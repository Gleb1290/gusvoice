/**
 * Сообщения КАНАЛОВ (#231) — отправка, правка, удаление, реакция, закреп. Вынесено из `routes/messages.ts` без смены
 * поведения людей: маршрут человека и Bot API (`bots/botChannel.ts`) зовут одно и то же — права канала, ответ только в этом
 * канале, упоминания ролей и `@everyone` по правам автора, пуш упомянутым, рассылка через `publishChannelMessageEvent`.
 *
 * Функции не знают про HTTP: отказ — `{kind:'error', code, error, reason}` с теми же кодами и текстами, что отдавал маршрут
 * (`reason` — для провода бота). Пределы частоты и проверка ссылок вложений — у вызывающего (у человека и бота они свои).
 */
import {
  canMentionEveryone,
  has,
  hasBroadcastMention,
  Permission,
  type Attachment,
  type InlineKeyboard,
  type Message,
  type MessageEmbed,
  type MessageReplyPreview,
  type MessageSticker,
  type ReactionGroup,
  type ReactionReactor,
} from '@gusvoice/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { pushDebounced } from './authGuard.js';
import { publishChannelMessageEvent } from './channelEvents.js';
import { replyAttachmentPreview } from './convRules.js';
import { db } from './db/index.js';
import { channels, messageReactions, messages, stickerPacks, stickers, users } from './db/schema.js';
import { getChannelPermissions } from './permissions.js';
import { contentPreview, resolveMentionedMembers, resolveRoleMentions, sendPushToUsers } from './push.js';
import { serializeMessage } from './serialize.js';
import { id } from './util.js';

export type MessageRow = typeof messages.$inferSelect;

export type ChannelFailReason =
  | 'no-channel'
  | 'not-text'
  | 'no-access'
  | 'no-send'
  | 'bad-reply'
  | 'bad-sticker'
  | 'not-found'
  | 'not-author'
  | 'empty'
  | 'no-manage';

export type ChannelFail = { kind: 'error'; code: number; error: string; reason: ChannelFailReason };

const fail = (code: number, error: string, reason: ChannelFailReason): ChannelFail => ({ kind: 'error', code, error, reason });

/** Сколько поставивших канал отдаёт списком на чип реакции (аватарки на чипе — до трёх, как у Telegram Desktop). */
const REACTORS_INLINE_MAX = 3;

/** Aggregate reactions for a batch of messages into per-message groups, with `me` for the viewer. */
export async function reactionsFor(messageIds: string[], viewerId: string): Promise<Map<string, ReactionGroup[]>> {
  const out = new Map<string, ReactionGroup[]>();
  if (messageIds.length === 0) return out;
  const rows = await db.select().from(messageReactions).where(inArray(messageReactions.messageId, messageIds));
  const agg = new Map<string, Map<string, { count: number; me: boolean; reactors: ReactionReactor[] }>>();
  for (const r of rows) {
    let byEmoji = agg.get(r.messageId);
    if (!byEmoji) {
      byEmoji = new Map();
      agg.set(r.messageId, byEmoji);
    }
    const cur = byEmoji.get(r.emoji) ?? { count: 0, me: false, reactors: [] };
    cur.count += 1;
    if (r.userId === viewerId) cur.me = true;
    cur.reactors.push({ userId: r.userId, at: r.createdAt.toISOString() });
    byEmoji.set(r.emoji, cur);
  }
  for (const [mid, byEmoji] of agg) {
    out.set(
      mid,
      [...byEmoji.entries()].map(([emoji, v]) => {
        const g: ReactionGroup = { emoji, count: v.count, me: v.me };
        // «Кто поставил» (G75, #211; Telegram Desktop `kMaxRecentUserpics`): список — только пока людей немного (чип рисует их
        // аватарки вместо числа); в каналах людей бывают сотни, большим группам список не шлём — чип с числом, как было.
        // Только добавление к DTO (правило 11): `count` и `me` прежние.
        if (v.count <= REACTORS_INLINE_MAX) {
          g.reactors = [...v.reactors].sort((x, y) => x.at.localeCompare(y.at) || x.userId.localeCompare(y.userId));
        }
        return g;
      }),
    );
  }
  return out;
}

/**
 * Build compact reply previews (author name + content) for a batch of parent message ids.
 * 05.10: плюс вид вложений цитируемого (`convRules.replyAttachmentPreview`: число, вид, длительность, имя файла, видео;
 * стикер — вид `sticker`) — цитата на сообщение вне загруженного окна пишет «Фото» / «Видео» / «Стикер», а не
 * «вложение». Миниатюры нет: цитата канала — одна строка словами. Цитируемое всегда из того же канала (проверка при
 * отправке), так что смотрящему оно и так видно.
 */
