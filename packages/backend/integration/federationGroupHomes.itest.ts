import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as authRules from '../src/authRules.js';
import * as superAdminRules from '../src/superAdminRules.js';
import * as convRules from '../src/convRules.js';
import * as barrier from '../src/dmWriteBarrier.js';
import * as groupRules from '../src/groupRules.js';
import * as userSearchRules from '../src/userSearchRules.js';
import * as guestRules from '../src/federation/guestRules.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as linkService from '../src/federation/linkService.js';
import * as statusRules from '../src/statusRules.js';
import * as shopRules from '../src/shopRules.js';
import * as callRules from '../src/callRules.js';
import * as lastSeenRules from '../src/lastSeenRules.js';
import * as threatRules from '../src/linkThreatsRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
type Edits = { group?: Mutation; changes?: Mutation; labels?: Mutation };
const self = 'a'.repeat(32), host = 'b'.repeat(32), third = 'c'.repeat(32), unknownHome = 'd'.repeat(32);
const cid = 'homes-group';
const local = { instanceId: self, userId: 'local' }, remote = { instanceId: host, userId: 'host-person' };
const stranger = { instanceId: third, userId: 'third-person' };
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => {
  try { await t.close(); }
  finally { await (await import('../src/db/index.js')).pool.end(); }
});
const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const forbidden = (name: string) => () => { throw new Error(`незадействованная граница ${name}`); };
const unreachable = (name: string) => new Proxy({}, { get: (_target, property) => property === '__esModule' ? true : forbidden(`${name}.${String(property)}`) });

/** Целые модули, настоящий SQL и правила; подменяются только конфигурация, транспорт и незадействованный IO. */
function moduleOf<T>(name: string, dependencies: Record<string, unknown>, clock: { now: number }, warns: string[], mutation?: Mutation): T {
  let raw = source(name);
  if (mutation) { assert.equal(raw.split(mutation[0]).length - 1, 1, `единственный якорь ${name}`); raw = raw.replace(...mutation); }
  class ClockDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? clock.now : value instanceof Date ? value.getTime() : value); }
    static now() { return clock.now; }
  }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    module, exports: module.exports, Date: ClockDate, Map, Set, Promise, Buffer, URL, crypto,
    console: { warn: (value: unknown) => warns.push(String(value)) }, setTimeout: forbidden('таймер'), setInterval: forbidden('worker'),
    require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `явный импорт ${name}:${id}`); return dependencies[id]; },
  });
  return module.exports as T;
}

