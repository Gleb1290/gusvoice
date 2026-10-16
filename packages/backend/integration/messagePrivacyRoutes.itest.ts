import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import Fastify, { type InjectOptions } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as dmRules from '../src/dmRules.js';
import * as blockRules from '../src/blockRules.js';
import * as groupRules from '../src/groupRules.js';
import * as scheduleRules from '../src/scheduleRules.js';
import * as strangerRules from '../src/strangerRules.js';
import * as contactRules from '../src/contactRules.js';
import * as privacyRules from '../src/messagePrivacyRules.js';
import * as pushRules from '../src/pushRules.js';
import * as pushCrypto from '../src/pushCrypto.js';
import * as authRules from '../src/authRules.js';
import * as superAdminRules from '../src/superAdminRules.js';
import * as searchRules from '../src/userSearchRules.js';
import * as attachmentRules from '../src/attachmentRules.js';
import * as statusRules from '../src/statusRules.js';
import * as shopRules from '../src/shopRules.js';
import * as callRules from '../src/callRules.js';
import * as seenRules from '../src/lastSeenRules.js';
import * as guestGuardCore from '../src/guestGuardCore.js';
import * as threatRules from '../src/linkThreatsRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = { from: string; to: string };
const direct = 'privacy-direct', origin = 'privacy-origin', group = 'privacy-group', saved = 'privacy-saved';
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { try { await t?.close(); } finally { const { pool } = await import('../src/db/index.js'); await pool.end(); } });
const source = (file: string) => readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function fixture(edit?: Mutation, noHook = false) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['sender', 'recipient', 'other', 'deleted'].map(id => ({ id, username: `privacy_${id}`, displayName: id,
    passwordHash: 'synthetic-only', verified: true, approvedAt: new Date(), messagePrivacy: 'contacts',
    deletedAt: id === 'deleted' ? new Date('2026-01-01T00:00:00Z') : null })));
  await t.db.insert(schema.conversations).values([
    { id: direct, kind: 'direct', directKey: 'recipient:sender' }, { id: origin, kind: 'direct', directKey: 'other:sender' },
    { id: group, kind: 'group', title: 'Synthetic group' }, { id: saved, kind: 'direct', directKey: 'sender:sender' },
  ]);
  await t.db.insert(schema.conversationMembers).values([
    ...['sender', 'recipient'].map(userId => ({ conversationId: direct, userId })),
    ...['sender', 'other'].map(userId => ({ conversationId: origin, userId })),
    ...['sender', 'recipient', 'other'].map(userId => ({ conversationId: group, userId })), { conversationId: saved, userId: 'sender' },
  ]);
  await t.db.insert(schema.conversationMessages).values({ id: 'source-message', conversationId: origin, authorId: 'sender', sortKey: 1, content: 'Synthetic forwarded text' });
  const unexpected: string[] = [], warnings: string[] = [], changed: string[] = [];
  const fail = (path: string) => () => { unexpected.push(path); throw new Error(`неописанная граница R212 routes: ${path}`); };
  const unused = (path: string) => new Proxy({}, { get: (_o, key) => key === '__esModule' ? true : fail(`${path}.${String(key)}`) });
  const events: Array<{ user: string; body: shared.GatewayServerMessage }> = [];
  function load<T>(file: string, deps: Record<string, unknown>): T {
    let raw = source(file);
    if (file === 'routes/conv' && edit) { assert.equal(raw.split(edit.from).length, 2, 'единственный whole-module якорь groupgate'); raw = raw.replace(edit.from, edit.to); }
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
      { module, exports: module.exports, Date, Buffer, Map, Set, Promise, URL, Error,
        console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')), log: fail('console.log'), error: fail('console.error') },
        setTimeout: fail('фоновый таймер'), setInterval: fail('worker'), clearTimeout: fail('снятие таймера'),
        require(id: string) { assert.ok(Object.hasOwn(deps, id), `закрытый импорт ${file}:${id}`); return deps[id]; } });
    return module.exports as T;
  }
  const env = { jwtSecret: 'not-a-secret-used-only-by-integration-tests', ntfy: { baseUrl: null, token: null }, linkThreats: { enabled: false }, economyEnabled: false };
  const common = { 'drizzle-orm': orm, '@gusvoice/shared': shared, './db/index.js': { db: t.db }, './db/schema.js': schema };
  const auth = load<typeof import('../src/auth.js')>('auth', { ...common, bcryptjs: bcrypt, jsonwebtoken: jwt, './authRules.js': authRules,
    './superAdminRules.js': superAdminRules, './env.js': { env } });
  const realtime = { publishToUser: async (user: string, body: shared.GatewayServerMessage) => { events.push({ user, body: normal(body) }); },
    redisPub: { incr: async () => 1, expire: async () => 1, ttl: async () => 10 } };
  const authGuard = load<typeof import('../src/authGuard.js')>('authGuard', { '@gusvoice/shared': shared, './authRules.js': authRules,
    './pushRules.js': pushRules, './realtime.js': realtime, './instanceSetup.js': unused('auth setup'), './mailer.js': unused('mailer') });
  const threats = load<typeof import('../src/linkThreats.js')>('linkThreats', { 'node:fs/promises': fs, './env.js': { env }, './linkThreatsRules.js': threatRules });
  const serialize = load<typeof import('../src/serialize.js')>('serialize', { '@gusvoice/shared': shared, './auth.js': auth, './superAdminRules.js': superAdminRules,
    './env.js': { env }, './statusRules.js': statusRules, './shopRules.js': shopRules, './callRules.js': callRules, './lastSeenRules.js': seenRules,
    './linkThreats.js': threats, './federation/instanceLabels.js': unused('instance labels') });
  const attachmentIO = { DailyQuotaError: class extends Error {}, attachmentStore: unused('attachment storage'), attachmentLink: fail('URL файла'),
    copyForForward: fail('копия файла'), discardForwardCopies: fail('стирание копий'), privateAttachmentsReady: fail('готовность файлов'), purgeDeleted: fail('стирание файлов') };
  const c = load<typeof import('../src/conversations.js')>('conversations', { ...common, './convRules.js': rules, './serialize.js': serialize,
    './env.js': { env }, './util.js': { uuidv7: crypto.randomUUID }, './dmWriteBarrier.js': { dmWriteBarrier: {} }, './attachments.js': attachmentIO, './realtime.js': realtime });
  const privacy = load<typeof import('../src/messagePrivacy.js')>('messagePrivacy', { ...common, './messagePrivacyRules.js': privacyRules, './lastSeenRules.js': seenRules });
  const contacts = load<typeof import('../src/contacts.js')>('contacts', { ...common, './contactRules.js': contactRules, './messagePrivacy.js': privacy });
  const blocks = load<typeof import('../src/blocks.js')>('blocks', common);
  const peers = load<typeof import('../src/db/peerQueries.js')>('db/peerQueries', { 'drizzle-orm': orm, './index.js': { db: t.db } });
  const gateway = { isUserDmPresent: () => false, broadcastUserProfile: async () => {}, broadcastUserStatus: fail('статус пользователя') };
  const lastSeen = load<typeof import('../src/lastSeen.js')>('lastSeen', { ...common, './conversations.js': c, './blocks.js': blocks,
    './db/peerQueries.js': peers, './gateway.js': gateway, './lastSeenRules.js': seenRules });
  const calls = load<typeof import('../src/callPrivacy.js')>('callPrivacy', { ...common, './callRules.js': callRules, './db/peerQueries.js': peers, './lastSeenRules.js': seenRules });
  const guests = load<typeof import('../src/guestGuard.js')>('guestGuard', { ...common, './guestGuardCore.js': guestGuardCore });
  const push = load<typeof import('../src/push.js')>('push', { ...common, './env.js': { env }, './pushRules.js': pushRules, './pushCrypto.js': pushCrypto,
    './util.js': { id: crypto.randomUUID }, './federation/instanceLabels.js': unused('push instance labels'), './permissions.js': unused('channel audience'),
    './pushDefer.js': unused('push defer'), './federation/guestPush.js': unused('guest push') });
  const fanout = load<typeof import('../src/convSendFanout.js')>('convSendFanout', { ...common, './conversations.js': c, './authGuard.js': authGuard,
    './contacts.js': contacts, './contactRules.js': contactRules, './groupRules.js': groupRules, './push.js': push });
  const scheduled = load<typeof import('../src/scheduled.js')>('scheduled', { ...common, './attachments.js': attachmentIO, './blockRules.js': blockRules,
    './conversations.js': c, './convSendFanout.js': fanout, './convRules.js': rules, './scheduleRules.js': scheduleRules, './util.js': { uuidv7: crypto.randomUUID } });
  const routeCommon = { 'drizzle-orm': orm, '@gusvoice/shared': shared, zod: { z }, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const att = load<typeof import('../src/routes/att.js')>('routes/att', { ...routeCommon, '../convRules.js': rules, '../attachmentRules.js': attachmentRules,
    '../attachments.js': attachmentIO, '../authGuard.js': authGuard, '../storage.js': unused('upload storage') });
  const convRoutes = load<typeof import('../src/routes/conv.js')>('routes/conv', { ...routeCommon, '../auth.js': auth, '../authGuard.js': authGuard,
    '../guestGuard.js': guests, './att.js': att, '../stickerCatalog.js': unused('stickers'), '../blockRules.js': blockRules, '../blocks.js': blocks,
    '../conversations.js': c, '../convSendFanout.js': fanout, '../convPolls.js': unused('polls'), '../dmReports.js': unused('DM reports'),
    '../strangerRules.js': strangerRules, '../scheduled.js': scheduled, '../scheduleRules.js': scheduleRules, '../convRules.js': rules,
    '../contacts.js': contacts, '../contactRules.js': contactRules, '../realtime.js': realtime, './dmFolders.js': unused('folders'),
    '../db/peerQueries.js': peers, '../lastSeen.js': lastSeen, '../dmRules.js': dmRules, '../instanceSetup.js': unused('DM policy'),
    '../userSearchRules.js': searchRules, '../push.js': push, '../superAdminRules.js': superAdminRules });
  if (!noHook) convRoutes.configureMessagePrivacy({ allowed: privacy.messageAllowedFor, wrote: privacy.wroteInDirect });
  const usersRoutes = load<typeof import('../src/routes/users.js')>('routes/users', { ...routeCommon, '../activity.js': unused('activity'),
    '../auth.js': auth, '../authGuard.js': authGuard, '../guestGuard.js': guests, '../db/userSearch.js': unused('user search'),
    '../userSearchRules.js': searchRules, '../gateway.js': gateway, '../federation/directoryEvents.js': { announceUser: async () => {} },
    '../federation/remoteUserSearch.js': unused('remote search'), '../permissions.js': unused('voice visibility'), '../realtime.js': realtime,
    '../serialize.js': serialize, '../lastSeen.js': lastSeen, '../lastSeenRules.js': seenRules, '../callPrivacy.js': calls,
    '../contacts.js': contacts, '../storage.js': unused('avatar storage'), '../shopRules.js': shopRules });
  usersRoutes.configureMessagePrivacyChanged(userId => changed.push(userId));
  const app = Fastify(); await app.register(convRoutes.convRoutes); await app.register(usersRoutes.userRoutes); await app.ready();
  const clean = async () => {
    for (let i = 0; i < 12; i++) { await new Promise<void>(resolve => setImmediate(resolve)); await t.raw.query('SELECT 1'); }
    assert.deepEqual(unexpected, [], 'неожиданные ветки не скрыты фоновым catch'); assert.deepEqual(warnings, [], 'нет скрытых предупреждений');
  };
  const request = async (user: string, method: InjectOptions['method'], url: string, payload?: InjectOptions['payload']) => {
    const r = await app.inject({ method, url, headers: { authorization: `Bearer ${auth.signToken({ sub: user, username: `privacy_${user}`, gen: 0 })}` },
      ...(payload === undefined ? {} : { payload }) }); await clean(); return r;
  };
  return { app, request, clean, c, privacy, events, changed };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function run(body: (f: Fixture) => Promise<void>, edit?: Mutation, noHook = false) {
  const f = await fixture(edit, noHook); try { await body(f); } finally { try { await f.clean(); } finally { await f.app.close(); } }
}
const send = (f: Fixture, cid = direct) => f.request('sender', 'POST', `/conv/${cid}/messages`, { clientId: crypto.randomUUID(), content: 'Synthetic message' });
const forward = (f: Fixture, cid = direct) => f.request('sender', 'POST', `/conv/${cid}/forward`, { clientId: crypto.randomUUID(), fromConversationId: origin, messageIds: ['source-message'] });
const schedule = (f: Fixture, cid = direct) => f.request('sender', 'POST', `/conv/${cid}/scheduled`, { clientId: crypto.randomUUID(), content: 'Synthetic scheduled message', sendAt: new Date(Date.now() + 3600_000).toISOString() });
const policy = (f: Fixture, value: 'everyone' | 'contacts') => f.request('recipient', 'PATCH', '/users/me', { messagePrivacy: value });
async function journalState() { return normal({ messages: await t.db.select().from(schema.conversationMessages),
  scheduled: await t.db.select().from(schema.conversationScheduled), changes: await t.db.select().from(schema.userChanges), sync: await t.db.select().from(schema.userSync) }); }

async function written(f: Fixture, cid: string, message: shared.ConvMessage, content: string) {
  // Один status201 не доказывает отправку: проверяем отдельную SQL-строку и адресный журнал/события её участников.
  assert.equal(typeof message?.id, 'string', 'ответ успешной отправки содержит id сообщения');
  const rows = await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, message.id));
  assert.equal(rows.length, 1, 'HTTP 201 соответствует одному зафиксированному сообщению');
  const row = rows[0];
  assert.equal(row.conversationId, cid); assert.equal(row.authorId, 'sender'); assert.equal(row.content, content);
  assert.equal(row.withheld, false); assert.equal(row.deletedAt, null);
  const audience = (cid === group ? ['sender', 'recipient', 'other'] : cid === saved ? ['sender'] : ['sender', 'recipient']).sort();
  const journal = await t.db.select().from(schema.userChanges).where(orm.and(
    orm.eq(schema.userChanges.messageId, message.id), orm.eq(schema.userChanges.kind, 'msg')));
  assert.deepEqual(journal.map(r => r.userId).sort(), audience, 'успех записан ровно в журнал каждого ожидаемого участника');
  assert.equal(journal.every(r => r.conversationId === cid), true, 'журнал адресован беседе успешной операции');
  const events = f.events.filter(e => e.body.t === 'conv.change' && e.body.message?.id === message.id);
  assert.deepEqual(events.map(e => e.user).sort(), audience, 'успешная запись доставлена conv.change каждому ожидаемому участнику');
  for (const event of events) {
    assert.ok(event.body.t === 'conv.change' && event.body.message && !('gone' in event.body.message));
    assert.equal(event.body.conversation.id, cid); assert.equal(event.body.message.content, content);
    assert.equal(event.body.pts, Number(journal.find(r => r.userId === event.user)!.pts), 'событие несёт pts реальной строки журнала');
  }
  return row;
}
async function sent(f: Fixture, cid = direct) {
  const r = await send(f, cid); assert.equal(r.statusCode, 201, r.body);
  await written(f, cid, r.json<shared.ConvMessage>(), 'Synthetic message');
}
async function forwarded(f: Fixture, cid = direct) {
  const r = await forward(f, cid); assert.equal(r.statusCode, 201, r.body);
  const messages = r.json<{ messages: shared.ConvMessage[] }>().messages;
  assert.equal(messages.length, 1, 'пересылка возвращает одну новую копию'); assert.notEqual(messages[0].id, 'source-message');
  const row = await written(f, cid, messages[0], 'Synthetic forwarded text');
  assert.equal(row.forwardedFrom?.userId, 'sender', 'SQL-копия сохраняет автора пересланного оригинала');
}
async function staged(f: Fixture, cid = direct) {
  const r = await schedule(f, cid); assert.equal(r.statusCode, 201, r.body);
  const id = r.json<shared.ConvScheduledResponse>().items[0].id;
  const rows = await t.db.select().from(schema.conversationScheduled).where(orm.eq(schema.conversationScheduled.id, id));
  assert.equal(rows.length, 1, 'создание отложенного зафиксировало SQL-строку');
  assert.equal(rows[0].conversationId, cid); assert.equal(rows[0].authorId, 'sender'); assert.equal(rows[0].content, 'Synthetic scheduled message');
  return id;
}
async function sentNow(f: Fixture, cid: string, id: string) {
  const [before] = await t.db.select().from(schema.conversationScheduled).where(orm.eq(schema.conversationScheduled.id, id));
  assert.ok(before, 'до отправить сейчас есть настоящее отложенное');
  const r = await f.request('sender', 'POST', `/conv/${cid}/scheduled/${id}/send`); assert.equal(r.statusCode, 201, r.body);
  const out = r.json<{ message: shared.ConvMessage; items: shared.ConvScheduled[] }>();
  const message = await written(f, cid, out.message, 'Synthetic scheduled message');
  assert.equal(message.clientId, before.clientId, 'обычная SQL-отправка сохраняет clientId отложенного');
  assert.equal((await t.db.select().from(schema.conversationScheduled).where(orm.eq(schema.conversationScheduled.id, id))).length, 0,
    'отправленное отложенное удалено из SQL той же операцией');
  assert.equal(out.items.some(item => item.id === id), false, 'ответ тоже убрал отправленное из списка');
}

