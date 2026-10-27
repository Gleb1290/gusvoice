/**
 * Боты на серверах (#231, этап 3): события каналов и членства в журнал бота + методы Bot API для каналов и серверов.
 *
 * Грузится ЛЕНИВО из `routes/botApi.ts` (у того закрытый перечень импортов, `botApi.wake.test.ts`) и подключается крючками
 * `configureChannelBots` / `configureMemberBots` — модули людей (`channelEvents.ts`, `memberEvents.ts`) ботов не импортируют.
 *
 * Правила (ТЗ этапа 3 §1.3, §1.5, §2.3, §2.7):
 * - событие боту — только если бот на сервере (`server_bots`), жив, боты включены и у бота есть `VIEW_CHANNEL` (аудитория);
 * - своё боту не пишется; сообщения ДРУГИХ ботов не приходят никому (защита от петель); вебхук — только «читать всё»;
 * - без «читать всё» — фильтр приватности `botAddressed` ДО записи в журнал (лишнего в `bot_updates` нет вовсе);
 * - снятие бота с сервера чистит его события этого сервера (`dropServerUpdates`), потом пишет `my_chat_member`.
 */
import {
  has,
  type InlineKeyboard,
  type Message,
  Permission,
} from '@gusvoice/shared';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { attachmentUploadBlock, rateHit } from '../authGuard.js';
import { writeAudit } from '../audit.js';
import type { ChannelMessageEvent } from '../channelEvents.js';
import {
  type ChannelFail,
  deleteChannelMessage,
  editChannelKeyboard,
  editChannelMessage,
  postChannelMessage,
  reactionsOfUser,
  setChannelPinned,
  setChannelReaction,
  channelMessageView,
} from '../channelMessages.js';
import { db } from '../db/index.js';
import { bans, channels, memberRoles, messages, roles, serverBots, serverMembers, servers, users } from '../db/schema.js';
import { instanceLabel } from '../federation/instanceLabels.js';
import type { MemberChange } from '../memberEvents.js';
import { getChannelAudience, getChannelPermissions, getMemberContext, highestPosition } from '../permissions.js';
import { publishToChannel, publishToServer } from '../realtime.js';
import { assignRoleBlock } from '../roleRules.js';
import { banMember, kickMember, leaveServer, unbanMember } from '../serverMembership.js';
import { attachmentBlocked, isOwnMediaUrl, putAttachment, storageConfigured } from '../storage.js';
import { id as newId } from '../util.js';
import { embedsFallbackText, normalizeEmbeds } from '../webhookRules.js';
import {
  BOT_CHAT_RATE,
  BOT_HEAVY_RATE,
  BOT_SERVER_RATE,
  BotApiError,
  botAddressed,
  CHAT_HISTORY_PAGE,
  CHAT_MEMBERS_PAGE,
  htmlToMarkers,
  PARSE_MODE_UNSUPPORTED,
  unixSeconds,
} from './botRules.js';
import { type BotRow, dropServerUpdates, liveBotsAmong, pushUpdates, readBotSettings, type UserRow } from './botStore.js';
import {
  banChatMemberParams,
  channelChat,
  chatMemberRoleParams,
  deleteMessageParams,
  editMessageReplyMarkupParams,
  editMessageTextParams,
  getChatHistoryParams,
  getChatMemberCountParams,
  getChatMemberParams,
  getChatMembersParams,
  getChatParams,
  getServerParams,
  kickChatMemberParams,
  leaveChatParams,
  pinChatMessageParams,
  sendChatActionParams,
  sendMessageParams,
  serverChat,
  setMessageReactionParams,
  toWireChannelMessage,
  toWireUser,
  unbanChatMemberParams,
  unpinChatMessageParams,
  type WireChat,
  type WireChatMemberInfo,
  type WireUser,
} from './botWire.js';
import { kickWebhook } from './webhookDelivery.js';

type ChannelRow = typeof channels.$inferSelect;
type ServerRow = typeof servers.$inferSelect;
export interface BotChannelCtx {
  bot: BotRow;
  user: UserRow;
}
interface Upload {
  name: string;
  mime: string;
  buffer: Buffer;
}
type Params = Record<string, unknown>;

const chatNotFound = () => new BotApiError(400, 'Bad Request: chat not found');

async function limit(key: string, rate: { max: number; windowS: number }): Promise<void> {
  const wait = await rateHit(key, rate.max, rate.windowS);
  if (wait) throw new BotApiError(429, `Too Many Requests: retry after ${wait}`, wait);
}

