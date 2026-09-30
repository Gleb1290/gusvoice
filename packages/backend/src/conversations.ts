import { CAP_CONV1 } from '@gusvoice/shared';
import type {
  Attachment,
  ConvGone,
  Message,
  ConvHistoryResponse,
  ConvLeft,
  ConvListResponse,
  ConvMessage,
  ConvSummary,
  ConvSyncResponse,
  MessageReplyPreview,
  ReactionGroup,
} from '@gusvoice/shared';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgTransactionConfig } from 'drizzle-orm/pg-core';
import {
  catchupPlan,
  changeAudience,
  directKey,
  idempotencyDecision,
  journalLockOrder,
  messageView,
  payloadHash,
  previewText,
  type ConvCursor,
  type JournalEntry,
} from './convRules.js';
import { db } from './db/index.js';
import * as schema from './db/schema.js';
import { dmWriteBarrier } from './dmWriteBarrier.js';
import { attachmentLink, purgeDeleted } from './attachments.js';
import { env } from './env.js';
import {
  attachments,
  conversationMembers,
  conversationMessageReactions,
  conversationMessages,
  conversations,
  userBlocks,
  userChanges,
  userSync,
  users,
} from './db/schema.js';
import { serializeMessage } from './serialize.js';
import { uuidv7 } from './util.js';

/**
 * ЛС, этап 1 (#211, `docs/dm/STAGE1.md`) — запись и чтение бесед. Правила (ключи, видимость, аудитория журнала,
 * план догонки) — чистые, в `convRules.ts`; здесь только запросы, замки и рассылка.
 *
 * 🔴 Порядок замков у ВСЕХ писателей один: строка беседы `FOR UPDATE` → строки `user_sync` по возрастанию `user_id`
 * (`journal`) → вставки. Замок `user_sync` держится до фиксации, поэтому `pts` одного человека становятся видны
 * строго по порядку, и снимок читателя видит либо изменение вместе с его `pts`, либо ни то ни другое.
 *
 * 🔴 Чтение (список, история, догонка) — одна транзакция `REPEATABLE READ READ ONLY` (разбор Codex 30.09): иначе ответ
 * мог собрать старую ленту и уже новый `pts`, и клиент навсегда пропустил бы изменение между ними.
 *
 * Этот же слой в шаге 1б понесёт старые ручки `/api/dm*` — поэтому отправка без `client_id` здесь допустима.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = PgDatabase<NodePgQueryResultHKT, typeof schema, any>;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type MsgRow = typeof conversationMessages.$inferSelect;
type UserRow = typeof users.$inferSelect;

const SNAPSHOT: PgTransactionConfig = { isolationLevel: 'repeatable read', accessMode: 'read only' };

/** Число из «сырого» ответа базы (int8 драйвер отдаёт строкой). Вне точных целых JS — ошибка, а не тихое округление. */
function toNum(v: unknown): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`не точное целое из базы: ${String(v)}`);
  return n;
}

function iso(v: unknown): string {
  return (v instanceof Date ? v : new Date(String(v))).toISOString();
}

// ─── Доступ ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Кто сейчас в беседе. `null` — меня в ней нет (или я вышел): для ручек это 404, как у старых ЛС. */
export interface ConvAccess {
  conversationId: string;
  /** Действующие участники, включая меня. */
  memberIds: string[];
  /** Собеседник 1:1 (для групп этапа 3 — `null`). */
  peerId: string | null;
}

export async function loadAccess(conversationId: string, me: string, q: Q = db): Promise<ConvAccess | null> {
  const rows = await q
    .select({ userId: conversationMembers.userId, leftAt: conversationMembers.leftAt })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));
  const active = rows.filter((r) => !r.leftAt).map((r) => r.userId);
  if (!active.includes(me)) return null;
  return { conversationId, memberIds: active, peerId: active.find((id) => id !== me) ?? null };
}

// ─── Замок, ключ, журнал ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Запереть строку беседы и сразу посчитать следующий ключ порядка — часами БАЗЫ, одними на все процессы бэкенда
 * (`convRules.nextSortKey` — то же правило). `null` — беседы нет.
 */
async function lockConversation(tx: Tx, conversationId: string): Promise<{ nextKey: number } | null> {
  const res = await tx.execute(sql`
    SELECT GREATEST((extract(epoch FROM clock_timestamp()) * 1000000)::bigint, last_sort_key + 1) AS k
    FROM conversations WHERE id = ${conversationId} FOR UPDATE`);
  const row = res.rows[0] as { k: unknown } | undefined;
  return row ? { nextKey: toNum(row.k) } : null;
}

/** Записать строки журнала; вернуть новый `pts` каждого затронутого человека. Замки — строго по `journalLockOrder`. */
async function journal(tx: Tx, entries: JournalEntry[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const userId of journalLockOrder(entries)) {
    const mine = entries.filter((e) => e.userId === userId);
    const [row] = await tx
      .insert(userSync)
      .values({ userId, pts: mine.length })
      .onConflictDoUpdate({ target: userSync.userId, set: { pts: sql`${userSync.pts} + ${mine.length}` } })
      .returning({ pts: userSync.pts });
    const last = toNum(row.pts);
    await tx.insert(userChanges).values(
      mine.map((e, i) => ({
        userId,
        pts: last - mine.length + 1 + i,
        conversationId: e.conversationId,
        kind: e.kind,
        messageId: e.messageId,
      })),
    );
    out.set(userId, last);
  }
  return out;
}

