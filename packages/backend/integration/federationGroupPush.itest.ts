import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as groupRules from '../src/groupRules.js';
import * as dmRules from '../src/dmRules.js';
import * as contactRules from '../src/contactRules.js';
import * as authRules from '../src/authRules.js';
import * as superAdminRules from '../src/superAdminRules.js';
import * as userSearchRules from '../src/userSearchRules.js';
import * as setupRules from '../src/setupRules.js';
import * as guestGuardCore from '../src/guestGuardCore.js';
import * as pushRules from '../src/pushRules.js';
import * as pushCrypto from '../src/pushCrypto.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as linkService from '../src/federation/linkService.js';
import * as outboxRules from '../src/federation/outboxRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = { file: string; from: string; to: string };
type Push = typeof import('../src/push.js');
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { try { await t?.close(); } finally { await (await import('../src/db/index.js')).pool.end(); } });
const self = 'a'.repeat(32), peer = 'b'.repeat(32), cid = 'push-host-group';
const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function moduleOf<T>(name: string, deps: Record<string, unknown>, unexpected: string[], mutation?: Mutation,
  extra: Record<string, unknown> = {}): T {
  let raw = source(name);
  if (mutation?.file === name) { assert.equal(raw.split(mutation.from).length - 1, 1, `единственный якорь ${name}`); raw = raw.replace(mutation.from, mutation.to); }
  const imports: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly) continue;
    const id = (n.moduleSpecifier as ts.StringLiteral).text;
    imports[id] = new Proxy({}, { get: (_t, key) => key === '__esModule' ? true : () => {
      const label = `${name}:${id}.${String(key)}`; unexpected.push(label); throw new Error(`неописанная граница ${label}`);
    } });
  }
  Object.assign(imports, deps);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
    module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, Error, console, crypto, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (id: string) => { assert.equal(Object.hasOwn(imports, id), true, `явный импорт ${name}:${id}`); return imports[id]; }, ...extra,
  });
  return module.exports as T;
}
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const strictFailure = (label: string, actual: unknown, expected: unknown) => (e: unknown) => e instanceof assert.AssertionError
  && e.message.startsWith(label) && e.operator === 'deepStrictEqual' && JSON.stringify(e.actual) === JSON.stringify(actual) && JSON.stringify(e.expected) === JSON.stringify(expected);

