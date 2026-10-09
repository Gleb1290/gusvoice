import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encWindow, formatLayerTargets, formatShareCfg, type EncCounters } from './streamDebugRules.js';

describe('цели слоёв в отладке показа', () => {
  it('нулевой или единственный слой не создаёт отдельную строку панели', () => {
    // Ловит шумную строку, которая не несёт сравнения между слоями.
    assert.equal(formatLayerTargets([]), '');
    assert.equal(formatLayerTargets([{ rid: 'f', active: true, bps: 3_500_000 }]), '');
  });

  it('несколько слоёв показывают Мбит/с, паузу и безопасное имя пустого rid', () => {
    // Ловит сокрытие dynacast-паузы под нулевым битрейтом и нечитаемую пустую подпись слоя.
    assert.equal(
      formatLayerTargets([
        { rid: 'f', active: true, bps: 3_500_000 },
        { rid: 'h', active: false, bps: 2_500_000 },
        { rid: '', active: true, bps: 150_000 },
      ]),
      'f 3.50 · h пауза · ? 0.15',
    );
  });
});

it('чёрный ящик считает QP, факт и цель за интервал, а не накопительные суммы', () => {
  // Накопительные числа без разности скрывают ухудшение за последние секунды и неправильно диагностируют статичный экран.
  const prev: EncCounters = { atMs: 1_000, frames: 10, qpSum: 200, bytesSent: 1_000, encBytesTarget: 1_200 };
  const now: EncCounters = { atMs: 3_000, frames: 50, qpSum: 1_600, bytesSent: 126_000, encBytesTarget: 101_200 };
  assert.deepEqual(encWindow(prev, now), { qp: 35, kbps: 500, encKbps: 400 });
  assert.equal(encWindow(null, now), null, 'без предыдущего отсчёта нет окна');
  assert.equal(encWindow(now, { ...now, atMs: 3_000 }), null, 'нулевой интервал не делится на ноль');
  assert.equal(encWindow(now, { ...now, atMs: 4_000, frames: 2 }), null, 'сброс счётчика означает новую сессию, а не отрицательную скорость');
});

it('строка фактической конфигурации показывает режим, NVENC, слои и максимальное качество', () => {
  // Без эффективного cfg панель повторяла бы настройку формы, даже когда нативная сторона выбрала иной путь.
  assert.equal(formatShareCfg({ width: 3840, height: 2160, fps: 30, bitrate: 8_000_000, mode: 'detail', layers: true }),
    '3840×2160 · 30 к/с · 8.0 Мбит/с · Чёткость · слои');
  assert.equal(formatShareCfg({ width: 1920, height: 1080, fps: 60, bitrate: 5_200_000, mode: 'motion', keyframeScale: 4, layers: false, maxQuality: true }),
    '1920×1080 · 60 к/с · 5.2 Мбит/с · Плавность · опорный ×4 · один поток · макс. качество');
  assert.equal(formatShareCfg({ width: 0, height: 0 }), '', 'неизвестный размер не печатает выдуманный режим');
});
