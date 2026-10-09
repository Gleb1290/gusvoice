import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { eq, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyError, type FastifyRequest, type FastifyReply } from 'fastify';
import { after, before, beforeEach, test } from 'node:test';
import { FEATURE_CONV6, Permission } from '@gusvoice/shared';
import { createTestDb, truncateAll, type TestDb } from './harness.js';
import { setDmWriteBarrierForTests } from '../src/dmWriteBarrier.js';

// Управляемые тестовые значения задаются до первого импорта env/push: никаких локальных .env тест не читает.
process.env.NTFY_BASE_URL = 'https://ntfy.example.test';
process.env.NTFY_TOKEN = 'integration-push-token';
process.env.PUBLIC_API_URL = 'https://api.example.test';

let t: TestDb;
let app: ReturnType<typeof Fastify>;
let tokenFor: (id: string) => string;
let forgetTokenGeneration: typeof import('../src/auth.js').forgetTokenGeneration;
const testTokenGenerations = new Map<string, number>();
let resetBlockCache: () => void;
let deliver: typeof import('../src/conversations.js').deliver;
let attachmentLink: typeof import('../src/attachments.js').attachmentLink;
let setAttachmentStoreForTests: typeof import('../src/attachments.js').setAttachmentStoreForTests;
let createPending: typeof import('../src/attachments.js').createPending;
let purgeAttachments: typeof import('../src/attachments.js').purgeAttachments;
let sendPushToUsers: typeof import('../src/push.js').sendPushToUsers;
let redisPub: typeof import('../src/realtime.js').redisPub;
const published: { channel: string; message: string }[] = [];
const posted: { url: string; init: RequestInit }[] = [];

const authHeader = (id: string) => ({ authorization: `Bearer ${tokenFor(id)}` });

function routedDmEvents(): { old: string[]; fresh: string[] } {
  const old: string[] = [];
  const fresh: string[] = [];
  for (const p of published) {
    const envelope = JSON.parse(p.message) as { m: { t: string }; cap?: string; notCap?: string };
    const user = p.channel.replace(/^gw:user:/, '');
    if (envelope.m.t.startsWith('dm.') || envelope.m.t === 'read.dm') {
      assert.equal(envelope.notCap, 'conv1');
      assert.equal(envelope.cap, undefined);
      old.push(`${user}:${envelope.m.t}`);
    } else if (envelope.m.t === 'conv.change') {
      assert.equal(envelope.cap, 'conv1');
      assert.equal(envelope.notCap, undefined);
      fresh.push(`${user}:${envelope.m.t}`);
    }
  }
  return { old: old.sort(), fresh: fresh.sort() };
}

function expectDmEvents(old: string[], fresh: string[]): void {
  assert.deepEqual(routedDmEvents(), { old: [...old].sort(), fresh: [...fresh].sort() });
}

async function mutantConversations(change: (s: string) => string, changeRules?: (s: string) => string, overrides: Record<string, unknown> = {}) {
  // Компилируется настоящий модуль; подмена только в памяти, база и SQL остаются настоящими.
  function compile(raw: string, deps: Record<string, unknown>) {
    const module = { exports: {} as Record<string, unknown> };
    const code = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(code, { module, exports: module.exports, Date, Map, Set, Buffer, require: (id: string) => { assert.ok(Object.hasOwn(deps, id), id); return deps[id]; } });
    return module.exports;
  }
  let rules: unknown = await import('../src/convRules.js');
  if (changeRules) {
    const raw = readFileSync(new URL('../src/convRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n'); const changed = changeRules(raw);
    assert.notEqual(changed, raw); rules = compile(changed, { 'node:crypto': await import('node:crypto') });
  }
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': await import('@gusvoice/shared'), 'drizzle-orm': await import('drizzle-orm'),
    './convRules.js': rules, './db/index.js': await import('../src/db/index.js'), './db/schema.js': await import('../src/db/schema.js'),
    './dmWriteBarrier.js': await import('../src/dmWriteBarrier.js'), './attachments.js': await import('../src/attachments.js'),
    './env.js': await import('../src/env.js'), './serialize.js': await import('../src/serialize.js'),
    './util.js': await import('../src/util.js'), './realtime.js': await import('../src/realtime.js'),
  };
  Object.assign(deps, overrides);
  const raw = readFileSync(new URL('../src/conversations.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const changed = change(raw); if (!changeRules) assert.notEqual(changed, raw);
  return compile(changed, deps) as unknown as typeof import('../src/conversations.js');
}

async function mutantAttachments(change: (s: string) => string) {
  const actual = await import('../src/attachments.js');
  const deps: Record<string, unknown> = {
    'drizzle-orm': await import('drizzle-orm'),
    './attachmentRules.js': await import('../src/attachmentRules.js'),
    './db/index.js': await import('../src/db/index.js'),
    './db/schema.js': await import('../src/db/schema.js'),
    './dmWriteBarrier.js': await import('../src/dmWriteBarrier.js'),
    './env.js': await import('../src/env.js'),
    './storage.js': await import('../src/storage.js'),
    './util.js': await import('../src/util.js'),
  };
  const raw = readFileSync(new URL('../src/attachments.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const changed = change(raw);
  assert.notEqual(changed, raw);
  const module = { exports: {} as Record<string, unknown> };
  const code = ts.transpileModule(changed, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { module, exports: module.exports, Date, Map, Set, Buffer, Promise, Error, console,
    setTimeout, clearTimeout, require: (id: string) => { assert.ok(Object.hasOwn(deps, id), id); return deps[id]; } });
  return module.exports as typeof actual;
}

async function compilePushDefer(source: string): Promise<typeof import('../src/pushDefer.js')> {
  const module = { exports: {} as Record<string, unknown> };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const deps: Record<string, unknown> = {
    'drizzle-orm': await import('drizzle-orm'),
    './db/index.js': { db: t.db },
    './db/schema.js': await import('../src/db/schema.js'),
    './pushRules.js': await import('../src/pushRules.js'),
    './realtime.js': { redisPub },
  };
  runInNewContext(code, { module, exports: module.exports, Date, Map, Set, Promise, require: (id: string) => {
    assert.ok(Object.hasOwn(deps, id), `unexpected pushDefer dependency: ${id}`);
    return deps[id];
  } });
  return module.exports as unknown as typeof import('../src/pushDefer.js');
}

async function compilePush(source: string, overrides: Record<string, unknown> = {}): Promise<typeof import('../src/push.js')> {
  const module = { exports: {} as Record<string, unknown> };
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': await import('@gusvoice/shared'),
    './federation/instanceLabels.js': await import('../src/federation/instanceLabels.js'),
    './permissions.js': await import('../src/permissions.js'),
    'drizzle-orm': await import('drizzle-orm'),
    './db/index.js': await import('../src/db/index.js'),
    './db/schema.js': await import('../src/db/schema.js'),
    './env.js': await import('../src/env.js'),
    './pushCrypto.js': await import('../src/pushCrypto.js'),
    './pushDefer.js': await import('../src/pushDefer.js'),
    './pushRules.js': await import('../src/pushRules.js'),
    './util.js': await import('../src/util.js'),
  };
  Object.assign(deps, overrides);
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, {
    module, exports: module.exports, Date, Map, Set, Buffer, Promise, console, fetch: globalThis.fetch,
    setTimeout, clearTimeout,
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `unexpected push dependency: ${id}`); return deps[id]; },
  });
  return module.exports as unknown as typeof import('../src/push.js');
}

function legacyEventShapes(): string[] {
  return published.map((p) => {
    const m = JSON.parse(p.message).m as Record<string, unknown>;
    if (!m.t || !(String(m.t).startsWith('dm.') || m.t === 'read.dm')) return null;
    const nested = m.message ?? m.channel;
    return JSON.stringify([p.channel, m.t, Object.keys(m).sort(), nested && typeof nested === 'object' ? Object.keys(nested).sort() : []]);
  }).filter((shape): shape is string => shape !== null).sort();
}

before(async () => {
  t = await createTestDb();
  // Старые тестовые INSERT не выдают ключ сами: одна монотонная последовательность только для фикстур.
  await t.raw.exec(`CREATE SEQUENCE test_message_sort_key;
    ALTER SEQUENCE test_message_sort_key OWNED BY conversation_messages.sort_key;
    ALTER TABLE conversation_messages ALTER COLUMN sort_key SET DEFAULT nextval('test_message_sort_key')`);
  const auth = await import('../src/auth.js');
  const { authRoutes } = await import('../src/routes/auth.js');
  const { attRoutes } = await import('../src/routes/att.js');
  const { blockRoutes } = await import('../src/routes/blocks.js');
  const { convRoutes } = await import('../src/routes/conv.js');
  const { dmRoutes } = await import('../src/routes/dm.js');
  const { messageRoutes } = await import('../src/routes/messages.js');
  const { pushRoutes } = await import('../src/routes/push.js');
  const { unreadRoutes } = await import('../src/routes/unread.js');
  ({ resetBlockCacheForTests: resetBlockCache } = await import('../src/blocks.js'));
  ({ deliver } = await import('../src/conversations.js'));
  ({ attachmentLink, setAttachmentStoreForTests, createPending, purgeAttachments } = await import('../src/attachments.js'));
  ({ sendPushToUsers } = await import('../src/push.js'));
  ({ redisPub } = await import('../src/realtime.js'));
  redisPub.publish = (async (channel: string, message: string) => {
    published.push({ channel, message });
    return 1;
  }) as typeof redisPub.publish;
  redisPub.incr = (async () => 1) as typeof redisPub.incr;
  redisPub.expire = (async () => 1) as typeof redisPub.expire;
  redisPub.ttl = (async () => 300) as typeof redisPub.ttl;
  forgetTokenGeneration = auth.forgetTokenGeneration;
  tokenFor = (id) => auth.signToken({ sub: id, username: id, gen: testTokenGenerations.get(id) ?? 0 });

  app = Fastify();
  // Как в index.ts: без обработчика приложения Fastify превращает отказ схемы в 500.
  // Исполняем обработчик index.ts: первый Zod issue — часть публичного API, а не синтетическое "validation" харнесса.
  const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const handlerStart = indexSource.indexOf('app.setErrorHandler('), handlerEnd = indexSource.indexOf('\n});', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'найден настоящий error handler');
  runInNewContext(ts.transpileModule(indexSource.slice(handlerStart, handlerEnd + 4), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { app, ZodError });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  await app.register(authRoutes);
  await app.register(attRoutes);
  await app.register(blockRoutes);
  await app.register(dmRoutes);
  await app.register(convRoutes);
  await app.register(messageRoutes);
  await app.register(pushRoutes);
  await app.register(unreadRoutes);
  await app.ready();
});

beforeEach(async () => {
  testTokenGenerations.clear();
  for (const id of ['a', 'b', 'c', 'd']) forgetTokenGeneration(id);
  setDmWriteBarrierForTests({});
  await truncateAll(t.raw);
  resetBlockCache();
  published.length = 0;
  posted.length = 0;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (url: string, init: RequestInit) => {
      posted.push({ url, init });
      return new Response(null, { status: 200 });
    },
  });
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES
      ('a', 'alpha', 'Alpha', 'hash'),
      ('b', 'bravo', 'Bravo', 'hash'),
      ('c', 'charlie', 'Charlie', 'hash');
    INSERT INTO servers (id, name, owner_id) VALUES ('s', 'Server', 'a');
    INSERT INTO server_members (server_id, user_id) VALUES ('s', 'a'), ('s', 'b'), ('s', 'c');
    INSERT INTO roles (id, server_id, name, permissions, is_everyone)
      VALUES ('everyone', 's', 'everyone', '${Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES}', true);
    INSERT INTO channels (id, server_id, name, type) VALUES
      ('ch', 's', 'chat', 'text'), ('foreign-ch', 's', 'other', 'text');
    INSERT INTO conversations (id, kind, direct_key, created_by, last_message_at) VALUES
      ('dm', 'direct', 'a:b', 'a', '2026-09-20T10:00:00Z'),
      ('foreign-dm', 'direct', 'a:c', 'a', '2026-09-20T10:00:00Z');
    INSERT INTO conversation_members (conversation_id, user_id) VALUES
      ('dm', 'a'), ('dm', 'b'), ('foreign-dm', 'a'), ('foreign-dm', 'c');
  `);
});

after(async () => {
  setDmWriteBarrierForTests({});
  setAttachmentStoreForTests(null);
  await app.close();
  redisPub.disconnect();
  await t.close();
});

function pushKeys() {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const auth = randomBytes(16);
  return {
    receiver,
    auth,
    public: { p256dh: receiver.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
}

test('регистрация устройства отвергает плохой пояс, обновляет хороший и сохраняет его при старом клиенте', async () => {
  const { registerPushDevice } = await import('../src/push.js');
  const read = async () => (await t.raw.query<{ tz: string | null; endpoint: string }>("SELECT tz,endpoint FROM push_devices WHERE user_id='a' AND device_id='tz-phone'")).rows;
  await registerPushDevice('a', 'tz-phone', 'https://ntfy.example.test/first', 'android', null, null, 'Not/AZone');
  assert.deepEqual(await read(), [{ tz: null, endpoint: 'https://ntfy.example.test/first' }]);
  await registerPushDevice('a', 'tz-phone', 'https://ntfy.example.test/moscow', 'android', null, null, 'Europe/Moscow');
  assert.equal((await read())[0].tz, 'Europe/Moscow');
  await registerPushDevice('a', 'tz-phone', 'https://ntfy.example.test/legacy', 'android');
  assert.deepEqual(await read(), [{ tz: 'Europe/Moscow', endpoint: 'https://ntfy.example.test/legacy' }]);
  await registerPushDevice('a', 'tz-phone', 'https://ntfy.example.test/invalid', 'android', null, null, 'Not/AZone');
  assert.equal((await read())[0].tz, 'Europe/Moscow');
  await registerPushDevice('a', 'tz-phone', 'https://ntfy.example.test/utc', 'android', null, null, 'UTC');
  assert.equal((await read())[0].tz, 'UTC');
  const raw = readFileSync(new URL('../src/push.ts', import.meta.url), 'utf8');
  const coalesce = 'tz: sql`coalesce(${tz}, ${pushDevices.tz})`';
  assert.ok(raw.includes(coalesce));
  const mutant = await compilePush(raw.replace(coalesce, 'tz'));
  await mutant.registerPushDevice('a', 'tz-phone', 'https://ntfy.example.test/rollback', 'android');
  assert.notEqual((await read())[0].tz, 'UTC', 'контрфакт без coalesce теряет сохранённый пояс');
  const validation = 'const tz = validTimeZone(tzIn) ? tzIn : null;';
  assert.ok(raw.includes(validation));
  const noValidation = await compilePush(raw.replace(validation, 'const tz = tzIn;'));
  await noValidation.registerPushDevice('a', 'tz-invalid', 'https://ntfy.example.test/invalid-new', 'android', null, null, 'Not/AZone');
  assert.equal((await t.raw.query<{ tz: string }>("SELECT tz FROM push_devices WHERE device_id='tz-invalid'")).rows[0].tz, 'Not/AZone', 'контрфакт без проверки хранит неподдерживаемый пояс');
});

test('ночной повтор ждёт 11:00 с прежним номером и firstAt, дневной и без пояса доставляются', async () => {
  await t.raw.exec(`INSERT INTO push_devices (id,user_id,device_id,endpoint,platform,tz) VALUES
    ('tz-a','a','phone','https://ntfy.example.test/a','android','Europe/Moscow');
    UPDATE users SET notify_repeat=60 WHERE id='a'`);
  const raw = readFileSync(new URL('../src/push.ts', import.meta.url), 'utf8');
  const held: unknown[][] = [];
  const defer = await import('../src/pushDefer.js');
  const push = await compilePush(raw, { './pushDefer.js': { ...defer, recipientActive: () => false,
    postponeRepeatPush: async (...args: unknown[]) => { held.push(args); }, scheduleRepeatPush: async () => {} } });
  const originalNow = Date.now;
  const payload = { type: 'dm' as const, title: 'Б', body: 'текст', dmId: 'dm', key: 10 };
  const at = Date.parse('2026-10-09T20:30:00Z');
  try {
    Date.now = () => at;
    await push.sendPushToUsers(['a'], payload, undefined, { private: true, noDefer: true, repeat: 2, firstAt: at - 3600_000 });
    assert.equal(posted.length, 0);
    assert.equal(held.length, 1);
    const [item, now, wait] = held[0] as [{ uid: string; repeat: number; firstAt: number }, number, number];
    assert.equal(item.uid, 'a'); assert.equal(item.repeat, 2); assert.equal(item.firstAt, at - 3600_000);
    assert.equal(now, at); assert.equal(wait, 11.5 * 3600_000);
    const nightGuard = 'if (opts.repeat && all.length > 0) {';
    assert.ok(raw.includes(nightGuard));
    const noNight = await compilePush(raw.replace(nightGuard, 'if (false) {'), { './pushDefer.js': { ...defer, recipientActive: () => false, scheduleRepeatPush: async () => {} } });
    await noNight.sendPushToUsers(['a'], payload, undefined, { private: true, noDefer: true, repeat: 2, firstAt: at - 3600_000 });
    assert.equal(posted.length, 1, 'контрфакт без ночного окна действительно отправляет повтор');
    posted.length = 0;
    await push.sendPushToUsers(['a'], payload, undefined, { private: true, noDefer: true });
    assert.equal(posted.length, 1, 'первое сообщение ночью не задерживается');
    posted.length = 0;
    held.length = 0;
    Date.now = () => Date.parse('2026-10-09T09:00:00Z');
    await push.sendPushToUsers(['a'], payload, undefined, { private: true, noDefer: true, repeat: 2 });
    assert.equal(posted.length, 1); assert.equal(held.length, 0);
    posted.length = 0;
    Date.now = () => at;
    await t.raw.exec("UPDATE push_devices SET tz=NULL WHERE user_id='a'");
    await push.sendPushToUsers(['a'], payload, undefined, { private: true, noDefer: true, repeat: 2 });
    assert.equal(posted.length, 1); assert.equal(held.length, 0);
    posted.length = 0;
    await t.raw.exec("UPDATE push_devices SET tz='Europe/Moscow' WHERE user_id='a'");
    await push.sendPushToUsers(['a'], payload, undefined, { private: true, noDefer: true, repeat: 2, firstAt: at - 23 * 3600_000 });
    assert.equal(posted.length, 0); assert.equal(held.length, 0, 'утро за пределами суток не продлевает цепочку');
  } finally { Date.now = originalNow; }
});

test('серверный черновик виден и журналируется только владельцу, повтор другого устройства молчит', async () => {
  const put = (device: string) => app.inject({ method: 'PUT', url: '/conv/dm/draft', headers: authHeader('a'), payload: { text: 'секретный набросок', replyToId: null, device } });
  assert.equal((await put('device-a')).statusCode, 204);
  assert.deepEqual(published.map((p) => p.channel), ['gw:user:a']);
  const a = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') })).json();
  const b = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') })).json();
  assert.equal(a.conversations.find((c: { id: string }) => c.id === 'dm').draft.text, 'секретный набросок');
  assert.equal(b.conversations.find((c: { id: string }) => c.id === 'dm').draft, null);
  const journal = await t.raw.query<{ user_id: string; kind: string }>('SELECT user_id, kind FROM user_changes');
  assert.deepEqual(journal.rows, [{ user_id: 'a', kind: 'draft' }]);
  published.length = 0; assert.equal((await put('device-b')).statusCode, 204); assert.equal(published.length, 0);
  assert.equal((await t.raw.query('SELECT * FROM user_changes')).rows.length, 1);
});
test('миграция черновиков допускает draft в журнале, но отвергает неизвестный вид', async () => {
  assert.ok(t.appliedMigrations.some((name) => name.startsWith('0081')));
  await t.raw.exec("INSERT INTO user_sync (user_id) VALUES ('a') ON CONFLICT DO NOTHING");
  await assert.rejects(t.raw.exec("INSERT INTO user_changes (user_id, pts, conversation_id, kind) VALUES ('a', 1, 'dm', 'unknown')"));
  await t.raw.exec("INSERT INTO user_changes (user_id, pts, conversation_id, kind) VALUES ('a', 1, 'dm', 'draft')");
  assert.equal((await t.raw.query<{ kind: string }>('SELECT kind FROM user_changes')).rows[0].kind, 'draft');
});

test('очистка черновика обнуляет все четыре колонки, повтор пустого не журналируется', async () => {
  const put = (text: string) => app.inject({ method: 'PUT', url: '/conv/dm/draft', headers: authHeader('a'), payload: { text, replyToId: null, device: 'me' } });
  assert.equal((await put('x')).statusCode, 204); assert.equal((await put(' \n ')).statusCode, 204);
  const row = await t.raw.query('SELECT draft_text, draft_reply_to, draft_at, draft_device FROM conversation_members WHERE conversation_id=\'dm\' AND user_id=\'a\'');
  assert.deepEqual(row.rows[0], { draft_text: null, draft_reply_to: null, draft_at: null, draft_device: null });
  assert.equal((await t.raw.query('SELECT * FROM user_changes')).rows.length, 2);
  assert.equal((await put('')).statusCode, 204); assert.equal((await t.raw.query('SELECT * FROM user_changes')).rows.length, 2);
});

test('границы текста и метки черновика принимаются, превышение и чужой участник отклоняются', async () => {
  const put = (user: string, text: string, device: string) => app.inject({ method: 'PUT', url: '/conv/dm/draft', headers: authHeader(user), payload: { text, replyToId: null, device } });
  assert.equal((await put('a', 'x'.repeat(4096), 'a'.repeat(64))).statusCode, 204);
  assert.equal((await put('a', 'x'.repeat(4097), 'me')).statusCode, 400);
  for (const device of ['', 'a'.repeat(65), 'bad device']) assert.equal((await put('a', 'x', device)).statusCode, 400);
  assert.equal((await put('c', 'x', 'me')).statusCode, 404);
  await t.raw.exec("UPDATE conversation_members SET left_at=now() WHERE conversation_id='dm' AND user_id='b'");
  assert.equal((await put('b', 'x', 'me')).statusCode, 404);
});

test('ответ черновика сохраняется только на видимое сообщение своей беседы', async () => {
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, hidden_for, withheld) VALUES
    ('visible', 'dm', 'b', 'x', '{}', false), ('foreign', 'foreign-dm', 'a', 'x', '{}', false),
    ('hidden', 'dm', 'b', 'x', '{a}', false), ('withheld', 'dm', 'b', 'x', '{}', true)`);
  for (const id of ['visible', 'foreign', 'missing', 'hidden', 'withheld']) {
    const res = await app.inject({ method: 'PUT', url: '/conv/dm/draft', headers: authHeader('a'), payload: { text: 'draft', replyToId: id, device: 'me' } });
    assert.equal(res.statusCode, 204);
    const row = await t.raw.query<{ draft_reply_to: string | null }>("SELECT draft_reply_to FROM conversation_members WHERE conversation_id='dm' AND user_id='a'");
    assert.equal(row.rows[0].draft_reply_to, id === 'visible' ? id : null);
  }
});

test('догонка отдаёт новый черновик, отправленное сообщение его намеренно не гасит', async () => {
  const initial = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') })).json().pts;
  assert.equal((await app.inject({ method: 'PUT', url: '/conv/dm/draft', headers: authHeader('a'), payload: { text: 'набранное', replyToId: null, device: 'me' } })).statusCode, 204);
  const sync = (await app.inject({ method: 'GET', url: `/conv/sync?pts=${initial}`, headers: authHeader('a') })).json();
  assert.equal(sync.conversations.find((c: { id: string }) => c.id === 'dm').draft.text, 'набранное');
  const sent = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: { content: 'отдельное', clientId: '10000000-0000-4000-8000-000000000099', attachments: [] } });
  assert.equal(sent.statusCode, 201);
  const row = await t.raw.query<{ draft_text: string }>("SELECT draft_text FROM conversation_members WHERE conversation_id='dm' AND user_id='a'");
  assert.equal(row.rows[0].draft_text, 'набранное');
});