async function fixture(mutation?: Mutation) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    ...['author', 'local'].map(id => ({ id, username: `gpush_${id}`, displayName: id === 'author' ? 'Автор' : 'Местный',
      passwordHash: 'fixture', verified: true, approvedAt: new Date() })),
    ...['shadow', 'shadow2'].map((id, i) => ({ id, username: `gpush_${id}`, displayName: 'Человек соседа', passwordHash: 'fixture',
      homeInstanceId: peer, homeUserId: `remote-${i}`, homeUsername: `remote_${i}`, verified: true, approvedAt: new Date() })),
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'peer.invalid', apiBase: 'https://peer.invalid/api',
    clientOrigin: 'https://peer.invalid', rootKey: 'fixture-root', state: 'active', features: ['dm1', 'dmgroup1'] });
  await t.db.insert(schema.pushDevices).values({ id: 'local-phone', userId: 'local', deviceId: 'phone', endpoint: 'https://ntfy.invalid/local' });
  await t.db.insert(schema.conversations).values({ id: cid, kind: 'group', createdBy: 'author', title: 'Наша группа' });
  await t.db.insert(schema.conversationMembers).values(['author', 'local', 'shadow'].map(userId => ({ conversationId: cid, userId, role: userId === 'author' ? 'owner' as const : 'member' as const })));
  const unexpected: string[] = [], pushCalls: string[][] = [], guestCalls: string[][] = [], pushNetwork: Array<{ url: string; body: string }> = [];
  const queued: Array<{ kind: string; seq: number }> = [], transported: Array<{ kind: string; earlier: string[]; payload: Record<string, unknown> }> = [];
  const outcomes: Array<{ kind: string; result: string }> = [], deliveries: unknown[] = [], background: Promise<unknown>[] = [];
  const fakeEnv = { ntfy: { baseUrl: 'https://ntfy.invalid', token: 'fixture-push-token' }, federation: { enabled: true },
    jwtSecret: 'not-a-secret-used-only-by-integration-tests' };
  const federation = { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture-key', privateKeyDer: new Uint8Array() }) };
  const fed = { '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema, './instance.js': { federation } };
  const transport = async (input: { payload: { events: Array<{ kind: string; seq: number; payload: Record<string, unknown> }> } }) => {
    const event = input.payload.events[0];
    const rows = (await t.raw.query<{ kind: string }>('SELECT kind FROM federation_outbox WHERE instance_id=$1 AND seq < $2 ORDER BY seq', [peer, event.seq])).rows;
    transported.push({ kind: event.kind, earlier: rows.map(r => r.kind), payload: event.payload });
    return { ok: true, value: { status: 200 } };
  };
  const outbox = moduleOf<typeof import('../src/federation/outbox.js')>('federation/outbox', {
    ...fed, 'node:crypto': crypto, './peerClient.js': { postSignedToPeer: transport }, './outboxRules.js': outboxRules,
  }, unexpected);
  const eventStream = moduleOf<typeof import('../src/federation/eventStream.js')>('federation/eventStream', {
    ...fed, './peerClient.js': { postSignedToPeer: transport }, './linkRules.js': linkRules, './outbox.js': {
      ...outbox, enqueueEvent: async (home: string, event: shared.FedEvent) => { await outbox.enqueueEvent(home, event); queued.push({ kind: event.kind, seq: event.seq }); },
    },
  }, unexpected);
  const events = { ...eventStream, sendEventTo: async (...args: Parameters<typeof eventStream.sendEventTo>) => {
    const pending = eventStream.sendEventTo(...args).then(result => { outcomes.push({ kind: args[1], result }); return result; });
    background.push(pending); return pending;
  } };
  // Счётчики Redis подставные; принятие решения burst, rateHit и правила отсрочки — настоящие модули.
  const redis = { incr: async () => 1, expire: async () => 1, ttl: async () => 10, set: async () => 'OK' };
  const authGuard = moduleOf<typeof import('../src/authGuard.js')>('authGuard', {
    '@gusvoice/shared': shared, './authRules.js': authRules, './pushRules.js': pushRules, './realtime.js': { redisPub: redis },
  }, unexpected);
  const defer = moduleOf<typeof import('../src/pushDefer.js')>('pushDefer', {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema, './pushRules.js': pushRules, './realtime.js': { redisPub: redis },
  }, unexpected);
  let push: Push;
  const guest = moduleOf<typeof import('../src/federation/guestPush.js')>('federation/guestPush', {
    ...fed, '../authGuard.js': authGuard, '../env.js': { env: fakeEnv }, '../push.js': new Proxy({}, { get: (_o, key) => push[key as keyof Push] }),
    './eventStream.js': events,
  }, unexpected);
  push = moduleOf<Push>('push', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema, './env.js': { env: fakeEnv },
    './pushRules.js': pushRules, './pushCrypto.js': pushCrypto, './pushDefer.js': defer, './util.js': { id: crypto.randomUUID },
    './federation/guestPush.js': { ...guest, notifyGuestHomes: async (...args: Parameters<typeof guest.notifyGuestHomes>) => {
      guestCalls.push(args[0].map(g => g.homeUserId)); const task = guest.notifyGuestHomes(...args); background.push(task); return task;
    } },
  }, unexpected, undefined, { fetch: async (url: string, init: { body: string }) => { pushNetwork.push({ url, body: init.body }); return { status: 200, type: 'basic' }; } });
  const observedPush = { ...push, sendPushToUsers: async (...args: Parameters<Push['sendPushToUsers']>) => {
    pushCalls.push([...args[0]]); const task = push.sendPushToUsers(...args); background.push(task); return task;
  } };
  const contacts = moduleOf<typeof import('../src/contacts.js')>('contacts', { 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema, './contactRules.js': contactRules }, unexpected);
  const serialize = moduleOf<typeof import('../src/serialize.js')>('serialize', {
    '@gusvoice/shared': shared, './env.js': { env: fakeEnv }, './linkThreats.js': { dangerousLinksOf: () => [] },
    './federation/instanceLabels.js': { instanceLabel: (id: string) => ({ instanceId: id, name: 'Сосед', domain: 'peer.invalid', reports: false }) },
  }, unexpected);
  const changes = moduleOf<typeof import('../src/federation/convChanges.js')>('federation/convChanges', fed, unexpected);
  const c = moduleOf<typeof import('../src/conversations.js')>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema, './convRules.js': rules,
    './serialize.js': serialize, './env.js': { env: fakeEnv }, './util.js': { uuidv7: crypto.randomUUID }, './dmWriteBarrier.js': { dmWriteBarrier: {} },
  }, unexpected);
  const conv = { ...c, deliver: async (d: unknown) => { if (d) deliveries.push(d); } };
  c.configureFederatedConv({ selfInstanceId: () => self, record: null });
  const groups = moduleOf<typeof import('../src/convGroups.js')>('convGroups', {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema, './groupRules.js': groupRules,
    './conversations.js': conv, './util.js': { uuidv7: crypto.randomUUID },
  }, unexpected);
  const fanout = moduleOf<typeof import('../src/convSendFanout.js')>('convSendFanout', {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema, './authGuard.js': authGuard, './conversations.js': conv,
    './contacts.js': contacts, './contactRules.js': contactRules, './groupRules.js': groupRules, './push.js': observedPush,
  }, unexpected, mutation);
  const accept = moduleOf<typeof import('../src/federation/convAccept.js')>('federation/convAccept', {
    ...fed, '../conversations.js': conv, '../convRules.js': rules, '../convSendFanout.js': fanout, './eventStream.js': events,
  }, unexpected);
  const auth = moduleOf<typeof import('../src/auth.js')>('auth', { bcryptjs: bcrypt, jsonwebtoken: jwt, 'drizzle-orm': orm,
    './db/index.js': { db: t.db }, './db/schema.js': schema, './env.js': { env: fakeEnv }, './authRules.js': authRules, './superAdminRules.js': superAdminRules }, unexpected);
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', { 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema }, unexpected);
  const guestGuard = moduleOf<typeof import('../src/guestGuard.js')>('guestGuard', { 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema, './guestGuardCore.js': guestGuardCore }, unexpected);
  const peerQueries = moduleOf<typeof import('../src/db/peerQueries.js')>('db/peerQueries', { 'drizzle-orm': orm, './index.js': { db: t.db } }, unexpected);
  const setup = moduleOf<typeof import('../src/instanceSetup.js')>('instanceSetup', { '@gusvoice/shared': shared, 'drizzle-orm': orm,
    './auth.js': auth, './db/index.js': { db: t.db }, './db/schema.js': schema, './dmRules.js': dmRules, './env.js': { env: fakeEnv }, './setupRules.js': setupRules }, unexpected);
  await setup.setDmPolicy('anyone');
  const routes = moduleOf<typeof import('../src/routes/convGroups.js')>('routes/convGroups', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z }, '../auth.js': auth, '../authGuard.js': authGuard, '../blocks.js': blocks,
    '../convGroups.js': groups, '../conversations.js': conv, '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../db/peerQueries.js': peerQueries,
    '../dmRules.js': dmRules, '../groupRules.js': groupRules, '../guestGuard.js': guestGuard, '../instanceSetup.js': setup,
    '../push.js': observedPush, '../superAdminRules.js': superAdminRules, '../userSearchRules.js': userSearchRules,
  }, unexpected, mutation);
  const links = moduleOf<typeof import('../src/federation/links.js')>('federation/links', {
    ...fed, 'node:crypto': crypto, './linkService.js': linkService, '../env.js': { env: fakeEnv },
  }, unexpected);
  const fedGroups = moduleOf<typeof import('../src/federation/convGroup.js')>('federation/convGroup', {
    ...fed, 'node:crypto': crypto, '../convGroups.js': groups, '../conversations.js': conv, '../groupRules.js': groupRules,
    '../userSearchRules.js': userSearchRules, './linkRules.js': linkRules, './links.js': links,
    './instanceMeta.js': { readInstanceMeta: async () => ({ paused: false }) },
  }, unexpected);
  routes.configureFedGroups({ invitable: fedGroups.groupInvitableHome, op: fedGroups.groupOpRemote });
  const drain = async () => {
    // Каждая итерация — очередь настоящего Postgres и переход event-loop. Это даёт завершиться void-веткам,
    // а их IO/transport promises явно дожидаются: простой sleep способен скрыть проглоченное исключение.
    for (let i = 0; i < 16; i++) { await new Promise<void>(resolve => setImmediate(resolve)); await t.raw.query('SELECT 1'); await Promise.all(background); }
    assert.deepEqual(unexpected, [], 'фон не проглотил неописанную зависимость');
  };
  const queuedRows = async () => (await t.raw.query<{ kind: string; seq: number }>('SELECT kind,seq FROM federation_outbox ORDER BY seq')).rows;
  const send = async (ring = false) => {
    if (ring) { changes.configureFedConvDoorbell(accept.ringDoorbell); c.configureFederatedConv({ selfInstanceId: () => self, record: changes.recordFedConvChanges }); }
    const access = await c.loadAccess(cid, 'author'); assert.ok(access);
    const result = await c.sendMessage('author', access, { clientId: crypto.randomUUID(), content: 'Привет группе', attachments: [], replyToId: null, withheld: false });
    assert.ok(result.kind === 'created');
    await fanout.fanOutSend({ me: 'author', peerId: null, groupMemberIds: ['author', 'local', 'shadow'], conversationId: cid,
      row: result.row, delivery: result.delivery, notifyRecipient: true, content: result.row.content, attachments: [], silent: false });
    await drain(); return result;
  };
  const create = async (added: string[]) => {
    const app = Fastify();
    try {
      await app.register(routes.convGroupRoutes); await app.ready();
      const result = await app.inject({ method: 'POST', url: '/conv/group', headers: { authorization: `Bearer ${auth.signToken({ sub: 'author', username: 'gpush_author', gen: 0 })}` }, payload: { title: 'Новая группа', userIds: added } });
      assert.equal(result.statusCode, 201, result.body); await drain();
      return result.json() as shared.ConvSummary;
    } finally { await app.close(); }
  };
  return { fanout, push, send, create, drain, queuedRows, pushCalls, guestCalls, pushNetwork, transported, outcomes, deliveries, queued };
}