// ─── Провод: люди ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Человек на проводе: у гостя — домашний ник и `instance_domain` (как ростер `servers.ts`). */
export function wireUserOf(u: Pick<UserRow, 'id' | 'username' | 'displayName' | 'bot' | 'homeUsername' | 'homeInstanceId' | 'verified'>): WireUser {
  const domain = u.homeInstanceId ? instanceLabel(u.homeInstanceId).domain : '';
  return toWireUser({
    id: u.id,
    username: u.homeUsername || u.username,
    displayName: u.displayName,
    bot: u.bot === true && u.verified === true,
    instanceDomain: domain || null,
  });
}

async function wireUsers(ids: readonly string[]): Promise<Map<string, WireUser>> {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return new Map();
  const rows = await db.select().from(users).where(inArray(users.id, uniq));
  return new Map(rows.map((u) => [u.id, wireUserOf(u)]));
}

// ─── Разбор chat_id ──────────────────────────────────────────────────────────────────────────────────────────────────

async function botOnServer(botId: string, serverId: string): Promise<boolean> {
  const [r] = await db
    .select({ one: sql<number>`1` })
    .from(serverBots)
    .where(and(eq(serverBots.serverId, serverId), eq(serverBots.botId, botId)))
    .limit(1);
  return !!r;
}

/**
 * `chat_id` → текстовый канал, который бот видит (ТЗ §1.1). id сервера → 400 «chat is a server»; голосовой → 400; чужое или
 * невидимое → «chat not found» (не подсказываем, что канал есть).
 */
export async function channelChatFor(botId: string, chatId: string): Promise<{ channel: ChannelRow; perms: bigint }> {
  const [channel] = await db.select().from(channels).where(eq(channels.id, chatId)).limit(1);
  if (!channel) {
    if (await botOnServer(botId, chatId)) throw new BotApiError(400, 'Bad Request: chat is a server; use a channel id');
    throw chatNotFound();
  }
  if (!(await botOnServer(botId, channel.serverId))) throw chatNotFound();
  const perms = await getChannelPermissions(channel.id, botId);
  if (!perms || !has(perms.permissions, Permission.VIEW_CHANNEL)) throw chatNotFound();
  if (channel.type !== 'text') throw new BotApiError(400, 'Bad Request: chat is not a text channel');
  return { channel, perms: perms.permissions };
}

/** `chat_id` сервера (или канала — берётся его сервер), где бот участник. */
async function serverChatFor(botId: string, chatId: string): Promise<ServerRow> {
  let serverId = chatId;
  const [channel] = await db.select({ serverId: channels.serverId }).from(channels).where(eq(channels.id, chatId)).limit(1);
  if (channel) serverId = channel.serverId;
  if (!(await botOnServer(botId, serverId))) throw chatNotFound();
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server) throw chatNotFound();
  return server;
}

/** Текст бота: `parse_mode` (ТЗ §1.7) — без него наши маркеры; `HTML` → маркеры; прочее — 400. */
export function botText(text: string, parseMode: string | undefined): string {
  if (!parseMode) return text;
  const mode = parseMode.trim().toLowerCase();
  if (mode === 'html') return htmlToMarkers(text);
  throw new BotApiError(400, PARSE_MODE_UNSUPPORTED);
}

function failToBot(f: ChannelFail, what: 'send' | 'edit' | 'delete' | 'react' | 'pin'): BotApiError {
  switch (f.reason) {
    case 'bad-reply':
      return new BotApiError(400, 'Bad Request: message to reply not found');
    case 'no-send':
      return new BotApiError(403, 'Forbidden: not enough rights to send messages to the chat');
    case 'not-found':
      return new BotApiError(400, `Bad Request: message to ${what} not found`);
    case 'not-author':
      return new BotApiError(400, "Bad Request: message can't be edited");
    case 'no-manage':
      return new BotApiError(400, what === 'pin' ? 'Bad Request: not enough rights to manage pinned messages in the chat' : "Bad Request: message can't be deleted");
    case 'empty':
      return new BotApiError(400, 'Bad Request: message text is empty');
    case 'not-text':
      return new BotApiError(400, 'Bad Request: chat is not a text channel');
    default:
      return chatNotFound();
  }
}

async function wireOf(ctx: BotChannelCtx, channel: ChannelRow, m: Message) {
  return toWireChannelMessage(m, channelChat(channel), m.author.id === ctx.bot.userId ? wireUserOf(ctx.user) : undefined);
}

// ─── Методы: канал ───────────────────────────────────────────────────────────────────────────────────────────────────