export async function replyPreviewsFor(replyToIds: (string | null)[]): Promise<Map<string, MessageReplyPreview>> {
  const ids = [...new Set(replyToIds.filter((x): x is string => !!x))];
  const out = new Map<string, MessageReplyPreview>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ m: messages, u: users })
    .from(messages)
    .innerJoin(users, eq(messages.authorId, users.id))
    .where(inArray(messages.id, ids));
  for (const r of rows) {
    out.set(r.m.id, {
      id: r.m.id,
      // Вебхук (#24): имя, под которым пришло сообщение, а не служебной строки-автора.
      authorName: r.m.webhookId ? (r.m.webhookName ?? r.u.displayName) : r.u.displayName,
      content: r.m.content,
      ...replyAttachmentPreview(r.m.attachments, !!r.m.sticker),
    });
  }
  return out;
}

/** Строка сообщения → DTO (автор, цитата; реакции — если `viewerId` задан). */
export async function channelMessageView(row: MessageRow, viewerId?: string): Promise<Message> {
  const [author] = await db.select().from(users).where(eq(users.id, row.authorId)).limit(1);
  const replies = await replyPreviewsFor([row.replyToId]);
  const reactions = viewerId ? await reactionsFor([row.id], viewerId) : null;
  return serializeMessage({
    ...row,
    author,
    ...(reactions ? { reactions: reactions.get(row.id) ?? [] } : {}),
    replyTo: row.replyToId ? (replies.get(row.replyToId) ?? null) : null,
  });
}

export interface PostChannelInput {
  /** Уже обрезанный текст. */
  content: string;
  attachments: Attachment[];
  replyToId?: string | null;
  /** Стикер из набора ЭТОГО сервера (#68). */
  stickerId?: string | null;
  /** Карточки (бот, #231) — уже проверенные `normalizeEmbeds`. */
  embeds?: MessageEmbed[];
  embedsFallback?: boolean;
  /** Кнопки (бот, #231). */
  keyboard?: InlineKeyboard | null;
  /** Не будить упомянутых пушем (`disable_notification` бота). */
  silent?: boolean;
}

/**
 * Отправить сообщение в текстовый канал от `authorId` (человек или бот — права одни, `getChannelPermissions`).
 * Пустоту, предел частоты и «вложение загружено через этот сервер» проверяет вызывающий.
 */
export async function postChannelMessage(
  authorId: string,
  channelId: string,
  input: PostChannelInput,
): Promise<{ kind: 'ok'; message: Message; row: MessageRow } | ChannelFail> {
  const content = input.content;
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!channel) return fail(404, 'not found', 'no-channel');
  if (channel.type !== 'text') return fail(400, 'not a text channel', 'not-text');

  const perms = await getChannelPermissions(channelId, authorId);
  if (!perms) return fail(404, 'not found', 'no-access');
  if (!has(perms.permissions, Permission.SEND_MESSAGES)) return fail(403, 'forbidden', 'no-send');

  // A reply must point at an existing message in this same channel.
  let replyToId: string | null = null;
  if (input.replyToId) {
    const [parent] = await db.select().from(messages).where(eq(messages.id, input.replyToId)).limit(1);
    if (!parent || parent.channelId !== channelId) return fail(400, 'invalid reply target', 'bad-reply');
    replyToId = parent.id;
  }

  // Стикер разрешаем ТОЛЬКО из набора этого же сервера: иначе по id можно было бы утащить в чат
  // стикер чужого сервера, где отправитель даже не состоит. Кладём копией — набор потом удалят,
  // а сообщение обязано остаться целым.
  let sticker: MessageSticker | null = null;
  if (input.stickerId) {
    const [found] = await db
      .select({ id: stickers.id, emoji: stickers.emoji, url: stickers.url, format: stickers.format })
      .from(stickers)
      .innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id))
      .where(and(eq(stickers.id, input.stickerId), eq(stickerPacks.serverId, channel.serverId)))
      .limit(1);
    if (!found) return fail(400, 'стикера нет на этом сервере', 'bad-sticker');
    sticker = found;
  }

  const [author] = await db.select().from(users).where(eq(users.id, authorId)).limit(1);
  // `@Роль` (#76): какие роли сообщение реально зовёт — решаем СЕЙЧАС, по праву автора, и кладём в сообщение.
  const mentionRoleIds = await resolveRoleMentions(content, channel.serverId, perms.permissions);
  // `@everyone`/`@here` (#76): зовут только с правом `MENTION_EVERYONE` (в канале — с учётом его переопределений); без
  // права текст остаётся, но флаг `false` гасит звук, значок и пуш. Нет таких обращений — NULL.
  const broadcastText = hasBroadcastMention(content);
  const mentionEveryone = broadcastText ? canMentionEveryone(perms.permissions) : null;
  const [row] = await db
    .insert(messages)
    .values({
      id: id(),
      channelId,
      authorId: author.id,
      content,
      attachments: input.attachments,
      replyToId,
      sticker,
      mentionRoles: mentionRoleIds,
      mentionEveryone,
      ...(input.embeds?.length ? { embeds: input.embeds, embedsFallback: input.embedsFallback === true } : {}),
      ...(input.keyboard?.length ? { keyboard: input.keyboard } : {}),
    })
    .returning();

  const replies = await replyPreviewsFor([replyToId]);
  const message = serializeMessage({ ...row, author, replyTo: replyToId ? (replies.get(replyToId) ?? null) : null });
  await publishChannelMessageEvent(channel.serverId, channelId, { kind: 'created', message }, author.id);
  if (input.silent) return { kind: 'ok', message, row };
  // Wake offline @mentioned members (fire-and-forget; only fires when the content has an @mention).
  void resolveMentionedMembers(content, channel.serverId, author.id, channelId, mentionRoleIds, mentionEveryone !== false).then(async (ids) => {
    if (ids.length === 0) return;
    // Push-bomb debounce (#5, P1-3): at most one mention-push per recipient per channel per window,
    // so a burst of @mentions can't machine-gun someone's phone.
    const fresh: string[] = [];
    for (const uid of ids) if (!(await pushDebounced(uid, channelId))) fresh.push(uid);
    if (fresh.length === 0) return;
    // source = this server, so a member who muted the server won't get a phone push.
    return sendPushToUsers(
      fresh,
      {
        type: 'mention',
        title: author.displayName,
        body: contentPreview(content, input.attachments.length),
        channelId,
        serverId: channel.serverId,
      },
      { scope: 'server', targetId: channel.serverId },
    );
  });
  return { kind: 'ok', message, row };
}

