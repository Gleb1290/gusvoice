import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addToastEvent,
  pruneToastEvents,
  shouldStartDrag,
  toastWants,
  TOAST_MS,
  TOAST_STACK,
  type ToastEvent,
} from './toastRules.js';

const ev = (id: string, atMs = 0, kind: ToastEvent['kind'] = 'tip'): ToastEvent => ({
  id,
  kind,
  fromName: 'Маша',
  toName: 'Петя',
  amount: 5,
  atMs,
});

describe('addToastEvent', () => {
  it('копит до потолка стопки', () => {
    let list: ToastEvent[] = [];
    for (let i = 0; i < TOAST_STACK; i++) list = addToastEvent(list, ev(`e${i}`));
    assert.equal(list.length, TOAST_STACK);
  });

  it('сверх потолка вытесняет самое СТАРОЕ, а не отбрасывает новое', () => {
    // Поверх игры важно то, что произошло только что: отбрось мы новое — плашка показывала бы
    // прошлое, пока человек смотрит на настоящее.
    let list: ToastEvent[] = [];
    for (let i = 0; i < TOAST_STACK + 2; i++) list = addToastEvent(list, ev(`e${i}`));
    const ids = list.map((e) => e.id);
    assert.equal(ids.length, TOAST_STACK);
    assert.equal(ids.includes('e0'), false);
    assert.equal(ids.at(-1), `e${TOAST_STACK + 1}`);
  });

  it('вытесняет по ЭКРАНУ, а не по человеку — щипок и тип теснят друг друга', () => {
    // Ровно этим плашка отличается от подсказки сайдбара: там стопка своя у каждой строки.
    let list: ToastEvent[] = [];
    for (let i = 0; i < TOAST_STACK; i++) list = addToastEvent(list, ev(`tip${i}`, i, 'tip'));
    list = addToastEvent(list, ev('poke', 99, 'poke'));
    assert.equal(list.length, TOAST_STACK);
    assert.equal(list.at(-1)?.kind, 'poke');
  });
});

describe('pruneToastEvents', () => {
  it('отжившее убирается, живое остаётся', () => {
    const list = [ev('old', 0), ev('fresh', TOAST_MS)];
    const kept = pruneToastEvents(list, TOAST_MS + 1);
    assert.deepEqual(
      kept.map((e) => e.id),
      ['fresh'],
    );
  });

  it('граница включительная — ровно в срок событие уже мертво', () => {
    assert.equal(pruneToastEvents([ev('x', 0)], TOAST_MS).length, 0);
    assert.equal(pruneToastEvents([ev('x', 0)], TOAST_MS - 1).length, 1);
  });
});

describe('shouldStartDrag', () => {
  it('нажатие на «Готово» перетаскивание НЕ начинает', () => {
    // Иначе система забирает мышь под перетаскивание, click не наступает, и кнопка мертва.
    assert.equal(shouldStartDrag({ positioning: true, button: 0, onDoneButton: true }), false);
  });

  it('нажатие мимо кнопки — тащим', () => {
    assert.equal(shouldStartDrag({ positioning: true, button: 0, onDoneButton: false }), true);
  });

  it('вне режима расстановки не тащим вовсе', () => {
    assert.equal(shouldStartDrag({ positioning: false, button: 0, onDoneButton: false }), false);
  });

  it('правая и средняя кнопки мыши не тащат', () => {
    assert.equal(shouldStartDrag({ positioning: true, button: 2, onDoneButton: false }), false);
    assert.equal(shouldStartDrag({ positioning: true, button: 1, onDoneButton: false }), false);
  });
});

describe('toastWants', () => {
  it('роды переключаются порознь', () => {
    assert.equal(toastWants({ tips: true, pokes: false }, 'tip'), true);
    assert.equal(toastWants({ tips: true, pokes: false }, 'poke'), false);
    assert.equal(toastWants({ tips: false, pokes: true }, 'tip'), false);
    assert.equal(toastWants({ tips: false, pokes: true }, 'poke'), true);
  });
});
