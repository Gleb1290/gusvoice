import assert from 'node:assert/strict';
import { it } from 'node:test';
import { AUDIO_DEFAULTS, getAudioSettings } from './audioSettings.js';
import { VAD_THRESHOLD_MIN } from './micProcessorRules.js';

it('старый сохранённый ноль мигрирует в порог 1 % при чтении настроек', () => {
  // Ловит сохранение выключенного гейта у существующих пользователей после смены дефолта.
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => key === 'gv_audio' ? JSON.stringify({ vadThreshold: 0 }) : null },
  });
  try {
    assert.equal(AUDIO_DEFAULTS.vadThreshold, VAD_THRESHOLD_MIN);
    assert.equal(getAudioSettings().vadThreshold, VAD_THRESHOLD_MIN);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