async function fixture(edits: Edits = {}, hosting = false) {
  await truncateAll(t.raw);
  const clock = { now: Date.now() }, warns: string[] = [];
  const own = hosting ? host : self;
  const m = <T>(name: string, dependencies: Record<string, unknown>, edit?: Mutation) => moduleOf<T>(name, dependencies, clock, warns, edit);
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'homes_local', displayName: 'Местный', passwordHash: 'fixture', verified: true, approvedAt: new Date(clock.now) },
    { id: 'shadow', username: 'homes_shadow', displayName: 'Сосед', passwordHash: 'fixture', verified: true,
      homeInstanceId: hosting ? self : host, homeUserId: hosting ? local.userId : remote.userId, homeUsername: 'neighbor_person' },
    ...(hosting ? [{ id: 'third-shadow', username: 'homes_third_shadow', displayName: 'Третий', passwordHash: 'fixture', verified: true,
      homeInstanceId: third, homeUserId: stranger.userId, homeUsername: 'third_person' }] : []),
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: hosting ? self : host, domain: 'linked.invalid',
    apiBase: 'https://linked.invalid/api', clientOrigin: 'https://linked.invalid', rootKey: 'fixture-public-key',
    theirName: 'Сосед по связке', state: 'active', features: [shared.FED_FEATURES.guests, shared.FED_FEATURES.dmgroup1] });
  if (hosting) {
    await t.db.insert(schema.federationLinks).values({ instanceId: third, domain: 'third.invalid', apiBase: 'https://third.invalid/api',
      clientOrigin: 'https://third.invalid', rootKey: 'fixture-third-public-key', theirName: 'Имя третьего', localName: 'Псевдоним третьего',
      state: 'active', features: [shared.FED_FEATURES.dmgroup1] });
    // Своя группа хранится с origin=NULL; наружу toWireConv подставляет id хоста.
    await t.db.insert(schema.conversations).values({ id: cid, kind: 'group', title: 'Группа хоста', groupVersion: 5 });
    await t.db.insert(schema.conversationMembers).values(['local', 'shadow', 'third-shadow'].map(userId => ({ conversationId: cid, userId, role: userId === 'local' ? 'owner' as const : 'member' as const })));
  }
  const common = { '@gusvoice/shared': shared, 'drizzle-orm': orm };
  const backend = { ...common, './db/index.js': { db: t.db }, './db/schema.js': schema };
  const fed = { ...common, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const env = { jwtSecret: 'not-a-secret-used-only-by-homes-tests', publicApiUrl: 'https://self.invalid', linkThreats: { enabled: false } };
  const auth = m<typeof import('../src/auth.js')>('auth', { ...backend, bcryptjs: bcrypt, jsonwebtoken: jwt, './authRules.js': authRules,
    './superAdminRules.js': superAdminRules, './env.js': { env } });
  const federation = { identity: () => ({ instanceId: own }) };
  const meta = { readInstanceMeta: async () => ({ paused: false, name: 'Местный дом' }) };
  const links = m<typeof import('../src/federation/links.js')>('federation/links', {
    ...fed, 'node:crypto': crypto, './linkService.js': linkService, './instance.js': { federation }, './instanceMeta.js': meta,
    './outbox.js': { queueDepth: async () => 0 }, './linkCode.js': unreachable('код связки'), './peerClient.js': unreachable('транспорт'),
    './revocation.js': unreachable('отзыв'), './auditLog.js': unreachable('аудит'), './directoryCache.js': unreachable('каталог'),
    './peerAuth.js': unreachable('подпись'), './guestAccess.js': unreachable('гостевые сессии'), '../env.js': { env }, '../auth.js': auth,
    '../realtime.js': unreachable('админское событие'), '../corsOrigins.js': unreachable('CORS'),
  });
  const labels = m<typeof import('../src/federation/instanceLabels.js')>('federation/instanceLabels', {
    ...common, './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta,
  }, edits.labels);
  await labels.refreshInstanceLabels();
  const threats = m<typeof import('../src/linkThreats.js')>('linkThreats', { 'node:fs/promises': unreachable('список угроз'),
    './env.js': { env }, './linkThreatsRules.js': threatRules });
  const serializer = m<typeof import('../src/serialize.js')>('serialize', {
    ...common, './federation/instanceLabels.js': labels, './linkThreats.js': threats, './auth.js': auth, './superAdminRules.js': superAdminRules,
    './env.js': { env }, './statusRules.js': statusRules, './shopRules.js': shopRules, './callRules.js': callRules, './lastSeenRules.js': lastSeenRules,
  });
  const changes = m<typeof import('../src/federation/convChanges.js')>('federation/convChanges', fed, edits.changes);
  const events: Array<{ userId: string; event: shared.GatewayServerMessage; cap: string }> = [];
  const c = m<typeof import('../src/conversations.js')>('conversations', {
    ...backend, './convRules.js': convRules, './serialize.js': serializer, './dmWriteBarrier.js': barrier, './util.js': { uuidv7: crypto.randomUUID },
    './env.js': { env }, './attachments.js': unreachable('вложения'),
    './realtime.js': { publishToUser: async (userId: string, event: shared.GatewayServerMessage, options: { cap: string }) => { events.push({ userId, event, cap: options.cap }); } },
  });
  c.configureFederatedConv({ selfInstanceId: () => own, record: changes.recordFedConvChanges });
  const guests = m<typeof import('../src/federation/guestHost.js')>('federation/guestHost', {
    ...fed, 'node:crypto': crypto, '../auth.js': auth, '../authRules.js': authRules, './guestRules.js': guestRules,
    './instance.js': { federation }, './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta,
    './avatars.js': { refreshGuestAvatar: async () => {} }, './peerAuth.js': unreachable('ключ личности'),
    './identityToken.js': unreachable('токен личности'), './guardsRuntime.js': unreachable('лимиты гостя'), './instanceBan.js': unreachable('бан гостя'),
  });
  const groups = m<typeof import('../src/federation/convGroup.js')>('federation/convGroup', {
    ...fed, 'node:crypto': crypto, '../conversations.js': c, '../groupRules.js': groupRules, '../userSearchRules.js': userSearchRules,
    './guestHost.js': guests, './instance.js': { federation }, './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta,
    '../convGroups.js': unreachable('действие с составом'), './directorySync.js': unreachable('визитка'), './instanceIdentity.js': unreachable('личность автора'),
    './peerClient.js': unreachable('POST хосту'), './signingKeys.js': unreachable('цепочка подписи'),
  }, edits.group);
  return { clock, warns, links, labels, changes, c, groups, events, guests, serializer };
}