test('лимит записи черновика принимает тридцатую и отклоняет тридцать первую', async () => {
  const incr = redisPub.incr; let hits = 0;
  redisPub.incr = (async () => ++hits) as typeof redisPub.incr;
  try {
    for (let i = 1; i <= 31; i++) {
      const res = await app.inject({ method: 'PUT', url: '/conv/dm/draft', headers: authHeader('a'), payload: { text: String(i), replyToId: null, device: 'me' } });
      assert.equal(res.statusCode, i <= 30 ? 204 : 429);
    }
  } finally { redisPub.incr = incr; }
});

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function decryptPush(body: Buffer, receiver: ReturnType<typeof createECDH>, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const keyLength = body[20]!;
  const sender = body.subarray(21, 21 + keyLength);
  const shared = receiver.computeSecret(sender);
  const prkKey = hmac(auth, shared);
  const info = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), receiver.getPublicKey(), sender]);
  const ikm = hmac(prkKey, Buffer.concat([info, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const sealed = body.subarray(21 + keyLength);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const clear = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  assert.equal(clear.at(-1), 2);
  return clear.subarray(0, -1);
}

test('регистрация пуша сохраняет ключи, отвергает кривые и стирает ключи при откате клиента', async () => {
  // Ловит как нешифрованный пуш новому APK, так и шифр, который откатившаяся версия уже не прочтёт.
  const keys = pushKeys().public;
  const valid = await app.inject({
    method: 'POST', url: '/push/register', headers: authHeader('a'),
    payload: { endpoint: 'https://ntfy.example.test/a', deviceId: 'phone', platform: 'android', keys },
  });
  assert.equal(valid.statusCode, 204);
  let rows = await t.raw.query<{ p256dh: string | null; auth: string | null }>(
    `SELECT p256dh, auth FROM push_devices WHERE user_id = 'a' AND device_id = 'phone'`,
  );
  assert.deepEqual(rows.rows, [{ p256dh: keys.p256dh, auth: keys.auth }]);

  const invalid = await app.inject({
    method: 'POST', url: '/push/register', headers: authHeader('a'),
    payload: { endpoint: 'https://ntfy.example.test/a', deviceId: 'bad', keys: { ...keys, auth: 'AA' } },
  });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { error: 'invalid push keys' });

  const rollback = await app.inject({
    method: 'POST', url: '/push/register', headers: authHeader('a'),
    payload: { endpoint: 'https://ntfy.example.test/a', deviceId: 'phone', platform: 'android' },
  });
  assert.equal(rollback.statusCode, 204);
  rows = await t.raw.query(`SELECT p256dh, auth FROM push_devices WHERE user_id = 'a' AND device_id = 'phone'`);
  assert.deepEqual(rows.rows, [{ p256dh: null, auth: null }]);
});

test('регистрация не принимает точку P-256 верной формы, но вне кривой', async () => {
  // Ловит сохранение ключа, который падает только во время фоновой доставки пуша.
  const keys = pushKeys().public;
  const invalidPoint = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url');
  const response = await app.inject({
    method: 'POST', url: '/push/register', headers: authHeader('a'),
    payload: { endpoint: 'https://ntfy.example.test/a', deviceId: 'off-curve', keys: { ...keys, p256dh: invalidPoint } },
  });
  assert.equal(response.statusCode, 400);
  const rows = await t.raw.query(`SELECT id FROM push_devices WHERE device_id = 'off-curve'`);
  assert.equal(rows.rows.length, 0);
});

test('повреждённый сохранённый ключ отправляет только обезличенный запасной пуш', async () => {
  // Ловит утечку текста ЛС в ntfy, если шифрование падает уже после регистрации устройства.
  const keys = pushKeys().public;
  const invalidPoint = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url');
  await t.raw.query(
    `INSERT INTO push_devices (id, user_id, device_id, endpoint, platform, p256dh, auth)
     VALUES ('corrupt', 'a', 'phone', 'https://ntfy.example.test/corrupt', 'android', $1, $2)`,
    [invalidPoint, keys.auth],
  );
  await sendPushToUsers(['a'], { type: 'dm', title: 'Bravo', body: 'секрет', dmId: 'dm' });
  assert.equal(posted.length, 1);
  const wire = posted[0]!.init;
  assert.equal((wire.headers as Record<string, string>)['Content-Encoding'], undefined);
  assert.equal(String(wire.body).includes('секрет'), false);
  assert.equal(JSON.parse(String(wire.body)).dmId, 'dm');
});

test('рассылка шифрует устройство с ключами и сохраняет прежний JSON без ключей', async () => {
  // Ловит открытый текст на новом устройстве, забытый X-UnifiedPush и преждевременную редактировку legacy-пуша.
  const encrypted = pushKeys();
  await t.raw.exec(`
    INSERT INTO push_devices (id, user_id, device_id, endpoint, platform, p256dh, auth) VALUES
      ('p1', 'a', 'encrypted', 'https://ntfy.example.test/encrypted', 'android',
       '${encrypted.public.p256dh}', '${encrypted.public.auth}'),
      ('p2', 'a', 'legacy', 'https://ntfy.example.test/legacy', 'android', null, null)
  `);
  const payload = { type: 'dm' as const, title: 'Bravo', body: 'секрет', dmId: 'dm' };
  await sendPushToUsers(['a'], payload);
  assert.equal(posted.length, 2);
  const secure = posted.find((p) => p.url.endsWith('/encrypted'))!;
  const legacy = posted.find((p) => p.url.endsWith('/legacy'))!;
  const secureHeaders = secure.init.headers as Record<string, string>;
  assert.equal(secureHeaders['Content-Encoding'], 'aes128gcm');
  assert.equal(secureHeaders['X-UnifiedPush'], '1');
  assert.deepEqual(JSON.parse(decryptPush(Buffer.from(secure.init.body as Buffer), encrypted.receiver, encrypted.auth).toString()), payload);
  assert.deepEqual(JSON.parse(String(legacy.init.body)), payload);
});

test('R112 номер повтора есть только в отправке, не загрязняет очередь и сохраняется без звука', async () => {
  const keys = pushKeys();
  await t.raw.query(`INSERT INTO push_devices (id,user_id,device_id,endpoint,platform,p256dh,auth) VALUES
    ('rep-secure','a','secure','https://ntfy.example.test/rep-secure','android',$1,$2),
    ('rep-legacy','a','legacy','https://ntfy.example.test/rep-legacy','android',null,null)`,
  [keys.public.p256dh, keys.public.auth]);
  await t.raw.exec("UPDATE users SET notify_repeat=5 WHERE id='a'");
  const payload = { type: 'dm' as const, title: 'Б', body: 'текст', dmId: 'dm', key: 10, mid: 'repeat-mid' };
  const source = { scope: 'dm_user' as const, targetId: 'b' };
  const raw = readFileSync(new URL('../src/push.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const defer = await import('../src/pushDefer.js');
  const queued: Parameters<typeof defer.scheduleRepeatPush>[0][] = [];
  const load = (code: string) => compilePush(code, { './pushDefer.js': {
    ...defer, recipientActive: () => false,
    scheduleRepeatPush: async (item: Parameters<typeof defer.scheduleRepeatPush>[0]) => { queued.push(item); },
  } });
  const wires = () => posted.map((p) => JSON.parse(p.url.endsWith('rep-secure')
    ? decryptPush(Buffer.from(p.init.body as Buffer), keys.receiver, keys.auth).toString()
    : String(p.init.body)) as Record<string, unknown>);
  const check = async (code: string) => {
    const push = await load(code);
    for (const repeat of [undefined, 1, 3]) {
      posted.length = 0; queued.length = 0;
      await push.sendPushToUsers(['a'], payload, source, { private: true, noDefer: true, ...(repeat ? { repeat } : {}) });
      assert.equal(posted.length, 2, 'каждое устройство получает пуш');
      for (const wire of wires()) {
        assert.equal(Object.hasOwn(wire, 'repeat'), repeat !== undefined, 'обычная доставка не помечена повтором');
        if (repeat) assert.equal(wire.repeat, repeat, 'номер отправленного повтора соответствует очереди');
      }
      assert.equal(queued.length, 1, 'следующий повтор ставится один раз на получателя');
      assert.equal(Object.hasOwn(queued[0]!.payload, 'repeat'), false, 'очередь хранит исходную нагрузку без repeat');
      assert.equal(JSON.stringify(queued[0]!.payload), JSON.stringify(payload));
      assert.equal(queued[0]!.repeat, (repeat ?? 0) + 1);
      assert.equal(JSON.stringify(queued[0]!.source), JSON.stringify(source));
    }
    posted.length = 0; queued.length = 0;
    await push.sendPushToUsers(['a'], { ...payload, silent: true }, source, { private: true, noDefer: true, repeat: 2 });
    assert.equal(posted.length, 2);
    for (const wire of wires()) {
      assert.equal(wire.silent, true);
      assert.equal(wire.repeat, 2, 'тихий повтор сохраняет номер');
    }
    assert.equal(queued.length, 0, 'беззвучное сообщение не запускает новую цепочку');
  };
  await check(raw);
  const allRepeat = raw.replace('opts.repeat ? { ...payload, repeat: opts.repeat } : payload', '{ ...payload, repeat: opts.repeat ?? 1 }');
  assert.notEqual(allRepeat, raw);
  await assert.rejects(check(allRepeat), /обычная доставка не помечена повтором/);
  const noRepeat = raw.replace('opts.repeat ? { ...payload, repeat: opts.repeat } : payload', 'payload');
  assert.notEqual(noRepeat, raw);
  await assert.rejects(check(noRepeat), /обычная доставка не помечена повтором/);
  // Поднимаем sent до schedule: иначе мутант ловился бы по ReferenceError, а не по испорченной очереди.
  const sentLine = '  const sent: PushPayload = opts.repeat ? { ...payload, repeat: opts.repeat } : payload;';
  const queueSent = raw.replace(sentLine, '').replace(
    "  if (opts.private && payload.type === 'dm' && payload.dmId && typeof payload.key === 'number' && !payload.silent) {",
    `${sentLine}\n  if (opts.private && payload.type === 'dm' && payload.dmId && typeof payload.key === 'number' && !payload.silent) {`,
  ).replace('scheduleRepeatPush({ uid, payload,', 'scheduleRepeatPush({ uid, payload: sent,');
  assert.notEqual(queueSent, raw);
  await assert.rejects(check(queueSent), /очередь хранит исходную нагрузку без repeat/);
  const silentDropsRepeat = raw.replace('q ? { ...sent, silent: true as const } : sent', 'q ? { ...sent, silent: true as const } : (sent.silent ? payload : sent)');
  assert.notEqual(silentDropsRepeat, raw);
  await assert.rejects(check(silentDropsRepeat), /тихий повтор сохраняет номер/);
  await t.raw.exec("INSERT INTO push_mutes (user_id,scope,target_id,sound_only) VALUES ('a','dm_user','b',true)");
  const checkQuiet = async (code: string) => {
    posted.length = 0; queued.length = 0;
    const push = await load(code);
    await push.sendPushToUsers(['a'], payload, source, { private: true, noDefer: true, repeat: 4 });
    assert.equal(posted.length, 2);
    for (const wire of wires()) {
      assert.equal(wire.silent, true, 'заглушка звука даёт тихий вариант');
      assert.equal(wire.repeat, 4, 'тихий вариант по настройке получателя сохраняет repeat');
    }
    assert.equal(queued.length, 0, 'заглушка звука не запускает следующую задачу');
  };
  await checkQuiet(raw);
  const quietDropsRepeat = raw.replace('q ? { ...sent, silent: true as const } : sent', 'q ? { ...payload, silent: true as const } : sent');
  assert.notEqual(quietDropsRepeat, raw);
  await assert.rejects(checkQuiet(quietDropsRepeat), /тихий вариант по настройке получателя сохраняет repeat/);
  assert.equal(Object.hasOwn(payload, 'repeat'), false, 'исходный объект не мутируется');
});

test('выключенные личные сообщения отсекают получателя и гостя только для private-пуша', async () => {
  // Групповые уведомления и прежние вызовы sendPushToUsers не должны внезапно наследовать личный тумблер.
  await t.raw.exec(`
    INSERT INTO users (id,username,display_name,password_hash,home_instance_id,home_user_id)
      VALUES ('d','delta','Delta','hash','home','remote-d');
    UPDATE users SET notify_dm = false WHERE id IN ('a','b','d');
    INSERT INTO push_devices (id,user_id,device_id,endpoint,platform) VALUES
      ('pa','a','a-phone','https://ntfy.example.test/a','android'),
      ('pb','b','b-phone','https://ntfy.example.test/b','android'),
      ('pd','d','d-phone','https://ntfy.example.test/d','android');
  `);
  await sendPushToUsers(['a', 'd'], { type: 'dm', title: 'Галя', body: 'личное', dmId: 'dm', key: 1 }, undefined, { private: true });
  assert.equal(posted.length, 0, 'локального пользователя и гостя с notify_dm=false отсекают до отправки/уведомления дому');

  await sendPushToUsers(['a'], { type: 'dm', title: 'Группа', body: 'общее', dmId: 'group' });
  assert.equal(posted.length, 1, 'legacy/group-вызов без private остаётся незатронутым');
});

test('повтор после выключения настройки снимается, активный получатель откладывает его, потолок — 24', async () => {
  // Уже поставленный repeat перепроверяет настройку; за активным получателем тот же номер ждёт, всего не более 24 повторов.
  await t.raw.exec(`
    INSERT INTO push_devices (id,user_id,device_id,endpoint,platform) VALUES ('pa','a','a-phone','https://ntfy.example.test/a','android');
    UPDATE users SET notify_repeat = 0 WHERE id='a';
  `);
  const payload = { type: 'dm' as const, title: 'Б', body: 'текст', dmId: 'dm', key: 10 };
  await sendPushToUsers(['a'], payload, undefined, { private: true, repeat: 1 });
  assert.equal(posted.length, 0, 'повтор из старой очереди снят после notify_repeat=0');

  await t.raw.exec("UPDATE users SET notify_repeat = 5 WHERE id='a'");
  const { runPushDeferTick } = await import('../src/pushDefer.js');
  const defer = await import('../src/pushDefer.js');
  const original = {
    multi: redisPub.multi,
    zrangebyscore: redisPub.zrangebyscore,
    eval: redisPub.eval,
  };
  const items = new Map<string, string>();
  const due = new Map<string, number>();
  redisPub.multi = (() => {
    let id = '';
    let raw = '';
    let score = 0;
    const chain = {
      hset(_key: string, key: string, value: string) { id = key; raw = value; return chain; },
      hsetnx(_key: string, key: string, value: string) { id = key; raw = items.has(key) ? items.get(key)! : value; return chain; },
      zadd(_key: string, atOrNx: number | string, scoreOrAt: number | string, maybeKey?: string) {
        if (typeof atOrNx === 'string') {
          id = maybeKey!;
          score = Number(scoreOrAt);
          if (atOrNx === 'NX' && due.has(id)) blockedByNx = true;
        } else { id = String(scoreOrAt); score = atOrNx; }
        return chain;
      },
      exec: async () => { if (!blockedByNx) { items.set(id, raw); due.set(id, score); } return []; },
    };
    let blockedByNx = false;
    return chain;
  }) as unknown as typeof redisPub.multi;
  redisPub.zrangebyscore = (async (_key: string, _min: string | number, max: string | number) =>
    [...due].filter(([, at]) => at <= Number(max)).map(([id]) => id)) as typeof redisPub.zrangebyscore;
  redisPub.eval = (async (_script: string, _keys: number, _zkey: string, _hkey: string, id: string, now: string) => {
    const score = due.get(id);
    if (score === undefined || score > Number(now)) return null;
    due.delete(id);
    const raw = items.get(id) ?? null;
    items.delete(id);
    return raw;
  }) as unknown as typeof redisPub.eval;
  try {
    const oldFirstAt = Date.now() - 48 * 60 * 60_000;
    defer.setPushActivityProbe(() => true);
    await sendPushToUsers(['a'], payload, undefined, { private: true, repeat: 1, firstAt: oldFirstAt });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 0, 'повтор за активным ПК, но уже старше окна от первого пуша, всё равно снимается');
    assert.equal(items.size, 0, 'за пределами окна не ставится следующий repeat даже при активном получателе');

    const pushSource = readFileSync(new URL('../src/push.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const noWindowGuardSource = pushSource.replace(
      'if (opts.repeat && !notifyRepeatInWindow(firstAt, now)) return;',
      'if (opts.repeat && !notifyRepeatInWindow(firstAt, now)) { /* mutant: продолжить */ }',
    );
    assert.notEqual(noWindowGuardSource, pushSource, 'мутант действительно убирает ранний отказ просроченной цепочки');
    const noWindowGuard = await compilePush(noWindowGuardSource);
    defer.setPushActivityProbe(() => false);
    await noWindowGuard.sendPushToUsers(['a'], payload, undefined, { private: true, repeat: 1, firstAt: oldFirstAt });
    assert.equal(posted.length, 1, 'мутант без раннего отказа доставляет уже просроченный повтор');
    assert.equal(items.size, 0, 'поздний repeat не должен оставлять новую задачу за окном');
    posted.length = 0;

    const noFirstAtPostponeSource = pushSource.replace(
      'private: true, repeat: opts.repeat, firstAt',
      'private: true, repeat: opts.repeat',
    );
    assert.notEqual(noFirstAtPostponeSource, pushSource, 'мутант удаления firstAt из postpone найден');
    const noFirstAtPostpone = await compilePush(noFirstAtPostponeSource);
    const keptFirstAt = Date.now() - 60_000;
    defer.setPushActivityProbe(() => true);
    await noFirstAtPostpone.sendPushToUsers(['a'], payload, undefined, { noDefer: true, private: true, repeat: 1, firstAt: keptFirstAt });
    const lostFirstAt = JSON.parse(items.get('rep:a:dm')!);
    assert.equal(lostFirstAt.firstAt, undefined, 'runtime-мутант действительно теряет firstAt при переносе за ПК');
    items.clear(); due.clear();
    defer.setPushActivityProbe(() => false);

    await sendPushToUsers(['a'], payload, undefined, { private: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual([...due.keys()], ['rep:a:dm'], 'исходное сообщение ставит один repeat для беседы');
    const firstAt = JSON.parse(items.get('rep:a:dm')!).firstAt;
    assert.equal(typeof firstAt, 'number', 'первый push задаёт начало окна повторов');
    const repeats: number[] = [];
    defer.setPushActivityProbe(() => true);
    const held = await runPushDeferTick(async (item) => {
      repeats.push(item.repeat ?? 0);
      await sendPushToUsers([item.uid], item.payload, item.source, { noDefer: true, private: item.private === true, repeat: item.repeat, firstAt: item.firstAt });
    }, Date.now() + 10 * 60_000);
    assert.deepEqual(held, { sent: 1, read: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 1, 'активный получатель не получает повтор на телефон');
    assert.equal(JSON.parse(items.get('rep:a:dm')!).repeat, 1, 'повтор остаётся под тем же номером');
    const originalFirstAt = JSON.parse(items.get('rep:a:dm')!).firstAt;
    assert.equal(originalFirstAt, firstAt, 'перенос за ПК сохраняет исходное время цепочки');
    assert.ok(due.has('rep:a:dm'), 'повтор переносится на ближайшую проверку');
    assert.ok(pushSource.includes('private: true, repeat: opts.repeat, firstAt'), 'перенос в push.ts явно сохраняет firstAt');
    const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const indexWithoutFirstAt = indexSource.replace('...(item.repeat && typeof item.firstAt === \'number\' ? { firstAt: item.firstAt } : {}),', '');
    assert.notEqual(indexWithoutFirstAt, indexSource, 'source mutant действительно удаляет firstAt из worker callback');
    assert.ok(indexSource.includes("...(item.repeat && typeof item.firstAt === 'number' ? { firstAt: item.firstAt } : {}),"),
      'index.ts переносит время начала очереди повторов в sendPushToUsers');
    defer.setPushActivityProbe(() => false);
    for (const expected of Array.from({ length: 24 }, (_, i) => i + 1)) {
      const result = await runPushDeferTick(async (item) => {
        repeats.push(item.repeat ?? 0);
        await sendPushToUsers([item.uid], item.payload, item.source, { noDefer: true, private: item.private === true, repeat: item.repeat, firstAt: item.firstAt });
      }, Date.now() + 10 * 60_000);
      assert.deepEqual(result, { sent: 1, read: 0 });
      // The callback intentionally enqueues asynchronously, just as index.ts does in the real worker.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(due.size, expected < 24 ? 1 : 0, `после повтора ${expected} остаётся только следующий из разрешённых`);
    }
    assert.deepEqual(repeats, [1, ...Array.from({ length: 24 }, (_, i) => i + 1)]);
    assert.equal(JSON.parse(items.get('rep:a:dm') ?? 'null'), null, 'после потолка очередь повторов пуста');
    assert.equal(posted.length, 25, 'один исходный push и ровно 24 доставленных повтора');
    const endOfWindow = Date.now() - 24 * 60 * 60_000 - 30_000;
    await sendPushToUsers(['a'], payload, undefined, { private: true, repeat: 1, firstAt: endOfWindow });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 26, 'повтор ещё в grace окне сам может уйти');
    assert.equal(items.size, 0, 'но следующий срок через пять минут уже за окном и повтор не ставится');
    assert.equal(due.size, 0);

    const legacyNow = Date.now();
    items.set('legacy-repeat-without-firstAt', JSON.stringify({ uid: 'a', payload, private: true, repeat: 1 }));
    due.set('legacy-repeat-without-firstAt', legacyNow - 1);
    const legacyTick = await runPushDeferTick(async (item) => {
      await sendPushToUsers([item.uid], item.payload, item.source, {
        noDefer: true, private: item.private === true, repeat: item.repeat, firstAt: item.firstAt,
      });
    }, legacyNow);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(legacyTick.sent, 1, 'старая запись очереди без firstAt всё ещё доставляется один раз');
    assert.deepEqual([...due.keys()], ['rep:a:dm'], 'tick создал следующую запись повтора для старой цепочки');
    const legacyNext = JSON.parse(items.get('rep:a:dm')!);
    assert.equal(legacyNext.repeat, 2);
    assert.ok(typeof legacyNext.firstAt === 'number' && legacyNext.firstAt >= legacyNow && legacyNext.firstAt <= Date.now(),
      'первый callback legacy-очереди начинает окно повторов с текущего такта');
    assert.equal(posted.length, 27);

  } finally {
    defer.setPushActivityProbe(() => false);
    redisPub.multi = original.multi;
    redisPub.zrangebyscore = original.zrangebyscore;
    redisPub.eval = original.eval;
  }
});

test('repeat не ставится для silent, заглушки со звуком и группового вызова', async () => {
  // Уведомление без звука не должно снова зазвенеть позже, а групповая беседа не использует личную политику повторов.
  await t.raw.exec(`
    INSERT INTO push_devices (id,user_id,device_id,endpoint,platform) VALUES ('pa','a','a-phone','https://ntfy.example.test/a','android');
    UPDATE users SET notify_repeat = 5 WHERE id='a';
    INSERT INTO push_mutes (user_id,scope,target_id,sound_only) VALUES ('a','dm_user','b',true);
  `);
  const originalMulti = redisPub.multi;
  let scheduled = 0;
  redisPub.multi = (() => {
    const chain = {
      hset() { return chain; },
      zadd() { return chain; },
      exec: async () => { scheduled++; return []; },
    };
    return chain;
  }) as unknown as typeof redisPub.multi;
  try {
    await sendPushToUsers(['a'], { type: 'dm', title: 'Б', body: 'тихо', dmId: 'dm', key: 10, silent: true }, undefined, { private: true });
    await sendPushToUsers(['a'], { type: 'dm', title: 'Б', body: 'заглушка', dmId: 'dm', key: 11 }, { scope: 'dm_user', targetId: 'b' }, { private: true });
    await sendPushToUsers(['a'], { type: 'dm', title: 'Группа', body: 'группа', dmId: 'group', key: 12 });
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    redisPub.multi = originalMulti;
  }
  assert.equal(scheduled, 0);
  assert.equal(posted.length, 3, 'все три первичных уведомления всё равно доставляются');
});

test('старый и новый вызов получают call push только на устройство с read1', async () => {
  // Без read1 приложение не может снять incoming notification после ответа или отклонения звонка.
  await t.raw.exec(`
    INSERT INTO push_devices (id,user_id,device_id,endpoint,platform,caps) VALUES
      ('legacy','a','legacy','https://ntfy.example.test/legacy','android','reply1'),
      ('read','a','read','https://ntfy.example.test/read','android','reply1,read1');
  `);
  await sendPushToUsers(['a'], { type: 'call', title: 'Б', body: 'Входящий звонок', dmId: 'dm', callId: 'call' });
  assert.deepEqual(posted.map((p) => p.url), ['https://ntfy.example.test/read']);

  posted.length = 0;
  await sendPushToUsers(['a'], { type: 'dm', title: 'Б', body: 'сообщение', dmId: 'dm' });
  assert.equal(posted.length, 2, 'обычное личное сообщение по-прежнему уходит обоим поколениям');
});

test('отложенный пуш с удалённым или скрытым сообщением снимается, живое уходит ровно один раз', async () => {
  // Повтор push3 и defer push2 несут mid: удалённое у всех, скрытое у получателя и исчезнувшее сообщение не должны светиться.
  await t.raw.exec(`
    INSERT INTO conversation_messages (id,conversation_id,author_id,content,deleted_at,hidden_for) VALUES
      ('gone-deleted','dm','b','секрет удалён',now(),'{}'),
      ('gone-hidden','dm','b','секрет спрятан',NULL,'{a}'),
      ('still-here','dm','b','живое',NULL,'{}');
  `);
  const { runPushDeferTick } = await import('../src/pushDefer.js');
  const items = new Map([
    ['deleted-repeat', JSON.stringify({ uid: 'a', payload: { type: 'dm', title: 'Б', body: 'x', dmId: 'dm', key: 1, mid: 'gone-deleted' }, repeat: 1 })],
    ['deleted-defer', JSON.stringify({ uid: 'a', payload: { type: 'dm', title: 'Б', body: 'x', dmId: 'dm', key: 1, mid: 'gone-deleted' } })],
    ['hidden-repeat', JSON.stringify({ uid: 'a', payload: { type: 'dm', title: 'Б', body: 'x', dmId: 'dm', key: 2, mid: 'gone-hidden' }, repeat: 2 })],
    ['hidden-defer', JSON.stringify({ uid: 'a', payload: { type: 'dm', title: 'Б', body: 'x', dmId: 'dm', key: 2, mid: 'gone-hidden' } })],
    ['missing', JSON.stringify({ uid: 'a', payload: { type: 'dm', title: 'Б', body: 'x', dmId: 'dm', key: 3, mid: 'no-longer-exists' }, repeat: 1 })],
    ['live', JSON.stringify({ uid: 'a', payload: { type: 'dm', title: 'Б', body: 'x', dmId: 'dm', key: 4, mid: 'still-here' } })],
  ]);
  const tickAt = Date.now();
  const futureAt = tickAt + 60_000;
  const due = new Map<string, number>([...items.keys()].map((id) => [id, tickAt - 1]));
  items.set('rescheduled', JSON.stringify({ uid: 'a', payload: { type: 'dm', title: 'Б', body: 'старое', dmId: 'dm' } }));
  due.set('rescheduled', tickAt - 1);
  items.set('future', JSON.stringify({ uid: 'a', payload: { type: 'dm', title: 'Б', body: 'будущее', dmId: 'dm' } }));
  due.set('future', futureAt);
  let moveBeforeClaim = true;
  let forcedRangeIds: string[] | null = null;
  const original = {
    zrangebyscore: redisPub.zrangebyscore,
    eval: redisPub.eval,
    zrem: redisPub.zrem,
    hget: redisPub.hget,
    hdel: redisPub.hdel,
  };
  redisPub.zrangebyscore = (async (_key: string, _min: string | number, max: string | number) => {
    if (forcedRangeIds) return forcedRangeIds;
    const ids = [...due].filter(([, at]) => at <= Number(max)).map(([id]) => id);
    if (moveBeforeClaim && ids.includes('rescheduled')) {
      // Гонка: новый текст и будущий срок появляются после снимка due, но до атомарного claim.
      items.set('rescheduled', JSON.stringify({ uid: 'a', payload: { type: 'dm', title: 'Б', body: 'новое', dmId: 'dm' } }));
      due.set('rescheduled', futureAt);
      moveBeforeClaim = false;
    }
    return ids;
  }) as typeof redisPub.zrangebyscore;
  redisPub.eval = (async (script: string, _keys: number, _zkey: string, _hkey: string, id: string, now: string) => {
    const score = due.get(id);
    const checksFutureScore = script.includes('tonumber(s) > tonumber(ARGV[2])');
    if (score === undefined || (checksFutureScore && score > Number(now))) return null;
    due.delete(id);
    const raw = items.get(id) ?? null;
    items.delete(id);
    return raw;
  }) as unknown as typeof redisPub.eval;
  try {
    const sent: string[] = [];
    const result = await runPushDeferTick(async (item) => { sent.push(item.payload.mid ?? item.payload.body); }, tickAt);
    assert.deepEqual(result, { sent: 1, read: 5 });
    assert.deepEqual(sent, ['still-here']);
    assert.equal(due.get('rescheduled'), futureAt, 'новая постановка не теряет будущий срок');
    assert.match(items.get('rescheduled')!, /новое/, 'новое содержимое остаётся в очереди');
    assert.equal(due.get('future'), futureAt, 'запись с ещё не наступившим сроком остаётся нетронутой');
    assert.ok(items.has('future'));
    const second = await runPushDeferTick(async (item) => { sent.push(item.payload.mid ?? item.payload.body); }, tickAt);
    assert.deepEqual(second, { sent: 0, read: 0 });
    assert.deepEqual(sent, ['still-here']);
    const ticks = await Promise.all([
      runPushDeferTick(async (item) => { sent.push(item.payload.mid ?? item.payload.body); }, futureAt),
      runPushDeferTick(async (item) => { sent.push(item.payload.mid ?? item.payload.body); }, futureAt),
    ]);
    assert.equal(ticks.reduce((sum, tick) => sum + tick.sent, 0), 2, 'два одновременных такта вместе забирают обе записи ровно раз');
    assert.deepEqual(sent.sort(), ['still-here', 'будущее', 'новое']);
    assert.equal(items.size, 0); assert.equal(due.size, 0);

    const source = readFileSync(new URL('../src/pushDefer.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const withoutDeadline = source.replace(
      'if not s or tonumber(s) > tonumber(ARGV[2]) then return false end',
      'if not s then return false end',
    );
    assert.notEqual(withoutDeadline, source, 'в LUA сценарии есть часовой guard для мутанта');
    const noDeadline = await compilePushDefer(withoutDeadline);
    const mutantAt = Date.now();
    items.set('future-mutant', JSON.stringify({ uid: 'a', payload: { type: 'dm', title: 'Б', body: 'слишком рано', dmId: 'dm' } }));
    due.set('future-mutant', mutantAt + 60_000);
    forcedRangeIds = ['future-mutant'];
    const controlFuture = await runPushDeferTick(async () => assert.fail('штатный Lua-контракт не должен брать будущий элемент'), mutantAt);
    assert.deepEqual(controlFuture, { sent: 0, read: 0 });
    const premature: string[] = [];
    const mutantFuture = await noDeadline.runPushDeferTick(async (item) => { premature.push(item.payload.body); }, mutantAt);
    assert.equal(mutantFuture.sent, 1, 'мутант без проверки срока забирает будущий элемент');
    assert.equal(mutantFuture.read, 0);
    assert.deepEqual(premature, ['слишком рано']);
    forcedRangeIds = null;

    const threeCommands = source.replace(
      'const raw = await claimDue(id, now);',
      'await redis.zrem(ZKEY, id); const raw = await redis.hget(HKEY, id); await redis.hdel(HKEY, id);',
    );
    assert.notEqual(threeCommands, source, 'контрфакт старой последовательности из трёх Redis-команд найден');
    const oldSequence = await compilePushDefer(threeCommands);
    const staleId = 'same-repeat';
    const newItem = JSON.stringify({ uid: 'a', payload: { type: 'dm', title: 'Б', body: 'новое сообщение', dmId: 'dm' } });
    items.set(staleId, JSON.stringify({ uid: 'a', payload: { type: 'dm', title: 'Б', body: 'старое сообщение', dmId: 'dm' } }));
    due.set(staleId, mutantAt - 1);
    forcedRangeIds = [staleId];
    const sentEarly: string[] = [];
    redisPub.zrem = (async (_key: string, id: string) => {
      due.delete(id);
      items.set(id, newItem);
      due.set(id, futureAt);
      return 1;
    }) as typeof redisPub.zrem;
    redisPub.hget = (async (_key: string, id: string) => items.get(id) ?? null) as typeof redisPub.hget;
    redisPub.hdel = (async (_key: string, id: string) => Number(items.delete(id))) as typeof redisPub.hdel;
    const oldRace = await oldSequence.runPushDeferTick(async (item) => { sentEarly.push(item.payload.body); }, mutantAt);
    assert.equal(oldRace.sent, 1);
    assert.equal(oldRace.read, 0);
    assert.deepEqual(sentEarly, ['новое сообщение'], 'три команды читают и отправляют новую запись до её будущего срока');
    assert.equal(due.get(staleId), futureAt, 'мутант оставляет срок без payload');
    assert.equal(items.has(staleId), false, 'мутант удаляет свежее содержимое очереди');
  } finally {
    redisPub.zrangebyscore = original.zrangebyscore;
    redisPub.eval = original.eval;
    redisPub.zrem = original.zrem;
    redisPub.hget = original.hget;
    redisPub.hdel = original.hdel;
  }
});

test('чёрный список валидирует цель, не дублируется, отдаёт профиль и сразу сбрасывает кеш', async () => {
  // Ловит самоблокировку, висячий id и устаревший кеш после POST/DELETE.
  const self = await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'a' } });
  assert.equal(self.statusCode, 400);
  const missing = await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'missing' } });
  assert.equal(missing.statusCode, 404);
  for (let i = 0; i < 2; i++) {
    const response = await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'b' } });
    assert.equal(response.statusCode, 204);
  }
  const count = await t.raw.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM user_blocks`);
  assert.equal(count.rows[0]?.n, 1);
  const list = await app.inject({ method: 'GET', url: '/blocks', headers: authHeader('a') });
  assert.deepEqual(list.json(), [{ id: 'b', username: 'bravo', displayName: 'Bravo', avatarUrl: null }]);
  const removed = await app.inject({ method: 'DELETE', url: '/blocks/b', headers: authHeader('a') });
  assert.equal(removed.statusCode, 204);
  const empty = await app.inject({ method: 'GET', url: '/blocks', headers: authHeader('a') });
  assert.deepEqual(empty.json(), []);
});

test('заблокированный пишет как обычно, но сообщение навсегда скрыто от блокировщика', async () => {
  // Ловит выдачу факта блокировки, подъём беседы, unread/push и проявление старого сообщения после разблокировки.
  await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'b' } });
  const sent = await app.inject({
    method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'не увидишь' },
  });
  assert.equal(sent.statusCode, 201);
  const hiddenId = sent.json().id as string;
  const row = await t.raw.query<{ withheld: boolean }>(`SELECT withheld FROM conversation_messages WHERE id = '${hiddenId}'`);
  assert.equal(row.rows[0]?.withheld, true);
  const channel = await t.raw.query<{ last_message_at: Date }>(`SELECT last_message_at FROM conversations WHERE id = 'dm'`);
  assert.equal(channel.rows[0]?.last_message_at.toISOString(), '2026-09-20T10:00:00.000Z');
  assert.equal(published.some((p) => p.channel === 'gw:user:a'), false);
  assert.equal(posted.length, 0);
  const aList = await app.inject({ method: 'GET', url: '/dm', headers: authHeader('a') });
  assert.equal(aList.json()[0].unread, 0);
  const unread = await app.inject({ method: 'GET', url: '/unread', headers: authHeader('a') });
  assert.equal(unread.json().dms, 0);
  const seenA = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  const seenB = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('b') });
  assert.deepEqual(seenA.json(), []);
  assert.deepEqual(seenB.json().map((m: { id: string }) => m.id), [hiddenId]);

  await app.inject({ method: 'DELETE', url: '/blocks/b', headers: authHeader('a') });
  const visible = await app.inject({
    method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'увидишь' },
  });
  assert.equal(visible.statusCode, 201);
  const after = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  assert.deepEqual(after.json().map((m: { id: string }) => m.id), [visible.json().id]);
});

test('DM-курсор по id не теряет соседа в той же миллисекунде и игнорирует чужой id', async () => {
  // Ловит потерю 51-го сообщения на микросекундной границе и использование курсора чужой беседы.
  await t.raw.exec(`
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at)
    SELECT 'd' || lpad(i::text, 2, '0'), 'dm', 'b', i::text,
      CASE WHEN i = 1 THEN '2026-09-20 12:00:00.0001+00'::timestamptz
           WHEN i = 2 THEN '2026-09-20 12:00:00.0009+00'::timestamptz
           ELSE '2026-09-20 12:00:00+00'::timestamptz + i * interval '1 millisecond' END
    FROM generate_series(1, 51) AS i;
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at)
      VALUES ('foreign-cursor', 'foreign-dm', 'c', 'x', '2026-09-20T12:00:00.030Z')
  `);
  const latest = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  assert.equal(latest.json().length, 50);
  const oldest = latest.json()[0] as { id: string; createdAt: string };
  const older = await app.inject({
    method: 'GET', url: `/dm/dm/messages?before=${encodeURIComponent(oldest.createdAt)}&beforeId=${oldest.id}`,
    headers: authHeader('a'),
  });
  assert.deepEqual(older.json().map((m: { id: string }) => m.id), ['d01']);
  const fallback = await app.inject({
    method: 'GET', url: `/dm/dm/messages?before=${encodeURIComponent('2026-09-20T12:00:00.020Z')}&beforeId=foreign-cursor`,
    headers: authHeader('a'),
  });
  assert.ok(fallback.json().length > 0);
  assert.equal(fallback.json().every((m: { createdAt: string }) => m.createdAt < '2026-09-20T12:00:00.020Z'), true);
});

test('канальный курсор по id не теряет соседа и чужой id падает на before', async () => {
  // Ловит зеркальное расхождение пагинации каналов и ЛС после починки только одного маршрута.
  await t.raw.exec(`
    INSERT INTO messages (id, channel_id, author_id, content, created_at)
    SELECT 'c' || lpad(i::text, 2, '0'), 'ch', 'b', i::text,
      CASE WHEN i = 1 THEN '2026-09-20 12:00:00.0001+00'::timestamptz
           WHEN i = 2 THEN '2026-09-20 12:00:00.0009+00'::timestamptz
           ELSE '2026-09-20 12:00:00+00'::timestamptz + i * interval '1 millisecond' END
    FROM generate_series(1, 51) AS i;
    INSERT INTO messages (id, channel_id, author_id, content, created_at)
      VALUES ('foreign-channel-cursor', 'foreign-ch', 'c', 'x', '2026-09-20T12:00:00.030Z')
  `);
  const latest = await app.inject({ method: 'GET', url: '/channels/ch/messages', headers: authHeader('a') });
  const oldest = latest.json()[0] as { id: string; createdAt: string };
  const older = await app.inject({
    method: 'GET', url: `/channels/ch/messages?before=${encodeURIComponent(oldest.createdAt)}&beforeId=${oldest.id}`,
    headers: authHeader('a'),
  });
  assert.deepEqual(older.json().map((m: { id: string }) => m.id), ['c01']);
  const fallback = await app.inject({
    method: 'GET', url: `/channels/ch/messages?before=${encodeURIComponent('2026-09-20T12:00:00.020Z')}&beforeId=foreign-channel-cursor`,
    headers: authHeader('a'),
  });
  assert.ok(fallback.json().length > 0);
  assert.equal(fallback.json().every((m: { createdAt: string }) => m.createdAt < '2026-09-20T12:00:00.020Z'), true);
});

test('отметка ЛС идёт до показанного сообщения, не откатывается и публикует сохранённое время', async () => {
  // Ловит поглощение невидимого хвоста, откат со второго устройства и событие с несохранённым временем.
  await t.raw.exec(`
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at) VALUES
      ('r1', 'dm', 'b', 'one', '2026-09-20T10:00:00Z'),
      ('r2', 'dm', 'b', 'two', '2026-09-20T11:00:00Z'),
      ('r3', 'dm', 'b', 'three', '2026-09-20T12:00:00Z')
  `);
  const mark = await app.inject({ method: 'POST', url: '/dm/dm/read', headers: authHeader('a'), payload: { upTo: 'r2' } });
  assert.equal(mark.statusCode, 200);
  await new Promise<void>((resolve) => setImmediate(resolve));
  let saved = await t.raw.query<{ last_read_key: number }>(`SELECT last_read_key FROM conversation_members WHERE conversation_id = 'dm' AND user_id = 'a'`);
  assert.equal(Number(saved.rows[0]?.last_read_key), 2);
  const event = published.map((p) => JSON.parse(p.message).m).find((m) => m.t === 'read.dm');
  assert.equal(event.at, '2026-09-20T11:00:00.000Z');
  const list = await app.inject({ method: 'GET', url: '/dm', headers: authHeader('a') });
  assert.equal(list.json()[0].unread, 1);
  await app.inject({ method: 'POST', url: '/dm/dm/read', headers: authHeader('a'), payload: { upTo: 'r1' } });
  saved = await t.raw.query(`SELECT last_read_key FROM conversation_members WHERE conversation_id = 'dm' AND user_id = 'a'`);
  assert.equal(Number(saved.rows[0]?.last_read_key), 2);
});

test('чужой upTo и отсутствие тела читают до хвоста беседы, а будущее время не откатывается', async () => {
  // Ловит доверие id другой беседы и возврат к отметке по часам вместо ключа видимого хвоста.
  await t.raw.exec(`
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at)
      VALUES ('foreign-read', 'foreign-dm', 'c', 'x', '2020-01-01T00:00:00Z');
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at)
      VALUES ('local-read', 'dm', 'b', 'local', '2026-09-20T12:00:00Z');
    UPDATE conversations SET last_sort_key = (SELECT sort_key FROM conversation_messages WHERE id = 'local-read') WHERE id = 'dm';
    UPDATE conversations SET last_message_at = '2099-01-01T00:00:00Z' WHERE id = 'dm'
  `);
  await app.inject({ method: 'POST', url: '/dm/dm/read', headers: authHeader('a'), payload: { upTo: 'foreign-read' } });
  let saved = await t.raw.query<{ last_read_key: number }>(`SELECT last_read_key FROM conversation_members WHERE conversation_id = 'dm' AND user_id = 'a'`);
  assert.equal(Number(saved.rows[0]?.last_read_key), 2);
  await t.raw.exec(`UPDATE conversation_members SET last_read_key = 0 WHERE conversation_id = 'dm' AND user_id = 'a'`);
  await app.inject({ method: 'POST', url: '/dm/dm/read', headers: authHeader('a') });
  saved = await t.raw.query(`SELECT last_read_key FROM conversation_members WHERE conversation_id = 'dm' AND user_id = 'a'`);
  assert.equal(Number(saved.rows[0]?.last_read_key), 2);
  await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'new' } });
  const dm = await t.raw.query<{ last_message_at: Date }>(`SELECT last_message_at FROM conversations WHERE id = 'dm'`);
  assert.equal(dm.rows[0]?.last_message_at.toISOString(), '2099-01-01T00:00:00.000Z');
});

test('повтор add/remove реакции не создаёт строк и событий ни в ЛС, ни в канале', async () => {
  // Ловит удвоение счётчика на клиенте после повтора уже идемпотентного запроса.
  await t.raw.exec(`
    INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('react-dm', 'dm', 'b', 'x');
    INSERT INTO messages (id, channel_id, author_id, content) VALUES ('react-ch', 'ch', 'b', 'x')
  `);
  for (const [url, eventName, channels] of [
    ['/dm/dm/messages/react-dm/reactions', 'dm.reaction', ['gw:user:a', 'gw:user:b']],
    ['/channels/ch/messages/react-ch/reactions', 'message.reaction', ['gw:server:s']],
  ] as const) {
    published.length = 0;
    for (const op of ['add', 'add', 'remove', 'remove'] as const) {
      const response = await app.inject({ method: 'POST', url, headers: authHeader('a'), payload: { emoji: '👍', op } });
      assert.equal(response.statusCode, 204);
    }
    for (const channel of channels) {
      const events = published.filter((p) => p.channel === channel)
        .map((p) => JSON.parse(p.message).m).filter((m) => m.t === eventName);
      assert.deepEqual(events.map((e) => e.op), ['add', 'remove']);
    }
  }
  const dmRows = await t.raw.query(`SELECT * FROM conversation_message_reactions`);
  const channelRows = await t.raw.query(`SELECT * FROM message_reactions`);
  assert.equal(dmRows.rows.length, 0);
  assert.equal(channelRows.rows.length, 0);
});

test('реакция заблокированного хранится для него, но скрыта из истории блокировщика', async () => {
  // Ловит обход чёрного списка через эмодзи под старым сообщением после самой блокировки.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('blocked-react', 'dm', 'a', 'x')`);
  await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'b' } });
  const reaction = await app.inject({
    method: 'POST', url: '/dm/dm/messages/blocked-react/reactions', headers: authHeader('b'),
    payload: { emoji: '🔥', op: 'add' },
  });
  assert.equal(reaction.statusCode, 204);
  assert.equal(published.some((p) => p.channel === 'gw:user:a' && JSON.parse(p.message).m.t === 'dm.reaction'), false);
  const forA = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  const forB = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('b') });
  assert.deepEqual(forA.json()[0].reactions, []);
  assert.deepEqual(forB.json()[0].reactions, [{ emoji: '🔥', count: 1, me: true }]);
});

