import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  judgeEvent,
  parseFedEvent,
  rememberEventId,
  serializeFedEvent,
  stateWins,
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