function msgEntries(userIds: readonly string[], conversationId: string, messageId: string): JournalEntry[] {
  return userIds.map((userId) => ({ userId, conversationId, kind: 'msg' as const, messageId }));
}

/** Что разослать после фиксации: `conv.change` каждому, у кого вырос `pts`. */
export interface Delivery {
  conversationId: string;
  messageId: string | null;
  pts: Map<string, number>;
}

// ─── Вид глазами человека ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Непрочитанное — то же условие, что `convRules.countsAsUnread`: видимые мне чужие сообщения новее «прочитано до».
 * Менять оба места вместе.
 */
function unreadSql(me: string, readKey: SQL): SQL {
  return sql`(SELECT count(*) FROM conversation_messages x
    WHERE x.conversation_id = c.id AND x.sort_key > ${readKey} AND x.author_id <> ${me}
      AND NOT x.withheld AND x.deleted_at IS NULL AND NOT (${me} = ANY(x.hidden_for)))::int`;
}

/** Сводки бесед глазами `me` (все его беседы или только `ids`). Вышедший — `ConvLeft`. */
async function summariesFor(me: string, ids: readonly string[] | null, q: Q): Promise<(ConvSummary | ConvLeft)[]> {
  if (ids && ids.length === 0) return [];
  const only = ids ? sql`AND c.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})` : sql``;
  const res = await q.execute(sql`
    SELECT c.id, c.kind, c.created_at, m.last_read_key, m.left_at,
      (SELECT p.user_id FROM conversation_members p
        WHERE p.conversation_id = c.id AND p.user_id <> ${me} ORDER BY p.joined_at, p.user_id LIMIT 1) AS peer_id,
      lm.id AS lm_id, lm.author_id AS lm_author, lm.content AS lm_content,
      jsonb_array_length(lm.attachments) AS lm_att, lm.sort_key AS lm_key, lm.created_at AS lm_at,
      ${unreadSql(me, sql`m.last_read_key`)} AS unread
    FROM conversation_members m
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN LATERAL (
      SELECT x.id, x.author_id, x.content, x.attachments, x.sort_key, x.created_at FROM conversation_messages x
      WHERE x.conversation_id = c.id AND x.deleted_at IS NULL AND NOT (${me} = ANY(x.hidden_for))
        AND (NOT x.withheld OR x.author_id = ${me})
      ORDER BY x.sort_key DESC LIMIT 1
    ) lm ON true
    WHERE m.user_id = ${me} ${only}`);
  const rows = res.rows as Record<string, unknown>[];
  const peerIds = [...new Set(rows.map((r) => r.peer_id).filter((x): x is string => typeof x === 'string'))];
  const peers = peerIds.length ? await q.select().from(users).where(inArray(users.id, peerIds)) : [];
  const peerById = new Map(peers.map((u) => [u.id, u]));
  return rows.map((r): ConvSummary | ConvLeft => {
    if (r.left_at) return { id: String(r.id), left: true };
    const peer = typeof r.peer_id === 'string' ? peerById.get(r.peer_id) : undefined;
    const last = r.lm_id
      ? {
          id: String(r.lm_id),
          authorId: String(r.lm_author),
          text: previewText(String(r.lm_content ?? '')),
          attachments: toNum(r.lm_att ?? 0),
          sortKey: toNum(r.lm_key),
          createdAt: iso(r.lm_at),
        }
      : null;
    return {
      id: String(r.id),
      kind: 'direct',
      otherUser: peer
        ? { id: peer.id, username: peer.username, displayName: peer.displayName, avatarUrl: peer.avatarUrl }
        : null,
      createdAt: iso(r.created_at),
      lastMessageAt: last ? last.createdAt : null,
      lastMessage: last,
      unread: toNum(r.unread ?? 0),
      lastReadKey: toNum(r.last_read_key ?? 0),
    };
  });
}

