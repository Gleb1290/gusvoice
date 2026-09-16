import {
  checkPollDraft,
  has,
  Permission,
  POLL_MAX_HOURS,
  POLL_MAX_OPTIONS,
  VOICE_MAX_MS,
  WAVEFORM_BUCKETS,
  type Attachment,
  type MessageReplyPreview,
  type MessageSticker,
  type ReactionGroup,
} from '@gusvoice/shared';
import { and, desc, eq, ilike, inArray, isNotNull, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { attachmentUploadBlock, heavyReadBlock, messageSendBlock, pushDebounced, retryMessage } from '../authGuard.js';
import { db } from '../db/index.js';
import { pollsFor, vote, votersOf } from '../polls.js';
import { channelReads, channels, messageReactions, messages, polls, stickerPacks, stickers, users } from '../db/schema.js';
import { getChannelPermissions, getServerChannelPermissions } from '../permissions.js';
import { contentPreview, resolveMentionedMembers, sendPushToUsers } from '../push.js';
import { publishToChannel, publishToUser } from '../realtime.js';
import { serializeMessage } from '../serialize.js';
import { attachmentBlocked, isOwnMediaUrl, putAttachment, storageConfigured } from '../storage.js';
import { id } from '../util.js';

/** Aggregate reactions for a batch of messages into per-message groups, with `me` for the viewer. */
async function reactionsFor(messageIds: string[], viewerId: string): Promise<Map<string, ReactionGroup[]>> {
  const out = new Map<string, ReactionGroup[]>();
  if (messageIds.length === 0) return out;
  const rows = await db.select().from(messageReactions).where(inArray(messageReactions.messageId, messageIds));
  const agg = new Map<string, Map<string, { count: number; me: boolean }>>();
  for (const r of rows) {
    let byEmoji = agg.get(r.messageId);
    if (!byEmoji) {
      byEmoji = new Map();
      agg.set(r.messageId, byEmoji);
    }
    const cur = byEmoji.get(r.emoji) ?? { count: 0, me: false };
    cur.count += 1;
    if (r.userId === viewerId) cur.me = true;
    byEmoji.set(r.emoji, cur);
  }
  for (const [mid, byEmoji] of agg) {
    out.set(
      mid,
      [...byEmoji.entries()].map(([emoji, v]) => ({ emoji, count: v.count, me: v.me })),
    );
  }
  return out;
}

/** Build compact reply previews (author name + content) for a batch of parent message ids. */
async function replyPreviewsFor(replyToIds: (string | null)[]): Promise<Map<string, MessageReplyPreview>> {
  const ids = [...new Set(replyToIds.filter((x): x is string => !!x))];
  const out = new Map<string, MessageReplyPreview>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ m: messages, u: users })
    .from(messages)
    .innerJoin(users, eq(messages.authorId, users.id))
    .where(inArray(messages.id, ids));
  for (const r of rows) out.set(r.m.id, { id: r.m.id, authorName: r.u.displayName, content: r.m.content });
  return out;
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // List recent messages (newest-last). Cursor: ?before=<ISO timestamp>.
  app.get('/channels/:id/messages', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
    const query = z
      .object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(req.query);

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.VIEW_CHANNEL)) return reply.code(403).send({ error: 'forbidden' });

    const where = query.before
      ? and(eq(messages.channelId, channelId), lt(messages.createdAt, new Date(query.before)))
      : eq(messages.channelId, channelId);

    const rows = await db
      .select({ m: messages, u: users })
      .from(messages)
      .innerJoin(users, eq(messages.authorId, users.id))
      .where(where)
      .orderBy(desc(messages.createdAt))
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
    let visible = [...perms.entries()]
      .filter(([, p]) => has(p, Permission.VIEW_CHANNEL) && has(p, Permission.READ_HISTORY))
      .map(([cid]) => cid);
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

  // Advance my read mark for a channel (persisted unread — migration 0018).
  app.post('/channels/:id/read', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    await db
      .insert(channelReads)
      .values({ userId: req.user!.sub, channelId, lastReadAt: new Date() })
      .onConflictDoUpdate({ target: [channelReads.userId, channelReads.channelId], set: { lastReadAt: new Date() } });
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
    const mime = file.mimetype || 'application/octet-stream';
    const name = file.filename || 'file';
    // Reject script-capable web types (P2-1/P3-8) — SVG/HTML could execute if rendered inline.
    if (attachmentBlocked(mime, name)) return reply.code(415).send({ error: 'этот тип файла запрещён (SVG/HTML)' });
    // Upload rate-limit (P2-3): bound MinIO writes (storage-exhaustion). Checked AFTER buffering (so the
    // multipart stream is drained), BEFORE the bucket write.
    const upWait = await attachmentUploadBlock(req.user!.sub);
    if (upWait) return reply.code(429).header('Retry-After', String(upWait)).send({ error: retryMessage(upWait) });
    const url = await putAttachment(id(), buffer, mime, name, Date.now());
    const attachment: Attachment = { url, name, contentType: mime, size: buffer.length };
    return reply.send(attachment);
  });

  // Post a message (text and/or up to 10 attachments).
  app.post('/channels/:id/messages', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        content: z.string().max(4000).optional().default(''),
        attachments: z
          .array(
            z.object({
              url: z.string().url(),
              name: z.string().min(1).max(300),
              contentType: z.string().min(1).max(150),
              size: z.number().int().nonnegative(),
              width: z.number().int().positive().nullish(),
              height: z.number().int().positive().nullish(),
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
    void resolveMentionedMembers(content, channel.serverId, author.id).then(async (ids) => {
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
    const { content } = z.object({ content: z.string().min(1).max(4000) }).parse(req.body);

    const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!msg || msg.channelId !== channelId) return reply.code(404).send({ error: 'not found' });
    if (msg.authorId !== req.user!.sub) return reply.code(403).send({ error: 'forbidden' });

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });

    const [row] = await db
      .update(messages)
      .set({ content: content.trim(), editedAt: new Date() })
      .where(eq(messages.id, messageId))
      .returning();
    const [author] = await db.select().from(users).where(eq(users.id, msg.authorId)).limit(1);
    const replies = await replyPreviewsFor([row.replyToId]);
    const message = serializeMessage({
      ...row,
      author,
      replyTo: row.replyToId ? (replies.get(row.replyToId) ?? null) : null,
    });
    await publishToChannel(perms.serverId, channelId, { t: 'message.update', channelId, message });
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

    if (op === 'add') {
      await db.insert(messageReactions).values({ messageId, userId: req.user!.sub, emoji }).onConflictDoNothing();
    } else {
      await db
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.userId, req.user!.sub),
            eq(messageReactions.emoji, emoji),
          ),
        );
    }
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
        .map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl })),
    }));
  });
}
