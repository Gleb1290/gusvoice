import type { Attachment, ConvScheduledResponse } from '@gusvoice/shared';
import { isOnceMedia } from '@gusvoice/shared';
import { and, asc, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { purgeDeleted } from './attachments.js';
import { dmDeliveryPlan, type DmDeliveryPlan } from './blockRules.js';
import {
  deliver,
  journalScheduled,
  loadAccess,
  lockConversation,
  scheduledListOf,
  sendMessage,
  storedAttachment,
  startOnceSweeper,
  type AttachmentRef,
  type ConvAccess,
  type Delivery,
  type ScheduledRow,
  type Tx,
} from './conversations.js';
import { fanOutSend } from './convSendFanout.js';
import { idempotencyDecision, messageView } from './convRules.js';
import { db } from './db/index.js';
import { attachments, conversationMessages, conversationScheduled, userBlocks, users } from './db/schema.js';
import {
  sameTarget,
  SCHED_TICK_BATCH,
  SCHED_TICK_MS,
  schedFailurePlan,
  schedPayloadHash,
  schedSendDecision,
  scheduledLimit,
  scheduledMediaLimit,
  type ScheduledMediaLimit,
  type ScheduleTarget,
} from './scheduleRules.js';
import { uuidv7 } from './util.js';

/**
 * Отложенные сообщения (С4, 05.10, признак `conv9`, как в Telegram): запись и планировщик. Правила — `scheduleRules.ts`
 * (ЧИСТОЕ), чтение, вид и события списка — `conversations.ts` (`scheduledFor`, `journalScheduled`, `Delivery.schedPts`),
 * ручки — `routes/conv.ts`.
 *
 * 🔴 Отправка — обычная (`conversations.sendMessage` в транзакции вызывающего + `convSendFanout.fanOutSend` после
 * фиксации): журнал, `conv.change` обоим (`created`), старые `dm.*`, пуш, «без звука», блокировка — придержано. Сообщение
 * и удаление строки отложенного — ОДНОЙ транзакцией: ни дубля, ни потери.
 *
 * 🔴 Порядок замков (без кругов с писателями бесед и удалением аккаунта):
 * - писатели бесед: беседа → (сообщения, вложения) → `user_sync`;
 * - «Отправить сейчас»: беседа → строка отложенного → её файлы → `user_sync`;
 * - правка и удаление отложенного: строка → её файлы → `user_sync` (беседу не трогают);
 * - создание: замок автора (`pg_advisory_xact_lock`) → незавершённые загрузки (`FOR UPDATE`) → новая строка → `user_sync`;
 * - удаление аккаунта: копии «Переслано от» → строки отложенного → их файлы → … → `user_sync` (`accountRows`);
 * - ТАКТ: строка (`FOR UPDATE SKIP LOCKED`) → беседа тоже `SKIP LOCKED`, БЕЗ ожидания: держа строку, ждать беседу нельзя —
 *   «Отправить сейчас» берёт их в обратном порядке, а удаление аккаунта держит копии и ждёт строку. Беседа занята —
 *   строка отпускается и берётся следующим тактом. Файлы строки — после беседы (`sendMessage`).
 *
 * 🔴 Вложения (06.10, признак `conv10`): загружены заранее обычным путём (`pending`), при создании «паркуются» за строкой
 * (`attachments.state = 'scheduled'`, `scheduled_id`), уходят с ней (`attached`), а при удалении строки, выходе автора,
 * повторе с другим сообщением и удалении аккаунта — `deleted`, файлы стираются после фиксации (`purgeDeleted`). Ссылка
 * `scheduled_id` проверяется при ФИКСАЦИИ (миграция 0087): строку отложенного с непереведёнными файлами удалить нельзя —
 * поэтому каждый путь удаления строки сначала (в той же транзакции) уводит её файлы, а бэкенд до `conv10` такую строку не
 * отправит одним текстом и не удалит.
 */

const mineIn = (conversationId: string, me: string, id: string): SQL =>
  and(eq(conversationScheduled.id, id), eq(conversationScheduled.conversationId, conversationId), eq(conversationScheduled.authorId, me))!;

/** Событие только со списком отложенных автора (`conversations.deliver` шлёт его ему одному). */
function schedOnly(conversationId: string, schedPts: Map<string, number>): Delivery {
  return { conversationId, messageId: null, pts: new Map(), schedPts };
}

/**
 * Файлы отложенного, которое не уйдёт (удалено, автора нет, сообщение с его id отправки уже было): «удалено» в транзакции
 * вызывающего, ссылка на строку снимается (её проверка — при фиксации, миграция 0087). Возвращает ключи файлов — стереть их
 * вызывающий обязан ПОСЛЕ фиксации (`purgeDeleted`): откатись транзакция, файл остался бы нужен. Сбой стирания подберёт
 * часовая уборка (`attachments.purgeAttachments`).
 */
async function dropParked(tx: Tx, scheduledId: string): Promise<string[]> {
  const dead = await tx
    .update(attachments)
    .set({ state: 'deleted', deletedAt: new Date(), scheduledId: null })
    .where(and(eq(attachments.scheduledId, scheduledId), eq(attachments.state, 'scheduled')))
    .returning({ key: attachments.storageKey });
  return dead.map((d) => d.key);
}

/** Стереть файлы после фиксации — в фоне: подвисшее хранилище не держит ответ и такт. */
function purgeLater(keys: readonly string[]): void {
  if (keys.length > 0) void purgeDeleted(keys).catch(() => {});
}

/** Вложение отложенного (вид строки сообщения) → ссылка отправки: id + подсказки клиента. */
function refOf(a: Attachment): AttachmentRef[] {
  if (!a.id) return [];
  return [
    {
      id: a.id,
      width: a.width ?? null,
      height: a.height ?? null,
      waveform: a.waveform ?? null,
      durationMs: a.durationMs ?? null,
      // Подсказки окна отправки файлов (`linkprev1`, `gifs1`, `media2`) лежат в вложении отложенного (`storedAttachment`) —
      // без них при отправке пропадали бы «как файл», GIF и спойлер.
      ...(a.asFile ? { asFile: true } : {}),
      ...(a.gif ? { gif: true } : {}),
      ...(a.spoiler ? { spoiler: true } : {}),
    },
  ];
}

// ─── Ручки автора ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface ScheduleInput {
  clientId: string;
  /** Уже после `trim`; пустой — только с вложениями. */
  content: string;
  /**
   * Вложения (06.10, `conv10`): id МОИХ незавершённых загрузок этой беседы (`POST /conv/:id/attachments`) + подсказки
   * клиента, как у отправки. Нет или пусто — только текст.
   */
  attachments?: readonly AttachmentRef[];
  replyToId: string | null;
  silent: boolean;
  /** «Подпись над медиа» (`media2`): ложится только при подписи и вложении. */
  captionAbove?: boolean;
  target: ScheduleTarget;
}