test('холодный кеш блокировок не зависает в истории, догонке и доставке события', async () => {
  // Ловит повторный запрос через глобальный пул из snapshot-транзакции на одно-соединенческом PGlite.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('cold-message', 'dm', 'b', 'hello')`);
  await t.raw.exec(`INSERT INTO conversation_message_reactions (message_id, user_id, emoji) VALUES ('cold-message', 'b', '🔥')`);
  await t.raw.exec(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('a', 'b')`);
  resetBlockCache();
  const history = await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader('a') });
  assert.equal(history.statusCode, 200);
  assert.deepEqual(history.json().messages[0].reactions, []);
  resetBlockCache();
  const sync = await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('a') });
  assert.equal(sync.statusCode, 200);
  resetBlockCache();
  published.length = 0;
  await deliver({ conversationId: 'dm', messageId: 'cold-message', pts: new Map([['a', 1]]) });
  const change = published.map((p) => JSON.parse(p.message).m).find((m) => m.t === 'conv.change');
  assert.ok(change);
  assert.deepEqual(change.message.reactions, []);
});

test('закрытый файл отдаётся участникам с range, HEAD и ETag, но ссылка отзывается при выходе', async () => {
  // Ловит выдачу файла после ухода из беседы, неверный 206/HEAD и лишнее чтение хранилища на 304.
  const attId = '12345678-1234-1234-1234-123456789abc';
  const bytes = Buffer.from('0123456789');
  let reads = 0;
  setAttachmentStoreForTests({
    ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async () => {}, stat: async () => ({ size: bytes.length }),
    get: async (_key, range) => { reads++; return Readable.from(range ? bytes.subarray(range.start, range.end + 1) : bytes); },
    remove: async () => {},
  });
  try {
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('att-message', 'dm', 'a', 'file')`);
    await t.raw.exec(`INSERT INTO attachments (id, conversation_id, owner_id, message_id, storage_key, name, content_type, size, state)
      VALUES ('${attId}', 'dm', 'a', 'att-message', 'dm/${attId}', 'voice.ogg', 'audio/ogg', 10, 'attached')`);
    let path = new URL(attachmentLink(attId, 'b', 0)).pathname.replace(/^\/api/, '');
    const ownerPath = new URL(attachmentLink(attId, 'a', 0)).pathname.replace(/^\/api/, '');
    assert.notEqual(path, ownerPath);
    assert.equal((await app.inject({ method: 'GET', url: ownerPath })).statusCode, 200);
    reads = 0;
    const head = await app.inject({ method: 'HEAD', url: path });
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers['content-length'], '10');
    assert.equal(reads, 0);
    const part = await app.inject({ method: 'GET', url: path, headers: { range: 'bytes=3-5' } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.body, '345');
    assert.equal(part.headers['content-range'], 'bytes 3-5/10');
    const unchanged = await app.inject({ method: 'GET', url: path, headers: { 'if-none-match': `"${attId}"` } });
    assert.equal(unchanged.statusCode, 304);
    assert.equal(reads, 1);
    const outside = await app.inject({ method: 'GET', url: path, headers: { range: 'bytes=10-' } });
    assert.equal(outside.statusCode, 416);
    assert.equal(outside.headers['content-range'], 'bytes */10');
    await t.raw.exec(`UPDATE users SET token_generation = 1 WHERE id = 'b'`);
    assert.equal((await app.inject({ method: 'GET', url: path })).statusCode, 404);
    path = new URL(attachmentLink(attId, 'b', 1)).pathname.replace(/^\/api/, '');
    assert.equal((await app.inject({ method: 'GET', url: path })).statusCode, 200);
    await t.raw.exec(`UPDATE conversation_members SET left_at = now() WHERE conversation_id = 'dm' AND user_id = 'b'`);
    assert.equal((await app.inject({ method: 'GET', url: path })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: path, headers: { 'sec-fetch-dest': 'document' } })).statusCode, 204);
  } finally { setAttachmentStoreForTests(null); }
});

test('загрузка становится вложением сообщения один раз, повтор clientId возвращает ту же строку', async () => {
  // Ловит повторное потребление pending-вложения при идемпотентной отправке и двойную привязку файла.
  const stored = new Map<string, Buffer>();
  setAttachmentStoreForTests({
    ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async (key, bytes) => { stored.set(key, bytes); },
    stat: async (key) => stored.has(key) ? { size: stored.get(key)!.length } : null,
    get: async (key) => Readable.from(stored.get(key) ?? Buffer.alloc(0)),
    remove: async (key) => { stored.delete(key); },
  });
  try {
    const boundary = 'gv-test-boundary';
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="picture.png"\r\nContent-Type: image/png\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await app.inject({ method: 'POST', url: '/conv/dm/attachments', headers: { ...authHeader('a'), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    assert.equal(upload.statusCode, 200, upload.body);
    const att = upload.json();
    assert.match(att.url, /\/api\/att\//);
    assert.equal(stored.size, 1);
    const body = { clientId: '00000000-0000-4000-8000-000000000111', content: '', attachments: [{ id: att.id }] };
    const first = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: body });
    assert.equal(first.statusCode, 201, first.body);
    const replay = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: body });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().id, first.json().id);
    const other = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'),
      payload: { ...body, clientId: '00000000-0000-4000-8000-000000000112' } });
    assert.equal(other.statusCode, 400);
    const rows = await t.raw.query<{ state: string; message_id: string }>(`SELECT state, message_id FROM attachments WHERE id = '${att.id}'`);
    assert.deepEqual(rows.rows.map((r) => [r.state, r.message_id]), [['attached', first.json().id]]);
  } finally { setAttachmentStoreForTests(null); }
});

test('видео-подсказки переживают отправку, сводку и цитату; прочие MIME получают только свои поля', async () => {
  // Иначе новое видео теряет размер/длительность в цитате либо изображение, голос и обычный файл получают чужие подсказки.
  const bytes = new Map<string, Buffer>();
  setAttachmentStoreForTests({ ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async (key, value) => { bytes.set(key, Buffer.from(value)); },
    stat: async (key) => bytes.has(key) ? { size: bytes.get(key)!.length } : null,
    get: async (key) => Readable.from(bytes.get(key) ?? []), remove: async (key) => { bytes.delete(key); } });
  try {
    const videoId = await createPending({ ownerId: 'a', conversationId: 'dm', name: 'clip.mp4', contentType: 'video/mp4', bytes: Buffer.from('video') });
    const hints = { id: videoId, width: 1920, height: 1080, durationMs: 42_000, waveform: [0, 30, 100] };
    const sent = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: {
      clientId: '10000000-0000-4000-8000-000000000801', content: '', attachments: [hints],
    } });
    assert.equal(sent.statusCode, 201, sent.body);
    const video = sent.json();
    assert.deepEqual([video.attachments[0].width, video.attachments[0].height, video.attachments[0].durationMs], [1920, 1080, 42_000]);
    assert.equal(Object.hasOwn(video.attachments[0], 'waveform'), false, 'waveform принадлежит голосовому, не видео');
    const persisted = (await t.raw.query<{ attachments: { width?: number; height?: number; durationMs?: number; waveform?: number[] }[] }>(
      'SELECT attachments FROM conversation_messages WHERE id=$1', [video.id],
    )).rows[0].attachments[0];
    assert.deepEqual([persisted.width, persisted.height, persisted.durationMs], [1920, 1080, 42_000]);
    assert.equal(Object.hasOwn(persisted, 'waveform'), false, 'огибающая не записывается в JSON вложения видео');

    const summary = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') })).json().conversations.find((c: { id: string }) => c.id === 'dm').lastMessage;
    assert.equal(summary.attachmentKind, 'file');
    assert.equal(summary.attachmentVideo, true);
    assert.equal(summary.attachmentDurationMs, 42_000);
    const reply = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('b'), payload: {
      clientId: '10000000-0000-4000-8000-000000000802', content: 'ответ на видео', replyToId: video.id, attachments: [],
    } });
    assert.equal(reply.statusCode, 201, reply.body);
    assert.equal(reply.json().replyTo.attachmentVideo, true);
    assert.equal(reply.json().replyTo.attachmentDurationMs, 42_000);
    assert.equal(reply.json().replyTo.attachments, 1);

    const { storedAttachment } = await import('../src/conversations.js');
    const { attachments: attachmentTable } = await import('../src/db/schema.js');
    const storedRow = (await t.db.select().from(attachmentTable).where(eq(attachmentTable.id, videoId)))[0];
    const videoStored = storedAttachment(storedRow, hints);
    assert.deepEqual([videoStored.width, videoStored.height, videoStored.durationMs], [1920, 1080, 42_000]);
    assert.equal(Object.hasOwn(videoStored, 'waveform'), false, 'экспортированный mapper тоже отсекает waveform у video/*');

    const imageId = await createPending({ ownerId: 'a', conversationId: 'dm', name: 'photo.png', contentType: 'image/png', bytes: Buffer.from('image') });
    const audioId = await createPending({ ownerId: 'a', conversationId: 'dm', name: 'voice.ogg', contentType: 'audio/ogg', bytes: Buffer.from('audio') });
    const fileId = await createPending({ ownerId: 'a', conversationId: 'dm', name: 'doc.pdf', contentType: 'application/pdf', bytes: Buffer.from('pdf') });
    const rows = await t.db.select().from(attachmentTable).where(sql`${attachmentTable.id} IN (${imageId},${audioId},${fileId})`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const noisyHints = { width: 800, height: 600, durationMs: 5_000, waveform: [10, 20] };
    const imageStored = storedAttachment(byId.get(imageId)!, { id: imageId, ...noisyHints });
    assert.deepEqual([imageStored.width, imageStored.height], [800, 600]);
    assert.equal(Object.hasOwn(imageStored, 'durationMs'), false, 'изображение не получает длительность');
    assert.equal(Object.hasOwn(imageStored, 'waveform'), false, 'изображение не получает огибающую');
    const audioStored = storedAttachment(byId.get(audioId)!, { id: audioId, ...noisyHints });
    assert.deepEqual([audioStored.durationMs, audioStored.waveform], [5_000, [10, 20]]);
    assert.equal(Object.hasOwn(audioStored, 'width'), false, 'звук не получает размеры кадра');
    const fileStored = storedAttachment(byId.get(fileId)!, { id: fileId, ...noisyHints });
    for (const key of ['width', 'height', 'durationMs', 'waveform'] as const) {
      assert.equal(Object.hasOwn(fileStored, key), false, `application/pdf не получает подсказку ${key}`);
    }

    const legacyId = await createPending({ ownerId: 'a', conversationId: 'dm', name: 'legacy.mp4', contentType: 'video/mp4', bytes: Buffer.from('legacy') });
    const legacy = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: {
      clientId: '10000000-0000-4000-8000-000000000803', content: '', attachments: [{ id: legacyId }],
    } });
    assert.equal(legacy.statusCode, 201, legacy.body);
    for (const key of ['width', 'height', 'durationMs', 'waveform'] as const) {
      assert.equal(Object.hasOwn(legacy.json().attachments[0], key), false, `старое видео без hints сохраняется без ${key}`);
    }
    const legacySummary = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') })).json().conversations.find((c: { id: string }) => c.id === 'dm').lastMessage;
    assert.equal(legacySummary.attachmentVideo, true);
    assert.equal(Object.hasOwn(legacySummary, 'attachmentDurationMs'), false, 'старое превью видео не выдумывает длительность');
  } finally { setAttachmentStoreForTests(null); }
});

test('старая отправка принимает свою живую ссылку, но отвергает чужую, устаревшую и публичную', async () => {
  // Ловит отвал вложений старого десктопа и обход закрытого бакета через подставленную ссылку.
  const id = '11111111-2222-4333-8444-555555555555';
  await t.raw.exec(`INSERT INTO attachments (id, conversation_id, owner_id, storage_key, name, content_type, size, state)
    VALUES ('${id}', 'dm', 'a', 'dm/${id}', 'x.txt', 'text/plain', 1, 'pending')`);
  const own = attachmentLink(id, 'a', 0);
  const metadata = { name: 'x.txt', contentType: 'text/plain', size: 1 };
  const send = (url: string) => app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('a'), payload: { attachments: [{ ...metadata, url }] } });
  for (const url of [attachmentLink(id, 'b', 0), attachmentLink(id, 'a', 1), 'https://public.example.test/x.txt']) {
    assert.equal((await send(url)).statusCode, 400);
  }
  const sent = await send(own);
  assert.equal(sent.statusCode, 201, sent.body);
  assert.equal(sent.json().attachments[0].url, own);
  const oldA = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  const oldB = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('b') });
  const convA = await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader('a') });
  const convB = await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader('b') });
  assert.equal(oldA.json()[0].attachments[0].url, own);
  assert.equal(convA.json().messages[0].attachments[0].url, own);
  const peerUrl = attachmentLink(id, 'b', 0);
  assert.equal(oldB.json()[0].attachments[0].url, peerUrl);
  assert.equal(convB.json().messages[0].attachments[0].url, peerUrl);
  assert.notEqual(own, peerUrl);
  assert.equal((await send(own)).statusCode, 400);
});

test('готовое хранилище не требуется для чтения, но неготовое запрещает новую загрузку', async () => {
  // Ловит ложное отключение старых вложений во время сбоя загрузочного контура.
  const id = '11111111-2222-4333-8444-666666666666';
  setAttachmentStoreForTests({
    ready: () => false, ensureReady: async () => false, configured: () => true,
    put: async () => {}, stat: async () => ({ size: 1 }), get: async () => Readable.from(Buffer.from('x')), remove: async () => {},
  });
  try {
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('ready-att', 'dm', 'a', 'x');
      INSERT INTO attachments (id, conversation_id, owner_id, message_id, storage_key, name, content_type, size, state)
      VALUES ('${id}', 'dm', 'a', 'ready-att', 'dm/${id}', 'x.txt', 'text/plain', 1, 'attached')`);
    const path = new URL(attachmentLink(id, 'b', 0)).pathname.replace(/^\/api/, '');
    assert.equal((await app.inject({ method: 'GET', url: path })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/conv/dm/attachments', headers: authHeader('a') })).statusCode, 503);
  } finally { setAttachmentStoreForTests(null); }
});

test('лимит выдачи вложения возвращает 204 переходу-странице и 429 запросу картинки', async () => {
  // Ловит выкидывание старого десктопа из приложения при исчерпанном лимите файла.
  const incr = redisPub.incr;
  redisPub.incr = (async (key: string) => key.startsWith('rl:att-ip:') ? 1201 : 1) as typeof redisPub.incr;
  try {
    const url = '/att/11111111-2222-4333-8444-777777777777/b/invalid';
    const page = await app.inject({ method: 'GET', url, headers: { 'sec-fetch-dest': 'document' } });
    assert.equal(page.statusCode, 204);
    assert.equal(page.headers['cache-control'], 'no-store');
    const image = await app.inject({ method: 'GET', url });
    assert.equal(image.statusCode, 429);
    assert.ok(image.headers['retry-after']);
  } finally { redisPub.incr = incr; }
});

test('незавершённая загрузка доступна только загрузившему, даже если оба участники беседы', async () => {
  // Ловит доступ собеседника к файлу до того, как владелец действительно отправил сообщение.
  const attId = '12345678-1234-1234-1234-123456789abc';
  setAttachmentStoreForTests({
    ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async () => {}, stat: async () => ({ size: 1 }), get: async () => Readable.from(Buffer.from('x')), remove: async () => {},
  });
  try {
    await t.raw.exec(`INSERT INTO attachments (id, conversation_id, owner_id, storage_key, name, content_type, size, state)
      VALUES ('${attId}', 'dm', 'a', 'dm/${attId}', 'x.txt', 'application/octet-stream', 1, 'pending')`);
    const owner = new URL(attachmentLink(attId, 'a', 0)).pathname.replace(/^\/api/, '');
    const peer = new URL(attachmentLink(attId, 'b', 0)).pathname.replace(/^\/api/, '');
    assert.equal((await app.inject({ method: 'GET', url: owner })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: peer })).statusCode, 404);
  } finally { setAttachmentStoreForTests(null); }
});

test('новая загрузка вытесняет старейшую из 40 pending, а упавший put не оставляет строку', async () => {
  // Ловит безграничное накопление сирот и строку без файла после ошибки хранилища.
  const stored = new Map<string, Buffer>();
  let fail = false;
  setAttachmentStoreForTests({
    ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async (key, bytes) => { if (fail) throw new Error('storage unavailable'); stored.set(key, bytes); },
    stat: async () => null, get: async () => Readable.from([]), remove: async () => {},
  });
  try {
    await t.raw.exec(`INSERT INTO attachments (id, conversation_id, owner_id, storage_key, name, content_type, size, state, created_at)
      SELECT 'pending-' || n, 'dm', 'a', 'dm/pending-' || n, 'x', 'application/octet-stream', 1, 'pending', now() - (41 - n) * interval '1 minute'
      FROM generate_series(1, 40) AS n`);
    const created = await createPending({ ownerId: 'a', conversationId: 'dm', name: 'new', contentType: 'application/octet-stream', bytes: Buffer.from('x') });
    const rows = await t.raw.query<{ id: string; state: string }>(`SELECT id, state FROM attachments WHERE owner_id = 'a'`);
    assert.equal(rows.rows.find((r) => r.id === 'pending-1')?.state, 'deleted');
    assert.equal(rows.rows.find((r) => r.id === created)?.state, 'pending');
    assert.equal(rows.rows.filter((r) => r.state === 'pending').length, 40);
    fail = true;
    await assert.rejects(createPending({ ownerId: 'b', conversationId: 'dm', name: 'failed', contentType: 'application/octet-stream', bytes: Buffer.from('x') }), /storage unavailable/);
    const orphan = await t.raw.query(`SELECT id FROM attachments WHERE owner_id = 'b'`);
    assert.equal(orphan.rows.length, 0);
  } finally { setAttachmentStoreForTests(null); }
});

test('перед вытеснением повторно проверяется pending: успевший прикрепиться файл остаётся живым', async () => {
  // Ловит удаление уже отправленного файла, если строка стала attached после выбора кандидата на вытеснение.
  const stored = new Map<string, Buffer>([['dm/pending-1', Buffer.from('attached file')]]);
  setAttachmentStoreForTests({ ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async (key, bytes) => { stored.set(key, Buffer.from(bytes)); }, stat: async () => null,
    get: async (key) => Readable.from(stored.get(key) ?? []), remove: async (key) => { stored.delete(key); } });
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('evict-race-msg','dm','a','sent');
    INSERT INTO attachments (id, conversation_id, owner_id, storage_key, name, content_type, size, state, created_at)
      SELECT 'pending-' || n, 'dm', 'a', 'dm/pending-' || n, 'x', 'application/octet-stream', 1, 'pending', now() - (41 - n) * interval '1 minute'
      FROM generate_series(1, 40) n`);
  setDmWriteBarrierForTests({ beforePendingEvict: async ({ tx, evict }) => {
    assert.deepEqual(evict, ['pending-1']);
    await tx.execute(sql`UPDATE attachments SET state='attached', message_id='evict-race-msg' WHERE id='pending-1' AND state='pending'`);
  } });
  try {
    await createPending({ ownerId: 'a', conversationId: 'dm', name: 'new', contentType: 'application/octet-stream', bytes: Buffer.from('new') });
    const row = await t.raw.query<{ state: string; message_id: string }>("SELECT state, message_id FROM attachments WHERE id='pending-1'");
    assert.deepEqual(row.rows, [{ state: 'attached', message_id: 'evict-race-msg' }]);
    assert.equal(stored.has('dm/pending-1'), true);

    // Удаление условия state=pending должно воспроизвести поломку и сделать проверку красной.
    const mutant = await mutantAttachments((source) => source.replace(
      ".where(and(inArray(attachments.id, evict), eq(attachments.state, 'pending')));",
      '.where(inArray(attachments.id, evict));',
    ));
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('evict-mutant-msg','dm','b','sent');
      INSERT INTO attachments (id, conversation_id, owner_id, storage_key, name, content_type, size, state, created_at)
        SELECT 'mut-pending-' || n, 'dm', 'b', 'dm/mut-pending-' || n, 'x', 'application/octet-stream', 1, 'pending', now() - (41 - n) * interval '1 minute'
        FROM generate_series(1, 40) n`);
    stored.set('dm/mut-pending-1', Buffer.from('must survive'));
    setDmWriteBarrierForTests({ beforePendingEvict: async ({ tx, evict }) => {
      assert.deepEqual(evict, ['mut-pending-1']);
      await tx.execute(sql`UPDATE attachments SET state='attached', message_id='evict-mutant-msg' WHERE id='mut-pending-1' AND state='pending'`);
    } });
    mutant.setAttachmentStoreForTests({ ready: () => true, ensureReady: async () => true, configured: () => true,
      put: async (key, bytes) => { stored.set(key, Buffer.from(bytes)); }, stat: async () => null,
      get: async (key) => Readable.from(stored.get(key) ?? []), remove: async (key) => { stored.delete(key); } });
    await mutant.createPending({ ownerId: 'b', conversationId: 'dm', name: 'new', contentType: 'application/octet-stream', bytes: Buffer.from('new') });
    const mutantRow = await t.raw.query<{ state: string }>("SELECT state FROM attachments WHERE id='mut-pending-1'");
    assert.throws(() => assert.equal(mutantRow.rows[0]?.state, 'attached'), assert.AssertionError);
  } finally { setDmWriteBarrierForTests({}); setAttachmentStoreForTests(null); }
});

test('шов позднего конфликта clientId откатывает пересылку и убирает временную копию', async () => {
  // Ловит 500/утечку файлов на ветке ForwardRace; PGlite откатывает инъекцию внутри той же транзакции.
  const sourceId = '12345678-1234-4234-8234-000000009921';
  const stored = new Map<string, Buffer>([[`dm/${sourceId}`, Buffer.from('source')]]);
  setAttachmentStoreForTests({ ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async (key, bytes) => { stored.set(key, Buffer.from(bytes)); }, stat: async (key) => stored.has(key) ? { size: stored.get(key)!.length } : null,
    get: async (key) => Readable.from(stored.get(key) ?? []), remove: async (key) => { stored.delete(key); },
    copy: async (from, to) => { stored.set(to, Buffer.from(stored.get(from) ?? [])); } });
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, attachments) VALUES
    ('race-forward-source','foreign-dm','c','file','[{"id":"${sourceId}","name":"f","contentType":"application/octet-stream","size":6}]');
    INSERT INTO attachments (id, conversation_id, owner_id, message_id, storage_key, name, content_type, size, state)
      VALUES ('${sourceId}','foreign-dm','c','race-forward-source','dm/${sourceId}','f','application/octet-stream',6,'attached')`);
  const body = { clientId: '00000000-0000-4000-8000-000000009922', fromConversationId: 'foreign-dm', messageIds: ['race-forward-source'] };
  const { forwardClientId } = await import('../src/convRules.js');
  setDmWriteBarrierForTests({ beforeForwardInsert: async ({ tx }) => {
    await tx.execute(sql`INSERT INTO conversation_messages (id, conversation_id, author_id, content, client_id, payload_hash)
      VALUES ('race-forward-winner','foreign-dm','a','winner',${forwardClientId(body.clientId, 0)},'another-payload')`);
  } });
  try {
    const response = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: body });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal((await t.raw.query("SELECT id FROM conversation_messages WHERE client_id=$1", [forwardClientId(body.clientId, 0)])).rows.length, 0,
      'PGlite откатил и конфликтующую тестовую запись, независимую фиксацию этот тест не моделирует');
    assert.equal((await t.raw.query("SELECT id FROM attachments WHERE conversation_id='dm' AND state='pending'")).rows.length, 0);
    assert.deepEqual([...stored.keys()], [`dm/${sourceId}`], 'временная файловая копия удалена, оригинал сохранён');
    assert.equal((await t.raw.query("SELECT 1 FROM user_changes WHERE conversation_id='dm'")).rows.length, 0);
  } finally { setDmWriteBarrierForTests({}); setAttachmentStoreForTests(null); }
});

test('уборка стирает старый pending, оставляет свежий и повторяет failed remove', async () => {
  // Ловит потерю следа не удалённого из бакета файла и преждевременную уборку свежей загрузки.
  const removed: string[] = [];
  setAttachmentStoreForTests({
    ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async () => {}, stat: async () => null, get: async () => Readable.from([]),
    remove: async (key) => { if (key === 'dm/dead') throw new Error('temporary'); removed.push(key); },
  });
  try {
    await t.raw.exec(`INSERT INTO attachments (id, conversation_id, owner_id, storage_key, name, content_type, size, state, created_at)
      VALUES ('old', 'dm', 'a', 'dm/old', 'x', 'application/octet-stream', 1, 'pending', now() - interval '25 hours'),
             ('fresh', 'dm', 'a', 'dm/fresh', 'x', 'application/octet-stream', 1, 'pending', now()),
             ('dead', 'dm', 'a', 'dm/dead', 'x', 'application/octet-stream', 1, 'deleted', now())`);
    const oldError = console.error;
    console.error = () => {};
    let n: number;
    try { n = await purgeAttachments(); } finally { console.error = oldError; }
    assert.equal(n, 1);
    assert.deepEqual(removed, ['dm/old']);
    const rows = await t.raw.query<{ id: string; state: string }>(`SELECT id, state FROM attachments ORDER BY id`);
    assert.deepEqual(rows.rows.map((r) => [r.id, r.state]), [['dead', 'deleted'], ['fresh', 'pending']]);
  } finally { setAttachmentStoreForTests(null); }
});

test('две отправки одного pending-файла не привязывают его к двум сообщениям', async () => {
  // Ловит двойное расходование одной загрузки при параллельных запросах.
  const attId = '12345678-1234-1234-1234-123456789abc';
  await t.raw.exec(`INSERT INTO attachments (id, conversation_id, owner_id, storage_key, name, content_type, size, state)
    VALUES ('${attId}', 'dm', 'a', 'dm/${attId}', 'x', 'application/octet-stream', 1, 'pending')`);
  const send = (clientId: string) => app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'),
    payload: { clientId, content: '', attachments: [{ id: attId }] } });
  const results = await Promise.all([
    send('00000000-0000-4000-8000-000000000121'),
    send('00000000-0000-4000-8000-000000000122'),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 400]);
  const rows = await t.raw.query<{ message_id: string }>(`SELECT message_id FROM attachments WHERE id = '${attId}'`);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].message_id, results.find((r) => r.statusCode === 201)?.json().id);
});

test('надгробие отвечает до медленного удаления файла, затем убирает и файл, и строку', async () => {
  // Ловит зависание интерфейса на медленном S3 после уже зафиксированного удаления сообщения.
  const attId = '12345678-1234-1234-1234-123456789abc';
  let release!: () => void;
  const removing = new Promise<void>((resolve) => { release = resolve; });
  let called = false;
  setAttachmentStoreForTests({
    ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async () => {}, stat: async () => null, get: async () => Readable.from([]),
    remove: async () => { called = true; await removing; },
  });
  try {
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('with-att', 'dm', 'a', '')`);
    await t.raw.exec(`INSERT INTO attachments (id, conversation_id, owner_id, message_id, storage_key, name, content_type, size, state)
      VALUES ('${attId}', 'dm', 'a', 'with-att', 'dm/${attId}', 'x', 'application/octet-stream', 1, 'attached')`);
    const response = await app.inject({ method: 'DELETE', url: '/conv/dm/messages/with-att?for=both', headers: authHeader('a') });
    assert.equal(response.statusCode, 204);
    assert.equal(called, true);
    const before = await t.raw.query<{ state: string }>(`SELECT state FROM attachments WHERE id = '${attId}'`);
    assert.equal(before.rows[0]?.state, 'deleted');
    release();
    for (let i = 0; i < 50; i++) {
      const after = await t.raw.query(`SELECT id FROM attachments WHERE id = '${attId}'`);
      if (after.rows.length === 0) return;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    assert.fail('строка должна уйти после успешного remove');
  } finally { release(); setAttachmentStoreForTests(null); }
});

test('без блокировки правка, реакция и удаление доходят до второго участника', async () => {
  // Ловит двойное отрицание у reachesPeer: база менялась, а живой собеседник не узнавал об этом.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('relay', 'dm', 'b', 'old')`);
  const cases = [
    { method: 'PATCH' as const, url: '/dm/dm/messages/relay', payload: { content: 'new' }, event: 'dm.update' },
    { method: 'POST' as const, url: '/dm/dm/messages/relay/reactions', payload: { emoji: '👍', op: 'add' }, event: 'dm.reaction' },
    { method: 'DELETE' as const, url: '/dm/dm/messages/relay', payload: undefined, event: 'dm.delete' },
  ];
  for (const c of cases) {
    published.length = 0;
    const response = await app.inject({ method: c.method, url: c.url, headers: authHeader('b'), ...(c.payload ? { payload: c.payload } : {}) });
    assert.ok(response.statusCode < 300, `${c.event}: ${response.statusCode}`);
    assert.equal(published.filter((p) => p.channel === 'gw:user:a' && JSON.parse(p.message).m.t === c.event).length, 1, c.event);
  }
});

test('удаление по умолчанию оставляет надгробие у обоих, но чужое запрещает', async () => {
  // Ловит потерю следа удаления для догонки и право стереть чужую строку у всех.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('own-b', 'dm', 'b', 'x')`);
  const foreign = await app.inject({ method: 'DELETE', url: '/dm/dm/messages/own-b', headers: authHeader('a') });
  assert.equal(foreign.statusCode, 403);
  const own = await app.inject({ method: 'DELETE', url: '/dm/dm/messages/own-b', headers: authHeader('b') });
  assert.equal(own.statusCode, 204);
  const rows = await t.raw.query<{ content: string; deleted_at: Date | null }>(`SELECT content, deleted_at FROM conversation_messages WHERE id = 'own-b'`);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0]?.content, '');
  assert.ok(rows.rows[0]?.deleted_at);
});

