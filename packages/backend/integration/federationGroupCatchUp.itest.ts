import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, it } from 'node:test';
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
  // harness загружает db/index ради миграций; незадействованный PgPool тоже принадлежит этому тестовому процессу.
  try {
    const closed = await Promise.allSettled([hdb.close(), pdb.close()]);
    for (const result of closed) assert.equal(result.status, 'fulfilled', 'обе PGlite-базы закрыты');
  } finally {
    await (await import('../src/db/index.js')).pool.end();
  }
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


async function returning(options: { edit?: Mutation; missingCursor?: boolean; activeBefore?: boolean; many?: boolean } = {}) {
  const { h, p } = await fixture(options.edit);
  const at = Date.now() - 60_000, leave = new Date(at + 1000);
  for (const [t, owner, person] of [[hdb, ids.owner, ids.peerShadow], [pdb, ids.hostShadow, ids.person]] as const) {
    await t.db.insert(schema.conversations).values({ id: ids.group, kind: 'group', title: 'Возврат', groupVersion: 5,
      originInstanceId: t === hdb ? null : H.instanceId });
    await t.db.insert(schema.conversationMembers).values([
      { conversationId: ids.group, userId: owner, role: 'owner' },
      { conversationId: ids.group, userId: person, leftAt: options.activeBefore ? null : leave },
    ]);
    await t.db.insert(schema.conversationMessages).values([
      { id: 'before', conversationId: ids.group, authorId: owner, sortKey: 1, content: 'до', createdAt: new Date(at) },
      { id: t === pdb && options.missingCursor ? 'local-missing' : 'leave', conversationId: ids.group, authorId: person,
        sortKey: 2, content: '', service: { kind: 'group', type: 'leave' }, createdAt: leave },
    ]);
  }
  const missed = Array.from({ length: options.many ? 103 : 2 }, (_, i) => `missed-${String(i + 1).padStart(3, '0')}`);
  await hdb.db.insert(schema.conversationMessages).values(missed.map((id, i) => ({
    id, conversationId: ids.group, authorId: ids.owner, sortKey: i + 3, content: `в отсутствие ${i}`, createdAt: new Date(at + i + 2000),
  })));
  await hdb.db.update(schema.conversationMembers).set({ leftAt: null }).where(orm.eq(schema.conversationMembers.userId, ids.peerShadow));
  await hdb.db.update(schema.conversations).set({ groupVersion: 6 }).where(orm.eq(schema.conversations.id, ids.group));
  await hdb.db.insert(schema.conversationMessages).values({ id: 'returned', conversationId: ids.group, authorId: ids.owner,
    sortKey: missed.length + 3, content: '', service: { kind: 'group', type: 'add' }, createdAt: new Date(at + 10_000) });
  await hdb.db.transaction(tx => h.changes.recordFedConvChanges(tx as never, [
    { conversationId: ids.group, kind: 'conv', entityId: null }, { conversationId: ids.group, kind: 'msg', entityId: 'returned' },
  ]));
  wire(p, h);
  return { h, p, missed };
}
async function returnedHistory(edit?: Mutation) {
  const { p, missed } = await returning({ edit });
  assert.equal(await p.accept.pullConvChanges(H.instanceId), 2, p.warns.join('\n'));
  assert.equal(await cursor(), 2);
  const exports = p.requests.filter(r => r.path.endsWith('/export'));
  assert.deepEqual(exports.map(r => r.query?.after), ['leave'], 'догонка начинается после последнего местного сообщения');
  assert.deepEqual(await messageIds(pdb), ['before', 'leave', ...missed, 'returned'], 'пропущенные строки лежат раньше следующей строки журнала');
  const [g] = await pdb.db.select().from(schema.conversations).where(orm.eq(schema.conversations.id, ids.group));
  assert.equal(g.groupVersion, 6);
  const [person] = await pdb.db.select().from(schema.conversationMembers).where(orm.and(orm.eq(schema.conversationMembers.conversationId, ids.group), orm.eq(schema.conversationMembers.userId, ids.person)));
  assert.equal(person.leftAt, null);
  p.requests.length = 0;
  assert.equal(await p.accept.pullConvChanges(H.instanceId), 2);
  assert.equal(p.requests.filter(r => r.path.endsWith('/export')).length, 0, 'повтор не открывает завершённую догонку');
}
// Класс ошибки: возврат догружается с начала вместо курсора либо новые строки журнала обгоняют пропущенную историю.
it('R208 новая версия возвращает участника и догоняет после последней местной строки до следующих строк журнала', async () => { await returnedHistory(); });
// Класс ошибки: catchUps сохраняет null вместо настоящей последней строки и повторяет всю историю.
it('R208 null вместо последнего сообщения обнаруживается адресным after, не таймаутом', async () => {
  await returnedHistory();
  await assert.rejects(returnedHistory(inFunction('federation/convAccept', 'groupCatchUp', 'catchUps.set(k, was.last)', 'catchUps.set(k, null)')), killed('догонка начинается после последнего местного сообщения'));
});

