import { FED_ERRORS } from '@gusvoice/shared';
import type { ConvGone, ConvMessage } from '@gusvoice/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isSuperAdmin, requireAuth } from '../auth.js';
import { messageSendBlock, pushDebounced, rateHit, retryMessage } from '../authGuard.js';
import { acceptDmUpload, convAttachmentRefsSchema } from './att.js';
import { dmDeliveryPlan } from '../blockRules.js';
import { blockedBy, isBlockedBy } from '../blocks.js';
import {
  createDirect,
  deleteMessage,
  deliver,
  editMessage,
  findDirect,
  history,
  listConversations,
  loadAccess,
  markRead,
  messageFor,
  reactMessage,
  sendMessage,
  syncSince,
} from '../conversations.js';
import { decodeCursor, HISTORY_LIMIT_MAX, isSortKey, SYNC_LIMIT_MAX } from '../convRules.js';
import { db } from '../db/index.js';
import { shareServer } from '../db/peerQueries.js';
import { users } from '../db/schema.js';
import { canWriteDm, DM_NO_SHARED_SERVER_ERROR, DM_PEER_GONE_ERROR, openDm } from '../dmRules.js';
import { contentPreview, sendPushToUsers } from '../push.js';
import { asUserId } from '../superAdminRules.js';

/**
 * ЛС, этап 1 — ручки бесед `/api/conv/*` (#211, `docs/dm/STAGE1.md`, «Новые ручки»). Вся запись и чтение — в
 * `conversations.ts`, правила — в `convRules.ts`; здесь разбор запроса, права, лимиты и коды ответа.
 *
 * С шага 1б живые ЛС лежат в беседах, старые `/api/dm*` (`routes/dm.ts`) — проекция поверх того же слоя, и сервер
 * объявляет `features: ['conv1']` (`instanceFeatures.ts`). В шаге 1а ручки стояли за флагом `CONV_API_ENABLED`: пока
 * таблицы были пустыми, заведённая через них беседа столкнулась бы с переносом по ключу пары.
 */

const convParams = z.object({ id: z.string().min(1).max(64) });
const msgParams = z.object({ id: z.string().min(1).max(64), mid: z.string().min(1).max(64) });

/** Лимиты правок, реакций и «прочитано» — раньше у ЛС их не было вовсе (разбор Codex 28.09). */
const EDIT_MAX = 30;
const REACT_MAX = 40;
const READ_MAX = 60;
const WINDOW_S = 10;

async function limited(reply: FastifyReply, wait: number): Promise<boolean> {
  if (!wait) return false;
  await reply.code(429).header('Retry-After', String(wait)).send({ error: retryMessage(wait) });
  return true;
}