test('удаление только у себя прячет своё и чужое без дубля и без чужого события', async () => {
  // Ловит удаление у второго участника и повторное включение спрятанного сообщения в unread.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at) VALUES
    ('hide-b', 'dm', 'b', 'one', now() - interval '2 minutes'),
    ('hide-a', 'dm', 'a', 'two', now() - interval '1 minute'),
    ('stay-b', 'dm', 'b', 'three', now())`);
  for (const id of ['hide-b', 'hide-a', 'hide-b']) {
    const response = await app.inject({ method: 'DELETE', url: `/dm/dm/messages/${id}?for=me`, headers: authHeader('a') });
    assert.equal(response.statusCode, 204);
  }
  assert.equal(published.some((p) => p.channel === 'gw:user:b' && JSON.parse(p.message).m.t === 'dm.delete'), false);
  const hidden = await t.raw.query<{ id: string; hidden_for: string[] }>(`SELECT id, hidden_for FROM conversation_messages WHERE id IN ('hide-b','hide-a') ORDER BY id`);
  assert.deepEqual(hidden.rows.map((r) => r.hidden_for), [['a'], ['a']]);
  const forA = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  const forB = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('b') });
  assert.deepEqual(forA.json().map((m: { id: string }) => m.id), ['stay-b']);
  assert.deepEqual(forB.json().map((m: { id: string }) => m.id), ['hide-b', 'hide-a', 'stay-b']);
  const list = await app.inject({ method: 'GET', url: '/dm', headers: authHeader('a') });
  const summary = await app.inject({ method: 'GET', url: '/unread', headers: authHeader('a') });
  assert.equal(list.json()[0].unread, 1);
  assert.equal(summary.json().dms, 1);
  const lastDelete = published.filter((p) => p.channel === 'gw:user:a')
    .map((p) => JSON.parse(p.message).m).filter((m) => m.t === 'dm.delete').at(-1);
  assert.equal(lastDelete.unread, 1);
});

test('чужое придержанное нельзя удалить даже только у себя', async () => {
  // Ловит раскрытие существования сообщения, которое блокировщик никогда не видел.
  await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'b' } });
  const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'secret' } });
  const deleted = await app.inject({ method: 'DELETE', url: `/dm/dm/messages/${sent.json().id}?for=me`, headers: authHeader('a') });
  assert.equal(deleted.statusCode, 404);
});

test('удаление последнего у обоих уменьшает время беседы и пересчитывает непрочитанное', async () => {
  // Ловит зависшую наверху пустую беседу и цифру 1 после удаления непрочитанного.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at) VALUES
    ('last-old', 'dm', 'b', 'one', now() - interval '2 minutes'),
    ('last-new', 'dm', 'b', 'two', now() - interval '1 minute')`);
  published.length = 0;
  const first = await app.inject({ method: 'DELETE', url: '/dm/dm/messages/last-new?for=both', headers: authHeader('b') });
  assert.equal(first.statusCode, 204);
  const left = await t.raw.query<{ created_at: Date }>(`SELECT created_at FROM conversation_messages WHERE id = 'last-old'`);
  const at = left.rows[0]!.created_at.toISOString();
  const row = await t.raw.query<{ last_message_at: Date }>(`SELECT last_message_at FROM conversations WHERE id = 'dm'`);
  assert.equal(row.rows[0]?.last_message_at.toISOString(), at);
  const event = published.filter((p) => p.channel === 'gw:user:a').map((p) => JSON.parse(p.message).m).find((m) => m.t === 'dm.delete');
  assert.equal(event.lastMessageAt, at);
  assert.equal(event.unread, 1);
  const ownEvent = published.filter((p) => p.channel === 'gw:user:b').map((p) => JSON.parse(p.message).m).find((m) => m.t === 'dm.delete');
  assert.equal(ownEvent.lastMessageAt, at);
  const second = await app.inject({ method: 'DELETE', url: '/dm/dm/messages/last-old', headers: authHeader('b') });
  assert.equal(second.statusCode, 204);
  const empty = await t.raw.query<{ last_message_at: Date | null }>(`SELECT last_message_at FROM conversations WHERE id = 'dm'`);
  assert.equal(empty.rows[0]?.last_message_at, null);
  const unread = await app.inject({ method: 'GET', url: '/dm', headers: authHeader('a') });
  assert.equal(unread.json()[0].unread, 0);
});

async function seedLastMessage(): Promise<void> {
  await t.raw.exec(`
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at)
      VALUES ('race-old', 'dm', 'b', 'old', now() - interval '1 minute');
    UPDATE conversations SET last_message_at = (SELECT created_at FROM conversation_messages WHERE id = 'race-old') WHERE id = 'dm';
  `);
}

async function assertFreshLast(sent: Awaited<ReturnType<typeof app.inject>>): Promise<void> {
  assert.equal(sent.statusCode, 201);
  const freshAt = sent.json().createdAt;
  const rows = await t.raw.query<{ last_message_at: Date }>(`SELECT last_message_at FROM conversations WHERE id = 'dm'`);
  assert.equal(rows.rows[0]!.last_message_at.toISOString(), freshAt);
  const messages = await t.raw.query<{ id: string }>(`SELECT id FROM conversation_messages WHERE conversation_id = 'dm' AND deleted_at IS NULL`);
  assert.deepEqual(messages.rows.map((row) => row.id), [sent.json().id]);
}

test('удаление под замком перед отправкой не стирает время свежего сообщения', async () => {
  // Ловит откат last_message_at в null, когда новый текст пришёл во время удаления последнего старого.
  await seedLastMessage();
  let reached!: () => void;
  let release!: () => void;
  const atLock = new Promise<void>((resolve) => { reached = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  setDmWriteBarrierForTests({ afterDeleteLock: async () => { reached(); await hold; } });
  try {
    const deleting = app.inject({ method: 'DELETE', url: '/dm/dm/messages/race-old?for=both', headers: authHeader('b') });
    await atLock;
    const sending = app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'fresh' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    assert.equal((await deleting).statusCode, 204);
    await assertFreshLast(await sending);
  } finally {
    release();
    setDmWriteBarrierForTests({});
  }
});

test('отправка перед удалением удерживает время нового сообщения', async () => {
  // Ловит пересчёт last_message_at по старому снимку при встречном порядке двух транзакций.
  await seedLastMessage();
  let reached!: () => void;
  let release!: () => void;
  const afterInsert = new Promise<void>((resolve) => { reached = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  setDmWriteBarrierForTests({ afterSendInsert: async () => { reached(); await hold; } });
  try {
    const sending = app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'fresh' } });
    await afterInsert;
    let deletionFinished = false;
    const deleting = app.inject({ method: 'DELETE', url: '/dm/dm/messages/race-old?for=both', headers: authHeader('b') });
    void deleting.then(() => { deletionFinished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deletionFinished, false, 'удаление обязано ждать замок отправки');
    release();
    const sent = await sending;
    assert.equal((await deleting).statusCode, 204);
    await assertFreshLast(sent);
  } finally {
    release();
    setDmWriteBarrierForTests({});
  }
});

test('старая отправка доставляет раздельные dm и conv события без новых полей в старом DTO', async () => {
  // Ловит двойной показ сообщения в смешанной паре старого и нового клиентов.
  const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'hello' } });
  assert.equal(sent.statusCode, 201);
  for (const field of ['conversationId', 'sortKey', 'clientId']) assert.equal(field in sent.json(), false, field);
  const envelopes = published.map((p) => ({ channel: p.channel, ...JSON.parse(p.message) }));
  const events = (channel: string, type: string) => envelopes.filter((e) => e.channel === channel && e.m.t === type);
  assert.equal(events('gw:user:a', 'dm.channel').length, 1);
  assert.equal(events('gw:user:a', 'dm.create').length, 1);
  assert.equal(events('gw:user:b', 'dm.create').length, 1);
  assert.equal(events('gw:user:a', 'conv.change').length, 1);
  assert.equal(events('gw:user:b', 'conv.change').length, 1);
  for (const e of envelopes) {
    if (e.m.t.startsWith('dm.')) assert.equal(e.notCap, 'conv1');
    if (e.m.t === 'conv.change') assert.equal(e.cap, 'conv1');
  }
});

test('отправка через старую и новую ручки сообщает старым и новым соединениям, replay молчит', async () => {
  // Ловит главный блокер 0.8.18: новое веб-сообщение не доходило до старого десктопа.
  const expectedOld = ['a:dm.create', 'b:dm.channel', 'b:dm.create'];
  const expectedFresh = ['a:conv.change', 'b:conv.change'];
  const old = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('a'), payload: { content: 'old' } });
  assert.equal(old.statusCode, 201);
  expectDmEvents(expectedOld, expectedFresh);
  const oldShapes = legacyEventShapes();
  published.length = 0;
  const body = { clientId: '00000000-0000-4000-8000-000000000181', content: 'new' };
  const fresh = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: body });
  assert.equal(fresh.statusCode, 201);
  expectDmEvents(expectedOld, expectedFresh);
  assert.deepEqual(legacyEventShapes(), oldShapes);
  published.length = 0;
  assert.equal((await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: body })).statusCode, 200);
  expectDmEvents([], []);
});

test('правка через обе ручки доходит обоим, а придержанная — только автору', async () => {
  // Ловит старый десктоп с неизменённым текстом после правки из веба и утечку придержанного текста.
  let visibleShapes: string[] | undefined;
  for (const mode of ['dm', 'conv'] as const) {
    const id = `edit-${mode}`;
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('${id}', 'dm', 'a', 'old')`);
    published.length = 0;
    const response = await app.inject({ method: 'PATCH', url: `/${mode}/dm/messages/${id}`, headers: authHeader('a'), payload: { content: 'new' } });
    assert.equal(response.statusCode, 200);
    expectDmEvents(['a:dm.update', 'b:dm.update'], ['a:conv.change', 'b:conv.change']);
    if (visibleShapes) assert.deepEqual(legacyEventShapes(), visibleShapes);
    else visibleShapes = legacyEventShapes();
  }
  assert.equal((await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('b'), payload: { userId: 'a' } })).statusCode, 204);
  let withheldShapes: string[] | undefined;
  for (const mode of ['dm', 'conv'] as const) {
    const id = `withheld-edit-${mode}`;
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, withheld) VALUES ('${id}', 'dm', 'a', 'old', true)`);
    published.length = 0;
    const response = await app.inject({ method: 'PATCH', url: `/${mode}/dm/messages/${id}`, headers: authHeader('a'), payload: { content: 'new' } });
    assert.equal(response.statusCode, 200);
    expectDmEvents(['a:dm.update'], ['a:conv.change']);
    if (withheldShapes) assert.deepEqual(legacyEventShapes(), withheldShapes);
    else withheldShapes = legacyEventShapes();
  }
});

test('реакции обеих ручек доходят обоим поколениям клиентов, повтор молчит, блокировка скрывает событие', async () => {
  // Ловит потерю реакции старым десктопом и повторную доставку идемпотентного add.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('parity-react', 'dm', 'b', 'x')`);
  let normalShapes: string[] | undefined;
  for (const mode of ['dm', 'conv'] as const) {
    const url = `/${mode}/dm/messages/parity-react/reactions`;
    published.length = 0;
    assert.equal((await app.inject({ method: 'POST', url, headers: authHeader('a'), payload: { emoji: '👍', op: 'add' } })).statusCode, 204);
    expectDmEvents(['a:dm.reaction', 'b:dm.reaction'], ['a:conv.change', 'b:conv.change']);
    if (normalShapes) assert.deepEqual(legacyEventShapes(), normalShapes);
    else normalShapes = legacyEventShapes();
    published.length = 0;
    assert.equal((await app.inject({ method: 'POST', url, headers: authHeader('a'), payload: { emoji: '👍', op: 'add' } })).statusCode, 204);
    expectDmEvents([], []);
    assert.equal((await app.inject({ method: 'POST', url, headers: authHeader('a'), payload: { emoji: '👍', op: 'remove' } })).statusCode, 204);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('b'), payload: { userId: 'a' } })).statusCode, 204);
  let blockedShapes: string[] | undefined;
  for (const mode of ['dm', 'conv'] as const) {
    published.length = 0;
    assert.equal((await app.inject({ method: 'POST', url: `/${mode}/dm/messages/parity-react/reactions`, headers: authHeader('a'), payload: { emoji: '🔥', op: 'add' } })).statusCode, 204);
    expectDmEvents(['a:dm.reaction'], ['a:conv.change']);
    if (blockedShapes) assert.deepEqual(legacyEventShapes(), blockedShapes);
    else blockedShapes = legacyEventShapes();
    assert.equal((await app.inject({ method: 'POST', url: `/${mode}/dm/messages/parity-react/reactions`, headers: authHeader('a'), payload: { emoji: '🔥', op: 'remove' } })).statusCode, 204);
  }
});

test('удаление обеими ручками адресуется обоим или только скрывшему и не дублируется', async () => {
  // Ловит пропажу надгробия на старом клиенте и утечку личного скрытия собеседнику.
  let bothShapes: string[] | undefined;
  let meShapes: string[] | undefined;
  for (const mode of ['dm', 'conv'] as const) {
    const bothId = `parity-both-${mode}`;
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('${bothId}', 'dm', 'a', 'x')`);
    published.length = 0;
    const both = `/${mode}/dm/messages/${bothId}?for=both`;
    assert.equal((await app.inject({ method: 'DELETE', url: both, headers: authHeader('a') })).statusCode, 204);
    expectDmEvents(['a:dm.delete', 'b:dm.delete'], ['a:conv.change', 'b:conv.change']);
    if (bothShapes) assert.deepEqual(legacyEventShapes(), bothShapes);
    else bothShapes = legacyEventShapes();
    published.length = 0;
    assert.equal((await app.inject({ method: 'DELETE', url: both, headers: authHeader('a') })).statusCode, 204);
    expectDmEvents([], []);
    const meId = `parity-me-${mode}`;
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('${meId}', 'dm', 'b', 'x')`);
    published.length = 0;
    assert.equal((await app.inject({ method: 'DELETE', url: `/${mode}/dm/messages/${meId}?for=me`, headers: authHeader('a') })).statusCode, 204);
    expectDmEvents(['a:dm.delete'], ['a:conv.change']);
    if (meShapes) assert.deepEqual(legacyEventShapes(), meShapes);
    else meShapes = legacyEventShapes();
  }
});

test('сдвиг прочтения обеими ручками доходит старым и новым устройствам, повтор новой молчит', async () => {
  // Ловит счётчик непрочитанного, который не гаснет на старом телефоне после чтения в вебе.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES
    ('parity-read-1', 'dm', 'b', 'one'), ('parity-read-2', 'dm', 'b', 'two')`);
  const keys = await t.raw.query<{ id: string; sort_key: number }>(`SELECT id, sort_key FROM conversation_messages WHERE id LIKE 'parity-read-%' ORDER BY sort_key`);
  published.length = 0;
  assert.equal((await app.inject({ method: 'POST', url: '/dm/dm/read', headers: authHeader('a'), payload: { upTo: keys.rows[0]!.id } })).statusCode, 200);
  for (let i = 0; i < 20 && !published.some((p) => JSON.parse(p.message).m.t === 'read.dm'); i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expectDmEvents(['a:read.dm'], ['a:conv.change', 'b:conv.change']);
  const oldShapes = legacyEventShapes();
  published.length = 0;
  const body = { key: Number(keys.rows[1]!.sort_key) };
  assert.equal((await app.inject({ method: 'POST', url: '/conv/dm/read', headers: authHeader('a'), payload: body })).statusCode, 200);
  expectDmEvents(['a:read.dm'], ['a:conv.change', 'b:conv.change']);
  assert.deepEqual(legacyEventShapes(), oldShapes);
  published.length = 0;
  assert.equal((await app.inject({ method: 'POST', url: '/conv/dm/read', headers: authHeader('a'), payload: body })).statusCode, 200);
  expectDmEvents([], []);
});

test('прочтение собеседника меняет только сводку и одну строку журнала, не доставляет сообщение заново', async () => {
  // Ловит ложное новое сообщение и изменение собственного прочтения при чужом ✓✓.
  const send = async (n: number) => {
    const res = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: { content: `m${n}`, clientId: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}` } });
    assert.equal(res.statusCode, 201); return res.json();
  };
  const m0 = await send(600); const m1 = await send(601); await send(602);
  const initial = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') })).json();
  published.length = 0;
  assert.equal((await app.inject({ method: 'POST', url: '/conv/dm/read', headers: authHeader('b'), payload: { key: m1.sortKey } })).statusCode, 200);
  expectDmEvents(['b:read.dm'], ['a:conv.change', 'b:conv.change']);
  const event = published.filter((p) => p.channel === 'gw:user:a').map((p) => JSON.parse(p.message).m)[0];
  assert.equal(event.created, undefined); assert.equal(event.message, undefined); assert.equal(event.pts, initial.pts + 1);
  assert.equal(event.conversation.peerReadKey, m1.sortKey);
  const sync = (await app.inject({ method: 'GET', url: `/conv/sync?pts=${initial.pts}`, headers: authHeader('a') })).json();
  assert.deepEqual(sync.messages, []); assert.equal(sync.conversations.find((c: { id: string }) => c.id === 'dm').peerReadKey, m1.sortKey);
  const rows = await t.raw.query<{ kind: string; message_id: string | null }>(`SELECT kind, message_id FROM user_changes WHERE user_id='a' AND pts > ${initial.pts}`);
  assert.deepEqual(rows.rows, [{ kind: 'read', message_id: null }]);
  for (const key of [m1.sortKey, m0.sortKey]) {
    published.length = 0;
    assert.equal((await app.inject({ method: 'POST', url: '/conv/dm/read', headers: authHeader('b'), payload: { key } })).statusCode, 200);
    expectDmEvents([], []);
  }
  assert.ok((await app.inject({ method: 'GET', url: '/auth/me', headers: authHeader('a') })).json().features.includes('conv4'));
});

test('блокирующий не раскрывает своё прочтение, но получает обратное, сводка обрезана перед придержанным', async () => {
  // Ловит утечку того, что блокирующий прочитал хвост, через журнал и сводку.
  await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('b'), payload: { userId: 'a' } });
  const send = async (who: string, n: number) => {
    const res = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader(who), payload: { content: 'x', clientId: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}` } });
    assert.equal(res.statusCode, 201); return res.json();
  };
  const w1 = await send('a', 701); const b1 = await send('b', 702);
  const before = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') })).json();
  published.length = 0;
  await app.inject({ method: 'POST', url: '/conv/dm/read', headers: authHeader('b'), payload: { key: b1.sortKey } });
  expectDmEvents(['b:read.dm'], ['b:conv.change']);
  const list = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') })).json();
  assert.equal(list.pts, before.pts); assert.equal(list.conversations.find((c: { id: string }) => c.id === 'dm').peerReadKey, w1.sortKey - 1);
  const sync = (await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('a') })).json();
  assert.equal(sync.conversations.find((c: { id: string }) => c.id === 'dm').peerReadKey, w1.sortKey - 1);
  await send('a', 703);
  const beforeLegacy = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') })).json();
  published.length = 0;
  assert.equal((await app.inject({ method: 'POST', url: '/dm/dm/read', headers: authHeader('b'), payload: {} })).statusCode, 200);
  for (let i = 0; i < 20 && published.length < 2; i++) await new Promise<void>((r) => setTimeout(r, 10));
  expectDmEvents(['b:read.dm'], ['b:conv.change']);
  const afterLegacy = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') })).json();
  assert.equal(afterLegacy.pts, beforeLegacy.pts); assert.equal(afterLegacy.conversations.find((c: { id: string }) => c.id === 'dm').peerReadKey, w1.sortKey - 1);
  published.length = 0;
  await app.inject({ method: 'POST', url: '/conv/dm/read', headers: authHeader('a'), payload: { key: b1.sortKey } });
  expectDmEvents(['a:read.dm'], ['a:conv.change', 'b:conv.change']);
});

test('повторная блокировка не использует старое придержанное как потолок прочтения', async () => {
  // Ловит возврат уже показанных ✓✓ к ✓ из-за сообщения предыдущей блокировки.
  await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('b'), payload: { userId: 'a' } });
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, withheld, sort_key, created_at)
    VALUES ('old-withheld', 'dm', 'a', 'old', true, 10, now() - interval '2 days');
    UPDATE conversation_members SET last_read_key=20 WHERE conversation_id='dm' AND user_id='b'`);
  const key = async () => (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') })).json().conversations.find((c: { id: string }) => c.id === 'dm').peerReadKey;
  // Управляем временем фикстуры, не ждём часы и не меняем продовый источник времени.
  await t.raw.exec(`UPDATE user_blocks SET created_at=now() - interval '3 days' WHERE blocker_id='b' AND blocked_id='a'`);
  assert.equal(await key(), 9);
  await app.inject({ method: 'DELETE', url: '/blocks/a', headers: authHeader('b') });
  assert.equal(await key(), 20);
  await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('b'), payload: { userId: 'a' } });
  assert.equal(await key(), 20);
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, withheld, sort_key)
    VALUES ('new-withheld', 'dm', 'a', 'new', true, 30);
    UPDATE conversation_members SET last_read_key=40 WHERE conversation_id='dm' AND user_id='b'`);
  assert.equal(await key(), 29);
});

for (const name of ['аудитория без фильтра блокировок', 'потолок прочтения отсутствует', 'журнал только себе', 'потолок прошлой блокировки'] as const) {
  test(`PGlite ловит мутант Р6: ${name}`, async () => {
    // Тот же сценарий обязан отвергать реальный откат защиты, а не только сравнивать фикстуру.
    const blocked = name !== 'журнал только себе';
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, withheld, sort_key, created_at)
      VALUES ('withheld-10', 'dm', 'a', 'old', true, 10, now() - interval '2 days'), ('visible-20', 'dm', 'b', 'new', false, 20, now());
      UPDATE conversations SET last_sort_key=20 WHERE id='dm'`);
    if (blocked) await t.raw.exec(`INSERT INTO user_blocks (blocker_id, blocked_id, created_at)
      VALUES ('b','a', now() - interval '${name === 'потолок прошлой блокировки' ? 1 : 3} days')`);
    const original = await import('../src/conversations.js');
    const mutant = name === 'аудитория без фильтра блокировок'
      ? await mutantConversations((s) => s, (s) => s.replace(' && !readerBlocked.has(id)', ''))
      : name === 'потолок прочтения отсутствует'
        ? await mutantConversations((s) => s, (s) => s.replace('Math.max(0, Math.min(o.lastReadKey, o.firstWithheldKey - 1))', 'o.lastReadKey'))
        : name === 'журнал только себе'
          ? await mutantConversations((s) => s.replace("audience.map((userId) => ({ userId, conversationId, kind: 'read'", "[me].map((userId) => ({ userId, conversationId, kind: 'read'"))
          : await mutantConversations((s) => s.replace(' AND x.created_at >= b.created_at', ''));
    async function scenario(code: typeof original) {
      published.length = 0;
      const access = await code.loadAccess('dm', 'b'); assert.ok(access);
      const result = await code.markRead('b', access, 20); assert.equal(result.kind, 'ok');
      if (result.kind === 'ok' && result.delivery) await code.deliver(result.delivery);
      const list = await code.listConversations('a');
      const journal = await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_changes WHERE user_id='a' AND kind='read'`);
      return { key: list.conversations.find((c) => c.id === 'dm')!.peerReadKey, journal: journal.rows[0]!.n,
        events: routedDmEvents().fresh };
    }
    const expected = { key: !blocked || name === 'потолок прошлой блокировки' ? 20 : 9,
      journal: blocked ? 0 : 1, events: blocked ? ['b:conv.change'] : ['a:conv.change', 'b:conv.change'] };
    assert.deepEqual(await scenario(original), expected);
    await t.raw.exec(`TRUNCATE user_changes, user_sync CASCADE; UPDATE conversation_members SET last_read_key=0 WHERE conversation_id='dm'`);
    const wrong = await scenario(mutant);
    assert.throws(() => assert.deepEqual(wrong, expected), assert.AssertionError, 'мутант должен нарушить тот же контракт');
  });
}

test('все три формы чтения сообщают peerRead только новым соединениям собеседника', async () => {
  // Ловит read.dm собеседнику, которое старый клиент принял бы за своё прочтение.
  for (const [i, mode] of ['new', 'legacy-upTo', 'legacy-tail'].entries()) {
    const sent = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'),
      payload: { content: `mode${i}`, clientId: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}` } });
    assert.equal(sent.statusCode, 201);
    published.length = 0;
    const read = await app.inject({ method: 'POST', url: mode === 'new' ? '/conv/dm/read' : '/dm/dm/read', headers: authHeader('b'),
      payload: mode === 'new' ? { key: sent.json().sortKey } : mode === 'legacy-upTo' ? { upTo: sent.json().id } : {} });
    assert.equal(read.statusCode, 200);
    for (let n = 0; n < 20 && published.length < 3; n++) await new Promise<void>((r) => setTimeout(r, 10));
    expectDmEvents(['b:read.dm'], ['a:conv.change', 'b:conv.change']);
    const mine = published.filter((p) => p.channel === 'gw:user:a').map((p) => JSON.parse(p.message));
    assert.equal(mine.length, 1); assert.equal(mine[0].cap, 'conv1'); assert.equal(mine[0].notCap, undefined);
    assert.equal(mine[0].m.message, undefined); assert.equal(mine[0].m.created, undefined);
  }
});
test('новая беседа начинает peerRead с нуля у обоих, чтение B не меняет lastRead и unread A', async () => {
  // Ловит пустой ключ новой пары и смешение своего прочтения с собеседником.
  const created = await app.inject({ method: 'POST', url: '/conv/direct', headers: authHeader('b'), payload: { userId: 'c' } });
  assert.equal(created.statusCode, 201); assert.equal(created.json().peerReadKey, 0);
  const id = created.json().id;
  const other = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('c') })).json().conversations.find((s: { id: string }) => s.id === id);
  assert.equal(other, undefined, 'получатель не видит пустую беседу до первого сообщения');
  const send = await app.inject({ method: 'POST', url: `/conv/${id}/messages`, headers: authHeader('b'),
    payload: { content: 'для c', clientId: '30000000-0000-4000-8000-000000000001' } });
  assert.equal(send.statusCode, 201);
  const revealed = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('c') })).json().conversations.find((s: { id: string }) => s.id === id);
  assert.equal(revealed.peerReadKey, 0, 'после первого сообщения беседа видна с нулевым peerRead');
  const before = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') })).json().conversations.find((s: { id: string }) => s.id === id);
  assert.equal((await app.inject({ method: 'POST', url: `/conv/${id}/read`, headers: authHeader('c'), payload: { key: send.json().sortKey } })).statusCode, 200);
  const after = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') })).json().conversations.find((s: { id: string }) => s.id === id);
  assert.equal(after.peerReadKey, send.json().sortKey); assert.equal(after.lastReadKey, before.lastReadKey); assert.equal(after.unread, before.unread);
});

test('conv2 обещает признак нового сообщения и доставку из новой ручки старому клиенту', async () => {
  // Ловит ложное объявление conv2, включающее новый клиент без звука и старую пару без живого сообщения.
  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: authHeader('a') });
  assert.equal(me.statusCode, 200);
  assert.ok(me.json().features.includes('conv1'));
  assert.ok(me.json().features.includes('conv2'));
  published.length = 0;
  const sent = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'),
    payload: { clientId: '00000000-0000-4000-8000-000000000182', content: 'conv2' } });
  assert.equal(sent.statusCode, 201);
  expectDmEvents(['a:dm.create', 'b:dm.channel', 'b:dm.create'], ['a:conv.change', 'b:conv.change']);
  const changes = published.map((p) => JSON.parse(p.message).m).filter((m) => m.t === 'conv.change');
  assert.equal(changes.length, 2);
  for (const change of changes) {
    assert.equal(change.created, true);
    assert.equal(change.message.id, sent.json().id);
  }
});

test('старая отметка прочтения молчит на пустой беседе, повторе и движении назад', async () => {
  // Ловит лишний read.dm после безусловного publishLegacyRead и ложную отметку посещения на другом устройстве.
  const read = (upTo?: string) => app.inject({ method: 'POST', url: '/dm/dm/read', headers: authHeader('a'), payload: upTo ? { upTo } : {} });
  assert.equal((await read()).statusCode, 200);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expectDmEvents([], []);
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES
    ('silent-read-1', 'dm', 'b', 'one'), ('silent-read-2', 'dm', 'b', 'two')`);
  assert.equal((await read('silent-read-2')).statusCode, 200);
  for (let i = 0; i < 20 && !published.some((p) => JSON.parse(p.message).m.t === 'read.dm'); i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expectDmEvents(['a:read.dm'], ['a:conv.change', 'b:conv.change']);
  for (const upTo of ['silent-read-2', 'silent-read-1']) {
    published.length = 0;
    assert.equal((await read(upTo)).statusCode, 200);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expectDmEvents([], []);
  }
  // Контрфактическая проверка той же ручки: меняем только условие в памяти, не прод-файл.
  const raw = readFileSync(new URL('../src/routes/dm.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('dm.ts', raw, ts.ScriptTarget.Latest, true);
  let handlerSource: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/dm/:id/read') {
      handlerSource = node.arguments[1]!.getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(handlerSource);
  assert.ok(handlerSource.includes('if (readKey !== null) void publishLegacyRead'));
  const mutated = handlerSource.replace('if (readKey !== null) void publishLegacyRead', 'void publishLegacyRead');
  const compiled = ts.transpileModule(`exports.handler = ${mutated}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { exports: {} as { handler?: (req: unknown, reply: unknown) => Promise<unknown> },
    ...await import('../src/conversations.js'), ...await import('../src/dmLegacyEvents.js'),
    z: (await import('zod')).z };
  runInNewContext(compiled, context);
  published.length = 0;
  await context.exports.handler!({ user: { sub: 'a' }, params: { id: 'foreign-dm' }, body: {} }, {});
  expectDmEvents(['a:read.dm'], []);
});

test('новая и старая ручки читают сообщения друг друга, а повтор новой отправки не создаёт дубль', async () => {
  // Ловит расхождение двух независимых хранилищ ЛС после переноса.
  const old = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('a'), payload: { content: 'old' } });
  assert.equal(old.statusCode, 201);
  const newHistory = await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader('b') });
  assert.deepEqual(newHistory.json().messages.map((m: { id: string }) => m.id), [old.json().id]);
  const payload = { clientId: '00000000-0000-4000-8000-000000000001', content: 'new' };
  const first = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('b'), payload });
  assert.equal(first.statusCode, 201);
  const replay = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('b'), payload });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().id, first.json().id);
  const oldHistory = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  assert.deepEqual(oldHistory.json().map((m: { id: string }) => m.id), [old.json().id, first.json().id]);
});

test('clientId принимает нормализованный повтор, но отвергает новый текст и другую беседу', async () => {
  // Ловит покупку второй записи тем же id отправки и возврат сообщения из чужой беседы.
  const clientId = '00000000-0000-4000-8000-000000000002';
  const post = (id: string, content: string) => app.inject({
    method: 'POST', url: `/conv/${id}/messages`, headers: authHeader('a'), payload: { clientId, content },
  });
  const first = await post('dm', '  hello  ');
  assert.equal(first.statusCode, 201);
  const replay = await post('dm', 'hello');
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().id, first.json().id);
  assert.equal((await post('dm', 'different')).statusCode, 409);
  assert.equal((await post('foreign-dm', 'hello')).statusCode, 409);
  const rows = await t.raw.query(`SELECT id FROM conversation_messages WHERE client_id = '${clientId}'`);
  assert.equal(rows.rows.length, 1);
});

test('параллельный повтор clientId пишет одну строку и один номер журнала', async () => {
  // Ловит UNIQUE-ошибку или двойное уведомление при повторной отправке с двух вкладок.
  const payload = { clientId: '00000000-0000-4000-8000-000000000099', content: 'once' };
  const send = () => app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload });
  const [first, second] = await Promise.all([send(), send()]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 201]);
  assert.equal(first.json().id, second.json().id);
  assert.equal((await t.raw.query(`SELECT id FROM conversation_messages WHERE client_id = '${payload.clientId}'`)).rows.length, 1);
  for (const id of ['a', 'b']) {
    const state = await t.raw.query<{ pts: number; n: number }>(`
      SELECT s.pts, (SELECT count(*)::int FROM user_changes c WHERE c.user_id = s.user_id) AS n
      FROM user_sync s WHERE s.user_id = '${id}'`);
    assert.deepEqual(state.rows.map((r) => [Number(r.pts), Number(r.n)]), [[1, 1]]);
  }
});

test('два старых запроса без clientId остаются двумя сообщениями, ключ после будущего растёт на один', async () => {
  // Ловит склейку старых отправок и откат порядка после перестановки часов.
  const future = Date.now() * 1000 + 10_000_000;
  await t.raw.query(`UPDATE conversations SET last_sort_key = $1 WHERE id = 'dm'`, [future]);
  const send = () => app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('a'), payload: { content: 'same' } });
  const [one, two] = await Promise.all([send(), send()]);
  assert.equal(one.statusCode, 201);
  assert.equal(two.statusCode, 201);
  assert.notEqual(one.json().id, two.json().id);
  const keys = (await t.raw.query<{ sort_key: number }>(`
    SELECT sort_key FROM conversation_messages WHERE conversation_id = 'dm' ORDER BY sort_key`,
  )).rows.map((r) => Number(r.sort_key));
  assert.deepEqual(keys, [future + 1, future + 2]);
  assert.equal(Number((await t.raw.query<{ last_sort_key: number }>(`SELECT last_sort_key FROM conversations WHERE id = 'dm'`)).rows[0]?.last_sort_key), future + 2);
});

test('встречные отправки дают уникальный порядок и последовательный журнал обоим', async () => {
  // Ловит взаимную блокировку при обратном порядке участников и дырку в pts.
  const send = (id: string) => app.inject({
    method: 'POST', url: '/dm/dm/messages', headers: authHeader(id), payload: { content: id },
  });
  const [a, b] = await Promise.all([send('a'), send('b')]);
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  const rows = (await t.raw.query<{ sort_key: number }>(`SELECT sort_key FROM conversation_messages WHERE conversation_id = 'dm' ORDER BY sort_key`)).rows;
  assert.equal(rows.length, 2);
  assert.ok(Number(rows[0]?.sort_key) < Number(rows[1]?.sort_key));
  for (const id of ['a', 'b']) {
    const journal = (await t.raw.query<{ pts: number }>(`SELECT pts FROM user_changes WHERE user_id = '${id}' ORDER BY pts`)).rows;
    assert.deepEqual(journal.map((r) => Number(r.pts)), [1, 2]);
  }
});

test('история беседы листается до, после и вокруг ключа без пропуска соседей', async () => {
  // Ловит потерю строки на границе страницы и смешение порядка сортировки.
  const ids: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const sent = await app.inject({
      method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'),
      payload: { clientId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, content: String(i) },
    });
    assert.equal(sent.statusCode, 201);
    ids.push(sent.json().id);
  }
  const page = async (suffix: string) => {
    const response = await app.inject({ method: 'GET', url: `/conv/dm/messages?${suffix}`, headers: authHeader('b') });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  const latest = await page('limit=2');
  assert.deepEqual(latest.messages.map((m: { id: string }) => m.id), ids.slice(2));
  assert.equal(latest.hasMoreBefore, true);
  const cursor = `${latest.messages[0].sortKey}_${latest.messages[0].id}`;
  assert.deepEqual((await page(`before=${cursor}&limit=2`)).messages.map((m: { id: string }) => m.id), ids.slice(0, 2));
  assert.deepEqual((await page(`after=${cursor}&limit=2`)).messages.map((m: { id: string }) => m.id), ids.slice(3));
  assert.deepEqual((await page(`around=${ids[1]}&limit=3`)).messages.map((m: { id: string }) => m.id), ids.slice(0, 3));
});

