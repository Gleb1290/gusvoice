import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as core from '../src/federation/directorySyncCore.js';
import * as directoryRules from '../src/federation/directoryRules.js';
import * as convRules from '../src/convRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
beforeEach(async () => { await truncateAll(t.raw); });
after(async () => { await t.close(); });
type Sync = typeof import('../src/federation/directorySync.js');
type Mutation = readonly [string, string];
const NOW = 2_000_000_000_000;
const first = 'a'.repeat(32), second = 'b'.repeat(32), paused = 'c'.repeat(32);
const forbidden = (name: string) => () => { throw new Error(`неисполняемая граница ${name}`); };
function moduleOf<T>(code: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    module, exports: module.exports, Date, URL,
    console: { warn() {}, log() {} }, setInterval: forbidden('worker timer'),
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `явный импорт ${id}`); return deps[id]; },
  });
  return module.exports as T;
}
async function fixture(mutation?: Mutation) {
  await t.db.insert(schema.federationLinks).values([
    { instanceId: first, domain: 'first.invalid', apiBase: 'https://first.invalid/api', clientOrigin: 'https://first.invalid', rootKey: 'fixture', state: 'active', features: [shared.FED_FEATURES.directory] },
    { instanceId: second, domain: 'second.invalid', apiBase: 'https://second.invalid/api', clientOrigin: 'https://second.invalid', rootKey: 'fixture', state: 'active', features: [] },
    { instanceId: paused, domain: 'paused.invalid', apiBase: 'https://paused.invalid/api', clientOrigin: 'https://paused.invalid', rootKey: 'fixture', state: 'paused', features: [shared.FED_FEATURES.directory] },
  ]);
  const requests: { apiBase: string; allowHosts: Set<string>; now: number }[] = [];
  let mode: 'ok' | 'unreachable' | 'wrong-home' = 'ok';
  let features: string[] = [shared.FED_FEATURES.directory, shared.FED_FEATURES.dm3];
  const deps: Record<string, unknown> = {
    'drizzle-orm': orm, '@gusvoice/shared': shared, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    './instance.js': { federation: { identity: () => ({ instanceId: 'd'.repeat(32) }), signingKey: () => null } },
    './guestRevocation.js': { fetchRevocations: async () => null },
    './guestMembership.js': { reconcileMemberships: forbidden('reconcileMemberships') },
    './peerClient.js': {
      getSignedFromPeer: forbidden('каталог не пора обновлять'),
      fetchPeerDocument: async (arg: typeof requests[number]) => {
        requests.push(arg);
        if (mode === 'unreachable') return { ok: false };
        return { ok: true, value: { instanceId: mode === 'wrong-home' ? paused : arg.apiBase.includes('first.') ? first : second,
          protocolVersion: 1, doc: { features } } };
      },
    },
    './links.js': { linkService: { resendConfirmation: forbidden('resendConfirmation') } },
    './directoryCache.js': { applyDirectoryEntries: forbidden('applyDirectoryEntries'), applyServerEntries: forbidden('applyServerEntries'),
      cacheSizes: forbidden('cacheSizes'), reconcileDirectory: forbidden('reconcileDirectory'), reconcileServers: forbidden('reconcileServers') },
    './directoryRules.js': directoryRules,
    // Расписание — отдельный покрытый модуль; здесь изолируем исполнение syncOneLink от ещё не наступившей сверки каталогов.
    './syncSchedule.js': { planSync: () => 'idle' }, './instanceMeta.js': { readInstanceMeta: async () => ({ paused: false }) },
    './directorySyncCore.js': core,
  };
  let code = readFileSync(new URL('../src/federation/directorySync.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation) { assert.equal(code.split(mutation[0]).length, 2, 'единственный якорь syncOneLink'); code = code.replace(...mutation); }
  const sync = moduleOf<Sync>(code, deps);
  const link = async (id: string) => (await t.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, id)))[0]!;
  return { sync, requests, link, mode: (next: typeof mode) => { mode = next; }, features: (next: string[]) => { features = next; } };
}

