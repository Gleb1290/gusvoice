import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as blockRules from '../src/blockRules.js';
import * as dmRules from '../src/dmRules.js';
import * as pushRules from '../src/pushRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
const knownImports: Record<string, readonly string[]> = {
  "serialize": ["@gusvoice/shared","./auth.js","./superAdminRules.js","./env.js","./federation/instanceLabels.js","./statusRules.js","./shopRules.js","./callRules.js","./lastSeenRules.js","./linkThreats.js"],
  "conversations": ["@gusvoice/shared","drizzle-orm","./convRules.js","./db/index.js","./db/schema.js","./dmWriteBarrier.js","./attachments.js","./env.js","./db/schema.js","./serialize.js","./util.js"],
  "blocks": ["drizzle-orm","./db/index.js","./db/schema.js"],
  "convSendFanout": ["drizzle-orm","./authGuard.js","./conversations.js","./db/index.js","./contacts.js","./contactRules.js","./db/schema.js","./groupRules.js","./push.js"],
  "routes/att": ["../auth.js","../conversations.js","@gusvoice/shared","drizzle-orm","zod","../attachmentRules.js","../attachments.js","../authGuard.js","../convRules.js","../db/index.js","../db/schema.js","../storage.js"],
  "routes/conv": ["@gusvoice/shared","@gusvoice/shared","drizzle-orm","zod","../auth.js","../authGuard.js","../guestGuard.js","./att.js","../stickerCatalog.js","../blockRules.js","../blocks.js","../conversations.js","../convSendFanout.js","../dmReports.js","../strangerRules.js","../scheduled.js","../scheduleRules.js","../convRules.js","../contacts.js","../contactRules.js","../db/index.js","../realtime.js","./dmFolders.js","../db/peerQueries.js","../lastSeen.js","../db/schema.js","../dmRules.js","../instanceSetup.js","../userSearchRules.js","../push.js","../superAdminRules.js"],
};
let ioFailures: string[] = [];
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.close(); });

// Полные модули исполняются с настоящим SQL; незаявленные IO и динамические импорты закрыты.
function load<T>(name: string, explicit: Record<string, unknown>, mutation?: Mutation): T {
  let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation) {
    assert.equal(source.split(mutation[0]).length - 1, 1, `единственный якорь ${name}`);
    source = source.replace(...mutation);
  }
  const deps: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly) continue;
    const id = (n.moduleSpecifier as ts.StringLiteral).text;
    assert.equal(knownImports[name]?.includes(id), true, `закрытый перечень импортов ${name}:${id}`);
    deps[id] = new Proxy({}, { get: (_o, key) => key === '__esModule' ? true : () => {
      ioFailures.push(`${id}.${String(key)}`); throw new Error(`закрытая IO-граница ${id}.${String(key)}`);
    } });
  }
  Object.assign(deps, explicit);
  const module = { exports: {} };
  const forbidden = () => { ioFailures.push('таймер или сеть'); throw new Error('неожиданный таймер или сеть'); };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, Error,
      fetch: forbidden, setTimeout: forbidden, setInterval: forbidden,
      require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `явный импорт ${name}:${id}`); return deps[id]; } });
  return module.exports as T;
}