const profile = (ref = stranger, home: shared.FedGroupProfile['home'] | null = { name: 'Третий дом', domain: 'third.invalid' }): shared.FedGroupProfile => ({
  ref, username: 'third_person', displayName: 'Третий', avatarHash: null, ...(home ? { home } : {}),
});
function wire(profiles = [profile()], version = 5, title = 'Группа со слов хоста', origin = host) {
  return { ...shared.serializeConvWire({ id: cid, kind: 'group', originInstanceId: origin, createdAt: Date.now() - 60_000,
    members: [local, remote, stranger], title }),
  ...shared.serializeConvGroupExtras({ version, avatarUrl: null, owner: remote, profiles }) };
}
async function vouched() {
  const rows = await t.raw.query<{ instance_id: string; name: string | null; domain: string; vouched_by: string }>(
    'SELECT instance_id,name,domain,vouched_by FROM federation_vouched_instances ORDER BY instance_id');
  return rows.rows.map(r => [r.instance_id, r.name, r.domain, r.vouched_by]);
}
async function snapshot() {
  return JSON.stringify({ conv: await t.db.select().from(schema.conversations), members: await t.db.select().from(schema.conversationMembers),
    journal: await t.db.select().from(schema.userChanges), fed: await t.db.select().from(schema.fedConvChanges) });
}
function killed(prefix: string, actual: unknown, expected: unknown) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(prefix)
    && error.operator === 'strictEqual' && Object.is(error.actual, actual) && Object.is(error.expected, expected);
}

async function hostEntity(edits: Edits = {}) {
  const f = await fixture(edits, true);
  // Отличается только тип результата драйвера, не SQL и не сама транзакция.
  await t.db.transaction(tx => f.c.journal(tx as unknown as Parameters<typeof f.c.journal>[0],
    [{ userId: 'local', conversationId: cid, kind: 'conv', messageId: null }]));
  const get = async () => {
    const page = await f.changes.changesForPeer(self, 0, 100, host);
    assert.ok('items' in page);
    const item = page.items.find(i => i.kind === 'conv' && i.conversationId === cid);
    assert.ok(item?.entity); return item.entity;
  };
  return { f, get };
}

it('R208 миграция 0143 даёт настоящее хранилище; applyGroupConv сохраняет третьего и сразу освежает кеш', async () => {
  const f = await fixture();
  assert.ok(t.appliedMigrations.includes('0143_fed_vouched_instances.sql'));
  assert.deepEqual(await vouched(), []);
  assert.equal(f.labels.instanceLabel(third).domain, '');
  await f.groups.applyGroupConv(host, self, cid, wire());
  assert.deepEqual(await vouched(), [[third, 'Третий дом', 'third.invalid', host]]);
  assert.equal(f.labels.instanceLabel(third).name, 'Третий дом'); assert.equal(f.labels.instanceLabel(third).domain, 'third.invalid');
  assert.equal(f.labels.instanceLabel(third).reports, false);
  const shadow = await f.guests.shadowUserFor(third, stranger.userId);
  assert.ok(shadow); assert.equal(shadow.homeUsername, 'third_person');
  const members = (await f.c.listConversations('local', true)).conversations[0].group?.members;
  const member = members?.find(m => m.id === shadow.id);
  assert.ok(member); assert.equal(member.homeInstance?.name, 'Третий дом'); assert.equal(member.homeInstance?.domain, 'third.invalid');
  assert.deepEqual(f.events.map(e => e.userId), ['local']); assert.deepEqual(f.warns, []);
});