/**
 * Правка своего сообщения. `keyboard` (бот): `undefined` — кнопки не трогаем (человек), `null` — снять, массив — заменить.
 * Текст не изменился — без «изм.» и без рассылки правки; сменились одни кнопки — людям `message.update` (вид `markup`), без
 * «изм.».
 */
export async function editChannelMessage(
  actorId: string,
  channelId: string,
  messageId: string,
  content: string,
  opts: { keyboard?: InlineKeyboard | null } = {},
): Promise<{ kind: 'ok'; message: Message } | ChannelFail> {
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!msg || msg.channelId !== channelId) return fail(404, 'not found', 'not-found');
  if (msg.authorId !== actorId) return fail(403, 'forbidden', 'not-author');
  // Пробелы проходили `.min(1)` до обрезки и давали пустую реплику (#212) — разбор был в снятом `routes/dm.ts`.
  if (!content && msg.attachments.length === 0 && !msg.embeds?.length) return fail(400, 'empty message', 'empty');

  const perms = await getChannelPermissions(channelId, actorId);
  if (!perms) return fail(404, 'not found', 'no-access');

  // Текст не изменился (06.10, сверка с Telegram): «правка» без изменений не ставит «изм.» и не рассылается — как у бесед
  // (`conversations.editMessage`). Ответ прежний — сообщение как есть (старый клиент подставляет его себе в ленту).
  const unchanged = content === msg.content;
  const nextKeyboard = opts.keyboard === undefined ? msg.keyboard : opts.keyboard?.length ? opts.keyboard : null;
  const keyboardChanged = opts.keyboard !== undefined && JSON.stringify(msg.keyboard ?? null) !== JSON.stringify(nextKeyboard ?? null);
  let row = msg;
  if (!unchanged) {
    [row] = await db.update(messages).set({ content, editedAt: new Date(), keyboard: nextKeyboard }).where(eq(messages.id, messageId)).returning();
  } else if (keyboardChanged) {
    // Одни кнопки (бот): без «изм.» — `editedAt` не трогаем.
    [row] = await db.update(messages).set({ keyboard: nextKeyboard }).where(eq(messages.id, messageId)).returning();
  }
  const [author] = await db.select().from(users).where(eq(users.id, msg.authorId)).limit(1);
  const replies = await replyPreviewsFor([row.replyToId]);
  const message = serializeMessage({
    ...row,
    author,
    replyTo: row.replyToId ? (replies.get(row.replyToId) ?? null) : null,
  });
  if (!unchanged) await publishChannelMessageEvent(perms.serverId, channelId, { kind: 'edited', message }, actorId);
  else if (keyboardChanged) await publishChannelMessageEvent(perms.serverId, channelId, { kind: 'markup', message }, actorId);
  return { kind: 'ok', message };
}

