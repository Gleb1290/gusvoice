import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bitrateFor,
  bitrateLabel,
  buildNativeShareConfig,
  captureOptions,
  getStreamSettings,
  publishOptions,
  setStreamSettings,
  type StreamSettings,
} from './streamSettings.js';

const settings = (patch: Partial<StreamSettings> = {}): StreamSettings => ({
  resolution: '720',
  fps: 30,
  mode: 'detail',
  codec: 'vp9',
  audio: true,
  // Способ захвата окна на битрейт не влияет (он про источник кадров, а не про кодирование),
  // но поле обязательное — держим значение по умолчанию, как в проде.
  wgcWindow: true,
  // Запасной слой качества (#109). На битрейт основного слоя не влияет, но поле обязательное —
  // держим включённым, как в проде; тесты ниже проверяют ОБА положения переключателя.
  layers: true,
  // Отдача превью показа (#115) — про приватность, не про кодирование. Как в проде: включено.
  streamPreview: true,
  ...patch,
});

const saved: Record<string, string> = {
  gv_stream: JSON.stringify({ resolution: '720', fps: 60, mode: 'motion', codec: 'vp9', audio: false }),
};

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => saved[key] ?? null,
    setItem: (key: string, value: string) => { saved[key] = value; },
  },
});

describe('сохранённые настройки показа', () => {
  it('старый объект без WGC и запасного слоя получает безопасные новые defaults', () => {
    // Регрессия #100: старая localStorage-запись не должна тихо отключать новый безопасный способ захвата.
    assert.deepEqual(getStreamSettings(), {
      resolution: '720',
      fps: 60,
      mode: 'motion',
      codec: 'vp9',
      audio: false,
      wgcWindow: true,
      layers: true,
      streamPreview: true,
    });
  });

  it('явно выключенный WGC сохраняется, а не возвращается к опасному default', () => {
    // Ловит ситуацию, где пользователь отключил WGC из-за утечки explorer, а следующий запуск это потерял.
    const next = settings({ wgcWindow: false, layers: false });
    setStreamSettings(next);
    assert.deepEqual(JSON.parse(saved.gv_stream), next);
    assert.equal(getStreamSettings().wgcWindow, false);
  });
});

describe('битрейт демонстрации экрана', () => {
  it('базовые битрейты разрешений соответствуют таблице качества', () => {
    // Ловит перепутанное разрешение, которое незаметно публикуется с битрейтом соседнего пресета.
    assert.deepEqual(
      ['720', '1080', '1440', '2160'].map((resolution) =>
        bitrateFor(settings({ resolution: resolution as StreamSettings['resolution'] })),
      ),
      [1_500_000, 3_000_000, 5_000_000, 8_000_000],
    );
  });

  it('15, 30 и 60 fps применяют свои множители по обе стороны 30 fps', () => {
    // Ловит условие, где 15 или 60 fps случайно получает битрейт стандартных 30 fps.
    assert.deepEqual([15, 30, 60].map((fps) => bitrateFor(settings({ fps: fps as 15 | 30 | 60 }))), [1_125_000, 1_500_000, 2_400_000]);
  });

  it('режим движения повышает запас на межкадровые изменения', () => {
    // Ловит UI-переключатель detail/motion, который меняет подсказку, но не сетевой бюджет.
    assert.equal(bitrateFor(settings({ mode: 'motion' })), 1_725_000);
  });

  it('H.264 получает отдельный запас относительно VP9', () => {
    // Ловит возвращение блоков на тексте из-за одинакового битрейта менее эффективного кодека.
    assert.equal(bitrateFor(settings({ codec: 'h264' })), 2_100_000);
    assert.equal(bitrateFor(settings({ codec: 'vp9' })), 1_500_000);
  });

  it('подпись битрейта сохраняет дробную часть и убирает лишний ноль', () => {
    // Ловит вводящую в заблуждение оценку скорости в панели качества.
    assert.equal(bitrateLabel(settings()), '1.5 Мбит/с');
    assert.equal(bitrateLabel(settings({ resolution: '2160' })), '8 Мбит/с');
  });
});

