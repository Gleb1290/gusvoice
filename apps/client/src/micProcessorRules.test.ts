import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AudioSettings } from './audioSettings.js';
import { micChainNeeded, micChainSignature } from './micProcessorRules.js';

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
  vadThreshold: 0,
  pttReleaseMs: 150,
  ...overrides,
});

describe('нужна ли собственная микрофонная цепь', () => {
  it('десктопные настройки по умолчанию оставляют дешёвый системный путь', () => {
    // Ловит ненужную пересборку WebAudio-цепи у каждого десктопного пользователя.
    assert.equal(micChainNeeded(settings()), false);
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

  it('первое включение gain меняет подпись и строит отсутствующую цепь', () => {
    // Ловит ситуацию, когда переход с raw-микрофона на обработанный не вызывает rebuild.
    assert.notEqual(micChainSignature(settings()), micChainSignature(settings({ inputGain: 1.2 })));
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