test('R212 HTTP запрещает отправку, пересылку, создание отложенного и отправить сейчас без частичной записи', async () => {
  await run(async f => {
    assert.equal((await policy(f, 'everyone')).statusCode, 200);
    const id = await staged(f);
    assert.equal((await policy(f, 'contacts')).statusCode, 200);
    const before = await journalState(), n = f.events.length;
    for (const r of [await send(f), await forward(f), await schedule(f), await f.request('sender', 'POST', `/conv/${direct}/scheduled/${id}/send`)]) {
      assert.equal(r.statusCode, 403, r.body); assert.equal(r.json().error, shared.MESSAGE_PRIVACY_ERROR);
    }
    assert.deepEqual(await journalState(), before, 'отказ не вставляет сообщение, не снимает отложенное и не растит pts');
    assert.equal(f.events.length, n, 'отказ не отправляет conv.change');
    assert.equal((await policy(f, 'everyone')).statusCode, 200);
    await sent(f); await forwarded(f); await sentNow(f, direct, id);
  });
});
async function exemptions(edit?: Mutation) {
  await run(async f => {
    assert.equal(await f.privacy.messageAllowedFor('sender', 'recipient'), false, 'контраст: для 1:1 получатель запретил отправителя');
    for (const cid of [group, saved]) {
      await sent(f, cid); await forwarded(f, cid);
      const id = await staged(f, cid); await sentNow(f, cid, id);
    }
  }, edit);
}
test('R212 личная политика контактов не режет группу и Избранное во всех четырёх операциях', async () => { await exemptions(); });
test('R212 last-seen показывает canMessage false, собственный контакт получателя или everyone открывает true', async () => {
  await run(async f => {
    const path = '/users/recipient/last-seen';
    const before = await f.request('sender', 'GET', path); assert.equal(before.statusCode, 200); assert.equal(before.json().canMessage, false);
    await t.db.insert(schema.userContacts).values({ ownerId: 'sender', contactId: 'recipient' });
    assert.equal((await f.request('sender', 'GET', path)).json().canMessage, false, 'обратный контакт не меняет canMessage');
    await t.db.insert(schema.userContacts).values({ ownerId: 'recipient', contactId: 'sender' });
    assert.equal((await f.request('sender', 'GET', path)).json().canMessage, true);
    await sent(f);
    assert.equal(Object.hasOwn((await f.request('recipient', 'GET', path)).json(), 'canMessage'), false, 'своему профилю поле отказа не добавляется');
    assert.equal((await f.request('sender', 'GET', '/users/deleted/last-seen')).statusCode, 404);
  });
});
test('R212 PUT/GET исключений HTTP очищает себя, неизвестных, удалённых и дубли и сохраняет другие ключи', async () => {
  await run(async f => {
    await t.db.insert(schema.privacyExceptions).values({ ownerId: 'recipient', targetId: 'sender', key: 'calls', kind: 'always' });
    const r = await f.request('recipient', 'PUT', '/users/me/message-exceptions', { always: ['recipient', 'unknown', 'deleted', 'other', 'sender', 'other'], never: ['sender'] });
    assert.equal(r.statusCode, 200, r.body); assert.deepEqual(r.json().always.map((p: { id: string }) => p.id), ['other', 'sender']); assert.deepEqual(r.json().never, []);
    assert.deepEqual((await f.request('recipient', 'GET', '/users/me/message-exceptions')).json(), r.json());
    assert.equal((await f.request('sender', 'GET', '/users/recipient/last-seen')).json().canMessage, true);
    await sent(f);
    assert.deepEqual(f.changed, ['recipient'], 'изменение исключения уведомляет крючок после записи');
    await f.request('recipient', 'PUT', '/users/me/message-exceptions', { always: [] });
    assert.equal((await send(f)).statusCode, 403, 'удаление исключения снова закрывает переписку');
    assert.deepEqual((await t.db.select().from(schema.privacyExceptions)).map(p => [p.key, p.targetId]), [['calls', 'sender']]);
  });
});
test('R212 PATCH собственной политики сохраняет значение и объявляет изменение', async () => {
  await run(async f => {
    const r = await policy(f, 'everyone'); assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().messagePrivacy, 'everyone');
    assert.deepEqual(f.changed, ['recipient']);
    assert.equal((await t.db.select().from(schema.users).where(orm.eq(schema.users.id, 'recipient')))[0].messagePrivacy, 'everyone');
    assert.equal((await f.request('sender', 'GET', '/users/recipient/last-seen')).json().canMessage, true);
  });
});
test('R212 настоящее живое сообщение получателя открывает ответ через HTTP без контактов', async () => {
  await run(async f => {
    await t.db.insert(schema.conversationMessages).values({ id: 'recipient-first', conversationId: direct, authorId: 'recipient', sortKey: 2, content: 'Synthetic first message' });
    assert.equal((await f.request('sender', 'GET', '/users/recipient/last-seen')).json().canMessage, true);
    await sent(f);
  });
});
test('R212 без подключения крючка convRoutes сохраняет прежнюю разрешённую отправку', async () => {
  await run(async f => { await sent(f); }, undefined, true);
});
test('R212 одиночный groupgate-мутант эквивалентен: реальный loadAccess даёт группе peerId=null', async () => {
  await exemptions();
  const raw = source('routes/conv'), ast = ts.createSourceFile('conv.ts', raw, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === 'messagePrivacyRefused');
  assert.equal(fn.length, 1); const from = fn[0].getText(ast), guard = " || access.kind === 'group'";
  assert.equal(from.split(guard).length, 2);
  // Не фабрикуем peerId у группы: дублирующий !access.peerId ещё защищает все реальные маршруты.
  await exemptions({ from, to: from.replace(guard, '') });
});
