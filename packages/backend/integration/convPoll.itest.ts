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
const sourceId = 'poll-source', targetId = 'poll-target', remoteId = 'poll-remote', hostId = 'poll-foreign-host', remoteDmId = 'poll-remote-dm';
const features = [shared.FED_FEATURES.dm1, shared.FED_FEATURES.dmgroup1, shared.FED_FEATURES.dmmedia1];
let t: TestDb;
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
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    ...['author', 'voter-a', 'voter-b', 'outsider'].map(id => ({ id, username: `poll_${id}`, displayName: id,
      passwordHash: 'synthetic-only', verified: true, approvedAt: new Date() })),
    { id: 'shadow', username: 'poll_shadow', displayName: 'Сосед', passwordHash: 'synthetic-only', homeInstanceId: peer, homeUserId: 'peer-person' },
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'poll.invalid', apiBase: 'https://poll.invalid/api',
    clientOrigin: 'https://poll.invalid', rootKey: 'synthetic-not-a-key', state: 'active', features });
  await t.db.insert(schema.conversations).values([
    { id: sourceId, kind: 'group', title: 'Опросы', createdBy: 'author' },
    { id: targetId, kind: 'group', title: 'Пересылка', createdBy: 'author' },
    { id: remoteId, kind: 'group', title: 'Смешанная группа', createdBy: 'author' },
    { id: hostId, kind: 'group', title: 'Чужой хост', createdBy: 'author', originInstanceId: peer },
    { id: remoteDmId, kind: 'direct', directKey: 'author:shadow', createdBy: 'author' },
  ]);
  await t.db.insert(schema.conversationMembers).values([
    ...['author', 'voter-a', 'voter-b'].map(userId => ({ conversationId: sourceId, userId })),
    ...['author', 'voter-a'].flatMap(userId => [targetId, remoteId, hostId].map(conversationId => ({ conversationId, userId }))),
    { conversationId: remoteId, userId: 'shadow' },
    ...['author', 'shadow'].map(userId => ({ conversationId: remoteDmId, userId })),
  ]);
  const unexpected: string[] = [], warnings: string[] = [], events: Event[] = [];
  const fail = (path: string) => () => { unexpected.push(path); throw new Error(`неописанная граница R219: ${path}`); };
  const unused = (path: string) => new Proxy({}, { get: (_o, key) => key === '__esModule' ? true : fail(`${path}.${String(key)}`) });
  function load<T>(file: string, deps: Record<string, unknown>): T {
    let raw = source(file);
    if (edit?.file === file) { assert.equal(raw.split(edit.from).length, 2, `единственный whole-module якорь ${file}`); raw = raw.replace(edit.from, edit.to); }
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
      module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, Error, crypto,
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
  const push = load<typeof import('../src/push.js')>('push', { ...common, './env.js': { env }, './pushRules.js': pushRules,
    './pushCrypto.js': pushCrypto, './util.js': { id: crypto.randomUUID }, './federation/instanceLabels.js': unused('push instance labels'),
    './permissions.js': unused('channel audience'), './pushDefer.js': unused('push defer'), './federation/guestPush.js': unused('guest push') });
  const fanout = load<typeof import('../src/convSendFanout.js')>('convSendFanout', { ...common, './conversations.js': c, './authGuard.js': guard,
    './contacts.js': contacts, './contactRules.js': contactRules, './groupRules.js': groupRules, './push.js': push });
  const att = load<typeof import('../src/routes/att.js')>('routes/att', { ...fed, zod: { z }, '../convRules.js': rules,
    // R304: старые GET проверяют выдачу; новый POST links — отдельная авторизованная граница.
    '../auth.js': { requireAuth: async () => {} },
    '../conversations.js': { formerLeftAt: async () => null },
    '../attachmentRules.js': attachmentRules, '../attachments.js': attachmentIO, '../authGuard.js': guard, '../storage.js': unused('upload storage') });
  const routes = load<typeof import('../src/routes/conv.js')>('routes/conv', { ...fed, zod: { z }, '../auth.js': auth,
    '../authGuard.js': guard, '../guestGuard.js': unused('guest guard'), './att.js': att, '../stickerCatalog.js': unused('sticker catalog'),
    '../blockRules.js': blockRules, '../blocks.js': blocks, '../conversations.js': c, '../convSendFanout.js': fanout, '../convPolls.js': polls,
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
    const reply = await app.inject({ method, url, headers: { authorization: `Bearer ${auth.signToken({ sub: user, username: `poll_${user}`, gen: 0 })}` }, ...(payload === undefined ? {} : { payload }) });
    await drain(); return reply;
  };
  return { app, c, changes, request, events, drain };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function run(body: (f: Fixture) => Promise<void>, edit?: Mutation) {
  const f = await fixture(edit); try { await body(f); } finally { try { await f.drain(); } finally { await f.app.close(); } }
}
const poll = (overrides: Partial<shared.ConvPollInput> = {}): shared.ConvPollInput => ({ kind: 'poll', question: 'Выбор?',
  options: ['Первый', ' ', 'Второй'], anonymous: false, ...overrides });
async function create(f: Fixture, media = poll(), conversationId = sourceId) {
  const r = await f.request('author', 'POST', `/conv/${conversationId}/messages`, { clientId: crypto.randomUUID(), media });
  assert.equal(r.statusCode, 201, r.body); return r.json<Message>();
}
function media(message: Message): shared.ConvPollMedia {
  assert.equal(message.media?.kind, 'poll', 'ответ содержит вид опроса'); return message.media as shared.ConvPollMedia;
}
const vote = (f: Fixture, user: string, id: string, optionIds: string[], conversationId = sourceId) =>
  f.request(user, 'POST', `/conv/${conversationId}/messages/${id}/poll/vote`, { optionIds });
const close = (f: Fixture, user: string, id: string, conversationId = sourceId) => f.request(user, 'POST', `/conv/${conversationId}/messages/${id}/poll/close`);
async function row(id: string) { return (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, id)))[0]; }
async function hiddenView(f: Fixture, user: string, id: string) {
  const message = await f.c.messageFor(id, user); assert.ok(message && !('gone' in message));
  const p = media(message);
  assert.equal(p.revealed, false, 'не голосовавший ещё не видит итоги'); assert.deepEqual(p.options.map(o => o.votes), [0, 0]);
  assert.equal(Object.hasOwn(p, 'correct'), false, 'правильный ответ не утекает'); assert.equal(Object.hasOwn(p, 'solution'), false, 'пояснение не утекает');
  return p;
}

