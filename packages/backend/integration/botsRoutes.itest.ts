import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { runInNewContext } from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import { after, before, test } from 'node:test';
import Fastify, { type InjectOptions } from 'fastify';
import * as zod from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';
import { hookUrlErrorEn, parseHookUrl } from '../src/safeFetch.js';
import { forwardPreview, pushThrottleSource, withSilent } from '../src/pushRules.js';
import { Bot as SdkBot, GusVoiceApiError as SdkApiError, type WebSocketLike } from '../../bot-sdk/src/index.js';

// R297: настоящие SQL, транзакции, сериализаторы, маршруты и журнал бесед; заменены только IO-границы.
// Целые модули загружаются заново на сценарий, поэтому контрфакты не меняют рабочее дерево/кэш импортов.
type Edit = { file: string; from: string; to: string };
type Conv = typeof import('../src/conversations.js');
type Socket = { send(data: string): void; close(code?: number, reason?: string): void; on(event: string, cb: (...args: any[]) => void): void };
type Api = typeof import('../src/routes/botApi.js') & { __serve: (s: Socket, req: unknown) => Promise<void> };
type WebhookDelivery = typeof import('../src/bots/webhookDelivery.js') & { __deliverLoop: (botId: string) => Promise<void> };
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function fixture(edit?: Edit) {
  await truncateAll(t.raw);
  const password = 'synthetic-r297-password';
  const passwordHash = await bcrypt.hash(password, 4);
  await t.db.insert(schema.users).values(['owner', 'other', 'admin'].map(id => ({ id, username: `r297_${id}`, displayName: id,
    passwordHash, verified: true, approvedAt: new Date('2026-01-01T00:00:00Z') })));
  await t.db.insert(schema.users).values({ id: 'webhook', username: 'r297_hookbot', displayName: 'Webhook', passwordHash, bot: true, verified: false });
  const unexpected: string[] = [], warnings: string[] = [];
  const routeErrors: string[] = [];
  const pushes: { users: string[]; body: unknown }[] = [];
  const readSyncPushes: unknown[][] = [];
  const events: { user: string; body: shared.GatewayServerMessage }[] = [];
  const pending = new Set<Promise<unknown>>();
  const hookRequests: { url: string; body: Record<string, any>; raw: string; headers: Record<string, string> }[] = [];
  const hookChecks: { url: string; allowInternal: boolean }[] = [];
  const profileBroadcasts: { userId: string; displayName: string; avatarUrl: string | null; animatedAvatarUrl: string | null }[] = [];
  const callStarts: { callerId: string; calleeId: string; conversationId: string; device: string }[] = [];
  const federationCalls: string[] = [];
  // R301: Redis и часы — IO; маршруты, очередь callback и проверка владельца настоящие.
  let callbackNow = Date.now();
  const callbackTimers: { at: number; fn: () => void }[] = [];
  const redisData = new Map<string, { value: string; expires: number }>();
  const rateBlocks = new Map<string, number>();
  const deliveryLocks: string[] = [];
  const deliveryIntervals: Array<{ fn: () => Promise<void>; ms: number }> = [];
  const redisGet = (key: string) => {
    const row = redisData.get(key);
    if (row && row.expires <= callbackNow) { redisData.delete(key); return null; }
    return row?.value ?? null;
  };
  const redis = {
    // R306: прежние сценарии не создают голосовых сессий, но lifecycle теперь честно грузит botVoice.
    smembers: async (key: string) => { assert.equal(key, 'presence:channels'); return []; },
    zremrangebyscore: async () => 0,
    zrangebyscore: async () => [],
    publish: async () => 1,
    get: async (key: string) => redisGet(key),
    set: async (key: string, value: string, mode?: string, ttl?: number, condition?: string) => {
      if (key.startsWith('bot:wh:lock:')) deliveryLocks.push(key);
      if (condition === 'NX' && redisGet(key) !== null) return null;
      redisData.set(key, { value, expires: mode === 'EX' ? callbackNow + ttl! * 1000 : mode === 'PX' ? callbackNow + ttl! : Infinity }); return 'OK';
    },
    del: async (key: string) => { redisGet(key); return Number(redisData.delete(key)); },
    incr: async (key: string) => { const n = Number(redisGet(key) ?? 0) + 1; redisData.set(key, { value: String(n), expires: redisData.get(key)?.expires ?? Infinity }); return n; },
    decr: async (key: string) => { const n = Number(redisGet(key) ?? 0) - 1; redisData.set(key, { value: String(n), expires: redisData.get(key)?.expires ?? Infinity }); return n; },
    expire: async (key: string, seconds: number) => { const r = redisData.get(key); if (r) r.expires = callbackNow + seconds * 1000; return Number(!!r); },
    pexpire: async (key: string, ms: number) => { const r = redisData.get(key); if (r) r.expires = callbackNow + ms; return Number(!!r); },
  };
  class CallbackDate extends Date { static override now() { return callbackNow; } }
  let hookTargetError: string | null = null;
  const retryDelays: number[] = [];
  let hookStatuses: number[] = [];
  let repeatedHookStatus: number | undefined;
  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p); void p.then(() => pending.delete(p), () => pending.delete(p)); return p;
  };
  const fail = (name: string) => (..._args: unknown[]): never => { unexpected.push(name); throw new Error(`R297 unexpected IO: ${name}`); };
  const dormant = (name: string) => new Proxy({}, { get: (_o, key) => key === '__esModule' ? true : fail(`${name}.${String(key)}`) });
  const noop = async () => {};
  const env = { jwtSecret: 'not-a-secret-used-only-by-integration-tests', ntfy: { baseUrl: null, token: null },
    economyEnabled: false, federation: { dmEnabled: false }, linkThreats: { enabled: false } };
  const modules = new Map<string, any>();
  const values: Record<string, unknown> = {
    'db/index': { db: t.db }, 'db/schema': schema, env: { env }, util: { id: crypto.randomUUID, uuidv7: crypto.randomUUID },
    dmWriteBarrier: { dmWriteBarrier: {} },
    channelEvents: { configureChannelBots: () => {} }, memberEvents: { configureMemberBots: () => {}, memberChanged: noop },
    'routes/serverBots': { serverBotRoutes: async () => {} },
    permissions: { getChannelAudience: fail('channel audience'), getChannelPermissions: fail('channel permissions') },
    realtime: { publishToUser: async (user: string, body: shared.GatewayServerMessage) => { events.push({ user, body: normal(body) }); },
      publishToServer: noop, redisPub: redis },
    // Rate-limit/password-lock mechanics имеют отдельные тесты; здесь ни Redis-сокета, ни live DNS.
    authGuard: { rateHit: async (key: string) => rateBlocks.get(key) ?? 0, clientIp: () => '192.0.2.1', loginLockRemaining: async () => 0,
      recordLoginFailure: async () => 0, clearLoginFailures: noop, clearLoginLock: noop, retryMessage: () => 'retry',
      messageSendBlock: async () => 0, pushBurst: async () => 'drop', pushDebounced: noop },
    gateway: { broadcastUserProfile: (userId: string, displayName: string, avatarUrl: string | null, animatedAvatarUrl: string | null) => {
      profileBroadcasts.push({ userId, displayName, avatarUrl, animatedAvatarUrl });
    }, relayBotTyping: noop, isUserDmPresent: () => false },
    // Только менеджер звонков/LiveKit заменён IO-ответом; доступ, SQL, блоки и приватность настоящие.
    calls: { callOf: () => null, startCall: async (callerId: string, calleeId: string, conversationId: string, device: string) => {
      callStarts.push({ callerId, calleeId, conversationId, device });
      return { kind: 'ok', answered: false, call: { id: 'r300-call', callerId, calleeId, conversationId } };
    }, callJoin: async (call: unknown, userId: string) => ({ call, userId }),
    act: fail('call action'), callById: fail('callById'), ping: fail('call ping') },
    attachments: { DailyQuotaError: class extends Error {}, attachmentStore: dormant('attachmentStore'),
      purgeDeletedOf: noop, purgeDeleted: noop, attachmentLink: fail('attachmentLink'), privateAttachmentsReady: fail('attachments ready'),
      copyForForward: fail('copy attachment for forward'),
      discardForwardCopies: async (ids: readonly string[]) => {
        assert.equal(ids.length, 0, 'R302 пересылка текста не требует удаления файловых копий');
      } },
    storage: { removeUserAvatars: noop, isOwnMediaUrl: () => false },
    instanceSetup: { dmPolicy: async () => 'anyone' },
    // R302: заменяем отправку, НЕ чистые реэкспорты push.js. Отсутствовавший forwardPreview
    // бросал VM TypeError после COMMIT/рассылки, а error handler раньше сериализовал его в 200 {}.
    push: { forwardPreview, pushThrottleSource, withSilent,
      sendReadSyncPush: async (...args: unknown[]) => { readSyncPushes.push(args); },
      sendPushToUsers: async (users: string[], body: unknown) => { pushes.push({ users: [...users], body: normal(body) }); } },
    linkThreats: { dangerousLinksOf: () => [] },
    'federation/instanceLabels': { instanceLabel: fail('remote label') },
    'federation/directoryEvents': { announceUser: async () => { federationCalls.push('announceUser'); } },
    'federation/guestRevocation': { revokeAccountEverywhere: async () => { federationCalls.push('revokeAccountEverywhere'); } },
    activity: { clearActivity: noop }, livekit: { removeFromOtherRooms: noop },
    gifs: { savedGifKeysOf: async () => [], removeGifFiles: noop },
    safeFetch: { hookUrlErrorEn, checkHookTarget: async (url: string, allowInternal: boolean) => {
      hookChecks.push({ url, allowInternal });
      const parsed = parseHookUrl(url, allowInternal);
      return parsed.ok ? hookTargetError : parsed.error;
    }, safeHookPost: async (url: string, body: Buffer, headers: Record<string, string>) => {
      const status = hookStatuses.shift() ?? repeatedHookStatus; assert.notEqual(status, undefined, 'каждой доставке задан синтетический ответ');
      hookRequests.push({ url, body: JSON.parse(body.toString('utf8')), raw: body.toString('utf8'), headers }); return { status };
    } },
    'bots/webhookDelivery': { kickWebhook: () => {}, resetWebhookRetry: () => {}, startBotJobs: fail('background jobs') },
  };
  for (const name of ['stickerCatalog', 'dmReports', 'scheduled', 'routes/dmFolders', 'mailer', 'settings', 'instanceFeatures', 'totp', 'audit', 'channelMessages', 'serverMembership']) values[name] = dormant(name);
  const real = new Set([
    'auth', 'guestGuard', 'conversations', 'serialize', 'contacts', 'blocks', 'lastSeen', 'db/peerQueries', 'db/userSearch',
    'messagePrivacy', 'convSendFanout', 'convGroups', 'accountDelete', 'accountRows',
    'bots/botStore', 'bots/botRules', 'bots/botUpdates', 'bots/botRead', 'bots/botWire', 'bots/botLifecycle', 'bots/webhookDelivery', 'bots/botCallback', 'bots/botChannel', 'bots/botVoice', 'routes/botPress', 'roleRules',
    'routes/att', 'routes/conv', 'routes/convGroups', 'routes/bots', 'routes/botApi', 'routes/auth', 'routes/calls', 'routes/blocks', 'callPrivacy',
    'convRules', 'dmRules', 'blockRules', 'groupRules', 'scheduleRules', 'strangerRules', 'contactRules', 'messagePrivacyRules',
    'authRules', 'superAdminRules', 'userSearchRules', 'attachmentRules', 'statusRules', 'shopRules', 'callRules', 'lastSeenRules',
    'guestGuardCore', 'webhookRules', 'accountRules', 'inviteRules', 'setupRules', 'storageRules', 'coinRules',
  ]);
  values.bigUploads = dormant('big uploads');
  // ioredis подтверждает SUBSCRIBE обещанием: новый wake.ready ждёт именно этот ответ.
  class RedisStub { on() { return this; } async subscribe() { return 1; } async unsubscribe() { return 1; } }
  const external: Record<string, unknown> = { 'node:crypto': crypto, 'drizzle-orm': orm, '@gusvoice/shared': shared,
    zod, bcryptjs: bcrypt, jsonwebtoken: jwt, ioredis: RedisStub, qrcode: dormant('QRCode') };
  function load<T>(name: string): T {
    if (Object.hasOwn(values, name)) return values[name] as T;
    if (modules.has(name)) return modules.get(name) as T;
    assert.equal(real.has(name), true, `R297 закрытый импорт ${name}`);
    let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    if (edit?.file === name) { assert.equal(source.split(edit.from).length, 2, 'R297 единственный whole-module якорь'); source = source.replace(edit.from, edit.to); }
    // Открываем ссылку на приватный WS-entrypoint, не извлекаем/не переписываем функцию.
    if (name === 'routes/botApi') source += '\nmodule.exports.__serve = serveBotSocket;\n';
    if (name === 'bots/webhookDelivery') source += '\nmodule.exports.__deliverLoop = deliverLoop;\n';
    const module = { exports: {} };
    modules.set(name, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, {
      module, exports: module.exports, Date: name === 'bots/botCallback' ? CallbackDate : Date, Map, Set, Promise, Buffer, URL, URLSearchParams, AbortController, Error,
      console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')), error: fail('console.error') },
      setTimeout: name === 'bots/botCallback'
        ? (fn: () => void, ms: number) => { const timer = { at: callbackNow + ms, fn }; callbackTimers.push(timer); return timer; }
        : name === 'bots/webhookDelivery'
        ? (_fn: () => void, ms: number) => { retryDelays.push(ms); return { unref() {} }; }
        : name === 'bots/botStore'
          ? (fn: () => void, ms: number) => {
            // Даже мгновенный SUBSCRIBE создаёт cap до своего microtask. Разрешён только этот
            // настоящий отменяемый таймер, а не произвольный IO, который код мог бы скрыть catch.
            if (ms !== 5_000) return fail('timeout')();
            return setTimeout(fn, ms);
          }
          : fail('timeout'),
      clearTimeout: name === 'bots/botStore' ? clearTimeout : () => {},
      setInterval: (fn: () => Promise<void>, ms: number) => {
        if (name === 'bots/webhookDelivery') deliveryIntervals.push({ fn, ms });
        return { unref() {} };
      }, clearInterval: () => {},
      require(id: string) {
        if (id.startsWith('.')) return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
        assert.equal(Object.hasOwn(external, id), true, `R297 внешний импорт ${id}`); return external[id];
      },
    });
    if (name === 'bots/botStore') {
      // ?offset запускает confirm без await: clean должен видеть уже начатый DELETE,
      // даже когда markTakenRead ещё не стартовал и не попал в pending.
      const store = module.exports as typeof import('../src/bots/botStore.js');
      const original = store.confirmUpdates;
      store.confirmUpdates = (...args) => track(original(...args));
    }
    if (name === 'bots/botRead') {
      // WS ack запускает цепочку без await в обработчике кадра. Наблюдаем обещание реального чтения,
      // чтобы clean ждал всей SQL-транзакции и deliver, а не удачного количества microtask-тиков.
      const read = module.exports as typeof import('../src/bots/botRead.js');
      const original = read.markTakenRead;
      read.markTakenRead = (...args) => track(original(...args));
    }
    return module.exports as T;
  }
  const auth = load<typeof import('../src/auth.js')>('auth'); auth.setSuperAdminId('admin');
  const c = load<Conv>('conversations');
  const store = load<typeof import('../src/bots/botStore.js')>('bots/botStore');
  const api = load<Api>('routes/botApi');
  const updates = load<typeof import('../src/bots/botUpdates.js')>('bots/botUpdates');
  // Учитываем обещания fire-and-forget крючков, сохраняя настоящий record/chatMember.
  const app = Fastify();
  app.decorateRequest('isMultipart', function () { return false; });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof zod.ZodError) return reply.code(400).send({ error: 'validation' });
    // VM TypeError/RangeError не instanceof host Error: Fastify иначе принимает их за обычный объект ответа.
    routeErrors.push(String((err as { message?: unknown }).message ?? err));
    return reply.code(500).send({ error: 'R302 unexpected route error', message: routeErrors.at(-1) });
  });
  await app.register(api.botApiRoutes, { prefix: '/api' });
  await app.register(load<typeof import('../src/routes/botPress.js')>('routes/botPress').botPressRoutes, { prefix: '/api' });
  await app.register(load<typeof import('../src/routes/bots.js')>('routes/bots').botRoutes, { prefix: '/api' });
  await app.register(load<typeof import('../src/routes/conv.js')>('routes/conv').convRoutes, { prefix: '/api' });
  await app.register(load<typeof import('../src/routes/convGroups.js')>('routes/convGroups').convGroupRoutes, { prefix: '/api' });
  await app.register(load<typeof import('../src/routes/auth.js')>('routes/auth').authRoutes, { prefix: '/api' });
  await app.register(load<typeof import('../src/routes/calls.js')>('routes/calls').callRoutes, { prefix: '/api' });
  await app.register(load<typeof import('../src/routes/blocks.js')>('routes/blocks').blockRoutes, { prefix: '/api' });
  await app.ready();
  c.configureBotConv({ record: ds => track(updates.recordBotUpdates(ds)),
    chatMember: (...args) => track(updates.chatMemberUpdate(...args)), enabled: async (q) => (await store.readBotSettings(q)).enabled });
  async function clean() {
    for (let i = 0; i < 12; i++) { await Promise.all([...pending]); await new Promise<void>(resolve => setImmediate(resolve)); await t.raw.query('SELECT 1'); }
    assert.deepEqual(unexpected, [], 'R297 неожиданный IO не скрыт catch');
    assert.deepEqual(warnings, [], 'R297 скрытых ошибок нет');
    assert.deepEqual(routeErrors, [], 'R302 ошибки маршрута не превращаются в успешный пустой ответ');
  }
  async function request(user: string, method: InjectOptions['method'], url: string, payload?: InjectOptions['payload']) {
    const r = await app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${auth.signToken({ sub: user, username: `r297_${user}`, gen: 0 })}` },
      ...(payload === undefined ? {} : { payload }) }); await clean(); return r;
  }
  async function bot(token: string, method: string, payload: Record<string, unknown> = {}) {
    const r = await app.inject({ method: 'POST', url: `/api/bot/v1/${method}`, headers: { authorization: `Bot ${token}` }, payload }); await clean(); return r;
  }
  async function create() {
    const r = await request('owner', 'POST', '/bots', { username: 'r297_testbot' }); assert.equal(r.statusCode, 201, r.body);
    return r.json() as shared.BotTokenResponse;
  }
  async function enable() { const r = await request('admin', 'PUT', '/admin/bots/settings', { enabled: true, creators: 'all' }); assert.equal(r.statusCode, 200, r.body); }
  async function open(id: string, user = 'owner') { const r = await request(user, 'POST', '/conv/direct', { userId: id }); assert.equal(r.statusCode, 201, r.body); return r.json().id as string; }
  async function send(cid: string, content: string) {
    const access = await c.loadAccess(cid, 'owner'); assert.ok(access);
    const sent = await c.sendMessage('owner', access, { clientId: null, content, attachments: [], replyToId: null, withheld: false, silent: false, noPreview: false });
    assert.equal(sent.kind, 'created'); if (sent.kind !== 'created') throw new Error('unreachable');
    await c.deliver(sent.delivery); await clean(); return sent.row;
  }
  async function deliverWebhook(botId: string, statuses: number[], repeatSuccess = false) {
    // Автоматические kick из маршрутов остаются IO-границей. Здесь запускается целый настоящий доставщик
    // с теми же store/read/conversations и PGlite, но без фонового планировщика или сети.
    const name = 'bots/webhookDelivery', stub = values[name];
    delete values[name];
    let delivery: WebhookDelivery;
    try { delivery = load<WebhookDelivery>(name); } finally { values[name] = stub; }
    hookStatuses = [...statuses];
    repeatedHookStatus = repeatSuccess ? 204 : undefined;
    await delivery.__deliverLoop(botId); await clean();
    assert.deepEqual(hookStatuses, [], 'все синтетические ответы использованы');
    return delivery;
  }
  async function startDeliveryJobs() {
    const name = 'bots/webhookDelivery', stub = values[name]; delete values[name];
    try { load<WebhookDelivery>(name).startBotJobs(); } finally { values[name] = stub; }
    await clean();
  }
  return { app, clean, request, bot, create, enable, open, send, store, c, api, load, events, password, passwordHash,
    deliverWebhook, hookRequests, retryDelays, hookChecks, profileBroadcasts, callStarts, redis, rateBlocks, callbackTimers, pushes, federationCalls,
    startDeliveryJobs, deliveryIntervals, deliveryLocks,
    async advanceCallback(ms: number) {
      const end = callbackNow + ms;
      for (;;) {
        const next = callbackTimers.sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        callbackTimers.shift(); callbackNow = next.at; next.fn(); await clean();
      }
      callbackNow = end; await clean();
    },
    setHookTargetError(error: string | null) { hookTargetError = error; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function run(body: (f: Fixture) => Promise<void>, edit?: Edit) {
  const f = await fixture(edit); try { await body(f); } finally { try { await f.clean(); } finally { await f.app.close(); } }
}
async function ready(f: Fixture) { await f.enable(); const b = await f.create(); const cid = await f.open(b.bot.id); await f.store.dropUpdates(b.bot.id); return { ...b, cid }; }

async function summaryTransaction304(edit?: Edit) {
  await run(async f => {
    await f.enable(); const b = await f.create();
    // Не открываем через HTTP до установки наблюдателя: мутант должен упасть на потере q,
    // а не повесить единственное соединение PGlite ещё в setup.
    await t.db.insert(schema.conversations).values({ id: 'r304-summary', kind: 'direct', directKey: [b.bot.id, 'owner'].sort().join(':'), createdBy: 'owner' });
    await t.db.insert(schema.conversationMembers).values(['owner', b.bot.id].map(userId => ({ conversationId: 'r304-summary', userId })));
    const hooks = f.c.botConv(); assert.ok(hooks);
    let calls = 0;
    f.c.configureBotConv({ ...hooks, enabled: async q => {
      calls++;
      // Отказ ДО обращения к свободному db не позволяет негативной пробе взаимно заблокировать базу.
      assert.equal(!!q && !Object.is(q, t.db), true, 'R304 сводка передаёт свою транзакцию настройке ботов');
      return (await f.store.readBotSettings(q)).enabled;
    } });
    const result = await f.c.listConversations('owner');
    assert.equal(result.conversations.length, 1); assert.equal(result.conversations[0].id, 'r304-summary');
    assert.equal(result.conversations[0].otherUser?.bot, true); assert.equal(calls, 1);
    // Соединение освобождено, а вызов — не замена SQL константным ответом.
    await t.raw.query('SELECT 1');
  }, edit);
}
test('R304 список ЛС с ботом читает настройки в своей SQL-транзакции и освобождает PGlite', () => summaryTransaction304());
test('R304 контрфакт enabled без q ловится до вложенного SQL, а не зависанием файла', async () => {
  await summaryTransaction304();
  await assert.rejects(summaryTransaction304({ file: 'conversations', from: 'botConvHooks?.enabled(q)', to: 'botConvHooks?.enabled()' }),
    (error: unknown) => error instanceof assert.AssertionError && error.code === 'ERR_ASSERTION' && error.operator === 'strictEqual'
      && error.message.split(/\r?\n/, 1)[0] === 'R304 сводка передаёт свою транзакцию настройке ботов'
      && error.actual === false && error.expected === true);
});
// Композиция настоящего HTTP-маршрута с настоящим closeBotSockets: наблюдаем закрытие уже подключённого потребителя,
// не подменяем сам closeBotSockets spy-функцией. Его ветка пробуждения poll отдельно исполняется в botApi.wake.test.ts.
async function closesConsumer<T>(f: Fixture, token: string, code: number, reason: string, action: () => Promise<T>): Promise<T> {
  const handlers = new Map<string, (...args: any[]) => void>(), closes: Array<{ code?: number; reason?: string }> = [];
  const frames: Array<{ op: string }> = [];
  let readyState = 1;
  const socket: Socket & { readonly readyState: number } = {
    get readyState() { return readyState; },
    send(raw) { frames.push(JSON.parse(raw)); }, on(event, handler) { handlers.set(event, handler); },
    close(code, reason) { if (readyState === 3) return; readyState = 3; closes.push({ code, reason }); handlers.get('close')?.(); },
  };
  try {
    await f.api.__serve(socket, { headers: { authorization: `Bot ${token}` }, query: {}, ip: '192.0.2.1' });
    assert.equal(frames[0]?.op, 'hello', 'потребитель подключён до HTTP-операции');
    const result = await action();
    assert.deepEqual(closes, [{ code, reason }], `HTTP вызывает настоящий отзыв потребителя: ${reason}`);
    return result;
  } finally { socket.close(); await f.clean(); }
}
const cursor = async (botId: string, cid: string) => (await t.db.select().from(schema.conversationMembers).where(orm.and(
  orm.eq(schema.conversationMembers.userId, botId), orm.eq(schema.conversationMembers.conversationId, cid))))[0].lastReadKey;

const markup301 = { inline_keyboard: [[{ text: 'Статус', callback_data: 'status' }, { text: 'Сайт', url: 'https://example.test' }]] };
const replacement301 = { inline_keyboard: [[{ text: 'Перезапуск', callback_data: 'restart' }]] };
async function panel301(f: Fixture) {
  const b = await ready(f);
  const r = await f.bot(b.token, 'sendMessage', { chat_id: b.cid, text: 'Панель', reply_markup: markup301 });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().result.reply_markup, markup301);
  return { ...b, mid: r.json().result.message_id as string };
}
async function message301(mid: string) {
  return (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, mid)))[0];
}
async function editText301(f: Fixture, supplied: boolean) {
  const b = await panel301(f);
  const r = await f.bot(b.token, 'editMessageText', { chat_id: b.cid, message_id: b.mid, text: 'Новый текст',
    ...(supplied ? { reply_markup: replacement301 } : {}) });
  assert.equal(r.statusCode, 200, r.body);
  const row = await message301(b.mid);
  assert.equal(isDeepStrictEqual(row.keyboard, supplied ? replacement301.inline_keyboard : null), true,
    supplied ? 'R301-edit: переданная клавиатура заменяет старую' : 'R301-edit: пропущенная клавиатура снята');
  assert.deepEqual(r.json().result.reply_markup, supplied ? replacement301 : undefined);
  assert.equal(row.content, 'Новый текст'); assert.ok(row.editedAt); assert.ok(row.editVersion > 0);
}
async function editKeyboard301(f: Fixture) {
  const b = await panel301(f), before = await message301(b.mid), start = f.events.length;
  const r = await f.bot(b.token, 'editMessageReplyMarkup', { chat_id: b.cid, message_id: b.mid, reply_markup: replacement301 });
  assert.equal(r.statusCode, 200, r.body); assert.deepEqual(r.json().result.reply_markup, replacement301);
  const row = await message301(b.mid);
  assert.equal(row.editedAt?.toISOString() ?? null, before.editedAt?.toISOString() ?? null, 'R301-markup: дата правки текста не меняется');
  assert.equal(row.editVersion, before.editVersion); assert.equal(row.content, before.content);
  assert.deepEqual(row.keyboard, replacement301.inline_keyboard);
  const changes = f.events.slice(start).filter(e => e.user === 'owner' && e.body.t === 'conv.change');
  assert.equal(changes.length, 1);
  const change = changes[0].body; assert.ok(change.t === 'conv.change');
  assert.equal(JSON.stringify(change).includes('restart'), true, 'новые кнопки пришли человеку в conv.change');
  const count = f.events.length;
  assert.equal((await f.bot(b.token, 'editMessageReplyMarkup', { chat_id: b.cid, message_id: b.mid, reply_markup: replacement301 })).statusCode, 200);
  assert.equal(f.events.length, count, 'идемпотентная правка не рассылается повторно');
  const removed = await f.bot(b.token, 'editMessageReplyMarkup', { chat_id: b.cid, message_id: b.mid });
  assert.equal(removed.statusCode, 200); assert.equal(removed.json().result.reply_markup, undefined);
  assert.equal((await message301(b.mid)).keyboard, null);
}

test('R301 sendMessage сохраняет кнопки в SQL и проводе; без кнопок колонка NULL', async () => run(async f => {
  const b = await panel301(f);
  assert.deepEqual((await message301(b.mid)).keyboard, markup301.inline_keyboard);
  const view = await f.c.messageFor(b.mid, b.bot.id); assert.ok(view && !('gone' in view));
  assert.deepEqual(normal(view.keyboard), markup301.inline_keyboard);
  const wire = f.load<typeof import('../src/bots/botWire.js')>('bots/botWire').toWireMessage(view);
  assert.deepEqual(normal(wire.reply_markup), markup301);
  const plain = await f.bot(b.token, 'sendMessage', { chat_id: b.cid, text: 'Без кнопок' });
  assert.equal(plain.statusCode, 200); assert.equal(plain.json().result.reply_markup, undefined);
  assert.equal((await message301(plain.json().result.message_id)).keyboard, null);
}));
test('R301 правка текста без reply_markup снимает кнопки', async () => run(f => editText301(f, false)));
test('R301 правка текста с reply_markup заменяет кнопки', async () => run(f => editText301(f, true)));
test('R301 правка только кнопок без отметки изменения, с рассылкой, повтором и снятием', async () => run(editKeyboard301));
test('R301 бот не правит клавиатуру человеческого или чужого сообщения', async () => run(async f => {
  const b = await panel301(f), human = await f.send(b.cid, 'От человека');
  const other = await f.request('owner', 'POST', '/bots', { username: 'r301_otherbot' }); assert.equal(other.statusCode, 201);
  const cid = await f.open(other.json().bot.id);
  const foreign = await f.bot(other.json().token, 'sendMessage', { chat_id: cid, text: 'Другой бот', reply_markup: markup301 });
  assert.equal(foreign.statusCode, 200);
  for (const mid of [human.id, foreign.json().result.message_id]) {
    const r = await f.bot(b.token, 'editMessageReplyMarkup', { chat_id: b.cid, message_id: mid, reply_markup: replacement301 });
    assert.equal(r.statusCode, 400, r.body);
  }
  assert.equal((await message301(human.id)).keyboard, null);
  assert.deepEqual((await message301(foreign.json().result.message_id)).keyboard, markup301.inline_keyboard);
}));
test('R301 команды замещаются, читаются, удаляются; карточка скрыта постороннему и выключенному боту', async () => run(async f => {
  const b = await ready(f), first = [{ command: 'start', description: 'Старт' }, { command: 'status', description: 'Статус' }];
  assert.deepEqual((await f.bot(b.token, 'setMyCommands', { commands: first })).json(), { ok: true, result: true });
  assert.deepEqual((await f.bot(b.token, 'getMyCommands')).json().result, first);
  const next = [{ command: 'help', description: 'Помощь' }];
  assert.equal((await f.bot(b.token, 'setMyCommands', { commands: next, scope: { type: 'all_private_chats' } })).statusCode, 200);
  assert.deepEqual((await f.bot(b.token, 'getMyCommands', { scope: { type: 'default' } })).json().result, first);
  assert.deepEqual((await f.bot(b.token, 'getMyCommands', { scope: { type: 'all_private_chats' } })).json().result, next);
  const info = await f.request('owner', 'GET', `/conv/${b.cid}/bot`); assert.equal(info.statusCode, 200);
  assert.deepEqual(info.json().commands, next); assert.ok(info.json().commandsUpdatedAt);
  assert.equal((await f.request('other', 'GET', `/conv/${b.cid}/bot`)).statusCode, 404);
  assert.deepEqual((await f.bot(b.token, 'deleteMyCommands')).json(), { ok: true, result: true });
  assert.deepEqual((await f.bot(b.token, 'getMyCommands')).json().result, []);
  await f.bot(b.token, 'setMyCommands', { commands: next });
  assert.equal((await f.bot(b.token, 'setMyCommands', { commands: [] })).statusCode, 200);
  assert.deepEqual((await f.bot(b.token, 'getMyCommands')).json().result, []);
  await f.bot(b.token, 'setMyCommands', { commands: next });
  await t.db.update(schema.bots).set({ disabledAt: new Date() }).where(orm.eq(schema.bots.userId, b.bot.id));
  for (const method of ['setMyCommands', 'getMyCommands', 'deleteMyCommands']) assert.equal((await f.bot(b.token, method, { commands: next })).statusCode, 401);
  assert.deepEqual((await f.request('owner', 'GET', `/conv/${b.cid}/bot`)).json().commands, []);
  await t.db.update(schema.bots).set({ disabledAt: null }).where(orm.eq(schema.bots.userId, b.bot.id));
  await f.request('admin', 'PUT', '/admin/bots/settings', { enabled: false });
  for (const method of ['setMyCommands', 'getMyCommands', 'deleteMyCommands']) assert.equal((await f.bot(b.token, method, { commands: next })).statusCode, 403);
  assert.deepEqual((await f.request('owner', 'GET', `/conv/${b.cid}/bot`)).json().commands, []);
}));

async function startPress301(f: Fixture, b: { cid: string; mid: string }, data = 'status', user = 'owner') {
  let settled = false;
  const timersBefore = f.callbackTimers.length;
  const response = f.request(user, 'POST', `/conv/${b.cid}/messages/${b.mid}/callback`, { data }).then(r => { settled = true; return r; });
  // Ожидаем наблюдаемую границу настоящего waitCallbackAnswer, не произвольную паузу.
  for (let i = 0; i < 30 && !settled && f.callbackTimers.length <= timersBefore; i++) await f.clean();
  assert.ok(settled || f.callbackTimers.length > timersBefore, 'нажатие дошло до ответа либо ожидания Redis');
  return { response, settled: () => settled };
}
async function callbackRecord301(f: Fixture, botId: string) {
  const rows = await f.store.updatesFrom(botId, 0, 100, ['callback_query']);
  assert.equal(rows.length, 1);
  return rows[0].payload as { id: string; from: Record<string, unknown>; message: Record<string, any>; data: string; date: number };
}
async function stalePress301(f: Fixture) {
  const b = await panel301(f), press = await startPress301(f, b, 'removed');
  // Контрфакт пропуска проверки дошёл бы до ожидания: доводим его до исхода, не оставляем висящую ручку.
  if (!press.settled()) await f.advanceCallback(15_000);
  const r = await press.response;
  assert.equal(r.statusCode, 409, 'R301-stale: произвольных данных нет в очереди');
  assert.deepEqual(r.json(), { error: 'stale_button' });
  assert.equal(await f.store.pendingCount(b.bot.id), 0);
}
async function callbackAnswer301(f: Fixture, foreignFirst = false) {
  const b = await panel301(f), press = await startPress301(f, b);
  try {
    assert.equal(press.settled(), false, 'человеческий HTTP ждёт ответ бота');
    const query = await callbackRecord301(f, b.bot.id);
    assert.match(query.id, /^cbq_[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(query.from, { id: 'owner', username: 'r297_owner', display_name: 'owner', bot: false });
    assert.equal(query.message.message_id, b.mid); assert.equal(query.message.chat.id, b.cid);
    assert.deepEqual(query.message.reply_markup, markup301); assert.equal(query.data, 'status');
    assert.equal(Number.isInteger(query.date), true);
    assert.equal((await f.bot(b.token, 'getUpdates')).json().result[0].callback_query.id, query.id);
    if (foreignFirst) {
      const other = await f.request('owner', 'POST', '/bots', { username: 'r301_foreignbot' }); assert.equal(other.statusCode, 201);
      const denied = await f.bot(other.json().token, 'answerCallbackQuery', { callback_query_id: query.id, text: 'Чужой ответ' });
      assert.equal(denied.statusCode, 400, 'R301-owner: другой бот не отвечает на чужой запрос');
      assert.match(denied.json().description, /query is too old and response timeout expired or query id is invalid/);
    }
    const answer = await f.bot(b.token, 'answerCallbackQuery', { callback_query_id: query.id, text: 'Готово', show_alert: true });
    assert.deepEqual(answer.json(), { ok: true, result: true });
    await f.advanceCallback(250);
    const r = await press.response; assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), { text: 'Готово', alert: true });
    for (const id of [query.id, 'cbq_missing']) {
      const duplicate = await f.bot(b.token, 'answerCallbackQuery', { callback_query_id: id });
      assert.equal(duplicate.statusCode, 400); assert.match(duplicate.json().description, /query is too old and response timeout expired or query id is invalid/);
    }
    assert.equal(await f.redis.get('bot:cbqn:u:owner'), '0'); assert.equal(await f.redis.get(`bot:cbqn:b:${b.bot.id}`), '0');
  } finally { if (!press.settled()) await f.advanceCallback(15_000); await press.response; }
}
test('R301 старые и подставленные данные кнопки получают 409 без события боту', async () => run(stalePress301));
test('R301 настоящий callback_query содержит нажавшего и кнопки, ответ возвращён HTTP с alert, повтор запрещён', async () => run(f => callbackAnswer301(f)));
test('R301 другой бот получает 400 и не съедает запрос, владелец отвечает после него', async () => run(f => callbackAnswer301(f, true)));
test('R301 два нажавших получают только свой HTTP-ответ: текст без alert и тихий ответ, без рассылки устройствам', async () => run(async f => {
  const b = await panel301(f);
  assert.equal((await f.request('owner', 'PATCH', `/bots/${b.bot.id}`, { public: true })).statusCode, 200);
  const cid = await f.open(b.bot.id, 'other');
  const sent = await f.bot(b.token, 'sendMessage', { chat_id: cid, text: 'Другая панель', reply_markup: markup301 });
  assert.equal(sent.statusCode, 200);
  await f.store.dropUpdates(b.bot.id);
  const first = await startPress301(f, b), second = await startPress301(f, { cid, mid: sent.json().result.message_id }, 'status', 'other');
  try {
    const rows = await f.store.updatesFrom(b.bot.id, 0, 100, ['callback_query']); assert.equal(rows.length, 2);
    const queries = rows.map(r => r.payload as { id: string; from: { id: string } });
    const owner = queries.find(q => q.from.id === 'owner'), other = queries.find(q => q.from.id === 'other'); assert.ok(owner && other);
    const eventCount = f.events.length;
    assert.equal((await f.bot(b.token, 'answerCallbackQuery', { callback_query_id: other.id, text: 'Только другому' })).statusCode, 200);
    await f.advanceCallback(250);
    assert.equal(first.settled(), false); assert.deepEqual((await second.response).json(), { text: 'Только другому' });
    assert.equal((await f.bot(b.token, 'answerCallbackQuery', { callback_query_id: owner.id })).statusCode, 200);
    await f.advanceCallback(250); assert.deepEqual((await first.response).json(), {});
    assert.equal(f.events.length, eventCount, 'ответ callback не уходит в пользовательскую WS-рассылку');
  } finally { await f.advanceCallback(15_000); await Promise.all([first.response, second.response]); }
}));
test('R301 без ответа нажатие ждёт 14999 мс и возвращает timeout ровно через 15 секунд', async () => run(async f => {
  const b = await panel301(f), press = await startPress301(f, b);
  await f.advanceCallback(14_999); assert.equal(press.settled(), false);
  await f.advanceCallback(1); const r = await press.response;
  assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), { timeout: true });
  assert.equal(await f.redis.get('bot:cbqn:u:owner'), '0'); assert.equal(await f.redis.get(`bot:cbqn:b:${b.bot.id}`), '0');
}));
test('R301 нажатие не участником, на человеческом сообщении, с мусором или выключенным ботом отклоняется до очереди', async () => run(async f => {
  const b = await panel301(f), human = await f.send(b.cid, 'Не кнопки'); await f.store.dropUpdates(b.bot.id);
  const url = `/conv/${b.cid}/messages/${b.mid}/callback`;
  assert.equal((await f.request('other', 'POST', url, { data: 'status' })).statusCode, 404);
  assert.equal((await f.request('owner', 'POST', `/conv/${b.cid}/messages/${human.id}/callback`, { data: 'status' })).statusCode, 400);
  for (const data of [null, 1, '', 'я'.repeat(33)]) assert.equal((await f.request('owner', 'POST', url, { data })).statusCode, 400);
  await t.db.update(schema.bots).set({ disabledAt: new Date() }).where(orm.eq(schema.bots.userId, b.bot.id));
  assert.equal((await f.request('owner', 'POST', url, { data: 'status' })).statusCode, 403);
  await t.db.update(schema.bots).set({ disabledAt: null }).where(orm.eq(schema.bots.userId, b.bot.id));
  await f.request('admin', 'PUT', '/admin/bots/settings', { enabled: false });
  assert.equal((await f.request('owner', 'POST', url, { data: 'status' })).statusCode, 403);
  assert.equal(await f.store.pendingCount(b.bot.id), 0);
}));
test('R301 лимит частоты человека и бота даёт 429 с Retry-After и не пишет событие', async () => run(async f => {
  const b = await panel301(f);
  for (const key of ['cbq:owner', `cbqbot:${b.bot.id}`]) {
    f.rateBlocks.set(key, 7);
    const r = await f.request('owner', 'POST', `/conv/${b.cid}/messages/${b.mid}/callback`, { data: 'status' });
    assert.equal(r.statusCode, 429); assert.equal(r.headers['retry-after'], '7'); assert.equal(r.json().retryAfter, 7);
    f.rateBlocks.delete(key);
  }
  assert.equal(await f.store.pendingCount(b.bot.id), 0);
}));
test('R301 занятые места человека и бота дают 429; отказ бота освобождает место человека', async () => run(async f => {
  const b = await panel301(f);
  for (const [key, max] of [['u:owner', 3], [`b:${b.bot.id}`, 20]] as const) {
    await f.redis.set(`bot:cbqn:${key}`, String(max));
    const r = await f.request('owner', 'POST', `/conv/${b.cid}/messages/${b.mid}/callback`, { data: 'status' });
    assert.equal(r.statusCode, 429); assert.equal(r.headers['retry-after'], '5');
    assert.equal(await f.redis.get(`bot:cbqn:${key}`), String(max), 'отклонённое нажатие не занимает место');
    if (key.startsWith('b:')) assert.equal(await f.redis.get('bot:cbqn:u:owner'), '0');
    await f.redis.del(`bot:cbqn:${key}`);
  }
  assert.equal(await f.store.pendingCount(b.bot.id), 0);
}));

async function staleQueue301(f: Fixture) {
  const b = await ready(f), message = await f.send(b.cid, 'Сообщение не протухает за минуту');
  const [oldMessage] = await f.store.updatesFrom(b.bot.id, 0, 100);
  const expired = await f.store.pushUpdate(b.bot.id, 'callback_query', { id: 'expired', data: 'restart' });
  const fresh = await f.store.pushUpdate(b.bot.id, 'callback_query', { id: 'fresh', data: 'status' });
  await t.db.update(schema.botUpdates).set({ createdAt: orm.sql`now() - interval '26 seconds'` })
    .where(orm.inArray(schema.botUpdates.updateId, [oldMessage.updateId, expired]));
  return { ...b, oldMessage: oldMessage.updateId, expired, fresh, message };
}
async function staleFilter301(f: Fixture) {
  const b = await staleQueue301(f);
  const rows = await f.store.updatesFrom(b.bot.id, 0, 100);
  assert.equal(rows.some(r => r.updateId === b.expired), false, 'R301-TTL: протухшее нажатие не выдаётся');
  assert.deepEqual(rows.map(r => r.updateId), [b.oldMessage, b.fresh]);
  assert.equal(await f.store.pendingCount(b.bot.id), 2);
  assert.deepEqual((await f.store.updatesFrom(b.bot.id, 0, 100, ['callback_query'])).map(r => r.updateId), [b.fresh]);
  return b;
}
test('R303 очередь скрывает callback старше 25 с, сохраняя свежий callback и старое сообщение', async () => run(async f => { await staleFilter301(f); }));
test('R303 граница SQL ровно 25 секунд включена, 25001 мс исключена; prune удаляет только протухшее нажатие', async () => run(async f => {
  const b = await ready(f);
  // now() фиксируется PostgreSQL на BEGIN: проверка точной границы не зависит от скорости CPU/CI.
  await t.raw.exec('BEGIN');
  try {
    const ids: number[] = [];
    for (const [type, age] of [['callback_query', 25_000], ['callback_query', 25_001], ['message', 25_001]] as const) {
      const [row] = await t.db.insert(schema.botUpdates).values({ botId: b.bot.id, type, payload: { marker: age },
        createdAt: orm.sql`now() - (${age} * interval '1 millisecond')` }).returning(); ids.push(row.updateId);
    }
    assert.deepEqual((await f.store.updatesFrom(b.bot.id, 0, 100)).map(r => r.updateId), [ids[0], ids[2]]);
    const time = await t.raw.query<{ now: Date }>('SELECT now() AS now');
    assert.equal(await f.store.pruneBotUpdates(new Date(time.rows[0].now).getTime()), 1);
    assert.deepEqual((await t.db.select().from(schema.botUpdates).orderBy(schema.botUpdates.updateId)).map(r => r.updateId), [ids[0], ids[2]]);
  } finally { await t.raw.exec('COMMIT'); }
}));
for (const transport of ['getUpdates', 'WS', 'webhook'] as const) test(`R301 ${transport} выдаёт свежую кнопку и старое сообщение, но не протухшую кнопку`, async () => run(async f => {
  const b = await staleQueue301(f);
  let ids: number[];
  if (transport === 'getUpdates') {
    const response = await f.bot(b.token, 'getUpdates'); assert.equal(response.statusCode, 200);
    ids = response.json().result.map((r: { update_id: number }) => r.update_id);
  } else if (transport === 'WS') {
    const frames: any[] = [], handlers = new Map<string, (...args: any[]) => void>();
    const socket: Socket = { send: data => frames.push(JSON.parse(data)), close: () => handlers.get('close')?.(), on: (event, cb) => { handlers.set(event, cb); } };
    try {
      await f.api.__serve(socket, { headers: { authorization: `Bot ${b.token}` }, query: {}, ip: '192.0.2.1' }); await f.clean();
      ids = frames.filter(x => x.op === 'update').map(x => x.update.update_id);
    } finally { socket.close(); }
  } else {
    await t.db.update(schema.bots).set({ webhookUrl: 'https://bot.example.test/r301', webhookSecret: 'synthetic-r301-hook' }).where(orm.eq(schema.bots.userId, b.bot.id));
    await f.deliverWebhook(b.bot.id, [200, 200]); ids = f.hookRequests.map(r => r.body.update_id);
  }
  assert.deepEqual(ids, [b.oldMessage, b.fresh]);
}));
test('R301 пересылка и копия сообщения бота сохраняют текст, но не клавиатуру ни в SQL, ни в DTO', async () => run(async f => {
  const b = await panel301(f), target = await f.open('other');
  for (const hideSender of [false, true]) {
    const pushStart = f.pushes.length;
    const r = await f.request('owner', 'POST', `/conv/${target}/forward`, {
      clientId: crypto.randomUUID(), fromConversationId: b.cid, messageIds: [b.mid], hideSender,
    });
    assert.equal(r.statusCode, 201, r.body); assert.equal(r.json().messages.length, 1);
    const message = r.json().messages[0]; assert.equal(message.content, 'Панель'); assert.equal(message.keyboard, undefined);
    assert.equal((await message301(message.id)).keyboard, null);
    assert.equal(!!message.forwardedFrom, !hideSender);
    assert.deepEqual(f.pushes.slice(pushStart), [{ users: ['other'], body: { type: 'dm', title: 'owner', body: '↪ Панель', dmId: target } }],
      'R302 пересылка действительно проходит ветку пуша с настоящим forwardPreview');
  }
  assert.deepEqual((await message301(b.mid)).keyboard, markup301.inline_keyboard, 'оригинал не повреждён пересылкой');
}));

test('R297 без настройки боты выключены: список доступен, создание/API запрещены, журнал не растёт', async () => run(async f => {
  const list = await f.request('owner', 'GET', '/bots'); assert.equal(list.statusCode, 200); assert.equal(list.json().enabled, false); assert.equal(list.json().canCreate, false);
  assert.equal((await f.request('owner', 'POST', '/bots', { username: 'r297_newbot' })).statusCode, 403);
  const b = await ready(f); await t.db.delete(schema.instanceSettings);
  const me = await f.bot(b.token, 'getMe'); assert.equal(me.statusCode, 403);
  assert.deepEqual(me.json(), { ok: false, error_code: 403, description: 'Forbidden: bots are disabled on this instance' });
  await f.send(b.cid, 'Не копить события'); assert.equal(await f.store.pendingCount(b.bot.id), 0);
}));

test('R297 частичный PUT тумблера сохраняет creators, лимит и внутренние адреса', async () => run(async f => {
  const settings = { creators: 'approved', perUserLimit: 7, allowInternalWebhooks: true, enabled: true };
  assert.deepEqual((await f.request('admin', 'PUT', '/admin/bots/settings', settings)).json(), settings);
  const b = await f.create();
  const switched = await closesConsumer(f, b.token, 4003, 'bots disabled', () => f.request('admin', 'PUT', '/admin/bots/settings', { enabled: false }));
  assert.deepEqual(switched.json(), { ...settings, enabled: false });
  assert.deepEqual((await f.request('admin', 'PUT', '/admin/bots/settings', { perUserLimit: 0 })).json(), { ...settings, enabled: false, perUserLimit: 0 });
}));

test('R297 ник без bot отклонён, допустимый создаётся, занятый без регистра получает 409', async () => run(async f => {
  await f.enable(); assert.equal((await f.request('owner', 'POST', '/bots', { username: 'r297_plain' })).statusCode, 400);
  const b = await f.create();
  assert.equal((await f.request('owner', 'POST', '/bots', { username: 'R297_TESTBOT' })).statusCode, 409);
  const [u] = await t.db.select().from(schema.users).where(orm.eq(schema.users.id, b.bot.id));
  assert.equal(u.bot, true); assert.equal(u.verified, true); assert.equal(u.hiddenFromPeers, true); assert.equal(u.email, null); assert.ok(u.approvedAt);
  assert.equal(await bcrypt.compare(f.password, u.passwordHash), false);
}));

async function privateBot(f: Fixture) {
  await f.enable(); const b = await f.create();
  const search = f.load<typeof import('../src/db/userSearch.js')>('db/userSearch');
  assert.deepEqual(normal(await search.searchLocalUsers('other', 'r297_testbot')), []);
  assert.equal((await search.searchLocalUsers('owner', 'r297_testbot'))[0]?.bot, true);
  const denied = await f.request('other', 'POST', '/conv/direct', { userId: b.bot.id });
  assert.equal(denied.statusCode, 403, 'R297-private: чужой не открывает приватного бота');
  assert.equal(denied.json().error, 'Этот бот доступен только своему владельцу');
  await f.open(b.bot.id);
  const visible = await f.request('owner', 'PATCH', `/bots/${b.bot.id}`, { public: true }); assert.equal(visible.statusCode, 200);
  assert.equal((await search.searchLocalUsers('other', 'r297_testbot'))[0]?.bot, true);
  await f.open(b.bot.id, 'other');
}
test('R297 приватный бот скрыт чужому, владелец открывает; публичный находится и открывается чужим', async () => run(privateBot));

test('R297 автор вебхука не становится собеседником даже при включённых ботах', async () => run(async f => {
  await f.enable(); const r = await f.request('owner', 'POST', '/conv/direct', { userId: 'webhook' });
  assert.equal(r.statusCode, 403); assert.deepEqual(r.json(), { error: 'Это вебхук — ему нельзя написать' });
  const b = await f.create(); await f.open(b.bot.id);
}));

async function serializeAuthors(f: Fixture) {
  const b = await ready(f); await f.send(b.cid, '/start');
  const poll = await f.bot(b.token, 'getUpdates'); assert.equal(poll.statusCode, 200); assert.equal(poll.json().result[0].message.text, '/start');
  const sent = await f.bot(b.token, 'sendMessage', { chat_id: b.cid, text: 'Синтетический ответ' }); assert.equal(sent.statusCode, 200, sent.body);
  const mid = sent.json().result.message_id as string;
  const view = await f.c.messageFor(mid, 'owner'); assert.ok(view && !('gone' in view));
  assert.equal(view.author.bot, true); assert.equal(sent.json().result.from.bot, true);
  const messageEvents = f.events.filter(e => e.user === 'owner' && e.body.t === 'conv.change' && 'message' in e.body && e.body.message?.id === mid);
  assert.equal(messageEvents.length, 1, 'человек получил один настоящий conv.change с ответом');
  // Тот же сериализатор на неподтверждённом авторе вебхука: bot=true у users ещё не делает его настоящим ботом.
  await t.db.insert(schema.conversationMessages).values({ id: 'webhook-message', conversationId: b.cid, authorId: 'webhook', sortKey: 50, content: 'Вебхук' });
  const hook = await f.c.messageFor('webhook-message', 'owner'); assert.ok(hook && !('gone' in hook));
  assert.equal(Object.hasOwn(hook.author, 'bot'), false, 'R297-verified: вебхук не помечен настоящим ботом');
}
test('R297 getUpdates отдаёт входящее, sendMessage пишет ответ с author.bot, вебхук без значка', async () => run(serializeAuthors));

async function ownActor(f: Fixture) {
  const b = await ready(f); const first = await f.send(b.cid, 'Удалить действием бота');
  await f.store.dropUpdates(b.bot.id);
  const removed = await f.bot(b.token, 'deleteMessage', { chat_id: b.cid, message_id: first.id }); assert.equal(removed.statusCode, 200, removed.body);
  // Автор здесь человек: без actor-фильтра message_deleted вернётся боту, хотя удалял он сам.
  assert.equal(await f.store.pendingCount(b.bot.id), 0, 'R297-actor: собственное удаление не эхо');
  const second = await f.send(b.cid, 'Удалить действием человека'); await f.store.dropUpdates(b.bot.id);
  const access = await f.c.loadAccess(b.cid, 'owner'); assert.ok(access);
  const res = await f.c.deleteMessage('owner', access, second.id, 'both');
  if (res.kind !== 'ok') assert.fail(`удаление человеком: ${res.kind}`); assert.ok(res.delivery);
  await f.c.deliver({ ...res.delivery, actor: 'owner' }); await f.clean();
  const rows = await f.store.updatesFrom(b.bot.id, 0, 100); assert.equal(rows.length, 1); assert.equal(rows[0].type, 'message_deleted');
}
test('R297 удаление ботом чужого сообщения не эхо, удаление человеком попадает в журнал', async () => run(ownActor));

test('R297 offset подтверждает только меньшие id, allowed_updates отбирает вид и оставляет чужой журнал', async () => run(async f => {
  const b = await ready(f); const one = await f.send(b.cid, 'Первое');
  const access = await f.c.loadAccess(b.cid, 'owner'); assert.ok(access);
  const edited = await f.c.editMessage('owner', access, one.id, 'Правка');
  if (edited.kind !== 'ok') assert.fail(`правка человеком: ${edited.kind}`); assert.ok(edited.delivery);
  await f.c.deliver({ ...edited.delivery, actor: 'owner' }); await f.clean();
  const rows = await f.store.updatesFrom(b.bot.id, 0, 100); assert.deepEqual(rows.map(r => r.type), ['message', 'edited_message']);
  const filtered = await f.bot(b.token, 'getUpdates', { allowed_updates: ['edited_message'] });
  assert.equal(filtered.statusCode, 200); assert.deepEqual(filtered.json().result.map((r: any) => r.update_id), [rows[1].updateId]);
  assert.equal(await cursor(b.bot.id, b.cid), 0, 'правка не считается прочтением message');
  const second = await f.request('other', 'POST', '/bots', { username: 'r297_secondbot' }); assert.equal(second.statusCode, 201);
  const otherId = second.json().bot.id as string;
  await f.store.pushUpdate(otherId, 'my_chat_member', { marker: 'чужой журнал' });
  const ack = await f.bot(b.token, 'getUpdates', { offset: rows[1].updateId, allowed_updates: ['edited_message'] });
  assert.equal(ack.statusCode, 200); assert.deepEqual(ack.json().result.map((r: any) => r.update_id), [rows[1].updateId]);
  assert.equal(await f.store.pendingCount(b.bot.id), 1); assert.equal(await f.store.pendingCount(otherId), 1);
  await f.bot(b.token, 'getUpdates', { offset: rows[1].updateId + 1 }); assert.equal(await f.store.pendingCount(b.bot.id), 0);
}));

test('R297 getUpdates сортирует настоящие SQL-строки по update_id до применения limit', async () => run(async f => {
  const b = await ready(f);
  // Физический порядок специально отличается от update_id: проверка не зависит от привычного SERIAL-вставления.
  await t.db.insert(schema.botUpdates).values([
    { botId: b.bot.id, updateId: 90, type: 'my_chat_member', payload: { new_status: 'left' } },
    { botId: b.bot.id, updateId: 10, type: 'my_chat_member', payload: { new_status: 'member' } },
    { botId: b.bot.id, updateId: 50, type: 'my_chat_member', payload: { new_status: 'left' } },
  ]);
  const r = await f.bot(b.token, 'getUpdates', { limit: 2 }); assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().result, [
    { update_id: 10, my_chat_member: { new_status: 'member' } },
    { update_id: 50, my_chat_member: { new_status: 'left' } },
  ]);
  const next = await f.bot(b.token, 'getUpdates', { offset: 51, limit: 2 }); assert.equal(next.statusCode, 200);
  assert.deepEqual(next.json().result, [{ update_id: 90, my_chat_member: { new_status: 'left' } }]);
}));

async function conflict(f: Fixture) {
  const b = await ready(f); await f.send(b.cid, 'Ждёт доставки');
  await t.db.update(schema.bots).set({ webhookUrl: 'https://bot.example.test/hook', webhookSecret: 'synthetic-only' }).where(orm.eq(schema.bots.userId, b.bot.id));
  const r = await f.bot(b.token, 'getUpdates'); assert.equal(r.statusCode, 409, 'R297-webhook: poll несовместим с доставкой');
  assert.deepEqual(r.json(), { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" });
  assert.equal(await cursor(b.bot.id, b.cid), 0);
  assert.equal((await f.bot(b.token, 'deleteWebhook')).statusCode, 200);
  assert.equal((await f.bot(b.token, 'getUpdates')).json().result.length, 1);
}
test('R297 адрес доставки запрещает getUpdates до deleteWebhook', async () => run(conflict));

async function dropPending(f: Fixture, method: 'setWebhook' | 'deleteWebhook') {
  const b = await ready(f); await f.send(b.cid, 'Очередь');
  const args = method === 'setWebhook' ? { url: 'https://bot.example.test/hook', secret_token: 'synthetic-r297-hook' } : {};
  const keep = () => f.bot(b.token, method, { ...args, drop_pending_updates: false });
  const kept = method === 'setWebhook' ? await closesConsumer(f, b.token, 4009, 'webhook is active', keep) : await keep();
  assert.equal(kept.statusCode, 200);
  assert.equal(await f.store.pendingCount(b.bot.id), 1, 'false оставляет очередь');
  assert.equal((await f.bot(b.token, method, { ...args, drop_pending_updates: true })).statusCode, 200);
  assert.equal(await f.store.pendingCount(b.bot.id), 0, `R297-drop-${method}: true удаляет очередь`);
  assert.equal(await cursor(b.bot.id, b.cid), 0, 'выбросить очередь не означает прочитать');
}
for (const method of ['setWebhook', 'deleteWebhook'] as const) test(`R297 ${method} очищает очередь только при drop_pending_updates`, async () => run(f => dropPending(f, method)));

test('R297 перевыпуск токена отзывает старый, админ выключает и снова включает живой бот', async () => run(async f => {
  const b = await ready(f); assert.equal((await f.bot(b.token, 'getMe')).statusCode, 200);
  const rotate = await closesConsumer(f, b.token, 4001, 'token revoked', () => f.request('owner', 'POST', `/bots/${b.bot.id}/token`)); assert.equal(rotate.statusCode, 200);
  const next = rotate.json().token as string; assert.notEqual(next, b.token);
  assert.equal((await f.bot(b.token, 'getMe')).statusCode, 401); assert.equal((await f.bot(next, 'getMe')).statusCode, 200);
  const disabled = await closesConsumer(f, next, 4001, 'bot disabled', () => f.request('admin', 'PATCH', `/admin/bots/${b.bot.id}`, { disabled: true }));
  assert.equal(disabled.statusCode, 200);
  assert.equal((await f.bot(next, 'getMe')).statusCode, 401);
  assert.equal((await f.request('admin', 'PATCH', `/admin/bots/${b.bot.id}`, { disabled: false })).statusCode, 200);
  assert.equal((await f.bot(next, 'getMe')).statusCode, 200);
}));

test('R297 удаление владельца обезличивает бота, отзывает токен и очищает его доставку и очередь', async () => run(async f => {
  const b = await ready(f); await f.send(b.cid, 'Очередь перед удалением');
  await t.db.update(schema.bots).set({ webhookUrl: 'https://bot.example.test/hook', webhookSecret: 'synthetic-only' }).where(orm.eq(schema.bots.userId, b.bot.id));
  const deleted = await f.request('owner', 'POST', '/auth/delete', { password: f.password }); assert.equal(deleted.statusCode, 200, deleted.body); assert.deepEqual(deleted.json(), { ok: true });
  const [u] = await t.db.select().from(schema.users).where(orm.eq(schema.users.id, b.bot.id)); assert.ok(u.deletedAt); assert.equal(u.verified, false);
  const [row] = await t.db.select().from(schema.bots).where(orm.eq(schema.bots.userId, b.bot.id));
  assert.ok(row.disabledAt); assert.equal(row.webhookUrl, null); assert.equal(row.webhookSecret, null);
  assert.notEqual(row.tokenHash, f.load<typeof import('../src/bots/botRules.js')>('bots/botRules').hashBotToken(b.token));
  assert.equal(await f.store.pendingCount(b.bot.id), 0); assert.equal((await f.bot(b.token, 'getMe')).statusCode, 401);
  assert.equal((await t.db.select().from(schema.conversations).where(orm.eq(schema.conversations.id, b.cid))).length, 1, 'переписка остаётся');
}));

test('R297 бот не приглашается в группу, обычный человек приглашается', async () => run(async f => {
  const b = await ready(f);
  const denied = await f.request('owner', 'POST', '/conv/group', { title: 'Тест', userIds: [b.bot.id] });
  assert.equal(denied.statusCode, 403); assert.deepEqual(denied.json(), { error: 'group_not_invitable', userIds: [b.bot.id] });
  const accepted = await f.request('owner', 'POST', '/conv/group', { title: 'Тест', userIds: ['other'] }); assert.equal(accepted.statusCode, 201, accepted.body);
}));

test('R297 даже правильный пароль не пускает бота, тот же пароль пускает человека', async () => run(async f => {
  await f.enable(); const b = await f.create();
  await t.db.update(schema.users).set({ passwordHash: f.passwordHash }).where(orm.eq(schema.users.id, b.bot.id));
  const denied = await f.request('owner', 'POST', '/auth/login', { username: b.bot.username, password: f.password });
  assert.equal(denied.statusCode, 401); assert.deepEqual(denied.json(), { error: 'invalid credentials' });
  const accepted = await f.request('owner', 'POST', '/auth/login', { username: 'r297_owner', password: f.password }); assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().user.id, 'owner');
}));

async function readBatch(f: Fixture) {
  const b = await ready(f); await f.send(b.cid, 'Первая строка'); const last = await f.send(b.cid, 'Последняя строка');
  const before = f.events.length;
  const r = await f.bot(b.token, 'getUpdates'); assert.equal(r.statusCode, 200); assert.equal(r.json().result.length, 2);
  assert.equal((await cursor(b.bot.id, b.cid)) === last.sortKey, true, 'R297-taken: getUpdates читает до последнего');
  const readEvents = f.events.slice(before).filter(e => e.user === 'owner' && e.body.t === 'conv.change');
  assert.equal(readEvents.length, 1, 'на пачку ровно одна сводка человеку');
  const body = readEvents[0].body;
  assert.ok(body.t === 'conv.change' && !('left' in body.conversation)); assert.equal(body.conversation.peerReadKey, last.sortKey);
  const again = f.events.length; await f.bot(b.token, 'getUpdates'); assert.equal(f.events.length, again, 'повтор не создаёт квитанцию заново');
}
test('R297 getUpdates отмечает пачку одним прочтением до последнего и посылает человеку peerReadKey', async () => run(readBatch));

async function wsRead(f: Fixture, offsetOnConnect = false) {
  const b = await ready(f); await f.send(b.cid, 'Первое WS'); const last = await f.send(b.cid, 'Второе WS');
  const rows = await f.store.updatesFrom(b.bot.id, 0, 100); const offset = rows.at(-1)!.updateId + 1;
  const handlers = new Map<string, (...args: any[]) => void>(); const frames: any[] = [];
  const socket: Socket = { send: data => frames.push(JSON.parse(data)), close: () => handlers.get('close')?.(), on: (event, cb) => { handlers.set(event, cb); } };
  const before = f.events.length;
  try {
    await f.api.__serve(socket, { headers: { authorization: `Bot ${b.token}` }, query: offsetOnConnect ? { offset } : {}, ip: '192.0.2.1' });
    // __serve заканчивает первоначальную отправку, но ?offset подтверждается независимо от неё.
    await f.clean();
    if (!offsetOnConnect) {
      assert.deepEqual(frames.map(x => x.op), ['hello', 'update', 'update']);
      assert.equal((await cursor(b.bot.id, b.cid)) > 0, false, 'R297-ws-send: отправка без ack не прочитана');
      assert.equal(await f.store.pendingCount(b.bot.id), 2);
      handlers.get('message')!(JSON.stringify({ op: 'ack', offset })); await f.clean();
    } else assert.deepEqual(frames.map(x => x.op), ['hello']);
    assert.equal(await cursor(b.bot.id, b.cid), last.sortKey); assert.equal(await f.store.pendingCount(b.bot.id), 0);
    const changes = f.events.slice(before).filter(e => e.user === 'owner' && e.body.t === 'conv.change'); assert.equal(changes.length, 1);
    const change = changes[0].body; assert.ok(change.t === 'conv.change' && !('left' in change.conversation)); assert.equal(change.conversation.peerReadKey, last.sortKey);
  } finally { socket.close(); }
}
test('R297 WS отправляет без прочтения, ack подтверждает пачку одной квитанцией', async () => run(f => wsRead(f)));
test('R297 WS offset при подключении подтверждает старую пачку без повторной отправки', async () => run(f => wsRead(f, true)));

async function reveal(f: Fixture) {
  await f.enable(); const b = await f.create(); const cid = await f.open(b.bot.id);
  assert.equal((await f.request('owner', 'POST', `/conv/${cid}/hide`, { for: 'me' })).statusCode, 204);
  const opened = await f.request('owner', 'POST', '/conv/direct', { userId: b.bot.id }); assert.equal(opened.statusCode, 200); assert.equal(opened.json().id, cid);
  const rows = await f.store.updatesFrom(b.bot.id, 0, 100);
  assert.equal(rows.length, 3, 'R297-reveal: новый member после скрытия');
  assert.deepEqual(rows.map(r => (r.payload as Record<string, unknown>).new_status), ['member', 'left', 'member']);
  const again = await f.request('owner', 'POST', '/conv/direct', { userId: b.bot.id }); assert.equal(again.statusCode, 200);
  assert.equal(await f.store.pendingCount(b.bot.id), 3, 'повтор без скрытия не плодит member');
}
test('R297 hide даёт left, повторное открытие даёт member, обычный повтор не дублирует событие', async () => run(reveal));

test('R297 настоящий доставщик 2xx удаляет SQL-пачку и даёт человеку одну квитанцию до последнего', async () => run(async f => {
  const b = await ready(f); const first = await f.send(b.cid, 'Доставить первое'); const last = await f.send(b.cid, 'Доставить последнее');
  const rows = await f.store.updatesFrom(b.bot.id, 0, 100);
  await t.db.update(schema.bots).set({ webhookUrl: 'https://bot.example.test/hook', webhookSecret: 'synthetic-r297-hook',
    webhookFailures: 3, webhookLastError: 'HTTP 500' }).where(orm.eq(schema.bots.userId, b.bot.id));
  const before = f.events.length;
  await f.deliverWebhook(b.bot.id, [202, 204]);
  assert.deepEqual(f.hookRequests.map(r => r.body.update_id), rows.map(r => r.updateId));
  assert.deepEqual(f.hookRequests.map(r => r.body.message.message_id), [first.id, last.id]);
  assert.equal(await f.store.pendingCount(b.bot.id), 0);
  assert.equal(await cursor(b.bot.id, b.cid), last.sortKey);
  const changes = f.events.slice(before).filter(e => e.user === 'owner' && e.body.t === 'conv.change'); assert.equal(changes.length, 1);
  const change = changes[0].body; assert.ok(change.t === 'conv.change' && !('left' in change.conversation));
  assert.equal(change.conversation.peerReadKey, last.sortKey);
  const [row] = await t.db.select().from(schema.bots).where(orm.eq(schema.bots.userId, b.bot.id));
  assert.equal(row.webhookFailures, 0); assert.equal(row.webhookLastError, null); assert.deepEqual(f.retryDelays, []);
}));

async function failedWebhookRead(f: Fixture) {
  const b = await ready(f); const message = await f.send(b.cid, 'Отказ доставки');
  const queued = await f.store.updatesFrom(b.bot.id, 0, 100);
  await t.db.update(schema.bots).set({ webhookUrl: 'https://bot.example.test/hook', webhookSecret: 'synthetic-r297-hook' }).where(orm.eq(schema.bots.userId, b.bot.id));
  const before = f.events.length;
  await f.deliverWebhook(b.bot.id, [500]);
  assert.equal((await cursor(b.bot.id, b.cid)) > 0, false, 'R297-webhook500: отказ доставки не прочитан');
  assert.deepEqual((await f.store.updatesFrom(b.bot.id, 0, 100)).map(r => r.updateId), queued.map(r => r.updateId));
  assert.equal(f.hookRequests.length, 1); assert.equal(f.hookRequests[0].body.message.message_id, message.id);
  assert.equal(f.events.slice(before).filter(e => e.user === 'owner' && e.body.t === 'conv.change').length, 0);
  const [stored] = await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, message.id));
  assert.equal(stored.readAt, null);
  const [row] = await t.db.select().from(schema.bots).where(orm.eq(schema.bots.userId, b.bot.id));
  assert.equal(row.webhookFailures, 1); assert.equal(row.webhookDisabledAt, null); assert.deepEqual(f.retryDelays, [5000]);
}
test('R297 настоящий доставщик после 500 сохраняет событие без прочтения и назначает повтор', async () => run(failedWebhookRead));

// Заморожены существующие поля v1; добавочные поля разрешены контрактом, менять старые нельзя.
function existingFields(body: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.map(key => [key, body[key]]));
}
test('R297 v1 реальные getMe и getWebhookInfo сохраняют замороженные имена, типы и значения полей', async () => run(async f => {
  await f.enable(); const b = await f.create();
  await f.request('owner', 'PATCH', `/bots/${b.bot.id}`, { displayName: 'Тестовый бот', description: 'Описание v1', about: 'О боте', public: true });
  const me = await f.bot(b.token, 'getMe'); assert.equal(me.statusCode, 200);
  assert.equal(me.json().ok, true);
  assert.deepEqual(existingFields({ ...me.json().result, id: '<bot-id>' }, ['id', 'username', 'display_name', 'bot', 'description', 'about', 'public']),
    { id: '<bot-id>', username: 'r297_testbot', display_name: 'Тестовый бот', bot: true, description: 'Описание v1', about: 'О боте', public: true });
  assert.equal(me.json().result.id, b.bot.id);
  const empty = await f.bot(b.token, 'getWebhookInfo'); assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().ok, true);
  assert.deepEqual(existingFields(empty.json().result, ['url', 'pending_update_count', 'failures']), { url: '', pending_update_count: 0, failures: 0 });
  assert.equal(Object.hasOwn(empty.json().result, 'last_error_date'), false); assert.equal(Object.hasOwn(empty.json().result, 'disabled_date'), false);
  await f.store.pushUpdate(b.bot.id, 'my_chat_member', { new_status: 'member' });
  await t.db.update(schema.bots).set({ webhookUrl: 'https://bot.example.test/hook', webhookFailures: 10,
    webhookLastError: 'HTTP 500', webhookLastErrorAt: new Date('2026-01-01T00:00:00Z'),
    webhookDisabledAt: new Date('2026-01-01T00:01:00Z') }).where(orm.eq(schema.bots.userId, b.bot.id));
  const info = await f.bot(b.token, 'getWebhookInfo'); assert.equal(info.statusCode, 200); assert.equal(info.json().ok, true);
  assert.deepEqual(existingFields(info.json().result, ['url', 'pending_update_count', 'failures', 'last_error_date', 'last_error_message', 'disabled_date']),
    { url: 'https://bot.example.test/hook', pending_update_count: 1, failures: 10, last_error_date: 1767225600,
      last_error_message: 'HTTP 500', disabled_date: 1767225660 });
}));

test('R297 v1 реальные ответы ошибок сохраняют envelope 401, 404 и 400', async () => run(async f => {
  await f.enable(); const b = await f.create();
  for (const [token, method, payload, status, description] of [
    ['invalid', 'getMe', {}, 401, 'Unauthorized'],
    [b.token, 'unknownMethod', {}, 404, 'Not Found: method not found'],
    [b.token, 'sendMessage', { chat_id: 'missing-chat', text: 'Тест' }, 400, 'Bad Request: chat not found'],
  ] as const) {
    const r = await f.bot(token, method, payload); assert.equal(r.statusCode, status);
    assert.deepEqual(existingFields(r.json(), ['ok', 'error_code', 'description']), { ok: false, error_code: status, description });
    assert.equal(Object.hasOwn(r.json(), 'result'), false);
  }
}));

// Каждая мутация проходит ТУ ЖЕ проверку после оригинала. Принимается только конкретная ошибка исхода,
// не неизвестный импорт, SQL-ошибка, предупреждение или несовпавший якорь.
function killed(label: string, actual: unknown, expected: unknown) {
  return (e: unknown) => e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION' && e.operator === 'strictEqual'
    && e.message.split(/\r?\n/)[0] === label && Object.is(e.actual, actual) && Object.is(e.expected, expected);
}
const cases: { name: string; body: (f: Fixture) => Promise<void>; edit: Edit; label: string; actual: unknown; expected: unknown }[] = [
  { name: 'снят public/owner', body: privateBot, edit: { file: 'routes/conv', from: 'if (why) return reply.code(403).send({ error: BOT_UNAVAILABLE_ERRORS[why], code: BOT_UNAVAILABLE_CODE, reason: why });', to: '/* гейт открытия снят */' },
    label: 'R297-private: чужой не открывает приватного бота', actual: 201, expected: 403 },
  { name: 'снят actor-фильтр', body: ownActor, edit: { file: 'bots/botUpdates', from: 'bots.has(uid) && uid !== d.actor', to: 'bots.has(uid)' },
    label: 'R297-actor: собственное удаление не эхо', actual: 1, expected: 0 },
  { name: 'getUpdates разрешён при webhook', body: conflict, edit: { file: 'routes/botApi', from: 'async getupdates(ctx, p, { req, reply }) {\n    if (ctx.bot.webhookUrl) {', to: 'async getupdates(ctx, p, { req, reply }) {\n    if (false) {' },
    label: 'R297-webhook: poll несовместим с доставкой', actual: 200, expected: 409 },
  { name: 'verified больше не нужен', body: serializeAuthors, edit: { file: 'serialize', from: 'u.bot === true && u.verified === true', to: 'u.bot === true' },
    label: 'R297-verified: вебхук не помечен настоящим ботом', actual: true, expected: false },
  { name: 'getUpdates не отмечает прочтение', body: readBatch, edit: { file: 'routes/botApi', from: 'if (rows.length > 0) await markTakenRead(botId, rows);', to: '/* чтение потеряно */' },
    label: 'R297-taken: getUpdates читает до последнего', actual: false, expected: true },
  { name: 'WS ошибочно читает при отправке', body: f => wsRead(f), edit: { file: 'routes/botApi',
    from: "for (const r of rows) wsSend(socket, { op: 'update', update: wireUpdateOf(r) });",
    to: "await markTakenRead(botId, rows); for (const r of rows) wsSend(socket, { op: 'update', update: wireUpdateOf(r) });" },
    label: 'R297-ws-send: отправка без ack не прочитана', actual: true, expected: false },
  { name: 'reveal не даёт member', body: reveal, edit: { file: 'routes/conv', from: 'if (botRow && (created || revealed))', to: 'if (botRow && created)' },
    label: 'R297-reveal: новый member после скрытия', actual: 2, expected: 3 },
  { name: '500 доставки ошибочно считается прочтением', body: failedWebhookRead,
    edit: { file: 'bots/webhookDelivery', from: 'const failures = row.bot.webhookFailures + 1;', to: 'taken.push(next);\n      const failures = row.bot.webhookFailures + 1;' },
    label: 'R297-webhook500: отказ доставки не прочитан', actual: true, expected: false },
];
for (const method of ['setWebhook', 'deleteWebhook'] as const) cases.push({ name: `${method} теряет drop_pending_updates`, body: f => dropPending(f, method),
  edit: { file: 'routes/botApi', from: method === 'setWebhook'
    ? 'if (q.drop_pending_updates) await dropUpdates(ctx.bot.userId);\n    resetWebhookRetry(ctx.bot.userId);'
    : 'resetWebhookRetry(ctx.bot.userId);\n    if (q.drop_pending_updates) await dropUpdates(ctx.bot.userId);',
  to: 'resetWebhookRetry(ctx.bot.userId);' }, label: `R297-drop-${method}: true удаляет очередь`, actual: 1, expected: 0 });
for (const c of cases) test(`R297 контрфакт: ${c.name}`, async () => {
  await run(c.body); await assert.rejects(() => run(c.body, c.edit), killed(c.label, c.actual, c.expected));
});

const cases301: typeof cases = [
  { name: 'правка текста всегда сохраняет старые кнопки', body: f => editText301(f, false),
    edit: { file: 'routes/botApi', from: '{ keyboard: q.reply_markup?.inline_keyboard ?? null }', to: '{}' },
    label: 'R301-edit: пропущенная клавиатура снята', actual: false, expected: true },
  { name: 'правка текста всегда снимает переданные кнопки', body: f => editText301(f, true),
    edit: { file: 'routes/botApi', from: '{ keyboard: q.reply_markup?.inline_keyboard ?? null }', to: '{ keyboard: null }' },
    label: 'R301-edit: переданная клавиатура заменяет старую', actual: false, expected: true },
  { name: 'правка кнопок ошибочно ставит дату изменения текста', body: editKeyboard301,
    edit: { file: 'conversations', from: '.set({ keyboard: next })', to: '.set({ keyboard: next, editedAt: new Date(0) })' },
    label: 'R301-markup: дата правки текста не меняется', actual: '1970-01-01T00:00:00.000Z', expected: null },
  { name: 'подставленные данные кнопки проходят без проверки', body: stalePress301,
    edit: { file: 'routes/botPress', from: "if (msg.author.id !== c.bot.userId) return reply.code(400).send({ error: 'Это не сообщение бота' });\n      // Точное совпадение с кнопкой ТЕКУЩЕЙ клавиатуры: бот сменил кнопки — старое нажатие не уходит (клиент перечитает).\n      if (!keyboardHasData(msg.keyboard, data))", to: "if (msg.author.id !== c.bot.userId) return reply.code(400).send({ error: 'Это не сообщение бота' });\n      if (false)" },
    label: 'R301-stale: произвольных данных нет в очереди', actual: 200, expected: 409 },
  { name: 'чужой бот отвечает на нажатие без проверки владельца', body: f => callbackAnswer301(f, true),
    edit: { file: 'bots/botCallback', from: 'if (rec.botId !== botId) return false;', to: '/* владелец больше не проверяется */' },
    label: 'R301-owner: другой бот не отвечает на чужой запрос', actual: 200, expected: 400 },
  { name: 'SQL-фильтр протухших нажатий снят', body: async f => { await staleFilter301(f); },
    edit: { file: 'bots/botStore', from: "types ? inArray(botUpdates.type, [...types]) : undefined, notStale()", to: 'types ? inArray(botUpdates.type, [...types]) : undefined' },
    label: 'R301-TTL: протухшее нажатие не выдаётся', actual: true, expected: false },
];
for (const c of cases301) test(`R301 контрфакт: ${c.name}`, async () => {
  await run(c.body); await assert.rejects(() => run(c.body, c.edit), killed(c.label, c.actual, c.expected));
});

async function webhookEnglish(f: Fixture) {
  await f.enable(); const b = await f.create();
  for (const [stored, expected] of [
    ['ответ 500', 'Wrong response from the webhook: HTTP 500'],
    ['соединение отклонено', 'Connection refused'],
    ['неизвестная ошибка доставки', 'Webhook delivery failed'],
    ['HTTP 502', 'HTTP 502'],
  ]) {
    await t.db.update(schema.bots).set({ webhookLastError: stored, webhookLastErrorAt: new Date('2026-01-01T00:00:00Z') })
      .where(orm.eq(schema.bots.userId, b.bot.id));
    const response = await f.bot(b.token, 'getWebhookInfo'); assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().ok, true);
    const info = response.json().result;
    assert.equal(info.last_error_message, expected, 'R300-wire: ошибка доставки переведена для Bot API');
    assert.doesNotMatch(info.last_error_message, /[А-Яа-яЁё]/);
    assert.equal(info.last_error_date, 1767225600);
  }
}
test('R300 getWebhookInfo переводит русские ошибки доставки, английскую сохраняет без кириллицы', async () => run(webhookEnglish));

test('R300 setWebhook переводит причины отказа адреса на английский, допустимый адрес сохраняется', async () => run(async f => {
  await f.enable(); const b = await f.create();
  const url = 'https://bot.example.test/r300';
  // DNS/HTTP не вызываются: конкретные результаты проверки поступают с IO-границы,
  // но переводчик hookUrlErrorEn и полный маршрут остаются настоящими.
  for (const [ru, en] of [
    ['адрес не разобран', 'invalid URL'],
    ['нужен адрес https://', 'an HTTPS URL is required'],
    ['нужен адрес https:// или http://', 'an HTTPS or HTTP URL is required'],
    ['логин и пароль в адресе не принимаются', 'credentials in the URL are not allowed'],
    ['в адресе нет хоста', 'the URL has no host'],
    ['адрес внутренний — доставка туда запрещена', 'internal addresses are not allowed'],
    ['имя хоста не резолвится', 'failed to resolve host'],
  ]) {
    f.setHookTargetError(ru);
    const denied = await f.bot(b.token, 'setWebhook', { url, secret_token: 'r300-synthetic-hook' });
    assert.equal(denied.statusCode, 400, denied.body);
    assert.deepEqual(denied.json(), { ok: false, error_code: 400, description: `Bad Request: bad webhook: ${en}` });
    assert.doesNotMatch(denied.json().description, /[А-Яа-яЁё]/);
    const [row] = await t.db.select().from(schema.bots).where(orm.eq(schema.bots.userId, b.bot.id));
    assert.equal(row.webhookUrl, null); assert.equal(row.webhookSecret, null);
  }
  f.setHookTargetError(null);
  const accepted = await f.bot(b.token, 'setWebhook', { url, secret_token: 'r300-synthetic-hook' });
  assert.equal(accepted.statusCode, 200, accepted.body); assert.deepEqual(accepted.json(), { ok: true, result: true });
  const [row] = await t.db.select().from(schema.bots).where(orm.eq(schema.bots.userId, b.bot.id));
  assert.equal(row.webhookUrl, url); assert.equal(row.webhookSecret, 'r300-synthetic-hook');
  assert.deepEqual(f.hookChecks, Array.from({ length: 8 }, () => ({ url, allowInternal: false })));
}));

async function peerSummary(f: Fixture, cid: string) {
  const response = await f.request('owner', 'GET', '/conv'); assert.equal(response.statusCode, 200, response.body);
  const conversation = (response.json().conversations as shared.ConvSummary[]).find(c => c.id === cid);
  assert.ok(conversation?.otherUser, 'беседа и собеседник присутствуют в настоящей сводке');
  return conversation.otherUser;
}

async function hardenSend(f: Fixture) {
  const b = await panel301(f);
  await f.request('owner', 'PATCH', `/bots/${b.bot.id}`, { public: true });
  const otherCid = await f.open(b.bot.id, 'other');
  await f.request('owner', 'PATCH', `/bots/${b.bot.id}`, { public: false });
  const inputs: Array<[string, Record<string, unknown>]> = [
    ['messages', { clientId: crypto.randomUUID(), content: 'Текст' }],
    ['messages', { clientId: crypto.randomUUID(), content: '', attachments: [{ id: crypto.randomUUID(), asFile: true }] }],
    ['messages', { clientId: crypto.randomUUID(), content: '', attachments: [{ id: crypto.randomUUID(), durationMs: 1000, waveform: [1, 2] }] }],
    ['forward', { clientId: crypto.randomUUID(), fromConversationId: otherCid, messageIds: [b.mid] }],
    ['scheduled', { clientId: crypto.randomUUID(), content: 'Позже', sendAt: new Date(Date.now() + 120_000).toISOString() }],
    ['scheduled/synthetic-scheduled/send', {}],
    [`messages/${b.mid}/callback`, { data: 'status' }],
  ];
  for (const [path, payload] of inputs) {
    const r = await f.request('other', 'POST', `/conv/${otherCid}/${path}`, payload);
    assert.equal(r.statusCode, 403, `R303 гейт ${path}`);
    assert.equal(r.json().code, 'bot_unavailable'); assert.equal(r.json().reason, 'private');
  }
  const accepted = await f.request('owner', 'POST', `/conv/${b.cid}/messages`, { clientId: crypto.randomUUID(), content: 'Владелец проходит' });
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.equal((await peerSummary(f, b.cid)).botUnavailable, undefined);
  const list = await f.request('other', 'GET', '/conv');
  assert.equal(list.json().conversations.find((c: shared.ConvSummary) => c.id === otherCid).otherUser.botUnavailable, 'private');
  await t.db.update(schema.bots).set({ disabledAt: new Date() }).where(orm.eq(schema.bots.userId, b.bot.id));
  assert.equal((await peerSummary(f, b.cid)).botUnavailable, 'disabled');
  const disabled = await f.request('owner', 'POST', `/conv/${b.cid}/messages`, { clientId: crypto.randomUUID(), content: 'Нельзя' });
  assert.equal(disabled.statusCode, 403); assert.equal(disabled.json().reason, 'disabled');
  await t.db.update(schema.bots).set({ disabledAt: null }).where(orm.eq(schema.bots.userId, b.bot.id));
  await f.request('admin', 'PUT', '/admin/bots/settings', { enabled: false, creators: 'all' });
  const global = await f.request('owner', 'POST', `/conv/${b.cid}/messages`, { clientId: crypto.randomUUID(), content: 'Тоже нельзя' });
  assert.equal(global.statusCode, 403); assert.equal(global.json().reason, 'disabled');
  assert.equal((await peerSummary(f, b.cid)).botUnavailable, 'disabled');
}
test('R303 приватный бот закрывает все семь входов отправки чужому, владелец проходит; отключение видно в ответе и сводке', async () => run(hardenSend));

async function privateJournal303(f: Fixture) {
  const b = await ready(f);
  await f.request('owner', 'PATCH', `/bots/${b.bot.id}`, { public: true });
  const otherCid = await f.open(b.bot.id, 'other');
  await f.request('owner', 'PATCH', `/bots/${b.bot.id}`, { public: false });
  await f.store.dropUpdates(b.bot.id);
  // Обходим HTTP-гейт умышленно: это независимая вторая линия защиты журнала.
  const access = await f.c.loadAccess(otherCid, 'other'); assert.ok(access);
  const sent = await f.c.sendMessage('other', access, { clientId: null, content: 'В обход маршрута', attachments: [], replyToId: null, withheld: false, silent: false, noPreview: false });
  assert.equal(sent.kind, 'created'); if (sent.kind !== 'created') assert.fail('message not created');
  await f.c.deliver(sent.delivery); await f.clean();
  assert.equal(await f.store.pendingCount(b.bot.id), 0, 'R303 чужая беседа не попадает в приватный журнал');
  await f.send(b.cid, 'Свой');
  assert.equal(await f.store.pendingCount(b.bot.id), 1);
}
test('R303 журнал приватного бота отбрасывает чужую беседу даже в обход HTTP, но пишет владельца', async () => run(privateJournal303));

test('R303 setWebhook не открывает loopback тумблером LAN, но принимает LAN', async () => run(async f => {
  const b = await ready(f);
  await f.request('admin', 'PUT', '/admin/bots/settings', { enabled: true, creators: 'all', allowInternalWebhooks: true });
  const denied = await f.bot(b.token, 'setWebhook', { url: 'http://127.0.0.1/hook', secret_token: 'synthetic-hook-secret' });
  assert.equal(denied.statusCode, 400); assert.match(denied.json().description, /internal addresses/);
  assert.equal((await f.bot(b.token, 'setWebhook', { url: 'http://192.168.2.1/hook', secret_token: 'synthetic-hook-secret' })).statusCode, 200);
}));

test('R303 блок и разблок бота дают member→kicked→member, блок человека не пишет боту', async () => run(async f => {
  const b = await ready(f);
  assert.equal((await f.request('owner', 'POST', '/blocks', { userId: b.bot.id })).statusCode, 204);
  assert.equal((await f.request('owner', 'DELETE', `/blocks/${b.bot.id}`)).statusCode, 204);
  const rows = await f.store.updatesFrom(b.bot.id, 0, 100);
  assert.deepEqual(rows.map(r => [r.type, r.payload.old_status, r.payload.new_status]), [
    ['my_chat_member', 'member', 'kicked'], ['my_chat_member', 'kicked', 'member'],
  ]);
  await f.request('owner', 'POST', '/blocks', { userId: 'other' });
  assert.equal(await f.store.pendingCount(b.bot.id), 2);
}));

async function delete303(f: Fixture) {
  const b = await ready(f);
  assert.equal((await f.request('owner', 'DELETE', `/bots/${b.bot.id}`)).statusCode, 204);
  assert.equal(f.federationCalls.length, 0, 'R303 бот скрыт от федерации даже при удалении');
  const row = (await t.db.select().from(schema.users).where(orm.eq(schema.users.id, b.bot.id)))[0];
  assert.ok(row.deletedAt); assert.equal(row.displayName, shared.DELETED_BOT_NAME);
  // Контрфакт запрета ВСЕХ анонсов: обычный человек по-прежнему отзывает гостевые сеансы и надгробие.
  await f.load<typeof import('../src/accountDelete.js')>('accountDelete').anonymizeAccount('other'); await f.clean();
  assert.deepEqual(f.federationCalls, ['revokeAccountEverywhere', 'announceUser']);
}
test('R303 удаление бота не анонсирует профиль соседям, удаление человека сохраняет оба вызова', async () => run(delete303));

test('R303 client_id возвращает тот же id и одну строку; чужая беседа отвергается', async () => run(async f => {
  const b = await ready(f), client_id = 'synthetic-retry-id';
  const first = await f.bot(b.token, 'sendMessage', { chat_id: b.cid, text: 'Первый', client_id });
  const retry = await f.bot(b.token, 'sendMessage', { chat_id: b.cid, text: 'Другой текст', client_id });
  assert.equal(first.statusCode, 200); assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().result.message_id, first.json().result.message_id);
  const rows = await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.clientId, client_id));
  assert.equal(rows.length, 1); assert.equal(rows[0].content, 'Первый');
  await f.request('owner', 'PATCH', `/bots/${b.bot.id}`, { public: true });
  const other = await f.open(b.bot.id, 'other');
  assert.equal((await f.bot(b.token, 'sendMessage', { chat_id: other, text: 'Не сюда', client_id })).statusCode, 400);
  assert.equal((await f.bot(b.token, 'sendMessage', { chat_id: other, text: 'Новый id', client_id: 'fresh-id' })).statusCode, 200);
}));

async function cap303(f: Fixture) {
  const b = await ready(f);
  const second = await f.request('owner', 'POST', '/bots', { username: 'r303_otherbot' }); assert.equal(second.statusCode, 201);
  const other = second.json().bot.id as string;
  await f.store.pushUpdate(other, 'message', { tag: 'чужой' });
  const seeded = await t.db.insert(schema.botUpdates).values(Array.from({ length: 1000 }, (_, n) => ({ botId: b.bot.id, type: 'message', payload: { n } }))).returning();
  const last = await f.store.pushUpdate(b.bot.id, 'message', { n: 1000 });
  const rows = await t.db.select().from(schema.botUpdates).where(orm.eq(schema.botUpdates.botId, b.bot.id)).orderBy(schema.botUpdates.updateId);
  assert.equal(rows.length, 1000, 'R303 вставка сама держит потолок журнала'); assert.equal(rows[0].updateId, seeded[1].updateId); assert.equal(rows.at(-1)!.updateId, last);
  assert.equal(await f.store.pendingCount(other), 1);
  assert.equal((await t.db.select().from(schema.bots).where(orm.eq(schema.bots.userId, b.bot.id)))[0].droppedUpdateCount, 1);
}
test('R303 1001-я вставка оставляет 1000 новейших своего бота и не трогает чужого', async () => run(cap303));

async function order303(f: Fixture) {
  const b = await ready(f), original = f.c.botConv()!;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered: string[] = [];
  f.c.configureBotConv({ ...original, record: async ds => {
    entered.push(ds[0].messageId!);
    if (entered.length === 1) await held;
    await original.record(ds);
  } });
  const access = await f.c.loadAccess(b.cid, 'owner'); assert.ok(access);
  const messages = [];
  for (const content of ['Первый медленный', 'Второй быстрый']) {
    const r = await f.c.sendMessage('owner', access, { clientId: null, content, attachments: [], replyToId: null, withheld: false, silent: false, noPreview: false });
    assert.equal(r.kind, 'created'); if (r.kind !== 'created') assert.fail('created'); messages.push(r);
  }
  try {
    await f.c.deliver(messages[0].delivery); await f.c.deliver(messages[1].delivery);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(entered.length, 1, 'R303 второй deliver ждёт хвост первой записи');
    assert.equal(entered[0], messages[0].row.id);
  } finally { release(); await f.clean(); }
  assert.deepEqual((await f.store.updatesFrom(b.bot.id, 0, 100)).map(r => r.payload.message_id), messages.map(m => m.row.id));
}
test('R303 медленный первый deliver не позволяет второму обогнать его в update_id', async () => run(order303));

async function staleSweep303(f: Fixture) {
  const b = await ready(f); await f.startDeliveryJobs();
  await t.db.update(schema.bots).set({ webhookUrl: 'https://example.test/hook', webhookSecret: null }).where(orm.eq(schema.bots.userId, b.bot.id));
  await t.db.insert(schema.botUpdates).values({ botId: b.bot.id, type: 'callback_query', payload: { id: 'stale' }, createdAt: orm.sql`now() - interval '26 seconds'` });
  const sweep = f.deliveryIntervals.find(timer => timer.ms === 60_000); assert.ok(sweep);
  await sweep.fn(); await f.clean();
  assert.equal(f.deliveryLocks.length, 0, 'R303 протухшее нажатие не запускает доставщик');
  // Обычное старое сообщение не протухает по короткому TTL кнопок и разбудит доставку.
  await t.db.insert(schema.botUpdates).values({ botId: b.bot.id, type: 'message', payload: { marker: 'message' }, createdAt: orm.sql`now() - interval '26 seconds'` });
  await sweep.fn(); await f.clean();
  assert.equal(f.deliveryLocks.length, 1);
}
test('R303 EXISTS обхода вебхуков не будит доставку для одного протухшего callback', async () => run(staleSweep303));

test('R303 getMe сообщает версию и признаки, неизвестный allowed_updates игнорируется', async () => run(async f => {
  const b = await ready(f); await f.send(b.cid, 'Сообщение');
  const me = await f.bot(b.token, 'getMe'); assert.equal(me.json().result.api_version, 4);
  for (const feature of ['keyboards', 'commands', 'ws', 'servers', 'reactions', 'parse_mode', 'webhook_batch', 'voice']) assert.ok(me.json().result.features.includes(feature));
  const updates = await f.bot(b.token, 'getUpdates', { allowed_updates: ['message', 'poll'] });
  assert.equal(updates.statusCode, 200); assert.equal(updates.json().result.length, 1);
  assert.equal(updates.json().result[0].message.text, 'Сообщение');
}));

test('R303 этап 3 pushUpdates держит 10000 для readAll и 1000 для обычного, считает только реально потерянное', async () => run(async f => {
  const b = await ready(f), second = await f.request('owner', 'POST', '/bots', { username: 'r303_batchbot' });
  assert.equal(second.statusCode, 201); const other = second.json().bot.id as string;
  await t.db.insert(schema.botUpdates).values(Array.from({ length: 10_000 }, (_, n) => ({ botId: b.bot.id, type: 'message', payload: { n } })));
  assert.equal(await f.store.pendingCount(b.bot.id), 10_000);
  const targets = await f.store.pushUpdates([
    { botId: b.bot.id, type: 'message', payload: { n: 10_000 }, readAll: true },
    ...Array.from({ length: 1001 }, (_, n) => ({ botId: other, type: 'message' as const, payload: { n }, readAll: false })),
  ]);
  assert.deepEqual(normal(targets).sort(), [b.bot.id, other].sort());
  assert.equal(await f.store.pendingCount(b.bot.id), 10_000); assert.equal(await f.store.pendingCount(other), 1000);
  for (const botId of [b.bot.id, other]) {
    const rows = await t.db.select().from(schema.botUpdates).where(orm.eq(schema.botUpdates.botId, botId)).orderBy(schema.botUpdates.updateId);
    assert.equal(rows[0].payload.n, 1, 'ушла именно самая старая строка');
    assert.equal((await t.db.select().from(schema.bots).where(orm.eq(schema.bots.userId, botId)))[0].droppedUpdateCount, 1);
  }
  // Одиночная вставка сама читает readAll из серверного членства, не полагается на подсказку pushUpdates.
  await t.db.insert(schema.servers).values({ id: 'r303-cap-server', name: 'Потолок', ownerId: 'owner' });
  await t.db.insert(schema.serverMembers).values({ serverId: 'r303-cap-server', userId: b.bot.id });
  await t.db.insert(schema.serverBots).values({ serverId: 'r303-cap-server', botId: b.bot.id, readAll: true, addedBy: 'owner' });
  await f.store.pushUpdate(b.bot.id, 'message', { n: 10_001 });
  assert.equal(await f.store.pendingCount(b.bot.id), 10_000);
  assert.equal((await t.db.select().from(schema.bots).where(orm.eq(schema.bots.userId, b.bot.id)))[0].droppedUpdateCount, 2);
}));

test('R303 этап 3 dropServerUpdates снимает только свой сервер, включая вложенный chat кнопки', async () => run(async f => {
  const b = await ready(f), second = await f.request('owner', 'POST', '/bots', { username: 'r303_keepbot' });
  assert.equal(second.statusCode, 201); const other = second.json().bot.id as string;
  for (const [botId, type, payload] of [
    [b.bot.id, 'message', { chat: { id: 'channel', server_id: 'remove' } }],
    [b.bot.id, 'callback_query', { message: { chat: { id: 'channel', server_id: 'remove' } } }],
    [b.bot.id, 'message', { chat: { id: b.cid, type: 'private' } }],
    [b.bot.id, 'message', { chat: { id: 'channel2', server_id: 'keep' } }],
    [other, 'message', { chat: { id: 'channel', server_id: 'remove' } }],
  ] as const) await f.store.pushUpdate(botId, type, payload);
  await f.store.dropServerUpdates(b.bot.id, 'remove');
  const rows = await f.store.updatesFrom(b.bot.id, 0, 100);
  assert.deepEqual(rows.map(r => (r.payload.chat as { id: string }).id), [b.cid, 'channel2']);
  assert.equal(await f.store.pendingCount(other), 1);
}));

test('R303 этап 3 области команд независимы: пустой override скрывает default, удаление возвращает default', async () => run(async f => {
  const b = await ready(f), def = [{ command: 'base', description: 'По умолчанию' }], dm = [{ command: 'private', description: 'В ЛС' }];
  const row = async () => (await f.store.botById(b.bot.id))!.bot;
  await f.store.setBotCommands(b.bot.id, def);
  await f.store.setBotCommands(b.bot.id, dm, 'all_private_chats');
  await f.store.setBotCommands(b.bot.id, [], 'all_group_chats');
  assert.deepEqual(normal(f.store.commandsFor(await row(), 'dm')), dm);
  assert.deepEqual(normal(f.store.commandsFor(await row(), 'server')), []);
  await f.store.setBotCommands(b.bot.id, null, 'all_group_chats');
  assert.deepEqual(normal(f.store.commandsFor(await row(), 'server')), def);
  assert.deepEqual(normal(f.store.commandsFor(await row(), 'dm')), dm);
  await f.store.setBotCommands(b.bot.id, null, 'all_private_chats');
  assert.deepEqual(normal(f.store.commandsFor(await row(), 'dm')), def);
  assert.ok((await row()).commandsUpdatedAt);
}));

async function batch303(f: Fixture, batch = true) {
  const b = await ready(f);
  const ids = [];
  for (let n = 0; n < 3; n++) ids.push(await f.store.pushUpdate(b.bot.id, 'message', { marker: n }));
  await t.db.update(schema.bots).set({ webhookUrl: 'https://example.test/hook', webhookSecret: 'synthetic-hook-secret', webhookBatch: batch }).where(orm.eq(schema.bots.userId, b.bot.id));
  await f.deliverWebhook(b.bot.id, batch ? [204] : [204, 204, 204], true);
  assert.equal(f.hookRequests.length, batch ? 1 : 3, 'R303 batch подтверждается одним запросом целиком');
  assert.equal(Array.isArray(f.hookRequests[0].body), batch, 'R303 batch передаётся массивом');
  const bodies = batch ? f.hookRequests[0].body : f.hookRequests.map(r => r.body);
  assert.deepEqual((bodies as Array<{ update_id: number }>).map(row => row.update_id), ids);
  for (const request of f.hookRequests) {
    const signature = request.headers['x-gusvoice-signature'];
    const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signature); assert.ok(match);
    assert.equal(match[2] === crypto.createHmac('sha256', 'synthetic-hook-secret').update(`${match[1]}.${request.raw}`).digest('hex'), true,
      'R303 подпись покрывает всё переданное тело');
  }
  assert.equal(await f.store.pendingCount(b.bot.id), 0);
}
for (const batch of [false, true]) test(`R303 этап 3 webhook batch=${batch}: форма тела и подтверждение всей выбранной пачки`, async () => run(f => batch303(f, batch)));

test('R303 этап 3 batch 500 сохраняет всю пачку для повтора, следующий 2xx снимает её целиком', async () => run(async f => {
  const b = await ready(f);
  for (let n = 0; n < 3; n++) await f.store.pushUpdate(b.bot.id, 'message', { marker: n });
  await t.db.update(schema.bots).set({ webhookUrl: 'https://example.test/hook', webhookSecret: 'synthetic-hook-secret', webhookBatch: true }).where(orm.eq(schema.bots.userId, b.bot.id));
  const delivery = await f.deliverWebhook(b.bot.id, [500]);
  assert.equal(await f.store.pendingCount(b.bot.id), 3); assert.equal(f.retryDelays.length, 1);
  delivery.resetWebhookRetry(b.bot.id);
  await f.deliverWebhook(b.bot.id, [204]);
  assert.equal(await f.store.pendingCount(b.bot.id), 0);
  assert.deepEqual(f.hookRequests[1].body, f.hookRequests[0].body);
}));

const hardeningMutants: Array<{ name: string; body: (f: Fixture) => Promise<void>; edit: Edit; label: string; actual: unknown; expected: unknown }> = [
  { name: 'messagePrivacy без botSendRefused', body: hardenSend,
    edit: { file: 'routes/conv', from: '  if (await botSendRefused(reply, me, access)) return true;', to: '' },
    label: 'R303 гейт messages', actual: 201, expected: 403 },
  { name: 'ownerOnlyChat всегда пропускает', body: privateJournal303,
    edit: { file: 'bots/botUpdates', from: 'return others.length > 0 && others.every((u) => u === ownerId);', to: 'return true;' },
    label: 'R303 чужая беседа не попадает в приватный журнал', actual: 1, expected: 0 },
  { name: 'EXISTS не отсекает протухшую кнопку', body: staleSweep303,
    edit: { file: 'bots/webhookDelivery', from: "AND (u.type <> 'callback_query' OR u.created_at >= now() - make_interval(secs => ${CALLBACK_QUERY_STALE_S}))", to: '' },
    label: 'R303 протухшее нажатие не запускает доставщик', actual: 1, expected: 0 },
  { name: 'вставка не подрезает журнал', body: cap303,
    edit: { file: 'bots/botStore', from: '  await trimJournal(botId, await capOf(botId));', to: '' },
    label: 'R303 вставка сама держит потолок журнала', actual: 1001, expected: 1000 },
  { name: 'очередь не ждёт предыдущую запись', body: order303,
    edit: { file: 'conversations', from: 'const prev = Promise.all(keys.map((k) => botChains.get(k)));', to: 'const prev = Promise.resolve();' },
    label: 'R303 второй deliver ждёт хвост первой записи', actual: 2, expected: 1 },
  { name: 'batch подтверждает только первое событие', body: batch303,
    edit: { file: 'bots/webhookDelivery', from: 'sql.join(pack.map((u) => sql`${u.updateId}`), sql`, `)', to: 'sql.join(pack.slice(0, 1).map((u) => sql`${u.updateId}`), sql`, `)' },
    label: 'R303 batch подтверждается одним запросом целиком', actual: 3, expected: 1 },
  { name: 'batch подписывает только первый элемент', body: batch303,
    edit: { file: 'bots/webhookDelivery', from: 'webhookSignature(row.bot.webhookSecret, body, unixSeconds(Date.now()))', to: 'webhookSignature(row.bot.webhookSecret, JSON.stringify(wireUpdateOf(next)), unixSeconds(Date.now()))' },
    label: 'R303 подпись покрывает всё переданное тело', actual: false, expected: true },
  { name: 'deleteBot обезличивается как человек', body: delete303,
    edit: { file: 'bots/botLifecycle', from: '{ displayName: DELETED_BOT_NAME, bot: true }', to: '{ displayName: DELETED_BOT_NAME }' },
    label: 'R303 бот скрыт от федерации даже при удалении', actual: 2, expected: 0 },
];
for (const m of hardeningMutants) test(`R303 контрфакт: ${m.name}`, async () => {
  await run(m.body); await assert.rejects(run(m.body, m.edit), killed(m.label, m.actual, m.expected));
});
async function summaryDescription(f: Fixture) {
  const b = await ready(f);
  const empty = await peerSummary(f, b.cid);
  assert.equal(empty.bot, true);
  assert.equal(Object.hasOwn(empty, 'botDescription'), false, 'R300-empty: пустое описание отсутствует в сводке');
  const changed = await f.request('owner', 'PATCH', `/bots/${b.bot.id}`, { description: 'Отвечает на команды' });
  assert.equal(changed.statusCode, 200, changed.body);
  const live = await peerSummary(f, b.cid);
  assert.equal(live.bot, true); assert.equal(live.botDescription, 'Отвечает на команды');
  await t.db.update(schema.users).set({ verified: false }).where(orm.eq(schema.users.id, b.bot.id));
  const unverified = await peerSummary(f, b.cid);
  assert.equal(Object.hasOwn(unverified, 'botDescription'), false, 'неподтверждённый автор не выдаёт себя за настоящего бота');
  assert.equal(Object.hasOwn(unverified, 'bot'), false);
  const human = await peerSummary(f, await f.open('other'));
  assert.equal(Object.hasOwn(human, 'botDescription'), false); assert.equal(Object.hasOwn(human, 'bot'), false);
}
test('R300 сводка отдаёт непустое описание живого бота, но не пустое и не человеку', async () => run(summaryDescription));

async function deletedSummary(f: Fixture) {
  const b = await ready(f);
  assert.equal((await f.request('owner', 'PATCH', `/bots/${b.bot.id}`, { description: 'Старое описание' })).statusCode, 200);
  assert.equal((await f.request('owner', 'DELETE', `/bots/${b.bot.id}`)).statusCode, 204);
  // В bots описание хранится и после удаления; иначе мутант мог бы пройти из-за пустой фикстуры.
  const [record] = await t.db.select().from(schema.bots).where(orm.eq(schema.bots.userId, b.bot.id));
  assert.equal(record.description, 'Старое описание');
  // Старые удалённые до R300 боты в users ещё называются пользователями: сводка обязана поправить это.
  await t.db.update(schema.users).set({ displayName: 'Удалённый пользователь' }).where(orm.eq(schema.users.id, b.bot.id));
  const peer = await peerSummary(f, b.cid);
  assert.equal(Object.hasOwn(peer, 'botDescription'), false, 'R300-deleted: описание удалённого бота отсутствует');
  assert.equal(Object.hasOwn(peer, 'bot'), false);
  assert.equal(peer.displayName, shared.DELETED_BOT_NAME); assert.equal(peer.id, b.bot.id);
}
test('R300 сводка удалённого бота исправляет старое имя и не отдаёт значок и сохранившееся описание', async () => run(deletedSummary));

test('R300 deleteBot сохраняет имя удалённого бота в users и рассылает то же имя собеседникам', async () => run(async f => {
  const b = await ready(f);
  f.profileBroadcasts.length = 0;
  const response = await f.request('owner', 'DELETE', `/bots/${b.bot.id}`); assert.equal(response.statusCode, 204, response.body);
  const [user] = await t.db.select().from(schema.users).where(orm.eq(schema.users.id, b.bot.id));
  assert.ok(user.deletedAt); assert.equal(user.verified, false); assert.equal(user.displayName, shared.DELETED_BOT_NAME);
  assert.deepEqual(f.profileBroadcasts, [{ userId: b.bot.id, displayName: shared.DELETED_BOT_NAME, avatarUrl: null, animatedAvatarUrl: null }]);
  assert.equal((await peerSummary(f, b.cid)).displayName, shared.DELETED_BOT_NAME);
}));

async function botCallUnavailable(f: Fixture) {
  const b = await ready(f);
  // Одинаково разрешённая приватность у обоих адресатов исключает случайный отказ до менеджера звонка.
  await t.db.update(schema.users).set({ callPrivacy: 'everyone' }).where(orm.inArray(schema.users.id, [b.bot.id, 'other']));
  const denied = await f.request('owner', 'POST', `/conv/${b.cid}/call`, { device: 'r300-device' });
  assert.equal(denied.statusCode, 403, 'R300-call: бот не принимает звонок');
  assert.deepEqual(denied.json(), { error: 'Позвонить нельзя' }); assert.deepEqual(f.callStarts, []);
  const humanCid = await f.open('other');
  const accepted = await f.request('owner', 'POST', `/conv/${humanCid}/call`, { device: 'r300-device' });
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.deepEqual(accepted.json(), { call: { id: 'r300-call', callerId: 'owner', calleeId: 'other', conversationId: humanCid }, userId: 'owner' });
  assert.deepEqual(f.callStarts, [{ callerId: 'owner', calleeId: 'other', conversationId: humanCid, device: 'r300-device' }]);
}
test('R300 настоящий маршрут звонка отказывает боту с 403, человеку разрешает и передаёт устройство', async () => run(botCallUnavailable));

const r300Cases: typeof cases = [
  { name: 'сырой русский webhookLastError попал в провод', body: webhookEnglish,
    edit: { file: 'routes/botApi', from: 'last_error_message: webhookErrorWire(b.webhookLastError)', to: 'last_error_message: b.webhookLastError' },
    label: 'R300-wire: ошибка доставки переведена для Bot API', actual: 'ответ 500', expected: 'Wrong response from the webhook: HTTP 500' },
  { name: 'пустое описание бота попало в сводку', body: summaryDescription,
    edit: { file: 'conversations', from: 'peer.bot && peer.verified && botDescById.get(peer.id) ? { botDescription:', to: 'peer.bot && peer.verified ? { botDescription:' },
    label: 'R300-empty: пустое описание отсутствует в сводке', actual: true, expected: false },
  { name: 'описание удалённого бота попало в сводку', body: deletedSummary,
    edit: { file: 'conversations', from: 'peer.bot && peer.verified && botDescById.get(peer.id) ? { botDescription:', to: 'botDescById.get(peer.id) ? { botDescription:' },
    label: 'R300-deleted: описание удалённого бота отсутствует', actual: true, expected: false },
  { name: 'проверка бота снята с маршрута звонков', body: botCallUnavailable,
    edit: { file: 'routes/calls', from: 'if (peer?.bot) return reply.code(403).send({ error: CALL_UNAVAILABLE });', to: '/* запрет звонка боту потерян */' },
    label: 'R300-call: бот не принимает звонок', actual: 201, expected: 403 },
];
for (const c of r300Cases) test(`R300 контрфакт: ${c.name}`, async () => {
  await run(c.body); await assert.rejects(() => run(c.body, c.edit), killed(c.label, c.actual, c.expected));
});

// R299: SDK настоящий, HTTP заменён только адаптером fetch→Fastify.inject, WS — мостом к настоящему entrypoint.
// Нет TCP-порта/реального Redis; SQL, авторизация, команды, sendMessage/ctx.reply и отзыв токена настоящие.
function sdkDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function sdkBounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_yes, no) => {
      timer = setTimeout(() => no(new Error(`R299 watchdog: ${label}`)), 30_000);
    })]);
  } finally { clearTimeout(timer); }
}
function sdkTransport(f: Fixture, before?: (method: string, params: Record<string, unknown>, signal: AbortSignal | null | undefined) => Promise<void>): typeof fetch {
  return async (input, init) => {
    assert.equal(typeof input, 'string', 'SDK передаёт URL строкой');
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://sdk.example.invalid');
    assert.equal(init?.method, 'POST'); assert.equal(typeof init?.body, 'string');
    const params = JSON.parse(init!.body as string) as Record<string, unknown>;
    await before?.(url.pathname.split('/').at(-1)!, params, init?.signal);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const reply = await f.app.inject({ method: 'POST', url: url.pathname + url.search, headers, payload: init!.body as string });
    await f.clean();
    return new Response(reply.body, { status: reply.statusCode, headers: { 'content-type': 'application/json' } });
  };
}
async function sdkReply(f: Fixture, cid: string, messageId: string, text: string) {
  const reply = await f.c.messageFor(messageId, 'owner'); assert.ok(reply && !('gone' in reply));
  assert.equal(reply.conversationId, cid); assert.equal(reply.content, text); assert.equal(reply.author.bot, true);
}

test('R299 SDK polling получает команду, отвечает ctx.reply и после перевыпуска токена получает 401', async () => run(async f => {
  const b = await ready(f); await f.send(b.cid, '/probe первый');
  const nextPoll = sdkDeferred<void>(), releasePoll = sdkDeferred<void>();
  const commands: string[][] = [], replies: string[] = [], errors: unknown[] = [];
  let blocked = false;
  const fetch = sdkTransport(f, async (method, params, signal) => {
    if (method !== 'getUpdates' || !params.offset || blocked || Array.isArray(params.allowed_updates) && params.allowed_updates.length === 0) return;
    blocked = true; nextPoll.resolve();
    // Второй запрос начинается только после полного завершения handler; удерживаем его до отзыва токена.
    await new Promise<void>((yes, no) => {
      const abort = () => { no(signal?.reason ?? new Error('SDK polling aborted')); };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      void releasePoll.promise.then(() => { signal?.removeEventListener('abort', abort); yes(); });
    });
  });
  const bot = new SdkBot(b.token, { baseUrl: 'https://sdk.example.invalid', discover: false, fetch, log: false });
  bot.catch(error => { errors.push(error); });
  bot.command('probe', async ctx => { commands.push(ctx.args); replies.push((await ctx.reply('Ответ SDK polling')).message_id); });
  bot.on('message', () => assert.fail('зарегистрированная команда не должна дублироваться как обычное сообщение'));
  const ended = bot.start({ mode: 'polling', timeout: 0 }).then(() => ({ error: undefined as unknown }), error => ({ error }));
  try {
    await sdkBounded(nextPoll.promise, 'следующий polling после команды');
    assert.deepEqual(commands, [['первый']]); assert.equal(replies.length, 1); assert.deepEqual(errors, []);
    await sdkReply(f, b.cid, replies[0], 'Ответ SDK polling');
    const rotated = await f.request('owner', 'POST', `/bots/${b.bot.id}/token`); assert.equal(rotated.statusCode, 200);
    releasePoll.resolve();
    const result = await sdkBounded(ended, 'polling отозванного токена');
    assert.ok(result.error instanceof SdkApiError); assert.equal(result.error.code, 401); assert.equal(result.error.method, 'getUpdates');
    assert.equal(bot.isRunning, false);
  } finally { releasePoll.resolve(); await sdkBounded(bot.stop(), 'остановка polling'); }
}));

test('R299 SDK WS получает команду, отвечает ctx.reply, подтверждает обработанное и видит отзыв токена', async () => run(async f => {
  const b = await ready(f); await f.send(b.cid, '/probe второй');
  const acked = sdkDeferred<number>();
  const entered = sdkDeferred<void>(), finishCommand = sdkDeferred<void>();
  let ackOffset: number | undefined;
  const serverTasks: Promise<void>[] = [];
  const serverErrors: unknown[] = [];
  const sockets: SdkSocket[] = [];
  const commands: string[][] = [], replies: string[] = [];
  const serverFrames: string[] = [];
  class SdkSocket implements WebSocketLike {
    readyState = 1;
    onopen: WebSocketLike['onopen'] = null;
    onmessage: WebSocketLike['onmessage'] = null;
    onclose: WebSocketLike['onclose'] = null;
    onerror: WebSocketLike['onerror'] = null;
    private readonly handlers = new Map<string, (...args: any[]) => void>();
    constructor(url: string, init: { headers: Record<string, string> }) {
      sockets.push(this);
      const target = new URL(url); assert.equal(target.href, 'wss://sdk.example.invalid/api/bot/v1/ws');
      const client = this;
      const peer: Socket & { readonly readyState: number } = { get readyState() { return client.readyState; }, send: data => {
        if (this.readyState !== 1) return;
        serverFrames.push(JSON.parse(data).op); this.onmessage?.({ data });
      }, close: (code, reason) => this.close(code, reason), on: (event, cb) => { this.handlers.set(event, cb); } };
      // Настоящий WebSocket не присылает кадры синхронно из конструктора, до установки SDK.onmessage.
      const serving = Promise.resolve().then(() => f.api.__serve(peer, { headers: init.headers, query: {}, ip: '192.0.2.1' }));
      void serving.catch(error => { serverErrors.push(error); });
      serverTasks.push(serving);
    }
    send(data: string) {
      const frame = JSON.parse(data);
      this.handlers.get('message')?.(data);
      if (frame.op === 'ack') { ackOffset = frame.offset; acked.resolve(frame.offset); }
    }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3; this.handlers.get('close')?.(); this.onclose?.({ code, reason });
    }
  }
  const bot = new SdkBot(b.token, { baseUrl: 'https://sdk.example.invalid', discover: false, fetch: sdkTransport(f), WebSocket: SdkSocket, log: false });
  const errors: unknown[] = [];
  bot.catch(error => { errors.push(error); });
  bot.command('probe', async ctx => {
    commands.push(ctx.args); entered.resolve(); await finishCommand.promise;
    replies.push((await ctx.reply('Ответ SDK WS')).message_id);
  });
  bot.on('message', () => assert.fail('команда не должна попасть в общий обработчик'));
  const ended = bot.start().then(() => ({ error: undefined as unknown }), error => ({ error }));
  try {
    await sdkBounded(entered.promise, 'WS команда вошла в обработчик');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(ackOffset, undefined, 'SDK не подтверждает команду, пока её обработчик удерживается');
    assert.equal(await f.store.pendingCount(b.bot.id), 1);
    assert.deepEqual(replies, []);
    finishCommand.resolve();
    const offset = await sdkBounded(acked.promise, 'SDK WS ack после команды'); await f.clean();
    assert.deepEqual(commands, [['второй']]); assert.equal(replies.length, 1); assert.deepEqual(errors, []); assert.deepEqual(serverErrors, []);
    await sdkReply(f, b.cid, replies[0], 'Ответ SDK WS');
    assert.equal(offset > 0, true); assert.deepEqual(serverFrames, ['hello', 'update']);
    assert.equal(await f.store.pendingCount(b.bot.id), 0, 'настоящий сервер обработал ack SDK');
    const rotated = await f.request('owner', 'POST', `/bots/${b.bot.id}/token`); assert.equal(rotated.statusCode, 200);
    const result = await sdkBounded(ended, 'WS отозванного токена');
    assert.ok(result.error instanceof SdkApiError); assert.equal(result.error.code, 401); assert.equal(result.error.method, 'ws');
    assert.equal(bot.isRunning, false);
  } finally {
    finishCommand.resolve();
    for (const socket of sockets) socket.close();
    await sdkBounded(bot.stop(), 'остановка SDK WS');
    await sdkBounded(Promise.all(serverTasks), 'завершение WS сервера');
  }
}));
