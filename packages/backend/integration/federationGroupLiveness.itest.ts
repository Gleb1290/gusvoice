import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as convRules from '../src/convRules.js';
import * as barrier from '../src/dmWriteBarrier.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as linkService from '../src/federation/linkService.js';
import * as statusRules from '../src/statusRules.js';
import * as shopRules from '../src/shopRules.js';
import * as callRules from '../src/callRules.js';
import * as lastSeenRules from '../src/lastSeenRules.js';
import * as superAdminRules from '../src/superAdminRules.js';
import * as threatRules from '../src/linkThreatsRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
type Link = typeof import('../src/federation/convLink.js');
const self = 'a'.repeat(32), host = 'b'.repeat(32), otherHost = 'c'.repeat(32);
const cid = 'liveness-group', duration = 600_000;
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => {
  try { await t.close(); }
  finally { await (await import('../src/db/index.js')).pool.end(); }
});
const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const forbidden = (name: string) => () => { throw new Error(`незадействованная граница ${name}`); };
// Закрытый перечень импортов. Недоступные здесь функции не изображают правила: вызов сразу роняет обвязку.
const unreachable = (name: string) => new Proxy({}, { get: (_target, property) => property === '__esModule' ? true : forbidden(`${name}.${String(property)}`) });

function moduleOf<T>(name: string, dependencies: Record<string, unknown>, clock: { now: number }, warns: string[], mutation?: Mutation): T {
  let raw = source(name);
  if (mutation) {
    assert.equal(raw.split(mutation[0]).length - 1, 1, `единственный якорь ${name}`);
    raw = raw.replace(...mutation);
  }
  class ClockDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? clock.now : value instanceof Date ? value.getTime() : value); }
    static now() { return clock.now; }
  }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    module, exports: module.exports, Date: ClockDate, Map, Set, Promise, Buffer, URL,
    console: { warn: (value: unknown) => warns.push(String(value)) },
    setTimeout: forbidden('таймер'), setInterval: forbidden('worker'),
    require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `явный импорт ${name}:${id}`); return dependencies[id]; },
  });
  return module.exports as T;
}