/** Сменить одни кнопки своего сообщения (бот, `editMessageReplyMarkup`): без «изм.», боту события нет. */
export async function editChannelKeyboard(
  actorId: string,
  channelId: string,
  messageId: string,
  keyboard: InlineKeyboard | null,
): Promise<{ kind: 'ok'; message: Message } | ChannelFail> {
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!msg || msg.channelId !== channelId) return fail(404, 'not found', 'not-found');
  return editChannelMessage(actorId, channelId, messageId, msg.content, { keyboard });
}

/** Удалить сообщение: автор — всегда, чужое — с `MANAGE_MESSAGES`. */
export async function deleteChannelMessage(actorId: string, channelId: string, messageId: string): Promise<{ kind: 'ok' } | ChannelFail> {
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!msg || msg.channelId !== channelId) return fail(404, 'not found', 'not-found');

  const perms = await getChannelPermissions(channelId, actorId);
  if (!perms) return fail(404, 'not found', 'no-access');
  const isAuthor = msg.authorId === actorId;
  if (!isAuthor && !has(perms.permissions, Permission.MANAGE_MESSAGES)) return fail(403, 'forbidden', 'no-manage');

  await db.delete(messages).where(eq(messages.id, messageId));
  await publishChannelMessageEvent(perms.serverId, channelId, { kind: 'deleted', messageId, authorId: msg.authorId }, actorId);
  return { kind: 'ok' };
}

/** Поставить или снять одну свою реакцию (`VIEW_CHANNEL`). `changed=false` — повтор, ничего не разослано. */
export async function setChannelReaction(
  userId: string,
  channelId: string,
  messageId: string,
  emoji: string,
  op: 'add' | 'remove',
): Promise<{ kind: 'ok'; changed: boolean } | ChannelFail> {
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!msg || msg.channelId !== channelId) return fail(404, 'not found', 'not-found');

  const perms = await getChannelPermissions(channelId, userId);
  if (!perms || !has(perms.permissions, Permission.VIEW_CHANNEL)) return fail(403, 'forbidden', 'no-access');

  // Рассылаем только настоящее изменение: повтор запроса иначе удваивал реакцию у всех на экране (#212,
  // разбор был в снятом `routes/dm.ts`).
  const changed =
    op === 'add'
      ? await db.insert(messageReactions).values({ messageId, userId, emoji }).onConflictDoNothing().returning({ id: messageReactions.messageId })
      : await db
          .delete(messageReactions)
          .where(and(eq(messageReactions.messageId, messageId), eq(messageReactions.userId, userId), eq(messageReactions.emoji, emoji)))
          .returning({ id: messageReactions.messageId });
  if (changed.length === 0) return { kind: 'ok', changed: false };
  await publishChannelMessageEvent(perms.serverId, channelId, { kind: 'reaction', messageId, authorId: msg.authorId, userId, emoji, op }, userId);
  return { kind: 'ok', changed: true };
}

/** Набор реакций одного человека на сообщение (порядок постановки). */
export async function reactionsOfUser(messageId: string, userId: string): Promise<string[]> {
  const rows = await db
    .select({ emoji: messageReactions.emoji, at: messageReactions.createdAt })
    .from(messageReactions)
    .where(and(eq(messageReactions.messageId, messageId), eq(messageReactions.userId, userId)));
  return rows.sort((a, b) => a.at.getTime() - b.at.getTime()).map((r) => r.emoji);
}

/** Закрепить / снять (`MANAGE_MESSAGES`). Людям — `message.update`, ботам ничего. */
export async function setChannelPinned(
  actorId: string,
  channelId: string,
  messageId: string,
  pinned: boolean,
): Promise<{ kind: 'ok'; message: Message } | ChannelFail> {
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!msg || msg.channelId !== channelId) return fail(404, 'not found', 'not-found');

  const perms = await getChannelPermissions(channelId, actorId);
  if (!perms) return fail(404, 'not found', 'no-access');
  if (!has(perms.permissions, Permission.MANAGE_MESSAGES)) return fail(403, 'forbidden', 'no-manage');

  const [row] = await db
    .update(messages)
    .set({ pinnedAt: pinned ? new Date() : null })
    .where(eq(messages.id, messageId))
    .returning();
  const message = await channelMessageView(row, actorId);
  await publishChannelMessageEvent(perms.serverId, channelId, { kind: 'pinned', message }, actorId);
  return { kind: 'ok', message };
}
