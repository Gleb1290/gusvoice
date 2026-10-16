import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, it } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as convRules from '../src/convRules.js';
import * as groupRules from '../src/groupRules.js';
import * as userSearchRules from '../src/userSearchRules.js';
import * as guestRules from '../src/federation/guestRules.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as linkService from '../src/federation/linkService.js';
import * as identityRules from '../src/federation/instanceIdentity.js';
import * as signing from '../src/federation/signingKeys.js';
import * as admission from '../src/routes/fedAdmission.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Identity = { instanceId: string; rootPublicKeyDer: Buffer; key: signing.SigningKeyPair };
type Mutation = { file: string; from: string; to: string };
type Request = { path: string; query?: Record<string, unknown> };
type Reply = { ok: true; value: { status: number; body: string; retryAfter: number | null } } | { ok: false; problem: string };
type Changes = typeof import('../src/federation/convChanges.js');
let H: Identity, P: Identity, hdb: TestDb, pdb: TestDb;
const ids = { owner: crypto.randomUUID(), person: crypto.randomUUID(), hostShadow: crypto.randomUUID(), peerShadow: crypto.randomUUID(),
  secondShadow: crypto.randomUUID(), secondPerson: crypto.randomUUID(), group: crypto.randomUUID(), direct: crypto.randomUUID() };
function identity(): Identity {
  const root = crypto.generateKeyPairSync('ed25519'), der = root.publicKey.export({ type: 'spki', format: 'der' });
  return { instanceId: identityRules.instanceIdFrom(der), rootPublicKeyDer: der,
    key: signing.issueSigningKey(root.privateKey.export({ type: 'pkcs8', format: 'der' }), Date.now()) };
}
before(async () => { H = identity(); P = identity(); hdb = await createTestDb(); pdb = await createTestDb(); });
after(async () => {
  const closed = await Promise.allSettled([hdb.close(), pdb.close()]);
  // harness импортирует db/index ради миграций; его неиспользуемый PgPool тоже не оставляем жить после HTTP-теста.
  const { pool } = await import('../src/db/index.js'); await pool.end();
  for (const result of closed) assert.equal(result.status, 'fulfilled', 'обе временные базы закрываются');
});
const fail = (name: string) => () => { throw new Error(`неописанная IO-граница ${name}`); };
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;
const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
/** Целый исходник: подменяются только IO, правила и SQL исполняются настоящие. */
function moduleOf<T>(name: string, explicit: Record<string, unknown>, warns: string[], edit?: Mutation): T {
  let raw = source(name);
  if (edit?.file === name) { assert.equal(raw.split(edit.from).length - 1, 1, `единственный якорь ${name}`); raw = raw.replace(edit.from, edit.to); }
  const deps: Record<string, unknown> = {};
  for (const node of ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
    const imported = (node.moduleSpecifier as ts.StringLiteral).text, exports: Record<string, unknown> = {};
    const names = node.importClause?.namedBindings;
    if (names && ts.isNamedImports(names)) for (const item of names.elements) if (!item.isTypeOnly) exports[item.propertyName?.text ?? item.name.text] = fail(`${imported}.${item.name.text}`);
    deps[imported] = exports;
  }
  Object.assign(deps, explicit);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date, Buffer, URL, Map, Set, Promise, Error,
    console: { warn: (...args: unknown[]) => warns.push(args.join(' ')) }, setTimeout: fail('таймер'), setInterval: fail('worker'),
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `явный импорт ${name}:${id}`); return deps[id]; },
  });
  return module.exports as T;
}
function inFunction(file: string, name: string, from: string, to: string): Mutation {
  const raw = source(file), ast = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.equal(functions.length, 1, `единственная функция ${name}`);
  const body = functions[0].getText(ast); assert.equal(body.split(from).length - 1, 1, `адресный якорь ${name}`);
  return { file, from: body, to: body.replace(from, to) };
}
/** Loader/realm/таймаут не являются убийством: нужен адресный host AssertionError с различающимися actual/expected. */
const killed = (label: string) => (error: unknown) => error instanceof assert.AssertionError && error.message.includes(label)
  && Object.hasOwn(error, 'actual') && Object.hasOwn(error, 'expected') && JSON.stringify(error.actual) !== JSON.stringify(error.expected);