/** Сообщения глазами `viewerId`: полный DTO или `gone`. Цитаты и реакции — тоже его глазами. */
async function messagesForViewer(rows: readonly MsgRow[], viewerId: string, q: Q): Promise<Map<string, ConvMessage | ConvGone>> {
  const out = new Map<string, ConvMessage | ConvGone>();
  if (rows.length === 0) return out;
  const full = rows.filter((m) => messageView(m, viewerId) === 'full');
  for (const m of rows) if (!full.includes(m)) out.set(m.id, { id: m.id, conversationId: m.conversationId, gone: true });
  if (full.length === 0) return out;

  const parentIds = [...new Set(full.map((m) => m.replyToId).filter((x): x is string => !!x))];
  const parents = parentIds.length
    ? await q
        .select({ m: conversationMessages, u: users })
        .from(conversationMessages)
        .innerJoin(users, eq(conversationMessages.authorId, users.id))
        .where(inArray(conversationMessages.id, parentIds))
    : [];
  const replies = new Map<string, MessageReplyPreview>();
  for (const p of parents) {
    // Удалённое у обоих — цитата «сообщение удалено»; спрятанное мной и чужое придержанное — цитаты нет вовсе.
    if (p.m.deletedAt) replies.set(p.m.id, { id: p.m.id, authorName: p.u.displayName, content: '', deleted: true });
    else if (messageView(p.m, viewerId) === 'full')
      replies.set(p.m.id, { id: p.m.id, authorName: p.u.displayName, content: p.m.content });
  }

  const ids = full.map((m) => m.id);
  const reactionRows = await q
    .select()
    .from(conversationMessageReactions)
    .where(inArray(conversationMessageReactions.messageId, ids));
  // Реакции тех, кого смотрящий заблокировал, ему не показываем — как у старых ЛС (#212).
  // 🔴 Через ТОТ ЖЕ `q`, а не `blocks.blockedBy` (нашёл Codex 30.09): при пустом кеше тот идёт в базу через общий
  // пул, пока чтение держит соединение своей транзакцией-снимком. На PGlite (одно соединение) — вечное ожидание, в
  // проде десять одновременных открытий бесед на холодном кеше занимают все 10 соединений пула и ждут друг друга.
  // Кеш модуля здесь не наполняем: набор, прочитанный внутри снимка, мог устареть к моменту записи в кеш.
  const hidden = new Set(
    (await q.select({ id: userBlocks.blockedId }).from(userBlocks).where(eq(userBlocks.blockerId, viewerId))).map((r) => r.id),
  );
  const agg = new Map<string, Map<string, { count: number; me: boolean }>>();
  for (const r of reactionRows) {
    if (hidden.has(r.userId)) continue;
    const byEmoji = agg.get(r.messageId) ?? new Map<string, { count: number; me: boolean }>();
    agg.set(r.messageId, byEmoji);
    const cur = byEmoji.get(r.emoji) ?? { count: 0, me: false };
    cur.count += 1;
    if (r.userId === viewerId) cur.me = true;
    byEmoji.set(r.emoji, cur);
  }

  const authorIds = [...new Set(full.map((m) => m.authorId))];
  const authors = new Map((await q.select().from(users).where(inArray(users.id, authorIds))).map((u) => [u.id, u]));
  // Поколение токенов смотрящего входит в подпись ссылок на его файлы: «выйти на всех устройствах» гасит и их.
  const [viewerRow] = await q.select({ gen: users.tokenGeneration }).from(users).where(eq(users.id, viewerId));
  const viewer = { id: viewerId, tokenGen: viewerRow?.gen ?? 0 };
  for (const m of full) {
    const author = authors.get(m.authorId);
    if (!author) {
      out.set(m.id, { id: m.id, conversationId: m.conversationId, gone: true });
      continue;
    }
    const reactions: ReactionGroup[] = [...(agg.get(m.id) ?? new Map()).entries()].map(([emoji, v]) => ({
      emoji,
      count: v.count,
      me: v.me,
    }));
    out.set(m.id, toConvMessage(m, author, m.replyToId ? (replies.get(m.replyToId) ?? null) : null, reactions, viewer));
  }
  return out;
}

/**
 * Вложения глазами смотрящего: у закрытых (шаг 1в, есть `id`) ссылка собирается ЗДЕСЬ, своя для каждого — в строке
 * сообщения её нет. Старые (публичный бакет, до 1в) несут `url` как есть (Р17).
 */
function viewerAttachments(list: Attachment[], viewer: { id: string; tokenGen: number }): Attachment[] {
  return list.map((a) => (a.id ? { ...a, url: attachmentLink(a.id, viewer.id, viewer.tokenGen) } : a));
}

function toConvMessage(
  m: MsgRow,
  author: UserRow,
  replyTo: MessageReplyPreview | null,
  reactions: ReactionGroup[],
  viewer: { id: string; tokenGen: number },
): ConvMessage {
  return {
    ...serializeMessage({
      id: m.id,
      channelId: m.conversationId,
      content: m.content,
      attachments: viewerAttachments(m.attachments, viewer),
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      replyTo,
      reactions,
      author,
    }),
    conversationId: m.conversationId,
    sortKey: m.sortKey,
    clientId: m.clientId,
  };
}

async function ptsOf(q: Q, me: string): Promise<{ pts: number; minPts: number }> {
  const [row] = await q.select({ pts: userSync.pts, minPts: userSync.minPts }).from(userSync).where(eq(userSync.userId, me));
  return row ? { pts: row.pts, minPts: row.minPts } : { pts: 0, minPts: 0 };
}

// ─── Чтение ────────────────────────────────────────────────────────────────────────────────────────────────────────

function isSummary(x: ConvSummary | ConvLeft): x is ConvSummary {
  return !('left' in x);
}

/** `GET /api/conv` — мои беседы, свежие сверху, и `pts`, согласованный со списком. */
export async function listConversations(me: string): Promise<ConvListResponse> {
  return db.transaction(async (tx) => {
    const { pts } = await ptsOf(tx, me);
    const conversations = (await summariesFor(me, null, tx)).filter(isSummary);
    conversations.sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
    return { pts, conversations };
  }, SNAPSHOT);
}

export interface HistoryQuery {
  before?: ConvCursor;
  /** Старый курсор `?before=<ISO>` (`GET /dm/:id/messages`, шаг 1б): строго раньше этого времени. */
  beforeTime?: Date;
  after?: ConvCursor;
  /** id сообщения, вокруг которого открыть (ответ, уведомление, поиск). */
  around?: string;
  limit: number;
}