async function everyLinkScenario(mutation?: Mutation) {
  const f = await fixture(mutation);
  const report = await f.sync.runSyncPass(NOW);
  assert.equal(report.failed, 0);
  assert.equal(f.requests.length, 2, 'каждая активная связка перечитывает визитку, включая уже умеющую directory');
  for (const id of [first, second]) assert.equal((await f.link(id)).features.includes(shared.FED_FEATURES.dm3), true);
  assert.equal((await f.link(paused)).features.includes(shared.FED_FEATURES.dm3), false);
  assert.equal(f.requests.some(r => r.apiBase.includes('paused.')), false);
  for (const r of f.requests) { assert.deepEqual([...r.allowHosts], [new URL(r.apiBase).host]); assert.equal(r.now, NOW); }
}
test('R197 сверка перечитывает capabilities всех активных связок, а не только соседей без directory', async () => {
  await everyLinkScenario();
});
test('R197 прежнее условие !directory поймано на уже работающей связке и её новом dm3', async () => {
  await everyLinkScenario(); await truncateAll(t.raw);
  await assert.rejects(everyLinkScenario(['features = await refreshCapabilities(link, now);', 'if (!features.includes(FED_FEATURES.directory)) features = await refreshCapabilities(link, now);']),
    e => e instanceof assert.AssertionError && e.message.includes('каждая активная связка перечитывает'));
});
test('R197 визитка обновляется ровно через час, до границы транспорт не вызывается', async () => {
  const f = await fixture();
  await f.sync.refreshCapabilities(await f.link(first), NOW);
  const fresh = await f.link(first);
  assert.equal(fresh.features.includes(shared.FED_FEATURES.dm3), true);
  await f.sync.refreshCapabilities(fresh, NOW + 3_600_000 - 1); assert.equal(f.requests.length, 1);
  await f.sync.refreshCapabilities(fresh, NOW + 3_600_000); assert.equal(f.requests.length, 2);
});
test('R197 недоступная визитка или другой дом не стирают старые features, честный дом обновляет строку', async () => {
  for (const mode of ['unreachable', 'wrong-home'] as const) {
    await truncateAll(t.raw); const f = await fixture(); f.mode(mode);
    const old = await f.link(first);
    const result = await f.sync.refreshCapabilities(old, NOW);
    assert.deepEqual([...result], [shared.FED_FEATURES.directory]);
    assert.deepEqual((await f.link(first)).features, [shared.FED_FEATURES.directory]);
    f.mode('ok');
    await f.sync.refreshCapabilities(await f.link(first), NOW + 3_600_000);
    assert.equal((await f.link(first)).features.includes(shared.FED_FEATURES.dm3), true);
  }
});

async function forceScenario(mutation?: Mutation) {
  const f = await fixture(mutation); await f.sync.refreshCapabilities(await f.link(first), NOW, { force: true });
  const fresh = await f.link(first);
  await f.sync.refreshCapabilities(fresh, NOW + 59_999, { force: true });
  assert.equal(f.requests.length, 1, 'force не перечитывает раньше полной минуты');
  await f.sync.refreshCapabilities(fresh, NOW + 60_000, { force: true }); assert.equal(f.requests.length, 2);
  await f.sync.refreshCapabilities(fresh, NOW + 60_000 + 3_600_000 - 1); assert.equal(f.requests.length, 2);
  await f.sync.refreshCapabilities(fresh, NOW + 60_000 + 3_600_000); assert.equal(f.requests.length, 3);
}
test('R201 force перечитывает не чаще минуты и сдвигает час последнего успешного ответа', async () => { await forceScenario(); });
async function failureScenario(mutation?: Mutation) {
  const f = await fixture(mutation); f.mode('unreachable'); const old = await f.link(first);
  await f.sync.refreshCapabilities(old, NOW); f.mode('ok');
  await f.sync.refreshCapabilities(old, NOW + 59_999); assert.equal(f.requests.length, 1);
  await f.sync.refreshCapabilities(old, NOW + 60_000);
  assert.equal(f.requests.length, 2, 'сбой визитки допускает повтор через минуту, а не час');
  assert.equal((await f.link(first)).features.includes(shared.FED_FEATURES.dm3), true);
}
test('R201 неудача обычной визитки оставляет признаки и допускает повтор точно через минуту', async () => { await failureScenario(); });

