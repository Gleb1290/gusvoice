import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as orm from 'drizzle-orm';
import ts from 'typescript';
import * as schema from '../src/db/schema.js';
import * as codes from '../src/federation/linkCode.js';
import * as service from '../src/federation/linkService.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.close(); });
const source = readFileSync(new URL('../src/federation/links.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Notice = { userId: string; event: { t: string } };
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

// Настоящие links.ts, фабрика linkService, Drizzle и Postgres. Подменены только внешние IO, не выбор адресатов.
async function fixture(raw = source, failGuestPublish = false) {
  await truncateAll(t.raw);
  const notices: Notice[] = [], unexpected: string[] = [], warnings: unknown[][] = [], cache: string[] = [];
  const unused = (name: string) => () => { unexpected.push(name); throw new Error(`непредметный IO: ${name}`); };
  let deps: service.LinkDeps | undefined;
  const imports: Record<string, unknown> = {
    'node:crypto': crypto, 'drizzle-orm': orm,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema, './linkCode.js': codes,
    './linkService.js': { createLinkService(value: service.LinkDeps) { deps = value; return service.createLinkService(value); } },
    './peerClient.js': { fetchPeerDocument: unused('fetchPeerDocument'), postSignedToPeer: unused('postSignedToPeer'), proveDomain: unused('proveDomain') },
    './instance.js': { domainFromOrigin: unused('domainFromOrigin'), federation: { identity: unused('identity'), signingKey: unused('signingKey') } },
    './revocation.js': { isRevoked: unused('isRevoked'), rebindLink: unused('rebindLink') },
    './auditLog.js': { fedAudit: unused('fedAudit') }, './outbox.js': { queueDepth: unused('queueDepth') },
    './directoryCache.js': { async forgetPeerCache(id: string) { cache.push(`cache:${id}`); } },
    './peerAuth.js': { forgetPeerDocument(id: string) { cache.push(`document:${id}`); } },
    './guestAccess.js': { async freezeGuestsOf(id: string) { cache.push(`freeze:${id}`); }, async thawGuestsOf(id: string) { cache.push(`thaw:${id}`); } },
    '../env.js': { env: { clientOrigin: 'https://home.example', federation: { apiBase: 'https://home.example/api' } } },
    '../auth.js': { superAdminId: () => 'admin' },
    '../realtime.js': { async publishToUser(userId: string, event: { t: string }) {
      assert.equal(['federation.links', 'federation.guest_links'].includes(event.t), true, 'только два предметных события');
      notices.push({ userId, event: plain(event) });
      if (failGuestPublish && event.t === 'federation.guest_links') throw new Error('fixture unavailable transport');
    } },
    '../corsOrigins.js': { async refreshPeerOrigins(options: unknown) { assert.deepEqual(plain(options), { force: true }); } },
    './instanceMeta.js': { readInstanceMeta: unused('readInstanceMeta') },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date, Buffer, URL,
    console: { warn(...args: unknown[]) { warnings.push(args); } },
    require(id: string) {
      if (!Object.hasOwn(imports, id)) { unexpected.push(`require:${id}`); throw new Error(`неизвестный импорт ${id}`); }
      return imports[id];
    },
  });
  assert.ok(deps, 'настоящая фабрика получила зависимости links.ts');
  await t.db.insert(schema.users).values(['admin', 'member-a', 'member-b', 'other-member', 'non-member'].map(id => ({
    id, username: id, displayName: id, passwordHash: 'fixture', verified: true,
  })));
  await t.db.insert(schema.federationLinks).values(['peer-a', 'peer-b'].map(id => ({
    instanceId: id, domain: `${id}.example`, apiBase: `https://${id}.example/api`, clientOrigin: `https://${id}.example`,
    rootKey: `fixture-${id}`, theirName: id, state: 'active', protocolVersion: 1, features: [], localName: 'Своё имя',
  })));
  await t.db.insert(schema.federationMemberships).values([
    { instanceId: 'peer-a', userId: 'member-a', serverId: 'one', state: 'active', updatedAt: 1 },
    { instanceId: 'peer-a', userId: 'member-a', serverId: 'two', state: 'removed', updatedAt: 2 },
    { instanceId: 'peer-a', userId: 'member-b', serverId: 'three', state: 'closed_by_host', updatedAt: 3 },
    { instanceId: 'peer-b', userId: 'member-a', serverId: 'four', state: 'active', updatedAt: 4 },
    { instanceId: 'peer-b', userId: 'other-member', serverId: 'five', state: 'active', updatedAt: 5 },
  ]);
  // announceGuestLinks запускается best-effort без await: SQL-барьер и следующий macrotask дают ему закончить публикации.
  async function drain() { await t.raw.query('SELECT 1'); await new Promise<void>(resolve => setImmediate(resolve)); }
  return {
    deps, notices, warnings, cache, drain,
    async clean() { await drain(); assert.deepEqual(unexpected, [], 'неожиданный IO не проглочен best-effort catch'); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function guestRecipients(f: Fixture, expected: string[]) {
  const guests = f.notices.filter(n => n.event.t === 'federation.guest_links');
  assert.equal(guests.length, expected.length, 'R234-guest-count: по одному событию на человека только нужного соседа');
  assert.equal(guests.map(n => n.userId).sort().join(','), [...expected].sort().join(','), 'R234-guest-users: адресаты взяты из членств именно этого соседа');
  for (const n of guests) assert.deepEqual(n.event, { t: 'federation.guest_links' }, 'чужие связки и членства не раскрываются нагрузкой');
  assert.deepEqual(f.notices.filter(n => n.event.t === 'federation.links'), [{ userId: 'admin', event: { t: 'federation.links' } }]);
}
async function change(kind: 'set' | 'upsert', raw = source) {
  const f = await fixture(raw);
  try {
    if (kind === 'set') await f.deps.setLinkState('peer-a', 'blocked', false);
    else await f.deps.upsertLink({ instanceId: 'peer-a', domain: 'peer-a.example', apiBase: 'https://peer-a.example/api',
      clientOrigin: 'https://peer-a.example', rootKey: 'replacement-root', theirName: 'Новый сосед', state: 'active',
      protocolVersion: 1, features: ['dm1'], confirmed: true });
    await f.drain();
    guestRecipients(f, ['member-a', 'member-b']);
    const rows = await t.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, 'peer-a'));
    assert.equal(rows.length, 1); assert.equal(rows[0].state, kind === 'set' ? 'blocked' : 'active');
    assert.equal(rows[0].localName, 'Своё имя');
    assert.deepEqual(f.cache, kind === 'set' ? ['cache:peer-a', 'document:peer-a', 'freeze:peer-a'] : ['thaw:peer-a']);
    if (kind === 'upsert') { assert.equal(rows[0].rootKey, 'replacement-root'); assert.ok(rows[0].confirmedAt); }
    assert.deepEqual(f.warnings, []);
  } finally { await f.clean(); }
}
for (const kind of ['set', 'upsert'] as const) test(`R234 ${kind} будит только гостей нужного соседа один раз независимо от числа и состояния членств`, () => {
  // Смена связки не должна раскрывать её всем людям дома или дублировать перерисовку за каждый сервер.
  return change(kind);
});
test('R234 смена другого соседа выбирает другой набор людей, общий участник получает ровно одно событие', async () => {
  // Ловит жёстко заданного соседа и соединение индекса без условия instance_id.
  const f = await fixture(); try {
    await f.deps.setLinkState('peer-b', 'paused', false); await f.drain();
    guestRecipients(f, ['member-a', 'other-member']); assert.deepEqual(f.cache, []); assert.deepEqual(f.warnings, []);
  } finally { await f.clean(); }
});
test('R234 новая связка без членств меняет SQL и будит держателя, но не посылает гостевое событие никому', async () => {
  // Парный пустой набор запрещает fallback-рассылку всем при отсутствии гостей.
  const f = await fixture(); try {
    await f.deps.upsertLink({ instanceId: 'peer-new', domain: 'new.example', apiBase: 'https://new.example/api',
      clientOrigin: 'https://new.example', rootKey: 'new-root', theirName: null, state: 'pending', protocolVersion: 1, features: [], confirmed: false });
    await f.drain(); guestRecipients(f, []);
    const row = await t.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, 'peer-new'));
    assert.equal(row[0]?.state, 'pending'); assert.equal(row[0]?.confirmedAt, null); assert.deepEqual(f.warnings, []);
  } finally { await f.clean(); }
});
test('R234 сбой транспорта гостевого события не откатывает уже сохранённую смену связки', async () => {
  // Best-effort рассылка не должна превращать состоявшуюся паузу в ошибку команды держателя.
  const f = await fixture(source, true); try {
    await f.deps.setLinkState('peer-a', 'paused', false); await f.drain();
    const row = await t.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, 'peer-a'));
    assert.equal(row[0]?.state, 'paused'); assert.equal(f.warnings.length, 1);
    assert.equal(f.notices.filter(n => n.event.t === 'federation.guest_links').length, 1);
  } finally { await f.clean(); }
});
for (const [label, anchor, replacement, kind, actual] of [
  ['рассылка людям всех соседей', '.where(eq(federationMemberships.instanceId, instanceId))', '', 'set', 3],
  ['дубли за каждый сервер', '.selectDistinct({ userId: federationMemberships.userId })', '.select({ userId: federationMemberships.userId })', 'set', 3],
  ['забыт вызов при setLinkState', 'void announceGuestLinks(instanceId);', '', 'set', 0],
  ['забыт вызов при upsertLink', 'void announceGuestLinks(link.instanceId);', '', 'upsert', 0],
] as const) test(`R234 контрфакт всего links.ts: ${label}`, async () => {
  await change(kind);
  assert.equal(source.split(anchor).length - 1, 1, 'якорь контрфакта единственный');
  await assert.rejects(() => change(kind, source.replace(anchor, replacement)), e => e instanceof assert.AssertionError
    && e.message.startsWith('R234-guest-count:') && e.operator === 'strictEqual' && e.actual === actual && e.expected === 2);
});