/** Видимое мне в беседе — то же условие, что `convRules.messageView === 'full'`. */
function visibleTo(me: string, conversationId: string): SQL {
  return and(
    eq(conversationMessages.conversationId, conversationId),
    isNull(conversationMessages.deletedAt),
    sql`NOT (${me} = ANY(${conversationMessages.hiddenFor}))`,
    or(eq(conversationMessages.withheld, false), eq(conversationMessages.authorId, me)),
  )!;
}

/**
 * `GET /api/conv/:id/messages` — страница истории (старые сверху). `null` — меня в беседе нет; `'no-anchor'` —
 * сообщения для `around` в этой беседе нет.
 */
export async function history(me: string, conversationId: string, qy: HistoryQuery): Promise<ConvHistoryResponse | null | 'no-anchor'> {
  return db.transaction(async (tx) => {
    if (!(await loadAccess(conversationId, me, tx))) return null;
    const { pts } = await ptsOf(tx, me);
    const vis = visibleTo(me, conversationId);
    const key = conversationMessages.sortKey;
    let page: MsgRow[];
    if (qy.around) {
      const [anchor] = await tx
        .select({ sortKey: key })
        .from(conversationMessages)
        .where(and(eq(conversationMessages.id, qy.around), eq(conversationMessages.conversationId, conversationId)));
      if (!anchor) return 'no-anchor';
      const olderN = Math.floor(qy.limit / 2);
      const older = await tx.select().from(conversationMessages).where(and(vis, lt(key, anchor.sortKey))).orderBy(desc(key)).limit(olderN);
      const newer = await tx
        .select()
        .from(conversationMessages)
        .where(and(vis, gte(key, anchor.sortKey)))
        .orderBy(asc(key))
        .limit(qy.limit - older.length);
      page = [...older.reverse(), ...newer];
    } else if (qy.after) {
      page = await tx.select().from(conversationMessages).where(and(vis, gt(key, qy.after.sortKey))).orderBy(asc(key)).limit(qy.limit);
    } else {
      const where = qy.before
        ? and(vis, lt(key, qy.before.sortKey))
        : qy.beforeTime
          ? and(vis, lt(conversationMessages.createdAt, qy.beforeTime))
          : vis;
      page = (await tx.select().from(conversationMessages).where(where).orderBy(desc(key)).limit(qy.limit)).reverse();
    }

    const exists = async (cond: SQL) =>
      (await tx.select({ id: conversationMessages.id }).from(conversationMessages).where(and(vis, cond)).limit(1)).length > 0;
    const first = page[0]?.sortKey;
    const last = page[page.length - 1]?.sortKey;
    const hasMoreBefore =
      first !== undefined ? await exists(lt(key, first)) : qy.after ? await exists(lt(key, qy.after.sortKey + 1)) : false;
    const hasMoreAfter =
      last !== undefined ? await exists(gt(key, last)) : qy.before ? await exists(gt(key, qy.before.sortKey - 1)) : false;

    const views = await messagesForViewer(page, me, tx);
    const messages = page.map((m) => views.get(m.id)).filter((v): v is ConvMessage => !!v && !('gone' in v));
    return { pts, messages, hasMoreBefore, hasMoreAfter };
  }, SNAPSHOT);
}

/** `GET /api/conv/sync?pts=N` — изменения после N (текущее состояние сущностей) или `reset`. */
export async function syncSince(me: string, since: number, limit: number): Promise<ConvSyncResponse> {
  return db.transaction(async (tx) => {
    const state = await ptsOf(tx, me);
    const rows = await tx
      .select()
      .from(userChanges)
      .where(and(eq(userChanges.userId, me), gt(userChanges.pts, since)))
      .orderBy(asc(userChanges.pts))
      .limit(limit + 1);
    const plan = catchupPlan(since, state, rows, limit);
    if (plan.reset) return { reset: true, pts: plan.pts };

    const messageIds = [...new Set(plan.rows.map((r) => r.messageId).filter((x): x is string => !!x))];
    const conversationIds = [...new Set(plan.rows.map((r) => r.conversationId))];
    const msgRows = messageIds.length
      ? await tx.select().from(conversationMessages).where(inArray(conversationMessages.id, messageIds))
      : [];
    const views = await messagesForViewer(msgRows, me, tx);
    return {
      reset: false,
      pts: plan.pts,
      more: plan.more,
      conversations: await summariesFor(me, conversationIds, tx),
      messages: [...views.values()],
    };
  }, SNAPSHOT);
}

/** Одно сообщение глазами человека — ответ отправки и повтора. */
export async function messageFor(messageId: string, viewerId: string): Promise<ConvMessage | ConvGone | null> {
  const rows = await db.select().from(conversationMessages).where(eq(conversationMessages.id, messageId));
  return (await messagesForViewer(rows, viewerId, db)).get(messageId) ?? null;
}

// ─── Запись ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Открыть или создать беседу 1:1. Проверки «можно ли» (общий сервер, федерация, сам с собой) — у вызывающего
 * (`dmRules.openDm`); здесь только «найти по ключу пары» и «создать».
 */