async function storePublicFiles(botId: string, files: Upload[]): Promise<{ attachments: { url: string; name: string; contentType: string; size: number }[]; urls: Map<string, string> }> {
  const attachments: { url: string; name: string; contentType: string; size: number }[] = [];
  const urls = new Map<string, string>();
  if (files.length === 0) return { attachments, urls };
  if (!storageConfigured()) throw new BotApiError(503, 'Service Unavailable: file storage is not ready');
  for (const f of files) {
    if (attachmentBlocked(f.mime, f.name)) throw new BotApiError(415, 'Bad Request: this file type is not allowed (SVG/HTML)');
    const wait = await attachmentUploadBlock(botId);
    if (wait) throw new BotApiError(429, `Too Many Requests: retry after ${wait}`, wait);
    const url = await putAttachment(newId(), f.buffer, f.mime, f.name, Date.now());
    attachments.push({ url, name: f.name, contentType: f.mime, size: f.buffer.length });
    urls.set(f.name, url);
  }
  return { attachments, urls };
}

export async function channelSendMessage(ctx: BotChannelCtx, p: Params, files: Upload[]) {
  const q = sendMessageParams.parse(p);
  const botId = ctx.bot.userId;
  const { channel, perms } = await channelChatFor(botId, q.chat_id);
  if (!has(perms, Permission.SEND_MESSAGES)) throw new BotApiError(403, 'Forbidden: not enough rights to send messages to the chat');
  await limit(`botchat:${botId}:${channel.id}`, BOT_CHAT_RATE);
  await limit(`botsrv:${botId}:${channel.serverId}`, BOT_SERVER_RATE);
  const text = botText((q.text ?? '').trim(), q.parse_mode).trim();
  if (!text && !q.embeds?.length && files.length === 0) throw new BotApiError(400, 'Bad Request: message text is empty');
  // Вложения каналов — публичный бакет (как у вебхука); карточки — `attachment://имя` из этого же запроса или наши ссылки.
  const { attachments, urls } = await storePublicFiles(botId, files);
  const embeds = normalizeEmbeds(q.embeds, isOwnMediaUrl, urls);
  if (!text && embeds.length === 0 && attachments.length === 0) throw new BotApiError(400, 'Bad Request: message text is empty');
  const fallback = !text && embeds.length > 0;
  const res = await postChannelMessage(botId, channel.id, {
    content: fallback ? embedsFallbackText(embeds) : text,
    attachments,
    replyToId: q.reply_to_message_id ?? null,
    ...(embeds.length ? { embeds, embedsFallback: fallback } : {}),
    keyboard: (q.reply_markup?.inline_keyboard as InlineKeyboard | undefined) ?? null,
    silent: q.disable_notification === true,
  });
  if (res.kind === 'error') throw failToBot(res, 'send');
  return wireOf(ctx, channel, res.message);
}

export async function channelEditMessageText(ctx: BotChannelCtx, p: Params) {
  const q = editMessageTextParams.parse(p);
  const botId = ctx.bot.userId;
  const { channel } = await channelChatFor(botId, q.chat_id);
  await limit(`botchat:${botId}:${channel.id}`, BOT_CHAT_RATE);
  const text = botText(q.text.trim(), q.parse_mode).trim();
  // Как Telegram: правка текста без `reply_markup` снимает кнопки.
  const res = await editChannelMessage(botId, channel.id, q.message_id, text, {
    keyboard: (q.reply_markup?.inline_keyboard as InlineKeyboard | undefined) ?? null,
  });
  if (res.kind === 'error') throw failToBot(res, 'edit');
  return wireOf(ctx, channel, res.message);
}

export async function channelEditMessageReplyMarkup(ctx: BotChannelCtx, p: Params) {
  const q = editMessageReplyMarkupParams.parse(p);
  const botId = ctx.bot.userId;
  const { channel } = await channelChatFor(botId, q.chat_id);
  await limit(`botchat:${botId}:${channel.id}`, BOT_CHAT_RATE);
  const res = await editChannelKeyboard(botId, channel.id, q.message_id, (q.reply_markup?.inline_keyboard as InlineKeyboard | undefined) ?? null);
  if (res.kind === 'error') throw failToBot(res, 'edit');
  return wireOf(ctx, channel, res.message);
}

export async function channelDeleteMessage(ctx: BotChannelCtx, p: Params) {
  const q = deleteMessageParams.parse(p);
  const { channel } = await channelChatFor(ctx.bot.userId, q.chat_id);
  const res = await deleteChannelMessage(ctx.bot.userId, channel.id, q.message_id);
  if (res.kind === 'error') throw failToBot(res, 'delete');
  return true;
}

export async function channelSendChatAction(ctx: BotChannelCtx, p: Params) {
  const q = sendChatActionParams.parse(p);
  const botId = ctx.bot.userId;
  const { channel, perms } = await channelChatFor(botId, q.chat_id);
  if (!has(perms, Permission.SEND_MESSAGES)) throw new BotApiError(403, 'Forbidden: not enough rights to send messages to the chat');
  // Путь «печатает» людей (`gatewayTyping`): аудитория канала, себе не показываем.
  const audience = await getChannelAudience(channel.id);
  if (!audience || audience.serverId !== channel.serverId) throw chatNotFound();
  await publishToChannel(channel.serverId, channel.id, { t: 'typing', channelId: channel.id, userId: botId }, audience.userIds.filter((u) => u !== botId));
  return true;
}

