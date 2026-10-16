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
import * as threatRules from '../src/linkThreatsRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = { file: string; from: string; to: string };
type Message = shared.ConvMessage;
type Event = { user: string; body: shared.GatewayServerMessage };
const self = 'a'.repeat(32), peer = 'b'.repeat(32);
const sourceId = 'live-source', targetId = 'live-target', remoteId = 'live-remote', hostId = 'live-foreign-host', remoteDmId = 'live-remote-dm';
const features = [shared.FED_FEATURES.dm1, shared.FED_FEATURES.dmgroup1, shared.FED_FEATURES.dmmedia1];
let t: TestDb, clock = Date.now();
class TestDate extends Date { static override now() { return clock; } }
before(async () => { t = await createTestDb(); });
after(async () => { try { await t?.close(); } finally { const { pool } = await import('../src/db/index.js'); await pool.end(); } });
const source = (file: string) => readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const killed = (prefix: string, actual: unknown, expected: unknown) => (e: unknown) => {
  if (!(e instanceof assert.AssertionError) || e.code !== 'ERR_ASSERTION' || !e.message.startsWith(prefix) || e.operator !== 'strictEqual') return false;
  assert.equal(e.actual, actual, 'точный известный неправильный результат');
  assert.equal(e.expected, expected, 'точный контракт, нарушенный контрфактом');
  return true;
};
function mutation(file: string, from: string, to: string, fn?: string): Mutation {
  const raw = source(file); let body = raw;
  if (fn) {
    const ast = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
    const found = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === fn);
    assert.equal(found.length, 1, `адресная функция ${fn}`); body = found[0].getText(ast);
  }
  assert.equal(body.split(from).length, 2, `один смысловой якорь ${file}:${fn ?? 'module'}`);
  return { file, from: body, to: body.replace(from, to) };
}