async function equalVersion(edits: Edits = {}) {
  const f = await fixture(edits);
  await f.groups.applyGroupConv(host, self, cid, wire());
  const before = await snapshot(), eventCount = f.events.length;
  f.clock.now++;
  await f.groups.applyGroupConv(host, self, cid, wire([profile(stranger, { name: 'Новое имя дома', domain: 'renamed.invalid' })], 5, 'Не менять название'));
  assert.equal(f.labels.instanceLabel(third).name, 'Новое имя дома', 'R208 равная версия: подпись дома обновляется до проверки состава');
  assert.deepEqual(await vouched(), [[third, 'Новое имя дома', 'renamed.invalid', host]]);
  assert.equal(await snapshot(), before, 'равная версия не меняет снимок группы и журнал');
  assert.equal(f.events.length, eventCount);
}
it('R208 равная версия меняет имя и домен дома, но не состав, название или события группы', async () => { await equalVersion(); });
it('R208 перенос записи подписи за проверку версии обнаруживается равным снимком', async () => {
  await equalVersion();
  const call = 'await rememberVouchedHomes(peer, self, x.profiles).catch(() => {});';
  // Одна замена всей функции: именно перемещаем существующий вызов, не подменяем хранилище.
  const original = source('federation/convGroup');
  const ast = ts.createSourceFile('convGroup', original, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'applyGroupConv');
  assert.ok(node); const body = node.getText(ast);
  const gate = "if (existing && (existing.kind !== 'group' || existing.origin !== peer || x.version <= existing.version)) return;";
  assert.equal(body.split(call).length - 1, 1); assert.equal(body.split(gate).length - 1, 1);
  const moved = body.replace(call, '').replace(gate, `${gate}\n  ${call}`);
  await assert.rejects(equalVersion({ group: [body, moved] }),
    killed('R208 равная версия: подпись дома обновляется до проверки состава', 'Третий дом', 'Новое имя дома'));
});

async function ignoredHomes(edits: Edits = {}) {
  const f = await fixture(edits);
  await f.groups.applyGroupConv(host, self, cid, wire([
    profile(local, { name: 'Самозваное наше имя', domain: 'self-claimed.invalid' }),
    profile(remote, { name: 'Слова о хосте', domain: 'host-claimed.invalid' }), profile(),
  ]));
  assert.equal((await vouched()).length, 1, 'R208 исключения: сохраняется только третий дом');
  assert.deepEqual(await vouched(), [[third, 'Третий дом', 'third.invalid', host]]);
  assert.equal(f.labels.instanceLabel(host).domain, 'linked.invalid');
  assert.equal(f.labels.instanceLabel(self).domain, '');
}
it('R208 профиль с нашим домом и домом хоста не становится vouched; третий принимается', async () => { await ignoredHomes(); });
for (const [label, guard] of [['наш дом', 'id === self || '], ['дом хоста', 'id === peer || ']] as const) {
  it(`R208 забытое исключение «${label}» обнаруживается лишней настоящей строкой подписи`, async () => {
    await ignoredHomes();
    await assert.rejects(ignoredHomes({ group: [guard, ''] }), killed('R208 исключения: сохраняется только третий дом', 2, 1));
  });
}

it('R208 нерабочий хост и чужой origin ничего не запоминают; рабочий хост принимается', async () => {
  const f = await fixture();
  await f.groups.applyGroupConv(host, self, cid, wire([profile()], 5, 'Группа', third));
  assert.deepEqual(await vouched(), []);
  await t.db.update(schema.federationLinks).set({ state: 'paused' }).where(orm.eq(schema.federationLinks.instanceId, host));
  await f.groups.applyGroupConv(host, self, cid, wire());
  assert.deepEqual(await vouched(), []); assert.equal((await t.db.select().from(schema.conversations)).length, 0);
  await t.db.update(schema.federationLinks).set({ state: 'active' }).where(orm.eq(schema.federationLinks.instanceId, host));
  await f.groups.applyGroupConv(host, self, cid, wire());
  assert.deepEqual(await vouched(), [[third, 'Третий дом', 'third.invalid', host]]);
});

