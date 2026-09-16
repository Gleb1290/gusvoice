import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addTipHint, hintsFor, pruneTipHints, TIP_HINT_MS, TIP_HINT_STACK, type TipHint } from './tipHints.js';

const hint = (id: string, toUserId: string, atMs = 0, fromName = 'Кто-то'): TipHint => ({
  id,
  toUserId,
  fromUserId: 'from-1',
  fromName,
  amount: 1,
  atMs,
});

describe('addTipHint', () => {
  it('копит стопку до потолка', () => {
    let list: TipHint[] = [];
    for (let i = 0; i < TIP_HINT_STACK; i++) list = addTipHint(list, hint(`h${i}`, 'u1'));
    assert.equal(hintsFor(list, 'u1').length, TIP_HINT_STACK);
  });

  it('сверх потолка вытесняет САМУЮ СТАРУЮ, а не отбрасывает новую', () => {
    // Иначе при серии быстрых типов человек видел бы первые три и не видел последних — то есть
    // ровно наоборот тому, что происходит прямо сейчас у него на глазах.
    let list: TipHint[] = [];
    for (let i = 0; i < TIP_HINT_STACK + 2; i++) list = addTipHint(list, hint(`h${i}`, 'u1'));
    const ids = hintsFor(list, 'u1').map((h) => h.id);
    assert.equal(ids.length, TIP_HINT_STACK);
    assert.equal(ids.includes('h0'), false);
    assert.equal(ids.at(-1), `h${TIP_HINT_STACK + 1}`);
  });

  it('вытеснение считается ПО ПОЛУЧАТЕЛЮ, чужие подсказки не трогает', () => {
    // Иначе оживлённый разговор в одном канале стирал бы адресованное тебе.
    let list: TipHint[] = [hint('other', 'u2')];
    for (let i = 0; i < TIP_HINT_STACK + 3; i++) list = addTipHint(list, hint(`h${i}`, 'u1'));
    assert.equal(hintsFor(list, 'u2').length, 1);
    assert.equal(hintsFor(list, 'u1').length, TIP_HINT_STACK);
  });

  it('порядок появления сохраняется — стопка растёт вверх предсказуемо', () => {
    let list: TipHint[] = [];
    list = addTipHint(list, hint('a', 'u1'));
    list = addTipHint(list, hint('b', 'u1'));
    assert.deepEqual(
      hintsFor(list, 'u1').map((h) => h.id),
      ['a', 'b'],
    );
  });
});

describe('pruneTipHints', () => {
  it('снимает отжившее и оставляет живое', () => {
    const list = [hint('old', 'u1', 0), hint('fresh', 'u1', 1_000)];
    const kept = pruneTipHints(list, TIP_HINT_MS + 500);
    assert.deepEqual(
      kept.map((h) => h.id),
      ['fresh'],
    );
  });

  it('ровно на границе срока подсказка уже снята', () => {
    assert.equal(pruneTipHints([hint('x', 'u1', 0)], TIP_HINT_MS).length, 0);
    assert.equal(pruneTipHints([hint('x', 'u1', 0)], TIP_HINT_MS - 1).length, 1);
  });

  it('спящая вкладка не копит: всё просроченное уходит разом', () => {
    // Таймеры в спящей вкладке не срабатывают, и без этой уборки при следующем типе всплыла бы
    // пачка старых подсказок.
    const list = [hint('a', 'u1', 0), hint('b', 'u1', 10), hint('c', 'u2', 20)];
    assert.equal(pruneTipHints(list, 600_000).length, 0);
  });
});