export async function channelGetChat(ctx: BotChannelCtx, p: Params) {
  const q = getChatParams.parse(p);
  const [channel] = await db.select({ id: channels.id }).from(channels).where(eq(channels.id, q.chat_id)).limit(1);
  if (channel) {
    const { channel: ch } = await channelChatFor(ctx.bot.userId, q.chat_id);
    return channelChat(ch);
  }
  const server = await serverChatFor(ctx.bot.userId, q.chat_id);
  return { ...serverChat(server), member_count: await memberCount(server.id) };
}

/** Набор реакций бота заменяется целиком (как Telegram): снять лишние, поставить недостающие. */
export async function channelSetMessageReaction(ctx: BotChannelCtx, p: Params) {
  const q = setMessageReactionParams.parse(p);
  const botId = ctx.bot.userId;
  const { channel } = await channelChatFor(botId, q.chat_id);
  await limit(`botchat:${botId}:${channel.id}`, BOT_CHAT_RATE);
  const want = [...new Set((q.reaction ?? []).map((r) => r.emoji))];
  const have = await reactionsOfUser(q.message_id, botId);
  for (const e of have.filter((x) => !want.includes(x))) {
    const r = await setChannelReaction(botId, channel.id, q.message_id, e, 'remove');
    if (r.kind === 'error') throw failToBot(r, 'react');
  }
  for (const e of want.filter((x) => !have.includes(x))) {
    const r = await setChannelReaction(botId, channel.id, q.message_id, e, 'add');
    if (r.kind === 'error') throw failToBot(r, 'react');
  }
  if (want.length === 0 && have.length === 0) {
    const [m] = await db.select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, q.message_id)).limit(1);
    if (!m || m.channelId !== channel.id) throw new BotApiError(400, 'Bad Request: message to react not found');
  }
  return true;
}

async function pin(ctx: BotChannelCtx, chatId: string, messageId: string, pinned: boolean) {
  const botId = ctx.bot.userId;
  const { channel } = await channelChatFor(botId, chatId);
  await limit(`botchat:${botId}:${channel.id}`, BOT_CHAT_RATE);
  const res = await setChannelPinned(botId, channel.id, messageId, pinned);
  if (res.kind === 'error') throw failToBot(res, 'pin');
  return true;
}

export async function channelPinChatMessage(ctx: BotChannelCtx, p: Params) {
  const q = pinChatMessageParams.parse(p);
  return pin(ctx, q.chat_id, q.message_id, true);
}

export async function channelUnpinChatMessage(ctx: BotChannelCtx, p: Params) {
  const q = unpinChatMessageParams.parse(p);
  return pin(ctx, q.chat_id, q.message_id, false);
}

/** История канала — только при «читать всё» на этом сервере + `READ_HISTORY` (ТЗ §9.10). Старые → новые. */
export async function channelGetChatHistory(ctx: BotChannelCtx, p: Params) {
  const q = getChatHistoryParams.parse(p);
  const botId = ctx.bot.userId;
  const { channel, perms } = await channelChatFor(botId, q.chat_id);
  const [sb] = await db
    .select({ readAll: serverBots.readAll })
    .from(serverBots)
    .where(and(eq(serverBots.serverId, channel.serverId), eq(serverBots.botId, botId)))
    .limit(1);
  if (!sb?.readAll) throw new BotApiError(403, 'Forbidden: history is available only to bots that read all messages');
  if (!has(perms, Permission.READ_HISTORY)) throw new BotApiError(403, 'Forbidden: not enough rights to read history');
  await limit(`botheavy:${botId}`, BOT_HEAVY_RATE);
  let before: Date | null = null;
  if (q.before_message_id) {
    const [b] = await db.select({ createdAt: messages.createdAt, channelId: messages.channelId }).from(messages).where(eq(messages.id, q.before_message_id)).limit(1);
    if (!b || b.channelId !== channel.id) throw new BotApiError(400, 'Bad Request: message not found');
    before = b.createdAt;
  }
  const rows = await db
    .select({ m: messages })
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), before ? lt(messages.createdAt, before) : undefined))
    .orderBy(desc(messages.createdAt))
    .limit(q.limit ?? CHAT_HISTORY_PAGE);
  const chat = channelChat(channel);
  const authors = await wireUsers(rows.map((r) => r.m.authorId));
  const out = [];
  for (const r of rows.reverse()) {
    if (r.m.content === '' && !r.m.attachments.length && !r.m.embeds?.length) continue; // опрос/стикер — не отдаём
    const view = await channelMessageView(r.m);
    out.push(toWireChannelMessage(view, chat, authors.get(r.m.authorId)));
  }
  return out;
}

