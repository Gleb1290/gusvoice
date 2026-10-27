import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { and, asc, eq } from 'drizzle-orm';
import { Permission as P, type Message } from '@gusvoice/shared';
import * as s from '../src/db/schema.js';
import { createTestDb, type TestDb } from './harness.js';
import { serverFixture, type Phase3Edit } from './botsServers.harness.js';

let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });
const normal = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const rights = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_HISTORY;
const markup = { inline_keyboard: [[{ text: 'Кнопка', callback_data: 'action' }]] };
type F = Awaited<ReturnType<typeof serverFixture>>;
const journal = (f: F) => f.t.db.select().from(s.botUpdates).orderBy(asc(s.botUpdates.updateId));
const botError = (code: number, fragment: string) => (e: unknown) => !!e && typeof e === 'object'
  && (e as { code?: number }).code === code && String((e as { description?: string }).description).includes(fragment);
async function role(f: F, botId = 'bot') {
  const [r] = await f.t.db.select().from(s.roles).where(eq(s.roles.managedBotId, botId)); assert.ok(r); return r;
}
async function grant(f: F, permissions: bigint, botId = 'bot') {
  await f.t.db.update(s.roles).set({ permissions: String(permissions) }).where(eq(s.roles.managedBotId, botId));
}

test('R303 добавление создаёт членство, управляемую роль и назначение атомарно, правка меняет только readAll', async () => {
  const f = await serverFixture(db);
  try {
    await f.bot(); const added = await f.add('bot'); assert.equal(added.statusCode, 201, added.body);
    const r = await role(f); assert.equal(r.id, added.json().roleId); assert.equal(r.membersCanAssign, false); assert.equal(r.mentionable, false);
    assert.equal((await db.db.select().from(s.serverMembers).where(eq(s.serverMembers.userId, 'bot'))).length, 1);
    assert.deepEqual((await db.db.select().from(s.memberRoles).where(eq(s.memberRoles.userId, 'bot'))).map(x => x.roleId), [r.id]);
    const update = await f.request({ method: 'PATCH', url: '/servers/server/bots/bot', payload: { readAll: true } }); assert.equal(update.statusCode, 204);
    assert.equal((await db.db.select().from(s.serverBots))[0].readAll, true);
    assert.equal((await role(f)).permissions, String(rights));
    assert.equal((await f.add('bot')).statusCode, 409);
    const removed = await f.request({ method: 'DELETE', url: '/servers/server/bots/bot' }); assert.equal(removed.statusCode, 204);
    for (const rows of [await db.db.select().from(s.serverBots), await db.db.select().from(s.roles).where(eq(s.roles.managedBotId, 'bot')), await db.db.select().from(s.memberRoles).where(eq(s.memberRoles.userId, 'bot'))]) assert.equal(rows.length, 0);
  } finally { await f.clean(); }
});
test('R303 добавление откатывает членство, если вставка управляемой роли сорвалась внутри транзакции', async () => {
  const f = await serverFixture(db);
  try {
    await f.bot();
    await db.raw.exec(`ALTER TABLE roles ADD CONSTRAINT r303_reject_bot CHECK (managed_bot_id IS NULL)`);
    try {
      assert.equal((await f.add('bot')).statusCode, 500);
      assert.equal((await db.db.select().from(s.serverMembers).where(eq(s.serverMembers.userId, 'bot'))).length, 0);
      assert.equal((await db.db.select().from(s.serverBots)).length, 0);
    } finally { await db.raw.exec('ALTER TABLE roles DROP CONSTRAINT r303_reject_bot'); }
  } finally { await f.clean(); }
});
test('R303 приватный чужой бот скрыт в lookup и закрыт на добавлении; свой приватный и публичный проходят', async () => {
  const f = await serverFixture(db);
  try {
    await f.bot('private', { ownerId: 'manager', public: false });
    assert.equal((await f.request({ method: 'GET', url: '/servers/server/bots/lookup?username=PRIVATEBOT' })).statusCode, 404);
    assert.equal((await f.add('private')).statusCode, 403);
    assert.equal((await f.request({ method: 'GET', url: '/servers/server/bots/lookup?username=@PRIVATEBOT' }, 'manager')).statusCode, 200);
    assert.equal((await f.add('private', rights, 'manager')).statusCode, 201);
    await f.bot('public', { ownerId: 'manager' }); assert.equal((await f.add('public')).statusCode, 201);
  } finally { await f.clean(); }
});
test('R303 добавляющий не выдаёт лишние права, роль строго ниже его высшей; ADMINISTRATOR нельзя даже владельцу', async () => {
  const f = await serverFixture(db);
  try {
    await f.bot(); assert.equal((await f.add('bot', P.ADMINISTRATOR)).statusCode, 400);
    assert.equal((await f.add('bot', rights, 'person')).statusCode, 403);
    assert.equal((await f.add('bot', rights, 'outsider')).statusCode, 404);
    assert.equal((await f.add('bot', rights | P.BAN_MEMBERS, 'manager')).statusCode, 201);
    const r = await role(f), [manager] = await db.db.select().from(s.roles).where(eq(s.roles.id, 'manager-role'));
    assert.ok(r.position < manager.position); assert.equal(BigInt(r.permissions), P.VIEW_CHANNEL | P.SEND_MESSAGES);
  } finally { await f.clean(); }
});
test('R303 выключенные боты и бан блокируют добавление; двадцатый проходит, двадцать первый нет', async () => {
  const f = await serverFixture(db);
  try {
    await f.bot('banned'); await db.db.insert(s.bans).values({ serverId: 'server', userId: 'banned', bannedBy: 'owner' });
    assert.equal((await f.add('banned')).statusCode, 409);
    await f.bot('disabled'); await db.db.update(s.bots).set({ disabledAt: new Date() }).where(eq(s.bots.userId, 'disabled'));
    assert.equal((await f.add('disabled')).statusCode, 404);
    for (let i = 0; i < 21; i++) { await f.bot(`limit-${i}`); assert.equal((await f.add(`limit-${i}`)).statusCode, i < 20 ? 201 : 409); }
    assert.equal((await db.db.select().from(s.serverBots)).length, 20);
    await f.store.writeBotSettings({ enabled: false, creators: 'all', perUserLimit: 100, allowInternalWebhooks: false });
    assert.equal((await f.add('limit-20')).statusCode, 403);
  } finally { await f.clean(); }
});
test('R303 миграция 0157 каскадно снимает роль, назначение и server_bots при любом удалении членства', async () => {
  const f = await serverFixture(db);
  try {
    assert.ok(db.appliedMigrations.includes('0157_server_bots.sql'));
    await f.bot(); assert.equal((await f.add('bot')).statusCode, 201);
    await db.db.delete(s.serverMembers).where(and(eq(s.serverMembers.serverId, 'server'), eq(s.serverMembers.userId, 'bot')));
    assert.equal((await db.db.select().from(s.serverBots)).length, 0);
    assert.equal((await db.db.select().from(s.roles).where(eq(s.roles.managedBotId, 'bot'))).length, 0);
    assert.equal((await db.db.select().from(s.memberRoles).where(eq(s.memberRoles.userId, 'bot'))).length, 0);
    assert.equal((await db.db.select().from(s.roles).where(eq(s.roles.id, 'manager-role'))).length, 1, 'обычная NULL managed_bot_id роль сохранена');
  } finally { await f.clean(); }
});
test('R303 канальная отправка сохраняет клавиатуру и публичный файл, без SEND_MESSAGES отказ до записи', async () => {
  const f = await serverFixture(db);
  try {
    const ctx = await f.bot(); await f.add('bot', P.VIEW_CHANNEL);
    await assert.rejects(f.channel.channelSendMessage(ctx, { chat_id: 'channel', text: 'текст' }, []), botError(403, 'rights to send'));
    assert.equal((await db.db.select().from(s.messages)).length, 0);
    await grant(f, rights);
    const sent = await f.channel.channelSendMessage(ctx, { chat_id: 'channel', text: '@everyone <b>ответ</b>', parse_mode: 'HTML', reply_markup: markup },
      [{ name: 'a.txt', mime: 'text/plain', buffer: Buffer.from('abc') }]);
    const [row] = await db.db.select().from(s.messages); assert.equal(row.content, '@everyone **ответ**'); assert.equal(row.mentionEveryone, false);
    assert.deepEqual(row.keyboard, markup.inline_keyboard); assert.deepEqual(normal(sent.reply_markup), markup);
    assert.equal(f.uploads.length, 1); assert.equal(row.attachments[0].url, 'https://example.invalid/public/a.txt');
    assert.deepEqual(normal(f.events.at(-1)?.body.message.keyboard), markup.inline_keyboard);
    assert.equal(f.events.at(-1)?.body.t, 'message.create');
    await assert.rejects(f.channel.channelSendMessage(ctx, { chat_id: 'channel', text: 'x', parse_mode: 'MarkdownV2' }, []), botError(400, 'MarkdownV2'));
    await assert.rejects(f.channel.channelSendMessage(ctx, { chat_id: 'other-channel', text: 'ответ', reply_to_message_id: sent.message_id }, []), botError(400, 'reply not found'));
  } finally { await f.clean(); }
});
test('R303 изменение только кнопок не ставит editedAt, правка текста без markup снимает клавиатуру', async () => {
  const f = await serverFixture(db);
  try {
    const ctx = await f.bot(); await f.add('bot');
    const sent = await f.channel.channelSendMessage(ctx, { chat_id: 'channel', text: 'панель', reply_markup: markup }, []);
    const next = { inline_keyboard: [[{ text: 'Новая', callback_data: 'new' }]] };
    await f.channel.channelEditMessageReplyMarkup(ctx, { chat_id: 'channel', message_id: sent.message_id, reply_markup: next });
    const [row] = await db.db.select().from(s.messages); assert.equal(row.editedAt, null); assert.deepEqual(row.keyboard, next.inline_keyboard);
    assert.equal(f.events.at(-1)?.body.t, 'message.update');
    await f.channel.channelEditMessageText(ctx, { chat_id: 'channel', message_id: sent.message_id, text: 'изменено' });
    const [edited] = await db.db.select().from(s.messages); assert.ok(edited.editedAt); assert.equal(edited.keyboard, null);
  } finally { await f.clean(); }
});
test('R303 чужое нельзя править и удалять без MANAGE_MESSAGES; закреп закрыт, права открывают только разрешённое', async () => {
  const f = await serverFixture(db);
  try {
    const ctx = await f.bot(); await f.add('bot');
    await db.db.insert(s.messages).values({ id: 'human', channelId: 'channel', authorId: 'owner', content: 'человек' });
    const args = { chat_id: 'channel', message_id: 'human' };
    await assert.rejects(f.channel.channelEditMessageText(ctx, { ...args, text: 'подмена' }), botError(400, "can't be edited"));
    await assert.rejects(f.channel.channelDeleteMessage(ctx, args), botError(400, "can't be deleted"));
    await assert.rejects(f.channel.channelPinChatMessage(ctx, args), botError(400, 'pinned'));
    await grant(f, rights | P.MANAGE_MESSAGES);
    assert.equal(await f.channel.channelPinChatMessage(ctx, args), true);
    assert.ok((await db.db.select().from(s.messages))[0].pinnedAt);
    assert.equal(await f.channel.channelUnpinChatMessage(ctx, args), true);
    assert.equal((await db.db.select().from(s.messages))[0].pinnedAt, null);
    assert.equal(await f.channel.channelDeleteMessage(ctx, args), true); assert.equal((await db.db.select().from(s.messages)).length, 0);
  } finally { await f.clean(); }
});
test('R303 набор реакций заменяется целиком, пустой снимает свои и сохраняет чужие', async () => {
  const f = await serverFixture(db);
  try {
    const ctx = await f.bot(); await f.add('bot');
    await db.db.insert(s.messages).values({ id: 'm', channelId: 'channel', authorId: 'owner', content: 'текст' });
    await db.db.insert(s.messageReactions).values({ messageId: 'm', userId: 'owner', emoji: '❤' });
    const set = (emoji: string[]) => f.channel.channelSetMessageReaction(ctx, { chat_id: 'channel', message_id: 'm', reaction: emoji.map(emoji => ({ type: 'emoji', emoji })) });
    await set(['👍', '❤']); await set(['👍']);
    assert.deepEqual((await db.db.select().from(s.messageReactions).where(eq(s.messageReactions.userId, 'bot'))).map(r => r.emoji), ['👍']);
    await set([]); assert.deepEqual((await db.db.select().from(s.messageReactions)).map(r => [r.userId, r.emoji]), [['owner', '❤']]);
  } finally { await f.clean(); }
});
test('R303 история требует readAll и READ_HISTORY, возвращает старые→новые и ограничивает курсором своего канала', async () => {
  const f = await serverFixture(db);
  try {
    const ctx = await f.bot(); await f.add('bot');
    for (let i = 1; i <= 3; i++) await db.db.insert(s.messages).values({ id: `m${i}`, channelId: 'channel', authorId: 'owner', content: String(i), createdAt: new Date(i * 1000) });
    await assert.rejects(f.channel.channelGetChatHistory(ctx, { chat_id: 'channel' }), botError(403, 'read all'));
    await f.request({ method: 'PATCH', url: '/servers/server/bots/bot', payload: { readAll: true } });
    await grant(f, P.VIEW_CHANNEL); await assert.rejects(f.channel.channelGetChatHistory(ctx, { chat_id: 'channel' }), botError(403, 'read history'));
    await grant(f, rights);
    assert.deepEqual(normal((await f.channel.channelGetChatHistory(ctx, { chat_id: 'channel', limit: 2 })).map(m => m.message_id)), ['m2', 'm3']);
    assert.deepEqual(normal((await f.channel.channelGetChatHistory(ctx, { chat_id: 'channel', before_message_id: 'm3' })).map(m => m.message_id)), ['m1', 'm2']);
    await assert.rejects(f.channel.channelGetChatHistory(ctx, { chat_id: 'other-channel', before_message_id: 'm3' }), botError(400, 'message not found'));
    await assert.rejects(f.channel.channelChatFor('bot', 'unknown'), botError(400, 'chat not found'));
    await assert.rejects(f.channel.channelChatFor('bot', 'voice'), botError(400, 'not a text channel'));
    await assert.rejects(f.channel.channelChatFor('bot', 'server'), botError(400, 'chat is a server'));
    await grant(f, 0n); await assert.rejects(f.channel.channelChatFor('bot', 'channel'), botError(400, 'chat not found'));
  } finally { await f.clean(); }
});
test('R303 состав сервера различает владельца, участника, ушедшего и забаненного; модерация соблюдает права и иерархию', async () => {
  const f = await serverFixture(db);
  try {
    const ctx = await f.bot(); await f.add('bot', rights | P.KICK_MEMBERS | P.BAN_MEMBERS | P.MANAGE_ROLES);
    const get = (user_id: string) => f.channel.serverGetChatMember(ctx, { chat_id: 'server', user_id });
    assert.equal((await get('owner')).status, 'creator'); assert.equal((await get('person')).status, 'member'); assert.equal((await get('outsider')).status, 'left');
    await assert.rejects(f.channel.serverKickChatMember(ctx, { chat_id: 'server', user_id: 'owner' }), botError(400, 'owner'));
    await assert.rejects(f.channel.serverKickChatMember(ctx, { chat_id: 'server', user_id: 'bot' }), botError(400, 'self'));
    await f.channel.serverBanChatMember(ctx, { chat_id: 'server', user_id: 'person', reason: 'причина' }); assert.equal((await get('person')).status, 'kicked');
    await f.channel.serverUnbanChatMember(ctx, { chat_id: 'server', user_id: 'person' }); assert.equal((await get('person')).status, 'left');
    assert.deepEqual(normal(f.changed.slice(-2).map(x => [x.from, x.to, x.actorId])), [['member', 'kicked', 'bot'], ['kicked', 'left', 'bot']]);
    const r = await role(f);
    await db.db.insert(s.roles).values([{ id: 'lower', serverId: 'server', name: 'ниже', position: r.position - 1 }, { id: 'equal', serverId: 'server', name: 'равная', position: r.position }]);
    const assign = (role_id: string) => f.channel.serverAddChatMemberRole(ctx, { chat_id: 'server', user_id: 'manager', role_id });
    await assert.rejects(assign(r.id), botError(400, 'managed')); await assert.rejects(assign('equal'), botError(400, 'not lower'));
    assert.equal(await assign('lower'), true);
    assert.equal(await f.channel.serverRemoveChatMemberRole(ctx, { chat_id: 'server', user_id: 'manager', role_id: 'lower' }), true);
    assert.equal(await f.channel.serverLeaveChat(ctx, { chat_id: 'server' }), true);
    assert.equal((await db.db.select().from(s.serverBots)).length, 0); assert.equal((await db.db.select().from(s.roles).where(eq(s.roles.managedBotId, 'bot'))).length, 0);
  } finally { await f.clean(); }
});