test('догонка отдаёт страницы без пропуска, а слишком старый номер требует снимок', async () => {
  // Ловит пропуск журнала между страницами и бесконечную догонку после очистки.
  for (let i = 1; i <= 3; i++) {
    const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('a'), payload: { content: String(i) } });
    assert.equal(sent.statusCode, 201);
  }
  const sync = async (pts: number, limit = 2) => {
    const response = await app.inject({ method: 'GET', url: `/conv/sync?pts=${pts}&limit=${limit}`, headers: authHeader('b') });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  const first = await sync(0);
  assert.equal(first.reset, false);
  assert.equal(first.more, true);
  assert.equal(first.pts, 2);
  assert.equal(first.messages.length, 2);
  const second = await sync(first.pts);
  assert.equal(second.more, false);
  assert.equal(second.pts, 3);
  assert.equal(second.messages.length, 1);
  await t.raw.exec(`UPDATE user_sync SET min_pts = 2 WHERE user_id = 'b'`);
  assert.deepEqual(await sync(1), { reset: true, pts: 3 });
  assert.equal((await sync(2)).reset, false);
  assert.deepEqual(await sync(4), { reset: true, pts: 3 });
});

test('личное скрытие превращается в gone только для скрывшего, не для собеседника', async () => {
  // Ловит оставшийся в офлайн-кеше текст после удаления «у меня» с другого устройства.
  const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'secret' } });
  const id = sent.json().id;
  const hidden = await app.inject({ method: 'DELETE', url: `/dm/dm/messages/${id}?for=me`, headers: authHeader('a') });
  assert.equal(hidden.statusCode, 204);
  const sync = async (viewer: string) => (await app.inject({
    method: 'GET', url: '/conv/sync?pts=0', headers: authHeader(viewer),
  })).json();
  const a = await sync('a');
  const b = await sync('b');
  assert.deepEqual(a.messages, [{ id, conversationId: 'dm', gone: true }]);
  assert.equal(b.messages[0].id, id);
  assert.equal('gone' in b.messages[0], false);
});

test('придержанное не появляется ни в журнале, ни в истории блокировщика', async () => {
  // Ловит раскрытие факта отправки заблокированным через догонку или счётчик.
  await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'b' } });
  const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'hidden' } });
  assert.equal(sent.statusCode, 201);
  const a = (await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('a') })).json();
  const b = (await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('b') })).json();
  assert.equal(a.pts, 0);
  assert.deepEqual(a.messages, []);
  assert.equal(b.messages[0].id, sent.json().id);
  assert.equal((await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader('a') })).json().messages.length, 0);
});

test('удаление у обоих стирает реакцию и даёт адресное надгробие без второй записи при повторе', async () => {
  // Ловит воскресшую реакцию или дублирующую догонку после удаления сообщения.
  const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'soon gone' } });
  const id = sent.json().id;
  const react = await app.inject({ method: 'POST', url: `/conv/dm/messages/${id}/reactions`, headers: authHeader('a'), payload: { emoji: '👍', op: 'add' } });
  assert.equal(react.statusCode, 204);
  assert.equal((await t.raw.query(`SELECT 1 FROM conversation_message_reactions WHERE message_id = '${id}'`)).rows.length, 1);
  assert.equal((await app.inject({ method: 'DELETE', url: `/dm/dm/messages/${id}`, headers: authHeader('b') })).statusCode, 204);
  assert.equal((await t.raw.query(`SELECT 1 FROM conversation_message_reactions WHERE message_id = '${id}'`)).rows.length, 0);
  for (const viewer of ['a', 'b']) {
    const sync = (await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader(viewer) })).json();
    assert.deepEqual(sync.messages, [{ id, conversationId: 'dm', gone: true }]);
  }
  const before = (await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_changes`)).rows[0]?.n;
  assert.equal((await app.inject({ method: 'DELETE', url: `/dm/dm/messages/${id}`, headers: authHeader('b') })).statusCode, 204);
  assert.equal((await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_changes`)).rows[0]?.n, before);
});

test('цитата удалённого у обоих остаётся помеченной только в новом DTO', async () => {
  // Ловит пустую цитату без признака удаления в старом клиенте или потерю ссылки в новом.
  const parent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('a'), payload: { content: 'parent' } });
  const child = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'child', replyToId: parent.json().id } });
  assert.equal(child.statusCode, 201);
  assert.equal((await app.inject({ method: 'DELETE', url: `/dm/dm/messages/${parent.json().id}`, headers: authHeader('a') })).statusCode, 204);
  const old = (await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') })).json();
  const fresh = (await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader('a') })).json().messages;
  assert.equal(old.find((m: { id: string }) => m.id === child.json().id).replyTo, null);
  assert.equal(fresh.find((m: { id: string }) => m.id === child.json().id).replyTo.deleted, true);
});

test('прочтение принимает только ключ своего сообщения и не откатывает отметку', async () => {
  // Ловит произвольное чтение будущего и возврат unread после отставшего устройства.
  const one = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('a'), payload: { content: '1' } });
  const two = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('a'), payload: { content: '2' } });
  const key = async (id: string) => Number((await t.raw.query<{ sort_key: number }>(
    `SELECT sort_key FROM conversation_messages WHERE id = '${id}'`,
  )).rows[0]?.sort_key);
  const low = await key(one.json().id);
  const high = await key(two.json().id);
  const read = (value: number) => app.inject({ method: 'POST', url: '/conv/dm/read', headers: authHeader('b'), payload: { key: value } });
  assert.equal((await read(high + 1)).statusCode, 400);
  assert.equal((await read(high)).json().lastReadKey, high);
  const pts = Number((await t.raw.query<{ pts: number }>(`SELECT pts FROM user_sync WHERE user_id = 'b'`)).rows[0]?.pts);
  assert.equal((await read(low)).json().lastReadKey, high);
  assert.equal(Number((await t.raw.query<{ pts: number }>(`SELECT pts FROM user_sync WHERE user_id = 'b'`)).rows[0]?.pts), pts);
});

test('повторное удаление надгробия не создаёт второе событие', async () => {
  // Ловит повторное удаление в догонке после повторного нажатия старого клиента.
  const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'delete' } });
  const url = `/dm/dm/messages/${sent.json().id}`;
  published.length = 0;
  assert.equal((await app.inject({ method: 'DELETE', url, headers: authHeader('b') })).statusCode, 204);
  const once = published.length;
  assert.ok(once > 0);
  assert.equal((await app.inject({ method: 'DELETE', url, headers: authHeader('b') })).statusCode, 204);
  assert.equal(published.length, once);
});

test('открытая старая пара возвращает прежнюю беседу без unread, новая — UUIDv7', async () => {
  // Ловит дубль пары и несовместимый DTO ответа старого POST /dm.
  const existing = await app.inject({ method: 'POST', url: '/dm', headers: authHeader('a'), payload: { userId: 'b' } });
  assert.equal(existing.statusCode, 200);
  assert.equal(existing.json().id, 'dm');
  assert.equal('unread' in existing.json(), false);
  const created = await app.inject({ method: 'POST', url: '/dm', headers: authHeader('b'), payload: { userId: 'c' } });
  assert.equal(created.statusCode, 200);
  assert.match(created.json().id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal('unread' in created.json(), false);
});

test('профиль объявляет conv1 и новая ручка доступна без старого флага', async () => {
  // Ловит скрытое включение работающих бесед, из-за которого новый клиент остался бы на старом API.
  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: authHeader('a') });
  assert.equal(me.statusCode, 200);
  assert.ok(me.json().features.includes('conv1'));
  const conv = await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') });
  assert.equal(conv.statusCode, 200);
  assert.deepEqual(conv.json().conversations.map((c: { id: string }) => c.id).sort(), ['dm', 'foreign-dm']);
});

test('цитата скрытого у меня сообщения исчезает только из моей истории', async () => {
  // Ловит утечку текста сообщения через reply preview после «удалить у меня».
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, reply_to_id) VALUES
    ('quote-parent', 'dm', 'b', 'скрытая цитата', null),
    ('quote-child', 'dm', 'b', 'ответ', 'quote-parent')`);
  const deleted = await app.inject({ method: 'DELETE', url: '/dm/dm/messages/quote-parent?for=me', headers: authHeader('a') });
  assert.equal(deleted.statusCode, 204);
  const a = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  const b = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('b') });
  assert.equal(a.json().find((m: { id: string }) => m.id === 'quote-child').replyTo, null);
  assert.equal(b.json().find((m: { id: string }) => m.id === 'quote-child').replyTo.content, 'скрытая цитата');
});

test('блокировка не задерживает правку и удаление доставленного, но придержанное молчит', async () => {
  // Ловит расхождение живой ленты с базой для старого сообщения и утечку нового придержанного.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('delivered', 'dm', 'b', 'old')`);
  await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'b' } });
  published.length = 0;
  const edit = await app.inject({ method: 'PATCH', url: '/dm/dm/messages/delivered', headers: authHeader('b'), payload: { content: 'new' } });
  assert.equal(edit.statusCode, 200);
  assert.equal(published.some((p) => p.channel === 'gw:user:a' && JSON.parse(p.message).m.t === 'dm.update'), true);
  published.length = 0;
  const remove = await app.inject({ method: 'DELETE', url: '/dm/dm/messages/delivered', headers: authHeader('b') });
  assert.equal(remove.statusCode, 204);
  assert.equal(published.some((p) => p.channel === 'gw:user:a' && JSON.parse(p.message).m.t === 'dm.delete'), true);
  const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'withheld' } });
  published.length = 0;
  const silentEdit = await app.inject({ method: 'PATCH', url: `/dm/dm/messages/${sent.json().id}`, headers: authHeader('b'), payload: { content: 'still withheld' } });
  assert.equal(silentEdit.statusCode, 200);
  const silentDelete = await app.inject({ method: 'DELETE', url: `/dm/dm/messages/${sent.json().id}`, headers: authHeader('b') });
  assert.equal(silentDelete.statusCode, 204);
  assert.equal(published.some((p) => p.channel === 'gw:user:a' && ['dm.update', 'dm.delete'].includes(JSON.parse(p.message).m.t)), false);
});

test('правка пробелами запрещена без вложений и разрешает убрать подпись у вложения', async () => {
  // Ловит пустые сообщения из пробелов и одновременно запрет законного удаления подписи у файла.
  await t.raw.exec(`
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, attachments) VALUES
      ('edit-dm-text', 'dm', 'a', 'keep', '[]'::jsonb),
      ('edit-dm-file', 'dm', 'a', 'caption', '[{"url":"https://x.test/f","name":"f","contentType":"text/plain","size":1}]'::jsonb);
    INSERT INTO messages (id, channel_id, author_id, content, attachments) VALUES
      ('edit-ch-text', 'ch', 'a', 'keep', '[]'::jsonb),
      ('edit-ch-file', 'ch', 'a', 'caption', '[{"url":"https://x.test/f","name":"f","contentType":"text/plain","size":1}]'::jsonb)
  `);
  for (const [textUrl, fileUrl] of [
    ['/dm/dm/messages/edit-dm-text', '/dm/dm/messages/edit-dm-file'],
    ['/channels/ch/messages/edit-ch-text', '/channels/ch/messages/edit-ch-file'],
  ]) {
    const rejected = await app.inject({ method: 'PATCH', url: textUrl, headers: authHeader('a'), payload: { content: '   ' } });
    assert.equal(rejected.statusCode, 400);
    const accepted = await app.inject({ method: 'PATCH', url: fileUrl, headers: authHeader('a'), payload: { content: '   ' } });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().content, '');
  }
  const texts = await t.raw.query<{ content: string }>(`
    SELECT content FROM conversation_messages WHERE id = 'edit-dm-text'
    UNION ALL SELECT content FROM messages WHERE id = 'edit-ch-text'
  `);
  assert.deepEqual(texts.rows.map((r) => r.content), ['keep', 'keep']);
});

test('пересылка с вложением создаёт отдельную копию и возвращает attachment preview в сводках', async () => {
  // Ловит утечку доступа к исходному файлу и потерю превью вложений в GET, sync и событии.
  const stored = new Map<string, Buffer>();
  const copied: string[][] = [];
  setAttachmentStoreForTests({
    ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async (key, bytes) => { stored.set(key, Buffer.from(bytes)); },
    stat: async (key) => stored.has(key) ? { size: stored.get(key)!.length } : null,
    get: async (key) => Readable.from(stored.get(key) ?? Buffer.alloc(0)),
    remove: async (key) => { stored.delete(key); },
    copy: async (from, to) => { copied.push([from, to]); stored.set(to, Buffer.from(stored.get(from) ?? [])); },
  });
  try {
    const original = '12345678-1234-1234-1234-123456789abc';
    const sourceBytes = Buffer.from('secret-copy-bytes');
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, attachments, created_at) VALUES
      ('older-dm-preview', 'dm', 'b', '', '[{"name":"older.pdf","contentType":"application/pdf","size":2}]', now() - interval '1 hour')`);
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, attachments)
      VALUES ('source-photo', 'foreign-dm', 'c', '', '${JSON.stringify([{ id: original, name: 'pic.png', contentType: 'image/png', size: sourceBytes.length, width: 640, height: 480 }]).replaceAll("'", "''")}')`);
    stored.set(`dm/${original}`, sourceBytes);
    await t.raw.exec(`INSERT INTO attachments (id, conversation_id, owner_id, message_id, storage_key, name, content_type, size, state)
      VALUES ('${original}', 'foreign-dm', 'c', 'source-photo', 'dm/${original}', 'pic.png', 'image/png', ${sourceBytes.length}, 'attached')`);
    const res = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: {
      clientId: '00000000-0000-4000-8000-000000000501', fromConversationId: 'foreign-dm', messageIds: ['source-photo'],
    } });
    assert.equal(res.statusCode, 201, res.body);
    const msg = res.json().messages[0];
    const copyId = msg.attachments[0].id;
    assert.notEqual(copyId, original);
    assert.deepEqual(msg.attachments[0] && [msg.attachments[0].width, msg.attachments[0].height], [640, 480]);
    assert.deepEqual(msg.forwardedFrom, { userId: 'c', displayName: 'Charlie', at: (await t.raw.query<{ created_at: Date }>("SELECT created_at FROM conversation_messages WHERE id='source-photo'")).rows[0].created_at.toISOString() });
    assert.deepEqual(copied, [[`dm/${original}`, `dm/${copyId}`]]);
    assert.deepEqual(stored.get(`dm/${copyId}`), sourceBytes);
    const rows = await t.raw.query<{ owner_id: string; conversation_id: string; message_id: string; storage_key: string; state: string }>(`SELECT owner_id, conversation_id, message_id, storage_key, state FROM attachments WHERE id='${copyId}'`);
    assert.deepEqual(rows.rows[0], { owner_id: 'a', conversation_id: 'dm', message_id: msg.id, storage_key: `dm/${copyId}`, state: 'attached' });
    assert.equal((await app.inject({ method: 'GET', url: new URL(attachmentLink(copyId, 'b', 0)).pathname.replace(/^\/api/, ''), headers: authHeader('b') })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: new URL(attachmentLink(copyId, 'c', 0)).pathname.replace(/^\/api/, ''), headers: authHeader('c') })).statusCode, 404);
    const summary = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') })).json().conversations.find((x: { id: string }) => x.id === 'dm');
    assert.equal(summary.lastMessage.attachmentKind, 'photo');
    const sync = await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('b') });
    assert.equal(sync.json().conversations.find((x: { id: string }) => x.id === 'dm').lastMessage.attachmentKind, 'photo');
    const events = published.map((p) => JSON.parse(p.message).m).filter((m) => m.t === 'conv.change');
    assert.ok(events.some((e) => e.conversation?.lastMessage?.attachmentKind === 'photo' || e.summary?.lastMessage?.attachmentKind === 'photo'));
    const deleteCopy = await app.inject({ method: 'DELETE', url: `/conv/dm/messages/${msg.id}?for=both`, headers: authHeader('a') });
    assert.equal(deleteCopy.statusCode, 204);
    for (let i = 0; i < 50 && stored.has(`dm/${copyId}`); i++) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(stored.has(`dm/${copyId}`), false);
    assert.equal(stored.has(`dm/${original}`), true);
    assert.equal((await app.inject({ method: 'GET', url: new URL(attachmentLink(original, 'c', 0)).pathname.replace(/^\/api/, ''), headers: authHeader('c') })).statusCode, 200);
    const deleteOriginal = await app.inject({ method: 'DELETE', url: '/conv/foreign-dm/messages/source-photo?for=both', headers: authHeader('c') });
    assert.equal(deleteOriginal.statusCode, 204);
    for (let i = 0; i < 50 && stored.has(`dm/${original}`); i++) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(stored.has(`dm/${original}`), false);
    const fallback = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') })).json().conversations.find((x: { id: string }) => x.id === 'dm').lastMessage;
    assert.equal(fallback.attachmentKind, 'file'); assert.equal(fallback.attachmentName, 'older.pdf');
    const original2 = '12345678-1234-1234-1234-123456789abd';
    stored.set(`dm/${original2}`, Buffer.from('second-source'));
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, attachments) VALUES
      ('source-photo-2', 'foreign-dm', 'c', '', '[{"id":"${original2}","name":"again.png","contentType":"image/png","size":13,"width":10,"height":20}]');
      INSERT INTO attachments (id, conversation_id, owner_id, message_id, storage_key, name, content_type, size, state)
      VALUES ('${original2}', 'foreign-dm', 'c', 'source-photo-2', 'dm/${original2}', 'again.png', 'image/png', 13, 'attached')`);
    const secondForward = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: {
      clientId: '00000000-0000-4000-8000-000000000512', fromConversationId: 'foreign-dm', messageIds: ['source-photo-2'],
    } });
    assert.equal(secondForward.statusCode, 201, secondForward.body);
    const secondCopyId = secondForward.json().messages[0].attachments[0].id;
    assert.notEqual(secondCopyId, original2);
    assert.equal((await app.inject({ method: 'DELETE', url: '/conv/foreign-dm/messages/source-photo-2?for=both', headers: authHeader('c') })).statusCode, 204);
    for (let i = 0; i < 50 && stored.has(`dm/${original2}`); i++) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(stored.has(`dm/${original2}`), false);
    assert.equal(stored.has(`dm/${secondCopyId}`), true);
    assert.equal((await app.inject({ method: 'GET', url: new URL(attachmentLink(secondCopyId, 'b', 0)).pathname.replace(/^\/api/, ''), headers: authHeader('b') })).statusCode, 200);
  } finally { setAttachmentStoreForTests(null); }
});

test('пересылка сохраняет порядок источника, идемпотентность, журнал и одну legacy/push пачку', async () => {
  // Ловит удвоение копий/событий при replay и неправильный маркер created на каждом элементе.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, sort_key) VALUES
    ('src-one', 'foreign-dm', 'c', 'first', 8001), ('src-two', 'foreign-dm', 'a', 'second', 8002), ('src-three', 'foreign-dm', 'c', 'third', 8003)`);
  await t.raw.exec("INSERT INTO push_devices (id, user_id, device_id, endpoint, platform) VALUES ('forward-push', 'b', 'phone', 'https://ntfy.example.test/forward', 'android')");
  const body = { clientId: '00000000-0000-4000-8000-000000000502', fromConversationId: 'foreign-dm', messageIds: ['src-three', 'src-one', 'src-two'] };
  const first = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: body });
  assert.equal(first.statusCode, 201, first.body);
  const messages = first.json().messages;
  assert.deepEqual(messages.map((m: { content: string }) => m.content), ['first', 'second', 'third']);
  assert.deepEqual(messages.map((m: { sortKey: number }) => m.sortKey), [messages[0].sortKey, messages[0].sortKey + 1, messages[0].sortKey + 2]);
  assert.ok(messages.every((m: { replyTo: unknown; forwardedFrom?: { userId: string } }) => m.replyTo === null && !!m.forwardedFrom?.userId), JSON.stringify(messages));
  const batchEvents = published.map((p) => JSON.parse(p.message)).filter((p) => p.m.t === 'conv.change');
  assert.equal(batchEvents.length, 6);
  assert.deepEqual(batchEvents.filter((p) => p.m.created).map((p) => p.m.message.id), [messages[2].id, messages[2].id]);
  const legacyCreates = published.map((p) => JSON.parse(p.message).m).filter((m) => m.t === 'dm.create');
  assert.equal(legacyCreates.length, 6);
  assert.ok(legacyCreates.every((m) => m.message?.forwardedFrom?.userId));
  assert.equal(published.filter((p) => p.channel === 'gw:user:b' && JSON.parse(p.message).m.t === 'dm.channel').length, 1);
  const beforeSync = { a: (await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('a') })).json().pts,
    b: (await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('b') })).json().pts };
  assert.equal(beforeSync.a, 3); assert.equal(beforeSync.b, 3);
  for (const user of ['a', 'b']) {
    const journal = await t.raw.query<{ pts: number }>(`SELECT pts FROM user_changes WHERE user_id='${user}' AND conversation_id='dm' ORDER BY pts`);
    assert.deepEqual(journal.rows.map((r) => Number(r.pts)), [1, 2, 3]);
  }
  const unread = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') })).json().conversations.find((c: { id: string }) => c.id === 'dm');
  assert.equal(unread.unread, 3); assert.equal(unread.lastMessage.id, messages[2].id);
  const beforeReplay = {
    messages: (await t.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id='dm'")).rows[0]!.n,
    attachments: (await t.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM attachments WHERE conversation_id='dm'")).rows[0]!.n,
    changes: (await t.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM user_changes WHERE conversation_id='dm'")).rows[0]!.n,
  };
  for (let i = 0; i < 10 && posted.length === 0; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(posted.length, 1);
  assert.match(String(posted[0].init.body), /Пересланные сообщения: 3/);
  published.length = 0; posted.length = 0;
  const replay = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: { ...body, messageIds: ['src-two', 'src-three', 'src-one'] } });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json().messages.map((m: { id: string }) => m.id), messages.map((m: { id: string }) => m.id));
  assert.deepEqual({
    messages: (await t.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id='dm'")).rows[0]!.n,
    attachments: (await t.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM attachments WHERE conversation_id='dm'")).rows[0]!.n,
    changes: (await t.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM user_changes WHERE conversation_id='dm'")).rows[0]!.n,
  }, beforeReplay);
  assert.equal(published.length, 0); assert.equal(posted.length, 0);
  for (const changed of [{ messageIds: ['src-one'] }, { messageIds: ['src-one', 'src-two', 'src-three', 'src-four'] }, { fromConversationId: 'dm' }]) {
    const conflict = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: { ...body, ...changed } });
    assert.equal(conflict.statusCode, 409);
  }
});

test('пересылка отказывает при невидимом источнике, неверном участии и удалённом собеседнике без побочных эффектов', async () => {
  // Ловит обход фильтра видимости источника и создание копий до проверки доступа.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, hidden_for, withheld) VALUES
    ('hidden-src', 'foreign-dm', 'c', 'hidden', ARRAY['a'], false), ('held-src', 'foreign-dm', 'a', 'held', '{}', true),
    ('gone-src', 'foreign-dm', 'c', '', '{}', false);
    INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('other-conversation-src', 'dm', 'a', 'not from this dialog');
    UPDATE conversation_messages SET deleted_at=now(), content='' WHERE id='gone-src';`);
  const attempt = (user: string, destination: string, source: string, ids: string[]) => app.inject({ method: 'POST', url: `/conv/${destination}/forward`, headers: authHeader(user), payload: {
    clientId: '00000000-0000-4000-8000-000000000503', fromConversationId: source, messageIds: ids,
  } });
  const sourceMissing = await attempt('a', 'dm', 'foreign-dm', ['hidden-src', 'gone-src', 'other-conversation-src', 'src-not-there']);
  assert.equal(sourceMissing.statusCode, 400);
  assert.deepEqual(sourceMissing.json().missing, ['hidden-src', 'gone-src', 'other-conversation-src', 'src-not-there']);
  assert.equal((await attempt('b', 'foreign-dm', 'dm', ['hidden-src'])).statusCode, 404);
  await t.raw.exec("UPDATE conversation_members SET left_at=now() WHERE conversation_id='foreign-dm' AND user_id='a'");
  assert.equal((await attempt('a', 'dm', 'foreign-dm', ['held-src'])).statusCode, 404);
  await t.raw.exec("UPDATE conversation_members SET left_at=NULL WHERE conversation_id='foreign-dm' AND user_id='a'");
  const ownWithheld = await attempt('a', 'dm', 'foreign-dm', ['held-src']);
  assert.equal(ownWithheld.statusCode, 201, ownWithheld.body);
  assert.equal(ownWithheld.json().messages[0].forwardedFrom.userId, 'a');
  await t.raw.exec("UPDATE users SET deleted_at=now() WHERE id='b'");
  assert.equal((await attempt('a', 'dm', 'foreign-dm', ['held-src'])).statusCode, 403);
  assert.equal((await t.raw.query("SELECT id FROM conversation_messages WHERE conversation_id='dm' AND forwarded_from->>'userId'='a'")).rows.length, 1);
  assert.equal((await t.raw.query("SELECT id FROM attachments WHERE state='pending'")).rows.length, 0);
});

test('С1 удаляет чужое в 1:1 через conv одиночно и пачкой, но старая dm-ручка запрещает', async () => {
  // Ловит расхождение прав между API, потерю следов удаления и пропуск legacy-клиента.
  const { INSTANCE_FEATURES } = await import('../src/instanceFeatures.js');
  assert.ok(INSTANCE_FEATURES.includes(FEATURE_CONV6));
  const fileId = '12345678-1234-4234-8234-000000009901';
  const stored = new Map<string, Buffer>([[`dm/${fileId}`, Buffer.from('secret')]]);
  setAttachmentStoreForTests({ ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async (k, b) => { stored.set(k, Buffer.from(b)); }, stat: async (k) => stored.has(k) ? { size: stored.get(k)!.length } : null,
    get: async (k) => Readable.from(stored.get(k) ?? []), remove: async (k) => { stored.delete(k); } });
  try {
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, forwarded_from, attachments) VALUES
      ('s1-single', 'dm', 'b', 'one', '{"userId":"c","displayName":"Charlie","at":"2026-01-01T00:00:00.000Z"}', '[]'),
      ('s1-own-forward', 'dm', 'a', 'own copy', '{"userId":"c","displayName":"Charlie","at":"2026-01-01T00:00:00.000Z"}', '[]'),
      ('s1-reverse', 'dm', 'a', 'reverse', null, '[]'), ('s1-legacy', 'dm', 'b', 'legacy', null, '[]'), ('s1-batch', 'dm', 'b', 'batch', null,
       '[{"id":"${fileId}","name":"f","contentType":"application/octet-stream","size":6}]');
      INSERT INTO conversation_messages (id, conversation_id, author_id, content, hidden_for, withheld, deleted_at) VALUES
        ('s1-hidden', 'dm', 'b', 'hidden', ARRAY['a'], false, null), ('s1-held', 'dm', 'b', 'held', '{}', true, null),
        ('s1-already', 'dm', 'b', '', '{}', false, now());
      INSERT INTO attachments (id, conversation_id, owner_id, message_id, storage_key, name, content_type, size, state)
        VALUES ('${fileId}', 'dm', 'b', 's1-batch', 'dm/${fileId}', 'f', 'application/octet-stream', 6, 'attached');
      INSERT INTO conversation_message_reactions (message_id, user_id, emoji) VALUES ('s1-batch', 'a', '🔥');
      INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('b', 'a'), ('a', 'b')`);
    const legacy = await app.inject({ method: 'DELETE', url: '/dm/dm/messages/s1-legacy?for=both', headers: authHeader('a') });
    assert.equal(legacy.statusCode, 403);
    const assertUnreadOnBothLegacyEvents = async (messageId: string) => {
      const expectedUnread = new Map<string, number>();
      for (const user of ['a', 'b']) {
        const summary = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader(user) })).json().conversations.find((c: { id: string }) => c.id === 'dm');
        expectedUnread.set(user, summary.unread ?? 0);
      }
      const expectedLast = (await t.raw.query<{ actual: Date; expected: Date }>(`SELECT c.last_message_at AS actual,
        (SELECT max(created_at) FROM conversation_messages WHERE conversation_id='dm' AND NOT withheld AND deleted_at IS NULL) AS expected
        FROM conversations c WHERE c.id='dm'`)).rows[0]!;
      assert.equal(expectedLast.actual.toISOString(), expectedLast.expected.toISOString());
      for (const user of ['a', 'b']) {
        const event = published.map((p) => ({ user: p.channel.replace(/^gw:user:/, ''), m: JSON.parse(p.message).m }))
          .find((x) => x.user === user && x.m.t === 'dm.delete' && x.m.messageId === messageId);
        assert.ok(event, `${user} получает dm.delete для ${messageId}`);
        assert.equal(event.m.unread, expectedUnread.get(user), `${user} получает своё актуальное unread для ${messageId}`);
        assert.equal(event.m.lastMessageAt, expectedLast.actual.toISOString());
      }
    };
    const single = await app.inject({ method: 'DELETE', url: '/conv/dm/messages/s1-single?for=both', headers: authHeader('a') });
    assert.equal(single.statusCode, 204, single.body);
    await assertUnreadOnBothLegacyEvents('s1-single');
    const eventsAfterFirstDelete = published.length;
    assert.equal((await app.inject({ method: 'DELETE', url: '/conv/dm/messages/s1-single?for=both', headers: authHeader('a') })).statusCode, 204);
    assert.equal(published.length, eventsAfterFirstDelete, 'повтор уже удалённого не рассылает события');
    const reverse = await app.inject({ method: 'DELETE', url: '/conv/dm/messages/s1-reverse?for=both', headers: authHeader('b') });
    assert.equal(reverse.statusCode, 204, reverse.body);
    const ownForward = await app.inject({ method: 'DELETE', url: '/conv/dm/messages/s1-own-forward?for=both', headers: authHeader('a') });
    assert.equal(ownForward.statusCode, 204, ownForward.body);
    for (const mid of ['s1-hidden', 's1-held']) {
      assert.equal((await app.inject({ method: 'DELETE', url: `/conv/dm/messages/${mid}?for=both`, headers: authHeader('a') })).statusCode, 404);
    }
    assert.equal((await app.inject({ method: 'DELETE', url: '/conv/dm/messages/s1-already?for=both', headers: authHeader('a') })).statusCode, 204);
    const batch = await app.inject({ method: 'POST', url: '/conv/dm/messages/delete', headers: authHeader('a'), payload: { ids: ['s1-batch'], for: 'both' } });
    assert.equal(batch.statusCode, 204, batch.body);
    await assertUnreadOnBothLegacyEvents('s1-batch');
    const tombstones = await t.raw.query<{ id: string; content: string; forwarded_from: unknown; deleted_at: Date | null }>(
      "SELECT id, content, forwarded_from, deleted_at FROM conversation_messages WHERE id IN ('s1-single','s1-reverse','s1-own-forward','s1-batch') ORDER BY id");
    assert.equal(tombstones.rows.length, 4, 'все четыре ожидаемых надгробия остаются в истории');
    assert.ok(tombstones.rows.every((row) => row.content === '' && row.deleted_at && row.forwarded_from === null));
    assert.equal((await t.raw.query("SELECT 1 FROM conversation_message_reactions WHERE message_id='s1-batch'")).rows.length, 0);
    assert.equal((await t.raw.query("SELECT id FROM attachments WHERE id=$1 AND state='attached'", [fileId])).rows.length, 0);
    assert.equal(stored.has(`dm/${fileId}`), false);
    const audience = new Set(published.map((p) => `${p.channel}:${JSON.parse(p.message).m.t}`));
    for (const user of ['a', 'b']) {
      assert.ok(audience.has(`gw:user:${user}:conv.change`), `${user} получает журнал изменения`);
      assert.ok(audience.has(`gw:user:${user}:dm.delete`), `${user} получает legacy-удаление, даже при блокировке`);
    }
    const expectedLast = (await t.raw.query<{ actual: Date; expected: Date }>(`SELECT c.last_message_at AS actual,
      (SELECT max(created_at) FROM conversation_messages WHERE conversation_id='dm' AND NOT withheld AND deleted_at IS NULL) AS expected
      FROM conversations c WHERE c.id='dm'`)).rows[0]!;
    assert.equal(expectedLast.actual.toISOString(), expectedLast.expected.toISOString());
    const bothJournal = await t.raw.query<{ user_id: string; kind: string; message_id: string }>(
      "SELECT user_id, kind, message_id FROM user_changes WHERE conversation_id='dm' AND kind='msg' AND message_id IN ('s1-single','s1-reverse','s1-own-forward','s1-batch')");
    assert.equal(bothJournal.rows.length, 8);
    assert.deepEqual(new Set(bothJournal.rows.map((r) => `${r.user_id}:${r.message_id}`)), new Set(
      ['s1-single','s1-reverse','s1-own-forward','s1-batch'].flatMap((id) => [`a:${id}`, `b:${id}`]),
    ));
    for (const user of ['a', 'b']) {
      const history = await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader(user) });
      const visibleIds = new Set(history.json().messages.map((m: { id: string }) => m.id));
      for (const id of ['s1-single','s1-reverse','s1-own-forward','s1-batch']) assert.equal(visibleIds.has(id), false, `${user} history does not show deleted text ${id}`);
      const catchup = await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader(user) });
      for (const id of ['s1-single','s1-reverse','s1-own-forward','s1-batch']) {
        assert.ok(catchup.json().messages.some((m: { id: string; gone?: boolean }) => m.id === id && m.gone), `${user} catch-up keeps ${id} as a text-free tombstone`);
      }
      const oldHistory = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader(user) });
      for (const id of ['s1-single','s1-reverse','s1-own-forward','s1-batch']) {
        assert.equal(oldHistory.json().some((m: { id: string }) => m.id === id), false, `${user} old history does not show deleted text ${id}`);
      }
    }
  } finally { setAttachmentStoreForTests(null); }
});