// ─── Методы: сервер ──────────────────────────────────────────────────────────────────────────────────────────────────

async function memberCount(serverId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.state, 'active')));
  return Number(r?.n ?? 0);
}

async function memberInfo(server: ServerRow, userId: string): Promise<WireChatMemberInfo> {
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw new BotApiError(400, 'Bad Request: user not found');
  const [m] = await db
    .select()
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, userId), eq(serverMembers.state, 'active')))
    .limit(1);
  if (!m) {
    const [b] = await db.select({ userId: bans.userId }).from(bans).where(and(eq(bans.serverId, server.id), eq(bans.userId, userId))).limit(1);
    return { user: wireUserOf(u), status: b ? 'kicked' : 'left', role_ids: [] };
  }
  const roleRows = await db
    .select({ roleId: memberRoles.roleId })
    .from(memberRoles)
    .where(and(eq(memberRoles.serverId, server.id), eq(memberRoles.userId, userId)));
  return {
    user: wireUserOf(u),
    status: server.ownerId === userId ? 'creator' : 'member',
    ...(m.nickname ? { nickname: m.nickname } : {}),
    role_ids: roleRows.map((r) => r.roleId),
    joined_date: unixSeconds(m.joinedAt),
  };
}

export async function serverGetChatMember(ctx: BotChannelCtx, p: Params) {
  const q = getChatMemberParams.parse(p);
  const server = await serverChatFor(ctx.bot.userId, q.chat_id);
  return memberInfo(server, q.user_id);
}

export async function serverGetChatMemberCount(ctx: BotChannelCtx, p: Params) {
  const q = getChatMemberCountParams.parse(p);
  const server = await serverChatFor(ctx.bot.userId, q.chat_id);
  return memberCount(server.id);
}

/** Ростер страницами: курсор — id участника (по возрастанию). */
export async function serverGetChatMembers(ctx: BotChannelCtx, p: Params) {
  const q = getChatMembersParams.parse(p);
  const server = await serverChatFor(ctx.bot.userId, q.chat_id);
  await limit(`botheavy:${ctx.bot.userId}`, BOT_HEAVY_RATE);
  const pageSize = q.limit ?? CHAT_MEMBERS_PAGE;
  const rows = await db
    .select({ m: serverMembers, u: users })
    .from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.state, 'active'), q.offset ? gt(serverMembers.userId, q.offset) : undefined))
    .orderBy(asc(serverMembers.userId))
    .limit(pageSize + 1);
  const page = rows.slice(0, pageSize);
  const ids = page.map((r) => r.u.id);
  const roleRows = ids.length
    ? await db
        .select({ userId: memberRoles.userId, roleId: memberRoles.roleId })
        .from(memberRoles)
        .where(and(eq(memberRoles.serverId, server.id), inArray(memberRoles.userId, ids)))
    : [];
  const byUser = new Map<string, string[]>();
  for (const r of roleRows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.roleId]);
  const members: WireChatMemberInfo[] = page.map(({ m, u }) => ({
    user: wireUserOf(u),
    status: server.ownerId === u.id ? 'creator' : 'member',
    ...(m.nickname ? { nickname: m.nickname } : {}),
    role_ids: byUser.get(u.id) ?? [],
    joined_date: unixSeconds(m.joinedAt),
  }));
  return { members, ...(rows.length > pageSize ? { next_offset: page[page.length - 1].u.id } : {}) };
}

export async function serverGetMyServers(ctx: BotChannelCtx) {
  const rows = await db
    .select({ id: servers.id, title: servers.name })
    .from(serverBots)
    .innerJoin(servers, eq(servers.id, serverBots.serverId))
    .where(eq(serverBots.botId, ctx.bot.userId))
    .orderBy(asc(servers.name));
  return rows;
}

export async function serverGetServer(ctx: BotChannelCtx, p: Params) {
  const q = getServerParams.parse(p);
  const server = await serverChatFor(ctx.bot.userId, q.server_id);
  const chans = await db.select().from(channels).where(eq(channels.serverId, server.id)).orderBy(asc(channels.position));
  const visible = [];
  for (const c of chans) {
    if (c.type !== 'text' && c.type !== 'voice') continue;
    const perms = await getChannelPermissions(c.id, ctx.bot.userId);
    if (!perms || !has(perms.permissions, Permission.VIEW_CHANNEL)) continue;
    visible.push({ id: c.id, title: c.name, type: c.type as 'text' | 'voice', can_send: c.type === 'text' && has(perms.permissions, Permission.SEND_MESSAGES) });
  }
  const roleRows = await db.select().from(roles).where(eq(roles.serverId, server.id)).orderBy(desc(roles.position));
  return {
    id: server.id,
    title: server.name,
    channels: visible,
    roles: roleRows.map((r) => ({ id: r.id, name: r.name, position: r.position, managed: !!r.managedBotId || r.isGuests })),
  };
}

