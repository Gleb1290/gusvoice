import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, beforeEach, test } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as lastSeenRules from '../src/lastSeenRules.js';
import type { StoredLink } from '../src/federation/linkService.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
beforeEach(async () => { await truncateAll(t.raw); });
after(async () => { await t.close(); });
type Ephemeral = typeof import('../src/federation/dmEphemeral.js');
type Internals = Ephemeral & {
  testSendTyping(dm: string, sender: string, peer: string, action: string): Promise<void>;
  testFlushPresence(user: string, alive: boolean): Promise<void>;
};
type Mutation = readonly [string, string];
const self = 'a'.repeat(32), peer = 'b'.repeat(32), third = 'c'.repeat(32);
const conv = '10000000-0000-4000-8000-000000000001';
const NOW = 2_000_000_000_000;
function moduleOf<T>(name: string, deps: Record<string, unknown>, globals: Record<string, unknown> = {}, mutations: readonly Mutation[] = [], expose = ''): T {
  let code = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to] of mutations) { assert.equal(code.split(from).length, 2, `единственный якорь ${from}`); code = code.replace(from, to); }
  // Только ссылки на реальные private функции: весь исходный модуль исполняется, вычисления не копируются и не вырезаются.
  code += expose;
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    module, exports: module.exports, Date, URL, Buffer, ...globals,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `явный импорт ${id}`); return deps[id]; },
  });
  return module.exports as T;
}
async function fixture(options: { dm3?: boolean; mutations?: readonly Mutation[] } = {}) {
  let now = NOW;
  class ClockDate extends Date { constructor(value?: number | string) { super(value ?? now); } static now() { return now; } }
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'ephemeral_local', displayName: 'Местный', passwordHash: 'fixture', verified: true, approvedAt: new Date(), lastSeenPrivacy: 'everyone', presenceStatus: 'invisible' },
    { id: 'viewer', username: 'ephemeral_viewer', displayName: 'Зритель', passwordHash: 'fixture', verified: true, approvedAt: new Date() },
    { id: 'blocked', username: 'ephemeral_blocked', displayName: 'Заблокировавший', passwordHash: 'fixture', verified: true, approvedAt: new Date() },
    { id: 'shadow', username: 'ephemeral_shadow', displayName: 'Сосед', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'remote' },
    { id: 'shadow2', username: 'ephemeral_shadow2', displayName: 'Второй сосед', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'remote2' },
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'peer.invalid', apiBase: 'https://peer.invalid/api', clientOrigin: 'https://peer.invalid', rootKey: 'fixture', state: 'active', features: options.dm3 === false ? ['dm1'] : ['dm1', 'dm3'] });
  await t.db.insert(schema.conversations).values({ id: conv, kind: 'direct', directKey: 'local:shadow', createdBy: 'local' });
  await t.db.insert(schema.conversationMembers).values([{ conversationId: conv, userId: 'local' }, { conversationId: conv, userId: 'shadow' }]);
  const savedLink = (await t.db.select().from(schema.federationLinks))[0]!;
  assert.equal(savedLink.state, 'active');
  const link: StoredLink = { ...savedLink, state: 'active' };
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
  });
  const online = new Set(['local']);
  const presence: [string, boolean][] = [];
  const typing: string[][] = [];
  const requests: { apiBase: string; path: string; payload: Record<string, any>; allowHosts: Set<string>; now: number }[] = [];
  const postWaiters: ((request: typeof requests[number]) => void)[] = [];
  const refreshes: string[] = [];
  const timeouts = new Map<object, { fn: () => void; ms: number }>();
  const intervals: { fn: () => void; ms: number }[] = [];
  const shadowReads: Promise<unknown>[] = [];
  // Наблюдаем выполнение настоящего SELECT, а не вызываем refreshShadowIds второй раз для ожидания:
  // отдельный вызов спрятал бы регрессию, при которой минутный такт перестал обновлять множество.
  const ephemeralDb = {
    execute: t.db.execute.bind(t.db),
    select(fields?: Record<string, unknown>) {
      const selected = Reflect.apply(t.db.select, t.db, fields === undefined ? [] : [fields]);
      if (!fields || Object.keys(fields).length !== 1 || fields.id !== schema.users.id) return selected;
      return { from(table: unknown) {
        assert.equal(table, schema.users);
        const from = selected.from(table);
        return { where(condition: unknown) {
          const query = from.where(condition);
          return { then(resolve?: (rows: unknown) => unknown, reject?: (error: unknown) => unknown) {
            const work: Promise<unknown> = Promise.resolve(query);
            shadowReads.push(work);
            return work.then(resolve, reject);
          } };
        } };
      } };
    },
  };
  const ephemeral = moduleOf<Internals>('federation/dmEphemeral', {
    'drizzle-orm': orm, '@gusvoice/shared': shared, '../blocks.js': blocks,
    '../db/index.js': { db: ephemeralDb }, '../db/schema.js': schema,
    '../gateway.js': { isUserDmPresent: (id: string) => online.has(id),
      relayFedTyping: async (...args: string[]) => { typing.push(args); },
      setRemoteDmPresence: (id: string, value: boolean) => { presence.push([id, value]); } },
    '../lastSeenRules.js': lastSeenRules,
    './directorySync.js': { refreshCapabilities: async (row: typeof link) => { refreshes.push(row.instanceId); return row.features; } },
    './guestHost.js': { shadowUserFor: async (home: string, id: string) => (await t.db.select().from(schema.users)
      .where(orm.and(orm.eq(schema.users.homeInstanceId, home), orm.eq(schema.users.homeUserId, id))).limit(1))[0] ?? null },
    './instance.js': { federation: { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture', privateKeyDer: new Uint8Array([1]) }) } },
    './peerClient.js': { postSignedToPeer: async (arg: typeof requests[number]) => {
      requests.push(arg);
      for (const resolve of postWaiters.splice(0)) resolve(arg);
      return { ok: true, value: { status: 202 } };
    } },
  }, { Date: ClockDate,
    setTimeout: (fn: () => void, ms: number) => { const handle = { unref() {} }; timeouts.set(handle, { fn, ms }); return handle; },
    clearTimeout: (handle: object) => { timeouts.delete(handle); },
    setInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms }); return { unref() {} }; },
  }, options.mutations, '\nexport { sendTyping as testSendTyping, flushPresence as testFlushPresence };\n');
  const sentPresence = () => requests.filter(r => r.payload.kind === 'presence');
  return { ephemeral, link, blocks, requests, typing, presence, refreshes, online, intervals, timeouts, sentPresence, shadowReads,
    nextPost: () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let resolvePost!: (request: typeof requests[number]) => void;
      const pending = new Promise<typeof requests[number]>((resolve, reject) => {
        resolvePost = resolve; postWaiters.push(resolvePost);
        timeout = setTimeout(() => reject(new Error('keepalive не дошёл до транспортной границы')), 5000);
      });
      return pending.finally(() => {
        if (timeout) clearTimeout(timeout);
        const at = postWaiters.indexOf(resolvePost); if (at >= 0) postWaiters.splice(at, 1);
      });
    },
    settleShadowIds: async () => {
      // await thenable начинает SQL микрозадачей; после результата ждём продолжение refreshShadowIds.
      await Promise.resolve(); await Promise.all(shadowReads); await Promise.resolve();
    },
    now: () => now, advance: (ms: number) => { now += ms; } };
}
function presenceWire(at = NOW, online = true, userId = 'remote', home = peer) {
  return shared.serializeEphemeralWire(peer, { kind: 'presence', user: { instanceId: home, userId }, at, online,
    views: [
      { user: { instanceId: self, userId: 'viewer' }, lastSeen: NOW - 1000, approx: null },
      { user: { instanceId: self, userId: 'blocked' }, lastSeen: NOW - 2000, approx: null },
      { user: { instanceId: third, userId: 'foreign' }, lastSeen: NOW - 3000, approx: null },
    ] });
}
function typingWire(until = NOW + shared.FED_TYPING_TTL_MS, stop = false) {
  return shared.serializeEphemeralWire(peer, { kind: 'typing', conversationId: conv, user: { instanceId: peer, userId: 'remote' }, action: 'voice', until, stop });
}

