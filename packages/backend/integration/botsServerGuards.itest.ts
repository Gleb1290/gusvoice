import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import Fastify, { type FastifyReply, type FastifyRequest, type InjectOptions } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { Permission as P } from '@gusvoice/shared';
import * as s from '../src/db/schema.js';
import { BOT_ADMIN_FORBIDDEN } from '../src/roleRules.js';
import { createTestDb, type TestDb } from './harness.js';
import { serverFixture, type Phase3Edit } from './botsServers.harness.js';

let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });
const normal = <T>(x: T): T => JSON.parse(JSON.stringify(x));

async function fixture(edit?: Phase3Edit, realConversations = false) {
  const unexpected: string[] = [], callbacks: Record<string, unknown>[] = [], pendingKeys: string[] = [], released: string[] = [];
  const fail = (name: string) => (..._args: unknown[]): never => { unexpected.push(name); throw new Error(`R303 неописанный IO ${name}`); };
  const dormant = (name: string) => new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : fail(`${name}.${String(key)}`) });
  const values: Record<string, unknown> = {
    'federation/directoryEvents': { announceServer: fail('announceServer') },
    'federation/guestAccess': { guestAccessRefusal: fail('guestAccessRefusal') },
    'federation/instanceBan': { sendReport: fail('sendReport'), REPORT_EVIDENCE_MAX: 10 },
    'federation/links': { getLink: fail('getLink') }, 'federation/guestRules': { GUESTS_ROLE_NAME: 'Гости' },
    telegram: { telegramConfigured: () => false }, unread: { serverListExtras: fail('serverListExtras') }, stickerCatalog: dormant('stickerCatalog'),
    storage: { isSupportedImage: fail('image'), putMedia: fail('upload') },
    conversations: { loadAccess: fail('DM loadAccess'), messageFor: fail('DM messageFor') },
    guestGuard: { requireLocalUser: async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.user?.sub === 'guest') return reply.code(403).send({ error: 'local users only' });
    } },
    'bots/botCallback': {
      acquirePending: async (key: string) => { pendingKeys.push(key); return true; },
      releasePending: async (key: string) => { released.push(key); },
      createCallbackQuery: async (record: Record<string, unknown>) => { callbacks.push(record); return 'callback-id'; },
      waitCallbackAnswer: async () => ({ text: 'Принято' }),
    },
  };
  const real = ['routes/roles', 'routes/servers', 'routes/channels', 'routes/botPress'];
  if (realConversations) {
    // GET карточки ЛС проходит настоящий loadAccess по SQL-членству, без готового ответа доступа в заглушке.
    delete values.conversations;
    real.push('conversations');
    values.dmWriteBarrier = { dmWriteBarrier: {} };
    values.util = { id: crypto.randomUUID, uuidv7: crypto.randomUUID };
    values.attachments = { DailyQuotaError: class extends Error {}, attachmentStore: {}, attachmentLink: fail('private attachment link'),
      copyForForward: fail('copy forward'), discardForwardCopies: fail('discard forward'), privateAttachmentsReady: fail('private storage'), purgeDeleted: fail('purge') };
  }
  const f = await serverFixture(db, edit, { real, values });
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { statusCode?: number; message?: string }; return reply.code(e.statusCode ?? 500).send({ error: e.message ?? String(e) });
  });
  await app.register(f.load('routes/roles').roleRoutes);
  await app.register(f.load('routes/servers').serverRoutes);
  await app.register(f.load('routes/channels').channelRoutes);
  await app.register(f.load('routes/botPress').botPressRoutes);
  await app.ready();
  const request = (options: InjectOptions, actor = 'owner') => app.inject({ ...options, headers: { ...options.headers, 'x-user': actor } });
  const setupBot = async () => {
    await f.bot(); const added = await f.add('bot'); assert.equal(added.statusCode, 201, added.body);
    const [role] = await db.db.select().from(s.roles).where(eq(s.roles.managedBotId, 'bot')); assert.ok(role); return role;
  };
  const message = async () => {
    await setupBot();
    await db.db.update(s.roles).set({ permissions: String(P.VIEW_CHANNEL) }).where(eq(s.roles.id, 'everyone'));
    await db.db.insert(s.messages).values({ id: 'button-message', channelId: 'channel', authorId: 'bot', content: 'Кнопка',
      keyboard: [[{ text: 'Принять', callback_data: 'accept' }]] });
  };
  const callback = (data = 'accept', actor = 'person', channel = 'channel') => request({ method: 'POST',
    url: `/channels/${channel}/messages/button-message/callback`, payload: { data } }, actor);
  return { ...f, app, request, setupBot, message, callback, callbacks, pendingKeys, released,
    async clean() { await app.close(); await f.clean(); assert.deepEqual(unexpected, []); } };
}

