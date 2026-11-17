import assert from 'node:assert/strict';
import { it } from 'node:test';
import { micCaptureOptions } from './micProcessorRules.js';

const settings = {
  inputDeviceId: '',
  echoCancellation: false,
  autoGainControl: true,
  noiseFilter: 'system' as const,
};

it('Android включает эхоподавление и отключает системные усиление и шумоподавление вопреки сохранённым настройкам', () => {
  assert.deepEqual(micCaptureOptions(settings, true), {
    echoCancellation: true,
    autoGainControl: false,
    noiseSuppression: false,
  });
});

it('Android сохраняет эти параметры при других настройках микрофона', () => {
  assert.deepEqual(micCaptureOptions({ ...settings, echoCancellation: true, autoGainControl: false, noiseFilter: 'off' }, true), {
    echoCancellation: true,
    autoGainControl: false,
    noiseSuppression: false,
  });
});

it('на компьютере эхоподавление и усиление следуют настройкам в обоих состояниях', () => {
  for (const value of [false, true]) {
    const options = micCaptureOptions({ ...settings, echoCancellation: value, autoGainControl: !value }, false);
    assert.equal(options.echoCancellation, value);
    assert.equal(options.autoGainControl, !value);
  }
});

it('на компьютере системное шумоподавление включается только для системного фильтра', () => {
  for (const noiseFilter of ['system', 'rnnoise', 'deepfilter', 'off'] as const) {
    assert.equal(micCaptureOptions({ ...settings, noiseFilter }, false).noiseSuppression, noiseFilter === 'system', noiseFilter);
  }
});

it('пустое устройство не добавляет deviceId даже при точном выборе', () => {
  for (const exact of [false, true]) {
    assert.equal(Object.hasOwn(micCaptureOptions(settings, false, exact), 'deviceId'), false);
  }
});

it('выбранное устройство передаётся строкой или точным ограничением для повторного захвата', () => {
  const selected = { ...settings, inputDeviceId: 'microphone-1' };
  assert.equal(micCaptureOptions(selected, false).deviceId, 'microphone-1');
  assert.equal(micCaptureOptions(selected, false, false).deviceId, 'microphone-1');
  assert.deepEqual(micCaptureOptions(selected, true, true).deviceId, { exact: 'microphone-1' });
});

it('настройки не меняются, а каждый вызов возвращает независимый объект', () => {
  const input = Object.freeze({ ...settings, inputDeviceId: 'microphone-1' });
  const before = { ...input };
  const first = micCaptureOptions(input, false, true);
  const second = micCaptureOptions(input, false, true);
  assert.deepEqual(input, before);
  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.deviceId, second.deviceId);
});
