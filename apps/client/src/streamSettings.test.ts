import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

it('битрейт клиента совпадает с 144 опорными сочетаниями Rust на обычных и нестандартных экранах',()=>{
  // Та же измеренная таблица используется Rust-тестом share_bitrate: изменение одного двойника не останется незаметным.
  const cases=[
    [1280,720,1500000],[1920,1080,3000000],[2560,1440,5000000],[3840,2160,8000000],
    [3440,1440,5825000],[2560,1080,3857142.857142857],[1600,900,2175000],[800,600,781250],
    [3840,2160,8000000],[1080,1920,3000000],[3840,1600,6600000],[1366,768,1666000],
  ];
  let count=0;
  for(const [w,h,base] of cases)for(const fps of [15,30,60] as const)for(const mode of ['detail','motion'] as const)for(const codec of ['vp9','h264'] as const){
    const expected=Math.round(base!*(fps===15?0.75:fps===30?1:1.6)*(mode==='motion'?1.15:1)*(codec==='h264'?1.4:1));
    assert.equal(bitrateForDims(w!,h!,{fps,mode,codec}),expected,`${w}×${h} ${fps} ${mode} ${codec}`);count++;
  }
  assert.equal(count,144);
});
import {
  bitrateFor,
  bitrateLabel,
  bitrateForDims,
  buildNativeShareConfig,
  captureOptions,
  fitNative,
  getStreamSettings,
  publishOptions,
  returnLayersOnce,
  shareLayerPresets,
  setStreamSettings,
  STREAM_DEFAULTS,
  webScreenSettings,
  webShareLayers,
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
    assert.equal(STREAM_DEFAULTS.resolution, 'native', 'новый пользователь начинает с родного размера');
    assert.equal(getStreamSettings().resolution, '720', 'сохранённый выбор не переписывается новым умолчанием');
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
      degradationPreference: 'balanced',
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
  it('новый GPU-конвейер включён отсутствием поля, а явное выключение доходит до Rust', () => {
    // Ловит отправку `undefined`/`true` как отдельного значения, с которым старый десктоп не умеет работать.
    assert.equal('gpuPipeline' in STREAM_DEFAULTS, false);
    const input = {
      url: 'wss://voice.example.test', token: 'test-token', sourceId: 'screen:1', isWindow: false,
    };
    const legacy = buildNativeShareConfig({ ...input, settings: settings() });
    const enabled = buildNativeShareConfig({ ...input, settings: settings({ gpuPipeline: true }) });
    const disabled = buildNativeShareConfig({ ...input, settings: settings({ gpuPipeline: false }) });
    assert.equal('gpuPipeline' in legacy, false);
    assert.equal('gpuPipeline' in enabled, false);
    assert.equal(disabled.gpuPipeline, false);
  });

  it('курсор включён отсутствием поля, а явное выключение доходит до Rust', () => {
    // Ловит лишний ключ у старых оболочек и потерю осознанного запрета показывать курсор зрителям.
    assert.equal('cursor' in STREAM_DEFAULTS, false);
    const input = {
      url: 'wss://voice.example.test', token: 'test-token', sourceId: 'screen:1', isWindow: false,
    };
    assert.equal('cursor' in buildNativeShareConfig({ ...input, settings: settings() }), false);
    assert.equal('cursor' in buildNativeShareConfig({ ...input, settings: settings({ cursor: true }) }), false);
    assert.equal(buildNativeShareConfig({ ...input, settings: settings({ cursor: false }) }).cursor, false);
  });

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
        mode: 'motion',
        wgcWindow: false,
        layers: false,
      },
    );
  });
});