const answer = (body: unknown, status = 200, retryAfter: number | null = null): Reply => ({ ok: true, value: { status, body: JSON.stringify(body), retryAfter } });
function side(t: TestDb, me: Identity, edit?: Mutation) {
  const warns: string[] = [], fed = { 'drizzle-orm': orm, '@gusvoice/shared': shared, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const load = <T>(name: string, deps: Record<string, unknown>) => moduleOf<T>(name, deps, warns, edit);
  const federation = { identity: () => me, signingKey: () => me.key };
  const meta = { readInstanceMeta: async () => ({ paused: false, name: 'Фикстура' }) };
  const links = load<typeof import('../src/federation/links.js')>('federation/links', {
    ...fed, './linkService.js': linkService, './instanceMeta.js': meta, './outbox.js': { queueDepth: async () => 0 },
  });
  const guest = load<typeof import('../src/federation/guestHost.js')>('federation/guestHost', {
    ...fed, 'node:crypto': crypto, './guestRules.js': guestRules, './links.js': links, './linkRules.js': linkRules, './instance.js': { federation },
  });
  const changes = load<Changes>('federation/convChanges', fed);
  const conversations = load<typeof import('../src/conversations.js')>('conversations', {
    'drizzle-orm': orm, '@gusvoice/shared': shared, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './convRules.js': convRules, './dmWriteBarrier.js': { dmWriteBarrier: {} }, './env.js': { env: {} }, './util.js': { uuidv7: crypto.randomUUID },
    './attachments.js': { privateAttachmentsReady: () => true },
  });
  conversations.configureFederatedConv({ selfInstanceId: () => me.instanceId, record: changes.recordFedConvChanges });
  const conv = { ...conversations, deliver: async () => {} };
  const group = load<typeof import('../src/federation/convGroup.js')>('federation/convGroup', {
    ...fed, 'node:crypto': crypto, '../conversations.js': conv, '../groupRules.js': groupRules, '../userSearchRules.js': userSearchRules,
    './guestHost.js': guest, './instance.js': { federation }, './instanceIdentity.js': identityRules, './signingKeys.js': signing,
    './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta,
  });
  changes.configureFedGroupSigner(group.signOwnMessage);
  const requests: Request[] = [], io = { get: (async () => { throw new Error('транспорт не подключён'); }) as (r: Request) => Promise<Reply> };
  const accept = load<typeof import('../src/federation/convAccept.js')>('federation/convAccept', {
    ...fed, '../conversations.js': conv, '../convRules.js': convRules, './instance.js': { federation },
    '../convSendFanout.js': { fanOutSend: async () => {} }, './convLink.js': { notePeerAnswer: () => {} },
    './peerClient.js': { getSignedFromPeer: async (r: Request) => { requests.push(r); return io.get(r); } },
  });
  accept.configureFedGroupAccept({ applyConv: group.applyGroupConv, verify: group.verifyMessageSig });
  accept.configureFedConvRow(async (peer, self, cid, entity) => (await group.acceptGroupConvRow(peer, self, cid, entity)) ?? false);
  return { t, me, changes, accept, group, requests, io, warns };
}
type Side = ReturnType<typeof side>;
async function fixture(edit?: Mutation, groups = true) {
  await truncateAll(hdb.raw); await truncateAll(pdb.raw);
  const features = [shared.FED_FEATURES.dm1, ...(groups ? [shared.FED_FEATURES.dmgroup1] : [])];
  const link = (who: Identity) => ({ instanceId: who.instanceId, domain: `${who.instanceId}.invalid`, apiBase: `https://${who.instanceId}.invalid/api`,
    clientOrigin: `https://${who.instanceId}.invalid`, rootKey: who.rootPublicKeyDer.toString('base64url'), state: 'active' as const, features });
  await hdb.db.insert(schema.users).values([
    { id: ids.owner, username: 'host_owner', displayName: 'Хост', passwordHash: 'fixture' },
    { id: ids.peerShadow, username: 'peer_shadow', displayName: 'Участник', passwordHash: 'fixture', homeInstanceId: P.instanceId, homeUserId: ids.person, homeUsername: 'peer_person' },
    { id: ids.secondShadow, username: 'second_shadow', displayName: 'Второй', passwordHash: 'fixture', homeInstanceId: P.instanceId, homeUserId: ids.secondPerson, homeUsername: 'second_person' },
  ]);
  await pdb.db.insert(schema.users).values([
    { id: ids.person, username: 'peer_person', displayName: 'Участник', passwordHash: 'fixture' },
    { id: ids.hostShadow, username: 'host_shadow', displayName: 'Хост', passwordHash: 'fixture', homeInstanceId: H.instanceId, homeUserId: ids.owner, homeUsername: 'host_owner' },
  ]);
  await hdb.db.insert(schema.federationLinks).values(link(P)); await pdb.db.insert(schema.federationLinks).values(link(H));
  for (const [t, a, b] of [[hdb, ids.owner, ids.peerShadow], [pdb, ids.person, ids.hostShadow]] as const) {
    await t.db.insert(schema.conversations).values({ id: ids.direct, kind: 'direct', directKey: `d-${ids.direct}` });
    await t.db.insert(schema.conversationMembers).values([{ conversationId: ids.direct, userId: a }, { conversationId: ids.direct, userId: b }]);
  }
  return { h: side(hdb, H, edit), p: side(pdb, P, edit) };
}
async function hostGroup(version = 3) {
  await hdb.db.insert(schema.conversations).values({ id: ids.group, kind: 'group', title: 'Тестовая группа', groupVersion: version, createdBy: ids.owner });
  await hdb.db.insert(schema.conversationMembers).values([{ conversationId: ids.group, userId: ids.owner, role: 'owner' }, { conversationId: ids.group, userId: ids.peerShadow }]);
}
function wire(client: Side, server: Side) {
  client.io.get = async r => {
    const q = r.query ?? {}; assert.equal(q.instance_id, client.me.instanceId);
    if (r.path === '/api/fed/v1/conv/changes') return answer(shared.serializeConvChangesPage(await server.changes.changesForPeer(client.me.instanceId, Number(q.since), 100, server.me.instanceId)));
    if (r.path === '/api/fed/v1/conv/groups') {
      const groups = await server.changes.groupsForPeer(client.me.instanceId);
      return groups ? answer(shared.serializeConvGroupsList({ instanceId: server.me.instanceId, groups })) : answer({}, 404);
    }
    const match = /^\/api\/fed\/v1\/conv\/([^/]+)\/export$/.exec(r.path); assert.ok(match, 'известный путь экспорта');
    const page = await server.changes.exportForPeer(client.me.instanceId, decodeURIComponent(match[1]), q.after as string | null ?? null, server.me.instanceId);
    return page ? answer(shared.serializeConvExportPage(page)) : answer({}, 404);
  };
}
async function reset() {
  await hdb.db.insert(schema.fedConvSync).values({ instanceId: P.instanceId, seq: 20, minSeq: 15 });
  await pdb.db.insert(schema.fedConvCursor).values({ instanceId: H.instanceId, since: 7 });
}
const messageIds = async (t: TestDb, cid = ids.group) => (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.conversationId, cid)).orderBy(orm.asc(schema.conversationMessages.sortKey))).map(m => m.id);
const cursor = async () => (await pdb.db.select().from(schema.fedConvCursor).where(orm.eq(schema.fedConvCursor.instanceId, H.instanceId)))[0]?.since ?? 0;