test('R197 приём отвергает чужой дом, пропускает неизвестную или удалённую тень, знакомую принимает', async () => {
  const f = await fixture();
  assert.equal((await f.ephemeral.acceptEphemeral(f.link, {})).status, 400);
  assert.equal((await f.ephemeral.acceptEphemeral(f.link, { kind: 'newer' })).body.ignored, true);
  assert.equal((await f.ephemeral.acceptEphemeral(f.link, presenceWire(NOW, true, 'remote', third))).status, 403);
  assert.equal((await f.ephemeral.acceptEphemeral(f.link, presenceWire(NOW, true, 'unknown'))).body.ignored, true);
  assert.deepEqual(f.presence, []);
  await t.db.update(schema.users).set({ deletedAt: new Date() }).where(orm.eq(schema.users.id, 'shadow'));
  assert.equal((await f.ephemeral.acceptEphemeral(f.link, presenceWire())).body.ignored, true);
  await t.db.update(schema.users).set({ deletedAt: null }).where(orm.eq(schema.users.id, 'shadow'));
  assert.equal((await f.ephemeral.acceptEphemeral(f.link, presenceWire())).body.ignored, undefined);
  assert.deepEqual(f.presence, [['shadow', true]]);
});
test('R197 presence принимает только больший at, старое и равное событие не меняют online и время', async () => {
  const f = await fixture();
  await f.ephemeral.acceptEphemeral(f.link, presenceWire());
  for (const at of [NOW - 1, NOW]) assert.equal((await f.ephemeral.acceptEphemeral(f.link, presenceWire(at, false))).body.ignored, true);
  assert.deepEqual(f.presence, [['shadow', true]]);
  assert.equal(f.ephemeral.remoteLastSeenFor('shadow', 'viewer')?.lastSeenAt?.getTime(), NOW - 1000);
  assert.equal((await f.ephemeral.acceptEphemeral(f.link, presenceWire(NOW + 1, false))).body.ignored, undefined);
  assert.deepEqual(f.presence, [['shadow', true], ['shadow', false]]);
});
test('R197 зритель с блокировкой и чужой инстанс не получают время, разблокированный получает точный итог дома', async () => {
  const f = await fixture(); await f.blocks.blockUser('blocked', 'shadow');
  await f.ephemeral.acceptEphemeral(f.link, presenceWire());
  assert.equal(f.ephemeral.remoteLastSeenFor('shadow', 'viewer')?.shares, true);
  for (const id of ['blocked', 'foreign', 'missing']) {
    const v = f.ephemeral.remoteLastSeenFor('shadow', id); assert.equal(v?.shares, false); assert.equal(v?.lastSeenAt, null);
  }
  assert.equal(f.ephemeral.remoteLastSeenFor('unknown', 'viewer'), null);
  await f.blocks.unblockUser('blocked', 'shadow'); await f.ephemeral.acceptEphemeral(f.link, presenceWire(NOW + 1));
  assert.equal(f.ephemeral.remoteLastSeenFor('shadow', 'blocked')?.shares, true);
});
test('R197 точное время из будущего ограничивается нашими часами, категории остаются скрытыми', async () => {
  const f = await fixture();
  const wire = presenceWire();
  wire.views = [
    { user: { instance_id: self, user_id: 'viewer' }, last_seen: NOW + 10_000 },
    { user: { instance_id: self, user_id: 'blocked' }, last_seen: null, approx: 'week' },
  ];
  await f.ephemeral.acceptEphemeral(f.link, wire);
  assert.equal(f.ephemeral.remoteLastSeenFor('shadow', 'viewer')?.lastSeenAt?.getTime(), NOW);
  assert.equal(f.ephemeral.remoteLastSeenFor('shadow', 'blocked')?.shares, false);
  assert.equal(f.ephemeral.remoteLastSeenFor('shadow', 'blocked')?.lastSeenAt?.getTime(), NOW - 5 * 86_400_000);
});
test('R197 typing в пределах опоздания проходит, ровно 30 секунд и stop не оживляют набор', async () => {
  const f = await fixture();
  await f.ephemeral.acceptEphemeral(f.link, typingWire(NOW - 30_000));
  await f.ephemeral.acceptEphemeral(f.link, typingWire(NOW - 30_000 + 1));
  await f.ephemeral.acceptEphemeral(f.link, typingWire(NOW + 6000, true));
  assert.deepEqual(f.typing, [['shadow', conv, 'voice']]);
});
test('R197 присутствие не протухает ровно на 150 секунд, затем уходит offline один раз и возрождается новым at', async () => {
  const f = await fixture(); await f.ephemeral.acceptEphemeral(f.link, presenceWire());
  f.ephemeral.startDmEphemeral(); f.ephemeral.startDmEphemeral();
  assert.equal(f.intervals.length, 2);
  const stale = f.intervals.find(job => job.ms === 30_000)!;
  f.advance(shared.FED_PRESENCE_STALE_MS); stale.fn(); assert.equal(f.presence.length, 1);
  f.advance(1); stale.fn(); assert.deepEqual(f.presence, [['shadow', true], ['shadow', false]]);
  stale.fn(); assert.equal(f.presence.length, 2);
  assert.equal(f.ephemeral.remoteLastSeenFor('shadow', 'viewer')?.lastSeenAt?.getTime(), NOW - 1000);
  await f.ephemeral.acceptEphemeral(f.link, presenceWire(NOW + 1)); assert.equal(f.presence.at(-1)?.[1], true);
});

