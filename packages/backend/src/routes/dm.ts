import { VOICE_MAX_MS, WAVEFORM_BUCKETS } from '@gusvoice/shared';
import type { Attachment, DmChannel, MessageReplyPreview, ReactionGroup } from '@gusvoice/shared';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isSuperAdmin, requireAuth } from '../auth.js';
import { decideDmOpen, DM_NO_SHARED_SERVER_ERROR } from '../dmRules.js';
import { attachmentUploadBlock, messageSendBlock, pushDebounced, retryMessage } from '../authGuard.js';
import { db } from '../db/index.js';
import { dmChannels, dmMessageReactions, dmMessages, dmReads, users } from '../db/schema.js';
import { contentPreview, sendPushToUsers } from '../push.js';
import { publishToUser } from '../realtime.js';
import { serializeMessage } from '../serialize.js';
import { attachmentBlocked, isOwnMediaUrl, putAttachment, storageConfigured } from '../storage.js';
import { id } from '../util.js';

type UserRow = typeof users.$inferSelect;
type DmRow = typeof dmChannels.$inferSelect;
type DmMessageRow = typeof dmMessages.$inferSelect;

function pickUser(u: UserRow): DmChannel['otherUser'] {
  return { id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl };
}

function serializeDmChannel(row: DmRow, other: UserRow): DmChannel {
  return {
    id: row.id,
    otherUser: pickUser(other),
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
  };
}

function serializeDmMessage(
  m: DmMessageRow,
  author: UserRow,
  replyTo?: MessageReplyPreview | null,
  reactions?: ReactionGroup[],
) {
  return serializeMessage({
    id: m.id,
    channelId: m.dmChannelId,
    content: m.content,
    attachments: m.attachments,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    replyTo: replyTo ?? null,
    reactions: reactions ?? [],
    author,
  });
}

/** Aggregate DM reactions for a batch of messages into per-message groups, with `me` for the viewer. */
async function dmReactionsFor(messageIds: string[], viewerId: string): Promise<Map<string, ReactionGroup[]>> {
  const out = new Map<string, ReactionGroup[]>();
  if (messageIds.length === 0) return out;
  const rows = await db.select().from(dmMessageReactions).where(inArray(dmMessageReactions.messageId, messageIds));
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

/** Compact reply previews for a batch of parent DM-message ids. */
async function dmReplyPreviewsFor(ids: (string | null)[]): Promise<Map<string, MessageReplyPreview>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, MessageReplyPreview>();
  if (uniq.length === 0) return out;
  const rows = await db
    .select({ m: dmMessages, u: users })
    .from(dmMessages)
    .innerJoin(users, eq(dmMessages.authorId, users.id))
    .where(inArray(dmMessages.id, uniq));
  for (const r of rows) out.set(r.m.id, { id: r.m.id, authorName: r.u.displayName, content: r.m.content });
  return out;
}

