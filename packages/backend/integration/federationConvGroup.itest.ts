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
import * as groupRules from '../src/groupRules.js';
import * as userSearchRules from '../src/userSearchRules.js';
import * as guestRules from '../src/federation/guestRules.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as linkService from '../src/federation/linkService.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
type Groups = typeof import('../src/federation/convGroup.js');
const self = 'a'.repeat(32), host = 'b'.repeat(32), third = 'c'.repeat(32), cid = 'group-projection';
const now = Date.now();
const local = { instanceId: self, userId: 'local' }, second = { instanceId: self, userId: 'second' };
const remote = { instanceId: host, userId: 'host-person' };
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.close(); });
const raw = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const forbidden = (name: string) => () => { throw new Error(`неописанная граница ${name}`); };

/** Целые модули; незадействованные импорты падают явно, а не отвечают выдуманным SQL/правилом. */
function moduleOf<T>(name: string, explicit: Record<string, unknown>, mutations: readonly Mutation[] = []): T {
  let source = raw(name);
  for (const [from, to] of mutations) {
    assert.equal(source.split(from).length - 1, 1, `единственный якорь ${name}: ${from}`);
    source = source.replace(from, to);
  }
  const dependencies: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly) continue;
    const id = (n.moduleSpecifier as ts.StringLiteral).text;
    const exports: Record<string, unknown> = {};
    const names = n.importClause?.namedBindings;
    if (names && ts.isNamedImports(names)) for (const item of names.elements) {
      if (!item.isTypeOnly) exports[item.propertyName?.text ?? item.name.text] = forbidden(`${id}.${item.name.text}`);
    }
    dependencies[id] = exports;
  }
  Object.assign(dependencies, explicit);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, crypto,
    console: { warn: () => {} }, setTimeout: forbidden('таймер'), setInterval: forbidden('worker'),
    require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `явный импорт ${name}:${id}`); return dependencies[id]; },
  });
  return module.exports as T;
}