async function shadowTickScenario(mutations: readonly Mutation[] = []) {
  const f = await fixture({ mutations });
  let keepalive: Promise<typeof f.requests[number]> | null = null;
  try {
    await f.ephemeral.testFlushPresence('local', false);
    assert.equal(f.sentPresence().length, 1);
    f.ephemeral.startDmEphemeral(); f.ephemeral.startDmEphemeral();
    assert.equal(f.intervals.length, 2, 'обновление теней не заводит третий штатный интервал');
    assert.deepEqual(f.intervals.map(job => job.ms).sort((a, b) => a - b), [30_000, shared.FED_PRESENCE_ALIVE_MS]);
    await f.settleShadowIds();
    assert.equal(f.shadowReads.length, 1, 'повторный start не перечитывает теней');
    assert.equal(f.ephemeral.isKnownShadow('shadow'), true);
    assert.equal(f.ephemeral.isKnownShadow('shadow2'), true);
    assert.equal(f.ephemeral.isKnownShadow('local'), false);
    await t.db.insert(schema.users).values({ id: 'new-shadow', username: 'ephemeral_new_shadow', displayName: 'Новый сосед', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'new-remote' });
    await t.db.delete(schema.users).where(orm.eq(schema.users.id, 'shadow2'));
    assert.equal(f.ephemeral.isKnownShadow('new-shadow'), false, 'SQL-изменение ждёт минутного такта');
    assert.equal(f.ephemeral.isKnownShadow('shadow2'), true);
    f.advance(shared.FED_PRESENCE_ALIVE_MS);
    keepalive = f.nextPost();
    f.intervals.find(job => job.ms === shared.FED_PRESENCE_ALIVE_MS)!.fn();
    await f.settleShadowIds();
    // Тот же callback обязан продолжать посылать «жив», а не только обслуживать новый кеш.
    const sent = await keepalive;
    assert.equal(sent.payload.kind, 'presence'); assert.equal(sent.payload.online, true); assert.equal(sent.payload.at, f.now());
    assert.equal(f.sentPresence().length, 2);
    assert.equal(f.ephemeral.isKnownShadow('new-shadow'), true, 'минутный такт обновляет новые и удалённые тени');
    assert.equal(f.ephemeral.isKnownShadow('shadow2'), false, 'минутный такт обновляет новые и удалённые тени');
    assert.equal(f.ephemeral.isKnownShadow('shadow'), true);
    assert.equal(f.ephemeral.isKnownShadow('local'), false);
    assert.equal(f.shadowReads.length, 2);
    assert.equal(f.intervals.length, 2);
  } finally {
    await f.settleShadowIds();
    if (keepalive) await keepalive;
  }
}

