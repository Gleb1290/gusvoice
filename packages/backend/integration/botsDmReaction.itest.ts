import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import { asc, eq } from 'drizzle-orm';
import * as s from '../src/db/schema.js';
import * as botRules from '../src/bots/botRules.js';
import * as attachmentRules from '../src/attachmentRules.js';
import { createTestDb, type TestDb } from './harness.js';
import { serverFixture, type Phase3Edit } from './botsServers.harness.js';

let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });
const normal = <T>(x: T): T => JSON.parse(JSON.stringify(x));

async function fixture(edit?: Phase3Edit) {
  const events: { user: string; body: any }[] = [], unexpected: string[] = [];
  const fail = (name: string) => (..._args: unknown[]): never => { unexpected.push(name); throw new Error(`R303 неописанный IO ${name}`); };
  const f = await serverFixture(db, edit, {
    real: ['conversations', 'bots/botUpdates', 'routes/botApi'],
    values: {
      util: { id: crypto.randomUUID, uuidv7: crypto.randomUUID }, dmWriteBarrier: { dmWriteBarrier: {} }, attachmentRules,
      attachments: { DailyQuotaError: class extends Error {}, attachmentStore: {}, attachmentLink: fail('attachmentLink'),
        privateAttachmentsReady: fail('private storage'), createPending: fail('upload'), copyForForward: fail('copy forward'),
        discardForwardCopies: fail('discard forward'), purgeDeleted: fail('purge') },
      blocks: { isBlockedBy: fail('blocks') }, convSendFanout: { fanOutSend: fail('fanout') },
      'bots/botRead': { markTakenRead: fail('mark read') },
      authGuard: { clientIp: () => '192.0.2.1', rateHit: async () => 0, attachmentUploadBlock: fail('upload rate'),
        pushDebounced: async () => false },
      gateway: { relayBotTyping: fail('typing') }, safeFetch: { checkHookTarget: fail('webhook DNS'), hookUrlErrorEn: fail('webhook URL') },
      realtime: { publishToUser: async (user: string, body: unknown) => { events.push({ user, body: normal(body) }); },
        publishToServer: async () => {}, publishToChannel: fail('channel event'), redisPub: { publish: async () => 1 } },
      'bots/webhookDelivery': { kickWebhook: () => {}, resetWebhookRetry: fail('webhook reset'), startBotJobs: fail('background jobs') },
    },
  });
  const conv = f.load('conversations') as typeof import('../src/conversations.js');
  const api = f.load('routes/botApi') as typeof import('../src/routes/botApi.js');
  const app = Fastify(); app.decorateRequest('isMultipart', () => false);
  await app.register(api.botApiRoutes); await app.ready();
  // Синтетический маркер в ТОЙ ЖЕ очереди, а не sleep/угадывание числа microtask:
  // он завершается только после всех recordBotUpdates, поставленных до него.
  let fence: (() => void) | undefined;
  const hooks = conv.botConv(); assert.ok(hooks);
  conv.configureBotConv({ ...hooks, chatMember: async () => { assert.ok(fence); const done = fence; fence = undefined; done(); } });
  const flush = async () => {
    const done = new Promise<void>(resolve => { fence = resolve; });
    conv.queueBotChatMember('bot', 'owner', 'dm', 'member'); await done;
  };
  await f.bot();
  const token = botRules.newBotToken();
  await db.db.update(s.bots).set({ tokenHash: botRules.hashBotToken(token) }).where(eq(s.bots.userId, 'bot'));
  await db.db.insert(s.conversations).values({ id: 'dm', kind: 'direct', directKey: 'bot:owner', createdBy: 'owner', lastSortKey: 10,
    lastMessageAt: new Date('2026-10-01T10:00:00Z') });
  await db.db.insert(s.conversationMembers).values(['owner', 'bot'].map(userId => ({ conversationId: 'dm', userId })));
  await db.db.insert(s.conversationMessages).values({ id: 'dm-message', conversationId: 'dm', authorId: 'bot', sortKey: 10, content: 'Погода ясная' });
  const react = async (emoji: string, op: 'add' | 'remove') => {
    const access = await conv.loadAccess('dm', 'owner'); assert.ok(access);
    const result = await conv.reactMessage('owner', access, 'dm-message', emoji, op, new Set());
    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') await conv.deliver(result.delivery ? { ...result.delivery, reaction: { userId: 'owner', emoji, op } } : null);
    await flush();
  };
  const request = (reaction: unknown[]) => app.inject({ method: 'POST', url: '/bot/v1/setMessageReaction', headers: { authorization: `Bot ${token}` },
    payload: { chat_id: 'dm', message_id: 'dm-message', reaction } });
  return { ...f, conv, events, react, request, flush,
    journal: () => db.db.select().from(s.botUpdates).orderBy(asc(s.botUpdates.updateId)),
    async clean() { await flush(); await app.close(); await f.clean(); assert.deepEqual(unexpected, []); } };
}

