import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OUTBOX_MAX_AGE_MS, OUTBOX_MAX_ATTEMPTS, dropReason, nextAttemptDelayMs, queueAction } from './outboxRules.js';

describe('правила очереди федеративных событий', () => {
  it('задержка растёт вдвое с первой скорой попытки и упирается в потолок', () => {
    assert.equal(nextAttemptDelayMs(0), 10_000);
    assert.equal(nextAttemptDelayMs(1), 20_000);
    assert.equal(nextAttemptDelayMs(8), 2_560_000);
    assert.equal(nextAttemptDelayMs(20), 2_560_000);
  });

  it('ровно предел попыток и ровно предельный возраст уже выбрасывают событие', () => {
    const now = 1_000_000_000;
    assert.equal(dropReason({ attempts: OUTBOX_MAX_ATTEMPTS, createdAt: now }, now), 'too-many-attempts');
    assert.equal(dropReason({ attempts: 0, createdAt: now - OUTBOX_MAX_AGE_MS }, now), 'too-old');
    assert.equal(dropReason({ attempts: OUTBOX_MAX_ATTEMPTS - 1, createdAt: now - OUTBOX_MAX_AGE_MS + 1 }, now), null);
  });

  it('active доставляет, временные состояния держат, разрыв и неизвестное чистят', () => {
    assert.equal(queueAction('active'), 'deliver');
    for (const state of ['paused', 'requested', 'pending']) assert.equal(queueAction(state), 'hold', state);
    for (const state of ['blocked', 'trust-lost', 'future-state']) assert.equal(queueAction(state), 'discard', state);
  });
});