export async function findDirect(one: string, two: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.directKey, directKey(one, two)))
    .limit(1);
  return row ?? null;
}

/** Создать беседу 1:1; `null` — параллельный запрос успел создать её раньше (ключ пары уникален). */
export async function createDirect(me: string, otherId: string): Promise<{ row: { id: string }; delivery: Delivery } | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(conversations)
      .values({ id: uuidv7(), kind: 'direct', directKey: directKey(me, otherId), createdBy: me })
      .onConflictDoNothing({ target: conversations.directKey })
      .returning({ id: conversations.id });
    if (!row) return null;
    await tx.insert(conversationMembers).values([
      { conversationId: row.id, userId: me },
      { conversationId: row.id, userId: otherId },
    ]);
    // Обоим: всё, что есть в списке, должно доходить и догонкой. Прятать ли пустую чужую беседу — дело клиента.
    const pts = await journal(
      tx,
      [me, otherId].map((userId) => ({ userId, conversationId: row.id, kind: 'conv' as const, messageId: null })),
    );
    return { row, delivery: { conversationId: row.id, messageId: null, pts } };
  });
}

/**
 * Ссылка на загруженное вложение при отправке (шаг 1в): id + то, что знает только клиент. Имя, тип и размер берутся из
 * строки `attachments`, а не со слов клиента; размеры картинки — подсказка раскладки (клиент меряет с учётом поворота
 * EXIF, сервер без декодирования так не может); огибающая и длительность — у голосовых, их клиент считает при записи.
 */
export interface AttachmentRef {
  id: string;
  width?: number | null;
  height?: number | null;
  waveform?: number[] | null;
  durationMs?: number | null;
}

type AttachmentRow = typeof attachments.$inferSelect;

/**
 * Вложение в строке сообщения — только из доверенных полей. Настоящая ссылка своя у каждого смотрящего и собирается
 * при чтении (`viewerAttachments`); в строке — ЗАГЛУШКА без смотрящего и подписи (не ключ, отдаёт 404).
 * 🔴 Заглушка нужна для отката (ревью 30.09): бэкенд до 1в отдаёт jsonb как есть, и вложение без `url` роняло бы
 * клиент 0.8.x (`attachmentDownloadUrl` → `a.url.match`) при открытии такой беседы.
 */
function storedAttachment(row: AttachmentRow, ref: AttachmentRef): Attachment {
  const a: Attachment & { id: string } = {
    id: row.id,
    url: `${env.publicApiUrl}/api/att/${row.id}`,
    name: row.name,
    contentType: row.contentType,
    size: row.size,
  };
  if (row.contentType.startsWith('image/')) {
    if (ref.width) a.width = ref.width;
    if (ref.height) a.height = ref.height;
  }
  if (row.contentType.startsWith('audio/')) {
    if (ref.waveform) a.waveform = ref.waveform;
    if (ref.durationMs) a.durationMs = ref.durationMs;
  }
  return a;
}

export interface SendInput {
  /** id отправки от клиента; `null` — старый клиент (шаг 1б), без защиты от повтора. */
  clientId: string | null;
  content: string;
  attachments: AttachmentRef[];
  replyToId: string | null;
  /** Получатель заблокировал автора (`blockRules.dmDeliveryPlan`): сохранить, но не показывать ему. */
  withheld: boolean;
}

export type SendResult =
  | { kind: 'created'; row: MsgRow; delivery: Delivery }
  | { kind: 'replay'; row: MsgRow }
  | { kind: 'conflict' }
  | { kind: 'bad-reply' }
  | { kind: 'bad-attachments' }
  | { kind: 'not-found' };