async function fixture(edit?: Mutation) {
  clock = Date.now();
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    ...['author', 'voter-a', 'voter-b', 'outsider'].map(id => ({ id, username: `live_${id}`, displayName: id,
      passwordHash: 'synthetic-only', verified: true, approvedAt: new Date() })),
    { id: 'shadow', username: 'live_shadow', displayName: 'Сосед', passwordHash: 'synthetic-only', homeInstanceId: peer, homeUserId: 'peer-person' },
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'poll.invalid', apiBase: 'https://poll.invalid/api',
    clientOrigin: 'https://poll.invalid', rootKey: 'synthetic-not-a-key', state: 'active', features });
  await t.db.insert(schema.conversations).values([
    { id: sourceId, kind: 'direct', directKey: 'author:voter-a', createdBy: 'author' },
    { id: targetId, kind: 'group', title: 'Пересылка', createdBy: 'author' },
    { id: remoteId, kind: 'group', title: 'Смешанная группа', createdBy: 'author' },
    { id: hostId, kind: 'group', title: 'Чужой хост', createdBy: 'author', originInstanceId: peer },
    { id: remoteDmId, kind: 'direct', directKey: 'author:shadow', createdBy: 'author' },
  ]);
  await t.db.insert(schema.conversationMembers).values([
    ...['author', 'voter-a'].map(userId => ({ conversationId: sourceId, userId })),
    ...['author', 'voter-a'].flatMap(userId => [targetId, remoteId, hostId].map(conversationId => ({ conversationId, userId }))),
    { conversationId: remoteId, userId: 'shadow' },
    ...['author', 'shadow'].map(userId => ({ conversationId: remoteDmId, userId })),
  ]);
  const unexpected: string[] = [], warnings: string[] = [], events: Event[] = [], pushes: unknown[][] = [];
  const fail = (path: string) => () => { unexpected.push(path); throw new Error(`неописанная граница R225: ${path}`); };
  const unused = (path: string) => new Proxy({}, { get: (_o, key) => key === '__esModule' ? true : fail(`${path}.${String(key)}`) });
  function load<T>(file: string, deps: Record<string, unknown>): T {
    let raw = source(file);
    if (edit?.file === file) { assert.equal(raw.split(edit.from).length, 2, `единственный whole-module якорь ${file}`); raw = raw.replace(edit.from, edit.to); }
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
      module, exports: module.exports, Date: TestDate, Map, Set, Promise, Buffer, URL, Error, crypto,
      console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')), log: fail('console.log'), error: fail('console.error') },
      setTimeout: fail('фоновый таймер'), setInterval: fail('фоновый worker'),
      require(id: string) { assert.ok(Object.hasOwn(deps, id), `закрытый импорт ${file}:${id}`); return deps[id]; },
    });
    return module.exports as T;
  }
  const env = { jwtSecret: 'not-a-secret-used-only-by-integration-tests', ntfy: { baseUrl: null, token: null }, linkThreats: { enabled: false } };
  const common = { 'drizzle-orm': orm, '@gusvoice/shared': shared, './db/index.js': { db: t.db }, './db/schema.js': schema };
  const auth = load<typeof import('../src/auth.js')>('auth', { ...common, bcryptjs: bcrypt, jsonwebtoken: jwt,
    './authRules.js': authRules, './superAdminRules.js': superAdminRules, './env.js': { env } });
  const realtime = { publishToUser: async (user: string, body: shared.GatewayServerMessage) => { events.push({ user, body: normal(body) }); },
    redisPub: { incr: async () => 1, expire: async () => 1, ttl: async () => 10 } };
  const guard = load<typeof import('../src/authGuard.js')>('authGuard', { '@gusvoice/shared': shared, './authRules.js': authRules,
    './pushRules.js': pushRules, './realtime.js': realtime, './instanceSetup.js': unused('auth setup'), './mailer.js': unused('mailer') });
  const threats = load<typeof import('../src/linkThreats.js')>('linkThreats', { 'node:fs/promises': fs, './env.js': { env }, './linkThreatsRules.js': threatRules });
  const serialize = load<typeof import('../src/serialize.js')>('serialize', { '@gusvoice/shared': shared, './auth.js': auth,
    './superAdminRules.js': superAdminRules, './env.js': { env }, './statusRules.js': statusRules, './shopRules.js': shopRules,
    './callRules.js': callRules, './lastSeenRules.js': seenRules, './linkThreats.js': threats,
    './federation/instanceLabels.js': { instanceLabel: (instanceId: string) => ({ instanceId, name: 'Сосед', domain: 'poll.invalid', reports: false }) } });
  const attachmentIO = { ...unused('attachments'), DailyQuotaError: class extends Error {}, attachmentStore: unused('attachmentStore'),
    attachmentLink: fail('URL вложения'), copyForForward: fail('копия вложения'), discardForwardCopies: fail('отброс копии'),
    privateAttachmentsReady: fail('готовность вложений'), purgeDeleted: fail('стирание вложения') };
  const c = load<typeof import('../src/conversations.js')>('conversations', { ...common, './convRules.js': rules,
    './serialize.js': serialize, './env.js': { env }, './util.js': { uuidv7: crypto.randomUUID }, './dmWriteBarrier.js': { dmWriteBarrier: {} },
    './attachments.js': attachmentIO, './realtime.js': realtime });
  const fed = { 'drizzle-orm': orm, '@gusvoice/shared': shared, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const changes = load<typeof import('../src/federation/convChanges.js')>('federation/convChanges', fed);
  c.configureFederatedConv({ selfInstanceId: () => self, record: changes.recordFedConvChanges });
  const polls = load<typeof import('../src/convPolls.js')>('convPolls', { ...common, './conversations.js': c, './convRules.js': rules });
  const blocks = load<typeof import('../src/blocks.js')>('blocks', common);
  const contacts = load<typeof import('../src/contacts.js')>('contacts', { ...common, './contactRules.js': contactRules });
  const rawPush = load<typeof import('../src/push.js')>('push', { ...common, './env.js': { env }, './pushRules.js': pushRules,
    './pushCrypto.js': pushCrypto, './util.js': { id: crypto.randomUUID }, './federation/instanceLabels.js': unused('push instance labels'),
    './permissions.js': unused('channel audience'), './pushDefer.js': unused('push defer'), './federation/guestPush.js': unused('guest push') });
  const push = { ...rawPush, sendPushToUsers: async (...args: Parameters<typeof rawPush.sendPushToUsers>) => { pushes.push(normal(args)); return rawPush.sendPushToUsers(...args); } };
  const live = load<typeof import('../src/convGeoLives.js')>('convGeoLives', { ...common, './conversations.js': c, './convRules.js': rules, './push.js': push });
  const fanout = load<typeof import('../src/convSendFanout.js')>('convSendFanout', { ...common, './conversations.js': c, './authGuard.js': guard,
    './contacts.js': contacts, './contactRules.js': contactRules, './groupRules.js': groupRules, './push.js': push });
  const att = load<typeof import('../src/routes/att.js')>('routes/att', { ...fed, zod: { z }, '../convRules.js': rules,
    '../attachmentRules.js': attachmentRules, '../attachments.js': attachmentIO, '../authGuard.js': guard, '../storage.js': unused('upload storage') });
  const routes = load<typeof import('../src/routes/conv.js')>('routes/conv', { ...fed, zod: { z }, '../auth.js': auth,
    '../authGuard.js': guard, '../guestGuard.js': unused('guest guard'), './att.js': att, '../stickerCatalog.js': unused('sticker catalog'),
    '../blockRules.js': blockRules, '../blocks.js': blocks, '../conversations.js': c, '../convSendFanout.js': fanout, '../convPolls.js': polls, '../convGeoLives.js': live,
    '../dmReports.js': unused('DM reports'), '../strangerRules.js': strangerRules, '../scheduled.js': unused('scheduled'), '../scheduleRules.js': scheduleRules,
    '../convRules.js': rules, '../contacts.js': contacts, '../contactRules.js': contactRules, '../realtime.js': realtime,
    './dmFolders.js': unused('DM folders'), '../db/peerQueries.js': unused('shared server'), '../lastSeen.js': unused('last seen'),
    '../dmRules.js': dmRules, '../instanceSetup.js': unused('DM policy'), '../userSearchRules.js': searchRules, '../push.js': push, '../superAdminRules.js': superAdminRules });
  const app = Fastify(); await app.register(routes.convRoutes); await app.ready();
  const drain = async () => {
    for (let i = 0; i < 12; i++) { await new Promise<void>(resolve => setImmediate(resolve)); await t.raw.query('SELECT 1'); }
    assert.deepEqual(unexpected, [], 'фон не проглотил неописанную зависимость');
    assert.deepEqual(warnings, [], 'ошибки SQL/доставки не скрыты предупреждениями');
  };
  const request = async (user: string, method: InjectOptions['method'], url: string, payload?: InjectOptions['payload']) => {
    const reply = await app.inject({ method, url, headers: { authorization: `Bearer ${auth.signToken({ sub: user, username: `live_${user}`, gen: 0 })}` }, ...(payload === undefined ? {} : { payload }) });
    await drain(); return reply;
  };
  return { app, c, changes, request, events, pushes, drain };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function run(body: (f: Fixture) => Promise<void>, edit?: Mutation) {
  const f = await fixture(edit); try { await body(f); } finally { try { await f.drain(); } finally { await f.app.close(); } }
}

const input = (extra: Partial<shared.ConvGeoLiveInput> = {}): shared.ConvGeoLiveInput => ({ kind: 'geolive', lat: 55.75, lon: 37.6,
  period: 900, accuracy: 8, heading: 20, ...extra });
async function create(f: Fixture, conversationId = sourceId) {
  const r = await f.request('author', 'POST', `/conv/${conversationId}/messages`, { clientId: crypto.randomUUID(), media: input() });
  assert.equal(r.statusCode, 201, r.body); return r.json<Message>();
}
const point = { lat: 55.751, lon: 37.602, accuracy: 4, heading: 180 };
const update = (f: Fixture, id: string, who = 'author', p = point, conversationId = sourceId) =>
  f.request(who, 'POST', `/conv/${conversationId}/messages/${id}/live`, p);
const stop = (f: Fixture, id: string, who = 'author') => f.request(who, 'POST', `/conv/${sourceId}/messages/${id}/live/stop`);
const media = (m: Message): shared.ConvGeoLiveMedia => { assert.equal(m.media?.kind, 'geolive'); return m.media as shared.ConvGeoLiveMedia; };
const row = async (id: string) => (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, id)))[0];
const journalRows = async (id: string) => (await t.db.select().from(schema.userChanges).where(orm.eq(schema.userChanges.messageId, id))).map(r => `${r.userId}:${r.kind}`).sort();
async function clearJournal(f: Fixture) { f.events.length = 0; f.pushes.length = 0; await t.db.delete(schema.userChanges); }