async function fixture(mutations: readonly Mutation[] = []) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'group_local', displayName: 'Местный', passwordHash: 'fixture', verified: true, approvedAt: new Date(now) },
    { id: 'second', username: 'group_second', displayName: 'Второй', passwordHash: 'fixture', verified: true, approvedAt: new Date(now) },
    { id: 'deleted', username: 'group_deleted', displayName: 'Удалённый', passwordHash: 'fixture', deletedAt: new Date(now) },
    { id: 'shadow', username: 'group_shadow', displayName: 'Сосед', passwordHash: 'fixture', verified: true,
      homeInstanceId: host, homeUserId: remote.userId, homeUsername: 'host_person' },
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: host, domain: 'group-host.invalid',
    apiBase: 'https://group-host.invalid', clientOrigin: 'https://group-host.invalid', rootKey: 'fixture-public-key',
    state: 'active', features: [shared.FED_FEATURES.guests, shared.FED_FEATURES.dmgroup1] });
  const events: Array<{ userId: string; event: shared.GatewayServerMessage; cap: string }> = [];
  const common = { '@gusvoice/shared': shared, 'drizzle-orm': orm };
  const backend = { ...common, './db/index.js': { db: t.db }, './db/schema.js': schema };
  const fed = { ...common, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  // Конфигурация и транспорт — IO; вычисление пароля/сессии, SQL, роли и сериализация настоящие.
  const env = { jwtSecret: 'not-a-secret-group-projection-fixture', publicApiUrl: 'https://self.invalid' };
  const auth = moduleOf<typeof import('../src/auth.js')>('auth', {
    ...backend, bcryptjs: bcrypt, jsonwebtoken: jwt, './authRules.js': authRules, './superAdminRules.js': superAdminRules, './env.js': { env },
  });
  const federation = { identity: () => ({ instanceId: self }) };
  const meta = { readInstanceMeta: async () => ({ paused: false, name: 'Фикстура группы' }) };
  const links = moduleOf<typeof import('../src/federation/links.js')>('federation/links', {
    ...fed, 'node:crypto': crypto, './linkService.js': linkService, './instance.js': { federation },
    './outbox.js': { queueDepth: async () => 0 }, './instanceMeta.js': meta,
  });
  const labels = moduleOf<typeof import('../src/federation/instanceLabels.js')>('federation/instanceLabels', {
    ...common, './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta,
  });
  await labels.refreshInstanceLabels();
  const threats = moduleOf<typeof import('../src/linkThreats.js')>('linkThreats', { './env.js': { env: { linkThreats: { enabled: false } } } });
  const serializer = moduleOf<typeof import('../src/serialize.js')>('serialize', {
    ...common, './federation/instanceLabels.js': labels, './linkThreats.js': threats,
  });
  const changes = moduleOf<typeof import('../src/federation/convChanges.js')>('federation/convChanges', fed);
  const c = moduleOf<typeof import('../src/conversations.js')>('conversations', {
    ...backend, './convRules.js': convRules, './serialize.js': serializer, './dmWriteBarrier.js': { dmWriteBarrier: {} },
    './util.js': { uuidv7: crypto.randomUUID }, './env.js': { env },
    './attachments.js': { privateAttachmentsReady: () => true, attachmentLink: forbidden('ссылка файла'), purgeDeleted: forbidden('удаление файла') },
    './realtime.js': { publishToUser: async (userId: string, event: shared.GatewayServerMessage, options: { cap: string }) => {
      events.push({ userId, event, cap: options.cap });
    } },
  });
  c.configureFederatedConv({ selfInstanceId: () => self, record: (tx, items) => changes.recordFedConvChanges(tx, items) });
  const guests = moduleOf<typeof import('../src/federation/guestHost.js')>('federation/guestHost', {
    ...fed, 'node:crypto': crypto, '../auth.js': auth, '../authRules.js': authRules, './guestRules.js': guestRules,
    './instance.js': { federation }, './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta,
    './avatars.js': { refreshGuestAvatar: async () => {} },
  });
  const groups = moduleOf<Groups>('federation/convGroup', {
    ...fed, 'node:crypto': crypto, '../conversations.js': c, '../groupRules.js': groupRules, '../userSearchRules.js': userSearchRules,
    './guestHost.js': guests, './instance.js': { federation }, './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta,
  }, mutations);
  return { groups, c, events, guests };
}

function wire(options: { version?: number; title?: string; members?: shared.FedPersonRef[]; owner?: shared.FedPersonRef | null;
  origin?: string; id?: string; profiles?: shared.FedGroupProfile[]; avatarUrl?: string | null } = {}): Record<string, unknown> {
  return { ...shared.serializeConvWire({ id: options.id ?? cid, kind: 'group', originInstanceId: options.origin ?? host,
    createdAt: now - 60_000, members: options.members ?? [local, second, remote], title: options.title ?? 'Исходная группа' }),
  ...shared.serializeConvGroupExtras({ version: options.version ?? 2, avatarUrl: options.avatarUrl ?? null,
    owner: options.owner === undefined ? remote : options.owner, profiles: options.profiles ?? [] }) };
}
async function conv(id = cid) { return (await t.db.select().from(schema.conversations).where(orm.eq(schema.conversations.id, id)))[0]; }
async function members(id = cid) { return t.db.select().from(schema.conversationMembers).where(orm.eq(schema.conversationMembers.conversationId, id)).orderBy(orm.asc(schema.conversationMembers.userId)); }
async function counts() { return { journal: (await t.db.select().from(schema.userChanges)).length, fed: (await t.db.select().from(schema.fedConvChanges)).length }; }
function assertion(label: string) { return (err: unknown) => err instanceof assert.AssertionError && err.message.includes(label); }