async function deleteProbe(edit?: Phase3Edit) {
  const f = await fixture(edit);
  try {
    const role = await f.setupBot();
    const denied = await f.request({ method: 'DELETE', url: `/roles/${role.id}` });
    assert.equal(denied.statusCode, 400, 'R303 удаление управляемой роли отклонено');
    assert.deepEqual(denied.json(), { error: 'Роль бота удаляется вместе с ботом' });
    assert.equal((await db.db.select().from(s.roles).where(eq(s.roles.id, role.id))).length, 1);
    await db.db.insert(s.roles).values({ id: 'ordinary', serverId: 'server', name: 'Друзья', position: 1 });
    const allowed = await f.request({ method: 'DELETE', url: '/roles/ordinary' }); assert.equal(allowed.statusCode, 204, allowed.body);
    assert.equal((await db.db.select().from(s.roles).where(eq(s.roles.id, 'ordinary'))).length, 0);
  } finally { await f.clean(); }
}
test('R303 DELETE управляемой роли запрещён даже владельцу, обычная роль удаляется', () => deleteProbe());
test('R303 управляемая роль не выдаётся и не снимается вручную, обычная роль проходит оба маршрута', async () => {
  const f = await fixture();
  try {
    const role = await f.setupBot();
    for (const [method, user] of [['PUT', 'person'], ['DELETE', 'bot']] as const) {
      const response = await f.request({ method, url: `/servers/server/members/${user}/roles/${role.id}` });
      assert.equal(response.statusCode, 400, response.body); assert.deepEqual(response.json(), { error: 'Роль бота выдаётся только ему' });
    }
    assert.deepEqual((await db.db.select().from(s.memberRoles).where(eq(s.memberRoles.roleId, role.id))).map(r => r.userId), ['bot']);
    await db.db.insert(s.roles).values({ id: 'ordinary', serverId: 'server', name: 'Друзья', position: 1 });
    const url = '/servers/server/members/person/roles/ordinary';
    assert.equal((await f.request({ method: 'PUT', url })).statusCode, 204);
    assert.equal((await db.db.select().from(s.memberRoles).where(eq(s.memberRoles.roleId, 'ordinary'))).length, 1);
    assert.equal((await f.request({ method: 'DELETE', url })).statusCode, 204);
    assert.equal((await db.db.select().from(s.memberRoles).where(eq(s.memberRoles.roleId, 'ordinary'))).length, 0);
  } finally { await f.clean(); }
});
async function administratorProbe(edit?: Phase3Edit) {
  const f = await fixture(edit);
  try {
    const role = await f.setupBot(); const before = role.permissions;
    const response = await f.request({ method: 'PATCH', url: `/roles/${role.id}`, payload: { permissions: String(P.ADMINISTRATOR | P.VIEW_CHANNEL) } });
    assert.equal(response.statusCode, 400, 'R303 ADMINISTRATOR управляемой роли запрещён владельцу');
    assert.deepEqual(response.json(), { error: BOT_ADMIN_FORBIDDEN });
    assert.equal((await db.db.select().from(s.roles).where(eq(s.roles.id, role.id)))[0].permissions, before);
    const allowed = await f.request({ method: 'PATCH', url: `/roles/${role.id}`, payload: { permissions: String(P.VIEW_CHANNEL | P.SEND_MESSAGES) } });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal((await db.db.select().from(s.roles).where(eq(s.roles.id, role.id)))[0].permissions, String(P.VIEW_CHANNEL | P.SEND_MESSAGES));
  } finally { await f.clean(); }
}
test('R303 PATCH управляемой роли не принимает ADMINISTRATOR даже от владельца, обычные права менять можно', () => administratorProbe());
test('R303 сервер нельзя передать боту, но можно человеку-участнику', async () => {
  const f = await fixture();
  try {
    await f.setupBot(); const response = await f.request({ method: 'POST', url: '/servers/server/transfer', payload: { newOwnerId: 'bot' } });
    assert.equal(response.statusCode, 400); assert.deepEqual(response.json(), { error: 'бот не может быть владельцем сервера' });
    assert.equal((await db.db.select().from(s.servers))[0].ownerId, 'owner');
    const allowed = await f.request({ method: 'POST', url: '/servers/server/transfer', payload: { newOwnerId: 'person' } });
    assert.equal(allowed.statusCode, 204, allowed.body); assert.equal((await db.db.select().from(s.servers))[0].ownerId, 'person');
  } finally { await f.clean(); }
});
test('R303 бот не назначается генералом голосового канала, человек назначается и снимается', async () => {
  const f = await fixture();
  try {
    await f.setupBot(); const url = '/channels/voice/general';
    const response = await f.request({ method: 'PUT', url, payload: { userId: 'bot' } });
    assert.equal(response.statusCode, 400); assert.deepEqual(response.json(), { error: 'бот не может быть генералом канала' });
    for (const userId of ['person', null]) {
      const allowed = await f.request({ method: 'PUT', url, payload: { userId } }); assert.equal(allowed.statusCode, 200, allowed.body);
      assert.equal((await db.db.select().from(s.channels).where(eq(s.channels.id, 'voice')))[0].generalUserId, userId);
    }
  } finally { await f.clean(); }
});