export async function sendMessage(me: string, access: ConvAccess, input: SendInput): Promise<SendResult> {
  const conversationId = access.conversationId;
  const hash = payloadHash({
    conversationId,
    content: input.content,
    attachmentRefs: input.attachments.map((a) => a.id),
    replyToId: input.replyToId,
  });
  const byClientId = (tx: Tx) =>
    tx
      .select()
      .from(conversationMessages)
      .where(and(eq(conversationMessages.authorId, me), eq(conversationMessages.clientId, input.clientId!)))
      .limit(1);
  const decide = (existing: MsgRow): SendResult =>
    idempotencyDecision(existing.payloadHash, hash) === 'replay' ? { kind: 'replay', row: existing } : { kind: 'conflict' };

  return db.transaction(async (tx): Promise<SendResult> => {
    const lock = await lockConversation(tx, conversationId);
    if (!lock) return { kind: 'not-found' };
    if (input.clientId) {
      const [existing] = await byClientId(tx);
      if (existing) return decide(existing);
    }
    if (input.replyToId) {
      const [parent] = await tx
        .select()
        .from(conversationMessages)
        .where(and(eq(conversationMessages.id, input.replyToId), eq(conversationMessages.conversationId, conversationId)))
        .limit(1);
      if (!parent || messageView(parent, me) !== 'full') return { kind: 'bad-reply' };
    }
    /*
     * 🔴 Вложения — ПОСЛЕ проверки повтора (повтор уже отправленного обязан получить 200, а его вложения уже не pending)
     * и под замком строк (`FOR UPDATE`): иначе две параллельные отправки прикрепили бы один файл к двум сообщениям, и
     * «удалить у обоих» одного стёрло бы файл у второго. Годится только МОЁ, НЕЗАВЕРШЁННОЕ, ЭТОЙ беседы.
     */
    const ids = input.attachments.map((a) => a.id);
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
      const byId = new Map(rows.map((r) => [r.id, r]));
      stored = input.attachments.map((ref) => storedAttachment(byId.get(ref.id)!, ref));
    }
    const [row] = await tx
      .insert(conversationMessages)
      .values({
        id: uuidv7(),
        conversationId,
        authorId: me,
        clientId: input.clientId,
        payloadHash: input.clientId ? hash : null,
        sortKey: lock.nextKey,
        content: input.content,
        attachments: stored,
        replyToId: input.replyToId,
        withheld: input.withheld,
      })
      // Тот же `client_id` параллельно в ДРУГОЙ беседе (в этой нас сериализует замок): ждём чужую фиксацию и отвечаем
      // по её строке — 200 или 409, а не 500 на уникальном ключе.
      .onConflictDoNothing({
        target: [conversationMessages.authorId, conversationMessages.clientId],
        where: sql`client_id IS NOT NULL`,
      })
      .returning();
    if (!row) {
      const [existing] = await byClientId(tx);
      if (!existing) throw new Error('конфликт client_id без строки');
      return decide(existing);
    }
    await dmWriteBarrier.afterSendInsert?.(); // точка для теста гонки с удалением (`dmWriteBarrier.ts`)
    if (ids.length > 0) {
      await tx.update(attachments).set({ state: 'attached', messageId: row.id }).where(inArray(attachments.id, ids));
    }
    await tx
      .update(conversations)
      .set(
        input.withheld
          ? { lastSortKey: lock.nextKey }
          : {
              lastSortKey: lock.nextKey,
              // Придержанное беседу не поднимает: строка общая, и сдвиг выдал бы получателю, что заблокированный пишет.
              lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, ${row.createdAt.toISOString()}::timestamptz)`,
            },
      )
      .where(eq(conversations.id, conversationId));
    const audience = changeAudience({
      action: 'create',
      actorId: me,
      memberIds: access.memberIds,
      withheld: input.withheld,
      blockedActor: new Set(),
    });
    const pts = await journal(tx, msgEntries(audience, conversationId, row.id));
    return { kind: 'created', row, delivery: { conversationId, messageId: row.id, pts } };
  });
}

/** Запереть беседу и взять сообщение этой беседы под замок. */
async function lockMessage(tx: Tx, conversationId: string, messageId: string): Promise<MsgRow | null> {
  if (!(await lockConversation(tx, conversationId))) return null;
  const [m] = await tx
    .select()
    .from(conversationMessages)
    .where(and(eq(conversationMessages.id, messageId), eq(conversationMessages.conversationId, conversationId)))
    .for('update')
    .limit(1);
  return m ?? null;
}

export type EditResult =
  | { kind: 'ok'; row: MsgRow; delivery: Delivery }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'empty' };

export async function editMessage(me: string, access: ConvAccess, messageId: string, content: string): Promise<EditResult> {
  return db.transaction(async (tx): Promise<EditResult> => {
    const m = await lockMessage(tx, access.conversationId, messageId);
    if (!m || m.deletedAt) return { kind: 'not-found' };
    if (m.authorId !== me) return { kind: 'forbidden' };
    // Пустой текст допустим только у сообщения с вложениями — «убрать подпись», как у отправки.
    if (!content && m.attachments.length === 0) return { kind: 'empty' };
    const [row] = await tx
      .update(conversationMessages)
      .set({ content, editedAt: new Date() })
      .where(eq(conversationMessages.id, messageId))
      .returning();
    const audience = changeAudience({ action: 'edit', actorId: me, memberIds: access.memberIds, withheld: m.withheld, blockedActor: new Set() });
    const pts = await journal(tx, msgEntries(audience, access.conversationId, messageId));
    return { kind: 'ok', row, delivery: { conversationId: access.conversationId, messageId, pts } };
  });
}

export type DeleteResult =
  | { kind: 'ok'; delivery: Delivery | null; lastMessageAt: string | null; withheld: boolean }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

/**
 * Удалить: `both` — только своё, надгробие у всех (текст, вложения и реакции стираются, строка остаётся, Р5/Р19);
 * `me` — любое видимое мне, спрятать только у себя (`hidden_for`), собеседник не узнаёт.
 * Повтор уже сделанного удаления — успех без изменений (ответ на первый запрос мог потеряться).
 */
export async function deleteMessage(me: string, access: ConvAccess, messageId: string, scope: 'me' | 'both'): Promise<DeleteResult> {
  let purge: string[] = [];
  const res = await deleteMessageTx(me, access, messageId, scope, (keys) => (purge = keys));
  // Файлы — только ПОСЛЕ фиксации: удали их до неё, и откат транзакции оставил бы сообщение без файла. И в ФОНЕ
  // (ревью 30.09): ждать хранилище значило бы при его зависании не разослать собеседнику само удаление. Сбой —
  // строки остаются `deleted`, их подберёт уборка (`attachments.purgeAttachments`, раз в час).
  if (purge.length > 0) void purgeDeleted(purge).catch(() => {});
  return res;
}

async function deleteMessageTx(
  me: string,
  access: ConvAccess,
  messageId: string,
  scope: 'me' | 'both',
  onPurge: (keys: string[]) => void,
): Promise<DeleteResult> {
  const conversationId = access.conversationId;
  return db.transaction(async (tx): Promise<DeleteResult> => {
    const m = await lockMessage(tx, conversationId, messageId);
    if (!m) return { kind: 'not-found' };
    if (scope === 'me') {
      if (m.hiddenFor.includes(me)) return { kind: 'ok', delivery: null, lastMessageAt: null, withheld: m.withheld };
      if (messageView(m, me) !== 'full') return { kind: 'not-found' };
      await tx
        .update(conversationMessages)
        .set({ hiddenFor: sql`array_append(${conversationMessages.hiddenFor}, ${me})` })
        .where(eq(conversationMessages.id, messageId));
      const pts = await journal(tx, msgEntries([me], conversationId, messageId));
      return { kind: 'ok', delivery: { conversationId, messageId, pts }, lastMessageAt: null, withheld: m.withheld };
    }
    if (m.authorId !== me) return { kind: m.deletedAt || messageView(m, me) !== 'full' ? 'not-found' : 'forbidden' };
    if (m.deletedAt) return { kind: 'ok', delivery: null, lastMessageAt: null, withheld: m.withheld };
    await dmWriteBarrier.afterDeleteLock?.(); // точка для теста гонки с отправкой (`dmWriteBarrier.ts`)
    await tx
      .update(conversationMessages)
      .set({ deletedAt: new Date(), content: '', attachments: [] })
      .where(eq(conversationMessages.id, messageId));
    await tx.delete(conversationMessageReactions).where(eq(conversationMessageReactions.messageId, messageId));
    // Закрытые файлы сообщения — «удалено» в этой же транзакции (выдача сразу 404), сами файлы — после фиксации (Р19).
    const dead = await tx
      .update(attachments)
      .set({ state: 'deleted', deletedAt: new Date() })
      .where(and(eq(attachments.messageId, messageId), eq(attachments.state, 'attached')))
      .returning({ key: attachments.storageKey });
    onPurge(dead.map((d) => d.key));
    // Время беседы — по последнему ОСТАВШЕМУСЯ; придержанное беседу не поднимало и здесь не считается.
    const [conv] = await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`(SELECT max(created_at) FROM conversation_messages
          WHERE conversation_id = ${conversationId} AND NOT withheld AND deleted_at IS NULL)`,
      })
      .where(eq(conversations.id, conversationId))
      .returning({ at: conversations.lastMessageAt });
    const audience = changeAudience({
      action: 'delete-both',
      actorId: me,
      memberIds: access.memberIds,
      withheld: m.withheld,
      blockedActor: new Set(),
    });
    const pts = await journal(tx, msgEntries(audience, conversationId, messageId));
    return {
      kind: 'ok',
      delivery: { conversationId, messageId, pts },
      lastMessageAt: conv?.at ? conv.at.toISOString() : null,
      withheld: m.withheld,
    };
  });
}

export type ReactResult = { kind: 'ok'; changed: boolean; delivery: Delivery | null } | { kind: 'not-found' };

/** Поставить или снять свою реакцию. Повтор (строка уже есть / уже снята) — успех без события и без строки журнала. */
export async function reactMessage(
  me: string,
  access: ConvAccess,
  messageId: string,
  emoji: string,
  op: 'add' | 'remove',
  blockedActor: ReadonlySet<string>,
): Promise<ReactResult> {
  const conversationId = access.conversationId;
  return db.transaction(async (tx): Promise<ReactResult> => {
    const m = await lockMessage(tx, conversationId, messageId);
    if (!m || messageView(m, me) !== 'full') return { kind: 'not-found' };
    const changed =
      op === 'add'
        ? await tx
            .insert(conversationMessageReactions)
            .values({ messageId, userId: me, emoji })
            .onConflictDoNothing()
            .returning({ id: conversationMessageReactions.messageId })
        : await tx
            .delete(conversationMessageReactions)
            .where(
              and(
                eq(conversationMessageReactions.messageId, messageId),
                eq(conversationMessageReactions.userId, me),
                eq(conversationMessageReactions.emoji, emoji),
              ),
            )
            .returning({ id: conversationMessageReactions.messageId });
    if (changed.length === 0) return { kind: 'ok', changed: false, delivery: null };
    const audience = changeAudience({ action: 'react', actorId: me, memberIds: access.memberIds, withheld: m.withheld, blockedActor });
    const pts = await journal(tx, msgEntries(audience, conversationId, messageId));
    return { kind: 'ok', changed: true, delivery: { conversationId, messageId, pts } };
  });
}

export type ReadResult = { kind: 'ok'; lastReadKey: number; delivery: Delivery | null } | { kind: 'bad-key' };

/**
 * «Прочитано до» ключа сообщения этой беседы — только вперёд (`GREATEST`). Ключ чужой беседы или несуществующий —
 * `bad-key`: иначе клиент мог бы «прочитать» будущее одним большим числом.
 */
export async function markRead(me: string, access: ConvAccess, key: number): Promise<ReadResult> {
  const conversationId = access.conversationId;
  return db.transaction(async (tx): Promise<ReadResult> => {
    if (!(await lockConversation(tx, conversationId))) return { kind: 'bad-key' };
    const [msg] = await tx
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.sortKey, key)))
      .limit(1);
    if (!msg) return { kind: 'bad-key' };
    const [before] = await tx
      .select({ key: conversationMembers.lastReadKey })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me)));
    if (!before) return { kind: 'bad-key' };
    if (key <= before.key) return { kind: 'ok', lastReadKey: before.key, delivery: null };
    await tx
      .update(conversationMembers)
      .set({ lastReadKey: sql`GREATEST(${conversationMembers.lastReadKey}, ${key})` })
      .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me)));
    // Себе — остальные мои устройства гасят непрочитанное. Собеседнику (✓✓) — решение Р6, пока нет.
    const pts = await journal(tx, [{ userId: me, conversationId, kind: 'read', messageId: null }]);
    return { kind: 'ok', lastReadKey: key, delivery: { conversationId, messageId: null, pts } };
  });
}

// ─── Для старых ручек `/api/dm*` (шаг 1б) ─────────────────────────────────────────────────────────────────────────

/** Мои беседы (без вышедших) — id, для сводки непрочитанного и старого списка. */
export async function myConversationIds(me: string): Promise<string[]> {
  const rows = await db
    .select({ id: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.userId, me), isNull(conversationMembers.leftAt)));
  return rows.map((r) => r.id);
}

/**
 * Непрочитанное человека по беседам: `id → число` (нули не кладутся). ОДНО правило на все места — `GET /dm`,
 * сводка рейла (`unread.ts`), события удаления — и то же, что `unreadSql`/`convRules.countsAsUnread`.
 */
export async function unreadCounts(me: string, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const res = await db.execute(sql`
    SELECT c.id, ${unreadSql(me, sql`m.last_read_key`)} AS unread
    FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.user_id = ${me} AND c.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  for (const r of res.rows as { id: string; unread: unknown }[]) {
    const n = toNum(r.unread);
    if (n > 0) out.set(r.id, n);
  }
  return out;
}

/** Общие поля бесед: время последнего сообщения, поднявшего беседу, и последний ключ (для «прочитано» без `upTo`). */
export async function conversationRows(ids: readonly string[]): Promise<Map<string, typeof conversations.$inferSelect>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(conversations).where(inArray(conversations.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Ключ и время сообщения этой беседы — для старого `POST /dm/:id/read {upTo}`. */
export async function messageKey(conversationId: string, messageId: string): Promise<{ sortKey: number; createdAt: Date } | null> {
  const [row] = await db
    .select({ sortKey: conversationMessages.sortKey, createdAt: conversationMessages.createdAt })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.id, messageId), eq(conversationMessages.conversationId, conversationId)))
    .limit(1);
  return row ?? null;
}

/** Время сообщения по ключу беседы — `at` старого события `read.dm`. */
export async function messageTimeByKey(conversationId: string, key: number): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: conversationMessages.createdAt })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.sortKey, key)))
    .limit(1);
  return row?.createdAt ?? null;
}