async function featureGate(edit?: Mutation) {
  const { h } = await fixture(edit, false); await hostGroup();
  assert.equal(await h.changes.groupsForPeer(P.instanceId), null, 'без dmgroup1 список закрыт');
  assert.equal(await h.changes.exportForPeer(P.instanceId, ids.group, null, H.instanceId), null, 'без dmgroup1 экспорт закрыт');
  await hdb.db.update(schema.federationLinks).set({ features: [shared.FED_FEATURES.dm1, shared.FED_FEATURES.dmgroup1] });
  assert.deepEqual(normal(await h.changes.groupsForPeer(P.instanceId)), [ids.group]);
  assert.ok(await h.changes.exportForPeer(P.instanceId, ids.group, null, H.instanceId));
}
// Класс ошибки: сосед без групп случайно получает неподдерживаемый провод; проверяем и закрытие, и открытие.
it('R208 без dmgroup1 список и экспорт закрыты, с признаком открыты; обход gate обнаруживается', async () => {
  await featureGate();
  await assert.rejects(featureGate(inFunction('federation/convChanges', 'peerKnowsGroups', 'return !!link?.features.includes(FED_FEATURES.dmgroup1);', 'return true;')), killed('без dmgroup1 список закрыт'));
});

async function hostedExport(edit?: Mutation) {
  const { h } = await fixture(edit); await hostGroup();
  await hdb.db.insert(schema.conversationMessages).values([
    { id: 'host-live', conversationId: ids.group, authorId: ids.owner, sortKey: 1, content: 'хост' },
    { id: 'peer-live', conversationId: ids.group, authorId: ids.peerShadow, sortKey: 2, content: 'эхо' },
    { id: 'peer-deleted', conversationId: ids.group, authorId: ids.peerShadow, sortKey: 3, content: '', deletedAt: new Date() },
    { id: 'peer-service', conversationId: ids.group, authorId: ids.peerShadow, sortKey: 4, content: '', service: { kind: 'group', type: 'leave' } },
  ]);
  const first = await h.changes.exportForPeer(P.instanceId, ids.group, null, H.instanceId); assert.ok(first);
  assert.deepEqual(normal(first.items.map(i => i.entityId ?? i.kind)), ['conv', 'host-live', 'peer-deleted', 'peer-service'], 'живая копия не эхо, надгробие и уход доходят');
  assert.equal(first.items.find(i => i.entityId === 'peer-deleted')?.entity?.deleted, true);
  const next = await h.changes.exportForPeer(P.instanceId, ids.group, 'host-live', H.instanceId); assert.ok(next);
  assert.deepEqual(normal(next.items.map(i => i.entityId ?? i.kind)), ['peer-deleted', 'peer-service'], 'conv только на первой странице');
  assert.equal(await h.changes.exportForPeer(P.instanceId, ids.group, 'missing', H.instanceId), null);
}
// Класс ошибки: отбор живых копий съедает служебную запись либо повторно заводит состав каждой страницей.
it('R208 хост не возвращает живую копию, но отдаёт надгробие и уход; conv только без after', async () => { await hostedExport(); });
for (const [name, from, to, label] of [
  ['служебная ошибочно признана копией', 'm.home === instanceId && !m.deletedAt && !m.service', 'm.home === instanceId && !m.deletedAt', 'живая копия не эхо, надгробие и уход доходят'],
  ['состав повторяется после курсора', 'if (hosting && !after)', 'if (hosting)', 'conv только на первой странице'],
] as const) {
  // Класс ошибки: неправильный фильтр экспорта, а не ошибка загрузчика или VM.
  it(`R208 мутант «${name}» обнаруживается адресным содержимым страницы`, async () => {
    await hostedExport(); await assert.rejects(hostedExport(inFunction('federation/convChanges', 'exportGroupForPeer', from, to)), killed(label));
  });
}