test('обезличивание переписывает снимки в цепочке C→A→B и журналирует только живые копии', async () => {
  // Ловит старое имя в сохранённых/надгробных пересылках и кеш участника без conv.change.
  await t.raw.exec(`INSERT INTO conversations (id, kind, direct_key, created_by) VALUES ('bc', 'direct', 'b:c', 'b');
    INSERT INTO conversation_members (conversation_id, user_id) VALUES ('bc','b'),('bc','c');
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, sort_key) VALUES ('origin-c','foreign-dm','c','origin',51001)`);
  const first = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: {
    clientId: '00000000-0000-4000-8000-000000009911', fromConversationId: 'foreign-dm', messageIds: ['origin-c'],
  } });
  assert.equal(first.statusCode, 201, first.body);
  const copyA = first.json().messages[0];
  assert.equal(Object.hasOwn(copyA.forwardedFrom, 'deleted'), false, 'живой автор не получает признак удаления');
  const second = await app.inject({ method: 'POST', url: '/conv/bc/forward', headers: authHeader('b'), payload: {
    clientId: '00000000-0000-4000-8000-000000009912', fromConversationId: 'dm', messageIds: [copyA.id],
  } });
  assert.equal(second.statusCode, 201, second.body);
  const copyB = second.json().messages[0];
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, forwarded_from, deleted_at) VALUES
    ('old-tombstone-snapshot','dm','a','', '{"userId":"c","displayName":"Charlie","at":"2026-01-01T00:00:00.000Z"}', now())`);
  const beforeSnapshots = await t.raw.query<{ id: string; forwarded_from: { userId: string; displayName: string; at: string } }>(
    "SELECT id, forwarded_from FROM conversation_messages WHERE forwarded_from->>'userId'='c' ORDER BY id");
  const { db } = await import('../src/db/index.js');
  const { anonymizeAccountRows } = await import('../src/accountRows.js');
  await db.transaction((tx) => anonymizeAccountRows(tx, 'c', '$2a$10$unusable', new Date('2026-10-05T00:00:00Z')));
  const snapshots = await t.raw.query<{ id: string; forwarded_from: { userId: string; displayName: string; at: string; deleted?: true } }>(
    "SELECT id, forwarded_from FROM conversation_messages WHERE forwarded_from->>'userId'='c' ORDER BY id");
  assert.equal(snapshots.rows.length, 3);
  assert.ok(snapshots.rows.every((r) => r.forwarded_from.displayName === 'Удалённый пользователь'));
  assert.ok(snapshots.rows.every((r) => r.forwarded_from.deleted === true), 'обезличены живые и надгробные снимки первого автора');
  assert.deepEqual(snapshots.rows.map((r) => [r.id, r.forwarded_from.userId, r.forwarded_from.at]),
    beforeSnapshots.rows.map((r) => [r.id, r.forwarded_from.userId, r.forwarded_from.at]));
  const { journalForwardedFrom, deliverMany } = await import('../src/conversations.js');
  published.length = 0;
  await deliverMany(await journalForwardedFrom('c'));
  const recipients = new Set(published.filter((p) => JSON.parse(p.message).m.t === 'conv.change').map((p) => p.channel));
  assert.ok(recipients.has('gw:user:a')); assert.ok(recipients.has('gw:user:b'));
  assert.equal(recipients.has('gw:user:c'), false, 'обезличенный пользователь не получает журнал');
  const journal = await t.raw.query<{ conversation_id: string; user_id: string; message_id: string }>(
    "SELECT conversation_id, user_id, message_id FROM user_changes WHERE kind='msg' AND message_id IN ($1,$2)", [copyA.id, copyB.id]);
  assert.deepEqual(new Set(journal.rows.map((r) => `${r.conversation_id}:${r.user_id}:${r.message_id}`)),
    new Set([`dm:a:${copyA.id}`, `dm:b:${copyA.id}`, `bc:b:${copyB.id}`]));
  const before = (await t.raw.query("SELECT pts FROM user_sync WHERE user_id='a'")).rows;
  await db.transaction((tx) => anonymizeAccountRows(tx, 'c', '$2a$10$unusable', new Date('2026-10-05T00:00:00Z')));
  const afterRepeat = await t.raw.query<{ id: string; forwarded_from: unknown }>(
    "SELECT id, forwarded_from FROM conversation_messages WHERE forwarded_from->>'userId'='c' ORDER BY id");
  assert.deepEqual(afterRepeat.rows, snapshots.rows, 'повтор оставляет сами снимки побайтно прежними');
  assert.deepEqual((await t.raw.query("SELECT pts FROM user_sync WHERE user_id='a'")).rows, before, 'повтор обезличивания не сдвигает журнал');
});

test('пачечное удаление атомарно отклоняет чужое в группе, пропускает исчезнувшее и скрывает только у себя', async () => {
  // Ловит частичное удаление до проверки всей пачки и сохраняет запрет в группах после разрешения 1:1.
  await t.raw.exec(`INSERT INTO conversations (id, kind, direct_key, created_by) VALUES ('group', 'group', NULL, 'a');
    INSERT INTO conversation_members (conversation_id, user_id) VALUES ('group','a'),('group','c');
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, hidden_for, withheld, deleted_at) VALUES
    ('batch-own', 'group', 'a', 'mine', '{}', false, null), ('batch-peer', 'group', 'c', 'theirs', '{}', false, null),
    ('batch-gone', 'group', 'c', '', '{}', false, now()), ('batch-hidden', 'group', 'c', 'hidden', ARRAY['a'], false, null)`);
  published.length = 0;
  const singleRejected = await app.inject({ method: 'DELETE', url: '/conv/group/messages/batch-peer?for=both', headers: authHeader('a') });
  assert.equal(singleRejected.statusCode, 403, 'одиночная новая ручка тоже сохраняет запрет в группе');
  assert.equal(published.length, 0, 'отказ одиночного удаления не рассылается');
  const rejected = await app.inject({ method: 'POST', url: '/conv/group/messages/delete', headers: authHeader('a'), payload: { ids: ['batch-own', 'batch-peer'], for: 'both' } });
  assert.equal(rejected.statusCode, 403);
  assert.equal((await t.raw.query<{ content: string }>("SELECT content FROM conversation_messages WHERE id='batch-own'")).rows[0]?.content, 'mine');
  assert.equal(published.length, 0, 'атомарный отказ не посылает ни журнал, ни legacy-событие');
  published.length = 0;
  const me = await app.inject({ method: 'POST', url: '/conv/group/messages/delete', headers: authHeader('a'), payload: { ids: ['batch-own', 'batch-peer'], for: 'me' } });
  assert.equal(me.statusCode, 204, me.body);
  const own = (await t.raw.query<{ hidden_for: string[] }>("SELECT hidden_for FROM conversation_messages WHERE id='batch-own'")).rows[0]!;
  const peer = (await t.raw.query<{ hidden_for: string[] }>("SELECT hidden_for FROM conversation_messages WHERE id='batch-peer'")).rows[0]!;
  assert.deepEqual(own.hidden_for, ['a']); assert.deepEqual(peer.hidden_for, ['a']);
  assert.ok(published.every((p) => p.channel === 'gw:user:a'));
  const pts = await t.raw.query<{ kind: string; conversation_id: string }>("SELECT kind, conversation_id FROM user_changes WHERE user_id='a'");
  assert.equal(pts.rows.length, 2);
  const count = await t.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id='group' AND hidden_for @> ARRAY['c']");
  assert.equal(count.rows[0]?.n, 0);
});

test('пачечное удаление надгробит свои с файлами, пересчитает время и синхронизирует tombstones', async () => {
  // Ловит оставшийся файл/реакции и неверный lastMessageAt после массового надгробия.
  const stored = new Map<string, Buffer>();
  setAttachmentStoreForTests({ ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async (k, b) => { stored.set(k, Buffer.from(b)); }, stat: async (k) => stored.has(k) ? { size: stored.get(k)!.length } : null,
    get: async (k) => Readable.from(stored.get(k) ?? []), remove: async (k) => { stored.delete(k); } });
  try {
    const id = '12345678-1234-1234-1234-123456789abd'; stored.set(`dm/${id}`, Buffer.from('f'));
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at) VALUES
      ('del-own-file', 'dm', 'a', 'file', now()-interval '2 minutes'), ('del-own-last', 'dm', 'a', 'last', now()-interval '1 minute');
      INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at) VALUES ('del-keep', 'dm', 'b', 'keep', now());
      INSERT INTO attachments (id, conversation_id, owner_id, message_id, storage_key, name, content_type, size, state)
      VALUES ('${id}', 'dm', 'a', 'del-own-file', 'dm/${id}', 'f.bin', 'application/octet-stream', 1, 'attached');
      INSERT INTO conversation_message_reactions (message_id, user_id, emoji) VALUES ('del-own-file', 'b', '🔥');
      UPDATE conversations SET last_message_at=now() WHERE id='dm';`);
    published.length = 0;
    const del = await app.inject({ method: 'POST', url: '/conv/dm/messages/delete', headers: authHeader('a'), payload: { ids: ['del-own-last', 'del-own-file'], for: 'both' } });
    assert.equal(del.statusCode, 204, del.body);
    const tombstones = await t.raw.query<{ id: string; content: string; deleted_at: Date | null }>("SELECT id, content, deleted_at FROM conversation_messages WHERE id IN ('del-own-file','del-own-last') ORDER BY id");
    assert.ok(tombstones.rows.every((r) => r.content === '' && r.deleted_at));
    assert.equal((await t.raw.query("SELECT * FROM conversation_message_reactions WHERE message_id='del-own-file'")).rows.length, 0);
    const copy = await t.raw.query<{ state: string }>(`SELECT state FROM attachments WHERE id='${id}'`);
    assert.ok(copy.rows.length === 0 || copy.rows[0].state === 'deleted');
    assert.equal(stored.has(`dm/${id}`), false);
    assert.equal((await app.inject({ method: 'GET', url: new URL(attachmentLink(id, 'b', 0)).pathname.replace(/^\/api/, ''), headers: authHeader('b') })).statusCode, 404);
    const sync = await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('b') });
    assert.ok(['del-own-file', 'del-own-last'].every((mid) => sync.json().messages.some((m: { id: string; gone?: boolean }) => m.id === mid && m.gone)));
    const event = published.map((p) => JSON.parse(p.message).m).find((m) => m.t === 'dm.delete' && m.messageId === 'del-own-last');
    assert.ok(event);
    const conv = await t.raw.query<{ last_message_at: Date; expected: Date }>(`SELECT c.last_message_at,
      (SELECT max(created_at) FROM conversation_messages WHERE conversation_id='dm' AND NOT withheld AND deleted_at IS NULL) AS expected
      FROM conversations c WHERE c.id='dm'`);
    assert.equal(conv.rows[0]?.last_message_at.toISOString(), conv.rows[0]?.expected.toISOString());
  } finally { setAttachmentStoreForTests(null); }
});

test('пачечный DELETE валидирует границы, скрывает придержанное и повторяется без новых событий', async () => {
  // Ловит некорректную пачку, выход за беседу и повторное журналирование неизменившихся строк.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, withheld, deleted_at, hidden_for) VALUES
    ('batch-held', 'dm', 'a', 'secret', true, null, '{}'), ('batch-foreign', 'foreign-dm', 'a', 'foreign', false, null, '{}'),
    ('batch-gone', 'dm', 'b', '', false, now(), '{}'), ('batch-hidden', 'dm', 'b', 'hidden', false, null, ARRAY['a'])`);
  const url = '/conv/dm/messages/delete';
  for (const payload of [{ ids: [], for: 'me' }, { ids: ['x', 'x'], for: 'me' }, { ids: ['x'], for: 'bad' }, { ids: ['x'] }, { ids: Array.from({ length: 101 }, (_, i) => `m${i}`), for: 'me' }]) {
    assert.equal((await app.inject({ method: 'POST', url, headers: authHeader('a'), payload })).statusCode, 400);
  }
  const wrong = await app.inject({ method: 'POST', url, headers: authHeader('a'), payload: { ids: ['batch-held', 'batch-foreign'], for: 'me' } });
  assert.equal(wrong.statusCode, 404);
  const removeHeld = await app.inject({ method: 'POST', url, headers: authHeader('a'), payload: { ids: ['batch-held'], for: 'both' } });
  assert.equal(removeHeld.statusCode, 204);
  const firstCount = published.length;
  const repeat = await app.inject({ method: 'POST', url, headers: authHeader('a'), payload: { ids: ['batch-held'], for: 'both' } });
  assert.equal(repeat.statusCode, 204); assert.equal(published.length, firstCount);
  const skips = await app.inject({ method: 'POST', url, headers: authHeader('a'), payload: { ids: ['batch-gone', 'batch-hidden'], for: 'both' } });
  assert.equal(skips.statusCode, 204); assert.equal(published.length, firstCount);
  assert.equal((await app.inject({ method: 'POST', url, headers: authHeader('c'), payload: { ids: ['batch-held'], for: 'me' } })).statusCode, 404);
});

test('пересылка валидирует batch/id, пределы вложений и разрешает пересылку в ту же беседу', async () => {
  // Ловит обход лимитов до копирования и ошибочный отказ на допустимую пересылку в исходный диалог.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('forward-self', 'dm', 'a', 'self');
    INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('too-many-files', 'foreign-dm', 'c', '');
    UPDATE conversation_messages SET attachments = (
      SELECT jsonb_agg(jsonb_build_object('id', 'file-' || n, 'name', 'f', 'contentType', 'application/octet-stream', 'size', 1))
      FROM generate_series(1, 41) n
    ) WHERE id='too-many-files';
    INSERT INTO attachments (id, conversation_id, owner_id, message_id, storage_key, name, content_type, size, state)
      SELECT 'file-' || n, 'foreign-dm', 'c', 'too-many-files', 'dm/file-' || n, 'f', 'application/octet-stream', 1, 'attached'
      FROM generate_series(1, 41) n;`);
  const send = (clientId: string, from: string, ids: string[]) => app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: { clientId, fromConversationId: from, messageIds: ids } });
  assert.equal((await send('not-a-uuid', 'foreign-dm', ['src-one'])).statusCode, 400);
  assert.equal((await send('00000000-0000-4000-8000-000000000601', 'foreign-dm', ['src-one', 'src-one'])).statusCode, 400);
  assert.equal((await send('00000000-0000-4000-8000-000000000602', 'foreign-dm', Array.from({ length: 101 }, (_, i) => `m${i}`))).statusCode, 400);
  const tooMany = await send('00000000-0000-4000-8000-000000000603', 'foreign-dm', ['too-many-files']);
  assert.equal(tooMany.statusCode, 400); assert.equal(tooMany.json().error, 'forward too large');
  assert.equal((await t.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM attachments WHERE state='pending'")).rows[0]?.n, 0);
  const exactIds = Array.from({ length: 40 }, (_, i) => `12345678-1234-4234-8234-${String(i + 1).padStart(12, '0')}`);
  const edgeId = '12345678-1234-4234-8234-000000000099';
  const overId = '12345678-1234-4234-8234-000000000100';
  const failId = '12345678-1234-4234-8234-000000000101';
  const forwardBytesMax = 6 * 1024 * 1024 * 1024;
  const stored = new Map<string, Buffer>();
  setAttachmentStoreForTests({ ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async (k, b) => { stored.set(k, Buffer.from(b)); }, stat: async (k) => stored.has(k) ? { size: stored.get(k)!.length } : null,
    get: async (k) => Readable.from(stored.get(k) ?? []), remove: async (k) => { stored.delete(k); },
    copy: async (from, to) => { stored.set(to, Buffer.from(stored.get(from) ?? Buffer.from('x'))); } });
  try {
    const fileJson = (id: string, size = 1) => ({ id, name: 'f', contentType: 'application/octet-stream', size });
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, attachments) VALUES
      ('exact-count', 'foreign-dm', 'c', '', '${JSON.stringify(exactIds.map((id) => fileJson(id))).replaceAll("'", "''")}'),
      ('exact-bytes', 'foreign-dm', 'c', '', '${JSON.stringify([fileJson(edgeId, forwardBytesMax)]).replaceAll("'", "''")}'),
      ('over-bytes', 'foreign-dm', 'c', '', '${JSON.stringify([fileJson(overId, forwardBytesMax + 1)]).replaceAll("'", "''")}'),
      ('copy-fails', 'foreign-dm', 'c', '', '${JSON.stringify([fileJson(failId)]).replaceAll("'", "''")}');
      INSERT INTO attachments (id, conversation_id, owner_id, message_id, storage_key, name, content_type, size, state)
      VALUES ${[...exactIds, edgeId, overId, failId].map((id) => `('${id}', 'foreign-dm', 'c', '${exactIds.includes(id) ? 'exact-count' : id === edgeId ? 'exact-bytes' : id === overId ? 'over-bytes' : 'copy-fails'}', 'dm/${id}', 'f', 'application/octet-stream', ${id === edgeId ? forwardBytesMax : id === overId ? forwardBytesMax + 1 : 1}, 'attached')`).join(',')}`);
    const exactCount = await send('00000000-0000-4000-8000-000000000605', 'foreign-dm', ['exact-count']);
    assert.equal(exactCount.statusCode, 201, exactCount.body);
    const exactBytes = await send('00000000-0000-4000-8000-000000000606', 'foreign-dm', ['exact-bytes']);
    assert.equal(exactBytes.statusCode, 201, exactBytes.body);
    const overBytes = await send('00000000-0000-4000-8000-000000000607', 'foreign-dm', ['over-bytes']);
    assert.equal(overBytes.statusCode, 400); assert.equal(overBytes.json().error, 'forward too large');
    setAttachmentStoreForTests({ ready: () => true, ensureReady: async () => true, configured: () => true,
      put: async () => {}, stat: async () => ({ size: 1 }), get: async () => Readable.from(Buffer.from('x')), remove: async () => {},
      copy: async () => { throw new Error('storage unavailable'); } });
    const failedCopy = await send('00000000-0000-4000-8000-000000000608', 'foreign-dm', ['copy-fails']);
    assert.equal(failedCopy.statusCode, 503);
    assert.equal((await t.raw.query("SELECT id FROM conversation_messages WHERE client_id LIKE '00000000-0000-4000-8000-000000000608%'")).rows.length, 0);
    assert.equal((await t.raw.query(`SELECT id FROM attachments WHERE conversation_id='dm' AND state='pending'`)).rows.length, 0);
  } finally { setAttachmentStoreForTests(null); }
  const self = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: {
    clientId: '00000000-0000-4000-8000-000000000604', fromConversationId: 'dm', messageIds: ['forward-self'],
  } });
  assert.equal(self.statusCode, 201, self.body);
  assert.equal(self.json().messages[0].content, 'self');
});

test('цепочка пересылок сохраняет первого автора и неизменный снимок после переименования', async () => {
  // Ловит превращение цепочки в «переслал B» и утечку прежнего имени удалённого автора.
  await t.raw.exec(`INSERT INTO conversations (id, kind, direct_key, created_by) VALUES ('bc', 'direct', 'b:c', 'b');
    INSERT INTO conversation_members (conversation_id, user_id) VALUES ('bc', 'b'), ('bc', 'c');
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, sort_key) VALUES ('chain-source', 'foreign-dm', 'c', 'origin', 9901);`);
  const first = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: {
    clientId: '00000000-0000-4000-8000-000000000701', fromConversationId: 'foreign-dm', messageIds: ['chain-source'],
  } });
  assert.equal(first.statusCode, 201, first.body);
  const firstCopy = first.json().messages[0];
  assert.deepEqual(firstCopy.forwardedFrom, { userId: 'c', displayName: 'Charlie', at: firstCopy.forwardedFrom.at });
  await t.raw.exec("UPDATE users SET display_name='Changed Charlie' WHERE id='c'");
  const second = await app.inject({ method: 'POST', url: '/conv/bc/forward', headers: authHeader('b'), payload: {
    clientId: '00000000-0000-4000-8000-000000000702', fromConversationId: 'dm', messageIds: [firstCopy.id],
  } });
  assert.equal(second.statusCode, 201, second.body);
  assert.deepEqual(second.json().messages[0].forwardedFrom, firstCopy.forwardedFrom);
  const sync = await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('b') });
  const synced = sync.json().messages.filter((m: { forwardedFrom?: unknown }) => m.forwardedFrom);
  assert.ok(synced.some((m: { id: string }) => m.id === firstCopy.id));
  assert.ok(synced.every((m: { forwardedFrom?: unknown }) => !!m.forwardedFrom));
  const conv = await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') });
  assert.equal(conv.json().conversations.find((c: { id: string }) => c.id === 'dm').unread, 1);
  assert.equal(conv.json().conversations.find((c: { id: string }) => c.id === 'dm').lastMessage.id, firstCopy.id);
  const dbRows = await t.raw.query<{ forwarded_from: { userId: string; displayName: string; at: string } }>(
    "SELECT forwarded_from FROM conversation_messages WHERE forwarded_from IS NOT NULL ORDER BY sort_key",
  );
  assert.equal(dbRows.rows.length, 2);
  assert.ok(dbRows.rows.every((r) => r.forwarded_from.userId === 'c' && r.forwarded_from.displayName === 'Charlie'));
});

test('preview DTO: без файла ключей нет, voice сохраняет длительность, старый /dm не получает forwardedFrom', async () => {
  // Ловит изменение DTO старого клиента и потерю типа/длительности голосового превью.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, attachments, sort_key) VALUES
    ('plain-preview', 'dm', 'a', 'plain', '[]', 10001),
    ('voice-preview-src', 'foreign-dm', 'c', '', '[{"name":"note.ogg","contentType":"audio/ogg","size":10,"waveform":[0.1,0.2],"durationMs":42000}]', 10002)`);
  const before = await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') });
  const plain = before.json().conversations.find((c: { id: string }) => c.id === 'dm').lastMessage;
  assert.equal(Object.hasOwn(plain, 'attachmentKind'), false);
  assert.equal(Object.hasOwn(plain, 'attachmentDurationMs'), false);
  assert.equal(Object.hasOwn(plain, 'attachmentName'), false);
  const forward = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: {
    clientId: '00000000-0000-4000-8000-000000000703', fromConversationId: 'foreign-dm', messageIds: ['voice-preview-src'],
  } });
  assert.equal(forward.statusCode, 201, forward.body);
  const summary = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') })).json().conversations.find((c: { id: string }) => c.id === 'dm').lastMessage;
  assert.equal(summary.attachmentKind, 'voice'); assert.equal(summary.attachmentDurationMs, 42000);
  const oldList = await app.inject({ method: 'GET', url: '/dm', headers: authHeader('b') });
  assert.equal(oldList.statusCode, 200);
  const oldMessages = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('b') });
  assert.equal(oldMessages.statusCode, 200);
  assert.equal(Object.hasOwn(oldMessages.json()[0], 'forwardedFrom'), false);
});

test('цитата отдаёт viewer-specific thumb, старую текстовую форму, tombstone, отложенный и канальный виды', async () => {
  // Причина: новая цитата должна подписывать фото каждому смотрящему, но не расширять пустую и удалённую цитату.
  const photoId = '12345678-1234-4234-8234-000000000901';
  await t.raw.exec(`INSERT INTO conversation_messages (id,conversation_id,author_id,content,attachments,sort_key,deleted_at) VALUES
    ('quote-photo','dm','a','photo','[{"id":"${photoId}","name":"p.png","contentType":"image/png","size":1}]',30001,NULL),
    ('quote-plain','dm','a','plain','[]',30002,NULL),
    ('quote-deleted','dm','a','secret','[]',30003,now()),
    ('quote-photo-child','dm','b','photo reply','[]',30004,NULL),
    ('quote-plain-child','dm','b','plain reply','[]',30005,NULL),
    ('quote-deleted-child','dm','b','deleted reply','[]',30006,NULL);
    UPDATE conversation_messages SET reply_to_id='quote-photo' WHERE id='quote-photo-child';
    UPDATE conversation_messages SET reply_to_id='quote-plain' WHERE id='quote-plain-child';
    UPDATE conversation_messages SET reply_to_id='quote-deleted' WHERE id='quote-deleted-child';
    INSERT INTO attachments (id,conversation_id,owner_id,message_id,storage_key,name,content_type,size,state)
      VALUES ('${photoId}','dm','a','quote-photo','dm/${photoId}','p.png','image/png',1,'attached');
    INSERT INTO messages (id,channel_id,author_id,content,attachments) VALUES
      ('channel-quote-photo','ch','a','channel photo','[{"name":"c.png","contentType":"image/png","size":1,"url":"https://api.example.test/c.png"}]');`);

  await t.raw.exec(`INSERT INTO conversation_messages (id,conversation_id,author_id,content,attachments,sort_key)
    VALUES ('quote-fragment-parent','dm','b','текст — выбранный фрагмент — конец','[]',30007)`);
  const historyA = (await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader('a') })).json().messages;
  const historyB = (await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader('b') })).json().messages;
  const photoA = historyA.find((m: { id: string }) => m.id === 'quote-photo-child').replyTo;
  const photoB = historyB.find((m: { id: string }) => m.id === 'quote-photo-child').replyTo;
  assert.equal(photoA.attachmentKind, 'photo');
  assert.equal(photoA.attachments, 1);
  assert.equal(typeof photoA.thumb, 'string');
  assert.notEqual(photoA.thumb, photoB.thumb, 'ссылка должна быть подписана отдельно для каждого смотрящего');
  assert.deepEqual(Object.keys(historyA.find((m: { id: string }) => m.id === 'quote-plain-child').replyTo).sort(), ['authorName', 'content', 'id']);
  const deleted = historyA.find((m: { id: string }) => m.id === 'quote-deleted-child').replyTo;
  assert.equal(deleted.deleted, true);
  assert.equal(Object.hasOwn(deleted, 'attachments'), false);
  assert.equal(Object.hasOwn(deleted, 'thumb'), false);

  const scheduled = await app.inject({ method: 'POST', url: '/conv/dm/scheduled', headers: authHeader('a'), payload: {
    clientId: '00000000-0000-4000-8000-000000000902', content: 'later', whenOnline: true, replyToId: 'quote-photo',
  } });
  assert.equal(scheduled.statusCode, 201, scheduled.body);
  const later = await app.inject({ method: 'GET', url: '/conv/dm/scheduled', headers: authHeader('a') });
  assert.equal(later.statusCode, 200, later.body);
  assert.equal(later.json().items[0].replyTo.attachmentKind, 'photo');
  assert.equal(later.json().items[0].replyTo.attachments, 1);

  const channelReply = await app.inject({ method: 'POST', url: '/channels/ch/messages', headers: authHeader('b'), payload: {
    content: 'reply', replyToId: 'channel-quote-photo',
  } });
  assert.equal(channelReply.statusCode, 201, channelReply.body);
  assert.equal(channelReply.json().replyTo.attachments, 1);
  assert.equal(channelReply.json().replyTo.attachmentKind, 'photo');
  assert.equal(Object.hasOwn(channelReply.json().replyTo, 'thumb'), false, 'превью канала показывает вид/count, не URL закрытого файла');

  const fragment = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: {
    clientId: '00000000-0000-4000-8000-000000000903', content: 'ответ с цитатой', attachments: [],
    replyToId: 'quote-fragment-parent', replyQuote: { text: 'выбранный фрагмент', offset: 8 },
  } });
  assert.equal(fragment.statusCode, 201, fragment.body);
  assert.equal(fragment.json().replyTo.quote, 'выбранный фрагмент');
  assert.equal(fragment.json().replyTo.quoteOffset, 8);
  const storedQuote = await t.raw.query<{ reply_quote: { text: string; offset: number } }>(
    `SELECT reply_quote FROM conversation_messages WHERE id='${fragment.json().id}'`,
  );
  assert.deepEqual(storedQuote.rows[0]?.reply_quote, { text: 'выбранный фрагмент', offset: 8 });
  const falseQuote = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: {
    clientId: '00000000-0000-4000-8000-000000000904', content: 'невалидная цитата', attachments: [],
    replyToId: 'quote-fragment-parent', replyQuote: { text: 'этого фрагмента нет' },
  } });
  assert.equal(falseQuote.statusCode, 400, 'пара к допустимой цитате: несуществующий фрагмент отклоняется');
});

async function seedForwardFile(id = '12345678-1234-4234-8234-000000000201') {
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, attachments) VALUES
    ('mut-source', 'foreign-dm', 'c', 'with file', '[{"id":"${id}","name":"f","contentType":"application/octet-stream","size":1}]');
    INSERT INTO attachments (id, conversation_id, owner_id, message_id, storage_key, name, content_type, size, state)
      VALUES ('${id}', 'foreign-dm', 'c', 'mut-source', 'dm/${id}', 'f', 'application/octet-stream', 1, 'attached')`);
}

function attachmentStore(copy: (from: string, to: string) => Promise<void>): import('../src/attachments.js').AttachmentStore {
  return { ready: () => true, ensureReady: async () => true, configured: () => true, put: async () => {},
    stat: async () => ({ size: 1 }), get: async () => Readable.from(Buffer.from('x')), remove: async () => {}, copy };
}

test('мутант раннего replay красит интеграционный сценарий: файлы не копируются при повторе', async () => {
  // Ловит возврат идемпотентности после дорогой работы: повтор не должен обращаться к закрытому хранилищу.
  await seedForwardFile();
  let copies = 0;
  setAttachmentStoreForTests(attachmentStore(async () => { copies++; }));
  try {
    const original = await import('../src/conversations.js');
    const access = await original.loadAccess('dm', 'a'); assert.ok(access);
    const input = { clientId: '00000000-0000-4000-8000-000000000801', fromConversationId: 'foreign-dm', messageIds: ['mut-source'], withheld: false };
    assert.equal((await original.forwardMessages('a', access, input)).kind, 'created');
    const before = copies;
    assert.equal((await original.forwardMessages('a', access, input)).kind, 'replay');
    assert.equal(copies, before, 'штатный повтор не копирует файлы повторно');
    const mutant = await mutantConversations((s) => s.replace('const early = decide(await already(db));\n  if (early) return early;', 'const early = null;\n  if (early) return early;'));
    await mutant.forwardMessages('a', access, input);
    assert.throws(() => assert.equal(copies, before), assert.AssertionError);
  } finally { setAttachmentStoreForTests(null); }
});

test('мутант фильтра видимости красит пересылку скрытого сообщения', async () => {
  // Ловит копирование строки, которую отправитель уже удалил у себя или не мог видеть.
  await t.raw.exec("INSERT INTO conversation_messages (id, conversation_id, author_id, content, hidden_for) VALUES ('mut-hidden', 'foreign-dm', 'c', 'secret', ARRAY['a'])");
  const original = await import('../src/conversations.js');
  const access = await original.loadAccess('dm', 'a'); assert.ok(access);
  const input = { clientId: '00000000-0000-4000-8000-000000000802', fromConversationId: 'foreign-dm', messageIds: ['mut-hidden'], withheld: false };
  assert.equal((await original.forwardMessages('a', access, input)).kind, 'source-missing');
  const mutant = await mutantConversations((s) => s.replace("found.filter((m) => messageView(m, me) === 'full')", 'found'));
  const wrong = await mutant.forwardMessages('a', access, input);
  assert.throws(() => assert.equal(wrong.kind, 'source-missing'), assert.AssertionError);
});

test('мутант атомарного запрета пачки красит удаление своего перед чужим', async () => {
  // Ловит частичную фиксацию личного скрытия, если в batch есть чужое видимое сообщение.
  await t.raw.exec(`INSERT INTO conversations (id, kind, created_by) VALUES ('mut-group', 'group', 'a');
    INSERT INTO conversation_members (conversation_id, user_id) VALUES ('mut-group','a'),('mut-group','c');
    INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES
    ('mut-own', 'mut-group', 'a', 'mine'), ('mut-peer', 'mut-group', 'c', 'theirs')`);
  const original = await import('../src/conversations.js');
  const access = await original.loadAccess('mut-group', 'a'); assert.ok(access);
  const baseline = await original.deleteMessages('a', access, ['mut-own', 'mut-peer'], 'both');
  assert.equal(baseline.kind, 'forbidden');
  const mutant = await mutantConversations((s) => s.replace(
    "const forbidden = plan.filter((p) => p.action === 'forbidden').map((p) => p.id);",
    'const forbidden: string[] = [];',
  ));
  const wrong = await mutant.deleteMessages('a', access, ['mut-own', 'mut-peer'], 'both');
  assert.throws(() => assert.equal(wrong.kind, 'forbidden'), assert.AssertionError);
});

test('мутант разрешённой правки пересланного красит запрет редактирования', async () => {
  // Ловит подмену смысловой цитаты: пересылка — новый авторский snapshot, не исходный черновик.
  await t.raw.exec("INSERT INTO conversation_messages (id, conversation_id, author_id, content, forwarded_from) VALUES ('mut-forwarded', 'dm', 'a', 'copy', '{\"userId\":\"c\",\"displayName\":\"Charlie\",\"at\":\"2026-01-01T00:00:00.000Z\"}')");
  const original = await import('../src/conversations.js');
  const access = await original.loadAccess('dm', 'a'); assert.ok(access);
  assert.equal((await original.editMessage('a', access, 'mut-forwarded', 'changed')).kind, 'forbidden');
  const mutant = await mutantConversations((s) => s.replace('if (m.forwardedFrom) return { kind: \'forbidden\' };', ''));
  const wrong = await mutant.editMessage('a', access, 'mut-forwarded', 'changed');
  assert.throws(() => assert.equal(wrong.kind, 'forbidden'), assert.AssertionError);
});

test('HTTP правка пересланного запрещена в conv и dm, обычная авторская правка принимается', async () => {
  // Ловит регрессию маршрутизации, если одна проекция обходит общий запрет editMessage.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, forwarded_from) VALUES
    ('http-forwarded', 'dm', 'a', 'snapshot', '{"userId":"c","displayName":"Charlie","at":"2026-01-01T00:00:00.000Z"}'),
    ('http-normal', 'dm', 'a', 'editable', null)`);
  for (const url of ['/conv/dm/messages/http-forwarded', '/dm/dm/messages/http-forwarded']) {
    const rejected = await app.inject({ method: 'PATCH', url, headers: authHeader('a'), payload: { content: 'tampered' } });
    assert.equal(rejected.statusCode, 403);
  }
  const ordinary = await app.inject({ method: 'PATCH', url: '/conv/dm/messages/http-normal', headers: authHeader('a'), payload: { content: 'updated' } });
  assert.equal(ordinary.statusCode, 200, ordinary.body);
  assert.equal(ordinary.json().content, 'updated');
});

