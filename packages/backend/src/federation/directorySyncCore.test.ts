import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createSyncRunner,
  fetchPages,
  MAX_PAGES,
  parseMembershipList,
  type SyncOutcome,
  type SyncReport,
} from './directorySyncCore.js';

const outcome = (): SyncOutcome => ({ ok: true, entries: 0, pages: 1 });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

function runner(overrides: Partial<Parameters<typeof createSyncRunner<{ instanceId: string; confirmPending: boolean }>>[0]> = {}) {
  const calls: string[] = [];
  const deps = {
    hasIdentity: () => true,
    paused: async () => false,
    activeLinks: async () => [{ instanceId: 'peer', confirmPending: false }],
    linkState: async () => ({ state: 'active', confirmPending: false }),
    resendConfirmation: async (id: string, opts?: { force?: boolean }) => { calls.push(`resend:${id}:${Boolean(opts?.force)}`); },
    syncOneLink: async (link: { instanceId: string }, _now: number, _hour: number, report: SyncReport) => {
      calls.push(`one:${link.instanceId}`); report.synced += 1;
    },
    syncFull: async (id: string) => { calls.push(`full:${id}`); return { directory: outcome(), servers: outcome() }; },
    now: () => 100,
    hourOf: () => 12,
    linkBudgetMs: 10,
    syncNowBudgetMs: 10,
    warn: () => {},
    ...overrides,
  };
  return { sync: createSyncRunner(deps), calls };
}

describe('проход синхронизации федеративного каталога', () => {
  it('без личности или при аварийной паузе возвращает пустой отчёт и не читает связки', async () => {
    // Ловит исходящие запросы федерации, когда подписывать нечем или держатель выключил рубильник.
    for (const mode of ['identity', 'paused'] as const) {
      let reads = 0;
      const h = runner({
        hasIdentity: () => mode !== 'identity',
        paused: async () => mode === 'paused',
        activeLinks: async () => { reads += 1; return []; },
      });
      assert.deepEqual(await h.sync.runSyncPass(), { synced: 0, failed: 0, skipped: 0 });
      assert.equal(reads, 0, mode);
    }
  });

  it('ожидающее подтверждение досылается в фоне и зависание не держит проход', async () => {
    // Ловит остановку каталогов всех соседей из-за зависшей досылки одному из них.
    const held = deferred<unknown>();
    const h = runner({
      activeLinks: async () => [{ instanceId: 'peer', confirmPending: true }],
      resendConfirmation: () => held.promise,
    });
    assert.deepEqual(await h.sync.runSyncPass(), { synced: 1, failed: 0, skipped: 0 });
    held.resolve(undefined);
  });

  it('просроченная работа не мешает следующей связке и остаётся busy до настоящего завершения', async () => {
    // Ловит наложение двух проходов на брошенную по таймауту работу и блокировку остальных соседей.
    const held = deferred<void>();
    const visited: string[] = [];
    const h = runner({
      activeLinks: async () => [
        { instanceId: 'slow', confirmPending: false },
        { instanceId: 'fast', confirmPending: false },
      ],
      syncOneLink: async (link, _now, _hour, report) => {
        visited.push(link.instanceId);
        if (link.instanceId === 'slow') await held.promise;
        else report.synced += 1;
      },
      linkBudgetMs: 5,
    });
    assert.deepEqual(await h.sync.runSyncPass(), { synced: 1, failed: 1, skipped: 0 });
    assert.deepEqual(visited, ['slow', 'fast']);
    assert.equal(h.sync.isSyncing('slow'), true);
    assert.deepEqual(await h.sync.runSyncPass(), { synced: 1, failed: 0, skipped: 1 });
    held.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.sync.isSyncing('slow'), false);
  });

  it('кнопка различает нерабочую связку, паузу и уже идущую работу', async () => {
    // Ловит ручной обход тех же запретов, которым подчиняется плановый проход.
    assert.deepEqual(await runner({ linkState: async () => null }).sync.syncLinkNow('peer'), { problem: 'not-active' });
    assert.deepEqual(await runner({ linkState: async () => ({ state: 'blocked', confirmPending: false }) }).sync.syncLinkNow('peer'), { problem: 'not-active' });
    assert.deepEqual(await runner({ paused: async () => true }).sync.syncLinkNow('peer'), { problem: 'paused' });
    const held = deferred<void>();
    const h = runner({ syncOneLink: () => held.promise, linkBudgetMs: 5 });
    await h.sync.runSyncPass();
    assert.deepEqual(await h.sync.syncLinkNow('peer'), { problem: 'busy' });
    held.resolve();
  });

  it('кнопка отвечает timeout, но держит busy до завершения фоновой сверки', async () => {
    // Ловит повторный запуск тяжёлой сверки после истечения только HTTP-бюджета кнопки.
    const held = deferred<{ directory: SyncOutcome; servers: SyncOutcome }>();
    const h = runner({ syncFull: () => held.promise, syncNowBudgetMs: 5 });
    assert.deepEqual(await h.sync.syncLinkNow('peer'), { problem: 'timeout' });
    assert.equal(h.sync.isSyncing('peer'), true);
    held.resolve({ directory: outcome(), servers: outcome() });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.sync.isSyncing('peer'), false);
  });

  it('кнопка принудительно досылает подтверждение перед сверкой, но отказ досылки её не ломает', async () => {
    // Ловит сверку раньше подтверждения и потерю ручной синхронизации из-за второстепенного сбоя.
    const order: string[] = [];
    const h = runner({
      linkState: async () => ({ state: 'active', confirmPending: true }),
      resendConfirmation: async (_id, opts) => { order.push(`resend:${Boolean(opts?.force)}`); throw new Error('offline'); },
      syncFull: async () => { order.push('full'); return { directory: outcome(), servers: outcome() }; },
    });
    assert.equal((await h.sync.syncLinkNow('peer')).problem, null);
    assert.deepEqual(order, ['resend:true', 'full']);
  });
});