async function formerWindow(edit?: Mutation) {
  const { h } = await fixture(edit); await hostGroup(); const at = new Date('2026-10-01T12:00:00Z');
  await hdb.db.insert(schema.conversationMembers).values({ conversationId: ids.group, userId: ids.secondShadow, leftAt: at });
  await hdb.db.update(schema.conversationMembers).set({ leftAt: new Date(at.getTime() - 100) }).where(orm.eq(schema.conversationMembers.userId, ids.peerShadow));
  await hdb.db.insert(schema.conversationMessages).values([
    { id: 'before', conversationId: ids.group, authorId: ids.owner, sortKey: 1, content: 'до', createdAt: new Date(at.getTime() - 1) },
    { id: 'equal-leave', conversationId: ids.group, authorId: ids.secondShadow, sortKey: 2, content: '', service: { kind: 'group', type: 'leave' }, createdAt: at },
    { id: 'after', conversationId: ids.group, authorId: ids.owner, sortKey: 3, content: 'после', createdAt: new Date(at.getTime() + 1) },
  ]);
  const page = await h.changes.exportForPeer(P.instanceId, ids.group, null, H.instanceId); assert.ok(page);
  assert.deepEqual(normal(page.items.map(i => i.entityId ?? i.kind)), ['conv', 'before', 'equal-leave'], 'окно бывшего включает max(left_at), но не +1 мс');
  assert.deepEqual(normal(await h.changes.groupsForPeer(P.instanceId)), [ids.group], 'бывшая группа остаётся в списке');
  await hdb.db.update(schema.conversationMembers).set({ leftAt: null }).where(orm.eq(schema.conversationMembers.userId, ids.peerShadow));
  const live = await h.changes.exportForPeer(P.instanceId, ids.group, null, H.instanceId); assert.ok(live);
  assert.deepEqual(normal(live.items.map(i => i.entityId ?? i.kind)), ['conv', 'before', 'equal-leave', 'after'], 'один живой человек открывает всё окно');
}
// Класс ошибки: раскрытие истории после ухода всех людей дома; два разных ухода ловят min вместо max.
it('R208 бывшим история до последнего ухода включительно, список остаётся; возвращённому вся история', async () => {
  await formerWindow();
  await assert.rejects(formerWindow(inFunction('federation/convChanges', 'exportGroupForPeer', 'if (Number(t.live) === 0)', 'if (false)')), killed('окно бывшего включает max(left_at), но не +1 мс'));
});

