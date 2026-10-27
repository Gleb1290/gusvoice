import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify, { type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import * as s from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as attRules from '../src/attachmentRules.js';
import * as groupRules from '../src/groupRules.js';
import { auditModules, type AuditEdit } from './auditDM.harness.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t?.close(); });
const OLD_FILE = '00000000-0000-4000-8000-000000000001';
const NEW_FILE = '00000000-0000-4000-8000-000000000002';
const LEFT = new Date('2026-10-20T12:00:00Z');
const fixtureKey = Buffer.from('not-a-secret-fixture-attachment-key');

async function fixture(edit?: AuditEdit) {
  await truncateAll(t.raw);
  await t.db.insert(s.users).values(['owner', 'old', 'new', 'outside'].map(id => ({ id, username: `audit_${id}`, displayName: id, passwordHash: 'fixture' })));
  await t.db.insert(s.conversations).values([
    { id: 'group', kind: 'group', createdBy: 'owner', title: 'Аудит', lastSortKey: 2 },
    { id: 'saved', kind: 'direct', directKey: 'new:new', createdBy: 'new' },
  ]);
  await t.db.insert(s.conversationMembers).values([
    { conversationId: 'group', userId: 'owner', role: 'owner' }, { conversationId: 'group', userId: 'old' },
    { conversationId: 'saved', userId: 'new' },
  ]);
  await t.db.insert(s.conversationMessages).values([
    { id: 'old-file', conversationId: 'group', authorId: 'owner', sortKey: 1, content: 'needle old file', createdAt: new Date(LEFT.getTime() - 1),
      attachments: [{ id: OLD_FILE, name: 'old.png', contentType: 'image/png', size: 1, url: '' }] },
    { id: 'old-text', conversationId: 'group', authorId: 'owner', sortKey: 2, content: 'needle old text', createdAt: LEFT },
  ]);
  await t.db.insert(s.attachments).values({ id: OLD_FILE, ownerId: 'owner', conversationId: 'group', messageId: 'old-file', state: 'attached',
    storageKey: OLD_FILE, name: 'old.png', contentType: 'image/png', size: 1 });
  const m = auditModules(t, edit);
  const rates: { key: string; max: number; seconds: number }[] = [];
  const counters = new Map<string, number>();
  let rateEnabled = false;
  const rateHit = async (key: string, max: number, seconds: number) => {
    rates.push({ key, max, seconds });
    if (!rateEnabled) return 0;
    const n = (counters.get(key) ?? 0) + 1; counters.set(key, n);
    return n > max ? seconds : 0;
  };
  const auth = { requireAuth: async (req: { headers: Record<string, unknown>; user?: unknown }) => { req.user = { sub: String(req.headers['x-test-user'] ?? 'new') }; } };
  // Все четыре пользователя fixture местные. preHandler читается уже при регистрации /conv/saved,
  // даже когда сценарий проверяет другой маршрут; тот же допуск нужен регистрации /conv/group.
  const guestGuard = { requireLocalUser: async () => {} };
  const guards = { rateHit, messageSendBlock: async () => 0, retryMessage: (seconds: number) => `wait ${seconds}`, clientIp: () => '192.0.2.1' };
  const link = (id: string, me: string, gen = 0) => `/att/${id}/${me}/${attRules.attSigExp(fixtureKey, id, me, gen, attRules.attLinkExpiry(Date.now()))}`;
  let reads = 0;
  const att = m.load<typeof import('../src/routes/att.js')>('routes/att', { ...m.common, zod: { z },
    '../attachmentRules.js': attRules, '../convRules.js': rules, '../conversations.js': m.c,
    '../db/index.js': { db: t.db }, '../db/schema.js': s, '../auth.js': auth, '../authGuard.js': guards,
    '../attachments.js': { attachmentLink: link,
      attachmentSigValid: (id: string, me: string, gen: number, sig: string) => attRules.attSigExpValid(fixtureKey, id, me, gen, sig, Date.now()),
      attachmentStore: { configured: () => true, stat: async () => ({ size: 1 }), get: async () => { reads++; return Readable.from(Buffer.from('x')); } },
    },
  });
  const conv = m.load<typeof import('../src/routes/conv.js')>('routes/conv', { ...m.common, zod: { z },
    '../db/index.js': { db: t.db }, '../db/schema.js': s, '../conversations.js': m.c, '../convRules.js': rules,
    '../auth.js': auth, '../authGuard.js': guards, '../guestGuard.js': guestGuard,
    './att.js': att, '../blocks.js': { blockedBy: async () => new Set() },
  });
  const mediaOps: string[] = [];
  const group = m.load<typeof import('../src/routes/convGroups.js')>('routes/convGroups', { ...m.common, zod: { z },
    '../db/index.js': { db: t.db }, '../db/schema.js': s, '../conversations.js': m.c, '../convGroups.js': m.groups,
    '../groupRules.js': groupRules, '../auth.js': auth, '../authGuard.js': guards,
    '../guestGuard.js': guestGuard,
    '../storage.js': { isSupportedImage: (mime: string) => mime === 'image/png',
      putMedia: async () => { mediaOps.push('put'); return '/fixture-new.png'; },
      removeOwnMedia: async (url: string) => { mediaOps.push(`remove:${url}`); },
    },
  });
  const app = Fastify();
  // IO граница парсера multipart: факт чтения потока фиксируется отдельно от записи публичного объекта.
  app.decorateRequest('file', (async () => { mediaOps.push('file'); return { mimetype: 'image/png', file: { truncated: false },
    toBuffer: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }; }) as unknown as FastifyRequest['file']);
  app.setErrorHandler((error, _req, reply) => error instanceof ZodError ? reply.code(400).send({ error: 'validation' }) : reply.send(error));
  await app.register(att.attRoutes); await app.register(conv.convRoutes); await app.register(group.convGroupRoutes);
  await app.ready();
  const headers = (me = 'new') => ({ 'x-test-user': me });
  return { ...m, app, headers, link, rates, counters, mediaOps, reads: () => reads,
    enableRate() { rateEnabled = true; counters.clear(); rates.length = 0; },
    async close() { await app.close(); m.assertIo(); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function forward(f: Fixture, id: string) {
  const access = await f.c.loadAccess('saved', 'new'); assert.ok(access);
  return f.c.forwardMessages('new', access, { clientId: randomUUID(), fromConversationId: 'group', messageIds: [id], withheld: false });
}
const forwardHttp = (f: Fixture, id: string) => f.app.inject({ method: 'POST', url: '/conv/saved/forward', headers: f.headers('new'),
  payload: { clientId: randomUUID(), fromConversationId: 'group', messageIds: [id] } });

test('R304 миграция 0156 сохраняет старым группам историю, но новая группа скрывает её по умолчанию', async () => {
  const raw = new PGlite();
  try {
    await raw.exec("CREATE TABLE conversations(id text PRIMARY KEY); CREATE TABLE conversation_members(user_id text); INSERT INTO conversations VALUES ('existing'); INSERT INTO conversation_members VALUES ('existing-member')");
    await raw.exec(readFileSync(new URL('../drizzle/0156_group_history.sql', import.meta.url), 'utf8'));
    await raw.exec("INSERT INTO conversations(id) VALUES ('new')");
    assert.deepEqual((await raw.query('SELECT id,history_for_new FROM conversations ORDER BY id')).rows,
      [{ id: 'existing', history_for_new: true }, { id: 'new', history_for_new: false }]);
    assert.deepEqual((await raw.query('SELECT history_from_key FROM conversation_members')).rows, [{ history_from_key: null }]);
  } finally { await raw.close(); }
});

async function historyScenario(visible: boolean, edit?: AuditEdit) {
  const f = await fixture(edit);
  try {
    assert.equal((await f.groups.setGroupHistory('owner', 'group', visible)).kind, visible ? 'ok' : 'same');
    assert.equal((await f.groups.addGroupMembers('owner', 'group', ['new'])).kind, 'ok');
    const member = (await t.raw.query<{ history_from_key: number | null }>("SELECT history_from_key FROM conversation_members WHERE conversation_id='group' AND user_id='new'")).rows[0];
    assert.equal(member.history_from_key === null, visible, 'R304 новая строка участника хранит границу истории');
    for (const me of ['new', 'old', 'owner']) {
      const allowed = me !== 'new' || visible;
      const history = await f.c.history(me, 'group', { limit: 30 }); assert.ok(history && history !== 'no-anchor');
      assert.equal(history.messages.some(m => m.id === 'old-text'), allowed, 'R304 старая лента следует границе истории');
      assert.equal((await f.c.searchConversation(me, 'group', '%needle%', undefined, 30))?.total, allowed ? 2 : 0);
      assert.equal((await f.c.sharedMedia(me, 'group', 'media', undefined, 30, false))?.messages.length, allowed ? 1 : 0);
      const around = await f.c.history(me, 'group', { limit: 30, around: 'old-text' });
      assert.equal(around === 'no-anchor', !allowed, 'R304 around не раскрывает ключ старой истории');
      const file = await f.app.inject({ method: 'GET', url: f.link(OLD_FILE, me) });
      assert.equal(file.statusCode, allowed ? 200 : 404, file.body);
      const detail = (await f.c.messagesFor(['old-text'], me)).get('old-text');
      assert.ok(detail); assert.equal('gone' in detail, !allowed);
    }
    assert.equal((await forward(f, 'old-text')).kind, visible ? 'created' : 'source-missing');
    const forwarded = await forwardHttp(f, 'old-text');
    assert.equal(forwarded.statusCode, visible ? 201 : 400, forwarded.body);
    const refusal = await f.app.inject({ method: 'PUT', url: '/conv/group/group/history', headers: f.headers('old'), payload: { visible: !visible } });
    assert.equal(refusal.statusCode, 403);
    assert.equal((await t.raw.query<{ history_for_new: boolean }>("SELECT history_for_new FROM conversations WHERE id='group'")).rows[0].history_for_new, visible);
  } finally { await f.close(); }
}
for (const visible of [false, true]) test(`R304 добавление в группу с историей ${visible ? 'видимой' : 'скрытой'} согласует ленту, поиск, медиа, around, файл и пересылку; старые участники не теряют историю`, () => historyScenario(visible));

test('R304 мутант записи historyFromKey теряет ограничение новой строки участника', async () => {
  await historyScenario(false);
  await assert.rejects(historyScenario(false, { file: 'convGroups', from: 'const historyFromKey = conv?.historyForNew ? null : lock.nextKey;', to: 'const historyFromKey = null;' }),
    e => e instanceof assert.AssertionError && e.message.startsWith('R304 новая строка участника хранит границу истории'));
});

test('R304 бывший участник получает файл и пересылает до выхода включительно, после выхода оба пути закрыты', async () => {
  const f = await fixture();
  try {
    await f.groups.setGroupHistory('owner', 'group', true); await f.groups.addGroupMembers('owner', 'group', ['new']);
    await t.raw.query("UPDATE conversation_members SET left_at=$1 WHERE conversation_id='group' AND user_id='new'", [LEFT.toISOString()]);
    await t.db.insert(s.conversationMessages).values([
      { id: 'after-file', conversationId: 'group', authorId: 'owner', sortKey: 4, content: 'после выхода', createdAt: new Date(LEFT.getTime() + 1),
        attachments: [{ id: NEW_FILE, name: 'new.png', contentType: 'image/png', size: 1, url: '' }] },
      { id: 'after-text', conversationId: 'group', authorId: 'owner', sortKey: 5, content: 'после выхода', createdAt: new Date(LEFT.getTime() + 1) },
    ]);
    await t.db.insert(s.attachments).values({ id: NEW_FILE, ownerId: 'owner', conversationId: 'group', messageId: 'after-file', state: 'attached', storageKey: NEW_FILE, name: 'new.png', contentType: 'image/png', size: 1 });
    assert.equal((await f.app.inject({ method: 'GET', url: f.link(OLD_FILE, 'new') })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'GET', url: f.link(NEW_FILE, 'new') })).statusCode, 404);
    assert.equal(f.reads(), 1, 'отказ не открывает поток хранилища');
    assert.equal((await forward(f, 'old-text')).kind, 'created');
    assert.equal((await forward(f, 'after-text')).kind, 'source-missing');
    const beforeHttp = await forwardHttp(f, 'old-text'); assert.equal(beforeHttp.statusCode, 201, beforeHttp.body);
    const afterHttp = await forwardHttp(f, 'after-text'); assert.equal(afterHttp.statusCode, 400, afterHttp.body);
    assert.deepEqual(afterHttp.json().missing, ['after-text']);
    assert.equal(await f.c.history('new', 'group', { limit: 30, former: true, around: 'after-text' }), 'no-anchor');
  } finally { await f.close(); }
});

test('R304 настоящий маршрут реакций отвергает текст и отсутствующий custom, четвёртая вытесняет старую только у поставившего', async () => {
  const f = await fixture();
  try {
    const react = (emoji: string, op = 'add') => f.app.inject({ method: 'POST', url: '/conv/group/messages/old-text/reactions', headers: f.headers('old'), payload: { emoji, op } });
    for (const emoji of ['lol', 'custom:missing']) assert.equal((await react(emoji)).statusCode, 400);
    assert.equal((await t.db.select().from(s.conversationMessageReactions)).length, 0);
    await t.db.insert(s.conversationMessageReactions).values({ messageId: 'old-text', userId: 'owner', emoji: '😎' });
    for (const [index, emoji] of ['👍', '❤', '🔥', '👨‍👩‍👧'].entries()) {
      const response = await react(emoji); assert.equal(response.statusCode, 204, response.body);
      await t.raw.query('UPDATE conversation_message_reactions SET created_at=$1 WHERE user_id=$2 AND emoji=$3', [new Date(LEFT.getTime() + index * 1000).toISOString(), 'old', emoji]);
    }
    const rows = await t.db.select().from(s.conversationMessageReactions);
    assert.deepEqual(rows.filter(r => r.userId === 'old').map(r => r.emoji).sort(), ['❤', '🔥', '👨‍👩‍👧'].sort());
    assert.equal(rows.some(r => r.userId === 'owner' && r.emoji === '😎'), true);
    assert.equal((await react('❤', 'remove')).statusCode, 204);
    // До аудита произвольные строки могли быть сохранены: удалить их можно и после ужесточения add.
    await t.db.insert(s.conversationMessageReactions).values({ messageId: 'old-text', userId: 'old', emoji: 'legacy text' });
    assert.equal((await react('legacy text', 'remove')).statusCode, 204);
    assert.equal((await t.db.select().from(s.conversationMessageReactions)).some(r => r.emoji === 'legacy text'), false);
    await t.db.insert(s.servers).values({ id: 'server', name: 'fixture', ownerId: 'owner' });
    await t.db.insert(s.serverEmojis).values({ id: 'exists', serverId: 'server', name: 'goose', url: '/goose.png' });
    assert.equal((await react('custom:exists')).statusCode, 204, 'существующий серверный эмодзи принимается');
  } finally { await f.close(); }
});

async function photoScenario(edit?: AuditEdit) {
  const f = await fixture(edit);
  try {
    await t.raw.exec("UPDATE conversations SET avatar_url='/fixture-old.png' WHERE id='group'");
    const denied = await f.app.inject({ method: 'POST', url: '/conv/group/group/photo', headers: f.headers('outside') });
    assert.equal(denied.statusCode, 404);
    assert.deepEqual(f.mediaOps, [], 'R304 чужое фото не читается и не загружается');
    const allowed = await f.app.inject({ method: 'POST', url: '/conv/group/group/photo', headers: f.headers('old') });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.deepEqual(f.mediaOps, ['file', 'put', 'remove:/fixture-old.png'], 'R304 замена удаляет только прежний объект');
    assert.equal((await t.raw.query<{ avatar_url: string }>("SELECT avatar_url FROM conversations WHERE id='group'")).rows[0].avatar_url, '/fixture-new.png');
  } finally { await f.close(); }
}
test('R304 фото группы проверяет участие до чтения multipart и заменяет фото с удалением прежнего объекта', () => photoScenario());
test('R304 мутант проверки фото после загрузки обнаруживается записью публичного объекта посторонним', async () => {
  await photoScenario();
  await assert.rejects(photoScenario({ file: 'routes/convGroups',
    from: "if (!access || access.kind !== 'group') return reply.code(404).send({ error: 'not found' });", to: '// ранний допуск удалён' }),
  e => e instanceof assert.AssertionError && e.message.startsWith('R304 чужое фото не читается и не загружается'));
});
test('R304 мутант без удаления старого фото обнаруживается незакрытым публичным объектом', async () => {
  await photoScenario();
  await assert.rejects(photoScenario({ file: 'routes/convGroups',
    from: "else if (prev?.avatarUrl && prev.avatarUrl !== url) void removeOwnMedia(prev.avatarUrl).catch(() => {});", to: '// старый объект оставлен' }),
  e => e instanceof assert.AssertionError && e.message.startsWith('R304 замена удаляет только прежний объект'));
});

test('R304 обновление ссылок отдаёт только доступные id: чужая группа, скрытая история и неизвестный UUID не раскрываются', async () => {
  const f = await fixture();
  try {
    await f.groups.addGroupMembers('owner', 'group', ['new']);
    const links = (me: string, ids: string[]) => f.app.inject({ method: 'POST', url: '/att/links', headers: f.headers(me), payload: { ids } });
    for (const me of ['outside', 'new']) {
      const response = await links(me, [OLD_FILE]); assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { links: {} });
    }
    const response = await links('old', [OLD_FILE, OLD_FILE, NEW_FILE, 'garbage']);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { links: { [OLD_FILE]: f.link(OLD_FILE, 'old') } });
    assert.equal(f.reads(), 0, 'обновление ссылки не читает файл хранилища');
    assert.equal((await links('old', Array.from({ length: 100 }, () => OLD_FILE))).statusCode, 200);
    assert.equal((await links('old', Array.from({ length: 101 }, () => OLD_FILE))).statusCode, 400);
    assert.equal((await links('old', [])).statusCode, 400);
    f.enableRate();
    for (let n = 0; n < 120; n++) assert.equal((await links('old', [OLD_FILE])).statusCode, 200);
    const limited = await links('old', [OLD_FILE]); assert.equal(limited.statusCode, 429); assert.equal(limited.headers['retry-after'], '60');
    assert.equal(f.rates.every(r => r.key === 'att-links:old' && r.max === 120 && r.seconds === 60), true);
  } finally { await f.close(); }
});