async function fixture(mutation?: Mutation) {
  ioFailures = [];
  await truncateAll(t.raw);
  await t.raw.exec(`INSERT INTO users(id,username,display_name,password_hash) VALUES ('a','alpha','Alpha','fixture'),('b','bravo','Bravo','fixture');
    INSERT INTO conversations(id,kind,direct_key,created_by) VALUES ('dm','direct','a:b','a'),('saved','direct','a:a','a');
    INSERT INTO conversation_members(conversation_id,user_id) VALUES ('dm','a'),('dm','b'),('saved','a')`);
  const events: Array<{ user: string; m: shared.GatewayServerMessage; options: { cap?: string; notCap?: string } }> = [];
  const readPushes: unknown[][] = [];
  const common = { '@gusvoice/shared': shared, 'drizzle-orm': orm };
  const db = { './db/index.js': { db: t.db }, './db/schema.js': schema };
  const serialize = load<typeof import('../src/serialize.js')>('serialize', {
    ...common, './env.js': { env: {} }, './linkThreats.js': { dangerousLinksOf: () => [] },
  });
  const c = load<typeof import('../src/conversations.js')>('conversations', {
    ...common, ...db, './convRules.js': rules, './serialize.js': serialize,
    './env.js': { env: { publicApiUrl: 'https://fixture.invalid' } }, './dmWriteBarrier.js': { dmWriteBarrier: {} },
    './util.js': { uuidv7: randomUUID }, './attachments.js': { privateAttachmentsReady: () => true },
    './realtime.js': { publishToUser: async (user: string, m: shared.GatewayServerMessage, options: { cap?: string; notCap?: string }) => { events.push({ user, m, options }); } },
  });
  const blocks = load<typeof import('../src/blocks.js')>('blocks', { ...common, ...db });
  const fanout = load<typeof import('../src/convSendFanout.js')>('convSendFanout', {
    ...common, ...db, './conversations.js': c, './authGuard.js': { pushBurst: async () => 'drop' }, './push.js': pushRules,
  });
  const att = load<typeof import('../src/routes/att.js')>('routes/att', { ...common, zod: { z },
    // R304: старые GET проверяют выдачу; новый POST links — отдельная авторизованная граница.
    '../auth.js': { requireAuth: async () => {} },
    '../conversations.js': { formerLeftAt: async () => null },
  });
  const route = load<typeof import('../src/routes/conv.js')>('routes/conv', {
    ...common, zod: { z }, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../auth.js': { requireAuth: async (req: any) => { req.user = { sub: req.headers['x-fixture-user'] ?? 'a' }; } },
    '../authGuard.js': { messageSendBlock: async () => 0, rateHit: async () => 0 },
    '../conversations.js': c, '../convRules.js': rules, '../blocks.js': blocks, '../blockRules.js': blockRules,
    '../dmRules.js': dmRules, './att.js': att, '../convSendFanout.js': fanout,
    '../push.js': { ...pushRules, sendReadSyncPush: async (...args: unknown[]) => { readPushes.push(args); } },
  }, mutation);
  const app = Fastify(); await app.register(route.convRoutes); await app.ready();
  const send = async (user: string, content: string, cid = 'dm', clientId = randomUUID()) => {
    const res = await app.inject({ method: 'POST', url: `/conv/${cid}/messages`, headers: { 'x-fixture-user': user }, payload: { content, clientId } });
    assert.equal(res.statusCode, 201, res.body); return res.json() as shared.ConvMessage;
  };
  const journal = async () => (await t.raw.query<{ user_id: string; pts: number; kind: string; message_id: string | null }>(
    'SELECT user_id,pts,kind,message_id FROM user_changes ORDER BY user_id,pts')).rows;
  const keys = async () => (await t.raw.query<{ user_id: string; last_read_key: number }>(
    "SELECT user_id,last_read_key FROM conversation_members WHERE conversation_id='dm' ORDER BY user_id")).rows.map(r => ({ user: r.user_id, key: Number(r.last_read_key) }));
  return { app, c, events, readPushes, send, journal, keys };
}

async function replyReads(mutation?: Mutation, expected?: { key: number }) {
  const f = await fixture(mutation);
  try {
    const a1 = await f.send('a', 'первое'); const a2 = await f.send('a', 'второе');
    const before = await f.c.listConversations('b');
    assert.equal(before.conversations.find(c => c.id === 'dm')?.unread, 2);
    const b = await f.send('b', 'ответ'); if (expected) expected.key = b.sortKey;
    const keys = await f.keys();
    assert.equal(keys.find(k => k.user === 'b')?.key, b.sortKey, 'R235 send-read: B прочитал до собственного ответа');
    const bs = (await f.c.listConversations('b')).conversations.find(c => c.id === 'dm');
    const as = (await f.c.listConversations('a')).conversations.find(c => c.id === 'dm');
    assert.equal(bs?.lastReadKey, b.sortKey); assert.equal(bs?.unread, 0); assert.equal(as?.peerReadKey, b.sortKey);
    assert.equal(as?.lastReadKey, a2.sortKey); assert.equal(as?.unread, 1);
    for (const user of ['a', 'b']) {
      const journal = (await f.journal()).filter(r => r.user_id === user);
      assert.deepEqual(journal.map(r => [Number(r.pts), r.kind, r.message_id]), [
        [1, 'msg', a1.id], [2, 'read', null], [3, 'msg', a2.id], [4, 'read', null], [5, 'msg', b.id], [6, 'read', null],
      ]);
      const events = f.events.filter(e => e.user === user);
      assert.equal(events.length, 6);
      for (const [index, e] of events.entries()) {
        assert.equal(e.m.t, 'conv.change'); assert.equal(e.options.cap, 'conv1'); assert.equal(e.options.notCap, undefined);
        const m = e.m as Extract<shared.GatewayServerMessage, { t: 'conv.change' }>;
        assert.equal(m.pts, index + 1);
        assert.equal(m.created, index % 2 === 0 ? true : undefined);
        assert.equal(m.message?.id, index % 2 === 0 ? [a1.id, a2.id, b.id][index / 2] : undefined);
      }
    }
    assert.deepEqual(f.readPushes, [['a', 'dm', a1.sortKey], ['a', 'dm', a2.sortKey], ['b', 'dm', b.sortKey]]);
    const rows = (await t.raw.query<{ id: string; read_at: unknown }>("SELECT id,read_at FROM conversation_messages ORDER BY sort_key")).rows;
    assert.deepEqual(rows.map(r => [r.id, r.read_at !== null]), [[a1.id, true], [a2.id, true], [b.id, false]]);
  } finally { await f.app.close(); assert.deepEqual(ioFailures, [], 'неожиданный IO не скрыт catch'); }
}