async function fixture(mutation?: Mutation, convMutation?: Mutation) {
  await truncateAll(t.raw);
  const clock = { now: Date.now() }, warns: string[] = [];
  const m = <T>(name: string, deps: Record<string, unknown>, edit?: Mutation) => moduleOf<T>(name, deps, clock, warns, edit);
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'liveness_local', displayName: 'Местный', passwordHash: 'fixture', verified: true, approvedAt: new Date(clock.now) },
    { id: 'shadow', username: 'liveness_shadow', displayName: 'Тень', passwordHash: 'fixture', verified: true, homeInstanceId: host, homeUserId: 'remote', homeUsername: 'remote' },
  ]);
  await t.db.insert(schema.federationLinks).values([host, otherHost].map(instanceId => ({ instanceId,
    domain: `${instanceId === host ? 'host' : 'other'}.invalid`, apiBase: 'https://host.invalid/api', clientOrigin: 'https://host.invalid',
    rootKey: 'fixture-public-key', state: 'active', features: [shared.FED_FEATURES.dmgroup1],
  })));
  // У хоста нет своего участника в этой копии: обнаружение обязано идти по origin, не по теням состава.
  await t.db.insert(schema.conversations).values([
    { id: cid, kind: 'group', title: 'Чужой дом', originInstanceId: host, groupVersion: 1 },
    { id: 'other-group', kind: 'group', title: 'Здоровый дом', originInstanceId: otherHost, groupVersion: 1 },
    { id: 'local-group', kind: 'group', title: 'Местная группа', groupVersion: 1 },
  ]);
  await t.db.insert(schema.conversationMembers).values([cid, 'other-group', 'local-group'].map(conversationId => ({ conversationId, userId: 'local', role: 'owner' as const })));
  const common = { '@gusvoice/shared': shared, 'drizzle-orm': orm };
  const backend = { ...common, './db/index.js': { db: t.db }, './db/schema.js': schema };
  const fed = { ...common, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const env = { publicApiUrl: 'https://self.invalid', linkThreats: { enabled: false } };
  const meta = { readInstanceMeta: async () => ({ paused: false, name: 'Местный дом' }) };
  const links = m<typeof import('../src/federation/links.js')>('federation/links', {
    ...fed, 'node:crypto': { randomUUID }, './linkService.js': linkService, './instanceMeta.js': meta,
    './outbox.js': { queueDepth: async () => 0 }, './instance.js': unreachable('личность'),
    './linkCode.js': unreachable('код связки'), './peerClient.js': unreachable('транспорт'), './revocation.js': unreachable('отзыв'),
    './auditLog.js': unreachable('аудит'), './directoryCache.js': unreachable('каталог'), './peerAuth.js': unreachable('подпись'),
    './guestAccess.js': unreachable('гостевые сессии'), '../env.js': { env }, '../auth.js': unreachable('авторизация'),
    '../realtime.js': unreachable('админское событие'), '../corsOrigins.js': unreachable('CORS'),
  });
  const labels = m<typeof import('../src/federation/instanceLabels.js')>('federation/instanceLabels', {
    ...common, './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta,
  });
  await labels.refreshInstanceLabels();
  const threats = m<typeof import('../src/linkThreats.js')>('linkThreats', {
    'node:fs/promises': unreachable('файл угроз'), './env.js': { env }, './linkThreatsRules.js': threatRules,
  });
  const serializer = m<typeof import('../src/serialize.js')>('serialize', {
    ...common, './federation/instanceLabels.js': labels, './linkThreats.js': threats, './auth.js': unreachable('суперадмин'),
    './superAdminRules.js': superAdminRules, './env.js': { env }, './statusRules.js': statusRules, './shopRules.js': shopRules,
    './callRules.js': callRules, './lastSeenRules.js': lastSeenRules,
  });
  const changes = m<typeof import('../src/federation/convChanges.js')>('federation/convChanges', fed);
  const events: Array<{ userId: string; event: shared.GatewayServerMessage; cap: string }> = [];
  const c = m<typeof import('../src/conversations.js')>('conversations', {
    ...backend, './convRules.js': convRules, './serialize.js': serializer, './dmWriteBarrier.js': barrier,
    './util.js': { uuidv7: randomUUID }, './env.js': { env }, './attachments.js': unreachable('вложения'),
    './realtime.js': { publishToUser: async (userId: string, event: shared.GatewayServerMessage, options: { cap: string }) => { events.push({ userId, event, cap: options.cap }); } },
  }, convMutation);
  const link = m<Link>('federation/convLink', { ...fed, '../conversations.js': c, './instanceMeta.js': meta, './instanceBan.js': unreachable('жалоба') }, mutation);
  c.configureFederatedConv({ selfInstanceId: () => self, record: changes.recordFedConvChanges,
    linkBroken: link.brokenHomes, linkStale: link.staleHomes, groupHostSilent: link.silentHomes });
  return { clock, warns, link, c, changes, events };
}

const sorted = (s: ReadonlySet<string>) => [...s].sort();
async function summary(f: Awaited<ReturnType<typeof fixture>>, id = cid) {
  const value = (await f.c.listConversations('local', true)).conversations.find(c => c.id === id);
  assert.ok(value); return value;
}
function killed(prefix: string, actual: unknown, expected: unknown) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(prefix)
    && error.operator === 'strictEqual' && Object.is(error.actual, actual) && Object.is(error.expected, expected);
}

async function downBoundary(mutation?: Mutation) {
  const f = await fixture(mutation), start = f.clock.now;
  f.link.notePeerAnswer(host, null, null);
  f.clock.now = start + 1;
  assert.equal((await f.link.silentHomes([host])).has(host), false, 'R208 граница: мгновенный сетевой сбой не объявляет хост лежащим');
  f.clock.now = start + duration - 1;
  assert.equal((await f.link.silentHomes([host])).has(host), false);
  f.clock.now = start + duration;
  assert.equal((await f.link.silentHomes([host])).has(host), false, 'ровно десять минут ещё не дольше порога');
  f.clock.now++;
  assert.deepEqual(sorted(await f.link.silentHomes([host, host, otherHost])), [host]);
  assert.deepEqual(sorted(await f.link.brokenHomes([host])), [], 'молчание не равно разорванной связке');
  assert.deepEqual(sorted(await f.link.staleHomes([host])), [], 'сетевой сбой не меняет прежнюю плашку 1:1');
  assert.deepEqual(sorted(await f.link.silentHomes([])), []);
}
it('R208 сеть: до, ровно и после десяти минут; здоровый дом, broken и stale не заражаются', async () => { await downBoundary(); });
it('R208 нулевой порог обнаруживается именно преждевременным silent, а не ошибкой обвязки', async () => {
  await downBoundary();
  await assert.rejects(downBoundary(['const STALE_AFTER_MS = 10 * 60_000;', 'const STALE_AFTER_MS = 0;']),
    killed('R208 граница: мгновенный сетевой сбой не объявляет хост лежащим', true, false));
});

