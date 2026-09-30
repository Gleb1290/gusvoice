import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AudioSettings } from './audioSettings.js';
import { clampVadThreshold, micChainNeeded, micChainSignature, VAD_THRESHOLD_MIN, VAD_THRESHOLD_MAX } from './micProcessorRules.js';

const settings = (overrides: Partial<AudioSettings> = {}): AudioSettings => ({
  inputDeviceId: '',
  outputDeviceId: '',
  cameraDeviceId: '',
  noiseSuppression: true,
  noiseFilter: 'system',
  echoCancellation: true,
  autoGainControl: true,
  pushToTalk: false,
  pttKey: 'Space',
  inputGain: 1,
  vadThreshold: VAD_THRESHOLD_MIN,
  pttReleaseMs: 150,
  ...overrides,
});

describe('нужна ли собственная микрофонная цепь', () => {
  it('новый порог 1 % собирает цепь даже на десктопе', () => {
    // Ловит возвращение старого дефолта, который передавал фоновый шум всем собеседникам.
    assert.equal(micChainNeeded(settings()), true);
  });

  it('мобильный RNNoise по умолчанию включает цепь', () => {
    // Ловит обход шумодава на мобильных, где RNNoise выбран стартовой настройкой.
    assert.equal(micChainNeeded(settings({ noiseSuppression: false, noiseFilter: 'rnnoise' })), true);
  });

  it('любое отклонение входного усиления от 100% включает цепь', () => {
    // Ловит применение gain только в одну сторону либо игнорирование ослабления микрофона.
    assert.equal(micChainNeeded(settings({ inputGain: 0.8 })), true);
    assert.equal(micChainNeeded(settings({ inputGain: 1.2 })), true);
  });

  it('положительный порог голосового гейта включает цепь', () => {
    // Ловит настройку порога, которая сохраняется в UI, но не попадает в аудиограф.
    assert.equal(micChainNeeded(settings({ vadThreshold: 0.01 })), true);
  });

  it('DeepFilter включает цепь так же, как RNNoise', () => {
    // Ловит пропуск второго нейрофильтра при проверке условий построения цепи.
    assert.equal(micChainNeeded(settings({ noiseFilter: 'deepfilter' })), true);
  });
});

describe('подпись топологии микрофонной цепи', () => {
  it('разные нейрофильтры дают разные подписи', () => {
    // Ловит смену фильтра в настройках без фактической перестройки аудиографа.
    const signatures = ['system', 'off', 'rnnoise', 'deepfilter'].map((noiseFilter) =>
      micChainSignature(settings({ noiseFilter: noiseFilter as AudioSettings['noiseFilter'] })),
    );
    assert.equal(new Set(signatures).size, signatures.length);
  });

  it('старый нулевой порог и новый 1 % дают разные топологии', () => {
    // Ловит отсутствие перестройки аудиографа при миграции со старого raw-пути.
    assert.notEqual(micChainSignature(settings({ vadThreshold: 0 })), micChainSignature(settings()));
  });

  it('gain и threshold внутри уже построенной цепи обновляются без rebuild', () => {
    // Ловит лишние разрывы опубликованного трека при параметрах, обновляемых на лету.
    assert.equal(
      micChainSignature(settings({ inputGain: 1.2 })),
      micChainSignature(settings({ vadThreshold: 0.3 })),
    );
  });

  it('несвязанные настройки устройств и push-to-talk подпись не меняют', () => {
    // Ловит перестройку микрофонного процессора от полей, не меняющих его топологию.
    assert.equal(
      micChainSignature(settings()),
      micChainSignature(settings({ inputDeviceId: 'mic-2', pushToTalk: true, pttKey: 'KeyV' })),
    );
  });
});

describe('шкала порога голоса', () => {
  it('старый ноль, отрицательное число и значение ниже 1 % становятся 1 %', () => {
    // Ловит сохранение прежнего режима «выкл» через старую настройку или испорченное значение.
    for (const value of [0, -1, 0.005]) assert.equal(clampVadThreshold(value), VAD_THRESHOLD_MIN);
  });

  it('отсутствующее, NaN и строковое значение не ломают порог', () => {
    // Ловит обход нормализации через нестандартное содержимое localStorage.
    for (const value of [undefined, NaN, '0.3']) assert.equal(clampVadThreshold(value), VAD_THRESHOLD_MIN);
  });

  it('значения внутри шкалы сохраняются, а выше 60 % прижимаются к максимуму', () => {
    // Ловит срезание допустимой настройки и пропуск верхнего ограничения.
    assert.equal(clampVadThreshold(0.3), 0.3);
    assert.equal(clampVadThreshold(0.6), VAD_THRESHOLD_MAX);
    assert.equal(clampVadThreshold(0.9), VAD_THRESHOLD_MAX);
  });
});