test('R219 пустой вопрос отвергается 400, заполненный создаёт опрос без пустого варианта и с запасным текстом', async () => {
  await run(async f => {
    const bad = await f.request('author', 'POST', `/conv/${sourceId}/messages`, { clientId: crypto.randomUUID(), media: poll({ question: '  ' }) });
    assert.equal(bad.statusCode, 400); assert.equal(bad.json().error, 'нужен вопрос');
    assert.equal((await t.db.select().from(schema.conversationMessages)).length, 0, 'ошибка не оставляет сообщение');
    const m = await create(f), stored = await row(m.id);
    assert.deepEqual(media(m).options.map(o => ({ id: o.id, text: o.text, votes: o.votes })), [{ id: '0', text: 'Первый', votes: 0 }, { id: '1', text: 'Второй', votes: 0 }]);
    assert.equal(stored.content, shared.convPollFallback(stored.media as shared.ConvPollMedia));
    assert.equal(stored.noPreview, true, 'запасной текст не запускает получение карточки ссылки');
    assert.equal(media(m).revealed, false);
  });
});
async function remoteGate(edit?: Mutation) {
  await run(async f => {
    const r = await f.request('author', 'POST', `/conv/${remoteId}/messages`, { clientId: crypto.randomUUID(), media: poll() });
    assert.equal(r.statusCode, 403, 'создание опроса с человеком соседа запрещено');
    assert.equal(r.json().reason, shared.CONV_POLL_FEDERATED_ERROR);
    assert.equal((await t.db.select().from(schema.conversationMessages)).length, 0, 'отказ не записывает частичный опрос');
    assert.equal((await f.request('author', 'POST', `/conv/${remoteId}/messages`, { clientId: crypto.randomUUID(), content: 'Обычный текст' })).statusCode, 201,
      'запрет опроса не запрещает обычное сообщение');
  }, edit);
}
test('R219 смешанная группа не принимает опрос, но обычный текст всё ещё можно отправить', async () => { await remoteGate(); });
test('R219 чужой хост, бывшая тень и собеседник соседа в 1:1 также не допускают опрос', async () => {
  await run(async f => {
    await t.db.update(schema.conversationMembers).set({ leftAt: new Date() }).where(orm.and(orm.eq(schema.conversationMembers.conversationId, remoteId), orm.eq(schema.conversationMembers.userId, 'shadow')));
    for (const id of [remoteId, hostId, remoteDmId]) {
      const r = await f.request('author', 'POST', `/conv/${id}/messages`, { clientId: crypto.randomUUID(), media: poll() });
      assert.equal(r.statusCode, 403); assert.equal(r.json().reason, shared.CONV_POLL_FEDERATED_ERROR);
    }
  });
});
async function privacy(edit?: Mutation) {
  await run(async f => {
    const m = await create(f, poll({ quiz: true, multi: true, correct: 2, solution: 'Объяснение' }));
    const stored = (await row(m.id)).media as shared.ConvPollMedia;
    assert.equal(stored.correct, '1'); assert.equal(stored.multi, false, 'присланный multi отброшен у викторины');
    await hiddenView(f, 'author', m.id);
    assert.equal((await vote(f, 'voter-a', m.id, ['0', '1'])).statusCode, 400, 'присланный multi не разрешает два ответа викторины');
    const r = await vote(f, 'voter-a', m.id, ['1']); assert.equal(r.statusCode, 200, r.body);
    const p = media(r.json<Message>());
    assert.equal(p.revealed, true, 'голосовавший получает итоги своим видом');
    assert.deepEqual(p.options.map(o => o.votes), [0, 1]); assert.deepEqual(p.my, ['1']); assert.equal(p.correct, '1'); assert.equal(p.solution, 'Объяснение');
    assert.equal((await hiddenView(f, 'voter-b', m.id)).voters, 1, 'число людей видно и без распределения');
    await hiddenView(f, 'author', m.id);
  }, edit);
}
test('R219 викторина скрывает правильный ответ даже от автора до голоса и раскрывает его только голосовавшему', async () => { await privacy(); });
test('R219 повторный голос отвергается, отмена обычного опроса удаляет мой выбор и снова скрывает итоги', async () => {
  await run(async f => {
    const m = await create(f); assert.equal((await vote(f, 'voter-a', m.id, ['0'])).statusCode, 200);
    const repeat = await vote(f, 'voter-a', m.id, ['1']); assert.equal(repeat.statusCode, 400);
    assert.deepEqual((await t.db.select().from(schema.convPollVotes)).map(v => v.optionId), ['0']);
    const cancel = await vote(f, 'voter-a', m.id, []); assert.equal(cancel.statusCode, 200);
    assert.deepEqual(media(cancel.json<Message>()).my, []); assert.equal(media(cancel.json<Message>()).revealed, false);
    assert.deepEqual(await t.db.select().from(schema.convPollVotes), []);
    assert.equal((await vote(f, 'voter-a', m.id, ['1'])).statusCode, 200, 'после отмены другой выбор принимается');
  });
});
test('R219 множественный выбор хранит две строки, но считает одного человека; неверный вариант и дубли не записываются', async () => {
  await run(async f => {
    const m = await create(f, poll({ multi: true }));
    for (const ids of [['bad'], ['0', '0']]) assert.equal((await vote(f, 'voter-a', m.id, ids)).statusCode, 400);
    const r = await vote(f, 'voter-a', m.id, ['0', '1']); assert.equal(r.statusCode, 200);
    const p = media(r.json<Message>()); assert.equal(p.voters, 1); assert.deepEqual(p.options.map(o => o.votes), [1, 1]);
    assert.equal((await t.db.select().from(schema.convPollVotes)).length, 2);
  });
});
test('R219 список голосовавших закрыт до голоса, открыт после; анонимный опрос не выдаёт людей', async () => {
  await run(async f => {
    const m = await create(f), url = `/conv/${sourceId}/messages/${m.id}/poll/voters`;
    assert.equal((await f.request('voter-b', 'GET', url)).statusCode, 403);
    await vote(f, 'voter-a', m.id, ['1']);
    const r = await f.request('voter-a', 'GET', url); assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().options.map((o: { optionId: string; voters: { id: string }[] }) => [o.optionId, o.voters.map(v => v.id)]), [['0', []], ['1', ['voter-a']]]);
    const anon = await create(f, poll({ anonymous: true })); await vote(f, 'voter-a', anon.id, ['0']);
    assert.equal((await f.request('voter-a', 'GET', `/conv/${sourceId}/messages/${anon.id}/poll/voters`)).statusCode, 403);
  });
});
async function closeAuthor(edit?: Mutation) {
  await run(async f => {
    const m = await create(f);
    const refused = await close(f, 'voter-a', m.id);
    assert.equal(refused.statusCode, 403, 'не автор не может остановить опрос');
    assert.equal(((await row(m.id)).media as shared.ConvPollMedia).closed, false);
    assert.equal((await close(f, 'author', m.id)).statusCode, 200);
    const after = f.events.length, journal = normal(await t.db.select().from(schema.userChanges));
    assert.equal((await close(f, 'author', m.id)).statusCode, 200); assert.equal(f.events.length, after, 'повтор закрытия не порождает второй журнал/событие');
    assert.deepEqual(normal(await t.db.select().from(schema.userChanges)), journal, 'повтор закрытия не растит pts участников');
    assert.equal((await vote(f, 'voter-b', m.id, ['0'])).statusCode, 403);
    const view = await f.c.messageFor(m.id, 'voter-b'); assert.ok(view && !('gone' in view)); assert.equal(media(view).revealed, true, 'закрытие раскрывает итоги без голоса');
    assert.equal((await f.request('voter-b', 'GET', `/conv/${sourceId}/messages/${m.id}/poll/voters`)).statusCode, 200);
  }, edit);
}
test('R219 только автор закрывает опрос навсегда; повтор без события и голос после закрытия запрещён', async () => { await closeAuthor(); });
test('R219 опрос нельзя править, а ответ викторины нельзя отменить', async () => {
  await run(async f => {
    const m = await create(f, poll({ quiz: true, correct: 0 }));
    assert.equal((await f.request('author', 'PATCH', `/conv/${sourceId}/messages/${m.id}`, { content: 'Исправление' })).statusCode, 403);
    assert.equal((await vote(f, 'voter-a', m.id, ['1'])).statusCode, 200);
    assert.equal((await vote(f, 'voter-a', m.id, [])).statusCode, 403);
    assert.deepEqual((await t.db.select().from(schema.convPollVotes)).map(v => v.optionId), ['1']);
  });
});
test('R219 conv.change и HTTP sync несут каждому участнику его собственный вид одного опроса', async () => {
  // Общий DTO или кеш по messageId вместо viewerId раскрыли бы голоса тем, кто ещё не ответил.
  await run(async f => {
    const m = await create(f); f.events.length = 0;
    await vote(f, 'voter-a', m.id, ['0']);
    const changed = f.events.filter(e => e.body.t === 'conv.change' && e.body.message?.id === m.id);
    assert.deepEqual(changed.map(e => e.user).sort(), ['author', 'voter-a', 'voter-b']);
    for (const user of ['author', 'voter-a', 'voter-b']) {
      const event = changed.find(e => e.user === user)!.body as Extract<shared.GatewayServerMessage, { t: 'conv.change' }>;
      assert.ok(event.message && !('gone' in event.message));
      const p = media(event.message); assert.equal(p.revealed, user === 'voter-a'); assert.deepEqual(p.options.map(o => o.votes), user === 'voter-a' ? [1, 0] : [0, 0]);
      const sync = await f.request(user, 'GET', '/conv/sync?pts=0&groups=1'); assert.equal(sync.statusCode, 200, sync.body);
      const raw = sync.json<shared.ConvSyncResponse>();
      assert.ok('messages' in raw, 'свежий журнал выдаёт сообщения, а не reset');
      const item = raw.messages.find(message => message.id === m.id); assert.ok(item && !('gone' in item));
      assert.deepEqual(media(item), p, 'потеря события восстанавливается тем же видом через sync');
    }
  });
});
test('R219 голоса заблокированного не скрываются из общих итогов неанонимного опроса', async () => {
  await run(async f => {
    const m = await create(f); await vote(f, 'voter-a', m.id, ['0']);
    await t.db.insert(schema.userBlocks).values({ blockerId: 'voter-b', blockedId: 'voter-a' });
    const r = await vote(f, 'voter-b', m.id, ['1']); assert.equal(r.statusCode, 200);
    assert.deepEqual(media(r.json<Message>()).options.map(o => o.votes), [1, 1]);
  });
});
test('R219 пересылка закрытого опроса создаёт новый открытый экземпляр без чужих голосов', async () => {
  // Копия — новый опрос, а не ссылка на закрытый исходник или на его таблицу голосов.
  await run(async f => {
    const m = await create(f); await vote(f, 'voter-a', m.id, ['0']); await close(f, 'author', m.id);
    const r = await f.request('author', 'POST', `/conv/${targetId}/forward`, { clientId: crypto.randomUUID(), fromConversationId: sourceId, messageIds: [m.id] });
    assert.equal(r.statusCode, 201, r.body);
    const copy = r.json<{ messages: Message[] }>().messages[0], p = media(copy);
    assert.notEqual(copy.id, m.id); assert.equal(p.closed, false); assert.equal(p.revealed, false); assert.equal(p.voters, 0); assert.deepEqual(p.my, []);
    assert.deepEqual(p.options.map(o => o.votes), [0, 0]);
    assert.equal(((await row(m.id)).media as shared.ConvPollMedia).closed, true, 'пересылка не открывает исходный опрос');
    assert.equal((await t.db.select().from(schema.convPollVotes).where(orm.eq(schema.convPollVotes.messageId, copy.id))).length, 0);
  });
});
test('R219 пересылка в смешанную группу сохраняет запасной текст, но не переносит media опроса', async () => {
  await run(async f => {
    const m = await create(f);
    const r = await f.request('author', 'POST', `/conv/${remoteId}/forward`, { clientId: crypto.randomUUID(), fromConversationId: sourceId, messageIds: [m.id] });
    assert.equal(r.statusCode, 201, r.body);
    const copy = r.json<{ messages: Message[] }>().messages[0]; assert.equal(copy.media, undefined);
    assert.equal((await row(copy.id)).media, null); assert.equal(copy.content, m.content);
  });
});
test('R219 удаление опроса у всех обнуляет media и больше не разрешает голосовать', async () => {
  await run(async f => {
    const m = await create(f); await vote(f, 'voter-a', m.id, ['0']);
    assert.equal((await f.request('author', 'DELETE', `/conv/${sourceId}/messages/${m.id}?for=both`)).statusCode, 204);
    const stored = await row(m.id); assert.equal(stored.media, null); assert.ok(stored.deletedAt);
    assert.equal((await vote(f, 'voter-a', m.id, ['1'])).statusCode, 404);
    assert.equal((await f.request('author', 'GET', `/conv/${sourceId}/messages/${m.id}/poll/voters`)).statusCode, 404);
  });
});
test('R219 materialize даже соседу с dmmedia1 отдаёт лишь запасной текст без ответов и media', async () => {
  await run(async f => {
    const m = await create(f, poll({ quiz: true, correct: 0, solution: 'Секрет' }));
    await t.db.insert(schema.conversationMembers).values({ conversationId: sourceId, userId: 'shadow' });
    const page = await f.changes.exportForPeer(peer, sourceId, null, self); assert.ok(page);
    const message = page.items.find(i => i.kind === 'msg' && i.entityId === m.id)?.entity; assert.ok(message);
    assert.equal(Object.hasOwn(message, 'media'), false, 'поддержка geo/contact не включает протокол опросов');
    assert.equal(message.content, m.content); assert.equal(JSON.stringify(message).includes('Секрет'), false);
    assert.equal(((await row(m.id)).media as shared.ConvPollMedia).correct, '0', 'провод не обезличивает хранимую форму');
  });
});
test('R219 посторонний, чужая беседа и обычное сообщение не допускают операции опроса', async () => {
  await run(async f => {
    const m = await create(f);
    assert.equal((await vote(f, 'outsider', m.id, ['0'])).statusCode, 404);
    assert.equal((await vote(f, 'voter-a', m.id, ['0'], targetId)).statusCode, 404);
    const text = await f.request('author', 'POST', `/conv/${sourceId}/messages`, { clientId: crypto.randomUUID(), content: 'Не опрос' });
    assert.equal(text.statusCode, 201); assert.equal((await vote(f, 'voter-a', text.json<Message>().id, ['0'])).statusCode, 404);
  });
});
test('R219 контрфакт: потерян персональный pollView — голосовавший получает скрытый пустой вид', async () => {
  await privacy();
  await assert.rejects(() => privacy(mutation('conversations', "if (m.media?.kind === 'poll') cm.media = convPollView(m.media, pollVotes.get(m.id) ?? [], viewerId);", '')),
    killed('голосовавший получает итоги своим видом', false, true));
});
test('R219 контрфакт: снята проверка автора — чужое закрытие становится HTTP 200', async () => {
  await closeAuthor();
  await assert.rejects(() => closeAuthor(mutation('convPolls', "if (p.authorId !== me) return { kind: 'refused', code: 403, error: 'остановить опрос может только автор' };", '', 'closeConvPoll')),
    killed('не автор не может остановить опрос', 200, 403));
});
test('R219 контрфакт: отключён convHasRemote — смешанная группа получает неподдерживаемый опрос', async () => {
  await remoteGate();
  await assert.rejects(() => remoteGate(mutation('routes/conv', "media?.kind === 'poll' && (await convHasRemote(db, conversationId))", "media?.kind === 'poll' && false", 'convRoutes')),
    killed('создание опроса с человеком соседа запрещено', 201, 403));
});