/** Выдать / снять роль участнику (`MANAGE_ROLES` + иерархия, как `PUT|DELETE /servers/:id/members/:userId/roles/:roleId`). */
async function memberRole(ctx: BotChannelCtx, p: Params, add: boolean) {
  const q = chatMemberRoleParams.parse(p);
  const botId = ctx.bot.userId;
  const server = await serverChatFor(botId, q.chat_id);
  await limit(`botsrv:${botId}:${server.id}`, BOT_SERVER_RATE);
  const actor = await getMemberContext(server.id, botId);
  if (!actor) throw chatNotFound();
  const [role] = await db.select().from(roles).where(eq(roles.id, q.role_id)).limit(1);
  if (!role || role.serverId !== server.id) throw new BotApiError(400, 'Bad Request: role not found');
  if (role.isEveryone || role.isGuests || role.managedBotId) throw new BotApiError(400, 'Bad Request: this role is managed and can not be assigned');
  if (!has(actor.serverPermissions, Permission.MANAGE_ROLES)) throw new BotApiError(400, 'Bad Request: not enough rights to manage roles');
  const block = assignRoleBlock({
    isManager: true,
    membersCanAssign: false,
    actorHasRole: false,
    rolePosition: role.position,
    actorHighest: highestPosition(actor),
  });
  if (block) throw new BotApiError(400, 'Bad Request: the role is not lower than the bot role');
  const target = await getMemberContext(server.id, q.user_id);
  const [member] = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, q.user_id)))
    .limit(1);
  if (!target || !member) throw new BotApiError(400, 'Bad Request: user is not a member of the chat');
  if (add) {
    await db.insert(memberRoles).values({ serverId: server.id, userId: q.user_id, roleId: role.id }).onConflictDoNothing();
  } else {
    await db.delete(memberRoles).where(and(eq(memberRoles.serverId, server.id), eq(memberRoles.userId, q.user_id), eq(memberRoles.roleId, role.id)));
  }
  await writeAudit(server.id, botId, add ? 'role.assign' : 'role.unassign', {
    targetType: 'member',
    targetId: q.user_id,
    data: { roleId: role.id, roleName: role.name },
  }).catch(() => {});
  await publishToServer(server.id, { t: 'server.invalidate', serverId: server.id });
  return true;
}

export const serverAddChatMemberRole = (ctx: BotChannelCtx, p: Params) => memberRole(ctx, p, true);
export const serverRemoveChatMemberRole = (ctx: BotChannelCtx, p: Params) => memberRole(ctx, p, false);

function moderationFail(f: { code: number; error: string }): BotApiError {
  if (f.code === 404) return chatNotFound();
  if (f.code === 403 && f.error === 'forbidden') return new BotApiError(400, 'Bad Request: not enough rights to restrict/unrestrict chat member');
  if (f.code === 403) return new BotApiError(400, 'Bad Request: user is an administrator of the chat');
  if (/владел|owner/i.test(f.error)) return new BotApiError(400, "Bad Request: can't remove chat owner");
  if (/себя|yourself/i.test(f.error)) return new BotApiError(400, "Bad Request: can't restrict self");
  return new BotApiError(400, `Bad Request: ${f.error}`);
}

export async function serverBanChatMember(ctx: BotChannelCtx, p: Params) {
  const q = banChatMemberParams.parse(p);
  const server = await serverChatFor(ctx.bot.userId, q.chat_id);
  await limit(`botsrv:${ctx.bot.userId}:${server.id}`, BOT_SERVER_RATE);
  const res = await banMember(server.id, ctx.bot.userId, q.user_id, q.reason);
  if (res.kind === 'error') throw moderationFail(res);
  return true;
}

export async function serverUnbanChatMember(ctx: BotChannelCtx, p: Params) {
  const q = unbanChatMemberParams.parse(p);
  const server = await serverChatFor(ctx.bot.userId, q.chat_id);
  await limit(`botsrv:${ctx.bot.userId}:${server.id}`, BOT_SERVER_RATE);
  const res = await unbanMember(server.id, ctx.bot.userId, q.user_id);
  if (res.kind === 'error') throw moderationFail(res);
  return true;
}