test('R303 скрытый канал и сообщение другого канала дают callback 404, событий боту нет', async () => {
  const f = await fixture();
  try {
    await f.message();
    await db.db.insert(s.channelOverwrites).values({ channelId: 'channel', targetType: 'member', targetId: 'person', allow: '0', deny: String(P.VIEW_CHANNEL) });
    assert.equal((await f.callback()).statusCode, 404);
    assert.equal((await f.callback('accept', 'owner', 'other-channel')).statusCode, 404);
    assert.equal((await db.db.select().from(s.botUpdates)).length, 0); assert.deepEqual(f.callbacks, []);
  } finally { await f.clean(); }
});
test('R303 кнопка оставшегося сообщения удалённого с сервера бота даёт 403, журнал пуст', async () => {
  const f = await fixture();
  try {
    await f.message(); await db.db.delete(s.serverBots).where(eq(s.serverBots.botId, 'bot'));
    const response = await f.callback(); assert.equal(response.statusCode, 403); assert.deepEqual(response.json(), { error: 'Бот удалён с сервера' });
    assert.equal((await db.db.select().from(s.botUpdates)).length, 0); assert.deepEqual(f.callbacks, []);
  } finally { await f.clean(); }
});
async function staleProbe(edit?: Phase3Edit) {
  const f = await fixture(edit);
  try {
    await f.message(); const response = await f.callback('forged');
    assert.equal(response.statusCode, 409, 'R303 данные вне текущей клавиатуры отклонены');
    assert.deepEqual(response.json(), { error: 'stale_button' });
    assert.equal((await db.db.select().from(s.botUpdates)).length, 0); assert.deepEqual(f.pendingKeys, []);
    const valid = await f.callback(); assert.equal(valid.statusCode, 200, valid.body); assert.deepEqual(valid.json(), { text: 'Принято' });
    const [event] = await db.db.select().from(s.botUpdates); assert.equal(event.type, 'callback_query');
    const payload = event.payload as any; assert.equal(payload.data, 'accept'); assert.equal(payload.message.chat.type, 'channel');
    assert.equal(payload.message.chat.id, 'channel'); assert.equal(payload.message.chat.server_id, 'server');
    assert.equal(payload.message.message_id, 'button-message'); assert.equal(payload.from.id, 'person');
    assert.deepEqual(f.released.sort(), ['b:bot', 'u:person']);
  } finally { await f.clean(); }
}
test('R303 подделанные data дают 409 до acquirePending, корректная кнопка пишет callback_query канала', () => staleProbe());
test('R303 гость-сосед нажимает канальную кнопку с домашним ником и instance_domain, запрет местного DM не применяется', async () => {
  const f = await fixture();
  try {
    await f.message();
    await db.db.insert(s.users).values({ id: 'guest', username: 'shadow-guest', displayName: 'Гость', passwordHash: 'synthetic-unused', verified: true,
      homeInstanceId: 'neighbor', homeUserId: 'remote-user', homeUsername: 'same-name' });
    await db.db.insert(s.serverMembers).values({ serverId: 'server', userId: 'guest' });
    await db.db.insert(s.roles).values({ id: 'guests', serverId: 'server', name: 'Гости', isGuests: true, permissions: String(P.VIEW_CHANNEL) });
    const dm = await f.request({ method: 'GET', url: '/conv/not-a-conversation/bot' }, 'guest');
    assert.equal(dm.statusCode, 403, 'положительная проверка реальности локального стража в соседней ветке');
    const response = await f.callback('accept', 'guest'); assert.equal(response.statusCode, 200, response.body);
    const [event] = await db.db.select().from(s.botUpdates).orderBy(asc(s.botUpdates.updateId));
    const payload = event.payload as any;
    assert.equal(payload.from.id, 'guest'); assert.equal(payload.from.username, 'same-name'); assert.equal(payload.from.instance_domain, 'neighbor.invalid');
    assert.equal(payload.message.chat.type, 'channel'); assert.equal(f.callbacks[0].serverId, 'server');
  } finally { await f.clean(); }
});