export type ScheduleResult =
  | { kind: 'created'; list: ConvScheduledResponse; delivery: Delivery }
  | { kind: 'replay'; list: ConvScheduledResponse }
  | { kind: 'conflict' }
  | { kind: 'limit'; scope: 'conversation' | 'user'; max: number }
  | ({ kind: 'media-limit' } & ScheduledMediaLimit)
  | { kind: 'bad-attachments' }
  /** Одноразовое фото/видео (`ttlmedia1`, #226): отложить нельзя. */
  | { kind: 'once-refused' }
  | { kind: 'bad-reply' };

/**
 * Создать отложенное. Повтор того же id отправки: строка есть — по отпечатку создания 200 (`replay`) или 409; строки нет, а
 * сообщение с этим id уже ушло в этой беседе с тем же текстом — тоже 200 (повтор создания не родит второе). Ответ — только
 * на видимое мне сообщение этой беседы (`messageView`), иначе `bad-reply`. Пределы — `scheduleRules.scheduledLimit`.
 * Журнал и событие — только автору (его другие устройства).
 *
 * Вложения (`conv10`) — как у отправки: только МОИ, НЕЗАВЕРШЁННЫЕ, ЭТОЙ беседы, без повторов (иначе `bad-attachments`), под
 * замком строк (`FOR UPDATE`: параллельная отправка или пересылка не возьмёт тот же файл второй раз, вытеснение
 * незавершённых ждёт и после фиксации видит уже не `pending`). Сверх общих пределов — `scheduleRules.scheduledMediaLimit`.
 * Строки файлов становятся `scheduled` и ссылаются на новое отложенное; их вид (доверенные поля + подсказки, по порядку) —
 * в самом отложенном.
 */