it('R203 группу заводит только её рабочий хост: чужой origin и paused ничего не записывают', async () => {
  const f = await fixture();
  await f.groups.applyGroupConv(host, self, cid, wire({ origin: third }));
  assert.equal(await conv(), undefined); assert.deepEqual(await counts(), { journal: 0, fed: 0 });
  await t.db.update(schema.federationLinks).set({ state: 'paused' });
  await f.groups.applyGroupConv(host, self, cid, wire()); assert.equal(await conv(), undefined);
  await t.db.update(schema.federationLinks).set({ state: 'active' });
  await f.groups.applyGroupConv(host, self, cid, wire());
  const row = await conv(); assert.equal(row.originInstanceId, host); assert.equal(row.kind, 'group'); assert.equal(row.groupVersion, 2);
  assert.equal(row.createdAt.getTime(), now - 60_000); assert.equal(row.title, 'Исходная группа');
  assert.deepEqual((await members()).map(m => [m.userId, m.role, m.leftAt]), [['local', 'member', null], ['second', 'member', null], ['shadow', 'owner', null]]);
  assert.deepEqual(await counts(), { journal: 2, fed: 0 });
  assert.deepEqual(f.events.map(e => e.userId).sort(), ['local', 'second']);
  for (const e of f.events) { assert.equal(e.event.t, 'conv.change'); assert.equal(e.cap, shared.FEATURE_GROUPS1); }
});

async function versions(mutations: readonly Mutation[] = []) {
  const f = await fixture(mutations); await f.groups.applyGroupConv(host, self, cid, wire());
  const original = JSON.stringify({ conv: await conv(), members: await members() }), initial = await counts();
  f.events.length = 0;
  for (const version of [1, 2]) {
    await f.groups.applyGroupConv(host, self, cid, wire({ version, title: 'Переписать равной/старой', members: [local, remote], owner: local,
      avatarUrl: 'https://group-host.invalid/stale.png' }));
    assert.equal(JSON.stringify({ conv: await conv(), members: await members() }), original, 'старая и равная версия не переписывают снимок');
    assert.deepEqual(await counts(), initial); assert.equal(f.events.length, 0);
  }
  await f.groups.applyGroupConv(host, self, cid, wire({ version: 3, title: 'Новая версия', members: [local, remote], owner: local,
    avatarUrl: 'https://group-host.invalid/new.png' }));
  assert.equal((await conv()).groupVersion, 3); assert.equal((await conv()).title, 'Новая версия');
  assert.equal((await conv()).avatarUrl, 'https://group-host.invalid/new.png');
  const rows = await members(); assert.ok(rows.find(m => m.userId === 'second')?.leftAt);
  assert.equal(rows.find(m => m.userId === 'local')?.role, 'owner'); assert.equal(rows.find(m => m.userId === 'shadow')?.role, 'member');
  assert.deepEqual(await counts(), { journal: initial.journal + 2, fed: 0 }); assert.equal(f.events.length, 2);
}
it('R203 старая и равная версии игнорируются, следующая меняет название, фото, состав и владельца', async () => { await versions(); });
it('R203 <= → < в обеих проверках версии обнаруживается равным снимком, не loader/таймаутом', async () => {
  await versions();
  await assert.rejects(versions([
    ['existing.origin !== peer || x.version <= existing.version', 'existing.origin !== peer || x.version < existing.version'],
    ['(existing && x.version <= cur.version)', '(existing && x.version < cur.version)'],
  ]), assertion('старая и равная версия не переписывают снимок'));
});

it('R203 несовпавший id, не группа и коллизия с местной беседой не меняют SQL; правильная новая группа проходит', async () => {
  const f = await fixture();
  await f.groups.applyGroupConv(host, self, cid, wire({ id: 'other' }));
  await f.groups.applyGroupConv(host, self, cid, { ...wire(), kind: 'direct' });
  await f.groups.applyGroupConv(host, self, cid, { ...wire(), group_version: undefined });
  assert.equal(await conv(), undefined); assert.deepEqual(await counts(), { journal: 0, fed: 0 });
  await t.db.insert(schema.conversations).values({ id: cid, kind: 'group', title: 'Местная', groupVersion: 0, createdBy: 'local' });
  await f.groups.applyGroupConv(host, self, cid, wire({ version: 9 }));
  assert.equal((await conv()).originInstanceId, null); assert.equal((await conv()).title, 'Местная'); assert.equal((await conv()).groupVersion, 0);
  await f.groups.applyGroupConv(host, self, 'other', wire({ id: 'other' })); assert.equal((await conv('other')).originInstanceId, host);
});