async function originExport(edit?: Mutation) {
  const { h, p } = await fixture(edit); await hostGroup();
  await pdb.db.insert(schema.conversations).values({ id: ids.group, kind: 'group', title: 'Копия', originInstanceId: H.instanceId, groupVersion: 3 });
  await pdb.db.insert(schema.conversationMembers).values([{ conversationId: ids.group, userId: ids.person }, { conversationId: ids.group, userId: ids.hostShadow, role: 'owner' }]);
  await pdb.db.insert(schema.conversationMessages).values([
    { id: 'own', conversationId: ids.group, authorId: ids.person, sortKey: 1, content: 'своё' },
    { id: 'host-copy', conversationId: ids.group, authorId: ids.hostShadow, sortKey: 2, content: 'хост' },
  ]);
  const page = await p.changes.exportForPeer(H.instanceId, ids.group, null, P.instanceId); assert.ok(page);
  assert.deepEqual(normal(page.items.map(i => i.entityId)), ['own'], 'дом участника отдаёт хосту только своё');
  const entity = page.items[0].entity; assert.ok(entity); const parsed = shared.parseConvMessageWire(entity); assert.ok(parsed);
  assert.equal(h.group.verifyMessageSig(parsed, entity), true, 'подпись настоящего дома автора проверяется');
  await pdb.db.update(schema.conversations).set({ originInstanceId: 'c'.repeat(32) }).where(orm.eq(schema.conversations.id, ids.group));
  assert.equal(await p.changes.exportForPeer(H.instanceId, ids.group, null, P.instanceId), null, 'не-хост не получает чужую группу');
}
// Класс ошибки: утечка чужому origin и неподписанная копия, принимаемая на доверии.
it('R208 участник экспортирует только своё с настоящей подписью, не-хосту отказывает; origin-мутант пойман', async () => {
  await originExport();
  await assert.rejects(originExport(inFunction('federation/convChanges', 'exportGroupForPeer', 'if (!hosting && c.origin !== instanceId) return null;', '')), killed('не-хост не получает чужую группу'));
});

// Класс ошибки: пагинация считает ровно лимит уже переполнением или теряет сообщение limit+1.
it('R208 ровно 100 сообщений — последняя страница, 101-е даёт next и отдельную страницу без conv', async () => {
  const { h } = await fixture(); await hostGroup();
  const messages = Array.from({ length: 101 }, (_, i) => `boundary-${String(i + 1).padStart(3, '0')}`);
  await hdb.db.insert(schema.conversationMessages).values(messages.slice(0, 100).map((id, i) => ({ id, conversationId: ids.group,
    authorId: ids.owner, sortKey: i + 1, content: id })));
  const exact = await h.changes.exportForPeer(P.instanceId, ids.group, null, H.instanceId); assert.ok(exact);
  assert.equal(exact.next, null); assert.deepEqual(normal(exact.items.map(i => i.entityId ?? i.kind)), ['conv', ...messages.slice(0, 100)]);
  await hdb.db.insert(schema.conversationMessages).values({ id: messages[100], conversationId: ids.group, authorId: ids.owner, sortKey: 101, content: '101' });
  const first = await h.changes.exportForPeer(P.instanceId, ids.group, null, H.instanceId); assert.ok(first);
  assert.equal(first.next, messages[99]); assert.equal(first.items.length, 101);
  const last = await h.changes.exportForPeer(P.instanceId, ids.group, first.next, H.instanceId); assert.ok(last);
  assert.equal(last.next, null); assert.deepEqual(normal(last.items.map(i => i.entityId ?? i.kind)), [messages[100]]);
});