describe('лестница слоёв показа', () => {
  it('1440p30 даёт экономный 360p и средний 720p именно в порядке SDK', () => {
    // Ловит перестановку RID: тогда сервер называет экономный слой средним и переключает не туда.
    assert.deepEqual(shareLayerPresets(2560, 1440, 7_000_000, 30), [
      { width: 640, height: 360, maxBitrate: 150_000, maxFramerate: 3 },
      { width: 1280, height: 720, maxBitrate: 1_500_000, maxFramerate: 30 },
    ]);
  });

  it('4K получает средний 1080p, а 720p — только половинный экономный слой', () => {
    // Ловит лишний кодировщик у 720p и слишком мелкий средний слой у 4K.
    assert.deepEqual(shareLayerPresets(3840, 2160, 8_000_000, 60), [
      { width: 960, height: 540, maxBitrate: 150_000, maxFramerate: 3 },
      { width: 1920, height: 1080, maxBitrate: 1_500_000, maxFramerate: 60 },
    ]);
    assert.deepEqual(shareLayerPresets(1280, 720, 1_500_000, 30), [
      { width: 640, height: 360, maxBitrate: 150_000, maxFramerate: 3 },
    ]);
  });

  it('средний слой соблюдает пол, потолок и долю общего бюджета', () => {
    // Ловит как голодный 720p, так и слой, съедающий больше 60 % канала основного потока.
    assert.equal(shareLayerPresets(1920, 1080, 1_000_000, 30)[1]?.maxBitrate, 600_000);
    assert.equal(shareLayerPresets(1920, 1080, 20_000_000, 30)[1]?.maxBitrate, 1_500_000);
    assert.equal(shareLayerPresets(1920, 1080, 1_500_000, 30)[1]?.maxBitrate, 900_000);
  });

  it('браузер не создаёт отдельные пресеты при выключенных слоях и у VP9', () => {
    // Ловит двойную лестницу у SVC-кодека и игнорирование аварийного выключателя слоёв.
    assert.deepEqual(webShareLayers(settings({ codec: 'h264', layers: false })), []);
    assert.deepEqual(webShareLayers(settings({ codec: 'vp9', layers: true })), []);
    assert.equal(webShareLayers(settings({ codec: 'h264', layers: true })).length, 1);
  });

  it('одноразовый возврат включает только ранее выключенные слои и уважает отметку', () => {
    // Ловит вечное принудительное включение, которое отнимет у старой карты аварийный выход.
    const off = settings({ layers: false });
    assert.deepEqual(returnLayersOnce(off, false), { settings: { ...off, layers: true }, changed: true });
    assert.deepEqual(returnLayersOnce(off, true), { settings: off, changed: false });
    const on = settings({ layers: true });
    assert.deepEqual(returnLayersOnce(on, false), { settings: on, changed: false });
  });

  it('общая таблица 720p–4K и 30/60 fps совпадает с нативной лестницей', () => {
    // Межъязыковой страж: изменение только TypeScript или только Rust даст разные слои одному зрителю.
    const cases = [
      ['720', 30, 2_100_000, [[640, 360, 150_000, 3]]],
      ['720', 60, 3_360_000, [[640, 360, 150_000, 3]]],
      ['1080', 30, 4_200_000, [[640, 360, 150_000, 3], [1280, 720, 1_500_000, 30]]],
      ['1080', 60, 6_720_000, [[640, 360, 150_000, 3], [1280, 720, 1_500_000, 60]]],
      ['1440', 30, 7_000_000, [[640, 360, 150_000, 3], [1280, 720, 1_500_000, 30]]],
      ['1440', 60, 11_200_000, [[640, 360, 150_000, 3], [1280, 720, 1_500_000, 60]]],
      ['2160', 30, 11_200_000, [[960, 540, 150_000, 3], [1920, 1080, 1_500_000, 30]]],
      ['2160', 60, 17_920_000, [[960, 540, 150_000, 3], [1920, 1080, 1_500_000, 60]]],
    ] as const;
    const dims = { '720': [1280, 720], '1080': [1920, 1080], '1440': [2560, 1440], '2160': [3840, 2160] } as const;
    for (const [resolution, fps, bitrate, expected] of cases) {
      const s = settings({ resolution, fps, codec: 'h264' });
      assert.equal(bitrateFor(s), bitrate, `${resolution}p${fps}`);
      const [w, h] = dims[resolution];
      assert.deepEqual(shareLayerPresets(w, h, bitrate, fps).map((x) => [x.width, x.height, x.maxBitrate, x.maxFramerate]), expected);
    }
  });
});

it('битрейт «Родного» совпадает с пресетами для всех режимов, fps и кодеков', () => {
  // Межъязыковой договор с Rust должен совпасть на контрольных размерах, а не только в одном частном пресете.
  const presets = [
    ['720', 1280, 720], ['1080', 1920, 1080], ['1440', 2560, 1440], ['2160', 3840, 2160],
  ] as const;
  for (const [resolution, width, height] of presets) for (const fps of [15, 30, 60] as const)
    for (const mode of ['detail', 'motion'] as const) for (const codec of ['vp9', 'h264'] as const) {
      const s = settings({ resolution, fps, mode, codec });
      assert.equal(bitrateForDims(width, height, s), bitrateFor(s), `${resolution}p${fps} ${mode} ${codec}`);
    }
});

it('fitNative вписывает альбом и портрет в 4K, не увеличивая мелкий источник', () => {
  // Перепутанные габариты на ультрашироком/портретном мониторе дают сжатие и мыло до кодировщика.
  assert.deepEqual(fitNative(7680, 4320), { width: 3840, height: 2160 });
  assert.deepEqual(fitNative(4320, 7680), { width: 2160, height: 3840 });
  assert.deepEqual(fitNative(1919, 1081), { width: 1918, height: 1080 });
});

it('экран в браузере заменяет несовместимый VP9 на H.264, не меняя настройки камеры', () => {
  // LiveKit перезаписывает VP9 screen share в L1T3/motion; камеры этот экранный обход затрагивать не должен.
  const vp9 = settings({ codec: 'vp9', mode: 'motion', resolution: 'native' });
  assert.deepEqual(webScreenSettings(vp9), { ...vp9, codec: 'h264' });
  const h264 = settings({ codec: 'h264' });
  assert.equal(webScreenSettings(h264), h264, 'совместимый экранный кодек не создаёт лишнюю замену');
});

it('«Родное» отправляет размер и битрейт на расчёт Rust, максимум качества убирает слои', () => {
  // Rust знает фактический размер источника; подстановка 1080p на клиенте ломает единый бюджет оценщика.
  const base = { url: 'wss://voice.example.test', token: 'test-token', sourceId: 'screen:2', isWindow: false };
  const native = buildNativeShareConfig({ ...base, settings: settings({ resolution: 'native' }) });
  assert.equal(native.width, 0, 'ширина источника не выдумывается клиентом');
  assert.equal(native.height, 0, 'высота источника не выдумывается клиентом');
  assert.equal(native.maxBitrate, 0, 'битрейт источника рассчитывает нативная сторона');
  const max = buildNativeShareConfig({ ...base, settings: settings({ maxQuality: true }) });
  assert.equal(max.maxQuality, true, 'галочка доходит до нативного конфига');
  assert.equal(max.layers, false, 'максимальное качество отключает запасные кодирующие слои');
});
