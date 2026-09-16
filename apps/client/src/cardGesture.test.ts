import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cardGesture } from './cardGesture.js';

/**
 * Судьба единственной карточки человека.
 *
 * Каждый случай тут — уже случившаяся ошибка, поэтому проверяем и «делает», и «НЕ делает».
 */

describe('cardGesture', () => {
  it('наведение без закреплённой — открывает по наведению', () => {
    assert.equal(cardGesture({ gesture: 'hover', pinnedUserId: null, targetUserId: 'u1' }), 'open-hover');
  });

  it('клик без закреплённой — открывает закреплённой', () => {
    assert.equal(cardGesture({ gesture: 'click', pinnedUserId: null, targetUserId: 'u1' }), 'open-pinned');
  });

  it('🔴 наведение на ДРУГОГО при закреплённой — игнорируем, карточку не крадём', () => {
    // Раньше достаточно было провести мышкой по соседней строке, и закреплённая подменялась чужой.
    assert.equal(cardGesture({ gesture: 'hover', pinnedUserId: 'u1', targetUserId: 'u2' }), 'ignore');
  });

  it('🔴 наведение на ТОГО ЖЕ при закреплённой — тоже игнорируем', () => {
    // Иначе увод и возврат мышки понизили бы закреплённую до обычной, и она исчезла бы сама.
    assert.equal(cardGesture({ gesture: 'hover', pinnedUserId: 'u1', targetUserId: 'u1' }), 'ignore');
  });

  it('🔴 повторный клик по ТОМУ ЖЕ человеку — закрывает', () => {
    assert.equal(cardGesture({ gesture: 'click', pinnedUserId: 'u1', targetUserId: 'u1' }), 'close');
  });

  it('клик по ДРУГОМУ при закреплённой — переоткрывает на нём, а не закрывает', () => {
    assert.equal(cardGesture({ gesture: 'click', pinnedUserId: 'u1', targetUserId: 'u2' }), 'open-pinned');
  });

  it('пустой id цели не считается совпадением с «не закреплено»', () => {
    // `pinnedUserId: null` и `targetUserId: ''` — разные вещи; спутать их значит закрыть карточку
    // вместо открытия.
    assert.equal(cardGesture({ gesture: 'click', pinnedUserId: null, targetUserId: '' }), 'open-pinned');
  });
});
