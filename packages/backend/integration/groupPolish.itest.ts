import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, after, test } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as dmRules from '../src/dmRules.js';
import * as groupRules from '../src/groupRules.js';
import * as scheduleRules from '../src/scheduleRules.js';
import * as strangerRules from '../src/strangerRules.js';
import * as contactRules from '../src/contactRules.js';
import * as pushRules from '../src/pushRules.js';
import * as pushCrypto from '../src/pushCrypto.js';
import * as authRules from '../src/authRules.js';
import * as superAdminRules from '../src/superAdminRules.js';
import * as userSearchRules from '../src/userSearchRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = { file: string; from: string; to: string };
let t: TestDb;
const self = 'a'.repeat(32), peer = 'b'.repeat(32), third = 'c'.repeat(32), cid = 'polish-group', leaf = 'polish-leaf';
before(async () => { t = await createTestDb(); });
after(async () => { try { await t?.close(); } finally { await (await import('../src/db/index.js')).pool.end(); } });
const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function moduleOf<T>(name: string, deps: Record<string, unknown>, unexpected: string[], mutation?: Mutation): T {
  let raw = source(name);
  if (mutation?.file === name) { assert.equal(raw.split(mutation.from).length - 1, 1, `единственный якорь ${name}`); raw = raw.replace(mutation.from, mutation.to); }
  const imports: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly) continue;
    const id = (n.moduleSpecifier as ts.StringLiteral).text;
    imports[id] = new Proxy({}, { get: (_o, key) => key === '__esModule' ? true : () => {
      const label = `${name}:${id}.${String(key)}`; unexpected.push(label); throw new Error(`неописанная граница ${label}`);
    } });
  }
  Object.assign(imports, deps);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
    { module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, Error, crypto, console, setTimeout, clearTimeout,
      require: (id: string) => { assert.ok(Object.hasOwn(imports, id), `явный импорт ${name}:${id}`); return imports[id]; } });
  return module.exports as T;
}
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const killed = (label: string, actual: unknown, expected: unknown) => (e: unknown) => e instanceof assert.AssertionError
  && e.message.startsWith(label) && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected;