async function serverError(mutation?: Mutation) {
  const f = await fixture(mutation), start = f.clock.now;
  f.link.notePeerAnswer(host, 500, null);
  f.clock.now = start + duration - 1;
  f.link.notePeerAnswer(host, 599, 'не JSON');
  f.clock.now = start + duration + 1;
  assert.equal((await f.link.silentHomes([host])).has(host), true, 'R208 500: повторные 5xx сохраняют начало молчания');
}
it('R208 ровно 500 начинает молчание, повторный 599 не отодвигает начало', async () => { await serverError(); });
it('R208 > 500 вместо >= 500 обнаруживается отсутствием накопленного срока', async () => {
  await serverError();
  await assert.rejects(serverError(['if (status === null || status >= 500) {', 'if (status === null || status > 500) {']),
    killed('R208 500: повторные 5xx сохраняют начало молчания', false, true));
});

async function clearDown(mutation?: Mutation, status = 499) {
  const f = await fixture(mutation), start = f.clock.now;
  f.link.notePeerAnswer(host, 503, null);
  f.clock.now += duration + 1;
  assert.equal((await f.link.silentHomes([host])).has(host), true);
  f.link.notePeerAnswer(host, status, null);
  assert.equal((await f.link.silentHomes([host])).has(host), false, 'R208 ответ: ниже 500 снимает молчание');
  f.link.notePeerAnswer(host, null, null);
  assert.equal((await f.link.silentHomes([host])).has(host), false, 'следующий сбой копит новый срок');
  f.clock.now = start + 2 * (duration + 1);
  assert.equal((await f.link.silentHomes([host])).has(host), true);
}
for (const status of [199, 200, 401, 429, 499]) it(`R208 ответ ${status} оживляет хост; новый сбой начинает новый срок`, async () => { await clearDown(undefined, status); });
it('R208 забытое снятие отметки обнаруживается ответом 499', async () => {
  await clearDown();
  await assert.rejects(clearDown(['pullDownSince.delete(instanceId);', '/* мутант: молчание не снято */']),
    killed('R208 ответ: ниже 500 снимает молчание', true, false));
});

it('R208 404 и ошибка часов оживляют сеть, но старый stale позднее тоже включает silent', async () => {
  for (const [status, body] of [[404, null], [401, '{"error":"clock-skew"}']] as const) {
    const f = await fixture(), start = f.clock.now;
    f.link.notePeerAnswer(host, null, null);
    f.clock.now += duration + 1;
    f.link.notePeerAnswer(host, status, body);
    assert.deepEqual(sorted(await f.link.silentHomes([host])), []);
    f.clock.now += duration;
    assert.deepEqual(sorted(await f.link.silentHomes([host])), []);
    f.clock.now++;
    assert.deepEqual(sorted(await f.link.staleHomes([host])), [host]);
    assert.deepEqual(sorted(await f.link.silentHomes([host])), [host]);
    assert.deepEqual(sorted(await f.link.brokenHomes([host])), []);
    f.link.notePeerAnswer(host, 200, null);
    assert.deepEqual(sorted(await f.link.silentHomes([host])), []);
    assert.ok(f.clock.now > start);
  }
});

it('R208 silent включает настоящий незабранный SQL-журнал старше порога, подтверждённый курсор снимает', async () => {
  const f = await fixture();
  await t.db.insert(schema.conversationMembers).values({ conversationId: cid, userId: 'shadow' });
  await t.db.insert(schema.conversationMessages).values({ id: 'liveness-message', conversationId: cid, authorId: 'local', content: 'Ждёт забора', sortKey: 1 });
  // Драйвер PGlite и node-postgres имеют разные типы результатов; транзакционный SQL при этом один.
  await t.db.transaction(tx => f.changes.recordFedConvChanges(tx as unknown as Parameters<typeof f.changes.recordFedConvChanges>[0],
    [{ conversationId: cid, kind: 'msg', entityId: 'liveness-message' }]));
  const [entry] = await t.db.select().from(schema.fedConvChanges);
  assert.ok(entry); assert.equal(entry.instanceId, host);
  f.clock.now = entry.at.getTime() + duration;
  assert.deepEqual(sorted(await f.link.silentHomes([host])), []);
  f.clock.now++;
  assert.deepEqual(sorted(await f.link.staleHomes([host])), [host]);
  assert.deepEqual(sorted(await f.link.silentHomes([host])), [host]);
  await f.link.notePeerPull(host, entry.seq);
  assert.deepEqual(sorted(await f.link.silentHomes([host])), []);
});