for (const former of [false, true]) {
  // Класс ошибки: хост не восстановил сообщения дома действующего участника или забрал сообщения уже бывшего.
  it(`R208 reset хоста ${former ? 'не забирает группу бывшего дома' : 'забирает настоящее подписанное своё дома участника без эха'}`, async () => {
    const { h, p } = await fixture(); await hostGroup();
    if (former) await hdb.db.update(schema.conversationMembers).set({ leftAt: new Date() }).where(orm.eq(schema.conversationMembers.userId, ids.peerShadow));
    await pdb.db.insert(schema.conversations).values({ id: ids.group, kind: 'group', originInstanceId: H.instanceId, title: 'Копия', groupVersion: 3 });
    await pdb.db.insert(schema.conversationMembers).values([{ conversationId: ids.group, userId: ids.person }, { conversationId: ids.group, userId: ids.hostShadow, role: 'owner' }]);
    await pdb.db.insert(schema.conversationMessages).values([
      { id: 'host-copy', conversationId: ids.group, authorId: ids.hostShadow, sortKey: 1, content: 'копия хоста' },
      { id: 'peer-own', conversationId: ids.group, authorId: ids.person, sortKey: 2, content: 'от участника' },
    ]);
    await pdb.db.insert(schema.fedConvSync).values({ instanceId: H.instanceId, seq: 9, minSeq: 5 });
    await hdb.db.insert(schema.fedConvCursor).values({ instanceId: P.instanceId, since: 2 });
    wire(h, p); assert.equal(await h.accept.pullConvChanges(P.instanceId), 9, h.warns.join('\n'));
    assert.deepEqual(await messageIds(hdb), former ? [] : ['peer-own']);
    assert.equal(h.requests.some(r => r.path === `/api/fed/v1/conv/${ids.group}/export`), !former);
    const echoed = await hdb.db.select().from(schema.fedConvChanges).where(orm.eq(schema.fedConvChanges.instanceId, P.instanceId));
    assert.equal(echoed.length, 0, 'подписанная копия не уходит эхом своему дому');
  });
}

// Класс ошибки: reset обрезанного журнала восстанавливает только 1:1 и теряет незаведённую группу/вторую страницу.
it('R208 reset привозит 120 групповых сообщений и 1:1; список групп, затем экспорт direct перед group', async () => {
  const { h, p } = await fixture(); await hostGroup();
  const messages = Array.from({ length: 120 }, (_, i) => `group-${String(i + 1).padStart(3, '0')}`);
  await hdb.db.insert(schema.conversationMessages).values(messages.map((id, i) => ({ id, conversationId: ids.group, authorId: ids.owner, sortKey: i + 1, content: `строка ${i}` })));
  await hdb.db.insert(schema.conversationMessages).values({ id: 'direct-message', conversationId: ids.direct, authorId: ids.owner, sortKey: 1, content: '1:1' });
  await reset(); wire(p, h);
  assert.equal(await p.accept.pullConvChanges(H.instanceId), 20, p.warns.join('\n'));
  assert.equal(await cursor(), 20); assert.deepEqual(await messageIds(pdb), messages); assert.deepEqual(await messageIds(pdb, ids.direct), ['direct-message']);
  assert.deepEqual(p.requests.map(r => [r.path, r.query?.after ?? null]), [
    ['/api/fed/v1/conv/changes', null], ['/api/fed/v1/conv/groups', null], [`/api/fed/v1/conv/${ids.direct}/export`, null],
    [`/api/fed/v1/conv/${ids.group}/export`, null], [`/api/fed/v1/conv/${ids.group}/export`, messages[99]], ['/api/fed/v1/conv/changes', null],
  ]);
  const [g] = await pdb.db.select().from(schema.conversations).where(orm.eq(schema.conversations.id, ids.group));
  assert.equal(g.originInstanceId, H.instanceId); assert.equal(g.groupVersion, 3);
});