export async function convRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/conv', async (req) => listConversations(req.user!.sub));

  app.get('/conv/sync', async (req) => {
    const q = z
      .object({
        pts: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        limit: z.coerce.number().int().min(1).max(SYNC_LIMIT_MAX).default(200),
      })
      .parse(req.query);
    return syncSince(req.user!.sub, q.pts, q.limit);
  });

  // Открыть или создать беседу 1:1 — те же правила, что у старого `POST /dm` (общий сервер, федерация выключена).
  app.post('/conv/direct', async (req, reply) => {
    const me = req.user!.sub;
    const { userId } = z.object({ userId: z.string().min(1).max(64) }).parse(req.body);
    if (userId === me) return reply.code(400).send({ error: 'cannot DM yourself' });
    const [other] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!other) return reply.code(404).send({ error: 'user not found' });
    const [meRow] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, me)).limit(1);
    // Личка между инстансами — этап 6 (§5.8, `routes/dm.ts` — почему половинчатая хуже никакой).
    if (other.homeInstanceId !== null || meRow?.home) return reply.code(403).send({ error: FED_ERRORS.dmUnavailable });

    let created = null as Awaited<ReturnType<typeof createDirect>>;
    const opened = await openDm<{ id: string }>(
      {
        findExisting: (a, b) => findDirect(a, b),
        shareServer: (one, two) => shareServer(one, two),
        initiatorIsSuperAdmin: () => isSuperAdmin(asUserId(me)),
        create: async () => {
          created = await createDirect(me, userId);
          return created?.row ?? null;
        },
      },
      me,
      userId,
    );
    if (!opened.ok) return reply.code(403).send({ error: DM_NO_SHARED_SERVER_ERROR });
    if (created) void deliver(created.delivery).catch(() => {});
    const list = await listConversations(me);
    const summary = list.conversations.find((c) => c.id === opened.row.id);
    return reply.code(created ? 201 : 200).send(summary ?? { id: opened.row.id });
  });

  app.get('/conv/:id/messages', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const q = z
      .object({
        before: z.string().max(100).optional(),
        after: z.string().max(100).optional(),
        around: z.string().min(1).max(64).optional(),
        limit: z.coerce.number().int().min(1).max(HISTORY_LIMIT_MAX).default(50),
      })
      .parse(req.query);
    if ([q.before, q.after, q.around].filter(Boolean).length > 1)
      return reply.code(400).send({ error: 'only one of before/after/around' });
    const before = q.before ? decodeCursor(q.before) : undefined;
    const after = q.after ? decodeCursor(q.after) : undefined;
    if (before === null || after === null) return reply.code(400).send({ error: 'bad cursor' });
    const page = await history(me, conversationId, { before, after, around: q.around, limit: q.limit });
    if (page === null || page === 'no-anchor') return reply.code(404).send({ error: 'not found' });
    return page;
  });

  // Загрузка вложения в закрытое хранилище (шаг 1в): ответ — `id` для отправки и ссылка для самого загрузившего.
  app.post('/conv/:id/attachments', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    if (!(await loadAccess(conversationId, me))) return reply.code(404).send({ error: 'not found' });
    return acceptDmUpload(req, reply, conversationId, me);
  });

  /**
   * Отправка. `clientId` обязателен: повтор с тем же содержимым → 200 и то же сообщение, с другим → 409
   * `client_id_conflict` (`convRules.idempotencyDecision`). Новое → 201.
   */
  app.post('/conv/:id/messages', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const body = z
      .object({
        clientId: z.string().uuid(),
        content: z.string().max(4000).optional().default(''),
        // Шаг 1в: вложения — id загрузок (`POST /conv/:id/attachments`) + подсказки клиента, не ссылки.
        attachments: convAttachmentRefsSchema,
        replyToId: z.string().min(1).max(64).nullish(),
      })
      .parse(req.body);
    const content = body.content.trim();
    if (!content && body.attachments.length === 0) return reply.code(400).send({ error: 'empty message' });
    if (await limited(reply, await messageSendBlock(me))) return;

    const access = await loadAccess(conversationId, me);
    const [peer] = access?.peerId
      ? await db.select({ deletedAt: users.deletedAt, displayName: users.displayName }).from(users).where(eq(users.id, access.peerId)).limit(1)
      : [];
    const write = canWriteDm({ member: !!access, peerExists: !!peer, peerDeleted: !!peer?.deletedAt });
    if (write === 'not-a-member' || !access) return reply.code(404).send({ error: 'not found' });
    if (write === 'peer-gone') return reply.code(403).send({ error: DM_PEER_GONE_ERROR });

    const plan = dmDeliveryPlan(await isBlockedBy(access.peerId!, me));
    const res = await sendMessage(me, access, {
      clientId: body.clientId,
      content,
      attachments: body.attachments,
      replyToId: body.replyToId ?? null,
      withheld: plan.withheld,
    });
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'bad-reply') return reply.code(400).send({ error: 'invalid reply target' });
    if (res.kind === 'bad-attachments') return reply.code(400).send({ error: 'вложение уже отправлено или не найдено' });
    if (res.kind === 'conflict') return reply.code(409).send({ error: 'client_id_conflict' });
    const view: ConvMessage | ConvGone | null = await messageFor(res.row.id, me);
    if (res.kind === 'replay') return reply.code(200).send(view);

    await deliver(res.delivery);
    if (plan.notifyRecipient) {
      const peerId = access.peerId!;
      const [author] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, me)).limit(1);
      // Тот же пуш, что у старых ЛС: один на получателя от отправителя за окно, заглушка «ЛС этого человека» чтится.
      void (async () => {
        if (await pushDebounced(peerId, me)) return;
        await sendPushToUsers(
          [peerId],
          { type: 'dm', title: author?.displayName ?? '', body: contentPreview(content, body.attachments.length), dmId: conversationId },
          { scope: 'dm_user', targetId: me },
        );
      })().catch(() => {});
    }
    return reply.code(201).send(view);
  });

  app.patch('/conv/:id/messages/:mid', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    const { content: raw } = z.object({ content: z.string().max(4000) }).parse(req.body);
    if (await limited(reply, await rateHit(`conv-edit:${me}`, EDIT_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await editMessage(me, access, mid, raw.trim());
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
    if (res.kind === 'empty') return reply.code(400).send({ error: 'empty message' });
    await deliver(res.delivery);
    return reply.send(await messageFor(mid, me));
  });

  app.delete('/conv/:id/messages/:mid', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    // Новая ручка требует явного выбора: «у меня» и «у обоих» — разные действия, умолчание было бы угадыванием.
    const { for: scope } = z.object({ for: z.enum(['me', 'both']) }).parse(req.query ?? {});
    if (await limited(reply, await rateHit(`conv-edit:${me}`, EDIT_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await deleteMessage(me, access, mid, scope);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
    await deliver(res.delivery);
    return reply.code(204).send();
  });

  app.post('/conv/:id/messages/:mid/reactions', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    const { emoji, op } = z.object({ emoji: z.string().min(1).max(32), op: z.enum(['add', 'remove']) }).parse(req.body);
    if (await limited(reply, await rateHit(`conv-react:${me}`, REACT_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    // Кто из участников заблокировал меня — тем моя реакция не доходит ни событием, ни журналом (`blockRules.reachesPeer`).
    const blockedActor = new Set<string>();
    for (const uid of access.memberIds) if (uid !== me && (await blockedBy(uid)).has(me)) blockedActor.add(uid);
    const res = await reactMessage(me, access, mid, emoji, op, blockedActor);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    await deliver(res.delivery);
    return reply.code(204).send();
  });

  app.post('/conv/:id/read', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const { key } = z.object({ key: z.number() }).parse(req.body);
    if (!isSortKey(key)) return reply.code(400).send({ error: 'bad key' });
    if (await limited(reply, await rateHit(`conv-read:${me}`, READ_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await markRead(me, access, key);
    if (res.kind === 'bad-key') return reply.code(400).send({ error: 'bad key' });
    await deliver(res.delivery);
    return { lastReadKey: res.lastReadKey };
  });
}
