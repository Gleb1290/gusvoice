import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  judgeEvent,
  MISSING_EVENT_SEQS_MAX,
  parseFedEvent,
  rememberEventId,
  serializeFedEvent,
  stateWins,
  trackMissingSeqs,
  type FedEvent,
} from './events.js';

describe('доставка федеративных событий', () => {
  it('обычный повтор отсекается по номеру, даже если идентификатор другой', () => {
    assert.deepEqual(judgeEvent({ eventId: 'new-id', seq: 7 }, { lastSeq: 7, recentIds: new Set() }), {
      accept: false,
      reason: 'duplicate',
    });
  });

  it('событие, обогнавшее себя другим путём, отсекается по идентификатору', () => {
    assert.deepEqual(judgeEvent({ eventId: 'seen', seq: 9 }, { lastSeq: 3, recentIds: new Set(['seen']) }), {
      accept: false,
      reason: 'duplicate',
    });
  });

  it('пропуск в нумерации отмечается, но не блокирует более свежее событие', () => {
    assert.deepEqual(judgeEvent({ eventId: 'later', seq: 5 }, { lastSeq: 2, recentIds: new Set() }), {
      accept: true,
      gap: true,
    });
    assert.deepEqual(judgeEvent({ eventId: 'next', seq: 3 }, { lastSeq: 2, recentIds: new Set() }), {
      accept: true,
      gap: false,
    });
  });

  it('опоздавший номер из списка пропусков принимается, не двигая последний номер', () => {
    // Ловит потерю раннего события после того, как более позднее уже прошло мимо очереди.
    const state = { lastSeq: 12, recentIds: new Set<string>(), missing: new Set([8, 10]) };
    assert.deepEqual(judgeEvent({ eventId: 'late-8', seq: 8 }, state), { accept: true, gap: false, late: true });
    assert.equal(state.lastSeq, 12);
  });

  it('номер вне пропусков и уже виденный id остаются повторами даже при наличии пропусков', () => {
    // Ловит обход дедупликации через missing: он не должен оживлять обычный повтор или повторный id.
    const state = { lastSeq: 12, recentIds: new Set(['seen-id']), missing: new Set([8]) };
    assert.deepEqual(judgeEvent({ eventId: 'not-missing', seq: 7 }, state), { accept: false, reason: 'duplicate' });
    assert.deepEqual(judgeEvent({ eventId: 'seen-id', seq: 8 }, state), { accept: false, reason: 'duplicate' });
  });

  it('учёт пропусков добавляет дыру, удаляет опоздавшее и ограничивает окно без изменения входа', () => {
    // Ловит мутацию исходного списка, потерю границ окна и сохранение уже доставленного номера.
    const original = [2, 5];
    assert.deepEqual(trackMissingSeqs(original, 5, 8), [2, 5, 6, 7]);
    assert.deepEqual(original, [2, 5]);
    assert.deepEqual(trackMissingSeqs([3, 4, 5], 5, 4), [3, 5]);
    assert.deepEqual(trackMissingSeqs([1, 2], 2, 3), [1, 2]);
    assert.equal(MISSING_EVENT_SEQS_MAX, 1024);
    const defaultLimit = trackMissingSeqs([], 0, 1025);
    assert.equal(defaultLimit.length, 1024);
    assert.equal(defaultLimit[0], 1);
    assert.equal(defaultLimit.at(-1), 1024);
    const atLimit = trackMissingSeqs([], 0, 1025, 1024);
    assert.equal(atLimit.length, 1024);
    assert.equal(atLimit[0], 1);
    assert.equal(atLimit.at(-1), 1024);
    const overLimit = trackMissingSeqs([1], 0, 1026, 1024);
    assert.equal(overLimit.length, 1024);
    assert.equal(overLimit[0], 2);
    assert.equal(overLimit.at(-1), 1025);
    const longGap = trackMissingSeqs([], 0, 1_000_000, 1024);
    assert.equal(longGap.length, 1024);
    assert.equal(longGap[0], 998_976);
    assert.equal(longGap.at(-1), 999_999);
  });

  it('при равной версии выигрывает уже сохранённое состояние', () => {
    assert.equal(stateWins(4, 4), false);
    assert.equal(stateWins(5, 4), true);
    assert.equal(stateWins(undefined, 4), true);
  });

  it('окно недавних идентификаторов ограничено и не содержит копий', () => {
    assert.deepEqual(rememberEventId(['a', 'b', 'a'], 'a', 2), ['b', 'a']);
    assert.deepEqual(rememberEventId(['a', 'b'], 'c', 2), ['b', 'c']);
  });

  it('провод отвергает нулевой и дробный номер, но терпит неизвестный вид события', () => {
    const base = { event_id: 'e', kind: 'future.kind', created_at: 1, payload: {}, extra: true };
    assert.equal(parseFedEvent({ ...base, seq: 0 }), null);
    assert.equal(parseFedEvent({ ...base, seq: 1.5 }), null);
    assert.equal(parseFedEvent({ ...base, seq: 1, event_id: '' }), null);
    const parsed = parseFedEvent({ ...base, seq: 1 });
    assert.equal(parsed?.kind, 'future.kind');
    assert.deepEqual(serializeFedEvent(parsed as FedEvent), {
      event_id: 'e',
      seq: 1,
      kind: 'future.kind',
      created_at: 1,
      payload: {},
    });
  });
});