test('R303 GET ботов видимого канала исключает невидимых, выключенных, удалённых и не состоящих на сервере; скрытый канал даёт 404', async () => {
  const f = await fixture();
  try {
    await f.setupBot();
    for (const id of ['hidden', 'disabled', 'deleted']) {
      await f.bot(id); const added = await f.add(id); assert.equal(added.statusCode, 201, added.body);
    }
    await f.bot('notmember');
    await db.db.update(s.roles).set({ permissions: String(P.VIEW_CHANNEL) }).where(eq(s.roles.id, 'everyone'));
    await db.db.insert(s.channelOverwrites).values({ channelId: 'channel', targetType: 'member', targetId: 'hidden', allow: '0', deny: String(P.VIEW_CHANNEL) });
    await db.db.update(s.bots).set({ disabledAt: new Date() }).where(eq(s.bots.userId, 'disabled'));
    await db.db.update(s.users).set({ deletedAt: new Date() }).where(eq(s.users.id, 'deleted'));
    const get = (actor = 'person') => f.request({ method: 'GET', url: '/channels/channel/bots' }, actor);
    const visible = await get(); assert.equal(visible.statusCode, 200, visible.body);
    assert.deepEqual(visible.json().bots.map((b: any) => b.id), ['bot']);
    assert.deepEqual(visible.json().bots[0], { id: 'bot', username: 'botbot', displayName: 'bot', avatarUrl: null, commands: [] });
    await db.db.insert(s.channelOverwrites).values({ channelId: 'channel', targetType: 'member', targetId: 'person', allow: '0', deny: String(P.VIEW_CHANNEL) });
    const hidden = await get(); assert.equal(hidden.statusCode, 404); assert.deepEqual(hidden.json(), { error: 'Не найдено' });
    assert.equal((await get('outsider')).statusCode, 404);
    const settings = await f.store.readBotSettings(); await f.store.writeBotSettings({ ...settings, enabled: false });
    const off = await get('owner'); assert.equal(off.statusCode, 200, off.body); assert.deepEqual(off.json(), { bots: [] });
    await f.store.writeBotSettings({ ...settings, enabled: true });
    assert.deepEqual((await get('owner')).json().bots.map((b: any) => b.id), ['bot'], 'включение возвращает живого бота, не остальных');
    await db.db.update(s.bots).set({ disabledAt: new Date() }).where(eq(s.bots.userId, 'bot'));
    const lastOff = await get('owner'); assert.equal(lastOff.statusCode, 200, lastOff.body); assert.deepEqual(lastOff.json(), { bots: [] });
  } finally { await f.clean(); }
});