describe('параметры захвата и публикации экрана', () => {
  it('capture передаёт выбранные размеры, fps, режим и оба состояния системного аудио', () => {
    // Ловит рассинхрон UI с getDisplayMedia и захват звука при выключенном переключателе.
    assert.deepEqual(captureOptions(settings({ resolution: '1440', fps: 60, mode: 'motion', audio: false })), {
      audio: false,
      systemAudio: 'exclude',
      resolution: { width: 2560, height: 1440, frameRate: 60 },
      contentHint: 'motion',
    });
    assert.equal(captureOptions(settings({ audio: true })).systemAudio, 'include');
  });

  it('H.264 публикуется с запасным слоем и без SVC-поля', () => {
    // Ловит возврат к ОДНОМУ слою (#109: без запасного слоя зритель с потерями просит опорные
    // кадры, и пульсация идёт у всех) и появление SVC-поля у кодека, который SVC не умеет.
    assert.deepEqual(publishOptions(settings({ codec: 'h264' })), {
      videoCodec: 'h264',
      screenShareEncoding: { maxBitrate: 2_100_000, maxFramerate: 30, priority: 'high' },
      degradationPreference: 'maintain-resolution',
      simulcast: true,
    });
  });

  it('VP9 motion включает пространственный SVC и приоритет частоты кадров', () => {
    // Ловит возврат к `L1T3` (#109: временные слои уменьшают ЧАСТОТУ, но не РАЗРЕШЕНИЕ, а зрителю
    // с потерями нужно именно меньшее разрешение) и деградацию разрешения вместо fps в игровом
    // режиме. `_KEY` важен отдельно: согласует слои по опорным кадрам, чтобы переключение между
    // ними не требовало нового опорного кадра.
    assert.deepEqual(publishOptions(settings({ codec: 'vp9', mode: 'motion', fps: 60 })), {
      videoCodec: 'vp9',
      screenShareEncoding: { maxBitrate: 2_760_000, maxFramerate: 60, priority: 'high' },
      degradationPreference: 'maintain-framerate',
      simulcast: true,
      scalabilityMode: 'L3T3_KEY',
    });
  });

  it('выключенный запасной слой возвращает публикацию к одному слою', () => {
    // Переключатель нужен ровно на один случай: у видеокарты кончились сеансы кодирования и показ
    // перестал стартовать (#109). Ловит, что выключение действительно доходит до публикации —
    // и что VP9 при этом откатывается на временные слои, а не остаётся с пространственными.
    assert.deepEqual(publishOptions(settings({ codec: 'h264', layers: false })), {
      videoCodec: 'h264',
      screenShareEncoding: { maxBitrate: 2_100_000, maxFramerate: 30, priority: 'high' },
      degradationPreference: 'maintain-resolution',
      simulcast: false,
    });
    assert.deepEqual(publishOptions(settings({ codec: 'vp9', layers: false })), {
      videoCodec: 'vp9',
      screenShareEncoding: { maxBitrate: 1_500_000, maxFramerate: 30, priority: 'high' },
      degradationPreference: 'maintain-resolution',
      simulcast: false,
      scalabilityMode: 'L1T3',
    });
  });
});

describe('провод настроек в нативный показ', () => {
  it('передаёт источник, качество и оба осознанно выключенных защитных переключателя', () => {
    // #100/#109: если хоть одно поле потеряется между панелью и Rust, человек снова получит WGC
    // с утечкой explorer или лишний слой, который не даёт начаться показу на слабой видеокарте.
    assert.deepEqual(
      buildNativeShareConfig({
        url: 'wss://voice.example.test',
        token: 'test-token',
        sourceId: 'window:42',
        isWindow: true,
        settings: settings({ resolution: '1440', fps: 60, mode: 'motion', codec: 'h264', wgcWindow: false, layers: false }),
      }),
      {
        url: 'wss://voice.example.test',
        token: 'test-token',
        sourceId: 'window:42',
        isWindow: true,
        fps: 60,
        width: 2560,
        height: 1440,
        maxBitrate: 12_880_000,
        codec: 'h264',
        wgcWindow: false,
        layers: false,
      },
    );
  });
});