test('мутант ссылки на оригинал красит проверку изоляции копии', async () => {
  // Ловит повторное использование id оригинального файла вместо отдельной строки и права получателя.
  const sourceId = '12345678-1234-4234-8234-000000000202';
  await seedForwardFile(sourceId);
  setAttachmentStoreForTests(attachmentStore(async () => {}));
  try {
    const original = await import('../src/conversations.js');
    const access = await original.loadAccess('dm', 'a'); assert.ok(access);
    const input = { clientId: '00000000-0000-4000-8000-000000000803', fromConversationId: 'foreign-dm', messageIds: ['mut-source'], withheld: false };
    const base = await original.forwardMessages('a', access, input);
    assert.equal(base.kind, 'created');
    if (base.kind !== 'created') return;
    assert.notEqual(base.rows[0].attachments[0]?.id, sourceId);
    const realAttachments = await import('../src/attachments.js');
    const mutantAttachments = { ...realAttachments, copyForForward: async (input: { sources: { id: string }[] }) => {
      const rows = await realAttachments.attachmentsByIds(input.sources.map((source) => source.id));
      return new Map(rows.map((row) => [row.id, row]));
    } };
    const mutant = await mutantConversations((s) => s.replace('const copy = copies.get(a.id);', 'const copy = copies.get(a.id); // copyForForward mutant injected below'), undefined, { './attachments.js': mutantAttachments });
    const wrong = await mutant.forwardMessages('a', access, { ...input, clientId: '00000000-0000-4000-8000-000000000806' });
    assert.throws(() => assert.equal(wrong.kind, 'created'), assert.AssertionError);
  } finally { setAttachmentStoreForTests(null); }
});

test('мутант created на каждом сообщении красит одиночный признак пачки', async () => {
  // Ловит тройной звук/тост для одной пересылки вместо одного события последнего элемента.
  await t.raw.exec("INSERT INTO conversation_messages (id, conversation_id, author_id, content, sort_key) VALUES ('mut-one', 'foreign-dm', 'c', '1', 11001), ('mut-two', 'foreign-dm', 'c', '2', 11002)");
  const original = await import('../src/conversations.js');
  const access = await original.loadAccess('dm', 'a'); assert.ok(access);
  const input = { clientId: '00000000-0000-4000-8000-000000000804', fromConversationId: 'foreign-dm', messageIds: ['mut-one', 'mut-two'], withheld: false };
  const base = await original.forwardMessages('a', access, input);
  assert.equal(base.kind, 'created');
  if (base.kind !== 'created') return;
  assert.equal(base.deliveries.filter((d) => d.created).length, 1);
  const mutant = await mutantConversations((s) => s.replace(
    'deliveries[deliveries.length - 1].created = true;',
    'for (const delivery of deliveries) delivery.created = true;',
  ));
  const wrong = await mutant.forwardMessages('a', access, { ...input, clientId: '00000000-0000-4000-8000-000000000805' });
  assert.equal(wrong.kind, 'created');
  if (wrong.kind !== 'created') return;
  assert.throws(() => assert.equal(wrong.deliveries.filter((d) => d.created).length, 1), assert.AssertionError);
});

test('хранилище без copy пересылает чтением и записью те же байты', async () => {
  // Ловит зависимость необязательного S3 CopyObject от каждой реализации AttachmentStore.
  const id = '12345678-1234-4234-8234-000000000301';
  const files = new Map<string, Buffer>([[`dm/${id}`, Buffer.from([0, 1, 2, 255])]]);
  const reads: string[] = []; const writes: string[] = [];
  setAttachmentStoreForTests({ ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async (key, bytes) => { writes.push(key); files.set(key, Buffer.from(bytes)); },
    stat: async (key) => files.has(key) ? { size: files.get(key)!.length } : null,
    get: async (key) => { reads.push(key); return Readable.from(files.get(key) ?? []); },
    remove: async (key) => { files.delete(key); } });
  try {
    await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, attachments) VALUES
      ('fallback-source', 'foreign-dm', 'c', '', '[{"id":"${id}","name":"bytes.bin","contentType":"application/octet-stream","size":4}]');
      INSERT INTO attachments (id, conversation_id, owner_id, message_id, storage_key, name, content_type, size, state)
      VALUES ('${id}', 'foreign-dm', 'c', 'fallback-source', 'dm/${id}', 'bytes.bin', 'application/octet-stream', 4, 'attached')`);
    const res = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: {
      clientId: '00000000-0000-4000-8000-000000000901', fromConversationId: 'foreign-dm', messageIds: ['fallback-source'],
    } });
    assert.equal(res.statusCode, 201, res.body);
    const copiedKey = `dm/${res.json().messages[0].attachments[0].id}`;
    assert.deepEqual(reads, [`dm/${id}`]); assert.deepEqual(writes, [copiedKey]);
    assert.deepEqual(files.get(copiedKey), Buffer.from([0, 1, 2, 255]));
  } finally { setAttachmentStoreForTests(null); }
});

test('пересылка расходует общий send и отдельный conv-forward лимиты по одному разу на запрос', async () => {
  // Ловит пачку N сообщений, обходящую оба бюджета пакетной отправки и расходов на хранение.
  await t.raw.exec("INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('rate-source', 'foreign-dm', 'c', 'x')");
  await t.raw.exec("INSERT INTO push_devices (id, user_id, device_id, endpoint, platform) VALUES ('rate-push', 'b', 'phone', 'https://ntfy.example.test/rate', 'android')");
  posted.length = 0;
  const incr = redisPub.incr;
  const hits: string[] = [];
  redisPub.incr = (async (key: string) => { hits.push(key); return 1; }) as typeof redisPub.incr;
  try {
    const payload = { clientId: '00000000-0000-4000-8000-000000000902', fromConversationId: 'foreign-dm', messageIds: ['rate-source'] };
    assert.equal((await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload })).statusCode, 201);
    assert.equal((await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload })).statusCode, 200);
    for (let i = 0; i < 10 && posted.length === 0; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(posted.length, 1);
    assert.equal(JSON.parse(String(posted[0].init.body)).body, '↪ x');
    assert.equal(hits.filter((key) => key === 'rl:send:a').length, 2);
    assert.equal(hits.filter((key) => key === 'rl:conv-forward:a').length, 2);
  } finally { redisPub.incr = incr; }
});

test('получатель заблокировал отправителя: вся пересылка придержана и не видна получателю', async () => {
  // Ловит раскрытие активности блокировщика через историю, время беседы, события или push.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('held-forward-src', 'foreign-dm', 'c', 'secret');
    INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('b', 'a');
    INSERT INTO push_devices (id, user_id, device_id, endpoint, platform) VALUES ('held-push', 'b', 'phone', 'https://ntfy.example.test/held', 'android');`);
  const before = await t.raw.query<{ last_message_at: Date }>("SELECT last_message_at FROM conversations WHERE id='dm'");
  published.length = 0; posted.length = 0;
  const res = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: {
    clientId: '00000000-0000-4000-8000-000000000903', fromConversationId: 'foreign-dm', messageIds: ['held-forward-src'],
  } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader('b') })).json().messages.length, 0);
  assert.equal((await t.raw.query<{ last_message_at: Date }>("SELECT last_message_at FROM conversations WHERE id='dm'")).rows[0]?.last_message_at.toISOString(), before.rows[0]?.last_message_at.toISOString());
  assert.equal(published.some((p) => p.channel === 'gw:user:b'), false);
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(posted.length, 0);
  assert.ok(published.some((p) => p.channel === 'gw:user:a' && JSON.parse(p.message).m.t === 'conv.change'));
});

async function c2Snapshot() {
  return {
    pins: (await t.raw.query(`SELECT * FROM conversation_pins ORDER BY conversation_id, user_id, message_id`)).rows,
    journal: (await t.raw.query(`SELECT * FROM user_changes ORDER BY user_id, pts`)).rows,
    cursors: (await t.raw.query(`SELECT * FROM user_sync ORDER BY user_id`)).rows,
    events: [...published],
  };
}

async function c2Put(id: string, user = 'a', scope = 'both', conv = 'dm') {
  const res = await app.inject({ method: 'PUT', url: `/conv/${conv}/messages/${id}/pin`, headers: authHeader(user), payload: { for: scope } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

async function c2List(user = 'a', conv = 'dm') {
  const res = await app.inject({ method: 'GET', url: `/conv/${conv}/pins`, headers: authHeader(user) });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

test('С2 закрепляет для себя и для обоих, а forBoth принадлежит каждой строке и открепление имеет свой scope', async () => {
  // Ловит утечку личного закрепа, потерю повышения до общего и снятие чужого личного закрепа.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES
    ('pin-me', 'dm', 'a', 'личное'), ('pin-both', 'dm', 'a', 'общее'), ('pin-peer-only', 'dm', 'b', 'личное собеседника')`);
  const me = await app.inject({ method: 'PUT', url: '/conv/dm/messages/pin-me/pin', headers: authHeader('a'), payload: { for: 'me' } });
  assert.equal(me.statusCode, 200, me.body); assert.equal(me.json().pins.length, 1); assert.equal(me.json().pins[0].forBoth, false);
  assert.deepEqual((await c2List('b')).pins, [], 'личный закреп не появляется у собеседника');
  await c2Put('pin-me', 'b', 'me');
  const both = await app.inject({ method: 'PUT', url: '/conv/dm/messages/pin-me/pin', headers: authHeader('a'), payload: { for: 'both' } });
  assert.equal(both.statusCode, 200, both.body);
  const lists = await Promise.all(['a', 'b'].map((id) => app.inject({ method: 'GET', url: '/conv/dm/pins', headers: authHeader(id) })));
  assert.deepEqual(lists.map((r) => r.json().pins.map((p: { message: { id: string }; forBoth: boolean }) => [p.message.id, p.forBoth])),
    [[['pin-me', true]], [['pin-me', true]]]);
  await app.inject({ method: 'PUT', url: '/conv/dm/messages/pin-peer-only/pin', headers: authHeader('b'), payload: { for: 'me' } });
  assert.equal((await app.inject({ method: 'DELETE', url: '/conv/dm/messages/pin-peer-only/pin?for=both', headers: authHeader('a') })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/conv/dm/pins', headers: authHeader('b') })).json().pins.length, 2,
    'чужое личное закрепление нельзя снять даже scope=both');
  await app.inject({ method: 'DELETE', url: '/conv/dm/messages/pin-me/pin?for=me', headers: authHeader('a') });
  assert.equal((await app.inject({ method: 'GET', url: '/conv/dm/pins', headers: authHeader('b') })).json().pins.length, 2,
    'for=me снимает мою строку и не трогает строку собеседника');
  assert.equal((await c2List('b')).pins.find((p: { message: { id: string } }) => p.message.id === 'pin-me').forBoth, true,
    'forBoth моей строки не выводится из существования строки собеседника');
  await app.inject({ method: 'DELETE', url: '/conv/dm/messages/pin-me/pin?for=both', headers: authHeader('a') });
  assert.equal((await app.inject({ method: 'GET', url: '/conv/dm/pins', headers: authHeader('b') })).json().pins.length, 1);
});

test('С2 предел 50 включителен, 51-й атомарно отклонён, полный список собеседника пропускается', async () => {
  // Ловит ошибку на единицу, частичную запись при отказе и раскрытие чужого полного списка.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content)
    SELECT 'limit-' || i, 'dm', 'a', i::text FROM generate_series(1, 51) i;
    INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('peer-full-skip', 'dm', 'a', 'peer full');
    INSERT INTO conversation_pins (conversation_id, user_id, message_id, pinned_by, for_both)
    SELECT 'dm', 'b', 'limit-' || i, 'b', false FROM generate_series(1, 50) i;`);
  for (let i = 1; i <= 50; i++) {
    const r = await app.inject({ method: 'PUT', url: `/conv/dm/messages/limit-${i}/pin`, headers: authHeader('a'), payload: { for: 'me' } });
    assert.equal(r.statusCode, 200, r.body);
  }
  await c2Put('limit-1');
  assert.equal((await c2List()).pins.find((p: { message: { id: string } }) => p.message.id === 'limit-1').forBoth, true,
    'при полном списке существующий закреп ещё можно сделать общим');
  const beforeFail = await c2Snapshot();
  const fail = await app.inject({ method: 'PUT', url: '/conv/dm/messages/limit-51/pin', headers: authHeader('a'), payload: { for: 'both' } });
  assert.equal(fail.statusCode, 409); assert.deepEqual(fail.json(), { error: 'pin limit', max: 50 });
  assert.deepEqual(await c2Snapshot(), beforeFail, '409 сохраняет строки, журнал, курсоры и события целиком');
  assert.equal((await t.raw.query<{ n: number }>("SELECT count(*)::int n FROM conversation_pins WHERE conversation_id='dm'")).rows[0]?.n, 100,
    'отказ не добавляет закреп ни мне, ни собеседнику');
  const aList = await app.inject({ method: 'GET', url: '/conv/dm/pins', headers: authHeader('a') });
  assert.equal(aList.json().pins.length, 50);
  await app.inject({ method: 'DELETE', url: '/conv/dm/messages/limit-1/pin?for=me', headers: authHeader('a') });
  const peerFullSkip = await app.inject({ method: 'PUT', url: '/conv/dm/messages/peer-full-skip/pin', headers: authHeader('a'), payload: { for: 'both' } });
  assert.equal(peerFullSkip.statusCode, 200, peerFullSkip.body);
  assert.equal((await app.inject({ method: 'GET', url: '/conv/dm/pins', headers: authHeader('b') })).json().pins.length, 50,
    'полная чужая полка молча пропускается, успех не раскрывает её лимит');
});

test('С2 pin принимает только видимое сообщение; own withheld только лично, чужое held не раскрывается при блокировке', async () => {
  // Ловит закреп невидимого сообщения и раскрытие придержанного текста собеседнику.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, hidden_for, withheld, deleted_at) VALUES
    ('hidden-pin', 'dm', 'a', 'x', ARRAY['a'], false, null), ('held-pin', 'dm', 'b', 'x', ARRAY[]::text[], true, null),
    ('deleted-pin', 'dm', 'b', 'x', ARRAY[]::text[], false, now()), ('own-held-pin', 'dm', 'a', 'x', ARRAY[]::text[], true, null);
    INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('b', 'a');`);
  for (const id of ['hidden-pin', 'held-pin', 'deleted-pin']) {
    const r = await app.inject({ method: 'PUT', url: `/conv/dm/messages/${id}/pin`, headers: authHeader('a'), payload: { for: 'both' } });
    assert.equal(r.statusCode, 404, `${id}: ${r.body}`);
  }
  const own = await app.inject({ method: 'PUT', url: '/conv/dm/messages/own-held-pin/pin', headers: authHeader('a'), payload: { for: 'both' } });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal((await app.inject({ method: 'GET', url: '/conv/dm/pins', headers: authHeader('b') })).json().pins.length, 0);
  assert.equal(published.some((p) => p.channel === 'gw:user:b' && JSON.parse(p.message).m.t === 'conv.change'), false,
    'закреп заблокировавшему не доставляется');
  const foreign = await app.inject({ method: 'PUT', url: '/conv/foreign-dm/messages/own-held-pin/pin', headers: authHeader('a'), payload: { for: 'me' } });
  assert.equal(foreign.statusCode, 404);
});

test('С2 pin change содержит полный список без message и догонка — только изменённые беседы', async () => {
  // Ловит неверного адресата журнала, чужой pts и расширение догонки на незатронутые списки.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('journal-pin', 'dm', 'a', 'snapshot');`);
  const r = await app.inject({ method: 'PUT', url: '/conv/dm/messages/journal-pin/pin', headers: authHeader('a'), payload: { for: 'both' } });
  assert.equal(r.statusCode, 200, r.body);
  const pinEvents = published.map((p) => ({ user: p.channel, m: JSON.parse(p.message).m }))
    .filter(({ m }) => m.t === 'conv.change' && Array.isArray(m.pins));
  assert.deepEqual(pinEvents.map(({ user }) => user).sort(), ['gw:user:a', 'gw:user:b']);
  for (const { m } of pinEvents) { assert.equal(m.message, undefined); assert.equal(m.pins.length, 1); assert.equal(m.pins[0].message.id, 'journal-pin'); }
  const journal = await t.raw.query<{ user_id: string; pts: number; kind: string; message_id: string | null }>(
    "SELECT user_id, pts, kind, message_id FROM user_changes WHERE conversation_id='dm' AND kind='pin' ORDER BY user_id");
  assert.deepEqual(journal.rows.map((row) => [row.user_id, row.kind, row.message_id]), [['a', 'pin', null], ['b', 'pin', null]]);
  for (const row of journal.rows) {
    const event = pinEvents.find(({ user }) => user === `gw:user:${row.user_id}`)?.m;
    assert.equal(event?.pts, row.pts, 'событие каждого получателя несёт pts собственной строки журнала');
  }
  const sync = await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('a') });
  assert.equal(sync.statusCode, 200, sync.body);
  assert.ok(sync.json().pins.some((entry: { conversationId: string }) => entry.conversationId === 'dm'), 'догонка включает затронутую беседу');
  assert.equal(sync.json().pins.some((entry: { conversationId: string }) => entry.conversationId === 'foreign-dm'), false,
    'догонка не включает беседу без изменения списка');
  assert.equal((await app.inject({ method: 'GET', url: '/conv/foreign-dm/pins', headers: authHeader('b') })).statusCode, 404,
    'неучастнику нельзя читать список закрепов');
});

test('С2 правка меняет закреплённое превью, скрытое открепление молчит, удаление удаляет строки у нужных людей', async () => {
  // Ловит устаревшее превью, изменение невидимого закрепа и остаточные строки после надгробия.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES
    ('edit-pin', 'dm', 'a', 'before'), ('hide-unpin', 'dm', 'a', 'hidden');`);
  await app.inject({ method: 'PUT', url: '/conv/dm/messages/edit-pin/pin', headers: authHeader('a'), payload: { for: 'both' } });
  const edit = await app.inject({ method: 'PATCH', url: '/conv/dm/messages/edit-pin', headers: authHeader('a'), payload: { content: 'after' } });
  assert.equal(edit.statusCode, 200, edit.body);
  assert.equal((await app.inject({ method: 'GET', url: '/conv/dm/pins', headers: authHeader('b') })).json().pins[0].message.text, 'after');
  await app.inject({ method: 'PUT', url: '/conv/dm/messages/hide-unpin/pin', headers: authHeader('a'), payload: { for: 'me' } });
  await t.raw.exec("UPDATE conversation_messages SET hidden_for = ARRAY['a'] WHERE id='hide-unpin'");
  const hiddenPinRows = await t.raw.query<{ n: number }>("SELECT count(*)::int n FROM conversation_pins WHERE message_id='hide-unpin'");
  const hidden = await app.inject({ method: 'DELETE', url: '/conv/dm/messages/hide-unpin/pin?for=both', headers: authHeader('a') });
  assert.equal(hidden.statusCode, 200, hidden.body);
  assert.equal((await t.raw.query<{ n: number }>("SELECT count(*)::int n FROM conversation_pins WHERE message_id='hide-unpin'")).rows[0]?.n, hiddenPinRows.rows[0]?.n,
    'невидимое сообщение не даёт unpin изменить закреплённое');
  const pinEventCount = published.filter((p) => JSON.parse(p.message).m.t === 'conv.change' && JSON.parse(p.message).m.pins).length;
  const deleted = await app.inject({ method: 'DELETE', url: '/conv/dm/messages/edit-pin?for=both', headers: authHeader('a') });
  assert.equal(deleted.statusCode, 204, deleted.body);
  assert.equal((await t.raw.query<{ n: number }>("SELECT count(*)::int n FROM conversation_pins WHERE message_id='edit-pin'")).rows[0]?.n, 0);
  assert.ok(published.filter((p) => JSON.parse(p.message).m.t === 'conv.change' && JSON.parse(p.message).m.pins).length > pinEventCount,
    'удаление закреплённого сообщения порождает синхронизацию списка после tombstone');
});

test('С2 удаление у себя одиночно и старой ручкой снимает только мои закрепы, пачка у обоих снимает строки обоих', async () => {
  // Ловит расхождение нового, пачечного и legacy-удаления по владельцу закрепа.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES
    ('delete-own-one', 'dm', 'a', 'one'), ('delete-own-legacy', 'dm', 'a', 'two'), ('delete-both-batch', 'dm', 'a', 'three');`);
  for (const id of ['delete-own-one', 'delete-own-legacy', 'delete-both-batch']) {
    const r = await app.inject({ method: 'PUT', url: `/conv/dm/messages/${id}/pin`, headers: authHeader('a'), payload: { for: 'both' } });
    assert.equal(r.statusCode, 200, r.body);
  }
  assert.equal((await app.inject({ method: 'DELETE', url: '/conv/dm/messages/delete-own-one?for=me', headers: authHeader('a') })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: '/conv/dm/pins', headers: authHeader('b') })).json().pins.length, 3,
    'удаление у себя сохраняет закреп собеседника');
  assert.equal((await app.inject({ method: 'DELETE', url: '/dm/dm/messages/delete-own-legacy?for=me', headers: authHeader('a') })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: '/conv/dm/pins', headers: authHeader('b') })).json().pins.length, 3,
    'legacy DELETE у себя тоже не меняет peer pins');
  const batch = await app.inject({ method: 'POST', url: '/conv/dm/messages/delete', headers: authHeader('a'), payload: { ids: ['delete-both-batch'], for: 'both' } });
  assert.equal(batch.statusCode, 204, batch.body);
  assert.equal((await t.raw.query<{ n: number }>("SELECT count(*)::int n FROM conversation_pins WHERE message_id='delete-both-batch'")).rows[0]?.n, 0,
    'batch delete у обоих удаляет строки закрепа обоих участников');
});

test('С2 повтор pin/unpin не журналируется, блокировщик не получает ни добавления, ни удаления общего закрепа', async () => {
  // Ловит лишние события на повторе и доставку закрепа заблокировавшему участнику.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('blocked-pin', 'dm', 'a', 'x');
    INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('b', 'a');`);
  const put = () => app.inject({ method: 'PUT', url: '/conv/dm/messages/blocked-pin/pin', headers: authHeader('a'), payload: { for: 'both' } });
  const first = await put(); assert.equal(first.statusCode, 200, first.body);
  const eventCount = published.length;
  const journalCount = async () => (await t.raw.query<{ n: number }>("SELECT count(*)::int n FROM user_changes WHERE conversation_id='dm' AND kind='pin'")).rows[0]?.n;
  const pinsJournal = await journalCount();
  const again = await put(); assert.equal(again.statusCode, 200, again.body);
  assert.equal(published.length, eventCount, 'повтор закрепления ничего не рассылает');
  assert.equal(await journalCount(), pinsJournal, 'повтор закрепления не добавляет journal row');
  const unpin = await app.inject({ method: 'DELETE', url: '/conv/dm/messages/blocked-pin/pin?for=both', headers: authHeader('a') });
  assert.equal(unpin.statusCode, 200, unpin.body);
  const beforeRepeat = await c2Snapshot();
  assert.equal((await app.inject({ method: 'DELETE', url: '/conv/dm/messages/blocked-pin/pin?for=both', headers: authHeader('a') })).statusCode, 200);
  assert.deepEqual(await c2Snapshot(), beforeRepeat, 'повтор открепления не пишет журнал и не шлёт события');
  assert.equal((await t.raw.query<{ n: number }>("SELECT count(*)::int n FROM conversation_pins WHERE message_id='blocked-pin'")).rows[0]?.n, 0);
  assert.equal(published.some((p) => p.channel === 'gw:user:b' && JSON.parse(p.message).m.t === 'conv.change'), false,
    'действие заблокированного не раскрывается блокировщику');
});

test('С2 превью закрепов идёт по ленте, сохраняет голос и файл, миниатюра подписана смотрящему', async () => {
  // Ловит сортировку по времени закрепления, потерю метаданных вложения и ссылку с чужим поколением токена.
  const photo = '00000000-0000-4000-8000-000000007701';
  await t.raw.exec(`UPDATE users SET token_generation=7 WHERE id='b';
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, sort_key, attachments) VALUES
      ('p-plain', 'dm', 'a', E'one\\n two', 61001, '[]'),
      ('p-photo', 'dm', 'a', '', 61002, '[{"id":"${photo}","contentType":"image/png","name":"a.png","size":10}]'),
      ('p-voice', 'dm', 'a', '', 61003, '[{"contentType":"audio/ogg","waveform":[0.1,0.2],"durationMs":42000,"name":"note.ogg"}]'),
      ('p-file', 'dm', 'a', '', 61004, '[{"contentType":"application/pdf","name":"a.pdf"}]'),
      ('p-old-photo', 'dm', 'a', '', 61005, '[{"contentType":"image/png","url":"https://example.test/old.png"}]');`);
  forgetTokenGeneration('b');
  testTokenGenerations.set('b', 7);
  for (const id of ['p-old-photo', 'p-file', 'p-voice', 'p-photo', 'p-plain']) await c2Put(id);
  await t.raw.exec(`UPDATE conversation_pins SET pinned_at='2026-01-01T00:00:00Z' WHERE message_id='p-old-photo';
    UPDATE conversation_pins SET pinned_at='2026-02-01T00:00:00Z' WHERE message_id='p-plain'`);
  const mine = (await c2List()).pins;
  const peer = (await c2List('b')).pins;
  assert.deepEqual(peer.map((p: { message: { id: string } }) => p.message.id), ['p-plain', 'p-photo', 'p-voice', 'p-file', 'p-old-photo']);
  assert.equal(peer[0].message.text, 'one two');
  assert.equal(Object.hasOwn(peer[0].message, 'attachmentKind'), false);
  assert.equal(Object.hasOwn(peer[0], 'thumb'), false);
  assert.equal(peer[1].message.attachmentKind, 'photo');
  assert.equal(peer[1].thumb, attachmentLink(photo, 'b', 7));
  assert.equal(mine[1].thumb, attachmentLink(photo, 'a', 0));
  assert.notEqual(peer[1].thumb, mine[1].thumb);
  assert.equal(peer[2].message.attachmentKind, 'voice');
  assert.equal(peer[2].message.attachmentDurationMs, 42000);
  assert.equal(Object.hasOwn(peer[2], 'thumb'), false);
  assert.equal(peer[3].message.attachmentKind, 'file');
  assert.equal(peer[3].message.attachmentName, 'a.pdf');
  assert.equal(peer[4].thumb, 'https://example.test/old.png');
  assert.equal(peer[0].pinnedBy, 'a');
  assert.equal(peer[0].pinnedAt, '2026-02-01T00:00:00.000Z');
  assert.equal(peer[0].message.sortKey, 61001);
  assert.equal(peer[0].message.attachments, 0);
});

test('С2 блокировка защищает существующий общий закреп, разблокировка не воспроизводит пропущенное действие', async () => {
  // Ловит снятие чужой строки вопреки блокировке и появление пропущенного закрепа задним числом.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES
    ('existing-pin', 'dm', 'a', 'old'), ('missed-pin', 'dm', 'a', 'new');`);
  await c2Put('existing-pin');
  await t.raw.exec(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('b','a')`);
  published.length = 0;
  const peerBefore = (await t.raw.query(`SELECT * FROM conversation_pins WHERE user_id='b' ORDER BY message_id`)).rows;
  const peerPts = (await t.raw.query(`SELECT pts FROM user_sync WHERE user_id='b'`)).rows;
  await c2Put('missed-pin');
  const unpin = await app.inject({ method: 'DELETE', url: '/conv/dm/messages/existing-pin/pin?for=both', headers: authHeader('a') });
  assert.equal(unpin.statusCode, 200, unpin.body);
  assert.deepEqual((await t.raw.query(`SELECT * FROM conversation_pins WHERE user_id='b' ORDER BY message_id`)).rows, peerBefore);
  assert.deepEqual((await t.raw.query(`SELECT pts FROM user_sync WHERE user_id='b'`)).rows, peerPts);
  assert.equal(published.some((p) => p.channel === 'gw:user:b'), false);
  await t.raw.exec(`DELETE FROM user_blocks WHERE blocker_id='b' AND blocked_id='a'`);
  assert.deepEqual((await c2List('b')).pins.map((p: { message: { id: string } }) => p.message.id), ['existing-pin']);
  assert.equal((await c2List()).pins[0].forBoth, true, 'мой forBoth остаётся истинным, даже если peer не получил строку');
  await c2Put('missed-pin');
  assert.deepEqual((await c2List('b')).pins.map((p: { message: { id: string } }) => p.message.id), ['existing-pin', 'missed-pin']);
});

test('С2 догонка страницами отдаёт полный текущий список только по pin в этой порции', async () => {
  // Ловит потерю закрепов при more и подмену полного списка частичным набором событий страницы.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES
    ('sync-pin-1','dm','a','one'), ('sync-pin-2','foreign-dm','a','two'), ('sync-pin-3','dm','a','three');`);
  await c2Put('sync-pin-1', 'a', 'me');
  await c2Put('sync-pin-2', 'a', 'me', 'foreign-dm');
  await c2Put('sync-pin-3', 'a', 'me');
  let pts = 0;
  for (const [conv, ids, more] of [
    ['dm', ['sync-pin-1', 'sync-pin-3'], true], ['foreign-dm', ['sync-pin-2'], true], ['dm', ['sync-pin-1', 'sync-pin-3'], false],
  ] as const) {
    const res = await app.inject({ method: 'GET', url: `/conv/sync?pts=${pts}&limit=1`, headers: authHeader('a') });
    assert.equal(res.statusCode, 200, res.body);
    const page = res.json();
    assert.equal(page.pts, pts + 1);
    assert.equal(page.more, more);
    assert.deepEqual(page.pins.map((p: { conversationId: string }) => p.conversationId), [conv]);
    assert.deepEqual(page.pins[0].pins.map((p: { message: { id: string } }) => p.message.id), ids);
    assert.deepEqual(page.messages, []);
    pts = page.pts;
  }
  const empty = (await app.inject({ method: 'GET', url: `/conv/sync?pts=${pts}`, headers: authHeader('a') })).json();
  assert.equal(Object.hasOwn(empty, 'pins'), false);
});

test('С2 pin и unpin делят предел 20 за 10 секунд, отказ и неверная область не меняют базу', async () => {
  // Ловит отдельный бюджет для обратного действия, ошибку на 20/21 и молчаливое умолчание scope.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('rate-pin','dm','a','x')`);
  const beforeInvalid = await c2Snapshot();
  for (const [method, url, payload] of [
    ['PUT', '/conv/dm/messages/rate-pin/pin', {}], ['PUT', '/conv/dm/messages/rate-pin/pin', { for: 'everyone' }],
    ['DELETE', '/conv/dm/messages/rate-pin/pin', undefined], ['DELETE', '/conv/dm/messages/rate-pin/pin?for=everyone', undefined],
  ] as const) {
    const r = await app.inject({ method, url, headers: authHeader('a'), payload });
    assert.equal(r.statusCode, 400, r.body);
  }
  assert.deepEqual(await c2Snapshot(), beforeInvalid);
  const incr = redisPub.incr, expire = redisPub.expire, ttl = redisPub.ttl;
  let hits = 0;
  const windows: [string, number][] = [];
  redisPub.incr = (async (key: string) => key === 'rl:conv-pin:a' ? ++hits : 1) as typeof redisPub.incr;
  redisPub.expire = (async (key: string, seconds: number) => { windows.push([key, seconds]); return 1; }) as typeof redisPub.expire;
  redisPub.ttl = (async () => 10) as typeof redisPub.ttl;
  try {
    for (let i = 1; i <= 20; i++) {
      const r = await app.inject({ method: i % 2 ? 'PUT' : 'DELETE',
        url: `/conv/dm/messages/rate-pin/pin${i % 2 ? '' : '?for=me'}`, headers: authHeader('a'),
        ...(i % 2 ? { payload: { for: 'me' } } : {}) });
      assert.equal(r.statusCode, 200, `hit ${i}: ${r.body}`);
    }
    const beforeFail = await c2Snapshot();
    const limited = await app.inject({ method: 'PUT', url: '/conv/dm/messages/rate-pin/pin', headers: authHeader('a'), payload: { for: 'both' } });
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.headers['retry-after'], '10');
    assert.deepEqual(await c2Snapshot(), beforeFail);
    assert.deepEqual(windows, [['rl:conv-pin:a', 10]]);
  } finally { redisPub.incr = incr; redisPub.expire = expire; redisPub.ttl = ttl; }
});