async function fanoutScenario(mutation?: Mutation) {
  const f = await fixture(mutation);
  // Участник местного дома и тень отличаются только home: SQL-выборка не должна перевернуть это правило.
  assert.deepEqual(plain([...await f.fanout.homedElsewhere(['author', 'local', 'shadow'])].sort()), ['shadow'], 'другой дом определяется по ненулевому home');
  await f.send();
  assert.deepEqual(f.pushCalls, [['local']], 'групповой пуш вызывается только своему участнику');
  assert.deepEqual(f.guestCalls, [], 'групповой пуш не вызывает guest.notify');
  assert.deepEqual(await f.queuedRows(), [], 'теневой участник не занимает очередь связки');
  assert.equal(f.pushNetwork.length, 1); assert.equal(f.pushNetwork[0].url, 'https://ntfy.invalid/local');
  assert.equal(JSON.parse(f.pushNetwork[0].body).title, 'Автор в «Наша группа»');
  assert.equal(f.deliveries.length, 1); return f;
}
test('R210 группа с автором, своим и теневым пушит только своего без guest.notify и строки outbox', async () => {
  // Тень получает уведомление со своего дома по принятой копии: наш пуш задержал бы саму копию.
  await fanoutScenario();
});
test('R210 снятие фильтра чужого дома ловится вызовом настоящего пуша теневому', async () => {
  await fanoutScenario();
  await assert.rejects(fanoutScenario({ file: 'convSendFanout', from: 'if (elsewhere.has(id)) continue;', to: '' }),
    strictFailure('групповой пуш вызывается только своему участнику', [['local'], ['shadow']], [['local']]));
});
test('R210 перевёрнутый home ловится реальным SQL, а не падением загрузчика', async () => {
  await fanoutScenario();
  await assert.rejects(fanoutScenario({ file: 'convSendFanout', from: 'rows.filter((r) => r.home !== null)', to: 'rows.filter((r) => r.home === null)' }),
    strictFailure('другой дом определяется по ненулевому home', ['author', 'local'], ['shadow']));
});
async function addedScenario(onlyShadows = false, mutation?: Mutation) {
  const f = await fixture(mutation), added = onlyShadows ? ['shadow', 'shadow2'] : ['local', 'shadow'];
  const summary = await f.create(added);
  assert.equal(summary.kind, 'group'); assert.equal(summary.group?.title, 'Новая группа');
  const members = (await t.raw.query<{ user_id: string }>('SELECT user_id FROM conversation_members WHERE conversation_id=$1 ORDER BY user_id', [summary.id])).rows.map(r => r.user_id);
  assert.deepEqual(members, ['author', ...added].sort(), 'HTTP действительно создал группу и участников');
  assert.deepEqual(f.pushCalls, onlyShadows ? [] : [['local']], 'добавление будит только местных и не вызывает пустую рассылку');
  assert.deepEqual(f.guestCalls, []); assert.deepEqual(await f.queuedRows(), []);
  assert.equal(f.pushNetwork.length, onlyShadows ? 0 : 1); return f;
}
test('R210 HTTP создания смешанной группы пушит добавленному своему, все добавленные теневые не вызывают рассылку', async () => {
  await addedScenario(); await addedScenario(true);
});
test('R210 передача added вместо local ловится настоящей рассылкой теневому после создания группы', async () => {
  await addedScenario();
  await assert.rejects(addedScenario(false, { file: 'routes/convGroups', from: 'await sendPushToUsers(local, {', to: 'await sendPushToUsers(added, {' }),
    strictFailure('добавление будит только местных и не вызывает пустую рассылку', [['local', 'shadow']], [['local']]));
});
test('R210 потеря раннего выхода при всех теневых ловится вызовом с пустым списком получателей', async () => {
  await addedScenario(true);
  await assert.rejects(addedScenario(true, { file: 'routes/convGroups', from: 'if (local.length === 0) return;', to: '' }),
    strictFailure('добавление будит только местных и не вызывает пустую рассылку', [[]], []));
});
test('R210 сквозная запись хоста звонит соседу сразу: настоящий ringDoorbell и sendEventTo дают sent без guest.notify впереди', async () => {
  const f = await fixture(); const made = await f.send(true);
  assert.ok((await t.db.select().from(schema.fedConvChanges)).some(r => r.entityId === made.row.id), 'сообщение записано в настоящий журнал связки');
  // ringDoorbell имеет реальную задержку 300 мс; её не удаляем, чтобы проверять шов после фиксации.
  for (let i = 0; i < 100 && f.outcomes.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await f.drain();
  assert.deepEqual(f.outcomes, [{ kind: 'conv.changed', result: 'sent' }], 'звонок не задерживается в очереди пушом гостю');
  assert.deepEqual(f.queued.map(e => e.kind), ['conv.changed']); assert.deepEqual(f.guestCalls, []);
  assert.deepEqual(f.transported.map(e => ({ kind: e.kind, earlier: e.earlier })), [{ kind: 'conv.changed', earlier: [] }]);
  assert.deepEqual(await f.queuedRows(), []); assert.deepEqual(f.pushCalls, [['local']]);
});
test('R210 контроль очереди: настоящий guest.notify впереди заставляет следующий звонок ждать, а не обгонять', async () => {
  const f = await fixture();
  // Положительный контроль: транспорт не зашит на sent — настоящая очередь действительно удерживает звонок.
  await f.push.sendPushToUsers(['shadow'], { type: 'dm', title: 'Контроль', body: 'Проверка очереди', dmId: cid }); await f.drain();
  assert.deepEqual((await f.queuedRows()).map(r => r.kind), ['guest.notify']);
  await f.send(true);
  for (let i = 0; i < 100 && f.outcomes.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await f.drain();
  assert.deepEqual(f.outcomes, [{ kind: 'conv.changed', result: 'queued' }]);
  assert.deepEqual((await f.queuedRows()).map(r => r.kind), ['guest.notify', 'conv.changed']); assert.equal(f.transported.length, 0);
});