it('R208 без home и с негодным доменом подпись не пишется; домен с чрезмерным именем сохраняется без имени', async () => {
  const f = await fixture();
  await f.groups.applyGroupConv(host, self, cid, wire([profile(stranger, null)]));
  assert.deepEqual(await vouched(), []);
  const bad = wire([profile(stranger, null)]);
  const rawProfiles = bad.profiles as Record<string, unknown>[];
  rawProfiles[0].home_domain = 'https://not-a-domain.invalid/path'; rawProfiles[0].home_name = 'Некорректный домен';
  await f.groups.applyGroupConv(host, self, cid, bad);
  assert.deepEqual(await vouched(), []); assert.equal(f.labels.instanceLabel(third).domain, '');
  await f.groups.applyGroupConv(host, self, cid, wire([profile(stranger, { name: 'Я'.repeat(41), domain: 'third.invalid' })]));
  assert.deepEqual(await vouched(), [[third, null, 'third.invalid', host]]);
  assert.equal(f.labels.instanceLabel(third).name, null); assert.equal(f.labels.instanceLabel(third).domain, 'third.invalid');
  await f.groups.applyGroupConv(host, self, cid, wire([profile(stranger, { name: 'Я'.repeat(40), domain: 'third.invalid' })]));
  assert.equal(f.labels.instanceLabel(third).name, 'Я'.repeat(40));
});

it('R208 несколько людей одного дома дают одну подпись; первый профиль определяет её', async () => {
  const f = await fixture();
  await f.groups.applyGroupConv(host, self, cid, wire([profile(), profile({ instanceId: third, userId: 'another-person' }, { name: 'Второй вариант', domain: 'second-claim.invalid' })]));
  assert.deepEqual(await vouched(), [[third, 'Третий дом', 'third.invalid', host]]);
});

async function producedHomes(edits: Edits = {}) {
  const { f, get } = await hostEntity(edits);
  const entity = await get();
  const rawProfiles = entity.profiles as Record<string, unknown>[];
  const thirdProfile = rawProfiles.find(p => p.instance_id === third);
  assert.ok(thirdProfile);
  assert.equal(thirdProfile.home_name, 'Псевдоним третьего', 'R208 хост: профиль третьего содержит имя по связке');
  assert.equal(thirdProfile.home_domain, 'third.invalid');
  assert.equal(rawProfiles.find(p => p.instance_id === host)?.home_domain, undefined, 'у местного участника хоста нет выдуманного чужого дома');
  assert.equal(rawProfiles.find(p => p.instance_id === self)?.home_domain, 'linked.invalid');
  const parsed = shared.parseConvGroupExtras(entity);
  assert.equal(parsed?.profiles.find(p => p.ref.instanceId === third)?.home?.name, 'Псевдоним третьего');
  assert.equal(shared.parseConvWire(entity)?.originInstanceId, host);
  assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 2, 'хост пишет каждому дому участников');
  assert.deepEqual(f.warns, []);
}
it('R208 хост сериализует home_name/home_domain третьего и адресата из настоящих связок', async () => { await producedHomes(); });
it('R208 удалённый home в профиле хоста обнаруживается на реальной странице журнала', async () => {
  await producedHomes();
  await assert.rejects(producedHomes({ changes: [
    '...(u?.homeInstanceId && groupHomes.get(u.homeInstanceId) ? { home: groupHomes.get(u.homeInstanceId) } : {}),',
    '/* мутант: профиль без подписи дома */',
  ] }), killed('R208 хост: профиль третьего содержит имя по связке', undefined, 'Псевдоним третьего'));
});

it('R208 хост предпочитает localName, допускает 40 символов, убирает имя на 41 и не отдаёт негодный домен', async () => {
  const { get } = await hostEntity();
  const home = async () => shared.parseConvGroupExtras(await get())?.profiles.find(p => p.ref.instanceId === third)?.home;
  assert.equal((await home())?.name, 'Псевдоним третьего');
  await t.db.update(schema.federationLinks).set({ localName: null }).where(orm.eq(schema.federationLinks.instanceId, third));
  assert.equal((await home())?.name, 'Имя третьего');
  await t.db.update(schema.federationLinks).set({ localName: 'Я'.repeat(40) }).where(orm.eq(schema.federationLinks.instanceId, third));
  assert.equal((await home())?.name, 'Я'.repeat(40));
  await t.db.update(schema.federationLinks).set({ localName: 'Я'.repeat(41) }).where(orm.eq(schema.federationLinks.instanceId, third));
  assert.equal((await home())?.name, null); assert.equal((await home())?.domain, 'third.invalid');
  await t.db.update(schema.federationLinks).set({ domain: 'https://invalid-domain.invalid/path' }).where(orm.eq(schema.federationLinks.instanceId, third));
  assert.equal(await home(), undefined);
  await t.db.update(schema.federationLinks).set({ domain: 'third.invalid', localName: 'Снова имя' }).where(orm.eq(schema.federationLinks.instanceId, third));
  assert.equal((await home())?.name, 'Снова имя');
});