test('С2 удаление всеми ручками и правка сначала журналируют сообщение, затем полный список закрепов', async () => {
  // Ловит расхождение scopes между ручками и перестановку событий, из-за которой клиент восстанавливает удалённый закреп.
  const cases = [
    ['single', 'me'], ['single', 'both'], ['batch', 'me'], ['batch', 'both'], ['legacy', 'me'], ['legacy', 'both'], ['edit', 'both'],
  ] as const;
  for (const [kind, scope] of cases) {
    const id = `matrix-${kind}-${scope}`;
    await t.raw.query(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ($1,'dm','a','before')`, [id]);
    await c2Put(id);
    const beforePts = new Map((await t.raw.query<{ user_id: string; pts: number }>(`SELECT user_id,pts FROM user_sync`)).rows.map((r) => [r.user_id, Number(r.pts)]));
    published.length = 0;
    const res = kind === 'batch'
      ? await app.inject({ method: 'POST', url: '/conv/dm/messages/delete', headers: authHeader('a'), payload: { ids: [id], for: scope } })
      : kind === 'edit'
        ? await app.inject({ method: 'PATCH', url: `/conv/dm/messages/${id}`, headers: authHeader('a'), payload: { content: 'after' } })
        : await app.inject({ method: 'DELETE', url: `/${kind === 'legacy' ? 'dm' : 'conv'}/dm/messages/${id}?for=${scope}`, headers: authHeader('a') });
    assert.equal(res.statusCode, kind === 'edit' ? 200 : 204, `${kind}/${scope}: ${res.body}`);
    const pins = (await t.raw.query<{ user_id: string }>(`SELECT user_id FROM conversation_pins WHERE message_id=$1 ORDER BY user_id`, [id])).rows;
    assert.deepEqual(pins.map((r) => r.user_id), kind === 'edit' ? ['a', 'b'] : scope === 'me' ? ['b'] : []);
    for (const user of ['a', 'b']) {
      const changed = kind === 'edit' || scope === 'both' || user === 'a';
      const journal = (await t.raw.query<{ pts: number; kind: string; message_id: string | null }>(
        `SELECT pts,kind,message_id FROM user_changes WHERE user_id=$1 AND pts>$2 ORDER BY pts`, [user, beforePts.get(user) ?? 0])).rows;
      const events = published.filter((p) => p.channel === `gw:user:${user}`).map((p) => JSON.parse(p.message).m).filter((m) => m.t === 'conv.change');
      assert.deepEqual(journal.map((r) => [r.kind, r.message_id]), changed ? [['msg', id], ['pin', null]] : [], `${kind}/${scope}/${user} журнал`);
      assert.equal(events.length, changed ? 2 : 0, `${kind}/${scope}/${user} события`);
      if (changed) {
        assert.deepEqual(events.map((e) => e.pts), journal.map((r) => Number(r.pts)));
        assert.equal(events[0].message.id, id);
        assert.equal(Object.hasOwn(events[0], 'pins'), false);
        assert.equal(Object.hasOwn(events[1], 'message'), false);
        assert.deepEqual(events[1].pins, (await c2List(user)).pins);
        if (kind === 'edit') assert.equal(events[1].pins.find((p: { message: { id: string } }) => p.message.id === id).message.text, 'after');
      }
    }
  }
});

test('С2 пересылка уже удалённого автора сразу получает deleted и сохраняет его через цепочку и догонку', async () => {
  // Ловит снимок, созданный после обезличивания без deleted, и потерю первого автора в следующем звене.
  await t.raw.exec(`UPDATE users SET deleted_at=now(), display_name='Удалённый пользователь' WHERE id='c';
    INSERT INTO users (id,username,display_name,password_hash) VALUES ('d','delta','Delta','hash');
    INSERT INTO server_members (server_id,user_id) VALUES ('s','d');
    INSERT INTO conversations (id,kind,direct_key) VALUES ('bc','direct','b:d');
    INSERT INTO conversation_members (conversation_id,user_id) VALUES ('bc','b'),('bc','d');
    INSERT INTO conversation_messages (id,conversation_id,author_id,content) VALUES ('dead-origin','foreign-dm','c','old');`);
  const first = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: {
    clientId: '00000000-0000-4000-8000-000000007711', fromConversationId: 'foreign-dm', messageIds: ['dead-origin'],
  } });
  assert.equal(first.statusCode, 201, first.body);
  const copy = first.json().messages[0];
  const snapshot = copy.forwardedFrom;
  assert.deepEqual(snapshot, { userId: 'c', displayName: 'Удалённый пользователь', at: snapshot.at, deleted: true });
  const second = await app.inject({ method: 'POST', url: '/conv/bc/forward', headers: authHeader('b'), payload: {
    clientId: '00000000-0000-4000-8000-000000007712', fromConversationId: 'dm', messageIds: [copy.id],
  } });
  assert.equal(second.statusCode, 201, second.body);
  assert.deepEqual(second.json().messages[0].forwardedFrom, snapshot);
  const rows = (await t.raw.query<{ forwarded_from: unknown }>(`SELECT forwarded_from FROM conversation_messages WHERE forwarded_from IS NOT NULL`)).rows;
  assert.deepEqual(rows.map((r) => r.forwarded_from), [snapshot, snapshot]);
  const history = (await app.inject({ method: 'GET', url: '/conv/bc/messages', headers: authHeader('b') })).json();
  assert.deepEqual(history.messages[0].forwardedFrom, snapshot);
  const sync = (await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('b') })).json();
  assert.deepEqual(sync.messages.filter((m: { forwardedFrom?: unknown }) => m.forwardedFrom).map((m: { forwardedFrom: unknown }) => m.forwardedFrom), [snapshot, snapshot]);
});

test('С2 старые невидимые строки не попадают в список и не расходуют лимит видимых закрепов', async () => {
  // Ловит следы отката старого сервера: невидимые строки не должны вытеснять доступный пятидесятый закреп.
  await t.raw.exec(`INSERT INTO conversation_messages (id,conversation_id,author_id,content)
    SELECT 'stale-'||n,'dm','b','x' FROM generate_series(1,53) n;
    INSERT INTO conversation_pins (conversation_id,user_id,message_id,pinned_by)
    SELECT 'dm','a','stale-'||n,'a' FROM generate_series(1,52) n;
    UPDATE conversation_messages SET deleted_at=now() WHERE id='stale-50';
    UPDATE conversation_messages SET hidden_for=ARRAY['a'] WHERE id='stale-51';
    UPDATE conversation_messages SET withheld=true WHERE id='stale-52';`);
  assert.equal((await c2List()).pins.length, 49);
  await c2Put('stale-53', 'a', 'me');
  assert.equal((await c2List()).pins.length, 50);
  const before = await c2Snapshot();
  for (const id of ['stale-50', 'stale-51', 'stale-52']) {
    const res = await app.inject({ method: 'DELETE', url: `/conv/dm/messages/${id}/pin?for=both`, headers: authHeader('a') });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().pins.length, 50);
  }
  assert.deepEqual(await c2Snapshot(), before, 'невидимое открепление не меняет строки/журнал/события');
  for (const url of ['/conv/dm/messages/absent/pin?for=both', '/conv/foreign-dm/messages/stale-1/pin?for=both']) {
    assert.equal((await app.inject({ method: 'DELETE', url, headers: authHeader('a') })).statusCode, 404);
  }
});

test('С2 контрфакты без видимости актора, собеседника и фильтра списка отвергаются', async () => {
  // Ловит ослабление самих фикстур: удаление каждой защиты обязано дать отличимый запрещённый результат.
  await t.raw.exec(`INSERT INTO conversation_messages (id,conversation_id,author_id,content,hidden_for) VALUES
    ('mutant-actor','dm','b','hidden',ARRAY['a']), ('mutant-peer','dm','a','hidden',ARRAY['b']);
    INSERT INTO conversation_pins (conversation_id,user_id,message_id,pinned_by) VALUES ('dm','a','mutant-actor','a');`);
  const actual = await import('../src/conversations.js');
  const access = (await actual.loadAccess('dm', 'a'))!;
  const checkActor = async (module: typeof actual) => {
    const res = await module.pinMessage('a', access, 'mutant-actor', 'me');
    assert.equal(res.kind, 'not-found');
  };
  await checkActor(actual);
  const actorMutant = await mutantConversations((s) => {
    const start = s.indexOf('export async function pinMessage(');
    assert.ok(start >= 0, 'найдена именно функция pinMessage для мутанта видимости');
    return s.slice(0, start) + s.slice(start).replace("if (!m || messageView(m, me) !== 'full') return { kind: 'not-found' };", "if (!m) return { kind: 'not-found' };");
  });
  await assert.rejects(checkActor(actorMutant), assert.AssertionError);
  const checkPeer = async (module: typeof actual) => {
    await t.raw.exec(`DELETE FROM conversation_pins WHERE message_id='mutant-peer'`);
    const res = await module.pinMessage('a', access, 'mutant-peer', 'both');
    assert.equal(res.kind, 'ok');
    assert.deepEqual((await t.raw.query(`SELECT user_id FROM conversation_pins WHERE message_id='mutant-peer' ORDER BY user_id`)).rows, [{ user_id: 'a' }]);
  };
  await checkPeer(actual);
  const peerMutant = await mutantConversations((s) => s, (s) => s.replace(" && messageView(message, id) === 'full'", ''));
  await assert.rejects(checkPeer(peerMutant), assert.AssertionError);
  const checkList = async (module: typeof actual) => {
    const list = await module.listPins('a', 'dm');
    assert.equal(list?.pins.some((p) => p.message.id === 'mutant-actor'), false);
  };
  await checkList(actual);
  const listMutant = await mutantConversations((s) => s.replace(
    'eq(conversationPins.userId, me), visibleTo(me, conversationId)', 'eq(conversationPins.userId, me)'));
  await assert.rejects(checkList(listMutant), assert.AssertionError);
});

test('С3 только boolean принимается, а silent true присутствует во всех DTO без изменения обычного сообщения', async () => {
  // Ловит приведение мусора к true и потерю флага на одном из старого/нового путей доставки.
  const id = '00000000-0000-4000-8000-000000008301';
  for (const silent of ['true', 1, null]) {
    for (const url of ['/conv/dm/messages', '/conv/dm/forward']) {
      const r = await app.inject({ method: 'POST', url, headers: authHeader('a'), payload: url.endsWith('/forward')
        ? { clientId: id, fromConversationId: 'foreign-dm', messageIds: ['absent'], silent }
        : { clientId: id, content: 'x', silent } });
      assert.equal(r.statusCode, 400, r.body);
    }
  }
  assert.equal((await t.raw.query(`SELECT id FROM conversation_messages`)).rows.length, 0);
  for (const [index, flag] of [undefined, false, true].entries()) {
    published.length = 0;
    const res = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: {
      clientId: `00000000-0000-4000-8000-00000000830${index + 2}`, content: `silent-${index}`, ...(flag === undefined ? {} : { silent: flag }),
    } });
    assert.equal(res.statusCode, 201, res.body);
    const message = res.json();
    assert.equal(message.silent, flag === true ? true : undefined);
    assert.equal(Object.hasOwn(message, 'silent'), flag === true);
    assert.equal((await t.raw.query<{ silent: boolean }>(`SELECT silent FROM conversation_messages WHERE id=$1`, [message.id])).rows[0]?.silent, flag === true);
    const wire = published.map((p) => ({ user: p.channel, m: JSON.parse(p.message).m })).filter(({ m }) => m.t === 'dm.create' || m.t === 'conv.change');
    assert.equal(wire.length, 4);
    for (const { m } of wire) {
      assert.equal(Object.hasOwn(m.message, 'silent'), flag === true);
      assert.equal(m.message.silent, flag === true ? true : undefined);
    }
    for (const user of ['a', 'b']) {
      for (const url of ['/conv/dm/messages', '/dm/dm/messages', '/conv/sync?pts=0']) {
        const r = await app.inject({ method: 'GET', url, headers: authHeader(user) });
        assert.equal(r.statusCode, 200, r.body);
        const body = r.json();
        const found = (Array.isArray(body) ? body : body.messages).find((m: { id: string }) => m.id === message.id);
        assert.equal(Object.hasOwn(found, 'silent'), flag === true, `${user}/${url}`);
      }
    }
    const before = published.length;
    const replay = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: {
      clientId: message.clientId, content: `silent-${index}`, silent: flag !== true,
    } });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), message);
    assert.equal(published.length, before);
    const conflict = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: {
      clientId: message.clientId, content: 'changed', silent: flag !== true,
    } });
    assert.equal(conflict.statusCode, 409, conflict.body);
  }
});

test('С3 пересылка задаёт тихость копии, не наследует её от оригинала и не меняет на повторе', async () => {
  // Ловит перенос разовой настройки исходной отправки и дублирование пересылки при смене silent на retry.
  await t.raw.exec(`INSERT INTO conversation_messages (id,conversation_id,author_id,content,silent) VALUES
    ('silent-origin','foreign-dm','c','one',true),('loud-origin','foreign-dm','c','two',false)`);
  for (const [n, source, silent] of [[1, 'silent-origin', false], [2, 'loud-origin', true]] as const) {
    const body = { clientId: `00000000-0000-4000-8000-00000000832${n}`, fromConversationId: 'foreign-dm', messageIds: [source], silent };
    const res = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: body });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(Object.hasOwn(res.json().messages[0], 'silent'), silent);
    assert.equal((await t.raw.query<{ silent: boolean }>(`SELECT silent FROM conversation_messages WHERE id=$1`, [res.json().messages[0].id])).rows[0]?.silent, silent);
    const before = await c2Snapshot();
    const replay = await app.inject({ method: 'POST', url: '/conv/dm/forward', headers: authHeader('a'), payload: { ...body, silent: !silent } });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), res.json());
    assert.deepEqual(await c2Snapshot(), before);
  }
});

test('С3 тихий пуш зашифрован, имеет своё окно и не поглощает следующий обычный пуш', async () => {
  // Ловит открытый silent вне шифра и общий debounce, который глушил бы нормальное сообщение после тихого.
  const encrypted = pushKeys();
  await t.raw.query(`INSERT INTO push_devices (id,user_id,device_id,endpoint,platform,p256dh,auth)
    VALUES ('c3-push','b','phone','https://ntfy.example.test/c3','android',$1,$2)`, [encrypted.public.p256dh, encrypted.public.auth]);
  const original = redisPub.incr;
  const counts = new Map<string, number>();
  redisPub.incr = (async (key: string) => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n; }) as typeof redisPub.incr;
  try {
    for (const [n, silent] of [true, false, false, true].entries()) {
      const res = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: {
        clientId: `00000000-0000-4000-8000-00000000833${n}`, content: `push-${n}`, silent,
      } });
      assert.equal(res.statusCode, 201, res.body);
      for (let wait = 0; wait < 20; wait++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(posted.length, 4, 'после первого пуша новые сообщения окна досылаются тихо');
    const payloads = posted.map((p) => {
      assert.equal((p.init.headers as Record<string, string>)['Content-Encoding'], 'aes128gcm');
      return JSON.parse(decryptPush(Buffer.from(p.init.body as Buffer), encrypted.receiver, encrypted.auth).toString());
    });
    assert.equal(payloads[0].silent, true);
    assert.equal(payloads[0].body, 'push-0');
    assert.equal(Object.hasOwn(payloads[1], 'silent'), false);
    assert.equal(payloads[1].body, 'push-1');
    // Решение владельца 39: повторные сообщения окна теперь доходят без звука,
    // а первый обычный после явно тихого по-прежнему использует независимое окно.
    assert.deepEqual(payloads.slice(2).map((p) => ({ body: p.body, silent: p.silent })), [
      { body: 'push-2', silent: true }, { body: 'push-3', silent: true },
    ]);
    const pushKeysUsed = [...counts.keys()].filter((key) => key.includes('push:'));
    assert.deepEqual(pushKeysUsed.sort(), ['rl:push:b:a', 'rl:push:b:a:silent'].sort());
  } finally { redisPub.incr = original; }
});

test('пачка из семи сообщений отправляет один звонкий и пять тихих шифрованных пушей, седьмой остаётся в истории', async () => {
  const keys = pushKeys();
  await t.raw.query(`INSERT INTO push_devices (id,user_id,device_id,endpoint,platform,p256dh,auth)
    VALUES ('burst-push','b','phone','https://ntfy.example.test/burst','android',$1,$2)`, [keys.public.p256dh, keys.public.auth]);
  const original = redisPub.incr; const counts = new Map<string, number>();
  redisPub.incr = (async (key: string) => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n; }) as typeof redisPub.incr;
  try {
    for (let n = 0; n < 7; n++) {
      const res = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: {
        clientId: `00000000-0000-4000-8000-00000000910${n}`, content: `burst-${n}`,
      } });
      assert.equal(res.statusCode, 201, res.body);
      for (let wait = 0; wait < 20; wait++) await new Promise<void>(resolve => setTimeout(resolve, 0));
      assert.equal(posted.length, Math.min(n + 1, 6), `доставка после сообщения ${n + 1}`);
    }
    const payloads = posted.map(p => {
      assert.equal((p.init.headers as Record<string, string>)['Content-Encoding'], 'aes128gcm');
      return JSON.parse(decryptPush(Buffer.from(p.init.body as Buffer), keys.receiver, keys.auth).toString());
    });
    assert.equal(Object.hasOwn(payloads[0], 'silent'), false);
    assert.deepEqual(payloads.map(p => p.body), Array.from({ length: 6 }, (_, n) => `burst-${n}`));
    assert.deepEqual(payloads.slice(1).map(p => p.silent), [true, true, true, true, true]);
    assert.equal(counts.get('rl:push:b:a'), 7); assert.equal(counts.get('rl:pushq:b:a'), 6);
    assert.equal((await t.raw.query("SELECT * FROM conversation_messages WHERE conversation_id='dm'")).rows.length, 7);
  } finally { redisPub.incr = original; }
});

test('исключение личной беседы перекрывает notifyDm=false только для своего адресата и источника', async () => {
  await t.raw.exec(`UPDATE users SET notify_dm=false WHERE id='b';
    INSERT INTO push_devices (id,user_id,device_id,endpoint,platform) VALUES ('always-device','b','phone','https://ntfy.example.test/always','android');`);
  const raw = readFileSync(new URL('../src/push.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const check = async (push: typeof import('../src/push.js')) => {
    await t.raw.exec('DELETE FROM push_always');
    for (const [notify, owner, target, soundOnly, expected] of [
      [true, null, null, null, 1], [false, null, null, null, 0], [false, 'b', 'a', null, 1],
      [false, 'c', 'a', null, 0], [false, 'b', 'c', null, 0],
      [false, 'b', 'a', false, 0], [false, 'b', 'a', true, 1],
    ] as const) {
      await t.raw.query("UPDATE users SET notify_dm=$1 WHERE id='b'", [notify]);
      await t.raw.exec('DELETE FROM push_always; DELETE FROM push_mutes');
      if (owner && target) await t.raw.query("INSERT INTO push_always(user_id,scope,target_id) VALUES($1,'dm_user',$2)", [owner, target]);
      if (soundOnly !== null) await t.raw.query("INSERT INTO push_mutes(user_id,scope,target_id,sound_only) VALUES('b','dm_user','a',$1)", [soundOnly]);
      posted.length = 0;
      await push.sendPushToUsers(['b'], { type: 'dm', title: 'Alpha', body: 'x', dmId: 'dm' }, { scope: 'dm_user', targetId: 'a' }, { private: true, noDefer: true });
      assert.equal(posted.length, expected, `notifyDm=${notify}, исключение ${owner}/${target}`);
      if (soundOnly === true) assert.equal(JSON.parse(posted[0].init.body as string).silent, true, 'исключение без звука остаётся тихим');
    }
  };
  await check(await compilePush(raw));
  const changed = raw.replace(' || always.has(r.id)', ''); assert.notEqual(changed, raw);
  await assert.rejects(check(await compilePush(changed)), /notifyDm=false, исключение b\/a/);
});

test('включение исключения снимает полную заглушку своей беседы, сохраняет sound_only и чужие строки', async () => {
  const raw = readFileSync(new URL('../src/push.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const check = async (push: typeof import('../src/push.js')) => {
    await t.raw.exec(`DELETE FROM push_always; DELETE FROM push_mutes;
      INSERT INTO push_mutes(user_id,scope,target_id,sound_only) VALUES
        ('b','dm_user','a',false),('b','dm_user','c',true),('c','dm_user','a',false),('b','server','s',false);`);
    await push.setPushAlways('b', 'a');
    assert.equal((await t.raw.query("SELECT * FROM push_mutes WHERE user_id='b' AND scope='dm_user' AND target_id='a'")).rows.length, 0);
    await push.setPushAlways('b', 'c');
    assert.equal((await t.raw.query("SELECT * FROM push_mutes WHERE user_id='b' AND target_id='c' AND sound_only=true")).rows.length, 1, 'sound_only не удаляется исключением');
    assert.equal((await t.raw.query("SELECT * FROM push_mutes WHERE user_id='c'")).rows.length, 1);
    assert.equal((await t.raw.query("SELECT * FROM push_mutes WHERE scope='server'")).rows.length, 1);
    await push.setPushAlways('b', 'c');
    assert.equal((await t.raw.query("SELECT * FROM push_always WHERE user_id='b'")).rows.length, 2, 'повтор включения идемпотентен');
  };
  await check(await compilePush(raw));
  const changed = raw.replace('          eq(pushMutes.soundOnly, false),', ''); assert.notEqual(changed, raw);
  await assert.rejects(check(await compilePush(changed)), /sound_only не удаляется исключением/);
});

test('полная заглушка снимает своё исключение, soundOnly и серверная заглушка оставляют его', async () => {
  const push = await import('../src/push.js');
  await push.setPushAlways('b', 'a'); await push.setPushAlways('c', 'a');
  await push.setPushMute('b', 'dm_user', 'a', undefined, true);
  assert.equal((await push.listPushAlways('b')).length, 1, 'выключение звука не выключает уведомления');
  await push.setPushMute('b', 'server', 's');
  assert.equal((await push.listPushAlways('b')).length, 1);
  await push.setPushMute('b', 'dm_user', 'a');
  assert.equal((await push.listPushAlways('b')).length, 0, 'полная заглушка удаляет исключение');
  assert.equal((await push.listPushAlways('c')).length, 1, 'чужое исключение осталось');
});

test('API исключений принимает dm_user и group:id, но отвергает server без записей в базе', async () => {
  const server = await app.inject({ method: 'POST', url: '/push/always', headers: authHeader('b'), payload: { scope: 'server', targetId: 's' } });
  assert.equal(server.statusCode, 400, server.body);
  assert.equal((await t.raw.query('SELECT * FROM push_always')).rows.length, 0);
  for (const targetId of ['a', 'group:dm']) {
    const allowed = await app.inject({ method: 'POST', url: '/push/always', headers: authHeader('b'), payload: { scope: 'dm_user', targetId } });
    assert.equal(allowed.statusCode, 204, allowed.body);
  }
  const listed = await app.inject({ method: 'GET', url: '/push/always', headers: authHeader('b') });
  assert.equal(listed.statusCode, 200); assert.deepEqual(listed.json().map((r: { targetId: string }) => r.targetId).sort(), ['a', 'group:dm']);
});

test('тихая досылка не ретранслируется дому гостя, обычный пуш дома остаётся', async () => {
  await t.raw.exec("UPDATE users SET home_instance_id='home',home_user_id='home-b' WHERE id='b'");
  const raw = readFileSync(new URL('../src/push.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const check = async (source: string) => {
    const relayed: unknown[] = [];
    const push = await compilePush(source, { './federation/guestPush.js': { notifyGuestHomes: async (guests: unknown, payload: unknown) => { relayed.push({ guests, payload }); } } });
    await push.sendPushToUsers(['b'], { type: 'dm', title: 'Alpha', body: 'one', dmId: 'dm' }, undefined, { noDefer: true });
    for (let n = 0; n < 5; n++) await Promise.resolve();
    assert.equal(relayed.length, 1, 'обычный пуш дошёл домой');
    await push.sendPushToUsers(['b'], { type: 'dm', title: 'Alpha', body: 'two', dmId: 'dm', silent: true }, undefined, { noDefer: true, burst: true });
    for (let n = 0; n < 5; n++) await Promise.resolve();
    assert.equal(relayed.length, 1, 'burst не будит дом второй раз');
    assert.equal(posted.length, 0, 'гость не получает прямой ntfy на чужом инстансе');
  };
  await check(raw);
  const changed = raw.replace(" && !opts.burst", ''); assert.notEqual(changed, raw);
  await assert.rejects(check(changed), /burst не будит дом второй раз/);
});

test('4096 знаков принимаются и 4097 отклоняются всеми ручками, включая черновик', async () => {
  // Новый счётчик не заменяет серверную защиту; старый клиент тоже получает понятное объяснение.
  const { TEXT_TOO_LONG } = await import('../src/convRules.js');
  const max = 'x'.repeat(4096); const over = max + 'x';
  const hdr = authHeader('a');
  const conv = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: hdr,
    payload: { content: max, attachments: [], clientId: '70000000-0000-4000-8000-000000000001' } });
  assert.equal(conv.statusCode, 201, conv.body);
  const dm = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: hdr, payload: { content: max, attachments: [] } });
  assert.equal(dm.statusCode, 201, dm.body);
  const channel = await app.inject({ method: 'POST', url: '/channels/ch/messages', headers: hdr, payload: { content: max, attachments: [] } });
  assert.equal(channel.statusCode, 201, channel.body);
  const queued = await app.inject({ method: 'POST', url: '/conv/dm/scheduled', headers: hdr,
    payload: { content: max, clientId: '70000000-0000-4000-8000-000000000002', sendAt: new Date(Date.now() + 60_000).toISOString() } });
  assert.equal(queued.statusCode, 201, queued.body);
  const sid = queued.json().items[0].id;
  const cases = [
    ['POST', '/conv/dm/messages', { content: over, attachments: [], clientId: '70000000-0000-4000-8000-000000000003' }],
    ['POST', '/dm/dm/messages', { content: over, attachments: [] }],
    ['POST', '/channels/ch/messages', { content: over, attachments: [] }],
    ['PATCH', `/conv/dm/messages/${conv.json().id}`, { content: over }],
    ['PATCH', `/dm/dm/messages/${dm.json().id}`, { content: over }],
    ['PATCH', `/channels/ch/messages/${channel.json().id}`, { content: over }],
    ['POST', '/conv/dm/scheduled', { content: over, clientId: '70000000-0000-4000-8000-000000000004', sendAt: new Date(Date.now() + 60_000).toISOString() }],
    ['PATCH', `/conv/dm/scheduled/${sid}`, { content: over }],
    ['PUT', '/conv/dm/draft', { text: over, replyToId: null, device: 'test' }],
  ] as const;
  for (const [method, url, payload] of cases) {
    const response = await app.inject({ method, url, headers: hdr, payload });
    assert.equal(response.statusCode, 400, `${method} ${url}: ${response.body}`);
    assert.equal(response.json().error, TEXT_TOO_LONG, `${method} ${url}`);
    const boundary = { ...payload, ...('text' in payload ? { text: max } : { content: max }) };
    const accepted = await app.inject({ method, url, headers: hdr, payload: boundary });
    assert.ok(accepted.statusCode >= 200 && accepted.statusCode < 300, `${method} ${url} точный предел: ${accepted.body}`);
  }
});

test('правка прежним текстом и пробелами не ставит editedAt и не рассылает события во всех трёх API', async () => {
  // Открыть редактор и нажать Отправить без изменений — не должно помечать сообщение изменённым.
  const hdr = authHeader('a');
  const requests = [
    ['/conv/dm/messages', { clientId: '70000000-0000-4000-8000-000000000010', content: 'исходный', attachments: [] }, 'conversation_messages'],
    ['/dm/dm/messages', { content: 'исходный', attachments: [] }, 'conversation_messages'],
    ['/channels/ch/messages', { content: 'исходный', attachments: [] }, 'messages'],
  ] as const;
  for (const [route, payload, table] of requests) {
    const created = await app.inject({ method: 'POST', url: route, headers: hdr, payload });
    assert.equal(created.statusCode, 201, created.body); const id = created.json().id;
    for (const content of ['исходный', '  исходный  ']) {
      published.length = 0;
      const before = (await t.raw.query('SELECT * FROM user_changes')).rows.length;
      const edited = await app.inject({ method: 'PATCH', url: `${route}/${id}`, headers: hdr, payload: { content } });
      assert.equal(edited.statusCode, 200, edited.body); assert.equal(edited.json().editedAt, null);
      assert.equal((await t.raw.query<{ edited_at: Date | null }>(`SELECT edited_at FROM ${table} WHERE id=$1`, [id])).rows[0].edited_at, null);
      assert.equal(published.length, 0, 'нет message.update/dm.update/conv.change');
      assert.equal((await t.raw.query('SELECT * FROM user_changes')).rows.length, before, 'нет новых изменений журнала');
    }
    const edited = await app.inject({ method: 'PATCH', url: `${route}/${id}`, headers: hdr, payload: { content: 'новый' } });
    assert.equal(edited.statusCode, 200, edited.body); assert.ok(edited.json().editedAt, 'настоящая правка получает дату');
    assert.ok(published.length > 0, 'настоящая правка рассылается');
  }
  const actual = await import('../src/conversations.js');
  const access = await actual.loadAccess('dm', 'a');
  assert.ok(access, 'автор состоит в беседе');
  const result = await actual.sendMessage('a', access, { content: 'контрфакт', attachments: [], clientId: '70000000-0000-4000-8000-000000000011', replyToId: null, withheld: false });
  assert.equal(result.kind, 'created');
  if (result.kind !== 'created') assert.fail('должно быть новое сообщение');
  const check = async (mod: typeof actual) => {
    const response = await mod.editMessage('a', access, result.row.id, 'контрфакт');
    assert.equal(response.kind, 'ok');
    if (response.kind === 'ok') assert.equal(response.delivery, null, 'неизменённая правка не создаёт delivery');
  };
  await check(actual);
  const bad = await mutantConversations(source => source.replace("    if (content === m.content) return { kind: 'ok', row: m, delivery: null };", ''));
  await assert.rejects(() => check(bad), assert.AssertionError);
});

test('новая история даёт список поставивших по времени с фильтром блока, а старая ЛС сохраняет прежний DTO', async () => {
  // Аватары «кто поставил» обязаны идти в порядке постановки; пользователь, заблокированный смотрящим, не должен раскрываться.
  await t.raw.exec(`
    INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('reactors-order', 'dm', 'b', 'x');
    INSERT INTO conversation_message_reactions (message_id, user_id, emoji, created_at) VALUES
      ('reactors-order', 'a', '🔥', '2026-09-20T10:00:03Z'),
      ('reactors-order', 'c', '🔥', '2026-09-20T10:00:02Z'),
      ('reactors-order', 'b', '🔥', '2026-09-20T10:00:01Z');
    INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('a', 'b')
  `);
  resetBlockCache();
  const fresh = await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader('a') });
  assert.equal(fresh.statusCode, 200, fresh.body);
  const newGroup = fresh.json().messages.find((m: { id: string }) => m.id === 'reactors-order')?.reactions[0];
  assert.ok(newGroup, 'у сообщения есть группа реакций');
  assert.deepEqual(newGroup.reactors.map((r: { userId: string }) => r.userId), ['c', 'a'], 'реакторы упорядочены по at, а заблокированный b скрыт');
  assert.equal(newGroup.count, 2, 'count соответствует только видимым людям');
  assert.equal(newGroup.me, true, 'моя реакция сохраняет прежний флаг');
  const legacy = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  assert.equal(legacy.statusCode, 200, legacy.body);
  const oldGroup = legacy.json().find((m: { id: string }) => m.id === 'reactors-order')?.reactions[0];
  assert.ok(oldGroup, 'старая история сохраняет реакцию');
  assert.equal(Object.hasOwn(oldGroup, 'reactors'), false, 'старый DTO не получает новое поле');
  assert.deepEqual(oldGroup, { emoji: '🔥', count: 2, me: true });

  // Эти контрфакты прогоняют тот же DB-путь через изменённую в памяти копию модуля: тест должен ловить потерю сортировки и фильтра блока.
  const unsorted = await mutantConversations((source) => source.replace(
    'function reactorsInOrder(list: ReactionReactor[]): ReactionReactor[] {\n  return [...list].sort((a, b) => a.at.localeCompare(b.at) || a.userId.localeCompare(b.userId));\n}',
    'function reactorsInOrder(list: ReactionReactor[]): ReactionReactor[] {\n  return [...list];\n}',
  ));
  const unsortedView = await unsorted.messageFor('reactors-order', 'a');
  if (!unsortedView || 'gone' in unsortedView) assert.fail('контрфакт сортировки должен возвращать сообщение');
  assert.throws(() => assert.deepEqual(unsortedView.reactions[0]?.reactors?.map((r) => r.userId), ['c', 'a']), assert.AssertionError,
    'сортировочный мутант должен ломать проверку порядка');
  const unfiltered = await mutantConversations((source) => source.replace('    if (hidden.has(r.userId)) continue;\n', ''));
  const unfilteredView = await unfiltered.messageFor('reactors-order', 'a');
  if (!unfilteredView || 'gone' in unfilteredView) assert.fail('контрфакт фильтра должен возвращать сообщение');
  assert.throws(() => assert.deepEqual(unfilteredView.reactions[0]?.reactors?.map((r) => r.userId), ['c', 'a']), assert.AssertionError,
    'мутант фильтра должен показывать заблокированного b и ломать проверку');
  const leakedLegacy = await mutantConversations(source => source.replace(
    'const reactions = rest.reactions?.map(({ reactors, ...g }) => g);', 'const reactions = rest.reactions;',
  ));
  const legacyMutant = leakedLegacy.toLegacyMessage(unsortedView);
  assert.throws(() => assert.equal(Object.hasOwn(legacyMutant.reactions[0], 'reactors'), false), assert.AssertionError,
    'без среза в toLegacyMessage старый DTO получает неподдерживаемое поле');
});