it('R203 без существующего живого местного участника группы нет; теневой id под self не становится местным', async () => {
  const f = await fixture();
  for (const userId of ['missing', 'deleted', 'shadow']) {
    await f.groups.applyGroupConv(host, self, cid, wire({ members: [{ instanceId: self, userId }, remote] }));
    assert.equal(await conv(), undefined); assert.equal((await members()).length, 0);
  }
  await f.groups.applyGroupConv(host, self, cid, wire({ members: [remote] })); assert.equal(await conv(), undefined);
  assert.deepEqual(await counts(), { journal: 0, fed: 0 }); assert.equal(f.events.length, 0);
  await f.groups.applyGroupConv(host, self, cid, wire({ members: [local, remote] }));
  assert.equal((await members()).length, 2); assert.deepEqual(await counts(), { journal: 1, fed: 0 });
});

it('R203 уход нашего участника ставит left_at и присылает бывшую группу без эха хосту', async () => {
  const f = await fixture(); await f.groups.applyGroupConv(host, self, cid, wire());
  await t.db.update(schema.conversationMembers).set({ pinnedAt: new Date(now), archivedAt: new Date(now), unreadMarkedAt: new Date(now) })
    .where(orm.and(orm.eq(schema.conversationMembers.conversationId, cid), orm.eq(schema.conversationMembers.userId, 'second')));
  f.events.length = 0;
  await f.groups.applyGroupConv(host, self, cid, wire({ version: 3, members: [local, remote] }));
  const left = (await members()).find(m => m.userId === 'second')!;
  assert.ok(left.leftAt); assert.equal(left.role, 'member'); assert.equal(left.pinnedAt, null); assert.equal(left.archivedAt, null); assert.equal(left.unreadMarkedAt, null);
  assert.equal(await f.c.loadAccess(cid, 'second'), null);
  const event = f.events.find(e => e.userId === 'second')?.event;
  assert.ok(event && event.t === 'conv.change');
  // Провод сохраняет left для старого клиента; новый получает полную former-сводку, а не удалённый чат.
  assert.equal(event.conversation.id, cid);
  assert.ok('left' in event.conversation && event.conversation.left === true, 'совместимая оболочка прежнего клиента сохранена');
  const former = event.conversation.former;
  assert.ok(former, 'ушедшему приходит полная сводка бывшей группы');
  assert.equal(former.id, cid);
  assert.equal(former.group?.title, 'Исходная группа');
  assert.equal(Object.hasOwn(former, 'left'), false, 'бывшая сводка не является командой убрать чат');
  assert.deepEqual(JSON.parse(JSON.stringify(former.former)), { at: left.leftAt!.toISOString(), removed: false });
  assert.equal(former.unread, 0); assert.equal(former.unreadReactions, 0); assert.equal(former.markedUnread, false);
  assert.equal(former.scheduledCount, 0); assert.equal(former.draft, null);
  assert.deepEqual(f.events.map(e => e.userId).sort(), ['local', 'second'], 'клиентские события идут только нашим участникам, не тени хоста');
  assert.equal((await counts()).fed, 0);
});

