import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '@gusvoice/shared';
import {
  HISTORY_PAGE,
  compareMessages,
  hasMoreOlder,
  mergeLatestPage,
  mergeOlderPage,
  olderCursor,
} from './historyPage.js';

const msg = (id: string, second: number, content = id): Message => ({
  id,
  channelId: 'feed',
  author: { id: 'u', username: 'u', displayName: 'U', avatarUrl: null },
  content,
  attachments: [],
  createdAt: new Date(Date.UTC(2026, 8, 20, 12, 0, second)).toISOString(),
  editedAt: null,
  reactions: [],
  replyTo: null,
});
const page = (from: number, count: number): Message[] =>
  Array.from({ length: count }, (_, i) => msg(`m${from + i}`, from + i));

describe('курсор и порядок истории', () => {
  it('одинаковое время упорядочивается по id, а разное — по времени', () => {
    // Ловит нестабильную границу порции для двух сообщений одной миллисекунды.
    assert.equal(compareMessages(msg('a', 1), msg('b', 1)), -1);
    assert.ok(compareMessages(msg('z', 1), msg('a', 2)) < 0);
    assert.equal(compareMessages(msg('same', 1), msg('same', 1)), 0);
  });

  it('пустая лента не даёт курсор, непустая указывает на самое старое сообщение', () => {
    // Ловит запрос без опоры и курсор от хвоста, который пропускает всю середину истории.
    assert.equal(olderCursor([]), null);
    assert.deepEqual(olderCursor([msg('old', 1), msg('new', 2)]), {
      before: msg('old', 1).createdAt,
      beforeId: 'old',
    });
  });

  it('ровно HISTORY_PAGE допускает следующую порцию, на одном меньше означает дно', () => {
    // Ловит off-by-one, прячущий пятидесятое сообщение или делающий лишний запрос.
    assert.equal(hasMoreOlder(page(0, HISTORY_PAGE - 1)), false);
    assert.equal(hasMoreOlder(page(0, HISTORY_PAGE)), true);
  });

  it('старая порция добавляется в начало без повторных id', () => {
    // Ловит видимый дубль на пересечении порций после сообщения, пришедшего во время запроса.
    const current = [msg('m2', 2), msg('m3', 3)];
    assert.deepEqual(mergeOlderPage(current, [msg('m1', 1), msg('m2', 2)]).map((m) => m.id), ['m1', 'm2', 'm3']);
  });
});

describe('слияние последней порции', () => {
  it('без кеша результатом становится точная копия порции', () => {
    // Ловит особый первый вход, который случайно применяет правила пересечения к отсутствующей истории.
    const fresh = [msg('a', 1), msg('b', 2)];
    assert.deepEqual(mergeLatestPage(undefined, fresh), fresh);
  });

  it('неполная порция удаляет старый кеш внутри всей истории, но сохраняет более новое сокет-сообщение', () => {
    // Ловит возвращение удалённого сообщения и потерю события, пришедшего параллельно запросу.
    const fresh = [msg('a', 1, 'server'), msg('b', 2, 'edited')];
    const cached = [msg('deleted', 0), msg('b', 2, 'stale'), msg('socket', 3)];
    const result = mergeLatestPage(cached, fresh);
    assert.deepEqual(result.map((m) => m.id), ['a', 'b', 'socket']);
    assert.equal(result[1]?.content, 'edited');
  });

  it('пересекающаяся полная порция сохраняет старый кеш и заменяет своё окно серверной истиной', () => {
    // Ловит исчезновение уже подгруженной прокруткой истории при пробуждении клиента.
    const fresh = page(10, HISTORY_PAGE);
    const cached = [msg('ancient', 1), msg('m10', 10, 'stale'), msg('socket', 61)];
    const result = mergeLatestPage(cached, fresh);
    assert.equal(result[0]?.id, 'ancient');
    assert.equal(result.find((m) => m.id === 'm10')?.content, 'm10');
    assert.equal(result.at(-1)?.id, 'socket');
  });

  it('кеш целиком старше полной порции отбрасывается, чтобы не рисовать дыру как непрерывную историю', () => {
    // Ловит склейку двух далёких диапазонов после сна без признака пропущенных сообщений между ними.
    const fresh = page(100, HISTORY_PAGE);
    const result = mergeLatestPage([msg('ancient', 1)], fresh);
    assert.deepEqual(result.map((m) => m.id), fresh.map((m) => m.id));
  });

  it('пустая последняя порция очищает кеш, а более новых сообщений у неё нет', () => {
    // Ловит вечные удалённые сообщения, когда сервер честно вернул полностью пустую историю.
    assert.deepEqual(mergeLatestPage([msg('old', 1)], []), []);
  });
});