async function commandScopesProbe(edit?: Phase3Edit) {
  const f = await fixture(edit, true);
  try {
    await f.setupBot();
    await db.db.insert(s.conversations).values({ id: 'scope-dm', kind: 'direct', directKey: 'bot:owner', createdBy: 'owner' });
    await db.db.insert(s.conversationMembers).values(['owner', 'bot'].map(userId => ({ conversationId: 'scope-dm', userId })));
    const defaults = [{ command: 'default_only', description: 'Общая команда' }];
    const privateCommands = [{ command: 'private_only', description: 'Только ЛС' }];
    const groupCommands = [{ command: 'group_only', description: 'Только серверы' }];
    await f.store.setBotCommands('bot', defaults);
    await f.store.setBotCommands('bot', privateCommands, 'all_private_chats');
    await f.store.setBotCommands('bot', groupCommands, 'all_group_chats');
    const channel = async () => {
      const response = await f.request({ method: 'GET', url: '/channels/channel/bots' });
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().bots.length, 1);
      return response.json().bots[0].commands as Array<{ command: string; description: string }>;
    };
    const dm = async () => {
      const response = await f.request({ method: 'GET', url: '/conv/scope-dm/bot' });
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().id, 'bot');
      return response.json().commands as Array<{ command: string; description: string }>;
    };
    assert.equal((await channel()).map(c => c.command).join(','), 'group_only', 'R303 канал берёт серверную область команд, не приватную');
    assert.deepEqual(await channel(), groupCommands); assert.deepEqual(await dm(), privateCommands);
    await f.store.setBotCommands('bot', null, 'all_group_chats');
    assert.deepEqual(await channel(), defaults); assert.deepEqual(await dm(), privateCommands, 'снятие групповой области не меняет ЛС');
    await f.store.setBotCommands('bot', null, 'all_private_chats');
    assert.deepEqual(await dm(), defaults); assert.deepEqual(await channel(), defaults);
    await f.store.setBotCommands('bot', [], 'all_group_chats'); await f.store.setBotCommands('bot', [], 'all_private_chats');
    assert.deepEqual(await channel(), [], 'явно пустая область не возвращает команды default'); assert.deepEqual(await dm(), []);
  } finally { await f.clean(); }
}
test('R303 настоящий store и GET выбирают group-команды каналу, private-команды ЛС и default после удаления области', () => commandScopesProbe());
test('R303 контрфакт канального commandsFor с dm-областью ловит точную подмену списка', async () => {
  await commandScopesProbe();
  await assert.rejects(() => commandScopesProbe({ file: 'routes/botPress', from: "commandsFor(b, 'server')", to: "commandsFor(b, 'dm')" }),
    (e: unknown) => e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION' && e.operator === 'strictEqual' &&
      e.message.split(/\r?\n/)[0] === 'R303 канал берёт серверную область команд, не приватную' && e.actual === 'private_only' && e.expected === 'group_only');
});

for (const [name, file, from, to, probe, message, actual, expected] of [
  ['нет запрета удаления роли бота', 'routes/roles', "if (role.managedBotId) return reply.code(400).send({ error: 'Роль бота удаляется вместе с ботом' });", '', deleteProbe,
    'R303 удаление управляемой роли отклонено', 204, 400],
  ['ADMINISTRATOR проверяется только при добавлении', 'routes/roles', 'role.managedBotId && body.permissions !== undefined && botAdminRequested', 'false && body.permissions !== undefined && botAdminRequested', administratorProbe,
    'R303 ADMINISTRATOR управляемой роли запрещён владельцу', 200, 400],
  ['клавиатура не проверяется', 'routes/botPress', "if (!keyboardHasData(msg.keyboard, data)) return reply.code(409).send({ error: 'stale_button' });", '', staleProbe,
    'R303 данные вне текущей клавиатуры отклонены', 200, 409],
] as const) test(`R303 контрфакт: ${name}`, async () => {
  await probe();
  // В botPress такой страж есть и для ЛС; якорь уточнён соседним комментарием канальной ветки.
  const raw = readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const edit = file === 'routes/botPress' ? { file, from: `// 3. Точное совпадение с кнопкой ТЕКУЩЕЙ клавиатуры.${newline}      ${from}`,
    to: '// 3. Точное совпадение с кнопкой ТЕКУЩЕЙ клавиатуры.' } : { file, from, to };
  await assert.rejects(() => probe(edit), (error: unknown) => error instanceof assert.AssertionError && error.code === 'ERR_ASSERTION' &&
    error.operator === 'strictEqual' && error.message.split(/\r?\n/)[0] === message && error.actual === actual && error.expected === expected);
});