export async function createScheduled(me: string, access: ConvAccess, input: ScheduleInput): Promise<ScheduleResult> {
  const conversationId = access.conversationId;
  const refs = input.attachments ?? [];
  const ids = refs.map((a) => a.id);
  const hash = schedPayloadHash({
    conversationId,
    content: input.content,
    replyToId: input.replyToId,
    silent: input.silent,
    target: input.target,
    attachmentIds: ids,
  });
  return db.transaction(async (tx): Promise<ScheduleResult> => {
    // Замок автора: подсчёт предела и вставка неразделимы — два параллельных создания не проскочат предел вдвоём.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`conv-sched:${me}`}))`);
    const [existing] = await tx
      .select({ payloadHash: conversationScheduled.payloadHash })
      .from(conversationScheduled)
      .where(and(eq(conversationScheduled.authorId, me), eq(conversationScheduled.clientId, input.clientId)))
      .limit(1);
    if (existing) {
      return idempotencyDecision(existing.payloadHash, hash) === 'replay'
        ? { kind: 'replay', list: await scheduledListOf(me, conversationId, tx) }
        : { kind: 'conflict' };
    }
    const [sent] = await tx
      .select({ conversationId: conversationMessages.conversationId, content: conversationMessages.content })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.authorId, me), eq(conversationMessages.clientId, input.clientId)))
      .limit(1);
    if (sent) {
      return sent.conversationId === conversationId && sent.content === input.content
        ? { kind: 'replay', list: await scheduledListOf(me, conversationId, tx) }
        : { kind: 'conflict' };
    }
    if (input.replyToId) {
      const [parent] = await tx
        .select()
        .from(conversationMessages)
        .where(and(eq(conversationMessages.id, input.replyToId), eq(conversationMessages.conversationId, conversationId)))
        .limit(1);
      if (!parent || messageView(parent, me) !== 'full') return { kind: 'bad-reply' };
    }
    const [n] = await tx
      .select({
        inConversation: sql<number>`count(*) FILTER (WHERE ${conversationScheduled.conversationId} = ${conversationId})::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(conversationScheduled)
      .where(eq(conversationScheduled.authorId, me));
    const limit = scheduledLimit({ inConversation: Number(n?.inConversation ?? 0), total: Number(n?.total ?? 0) });
    if (limit) return { kind: 'limit', ...limit };
    let stored: Attachment[] = [];
    if (ids.length > 0) {
      if (new Set(ids).size !== ids.length) return { kind: 'bad-attachments' };
      const rows = await tx
        .select()
        .from(attachments)
        .where(
          and(
            inArray(attachments.id, ids),
            eq(attachments.ownerId, me),
            eq(attachments.conversationId, conversationId),
            eq(attachments.state, 'pending'),
          ),
        )
        .for('update');
      if (rows.length !== ids.length) return { kind: 'bad-attachments' };
      const [media] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(conversationScheduled)
        .where(
          and(
            eq(conversationScheduled.authorId, me),
            eq(conversationScheduled.conversationId, conversationId),
            sql`${conversationScheduled.attachments} <> '[]'::jsonb`,
          ),
        );
      const [parked] = await tx
        .select({ bytes: sql<string>`coalesce(sum(${attachments.size}), 0)::text` })
        .from(attachments)
        .where(and(eq(attachments.ownerId, me), eq(attachments.state, 'scheduled')));
      const over = scheduledMediaLimit({
        mediaInConversation: Number(media?.n ?? 0),
        parkedBytes: Number(parked?.bytes ?? 0),
        addBytes: rows.reduce((sum, r) => sum + r.size, 0),
      });
      if (over) return { kind: 'media-limit', ...over };
      const byId = new Map(rows.map((r) => [r.id, r]));
      // Одноразовое фото/видео (`ttlmedia1`, #226) отложить нельзя (tdesktop `lng_ttl_no_schedule`) — отказ, не молча.
      if (refs.some((ref) => ref.once === true && isOnceMedia(storedAttachment(byId.get(ref.id)!, ref)))) return { kind: 'once-refused' };
      // «Один раз» (`voice3`) у отложенного не бывает — пометку снимаем.
      stored = refs.map((ref) => storedAttachment(byId.get(ref.id)!, { ...ref, once: null }));
    }
    const id = uuidv7();
    await tx.insert(conversationScheduled).values({
      id,
      conversationId,
      authorId: me,
      clientId: input.clientId,
      payloadHash: hash,
      content: input.content,
      replyToId: input.replyToId,
      silent: input.silent,
      captionAbove: input.captionAbove === true && input.content !== '' && stored.length > 0,
      sendAt: input.target.sendAt,
      whenOnline: input.target.whenOnline,
      attachments: stored,
    });
    if (ids.length > 0) {
      await tx.update(attachments).set({ state: 'scheduled', scheduledId: id }).where(inArray(attachments.id, ids));
    }
    const schedPts = await journalScheduled(tx, me, conversationId);
    return { kind: 'created', list: await scheduledListOf(me, conversationId, tx), delivery: schedOnly(conversationId, schedPts) };
  });
}

export interface ScheduledPatch {
  /** Новый текст (после `trim`); пустой — только у отложенного с вложениями («убрать подпись»). */
  content?: string;
  /** Новое время или режим — заодно снимает «не отправлено» и счётчик повторов. */
  target?: ScheduleTarget;
}

export type EditScheduledResult =
  | { kind: 'ok'; list: ConvScheduledResponse; delivery: Delivery | null }
  | { kind: 'not-found' }
  | { kind: 'empty' };

/**
 * Правка отложенного: текст и/или время/режим. Ничего не изменилось (тот же текст, то же время, строка не сдавалась) —
 * успех без журнала и событий. Строку держит такт (уходит прямо сейчас) — правка ждёт его и получает `not-found`: «уже
 * отправлено», а не тихая потеря правки. Пустой текст — только у отложенного с вложениями (как правка сообщения), иначе
 * `empty`. Вложения правка не трогает.
 */
export async function editScheduled(me: string, access: ConvAccess, id: string, patch: ScheduledPatch): Promise<EditScheduledResult> {
  const conversationId = access.conversationId;
  return db.transaction(async (tx): Promise<EditScheduledResult> => {
    const [s] = await tx.select().from(conversationScheduled).where(mineIn(conversationId, me, id)).for('update').limit(1);
    if (!s) return { kind: 'not-found' };
    if (patch.content !== undefined && !patch.content && s.attachments.length === 0) return { kind: 'empty' };
    const text = patch.content !== undefined && patch.content !== s.content ? patch.content : undefined;
    const target = patch.target && (!sameTarget(s, patch.target) || s.failedAt !== null || s.attempts > 0) ? patch.target : undefined;
    if (text === undefined && target === undefined) {
      return { kind: 'ok', list: await scheduledListOf(me, conversationId, tx), delivery: null };
    }
    await tx
      .update(conversationScheduled)
      .set({
        ...(text !== undefined ? { content: text, editedAt: sql`now()` } : {}),
        ...(target
          ? {
              sendAt: target.sendAt,
              whenOnline: target.whenOnline,
              attempts: 0,
              nextAttemptAt: null,
              lastError: null,
              failedAt: null,
              failReason: null,
            }
          : {}),
      })
      .where(eq(conversationScheduled.id, s.id));
    const schedPts = await journalScheduled(tx, me, conversationId);
    return { kind: 'ok', list: await scheduledListOf(me, conversationId, tx), delivery: schedOnly(conversationId, schedPts) };
  });
}

export type DeleteScheduledResult = { kind: 'ok'; list: ConvScheduledResponse; delivery: Delivery } | { kind: 'not-found' };

/**
 * Удалить отложенное (нет — уже ушло или удалено: `not-found`). Журнал и событие — автору. Его файлы (`conv10`) — «удалено»
 * той же транзакцией (выдача сразу 404), сами файлы — после фиксации, в фоне.
 */
export async function deleteScheduled(me: string, access: ConvAccess, id: string): Promise<DeleteScheduledResult> {
  const conversationId = access.conversationId;
  const fx: { purge: string[] } = { purge: [] };
  const res = await db.transaction(async (tx): Promise<DeleteScheduledResult> => {
    // Строка — первой (порядок замков: строка → её файлы, как у такта); ссылка файлов на неё проверится при фиксации.
    const gone = await tx.delete(conversationScheduled).where(mineIn(conversationId, me, id)).returning({ id: conversationScheduled.id });
    if (gone.length === 0) return { kind: 'not-found' };
    fx.purge = await dropParked(tx, id);
    const schedPts = await journalScheduled(tx, me, conversationId);
    return { kind: 'ok', list: await scheduledListOf(me, conversationId, tx), delivery: schedOnly(conversationId, schedPts) };
  });
  purgeLater(fx.purge);
  return res;
}

// ─── Отправка строки (такт и «Отправить сейчас») ──────────────────────────────────────────────────────────────────

/**
 * Ушедшее: что разослать после фиксации. `created: false` — сообщение с этим id отправки уже было (только список); `purge` —
 * файлы отложенного, ставшие ненужными (тогда же), стереть после фиксации.
 */
interface SentScheduled {
  s: ScheduledRow;
  access: ConvAccess;
  row: { id: string; createdAt: Date; attachments: readonly unknown[] };
  delivery: Delivery;
  plan: DmDeliveryPlan;
  created: boolean;
  purge: string[];
}

/**
 * Исход строки: `dropped` — удалена без отправки (файлы — в `purge`); `broken` — файлов отложенного нет на месте (так не
 * бывает: ссылку держит база, — но повтор тут не поможет).
 */
type RowOutcome =
  | { kind: 'sent'; sent: SentScheduled }
  | { kind: 'dropped'; purge: string[] }
  | { kind: 'peer-gone' }
  | { kind: 'conflict' }
  | { kind: 'broken' };

/**
 * Отправить строку отложенного обычной отправкой — в транзакции вызывающего, беседа уже заперта им. Права — как у
 * `POST /conv/:id/messages` (`dmRules.canWriteDm` → `scheduleRules.schedSendDecision`): автора нет в беседе или аккаунт
 * удалён — строка удаляется (`dropped`); собеседник удалил аккаунт — `peer-gone` (ничего не меняется, решает вызывающий).
 * Блокировка — `blockRules.dmDeliveryPlan`: придержано, собеседнику ни событий, ни пуша. Цитируемое ко времени отправки
 * исчезло для автора — уходит без ответа. Время сообщения — время этой транзакции (фактической отправки), id отправки — тот,
 * с которым отложенное создавали. Строка удаляется, автору — строка журнала `'sched'` (номер после строк сообщения).
 * Вложения (`conv10`) уходят с сообщением, как у обычной отправки (`sendMessage` с `scheduledId` берёт «припаркованные» за
 * этой строкой); строка удаляется без отправки — её файлы «удалено».
 */
async function sendRowTx(tx: Tx, s: ScheduledRow): Promise<RowOutcome> {
  const access = await loadAccess(s.conversationId, s.authorId, tx);
  const ids = [s.authorId, ...(access?.peerId ? [access.peerId] : [])];
  const people = await tx.select({ id: users.id, deletedAt: users.deletedAt }).from(users).where(inArray(users.id, ids));
  const author = people.find((u) => u.id === s.authorId);
  const peer = access?.peerId ? people.find((u) => u.id === access.peerId) : undefined;
  // Группа (`groups2`, 07.10): собеседника нет — «удалён ли он» и блок не применяются; автор вышел — отложенное пропадает.
  const isGroup = access?.kind === 'group';
  const decision = schedSendDecision({
    authorMember: !!access,
    authorDeleted: !author || !!author.deletedAt,
    peerExists: isGroup || !!access?.saved || !!peer,
    peerDeleted: !isGroup && !!peer?.deletedAt,
  });
  if (decision === 'drop' || !access) {
    await tx.delete(conversationScheduled).where(eq(conversationScheduled.id, s.id));
    return { kind: 'dropped', purge: await dropParked(tx, s.id) };
  }
  if (!isGroup && (decision === 'peer-gone' || (!access.peerId && !access.saved))) return { kind: 'peer-gone' };
  // Читается здесь, в транзакции под замком беседы, а не из кеша `blocks.ts` (он свой у каждого процесса).
  const blocked =
    !isGroup &&
    !access.saved &&
    access.peerId !== null &&
    (
      await tx
        .select({ id: userBlocks.blockerId })
        .from(userBlocks)
        .where(and(eq(userBlocks.blockerId, access.peerId), eq(userBlocks.blockedId, s.authorId)))
        .limit(1)
    ).length > 0;
  const plan = access.saved ? { ...dmDeliveryPlan(false), notifyRecipient: false } : dmDeliveryPlan(blocked);
  let replyToId = s.replyToId;
  if (replyToId) {
    const [parent] = await tx
      .select()
      .from(conversationMessages)
      .where(and(eq(conversationMessages.id, replyToId), eq(conversationMessages.conversationId, s.conversationId)))
      .limit(1);
    if (!parent || messageView(parent, s.authorId) !== 'full') replyToId = null;
  }
  const files = s.attachments.flatMap(refOf);
  const res = await sendMessage(
    s.authorId,
    access,
    {
      clientId: s.clientId,
      content: s.content,
      attachments: files,
      replyToId,
      withheld: plan.withheld,
      silent: s.silent,
      captionAbove: s.captionAbove,
      ...(files.length > 0 ? { scheduledId: s.id } : {}),
    },
    tx,
  );
  if (res.kind === 'conflict') return { kind: 'conflict' };
  if (res.kind === 'bad-attachments') return { kind: 'broken' };
  if (res.kind !== 'created' && res.kind !== 'replay') throw new Error(`отправка отложенного: ${res.kind}`);
  // Повтор: сообщение с этим id отправки уже было (повтор берёт его как есть) — файлы отложенного больше не нужны.
  const purge = res.kind === 'replay' ? await dropParked(tx, s.id) : [];
  await tx.delete(conversationScheduled).where(eq(conversationScheduled.id, s.id));
  const schedPts = await journalScheduled(tx, s.authorId, s.conversationId);
  const delivery: Delivery = res.kind === 'created' ? { ...res.delivery, schedPts } : schedOnly(s.conversationId, schedPts);
  return { kind: 'sent', sent: { s, access, row: res.row, delivery, plan, created: res.kind === 'created', purge } };
}

/** После фиксации: ушедшее — как обычная отправка (`fanOutSend`); бывшее раньше — только список автору. */
async function afterSent(x: SentScheduled): Promise<void> {
  purgeLater(x.purge);
  if (!x.created) return deliver(x.delivery);
  await fanOutSend({
    me: x.s.authorId,
    peerId: x.access.peerId,
    ...(x.access.kind === 'group' ? { groupMemberIds: x.access.memberIds } : {}),
    ...(x.access.saved ? { saved: true } : {}),
    conversationId: x.s.conversationId,
    row: x.row,
    delivery: x.delivery,
    notifyRecipient: x.plan.notifyRecipient,
    content: x.s.content,
    // Вложения строки сообщения, а не число: пуш назовёт их словами («Фото», «Видео», «Файл: имя»), как у отправки.
    attachments: x.row.attachments,
    silent: x.s.silent,
  });
}

export type SendNowResult =
  | { kind: 'sent'; messageId: string; created: boolean; list: ConvScheduledResponse }
  | { kind: 'not-found' }
  | { kind: 'peer-gone' }
  | { kind: 'conflict' }
  | { kind: 'broken' };

/**
 * «Отправить сейчас»: то же, что делает такт, но по просьбе автора и в любом состоянии строки (в том числе «не
 * отправлено» — это и есть ручной повтор). Порядок замков — как у писателей: беседа (с ожиданием), затем строка; такт
 * держит строку и беседу берёт без ожидания — круга нет. Строки нет (ушла тактом, удалена) — `not-found`. События и пуш —
 * после фиксации, до ответа (как у обычной отправки).
 */
export async function sendScheduledNow(me: string, access: ConvAccess, id: string): Promise<SendNowResult> {
  const conversationId = access.conversationId;
  const fx: { sent: SentScheduled | null; purge: string[] } = { sent: null, purge: [] };
  const res = await db.transaction(async (tx): Promise<SendNowResult> => {
    if (!(await lockConversation(tx, conversationId))) return { kind: 'not-found' };
    const [s] = await tx.select().from(conversationScheduled).where(mineIn(conversationId, me, id)).for('update').limit(1);
    if (!s) return { kind: 'not-found' };
    const out = await sendRowTx(tx, s);
    if (out.kind === 'dropped') {
      fx.purge = out.purge;
      return { kind: 'not-found' };
    }
    if (out.kind !== 'sent') return out;
    fx.sent = out.sent;
    return { kind: 'sent', messageId: out.sent.row.id, created: out.sent.created, list: await scheduledListOf(me, conversationId, tx) };
  });
  purgeLater(fx.purge);
  if (fx.sent) await afterSent(fx.sent);
  return res;
}

// ─── Планировщик ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Подменяемое для такта: сценарий на PGlite и тесты гоняют его без таймеров. */
export interface ScheduledTickDeps {
  /** «Сейчас» — для созревания, отсрочек и отметки «не отправлено». По умолчанию часы процесса. */
  now?: () => Date;
  /**
   * В сети ли человек — соединение со шлюзом ЭТОГО процесса, где человек «здесь» (`gateway.isUserDmPresent`: свёрнутое или простаивающее вне голоса — не в сети, D4 08.10, как Telegram). Статус «невидимый» отсекает
   * сам такт (по базе). По умолчанию — никто: без подключённого шлюза «Когда будет в сети» не срабатывает.
   */
  isOnline?: (userId: string) => boolean | Promise<boolean>;
  /** Сколько строк за такт (`SCHED_TICK_BATCH`); остальные — следующим тактом. */
  batch?: number;
}

export interface ScheduledTickReport {
  sent: number;
  /** Помечено «не отправлено»: писать некому, id отправки занят, попытки кончились. */
  failed: number;
  /** Удалено: автора больше нет в беседе (или аккаунта). */
  dropped: number;
  /** Отправка упала — следующая попытка с отсрочкой. */
  retried: number;
  /** Беседу держит писатель — строка ждёт следующего такта. */
  busy: number;
}

type StepResult = 'none' | keyof ScheduledTickReport;

/**
 * Получатели «Когда будет в сети», которые в сети глазами автора: живое соединение (`isOnline`) и статус не «невидимый»
 * (`scheduleRules.peerPresence`) — иначе уход отложенного выдал бы автору, что невидимый на самом деле в сети.
 */
async function onlinePeers(now: Date, isOnline: (userId: string) => boolean | Promise<boolean>): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT DISTINCT p.user_id AS id FROM conversation_scheduled s
    JOIN conversation_members p ON p.conversation_id = s.conversation_id AND p.user_id <> s.author_id AND p.left_at IS NULL
    JOIN users u ON u.id = p.user_id
    WHERE s.when_online AND s.failed_at IS NULL
      AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= ${now.toISOString()}::timestamptz)
      AND u.deleted_at IS NULL AND u.presence_status <> 'invisible'
    LIMIT 5000`);
  const out: string[] = [];
  for (const r of res.rows as { id: unknown }[]) {
    const id = String(r.id);
    if (await isOnline(id)) out.push(id);
  }
  return out;
}