async function legacyPass(edit?: Mutation, groups = false) {
  const { h, p } = await fixture(edit, groups); await hostGroup(); await reset(); wire(p, h);
  const transport = p.io.get;
  p.io.get = r => r.path === '/api/fed/v1/conv/groups' ? Promise.resolve(answer({}, 404)) : transport(r);
  assert.equal(await p.accept.pullConvChanges(H.instanceId), 20, 'старый сосед не держит полный проход');
  assert.equal(await cursor(), 20);
  if (!groups) assert.equal(p.requests.some(r => r.path === '/api/fed/v1/conv/groups'), false, 'без dmgroup1 списка в проходе нет');
  assert.equal(p.requests.some(r => r.path === `/api/fed/v1/conv/${ids.direct}/export`), true, '1:1 после 404 продолжает проход');
}
// Класс ошибки: gate участника перестал учитывать признак либо 404 старого соседа стал вечной ошибкой reset.
it('R208 полный проход без dmgroup1 остаётся только 1:1; отключение проверки признака поймано', async () => {
  await legacyPass();
  await assert.rejects(legacyPass(inFunction('federation/convAccept', 'fullPassGroups', 'if (!link?.features.includes(FED_FEATURES.dmgroup1)) return [];', '')), killed('без dmgroup1 списка в проходе нет'));
});
// Класс ошибки: совместимый 404 превращён в неисправность, хотя direct обязан догрузиться.
it('R208 список 404 пропускается, 1:1 продолжается; null вместо ids держит курсор и обнаруживается', async () => {
  await legacyPass(undefined, true);
  await assert.rejects(legacyPass(inFunction('federation/convAccept', 'fullPassGroups', 'if (r.value.status === 404) return ids;', 'if (r.value.status === 404) return null;'), true), killed('старый сосед не держит полный проход'));
});
for (const status of [503, 429]) {
  // Класс ошибки: недоступный список ошибочно подтверждает голову журнала, скрывая потерю группы.
  it(`R208 список ${status} удерживает курсор reset перед головой`, async () => {
    const { h, p } = await fixture(); await hostGroup(); await reset(); wire(p, h);
    const transport = p.io.get; p.io.get = r => r.path === '/api/fed/v1/conv/groups' ? Promise.resolve(answer({}, status, 30)) : transport(r);
    assert.equal(await p.accept.pullConvChanges(H.instanceId), 7); assert.equal(await cursor(), 7);
    assert.equal(p.requests.some(r => r.path.endsWith('/export')), false, 'ошибка списка не подтверждает ни одну беседу');
  });
}

async function rejectedGroup(edit?: Mutation) {
  const { h, p } = await fixture(edit); await hostGroup(); await reset(); wire(p, h);
  // На хосте 101 строка заставляет next; чужой состав не должен затянуть нас на эту следующую страницу.
  await hdb.db.delete(schema.conversationMembers).where(orm.eq(schema.conversationMembers.userId, ids.peerShadow));
  const fakeGroup = { ...shared.serializeConvWire({ id: ids.group, kind: 'group', originInstanceId: H.instanceId, createdAt: Date.now(), title: 'Чужая', members: [{ instanceId: H.instanceId, userId: ids.owner }] }),
    ...shared.serializeConvGroupExtras({ version: 4, owner: { instanceId: H.instanceId, userId: ids.owner }, profiles: [], avatarUrl: null }) };
  const transport = p.io.get;
  p.io.get = async r => {
    if (r.path === '/api/fed/v1/conv/groups') return answer(shared.serializeConvGroupsList({ instanceId: H.instanceId, groups: [ids.group] }));
    if (r.path === `/api/fed/v1/conv/${ids.group}/export`) return answer(shared.serializeConvExportPage({ instanceId: H.instanceId, conversationId: ids.group,
      next: r.query?.after ? null : 'next-page', items: [{ seq: 0, kind: 'conv', conversationId: ids.group, entityId: null, entity: fakeGroup }] }));
    return transport(r);
  };
  assert.equal(await p.accept.pullConvChanges(H.instanceId), 20);
  assert.equal(p.requests.filter(r => r.path === `/api/fed/v1/conv/${ids.group}/export`).length, 1, 'отклонённая conv не запрашивает следующую страницу');
  assert.deepEqual(await messageIds(pdb), []);
  assert.equal((await pdb.db.select().from(schema.conversations).where(orm.eq(schema.conversations.id, ids.group))).length, 0);
}
// Класс ошибки: обход gone продолжает export группы без нашего участника.
it('R208 отклонённая conv не заводит группу и не забирает её следующие страницы; gone-мутант пойман', async () => {
  await rejectedGroup();
  await assert.rejects(rejectedGroup(inFunction('federation/convAccept', 'fullPass', 'if (gone || !parsed.next || parsed.next === after) break;', 'if (!parsed.next || parsed.next === after) break;')), killed('отклонённая conv не запрашивает следующую страницу'));
});

