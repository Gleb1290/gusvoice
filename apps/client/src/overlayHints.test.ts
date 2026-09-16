import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { overlayHints, overlayRows } from './overlayHints.js';

const hint = (id: string, toUserId: string, atMs: number, amount = 10) => ({
  id,
  toUserId,
  fromUserId: `from-${id}`,
  fromName: `Отправитель ${id}`,
  amount,
  atMs,
});
const nameOf = (h: { fromName: string }) => h.fromName;

describe('overlayHints', () => {
  it('оставляет по одной подсказке на человека — самую свежую', () => {
    // В строке оверлея одна линия: стопка полезла бы вверх за край окна. Показываем то, что
    // только что случилось.
    const out = overlayHints([hint('a', 'u1', 100), hint('b', 'u1', 200)], new Set(['u1']), nameOf);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'b');
  });

  it('порядок прихода не важен — выигрывает поздняя по времени', () => {
    const out = overlayHints([hint('late', 'u1', 300), hint('early', 'u1', 50)], new Set(['u1']), nameOf);
    assert.equal(out[0].id, 'late');
  });

  it('отбрасывает подсказку тому, кого в оверлее нет', () => {
    // Иначе тип из соседнего канала доехал бы в окно и молча никуда не лёг.
    const out = overlayHints([hint('a', 'чужой', 1)], new Set(['u1']), nameOf);
    assert.deepEqual(out, []);
  });

  it('разным людям — по своей подсказке', () => {
    const out = overlayHints([hint('a', 'u1', 1), hint('b', 'u2', 2)], new Set(['u1', 'u2']), nameOf);
    assert.deepEqual(
      out.map((h) => h.toUserId).sort(),
      ['u1', 'u2'],
    );
  });

  it('имя отправителя берётся резолвером, а не из события', () => {
    // Показать надо ник НА ЭТОМ СЕРВЕРЕ (#73), а событие приносит обычное имя.
    const out = overlayHints([hint('a', 'u1', 1)], new Set(['u1']), () => 'Ник-на-сервере');
    assert.equal(out[0].from, 'Ник-на-сервере');
    assert.equal(out[0].amount, 10);
  });
});

describe('overlayRows', () => {
  const people = [
    { id: 'u1', speaking: false },
    { id: 'u2', speaking: true },
    { id: 'u3', speaking: false },
  ];

  it('в списке показывает всех независимо от подсказок', () => {
    assert.equal(overlayRows(people, false, []).length, 3);
  });

  it('в компактном виде — только говорящие', () => {
    assert.deepEqual(
      overlayRows(people, true, []).map((p) => p.id),
      ['u2'],
    );
  });

  it('в компактном виде добавляет молчащего получателя типа', () => {
    // Иначе жест на его счёт исчез бы бесследно: ников там нет, а самого человека в списке нет тоже.
    const hints = [{ id: 'a', toUserId: 'u3', from: 'Кто-то', amount: 10 }];
    assert.deepEqual(
      overlayRows(people, true, hints).map((p) => p.id),
      ['u2', 'u3'],
    );
  });

  it('порядок ростера сохраняется, дублей нет', () => {
    // Получатель, который И говорит, не должен появиться дважды.
    const hints = [{ id: 'a', toUserId: 'u2', from: 'Кто-то', amount: 10 }];
    assert.deepEqual(
      overlayRows(people, true, hints).map((p) => p.id),
      ['u2'],
    );
  });
});