for (const [url, key, limit] of [['/conv?groups=1', 'conv-list:old', 30], ['/conv/group/messages', 'conv-history:old', 120]] as const)
  test(`R304 ${url} принимает ровно ${limit} чтений за 10 секунд, следующее ограничивает`, async () => {
    const f = await fixture();
    try {
      f.enableRate();
      for (let n = 0; n < limit; n++) {
        const result = await f.app.inject({ method: 'GET', url, headers: f.headers('old') });
        assert.equal(result.statusCode, 200, result.body);
      }
      const limited = await f.app.inject({ method: 'GET', url, headers: f.headers('old') });
      assert.equal(limited.statusCode, 429); assert.equal(limited.headers['retry-after'], '10');
      assert.equal(f.rates.every(r => r.key === key && r.max === limit && r.seconds === 10), true);
      assert.equal((await f.app.inject({ method: 'GET', url, headers: f.headers('owner') })).statusCode, 200, 'лимит другого человека независим');
      f.counters.clear();
      assert.equal((await f.app.inject({ method: 'GET', url, headers: f.headers('old') })).statusCode, 200, 'новое окно допускает чтение');
    } finally { await f.close(); }
  });

async function anchorScenario(edit?: AuditEdit) {
  const f = await fixture(edit);
  try {
    await t.raw.exec("UPDATE conversation_messages SET hidden_for=ARRAY['old'] WHERE id='old-text'");
    assert.equal(await f.c.history('old', 'group', { limit: 30, around: 'old-text' }), 'no-anchor', 'R304 скрытый якорь не раскрывает ключ');
    assert.equal((await f.app.inject({ method: 'GET', url: '/conv/group/messages?around=old-text', headers: f.headers('old') })).statusCode, 404);
    const own = await f.c.history('owner', 'group', { limit: 30, around: 'old-text' }); assert.ok(own && own !== 'no-anchor');
    assert.ok(own.messages.some(m => m.id === 'old-text'));
  } finally { await f.close(); }
}
test('R304 around скрытого у меня сообщения возвращает no-anchor и HTTP 404, другому участнику якорь доступен', () => anchorScenario());
test('R304 мутант поиска якоря без vis раскрывает скрытый ключ в настоящем SQL', async () => {
  await anchorScenario();
  await assert.rejects(anchorScenario({ file: 'conversations', from: '.where(and(eq(conversationMessages.id, qy.around), vis));',
    to: '.where(eq(conversationMessages.id, qy.around));' }),
  e => e instanceof assert.AssertionError && e.message.startsWith('R304 скрытый якорь не раскрывает ключ'));
});