async function humanProbe(edit?: Phase3Edit) {
  const f = await fixture(edit);
  try {
    await f.react('❤', 'add'); await f.react('👍', 'add');
    const rows = await f.journal(); assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.type), ['message_reaction', 'message_reaction']);
    const first = normal(rows[0].payload) as any, second = normal(rows[1].payload) as any;
    assert.deepEqual(first.old_reaction, []); assert.deepEqual(first.new_reaction, [{ type: 'emoji', emoji: '❤' }]);
    assert.deepEqual(second.old_reaction, [{ type: 'emoji', emoji: '❤' }], 'R303 старый набор реакции не включает только что добавленную');
    assert.deepEqual(second.new_reaction, [{ type: 'emoji', emoji: '❤' }, { type: 'emoji', emoji: '👍' }]);
    assert.equal(second.chat.type, 'dm'); assert.equal(second.chat.id, 'dm'); assert.equal(second.message_id, 'dm-message');
    assert.equal(second.user.id, 'owner'); assert.equal(typeof second.date, 'number');
    await f.react('👍', 'remove');
    const removed = (await f.journal())[2].payload as any;
    assert.deepEqual(removed.old_reaction, [{ type: 'emoji', emoji: '❤' }, { type: 'emoji', emoji: '👍' }]);
    assert.deepEqual(removed.new_reaction, [{ type: 'emoji', emoji: '❤' }]);
  } finally { await f.clean(); }
}
test('R303 реакция человека на сообщение бота в ЛС пишет message_reaction с наборами до добавления и после снятия', () => humanProbe());
test('R303 setMessageReaction в ЛС заменяет только реакции бота, шлёт человеку conv.change и не возвращается боту эхом', async () => {
  const f = await fixture();
  try {
    await f.react('❤', 'add'); const before = (await f.journal()).length; f.events.length = 0;
    const response = await f.request([{ type: 'emoji', emoji: '👍' }, { type: 'emoji', emoji: '🔥' }]);
    assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { ok: true, result: true }); await f.flush();
    const reactions = await db.db.select().from(s.conversationMessageReactions).orderBy(asc(s.conversationMessageReactions.emoji));
    assert.deepEqual(reactions.filter(r => r.userId === 'owner').map(r => r.emoji), ['❤']);
    assert.deepEqual(reactions.filter(r => r.userId === 'bot').map(r => r.emoji).sort(), ['👍', '🔥'].sort());
    const changed = f.events.filter(e => e.user === 'owner' && e.body.t === 'conv.change'); assert.equal(changed.length, 2);
    assert.equal(changed[1].body.conversation.id, 'dm'); assert.equal(changed[1].body.message.id, 'dm-message');
    assert.deepEqual(changed[1].body.message.reactions.map((r: any) => r.emoji).sort(), ['❤', '👍', '🔥'].sort());
    assert.equal((await f.journal()).length, before, 'свои реакции не создают message_reaction самому боту');
    f.events.length = 0;
    const cleared = await f.request([]); assert.equal(cleared.statusCode, 200, cleared.body); await f.flush();
    assert.equal((await db.db.select().from(s.conversationMessageReactions).where(eq(s.conversationMessageReactions.userId, 'bot'))).length, 0);
    assert.equal(f.events.filter(e => e.user === 'owner' && e.body.t === 'conv.change').length, 2);
    assert.equal((await f.journal()).length, before);
  } finally { await f.clean(); }
});
test('R303 повтор того же набора реакций идемпотентен: без новой строки, pts, conv.change и самособытия', async () => {
  const f = await fixture();
  try {
    const desired = [{ type: 'emoji', emoji: '👍' }];
    assert.equal((await f.request(desired)).statusCode, 200); await f.flush();
    const pts = await db.db.select().from(s.userSync).orderBy(asc(s.userSync.userId)); f.events.length = 0;
    assert.equal((await f.request(desired)).statusCode, 200); await f.flush();
    assert.deepEqual(await db.db.select().from(s.userSync).orderBy(asc(s.userSync.userId)), pts);
    assert.equal((await db.db.select().from(s.conversationMessageReactions)).length, 1); assert.deepEqual(f.events, []); assert.deepEqual(await f.journal(), []);
  } finally { await f.clean(); }
});
test('R303 маршрут реакции человека передаёт действовавшего и операцию настоящей доставке боту', () => {
  const source = readFileSync(new URL('../src/routes/conv.ts', import.meta.url), 'utf8');
  assert.equal(source.split('await deliver(res.delivery ? { ...res.delivery, reaction: { userId: me, emoji, op } } : null);').length - 1, 1);
});
test('R303 контрфакт old_reaction равен новому набору ловится точным различием двух реакций', async () => {
  const edit = { file: 'bots/botUpdates', from: "const before = r.op === 'add' ? now.filter((e) => e !== r.emoji) : [...now, r.emoji];", to: 'const before = now;' };
  // Проверяем только второе добавление: первое тоже отличается, но даёт другой предмет ошибки.
  async function probe(mutation?: Phase3Edit) {
    const f = await fixture(mutation);
    try {
      await f.react('❤', 'add'); await f.react('👍', 'add');
      const payload = normal((await f.journal())[1].payload) as any;
      assert.deepEqual(payload.old_reaction, [{ type: 'emoji', emoji: '❤' }], 'R303 старый набор реакции не включает только что добавленную');
    } finally { await f.clean(); }
  }
  await probe();
  await assert.rejects(() => probe(edit), (e: unknown) => e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION' && e.operator === 'deepStrictEqual' &&
    e.message.split(/\r?\n/)[0] === 'R303 старый набор реакции не включает только что добавленную' &&
    JSON.stringify(e.actual) === JSON.stringify([{ type: 'emoji', emoji: '❤' }, { type: 'emoji', emoji: '👍' }]) &&
    JSON.stringify(e.expected) === JSON.stringify([{ type: 'emoji', emoji: '❤' }]));
});
