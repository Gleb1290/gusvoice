import {
  checkPollDraft,
  has,
  Permission,
  POLL_MAX_HOURS,
  POLL_MAX_OPTIONS,
  SERVER_SEARCH_MIN_CHARS,
  VOICE_MAX_MS,
  WAVEFORM_BUCKETS,
  type Attachment,
  type MessageReplyPreview,
  type MessageSticker,
  type ReactionGroup,
  type ReactionReactor,
  type ServerSearchResponse,
} from '@gusvoice/shared';
import { and, desc, eq, ilike, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import {
  attachmentUploadBlock,
  heavyReadBlock,
  messageSendBlock,
  pushDebounced,
  retryMessage,
  serverSearchBlock,
} from '../authGuard.js';
import { db } from '../db/index.js';
import { pollsFor, vote, votersOf } from '../polls.js';
import { MESSAGE_TEXT_MAX, replyAttachmentPreview, TEXT_TOO_LONG } from '../convRules.js';
import { channelReads, channels, messageReactions, messages, polls, stickerPacks, stickers, users } from '../db/schema.js';
import { getChannelPermissions, getServerChannelPermissions, searchableChannelIds } from '../permissions.js';
import { contentPreview, resolveMentionedMembers, sendPushToUsers } from '../push.js';
import { publishToChannel, publishToUser } from '../realtime.js';
import { serializeMessage, serializeUserBrief } from '../serialize.js';
import { attachmentBlocked, isOwnMediaUrl, putAttachment, storageConfigured } from '../storage.js';
import { id } from '../util.js';
import { searchAllServers, splitCursor } from '../serverSearch.js';
import { releaseQuota, reserveQuota } from '../federation/guestQuota.js';

/** Сколько поставивших канал отдаёт списком на чип реакции (аватарки на чипе — до трёх, как у Telegram Desktop). */
const REACTORS_INLINE_MAX = 3;

/** Aggregate reactions for a batch of messages into per-message groups, with `me` for the viewer. */
async function reactionsFor(messageIds: string[], viewerId: string): Promise<Map<string, ReactionGroup[]>> {
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
async function replyPreviewsFor(replyToIds: (string | null)[]): Promise<Map<string, MessageReplyPreview>> {
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
      authorName: r.u.displayName,
      content: r.m.content,
      ...replyAttachmentPreview(r.m.attachments, !!r.m.sticker),
    });
  }
  return out;
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // List recent messages (newest-last). Cursor: ?beforeId=<message id> (?before=<ISO> — fallback).
  app.get('/channels/:id/messages', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
    const query = z
      .object({
        before: z.string().datetime().optional(),
        beforeId: z.string().min(1).max(64).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.VIEW_CHANNEL)) return reply.code(403).send({ error: 'forbidden' });

    // Курсор (время, id) — та же дыра на границе миллисекунды, что и в ЛС (разбор — `routes/dm.ts`).
    const cursor = query.beforeId
      ? (
          await db
            .select({ id: messages.id })
            .from(messages)
            .where(and(eq(messages.id, query.beforeId), eq(messages.channelId, channelId)))
            .limit(1)
        )[0]
      : undefined;
    const where = cursor
      ? and(
          eq(messages.channelId, channelId),
          sql`(${messages.createdAt}, ${messages.id}) < (SELECT created_at, id FROM messages WHERE id = ${cursor.id})`,
        )
      : query.before
        ? and(eq(messages.channelId, channelId), lt(messages.createdAt, new Date(query.before)))
        : eq(messages.channelId, channelId);

    const rows = await db
      .select({ m: messages, u: users })
      .from(messages)
      .innerJoin(users, eq(messages.authorId, users.id))
      .where(where)
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(query.limit);

    const list = rows.reverse();
    const reactions = await reactionsFor(
      list.map((r) => r.m.id),
      req.user!.sub,
    );
    const replies = await replyPreviewsFor(list.map((r) => r.m.replyToId));
    const pollMap = await pollsFor(
      list.map((r) => r.m.id),
      req.user!.sub,
    );
    return list.map((r) =>
      serializeMessage({
        ...r.m,
        author: r.u,
        reactions: reactions.get(r.m.id) ?? [],
        replyTo: r.m.replyToId ? (replies.get(r.m.replyToId) ?? null) : null,
        poll: pollMap.get(r.m.id) ?? null,
      }),
    );
  });

  // Search messages across the server's channels the user may read. Cursor: ?before=<ISO>.
  app.get('/servers/:id/search', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const q = z
      .object({
        q: z.string().trim().min(1).max(200),
        channelId: z.string().optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(25),
      })
      .parse(req.query);

    // Expensive-read rate-limit (P2-2): search is an unindexed ilike scan — don't let it be looped.
    const rl = await heavyReadBlock(req.user!.sub);
    if (rl) return reply.code(429).header('Retry-After', String(rl)).send({ error: retryMessage(rl) });

    const perms = await getServerChannelPermissions(serverId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not a member' });

    // Only channels the user can both VIEW and READ_HISTORY are searchable.
    let visible = searchableChannelIds(perms);
    if (q.channelId) visible = visible.filter((cid) => cid === q.channelId);
    if (visible.length === 0) return [];

    const escaped = q.q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const conds = [inArray(messages.channelId, visible), ilike(messages.content, `%${escaped}%`)];
    if (q.before) conds.push(lt(messages.createdAt, new Date(q.before)));

    const rows = await db
      .select({ m: messages, u: users })
      .from(messages)
      .innerJoin(users, eq(messages.authorId, users.id))
      .where(and(...conds))
      .orderBy(desc(messages.createdAt))
      .limit(q.limit);

    const reactions = await reactionsFor(
      rows.map((r) => r.m.id),
      req.user!.sub,
    );
    return rows.map((r) => serializeMessage({ ...r.m, author: r.u, reactions: reactions.get(r.m.id) ?? [] }));
  });

  // Поиск по ВСЕМ моим серверам этого инстанса (G35, `srvsearch1`): вкладка «Серверы» в поиске из списка ЛС. Права — те же, что
  // выше (`searchableChannelIds` по `getServerChannelPermissions`), см. `serverSearch.ts`. Курсор `before` — из `next` прошлой порции.
  app.get('/search/servers', async (req, reply) => {
    const q = z
      .object({
        q: z.string().trim().min(2).max(200),
        before: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(25),
      })
      .parse(req.query);
    const before = q.before ? splitCursor(q.before) : undefined;
    if (q.before && !before) return reply.code(400).send({ error: 'bad cursor' });
    // От 3 знаков (решение владельца 21, `SERVER_SEARCH_MIN_CHARS`): короче — пусто, без похода в базу и без траты лимита.
    if ([...q.q].length < SERVER_SEARCH_MIN_CHARS) return { hits: [], next: null } satisfies ServerSearchResponse;
    // Свой, более жёсткий лимит (`serverSearchBlock`: 20 в минуту), а не общий `heavyReadBlock` 40 / 10 с: запрос идёт по
    // каналам ВСЕХ моих серверов сразу.
    const rl = await serverSearchBlock(req.user!.sub);
    if (rl) return reply.code(429).header('Retry-After', String(rl)).send({ error: retryMessage(rl) });
    return searchAllServers(req.user!.sub, { q: q.q, before: before ?? undefined, limit: q.limit });
  });

  // Advance my read mark for a channel (persisted unread — migration 0018).
  app.post('/channels/:id/read', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    const at = new Date();
    await db
      .insert(channelReads)
      .values({ userId: req.user!.sub, channelId, lastReadAt: at })
      .onConflictDoUpdate({ target: [channelReads.userId, channelReads.channelId], set: { lastReadAt: at } });
    /* Рассказать ОСТАЛЬНЫМ СВОИМ устройствам, что это прочитано (20.09). Раньше ручка писала строку
       и молчала: прочитал с телефона — на компьютере значок горел до перезахода. Адресно по
       `userId`, чтобы «что я прочитал» не уехало соседям по серверу. Отправка не ждёт ответа и не
       может помешать самой отметке. */
    void publishToUser(req.user!.sub, {
      t: 'read.channel',
      channelId,
      serverId: perms.serverId,
      at: at.toISOString(),
    }).catch(() => {});
    return { ok: true };
  });

  // Upload one attachment (image/file) for a channel; returns its metadata to attach to a message.
  app.post('/channels/:id/attachments', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.SEND_MESSAGES)) return reply.code(403).send({ error: 'forbidden' });
    if (!storageConfigured()) return reply.code(503).send({ error: 'attachments storage not configured' });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no file' });
    const buffer = await file.toBuffer();
    if (file.file.truncated) return reply.code(413).send({ error: 'request file too large' }); // обрезан по пределу multipart — см. att.ts
    const mime = file.mimetype || 'application/octet-stream';
    const name = file.filename || 'file';
    // Reject script-capable web types (P2-1/P3-8) — SVG/HTML could execute if rendered inline.
    if (attachmentBlocked(mime, name)) return reply.code(415).send({ error: 'этот тип файла запрещён (SVG/HTML)' });
    // Upload rate-limit (P2-3): bound MinIO writes (storage-exhaustion). Checked AFTER buffering (so the
    // multipart stream is drained), BEFORE the bucket write.
    const upWait = await attachmentUploadBlock(req.user!.sub);
    if (upWait) return reply.code(429).header('Retry-After', String(upWait)).send({ error: retryMessage(upWait) });
    /**
     * Квота хранилища для гостей (#139, F3, §5.10, требование 30): файлы чужих людей лежат у нас и
     * стоят нам места. Предел — на СВЯЗКУ, чтобы держателю было с кем разговаривать. Местных не
     * касается вовсе.
     *
     * ⚠️ Стоит именно на вложениях: эмодзи и стикеры требуют прав управления сервером (их гостю
     * дают осознанно и поимённо), а вложения шлёт каждый участник по десятку в день — объём здесь.
     *
     * 🔴 Место ЗАНИМАЕТСЯ одним запросом до записи файла, а не «проверили → записали → посчитали»
     * (нашёл Codex 16.09): две одновременные загрузки читали одно и то же занятое и обе проходили
     * предел. Предел, который обходится двумя вкладками, это не предел.
     */
    const quota = await reserveQuota(req.user!.sub, buffer.length);
    if (quota) return reply.code(413).send({ error: quota });
    let url: string;
    try {
      url = await putAttachment(id(), buffer, mime, name, Date.now());
    } catch (err) {
      // Хранилище не приняло файл — возвращаем занятое: наша неудача не должна съедать чужую квоту.
      await releaseQuota(req.user!.sub, buffer.length);
      throw err;
    }
    const attachment: Attachment = { url, name, contentType: mime, size: buffer.length };
    return reply.send(attachment);
  });

  // Post a message (text and/or up to 10 attachments).
  app.post('/channels/:id/messages', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        content: z.string().max(MESSAGE_TEXT_MAX, TEXT_TOO_LONG).optional().default(''),
        attachments: z
          .array(
            z.object({
              url: z.string().url(),
              name: z.string().min(1).max(300),
              contentType: z.string().min(1).max(150),
              size: z.number().int().nonnegative(),
              // Размер картинки (#194) — со слов отправителя, клиент задаёт им только место до загрузки. Потолок —
              // чтобы в jsonb не уезжали числа, которых у картинок не бывает (`imageSize.IMAGE_DIM_MAX`).
              width: z.number().int().positive().max(20_000).nullish(),
              height: z.number().int().positive().max(20_000).nullish(),
              // Голосовое сообщение (#20). Границы жёсткие: это чужие данные, и они попадают
              // в jsonb сообщения как есть — без потолка сюда уедет массив любой длины.
              waveform: z.array(z.number().int().min(0).max(100)).max(WAVEFORM_BUCKETS).nullish(),
              durationMs: z.number().int().positive().max(VOICE_MAX_MS).nullish(),
            }),
          )
          .max(10)
          .optional()
          .default([]),
        replyToId: z.string().nullish(),
        /** Стикер из набора ЭТОГО сервера (#68). Текст при нём обычно пустой. */
        stickerId: z.string().nullish(),
      })
      .parse(req.body);
    const content = body.content.trim();
    if (!content && body.attachments.length === 0 && !body.stickerId)
      return reply.code(400).send({ error: 'empty message' });

    // Anti-spam (#5, P1-3): cap outbound message rate per user (channels + DMs share one budget).
    const wait = await messageSendBlock(req.user!.sub);
    if (wait) return reply.code(429).header('Retry-After', String(wait)).send({ error: retryMessage(wait) });
    // Attachment URLs must point at OUR bucket (#4, P1-2) — reject a smuggled external URL (tracking pixel).
    if (body.attachments.some((a) => !isOwnMediaUrl(a.url)))
      return reply.code(400).send({ error: 'вложение должно быть загружено через этот сервер' });

    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel) return reply.code(404).send({ error: 'not found' });
    if (channel.type !== 'text') return reply.code(400).send({ error: 'not a text channel' });

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.SEND_MESSAGES)) return reply.code(403).send({ error: 'forbidden' });

    // A reply must point at an existing message in this same channel.
    let replyToId: string | null = null;
    if (body.replyToId) {
      const [parent] = await db.select().from(messages).where(eq(messages.id, body.replyToId)).limit(1);
      if (!parent || parent.channelId !== channelId) return reply.code(400).send({ error: 'invalid reply target' });
      replyToId = parent.id;
    }

    // Стикер разрешаем ТОЛЬКО из набора этого же сервера: иначе по id можно было бы утащить в чат
    // стикер чужого сервера, где отправитель даже не состоит. Кладём копией — набор потом удалят,
    // а сообщение обязано остаться целым.
    let sticker: MessageSticker | null = null;
    if (body.stickerId) {
      const [found] = await db
        .select({ id: stickers.id, emoji: stickers.emoji, url: stickers.url, format: stickers.format })
        .from(stickers)
        .innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id))
        .where(and(eq(stickers.id, body.stickerId), eq(stickerPacks.serverId, channel.serverId)))
        .limit(1);
      if (!found) return reply.code(400).send({ error: 'стикера нет на этом сервере' });
      sticker = found;
    }

    const [author] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
    const [row] = await db
      .insert(messages)
      .values({ id: id(), channelId, authorId: author.id, content, attachments: body.attachments, replyToId, sticker })
      .returning();

    const replies = await replyPreviewsFor([replyToId]);
    const message = serializeMessage({ ...row, author, replyTo: replyToId ? (replies.get(replyToId) ?? null) : null });
    await publishToChannel(channel.serverId, channelId, { t: 'message.create', channelId, serverId: channel.serverId, message });
    // Wake offline @mentioned members (fire-and-forget; only fires when the content has an @mention).
    void resolveMentionedMembers(content, channel.serverId, author.id, channelId).then(async (ids) => {
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
          body: contentPreview(content, body.attachments.length),
          channelId,
          serverId: channel.serverId,
        },
        { scope: 'server', targetId: channel.serverId },
      );
    });
    return reply.code(201).send(message);
  });

  // Edit your own message's text.
  app.patch('/channels/:id/messages/:messageId', async (req, reply) => {
    const { id: channelId, messageId } = z.object({ id: z.string(), messageId: z.string() }).parse(req.params);
    const { content: raw } = z.object({ content: z.string().max(MESSAGE_TEXT_MAX, TEXT_TOO_LONG) }).parse(req.body);
    const content = raw.trim();

    const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!msg || msg.channelId !== channelId) return reply.code(404).send({ error: 'not found' });
    if (msg.authorId !== req.user!.sub) return reply.code(403).send({ error: 'forbidden' });
    // Пробелы проходили `.min(1)` до обрезки и давали пустую реплику (#212) — разбор в `routes/dm.ts`.
    if (!content && msg.attachments.length === 0) return reply.code(400).send({ error: 'empty message' });

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });

    // Текст не изменился (06.10, сверка с Telegram): «правка» без изменений не ставит «изм.» и не рассылается — как у бесед
    // (`conversations.editMessage`). Ответ прежний — сообщение как есть (старый клиент подставляет его себе в ленту).
    const unchanged = content === msg.content;
    const [row] = unchanged
      ? [msg]
      : await db.update(messages).set({ content, editedAt: new Date() }).where(eq(messages.id, messageId)).returning();
    const [author] = await db.select().from(users).where(eq(users.id, msg.authorId)).limit(1);
    const replies = await replyPreviewsFor([row.replyToId]);
    const message = serializeMessage({
      ...row,
      author,
      replyTo: row.replyToId ? (replies.get(row.replyToId) ?? null) : null,
    });
    if (!unchanged) await publishToChannel(perms.serverId, channelId, { t: 'message.update', channelId, message });
    return reply.send(message);
  });

  // Delete a message (author or MANAGE_MESSAGES).
  app.delete('/channels/:id/messages/:messageId', async (req, reply) => {
    const { id: channelId, messageId } = z.object({ id: z.string(), messageId: z.string() }).parse(req.params);

    const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!msg || msg.channelId !== channelId) return reply.code(404).send({ error: 'not found' });

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    const isAuthor = msg.authorId === req.user!.sub;
    if (!isAuthor && !has(perms.permissions, Permission.MANAGE_MESSAGES)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    await db.delete(messages).where(eq(messages.id, messageId));
    await publishToChannel(perms.serverId, channelId, { t: 'message.delete', channelId, messageId });
    return reply.code(204).send();
  });

  // Add or remove the caller's emoji reaction to a message.
  app.post('/channels/:id/messages/:messageId/reactions', async (req, reply) => {
    const { id: channelId, messageId } = z.object({ id: z.string(), messageId: z.string() }).parse(req.params);
    const { emoji, op } = z.object({ emoji: z.string().min(1).max(32), op: z.enum(['add', 'remove']) }).parse(req.body);

    const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!msg || msg.channelId !== channelId) return reply.code(404).send({ error: 'not found' });

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms || !has(perms.permissions, Permission.VIEW_CHANNEL)) return reply.code(403).send({ error: 'forbidden' });

    // Рассылаем только настоящее изменение: повтор запроса иначе удваивал реакцию у всех на экране (#212,
    // разбор — `routes/dm.ts`).
    const changed =
      op === 'add'
        ? await db
            .insert(messageReactions)
            .values({ messageId, userId: req.user!.sub, emoji })
            .onConflictDoNothing()
            .returning({ id: messageReactions.messageId })
        : await db
            .delete(messageReactions)
            .where(
              and(
                eq(messageReactions.messageId, messageId),
                eq(messageReactions.userId, req.user!.sub),
                eq(messageReactions.emoji, emoji),
              ),
            )
            .returning({ id: messageReactions.messageId });
    if (changed.length === 0) return reply.code(204).send();
    await publishToChannel(perms.serverId, channelId, { t: 'message.reaction', channelId, messageId, emoji, userId: req.user!.sub, op });
    return reply.code(204).send();
  });

  // Pin / unpin a message (MANAGE_MESSAGES). Re-serializes and broadcasts the message.
  async function setPinned(req: FastifyRequest, reply: FastifyReply, pinned: boolean) {
    const { id: channelId, messageId } = z.object({ id: z.string(), messageId: z.string() }).parse(req.params);
    const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!msg || msg.channelId !== channelId) return reply.code(404).send({ error: 'not found' });

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.MANAGE_MESSAGES)) return reply.code(403).send({ error: 'forbidden' });

    const [row] = await db
      .update(messages)
      .set({ pinnedAt: pinned ? new Date() : null })
      .where(eq(messages.id, messageId))
      .returning();
    const [author] = await db.select().from(users).where(eq(users.id, row.authorId)).limit(1);
    const reactions = await reactionsFor([row.id], req.user!.sub);
    const replies = await replyPreviewsFor([row.replyToId]);
    const message = serializeMessage({
      ...row,
      author,
      reactions: reactions.get(row.id) ?? [],
      replyTo: row.replyToId ? (replies.get(row.replyToId) ?? null) : null,
    });
    await publishToChannel(perms.serverId, channelId, { t: 'message.update', channelId, message });
    return reply.send(message);
  }
  app.put('/channels/:id/messages/:messageId/pin', (req, reply) => setPinned(req, reply, true));
  app.delete('/channels/:id/messages/:messageId/pin', (req, reply) => setPinned(req, reply, false));

  // List the channel's pinned messages (newest pin first).
  app.get('/channels/:id/pins', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms || !has(perms.permissions, Permission.VIEW_CHANNEL)) return reply.code(403).send({ error: 'forbidden' });

    const rows = await db
      .select({ m: messages, u: users })
      .from(messages)
      .innerJoin(users, eq(messages.authorId, users.id))
      .where(and(eq(messages.channelId, channelId), isNotNull(messages.pinnedAt)))
      .orderBy(desc(messages.pinnedAt))
      .limit(50);
    const reactions = await reactionsFor(
      rows.map((r) => r.m.id),
      req.user!.sub,
    );
    const replies = await replyPreviewsFor(rows.map((r) => r.m.replyToId));
    return rows.map((r) =>
      serializeMessage({
        ...r.m,
        author: r.u,
        reactions: reactions.get(r.m.id) ?? [],
        replyTo: r.m.replyToId ? (replies.get(r.m.replyToId) ?? null) : null,
      }),
    );
  });

  /**
   * Создать опрос (#17). Это обычное сообщение + строка в `polls`, поэтому опрос живёт в ленте
   * наравне с остальным: удаление сообщения уносит опрос, ответы и закрепление работают как есть.
   */
  app.post('/channels/:id/polls', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        // zod проверяет только ФОРМУ (что это строки и их не миллион). Смысловые правила — длины,
        // пустые и повторяющиеся варианты — считает `checkPollDraft` из shared, тот же самый, что
        // гасит кнопку в форме: иначе форма разрешит отправить, а сервер откажет.
        question: z.string(),
        options: z.array(z.string()).max(100),
        multi: z.boolean().optional().default(false),
        /** true — кто за что проголосовал не покажем никому и никогда. */
        anonymous: z.boolean().optional().default(true),
        /** Часы до закрытия; 0/пусто — бессрочный. */
        hours: z.number().int().min(0).max(POLL_MAX_HOURS).optional().default(0),
      })
      .parse(req.body);

    const draft = checkPollDraft(body.question, body.options);
    if (!draft.ok) return reply.code(400).send({ error: draft.error });
    const { question, options } = draft;

    const wait = await messageSendBlock(req.user!.sub);
    if (wait) return reply.code(429).header('Retry-After', String(wait)).send({ error: retryMessage(wait) });

    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel) return reply.code(404).send({ error: 'not found' });
    if (channel.type !== 'text') return reply.code(400).send({ error: 'not a text channel' });
    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.SEND_MESSAGES)) return reply.code(403).send({ error: 'forbidden' });

    const [author] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
    const [row] = await db
      .insert(messages)
      // Текст пустой: вопрос и варианты живут в опросе. Клиент рисует карточку, а не строку.
      .values({ id: id(), channelId, authorId: author.id, content: '', attachments: [] })
      .returning();

    await db.insert(polls).values({
      messageId: row.id,
      question,
      options: options.map((text, i) => ({ id: String(i + 1), text })),
      multi: body.multi,
      anonymous: body.anonymous,
      closesAt: body.hours > 0 ? new Date(Date.now() + body.hours * 3600_000) : null,
    });

    const fresh = await pollsFor([row.id], author.id);
    const message = serializeMessage({ ...row, author, poll: fresh.get(row.id) ?? null });
    await publishToChannel(channel.serverId, channelId, { t: 'message.create', channelId, serverId: channel.serverId, message });
    return message;
  });

  /**
   * Проголосовать. Голос ОДИН и окончательный — переголосовать нельзя (правило в `checkVote`).
   * Варианты приходят массивом: при множественном выборе человек отмечает всё сразу и жмёт один
   * раз, иначе «нельзя переголосовать» и «выбери несколько» противоречат друг другу.
   */
  app.post('/channels/:id/messages/:messageId/poll/vote', async (req, reply) => {
    const { id: channelId, messageId } = z
      .object({ id: z.string(), messageId: z.string() })
      .parse(req.params);
    const body = z.object({ optionIds: z.array(z.string()).min(1).max(POLL_MAX_OPTIONS) }).parse(req.body);

    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel) return reply.code(404).send({ error: 'not found' });
    const perms = await getChannelPermissions(channelId, req.user!.sub);
    // Голосовать может тот, кто может писать: опрос — участие в разговоре, а не просмотр.
    if (!perms || !has(perms.permissions, Permission.SEND_MESSAGES))
      return reply.code(403).send({ error: 'forbidden' });

    const res = await vote(messageId, req.user!.sub, body.optionIds);
    if (!res.ok) return reply.code(res.code).send({ error: res.error });

    // В канал — только число проголосовавших. Счётчики по вариантам ушли бы тем, кто ещё не
    // голосовал, то есть раскрыли бы ровно то, что мы прячем.
    await publishToChannel(channel.serverId, channelId, {
      t: 'poll.update',
      channelId,
      messageId,
      voters: res.poll.voters,
    });
    // А сами счётчики — адресно тем, кто уже проголосовал: им результаты и так открыты.
    const counts = res.poll.options.map((o) => ({ id: o.id, votes: o.votes }));
    await Promise.all(
      res.voterIds.map((uid) => publishToUser(uid, { t: 'poll.counts', channelId, messageId, options: counts })),
    );
    return res.poll;
  });

  /** Кто за что проголосовал. Только публичный опрос и только после своего голоса. */
  app.get('/channels/:id/messages/:messageId/poll/voters', async (req, reply) => {
    const { id: channelId, messageId } = z
      .object({ id: z.string(), messageId: z.string() })
      .parse(req.params);
    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms || !has(perms.permissions, Permission.VIEW_CHANNEL))
      return reply.code(403).send({ error: 'forbidden' });

    const res = await votersOf(messageId, req.user!.sub);
    if (!res.ok) return reply.code(res.code).send({ error: res.error });

    const ids = [...new Set(res.voters.flatMap((v) => v.userIds))];
    const people = ids.length ? await db.select().from(users).where(inArray(users.id, ids)) : [];
    const byId = new Map(people.map((u) => [u.id, u]));
    return res.voters.map((v) => ({
      optionId: v.optionId,
      users: v.userIds
        .map((id) => byId.get(id))
        .filter((u): u is (typeof people)[number] => !!u)
        .map((u) => serializeUserBrief(u)),
    }));
  });
}