async function fixture(mutation?: Mutation) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    ...['author', 'other', 'gone'].map(id => ({ id, username: `polish_${id}`, displayName: id, passwordHash: 'fixture', verified: true, approvedAt: new Date() })),
    { id: 'host-person', username: 'polish_host', displayName: 'Хост', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'host-user' },
    { id: 'depart-shadow', username: 'polish_shadow', displayName: 'Исключённый сосед', passwordHash: 'fixture', homeInstanceId: third, homeUserId: 'third-user' },
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'peer.invalid', apiBase: 'https://peer.invalid/api', clientOrigin: 'https://peer.invalid',
    rootKey: 'fixture-root', state: 'active', features: ['dm1', 'dmgroup1'] });
  await t.db.insert(schema.conversations).values([
    { id: cid, kind: 'group', title: 'Местная группа', createdBy: 'author' },
    { id: 'polish-direct', kind: 'direct', directKey: 'author:other', createdBy: 'author' },
    { id: leaf, kind: 'group', title: 'Группа соседа', originInstanceId: peer, createdBy: 'host-person' },
  ]);
  await t.db.insert(schema.conversationMembers).values([
    ...[cid, 'polish-direct'].flatMap(conversationId => ['author', 'other'].map(userId => ({ conversationId, userId }))),
    ...['host-person', 'other'].map(userId => ({ conversationId: leaf, userId, lastReadKey: 42, joinedAt: new Date('2025-01-01') })),
    ...['gone', 'depart-shadow'].map(userId => ({ conversationId: leaf, userId, leftAt: new Date('2026-01-01'), joinedAt: new Date('2025-01-01') })),
  ]);
  await t.db.insert(schema.conversationMessages).values([
    { id: 'pinned', conversationId: cid, authorId: 'author', sortKey: 1, content: 'x'.repeat(61) },
    { id: 'direct-pinned', conversationId: 'polish-direct', authorId: 'author', sortKey: 1, content: 'Личное' },
    { id: 'service-origin', conversationId: leaf, authorId: 'host-person', sortKey: 1, content: 'Хост удалил', service: {
      kind: 'group', type: 'remove', users: [{ id: 'gone', displayName: 'Исключённый' }, { id: 'depart-shadow', displayName: 'Сосед' }, { id: 'unknown', displayName: 'Неизвестный' }],
    } },
  ]);
  const unexpected: string[] = [], events: Array<{ user: string; body: shared.GatewayServerMessage }> = [], packCalls: unknown[][] = [], pushCalls: string[][] = [];
  const env = { ntfy: { baseUrl: null, token: null }, jwtSecret: 'not-a-secret-used-only-by-integration-tests' };
  const dbDeps = { 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema };
  const serialize = moduleOf<typeof import('../src/serialize.js')>('serialize', { '@gusvoice/shared': shared, './env.js': { env }, './linkThreats.js': { dangerousLinksOf: () => [] },
    './federation/instanceLabels.js': { instanceLabel: (id: string) => ({ instanceId: id, name: 'Сосед', domain: 'peer.invalid', reports: false }) } }, unexpected);
  const c = moduleOf<typeof import('../src/conversations.js')>('conversations', { ...dbDeps, '@gusvoice/shared': shared, './convRules.js': rules,
    './serialize.js': serialize, './env.js': { env }, './util.js': { uuidv7: crypto.randomUUID }, './dmWriteBarrier.js': { dmWriteBarrier: {} },
    './realtime.js': { publishToUser: async (user: string, body: shared.GatewayServerMessage) => { events.push({ user, body }); } },
  }, unexpected, mutation);
  c.configureFederatedConv({ selfInstanceId: () => self, record: null });
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', dbDeps, unexpected);
  const contacts = moduleOf<typeof import('../src/contacts.js')>('contacts', { ...dbDeps, './contactRules.js': contactRules }, unexpected);
  const authGuard = moduleOf<typeof import('../src/authGuard.js')>('authGuard', { '@gusvoice/shared': shared, './authRules.js': authRules, './pushRules.js': pushRules,
    './realtime.js': { redisPub: { incr: async () => 1, expire: async () => 1, ttl: async () => 10 } } }, unexpected);
  const push = moduleOf<typeof import('../src/push.js')>('push', { ...dbDeps, '@gusvoice/shared': shared, './env.js': { env }, './pushRules.js': pushRules,
    './pushCrypto.js': pushCrypto, './util.js': { id: crypto.randomUUID } }, unexpected);
  const fanout = moduleOf<typeof import('../src/convSendFanout.js')>('convSendFanout', { ...dbDeps, './authGuard.js': authGuard, './conversations.js': c,
    './contacts.js': contacts, './contactRules.js': contactRules, './groupRules.js': groupRules, './push.js': { ...push, sendPushToUsers: async (...args: Parameters<typeof push.sendPushToUsers>) => {
      pushCalls.push([...args[0]]); return push.sendPushToUsers(...args);
    } } }, unexpected);
  const auth = moduleOf<typeof import('../src/auth.js')>('auth', { ...dbDeps, bcryptjs: bcrypt, jsonwebtoken: jwt, './authRules.js': authRules,
    './superAdminRules.js': superAdminRules, './env.js': { env } }, unexpected);
  const routes = moduleOf<typeof import('../src/routes/conv.js')>('routes/conv', { '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z }, '../db/index.js': { db: t.db },
    '../db/schema.js': schema, '../conversations.js': c, '../convRules.js': rules, '../dmRules.js': dmRules, '../scheduleRules.js': scheduleRules,
    '../strangerRules.js': strangerRules, '../auth.js': auth, '../authGuard.js': authGuard, '../blocks.js': blocks,
    './att.js': { convAttachmentRefsSchema: z.array(z.object({ id: z.string() })) }, '../convSendFanout.js': { ...fanout, pushGroupPack: (...args: Parameters<typeof fanout.pushGroupPack>) => {
      packCalls.push([...args]); fanout.pushGroupPack(...args);
    } } }, unexpected, mutation);
  const fedDeps = { '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const changes = moduleOf<typeof import('../src/federation/convChanges.js')>('federation/convChanges', fedDeps, unexpected);
  const fedGroup = moduleOf<typeof import('../src/federation/convGroup.js')>('federation/convGroup', { ...fedDeps, 'node:crypto': crypto,
    '../conversations.js': c, '../groupRules.js': groupRules, '../userSearchRules.js': userSearchRules }, unexpected);
  const accept = moduleOf<typeof import('../src/federation/convAccept.js')>('federation/convAccept', { ...fedDeps,
    '../conversations.js': c, '../convRules.js': rules, '../convSendFanout.js': fanout }, unexpected, mutation);
  accept.configureFedGroupAccept({ applyConv: async (...args) => { await fedGroup.acceptGroupConvRow(...args); }, verify: fedGroup.verifyMessageSig });
  const drain = async () => { for (let i = 0; i < 16; i++) { await new Promise<void>(resolve => setImmediate(resolve)); await t.raw.query('SELECT 1'); }
    assert.deepEqual(unexpected, [], 'фон не проглотил неописанную зависимость'); };
  const pin = async (notify?: unknown, conversationId = cid, mid = 'pinned', scope = 'both') => {
    const app = Fastify();
    try { await app.register(routes.convRoutes); await app.ready(); const r = await app.inject({ method: 'PUT', url: `/conv/${conversationId}/messages/${mid}/pin`,
      headers: { authorization: `Bearer ${auth.signToken({ sub: 'author', username: 'polish_author', gen: 0 })}` }, payload: { for: scope, ...(notify === undefined ? {} : { notify }) } });
      assert.equal(r.statusCode, 200, r.body); await drain(); return r.json();
    } finally { await app.close(); }
  };
  const pinService = async (conversationId = cid) => (await t.db.select().from(schema.conversationMessages)
    .where(orm.and(orm.eq(schema.conversationMessages.conversationId, conversationId), orm.sql`service->>'kind'='pin'`)))[0];
  const journal = async (user: string) => (await t.raw.query<{ kind: string; message_id: string | null }>('SELECT kind,message_id FROM user_changes WHERE user_id=$1 ORDER BY pts', [user])).rows;
  return { c, changes, accept, pin, pinService, drain, events, packCalls, pushCalls, journal };
}
async function pinScenario(notify?: unknown, mutation?: Mutation, direct = false) {
  const f = await fixture(mutation); await f.pin(notify, direct ? 'polish-direct' : cid, direct ? 'direct-pinned' : 'pinned');
  const service = await f.pinService(direct ? 'polish-direct' : cid); assert.ok(service, 'настоящий pinMessage записал служебную строку');
  assert.equal(service.silent, notify === false && !direct, 'legacy закреп без notify не становится тихим');
  assert.equal(f.packCalls.length, notify === true && !direct ? 1 : 0, 'pushGroupPack вызывается только у группы с notify');
  if (notify === true && !direct) {
    assert.deepEqual(plain(f.packCalls[0]), ['author', cid, ['author', 'other'], `закрепил(а) «${'x'.repeat(60)}…»`, false]);
    assert.deepEqual(f.pushCalls, [['other']]);
  }
  return f;
}
test('R214 G4 группа с Уведомить всех пишет строку закрепа и один пуш с обрезкой на 60 знаках', async () => { await pinScenario(true); });
test('R214 G4 снятая галочка пишет тихую строку без пуша, отсутствующее поле сохраняет прежнее поведение', async () => {
  await pinScenario(false); await pinScenario(); await pinScenario('не булево');
});
test('R214 G4 notify в личке и закреп только у себя в группе не создают групповой пуш', async () => {
  await pinScenario(true, undefined, true); const f = await fixture(); await f.pin(true, cid, 'pinned', 'me');
  assert.equal(await f.pinService(), undefined); assert.equal(f.packCalls.length, 0);
});
async function repeatScenario(mutation?: Mutation) {
  const f = await pinScenario(true, mutation), before = await f.journal('author'), service = await f.pinService();
  await f.pin(true); assert.equal(f.packCalls.length, 1, 'повтор закрепа не повторяет pushGroupPack');
  assert.deepEqual(await f.journal('author'), before); assert.equal((await f.pinService())?.id, service.id);
}
test('R214 G4 повтор закрепа не создаёт второй пуш, служебную строку и журнал', async () => { await repeatScenario(); });
test('R214 G4 контрфакт снятия проверки группы ловится пушем личного закрепа', async () => {
  await pinScenario(true, undefined, true);
  await assert.rejects(pinScenario(true, { file: 'routes/conv', from: "access.kind === 'group' && scope === 'both' ? notify : undefined", to: "scope === 'both' ? notify : undefined" }, true),
    killed('pushGroupPack вызывается только у группы с notify', 1, 0));
});
test('R214 G4 контрфакт !groupNotify ловится тихим legacy закрепом вместо прежнего поведения', async () => {
  await pinScenario(); await assert.rejects(pinScenario(undefined, { file: 'routes/conv', from: 'groupNotify === false ? { silent: true }', to: '!groupNotify ? { silent: true }' }),
    killed('legacy закреп без notify не становится тихим', true, false));
});
test('R214 G4 контрфакт потери res.service ловится вторым пушем на повторный закреп', async () => {
  await repeatScenario(); await assert.rejects(repeatScenario({ file: 'routes/conv', from: 'if (groupNotify === true && res.service)', to: 'if (groupNotify === true)' }),
    killed('повтор закрепа не повторяет pushGroupPack', 2, 1));
});
test('R214 G4 ровно 60 знаков не обрезаются, пробельный текст даёт пуш без цитаты', async () => {
  for (const [content, expected] of [['x'.repeat(60), `закрепил(а) «${'x'.repeat(60)}»`], [' \n\t ', 'закрепил(а) сообщение']]) {
    const f = await fixture(); await t.db.update(schema.conversationMessages).set({ content }).where(orm.eq(schema.conversationMessages.id, 'pinned'));
    await f.pin(true); assert.equal(f.packCalls[0][3], expected);
  }
});
test('R214 G6 провод служебной записи даёт глобальные ref только людям из people, исходную запись не меняет', async () => {
  const f = await fixture(), row = (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, 'service-origin')))[0];
  const users = await t.db.select().from(schema.users), people = new Map(users.map(u => [u.id, u]));
  const result = f.changes.toWireMessage(row, people, self).service as { users: Array<{ id: string; ref?: shared.FedPersonRef }> };
  assert.deepEqual(plain(result.users), [
    { id: 'gone', displayName: 'Исключённый', ref: { instanceId: self, userId: 'gone' } },
    { id: 'depart-shadow', displayName: 'Сосед', ref: { instanceId: third, userId: 'third-user' } },
    { id: 'unknown', displayName: 'Неизвестный' },
  ]);
  assert.deepEqual(plain(f.changes.toWireMessage(row, new Map(), self).service), plain(row.service), 'без people провод legacy, без выдуманных ref');
  assert.equal(JSON.stringify(row.service).includes('ref'), false); await f.drain();
});
function wire(service: Record<string, unknown>, author: shared.FedPersonRef = { instanceId: peer, userId: 'host-user' }) {
  return shared.serializeConvMessageWire({ id: 'arrival', conversationId: leaf, author, clientId: null, payloadHash: null, createdAt: Date.now(), originSortKey: 2,
    content: 'Служебная запись хоста', replyToId: null, forwardedFrom: null, silent: true, noPreview: false, captionAbove: false, replyQuote: null, sticker: null,
    service, attachments: [], editVersion: 0, editedAt: null, deleted: false });
}
async function departedScenario(type: 'remove' | 'leave', mutation?: Mutation) {
  const f = await fixture(mutation), service = type === 'remove' ? { kind: 'group', type, users: [
    { id: 'host-gone', displayName: 'Исключённый', ref: { instanceId: self, userId: 'gone' } },
    { id: 'host-shadow', displayName: 'Сосед', ref: { instanceId: third, userId: 'third-user' } },
    { id: 'unknown-on-host', displayName: 'Неизвестный', ref: { instanceId: third, userId: 'missing' } },
  ] } : { kind: 'group', type };
  await f.accept.applyChange(peer, self, 'msg', leaf, wire(service, type === 'leave' ? { instanceId: self, userId: 'gone' } : undefined));
  await f.drain();
  const row = (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, 'arrival')))[0]; assert.ok(row);
  if (type === 'remove') assert.deepEqual(plain((row.service as shared.ConvGroupService).users), [
    { id: 'gone', displayName: 'Исключённый' }, { id: 'depart-shadow', displayName: 'Сосед' }, { id: 'unknown-on-host', displayName: 'Неизвестный' },
  ], 'свой ref получает свой id, неизвестный id остаётся как пришло без ref');
  const journal = await f.journal('gone');
  assert.deepEqual(journal, [{ kind: 'msg', message_id: 'arrival' }, { kind: 'conv', message_id: null }],
    'ушедший получает ровно одну msg и одну conv');
  if (type === 'leave') assert.equal(row.authorId, 'gone', 'выход от хоста остаётся действием нашего ушедшего автора');
  assert.deepEqual(await f.journal('depart-shadow'), [], 'ушедшая тень не получает локальный журнал');
  const event = f.events.find(e => e.user === 'gone')?.body as Extract<shared.GatewayServerMessage, { t: 'conv.change' }>;
  assert.ok(event?.message && event.conversation && 'left' in event.conversation && event.conversation.former);
  assert.ok(event.conversation.former.former, 'бывшая группа содержит причину ухода');
  assert.equal(event.conversation.former.former.removed, type === 'remove', 'бывшая группа отличает исключение от самостоятельного выхода');
  const summary = (await f.c.listConversations('gone', true, true)).former?.find(c => c.id === leaf); assert.ok(summary);
  assert.equal(summary.peerReadKey, 42, 'бывшая группа сохраняет числовой ключ прочтения');
  return f;
}
test('R214 G6 исключённый наш получает служебную строку и бывшую сводку removed=true, тень не получает локальный журнал', async () => { await departedScenario('remove'); });
test('R214 G6 вышедший сам получает msg и conv с former.removed=false', async () => { await departedScenario('leave'); });