async function withheldDoesNotRead(mutation?: Mutation, expected?: { key: number }) {
  const f = await fixture(mutation);
  try {
    const a = await f.send('a', 'видимое B');
    await t.raw.exec("INSERT INTO user_blocks(blocker_id,blocked_id) VALUES ('a','b')");
    const journalBefore = await f.journal(); const pushBefore = f.readPushes.length;
    const b = await f.send('b', 'придержанное');
    if (expected) expected.key = b.sortKey;
    assert.equal((await f.keys()).find(k => k.user === 'b')?.key, 0, 'R235 withheld: отметка B остаётся нулевой');
    assert.deepEqual((await f.journal()).filter(r => r.user_id === 'a'), journalBefore.filter(r => r.user_id === 'a'));
    assert.deepEqual(f.events.map(e => [e.user, e.m.t]), [['a', 'conv.change'], ['b', 'conv.change'], ['a', 'conv.change'], ['b', 'conv.change'], ['b', 'conv.change']]);
    const event = f.events[4].m as Extract<shared.GatewayServerMessage, { t: 'conv.change' }>;
    assert.equal(event.created, true); assert.equal(event.message?.id, b.id);
    assert.ok(event.conversation && 'lastReadKey' in event.conversation); assert.equal(event.conversation.lastReadKey, 0);
    assert.deepEqual((await f.journal()).filter(r => r.user_id === 'b').map(r => [Number(r.pts), r.kind, r.message_id]),
      [[1, 'msg', a.id], [2, 'read', null], [3, 'msg', b.id]]);
    assert.equal(f.readPushes.length, pushBefore);
    assert.equal((await f.c.listConversations('b')).conversations.find(c => c.id === 'dm')?.unread, 1);
  } finally { await f.app.close(); assert.deepEqual(ioFailures, [], 'неожиданный IO не скрыт catch'); }
}

test('R235 ответ после двух входящих читает их, даёт ✓✓ собеседнику и гасит unread отправителя', async () => { await replyReads(); });
test('R235 придержанная отправка не читает входящее и не посылает события блокировщику', async () => { await withheldDoesNotRead(); });
test('R235 Избранное создаёт только msg, без read и read-sync push', async () => {
  const f = await fixture();
  try {
    const m = await f.send('a', 'для себя', 'saved');
    assert.deepEqual((await f.journal()).map(r => [r.user_id, Number(r.pts), r.kind, r.message_id]), [['a', 1, 'msg', m.id]]);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].user, 'a'); assert.equal(f.events[0].m.t, 'conv.change');
    assert.equal((f.events[0].m as Extract<shared.GatewayServerMessage, { t: 'conv.change' }>).message?.id, m.id);
    assert.equal(Number((await t.raw.query<{ last_read_key: number }>("SELECT last_read_key FROM conversation_members WHERE conversation_id='saved'")).rows[0].last_read_key), 0);
    assert.deepEqual(f.readPushes, []);
  } finally { await f.app.close(); assert.deepEqual(ioFailures, [], 'неожиданный IO не скрыт catch'); }
});
test('R235 повтор clientId не создаёт вторую read, событие или read-sync push', async () => {
  const f = await fixture();
  try {
    const clientId = randomUUID(); const m = await f.send('a', 'один раз', 'dm', clientId);
    const journal = await f.journal(); const events = [...f.events]; const pushes = [...f.readPushes]; const keys = await f.keys();
    const replay = await f.app.inject({ method: 'POST', url: '/conv/dm/messages', payload: { clientId, content: 'один раз' } });
    assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.json().id, m.id);
    assert.deepEqual(await f.journal(), journal); assert.deepEqual(f.events, events); assert.deepEqual(f.readPushes, pushes); assert.deepEqual(await f.keys(), keys);
    assert.deepEqual(journal.map(r => [r.user_id, Number(r.pts), r.kind]), [['a', 1, 'msg'], ['a', 2, 'read'], ['b', 1, 'msg'], ['b', 2, 'read']]);
  } finally { await f.app.close(); assert.deepEqual(ioFailures, [], 'неожиданный IO не скрыт catch'); }
});
test('R235 мутант без markRead после отправки убит ключом отправителя, не ошибкой загрузки', async () => {
  await replyReads(); const expected = { key: 0 };
  await assert.rejects(replyReads(['const read = await markRead(me, access, res.row.sortKey);', "const read = { kind: 'bad-key' as const };"], expected),
    e => e instanceof assert.AssertionError && e.message.startsWith('R235 send-read:') && e.operator === 'strictEqual' && e.actual === 0 && e.expected === expected.key && expected.key > 0);
});
test('R235 мутант без withheld-условия убит сдвигом read заблокированного отправителя', async () => {
  await withheldDoesNotRead(); const expected = { key: 0 };
  await assert.rejects(withheldDoesNotRead(['if (!access.saved && !plan.withheld) {', 'if (!access.saved) {'], expected),
    e => e instanceof assert.AssertionError && e.message.startsWith('R235 withheld:') && e.operator === 'strictEqual' && e.actual === expected.key && expected.key > 0 && e.expected === 0);
});