async function acceptedPollStored(message: Message, conversationId: string, memberIds: readonly string[], homeIds: readonly string[]) {
  const stored = await row(message.id); assert.ok(stored, '201 соответствует сохранённому сообщению');
  assert.equal(stored.conversationId, conversationId); assert.equal(stored.authorId, 'author');
  assert.equal(stored.media?.kind, 'poll', '201 сохраняет настоящий media опроса');
  const p = stored.media as shared.ConvPollMedia;
  assert.deepEqual(p.options.map(o => ({ id: o.id, text: o.text })), [{ id: '0', text: 'Первый' }, { id: '1', text: 'Второй' }]);
  assert.equal(p.question, 'Выбор?'); assert.equal(p.closed, false); assert.equal(stored.content, message.content);
  const local = await t.db.select().from(schema.userChanges).where(orm.eq(schema.userChanges.messageId, message.id));
  assert.deepEqual(local.map(r => `${r.userId}:${r.conversationId}:${r.kind}`).sort(),
    memberIds.map(id => `${id}:${conversationId}:msg`).sort(), 'сохранение пишет msg каждому действующему участнику и никому бывшему');
  const remote = await t.db.select().from(schema.fedConvChanges).where(orm.eq(schema.fedConvChanges.entityId, message.id));
  assert.deepEqual(remote.map(r => `${r.instanceId}:${r.conversationId}:${r.kind}`).sort(),
    homeIds.map(id => `${id}:${conversationId}:msg`).sort(), 'создание записано только нужным домам в журнал федерации');
}
test('R222 все чужие дома с dmpoll1 допускают создание в смешанной группе и 1:1', async () => {
  await run(async f => {
    await t.db.update(schema.federationLinks).set({ features: [...features, shared.FED_FEATURES.dmpoll1] });
    for (const [id, members] of [[remoteId, ['author', 'voter-a', 'shadow']], [remoteDmId, ['author', 'shadow']]] as const) {
      const m = await create(f, poll(), id); assert.equal(media(m).kind, 'poll');
      await acceptedPollStored(m, id, members, [peer]);
    }
  });
});
test('R222 один старый дом запрещает создание тем же reason, после объявления dmpoll1 тот же состав принимается', async () => {
  await run(async f => {
    const third = 'r222-old-home';
    await t.db.update(schema.federationLinks).set({ features: [...features, shared.FED_FEATURES.dmpoll1] });
    await t.db.insert(schema.federationLinks).values({ instanceId: third, domain: 'old-poll.invalid', apiBase: 'https://old-poll.invalid/api',
      clientOrigin: 'https://old-poll.invalid', rootKey: 'synthetic-only', state: 'active', features });
    await t.db.insert(schema.users).values({ id: 'r222-old-person', username: 'r222_old_person', displayName: 'Другой дом',
      passwordHash: 'synthetic-only', homeInstanceId: third, homeUserId: 'home-person' });
    await t.db.insert(schema.conversationMembers).values({ conversationId: remoteId, userId: 'r222-old-person' });
    const r = await f.request('author', 'POST', `/conv/${remoteId}/messages`, { clientId: crypto.randomUUID(), media: poll() });
    assert.equal(r.statusCode, 403); assert.equal(r.json().reason, shared.CONV_POLL_FEDERATED_ERROR);
    assert.equal((await t.db.select().from(schema.conversationMessages)).length, 0);
    await t.db.update(schema.federationLinks).set({ features: [...features, shared.FED_FEATURES.dmpoll1] }).where(orm.eq(schema.federationLinks.instanceId, third));
    const m = await create(f, poll(), remoteId); assert.equal(media(m).kind, 'poll');
    await acceptedPollStored(m, remoteId, ['author', 'voter-a', 'shadow', 'r222-old-person'], [peer, third]);
  });
});
test('R222 бывший участник старого дома всё ещё запрещает создание, объявленный признак допускает', async () => {
  await run(async f => {
    await t.db.update(schema.conversationMembers).set({ leftAt: new Date('2026-10-01T00:00:00Z') }).where(orm.and(
      orm.eq(schema.conversationMembers.conversationId, remoteId), orm.eq(schema.conversationMembers.userId, 'shadow')));
    const r = await f.request('author', 'POST', `/conv/${remoteId}/messages`, { clientId: crypto.randomUUID(), media: poll() });
    assert.equal(r.statusCode, 403); assert.equal(r.json().reason, shared.CONV_POLL_FEDERATED_ERROR);
    await t.db.update(schema.federationLinks).set({ features: [...features, shared.FED_FEATURES.dmpoll1] });
    const m = await create(f, poll(), remoteId); assert.equal(media(m).kind, 'poll');
    await acceptedPollStored(m, remoteId, ['author', 'voter-a'], []);
  });
});
test('R222 чужой хост без dmpoll1 блокирует даже местный состав, с признаком допускает опрос', async () => {
  await run(async f => {
    const r = await f.request('author', 'POST', `/conv/${hostId}/messages`, { clientId: crypto.randomUUID(), media: poll() });
    assert.equal(r.statusCode, 403); assert.equal(r.json().reason, shared.CONV_POLL_FEDERATED_ERROR);
    await t.db.update(schema.federationLinks).set({ features: [...features, shared.FED_FEATURES.dmpoll1] });
    const m = await create(f, poll(), hostId); assert.equal(media(m).kind, 'poll');
    await acceptedPollStored(m, hostId, ['author', 'voter-a'], [peer]);
  });
});
test('R222 без record опрос с соседями запрещён даже при dmpoll1, после подключения снова принимается', async () => {
  await run(async f => {
    await t.db.update(schema.federationLinks).set({ features: [...features, shared.FED_FEATURES.dmpoll1] });
    f.c.configureFederatedConv(null);
    const r = await f.request('author', 'POST', `/conv/${remoteDmId}/messages`, { clientId: crypto.randomUUID(), media: poll() });
    assert.equal(r.statusCode, 403); assert.equal(r.json().reason, shared.CONV_POLL_FEDERATED_ERROR);
    f.c.configureFederatedConv({ selfInstanceId: () => self, record: f.changes.recordFedConvChanges });
    const m = await create(f, poll(), remoteDmId); assert.equal(media(m).kind, 'poll');
    await acceptedPollStored(m, remoteDmId, ['author', 'shadow'], [peer]);
  });
});
test('R222 пересылка старому дому становится текстом, новому — независимым открытым опросом', async () => {
  await run(async f => {
    const m = await create(f); await vote(f, 'voter-a', m.id, ['0']); await close(f, 'author', m.id);
    const forward = async () => {
      const r = await f.request('author', 'POST', `/conv/${remoteId}/forward`, { clientId: crypto.randomUUID(), fromConversationId: sourceId, messageIds: [m.id] });
      assert.equal(r.statusCode, 201, r.body); return r.json<{ messages: Message[] }>().messages[0];
    };
    const old = await forward(); assert.equal(old.media, undefined); assert.equal(old.content, m.content);
    await t.db.update(schema.federationLinks).set({ features: [...features, shared.FED_FEATURES.dmpoll1] });
    const modern = await forward(); assert.equal(media(modern).closed, false); assert.equal(media(modern).voters, 0);
    await acceptedPollStored(modern, remoteId, ['author', 'voter-a', 'shadow'], [peer]);
    assert.equal((await t.db.select().from(schema.convPollVotes).where(orm.eq(schema.convPollVotes.messageId, modern.id))).length, 0);
  });
});