async function cursorGone(edit?: Mutation) {
  const { p, missed } = await returning({ edit, missingCursor: true });
  assert.equal(await p.accept.pullConvChanges(H.instanceId), 2);
  assert.deepEqual(p.requests.filter(r => r.path.endsWith('/export')).map(r => r.query?.after), ['local-missing', null], '404 курсора повторяется с after=null');
  assert.deepEqual(await messageIds(pdb), ['before', 'local-missing', 'leave', ...missed, 'returned'], '404 курсора не теряет пропущенную историю');
  assert.equal(await cursor(), 2);
}
// Класс ошибки: локальная строка не дошла до хоста; 404 cursor ошибочно принимается за отсутствие всей группы.
it('R208 отсутствующий у хоста курсор вызывает 404 и один повтор от начала; отключённая ветка обнаруживается', async () => {
  await cursorGone();
  await assert.rejects(cursorGone(inFunction('federation/convAccept', 'groupCatchUp',
    'if (r.ok && r.value.status === 404 && after !== null && page === 0)', 'if (false)')), killed('404 курсора повторяется с after=null'));
});

async function interrupted(edit?: Mutation) {
  const { p, missed } = await returning({ edit, many: true }), transport = p.io.get;
  let broken = true;
  p.io.get = r => broken && r.path.endsWith('/export') && r.query?.after === missed[99]
    ? Promise.resolve({ ok: false, problem: 'fixture-network' }) : transport(r);
  assert.equal(await p.accept.pullConvChanges(H.instanceId), 0, 'сеть держит курсор перед conv');
  assert.equal(await cursor(), 0);
  assert.deepEqual(await messageIds(pdb), ['before', 'leave', ...missed.slice(0, 100)], 'первая страница применена, следующая строка журнала ещё нет');
  const [g] = await pdb.db.select().from(schema.conversations).where(orm.eq(schema.conversations.id, ids.group)); assert.equal(g.groupVersion, 6);
  p.requests.length = 0; broken = false;
  assert.equal(await p.accept.pullConvChanges(H.instanceId), 2);
  assert.deepEqual(p.requests.filter(r => r.path.endsWith('/export')).map(r => r.query?.after), [missed[99]], 'catchUps повторяет последнюю непройденную страницу');
  assert.deepEqual(await messageIds(pdb), ['before', 'leave', ...missed, 'returned'], 'повтор conv с тем же составом завершает сохранённую догонку');
  assert.equal(await cursor(), 2);
}
// Класс ошибки: ошибочный курсор проходит conv при обрыве или теряется after второй страницы при уже принятом составе.
it('R208 сеть на второй странице держит курсор перед conv, повтор завершает catchUps с сохранённого after', async () => { await interrupted(); });
// Класс ошибки: удаление сохранения after повторяет уже полученные страницы вместо продолжения.
it('R208 потерянное catchUps.set(k, after) обнаруживается точным курсором повторной страницы', async () => {
  await interrupted();
  await assert.rejects(interrupted(inFunction('federation/convAccept', 'groupCatchUp', 'else catchUps.set(k, after);', 'else {}')), killed('catchUps повторяет последнюю непройденную страницу'));
});

// Класс ошибки: любое обновление состава ошибочно запускает экспорт, хотя наши действующие люди не менялись.
it('R208 новая версия без изменения наших действующих людей не запускает экспорт истории', async () => {
  const { p } = await returning({ activeBefore: true });
  assert.equal(await p.accept.pullConvChanges(H.instanceId), 2); assert.equal(await cursor(), 2);
  assert.equal(p.requests.filter(r => r.path.endsWith('/export')).length, 0, 'неизменный местный состав не догоняется');
  assert.deepEqual(await messageIds(pdb), ['before', 'leave', 'returned']);
});

// Класс ошибки: старый хост без экспорта групп превращается в вечный retry; второй 404 должен завершить строку совместимо.
it('R208 старый хост с 404 экспорта завершает возврат совместимо после повтора без курсора', async () => {
  const { p } = await returning();
  const transport = p.io.get;
  p.io.get = r => r.path.endsWith('/export') ? Promise.resolve(answer({}, 404)) : transport(r);
  assert.equal(await p.accept.pullConvChanges(H.instanceId), 2);
  assert.deepEqual(p.requests.filter(r => r.path.endsWith('/export')).map(r => r.query?.after), ['leave', null]);
  assert.deepEqual(await messageIds(pdb), ['before', 'leave', 'returned']); assert.equal(await cursor(), 2);
});