async function linkedPrecedence(edits: Edits = {}) {
  const f = await fixture(edits);
  await f.links.saveVouchedInstance({ instanceId: third, name: 'Слова хоста', domain: 'vouched.invalid', vouchedBy: host });
  assert.equal(f.labels.instanceLabel(third).name, 'Слова хоста');
  await t.db.insert(schema.federationLinks).values({ instanceId: third, domain: 'direct.invalid', apiBase: 'https://direct.invalid/api',
    clientOrigin: 'https://direct.invalid', rootKey: 'fixture-direct-public-key', theirName: 'Прямое имя', localName: 'Мой псевдоним', state: 'active', features: [shared.FED_FEATURES.reports] });
  await f.labels.refreshInstanceLabels();
  assert.equal(f.labels.instanceLabel(third).name, 'Мой псевдоним', 'R208 связка: прямое имя старше vouched'); assert.equal(f.labels.instanceLabel(third).domain, 'direct.invalid');
  assert.equal(f.labels.instanceLabel(third).reports, true);
  await f.links.saveVouchedInstance({ instanceId: third, name: 'Попытка перекрыть связку', domain: 'new-vouched.invalid', vouchedBy: host });
  assert.equal(f.labels.instanceLabel(third).name, 'Мой псевдоним'); assert.equal(f.labels.instanceLabel(third).domain, 'direct.invalid');
  assert.equal(f.labels.instanceIdByDomain(' DIRECT.INVALID '), third); assert.equal(f.labels.instanceIdByDomain('new-vouched.invalid'), null);
  assert.deepEqual(await vouched(), [[third, 'Попытка перекрыть связку', 'new-vouched.invalid', host]]);
}
it('R208 настоящая связка перекрывает vouched имя, домен и reports, обновление vouched не подменяет её', async () => { await linkedPrecedence(); });
it('R208 vouched вместо прямой связки обнаруживается подменой подписанного напрямую дома', async () => {
  await linkedPrecedence();
  await assert.rejects(linkedPrecedence({ labels: ['if (cache.has(v.instanceId)) continue;', '/* мутант: vouched старше связки */'] }),
    killed('R208 связка: прямое имя старше vouched', 'Слова хоста', 'Мой псевдоним'));
});

async function collidingName(edits: Edits = {}) {
  const f = await fixture(edits);
  await f.links.saveVouchedInstance({ instanceId: third, name: '  МеСтНыЙ ДоМ  ', domain: 'third.invalid', vouchedBy: host });
  assert.equal(f.labels.instanceLabel(third).name, null, 'R208 имя: совпадение с нашим именем не выдаётся за другой дом');
  assert.equal(f.labels.instanceLabel(third).domain, 'third.invalid');
  await f.links.saveVouchedInstance({ instanceId: third, name: 'Сосед по связке', domain: 'third.invalid', vouchedBy: host });
  assert.equal(f.labels.instanceLabel(third).name, null, 'совпадение с именем связки тоже не используется');
  await f.links.saveVouchedInstance({ instanceId: third, name: 'Независимое имя', domain: 'third.invalid', vouchedBy: host });
  assert.equal(f.labels.instanceLabel(third).name, 'Независимое имя'); assert.equal(f.labels.instanceLabel(third).domain, 'third.invalid');
  assert.equal(f.labels.instanceLabel(unknownHome).domain, '');
}
it('R208 совпавшие с нами и связкой имена подавляются, независимое принимается; домен сохраняется', async () => { await collidingName(); });
it('R208 отключение защиты от одноимённого vouched обнаруживается на реальном кеше', async () => {
  await collidingName();
  await assert.rejects(collidingName({ labels: ['nm && !taken.has(nm.toLowerCase()) ? nm : null', 'nm ? nm : null'] }),
    killed('R208 имя: совпадение с нашим именем не выдаётся за другой дом', 'МеСтНыЙ ДоМ', null));
});