/**
 * «Пора» в SQL — то же условие, что `scheduleRules.isRipe` (менять оба места вместе): не сдавшаяся, отсрочка прошла, и
 * либо время наступило, либо собеседник «Когда будет в сети» в сети (`online`), либо писать некому (живого собеседника в
 * беседе нет — строку надо пометить «не отправлено», а не держать вечно). `skip` — уже разобранные этим тактом.
 */
function ripeWhere(now: Date, online: readonly string[], skip: readonly string[]): SQL {
  const s = conversationScheduled;
  const livePeer = (extra: SQL) => sql`EXISTS (SELECT 1 FROM conversation_members p JOIN users u ON u.id = p.user_id
    WHERE p.conversation_id = ${s.conversationId} AND p.user_id <> ${s.authorId} AND p.left_at IS NULL
      AND u.deleted_at IS NULL ${extra})`;
  const peerOnline =
    online.length > 0 ? livePeer(sql`AND p.user_id IN (${sql.join(online.map((id) => sql`${id}`), sql`, `)})`) : sql`false`;
  return and(
    isNull(s.failedAt),
    or(isNull(s.nextAttemptAt), lte(s.nextAttemptAt, now)),
    or(
      and(isNotNull(s.sendAt), lte(s.sendAt, now)),
      and(eq(s.whenOnline, true), peerOnline),
      and(eq(s.whenOnline, true), sql`NOT ${livePeer(sql``)}`),
    ),
    skip.length > 0 ? notInArray(s.id, [...skip]) : undefined,
  )!;
}