async function deliveryScenario(edit?: AuditEdit) {
  const f = await fixture(edit);
  try {
    f.resetSummaryReads(); f.events.length = 0;
    await f.c.deliver({ conversationId: 'group', messageId: 'old-text',
      pts: new Map([['owner', 1], ['old', 1]]), pinPts: new Map([['owner', 2], ['old', 2]]), schedPts: new Map([['owner', 3], ['old', 3]]) });
    f.assertIo();
    assert.equal(f.events.length, 6, 'все три вида изменений доставлены обоим');
    assert.equal(f.summaryReads(), 2, 'R304 одна SQL сводка на человека в доставке');
    for (const user of ['owner', 'old']) {
      const values = f.events.filter(e => e.user === user).map(e => e.value) as Array<{ pts: number; conversation: { id: string }; pins?: unknown; scheduled?: unknown }>;
      assert.deepEqual(values.map(v => v.pts), [1, 2, 3]);
      assert.equal(values.every(v => v.conversation.id === 'group'), true);
    }
    // Кеш живёт одну доставку, иначе новое состояние беседы не обновилось бы.
    await f.c.deliver({ conversationId: 'group', messageId: 'old-text', pts: new Map([['owner', 4]]) });
    assert.equal(f.summaryReads(), 3);
  } finally { await f.close(); }
}
test('R304 доставка совмещённых msg/pins/scheduled вычисляет сводку один раз на человека, следующая доставка перечитывает', () => deliveryScenario());
test('R304 мутант без кеша сводок обнаруживается шестью SQL чтениями вместо двух', async () => {
  await deliveryScenario();
  await assert.rejects(deliveryScenario({ file: 'conversations', from: 'summaries.set(userId, p);', to: '// кеш удалён' }),
    e => e instanceof assert.AssertionError && e.message.startsWith('R304 одна SQL сводка на человека в доставке'));
});
