import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PENDING_WATCH_TIMEOUT_MS, matchPendingWatch, pendingWatchExpired, type PendingWatch } from './pendingWatch.js';

/**
 * Намерение «зайти и смотреть».
 *
 * Сценарии взяты из двух реальных случаев: браузерный показ публикует сам человек,
 * нативный — спутник `<userId>#screen`. Проверять надо оба, потому что перепутать их означает
 * открыть пустоту у половины людей — у тех, кто показывает с десктопа.
 */

const намерение = (over: Partial<PendingWatch> = {}): PendingWatch => ({
  channelId: 'ch-1',
  userId: 'u-goose',
  at: 1000,
  ...over,
});

describe('matchPendingWatch', () => {
  it('находит нативный показ, который публикует спутник', () => {
    assert.equal(matchPendingWatch(намерение(), 'ch-1', ['u-goose#screen']), 'u-goose#screen');
  });

  it('находит браузерный показ, который публикует сам человек', () => {
    assert.equal(matchPendingWatch(намерение(), 'ch-1', ['u-goose']), 'u-goose');
  });

  it('выбирает нужного среди чужих треков', () => {
    const треки = ['u-petya#screen', 'u-masha', 'u-goose#screen'];
    assert.equal(matchPendingWatch(намерение(), 'ch-1', треки), 'u-goose#screen');
  });

  it('без намерения не открывает ничего', () => {
    assert.equal(matchPendingWatch(null, 'ch-1', ['u-goose#screen']), null);
  });

  it('в ЧУЖОМ канале молчит, даже если там показывает человек с тем же id', () => {
    // Пока joinVoice не довёл нас до места, живые треки принадлежат ПРЕЖНЕМУ каналу.
    assert.equal(matchPendingWatch(намерение(), 'ch-другой', ['u-goose#screen']), null);
  });

  it('ещё не подключились (канала нет вовсе) — молчит', () => {
    assert.equal(matchPendingWatch(намерение(), null, ['u-goose#screen']), null);
  });

  it('пришли, а показа ещё нет — молчит, намерение остаётся ждать', () => {
    assert.equal(matchPendingWatch(намерение(), 'ch-1', []), null);
    assert.equal(matchPendingWatch(намерение(), 'ch-1', ['u-petya#screen']), null);
  });

  it('не путает человека с тем, чей id начинается так же', () => {
    // `u-goo` и `u-goose` — разные люди; срезание суффикса не должно превращаться в префиксный поиск.
    assert.equal(matchPendingWatch(намерение({ userId: 'u-goo' }), 'ch-1', ['u-goose#screen']), null);
  });
});

describe('pendingWatchExpired', () => {
  it('до срока — живо, ровно на сроке — просрочено', () => {
    const p = намерение({ at: 1000 });
    assert.equal(pendingWatchExpired(p, 1000 + PENDING_WATCH_TIMEOUT_MS - 1), false);
    assert.equal(pendingWatchExpired(p, 1000 + PENDING_WATCH_TIMEOUT_MS), true);
  });

  it('часы прыгнули назад — намерение не считается просроченным', () => {
    // Иначе перевод времени гасил бы намерение сразу после клика.
    assert.equal(pendingWatchExpired(намерение({ at: 1000 }), 0), false);
  });
});