test('R202 минутный такт посылает «жив» и обновляет новые и удалённые тени без третьего таймера', async () => {
  await shadowTickScenario();
});
test('R202 потеря обновления теней в минутном такте обнаруживается реальными SQL-изменениями', async () => {
  await shadowTickScenario(); await truncateAll(t.raw);
  await assert.rejects(shadowTickScenario([[
    'const alive = setInterval(() => {\n    void refreshShadowIds().catch(() => {});',
    'const alive = setInterval(() => {',
  ]]), e => e instanceof assert.AssertionError && e.message.includes('минутный такт обновляет новые и удалённые тени'));
});
test('R202 отдельный третий интервал обновления теней не заменяет совмещённый минутный такт', async () => {
  await shadowTickScenario(); await truncateAll(t.raw);
  await assert.rejects(shadowTickScenario([[
    'const stale = setInterval(() => {',
    'setInterval(() => { void refreshShadowIds().catch(() => {}); }, FED_PRESENCE_ALIVE_MS);\n  const stale = setInterval(() => {',
  ]]), e => e instanceof assert.AssertionError && e.message.includes('обновление теней не заводит третий штатный интервал'));
});

async function capabilitiesScenario(mutations: readonly Mutation[] = []) {
  const f = await fixture({ dm3: false, mutations });
  await f.ephemeral.testSendTyping(conv, 'local', 'shadow', 'voice');
  await f.ephemeral.testFlushPresence('local', false);
  assert.equal(f.refreshes.length, 1, 'отсутствующее dm3 перепроверено один раз');
  assert.equal(f.requests.length, 0, 'без dm3 не уходят ни typing, ни presence');
  await truncateAll(t.raw); const on = await fixture({ mutations });
  await on.ephemeral.testSendTyping(conv, 'local', 'shadow', 'voice'); await on.ephemeral.testFlushPresence('local', false);
  assert.deepEqual(on.requests.map(r => r.payload.kind), ['typing', 'presence']);
  assert.equal(on.refreshes.length, 0);
  for (const r of on.requests) {
    assert.equal(r.path, '/api/fed/v1/ephemeral'); assert.deepEqual([...r.allowHosts], ['peer.invalid']);
    assert.equal(r.payload.instance_id, self); assert.equal(r.payload.user.instance_id, self); assert.equal(r.now, NOW);
  }
}
test('R197 сосед без dm3 не получает эфемерные записи, обновлённый получает оба вида', async () => {
  await capabilitiesScenario();
});
test('R197 заблокированному местным автором не уходят typing и presence, снятие блока возобновляет оба', async () => {
  const f = await fixture(); await f.blocks.blockUser('local', 'shadow');
  await f.ephemeral.testSendTyping(conv, 'local', 'shadow', 'voice'); await f.ephemeral.testFlushPresence('local', false);
  assert.equal(f.requests.length, 0);
  await f.blocks.unblockUser('local', 'shadow');
  await f.ephemeral.testSendTyping(conv, 'local', 'shadow', 'voice'); await f.ephemeral.testFlushPresence('local', false);
  assert.deepEqual(f.requests.map(r => r.payload.kind), ['typing', 'presence']);
});
test('R197 невидимый местный автор делится временем в ЛС, never и Никто дают только recently, always возвращает время', async () => {
  const f = await fixture();
  await f.ephemeral.testFlushPresence('local', false);
  let v = f.sentPresence().at(-1)!.payload.views[0];
  assert.equal(v.last_seen, NOW, 'Невидимый не скрывает время в ЛС'); assert.equal(v.approx, undefined);
  await t.db.insert(schema.lastSeenExceptions).values({ ownerId: 'local', targetId: 'shadow', kind: 'never' });
  await f.ephemeral.testFlushPresence('local', false); v = f.sentPresence().at(-1)!.payload.views[0];
  assert.equal(v.last_seen, null); assert.equal(v.approx, 'recently');
  await t.db.delete(schema.lastSeenExceptions); await t.db.update(schema.users).set({ lastSeenPrivacy: 'nobody' }).where(orm.eq(schema.users.id, 'local'));
  await f.ephemeral.testFlushPresence('local', false); v = f.sentPresence().at(-1)!.payload.views[0];
  assert.equal(v.last_seen, null); assert.equal(v.approx, 'recently');
  await t.db.insert(schema.lastSeenExceptions).values({ ownerId: 'local', targetId: 'shadow', kind: 'always' });
  await f.ephemeral.testFlushPresence('local', false); v = f.sentPresence().at(-1)!.payload.views[0];
  assert.equal(v.last_seen, NOW); assert.equal(v.approx, undefined);
  f.online.delete('local'); f.advance(2500); await f.ephemeral.testFlushPresence('local', false);
  assert.equal(f.sentPresence().at(-1)!.payload.online, false); assert.equal(f.sentPresence().at(-1)!.payload.views[0].last_seen, NOW + 500);
});
test('R197 privacy исключения считаются отдельно по собеседнику в одной записи дома', async () => {
  const f = await fixture();
  await t.db.insert(schema.conversations).values({ id: 'second-direct', kind: 'direct', directKey: 'local:shadow2', createdBy: 'local' });
  await t.db.insert(schema.conversationMembers).values([{ conversationId: 'second-direct', userId: 'local' }, { conversationId: 'second-direct', userId: 'shadow2' }]);
  await t.db.insert(schema.lastSeenExceptions).values({ ownerId: 'local', targetId: 'shadow', kind: 'never' });
  await f.ephemeral.testFlushPresence('local', false);
  assert.equal(f.sentPresence().length, 1);
  const views = f.sentPresence()[0].payload.views;
  assert.equal(views.find((v: any) => v.user.user_id === 'remote').last_seen, null);
  assert.equal(views.find((v: any) => v.user.user_id === 'remote').approx, 'recently');
  assert.equal(views.find((v: any) => v.user.user_id === 'remote2').last_seen, NOW);
});
test('R197 typing повторяется ровно через 3 секунды, другой вид и другая беседа имеют отдельный ключ', async () => {
  const f = await fixture();
  await f.ephemeral.testSendTyping(conv, 'local', 'shadow', 'typing');
  await f.ephemeral.testSendTyping(conv, 'local', 'shadow', 'typing'); assert.equal(f.requests.length, 1);
  f.advance(2999); await f.ephemeral.testSendTyping(conv, 'local', 'shadow', 'typing'); assert.equal(f.requests.length, 1);
  f.advance(1); await f.ephemeral.testSendTyping(conv, 'local', 'shadow', 'typing'); assert.equal(f.requests.length, 2);
  await f.ephemeral.testSendTyping(conv, 'local', 'shadow', 'round');
  await f.ephemeral.testSendTyping('second-conv', 'local', 'shadow', 'typing'); assert.equal(f.requests.length, 4);
  assert.equal(f.requests[0].payload.action, undefined); assert.equal(f.requests[0].payload.until, NOW + shared.FED_TYPING_TTL_MS);
  assert.equal(f.requests[2].payload.action, 'round'); assert.equal(f.requests[2].payload.until, NOW + 3000 + shared.FED_TYPING_TTL_MS);
});
test('R197 местный offline адресат и чужой автор не отправляются соседу, местный автор теневому отправляется', async () => {
  const f = await fixture();
  await f.ephemeral.testSendTyping(conv, 'local', 'viewer', 'voice');
  await f.ephemeral.testSendTyping(conv, 'shadow', 'shadow2', 'voice');
  await f.ephemeral.testFlushPresence('shadow', false); assert.equal(f.requests.length, 0);
  await f.ephemeral.testSendTyping(conv, 'local', 'shadow', 'voice'); assert.equal(f.requests.length, 1);
});