test('R303 счётчик и страницы состава ограничены сервером и активным членством, курсор не повторяет последнего', async () => {
  const f = await serverFixture(db);
  try {
    const ctx = await f.bot(); assert.equal((await f.add('bot')).statusCode, 201);
    await db.db.insert(s.servers).values({ id: 'foreign-server', name: 'Чужой', ownerId: 'outsider' });
    await db.db.insert(s.serverMembers).values([
      { serverId: 'foreign-server', userId: 'outsider' },
      { serverId: 'foreign-server', userId: 'manager' },
      { serverId: 'server', userId: 'outsider', state: 'closed_by_host' },
    ]);
    await db.db.insert(s.roles).values({ id: 'foreign-role', serverId: 'foreign-server', name: 'Чужая' });
    await db.db.insert(s.memberRoles).values({ serverId: 'foreign-server', userId: 'manager', roleId: 'foreign-role' });
    await db.db.update(s.serverMembers).set({ nickname: 'Ник менеджера', joinedAt: new Date(123000) })
      .where(and(eq(s.serverMembers.serverId, 'server'), eq(s.serverMembers.userId, 'manager')));
    assert.equal(await f.channel.serverGetChatMemberCount(ctx, { chat_id: 'server' }), 4);
    assert.equal(await f.channel.serverGetChatMemberCount(ctx, { chat_id: 'channel' }), 4, 'id канала разрешается в его сервер');
    const first = await f.channel.serverGetChatMembers(ctx, { chat_id: 'server', limit: 2 });
    assert.deepEqual(normal(first.members.map(m => m.user.id)), ['bot', 'manager']);
    assert.equal(first.next_offset, 'manager');
    assert.deepEqual(normal(first.members[0].role_ids), [(await role(f)).id]);
    assert.deepEqual(normal(first.members[1].role_ids), ['manager-role'], 'роль того же человека на чужом сервере не протекает');
    assert.equal(first.members[1].nickname, 'Ник менеджера'); assert.equal(first.members[1].joined_date, 123);
    const second = await f.channel.serverGetChatMembers(ctx, { chat_id: 'channel', offset: first.next_offset, limit: 2 });
    assert.deepEqual(normal(second.members.map(m => [m.user.id, m.status])), [['owner', 'creator'], ['person', 'member']]);
    assert.equal(Object.hasOwn(second, 'next_offset'), false, 'полная последняя страница не обещает лишний запрос');
    const empty = await f.channel.serverGetChatMembers(ctx, { chat_id: 'server', offset: 'person', limit: 1 });
    assert.deepEqual(normal(empty), { members: [] });
    assert.equal((await f.channel.serverGetChatMembers(ctx, { chat_id: 'server', limit: 200 })).members.length, 4);
    for (const limit of [0, 201]) await assert.rejects(f.channel.serverGetChatMembers(ctx, { chat_id: 'server', limit }),
      (e: unknown) => e instanceof Error && e.name === 'ZodError');
    for (const chat_id of ['foreign-server', 'missing']) {
      await assert.rejects(f.channel.serverGetChatMemberCount(ctx, { chat_id }), botError(400, 'chat not found'));
      await assert.rejects(f.channel.serverGetChatMembers(ctx, { chat_id }), botError(400, 'chat not found'));
    }
  } finally { await f.clean(); }
});

