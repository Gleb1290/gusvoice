import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DELTA_INTERVAL_MS,
  FULL_INTERVAL_MS,
  MISSED_NIGHT_GRACE_MS,
  SYNC_BACKOFF_MAX_MS,
  freshnessText,
  planSync,
  syncBackoffMs,
  type SyncState,
} from './syncSchedule.js';

const state = (patch: Partial<SyncState> = {}): SyncState => ({
  lastDeltaAt: 0, lastFullAt: 0, failures: 0, needsFull: false, ...patch,
});

describe('расписание синхронизации федерации', () => {
  it('первый проход и явный разрыв требуют полной сверки даже днём', () => {
    assert.equal(planSync(state({ lastFullAt: null, lastDeltaAt: null }), 1, 12), 'full');
    assert.equal(planSync(state({ needsFull: true }), 1, 12), 'full');
  });

  it('суточная сверка ждёт ночь, но пропущенное ночное окно получает дневную поблажку', () => {
    assert.equal(planSync(state(), FULL_INTERVAL_MS, 3), 'full');
    assert.equal(planSync(state({ lastDeltaAt: FULL_INTERVAL_MS }), FULL_INTERVAL_MS, 12), 'idle');
    assert.equal(planSync(state(), FULL_INTERVAL_MS + MISSED_NIGHT_GRACE_MS, 12), 'full');
  });

  it('полная сверка проверяется раньше уже подошедшей дельты', () => {
    const now = FULL_INTERVAL_MS + MISSED_NIGHT_GRACE_MS;
    assert.equal(planSync(state({ lastDeltaAt: now - DELTA_INTERVAL_MS }), now, 12), 'full');
  });

  it('первая неудача не растягивает срок, следующие удваивают его до потолка', () => {
    assert.equal(syncBackoffMs(1), DELTA_INTERVAL_MS);
    assert.equal(syncBackoffMs(2), DELTA_INTERVAL_MS * 2);
    assert.equal(syncBackoffMs(100), SYNC_BACKOFF_MAX_MS);
  });

  it('свежесть различает отсутствие, только что, минуты, часы и сутки', () => {
    const now = 10 * 24 * 60 * 60_000;
    assert.equal(freshnessText(null, now), 'ещё не синхронизировано');
    assert.equal(freshnessText(now - 59_999, now), 'обновлено только что');
    assert.equal(freshnessText(now - 3 * 60_000, now), 'обновлено 3 мин назад');
    assert.equal(freshnessText(now - 3 * 60 * 60_000, now), 'обновлено 3 ч назад');
    assert.equal(freshnessText(now - 2 * 24 * 60 * 60_000, now), 'обновлено 2 сут назад');
  });
});
