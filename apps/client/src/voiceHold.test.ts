import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VOICE_HOLD, voiceHoldProgress, voiceHoldRelease, voiceHoldStep } from './voiceHold.js';

describe('жест удержания голосового сообщения', () => {
  it('ровно порог подъёма фиксирует запись, а пикселем ниже ещё держит', () => {
    // Ловит ошибку на единицу, из-за которой жест фиксации ощущается случайным.
    assert.equal(voiceHoldStep(0, -VOICE_HOLD.lockDy), 'lock');
    assert.equal(voiceHoldStep(0, -VOICE_HOLD.lockDy + 1), 'hold');
  });

  it('ровно порог движения влево отменяет запись, а пикселем раньше ещё держит', () => {
    // Ловит слишком раннюю отмену и потерю уже записанного сообщения.
    assert.equal(voiceHoldStep(-VOICE_HOLD.cancelDx, 0), 'cancel');
    assert.equal(voiceHoldStep(-VOICE_HOLD.cancelDx + 1, 0), 'hold');
  });

  it('при одновременном прохождении обоих порогов фиксация побеждает отмену', () => {
    // Ловит потерю записи при быстром диагональном движении пальца.
    assert.equal(voiceHoldStep(-VOICE_HOLD.cancelDx, -VOICE_HOLD.lockDy), 'lock');
  });

  it('движение вправо и вниз ничего не запускает', () => {
    // Ловит перепутанный знак экранных координат.
    assert.equal(voiceHoldStep(500, 500), 'hold');
  });

  it('прогресс ограничен диапазоном от нуля до единицы', () => {
    // Ловит вылет подсказок за экран при движении не в ту сторону или далеко за порог.
    assert.deepEqual(voiceHoldProgress(50, 50), { lock: 0, cancel: 0 });
    assert.deepEqual(voiceHoldProgress(-VOICE_HOLD.cancelDx * 2, -VOICE_HOLD.lockDy * 2), {
      lock: 1,
      cancel: 1,
    });
  });

  it('ровно 500 мс уже отправляются, а 499 мс считаются промахом', () => {
    // Ловит рассогласование порога подсказки с фактической отправкой записи.
    assert.equal(voiceHoldRelease(VOICE_HOLD.minHoldMs - 1), 'short');
    assert.equal(voiceHoldRelease(VOICE_HOLD.minHoldMs), 'send');
  });
});