test('R303 описание сервера выдаёт только видимые каналы с can_send и управляемость ролей, чужие серверы скрыты', async () => {
  const f = await serverFixture(db);
  try {
    const ctx = await f.bot(); assert.equal((await f.add('bot')).statusCode, 201);
    const nonmember = await f.bot('nonmember');
    await db.db.insert(s.servers).values({ id: 'foreign-server', name: 'Чужой', ownerId: 'outsider' });
    await db.db.insert(s.serverMembers).values({ serverId: 'foreign-server', userId: 'outsider' });
    await db.db.insert(s.channels).values([
      { id: 'hidden', serverId: 'server', name: 'скрытый', type: 'text', position: 3 },
      { id: 'foreign-channel', serverId: 'foreign-server', name: 'чужой', type: 'text' },
    ]);
    await db.db.update(s.channels).set({ position: 1 }).where(eq(s.channels.id, 'other-channel'));
    await db.db.update(s.channels).set({ position: 2 }).where(eq(s.channels.id, 'voice'));
    await db.db.insert(s.channelOverwrites).values([
      { channelId: 'other-channel', targetId: 'bot', targetType: 'member', deny: String(P.SEND_MESSAGES) },
      { channelId: 'hidden', targetId: 'bot', targetType: 'member', deny: String(P.VIEW_CHANNEL) },
    ]);
    await db.db.insert(s.roles).values([
      { id: 'guests', serverId: 'server', name: 'Гости', isGuests: true, position: 3 },
      { id: 'foreign-role', serverId: 'foreign-server', name: 'Чужая' },
    ]);
    assert.deepEqual(normal(await f.channel.serverGetMyServers(ctx)), [{ id: 'server', title: 'Сервер' }]);
    assert.deepEqual(normal(await f.channel.serverGetMyServers(nonmember)), []);
    const result = await f.channel.serverGetServer(ctx, { server_id: 'server' });
    assert.equal(result.id, 'server'); assert.equal(result.title, 'Сервер');
    assert.deepEqual(normal(result.channels), [
      { id: 'channel', title: 'общий', type: 'text', can_send: true },
      { id: 'other-channel', title: 'другой', type: 'text', can_send: false },
      { id: 'voice', title: 'голос', type: 'voice', can_send: false },
    ]);
    assert.deepEqual(normal(result.roles.map(r => [r.id, r.managed]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
      [[(await role(f)).id, true], ['everyone', false], ['guests', true], ['manager-role', false]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    assert.ok(result.roles.every((r, i, all) => i === 0 || all[i - 1].position >= r.position));
    for (const server_id of ['foreign-server', 'missing']) await assert.rejects(f.channel.serverGetServer(ctx, { server_id }), botError(400, 'chat not found'));
    await assert.rejects(f.channel.serverGetServer(nonmember, { server_id: 'server' }), botError(400, 'chat not found'));
  } finally { await f.clean(); }
});

async function privacyFixture(edit?: Phase3Edit) {
  const f = await serverFixture(db, edit);
  await f.bot('private'); await f.add('private'); await f.bot('reader'); await f.add('reader', rights, 'owner', true);
  const message: Message = { id: 'message', channelId: 'channel', content: 'обычная переписка', attachments: [], reactions: [], replyTo: null, createdAt: new Date().toISOString(), editedAt: null,
    author: { id: 'owner', username: 'owner', displayName: 'Человек', avatarUrl: null } };
  const send = (message: Message, audience = ['private', 'reader'], actor = 'owner') => f.channel.recordChannelBotUpdates('server', 'channel', { kind: 'created', message }, audience, actor);
  return { ...f, message, send };
}
test('R303 приватность действует до INSERT: обычный текст только readAll, обращения обоим, скрытый канал никому', async () => {
  const f = await privacyFixture();
  try {
    await f.send(f.message); assert.deepEqual((await journal(f)).map(r => r.botId), ['reader']);
    await db.db.delete(s.botUpdates);
    await f.send({ ...f.message, content: '/cmd' }); assert.deepEqual((await journal(f)).map(r => r.botId).sort(), ['private', 'reader']);
    await db.db.delete(s.botUpdates);
    await f.send({ ...f.message, content: '/cmd' }, []); assert.equal((await journal(f)).length, 0);
    await f.send({ ...f.message, mentionRoles: [(await role(f, 'private')).id] }); assert.equal((await journal(f)).length, 2);
    await db.db.delete(s.botUpdates);
    await db.db.insert(s.messages).values({ id: 'parent', channelId: 'channel', authorId: 'private', content: 'панель' });
    await f.send({ ...f.message, replyTo: { id: 'parent', content: 'панель', authorName: 'бот' } });
    assert.equal((await journal(f)).length, 2);
  } finally { await f.clean(); }
});
test('R303 своё и чужих ботов нет в журнале даже readAll; вебхуки только readAll, массовое упоминание не обход', async () => {
  const f = await privacyFixture();
  try {
    for (const id of ['private', 'reader']) await f.send({ ...f.message, content: '/cmd', author: { ...f.message.author, id, bot: true } }, ['private', 'reader'], id);
    assert.equal((await journal(f)).length, 0);
    await f.send({ ...f.message, content: '@everyone' }); assert.deepEqual((await journal(f)).map(x => x.botId), ['reader']);
    await db.db.delete(s.botUpdates);
    await f.send({ ...f.message, content: '/cmd', webhookId: 'hook', author: { ...f.message.author, bot: true } });
    assert.deepEqual((await journal(f)).map(x => x.botId), ['reader']);
    await db.db.delete(s.botUpdates);
    await f.send({ ...f.message, content: '/cmd' }, ['private', 'reader'], 'reader');
    assert.deepEqual((await journal(f)).map(x => x.botId), ['private']);
  } finally { await f.clean(); }
});
test('R303 выключатель и disabled отсекают запись; правка проверяет новый текст, закреп и markup ничего не пишут', async () => {
  const f = await privacyFixture();
  try {
    for (const kind of ['pinned', 'markup'] as const) await f.channel.recordChannelBotUpdates('server', 'channel', { kind, message: f.message }, ['private', 'reader']);
    assert.equal((await journal(f)).length, 0);
    await f.channel.recordChannelBotUpdates('server', 'channel', { kind: 'edited', message: f.message }, ['private', 'reader']);
    assert.deepEqual((await journal(f)).map(x => [x.botId, x.type]), [['reader', 'edited_message']]);
    await db.db.delete(s.botUpdates);
    await db.db.update(s.bots).set({ disabledAt: new Date() }).where(eq(s.bots.userId, 'reader'));
    await f.send({ ...f.message, content: '/cmd' }); assert.deepEqual((await journal(f)).map(x => x.botId), ['private']);
    await db.db.delete(s.botUpdates);
    await f.store.writeBotSettings({ enabled: false, creators: 'all', perUserLimit: 100, allowInternalWebhooks: false });
    await f.send({ ...f.message, content: '/cmd' }); assert.equal((await journal(f)).length, 0);
  } finally { await f.clean(); }
});
test('R303 удаление и реакция приходят readAll и автору-боту, old/new реакции полные, реакция бота не размножается', async () => {
  const f = await privacyFixture();
  try {
    await f.channel.recordChannelBotUpdates('server', 'channel', { kind: 'deleted', messageId: 'm', authorId: 'private' }, ['private', 'reader'], 'owner');
    assert.deepEqual((await journal(f)).map(x => x.botId).sort(), ['private', 'reader']); await db.db.delete(s.botUpdates);
    await db.db.insert(s.messages).values({ id: 'm', channelId: 'channel', authorId: 'private', content: 'панель' });
    await db.db.insert(s.messageReactions).values([{ messageId: 'm', userId: 'owner', emoji: '❤', createdAt: new Date(1000) }, { messageId: 'm', userId: 'owner', emoji: '👍', createdAt: new Date(2000) }]);
    await f.channel.recordChannelBotUpdates('server', 'channel', { kind: 'reaction', messageId: 'm', authorId: 'private', userId: 'owner', emoji: '👍', op: 'add' }, ['private', 'reader'], 'owner');
    for (const r of await journal(f)) {
      const p = r.payload as any; assert.deepEqual(p.old_reaction, [{ type: 'emoji', emoji: '❤' }]); assert.deepEqual(p.new_reaction, [{ type: 'emoji', emoji: '❤' }, { type: 'emoji', emoji: '👍' }]);
    }
    assert.equal((await journal(f)).length, 2); await db.db.delete(s.botUpdates);
    await f.channel.recordChannelBotUpdates('server', 'channel', { kind: 'reaction', messageId: 'm', authorId: 'private', userId: 'reader', emoji: '👍', op: 'add' }, ['private', 'reader'], 'reader');
    assert.equal((await journal(f)).length, 0);
  } finally { await f.clean(); }
});
test('R303 memberBotUpdates чистит только события снятого сервера ДО my_chat_member и сохраняет чужих ботов', async () => {
  const f = await privacyFixture();
  try {
    await f.store.pushUpdates([
      { botId: 'private', type: 'message', payload: { chat: { server_id: 'server' } } },
      { botId: 'private', type: 'callback_query', payload: { message: { chat: { server_id: 'server' } } } },
      { botId: 'private', type: 'message', payload: { chat: { type: 'dm', id: 'dm' } } },
      { botId: 'private', type: 'message', payload: { chat: { server_id: 'another' } } },
      { botId: 'reader', type: 'message', payload: { chat: { server_id: 'server' } } },
    ]);
    await f.channel.memberBotUpdates({ serverId: 'server', userId: 'private', actorId: 'owner', from: 'member', to: 'kicked' });
    const rows = await journal(f), own = rows.filter(x => x.botId === 'private');
    assert.deepEqual(own.map(x => x.type), ['message', 'message', 'my_chat_member']);
    assert.deepEqual(own.slice(0, 2).map(x => (x.payload as any).chat), [{ type: 'dm', id: 'dm' }, { server_id: 'another' }]);
    assert.equal((own.at(-1)!.payload as any).new_status, 'kicked'); assert.equal((own.at(-1)!.payload as any).from.id, 'owner');
    assert.deepEqual(rows.filter(x => x.botId === 'reader').map(x => x.type), ['message', 'chat_member']);
  } finally { await f.clean(); }
});
test('R303 original-first контрфакты приватности, аудитории и своего действия дают точный SQL-AssertionError', async () => {
  for (const m of [
    { from: 'if (!b.readAll && !botAddressed', to: 'if (false && !botAddressed', audience: ['private', 'reader'], actor: 'owner', content: 'обычная переписка', expected: ['reader'] },
    { from: 'const seen = audience ? new Set(audience) : null;', to: 'const seen = null;', audience: [] as string[], actor: 'owner', content: '/cmd', expected: [] as string[] },
    { from: 'b.bot.userId !== actor && b.bot.userId !== m.author.id', to: 'b.bot.userId !== m.author.id', audience: ['private', 'reader'], actor: 'reader', content: '/cmd', expected: ['private'] },
  ]) {
    const check = async (edit?: Phase3Edit) => {
      const f = await privacyFixture(edit);
      try { await f.send({ ...f.message, content: m.content }, m.audience, m.actor); assert.deepEqual((await journal(f)).map(x => x.botId).sort(), m.expected, 'R303 запрещённые получатели отсутствуют в SQL'); }
      finally { await f.clean(); }
    };
    await check();
    await assert.rejects(check({ file: 'bots/botChannel', from: m.from, to: m.to }), e => e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION'
      && e.operator === 'deepStrictEqual' && e.message.startsWith('R303 запрещённые получатели отсутствуют в SQL'));
  }
});
test('R303 original-first мутант публичности не маскируется под ошибку фикстуры', async () => {
  const check = async (edit?: Phase3Edit) => {
    const f = await serverFixture(db, edit);
    try {
      await f.bot('hidden', { ownerId: 'manager', public: false });
      const result = await f.add('hidden');
      assert.equal(result.statusCode, 403, 'R303 чужой приватный бот не добавляется');
    } finally { await f.clean(); }
  };
  await check();
  await assert.rejects(check({ file: 'routes/serverBots', from: 'if (!found.bot.public && found.bot.ownerId !== me)', to: 'if (false)' }),
    e => e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION' && e.operator === 'strictEqual'
      && e.message.startsWith('R303 чужой приватный бот не добавляется') && e.actual === 201 && e.expected === 403);
});
test('R303 original-first мутант снятого FK оставляет роль после кика и пойман на SQL', async () => {
  const check = async (removeFk: boolean) => {
    const f = await serverFixture(db);
    try {
      await f.bot(); await f.add('bot');
      if (removeFk) await db.raw.exec('ALTER TABLE roles DROP CONSTRAINT roles_managed_bot_fk');
      try {
        assert.equal((await f.members.kickMember('server', 'owner', 'bot')).kind, 'ok');
        const rows = await db.db.select().from(s.roles).where(eq(s.roles.managedBotId, 'bot'));
        assert.equal(rows.length, 0, 'R303 роль уходит вместе с членством по FK');
      } finally {
        if (removeFk) {
          // Мутант меняет только временную PGlite; до восстановления FK убираем намеренно осиротевшую строку.
          await db.db.delete(s.roles).where(eq(s.roles.managedBotId, 'bot'));
          await db.raw.exec('ALTER TABLE roles ADD CONSTRAINT roles_managed_bot_fk FOREIGN KEY (server_id, managed_bot_id) REFERENCES server_members(server_id, user_id) ON DELETE CASCADE');
        }
      }
    } finally { await f.clean(); }
  };
  await check(false);
  await assert.rejects(check(true), e => e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION' && e.operator === 'strictEqual'
    && e.message.startsWith('R303 роль уходит вместе с членством по FK') && e.actual === 1 && e.expected === 0);
});