/** Беседу — без ожидания (см. порядок замков в шапке модуля). `false` — её держит писатель. */
async function tryLockConversation(tx: Tx, conversationId: string): Promise<boolean> {
  const res = await tx.execute(sql`SELECT id FROM conversations WHERE id = ${conversationId} FOR UPDATE SKIP LOCKED`);
  return res.rows.length > 0;
}

/** Пометить «не отправлено» и сказать автору (его список изменился). */
async function markFailed(tx: Tx, s: ScheduledRow, reason: 'peer-gone' | 'error', error: string | null, now: Date): Promise<Delivery> {
  await tx
    .update(conversationScheduled)
    .set({ failedAt: now, failReason: reason, nextAttemptAt: null, lastError: error })
    .where(eq(conversationScheduled.id, s.id));
  return schedOnly(s.conversationId, await journalScheduled(tx, s.authorId, s.conversationId));
}

/**
 * Засчитать упавшую попытку (её транзакция откатилась, строка цела): отсрочка по `scheduleRules.schedFailurePlan`, а на
 * последней — «не отправлено» (`error`) и событие автору. `null` — повтор назначен (или строки уже нет).
 */
async function recordAttempt(id: string, now: Date, err: unknown): Promise<Delivery | null> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  return db.transaction(async (tx): Promise<Delivery | null> => {
    const [s] = await tx.select().from(conversationScheduled).where(eq(conversationScheduled.id, id)).for('update').limit(1);
    if (!s || s.failedAt) return null;
    const plan = schedFailurePlan(s.attempts, now);
    if (!plan.giveUp) {
      await tx
        .update(conversationScheduled)
        .set({ attempts: plan.attempts, nextAttemptAt: plan.nextAttemptAt, lastError: message })
        .where(eq(conversationScheduled.id, s.id));
      return null;
    }
    await tx.update(conversationScheduled).set({ attempts: plan.attempts }).where(eq(conversationScheduled.id, s.id));
    return markFailed(tx, s, 'error', message, now);
  });
}

