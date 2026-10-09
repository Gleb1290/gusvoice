import { FED_ERRORS, VOICE_MAX_MS, WAVEFORM_BUCKETS } from '@gusvoice/shared';
import type { DmChannel, Message } from '@gusvoice/shared';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isSuperAdmin, requireAuth } from '../auth.js';
import { asUserId } from '../superAdminRules.js';
import { canWriteDm, DM_NEW_LIMIT, DM_PEER_GONE_ERROR, dmOpenRefusal, openDm } from '../dmRules.js';
import { messageSendBlock, pushDebounced, rateHit, retryMessage } from '../authGuard.js';
import { dmPolicy } from '../instanceSetup.js';
import { reachableUser } from '../userSearchRules.js';
import { acceptDmUpload, refsFromLegacyUrls } from './att.js';
import { dmDeliveryPlan } from '../blockRules.js';
import { blockedBy, isBlockedBy } from '../blocks.js';
import {
  conversationRows,
  createDirect,
  deleteMessage,
  deliver,
  editMessage,
  findDirect,
  history,
  legacyMessageFor,
  loadAccess,
  markRead,
  messageKey,
  myConversationIds,
  reactMessage,
  revealDirect,
  sendMessage,
  toLegacyMessage,
  unreadCounts,
} from '../conversations.js';
import type { ConvCursor } from '../convRules.js';
import { MESSAGE_TEXT_MAX, TEXT_TOO_LONG } from '../convRules.js';
import { contactNamesFor } from '../contacts.js';
import { pushNameFor } from '../contactRules.js';
import { db } from '../db/index.js';
import { shareServer } from '../db/peerQueries.js';
import { conversationMembers, users } from '../db/schema.js';
import { contentPreview, sendPushToUsers } from '../push.js';
import {
  pickLegacyUser,
  publishLegacyDelete,
  publishLegacyEdit,
  publishLegacyReaction,
  publishLegacyRead,
  publishLegacySend,
} from '../dmLegacyEvents.js';

/**
 * Старые ручки ЛС `/api/dm*` — ПОВЕРХ бесед (ЛС этап 1, шаг 1б, `docs/dm/STAGE1.md`, «Возможности клиента и
 * совместимость»). Адреса, DTO, id и события `dm.*` — прежние: так работают десктопы 0.8.x, которые вшивают фронт и
 * живут у людей неделями. Запись и чтение — `conversations.ts` (те же замки, журнал и правила, что у `/api/conv/*`),
 * `dm_*` после миграции 0079 заморожены и не пишутся.
 *
 * 🔴 Каждое изменение рассылается дважды: `dm.*` — соединениям БЕЗ `caps: ['conv1']` (`dmLegacyEvents.ts`, его же зовут
 * ручки `/api/conv/*`), `conv.change` — соединениям с ней (`deliver`). У одного человека бывают сразу оба клиента, и
 * каждый получает только свою форму.
 *
 * Срок жизни — Р15: два тега после перехода клиента на `/api/conv/*` и ещё ≥ 30 дней без запросов от старых версий.
 */

type UserRow = typeof users.$inferSelect;

const pickUser = (u: UserRow): DmChannel['otherUser'] => pickLegacyUser(u);

/** Собеседники по беседам: `id беседы → строка собеседника`. */
async function peersOf(me: string, ids: readonly string[]): Promise<Map<string, UserRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ conversationId: conversationMembers.conversationId, u: users })
    .from(conversationMembers)
    .innerJoin(users, eq(conversationMembers.userId, users.id))
    .where(and(inArray(conversationMembers.conversationId, [...ids]), ne(conversationMembers.userId, me)));
  return new Map(rows.map((r) => [r.conversationId, r.u]));
}

/** Беседа в старом DTO. `lastMessageAt` — общее время беседы (придержанное его не двигает), как у `dm_channels`. */
async function legacyChannel(me: string, conversationId: string): Promise<DmChannel | null> {
  const [conv, peers] = await Promise.all([conversationRows([conversationId]), peersOf(me, [conversationId])]);
  const row = conv.get(conversationId);
  const peer = peers.get(conversationId);
  if (!row || !peer) return null;
  return {
    id: row.id,
    otherUser: pickUser(peer),
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
  };
}