test('R197 мутант без проверки dm3 пойман на беззвучной связке до парного положительного приёма', async () => {
  await capabilitiesScenario(); await truncateAll(t.raw);
  await assert.rejects(capabilitiesScenario([['if (features.includes(FED_FEATURES.dm3)) link = row as unknown as StoredLink;', 'link = row as unknown as StoredLink;']]),
    e => e instanceof assert.AssertionError && e.message.includes('без dm3 не уходят'));
});
test('R197 мутант серверного invisible в sharesLastSeen ловится фактическим payload ЛС', async () => {
  const check = async (mutations: readonly Mutation[] = []) => {
    const f = await fixture({ mutations }); await f.ephemeral.testFlushPresence('local', false);
    assert.equal(f.sentPresence().at(-1)!.payload.views[0].last_seen, NOW, 'Невидимый не скрывает время ЛС от собеседника');
  };
  await check(); await truncateAll(t.raw);
  await assert.rejects(check([
    ['privacy: users.lastSeenPrivacy, home: users.homeInstanceId, deletedAt: users.deletedAt', 'privacy: users.lastSeenPrivacy, presence: users.presenceStatus, home: users.homeInstanceId, deletedAt: users.deletedAt'],
    ['sharesLastSeen(privacy, false, true, exceptionOf({ exceptions }, p.peer))', "sharesLastSeen(privacy, me.presence === 'invisible', true, exceptionOf({ exceptions }, p.peer))"],
  ]), e => e instanceof assert.AssertionError && e.message.includes('Невидимый не скрывает время ЛС'));
});
test('R197 мутант чужого user.instance_id не проходит адресную проверку принадлежности', async () => {
  const check = async (mutations: readonly Mutation[] = []) => {
    const f = await fixture({ mutations });
    assert.equal((await f.ephemeral.acceptEphemeral(f.link, presenceWire(NOW, true, 'remote', third))).status, 403, 'не свой человек не принимается от связки');
    assert.deepEqual(f.presence, []);
    assert.equal((await f.ephemeral.acceptEphemeral(f.link, presenceWire())).status, 202);
  };
  await check(); await truncateAll(t.raw);
  await assert.rejects(check([['if (e.user.instanceId !== link.instanceId)', 'if (false)']]),
    e => e instanceof assert.AssertionError && e.message.includes('не свой человек не принимается'));
});