/** Есть ли сервер, где состоят оба. Один запрос по индексу `server_members(user_id)` (миграция 0060). */
async function shareServer(userA: string, userB: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM server_members a
      JOIN server_members b ON b.server_id = a.server_id AND b.user_id = ${userB}
      WHERE a.user_id = ${userA}
      LIMIT 1
  `);
  return res.rows.length > 0;
}

/** Load a DM channel only if `me` is a participant; returns the row and the other user's id. */
async function loadDm(dmId: string, me: string): Promise<{ row: DmRow; otherId: string } | null> {
  const [row] = await db.select().from(dmChannels).where(eq(dmChannels.id, dmId)).limit(1);
  if (!row || (row.userA !== me && row.userB !== me)) return null;
  return { row, otherId: row.userA === me ? row.userB : row.userA };
}

const attachmentSchema = z
  .array(
    z.object({
      url: z.string().url(),
      name: z.string().min(1).max(300),
      contentType: z.string().min(1).max(150),
      size: z.number().int().nonnegative(),
      width: z.number().int().positive().nullish(),
      height: z.number().int().positive().nullish(),
      // Голосовое сообщение (#20) — те же границы, что в канальном роуте: данные чужие.
      waveform: z.array(z.number().int().min(0).max(100)).max(WAVEFORM_BUCKETS).nullish(),
      durationMs: z.number().int().positive().max(VOICE_MAX_MS).nullish(),
    }),
  )
  .max(10)
  .optional()
  .default([]);

export async function dmRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // List my conversations (most-recent first).
  app.get('/dm', async (req) => {
    const me = req.user!.sub;
    const rows = await db
      .select()
      .from(dmChannels)
      .where(or(eq(dmChannels.userA, me), eq(dmChannels.userB, me)));
    if (rows.length === 0) return [];
    const otherIds = rows.map((r) => (r.userA === me ? r.userB : r.userA));
    const otherUsers = await db.select().from(users).where(inArray(users.id, otherIds));
    const byId = new Map(otherUsers.map((u) => [u.id, u]));

    // Persisted unread per conversation (migration 0018): other-user messages newer than my
    // dm_reads mark, 14-day window (same rule as channel reads in buildBootstrap).
    const unreadBy = new Map<string, number>();
    const counts = await db.execute(sql`
      SELECT dm.dm_channel_id AS id, COUNT(*)::int AS unread
      FROM dm_messages dm
      LEFT JOIN dm_reads r ON r.dm_channel_id = dm.dm_channel_id AND r.user_id = ${me}
      WHERE dm.dm_channel_id IN (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)})
        AND dm.author_id <> ${me}
        AND dm.created_at > GREATEST(COALESCE(r.last_read_at, to_timestamp(0)), now() - interval '14 days')
      GROUP BY dm.dm_channel_id
    `);
    for (const row of counts.rows as { id: string; unread: number }[]) unreadBy.set(row.id, row.unread);

    const list = rows
      .map((r) => ({
        ...serializeDmChannel(r, byId.get(r.userA === me ? r.userB : r.userA)!),
        unread: unreadBy.get(r.id) ?? 0,
      }))
      .filter((d) => d.otherUser);
    list.sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
    return list;
  });

  // Advance my read mark for a conversation (persisted unread — migration 0018).
  app.post('/dm/:id/read', async (req, reply) => {
    const me = req.user!.sub;
    const { id: dmId } = z.object({ id: z.string() }).parse(req.params);
    const [row] = await db.select().from(dmChannels).where(eq(dmChannels.id, dmId)).limit(1);
    if (!row || (row.userA !== me && row.userB !== me)) return reply.code(404).send({ error: 'not found' });
    await db
      .insert(dmReads)
      .values({ userId: me, dmChannelId: dmId, lastReadAt: new Date() })
      .onConflictDoUpdate({ target: [dmReads.userId, dmReads.dmChannelId], set: { lastReadAt: new Date() } });
    return { ok: true };
  });

  // Open (or create) a conversation with another user.
  app.post('/dm', async (req, reply) => {
    const me = req.user!.sub;
    const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
    if (userId === me) return reply.code(400).send({ error: 'cannot DM yourself' });

    const [other] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!other) return reply.code(404).send({ error: 'user not found' });

    const [a, b] = me < userId ? [me, userId] : [userId, me];
    let [row] = await db
      .select()
      .from(dmChannels)
      .where(and(eq(dmChannels.userA, a), eq(dmChannels.userB, b)))
      .limit(1);
    // Новая беседа — только при общем сервере (F0, #139). Правило и его граница — в `dmRules.ts`.
    const verdict = decideDmOpen({
      exists: !!row,
      sharedServer: row ? false : await shareServer(me, userId),
      initiatorIsSuperAdmin: isSuperAdmin(me),
    });
    if (verdict === 'no-shared-server') return reply.code(403).send({ error: DM_NO_SHARED_SERVER_ERROR });
    if (!row) {
      [row] = await db.insert(dmChannels).values({ id: id(), userA: a, userB: b }).onConflictDoNothing().returning();
      // Гонка двух одновременных «Написать» у одной пары: вторая вставка ничего не вернула — берём первую.
      if (!row) {
        [row] = await db
          .select()
          .from(dmChannels)
          .where(and(eq(dmChannels.userA, a), eq(dmChannels.userB, b)))
          .limit(1);
      }
    }
    return serializeDmChannel(row, other);
  });

  // Messages of a conversation (newest-last). Cursor: ?before=<ISO timestamp>.
  app.get('/dm/:id/messages', async (req, reply) => {
    const me = req.user!.sub;
    const { id: dmId } = z.object({ id: z.string() }).parse(req.params);
    const query = z
      .object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(req.query);

    const dm = await loadDm(dmId, me);
    if (!dm) return reply.code(404).send({ error: 'not found' });

    const where = query.before
      ? and(eq(dmMessages.dmChannelId, dmId), lt(dmMessages.createdAt, new Date(query.before)))
      : eq(dmMessages.dmChannelId, dmId);

    const rows = await db
      .select({ m: dmMessages, u: users })
      .from(dmMessages)
      .innerJoin(users, eq(dmMessages.authorId, users.id))
      .where(where)
      .orderBy(desc(dmMessages.createdAt))
      .limit(query.limit);

    const list = rows.reverse();
    const replies = await dmReplyPreviewsFor(list.map((r) => r.m.replyToId));
    const reactions = await dmReactionsFor(
      list.map((r) => r.m.id),
      me,
    );
    return list.map((r) =>
      serializeDmMessage(
        r.m,
        r.u,
        r.m.replyToId ? (replies.get(r.m.replyToId) ?? null) : null,
        reactions.get(r.m.id) ?? [],
      ),
    );
  });

  // Upload one attachment for a conversation; returns its metadata.
  app.post('/dm/:id/attachments', async (req, reply) => {
    const me = req.user!.sub;
    const { id: dmId } = z.object({ id: z.string() }).parse(req.params);
    const dm = await loadDm(dmId, me);
    if (!dm) return reply.code(404).send({ error: 'not found' });
    if (!storageConfigured()) return reply.code(503).send({ error: 'attachments storage not configured' });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no file' });
    const buffer = await file.toBuffer();
    const mime = file.mimetype || 'application/octet-stream';
    const name = file.filename || 'file';
    // Reject script-capable web types (P2-1/P3-8) — SVG/HTML could execute if rendered inline.
    if (attachmentBlocked(mime, name)) return reply.code(415).send({ error: 'этот тип файла запрещён (SVG/HTML)' });
    // Upload rate-limit (P2-3): the DM path is weaker (only DM-membership gates it) — bound storage abuse.
    // After buffering (multipart drained), before the bucket write.
    const upWait = await attachmentUploadBlock(me);
    if (upWait) return reply.code(429).header('Retry-After', String(upWait)).send({ error: retryMessage(upWait) });
    const url = await putAttachment(id(), buffer, mime, name, Date.now());
    const attachment: Attachment = { url, name, contentType: mime, size: buffer.length };
    return reply.send(attachment);
  });

  // Send a message (text and/or up to 10 attachments).
  app.post('/dm/:id/messages', async (req, reply) => {
    const me = req.user!.sub;
    const { id: dmId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        content: z.string().max(4000).optional().default(''),
        attachments: attachmentSchema,
        replyToId: z.string().nullish(),
      })
      .parse(req.body);
    const content = body.content.trim();
    if (!content && body.attachments.length === 0) return reply.code(400).send({ error: 'empty message' });

    // Anti-spam (#5, P1-3): cap outbound message rate per user (channels + DMs share one budget).
    const wait = await messageSendBlock(me);
    if (wait) return reply.code(429).header('Retry-After', String(wait)).send({ error: retryMessage(wait) });
    // Attachment URLs must point at OUR bucket (#4, P1-2) — reject a smuggled external URL (tracking pixel).
    if (body.attachments.some((a) => !isOwnMediaUrl(a.url)))
      return reply.code(400).send({ error: 'вложение должно быть загружено через этот сервер' });

    const dm = await loadDm(dmId, me);
    if (!dm) return reply.code(404).send({ error: 'not found' });
    // Собеседник удалил аккаунт (F0 #139): история остаётся читаемой, но писать больше некому.
    const [peer] = await db.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, dm.otherId)).limit(1);
    if (!peer || peer.deletedAt) return reply.code(403).send({ error: 'Собеседник удалил аккаунт' });

    // A reply must point at an existing message in this same conversation.
    let replyToId: string | null = null;
    if (body.replyToId) {
      const [parent] = await db.select().from(dmMessages).where(eq(dmMessages.id, body.replyToId)).limit(1);
      if (!parent || parent.dmChannelId !== dmId) return reply.code(400).send({ error: 'invalid reply target' });
      replyToId = parent.id;
    }

    const [author] = await db.select().from(users).where(eq(users.id, me)).limit(1);
    const [row] = await db
      .insert(dmMessages)
      .values({ id: id(), dmChannelId: dmId, authorId: me, content, attachments: body.attachments, replyToId })
      .returning();
    await db.update(dmChannels).set({ lastMessageAt: row.createdAt }).where(eq(dmChannels.id, dmId));

    const replies = await dmReplyPreviewsFor([replyToId]);
    const message = serializeDmMessage(row, author, replyToId ? (replies.get(replyToId) ?? null) : null);
    // Tell the recipient about the conversation (so it appears / re-sorts in their list),
    // then deliver the message to both participants' own connections.
    const channelForRecipient: DmChannel = {
      id: dmId,
      otherUser: pickUser(author),
      createdAt: dm.row.createdAt.toISOString(),
      lastMessageAt: row.createdAt.toISOString(),
    };
    await publishToUser(dm.otherId, { t: 'dm.channel', channel: channelForRecipient });
    await publishToUser(dm.otherId, { t: 'dm.create', channelId: dmId, message });
    await publishToUser(me, { t: 'dm.create', channelId: dmId, message });
    // Wake the recipient's registered devices (fire-and-forget; never blocks the response).
    // source = this DM author, so a recipient who muted my DMs won't get a phone push.
    void (async () => {
      // Push-bomb debounce (#5, P1-3): one DM-push per recipient per sender per window, so a burst
      // of DMs can't machine-gun the recipient's phone.
      if (await pushDebounced(dm.otherId, me)) return;
      await sendPushToUsers(
        [dm.otherId],
        {
          type: 'dm',
          title: author.displayName,
          body: contentPreview(content, body.attachments.length),
          dmId,
        },
        { scope: 'dm_user', targetId: me },
      );
    })();
    return reply.code(201).send(message);
  });

  // Edit your own message.
  app.patch('/dm/:id/messages/:messageId', async (req, reply) => {
    const me = req.user!.sub;
    const { id: dmId, messageId } = z.object({ id: z.string(), messageId: z.string() }).parse(req.params);
    const { content } = z.object({ content: z.string().min(1).max(4000) }).parse(req.body);

    const dm = await loadDm(dmId, me);
    if (!dm) return reply.code(404).send({ error: 'not found' });
    const [msg] = await db.select().from(dmMessages).where(eq(dmMessages.id, messageId)).limit(1);
    if (!msg || msg.dmChannelId !== dmId) return reply.code(404).send({ error: 'not found' });
    if (msg.authorId !== me) return reply.code(403).send({ error: 'forbidden' });

    const [row] = await db
      .update(dmMessages)
      .set({ content: content.trim(), editedAt: new Date() })
      .where(eq(dmMessages.id, messageId))
      .returning();
    const [author] = await db.select().from(users).where(eq(users.id, me)).limit(1);
    const replies = await dmReplyPreviewsFor([row.replyToId]);
    const reactions = await dmReactionsFor([row.id], me);
    const message = serializeDmMessage(
      row,
      author,
      row.replyToId ? (replies.get(row.replyToId) ?? null) : null,
      reactions.get(row.id) ?? [],
    );
    await publishToUser(dm.otherId, { t: 'dm.update', channelId: dmId, message });
    await publishToUser(me, { t: 'dm.update', channelId: dmId, message });
    return reply.send(message);
  });

  // Delete your own message.
  app.delete('/dm/:id/messages/:messageId', async (req, reply) => {
    const me = req.user!.sub;
    const { id: dmId, messageId } = z.object({ id: z.string(), messageId: z.string() }).parse(req.params);

    const dm = await loadDm(dmId, me);
    if (!dm) return reply.code(404).send({ error: 'not found' });
    const [msg] = await db.select().from(dmMessages).where(eq(dmMessages.id, messageId)).limit(1);
    if (!msg || msg.dmChannelId !== dmId) return reply.code(404).send({ error: 'not found' });
    if (msg.authorId !== me) return reply.code(403).send({ error: 'forbidden' });

    await db.delete(dmMessages).where(eq(dmMessages.id, messageId));
    await publishToUser(dm.otherId, { t: 'dm.delete', channelId: dmId, messageId });
    await publishToUser(me, { t: 'dm.delete', channelId: dmId, messageId });
    return reply.code(204).send();
  });

  // Add or remove the caller's emoji reaction to a DM message (both participants get the delta).
  app.post('/dm/:id/messages/:messageId/reactions', async (req, reply) => {
    const me = req.user!.sub;
    const { id: dmId, messageId } = z.object({ id: z.string(), messageId: z.string() }).parse(req.params);
    const { emoji, op } = z.object({ emoji: z.string().min(1).max(32), op: z.enum(['add', 'remove']) }).parse(req.body);

    const dm = await loadDm(dmId, me);
    if (!dm) return reply.code(404).send({ error: 'not found' });
    const [msg] = await db.select().from(dmMessages).where(eq(dmMessages.id, messageId)).limit(1);
    if (!msg || msg.dmChannelId !== dmId) return reply.code(404).send({ error: 'not found' });

    if (op === 'add') {
      await db.insert(dmMessageReactions).values({ messageId, userId: me, emoji }).onConflictDoNothing();
    } else {
      await db
        .delete(dmMessageReactions)
        .where(
          and(
            eq(dmMessageReactions.messageId, messageId),
            eq(dmMessageReactions.userId, me),
            eq(dmMessageReactions.emoji, emoji),
          ),
        );
    }
    const event = { t: 'dm.reaction' as const, channelId: dmId, messageId, emoji, userId: me, op };
    await publishToUser(dm.otherId, event);
    await publishToUser(me, event);
    return reply.code(204).send();
  });
}