test('R225 отправка трансляции сохраняет вид и запасную первую точку, а провода для соседей нет', async () => {
  await run(async f => {
    const m = await create(f), stored = await row(m.id), p = media(m);
    assert.equal(p.startedAt, clock); assert.equal(p.until, clock + 900_000); assert.equal(p.updatedAt, clock);
    assert.equal(stored.content, shared.convGeoLiveFallback(p)); assert.equal(stored.noPreview, true);
    assert.equal(shared.convMediaToWire(p, self), null);
    assert.equal(shared.convMediaPreview(p), 'Геопозиция в реальном времени');
  });
});
test('R225 тень соседа, чужой хост и 1:1 соседа запрещают трансляцию одним reason, местная пара принимает', async () => {
  await run(async f => {
    for (const id of [remoteId, hostId, remoteDmId]) {
      const r = await f.request('author', 'POST', `/conv/${id}/messages`, { clientId: crypto.randomUUID(), media: input() });
      assert.equal(r.statusCode, 403); assert.equal(r.json().reason, shared.CONV_GEOLIVE_FEDERATED_ERROR);
    }
    assert.equal((await t.db.select().from(schema.conversationMessages)).length, 0);
    await create(f);
  });
});
async function authorUpdate(edit?: Mutation) {
  await run(async f => {
    const m = await create(f); clock += 3000; await clearJournal(f);
    const foreign = await update(f, m.id, 'voter-a'); assert.equal(foreign.statusCode, 403, 'чужой не обновляет трансляцию');
    assert.equal((await row(m.id)).media?.kind === 'geolive' && ((await row(m.id)).media as shared.ConvGeoLiveMedia).lat, input().lat);
    assert.deepEqual(await journalRows(m.id), []);
    assert.equal((await update(f, m.id)).statusCode, 200, 'автор обновляет свою трансляцию');
  }, edit);
}
test('R225 обновить точку может автор, чужой участник получает 403 без SQL-изменения', () => authorUpdate());
async function authorStop(edit?: Mutation) {
  await run(async f => {
    const m = await create(f); await clearJournal(f);
    assert.equal((await stop(f, m.id, 'voter-a')).statusCode, 403, 'чужой не останавливает трансляцию');
    assert.equal(((await row(m.id)).media as shared.ConvGeoLiveMedia).stopped, false);
    assert.deepEqual(await journalRows(m.id), []);
    assert.equal((await stop(f, m.id)).statusCode, 200);
    assert.equal(((await row(m.id)).media as shared.ConvGeoLiveMedia).stopped, true);
    await clearJournal(f); assert.equal((await stop(f, m.id)).statusCode, 200);
    assert.deepEqual(await journalRows(m.id), [], 'повтор остановки без новой строки');
    clock += 3000; assert.equal((await update(f, m.id)).statusCode, 403, 'остановленная трансляция не обновляется');
  }, edit);
}
test('R225 остановить может только автор, остановка монотонна и повтор не создаёт события', () => authorStop());
test('R225 expiry на границе until запрещает новую точку и на чтении отдаёт stopped без изменения базы', async () => {
  await run(async f => {
    const m = await create(f), p = media(m); clock = p.until - 1;
    assert.equal((await update(f, m.id)).statusCode, 200, 'последняя миллисекунда ещё живая');
    clock = p.until; await clearJournal(f);
    assert.equal((await update(f, m.id)).statusCode, 403, 'ровно until уже запрещает точку');
    const view = await f.c.messageFor(m.id, 'voter-a'); assert.ok(view && !('gone' in view));
    assert.equal(media(view).stopped, true);
    assert.equal(((await row(m.id)).media as shared.ConvGeoLiveMedia).stopped, false, 'истечение не записывается фоновым worker');
    assert.equal((await stop(f, m.id)).statusCode, 200); assert.deepEqual(await journalRows(m.id), [], 'истёкшая остановка без события');
  });
});
test('R225 2999 мс дают 200 без записи и события, ровно 3000 мс записывают следующую точку', async () => {
  await run(async f => {
    const m = await create(f), before = normal(await row(m.id)); await clearJournal(f);
    clock += 2999; const early = await update(f, m.id); assert.equal(early.statusCode, 200);
    assert.deepEqual(normal(await row(m.id)), before); assert.deepEqual(await journalRows(m.id), []); assert.equal(f.events.length, 0); assert.equal(f.pushes.length, 0);
    clock++; const accepted = await update(f, m.id); assert.equal(accepted.statusCode, 200);
    assert.equal(media(accepted.json<Message>()).lat, point.lat); assert.equal(media(accepted.json<Message>()).updatedAt, clock);
    assert.deepEqual(await journalRows(m.id), ['author:msg', 'voter-a:msg']);
  });
});
async function editedJournal(edit?: Mutation, stopInstead = false) {
  await run(async f => {
    const m = await create(f), before = await row(m.id); await clearJournal(f); clock += 3000;
    const r = stopInstead ? await stop(f, m.id) : await update(f, m.id); assert.equal(r.statusCode, 200, r.body);
    const after = await row(m.id);
    assert.equal(after.editedAt, null, 'обновление геопозиции не ставит editedAt');
    assert.equal(after.sortKey, before.sortKey, 'обновление не меняет место сообщения');
    assert.equal(after.content, before.content, 'запасной текст остаётся первой точкой');
    if (f.pushes.length) assert.equal(JSON.stringify(f.pushes[0][0]), '["voter-a"]', 'наблюдаемая попытка пуша адресована настоящему получателю');
    assert.equal(f.pushes.length, 0, 'обновление геопозиции не вызывает пуш');
    assert.deepEqual(await journalRows(m.id), ['author:msg', 'voter-a:msg']);
    const events = f.events.filter(e => e.body.t === 'conv.change' && e.body.message?.id === m.id);
    assert.deepEqual(events.map(e => e.user).sort(), ['author', 'voter-a']);
    for (const e of events) {
      const event = e.body as Extract<shared.GatewayServerMessage, { t: 'conv.change' }>;
      assert.ok(event.message && !('gone' in event.message));
      assert.equal(media(event.message).stopped, stopInstead);
      assert.equal(media(event.message).lat, stopInstead ? input().lat : point.lat);
    }
    for (const user of ['author', 'voter-a']) {
      const sync = await f.request(user, 'GET', '/conv/sync?pts=0&groups=1'); assert.equal(sync.statusCode, 200, sync.body);
      const page = sync.json<shared.ConvSyncResponse>(); assert.ok('messages' in page);
      const change = page.messages.find(message => message.id === m.id);
      assert.ok(change && !('gone' in change));
      assert.equal(media(change).stopped, stopInstead);
    }
  }, edit);
}
test('R225 update и stop журналируются обоим и доставляются без editedAt, смены sortKey и пуша', async () => {
  await editedJournal(); await editedJournal(undefined, true);
});
test('R225 пересылка активной трансляции даёт статичную последнюю geo, а правка трансляции запрещена', async () => {
  await run(async f => {
    const m = await create(f); clock += 3000; assert.equal((await update(f, m.id)).statusCode, 200);
    assert.equal((await f.request('author', 'PATCH', `/conv/${sourceId}/messages/${m.id}`, { content: 'Изменить' })).statusCode, 403);
    const r = await f.request('author', 'POST', `/conv/${targetId}/forward`, { clientId: crypto.randomUUID(), fromConversationId: sourceId, messageIds: [m.id] });
    assert.equal(r.statusCode, 201, r.body); const copy = r.json<{ messages: Message[] }>().messages[0];
    assert.deepEqual(copy.media, { kind: 'geo', lat: point.lat, lon: point.lon, accuracy: point.accuracy });
    assert.equal(shared.convMediaToWire(copy.media!, self)?.kind, 'geo', 'статичную пересылку сосед уже понимает');
    assert.equal(((await row(m.id)).media as shared.ConvGeoLiveMedia).stopped, false, 'пересылка не останавливает источник');
  });
});
test('R225 неизвестное, удалённое и обычное сообщение не принимают update/stop, посторонний также получает 404', async () => {
  await run(async f => {
    const m = await create(f);
    assert.equal((await update(f, m.id, 'outsider')).statusCode, 404);
    assert.equal((await stop(f, 'missing')).statusCode, 404);
    const r = await f.request('author', 'POST', `/conv/${sourceId}/messages`, { clientId: crypto.randomUUID(), content: 'Текст' }); assert.equal(r.statusCode, 201);
    assert.equal((await update(f, r.json<Message>().id)).statusCode, 404);
    assert.equal((await stop(f, r.json<Message>().id)).statusCode, 404);
    assert.equal((await f.request('author', 'DELETE', `/conv/${sourceId}/messages/${m.id}?for=both`)).statusCode, 204);
    assert.equal((await update(f, m.id)).statusCode, 404); assert.equal((await stop(f, m.id)).statusCode, 404);
  });
});
test('R225 контрфакт: снят автор update — чужой получает 200', async () => {
  await authorUpdate();
  await assert.rejects(() => authorUpdate(mutation('convGeoLives', "if (p.authorId !== me) return { kind: 'refused', code: 403, error: 'точку обновляет только автор' };", '', 'updateConvGeoLive')),
    killed('чужой не обновляет трансляцию', 200, 403));
});
test('R225 контрфакт: снят автор stop — чужой получает 200', async () => {
  await authorStop();
  await assert.rejects(() => authorStop(mutation('convGeoLives', "if (p.authorId !== me) return { kind: 'refused', code: 403, error: 'остановить трансляцию может только автор' };", '', 'stopConvGeoLive')),
    killed('чужой не останавливает трансляцию', 200, 403));
});
test('R225 контрфакт: update ставит editedAt — геопозиция получает ложную правку', async () => {
  await editedJournal();
  const edit = mutation('convGeoLives', '.set({ media: res.media })', '.set({ media: res.media, editedAt: new Date(now) })', 'updateConvGeoLive');
  // Фикстура заново берёт Date.now, поэтому сравниваем известный вид результата, не часы между двумя прогонами.
  const scenario = async (m?: Mutation) => run(async f => {
    const message = await create(f); clock += 3000; await update(f, message.id);
    assert.equal((await row(message.id)).editedAt !== null, false, 'у геопозиции отсутствует editedAt');
  }, m);
  await scenario(); await assert.rejects(() => scenario(edit), killed('у геопозиции отсутствует editedAt', true, false));
});
test('R225 контрфакт: update вызывает настоящий sendPushToUsers — запрет пуша ловится наблюдаемой границей', async () => {
  await editedJournal();
  const raw = source('convGeoLives'), anchor = "import { eq } from 'drizzle-orm';";
  const action = mutation('convGeoLives', 'return db.transaction(async (tx): Promise<ConvGeoLiveActResult> => {',
    'const result = await db.transaction(async (tx): Promise<ConvGeoLiveActResult> => {', 'updateConvGeoLive');
  const end = '  });\n}'; assert.equal(action.to.split(end).length, 2, 'единственный конец настоящего update');
  // Настоящий push читает получателя после фиксации: PGlite не допускает root-db чтение внутри своего tx-замка.
  const to = action.to.replace(end, "  });\n  await sendPushToUsers(['voter-a'], { type: 'dm', title: 'Synthetic', body: 'Synthetic' });\n  return result;\n}");
  assert.equal(raw.split(anchor).length, 2); assert.equal(raw.split(action.from).length, 2);
  const edit = { file: 'convGeoLives', from: raw, to: raw.replace(action.from, to).replace(anchor, `${anchor}\nimport { sendPushToUsers } from './push.js';`) };
  await assert.rejects(() => editedJournal(edit), killed('обновление геопозиции не вызывает пуш', 1, 0));
});

