import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as barrier from '../src/dmWriteBarrier.js';
import * as linkService from '../src/federation/linkService.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as contacts from '../src/federation/contacts.js';
import * as textGuards from '../src/federation/textGuards.js';
import * as statusRules from '../src/statusRules.js';
import * as shopRules from '../src/shopRules.js';
import * as callRules from '../src/callRules.js';
import * as lastSeenRules from '../src/lastSeenRules.js';
import * as superAdminRules from '../src/superAdminRules.js';
import * as threatRules from '../src/linkThreatsRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Edit = { file: string; from: string; to: string };
type Link = typeof import('../src/federation/convLink.js');
const self = 'a'.repeat(32), downHome = 'b'.repeat(32), staleHome = 'c'.repeat(32), unknownHome = 'd'.repeat(32);
const direct = 'peer-down-direct', staleDirect = 'peer-stale-direct', localDirect = 'peer-local-direct', group = 'peer-down-group';
const timeout = 600_000;
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { try { await t?.close(); } finally { await (await import('../src/db/index.js')).pool.end(); } });
const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

async function fixture(options: { group?: boolean; edit?: Edit } = {}) {
  await truncateAll(t.raw);
  const clock = { now: Date.now() }, warnings: string[] = [], unexpected: string[] = [];
  const no = (label: string) => () => { unexpected.push(label); throw new Error(`неописанная IO-граница ${label}`); };
  function moduleOf<T>(name: string, deps: Record<string, unknown>): T {
    let raw = source(name);
    if (options.edit?.file === name) {
      assert.equal(raw.split(options.edit.from).length - 1, 1, `единственный якорь R217 ${name}`); raw = raw.replace(options.edit.from, options.edit.to);
    }
    const imports: Record<string, unknown> = {};
    for (const statement of ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true).statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
      const id = (statement.moduleSpecifier as ts.StringLiteral).text;
      imports[id] = new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : no(`${name}:${id}.${String(key)}`) });
    }
    Object.assign(imports, deps);
    class ClockDate extends Date {
      constructor(value?: string | number | Date) { super(value === undefined ? clock.now : value instanceof Date ? value.getTime() : value); }
      static now() { return clock.now; }
    }
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
      { module, exports: module.exports, Date: ClockDate, Map, Set, Promise, Buffer, URL, Error,
        console: { warn: (...values: unknown[]) => warnings.push(values.map(String).join(' ')) },
        setInterval: no('постоянный таймер'), setTimeout: no('фоновый таймер'),
        require: (id: string) => { assert.equal(Object.hasOwn(imports, id), true, `явный импорт ${name}:${id}`); return imports[id]; } });
    return module.exports as T;
  }
  await t.db.insert(schema.users).values([
    ...['local', 'other'].map(id => ({ id, username: `peerdown_${id}`, displayName: id, passwordHash: 'fixture', verified: true, approvedAt: new Date(clock.now) })),
    ...[['down-shadow', downHome], ['stale-shadow', staleHome]].map(([id, home]) => ({ id, username: `peerdown_${id}`, displayName: id,
      passwordHash: 'fixture', homeInstanceId: home, homeUserId: id, homeUsername: id })),
  ]);
  await t.db.insert(schema.federationLinks).values([downHome, staleHome].map((instanceId, i) => ({ instanceId, domain: `peer${i}.invalid`, apiBase: `https://peer${i}.invalid/api`,
    clientOrigin: `https://peer${i}.invalid`, rootKey: 'fixture-public-key', state: 'active', features: ['dm1', 'dm2', 'dmgroup1'] })));
  await t.db.insert(schema.conversations).values([
    ...[[direct, 'down-shadow'], [staleDirect, 'stale-shadow'], [localDirect, 'other']].map(([id, peer]) => ({ id, kind: 'direct' as const, directKey: `local:${peer}`, createdBy: 'local', originInstanceId: self })),
    ...(options.group ? [{ id: group, kind: 'group' as const, title: 'Группа того же дома', originInstanceId: downHome, groupVersion: 1 }] : []),
  ]);
  await t.db.insert(schema.conversationMembers).values([
    ...[[direct, 'down-shadow'], [staleDirect, 'stale-shadow'], [localDirect, 'other']].flatMap(([conversationId, peer]) => ['local', peer].map(userId => ({ conversationId, userId, pending: false }))),
    ...(options.group ? [{ conversationId: group, userId: 'local', role: 'owner' as const, pending: false }] : []),
  ]);
  const common = { '@gusvoice/shared': shared, 'drizzle-orm': orm };
  const backend = { ...common, './db/index.js': { db: t.db }, './db/schema.js': schema };
  const fed = { ...common, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const env = { publicApiUrl: 'https://self.invalid', linkThreats: { enabled: false } };
  // Только ключ конфигурационного хранилища; readInstanceMeta и его разбор — целый настоящий модуль с реальным SQL.
  const meta = moduleOf<typeof import('../src/federation/instanceMeta.js')>('federation/instanceMeta', {
    ...fed, './instance.js': { FEDERATION_META_KEY: 'federation_meta' }, './contacts.js': contacts, './textGuards.js': textGuards,
  });
  const links = moduleOf<typeof import('../src/federation/links.js')>('federation/links', {
    ...fed, 'node:crypto': { randomUUID }, './linkService.js': linkService, './instanceMeta.js': meta,
    './outbox.js': { queueDepth: async () => 0 }, '../env.js': { env },
  });
  const labels = moduleOf<typeof import('../src/federation/instanceLabels.js')>('federation/instanceLabels', {
    ...common, './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta,
  });
  await labels.refreshInstanceLabels();
  const threats = moduleOf<typeof import('../src/linkThreats.js')>('linkThreats', { './env.js': { env }, './linkThreatsRules.js': threatRules });
  const serializer = moduleOf<typeof import('../src/serialize.js')>('serialize', {
    ...common, './federation/instanceLabels.js': labels, './linkThreats.js': threats, './superAdminRules.js': superAdminRules,
    './env.js': { env }, './statusRules.js': statusRules, './shopRules.js': shopRules, './callRules.js': callRules, './lastSeenRules.js': lastSeenRules,
  });
  const changes = moduleOf<typeof import('../src/federation/convChanges.js')>('federation/convChanges', fed);
  const events: { userId: string; body: shared.GatewayServerMessage; cap?: string }[] = [];
  const c = moduleOf<typeof import('../src/conversations.js')>('conversations', {
    ...backend, './convRules.js': rules, './serialize.js': serializer, './dmWriteBarrier.js': barrier,
    './util.js': { uuidv7: randomUUID }, './env.js': { env },
    './realtime.js': { publishToUser: async (userId: string, body: shared.GatewayServerMessage, opts?: { cap?: string }) => { events.push({ userId, body, cap: opts?.cap }); } },
  });
  const link = moduleOf<Link>('federation/convLink', { ...fed, '../conversations.js': c, './instanceMeta.js': meta });
  function configure(withPeerDown = true) {
    c.configureFederatedConv({ selfInstanceId: () => self, record: changes.recordFedConvChanges,
      linkBroken: link.brokenHomes, linkStale: link.staleHomes, groupHostSilent: link.silentHomes, ...(withPeerDown ? { peerDown: link.downHomes } : {}) });
  }
  configure();
  async function clean() {
    await labels.refreshInstanceLabels();
    assert.deepEqual(unexpected, [], 'фоновый путь не проглотил подмену вычисляющего модуля');
    assert.deepEqual(warnings, [], 'сверка не проглотила ошибку SQL или доставки');
  }
  const refresh = async () => { await link.refreshFedLinks(); await clean(); };
  const summaries = async () => { const out = (await c.listConversations('local', true)).conversations; await clean(); return out; };
  const summary = async (id = direct) => { const out = (await summaries()).find(row => row.id === id); assert.ok(out, `сводка ${id} есть`); return out; };
  const journal = async () => (await t.db.select().from(schema.userChanges)).map(row => ({ userId: row.userId, id: row.conversationId, kind: row.kind }));
  await clean();
  return { clock, link, c, events, configure, clean, refresh, summaries, summary, journal };
}
const sorted = (values: ReadonlySet<string>) => [...values].sort();
function failure(prefix: string, actual: unknown, expected: unknown) {
  return (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(prefix) && e.operator === 'strictEqual'
    && Object.is(e.actual, actual) && Object.is(e.expected, expected);
}

async function boundary(edit?: Edit) {
  const f = await fixture({ edit }); f.link.notePeerAnswer(downHome, null, null);
  f.clock.now += timeout - 1; assert.equal(f.link.downHomes([downHome]).has(downHome), false);
  f.clock.now++; assert.equal(f.link.downHomes([downHome]).has(downHome), false, 'R217-boundary: ровно десять минут ещё не недоступен');
  assert.equal((await f.link.silentHomes([downHome])).has(downHome), false);
  f.clock.now++; assert.deepEqual(sorted(f.link.downHomes([downHome, unknownHome, downHome])), [downHome]);
  assert.equal((await f.link.silentHomes([downHome])).has(downHome), true); assert.deepEqual(sorted(f.link.downHomes([])), []); await f.clean();
}
it('R217 downHomes и silentHomes не включают ровно десять минут, а включают плюс одну миллисекунду', () => boundary());
it('R217 сеть и 5xx начинают один срок молчания, повтор ошибки не переносит начало', async () => {
  const f = await fixture();
  for (const [index, status] of [null, 500, 503, 599].entries()) f.link.notePeerAnswer(`home-${index}`, status, null);
  f.clock.now += timeout; f.link.notePeerAnswer('home-0', 503, 'не JSON'); f.clock.now++;
  assert.deepEqual(sorted(f.link.downHomes(['home-0', 'home-1', 'home-2', 'home-3', 'unseen'])), ['home-0', 'home-1', 'home-2', 'home-3']); await f.clean();
});
it('R217 любой ответ ниже 500 снимает down, следующий сетевой сбой начинает новый полный срок', async () => {
  const f = await fixture();
  for (const status of [200, 204, 301, 400, 401, 403, 404, 429, 499]) {
    f.link.notePeerAnswer(downHome, 503, null); f.clock.now += timeout + 1; assert.equal(f.link.downHomes([downHome]).has(downHome), true);
    f.link.notePeerAnswer(downHome, status, null); assert.equal(f.link.downHomes([downHome]).has(downHome), false, `ответ ${status} снимает down`);
    f.link.notePeerAnswer(downHome, null, null); assert.equal(f.link.downHomes([downHome]).has(downHome), false);
    f.clock.now += timeout; assert.equal(f.link.downHomes([downHome]).has(downHome), false); f.clock.now++;
    assert.equal(f.link.downHomes([downHome]).has(downHome), true); f.link.notePeerAnswer(downHome, 200, null);
  }
  await f.clean();
});
async function union(edit?: Edit) {
  const f = await fixture({ edit }); f.link.notePeerAnswer(downHome, 503, null); f.link.notePeerAnswer(staleHome, 404, null); f.clock.now += timeout + 1;
  const silent = await f.link.silentHomes([downHome, staleHome, unknownHome]);
  assert.equal(silent.has(downHome), true, 'R217-union: silentHomes содержит отвечающий за сеть downHomes');
  assert.deepEqual(sorted(silent), [downHome, staleHome]); assert.deepEqual(sorted(f.link.downHomes([downHome, staleHome])), [downHome]);
  assert.deepEqual(sorted(await f.link.staleHomes([downHome, staleHome])), [staleHome]); await f.clean();
}
it('R217 silentHomes объединяет сеть и stale, а stale из 404 не превращается в down', () => union());
it('R217 реальная незабранная строка SQL даёт stale и silent, но не down', async () => {
  const f = await fixture();
  await t.db.insert(schema.fedConvSync).values({ instanceId: staleHome, seq: 1, ackedSeq: 0 });
  await t.db.insert(schema.fedConvChanges).values({ instanceId: staleHome, seq: 1, conversationId: staleDirect, kind: 'conv', entityId: null, at: new Date(f.clock.now - timeout - 1) });
  assert.equal((await f.link.staleHomes([staleHome])).has(staleHome), true); assert.equal((await f.link.silentHomes([staleHome])).has(staleHome), true);
  assert.equal(f.link.downHomes([staleHome]).has(staleHome), false); await f.clean();
});
it('R217 реальная сводка ставит fedPeerDown только удалённому 1:1, не группе и не местной беседе', async () => {
  const f = await fixture({ group: true }); f.link.notePeerAnswer(downHome, null, null); f.clock.now += timeout + 1;
  assert.equal((await f.summary()).fedPeerDown, true);
  assert.equal((await f.summary(staleDirect)).fedPeerDown, undefined); assert.equal((await f.summary(localDirect)).fedPeerDown, undefined);
  const grouped = await f.summary(group); assert.equal(grouped.fedPeerDown, undefined); assert.equal(grouped.fedGroupHost?.down, true);
});
async function broken(edit?: Edit) {
  const f = await fixture({ edit }); f.link.notePeerAnswer(downHome, null, null); f.clock.now += timeout + 1;
  await t.db.update(schema.federationLinks).set({ state: 'paused' }).where(orm.eq(schema.federationLinks.instanceId, downHome));
  const row = await f.summary(); assert.equal(row.fedLink, 'broken');
  assert.equal(row.fedPeerDown, undefined, 'R217-broken: архив важнее недоступности');
}
it('R217 сломанная связка подавляет fedPeerDown даже при истёкшем сроке сетевой ошибки', () => broken());
it('R217 без крючка peerDown и без всех федеративных крючков сводка не выдумывает недоступность', async () => {
  const f = await fixture(); f.link.notePeerAnswer(downHome, 503, null); f.clock.now += timeout + 1;
  f.configure(false); assert.equal((await f.summary()).fedPeerDown, undefined);
  f.c.configureFederatedConv(null); assert.equal((await f.summary()).fedPeerDown, undefined);
});
async function staleOnly(edit?: Edit) {
  const f = await fixture({ edit }); f.link.notePeerAnswer(staleHome, 404, null); f.clock.now += timeout + 1;
  const row = await f.summary(staleDirect); assert.equal(row.fedStale, true);
  assert.equal(row.fedPeerDown, undefined, 'R217-stale: ожидание забора не означает недоступность');
}
it('R217 плашка ожидания забора в 1:1 не подменяется плашкой недоступности', () => staleOnly());
const eventSummary = (event: shared.GatewayServerMessage) => { assert.equal(event.t, 'conv.change'); return (event as Extract<shared.GatewayServerMessage, { t: 'conv.change' }>).conversation; };
async function directRefresh(edit?: Edit) {
  const f = await fixture({ edit }); await f.refresh(); assert.equal(f.events.length, 0); assert.deepEqual(await f.journal(), []);
  f.link.notePeerAnswer(downHome, null, null); f.clock.now += timeout; await f.refresh(); assert.equal(f.events.length, 0);
  f.clock.now++; await f.refresh(); assert.equal(f.events.length, 1, 'R217-refresh: перемена down объявляется один раз');
  assert.equal(f.events[0]!.userId, 'local'); assert.equal(f.events[0]!.cap, shared.CAP_CONV1);
  const row = eventSummary(f.events[0]!.body); assert.equal(row.id, direct); assert.equal('fedPeerDown' in row && row.fedPeerDown, true);
  assert.deepEqual(await f.journal(), [{ userId: 'local', id: direct, kind: 'conv' }]);
  assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 0, 'объявление состояния не возвращается в журнал соседа');
  await f.refresh(); assert.equal(f.events.length, 1);
  f.link.notePeerAnswer(downHome, 200, null); await f.refresh(); assert.equal(f.events.length, 2);
  const restored = eventSummary(f.events[1]!.body); assert.equal('fedPeerDown' in restored ? restored.fedPeerDown : undefined, undefined);
  assert.equal((await f.journal()).length, 2); await f.refresh(); assert.equal(f.events.length, 2);
}
it('R217 refreshOnce шлёт одну conv.change на down и на восстановление, без перемены не пишет журнал', () => directRefresh());
async function sharedHostRefresh(edit?: Edit) {
  const f = await fixture({ group: true, edit }); await f.refresh();
  f.link.notePeerAnswer(downHome, 503, null); f.clock.now += timeout + 1; await f.refresh();
  const counts = (id: string) => f.events.filter(event => eventSummary(event.body).id === id).length;
  assert.equal(counts(direct), 1, 'R217-shared-host: ЛС получает одну сводку от общего дома');
  assert.equal(counts(group), 1); assert.equal(f.events.length, 2); assert.equal((await f.journal()).length, 2);
  assert.equal(f.events.every(event => event.userId === 'local'), true);
  const directRow = eventSummary(f.events.find(event => eventSummary(event.body).id === direct)!.body);
  const groupRow = eventSummary(f.events.find(event => eventSummary(event.body).id === group)!.body);
  assert.equal('fedPeerDown' in directRow && directRow.fedPeerDown, true); assert.equal('fedGroupHost' in groupRow && groupRow.fedGroupHost?.down, true);
  await f.refresh(); assert.equal(f.events.length, 2);
  f.link.notePeerAnswer(downHome, 200, null); await f.refresh(); assert.equal(counts(direct), 2); assert.equal(counts(group), 2); assert.equal((await f.journal()).length, 4);
}
it('R217 один дом для хоста группы и собеседника 1:1 обновляет каждую беседу ровно один раз на обеих переменах', () => sharedHostRefresh());
async function changedRefresh(edit?: Edit) {
  const f = await fixture({ edit }); await f.refresh(); f.link.notePeerAnswer(downHome, 503, null); f.clock.now += timeout + 1;
  await t.db.update(schema.federationLinks).set({ state: 'paused' }).where(orm.eq(schema.federationLinks.instanceId, downHome)); await f.refresh();
  assert.equal(f.events.length, 1, 'R217-archive-refresh: одновременные broken и down не дублируются');
  const row = eventSummary(f.events[0]!.body); assert.equal('fedLink' in row && row.fedLink, 'broken'); assert.equal('fedPeerDown' in row, false);
  assert.equal((await f.journal()).length, 1);
}
it('R217 одновременная потеря связки и down объявляются одной архивной сводкой', () => changedRefresh());