/**
 * Сообщение беседы → DTO старых ручек: без полей бесед, а цитата удалённого у обоих — `null`, как было при удалении
 * строки (`ON DELETE SET NULL`): старый клиент не знает флага `deleted` и показал бы пустую цитату.
 */
export function toLegacyMessage(m: ConvMessage): Message {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { conversationId, sortKey, clientId, ...rest } = m;
  return { ...rest, replyTo: m.replyTo && !m.replyTo.deleted ? m.replyTo : null };
}

/** Сообщение глазами человека в старом DTO; `null` — ему его не видно. */
export async function legacyMessageFor(messageId: string, viewerId: string): Promise<Message | null> {
  const v = await messageFor(messageId, viewerId);
  return v && !('gone' in v) ? toLegacyMessage(v) : null;
}

// ─── Рассылка ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * После фиксации: каждому, у кого вырос `pts`, — `conv.change` с его сводкой беседы и его видом сообщения, только на
 * соединения с `caps: ['conv1']`. Потерянное событие не страшно: журнал и есть очередь, клиент догонит по `pts`.
 */
export async function deliver(d: Delivery | null): Promise<void> {
  if (!d) return;
  // ⚠️ Лениво: `realtime.ts` открывает Redis при ЗАГРУЗКЕ модуля. Статический импорт делал бы этот модуль (а с ним
  // `unread.ts`, `cleanup.ts` и любой тест на PGlite) держателем открытого Redis — так 30.09 висел `accountCleanup.itest`.
  const { publishToUser } = await import('./realtime.js');
  const rows = d.messageId ? await db.select().from(conversationMessages).where(eq(conversationMessages.id, d.messageId)) : [];
  for (const [userId, pts] of d.pts) {
    const [summary] = await summariesFor(userId, [d.conversationId], db);
    const message = d.messageId ? (await messagesForViewer(rows, userId, db)).get(d.messageId) : undefined;
    await publishToUser(
      userId,
      { t: 'conv.change', pts, conversation: summary ?? { id: d.conversationId, left: true }, ...(message ? { message } : {}) },
      { cap: CAP_CONV1 },
    );
  }
}
