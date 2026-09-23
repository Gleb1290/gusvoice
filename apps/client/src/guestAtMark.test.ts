import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { guestAtLine, guestAtLines, guestAtSummary } from './guestAtMark.js';

const guest = (extra: Record<string, unknown> = {}) => ({
  instance: 'Соседи', serverName: 'Чужой сервер', method: 'invite', at: '2026-09-20T12:00:00Z', ...extra,
}) as never;

describe('отметка мест, где виден скрытый человек', () => {
  it('вход по ссылке называет способ и известного пригласившего', () => {
    // Ловит потерю объяснения, почему скрытый из каталога человек всё же появился у соседа.
    const line = guestAtLine(guest({ invitedByName: 'Маша' }));
    assert.match(line, /вошёл по ссылке/);
    assert.match(line, /ссылку создал: Маша/);
  });

  it('без имени пригласившего сырой идентификатор не показывается', () => {
    // Ловит бесполезный технический id в административной таблице.
    assert.doesNotMatch(guestAtLine(guest({ invitedBy: 'raw-id' })), /raw-id/);
  });

  it('пустой список не рисует отметку и даёт пустой набор строк', () => {
    // Ловит ложный сигнал о видимости у соседей без единого гостевого места.
    assert.equal(guestAtSummary(undefined), null);
    assert.deepEqual(guestAtLines(undefined), []);
  });

  it('подпись правильно различает 1, 2, 11 и 21 сервер', () => {
    // Ловит неверную форму на подростковых числах и после десятков.
    const list = (n: number) => Array.from({ length: n }, () => guest());
    assert.match(guestAtSummary(list(1))!, /1 сервере$/);
    assert.match(guestAtSummary(list(2))!, /2 серверах$/);
    assert.match(guestAtSummary(list(11))!, /11 серверах$/);
    assert.match(guestAtSummary(list(21))!, /21 сервере$/);
  });
});