const linkEdit = (from: string, to: string): Edit => ({ file: 'federation/convLink', from, to });
const convEdit = (from: string, to: string): Edit => ({ file: 'conversations', from, to });
it('R217 контрфакт включает down на точной границе десяти минут', async () => {
  await boundary(); await assert.rejects(boundary(linkEdit('const since = pullDownSince.get(h);\n    if (since !== undefined && now - since > STALE_AFTER_MS)',
    'const since = pullDownSince.get(h);\n    if (since !== undefined && now - since >= STALE_AFTER_MS)')), failure('R217-boundary:', true, false));
});
it('R217 контрфакт silentHomes теряет сетевой down', async () => {
  await union(); await assert.rejects(union(linkEdit('for (const h of downHomes(homes)) out.add(h);', '')), failure('R217-union:', false, true));
});
it('R217 контрфакт показывает fedPeerDown вместе с broken', async () => {
  await broken(); await assert.rejects(broken(convEdit('downHomes.has(peer.homeInstanceId) && !brokenHomes.has(peer.homeInstanceId)', 'downHomes.has(peer.homeInstanceId)')), failure('R217-broken:', true, undefined));
});
it('R217 контрфакт использует stale вместо down для недоступности собеседника', async () => {
  await staleOnly(); await assert.rejects(staleOnly(convEdit('downHomes.has(peer.homeInstanceId)', 'staleHomes.has(peer.homeInstanceId)')), failure('R217-stale:', true, undefined));
});
it('R217 контрфакт убирает цикл объявления downKnown', async () => {
  await directRefresh(); await assert.rejects(directRefresh(linkEdit('for (const instanceId of directHomes) {\n    if ((downBefore?.has(instanceId) ?? false) === down.has(instanceId)) continue;',
    'for (const instanceId of [] as string[]) {\n    if ((downBefore?.has(instanceId) ?? false) === down.has(instanceId)) continue;')), failure('R217-refresh:', 0, 1));
});
it('R217 контрфакт повторно объявляет дом, уже объявленный как молчащий хост группы', async () => {
  await sharedHostRefresh(); await assert.rejects(sharedHostRefresh(linkEdit('if (groupHosts.includes(instanceId) && (silentBefore?.has(instanceId) ?? false) !== silent.has(instanceId)) continue;', '')),
    failure('R217-shared-host:', 2, 1));
});
it('R217 контрфакт повторно объявляет дом, уже объявленный как broken', async () => {
  await changedRefresh(); await assert.rejects(changedRefresh(linkEdit('if (changed.includes(instanceId) || (staleBefore?.has(instanceId) ?? false) !== stale.has(instanceId)) continue;', '')),
    failure('R217-archive-refresh:', 2, 1));
});