async function summaryDown(convMutation?: Mutation) {
  const f = await fixture(undefined, convMutation);
  assert.equal((await summary(f)).fedGroupHost?.down, undefined);
  f.link.notePeerAnswer(host, null, null); f.clock.now += duration + 1;
  assert.deepEqual(sorted(await f.link.brokenHomes([host])), []);
  assert.equal((await summary(f)).fedGroupHost?.down, true, 'R208 сводка: молчание включает down без broken');
  assert.equal((await summary(f, 'other-group')).fedGroupHost?.down, undefined);
  assert.equal((await summary(f, 'local-group')).fedGroupHost, undefined);
  f.link.notePeerAnswer(host, 499, null);
  assert.equal((await summary(f)).fedGroupHost?.down, undefined);
}
it('R208 реальная сводка ставит down только молчащему чужому хосту и снимает после ответа', async () => { await summaryDown(); });
it('R208 удаление silent из сводки обнаруживается при всё ещё активной связке', async () => {
  await summaryDown();
  await assert.rejects(summaryDown(['groupHostsDown.has(r.origin_instance_id) || groupHostsSilent.has(r.origin_instance_id)', 'groupHostsDown.has(r.origin_instance_id)']),
    killed('R208 сводка: молчание включает down без broken', undefined, true));
});

it('R208 сверка знает один origin группы без 1:1 и рассылает журнал + conv.change на обеих переменах silent', async () => {
  const f = await fixture();
  await f.link.refreshFedLinks();
  assert.equal(f.events.length, 0); assert.equal((await t.db.select().from(schema.userChanges)).length, 0);
  f.link.notePeerAnswer(host, null, null); f.clock.now += duration;
  await f.link.refreshFedLinks(); assert.equal(f.events.length, 0);
  f.clock.now++;
  await f.link.refreshFedLinks();
  assert.equal(f.events.length, 1); assert.equal(f.events[0].userId, 'local'); assert.equal(f.events[0].cap, shared.FEATURE_GROUPS1);
  assert.equal(f.events[0].event.t, 'conv.change');
  assert.equal(f.events[0].event.t === 'conv.change' && 'fedGroupHost' in f.events[0].event.conversation && f.events[0].event.conversation.fedGroupHost?.down, true);
  const rows = await t.db.select().from(schema.userChanges);
  assert.deepEqual(rows.map(r => [r.userId, r.conversationId, r.kind]), [['local', cid, 'conv']]);
  assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 0, 'объявление не эхо-журнал соседу');
  await f.link.refreshFedLinks(); assert.equal(f.events.length, 1, 'неизменное состояние не дублируется');
  f.link.notePeerAnswer(host, 200, null);
  await f.link.refreshFedLinks();
  assert.equal(f.events.length, 2);
  const restored = f.events[1].event;
  assert.ok(restored.t === 'conv.change' && 'fedGroupHost' in restored.conversation);
  assert.equal(restored.conversation.fedGroupHost?.down, undefined);
  assert.equal((await t.db.select().from(schema.userChanges)).length, 2);
  assert.deepEqual(f.warns, []);
});

it('R208 пауза и возврат связки тоже обновляют группу без людей её хоста', async () => {
  const f = await fixture(); await f.link.refreshFedLinks();
  await t.db.update(schema.federationLinks).set({ state: 'paused' }).where(orm.eq(schema.federationLinks.instanceId, host));
  await f.link.refreshFedLinks(); assert.equal(f.events.length, 1); assert.equal((await summary(f)).fedGroupHost?.down, true);
  await t.db.update(schema.federationLinks).set({ state: 'active' }).where(orm.eq(schema.federationLinks.instanceId, host));
  await f.link.refreshFedLinks(); assert.equal(f.events.length, 2); assert.equal((await summary(f)).fedGroupHost?.down, undefined);
  assert.deepEqual(f.warns, []);
});