/** Вложения отправки ЛС — те же границы и у бесед `/api/conv/*` (`routes/conv.ts`). */
export const dmAttachmentSchema = z
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
    const ids = await myConversationIds(me, true);
    if (ids.length === 0) return [];
    const [rows, peers, unreadBy] = await Promise.all([conversationRows(ids), peersOf(me, ids), unreadCounts(me, ids)]);
    const list: DmChannel[] = [];
    for (const cid of ids) {
      const row = rows.get(cid);
      const peer = peers.get(cid);
      if (!row || !peer) continue;
      list.push({
        id: cid,
        otherUser: pickUser(peer),
        createdAt: row.createdAt.toISOString(),
        lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
        unread: unreadBy.get(cid) ?? 0,
      });
    }
    list.sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
    return list;
  });

  /**
   * «Прочитано» старого клиента. `upTo` = id последнего сообщения на экране → «прочитано до» его ключа (28.09, Codex:
   * не «до часов сервера»); без тела — до последнего ключа беседы, как прежнее «сейчас». Только вперёд.
   * Своим старым соединениям — прежнее `read.dm { at }` (время сообщения, до которого прочитано), и только когда
   * отметка СДВИНУЛАСЬ: повтор — без событий, как у `/conv/:id/read` (разбор Codex 01.10; свои устройства уже получили
   * событие при настоящем сдвиге — какой бы ручкой он ни случился). Собеседнику — только `conv.change` из `deliver`
   * (Р6, ✓✓ — `markRead` пишет журнал и ему), `read.dm` — никогда: его 0.8.x принял бы событие за своё «прочитано».
   */
  app.post('/dm/:id/read', async (req, reply) => {
    const me = req.user!.sub;
    const { id: dmId } = z.object({ id: z.string() }).parse(req.params);
    const { upTo } = z.object({ upTo: z.string().min(1).max(64).optional() }).parse(req.body ?? {});
    const access = await loadAccess(dmId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const shown = upTo ? await messageKey(dmId, upTo) : null;
    const key = shown?.sortKey ?? (await conversationRows([dmId])).get(dmId)?.lastSortKey ?? 0;
    let readKey: number | null = null;
    if (key > 0) {
      const res = await markRead(me, access, key);
      if (res.kind === 'ok' && res.delivery) {
        await deliver(res.delivery);
        readKey = res.lastReadKey;
      }
    }
    if (readKey !== null) void publishLegacyRead(me, dmId, readKey).catch(() => {});
    return { ok: true };
  });

  // Open (or create) a conversation with another user.
  app.post('/dm', async (req, reply) => {
    const me = req.user!.sub;
    const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
    if (userId === me) return reply.code(400).send({ error: 'cannot DM yourself' });

    const [other] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!other) return reply.code(404).send({ error: 'user not found' });

    /**
     * Личка между инстансами выключена до #141 (требование 22, §5.8).
     *
     * 🔴 Дело не в лени: беседа у нас живёт ОДНОЙ строкой на нашем инстансе, а переписка людей двух
     * инстансов обязана пережить падение любого из них (§7.2) — это копии у обоих и запись через
     * инстанс собеседника. Половинчатая личка, которая исчезает вместе с хостом, хуже, чем её
     * отсутствие: люди успеют ей поверить.
     */
    const [meRow] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, me)).limit(1);
    if (other.homeInstanceId !== null || meRow?.home) {
      return reply.code(403).send({ error: FED_ERRORS.dmUnavailable });
    }

    // Новая беседа — по политике инстанса (F0 #139: общий сервер; 05.10: `dmPolicy`, предел новых без общего сервера —
    // 429). Правило, порядок шагов и разбор гонки — в `dmRules.ts openDm`; здесь только запросы. Те же правила, что у
    // `POST /conv/direct`: и пустая новая беседа у получателя не видна, и чужую неоткрытую моё «Написать» показывает мне.
    let delivery: Parameters<typeof deliver>[0] = null;
    let createdNew = false as boolean;
    const opened = await openDm<{ id: string }>(
      {
        findExisting: (a, b) => findDirect(a, b),
        shareServer: (one, two) => shareServer(one, two),
        initiatorIsSuperAdmin: () => isSuperAdmin(asUserId(me)),
        create: async () => {
          const created = await createDirect(me, userId);
          delivery = created?.delivery ?? null;
          createdNew = !!created;
          return created?.row ?? null;
        },
        policy: () => dmPolicy(),
        peerReachable: () => reachableUser(other),
        spendNewDm: () => rateHit(`dm-new:${me}`, DM_NEW_LIMIT.max, DM_NEW_LIMIT.windowS),
      },
      me,
      userId,
    );
    if (!opened.ok) {
      const no = dmOpenRefusal(opened);
      if (no.retryAfter) reply.header('Retry-After', String(no.retryAfter));
      return reply.code(no.status).send(no.body);
    }
    const revealed = createdNew ? null : await revealDirect(me, opened.row.id);
    void deliver(delivery).catch(() => {});
    if (revealed) void deliver(revealed).catch(() => {});
    const channel = await legacyChannel(me, opened.row.id);
    if (!channel) return reply.code(404).send({ error: 'not found' });
    return channel;
  });

  // Messages of a conversation (newest-last). Cursor: ?beforeId=<message id> (with ?before=<ISO> as a
  // fallback for old clients and for a cursor message deleted meanwhile).
  app.get('/dm/:id/messages', async (req, reply) => {
    const me = req.user!.sub;
    const { id: dmId } = z.object({ id: z.string() }).parse(req.params);
    const query = z
      .object({
        before: z.string().datetime().optional(),
        beforeId: z.string().min(1).max(64).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    // Курсор — ключ порядка сообщения-курсора (перенос 1б повторяет прежний порядок `(время, id)`); удалённое
    // тем временем — прежний запасной путь по времени.
    const k = query.beforeId ? await messageKey(dmId, query.beforeId) : null;
    const before: ConvCursor | undefined = k ? { sortKey: k.sortKey, id: query.beforeId! } : undefined;
    const beforeTime = !before && query.before ? new Date(query.before) : undefined;
    const page = await history(me, dmId, { before, beforeTime, limit: query.limit });
    if (page === null || page === 'no-anchor') return reply.code(404).send({ error: 'not found' });
    return page.messages.map(toLegacyMessage);
  });

  // Upload one attachment for a conversation; returns its metadata. С шага 1в — в закрытое хранилище, ссылка своя у
  // каждого смотрящего (`routes/att.ts`); 0.8.x получает её в `url` и отправляет обратно как раньше.
  app.post('/dm/:id/attachments', async (req, reply) => {
    const me = req.user!.sub;
    const { id: dmId } = z.object({ id: z.string() }).parse(req.params);
    if (!(await loadAccess(dmId, me))) return reply.code(404).send({ error: 'not found' });
    return acceptDmUpload(req, reply, dmId, me);
  });

  // Send a message (text and/or up to 10 attachments). Старый клиент — без id отправки и без защиты от повтора.
  app.post('/dm/:id/messages', async (req, reply) => {
    const me = req.user!.sub;
    const { id: dmId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        content: z.string().max(MESSAGE_TEXT_MAX, TEXT_TOO_LONG).optional().default(''),
        attachments: dmAttachmentSchema,
        replyToId: z.string().nullish(),
      })
      .parse(req.body);
    const content = body.content.trim();
    if (!content && body.attachments.length === 0) return reply.code(400).send({ error: 'empty message' });

    // Anti-spam (#5, P1-3): cap outbound message rate per user (channels + DMs share one budget).
    const wait = await messageSendBlock(me);
    if (wait) return reply.code(429).header('Retry-After', String(wait)).send({ error: retryMessage(wait) });
    // Вложение — только НАША ссылка на файл, выданная мне при загрузке (#4, P1-2; шаг 1в): публичные адреса бакета и
    // чужие ссылки не принимаются. Моё ли, незавершённое ли, этой ли беседы — решает `sendMessage` под замком.
    const refs = await refsFromLegacyUrls(body.attachments, me);
    if (!refs) return reply.code(400).send({ error: 'вложение должно быть загружено через этот сервер' });

    const access = await loadAccess(dmId, me);
    // Собеседник удалил аккаунт (F0 #139): история остаётся читаемой, но писать больше некому.
    // Само правило (и почему «не участник» — это 404, а не 403) — в `dmRules.ts canWriteDm`.
    const [peer] = access?.peerId ? await db.select().from(users).where(eq(users.id, access.peerId)).limit(1) : [];
    const write = canWriteDm({ member: !!access, peerExists: !!peer, peerDeleted: !!peer?.deletedAt });
    if (write === 'not-a-member' || !access) return reply.code(404).send({ error: 'not found' });
    if (write === 'peer-gone') return reply.code(403).send({ error: DM_PEER_GONE_ERROR });
    const peerId = access.peerId!;

    // Получатель заблокировал автора — «как в Telegram» (#212, `blockRules.dmDeliveryPlan`): сохраняем,
    // автору всё как обычно, получателю — ничего, и беседа у него не поднимается.
    const plan = dmDeliveryPlan(await isBlockedBy(peerId, me));
    const res = await sendMessage(me, access, {
      clientId: null,
      content,
      attachments: refs,
      replyToId: body.replyToId ?? null,
      withheld: plan.withheld,
    });
    if (res.kind === 'bad-reply') return reply.code(400).send({ error: 'invalid reply target' });
    if (res.kind === 'bad-attachments') return reply.code(400).send({ error: 'вложение уже отправлено или не найдено' });
    if (res.kind !== 'created') return reply.code(404).send({ error: 'not found' });

    const mine = await legacyMessageFor(res.row.id, me);
    if (!mine) return reply.code(404).send({ error: 'not found' });
    const [author] = await db.select().from(users).where(eq(users.id, me)).limit(1);
    await publishLegacySend(me, peerId, dmId, res.row, plan.notifyRecipient, mine);
    await deliver(res.delivery);
    if (!plan.notifyRecipient) return reply.code(201).send(mine);
    // Wake the recipient's registered devices (fire-and-forget; never blocks the response).
    // source = this DM author, so a recipient who muted my DMs won't get a phone push.
    void (async () => {
      // Push-bomb debounce (#5, P1-3): one DM-push per recipient per sender per window, so a burst
      // of DMs can't machine-gun the recipient's phone.
      if (await pushDebounced(peerId, me)) return;
      // Подпись автора в контактах получателя (решение владельца 08.10 п.27, `contacts.contactNamesFor`).
      const title = pushNameFor(await contactNamesFor(me, [peerId]), peerId, author.displayName);
      await sendPushToUsers(
        [peerId],
        {
          type: 'dm',
          title,
          body: contentPreview(content, res.row.attachments),
          dmId,
        },
        { scope: 'dm_user', targetId: me },
        { private: true },
      );
    })().catch(() => {});
    return reply.code(201).send(mine);
  });

  // Edit your own message.
  app.patch('/dm/:id/messages/:messageId', async (req, reply) => {
    const me = req.user!.sub;
    const { id: dmId, messageId } = z.object({ id: z.string(), messageId: z.string() }).parse(req.params);
    const { content: raw } = z.object({ content: z.string().max(MESSAGE_TEXT_MAX, TEXT_TOO_LONG) }).parse(req.body);
    const access = await loadAccess(dmId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    // Правка из одних пробелов проходила `.min(1)` ДО обрезки и сохраняла пустую реплику (#212, Codex).
    // Пустой текст допустим только у сообщения с вложениями — это «убрать подпись», как у отправки.
    const res = await editMessage(me, access, messageId, raw.trim());
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
    if (res.kind === 'empty') return reply.code(400).send({ error: 'empty message' });
    const mine = (await legacyMessageFor(messageId, me)) as Message;
    // Правка без изменений (`delivery` пуст) — событий нет: сообщение не менялось.
    if (res.delivery) await publishLegacyEdit(me, access.peerId, dmId, messageId, res.row.withheld, mine);
    await deliver(res.delivery);
    return reply.send(mine);
  });

  /**
   * Удалить сообщение — «как в Telegram» (#212, Р5, решение владельца 28.09):
   * - `?for=both` (по умолчанию — так удаляет старый клиент): только СВОЁ, у обоих (в беседах — надгробие, Р19:
   *   исчезает без следа);
   * - `?for=me`: любое видимое мне сообщение пропадает только у меня, собеседник его по-прежнему видит.
   * Чужое «у обоих» (С1, признак `conv6`) — только новыми ручками `/api/conv/*`, здесь по-прежнему 403: умолчание `both`
   * осталось от клиентов, которые удаляли только своё (`conversations.DeleteOptions`).
   * Событие `dm.delete` несёт новое время беседы (`lastMessageAt`) и новое непрочитанное получателя (`unread`):
   * без первого удалённое последнее сообщение держало беседу наверху списка со своим временем (поймано на S25),
   * без второго непрочитанное удалённое оставляло у собеседника «1» на пустом месте.
   */
  app.delete('/dm/:id/messages/:messageId', async (req, reply) => {
    const me = req.user!.sub;
    const { id: dmId, messageId } = z.object({ id: z.string(), messageId: z.string() }).parse(req.params);
    const { for: scope } = z.object({ for: z.enum(['me', 'both']).default('both') }).parse(req.query ?? {});
    const access = await loadAccess(dmId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await deleteMessage(me, access, messageId, scope);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
    if (!res.delivery) return reply.code(204).send(); // повтор уже сделанного удаления — событий второй раз нет

    // «У меня» — только своим устройствам; «у обоих» уходит у собеседника и при блокировке (`blockRules.reachesPeer`),
    // придержанное он не видел.
    await publishLegacyDelete(me, access.peerId, dmId, messageId, scope, res);
    await deliver(res.delivery);
    return reply.code(204).send();
  });

  // Add or remove the caller's emoji reaction to a DM message (both participants get the delta).
  app.post('/dm/:id/messages/:messageId/reactions', async (req, reply) => {
    const me = req.user!.sub;
    const { id: dmId, messageId } = z.object({ id: z.string(), messageId: z.string() }).parse(req.params);
    const { emoji, op } = z.object({ emoji: z.string().min(1).max(32), op: z.enum(['add', 'remove']) }).parse(req.body);
    const access = await loadAccess(dmId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const blockedActor = new Set<string>();
    for (const uid of access.memberIds) if (uid !== me && (await blockedBy(uid)).has(me)) blockedActor.add(uid);

    /**
     * 🔴 Рассылаем только НАСТОЯЩЕЕ изменение (28.09, #212, найдено Codex и воспроизведено).
     * Повтор запроса (потерянный ответ, двойной клик) вставки не делал — строка уже есть, — но событие
     * уходило, и клиенты без номера события прибавляли реакцию второй раз: в базе одна, на экране две.
     * Двойное снятие так же могло вычесть чужую реакцию. Ответ тот же 204: для отправителя повтор — успех.
     */
    const res = await reactMessage(me, access, messageId, emoji, op, blockedActor);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (!res.changed) return reply.code(204).send();
    // Реакция заблокированного хранится, но собеседник её не видит ни сейчас, ни в истории.
    await publishLegacyReaction(me, access.peerId, dmId, messageId, emoji, op, !!access.peerId && blockedActor.has(access.peerId));
    await deliver(res.delivery);
    return reply.code(204).send();
  });
}