export async function serverKickChatMember(ctx: BotChannelCtx, p: Params) {
  const q = kickChatMemberParams.parse(p);
  const server = await serverChatFor(ctx.bot.userId, q.chat_id);
  await limit(`botsrv:${ctx.bot.userId}:${server.id}`, BOT_SERVER_RATE);
  const res = await kickMember(server.id, ctx.bot.userId, q.user_id);
  if (res.kind === 'error') throw moderationFail(res);
  return true;
}

export async function serverLeaveChat(ctx: BotChannelCtx, p: Params) {
  const q = leaveChatParams.parse(p);
  const server = await serverChatFor(ctx.bot.userId, q.chat_id);
  const res = await leaveServer(server.id, ctx.bot.userId);
  if (res.kind === 'error') throw moderationFail(res);
  return true;
}

// ─── Крючок событий каналов ──────────────────────────────────────────────────────────────────────────────────────────

/** Боты сервера, которым можно писать: строка `server_bots` ∩ аудитория (`VIEW_CHANNEL`) ∩ живые ∩ боты включены. */
async function botsFor(serverId: string, audience: readonly string[] | null): Promise<{ bot: BotRow; readAll: boolean; roleId: string | null }[]> {
  const rows = await db.select({ botId: serverBots.botId, readAll: serverBots.readAll }).from(serverBots).where(eq(serverBots.serverId, serverId));
  if (rows.length === 0) return [];
  const seen = audience ? new Set(audience) : null;
  const cand = rows.filter((r) => !seen || seen.has(r.botId));
  if (cand.length === 0) return [];
  const live = await liveBotsAmong(cand.map((r) => r.botId));
  if (live.size === 0) return [];
  if (!(await readBotSettings()).enabled) return [];
  const roleRows = await db
    .select({ id: roles.id, botId: roles.managedBotId })
    .from(roles)
    .where(and(eq(roles.serverId, serverId), inArray(roles.managedBotId, [...live.keys()])));
  const roleOf = new Map(roleRows.map((r) => [r.botId!, r.id]));
  return cand.filter((r) => live.has(r.botId)).map((r) => ({ bot: live.get(r.botId)!, readAll: r.readAll, roleId: roleOf.get(r.botId) ?? null }));
}

/** Автор — настоящий бот (не вебхук)? Вебхук — `webhookId` в DTO. */
function authorKind(m: Message): 'bot' | 'webhook' | 'human' {
  if (m.webhookId) return 'webhook';
  return m.author.bot ? 'bot' : 'human';
}

export async function recordChannelBotUpdates(
  serverId: string,
  channelId: string,
  ev: ChannelMessageEvent,
  audience: readonly string[],
  actor?: string,
): Promise<void> {
  if (ev.kind === 'pinned' || ev.kind === 'markup') return;
  const bots = await botsFor(serverId, audience);
  if (bots.length === 0) return;
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!channel) return;
  const chat: WireChat = channelChat(channel);
  const now = unixSeconds(Date.now());
  const out: { botId: string; type: 'message' | 'edited_message' | 'message_deleted' | 'message_reaction'; payload: Record<string, unknown>; readAll: boolean }[] = [];

  if (ev.kind === 'created' || ev.kind === 'edited') {
    const m = ev.message;
    // Опрос — отдельным событием не приходит и сообщением не отдаётся (ТЗ §1.3).
    if (m.poll) return;
    const kind = authorKind(m);
    // Сообщения других ботов боту не приходят (защита от петель); своё — тоже.
    if (kind === 'bot') return;
    const targets = bots.filter((b) => b.bot.userId !== actor && b.bot.userId !== m.author.id && (kind !== 'webhook' || b.readAll));
    if (targets.length === 0) return;
    let replyToAuthorId: string | null = null;
    if (m.replyTo?.id && targets.some((b) => !b.readAll)) {
      const [parent] = await db.select({ authorId: messages.authorId }).from(messages).where(eq(messages.id, m.replyTo.id)).limit(1);
      replyToAuthorId = parent?.authorId ?? null;
    }
    const usernames = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, targets.map((b) => b.bot.userId)));
    const nick = new Map(usernames.map((u) => [u.id, u.username]));
    const [authorRow] = await db.select().from(users).where(eq(users.id, m.author.id)).limit(1);
    const from = authorRow ? (m.webhookId ? toWireUser({ id: m.author.id, username: m.author.username, displayName: m.author.displayName, bot: false }) : wireUserOf(authorRow)) : undefined;
    const payload = toWireChannelMessage(m, chat, from) as unknown as Record<string, unknown>;
    for (const b of targets) {
      // Фильтр приватности — ДО журнала: чего бот видеть не должен, в `bot_updates` не попадает вовсе.
      if (!b.readAll && !botAddressed({ content: m.content, mentionRoles: m.mentionRoles, replyToAuthorId }, { id: b.bot.userId, username: nick.get(b.bot.userId) ?? '', roleId: b.roleId })) continue;
      out.push({ botId: b.bot.userId, type: ev.kind === 'created' ? 'message' : 'edited_message', payload, readAll: b.readAll });
    }
  } else if (ev.kind === 'deleted') {
    for (const b of bots) {
      if (b.bot.userId === actor) continue;
      if (!b.readAll && b.bot.userId !== ev.authorId) continue;
      out.push({ botId: b.bot.userId, type: 'message_deleted', payload: { message_id: ev.messageId, chat, date: now }, readAll: b.readAll });
    }
  } else if (ev.kind === 'reaction') {
    const targets = bots.filter((b) => b.bot.userId !== actor && b.bot.userId !== ev.userId && (b.readAll || b.bot.userId === ev.authorId));
    if (targets.length === 0) return;
    const [who] = await db.select().from(users).where(eq(users.id, ev.userId)).limit(1);
    // Реакции других ботов боту не приходят (как их сообщения).
    if (!who || (who.bot && who.verified)) return;
    const now2 = await reactionsOfUser(ev.messageId, ev.userId);
    const before = ev.op === 'add' ? now2.filter((e) => e !== ev.emoji) : [...now2, ev.emoji];
    const payload = {
      chat,
      message_id: ev.messageId,
      user: wireUserOf(who),
      date: now,
      old_reaction: before.map((emoji) => ({ type: 'emoji' as const, emoji })),
      new_reaction: now2.map((emoji) => ({ type: 'emoji' as const, emoji })),
    };
    for (const b of targets) out.push({ botId: b.bot.userId, type: 'message_reaction', payload, readAll: b.readAll });
  }
  if (out.length === 0) return;
  const touched = await pushUpdates(out);
  for (const botId of touched) kickWebhook(botId);
}