test('R215 G6 потеря audience.includes дублирует msg ушедшего автора, но не меняет удаление хостом', async () => {
  // Автор уже получил msg обычной аудиторией; departed-путь добавляет ему только conv. Неавтору нужны обе строки.
  await departedScenario('leave');
  await departedScenario('remove');
  const mutation = { file: 'federation/convAccept',
    from: "...(audience.includes(userId) ? [] : [{ userId, conversationId, kind: 'msg' as const, messageId: ins.id }]),",
    to: "{ userId, conversationId, kind: 'msg' as const, messageId: ins.id }," };
  await departedScenario('remove', mutation);
  const wrong = [{ kind: 'msg', message_id: 'arrival' }, { kind: 'msg', message_id: 'arrival' }, { kind: 'conv', message_id: null }];
  const expected = [{ kind: 'msg', message_id: 'arrival' }, { kind: 'conv', message_id: null }];
  await assert.rejects(departedScenario('leave', mutation), e => e instanceof assert.AssertionError
    && e.message.startsWith('ушедший получает ровно одну msg и одну conv') && e.operator === 'deepStrictEqual'
    && JSON.stringify(e.actual) === JSON.stringify(wrong) && JSON.stringify(e.expected) === JSON.stringify(expected));
});
test('R214 G6 контрфакт !gone без former ловится потерей числового peerReadKey у бывшей группы', async () => {
  await departedScenario('remove'); await assert.rejects(departedScenario('remove', { file: 'conversations',
    from: 'const peerReads = await peerReadKeys(me, rows.filter((r) => !gone(r) || former(r)).map',
    to: 'const peerReads = await peerReadKeys(me, rows.filter((r) => !gone(r)).map' }), killed('бывшая группа сохраняет числовой ключ прочтения', null, 42));
});