describe('получение страниц каталога', () => {
  const input = {
    instanceId: 'peer', apiBase: 'https://peer.example/api', path: '/directory', since: null,
    parse: (raw: unknown) => raw as { entries: Array<{ id: string }>; nextCursor: string | null; instanceId: string; now: number },
    apply: async (entries: Array<{ id: string }>) => ({ upserted: entries.length, removed: 0 }),
    idOf: (entry: { id: string }) => entry.id,
  };

  it('без подписанта не делает запрос и объясняет, что подписывать нечем', async () => {
    // Ловит анонимный сетевой запрос вместо явного отказа неподнятой федерации.
    let calls = 0;
    const result = await fetchPages({ signer: () => null, now: () => 1, getSignedFromPeer: async () => { calls += 1; throw new Error(); } }, input);
    assert.equal(result.problem, 'нечем подписать');
    assert.equal(calls, 0);
  });

  it('из тела non-2xx показывает только безопасный машинный код', async () => {
    // Ловит вывод управляемого соседом текста как доверенного системного сообщения.
    for (const [body, expected] of [
      ['{"error":"trust_lost","detail":"пишите мошеннику"}', 'ответ 409 (trust_lost)'],
      ['{"error":"Пишите t.me/fake"}', 'ответ 409'],
    ]) {
      const result = await fetchPages({
        signer: () => ({ instanceId: 'local', kid: 'k', privateKeyDer: new Uint8Array() }), now: () => 1,
        getSignedFromPeer: async () => ({ ok: true, value: { status: 409, body } }),
      }, input);
      assert.equal(result.problem, expected);
    }
  });

  it('ответ другой личности отвергается до применения записей', async () => {
    // Ловит запись чужих людей в кеш перепривязанного соседа.
    let applies = 0;
    const result = await fetchPages({
      signer: () => ({ instanceId: 'local', kid: 'k', privateKeyDer: new Uint8Array() }), now: () => 1,
      getSignedFromPeer: async () => ({ ok: true, value: { status: 200, body: JSON.stringify({ entries: [], nextCursor: null, instanceId: 'other', now: 1 }) } }),
    }, { ...input, apply: async () => { applies += 1; return { upserted: 0, removed: 0 }; } });
    assert.equal(result.problem, 'ответ от другого инстанса');
    assert.equal(applies, 0);
  });

  it('пятьдесят незавершённых страниц останавливаются пределом и каждая подписывается свежим временем', async () => {
    // Ловит бесконечный курсор и протухание подписи у длинной честной выгрузки.
    const times: number[] = [];
    let now = 0;
    const result = await fetchPages({
      signer: () => ({ instanceId: 'local', kid: 'k', privateKeyDer: new Uint8Array() }),
      now: () => ++now,
      getSignedFromPeer: async (request) => {
        times.push(request.now);
        return { ok: true, value: { status: 200, body: JSON.stringify({ entries: [], nextCursor: 'again', instanceId: 'peer', now: request.now }) } };
      },
    }, input);
    assert.equal(result.problem, 'слишком много страниц');
    assert.equal(result.pages, MAX_PAGES);
    assert.deepEqual(times, Array.from({ length: MAX_PAGES }, (_, index) => index + 1));
  });
});

describe('разбор списка членств', () => {
  it('не-JSON, не-массив и любой примитив или null внутри делают весь ответ негодным', () => {
    // Ловит стирание локального индекса по частично повреждённому полному снимку.
    for (const body of ['x', '{}', '{"memberships":null}', '{"memberships":[null]}', '{"memberships":[1]}', '{"memberships":["x"]}']) {
      assert.equal(parseMembershipList(body), null, body);
    }
  });

  it('кривые объекты отбрасываются, а корректные получают безопасные значения необязательных полей', () => {
    // Ловит отказ от всего снимка из-за одной записи без обязательного идентификатора.
    assert.deepEqual(parseMembershipList(JSON.stringify({ memberships: [
      {}, { user_id: 'u' }, { user_id: 'u', server_id: 's' },
    ] })), [{ userId: 'u', serverId: 's', serverName: '', state: 'active', method: null, invitedBy: null }]);
  });
});