async function changedScenario(mutation?: Mutation) {
  const f = await fixture(mutation);
  const names = ['local', 'otherLocal', 'goneLocal', 'shadowFirst', 'shadowSecond'];
  await t.db.insert(schema.users).values(names.map(id => ({ id, username: `caps_${id}`, displayName: id, passwordHash: 'fixture',
    homeInstanceId: id === 'shadowFirst' ? first : id === 'shadowSecond' ? second : null,
    homeUserId: id.startsWith('shadow') ? 'remote' : null })));
  await t.db.insert(schema.conversations).values([
    { id: 'first-direct', kind: 'direct', directKey: 'first:pair', createdBy: 'local' },
    { id: 'second-direct', kind: 'direct', directKey: 'second:pair', createdBy: 'local' },
    { id: 'local-direct', kind: 'direct', directKey: 'local:otherLocal', createdBy: 'local' },
    { id: 'left-direct', kind: 'direct', directKey: 'left:pair', createdBy: 'goneLocal' },
  ]);
  await t.db.insert(schema.conversationMembers).values([
    { conversationId: 'first-direct', userId: 'local' }, { conversationId: 'first-direct', userId: 'shadowFirst' },
    { conversationId: 'second-direct', userId: 'local' }, { conversationId: 'second-direct', userId: 'shadowSecond' },
    { conversationId: 'local-direct', userId: 'local' }, { conversationId: 'local-direct', userId: 'otherLocal' },
    { conversationId: 'left-direct', userId: 'goneLocal', leftAt: new Date() }, { conversationId: 'left-direct', userId: 'shadowFirst' },
  ]);
  const c = moduleOf<typeof import('../src/conversations.js')>(readFileSync(new URL('../src/conversations.ts', import.meta.url), 'utf8'), {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': convRules, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './dmWriteBarrier.js': { dmWriteBarrier: forbidden('dmWriteBarrier') },
    './attachments.js': { attachmentLink: forbidden('attachmentLink'), attachmentStore: {}, copyForForward: forbidden('copyForForward'), DailyQuotaError: class extends Error {}, discardForwardCopies: forbidden('discardForwardCopies'), privateAttachmentsReady: forbidden('privateAttachmentsReady'), purgeDeleted: forbidden('purgeDeleted') },
    './env.js': { env: {} }, './util.js': { uuidv7: randomUUID }, './serialize.js': { homeInstanceOf: forbidden('homeInstanceOf'), serializeMessage: forbidden('serializeMessage') },
  });
  const deliveries: Parameters<typeof c.deliver>[0][] = [];
  const convLink = moduleOf<typeof import('../src/federation/convLink.js')>(readFileSync(new URL('../src/federation/convLink.ts', import.meta.url), 'utf8'), {
    'drizzle-orm': orm, '@gusvoice/shared': shared, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../conversations.js': { ...c, deliver: async (d: Parameters<typeof c.deliver>[0]) => { deliveries.push(d); } },
    './instanceMeta.js': { readInstanceMeta: async () => ({ paused: false }) }, './instanceBan.js': { sendReport: forbidden('sendReport') },
  });
  const changed: string[] = [], work: Promise<void>[] = [];
  f.sync.configureCapsChanged(id => { changed.push(id); work.push(convLink.announceConvs(id)); });
  const stale = await f.link(first);
  await f.sync.refreshCapabilities(stale, NOW); await Promise.all(work);
  assert.deepEqual(changed, [first]);
  const entries = await t.db.select().from(schema.userChanges);
  assert.deepEqual(entries.map(e => [e.userId, e.conversationId, e.kind]), [['local', 'first-direct', 'conv']]);
  assert.equal(deliveries.length, 1); const delivered = deliveries[0]; assert.ok(delivered);
  assert.equal(delivered.conversationId, 'first-direct'); assert.equal(delivered.messageId, null);
  assert.equal(delivered.pts.has('local'), true); assert.equal(delivered.pts.has('shadowFirst'), false);
  // Старый аргумент не должен повторно объявлять уже записанный набор; порядок и повтор элемента не считаются изменением.
  f.features([shared.FED_FEATURES.dm3, shared.FED_FEATURES.directory, shared.FED_FEATURES.dm3]);
  await f.sync.refreshCapabilities(stale, NOW + 60_000, { force: true }); await Promise.all(work);
  assert.equal(changed.length, 1, 'равный набор features не объявляет беседы повторно'); assert.equal(deliveries.length, 1);
  f.features([shared.FED_FEATURES.directory]);
  await f.sync.refreshCapabilities(stale, NOW + 120_000, { force: true }); await Promise.all(work);
  assert.equal(changed.length, 2); assert.equal(deliveries.length, 2);
  f.sync.configureCapsChanged(null);
}
test('R201 смена набора capabilities объявляет conv местным 1:1 адресатам этого дома, равный набор молчит', async () => { await changedScenario(); });
for (const [name, mutation, check, failure] of [
  ['force без минуты', ['if (now - (capsForcedAt.get(link.instanceId) ?? 0) < CAPS_FORCE_MS) return link.features;', 'if (false) return link.features;'], forceScenario, 'force не перечитывает'],
  ['сбой ждёт час', ['if (!opts.force) capsCheckedAt.set(link.instanceId, now - CAPS_RECHECK_MS + CAPS_FORCE_MS);', '// failure leaves hourly stamp'], failureScenario, 'сбой визитки допускает повтор'],
  ['каждая визитка объявляет беседы', ['if (changed) featuresChanged?.(link.instanceId);', 'featuresChanged?.(link.instanceId);'], changedScenario, 'равный набор features'],
] as [string, Mutation, (mutation?: Mutation) => Promise<void>, string][]) {
  test(`R201 мутант capabilities «${name}» пойман транспортом или conv журналом`, async () => {
    await check(); await truncateAll(t.raw); await assert.rejects(check(mutation), e => e instanceof assert.AssertionError && e.message.includes(failure));
  });
}