/** Одна строка: своя транзакция; события — после фиксации. */
async function tickStep(now: Date, online: readonly string[], skip: string[]): Promise<StepResult> {
  const fx: { row: ScheduledRow | null; after: (() => Promise<void>) | null } = { row: null, after: null };
  let result: StepResult;
  try {
    result = await db.transaction(async (tx): Promise<StepResult> => {
      const [s] = await tx
        .select()
        .from(conversationScheduled)
        .where(ripeWhere(now, online, skip))
        .orderBy(
          sql`coalesce(${conversationScheduled.sendAt}, ${conversationScheduled.createdAt})`,
          asc(conversationScheduled.createdAt),
          asc(conversationScheduled.id),
        )
        .limit(1)
        .for('update', { skipLocked: true });
      if (!s) return 'none';
      fx.row = s;
      skip.push(s.id); // в этом такте строку больше не берём, что бы с ней ни вышло
      if (!(await tryLockConversation(tx, s.conversationId))) return 'busy';
      const out = await sendRowTx(tx, s);
      if (out.kind === 'dropped') {
        const keys = out.purge;
        fx.after = async () => purgeLater(keys);
        return 'dropped';
      }
      if (out.kind === 'sent') {
        const sent = out.sent;
        fx.after = () => afterSent(sent);
        return 'sent';
      }
      // Писать некому, id отправки занят другим сообщением или файлов нет на месте — повтор не поможет: «не отправлено»,
      // строка (и её файлы) у автора.
      const why = out.kind === 'conflict' ? 'client_id_conflict' : out.kind === 'broken' ? 'attachments_missing' : null;
      const d = await markFailed(tx, s, out.kind === 'peer-gone' ? 'peer-gone' : 'error', why, now);
      fx.after = () => deliver(d);
      return 'failed';
    });
  } catch (e) {
    const s = fx.row;
    if (!s) throw e; // упала сама выборка — такт прекращается, следующий через `SCHED_TICK_MS`
    console.warn(`[sched] отложенное ${s.id} не ушло: ${e instanceof Error ? e.message : String(e)}`);
    const d = await recordAttempt(s.id, now, e);
    if (!d) return 'retried';
    await deliver(d).catch(() => {});
    return 'failed';
  }
  // Сообщение уже в базе: сбой рассылки — не сбой отправки (клиенты догонят по журналу), повтора не будет.
  if (fx.after) {
    await fx.after().catch((e: unknown) => {
      console.warn(`[sched] события отложенного ${fx.row?.id} не разосланы: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
  return result;
}

/**
 * Такт планировщика: созревшие строки по одной, каждая своей транзакцией (`FOR UPDATE SKIP LOCKED` — несколько процессов
 * не возьмут одну строку, а одну строку не отправят дважды), не больше `batch` за такт. «Когда будет в сети» — опросом в
 * этом же такте: задержка после появления собеседника — до одного такта (`SCHED_TICK_MS`, 5 с). При нескольких процессах
 * каждый видит только свои соединения — строку отправит тот, к чьему шлюзу собеседник подключён.
 */
export async function runScheduledTick(deps: ScheduledTickDeps = {}): Promise<ScheduledTickReport> {
  const now = (deps.now ?? (() => new Date()))();
  const report: ScheduledTickReport = { sent: 0, failed: 0, dropped: 0, retried: 0, busy: 0 };
  const online = await onlinePeers(now, deps.isOnline ?? (() => false));
  const skip: string[] = [];
  const max = deps.batch ?? SCHED_TICK_BATCH;
  for (let i = 0; i < max; i++) {
    const step = await tickStep(now, online, skip);
    if (step === 'none') break;
    report[step] += 1;
  }
  return report;
}

/** Запустить такт раз в `SCHED_TICK_MS` (`index.ts`, после `listen`). Новый такт поверх незавершённого не стартует. */
export function startScheduledWorker(deps: ScheduledTickDeps = {}): void {
  // #226: сторож одноразовых фото/видео — свой такт рядом (`conversations.sweepOpenedOnce`): открытое, чьё закрытие не пришло,
  // сгорает по сроку. Здесь, а не в `index.ts`: его перечень крючков и импортов закрыт проверкой.
  startOnceSweeper();
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runScheduledTick(deps)
      .then((r) => {
        if (r.failed > 0 || r.retried > 0) {
          console.warn(`[sched] такт: ушло ${r.sent}, повторов ${r.retried}, «не отправлено» ${r.failed}`);
        }
      })
      .catch((err: unknown) => {
        console.warn(`[sched] такт упал: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        running = false;
      });
  }, SCHED_TICK_MS);
  timer.unref();
}