// ─── Крючок членства ─────────────────────────────────────────────────────────────────────────────────────────────────

export async function memberBotUpdates(c: MemberChange): Promise<void> {
  const [server] = await db.select().from(servers).where(eq(servers.id, c.serverId)).limit(1);
  if (!server) return;
  const chat = serverChat(server);
  const date = unixSeconds(Date.now());
  const people = await wireUsers([c.userId, ...(c.actorId ? [c.actorId] : [])]);
  const subject = people.get(c.userId);
  if (!subject) return;
  const from = (c.actorId && people.get(c.actorId)) || subject;
  const out: { botId: string; type: 'my_chat_member' | 'chat_member'; payload: Record<string, unknown>; readAll?: boolean }[] = [];
  const enabled = (await readBotSettings()).enabled;

  // Субъект — бот: снятие чистит его события этого сервера (решение владельца), затем `my_chat_member` ему самому.
  const subjectBot = (await liveBotsAmong([c.userId])).get(c.userId);
  if (subjectBot) {
    if (c.to === 'left' || c.to === 'kicked') {
      await dropServerUpdates(c.userId, c.serverId);
      // Этап 4 (#232): бот ушёл с сервера (кик, бан, снятие, удаление) — вон из голосовых комнат этого сервера. Лениво: модуль
      // голоса тянет LiveKit; не нашёлся — добьёт страховочный обход (`sweepBotVoice`).
      await import('./botVoice.js').then((m) => m.dropBotVoice(c.userId, c.serverId), () => undefined);
    }
    if (enabled) out.push({ botId: c.userId, type: 'my_chat_member', payload: { chat, from, date, old_status: c.from, new_status: c.to } });
  }
  if (enabled) {
    for (const b of await botsFor(c.serverId, null)) {
      if (b.bot.userId === c.userId) continue;
      out.push({
        botId: b.bot.userId,
        type: 'chat_member',
        payload: { chat, from, user: subject, date, old_status: c.from, new_status: c.to },
        readAll: b.readAll,
      });
    }
  }
  if (out.length === 0) return;
  const touched = await pushUpdates(out);
  for (const botId of touched) kickWebhook(botId);
}

// ─── Человек нажал кнопку под сообщением бота в канале ───────────────────────────────────────────────────────────────

/** Сообщение канала с кнопками бота глазами бота — для `callback_query.message`. */
export async function channelCallbackMessage(botId: string, channel: ChannelRow, messageId: string): Promise<Record<string, unknown> | null> {
  const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!row || row.channelId !== channel.id || row.authorId !== botId) return null;
  const view = await channelMessageView(row);
  const [botUser] = await db.select().from(users).where(eq(users.id, botId)).limit(1);
  return toWireChannelMessage(view, channelChat(channel), botUser ? wireUserOf(botUser) : undefined) as unknown as Record<string, unknown>;
}

export { botOnServer, botsFor, wireUsers };
export type { Upload as BotChannelUpload };