it('R203 возвращение оживляет прежнюю строку, снимает pending/архив/скрытие и назначает owner по проводу', async () => {
  const f = await fixture(); await f.groups.applyGroupConv(host, self, cid, wire());
  await f.groups.applyGroupConv(host, self, cid, wire({ version: 3, members: [local, remote] }));
  const highKey = Number.MAX_SAFE_INTEGER - 10;
  await t.db.update(schema.conversations).set({ lastSortKey: highKey }).where(orm.eq(schema.conversations.id, cid));
  const oldJoined = new Date(now - 86_400_000);
  await t.db.update(schema.conversationMembers).set({ joinedAt: oldJoined, pending: true, hiddenKey: 12, lastReadKey: 2,
    archivedAt: new Date(now), pinnedAt: new Date(now) }).where(orm.and(orm.eq(schema.conversationMembers.conversationId, cid), orm.eq(schema.conversationMembers.userId, 'second')));
  f.events.length = 0;
  await f.groups.applyGroupConv(host, self, cid, wire({ version: 4, owner: second }));
  const rows = await members(), back = rows.find(m => m.userId === 'second')!;
  assert.equal(rows.length, 3); assert.equal(back.leftAt, null); assert.equal(back.pending, false); assert.equal(back.hiddenKey, null);
  assert.equal(back.archivedAt, null); assert.equal(back.pinnedAt, null); assert.ok(back.joinedAt.getTime() > oldJoined.getTime());
  // Ключ выше часов базы: настоящая SQL-ветка max(last_sort_key + 1, now()) даёт точное highKey + 1.
  assert.equal(back.lastReadKey, highKey);
  assert.equal(back.role, 'owner'); assert.equal(rows.find(m => m.userId === 'shadow')?.role, 'member');
  assert.ok(await f.c.loadAccess(cid, 'second')); assert.deepEqual(f.events.map(e => e.userId).sort(), ['local', 'second']);
});

it('R203 owner переносится между действующими людьми; null не оставляет прежнему владельцу власть', async () => {
  const f = await fixture(); await f.groups.applyGroupConv(host, self, cid, wire());
  await f.groups.applyGroupConv(host, self, cid, wire({ version: 3, owner: local }));
  assert.deepEqual((await members()).filter(m => m.role === 'owner').map(m => m.userId), ['local']);
  await f.groups.applyGroupConv(host, self, cid, wire({ version: 4, owner: null }));
  assert.equal((await members()).filter(m => m.role === 'owner').length, 0);
});

it('R203 хост поручается за третьего участника без попарной связки: профиль и owner попадают в настоящие строки', async () => {
  const f = await fixture(); const person = { instanceId: third, userId: 'third-person' };
  assert.equal((await t.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, third))).length, 0);
  await f.groups.applyGroupConv(host, self, cid, wire({ members: [local, remote, person], owner: person,
    profiles: [{ ref: person, username: 'third_person', displayName: 'Третий дом', avatarHash: null }] }));
  const shadow = await f.guests.shadowUserFor(third, person.userId); assert.ok(shadow);
  assert.equal(shadow.homeUsername, 'third_person'); assert.equal(shadow.displayName, 'Третий дом');
  assert.equal((await members()).find(m => m.userId === shadow.id)?.role, 'owner');
  assert.equal((await conv()).originInstanceId, host); assert.deepEqual(f.events.map(e => e.userId), ['local']);
});

it('R203 acceptGroupConvRow возвращает null для 1:1, true для принятой группы и false без нашего человека', async () => {
  const f = await fixture();
  assert.equal(await f.groups.acceptGroupConvRow(host, self, 'direct', { kind: 'direct' }), null);
  assert.equal(await conv('direct'), undefined);
  assert.equal(await f.groups.acceptGroupConvRow(host, self, 'refused', wire({ id: 'refused', members: [remote] })), false);
  assert.equal(await conv('refused'), undefined);
  assert.equal(await f.groups.acceptGroupConvRow(host, self, cid, wire()), true);
  assert.equal(await f.groups.acceptGroupConvRow(host, self, cid, wire({ version: 1 })), true, 'прежняя принятая группа остаётся доступной для следующих msg');
  assert.equal((await conv()).groupVersion, 2);
});