// Класс ошибки: null коллектора не превращён в HTTP 404 или HTTP остаётся закрытым после объявления dmgroup1.
it('R208 настоящие HTTP groups и export дают 404 без dmgroup1, после обновления связки 200 с валидным проводом', async () => {
  const { h } = await fixture(undefined, false); await hostGroup();
  await hdb.db.insert(schema.conversationMessages).values({ id: 'http-host-message', conversationId: ids.group, authorId: ids.owner, sortKey: 1, content: 'HTTP-группа' });
  const authenticated: string[] = [], limits: string[] = [];
  const routes = moduleOf<typeof import('../src/routes/federation.js')>('routes/federation', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: hdb.db }, '../db/schema.js': schema,
    '../env.js': { env: { federation: { enabled: true, dmEnabled: true } } },
    '../federation/instance.js': { federation: { identity: () => H } },
    '../federation/convChanges.js': h.changes, './fedAdmission.js': admission,
    // Подпись и Redis — внешние границы. Форма запроса, допуск, маршруты и SQL отбора групп остаются настоящими.
    '../federation/guardsRuntime.js': { fedRateBlock: async (kind: string) => { limits.push(kind); return 0; } },
    '../federation/peerAuth.js': { authenticateLinkedPeer: async (_request: unknown, instanceId: string) => {
      authenticated.push(instanceId);
      const [link] = await hdb.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, instanceId));
      return link ? { ok: true, link } : { ok: false, status: 403, error: shared.FED_ERRORS.noLink };
    } },
  }, h.warns);
  const app = Fastify();
  try {
    await app.register(routes.federationRoutes); await app.ready();
    const listUrl = `/fed/v1/conv/groups?instance_id=${P.instanceId}`;
    const exportUrl = `/fed/v1/conv/${ids.group}/export?instance_id=${P.instanceId}`;
    for (const url of [listUrl, exportUrl]) {
      const refused = await app.inject({ url });
      assert.equal(refused.statusCode, 404, 'HTTP без dmgroup1 скрывает группу');
      assert.deepEqual(refused.json(), { error: 'not found' }, '404 пришёл от production-handler, не отсутствующего маршрута Fastify');
    }
    await hdb.db.update(schema.federationLinks).set({ features: [shared.FED_FEATURES.dm1, shared.FED_FEATURES.dmgroup1] }).where(orm.eq(schema.federationLinks.instanceId, P.instanceId));
    const listed = await app.inject({ url: listUrl }); assert.equal(listed.statusCode, 200, 'HTTP список открывается после признака');
    assert.deepEqual(normal(shared.parseConvGroupsList(listed.json())), { instanceId: H.instanceId, groups: [ids.group] }, 'HTTP список проходит настоящий parser');
    const exported = await app.inject({ url: exportUrl }); assert.equal(exported.statusCode, 200, 'HTTP экспорт открывается после признака');
    const parsed = shared.parseConvExportPage(exported.json()); assert.ok(parsed, 'HTTP экспорт проходит настоящий parser');
    assert.equal(parsed.instanceId, H.instanceId); assert.equal(parsed.conversationId, ids.group); assert.equal(parsed.next, null);
    assert.deepEqual(normal(parsed.items.map(i => i.entityId ?? i.kind)), ['conv', 'http-host-message']);
    assert.deepEqual(authenticated, Array(4).fill(P.instanceId), 'оба HTTP пути реально проходят допуск');
    assert.deepEqual(limits, Array.from({ length: 4 }, () => ['peerAddress', 'convPull']).flat(), 'настоящий допуск применяет адресный и convPull пределы');
  } finally { await app.close(); }
});
