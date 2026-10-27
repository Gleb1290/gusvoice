import { callServiceMark, CAP_CONV1, DELETED_BOT_NAME, botUnavailableFor, convMediaPreview, convPollDraft, convPollView, geoLiveStart, geoLiveView, geoMedia, parseConvMedia, deliveredLate, FED_CONV_CHANGE, FED_CONV_CHANGE_E2, FED_FEATURES, FEATURE_GROUPS1, pairDirectKey, GROUP_MEMBER_LIMIT, GROUP_MUTE_PREFIX, groupMuteTarget, groupOfMuteTarget, isListenable, isOnceMedia, isOnceSpendable, isVoiceMessage, ONCE_TTL_MAX, onceSpentText, REACTIONS_PER_USER_MAX, ROUND_MAX_MS, customReactionId, isReactionEmoji } from '@gusvoice/shared';
import type {
  ConvServiceMark,
  InlineKeyboard,
  MessageEmbed,
  ConvGroupMember,
  Attachment,
  ConvGone,
  ConvHistoryResponse,
  ConvSearchResponse,
  SharedMediaCounts,
  SharedMediaKind,
  SharedMediaResponse,
  ConvSearchAllResponse,
  ConvFrequentResponse,
  ConvUnreadReactionsResponse,
  ConvLeft,
  ConvListResponse,
  ConvMessage,
  ConvPin,
  ConvPinsOf,
  ConvPinsResponse,
  ConvScheduled,
  ConvScheduledOf,
  ConvScheduledResponse,
  ConvSummary,
  ConvSyncResponse,
  GatewayServerMessage,
  MessageForwardedFrom,
  MessageReplyPreview,
  MessageSticker,
  ConvContactMedia,
  ConvMediaInput,
  ConvMediaMark,
  FedConvMediaWire,
  ReactionGroup,
  ReactionReactor,
} from '@gusvoice/shared';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgTransactionConfig } from 'drizzle-orm/pg-core';
import {
  batchDeleteDecision,
  catchupPlan,
  changeAudience,
  CONV_PIN_LIMIT,
  convListOrder,
  convPinOrderPlan,
  convPinOrderStamps,
  deleteDecision,
  entryPts,
  FORWARD_ATTACHMENTS_MAX,
  FORWARD_BYTES_MAX,
  encodeCursor,
  forwardClientId,
  forwardedFromOf,
  forwardPayloadHash,
  forwardReplayDecision,
  idempotencyDecision,
  isSavedKey,
  journalLockOrder,
  lastAttachmentPreview,
  MESSAGE_BATCH_MAX,
  messageView,
  normalizeDraft,
  othersDeletableForBoth,
  payloadHash,
  peerReadKey,
  pinAudience,
  pinRowAction,
  previewText,
  savedKey,
  stickerAwarePreview,
  stickerOf,
  readAudience,
  replyAttachmentPreview,
  sameDraft,
  unpinTargets,
  type ConvCursor,
  type ConversationKind,
  type JournalEntry,
  type PeerReadState,
  type PinScope,
  resolveReplyQuote,
  replyQuoteSnapshot,
  type ReplyQuoteMark,
  albumItemDecision,
  attachmentsForViewer,
  hiddenAttachmentKey,
} from './convRules.js';
import { db } from './db/index.js';
import * as schema from './db/schema.js';
import { dmWriteBarrier } from './dmWriteBarrier.js';
import type { FedConvChangeInput } from './federation/convChanges.js';
import {
  attachmentLink,
  attachmentStore,
  copyForForward,
  DailyQuotaError,
  discardForwardCopies,
  privateAttachmentsReady,
  purgeDeleted,
} from './attachments.js';
import { env } from './env.js';
import {
  attachments,
  federationLinks,
  conversationMembers,
  conversationMessageReactions,
  conversationVoiceListens,
  convPollVotes,
  conversationMessages,
  conversationPins,
  conversations,
  conversationScheduled,
  serverEmojis,
  userBlocks,
  userChanges,
  userSync,
  users,
} from './db/schema.js';
import { homeInstanceOf, serializeMessage } from './serialize.js';
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
 * Отправка без `client_id` здесь допустима: так пишут свои вызовы сервера (служебные сообщения звонков и закрепа),
 * не ручка клиента.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = PgDatabase<NodePgQueryResultHKT, typeof schema, any>;
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
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

/** Массив jsonb из «сырого» ответа базы: драйвер обычно отдаёт его разобранным, но строку тоже понимаем. Не массив — пусто. */
function jsonList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─── Доступ ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Кто сейчас в беседе. `null` — меня в ней нет (или я вышел): для ручек это 404, как у старых ЛС. */
export interface ConvAccess {
  conversationId: string;
  /** Действующие участники, включая меня. */
  memberIds: string[];
  /** Собеседник 1:1 (у группы — `null`: правила «собеседника» — блок, «прочитано в» — к группе не относятся). */
  peerId: string | null;
  /** Вид беседы (07.10, `groups1`); незнакомый — как группа (права 1:1 он не даёт). */
  kind: ConversationKind;
  /** «Избранное» (08.10, `saved1`): беседа с самим собой — собеседника нет, блока и пуша нет, ✓✓ не бывает. */
  saved: boolean;
}

/**
 * SQL: беседа `c` — «Избранное» (ключ пары «я:я», `convRules.savedKey`): обе половины ключа — один и тот же человек.
 * Ревью 08.10 (`calls3`): раньше здесь был `EXISTS` по `conversation_members` (участник X с ключом «X:X»), и Postgres
 * делал из него хеш-подплан с полным проходом таблицы участников на каждый список. Ключ пары строит только `directKey`
 * из двух id без «:», а беседа «X:X» бывает только «Избранным» X — сравнение половин ключа ей равносильно и без подзапроса.
 */
const SAVED_CONV = sql`(c.direct_key IS NOT NULL AND split_part(c.direct_key, ':', 1) = split_part(c.direct_key, ':', 2))`;

export async function loadAccess(conversationId: string, me: string, q: Q = db): Promise<ConvAccess | null> {
  const rows = await q
    .select({
      userId: conversationMembers.userId,
      leftAt: conversationMembers.leftAt,
      kind: conversations.kind,
      directKey: conversations.directKey,
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(eq(conversationMembers.conversationId, conversationId));
  const active = rows.filter((r) => !r.leftAt).map((r) => r.userId);
  if (!active.includes(me)) return null;
  const kind: ConversationKind = rows[0]?.kind === 'direct' ? 'direct' : 'group';
  const saved = kind === 'direct' && isSavedKey(rows[0]?.directKey, me);
  return { conversationId, memberIds: active, peerId: kind === 'direct' ? (active.find((id) => id !== me) ?? null) : null, kind, saved };
}

// ─── Замок, ключ, журнал ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Запереть строку беседы и сразу посчитать следующий ключ порядка — часами БАЗЫ, одними на все процессы бэкенда
 * (`convRules.nextSortKey` — то же правило). `null` — беседы нет. Вид беседы — под тем же замком (право удалить чужое
 * «у обоих», С1, есть только у 1:1); незнакомый вид считается группой — права он не даёт.
 */
export async function lockConversation(tx: Tx, conversationId: string): Promise<{ nextKey: number; kind: ConversationKind } | null> {
  const res = await tx.execute(sql`
    SELECT GREATEST((extract(epoch FROM clock_timestamp()) * 1000000)::bigint, last_sort_key + 1) AS k, kind
    FROM conversations WHERE id = ${conversationId} FOR UPDATE`);
  const row = res.rows[0] as { k: unknown; kind: unknown } | undefined;
  return row ? { nextKey: toNum(row.k), kind: row.kind === 'direct' ? 'direct' : 'group' } : null;
}

/** Записать строки журнала; вернуть новый `pts` каждого затронутого человека. Замки — строго по `journalLockOrder`. */
export async function journal(tx: Tx, entries: JournalEntry[], opts: { fed?: boolean } = {}): Promise<Map<string, number>> {
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
  // Журнал на связку (Э0 ЛС между инстансами): той же транзакцией; выключено (`FEDERATION_DM_ENABLED`) — ни одного запроса.
  // Э2: `opts.fed = false` — запись приёма копии от соседа (`federation/convAccept.ts`), в журнал на связку не идёт (иначе эхо
  // владельцу). Только сообщения и беседа: реакции, «прочитано до» и закреп «у обоих» пишут свои места явно (`fedRecord`) —
  // у них владелец действующий, а не автор; отбор «только записи наших владельцев» — `recordFedConvChanges`.
  if (fedHooks?.record && opts.fed !== false) {
    await fedHooks.record(
      tx,
      entries.flatMap((e): FedConvChangeInput[] =>
        e.kind === 'msg' && e.messageId
          ? [{ conversationId: e.conversationId, kind: FED_CONV_CHANGE.msg, entityId: e.messageId }]
          : e.kind === 'conv'
            ? [{ conversationId: e.conversationId, kind: e.kind, entityId: null }]
            : [],
      ),
    );
  }
  return out;
}

/** Э2: строка журнала на связку от действия НАШЕГО человека (реакция, «прочитано до», закреп «у обоих») — той же транзакцией. */
async function fedRecord(tx: Tx, items: FedConvChangeInput[]): Promise<void> {
  if (fedHooks?.record) await fedHooks.record(tx, items);
}

/**
 * Э7 часть 1 (#141, §3.6): строка `conv` журнала на связку — состав, название, фото группы (`convGroups.insertService`), той же
 * транзакцией и ДО служебной записи: дом участника сперва заводит группу, потом кладёт в неё запись. Пишет только хост
 * (`federation/convChanges.recordFedConvChanges` отбрасывает `conv` группы чужого дома).
 */
export async function fedRecordGroup(tx: Tx, conversationId: string): Promise<void> {
  await fedRecord(tx, [{ conversationId, kind: FED_CONV_CHANGE.conv, entityId: null }]);
}

/**
 * Э7 часть 3 (#141, §3.6): хост группы со смешанным составом пересылает остальным домам принятое от дома участника —
 * реакции, «прочитано до», закреп «для всех», «прослушано» (`federation/convAccept.ts`). Строка помечена `exceptHome`
 * (дом автора действия): ему своё не возвращается. Отбор адресатов — `federation/convChanges.recordFedConvChanges`.
 */
export async function fedRecordRelay(tx: Tx, items: FedConvChangeInput[]): Promise<void> {
  await fedRecord(tx, items);
}

/**
 * Опрос (`dmpoll1`): голос / отмена голоса НАШЕГО человека — строка `pollvote` журнала на связку той же транзакцией (`convPolls.ts`).
 * Строкой `msg` голос не ходит: сообщение автора не менялось, а копию чужого сосед от нас и не принял бы.
 */
export async function fedRecordPollVote(tx: Tx, conversationId: string, messageId: string): Promise<void> {
  await fedRecord(tx, [{ conversationId, kind: FED_CONV_CHANGE_E2.vote, entityId: messageId }]);
}

export function msgEntries(userIds: readonly string[], conversationId: string, messageId: string): JournalEntry[] {
  return userIds.map((userId) => ({ userId, conversationId, kind: 'msg' as const, messageId }));
}

/** Что разослать после фиксации: `conv.change` каждому, у кого вырос `pts`. */
export interface Delivery {
  conversationId: string;
  messageId: string | null;
  pts: Map<string, number>;
  /** Новое сообщение (а не правка/реакция/удаление) — едет в событие как `created: true` (этап 2). */
  created?: true;
  /**
   * С2 (`conv7`): у этих людей изменился список закреплённого беседы — после события по сообщению (если оно им есть)
   * каждому уходит ещё `conv.change` со сводкой и списком целиком (`pins`) под ЭТИМ номером журнала (строка `'pin'`).
   */
  pinPts?: Map<string, number>;
  /**
   * С4 (`conv9`): у автора изменился список отложенных беседы — после события по сообщению (отложенное ушло) ему уходит
   * `conv.change` со сводкой и списком целиком (`scheduled`) под ЭТИМ номером журнала (строка `'sched'`).
   */
  schedPts?: Map<string, number>;
  /** Правка текста (`editMessage`) — боту уходит `edited_message`, а не молчание (#229). Наружу не едет. */
  edited?: true;
  /** Кто сделал (бот через Bot API) — ему самому событие о своём действии не пишется (#229). Наружу не едет. */
  actor?: string;
  /** Реакция (#231): userId, emoji, add/remove — боту уходит message_reaction. Наружу не едет. */
  reaction?: { userId: string; emoji: string; op: 'add' | 'remove' };
}

/**
 * Строка журнала «мой список отложенных изменился» (С4) — только автору, и событие со списком (`schedPts`). Зовётся в
 * транзакции после всех остальных строк записи: номер автору — следующий за ними, список уходит последним.
 */
export async function journalScheduled(tx: Tx, authorId: string, conversationId: string): Promise<Map<string, number>> {
  return journal(tx, [{ userId: authorId, conversationId, kind: 'sched', messageId: null }]);
}

/** Строки журнала «список закреплённого изменился» (С2) — одна на человека и беседу, без сообщения. */
function pinEntries(userIds: Iterable<string>, conversationId: string): JournalEntry[] {
  return [...new Set(userIds)].map((userId) => ({ userId, conversationId, kind: 'pin' as const, messageId: null }));
}

/**
 * События записанной пачки журнала: по одному на сообщение (`batchDeliveries`) и (С2) номера строк «список закреплённого
 * изменился» — у ПОСЛЕДНЕГО события (`pinPts`), чтобы список ушёл после событий по сообщениям. Сообщений нет — одно
 * событие только со списками.
 */
function withPinDeliveries(
  conversationId: string,
  messageIds: readonly string[],
  entries: readonly JournalEntry[],
  nums: readonly number[],
): Delivery[] {
  const out = batchDeliveries(conversationId, messageIds, entries, nums);
  const pinPts = new Map<string, number>();
  entries.forEach((e, k) => {
    if (e.kind === 'pin') pinPts.set(e.userId, nums[k]);
  });
  if (pinPts.size === 0) return out;
  if (out.length > 0) out[out.length - 1].pinPts = pinPts;
  else out.push({ conversationId, messageId: null, pts: new Map(), pinPts });
  return out;
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

/**
 * Непрочитанные реакции на МОИ сообщения этой беседы (07.10, G24, `reactunread1`; Telegram `HistoryItem::markReactionsRead`,
 * `unreadReactions().count`): число сообщений, у которых есть реакция другого человека, которую я ещё не видел
 * (`seen_at IS NULL`). Заблокированные мной, удалённое и спрятанное мной — мимо. Выражение коррелирует с `c.id`.
 */
/**
 * Упоминает ли сообщение `x` меня (07.10, `groups2`, G24, tdesktop `HistoryItem::mentionsMe`): в тексте «@мой_ник» целым
 * словом, без учёта регистра (то же правило, что подсветка `shared/mentions.ts`). Ник экранируется для регулярки.
 */
function mentionsMeSql(me: string): SQL {
  return sql`x.content ~* ('(^|[^[:alnum:]_])@' || regexp_replace((SELECT u.username FROM users u WHERE u.id = ${me}), '([^[:alnum:]_])', '\', 'g') || '($|[^[:alnum:]_])')`;
}

/**
 * Непрочитанные упоминания меня в ГРУППЕ (07.10, `groups2`, G24): непрочитанные (условие `unreadSql`) сообщения с «@мой_ник».
 * В беседе 1:1 упоминаний нет (у Telegram кнопка «@» — только в группах). Выражение коррелирует с `c.id`.
 */
function unreadMentionsSql(me: string, readKey: SQL): SQL {
  return sql`(SELECT count(*) FROM conversation_messages x
    WHERE x.conversation_id = c.id AND x.sort_key > ${readKey} AND x.author_id <> ${me}
      AND NOT x.withheld AND x.deleted_at IS NULL AND NOT (${me} = ANY(x.hidden_for)) AND ${mentionsMeSql(me)})::int`;
}

function unreadReactionsSql(me: string): SQL {
  return sql`(SELECT count(DISTINCT r.message_id) FROM conversation_message_reactions r
    JOIN conversation_messages x ON x.id = r.message_id
    WHERE r.seen_at IS NULL AND x.conversation_id = c.id AND x.author_id = ${me} AND r.user_id <> ${me}
      AND x.deleted_at IS NULL AND NOT (${me} = ANY(x.hidden_for))
      AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = ${me} AND b.blocked_id = r.user_id))::int`;
}

/**
 * Беседа ещё НЕ показана мне (05.10, признак `users1`, миграция 0086): её открыл другой (`pending` у моей строки
 * участника), и в ней нет ни одного сообщения, дошедшего до меня, — не придержанного от меня (`withheld`, `blockRules.ts`)
 * или моего собственного. Удалённое и скрытое «у меня» считаются: они до меня дошли, и однажды показанная беседа из
 * списка не пропадает. Такой беседы нет в моём списке (`summariesFor`, `myConversationIds`), и событий по ней мне нет
 * (`deliver`): получатель видит переписку только после первого сообщения, а от заблокированного — никогда.
 * `pending` и `cid` — выражения моей строки `conversation_members` (у разных запросов разные псевдонимы).
 */
function hiddenFromMe(me: string, pending: SQL, cid: SQL): SQL {
  return sql`(${pending} AND NOT EXISTS (SELECT 1 FROM conversation_messages y
    WHERE y.conversation_id = ${cid} AND (NOT y.withheld OR y.author_id = ${me})))`;
}

/**
 * Беседу Я убрал из списка («Удалить чат», 07.10, признак `conv12`, миграция 0089): у моей строки участника есть
 * `hidden_key`, и после него до меня не дошло ни одного сообщения (то же «дошло», что у `hiddenFromMe`: не придержанное
 * от меня или моё; удалённое потом тоже считается). Новое сообщение возвращает беседу само, как у Telegram. В отличие от
 * ещё не показанной (`hiddenFromMe`), убранная мной приходит моим устройствам как `ConvLeft` — её строка должна уйти из
 * их списков. `hiddenKey` и `cid` — выражения моей строки `conversation_members`.
 */
function clearedFromMe(me: string, hiddenKey: SQL, cid: SQL): SQL {
  return sql`(${hiddenKey} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversation_messages z
    WHERE z.conversation_id = ${cid} AND z.sort_key > ${hiddenKey} AND (NOT z.withheld OR z.author_id = ${me})))`;
}

/**
 * Бывшую группу (08.10, `groups3`) я убрал «Удалить группу»: как `clearedFromMe`, но в счёт только сообщения до моего
 * выхода — новое в группе, где меня нет, убранную беседу обратно не поднимает.
 */
function formerClearedByMe(me: string, hiddenKey: SQL, leftAt: SQL, cid: SQL): SQL {
  return sql`(${hiddenKey} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversation_messages z
    WHERE z.conversation_id = ${cid} AND z.sort_key > ${hiddenKey} AND z.created_at <= ${leftAt}
      AND (NOT z.withheld OR z.author_id = ${me})))`;
}

/**
 * «Прочитано собеседником» (Р6) по беседам глазами `me`: `id беседы → ключ` по правилу `convRules.peerReadKey`. Беседы
 * без других участников в ответ не попадают (в сводке — `null`).
 * Потолок блокировки (Р12) — первое придержанное МОЁ сообщение с начала блокировки ЭТИМ участником (`user_blocks
 * .created_at`). Условие `b.created_at IS NOT NULL` в подзапросе ссылается только на внешнюю строку — Postgres делает
 * из него разовый фильтр: без блокировки сообщения беседы не перебираются вовсе (проверено `EXPLAIN`).
 * 🔴 Через тот же `q`, что и сводка: внутри чтения-снимка — только его транзакция (см. `messagesForViewer`).
 */
export async function peerReadKeys(me: string, ids: readonly string[], q: Q = db): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (ids.length === 0) return out;
  const res = await q.execute(sql`
    SELECT o.conversation_id AS cid, o.last_read_key AS k, w.k AS cap
    FROM conversation_members o
    LEFT JOIN user_blocks b ON b.blocker_id = o.user_id AND b.blocked_id = ${me}
    LEFT JOIN LATERAL (
      SELECT min(x.sort_key) AS k FROM conversation_messages x
      WHERE b.created_at IS NOT NULL AND x.conversation_id = o.conversation_id AND x.author_id = ${me}
        AND x.withheld AND x.created_at >= b.created_at
    ) w ON true
    WHERE o.conversation_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND o.user_id <> ${me}`);
  const byConv = new Map<string, PeerReadState[]>();
  for (const r of res.rows as { cid: unknown; k: unknown; cap: unknown }[]) {
    const cid = String(r.cid);
    const list = byConv.get(cid) ?? [];
    list.push({ lastReadKey: toNum(r.k ?? 0), firstWithheldKey: r.cap === null || r.cap === undefined ? null : toNum(r.cap) });
    byConv.set(cid, list);
  }
  for (const [cid, others] of byConv) out.set(cid, peerReadKey(others));
  return out;
}

/** Запись о звонке последнего сообщения 1:1 → поле `call` сводки (10.10, B3); не звонок / незнакомое — пусто. */
function lastCallOf(service: unknown): { call?: NonNullable<ConvSummary['lastMessage']>['call'] } {
  const mark = callServiceMark({ service });
  return mark ? { call: { reason: mark.reason, duration: mark.duration, ...(mark.video ? { video: true as const } : {}) } } : {};
}

/**
 * Текст превью с учётом вида сообщения (G69, `geocontact1`): у геопозиции и контакта — подпись «Геопозиция» / «Контакт: Имя»
 * вместо запасной фразы с координатами и ссылкой (строка списка, закреп, цитата). Остальное — как было.
 */
function mediaAwareText(content: string, media: unknown): string {
  const mark = media ? parseConvMedia(media) : null;
  return mark ? convMediaPreview(mark) : content;
}

/** Первое вложение последнего сообщения строки списка, когда вид превью — фото (07.10, G34); иначе `null`. */
function lastPhoto(r: Record<string, unknown>): { id?: unknown; url?: unknown; spoiler?: unknown; fedState?: unknown } | null {
  if (!r.lm_id || stickerOf(r.lm_sticker)) return null;
  const list = jsonList(r.lm_atts);
  if (lastAttachmentPreview(list)?.attachmentKind !== 'photo') return null;
  const first = list[0];
  // Одноразовое фото (#226) — без миниатюры: файл не раздаётся получателю до открытия, и кадр в списке раскрыл бы его.
  if (first && typeof first === 'object' && (first as { once?: unknown }).once === true) return null;
  return first && typeof first === 'object' ? (first as { id?: unknown; url?: unknown; spoiler?: unknown; fedState?: unknown }) : null;
}

/**
 * Мини-превью строки списка (07.10, G34; Telegram Android `DialogCell.thumbImage`): ссылка СМОТРЯЩЕГО на первое фото
 * (`attachmentLink`, как у закрепа `pinsFor`), у старого публичного вложения (до шага 1в) — `url` как есть (Р17).
 */
function lastThumb(r: Record<string, unknown>, me: string, gen: number): { thumb?: string; thumbSpoiler?: true } {
  const first = lastPhoto(r);
  // ЛС между инстансами (исправления ревью 12.10, п. 11): копия файла ещё едет с инстанса автора (`fedState`) — ссылка
  // ответила бы 503, клиент рисует значок вида вместо миниатюры.
  if (!first || first.fedState !== undefined) return {};
  const spoiler = first.spoiler === true ? { thumbSpoiler: true as const } : {};
  if (typeof first.id === 'string' && first.id) return { thumb: attachmentLink(first.id, me, gen), ...spoiler };
  return typeof first.url === 'string' && first.url ? { thumb: first.url, ...spoiler } : {};
}

/**
 * Действующие участники групп (`groups1`) по беседам — создатель первым, дальше по времени входа; вышедших нет.
 * Бывшая группа (`groups3`, `formerAt`: беседа → момент МОЕГО выхода) — состав на момент выхода: кого добавили после,
 * бывшему участнику не видно (ревью 08.10: иначе список `?former=1` выдавал новых участников).
 */
async function groupMembersByConv(
  ids: readonly string[],
  q: Q,
  formerAt: ReadonlyMap<string, Date> = new Map(),
): Promise<Map<string, ConvGroupMember[]>> {
  const out = new Map<string, ConvGroupMember[]>();
  if (ids.length === 0) return out;
  const live = ids.filter((id) => !formerAt.has(id));
  const scope = or(
    ...(live.length ? [and(inArray(conversationMembers.conversationId, live), isNull(conversationMembers.leftAt))] : []),
    ...[...formerAt].map(([cid, at]) =>
      and(
        eq(conversationMembers.conversationId, cid),
        lte(conversationMembers.joinedAt, at),
        or(isNull(conversationMembers.leftAt), gt(conversationMembers.leftAt, at)),
      ),
    ),
  );
  const rows = await q
    .select({ cid: conversationMembers.conversationId, role: conversationMembers.role, u: users })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(scope)
    // Создатель первым (как «владелец» в списке участников Telegram), дальше — по времени входа.
    .orderBy(sql`(${conversationMembers.role} = 'owner') DESC`, asc(conversationMembers.joinedAt), asc(conversationMembers.userId));
  for (const r of rows) {
    const list = out.get(r.cid) ?? [];
    list.push({
      id: r.u.id,
      // Э7 часть 1 (#141): участник с другого инстанса — логин на его доме и значок инстанса (добавление).
      username: r.u.homeUsername || r.u.username,
      displayName: r.u.displayName,
      avatarUrl: r.u.avatarUrl,
      role: r.role,
      ...(r.u.homeInstanceId ? { homeInstance: homeInstanceOf(r.u.homeInstanceId) ?? undefined } : {}),
    });
    out.set(r.cid, list);
  }
  return out;
}

/**
 * Плашка незнакомца (08.10, `stranger1`, С7, G30; Telegram: `PeerBarSetting::BlockContact`, `history_view_contact_status.cpp`):
 * беседа 1:1, где собеседник мне уже писал (видимое мне сообщение), я не ответил ни разу, общего активного сервера нет,
 * собеседника я не блокировал, не держу в контактах (`contacts1`, как `user->isContact()` у Telegram) и плашку крестиком не
 * скрывал. Выражение — над строкой `m` (моя строка участника) и `c`.
 * «Я не ответил» (`sx`) идёт по частичному индексу `conversation_messages_author_conv_idx` (миграция 0114, `calls3`): его
 * условие — ровно `deleted_at IS NULL AND service IS NULL`; поменял условие здесь — поменяй индекс, иначе вернётся полный
 * проход всей таблицы сообщений на каждый список бесед.
 */
function strangerSql(me: string): SQL {
  const peer = sql`(SELECT p.user_id FROM conversation_members p
          WHERE p.conversation_id = c.id AND p.user_id <> ${me} ORDER BY p.joined_at, p.user_id LIMIT 1)`;
  return sql`(c.kind = 'direct' AND m.stranger_hidden_at IS NULL AND m.left_at IS NULL
      AND EXISTS (SELECT 1 FROM conversation_messages sy WHERE sy.conversation_id = c.id AND sy.author_id <> ${me}
        AND sy.deleted_at IS NULL AND sy.service IS NULL AND NOT sy.withheld AND NOT (${me} = ANY(sy.hidden_for)))
      AND NOT EXISTS (SELECT 1 FROM conversation_messages sx WHERE sx.conversation_id = c.id AND sx.author_id = ${me}
        AND sx.deleted_at IS NULL AND sx.service IS NULL)
      AND NOT EXISTS (SELECT 1 FROM server_members sa JOIN server_members sb ON sb.server_id = sa.server_id AND sb.state = 'active'
        WHERE sa.user_id = ${me} AND sa.state = 'active' AND sb.user_id = ${peer})
      AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.blocker_id = ${me} AND ub.blocked_id = ${peer})
      AND NOT EXISTS (SELECT 1 FROM user_contacts uc WHERE uc.owner_id = ${me} AND uc.contact_id = ${peer}))`;
}

/**
 * Сводки бесед глазами `me` (все его беседы или только `ids`). Вышедший — `ConvLeft`. Ещё не показанной мне беседы
 * (`hiddenFromMe`) в ответе НЕТ вовсе — ни сводки, ни «вышел»; её id кладётся в `hidden`, если его передали (`deliver`
 * по нему не шлёт событие).
 */
async function summariesFor(
  me: string,
  ids: readonly string[] | null,
  q: Q,
  hidden?: Set<string>,
  groups = true,
): Promise<(ConvSummary | ConvLeft)[]> {
  if (ids && ids.length === 0) return [];
  const only = ids ? sql`AND c.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})` : sql``;
  // Группы (07.10, `groups1`) — только клиенту, который их просит: старый клиент строит строку списка по `otherUser`.
  // «Избранное» (`saved1`) — тоже только тому, кто просит группы: старый клиент строил бы по ней строку «с самим собой».
  const kinds = groups ? sql`` : sql`AND c.kind = 'direct' AND NOT ${SAVED_CONV}`;
  const res = await q.execute(sql`
    SELECT c.id, c.kind, c.created_at, c.last_message_at AS conv_last_at, c.title, c.avatar_url, c.history_for_new, c.origin_instance_id, m.last_read_key, m.left_at, ${SAVED_CONV} AS is_saved,
      ${hiddenFromMe(me, sql`m.pending`, sql`c.id`)} AS hidden_from_me,
      ${clearedFromMe(me, sql`m.hidden_key`, sql`c.id`)} AS cleared_by_me,
      ${formerClearedByMe(me, sql`m.hidden_key`, sql`m.left_at`, sql`c.id`)} AS former_cleared,
      m.draft_text, m.draft_reply_to, m.draft_at, m.draft_device,
      (SELECT p.user_id FROM conversation_members p
        WHERE p.conversation_id = c.id AND p.user_id <> ${me} ORDER BY p.joined_at, p.user_id LIMIT 1) AS peer_id,
      lm.id AS lm_id, lm.author_id AS lm_author, lm.content AS lm_content,
      jsonb_array_length(lm.attachments) AS lm_att, lm.attachments AS lm_atts, lm.sticker AS lm_sticker, lm.media AS lm_media, lm.forwarded_from IS NOT NULL AS lm_fwd, lm.sort_key AS lm_key, lm.created_at AS lm_at,
      lm.service IS NOT NULL AS lm_service, lm.service AS lm_svc, (SELECT a.display_name FROM users a WHERE a.id = lm.author_id) AS lm_author_name,
      ${unreadSql(me, sql`m.last_read_key`)} AS unread,
      ${unreadReactionsSql(me)} AS react_n,
      CASE WHEN c.kind = 'group' THEN ${unreadMentionsSql(me, sql`m.last_read_key`)} ELSE 0 END AS mention_n,
      (SELECT count(*) FROM conversation_scheduled sc WHERE sc.conversation_id = c.id AND sc.author_id = ${me})::int AS sched_n,
      ${strangerSql(me)} AS stranger,
      m.pinned_at, m.unread_marked_at, m.archived_at, mu.hit AS mute_hit, mu.until AS mute_until, mu.sound_only AS mute_sound,
      -- 08.10 (groups3): как я перестал быть участником группы — последняя служебная строка обо мне («удалил» меня или
      -- «покинул» мной); у действующего участника и у 1:1 — null.
      CASE WHEN c.kind = 'group' AND m.left_at IS NOT NULL THEN (
        SELECT s.service->>'type' FROM conversation_messages s
        WHERE s.conversation_id = c.id AND s.service IS NOT NULL
          AND ((s.service->>'type' = 'remove' AND s.service->'users' @> jsonb_build_array(jsonb_build_object('id', ${me}::text)))
            OR (s.service->>'type' = 'leave' AND s.author_id = ${me}))
        ORDER BY s.sort_key DESC LIMIT 1) END AS left_how
    FROM conversation_members m
    JOIN conversations c ON c.id = m.conversation_id
    -- 07.10 (conv11): моя действующая заглушка собеседника (push_mutes, dm_user); истёкшая — как нет.
    LEFT JOIN LATERAL (
      SELECT true AS hit, pm.until, pm.sound_only FROM push_mutes pm
      WHERE pm.user_id = ${me} AND pm.scope = 'dm_user' AND (pm.until IS NULL OR pm.until > now())
        AND ((c.kind = 'direct' AND pm.target_id = (SELECT p.user_id FROM conversation_members p
          WHERE p.conversation_id = c.id AND p.user_id <> ${me} ORDER BY p.joined_at, p.user_id LIMIT 1))
        -- 07.10 (groups2): заглушка группы — цель group:<id беседы> (groupRules.groupMuteTarget).
          OR (c.kind = 'group' AND pm.target_id = ${GROUP_MUTE_PREFIX} || c.id))
      LIMIT 1
    ) mu ON true
    LEFT JOIN LATERAL (
      SELECT x.id, x.author_id, x.content, x.attachments, x.sticker, x.media, x.forwarded_from, x.service, x.sort_key, x.created_at FROM conversation_messages x
      WHERE x.conversation_id = c.id AND x.deleted_at IS NULL AND NOT (${me} = ANY(x.hidden_for))
        -- 08.10 (groups3): бывшему участнику — не позже его выхода (новое после выхода ему не видно).
        AND (m.left_at IS NULL OR x.created_at <= m.left_at)
        AND (NOT x.withheld OR x.author_id = ${me})
      ORDER BY x.sort_key DESC LIMIT 1
    ) lm ON true
    WHERE m.user_id = ${me} ${only} ${kinds}`);
  const rows = (res.rows as Record<string, unknown>[]).filter((r) => {
    if (r.hidden_from_me !== true) return true;
    hidden?.add(String(r.id));
    return false;
  });
  const hasSaved = rows.some((r) => r.is_saved === true && r.kind !== 'group');
  const peerIds = [...new Set([...rows.map((r) => r.peer_id), ...(hasSaved ? [me] : [])].filter((x): x is string => typeof x === 'string'))];
  const peers = peerIds.length ? await q.select().from(users).where(inArray(users.id, peerIds)) : [];
  const peerById = new Map(peers.map((u) => [u.id, u]));
  // Боты-собеседники (#229, 26.10): описание («что умеет этот бот» в пустой беседе) и подпись удалённого бота — одной выборкой
  // по `bots` и только для строк с `bot` (у людей запроса нет). Строка `bots` удалённого бота остаётся — по ней и узнаём.
  const botPeerIds = peers.filter((u) => u.bot).map((u) => u.id);
  const botRows = botPeerIds.length
    ? await q
        .select({ id: schema.bots.userId, description: schema.bots.description, disabledAt: schema.bots.disabledAt, public: schema.bots.public, ownerId: schema.bots.ownerId })
        .from(schema.bots)
        .where(inArray(schema.bots.userId, botPeerIds))
    : [];
  const botDescById = new Map(botRows.map((b) => [b.id, b.description]));
  // Решение A (26.10): писать боту нельзя (выключен / приватный, а я не владелец) — `otherUser.botUnavailable` (добавление),
  // клиент вместо поля ввода рисует плашку. Нет крючков ботов (тесты) — боты считаются включёнными, как в `routes/conv.ts`.
  const botsOn = botRows.length ? (await botConvHooks?.enabled(q)) !== false : true;
  const botUnavailById = new Map(botRows.map((b) => [b.id, botUnavailableFor(b, botsOn, me)]));
  // Э2 часть Б (#141, Ф7): инстансы собеседников, связка с которыми не работает, — `fedLink: 'broken'` (крючок федерации).
  const remoteHomes = [...new Set(peers.map((u) => u.homeInstanceId).filter((h): h is string => typeof h === 'string'))];
  const brokenHomes = remoteHomes.length > 0 && fedHooks?.linkBroken ? await fedHooks.linkBroken(remoteHomes, q) : new Set<string>();
  const noFilesHomes = remoteHomes.length > 0 && fedHooks?.noFiles ? await fedHooks.noFiles(remoteHomes, q) : new Set<string>();
  const noCallsHomes = remoteHomes.length > 0 && fedHooks?.noCalls ? await fedHooks.noCalls(remoteHomes, q) : new Set<string>();
  // Опрос (`dmpoll1`, `ConvSummary.fedPoll`): инстанс собеседника умеет опрос, и журнал на связку у нас пишется.
  const pollHomes = remoteHomes.length > 0 && fedHooks?.record ? await homesWithPolls(q, remoteHomes) : new Set<string>();
  // Исправления ревью 12.10, п. 7 (`ConvSummary.fedStale`): инстанс собеседника не забирает наши сообщения дольше 10 минут.
  const staleHomes = remoteHomes.length > 0 && fedHooks?.linkStale ? await fedHooks.linkStale(remoteHomes, q) : new Set<string>();
  // Хвост Э7 (14.10, `ConvSummary.fedPeerDown`): инстанс собеседника не отвечает нашему забору дольше 10 минут (как дом группы).
  const downHomes = remoteHomes.length > 0 && fedHooks?.peerDown ? fedHooks.peerDown(remoteHomes) : new Set<string>();
  // Э7 часть 1 (#141): дома групп со смешанным составом, связка с которыми не работает, — `fedGroupHost.down`.
  const groupHosts = [...new Set(rows.filter((r) => r.kind === 'group' && typeof r.origin_instance_id === 'string').map((r) => String(r.origin_instance_id)))];
  const groupHostsDown = groupHosts.length > 0 && fedHooks?.linkBroken ? await fedHooks.linkBroken(groupHosts, q) : new Set<string>();
  // Э7 часть 3 (D): дом группы ещё и «молчит» дольше 10 минут (наш забор у него падает / он не забирает наше) — тоже `down`.
  const groupHostsSilent = groupHosts.length > 0 && fedHooks?.groupHostSilent ? await fedHooks.groupHostSilent(groupHosts, q) : new Set<string>();
  const gone = (r: Record<string, unknown>) => !!r.left_at || r.cleared_by_me === true;
  // 08.10 (groups3): бывшая группа — вышел или удалили, а убрать её («Удалить чат») я не успел: сводка на момент выхода.
  const former = (r: Record<string, unknown>) => r.kind === 'group' && !!r.left_at && r.former_cleared !== true;
  // G6 (приёмка 13.10): и бывшей группе — ✓✓ на моих сообщениях не откатываются в ✓, пока меня нет в группе (как Telegram: отметка
  // прочтения диалога остаётся у исключённого).
  const peerReads = await peerReadKeys(me, rows.filter((r) => !gone(r) || former(r)).map((r) => String(r.id)), q);
  // Поколение токенов смотрящего — в подписи ссылки мини-превью (G34); спрашиваем, только если такое фото есть.
  const gen = rows.some((r) => (!gone(r) || former(r)) && lastPhoto(r)) ? await tokenGenOf(me, q) : 0;
  const groupMembers = await groupMembersByConv(
    rows.filter((r) => (!gone(r) || former(r)) && r.kind === 'group').map((r) => String(r.id)),
    q,
    new Map(rows.filter(former).map((r) => [String(r.id), new Date(r.left_at as string | Date)])),
  );
  return rows.map((r): ConvSummary | ConvLeft => {
    // Убранная мной («Удалить чат», `conv12`) — для списка как «вышел»: строка уходит со всех моих устройств.
    if (gone(r) && !former(r)) return { id: String(r.id), left: true };
    const isGroup = r.kind === 'group';
    const saved = !isGroup && r.is_saved === true;
    // «Избранное»: собеседник — я сам (карточка нужна клиенту; других участников нет).
    const peer = saved ? peerById.get(me) : !isGroup && typeof r.peer_id === 'string' ? peerById.get(r.peer_id) : undefined;
    const last = r.lm_id
      ? {
          id: String(r.lm_id),
          authorId: String(r.lm_author),
          ...stickerAwarePreview(mediaAwareText(String(r.lm_content ?? ''), r.lm_media), r.lm_sticker),
          attachments: toNum(r.lm_att ?? 0),
          // Раунд 11: вид вложений для превью в списке (фото, голосовое с длительностью, файл с именем) — только
          // добавлением: без вложений полей нет, старый клиент их не читает.
          ...(stickerOf(r.lm_sticker) ? { attachmentKind: 'sticker' as const } : lastAttachmentPreview(jsonList(r.lm_atts))),
          // 07.10 (G34): мини-превью первого фото (ссылка смотрящего, как у закрепа `pinsFor`) и признак «переслано» —
          // только добавлением: у не-фото и не-пересланного полей нет, старый клиент их не читает.
          ...lastThumb(r, me, gen),
          ...(r.lm_fwd === true ? { forwarded: true as const } : {}),
          // Группа (`groups1`): «Имя: текст» в строке списка; у служебной записи — признак вместо имени.
          ...(isGroup && r.lm_service === true ? { service: true as const } : {}),
          ...(isGroup && r.lm_service !== true && typeof r.lm_author_name === 'string' ? { authorName: r.lm_author_name } : {}),
          // 10.10 (B3): запись о звонке 1:1 — причина/длительность/видео; строка списка подписывает её, как лента.
          ...(!isGroup ? lastCallOf(r.lm_svc) : {}),
          sortKey: toNum(r.lm_key),
          createdAt: iso(r.lm_at),
        }
      : null;
    const members = groupMembers.get(String(r.id)) ?? [];
    const summary: ConvSummary = {
      id: String(r.id),
      kind: isGroup ? 'group' : 'direct',
      ...(saved ? { saved: true as const } : {}),
      // Группа (`groups1`): название, фото, участники — только у неё; у 1:1 поля нет (DTO прежний).
      ...(isGroup
        ? {
            group: {
              title: typeof r.title === 'string' ? r.title : '',
              avatarUrl: typeof r.avatar_url === 'string' ? r.avatar_url : null,
              ownerId: members.find((x) => x.role === 'owner')?.id ?? null,
              members,
              limit: GROUP_MEMBER_LIMIT,
              // «История для новых» (аудит ЛС #236, п.8) — добавлением: старый клиент поле не знает.
              historyForNew: r.history_for_new === true,
            },
            // Э7 часть 1 (#141, `fedm6`): дом группы — другой инстанс (состав меняет он; связка не работает — `down`).
            ...(typeof r.origin_instance_id === 'string'
              ? { fedGroupHost: { instanceId: r.origin_instance_id, ...(groupHostsDown.has(r.origin_instance_id) || groupHostsSilent.has(r.origin_instance_id) ? { down: true as const } : {}) } }
              : {}),
          }
        : {}),
      otherUser: peer
        ? {
            id: peer.id,
            // Э1 (#141): собеседник с другого инстанса — его логин на доме и значок инстанса (поле только у него, добавление).
            username: peer.homeUsername || peer.username,
            // Удалённый бот (#229, 26.10) — «Удалённый бот», а не «Удалённый пользователь»; и у удалённых до этой правки.
            displayName: peer.deletedAt && botDescById.has(peer.id) ? DELETED_BOT_NAME : peer.displayName,
            avatarUrl: peer.avatarUrl,
            ...(peer.homeInstanceId ? { homeInstance: homeInstanceOf(peer.homeInstanceId) } : {}),
            // Бот (#229): значок «БОТ» в списке и шапке беседы — поле только у бота (добавление).
            // Настоящий бот, а не автор вебхука — тот же признак, что `serialize.isRealBot` (подтверждён); здесь без импорта.
            ...(peer.bot && peer.verified ? { bot: true as const } : {}),
            // Описание бота для пустой беседы (Telegram «Что умеет этот бот?») — только у живого бота с непустым (добавление).
            ...(peer.bot && peer.verified && botDescById.get(peer.id) ? { botDescription: botDescById.get(peer.id) } : {}),
            // Писать боту нельзя (решение A, 26.10): `private` / `disabled` — клиент рисует плашку вместо поля ввода (добавление).
            ...(peer.bot && peer.verified && !peer.deletedAt && botUnavailById.get(peer.id) ? { botUnavailable: botUnavailById.get(peer.id)! } : {}),
          }
        : null,
      createdAt: iso(r.created_at),
      // Э2 часть Б (Ф9 «по приходу»): у беседы с человеком соседа опоздавшая копия поднимает беседу моментом приёма — время
      // беседы (`conversations.last_message_at`, приём ставит `now()`) позже времени отправки последнего сообщения.
      lastMessageAt: last ? (peer?.homeInstanceId ? laterIso(last.createdAt, r.conv_last_at) : last.createdAt) : null,
      lastMessage: last,
      unread: toNum(r.unread ?? 0),
      lastReadKey: toNum(r.last_read_key ?? 0),
      // Р6: «прочитано собеседником» глазами меня (`peerReadKeys`); `null` — сравнивать не с кем.
      peerReadKey: peerReads.get(String(r.id)) ?? null,
      // Р7: мой черновик — только в МОЕЙ сводке (строка участника — моя); `null` — нет.
      draft:
        typeof r.draft_text === 'string'
          ? {
              text: r.draft_text,
              replyToId: typeof r.draft_reply_to === 'string' ? r.draft_reply_to : null,
              at: iso(r.draft_at ?? r.created_at),
              device: typeof r.draft_device === 'string' ? r.draft_device : null,
            }
          : null,
      // С4: сколько МОИХ отложенных в беседе — вход «Отложенные: N»; собеседник моих не видит (его сводка — его число).
      scheduledCount: toNum(r.sched_n ?? 0),
      // 07.10 (`conv11`): мой закреп беседы и моя заглушка собеседника — только в МОЕЙ сводке.
      pinnedAt: r.pinned_at ? iso(r.pinned_at) : null,
      muted:
        r.mute_hit === true
          ? { until: r.mute_until ? iso(r.mute_until) : null, ...(r.mute_sound === true ? { soundOnly: true as const } : {}) }
          : null,
      // 07.10 (`conv13`): моя пометка «непрочитанным» (точка без числа) — только в МОЕЙ сводке.
      markedUnread: !!r.unread_marked_at,
      // 07.10 (`archive1`, G41): беседа в моём архиве — только в МОЕЙ сводке.
      archived: !!r.archived_at,
      // 08.10 (`stranger1`, С7): плашка незнакомца — только в МОЕЙ сводке (поле есть, только когда она горит).
      ...(r.stranger === true ? { stranger: true as const } : {}),
      // Э2 часть Б (`ConvSummary.fedLink`): связка с инстансом собеседника разорвана/на паузе — архив только для чтения.
      ...(peer?.homeInstanceId && brokenHomes.has(peer.homeInstanceId) ? { fedLink: 'broken' as const } : {}),
      // Э3 часть 1 (`ConvSummary.fedNoFiles`): инстанс собеседника не умеет вложения (`dm2`) — файлы туда не уходят.
      ...(peer?.homeInstanceId && noFilesHomes.has(peer.homeInstanceId) ? { fedNoFiles: true as const } : {}),
      // Э6 (`ConvSummary.fedNoCalls`): инстанс собеседника не умеет звонки (`dmcall1`) — кнопка звонка неактивна.
      ...(peer?.homeInstanceId && noCallsHomes.has(peer.homeInstanceId) ? { fedNoCalls: true as const } : {}),
      // Опрос (`ConvSummary.fedPoll`): 1:1 с человеком инстанса, объявившего `dmpoll1`, — пункт «Опрос» открыт.
      ...(r.kind !== 'group' && peer?.homeInstanceId && pollHomes.has(peer.homeInstanceId) ? { fedPoll: true as const } : {}),
      // Исправления ревью 12.10, п. 7: архив (`fedLink`) важнее — плашка «ждут» только у рабочей связки.
      ...(peer?.homeInstanceId && staleHomes.has(peer.homeInstanceId) && !brokenHomes.has(peer.homeInstanceId) ? { fedStale: true as const } : {}),
      // Хвост Э7 (14.10): дом собеседника молчит — плашка «Инстанс «X» недоступен»; архив (`fedLink`) важнее и её.
      ...(peer?.homeInstanceId && downHomes.has(peer.homeInstanceId) && !brokenHomes.has(peer.homeInstanceId) ? { fedPeerDown: true as const } : {}),
      // 07.10 (`reactunread1`, G24): сколько моих сообщений с непрочитанными реакциями — только в МОЕЙ сводке.
      unreadReactions: toNum(r.react_n ?? 0),
      // 07.10 (`groups2`, G24): непрочитанные упоминания меня — только у группы и только когда есть.
      ...(isGroup && toNum(r.mention_n ?? 0) > 0 ? { unreadMentions: toNum(r.mention_n ?? 0) } : {}),
    };
    if (!former(r)) return summary;
    // Бывшая группа (`groups3`): для старого клиента — прежнее «вышел», новому — сводка только на чтение. Счётчиков нет
    // (новое после выхода не моё), отложенных и черновика — тоже (писать нельзя).
    const { unreadMentions: _m, ...rest } = summary;
    return {
      id: String(r.id),
      left: true,
      former: {
        ...rest,
        unread: 0,
        unreadReactions: 0,
        markedUnread: false,
        scheduledCount: 0,
        draft: null,
        former: { at: iso(r.left_at), removed: r.left_how === 'remove' },
      },
    };
  });
}

/**
 * Цитата ответа `m` глазами смотрящего (`quote1`, G55). `base` — превью цитируемого, как прежде (его нет — спрятано от
 * смотрящего); `parent` — беседа и автор цитируемого (нет — строки нет). Цитата фрагмента (`reply_quote` не `auto`) —
 * `quote` / `quoteOffset`. Цитируемое из ДРУГОЙ беседы — `foreign`; состоящему в той беседе — полное превью и
 * `conversationId` (переход), остальным — только имя автора и снимок цитаты (`content`), без вложений и перехода.
 */
function replyPreviewFor(
  m: MsgRow,
  base: MessageReplyPreview | undefined,
  parent: { conversationId: string; authorName: string } | undefined,
  memberOf: ReadonlySet<string>,
): MessageReplyPreview | null {
  if (!parent) return null;
  const q = m.replyQuote;
  const quote = q && !q.auto && base && !base.deleted ? { quote: q.text, quoteOffset: q.offset } : {};
  if (parent.conversationId === m.conversationId) return base ? { ...base, ...quote } : null;
  if (base?.deleted) return { ...base, foreign: true };
  if (base && memberOf.has(parent.conversationId)) return { ...base, ...quote, foreign: true, conversationId: parent.conversationId };
  return {
    id: m.replyToId!,
    authorName: parent.authorName,
    content: q?.text ?? '',
    ...(q && !q.auto ? { quote: q.text, quoteOffset: q.offset } : {}),
    foreign: true,
  };
}

/** Сообщения глазами `viewerId`: полный DTO или `gone`. Цитаты и реакции — тоже его глазами. */
async function messagesForViewer(rows: readonly MsgRow[], viewerId: string, q: Q): Promise<Map<string, ConvMessage | ConvGone>> {
  const out = new Map<string, ConvMessage | ConvGone>();
  if (rows.length === 0) return out;
  // «История для новых» (аудит ЛС #236, п.8): сообщение до добавления смотрящего — для него `gone`, как спрятанное.
  const floors = await historyFloors(viewerId, [...new Set(rows.map((m) => m.conversationId))], q);
  const beforeJoin = (m: { conversationId: string; sortKey: number }) => m.sortKey < (floors.get(m.conversationId) ?? 0);
  const full = rows.filter((m) => messageView(m, viewerId) === 'full' && !beforeJoin(m));
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
  // Поколение токенов смотрящего входит в подпись ссылок на его файлы: «выйти на всех устройствах» гасит и их. Нужно и
  // цитатам (миниатюра фото, 05.10), и вложениям самих сообщений ниже.
  const viewer = { id: viewerId, tokenGen: await tokenGenOf(viewerId, q) };
  const replies = new Map<string, MessageReplyPreview>();
  // «Ответить в другом чате» (`quote1`): у цитируемого из ДРУГОЙ беседы переход и превью — только тем, кто в той беседе
  // состоит; остальным — снимок цитаты текстом (`replyPreviewFor`). Одним запросом: в каких из этих бесед смотрящий сейчас.
  const parentInfo = new Map(parents.map((p) => [p.m.id, { conversationId: p.m.conversationId, authorName: p.u.displayName }]));
  const otherConvs = [
    ...new Set(
      full.flatMap((m) => {
        const c = m.replyToId ? parentInfo.get(m.replyToId)?.conversationId : undefined;
        return c && c !== m.conversationId ? [c] : [];
      }),
    ),
  ];
  const memberOf = new Set(
    otherConvs.length
      ? (
          await q
            .select({ c: conversationMembers.conversationId })
            .from(conversationMembers)
            .where(
              and(
                eq(conversationMembers.userId, viewerId),
                isNull(conversationMembers.leftAt),
                inArray(conversationMembers.conversationId, otherConvs),
              ),
            )
        ).map((r) => r.c)
      : [],
  );
  // Цитата на сообщение до добавления смотрящего («История для новых», аудит #236, п.8) — как спрятанное: цитаты нет.
  const parentConvs = [...new Set(parents.map((p) => p.m.conversationId))].filter((c) => !floors.has(c));
  const pFloors = new Map([...floors, ...(await historyFloors(viewerId, parentConvs, q))]);
  for (const p of parents) {
    if (p.m.sortKey < (pFloors.get(p.m.conversationId) ?? 0)) continue;
    // Удалённое у обоих — цитата «сообщение удалено»; спрятанное мной и чужое придержанное — цитаты нет вовсе.
    if (p.m.deletedAt) replies.set(p.m.id, { id: p.m.id, authorName: p.u.displayName, content: '', deleted: true });
    else if (messageView(p.m, viewerId) === 'full')
      replies.set(p.m.id, {
        id: p.m.id,
        authorName: p.u.displayName,
        content: mediaAwareText(p.m.content, p.m.media),
        // 05.10: вид вложений цитируемого — для цитаты на сообщение вне загруженного окна ленты (у клиента его нет).
        ...replyAttachments(p.m.attachments, viewer, !!p.m.sticker),
      });
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
  // «Кто поставил» (07.10, `ReactionGroup.reactors`): люди по порядку постановки — клиент рисует их аватарки вместо числа
  // и окно «кто поставил». Только добавление к DTO (правило 11): `count` и `me` прежние.
  const agg = new Map<string, Map<string, { count: number; me: boolean; reactors: ReactionReactor[] }>>();
  for (const r of reactionRows) {
    if (hidden.has(r.userId)) continue;
    const byEmoji = agg.get(r.messageId) ?? new Map<string, { count: number; me: boolean; reactors: ReactionReactor[] }>();
    agg.set(r.messageId, byEmoji);
    const cur = byEmoji.get(r.emoji) ?? { count: 0, me: false, reactors: [] };
    cur.count += 1;
    if (r.userId === viewerId) cur.me = true;
    cur.reactors.push({ userId: r.userId, at: iso(r.createdAt) });
    byEmoji.set(r.emoji, cur);
  }

  // «Прослушано» у голосовых (07.10, `voice1`): строки слушателей только по голосовым сообщениям этой выдачи.
  const voiceIds = full.filter((m) => m.attachments.some(isListenable)).map((m) => m.id);
  const listens = new Map<string, Set<string>>();
  if (voiceIds.length > 0) {
    const rows = await q
      .select({ messageId: conversationVoiceListens.messageId, userId: conversationVoiceListens.userId })
      .from(conversationVoiceListens)
      .where(inArray(conversationVoiceListens.messageId, voiceIds));
    for (const r of rows) {
      if (hidden.has(r.userId)) continue; // прослушавший, которого я заблокировал, для меня как не слушал — как с реакциями
      const set = listens.get(r.messageId) ?? new Set<string>();
      listens.set(r.messageId, set);
      set.add(r.userId);
    }
  }

  // Опросы (`convpoll1`): голоса только по опросам этой выдачи — одним запросом. Голоса заблокированных смотрящим НЕ прячем:
  // итог опроса общий для всех (как у Telegram), иначе у двоих разные проценты одного опроса.
  const pollIds = full.filter((m) => m.media?.kind === 'poll').map((m) => m.id);
  const pollVotes = new Map<string, { userId: string; optionId: string }[]>();
  if (pollIds.length > 0) {
    const rows = await q
      .select({ messageId: convPollVotes.messageId, userId: convPollVotes.userId, optionId: convPollVotes.optionId })
      .from(convPollVotes)
      .where(inArray(convPollVotes.messageId, pollIds));
    for (const r of rows) pollVotes.set(r.messageId, [...(pollVotes.get(r.messageId) ?? []), r]);
  }

  // Авторы и авторы оригиналов пересланного (`forwardedFrom`, `conv5`) — одним запросом.
  const authorIds = [
    ...new Set([...full.map((m) => m.authorId), ...full.flatMap((m) => (m.forwardedFrom ? [m.forwardedFrom.userId] : []))]),
  ];
  const authors = new Map((await q.select().from(users).where(inArray(users.id, authorIds))).map((u) => [u.id, u]));
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
      reactors: reactorsInOrder(v.reactors),
    }));
    const replyTo = m.replyToId ? replyPreviewFor(m, replies.get(m.replyToId), parentInfo.get(m.replyToId), memberOf) : null;
    const cm = toConvMessage(m, author, replyTo, reactions, viewer, forwardView(m.forwardedFrom, authors));
    // G24 (`reactunread1`): автору — «на сообщение есть реакция, которую я не видел» (чужая, не заблокированного).
    if (m.authorId === viewerId && reactionRows.some((r) => r.messageId === m.id && r.seenAt === null && r.userId !== viewerId && !hidden.has(r.userId)))
      cm.reactionUnread = true;
    if (voiceIds.includes(m.id)) cm.voiceListened = voiceListenedFor(viewerId, m.authorId, listens.get(m.id) ?? new Set());
    if (m.media?.kind === 'poll') cm.media = convPollView(m.media, pollVotes.get(m.id) ?? [], viewerId);
    out.set(m.id, cm);
  }
  return out;
}

/** Поставившие реакцию по порядку постановки (старые первыми; в одну миллисекунду — по id): строки базы идут вразнобой. */
function reactorsInOrder(list: ReactionReactor[]): ReactionReactor[] {
  return [...list].sort((a, b) => a.at.localeCompare(b.at) || a.userId.localeCompare(b.userId));
}

/**
 * «Переслано от» глазами смотрящего (`conv5`): имя — снимок на момент пересылки. Аккаунт автора оригинала удалён — его
 * нынешнее обезличенное имя, как у автора сообщения и у цитаты: старое имя удалённого человека по беседам не ходит.
 * Признак `deleted` (05.10) — из снимка (его ставит обезличивание, `accountRows`) или по самому аккаунту: снимок, вставленный
 * пересылкой в узкое окно после обезличивания, или снятый до появления признака, его не несёт. У живого автора поля нет.
 */
function forwardView(f: MessageForwardedFrom | null, people: ReadonlyMap<string, UserRow>): MessageForwardedFrom | null {
  if (!f) return null;
  const u = people.get(f.userId);
  const deleted = f.deleted === true || !!u?.deletedAt;
  return {
    userId: f.userId,
    displayName: u?.deletedAt ? u.displayName : f.displayName,
    at: f.at,
    ...(deleted ? { deleted: true as const } : {}),
    ...(f.unverified === true ? { unverified: true as const } : {}),
  };
}

/**
 * Вложения глазами смотрящего: у закрытых (шаг 1в, есть `id`) ссылка собирается ЗДЕСЬ, своя для каждого — в строке
 * сообщения её нет. Старые (публичный бакет, до 1в) несут `url` как есть (Р17).
 */
function viewerAttachments(list: Attachment[], viewer: { id: string; tokenGen: number }): Attachment[] {
  return list.map((a) => (a.id ? { ...a, url: attachmentLink(a.id, viewer.id, viewer.tokenGen) } : a));
}

/** Поколение токенов человека — входит в подпись ссылок на его файлы (`attachmentLink`). */
async function tokenGenOf(userId: string, q: Q): Promise<number> {
  const [row] = await q.select({ gen: users.tokenGeneration }).from(users).where(eq(users.id, userId));
  return row?.gen ?? 0;
}

type ReplyAttachmentView = Pick<
  MessageReplyPreview,
  'attachments' | 'attachmentKind' | 'attachmentDurationMs' | 'attachmentName' | 'attachmentVideo' | 'thumb' | 'thumbSpoiler'
>;

/**
 * Вложения цитируемого глазами смотрящего (05.10, `MessageReplyPreview`): число и вид
 * (`convRules.replyAttachmentPreview` — форма превью строки списка), у фото — миниатюра первого: ссылка СМОТРЯЩЕГО
 * (`attachmentLink`, как у вложений в ленте и у закрепа), у старого публичного (до шага 1в) — `url` как есть (Р17).
 * Без вложений — пусто: DTO цитаты прежний.
 */
function replyAttachments(
  list: readonly Attachment[],
  viewer: { id: string; tokenGen: number },
  sticker = false,
): ReplyAttachmentView {
  // Цитата на стикер (`stickers2`) — вид `sticker` без числа, как в каналах (`routes/messages.ts`).
  const fields: ReplyAttachmentView = replyAttachmentPreview(list, sticker);
  const first = list[0];
  // Одноразовое фото (#226) — цитата без миниатюры (файл закрыт до открытия получателем).
  if (fields.attachmentKind !== 'photo' || !first || first.once === true) return fields;
  const thumb = first.id ? attachmentLink(first.id, viewer.id, viewer.tokenGen) : first.url;
  // Спойлер первого фото (`media2`): миниатюра уходит, но с признаком — клиент рисует её размытой.
  return thumb ? { ...fields, thumb, ...(first.spoiler === true ? { thumbSpoiler: true as const } : {}) } : fields;
}

function toConvMessage(
  m: MsgRow,
  author: UserRow,
  replyTo: MessageReplyPreview | null,
  reactions: ReactionGroup[],
  viewer: { id: string; tokenGen: number },
  forwardedFrom: MessageForwardedFrom | null = null,
): ConvMessage {
  return {
    ...serializeMessage({
      id: m.id,
      channelId: m.conversationId,
      content: m.content,
      // G56 (`album1`): элементы альбома, спрятанные смотрящим «у меня», ему не показываются.
      attachments: viewerAttachments(attachmentsForViewer(m.attachments, m.hiddenAttachments, viewer.id), viewer),
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      replyTo,
      reactions,
      // Э7 часть 1 (#141): автор с другого инстанса (теневая строка) — его логин на доме, как `otherUser`/участники группы.
      author: author.homeInstanceId ? { ...author, username: author.homeUsername || author.username } : author,
      sticker: m.sticker ?? null,
      // Карточки бота (#229): поле только у таких сообщений, у остальных DTO прежний (`serializeMessage`).
      embeds: m.embeds,
      embedsFallback: m.embedsFallback,
    }),
    conversationId: m.conversationId,
    sortKey: m.sortKey,
    clientId: m.clientId,
    // Только у пересланных (`conv5`): у остальных сообщений DTO прежний, без нового поля.
    ...(forwardedFrom ? { forwardedFrom } : {}),
    // «Без звука» (С3, `conv8`) — тоже только у таких: обычное сообщение не получает ни ключа (DTO прежний). Отсюда поле
    // едет везде, где есть вид сообщения: ответ, история, `conv.change`, догонка.
    ...(m.silent ? { silent: true as const } : {}),
    // «Без превью ссылки» (G19, `linkprev1`) — так же, только у таких.
    ...(m.noPreview ? { noPreview: true as const } : {}),
    // «Подпись над медиа» (G48, `media2`) — так же, только у таких.
    ...(m.captionAbove ? { captionAbove: true as const } : {}),
    // Служебная строка (G28 `pins2` — закреп, `groups1` — действие в группе) — только у таких; у обычных DTO прежний.
    ...(m.service ? { service: m.service } : {}),
    // Геопозиция / контакт (G69, `geocontact1`) — только у таких; у обычных DTO прежний.
    ...(m.media ? { media: m.media } : {}),
    // Опрос (`convpoll1`): хранимая форма несёт правильный ответ и пояснение — наружу только вид смотрящего без голосов; итоги
    // подставляет построитель выдачи (голоса пачкой), до того — нули и ни одного секрета.
    ...(m.media?.kind === 'poll' ? { media: convPollView(m.media, [], viewer.id) } : {}),
    // Трансляция геопозиции (`geolive1`): истёкшая отдаётся остановленной — истечение на чтении, без таймеров.
    ...(m.media?.kind === 'geolive' ? { media: geoLiveView(m.media, Date.now()) } : {}),
    // Одноразовое голосовое прослушано (`voice3`, G54) — только у таких; у остальных DTO прежний.
    ...(m.onceSpentAt ? { voiceOnceSpent: true as const } : {}),
    // Э2 (#141, Ф9): копия с другого инстанса пришла позже отправки больше чем на 5 минут — момент прихода (местный ключ
    // порядка — микросекунды часов базы при вставке). У своих сообщений `origin_sort_key` нет — поля нет.
    ...(m.originSortKey !== null && deliveredLate(m.createdAt.getTime(), Math.floor(m.sortKey / 1000))
      ? { deliveredAt: new Date(Math.floor(m.sortKey / 1000)).toISOString() }
      : {}),
    // Э5 часть 1 (#141, `fedm5`): «через» другой инстанс — только у таких; у обычных DTO прежний.
    ...(m.viaInstanceId ? { via: { instance: m.viaInstanceId, confirmed: m.viaState === 'confirmed' } } : {}),
    // Кнопки под сообщением бота (#230) — только у таких; у остальных DTO прежний. Только здесь, не в `serializeMessage`
    // (он общий с каналами), и не в федеративном проводе (беседа с ботом всегда местная).
    ...(m.keyboard?.length ? { keyboard: keyboardView(m.keyboard) } : {}),
  };
}

/**
 * Кнопки в порядке полей провода (`text`, затем `callback_data` или `url`): jsonb хранит ключи объекта отсортированными
 * (`url` раньше `text`), а клиенту и боту отдаём форму Bot API как есть. Лишнего не пропускает.
 */
function keyboardView(k: InlineKeyboard): InlineKeyboard {
  return k.map((row) =>
    row.map((b) => ({ text: b.text, ...(b.callback_data !== undefined ? { callback_data: b.callback_data } : { url: b.url ?? '' }) })),
  );
}

async function ptsOf(q: Q, me: string): Promise<{ pts: number; minPts: number }> {
  const [row] = await q.select({ pts: userSync.pts, minPts: userSync.minPts }).from(userSync).where(eq(userSync.userId, me));
  return row ? { pts: row.pts, minPts: row.minPts } : { pts: 0, minPts: 0 };
}

/**
 * Мои закреплённые в беседе (С2, `conv7`) — от старых к новым по порядку ленты, с превью в форме последнего сообщения
 * строки списка (раунд 11) и миниатюрой первого фото (ссылка смотрящего). Видимость — `visibleTo` (то же, что
 * `convRules.messageView === 'full'`): строки и так уходят вместе с видимостью (удаление у обоих, «у меня»), а фильтр
 * страхует от закрепов, оставленных откатом на бэкенд до С2. 🔴 Через переданный `q` — внутри чтения-снимка только его
 * транзакция (см. `messagesForViewer`).
 */
async function pinsFor(me: string, conversationId: string, q: Q): Promise<ConvPin[]> {
  const rows = await q
    .select({ pin: conversationPins, m: conversationMessages })
    .from(conversationPins)
    .innerJoin(conversationMessages, eq(conversationMessages.id, conversationPins.messageId))
    .where(and(eq(conversationPins.conversationId, conversationId), eq(conversationPins.userId, me), visibleTo(me, conversationId)))
    .orderBy(asc(conversationMessages.sortKey));
  let tokenGen: number | null = null;
  const out: ConvPin[] = [];
  for (const { pin, m } of rows) {
    const kind = m.sticker ? { attachmentKind: 'sticker' as const } : lastAttachmentPreview(m.attachments);
    let thumb: string | undefined;
    const first = m.attachments[0];
    // Копия файла соседа ещё едет (`fedState`, исправления ревью 12.10, п. 11) — без миниатюры, как у строки списка.
    if (kind?.attachmentKind === 'photo' && first && !first.fedState && first.once !== true) {
      if (first.id) {
        if (tokenGen === null) {
          // Поколение токенов смотрящего входит в подпись ссылки (как у вложений в ленте, `messagesForViewer`).
          const [viewer] = await q.select({ gen: users.tokenGeneration }).from(users).where(eq(users.id, me));
          tokenGen = viewer?.gen ?? 0;
        }
        thumb = attachmentLink(first.id, me, tokenGen);
      } else if (first.url) thumb = first.url; // старое публичное вложение (до 1в) — ссылка как есть (Р17)
    }
    out.push({
      message: {
        id: m.id,
        authorId: m.authorId,
        text: previewText(mediaAwareText(m.content, m.media) || (m.sticker?.emoji ?? '')),
        attachments: m.attachments.length,
        ...kind,
        sortKey: m.sortKey,
        createdAt: m.createdAt.toISOString(),
      },
      ...(thumb ? { thumb } : {}),
      ...(thumb && first?.spoiler === true ? { thumbSpoiler: true as const } : {}),
      forBoth: pin.forBoth,
      pinnedBy: pin.pinnedBy,
      pinnedAt: pin.pinnedAt.toISOString(),
    });
  }
  return out;
}

/** Мой список закреплённого и номер журнала из ОДНОГО снимка (`q` — транзакция вызывающего). */
async function pinsListOf(me: string, conversationId: string, q: Q): Promise<ConvPinsResponse> {
  const { pts } = await ptsOf(q, me);
  return { pts, pins: await pinsFor(me, conversationId, q) };
}

// ─── Отложенные (С4, 05.10, признак `conv9`): чтение и вид — здесь, запись и планировщик — `scheduled.ts` ─────────────

export type ScheduledRow = typeof conversationScheduled.$inferSelect;

/**
 * Цитата отложенного глазами автора — то же правило, что у сообщения (`messagesForViewer`): удалённое у обоих —
 * «сообщение удалено», спрятанное им и чужое придержанное — цитаты нет. Вложения цитируемого (05.10) — тоже как там:
 * вид, число и миниатюра фото ссылкой автора (`viewer`).
 */
function scheduledReply(
  parent: MsgRow | null,
  authorName: string | null,
  me: string,
  viewer: { id: string; tokenGen: number },
): MessageReplyPreview | null {
  if (!parent) return null;
  if (parent.deletedAt) return { id: parent.id, authorName: authorName ?? '', content: '', deleted: true };
  if (messageView(parent, me) !== 'full') return null;
  return {
    id: parent.id,
    authorName: authorName ?? '',
    content: mediaAwareText(parent.content, parent.media),
    ...replyAttachments(parent.attachments, viewer, !!parent.sticker),
  };
}

/**
 * Отложенное — DTO автора (`ConvScheduled`): `silent` и `failed` — только у таких. `attachments` (06.10, `conv10`) — только
 * у отложенного с файлами: ссылки собираются здесь под смотрящего (`viewer` — автор и поколение его токенов), как у
 * вложений в ленте; в строке отложенного — заглушки.
 */
export function toScheduledView(
  s: ScheduledRow,
  replyTo: MessageReplyPreview | null,
  viewer: { id: string; tokenGen: number },
): ConvScheduled {
  return {
    id: s.id,
    conversationId: s.conversationId,
    clientId: s.clientId,
    content: s.content,
    replyTo,
    ...(s.attachments.length > 0 ? { attachments: viewerAttachments(s.attachments, viewer) } : {}),
    ...(s.silent ? { silent: true as const } : {}),
    ...(s.captionAbove ? { captionAbove: true as const } : {}),
    sendAt: s.sendAt ? s.sendAt.toISOString() : null,
    whenOnline: s.whenOnline,
    createdAt: s.createdAt.toISOString(),
    editedAt: s.editedAt ? s.editedAt.toISOString() : null,
    ...(s.failedAt ? { failed: { at: s.failedAt.toISOString(), reason: s.failReason === 'peer-gone' ? ('peer-gone' as const) : ('error' as const) } } : {}),
  };
}

/**
 * Мои отложенные в беседе (С4) — сначала «Отправить позже» по времени, затем «Когда будет в сети» по порядку создания.
 * Только мои: чужие отложенные не видны никому, кроме их автора. 🔴 Через переданный `q` — внутри чтения-снимка только его
 * транзакция (см. `messagesForViewer`).
 */
export async function scheduledFor(me: string, conversationId: string, q: Q): Promise<ConvScheduled[]> {
  const rows = await q
    .select({ s: conversationScheduled, parent: conversationMessages, parentName: users.displayName })
    .from(conversationScheduled)
    .leftJoin(conversationMessages, eq(conversationMessages.id, conversationScheduled.replyToId))
    .leftJoin(users, eq(users.id, conversationMessages.authorId))
    .where(and(eq(conversationScheduled.conversationId, conversationId), eq(conversationScheduled.authorId, me)))
    .orderBy(
      sql`${conversationScheduled.sendAt} IS NULL`,
      asc(conversationScheduled.sendAt),
      asc(conversationScheduled.createdAt),
      asc(conversationScheduled.id),
    );
  // Ссылки автора на файлы — миниатюра фото в цитате (05.10) и вложения самих отложенных (06.10, `conv10`): поколение его
  // токенов — один запрос, и только когда файлы есть (без них ссылок нет, число не нужно).
  const withFiles = rows.some((r) => r.s.attachments.length > 0 || (!!r.parent && r.parent.attachments.length > 0));
  const viewer = { id: me, tokenGen: withFiles ? await tokenGenOf(me, q) : 0 };
  return rows.map((r) => toScheduledView(r.s, scheduledReply(r.parent, r.parentName, me, viewer), viewer));
}

/** Мой список отложенных и номер журнала из ОДНОГО снимка (`q` — транзакция вызывающего). */
export async function scheduledListOf(me: string, conversationId: string, q: Q): Promise<ConvScheduledResponse> {
  const { pts } = await ptsOf(q, me);
  return { pts, items: await scheduledFor(me, conversationId, q) };
}

// ─── Чтение ────────────────────────────────────────────────────────────────────────────────────────────────────────

function isSummary(x: ConvSummary | ConvLeft): x is ConvSummary {
  return !('left' in x);
}

/** `GET /api/conv` — мои беседы, свежие сверху, и `pts`, согласованный со списком. */
export async function listConversations(me: string, groups = false, withFormer = false): Promise<ConvListResponse> {
  return db.transaction(async (tx) => {
    // Ревью 08.10: у списка в сотни бесед оценка плана — миллионы, и Postgres тратит на JIT-компиляцию больше, чем на
    // само чтение (3263 беседы: 1,3 с с JIT против 0,27 с без). Только в этой транзакции (`SET LOCAL`).
    await tx.execute(sql`SET LOCAL jit = off`);
    const { pts } = await ptsOf(tx, me);
    const all = await summariesFor(me, null, tx, undefined, groups);
    const conversations = all.filter(isSummary);
    // Закреплённые первыми (07.10, `conv11`), дальше свежие сверху; клиент сортирует сам, порядок здесь — для старых.
    conversations.sort(convListOrder);
    if (!withFormer || !groups) return { pts, conversations };
    // 08.10 (`groups3`): бывшие группы — отдельным полем, только по просьбе (`?former=1`); старый клиент его не шлёт.
    const former = all.flatMap((x) => (!isSummary(x) && x.former ? [x.former] : []));
    return { pts, conversations, former };
  }, SNAPSHOT);
}

/**
 * Бывший участник группы (08.10, `groups3`): когда вышел, если беседа группа, я в ней был и не убирал её «Удалить чат».
 * `null` — не бывший (действующий, чужой или убрал). История ему — до этого момента (`history`).
 */
export async function formerLeftAt(conversationId: string, me: string, q: Q = db): Promise<Date | null> {
  const res = await q.execute(sql`
    SELECT m.left_at, ${formerClearedByMe(me, sql`m.hidden_key`, sql`m.left_at`, sql`c.id`)} AS cleared_by_me
    FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = ${conversationId} AND m.user_id = ${me} AND c.kind = 'group' AND m.left_at IS NOT NULL`);
  const row = res.rows[0] as { left_at: unknown; cleared_by_me: unknown } | undefined;
  if (!row || row.cleared_by_me === true || !row.left_at) return null;
  return row.left_at instanceof Date ? row.left_at : new Date(String(row.left_at));
}

export interface HistoryQuery {
  before?: ConvCursor;
  after?: ConvCursor;
  /** id сообщения, вокруг которого открыть (ответ, уведомление, поиск). */
  around?: string;
  /**
   * «Перейти к дате» (G25, `search1`): окно вокруг первого видимого мне сообщения не раньше этого момента (клиент шлёт
   * начало дня по своим часам); такого нет — последние.
   */
  date?: Date;
  limit: number;
  /** Бывший участник группы (`groups3`, `?former=1`): лента до его выхода; без флага — «нет такой», как раньше. */
  former?: boolean;
}

/**
 * Видимое мне в беседе — то же условие, что `convRules.messageView === 'full'`, плюс «История для новых» (аудит ЛС #236,
 * п.8): у добавленного в группу со скрытой историей лента начинается с `history_from_key` его строки участника.
 * Подзапрос не зависит от строки сообщения — база считает его один раз на запрос.
 */
function visibleTo(me: string, conversationId: string): SQL {
  return and(
    eq(conversationMessages.conversationId, conversationId),
    isNull(conversationMessages.deletedAt),
    sql`NOT (${me} = ANY(${conversationMessages.hiddenFor}))`,
    or(eq(conversationMessages.withheld, false), eq(conversationMessages.authorId, me)),
    sql`${conversationMessages.sortKey} >= COALESCE((SELECT hm.history_from_key FROM conversation_members hm
      WHERE hm.conversation_id = ${conversationId} AND hm.user_id = ${me}), 0)`,
  )!;
}

/** С какого ключа смотрящему видны беседы (аудит ЛС #236, п.8): только беседы, где граница есть. */
async function historyFloors(viewerId: string, conversationIds: readonly string[], q: Q): Promise<Map<string, number>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await q
    .select({ id: conversationMembers.conversationId, key: conversationMembers.historyFromKey })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.userId, viewerId), inArray(conversationMembers.conversationId, [...conversationIds])));
  return new Map(rows.filter((r) => r.key !== null).map((r) => [r.id, Number(r.key)]));
}

/**
 * `GET /api/conv/:id/messages` — страница истории (старые сверху). `null` — меня в беседе нет; `'no-anchor'` —
 * сообщения для `around` в этой беседе нет.
 */
export async function history(me: string, conversationId: string, qy: HistoryQuery): Promise<ConvHistoryResponse | null | 'no-anchor'> {
  return db.transaction(async (tx) => {
    // Бывший участник группы (`groups3`) читает историю до своего выхода; новое после — не его.
    const leftAt = qy.former && !(await loadAccess(conversationId, me, tx)) ? await formerLeftAt(conversationId, me, tx) : null;
    if (leftAt === null && !(await loadAccess(conversationId, me, tx))) return null;
    const { pts } = await ptsOf(tx, me);
    const base = visibleTo(me, conversationId);
    const vis = leftAt ? (and(base, lte(conversationMessages.createdAt, leftAt)) as SQL) : base;
    const key = conversationMessages.sortKey;
    let page: MsgRow[];
    let anchorKey: number | null = null;
    if (qy.around) {
      // Аудит ЛС #236, п.14: якорь — только видимое мне (`vis`), иначе по ответу узнавался бы ключ порядка спрятанного,
      // придержанного, до добавления или после выхода.
      const [anchor] = await tx
        .select({ sortKey: key })
        .from(conversationMessages)
        .where(and(eq(conversationMessages.id, qy.around), vis));
      if (!anchor) return 'no-anchor';
      anchorKey = anchor.sortKey;
    } else if (qy.date) {
      const [first] = await tx
        .select({ sortKey: key })
        .from(conversationMessages)
        .where(and(vis, gte(conversationMessages.createdAt, qy.date)))
        .orderBy(asc(key))
        .limit(1);
      anchorKey = first?.sortKey ?? null;
    }
    if (anchorKey !== null) {
      const olderN = Math.floor(qy.limit / 2);
      const older = await tx.select().from(conversationMessages).where(and(vis, lt(key, anchorKey))).orderBy(desc(key)).limit(olderN);
      const newer = await tx
        .select()
        .from(conversationMessages)
        .where(and(vis, gte(key, anchorKey)))
        .orderBy(asc(key))
        .limit(qy.limit - older.length);
      page = [...older.reverse(), ...newer];
    } else if (qy.after) {
      page = await tx.select().from(conversationMessages).where(and(vis, gt(key, qy.after.sortKey))).orderBy(asc(key)).limit(qy.limit);
    } else {
      const where = qy.before ? and(vis, lt(key, qy.before.sortKey)) : vis;
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

/**
 * `GET /api/conv/:id/search` (G05, признак `search1`) — сообщения беседы с подстрокой `pattern` (`convRules.searchPattern`)
 * в тексте, новые первыми, порцией до `limit`; `before` — курсор продолжения. Только видимое мне (`visibleTo`: надгробия,
 * спрятанное «у меня» и очищенное, чужое придержанное — мимо). `total` — из того же снимка. `null` — меня в беседе нет.
 * ILIKE по подстроке ускоряет триграммный индекс (миграция 0095), без него — тот же ответ, медленнее.
 */
export async function searchConversation(
  me: string,
  conversationId: string,
  pattern: string,
  before: ConvCursor | undefined,
  limit: number,
): Promise<ConvSearchResponse | null> {
  return db.transaction(async (tx) => {
    if (!(await loadAccess(conversationId, me, tx))) return null;
    const match = and(visibleTo(me, conversationId), sql`${conversationMessages.content} ILIKE ${pattern}`)!;
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(conversationMessages).where(match);
    const key = conversationMessages.sortKey;
    const rows = await tx
      .select({
        id: conversationMessages.id,
        sortKey: key,
        createdAt: conversationMessages.createdAt,
        authorId: conversationMessages.authorId,
      })
      .from(conversationMessages)
      .where(before ? and(match, lt(key, before.sortKey)) : match)
      .orderBy(desc(key))
      .limit(limit + 1);
    const more = rows.length > limit;
    const hits = rows.slice(0, limit).map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    const last = hits[hits.length - 1];
    return { total: Number(n), hits, next: more && last ? encodeCursor({ sortKey: last.sortKey, id: last.id }) : null };
  }, SNAPSHOT);
}

/**
 * Вид общих медиа (G29, `media1`) условием по строке сообщения — ТЕМИ ЖЕ выражениями, что частичные индексы миграции 0108
 * (планировщик берёт индекс, только когда условие запроса совпадает с условием индекса). Служебные строки — мимо.
 */
function sharedMediaCond(kind: SharedMediaKind): SQL {
  const a = conversationMessages.attachments;
  switch (kind) {
    case 'media':
      // Одноразовое (`once`: кружок `circles1`) в «Медиа» не попадает — кадр плитки и просмотрщик показали бы его, не «потратив»
      // (ревью 08.10; Telegram: самоуничтожающееся медиа в общих медиа и поиске по виду не показывается). Индекс 0108 — тот же.
      return sql`gv_media_count(${a}, 'media') > 0 AND NOT (${a} @> '[{"once": true}]'::jsonb)`;
    case 'file':
      return sql`gv_media_count(${a}, 'file') > 0`;
    case 'gif':
      return sql`gv_media_count(${a}, 'gif') > 0`;
    case 'voice':
      // С 0125 (решение владельца 19) сюда идут и кружки, как Telegram `RoundVoice`. Одноразовый кружок — мимо, как раньше мимо
      // «Медиа» (ревью №4); одноразовое голосовое — как было, видно.
      return sql`gv_media_count(${a}, 'voice') > 0 AND NOT (${a} @> '[{"once": true, "round": true}]'::jsonb)`;
    case 'link':
      return sql`gv_has_link(${conversationMessages.content})`;
  }
}

/**
 * То же условие вида для запросов с псевдонимом таблицы (поиск из списка читает `conversation_messages x`): `gv_media_count` /
 * `gv_has_link` те же, что у частичных индексов 0108, — менять вместе с `sharedMediaCond`.
 */
function sharedMediaCondAlias(kind: SharedMediaKind, t: SQL): SQL {
  if (kind === 'link') return sql`gv_has_link(${t}.content)`;
  // Одноразовое — мимо «Медиа», как в `sharedMediaCond`.
  if (kind === 'media') return sql`gv_media_count(${t}.attachments, 'media') > 0 AND NOT (${t}.attachments @> '[{"once": true}]'::jsonb)`;
  // Одноразовый кружок — мимо «Голосовых», как в `sharedMediaCond`.
  if (kind === 'voice') return sql`gv_media_count(${t}.attachments, 'voice') > 0 AND NOT (${t}.attachments @> '[{"once": true, "round": true}]'::jsonb)`;
  return sql`gv_media_count(${t}.attachments, ${kind}) > 0`;
}

/**
 * Что видно мне для общих медиа: то же, что лента (`history`) — не удалено, не спрятано «у меня» и не очищено, чужое
 * придержанное мимо; бывшему участнику группы (`groups3`, `former`) — только до выхода. `null` — беседы мне не видно.
 */
async function sharedMediaScope(tx: Q, me: string, conversationId: string, former: boolean): Promise<SQL | null> {
  const member = await loadAccess(conversationId, me, tx);
  const leftAt = !member && former ? await formerLeftAt(conversationId, me, tx) : null;
  if (!member && !leftAt) return null;
  const base = and(visibleTo(me, conversationId), isNull(conversationMessages.service))!;
  return leftAt ? (and(base, lte(conversationMessages.createdAt, leftAt)) as SQL) : base;
}

/**
 * `GET /api/conv/:id/media?kind=…` (G29, признак `media1`; Telegram `messages.search` с фильтром вида) — сообщения беседы
 * с вложениями этого вида (или со ссылками), новые первыми, порцией до `limit`; `before` — курсор продолжения.
 */
export async function sharedMedia(
  me: string,
  conversationId: string,
  kind: SharedMediaKind,
  before: ConvCursor | undefined,
  limit: number,
  former: boolean,
): Promise<SharedMediaResponse | null> {
  return db.transaction(async (tx) => {
    const scope = await sharedMediaScope(tx, me, conversationId, former);
    if (!scope) return null;
    const key = conversationMessages.sortKey;
    const match = and(scope, sharedMediaCond(kind))!;
    const rows = await tx
      .select()
      .from(conversationMessages)
      .where(before ? and(match, lt(key, before.sortKey)) : match)
      .orderBy(desc(key))
      .limit(limit + 1);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const views = await messagesForViewer(page, me, tx);
    const messages = page.map((m) => views.get(m.id)).filter((v): v is ConvMessage => !!v && !('gone' in v));
    const last = page[page.length - 1];
    return { messages, next: more && last ? encodeCursor({ sortKey: last.sortKey, id: last.id }) : null };
  }, SNAPSHOT);
}

/** `GET /api/conv/:id/media/counts` (G29, `media1`): сколько вложений каждого вида; у ссылок — сообщений со ссылками. */
export async function sharedMediaCounts(me: string, conversationId: string, former: boolean): Promise<SharedMediaCounts | null> {
  return db.transaction(async (tx) => {
    const scope = await sharedMediaScope(tx, me, conversationId, former);
    if (!scope) return null;
    const a = conversationMessages.attachments;
    // Ревью 08.10: по запросу на вид, с условием частичного индекса (0108, `sharedMediaCond`) — читаются только сообщения
    // с этим видом. Один проход по ВСЕЙ беседе считал функцию вида на каждой строке: 150 тыс. сообщений — 0,87 с на трёх
    // процессах базы против 0,26 с так.
    const out: SharedMediaCounts = { media: 0, file: 0, link: 0, gif: 0, voice: 0 };
    for (const kind of ['media', 'file', 'gif', 'voice', 'link'] as const) {
      const n =
        kind === 'media'
          ? sql<number>`coalesce(sum(gv_media_count(${a}, 'media')), 0)::int`
          : kind === 'file'
            ? sql<number>`coalesce(sum(gv_media_count(${a}, 'file')), 0)::int`
            : kind === 'gif'
              ? sql<number>`coalesce(sum(gv_media_count(${a}, 'gif')), 0)::int`
              : kind === 'voice'
                ? sql<number>`coalesce(sum(gv_media_count(${a}, 'voice')), 0)::int`
                : sql<number>`count(*)::int`;
      const [r] = await tx.select({ n }).from(conversationMessages).where(and(scope, sharedMediaCond(kind)));
      out[kind] = Number(r?.n ?? 0);
    }
    return out;
  }, SNAPSHOT);
}

/** Какие из бесед — группы (`groups1`). */
async function groupIdsAmong(q: Q, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await q
    .select({ id: conversations.id })
    .from(conversations)
    // Группы и «Избранное» (`saved1`) — те, что видит только клиент с `groups1`.
    .where(
      and(
        inArray(conversations.id, [...ids]),
        or(
          eq(conversations.kind, 'group'),
          sql`EXISTS (SELECT 1 FROM conversation_members sv WHERE sv.conversation_id = ${conversations.id} AND ${conversations.directKey} = sv.user_id || ':' || sv.user_id)`,
        ),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** Параметры поиска из списка (`searchAllConversations`): все необязательные, но хоть один из `pattern` / `conversationId` / `since` обязателен. */
export interface SearchAllQuery {
  pattern: string | null;
  conversationId?: string;
  /** Начало периода (включительно) и его конец (исключая) — моменты по часам клиента (чип «дата»). */
  since?: Date;
  until?: Date;
  /** Чип «тип» (G35, `gsearch1`): только сообщения с вложением / ссылкой этого вида — правила вида те же, что у «Общих медиа». */
  kind?: SharedMediaKind;
  before?: ConvCursor;
  limit: number;
  /**
   * Вкладки поиска на телефоне (12.10, #218; Telegram Android `FilteredSearchView`): `names` — вместе с видом текст ищется и в
   * именах вложений (файл «отчёт.pdf» по «отчёт»), `full` — у найденного целое сообщение (`ConvSearchAllHit.message`: вложения
   * со ссылками смотрящего — для сетки медиа и строк файлов / голосовых). Оба — только добавления к прежнему запросу.
   */
  names?: boolean;
  full?: boolean;
}

/** Окно «Частых»: старше моих сообщений не учитываем (вес за 90 дней при затухании в 28 суток — уже ~4 %). */
export const FREQUENT_WINDOW_DAYS = 90;
/** Затухание рейтинга, секунд: 28 суток — `rating_e_decay` по умолчанию у Telegram (Android `MessagesController.ratingDecay` = 2419200). */
export const FREQUENT_DECAY_S = 2419200;

/**
 * `GET /api/conv/frequent` (G35, признак `freq1`; Telegram top peers — `contacts.getTopPeers`, рейтинг растёт с каждым
 * отправленным сообщением и затухает со временем) — мои беседы по убыванию «частоты»: сумма `exp(-возраст / 28 суток)` по МОИМ
 * сообщениям за 90 дней. Только видимое мне: беседа не покинута и не убрана, не «ещё не показана»; удалённые, служебные и
 * удалённые мной «у себя» (`hidden_for`) строки мимо (окно 90 суток — индекс `conversation_messages_author_time_idx`, 0129). `lastAt` — моё последнее сообщение: по нему клиент возвращает убранную
 * из «Частых» беседу, когда я снова в неё написал (у Telegram `contacts.resetTopPeerRating` обнуляет рейтинг так же).
 * Архив, заблокированных и «Избранное» отсеивает клиент (у него эти метки уже есть). Убранные мной (`freq2`,
 * `frequent_hidden_at`, 09.10) не отдаются, пока моё последнее сообщение там не новее отметки — на всех моих устройствах.
 */
export async function frequentConversations(me: string, limit: number): Promise<ConvFrequentResponse> {
  const res = await db.execute(sql`
    SELECT x.conversation_id,
           SUM(EXP(-EXTRACT(EPOCH FROM (now() - x.created_at)) / ${FREQUENT_DECAY_S}::float8)) AS score,
           MAX(x.created_at) AS last_at
    FROM conversation_members m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN conversation_messages x ON x.conversation_id = c.id
    WHERE m.user_id = ${me}
      AND m.left_at IS NULL
      AND NOT ${clearedFromMe(me, sql`m.hidden_key`, sql`c.id`)}
      AND NOT ${hiddenFromMe(me, sql`m.pending`, sql`c.id`)}
      AND x.author_id = ${me}
      AND x.deleted_at IS NULL
      AND x.service IS NULL
      AND NOT (${me} = ANY(x.hidden_for))
      AND (m.hidden_key IS NULL OR x.sort_key > m.hidden_key)
      AND x.created_at >= now() - ${FREQUENT_WINDOW_DAYS}::int * interval '1 day'
    GROUP BY x.conversation_id, m.frequent_hidden_at
    HAVING m.frequent_hidden_at IS NULL OR MAX(x.created_at) > m.frequent_hidden_at
    ORDER BY score DESC, last_at DESC
    LIMIT ${limit}`);
  return {
    items: (res.rows as Record<string, unknown>[]).map((r) => ({
      conversationId: String(r.conversation_id),
      score: Math.round(Number(r.score) * 1000) / 1000,
      lastAt: iso(r.last_at),
    })),
  };
}

/** Сколько бесед за раз можно убрать из «Частых» (перенос убранных на устройстве — `FREQUENT_HIDDEN_MAX` клиента = 100). */
export const FREQUENT_HIDE_MAX = 100;

/**
 * «Убрать из частых» (09.10, `freq2`; Telegram `contacts.resetTopPeerRating`): отметка в МОЕЙ строке участника. `at` — момент
 * с устройства (разовый перенос убранных при `freq1`): не позже `now()` базы, нет — `now()`; прежняя более поздняя отметка
 * остаётся (`GREATEST`). Чужие, покинутые и неизвестные беседы молча пропускаются. Возвращает число отмеченных.
 */
export async function hideFrequentConversations(me: string, items: readonly { conversationId: string; at?: Date }[]): Promise<number> {
  const seen = new Map<string, Date | null>();
  // Повтор id: «сейчас» (`null`) сильнее отметки с устройства, из двух отметок — поздняя.
  for (const it of items) {
    const at = it.at ?? null;
    const cur = seen.get(it.conversationId);
    if (cur === undefined) seen.set(it.conversationId, at);
    else if (cur !== null) seen.set(it.conversationId, at === null || at > cur ? at : cur);
  }
  if (seen.size === 0) return 0;
  const values = sql.join(
    [...seen].map(([id, at]) => sql`(${id}, ${at ? at.toISOString() : null}::timestamptz)`),
    sql`, `,
  );
  const res = await db.execute(sql`
    UPDATE conversation_members m
    SET frequent_hidden_at = GREATEST(m.frequent_hidden_at, LEAST(COALESCE(v.at, now()), now()))
    FROM (VALUES ${values}) AS v(id, at)
    WHERE m.conversation_id = v.id AND m.user_id = ${me} AND m.left_at IS NULL
    RETURNING m.conversation_id`);
  return res.rows.length;
}

/**
 * `GET /api/conv/search` (G35, признак `gsearch1`; Telegram `Dialogs::Widget` — «Сообщения» под беседами, чипы человека и
 * даты `FiltersView`) — сообщения со всех МОИХ бесед: подстрока в тексте (`pattern`, как `searchConversation`), необязательно
 * одна беседа и период. Только видимое мне: беседа не покинута и не убрана, не «ещё не показана» (`hiddenFromMe`), сообщение
 * не удалено, не спрятано мной, не чужое придержанное, не старше моей очистки (`hidden_key`); служебные строки «закрепил»
 * мимо. Новые первыми по `sort_key` (микросекунды, общий порядок на все беседы), `before` — курсор следующей порции.
 */
export async function searchAllConversations(me: string, qy: SearchAllQuery): Promise<ConvSearchAllResponse> {
  const memberConds: SQL[] = [
    sql`m.user_id = ${me}`,
    sql`m.left_at IS NULL`,
    sql`NOT ${clearedFromMe(me, sql`m.hidden_key`, sql`c.id`)}`,
    sql`NOT ${hiddenFromMe(me, sql`m.pending`, sql`c.id`)}`,
  ];
  const msgConds: SQL[] = [
    sql`(m.hidden_key IS NULL OR x.sort_key > m.hidden_key)`,
    sql`x.deleted_at IS NULL`,
    sql`NOT (${me} = ANY(x.hidden_for))`,
    sql`(NOT x.withheld OR x.author_id = ${me})`,
    sql`x.service IS NULL`,
  ];
  if (qy.pattern && qy.names && qy.kind)
    msgConds.push(
      sql`(x.content ILIKE ${qy.pattern} OR EXISTS (SELECT 1 FROM jsonb_array_elements(x.attachments) AS a WHERE a->>'name' ILIKE ${qy.pattern}))`,
    );
  else if (qy.pattern) msgConds.push(sql`x.content ILIKE ${qy.pattern}`);
  if (qy.conversationId) memberConds.push(sql`c.id = ${qy.conversationId}`);
  if (qy.since) msgConds.push(sql`x.created_at >= ${qy.since.toISOString()}::timestamptz`);
  if (qy.until) msgConds.push(sql`x.created_at < ${qy.until.toISOString()}::timestamptz`);
  if (qy.kind) msgConds.push(sharedMediaCondAlias(qy.kind, sql`x`));
  if (qy.before) msgConds.push(sql`(x.sort_key, x.id) < (${qy.before.sortKey}::bigint, ${qy.before.id}::text)`);
  /*
   * Чип «тип» (ревью 08.10): общий проход по частичному индексу вида (0108) идёт по ВСЕМ таким сообщениям инстанса от новых
   * к старым и пробует участие в каждом — цена росла с чужими беседами (200 тыс. чужих голосовых: 8 → 253 мс). Поэтому
   * с чипом — от моих бесед: в каждой первые N по тому же индексу (`conversation_id, sort_key`), потом общий порядок. Оценка
   * такого плана — миллионы, и JIT съедал бы больше самого чтения (как у `listConversations`) — он выключен в транзакции.
   */
  const res = qy.kind
    ? await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL jit = off`);
        return tx.execute(sql`
          SELECT x.id, x.conversation_id, x.sort_key, x.created_at, x.author_id, x.content
          FROM conversation_members m
          JOIN conversations c ON c.id = m.conversation_id
          CROSS JOIN LATERAL (
            SELECT x.id, x.conversation_id, x.sort_key, x.created_at, x.author_id, left(x.content, 400) AS content
            FROM conversation_messages x
            WHERE x.conversation_id = c.id AND ${sql.join(msgConds, sql` AND `)}
            ORDER BY x.sort_key DESC, x.id DESC
            LIMIT ${qy.limit + 1}
          ) x
          WHERE ${sql.join(memberConds, sql` AND `)}
          ORDER BY x.sort_key DESC, x.id DESC
          LIMIT ${qy.limit + 1}`);
      })
    : await db.execute(sql`
    SELECT x.id, x.conversation_id, x.sort_key, x.created_at, x.author_id, left(x.content, 400) AS content
    FROM conversation_members m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN conversation_messages x ON x.conversation_id = c.id
    WHERE ${sql.join([...memberConds, ...msgConds], sql` AND `)}
    ORDER BY x.sort_key DESC, x.id DESC
    LIMIT ${qy.limit + 1}`);
  const rows = res.rows as Record<string, unknown>[];
  const hits = rows.slice(0, qy.limit).map((r) => ({
    id: String(r.id),
    conversationId: String(r.conversation_id),
    sortKey: toNum(r.sort_key),
    createdAt: iso(r.created_at),
    authorId: String(r.author_id),
    content: String(r.content ?? ''),
  }));
  const last = hits[hits.length - 1];
  const next = rows.length > qy.limit && last ? encodeCursor({ sortKey: last.sortKey, id: last.id }) : null;
  if (!qy.full || hits.length === 0) return { hits, next };
  // `full`: целые сообщения тем же видом, что лента (`messagesForViewer`: ссылки на закрытые вложения — свои у смотрящего).
  const page = await db.select().from(conversationMessages).where(inArray(conversationMessages.id, hits.map((h) => h.id)));
  const views = await messagesForViewer(page, me, db);
  return {
    hits: hits.map((h) => {
      const v = views.get(h.id);
      return v && !('gone' in v) ? { ...h, message: v } : h;
    }),
    next,
  };
}

/** `GET /api/conv/sync?pts=N` — изменения после N (текущее состояние сущностей) или `reset`. */
export async function syncSince(me: string, since: number, limit: number, groups = false): Promise<ConvSyncResponse> {
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
    // Группы (`groups1`) — только клиенту, который их просит: старому ни сводок, ни сообщений по ним.
    const groupIds = groups ? new Set<string>() : await groupIdsAmong(tx, [...new Set(plan.rows.map((r) => r.conversationId))]);
    const conversationIds = [...new Set(plan.rows.map((r) => r.conversationId))].filter((id) => !groupIds.has(id));
    const msgRows = messageIds.length
      ? (await tx.select().from(conversationMessages).where(inArray(conversationMessages.id, messageIds))).filter(
          (m) => !groupIds.has(m.conversationId),
        )
      : [];
    const views = await messagesForViewer(msgRows, me, tx);
    // С2: списки закреплённого — целиком и только по беседам, где мой список менялся в этой порции (строки `'pin'`).
    const pins: ConvPinsOf[] = [];
    for (const conversationId of new Set(plan.rows.filter((r) => r.kind === 'pin').map((r) => r.conversationId))) {
      pins.push({ conversationId, pins: await pinsFor(me, conversationId, tx) });
    }
    // С4: списки МОИХ отложенных — целиком и только по беседам, где они менялись в этой порции (строки `'sched'`).
    const scheduled: ConvScheduledOf[] = [];
    for (const conversationId of new Set(plan.rows.filter((r) => r.kind === 'sched').map((r) => r.conversationId))) {
      scheduled.push({ conversationId, items: await scheduledFor(me, conversationId, tx) });
    }
    return {
      reset: false,
      pts: plan.pts,
      more: plan.more,
      conversations: await summariesFor(me, conversationIds, tx, undefined, groups),
      messages: [...views.values()],
      // Поля нет — списки не менялись: ответ без закрепа прежней формы.
      ...(pins.length > 0 ? { pins } : {}),
      // Так же и отложенные: поля нет — мои отложенные в этой порции не менялись.
      ...(scheduled.length > 0 ? { scheduled } : {}),
    };
  }, SNAPSHOT);
}

/** `GET /api/conv/:id/pins` (С2) — мои закреплённые беседы и `pts` из одного снимка; `null` — меня в беседе нет. */
export async function listPins(me: string, conversationId: string): Promise<ConvPinsResponse | null> {
  return db.transaction(async (tx) => {
    if (!(await loadAccess(conversationId, me, tx))) return null;
    return pinsListOf(me, conversationId, tx);
  }, SNAPSHOT);
}

/** `GET /api/conv/:id/scheduled` (С4) — мои отложенные беседы и `pts` из одного снимка; `null` — меня в беседе нет. */
export async function listScheduled(me: string, conversationId: string): Promise<ConvScheduledResponse | null> {
  return db.transaction(async (tx) => {
    if (!(await loadAccess(conversationId, me, tx))) return null;
    return scheduledListOf(me, conversationId, tx);
  }, SNAPSHOT);
}

/** Одно сообщение глазами человека — ответ отправки и повтора. */
export async function messageFor(messageId: string, viewerId: string): Promise<ConvMessage | ConvGone | null> {
  const rows = await db.select().from(conversationMessages).where(eq(conversationMessages.id, messageId));
  return (await messagesForViewer(rows, viewerId, db)).get(messageId) ?? null;
}

/** Несколько сообщений глазами человека одним разом (ответ пересылки, старые события пачки): `id → вид`. */
export async function messagesFor(ids: readonly string[], viewerId: string): Promise<Map<string, ConvMessage | ConvGone>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(conversationMessages).where(inArray(conversationMessages.id, [...ids]));
  return messagesForViewer(rows, viewerId, db);
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
    .where(eq(conversations.directKey, await directKeyOf(db, one, two)))
    .limit(1);
  return row ?? null;
}

/**
 * ЛС между инстансами (Э0): то, что этому модулю нужно от федерации, подключает `index.ts` (`configureFederatedConv`), а не
 * импорт здесь — модуль компилируется проверками с явным перечнем зависимостей, и федерация (ключи, связки) ему не нужна.
 * `record` — запись журнала на связку той же транзакцией (`federation/convChanges.recordFedConvChanges`), есть только при
 * `FEDERATION_DM_ENABLED`; `selfInstanceId` — id нашего инстанса для глобального ключа пары.
 */
export interface FederatedConvHooks {
  selfInstanceId(): string | null;
  record: ((tx: Tx, items: FedConvChangeInput[]) => Promise<void>) | null;
  /** Э2 часть Б: из этих инстансов — те, связка с которыми не работает (`federation/convLink.brokenHomes`); нет — поля нет. */
  linkBroken?: ((homes: readonly string[], q: Q) => Promise<Set<string>>) | null;
  /** Э3 часть 1: из этих инстансов — те, что не умеют вложения (`federation/convAtt.homesWithoutFiles`); нет — поля нет. */
  noFiles?: ((homes: readonly string[], q: Q) => Promise<Set<string>>) | null;
  /** Э6: из этих инстансов — те, что не умеют звонки (`federation/dmCalls.homesWithoutCalls`); нет — поля нет. */
  noCalls?: ((homes: readonly string[], q: Q) => Promise<Set<string>>) | null;
  /** Исправления ревью 12.10, п. 7: из этих инстансов — те, что не забирают наши сообщения (`federation/convLink.staleHomes`). */
  linkStale?: ((homes: readonly string[], q: Q) => Promise<Set<string>>) | null;
  /** Э7 часть 3 (D): из этих домов групп — те, что молчат дольше 10 минут (`federation/convLink.silentHomes`): `fedGroupHost.down`. */
  groupHostSilent?: ((homes: readonly string[], q: Q) => Promise<Set<string>>) | null;
  /** Хвост Э7 (14.10): из этих инстансов — те, что не отвечают нашему забору дольше 10 минут (`federation/convLink.downHomes`): `fedPeerDown`. */
  peerDown?: ((homes: readonly string[]) => Set<string>) | null;
}

let fedHooks: FederatedConvHooks | null = null;

export function configureFederatedConv(hooks: FederatedConvHooks | null): void {
  fedHooks = hooks;
}

/**
 * Ключ пары 1:1 (`pairDirectKey`, shared): местная пара — прежний формат, пара с теневым (Э0) — глобальный из
 * `(instance_id, user_id)`; id своего инстанса спрашивается только при теневом участнике.
 */
/** `q` — тот же исполнитель, что у вызывающего: внутри транзакции запрос на `db` ждёт другое соединение (на одном соединении PGlite — вечно). */
/** Более позднее из двух моментов (ISO); негодное второе — первое. */
function laterIso(a: string, b: unknown): string {
  const t = b instanceof Date ? b.getTime() : typeof b === 'string' ? Date.parse(b) : NaN;
  return Number.isFinite(t) && t > Date.parse(a) ? new Date(t).toISOString() : a;
}

async function directKeyOf(q: Tx | typeof db, one: string, two: string): Promise<string> {
  const rows = await q
    .select({ id: users.id, homeInstanceId: users.homeInstanceId, homeUserId: users.homeUserId })
    .from(users)
    .where(inArray(users.id, one === two ? [one] : [one, two]));
  const side = (id: string) => rows.find((r) => r.id === id) ?? { id, homeInstanceId: null, homeUserId: null };
  const a = side(one);
  const b = side(two);
  const self = a.homeInstanceId !== null || b.homeInstanceId !== null ? (fedHooks?.selfInstanceId() ?? null) : null;
  return pairDirectKey(a, b, self);
}

/**
 * Создать беседу 1:1; `null` — параллельный запрос успел создать её раньше (ключ пары уникален).
 *
 * 🔴 Получателю беседа НЕ показывается до первого дошедшего до него сообщения (05.10, `hiddenFromMe`): его строка
 * участника — `pending`, а журнал и событие — только мне. До 05.10 журнал писался обоим, и получатель (даже заблокировавший
 * меня) сразу видел пустую строку с моим именем; с политикой `anyone` так мог бы делать кто угодно на инстансе. Первое
 * сообщение запишет журнал обоим обычным путём (`sendMessage`) — беседа появится у получателя вместе с ним.
 */
export async function createDirect(
  me: string,
  otherId: string,
  /**
   * ЛС между инстансами (Э1, `federation/convOpen.ts`): беседа с человеком соседа заводится с ОДНИМ id на обоих инстансах —
   * его выбирает дом инициатора; `originInstanceId` — инстанс инициатора. `me` — участник, чья строка видна сразу (на доме
   * получателя это теневой инициатор), `otherId` — тот, кому беседа покажется с первым сообщением.
   */
  fed?: { id: string; originInstanceId: string },
): Promise<{ row: { id: string }; delivery: Delivery } | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(conversations)
      .values({
        id: fed?.id ?? uuidv7(),
        kind: 'direct',
        directKey: await directKeyOf(tx, me, otherId),
        createdBy: me,
        ...(fed ? { originInstanceId: fed.originInstanceId } : {}),
      })
      .onConflictDoNothing({ target: conversations.directKey })
      .returning({ id: conversations.id });
    if (!row) return null;
    await tx.insert(conversationMembers).values([
      { conversationId: row.id, userId: me },
      { conversationId: row.id, userId: otherId, pending: true },
    ]);
    const pts = await journal(tx, [{ userId: me, conversationId: row.id, kind: 'conv', messageId: null }]);
    return { row, delivery: { conversationId: row.id, messageId: null, pts } };
  });
}

/**
 * «Избранное» (08.10, `saved1`): найти беседу с самим собой или завести. Один участник — я; беседа видна сразу (`pending`
 * не ставится), журнал пишется только мне. Идемпотентно: ключ «я:я» уникален, гонка двух устройств даёт одну беседу
 * (`delivery: null` у проигравшего). Проверки «можно ли» (гость, инстанс) — у вызывающего.
 */
export async function ensureSaved(me: string): Promise<{ id: string; delivery: Delivery | null }> {
  const key = savedKey(me);
  const found = async (): Promise<string | null> => {
    const [row] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.directKey, key)).limit(1);
    return row?.id ?? null;
  };
  const existing = await found();
  if (existing) return { id: existing, delivery: null };
  const made = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(conversations)
      .values({ id: uuidv7(), kind: 'direct', directKey: key, createdBy: me })
      .onConflictDoNothing({ target: conversations.directKey })
      .returning({ id: conversations.id });
    if (!row) return null;
    await tx.insert(conversationMembers).values({ conversationId: row.id, userId: me });
    const pts = await journal(tx, [{ userId: me, conversationId: row.id, kind: 'conv', messageId: null }]);
    return { id: row.id, delivery: { conversationId: row.id, messageId: null, pts } as Delivery };
  });
  return made ?? { id: (await found()) ?? '', delivery: null };
}

/**
 * Получатель сам открыл беседу, которую завёл другой и которая ему ещё не показана (05.10): «Написать» тому же человеку
 * находит её (`findDirect`), а не создаёт новую. Снять `pending` и записать МНЕ строку журнала — беседа появится в моём
 * списке и на других моих устройствах (`deliver`). `null` — показывать нечего: беседа мне уже видна или меня в ней нет.
 * Замки — в общем порядке писателей: строка беседы, затем журнал.
 */
export async function revealDirect(me: string, conversationId: string): Promise<Delivery | null> {
  return db.transaction(async (tx) => {
    if (!(await lockConversation(tx, conversationId))) return null;
    const [row] = await tx
      .update(conversationMembers)
      .set({ pending: false, hiddenKey: null })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, me),
          or(
            hiddenFromMe(me, sql`${conversationMembers.pending}`, sql`${conversationMembers.conversationId}`),
            // Убранная мной («Удалить чат», `conv12`) — «Написать» тому же человеку возвращает её сразу, пустой.
            clearedFromMe(me, sql`${conversationMembers.hiddenKey}`, sql`${conversationMembers.conversationId}`),
          ),
        ),
      )
      .returning({ id: conversationMembers.conversationId });
    if (!row) return null;
    const pts = await journal(tx, [{ userId: me, conversationId, kind: 'conv', messageId: null }]);
    return { conversationId, messageId: null, pts };
  });
}

/**
 * Ссылка на загруженное вложение при отправке (шаг 1в): id + то, что знает только клиент. Имя, тип и размер берутся из
 * строки `attachments`, а не со слов клиента; размеры картинки — подсказка раскладки (клиент меряет с учётом поворота
 * EXIF, сервер без декодирования так не может); огибающая и длительность — у голосовых, их клиент считает при записи.
 * С 06.10 размер и длительность — и у видео (клиент меряет по метаданным файла перед отправкой, `imageSize.measureVideoFile`).
 */
export interface AttachmentRef {
  id: string;
  width?: number | null;
  height?: number | null;
  waveform?: number[] | null;
  durationMs?: number | null;
  /** «Отправить как файл» (`linkprev1`, окно отправки файлов): картинка и видео — карточкой файла. Нет — как было. */
  asFile?: boolean | null;
  /** GIF (`gifs1`, Р-7): видео без звука по кругу. Нет — обычное видео. */
  gif?: boolean | null;
  /** Спойлер (`media2`, G48): фото и видео размыты до нажатия получателя. Нет — как было. */
  spoiler?: boolean | null;
  /** «Прослушать один раз» (`voice3`, G54): голосовое и (`circles1`) кружок; беседу 1:1 проверяет `sendMessage`. */
  once?: boolean | null;
  /** Кружок (`circles1`, G68): только квадратное видео до `ROUND_MAX_MS` с известными размером и длительностью. */
  round?: boolean | null;
  /** Таймер одноразового фото/видео, с (`ttlmedia1`, #226): только вместе с `once`, 1…`ONCE_TTL_MAX`. */
  onceTtl?: number | null;
}

type AttachmentRow = typeof attachments.$inferSelect;

/**
 * Вложение в строке сообщения — только из доверенных полей. Настоящая ссылка своя у каждого смотрящего и собирается
 * при чтении (`viewerAttachments`); в строке — ЗАГЛУШКА без смотрящего и подписи (не ключ, отдаёт 404).
 * 🔴 Заглушка нужна для отката (ревью 30.09): бэкенд до 1в отдаёт jsonb как есть, и вложение без `url` роняло бы
 * клиент 0.8.x (`attachmentDownloadUrl` → `a.url.match`) при открытии такой беседы.
 * Тот же вид лежит и в отложенном с вложениями (`conv10`, `scheduled.createScheduled`) — до его отправки.
 */
export function storedAttachment(row: AttachmentRow, ref: AttachmentRef): Attachment {
  const a: Attachment & { id: string } = {
    id: row.id,
    url: `${env.publicApiUrl}/api/att/${row.id}`,
    name: row.name,
    contentType: row.contentType,
    size: row.size,
  };
  const video = row.contentType.startsWith('video/');
  // Размер — у картинок и (06.10) у видео: новый клиент рисует видео кадром и держит под него место, как под фото.
  if (row.contentType.startsWith('image/') || video) {
    if (ref.width) a.width = ref.width;
    if (ref.height) a.height = ref.height;
  }
  if (row.contentType.startsWith('audio/')) {
    if (ref.waveform) a.waveform = ref.waveform;
    if (ref.durationMs) a.durationMs = ref.durationMs;
  }
  // Длительность видео (06.10) — подпись на кадре, «Видео · 0:42» в цитате, строке списка и пуше; огибающей у видео нет.
  // Только добавление полей: клиент до этой правки их не читает и рисует видео карточкой файла, как раньше.
  if (video && ref.durationMs) a.durationMs = ref.durationMs;
  // «Как файл» (`linkprev1`) — только у картинки и видео (у остальных всё и так карточка файла); у прочих DTO прежний.
  if (ref.asFile === true && (video || row.contentType.startsWith('image/'))) a.asFile = true;
  // GIF (`gifs1`) — только у видео и `image/gif`; у прочих DTO прежний.
  if (ref.gif === true && (video || row.contentType === 'image/gif')) a.gif = true;
  // Спойлер (`media2`) — только у фото и видео, показанных кадром (не «как файл»); у прочих DTO прежний.
  if (ref.spoiler === true && ref.asFile !== true && (video || row.contentType.startsWith('image/'))) a.spoiler = true;
  // «Один раз» (`voice3`) — только у голосового (аудио с огибающей); у прочих DTO прежний.
  // Кружок (`circles1`) — только видео, квадратное, с длительностью до минуты (Telegram: 1:1, `kMaxDuration`); иначе
  // пометка молча снимается — придёт обычное видео. С запасом в секунду: длительность клиент считает по часам.
  if (
    ref.round === true &&
    video &&
    !a.asFile &&
    !a.gif &&
    !!a.width &&
    a.width === a.height &&
    !!a.durationMs &&
    a.durationMs <= ROUND_MAX_MS + 1000
  )
    a.round = true;
  // «Один раз» (`voice3`) — только у голосового (аудио с огибающей) и кружка; у прочих DTO прежний.
  if (ref.once === true && ((row.contentType.startsWith('audio/') && a.waveform && a.waveform.length > 0) || a.round)) a.once = true;
  // Одноразовое фото/видео (`ttlmedia1`, #226; tdesktop `send_files_box.cpp` `canSetTtl`: только фото и видео кадром) — не
  // «как файл», не GIF, не кружок; таймер — только вместе с `once`, 1…60 с. Пускает ли беседа — решает `sendMessage`.
  if (ref.once === true && !a.once && isOnceMedia({ once: true, contentType: row.contentType, asFile: a.asFile, gif: a.gif, round: a.round })) {
    a.once = true;
    if (ref.onceTtl && Number.isInteger(ref.onceTtl) && ref.onceTtl >= 1 && ref.onceTtl <= ONCE_TTL_MAX) a.onceTtl = ref.onceTtl;
  }
  return a;
}

export interface SendInput {
  /** id отправки от клиента; `null` — старый клиент (шаг 1б), без защиты от повтора. */
  clientId: string | null;
  content: string;
  attachments: AttachmentRef[];
  replyToId: string | null;
  /**
   * Цитата фрагмента (`quote1`, G55): кусок текста цитируемого (подстрока, ≤ 1024 знаков) — иначе `bad-quote`. Ответ на
   * сообщение ДРУГОЙ беседы (`replyToId` чужой беседы, где я состою) — «Ответить в другом чате»; без цитаты сохраняется
   * снимок начала текста (`ReplyQuoteMark.auto`). Нет поля — обычный ответ.
   */
  replyQuote?: { text: string; offset?: number } | null;
  /** Получатель заблокировал автора (`blockRules.dmDeliveryPlan`): сохранить, но не показывать ему. */
  withheld: boolean;
  /**
   * «Без звука» (С3, `conv8`): флаг ложится в строку и едет в DTO. В отпечаток повтора (`payloadHash`) НЕ входит — почему,
   * там же: повтор с тем же id и другим флагом — 200 и сообщение как есть (с его настоящим `silent`), не 409.
   * Нет поля — обычное сообщение.
   */
  silent?: boolean;
  /** «Без превью ссылки» (G19, `linkprev1`, миграция 0101): флаг ложится в строку и едет в DTO; в отпечаток повтора не входит. */
  noPreview?: boolean;
  /** «Подпись над медиа» (G48, `media2`, миграция 0112): ложится в строку только при подписи и вложении; в отпечаток повтора не входит. */
  captionAbove?: boolean;
  /**
   * Уходит отложенное с вложениями (06.10, `conv10`, `scheduled.sendRowTx`): его файлы — не незавершённые загрузки, а
   * «припаркованные» за ним (`state = 'scheduled'`, `scheduled_id` = этот id). Привязка к сообщению та же (`attached`,
   * ссылка на отложенное снимается). Без поля — только `pending`, как всегда.
   */
  scheduledId?: string;
  /** Стикер каталога (0092, `stickers2`) — уже КОПИЕЙ (`stickerCatalog.catalogSticker`); нет поля — сообщение без стикера. */
  sticker?: MessageSticker | null;
  /** Служебная строка (0097, `pins2`, G28): «X закрепил(а) сообщение». Только из `pinMessage`; нет поля — обычное сообщение. */
  service?: ConvServiceMark | null;
  /** Вид сообщения (0145, `geocontact1`, G69): геопозиция или снимок контакта — уже проверенный (`routes/conv.ts`). */
  media?: ConvMediaMark | null;
  /**
   * Э5 часть 1 (#141, `federation/convVia.ts`): сообщение «через». У инстанса собеседника — автор человек соседа (теневая
   * строка) по долгой сессии: `{ instanceId: дом автора, state: 'pending' }`. У дома автора после сверки — `{ instanceId:
   * инстанс, через который прошло, state: 'confirmed' }` вместе с `id` и `createdAt` копии соседа (та же `id` у обоих — иначе
   * у собеседника было бы два сообщения). Нет поля — обычное сообщение с новым id.
   */
  via?: { instanceId: string; state: 'pending' | 'confirmed' };
  /** Э5: id сообщения задан (принятое домом «через»-сообщение); только вместе с `via`. */
  id?: string;
  /** Э5: момент отправки на самом деле (копия соседа); только вместе с `via`. */
  createdAt?: Date;
  /** Карточки бота (#229, миграция 0154) — уже проверенные `normalizeEmbeds`; `embedsFallback` — `content` собран из них. */
  embeds?: MessageEmbed[] | null;
  embedsFallback?: boolean;
  /** Кнопки под сообщением бота (#230, миграция 0155) — уже проверенные `botWire`. Пересылка/копии их не передают. */
  keyboard?: InlineKeyboard | null;
}

export type SendResult =
  | { kind: 'created'; row: MsgRow; delivery: Delivery }
  | { kind: 'replay'; row: MsgRow }
  | { kind: 'conflict' }
  | { kind: 'bad-reply' }
  | { kind: 'bad-quote' }
  | { kind: 'bad-attachments' }
  /** Одноразовое фото/видео (`ttlmedia1`) не в личке 1:1 с человеком или не отдельным сообщением (альбом). */
  | { kind: 'once-refused' }
  | { kind: 'not-found' };

/**
 * Отправить. `outer` (С4) — транзакция вызывающего: планировщик отложенных отправляет и удаляет строку отложенного
 * ОДНОЙ транзакцией (уйдёт либо всё, либо ничего — ни дубля, ни потери). Беседу вызывающий мог уже запереть — повторный
 * `FOR UPDATE` своей же транзакции не ждёт. Без `outer` — своя транзакция, как всегда.
 */
export async function sendMessage(me: string, access: ConvAccess, input: SendInput, outer?: Tx): Promise<SendResult> {
  const conversationId = access.conversationId;
  const hash = payloadHash({
    conversationId,
    content: input.content,
    attachmentRefs: input.attachments.map((a) => a.id),
    replyToId: input.replyToId,
    stickerId: input.sticker?.id ?? null,
    replyQuote: input.replyQuote ?? null,
  });
  const byClientId = (tx: Tx) =>
    tx
      .select()
      .from(conversationMessages)
      .where(and(eq(conversationMessages.authorId, me), eq(conversationMessages.clientId, input.clientId!)))
      .limit(1);
  const decide = (existing: MsgRow): SendResult =>
    idempotencyDecision(existing.payloadHash, hash) === 'replay' ? { kind: 'replay', row: existing } : { kind: 'conflict' };

  const run = async (tx: Tx): Promise<SendResult> => {
    const lock = await lockConversation(tx, conversationId);
    if (!lock) return { kind: 'not-found' };
    if (input.clientId) {
      const [existing] = await byClientId(tx);
      if (existing) return decide(existing);
    }
    let replyQuote: ReplyQuoteMark | null = null;
    if (input.replyToId) {
      const [parent] = await tx.select().from(conversationMessages).where(eq(conversationMessages.id, input.replyToId)).limit(1);
      if (!parent || messageView(parent, me) !== 'full' || parent.service) return { kind: 'bad-reply' };
      // «Ответить в другом чате» (`quote1`): цитируемое — из беседы, где я сейчас состою; иначе как прежде — только эта беседа.
      const foreign = parent.conversationId !== conversationId;
      if (foreign && !(await loadAccess(parent.conversationId, me, tx))) return { kind: 'bad-reply' };
      if (input.replyQuote) {
        replyQuote = resolveReplyQuote(parent.content, input.replyQuote);
        if (!replyQuote) return { kind: 'bad-quote' };
      } else if (foreign) replyQuote = replyQuoteSnapshot(parent.content);
    } else if (input.replyQuote) return { kind: 'bad-quote' };
    /*
     * 🔴 Вложения — ПОСЛЕ проверки повтора (повтор уже отправленного обязан получить 200, а его вложения уже не pending)
     * и под замком строк (`FOR UPDATE`): иначе две параллельные отправки прикрепили бы один файл к двум сообщениям, и
     * «удалить у обоих» одного стёрло бы файл у второго. Годится только МОЁ, НЕЗАВЕРШЁННОЕ, ЭТОЙ беседы — а у уходящего
     * отложенного (`scheduledId`, `conv10`) только его «припаркованные» файлы.
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
            input.scheduledId
              ? and(eq(attachments.state, 'scheduled'), eq(attachments.scheduledId, input.scheduledId))
              : eq(attachments.state, 'pending'),
          ),
        )
        .for('update');
      if (rows.length !== ids.length) return { kind: 'bad-attachments' };
      const byId = new Map(rows.map((r) => [r.id, r]));
      // «Один раз» (`voice3`, G54) — только в личке 1:1 с человеком: в группе и «Избранном» пометка молча снимается.
      const onceOk = lock.kind === 'direct' && !access.saved;
      // Одноразовое фото/видео (`ttlmedia1`, #226) — не молча: отправитель уверен, что оно сгорит. Только личка 1:1 и только
      // одним файлом (Telegram не собирает такие в альбом — tdesktop `send_files_box.cpp` `ttlSeconds` рвёт группу).
      const onceMedia = input.attachments.some((ref) => ref.once === true && isOnceMedia(storedAttachment(byId.get(ref.id)!, ref)));
      if (onceMedia && (!onceOk || input.attachments.length > 1)) return { kind: 'once-refused' };
      stored = input.attachments.map((ref) => storedAttachment(byId.get(ref.id)!, onceOk ? ref : { ...ref, once: null }));
    }
    const [row] = await tx
      .insert(conversationMessages)
      .values({
        id: (input.via && input.id) || uuidv7(),
        conversationId,
        authorId: me,
        clientId: input.clientId,
        payloadHash: input.clientId ? hash : null,
        ...(input.via ? { viaInstanceId: input.via.instanceId, viaState: input.via.state } : {}),
        ...(input.via && input.createdAt ? { createdAt: input.createdAt } : {}),
        sortKey: lock.nextKey,
        content: input.content,
        attachments: stored,
        replyToId: input.replyToId,
        replyQuote,
        withheld: input.withheld,
        silent: input.silent === true,
        noPreview: input.noPreview === true,
        captionAbove: input.captionAbove === true && input.content.trim() !== '' && stored.length > 0,
        sticker: input.sticker ?? null,
        service: input.service ?? null,
        media: input.media ?? null,
        ...(input.embeds?.length ? { embeds: input.embeds, embedsFallback: input.embedsFallback === true } : {}),
        ...(input.keyboard?.length ? { keyboard: input.keyboard } : {}),
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
      // Ссылка на отложенное снимается тут же (CHECK `scheduled` ⇔ `scheduled_id`): строку отложенного вызывающий удалит.
      await tx
        .update(attachments)
        .set({ state: 'attached', messageId: row.id, scheduledId: null })
        .where(inArray(attachments.id, ids));
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
    await unarchiveOnMessage(tx, conversationId, me, audience);
    const pts = await journal(tx, msgEntries(audience, conversationId, row.id));
    return { kind: 'created', row, delivery: { conversationId, messageId: row.id, pts, created: true } };
  };
  return outer ? run(outer) : db.transaction(run);
}

/** Сообщение этой беседы под замком строки (беседу вызывающий уже запер). */
async function messageForUpdate(tx: Tx, conversationId: string, messageId: string): Promise<MsgRow | null> {
  const [m] = await tx
    .select()
    .from(conversationMessages)
    .where(and(eq(conversationMessages.id, messageId), eq(conversationMessages.conversationId, conversationId)))
    .for('update')
    .limit(1);
  return m ?? null;
}

/** Запереть беседу и взять сообщение этой беседы под замок. */
export async function lockMessage(tx: Tx, conversationId: string, messageId: string): Promise<MsgRow | null> {
  if (!(await lockConversation(tx, conversationId))) return null;
  return messageForUpdate(tx, conversationId, messageId);
}

export type EditResult =
  /** `delivery: null` — текст не изменился: ничего не записано (`editedAt` на месте), рассылать нечего. */
  | { kind: 'ok'; row: MsgRow; delivery: Delivery | null }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'empty' };

/**
 * Правка сообщения. `opts.keyboard` — путь бота (#230, `editMessageText`): `undefined` — кнопки не трогать (путь человека
 * `PATCH /conv/:id/messages/:mid`), `null`/`[]` — снять, значение — заменить (как Telegram: правка текста без `reply_markup`
 * снимает клавиатуру — это решает `routes/botApi.ts`). Смена одних кнопок «(изм.)» не ставит и `edit_version` не двигает.
 */
export async function editMessage(
  me: string,
  access: ConvAccess,
  messageId: string,
  content: string,
  opts: { keyboard?: InlineKeyboard | null } = {},
): Promise<EditResult> {
  return db.transaction(async (tx): Promise<EditResult> => {
    const m = await lockMessage(tx, access.conversationId, messageId);
    if (!m || m.deletedAt) return { kind: 'not-found' };
    if (m.authorId !== me) return { kind: 'forbidden' };
    // Пересланное не правится (как у Telegram, `conv5`): иначе под «Переслано от» встал бы текст, которого автор оригинала
    // не писал.
    if (m.forwardedFrom) return { kind: 'forbidden' };
    // Стикер (`stickers2`) не правится — как у Telegram: подписи у стикера нет.
    if (m.sticker) return { kind: 'forbidden' };
    // Геопозиция и контакт (G69) не правятся — подписи у них нет, текст в `content` запасной (как у Telegram).
    if (m.media) return { kind: 'forbidden' };
    // Служебная строка «X закрепил(а) сообщение» (`pins2`) не правится — текст в ней запасной, настоящий строит клиент.
    if (m.service) return { kind: 'forbidden' };
    // Прослушанное одноразовое голосовое (`voice3`) — запасная фраза сервера, не текст автора: правке не подлежит.
    if (m.onceSpentAt) return { kind: 'forbidden' };
    // Пустой текст допустим только у сообщения с вложениями — «убрать подпись», как у отправки.
    if (!content && m.attachments.length === 0) return { kind: 'empty' };
    // Текст не изменился (06.10, сверка с Telegram): «правка» без изменений не ставит «изм.» и никого не будит — ни записи,
    // ни журнала, ни событий. Старый клиент слал такое всегда (сверки текста у него не было), ответ ему прежний — сообщение.
    const textChanged = content !== m.content;
    const keyboard = opts.keyboard === undefined ? undefined : opts.keyboard?.length ? opts.keyboard : null;
    const keyboardChanged = keyboard !== undefined && !sameKeyboard(m.keyboard, keyboard);
    if (!textChanged && !keyboardChanged) return { kind: 'ok', row: m, delivery: null };
    const [row] = await tx
      .update(conversationMessages)
      // `edit_version` (Э0 ЛС между инстансами): +1 на правку — при слиянии копий у соседа побеждает бо́льшая.
      .set({
        ...(textChanged ? { content, editedAt: new Date(), editVersion: sql`${conversationMessages.editVersion} + 1` } : {}),
        ...(keyboardChanged ? { keyboard } : {}),
      })
      .where(eq(conversationMessages.id, messageId))
      .returning();
    const audience = changeAudience({ action: 'edit', actorId: me, memberIds: access.memberIds, withheld: m.withheld, blockedActor: new Set() });
    // С2: у кого сообщение закреплено, у тех поменялось превью в списке закрепа — следом событие со списком.
    const holders = (await pinHolders(tx, [messageId])).filter((id) => audience.includes(id));
    const entries = [...msgEntries(audience, access.conversationId, messageId), ...pinEntries(holders, access.conversationId)];
    const nums = entryPts(entries, await journal(tx, entries));
    const [delivery] = withPinDeliveries(access.conversationId, [messageId], entries, nums);
    return { kind: 'ok', row, delivery: textChanged ? { ...delivery, edited: true } : delivery };
  });
}

/** Кнопки сообщения те же (сравнение в одном порядке полей: из jsonb ключи приходят отсортированными). */
function sameKeyboard(a: InlineKeyboard | null, b: InlineKeyboard | null): boolean {
  return JSON.stringify(a?.length ? keyboardView(a) : null) === JSON.stringify(b?.length ? keyboardView(b) : null);
}

/**
 * Только кнопки под сообщением (#230, `editMessageReplyMarkup` бота): своё живое сообщение; `null`/`[]` — снять. Не ставит
 * «(изм.)», не двигает `edit_version`; рассылка `conv.change` — та же, что у правки. Те же кнопки — ничего не пишем.
 */
export async function editMessageKeyboard(
  me: string,
  access: ConvAccess,
  messageId: string,
  keyboard: InlineKeyboard | null,
): Promise<EditResult> {
  return db.transaction(async (tx): Promise<EditResult> => {
    const m = await lockMessage(tx, access.conversationId, messageId);
    if (!m || m.deletedAt) return { kind: 'not-found' };
    if (m.authorId !== me) return { kind: 'forbidden' };
    const next = keyboard?.length ? keyboard : null;
    if (sameKeyboard(m.keyboard, next)) return { kind: 'ok', row: m, delivery: null };
    const [row] = await tx.update(conversationMessages).set({ keyboard: next }).where(eq(conversationMessages.id, messageId)).returning();
    const audience = changeAudience({ action: 'edit', actorId: me, memberIds: access.memberIds, withheld: m.withheld, blockedActor: new Set() });
    const entries = msgEntries(audience, access.conversationId, messageId);
    const nums = entryPts(entries, await journal(tx, entries));
    const [delivery] = withPinDeliveries(access.conversationId, [messageId], entries, nums);
    return { kind: 'ok', row, delivery };
  });
}

export type DeleteResult =
  | {
      kind: 'ok';
      delivery: Delivery | null;
      lastMessageAt: string | null;
      withheld: boolean;
      /** Сообщение было моим. Чужое (С1) меняет МОЁ непрочитанное — старым клиентам удалившего уходит и оно. */
      own: boolean;
    }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

/** Права удаления, которые даёт ручка (С1). */
export interface DeleteOptions {
  /**
   * Удалить ЧУЖОЕ «у обоих», где вид беседы это допускает (`convRules.othersDeletableForBoth` — только 1:1; признак
   * `conv6`). Дают ручки `/api/conv/*`, где `for` всегда явный; по умолчанию права на чужое нет.
   */
  othersForBoth?: boolean;
}

/**
 * Удалить (решение — `convRules.deleteDecision`): `both` — своё, а с правом на чужое (`othersForBoth`, С1: беседа 1:1) —
 * и чужое видимое; надгробие у всех (текст, вложения, реакции и снимок «Переслано от» стираются, строка остаётся,
 * Р5/Р19 — «без следа»), следы у чужого те же, что у своего. `me` — любое видимое мне, спрятать только у себя
 * (`hidden_for`; у собеседника сообщение живое, ничего не стирается), собеседник не узнаёт.
 * Повтор уже сделанного удаления — успех без изменений (ответ на первый запрос мог потеряться).
 */
export async function deleteMessage(
  me: string,
  access: ConvAccess,
  messageId: string,
  scope: 'me' | 'both',
  opts: DeleteOptions = {},
): Promise<DeleteResult> {
  let purge: string[] = [];
  const res = await deleteMessageTx(me, access, messageId, scope, opts, (keys) => (purge = keys));
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
  opts: DeleteOptions,
  onPurge: (keys: string[]) => void,
): Promise<DeleteResult> {
  const conversationId = access.conversationId;
  return db.transaction(async (tx): Promise<DeleteResult> => {
    const lock = await lockConversation(tx, conversationId);
    const m = lock ? await messageForUpdate(tx, conversationId, messageId) : null;
    if (!lock || !m) return { kind: 'not-found' };
    const own = m.authorId === me;
    const action = deleteDecision(m, me, scope, !!opts.othersForBoth && othersDeletableForBoth(lock.kind));
    if (action === 'not-found') return { kind: 'not-found' };
    if (action === 'forbidden') return { kind: 'forbidden' };
    if (action === 'repeat') return { kind: 'ok', delivery: null, lastMessageAt: null, withheld: m.withheld, own };
    if (action === 'hide') {
      await tx
        .update(conversationMessages)
        .set({ hiddenFor: sql`array_append(${conversationMessages.hiddenFor}, ${me})` })
        .where(eq(conversationMessages.id, messageId));
      // С2: спрятанное у себя снимает и МОЙ закреп на нём (у собеседника закреп остаётся — сообщение у него живое).
      const unpinned = await removePins(tx, [messageId], me);
      const entries = [...msgEntries([me], conversationId, messageId), ...pinEntries(unpinned, conversationId)];
      const nums = entryPts(entries, await journal(tx, entries));
      const [delivery] = withPinDeliveries(conversationId, [messageId], entries, nums);
      return { kind: 'ok', delivery, lastMessageAt: null, withheld: m.withheld, own };
    }
    await dmWriteBarrier.afterDeleteLock?.(); // точка для теста гонки с отправкой (`dmWriteBarrier.ts`)
    // Р19 «без следа»: и снимок «Переслано от» (`conv5`: имя автора оригинала) — надгробию он не нужен.
    await tx
      .update(conversationMessages)
      .set({ deletedAt: new Date(), content: '', attachments: [], forwardedFrom: null, sticker: null, service: null, media: null, keyboard: null })
      .where(eq(conversationMessages.id, messageId));
    await tx.delete(conversationMessageReactions).where(eq(conversationMessageReactions.messageId, messageId));
    // С2: удалённое у обоих снимает его закрепы у всех.
    const unpinned = (await removePins(tx, [messageId], null)).filter((id) => access.memberIds.includes(id));
    // Закрытые файлы сообщения — «удалено» в этой же транзакции (выдача сразу 404), сами файлы — после фиксации (Р19).
    const dead = await tx
      .update(attachments)
      .set({ state: 'deleted', deletedAt: new Date() })
      // Э3: и не скопированные ещё файлы копии соседа (`remote`) — иначе копия доехала бы в надгробие.
      .where(and(eq(attachments.messageId, messageId), inArray(attachments.state, ['attached', 'remote'])))
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
    // Чужое у обоих (С1) — та же аудитория, что у своего: оба участника, и при блокировке (удаление уже доставленного
    // доходит всегда); чужое придержанное сюда не попадает — для меня его нет (`deleteDecision`).
    const audience = changeAudience({
      action: 'delete-both',
      actorId: me,
      memberIds: access.memberIds,
      withheld: m.withheld,
      blockedActor: new Set(),
    });
    const entries = [...msgEntries(audience, conversationId, messageId), ...pinEntries(unpinned, conversationId)];
    const nums = entryPts(entries, await journal(tx, entries));
    const [delivery] = withPinDeliveries(conversationId, [messageId], entries, nums);
    return {
      kind: 'ok',
      delivery,
      lastMessageAt: conv?.at ? conv.at.toISOString() : null,
      withheld: m.withheld,
      own,
    };
  });
}

export type AlbumItemResult =
  | {
      kind: 'ok';
      /** `item` — убран один элемент (или повтор), `message` — элемент был последним видимым: сообщение удалено целиком. */
      removed: 'item' | 'message';
      delivery: Delivery | null;
      /** Только при `message`: то же, что у `deleteMessage` (время беседы, придержанное, своё). */
      whole?: Extract<DeleteResult, { kind: 'ok' }>;
    }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

/**
 * Удалить ОДИН элемент альбома (G56, признак `album1`; решение — `convRules.albumItemDecision`). `both` — только своё
 * сообщение: элемент уходит из списка вложений (правка без «изм.»: `edit_version` +1 — сосед по связке примет меньший
 * список, `convAccept`), строка файла — `deleted` в той же транзакции, сам файл — после фиксации в фоне (как у
 * `deleteMessage`). `me` — элемент спрятан только у меня (`hidden_attachments`), собеседник не узнаёт. Последний видимый
 * элемент — удаление сообщения целиком (`deleteMessage` с теми же правами). Повтор — успех без изменений.
 */
export async function deleteAlbumItem(
  me: string,
  access: ConvAccess,
  messageId: string,
  attachmentId: string,
  scope: 'me' | 'both',
  opts: DeleteOptions = {},
): Promise<AlbumItemResult> {
  const conversationId = access.conversationId;
  let purge: string[] = [];
  const res = await db.transaction(async (tx): Promise<AlbumItemResult | 'whole'> => {
    const m = await lockMessage(tx, conversationId, messageId);
    if (!m || messageView(m, me) !== 'full') return { kind: 'not-found' };
    const action = albumItemDecision({
      list: m.attachments,
      hidden: m.hiddenAttachments,
      viewerId: me,
      authorId: m.authorId,
      attachmentId,
      scope,
    });
    if (action === 'forbidden') return { kind: 'forbidden' };
    if (action === 'repeat') return { kind: 'ok', removed: 'item', delivery: null };
    if (action === 'whole') return 'whole';
    if (action === 'hide') {
      await tx
        .update(conversationMessages)
        .set({ hiddenAttachments: sql`array_append(${conversationMessages.hiddenAttachments}, ${hiddenAttachmentKey(me, attachmentId)})` })
        .where(eq(conversationMessages.id, messageId));
      const entries = msgEntries([me], conversationId, messageId);
      const pts = await journal(tx, entries);
      return { kind: 'ok', removed: 'item', delivery: { conversationId, messageId, pts } };
    }
    await tx
      .update(conversationMessages)
      .set({
        attachments: m.attachments.filter((a) => a.id !== attachmentId),
        editVersion: sql`${conversationMessages.editVersion} + 1`,
      })
      .where(eq(conversationMessages.id, messageId));
    const dead = await tx
      .update(attachments)
      .set({ state: 'deleted', deletedAt: new Date() })
      .where(
        and(
          eq(attachments.id, attachmentId),
          eq(attachments.messageId, messageId),
          inArray(attachments.state, ['attached', 'remote']),
        ),
      )
      .returning({ key: attachments.storageKey });
    purge = dead.map((d) => d.key);
    // Аудитория и закрепы — как у правки (`editMessage`): у кого закреплено, у тех меняется миниатюра в полосе.
    const audience = changeAudience({ action: 'edit', actorId: me, memberIds: access.memberIds, withheld: m.withheld, blockedActor: new Set() });
    const holders = (await pinHolders(tx, [messageId])).filter((id) => audience.includes(id));
    const entries = [...msgEntries(audience, conversationId, messageId), ...pinEntries(holders, conversationId)];
    const nums = entryPts(entries, await journal(tx, entries));
    const [delivery] = withPinDeliveries(conversationId, [messageId], entries, nums);
    return { kind: 'ok', removed: 'item', delivery };
  });
  if (purge.length > 0) void purgeDeleted(purge).catch(() => {});
  if (res !== 'whole') return res;
  const whole = await deleteMessage(me, access, messageId, scope, opts);
  if (whole.kind !== 'ok') return whole;
  return { kind: 'ok', removed: 'message', delivery: whole.delivery, whole };
}

export type ListenedResult = { kind: 'ok'; changed: boolean; delivery: Delivery | null } | { kind: 'not-found' };

/**
 * «Прослушал голосовое» (07.10, `voice1`): строка слушателя и событие `conv.change` с обновлённым сообщением — мне (другие
 * устройства гасят точку) и автору (видит «прослушано»). Свои голосовые, не-голосовые и чужие невидимые мне сообщения —
 * `not-found`; повтор — успех без строки журнала и событий. Заблокировавший меня автор события не получает (правило
 * реакций, `changeAudience`), но строка остаётся — мои другие устройства всё равно гасят точку.
 */
export async function listenVoice(
  me: string,
  access: ConvAccess,
  messageId: string,
  blockedActor: ReadonlySet<string>,
): Promise<ListenedResult> {
  const conversationId = access.conversationId;
  return db.transaction(async (tx): Promise<ListenedResult> => {
    const m = await lockMessage(tx, conversationId, messageId);
    if (!m || m.deletedAt || messageView(m, me) !== 'full' || m.authorId === me || !m.attachments.some(isListenable)) {
      return { kind: 'not-found' };
    }
    const inserted = await tx
      .insert(conversationVoiceListens)
      .values({ messageId, userId: me })
      .onConflictDoNothing()
      .returning({ id: conversationVoiceListens.messageId });
    if (inserted.length === 0) return { kind: 'ok', changed: false, delivery: null };
    const audience = changeAudience({ action: 'react', actorId: me, memberIds: access.memberIds, withheld: m.withheld, blockedActor });
    const pts = await journal(tx, msgEntries(audience, conversationId, messageId));
    // Э3 часть 3: владелец «прослушано» — дом слушателя; соседу-автору уходит итог наших слушателей этого сообщения.
    await fedRecord(tx, [{ conversationId, kind: FED_CONV_CHANGE_E2.listen, entityId: messageId }]);
    return { kind: 'ok', changed: true, delivery: { conversationId, messageId, pts } };
  });
}

/**
 * `ConvMessage.voiceListened` глазами смотрящего: получателю — есть ли его строка; автору — есть ли строка хоть у одного
 * другого участника (`listeners` — только видимые смотрящему, заблокированные отброшены выше).
 */
export function voiceListenedFor(viewerId: string, authorId: string, listeners: ReadonlySet<string>): boolean {
  if (viewerId === authorId) return [...listeners].some((id) => id !== authorId);
  return listeners.has(viewerId);
}

/**
 * Одноразовое голосовое дослушано или закрыто получателем (08.10, `voice3`, G54; Telegram: view-once голосовое после
 * прослушивания исчезает, у обоих — «Голосовое сообщение прослушано»). Файл — «удалён» в этой транзакции (выдача сразу 404),
 * сам объект хранилища — после фиксации (как `deleteMessage`); сообщение у обоих становится запасной фразой без вложений,
 * `once_spent_at` — признак `ConvMessage.voiceOnceSpent`; заодно строка «прослушано» (`voice1`). Только получатель; своё,
 * не одноразовое и невидимое — `not-found`; повтор — успех без событий. Событие — обоим, как у удаления «у обоих».
 */
export async function spendVoiceOnce(me: string, access: ConvAccess, messageId: string): Promise<ListenedResult> {
  const conversationId = access.conversationId;
  let purge: string[] = [];
  const res = await db.transaction(async (tx): Promise<ListenedResult> => {
    const m = await lockMessage(tx, conversationId, messageId);
    if (!m || m.deletedAt || messageView(m, me) !== 'full' || m.authorId === me) return { kind: 'not-found' };
    if (m.onceSpentAt) return { kind: 'ok', changed: false, delivery: null };
    if (!m.attachments.some(isOnceSpendable)) return { kind: 'not-found' };
    // Кружок (`circles1`) — своя запасная фраза: «Видеосообщение просмотрено»; фото/видео (`ttlmedia1`) — «Фото/Видео истекло».
    const spentText = onceSpentText(m.attachments);
    await tx
      .update(conversationMessages)
      .set({ onceSpentAt: new Date(), content: spentText, attachments: [] })
      .where(eq(conversationMessages.id, messageId));
    await tx.insert(conversationVoiceListens).values({ messageId, userId: me }).onConflictDoNothing();
    // Э3 часть 3: копия файла соседа может быть ещё не скопирована (`remote`) — уходит так же; место квоты связки у
    // скопированной вернёт триггер 0138 (переход из `attached`).
    const dead = await tx
      .update(attachments)
      .set({ state: 'deleted', deletedAt: new Date() })
      .where(and(eq(attachments.messageId, messageId), inArray(attachments.state, ['attached', 'remote'])))
      .returning({ key: attachments.storageKey });
    purge = dead.map((d) => d.key);
    const audience = changeAudience({
      action: 'delete-both',
      actorId: me,
      memberIds: access.memberIds,
      withheld: m.withheld,
      blockedActor: new Set(),
    });
    const pts = await journal(tx, msgEntries(audience, conversationId, messageId));
    // Э3 часть 3: автор — человек соседа: «прослушано» уходит его дому, тот гасит оригинал у себя (`convAccept.applyListens`).
    await fedRecord(tx, [{ conversationId, kind: FED_CONV_CHANGE_E2.listen, entityId: messageId }]);
    return { kind: 'ok', changed: true, delivery: { conversationId, messageId, pts } };
  });
  if (purge.length > 0) void purgeDeleted(purge).catch(() => {});
  return res;
}

/** Открытие одноразового фото/видео: `openedAt` — первое открытие (отсчёт таймера идёт от него), `spent` — уже сгорело. */
export type OnceOpenResult = { kind: 'ok'; openedAt: Date } | { kind: 'spent' } | { kind: 'not-found' };

/**
 * Получатель открыл одноразовое фото/видео (19.10, `ttlmedia1`, #226; Telegram: отсчёт таймера — с открытия). Отметка
 * `once_opened_at` ставится один раз; событий нет (отправитель в Telegram открытия не видит). Закрыл или вышел таймер — клиент
 * зовёт `once-spent`; не позвал (закрыл приложение) — сожжёт сторож `sweepOpenedOnce`. Только получатель; своё, не такое и
 * невидимое — `not-found`.
 */
export async function openOnceMedia(me: string, access: ConvAccess, messageId: string): Promise<OnceOpenResult> {
  return db.transaction(async (tx): Promise<OnceOpenResult> => {
    const m = await lockMessage(tx, access.conversationId, messageId);
    if (!m || m.deletedAt || messageView(m, me) !== 'full' || m.authorId === me) return { kind: 'not-found' };
    if (m.onceSpentAt) return { kind: 'spent' };
    if (!m.attachments.some(isOnceMedia)) return { kind: 'not-found' };
    if (m.onceOpenedAt) return { kind: 'ok', openedAt: m.onceOpenedAt };
    const openedAt = new Date();
    await tx.update(conversationMessages).set({ onceOpenedAt: openedAt }).where(eq(conversationMessages.id, messageId));
    return { kind: 'ok', openedAt };
  });
}

/**
 * Сколько открытое одноразовое фото/видео живёт без сообщения о закрытии, мс: таймер (или длина видео, если она больше) и
 * запас на сеть; «просмотр один раз» без таймера — длина видео и 5 минут (закрытия ждём от клиента).
 */
export function onceOpenLimitMs(a: { onceTtl?: number; durationMs?: number | null; contentType: string }): number {
  const video = a.contentType.startsWith('video/') ? (a.durationMs ?? 0) : 0;
  return a.onceTtl ? Math.max(a.onceTtl * 1000, video) + 15_000 : video + 5 * 60_000;
}

/**
 * Сторож одноразовых фото/видео (`ttlmedia1`): открытое, у которого вышел срок `onceOpenLimitMs`, сгорает от имени
 * получателя — как его `once-spent` (файл удаляется, событие обоим, соседу-автору — `listen` со `spent`).
 */
export async function sweepOpenedOnce(now = Date.now()): Promise<number> {
  const rows = await db
    .select({
      id: conversationMessages.id,
      conversationId: conversationMessages.conversationId,
      authorId: conversationMessages.authorId,
      attachments: conversationMessages.attachments,
      openedAt: conversationMessages.onceOpenedAt,
    })
    .from(conversationMessages)
    .where(
      and(
        isNotNull(conversationMessages.onceOpenedAt),
        isNull(conversationMessages.onceSpentAt),
        isNull(conversationMessages.deletedAt),
        lt(conversationMessages.onceOpenedAt, new Date(now - 15_000)),
      ),
    )
    .orderBy(asc(conversationMessages.onceOpenedAt))
    .limit(100);
  let n = 0;
  for (const r of rows) {
    const a = r.attachments.find(isOnceMedia);
    if (!a || !r.openedAt || r.openedAt.getTime() + onceOpenLimitMs(a) > now) continue;
    const [peer] = await db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, r.conversationId), ne(conversationMembers.userId, r.authorId)))
      .limit(1);
    if (!peer) continue;
    const access = await loadAccess(r.conversationId, peer.userId);
    if (!access) continue;
    const res = await spendVoiceOnce(peer.userId, access, r.id);
    if (res.kind === 'ok' && res.changed) {
      n++;
      await deliver(res.delivery);
    }
  }
  return n;
}

/** Запуск сторожа одноразовых фото/видео (раз в 10 с, как у Telegram — сервер, а не клиент, решает, что сгорело). */
export function startOnceSweeper(): void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void sweepOpenedOnce()
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, 10_000);
  timer.unref?.();
}

/**
 * `audience` (08.10, `bigreact1`) — кому дошла бы реакция (`changeAudience`, и при повторе тоже): по нему маршрут шлёт `reaction.big`.
 */
export type ReactResult = { kind: 'ok'; changed: boolean; delivery: Delivery | null; audience: string[] } | { kind: 'not-found' };

/** Поставить или снять свою реакцию. Повтор (строка уже есть / уже снята) — успех без события и без строки журнала. */
/**
 * Реакцию можно поставить (аудит ЛС #236, п.4): юникодный эмодзи или кастомный эмодзи, который есть на каком-нибудь
 * сервере инстанса (`shared.isReactionEmoji` + строка `server_emojis`). Произвольный текст — нет.
 */
export async function reactionAllowed(emoji: string): Promise<boolean> {
  if (!isReactionEmoji(emoji)) return false;
  const custom = customReactionId(emoji);
  if (custom === null) return true;
  const [row] = await db.select({ id: serverEmojis.id }).from(serverEmojis).where(eq(serverEmojis.id, custom)).limit(1);
  return !!row;
}

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
            // Своя реакция на своё сообщение автору «не новость»: сразу увиденная (G24, `reactunread1`).
            .values({ messageId, userId: me, emoji, seenAt: m.authorId === me ? new Date() : null })
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
    // Аудит ЛС #236, п.4: не больше `REACTIONS_PER_USER_MAX` реакций одного человека на сообщение — новая вытесняет самые
    // старые его реакции (Telegram Premium: четвёртая заменяет первую). Новую не трогаем, даже при равном времени.
    if (op === 'add' && changed.length > 0) {
      const mine = await tx
        .select({ emoji: conversationMessageReactions.emoji })
        .from(conversationMessageReactions)
        .where(
          and(
            eq(conversationMessageReactions.messageId, messageId),
            eq(conversationMessageReactions.userId, me),
            ne(conversationMessageReactions.emoji, emoji),
          ),
        )
        .orderBy(desc(conversationMessageReactions.createdAt), desc(conversationMessageReactions.emoji));
      const evict = mine.slice(REACTIONS_PER_USER_MAX - 1).map((r) => r.emoji);
      if (evict.length > 0) {
        await tx
          .delete(conversationMessageReactions)
          .where(
            and(
              eq(conversationMessageReactions.messageId, messageId),
              eq(conversationMessageReactions.userId, me),
              inArray(conversationMessageReactions.emoji, evict),
            ),
          );
      }
    }
    const audience = changeAudience({ action: 'react', actorId: me, memberIds: access.memberIds, withheld: m.withheld, blockedActor });
    if (changed.length === 0) return { kind: 'ok', changed: false, delivery: null, audience };
    const pts = await journal(tx, msgEntries(audience, conversationId, messageId));
    // Э2: владелец реакции — дом поставившего; соседу уходит итог реакций наших людей на это сообщение.
    await fedRecord(tx, [{ conversationId, kind: FED_CONV_CHANGE_E2.react, entityId: messageId }]);
    return { kind: 'ok', changed: true, delivery: { conversationId, messageId, pts }, audience };
  });
}

/** Условие «сообщение моё, видимо мне» для списка непрочитанных реакций (общее для списка и отметки). */
function ownVisible(me: string, conversationId: string): SQL {
  return and(
    eq(conversationMessages.conversationId, conversationId),
    eq(conversationMessages.authorId, me),
    isNull(conversationMessages.deletedAt),
    sql`NOT (${me} = ANY(${conversationMessages.hiddenFor}))`,
  )!;
}

/**
 * `GET /api/conv/:id/unread-reactions` (G24, `reactunread1`): мои сообщения беседы с непрочитанными реакциями, самые
 * старые первыми, до `limit`; `total` — всего. Клик по «♥» идёт к первому (Telegram `CornerButtons::reactionsClick` →
 * `unreadReactions().minLoaded()`). `null` — меня в беседе нет.
 */
export async function unreadReactionMessages(me: string, conversationId: string, limit: number): Promise<ConvUnreadReactionsResponse | null> {
  return db.transaction(async (tx) => {
    if (!(await loadAccess(conversationId, me, tx))) return null;
    const r = conversationMessageReactions;
    const unseen = sql`EXISTS (SELECT 1 FROM ${r} WHERE ${r.messageId} = ${conversationMessages.id} AND ${r.seenAt} IS NULL
      AND ${r.userId} <> ${me}
      AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = ${me} AND b.blocked_id = ${r.userId}))`;
    const where = and(ownVisible(me, conversationId), unseen)!;
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(conversationMessages).where(where);
    const rows = await tx
      .select({ id: conversationMessages.id, sortKey: conversationMessages.sortKey })
      .from(conversationMessages)
      .where(where)
      .orderBy(asc(conversationMessages.sortKey))
      .limit(limit);
    return { total: Number(n), messages: rows };
  }, SNAPSHOT);
}

/**
 * `GET /api/conv/:id/unread-mentions` (07.10, `groups2`, G24): непрочитанные сообщения группы с упоминанием меня, самые старые
 * первыми, до `limit` (клик по «@» — к первому, tdesktop `CornerButtons::mentionsClick`). `null` — меня в беседе нет.
 */
export async function unreadMentionMessages(me: string, conversationId: string, limit: number): Promise<ConvUnreadReactionsResponse | null> {
  return db.transaction(async (tx) => {
    const access = await loadAccess(conversationId, me, tx);
    if (!access) return null;
    if (access.kind !== 'group') return { total: 0, messages: [] };
    const res = await tx.execute(sql`SELECT x.id, x.sort_key FROM conversation_messages x
      JOIN conversation_members m ON m.conversation_id = x.conversation_id AND m.user_id = ${me}
      WHERE x.conversation_id = ${conversationId} AND x.sort_key > m.last_read_key AND x.author_id <> ${me}
        AND NOT x.withheld AND x.deleted_at IS NULL AND NOT (${me} = ANY(x.hidden_for)) AND ${mentionsMeSql(me)}
      ORDER BY x.sort_key ASC`);
    const rows = res.rows as { id: string; sort_key: number | string }[];
    return { total: rows.length, messages: rows.slice(0, limit).map((r) => ({ id: String(r.id), sortKey: Number(r.sort_key) })) };
  }, SNAPSHOT);
}

export type ReactionsReadResult = { kind: 'ok'; read: number; delivery: Delivery | null } | { kind: 'not-found' };

/**
 * `POST /api/conv/:id/reactions-read` (G24): реакции на мои сообщения беседы увидены — `messageIds` (показаны на экране) или
 * все («Прочитать все», `lng_context_mark_read_reactions_all`). Только мои сообщения; повтор — 0 и без события. Сдвинулось —
 * строка журнала `'draft'` («моя строка изменилась») → `conv.change` со сводкой (`unreadReactions`) ТОЛЬКО моим устройствам;
 * собеседник не узнаёт. `read` — сколько сообщений погашено.
 */
export async function markReactionsRead(me: string, access: ConvAccess, messageIds: readonly string[] | null): Promise<ReactionsReadResult> {
  const conversationId = access.conversationId;
  return db.transaction(async (tx): Promise<ReactionsReadResult> => {
    if (!(await lockConversation(tx, conversationId))) return { kind: 'not-found' };
    const only = messageIds ? sql`AND r.message_id IN (${sql.join(messageIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
    const res = await tx.execute(sql`
      UPDATE conversation_message_reactions r SET seen_at = now() FROM conversation_messages x
      WHERE x.id = r.message_id AND x.conversation_id = ${conversationId} AND x.author_id = ${me}
        AND r.seen_at IS NULL AND r.user_id <> ${me} ${only}
      RETURNING r.message_id`);
    const read = new Set((res.rows as { message_id: string }[]).map((x) => x.message_id)).size;
    if (read === 0) return { kind: 'ok', read: 0, delivery: null };
    const pts = await journal(tx, [{ userId: me, conversationId, kind: 'draft', messageId: null }]);
    return { kind: 'ok', read, delivery: { conversationId, messageId: null, pts } };
  });
}

export type ReadResult = { kind: 'ok'; lastReadKey: number; delivery: Delivery | null } | { kind: 'bad-key' };

/**
 * «Прочитано до» ключа сообщения этой беседы — только вперёд (`GREATEST`). Ключ чужой беседы или несуществующий —
 * `bad-key`: иначе клиент мог бы «прочитать» будущее одним большим числом.
 * Отметка сдвинулась — строка журнала мне и собеседнику (Р6, ✓✓: его сводка несёт новый `peerReadKey`), кроме тех, кого
 * я держу в чёрном списке (`convRules.readAudience`). Повтор и движение назад — без журнала и без событий.
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
      .select({ key: conversationMembers.lastReadKey, marked: conversationMembers.unreadMarkedAt })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me)));
    if (!before) return { kind: 'bad-key' };
    if (key <= before.key) {
      if (!before.marked) return { kind: 'ok', lastReadKey: before.key, delivery: null };
      // Любое чтение снимает пометку «непрочитанным» (G04, 07.10, `conv13`) — и когда «прочитано до» не сдвинулось:
      // моим устройствам уходит сводка без точки, собеседнику ничего (его ✓✓ не менялись).
      await tx
        .update(conversationMembers)
        .set({ unreadMarkedAt: null })
        .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me)));
      const pts = await journal(tx, [{ userId: me, conversationId, kind: 'draft', messageId: null }]);
      return { kind: 'ok', lastReadKey: before.key, delivery: { conversationId, messageId: null, pts } };
    }
    await tx
      .update(conversationMembers)
      .set({ lastReadKey: sql`GREATEST(${conversationMembers.lastReadKey}, ${key})`, unreadMarkedAt: null })
      .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me)));
    // «Прочитано в 12:34» (С1, #211): чужим сообщениям беседы 1:1, которые этот сдвиг накрыл впервые, — момент прочтения.
    // Только вперёд (`read_at IS NULL`) и только в пределах сдвига — число строк не больше, чем новых прочитанных.
    if (access.peerId) {
      await tx
        .update(conversationMessages)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(conversationMessages.conversationId, conversationId),
            gt(conversationMessages.sortKey, before.key),
            lte(conversationMessages.sortKey, key),
            ne(conversationMessages.authorId, me),
            isNull(conversationMessages.readAt),
          ),
        );
    }
    // Себе — остальные мои устройства гасят непрочитанное; собеседнику — ✓✓ (Р6, видно всегда). Кого я держу в чёрном
    // списке — тем ничего (Р12). Набор читается здесь же, в транзакции под замком беседы, а не из кеша `blocks.ts`.
    const others = access.memberIds.filter((id) => id !== me);
    const readerBlocked = new Set(
      others.length > 0
        ? (
            await tx
              .select({ id: userBlocks.blockedId })
              .from(userBlocks)
              .where(and(eq(userBlocks.blockerId, me), inArray(userBlocks.blockedId, others)))
          ).map((r) => r.id)
        : [],
    );
    const audience = readAudience({ readerId: me, memberIds: access.memberIds, readerBlocked });
    const pts = await journal(
      tx,
      audience.map((userId) => ({ userId, conversationId, kind: 'read' as const, messageId: null })),
    );
    // Э2: «прочитано до» шлёт дом читателя — сосед мапит id сообщения на свой ключ (✓✓ у автора там).
    await fedRecord(tx, [{ conversationId, kind: FED_CONV_CHANGE.read, entityId: null }]);
    return { kind: 'ok', lastReadKey: key, delivery: { conversationId, messageId: null, pts } };
  });
}

export type DraftResult = { kind: 'ok'; delivery: Delivery | null } | { kind: 'not-found' };

/**
 * Черновик (Р7) — между МОИМИ устройствами: строка участника и журнал себе, как «прочитано»; собеседнику ни строки, ни
 * события. Ответ на сообщение, которого мне не видно или не этой беседы, отбрасывается — черновик сохраняется без него,
 * а не падает (цитируемое могли удалить, пока он лежал). Тот же черновик — без записи и без события. Гасит его клиент,
 * записью пустого после отправки (сервер отправку не трогает: голосовое или стикер не должны стирать набранный текст).
 */
export async function saveDraft(
  me: string,
  access: ConvAccess,
  input: { text: string; replyToId: string | null; device: string },
): Promise<DraftResult> {
  const conversationId = access.conversationId;
  const mine = and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me));
  return db.transaction(async (tx): Promise<DraftResult> => {
    if (!(await lockConversation(tx, conversationId))) return { kind: 'not-found' };
    let replyToId = input.replyToId;
    if (replyToId) {
      const [parent] = await tx
        .select()
        .from(conversationMessages)
        .where(and(eq(conversationMessages.id, replyToId), eq(conversationMessages.conversationId, conversationId)))
        .limit(1);
      if (!parent || messageView(parent, me) !== 'full') replyToId = null;
    }
    const next = normalizeDraft(input.text, replyToId);
    const [row] = await tx
      .select({ text: conversationMembers.draftText, replyTo: conversationMembers.draftReplyTo })
      .from(conversationMembers)
      .where(mine);
    if (!row) return { kind: 'not-found' };
    if (sameDraft(row.text === null ? null : { text: row.text, replyToId: row.replyTo }, next)) {
      return { kind: 'ok', delivery: null };
    }
    await tx
      .update(conversationMembers)
      .set(
        next
          ? { draftText: next.text, draftReplyTo: next.replyToId, draftAt: sql`now()`, draftDevice: input.device }
          : { draftText: null, draftReplyTo: null, draftAt: null, draftDevice: null },
      )
      .where(mine);
    const pts = await journal(tx, [{ userId: me, conversationId, kind: 'draft', messageId: null }]);
    return { kind: 'ok', delivery: { conversationId, messageId: null, pts } };
  });
}

// ─── Закреп беседы в списке и заглушка (07.10, признак `conv11`) ──────────────────────────────────────────────

export type ConvPinnedResult =
  | { kind: 'ok'; pinnedAt: string | null; delivery: Delivery | null; foldersChanged?: boolean }
  | { kind: 'not-found' }
  | { kind: 'limit'; max: number };

/**
 * Закрепить или открепить беседу наверху МОЕГО списка: строка участника и журнал себе, как черновик (строка `'draft'`
 * журнала = «моя строка участника изменилась», догонка и событие отдают сводку с `pinnedAt`). Собеседник не узнаёт.
 * Не больше `CONV_PIN_LIMIT` закреплённых: считает замок на человека, иначе два закрепа с двух устройств прошли бы оба.
 * То же состояние — без записи и без события.
 */
export async function setConversationPinned(me: string, access: ConvAccess, pinned: boolean): Promise<ConvPinnedResult> {
  const conversationId = access.conversationId;
  const mine = and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me));
  return db.transaction(async (tx): Promise<ConvPinnedResult> => {
    if (!(await lockConversation(tx, conversationId))) return { kind: 'not-found' };
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`conv-pinned:${me}`}))`);
    const [row] = await tx
      .select({ pinnedAt: conversationMembers.pinnedAt, leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(mine);
    if (!row || row.leftAt) return { kind: 'not-found' };
    if (pinned === (row.pinnedAt !== null)) {
      return { kind: 'ok', pinnedAt: row.pinnedAt ? row.pinnedAt.toISOString() : null, delivery: null };
    }
    if (pinned) {
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(conversationMembers)
        .where(and(eq(conversationMembers.userId, me), isNotNull(conversationMembers.pinnedAt), isNull(conversationMembers.leftAt)));
      if (n >= CONV_PIN_LIMIT) return { kind: 'limit', max: CONV_PIN_LIMIT };
    }
    const [upd] = await tx
      .update(conversationMembers)
      .set({ pinnedAt: pinned ? sql`now()` : null })
      .where(mine)
      .returning({ pinnedAt: conversationMembers.pinnedAt });
    /* Свой порядок закреплённых в папках (09.10, `pinorder2`): закреп и откреп вычёркивают беседу из `pinned_ids` всех моих
       папок — закреплённая заново встаёт в каждой папке наверх, как новый закреп у Telegram (`dmFolderPinnedOrder`). Папки со
       СВОИМ набором (`pinset1`, `pinned_own`) не трогаются: общий закреп в них не действует. */
    const pruned = await tx.execute(sql`
      UPDATE dm_folders SET pinned_ids = array_remove(pinned_ids, ${conversationId}), updated_at = now()
      WHERE user_id = ${me} AND NOT pinned_own AND ${conversationId} = ANY(pinned_ids)
      RETURNING id`);
    const pts = await journal(tx, [{ userId: me, conversationId, kind: 'draft', messageId: null }]);
    return {
      kind: 'ok',
      pinnedAt: upd?.pinnedAt ? upd.pinnedAt.toISOString() : null,
      delivery: { conversationId, messageId: null, pts },
      foldersChanged: pruned.rows.length > 0,
    };
  });
}

export type ConvPinOrderResult =
  | { kind: 'ok'; pins: { id: string; pinnedAt: string }[]; deliveries: Delivery[] }
  | { kind: 'bad' };

/**
 * Переставить мои закреплённые беседы (08.10, `pinorder1`, Telegram `messages.reorderPinnedDialogs`): правило —
 * `convPinOrderPlan` (повтор и не мой закреп — `bad`, неназванные закреплённые — после названных). Порядок хранится в
 * `pinned_at` (`convPinOrderStamps`: верхняя — `now()`, дальше на миллисекунду раньше), поэтому старый клиент и бэкенд
 * постарше на той же базе видят новый порядок как есть. Журнал себе строкой `'draft'` на КАЖДУЮ беседу, отметка которой
 * сменилась → `conv.change` со сводкой только моим устройствам, догонка отдаёт те же сводки. Замок — тот же, что у
 * закрепа (`conv-pinned:<я>`), без замков бесед: строки участника обновляются одним запросом, журнал — после.
 */
export async function reorderConversationPins(me: string, ids: readonly string[]): Promise<ConvPinOrderResult> {
  return db.transaction(async (tx): Promise<ConvPinOrderResult> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`conv-pinned:${me}`}))`);
    const rows = await tx
      .select({ id: conversationMembers.conversationId, pinnedAt: conversationMembers.pinnedAt })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.userId, me), isNotNull(conversationMembers.pinnedAt), isNull(conversationMembers.leftAt)))
      .orderBy(desc(conversationMembers.pinnedAt), asc(conversationMembers.conversationId));
    const plan = convPinOrderPlan(
      rows.map((r) => r.id),
      ids,
    );
    if (plan.kind === 'bad') return { kind: 'bad' };
    const view = (list: { id: string; pinnedAt: Date | null }[]) =>
      list.map((r) => ({ id: r.id, pinnedAt: (r.pinnedAt as Date).toISOString() }));
    if (plan.kind === 'same') return { kind: 'ok', pins: view(rows), deliveries: [] };
    const nowRes = await tx.execute(sql`SELECT now() AS t`);
    const base = new Date((nowRes.rows[0] as { t: string | Date }).t);
    const stamps = convPinOrderStamps(base, plan.order.length);
    const before = new Map(rows.map((r) => [r.id, r.pinnedAt ? r.pinnedAt.getTime() : null]));
    const changed = plan.order.filter((id, i) => before.get(id) !== stamps[i].getTime());
    const values = sql.join(
      plan.order.map((id, i) => sql`(${id}, ${stamps[i].toISOString()}::timestamptz)`),
      sql`, `,
    );
    await tx.execute(sql`
      UPDATE conversation_members m SET pinned_at = v.at
      FROM (VALUES ${values}) AS v(id, at)
      WHERE m.conversation_id = v.id AND m.user_id = ${me} AND m.pinned_at IS NOT NULL AND m.left_at IS NULL`);
    const deliveries: Delivery[] = [];
    for (const conversationId of changed) {
      const pts = await journal(tx, [{ userId: me, conversationId, kind: 'draft', messageId: null }]);
      deliveries.push({ conversationId, messageId: null, pts });
    }
    return {
      kind: 'ok',
      pins: plan.order.map((id, i) => ({ id, pinnedAt: stamps[i].toISOString() })),
      deliveries,
    };
  });
}

export type ConvUnreadMarkResult = { kind: 'ok'; marked: boolean; delivery: Delivery | null } | { kind: 'not-found' };

/**
 * «Пометить как непрочитанное / прочитанное» (G04, 07.10, `conv13`): строка участника и журнал себе, как закреп (строка
 * `'draft'` = «моя строка изменилась», сводка несёт `markedUnread`). Собеседник не узнаёт. `marked: false` только снимает
 * точку — «прочитано до» не двигает (прочитать беседу целиком — `markRead`). То же состояние — без записи и без события.
 */
export async function setConversationUnreadMark(me: string, access: ConvAccess, marked: boolean): Promise<ConvUnreadMarkResult> {
  const conversationId = access.conversationId;
  const mine = and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me));
  return db.transaction(async (tx): Promise<ConvUnreadMarkResult> => {
    if (!(await lockConversation(tx, conversationId))) return { kind: 'not-found' };
    const [row] = await tx
      .select({ marked: conversationMembers.unreadMarkedAt, leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(mine);
    if (!row || row.leftAt) return { kind: 'not-found' };
    if (marked === (row.marked !== null)) return { kind: 'ok', marked, delivery: null };
    await tx
      .update(conversationMembers)
      .set({ unreadMarkedAt: marked ? sql`now()` : null })
      .where(mine);
    const pts = await journal(tx, [{ userId: me, conversationId, kind: 'draft', messageId: null }]);
    return { kind: 'ok', marked, delivery: { conversationId, messageId: null, pts } };
  });
}

export type ConvArchivedResult = { kind: 'ok'; archived: boolean; delivery: Delivery | null } | { kind: 'not-found' };

/**
 * «В архив» / «Вернуть из архива» (07.10, #211, G41, `archive1`; `window_peer_menu.cpp` `addToggleArchive`, `api.toggleHistoryArchived`):
 * `archived_at` моей строки участника. Журнал себе строкой `'draft'` («моя строка изменилась», как у закрепа) → `conv.change`
 * со сводкой (`archived`) ТОЛЬКО моим устройствам. То же состояние — без записи и события. Закреп и черновик в архиве остаются.
 */
export async function setConversationArchived(me: string, access: ConvAccess, archived: boolean): Promise<ConvArchivedResult> {
  const conversationId = access.conversationId;
  const mine = and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me));
  return db.transaction(async (tx): Promise<ConvArchivedResult> => {
    if (!(await lockConversation(tx, conversationId))) return { kind: 'not-found' };
    const [row] = await tx
      .select({ at: conversationMembers.archivedAt, leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(mine);
    if (!row || row.leftAt) return { kind: 'not-found' };
    if (archived === (row.at !== null)) return { kind: 'ok', archived, delivery: null };
    await tx
      .update(conversationMembers)
      .set({ archivedAt: archived ? sql`now()` : null })
      .where(mine);
    const pts = await journal(tx, [{ userId: me, conversationId, kind: 'draft', messageId: null }]);
    return { kind: 'ok', archived, delivery: { conversationId, messageId: null, pts } };
  });
}

/**
 * Новое сообщение возвращает беседу из архива (07.10, G41, `archive1`). Правило Telegram по умолчанию («Архив и мьют» →
 * «Всегда в архиве» выключено): `lang.strings` `lng_archived_added` — «заглушённые чаты остаются в архиве при новых
 * сообщениях», `lng_archive_hint_about_unmuted` — незаглушённые уходят в «Чаты»; у Android «Выключить звук» (`soundOnly`)
 * заглушкой не считается (уведомления идут). Получатель держит беседу в архиве, пока действует ЕГО заглушка автора
 * (`push_mutes`, `dm_user`, без `sound_only`, `until` пуст или в будущем). Автор своё сообщение отправил сам — беседа
 * возвращается у него всегда. Зовётся ВНУТРИ транзакции отправки/пересылки (замок беседы уже взят); строка участника
 * меняется до журнала, так что `conv.change` по сообщению уже несёт `archived: false` (отдельного события не нужно).
 */
export async function unarchiveOnMessage(tx: Tx, conversationId: string, authorId: string, audience: readonly string[]): Promise<void> {
  if (audience.length === 0) return;
  await tx.execute(sql`
    UPDATE conversation_members m SET archived_at = NULL
    WHERE m.conversation_id = ${conversationId} AND m.archived_at IS NOT NULL
      AND m.user_id IN (${sql.join(audience.map((id) => sql`${id}`), sql`, `)})
      AND (m.user_id = ${authorId} OR NOT EXISTS (
        SELECT 1 FROM push_mutes pm
        WHERE pm.user_id = m.user_id AND pm.scope = 'dm_user'
          -- 07.10 (groups2): в группе держит заглушка самой группы, а не автора.
          AND pm.target_id = CASE WHEN (SELECT k.kind FROM conversations k WHERE k.id = ${conversationId}) = 'group'
            THEN ${groupMuteTarget(conversationId)} ELSE ${authorId} END
          AND NOT pm.sound_only AND (pm.until IS NULL OR pm.until > now())))`);
}

/**
 * «Прочитать все» (G04, 07.10, `conv13`): каждая моя беседа с непрочитанным или пометкой — прочитана до последнего
 * сообщения (`markRead`, те же ✓✓ собеседникам и те же события, что при открытии беседы) и без точки. Возвращает события
 * к рассылке и число затронутых бесед. Беседа с пометкой, но без единого сообщения, только теряет точку.
 */
export async function markAllRead(me: string): Promise<{ deliveries: Delivery[]; count: number }> {
  const all = await summariesFor(me, null, db);
  const deliveries: Delivery[] = [];
  let count = 0;
  for (const s of all) {
    if ('left' in s) continue;
    if (!(s.unread > 0 || s.markedUnread)) continue;
    const access = await loadAccess(s.id, me);
    if (!access) continue;
    count++;
    const key = s.lastMessage?.sortKey;
    if (key === undefined) {
      const r = await setConversationUnreadMark(me, access, false);
      if (r.kind === 'ok' && r.delivery) deliveries.push(r.delivery);
      continue;
    }
    const r = await markRead(me, access, key);
    if (r.kind !== 'ok') continue;
    if (r.delivery) deliveries.push(r.delivery);
  }
  return { deliveries, count };
}

/**
 * Заглушка собеседника сменилась (`routes/push.ts`, `dm_user`): новая сводка беседы 1:1 с ним — всем МОИМ
 * устройствам (журнал себе, строка `'draft'`, как у закрепа). Беседы с ним нет — событий нет (`null`).
 */
export async function journalMuteChange(me: string, otherId: string): Promise<Delivery | null> {
  // Группа (`groups2`): цель заглушки — `group:<id беседы>`; сводка — этой беседы (членство проверяется ниже).
  const groupId = groupOfMuteTarget(otherId);
  const conv = groupId ? { id: groupId } : await findDirect(me, otherId);
  if (!conv) return null;
  return db.transaction(async (tx): Promise<Delivery | null> => {
    if (!(await lockConversation(tx, conv.id))) return null;
    const [row] = await tx
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, conv.id), eq(conversationMembers.userId, me)));
    if (!row || row.leftAt) return null;
    const pts = await journal(tx, [{ userId: me, conversationId: conv.id, kind: 'draft', messageId: null }]);
    return { conversationId: conv.id, messageId: null, pts };
  });
}

// ─── Закреп в беседе (С2, 05.10, признак `conv7`) ───────────────────────────────────────────────────────────────────

/** У кого закреплены эти сообщения (строки закрепа) — id людей без повторов. */
async function pinHolders(tx: Tx, messageIds: readonly string[]): Promise<string[]> {
  const rows = await tx
    .select({ userId: conversationPins.userId })
    .from(conversationPins)
    .where(inArray(conversationPins.messageId, [...messageIds]));
  return [...new Set(rows.map((r) => r.userId))];
}

/** Снять закрепы этих сообщений — у одного человека (`onlyUser`) или у всех (`null`); вернуть, у кого сняты. */
export async function removePins(tx: Tx, messageIds: readonly string[], onlyUser: string | null): Promise<string[]> {
  const byMessage = inArray(conversationPins.messageId, [...messageIds]);
  const rows = await tx
    .delete(conversationPins)
    .where(onlyUser === null ? byMessage : and(byMessage, eq(conversationPins.userId, onlyUser)))
    .returning({ userId: conversationPins.userId });
  return [...new Set(rows.map((r) => r.userId))];
}

/**
 * Участники беседы, заблокировавшие `me`, — правило реакций для закрепа: действия заблокированного им не доходят.
 * Читается в транзакции под замком беседы (как в `markRead`), а не из кеша `blocks.ts`.
 */
async function blockersOf(tx: Tx, me: string, memberIds: readonly string[]): Promise<Set<string>> {
  const others = memberIds.filter((id) => id !== me);
  if (others.length === 0) return new Set();
  const rows = await tx
    .select({ id: userBlocks.blockerId })
    .from(userBlocks)
    .where(and(eq(userBlocks.blockedId, me), inArray(userBlocks.blockerId, others)));
  return new Set(rows.map((r) => r.id));
}

/** Журнал «список закреплённого изменился» этим людям и событие только со списками (`pinPts`). */
export async function journalPins(tx: Tx, conversationId: string, userIds: readonly string[]): Promise<Delivery> {
  const entries = pinEntries(userIds, conversationId);
  const nums = entryPts(entries, await journal(tx, entries));
  const [delivery] = withPinDeliveries(conversationId, [], entries, nums);
  return delivery;
}

/** Запасной текст служебной строки «закрепил(а) сообщение» (`pins2`): его покажет клиент без признака, новый строит строку сам. */
export const PIN_SERVICE_FALLBACK = 'Закрепил(а) сообщение';

export type PinResult =
  | {
      kind: 'ok';
      delivery: Delivery | null;
      list: ConvPinsResponse;
      /** Событие служебной строки «X закрепил(а) сообщение» (`pins2`): закрепили «для обоих» — рассылать ВМЕСТЕ с `delivery`. */
      service?: Delivery | null;
    }
  | { kind: 'not-found' }
  | { kind: 'limit' };

/**
 * Закрепить сообщение (С2): `me` — только у себя, `both` — ещё у собеседника (`convRules.pinAudience`: кому оно видно и
 * кто не заблокировал меня). Закрепить можно только живое видимое МНЕ сообщение этой беседы (`messageView === 'full'`):
 * не удалённое, не спрятанное мной, не чужое придержанное — иначе `not-found`. Своё придержанное — можно (только у себя:
 * собеседнику его не видно): отказ выдал бы автору, что собеседник его заблокировал (Р12).
 * Строка каждого — по `convRules.pinRowAction`: новая, «теперь для обоих» или без изменений. Мой список полон
 * (`PINS_MAX`) — `limit`, не меняется ничего; полный список собеседника молча пропускается (иначе ответ выдал бы, сколько
 * у него закреплено «для себя»). Повтор — успех без журнала и событий. Пуша и звука нет: закреп — не сообщение.
 * Ответ — мой список и `pts` из той же транзакции (после записи).
 */
export async function pinMessage(
  me: string,
  access: ConvAccess,
  messageId: string,
  scope: PinScope,
  /** G4: группа без «Уведомить всех участников» — строка закрепа «без звука» (соседи по ней будят тихо, как Telegram `silent`). */
  opts?: { silent?: boolean },
): Promise<PinResult> {
  const conversationId = access.conversationId;
  return db.transaction(async (tx): Promise<PinResult> => {
    const m = await lockMessage(tx, conversationId, messageId);
    if (!m || messageView(m, me) !== 'full') return { kind: 'not-found' };
    const blockedActor = scope === 'both' ? await blockersOf(tx, me, access.memberIds) : new Set<string>();
    const targets = pinAudience({ message: m, actorId: me, scope, memberIds: access.memberIds, blockedActor });
    const existing = new Map(
      (
        await tx
          .select({ userId: conversationPins.userId, forBoth: conversationPins.forBoth })
          .from(conversationPins)
          .where(and(eq(conversationPins.conversationId, conversationId), eq(conversationPins.messageId, messageId)))
      ).map((r) => [r.userId, r]),
    );
    // Сколько ВИДИМОГО каждому уже закреплено в беседе — условие видимости то же, что у списка, но глазами владельца строки.
    const counts = new Map(
      (
        await tx
          .select({ userId: conversationPins.userId, n: sql<number>`count(*)::int` })
          .from(conversationPins)
          .innerJoin(conversationMessages, eq(conversationMessages.id, conversationPins.messageId))
          .where(
            and(
              eq(conversationPins.conversationId, conversationId),
              inArray(conversationPins.userId, targets),
              isNull(conversationMessages.deletedAt),
              sql`NOT (${conversationPins.userId} = ANY(${conversationMessages.hiddenFor}))`,
              or(eq(conversationMessages.withheld, false), eq(conversationMessages.authorId, conversationPins.userId)),
            ),
          )
          .groupBy(conversationPins.userId)
      ).map((r) => [r.userId, Number(r.n)]),
    );
    const plan = targets.map((userId) => ({ userId, action: pinRowAction(existing.get(userId), scope, counts.get(userId) ?? 0) }));
    if (plan.some((p) => p.userId === me && p.action === 'full')) return { kind: 'limit' };
    const insert = plan.filter((p) => p.action === 'insert').map((p) => p.userId);
    const share = plan.filter((p) => p.action === 'share').map((p) => p.userId);
    if (insert.length > 0) {
      await tx
        .insert(conversationPins)
        .values(insert.map((userId) => ({ conversationId, userId, messageId, pinnedBy: me, forBoth: scope === 'both' })));
    }
    if (share.length > 0) {
      await tx
        .update(conversationPins)
        .set({ forBoth: true })
        .where(
          and(
            eq(conversationPins.conversationId, conversationId),
            eq(conversationPins.messageId, messageId),
            inArray(conversationPins.userId, share),
          ),
        );
    }
    const changed = [...insert, ...share];
    const delivery = changed.length > 0 ? await journalPins(tx, conversationId, changed) : null;
    // Э2: закреп «у обоих» — владелец дом закрепившего; соседу — состояние закрепа этого сообщения.
    if (scope === 'both' && changed.length > 0) await fedRecord(tx, [{ conversationId, kind: FED_CONV_CHANGE.pin, entityId: messageId }]);
    // G28 (`pins2`, как «X pinned a message» у Telegram): закреп стал виден собеседнику — в ленту встаёт служебная строка от меня.
    // Закреп «только у себя» и повтор её не рождают; заблокировавший меня собеседник строки закрепа не получает — и строки тоже.
    let service: Delivery | null = null;
    if (changed.some((id) => id !== me)) {
      const sent = await sendMessage(
        me,
        access,
        { clientId: null, content: PIN_SERVICE_FALLBACK, attachments: [], replyToId: null, withheld: false, service: { kind: 'pin', messageId }, ...(opts?.silent ? { silent: true } : {}) },
        tx,
      );
      if (sent.kind === 'created') service = sent.delivery;
    }
    return { kind: 'ok', delivery, service, list: await pinsListOf(me, conversationId, tx) };
  });
}

export type UnpinResult = { kind: 'ok'; delivery: Delivery | null; list: ConvPinsResponse } | { kind: 'not-found' };

/**
 * Открепить (С2): `me` — только мой закреп, `both` — ещё закрепы «для обоих» у остальных (`convRules.unpinTargets`; закреп
 * собеседника «только у себя» и закрепы заблокировавших меня не трогаются). Сообщения нет в этой беседе — `not-found`.
 * Сообщения нет ДЛЯ МЕНЯ (удалено, спрятано мной, чужое придержанное) — успех без изменений: моего закрепа на нём уже нет,
 * а права на чужие закрепы того, чего нет в моей переписке, нет (как у С1). Повтор — успех без журнала и событий.
 */
export async function unpinMessage(me: string, access: ConvAccess, messageId: string, scope: PinScope): Promise<UnpinResult> {
  const conversationId = access.conversationId;
  return db.transaction(async (tx): Promise<UnpinResult> => {
    const m = await lockMessage(tx, conversationId, messageId);
    if (!m) return { kind: 'not-found' };
    let changed: string[] = [];
    if (messageView(m, me) === 'full') {
      const rows = await tx
        .select({ userId: conversationPins.userId, forBoth: conversationPins.forBoth })
        .from(conversationPins)
        .where(and(eq(conversationPins.conversationId, conversationId), eq(conversationPins.messageId, messageId)));
      const blockedActor = scope === 'both' ? await blockersOf(tx, me, access.memberIds) : new Set<string>();
      const targets = unpinTargets({ actorId: me, scope, rows, blockedActor });
      if (targets.length > 0) {
        await tx
          .delete(conversationPins)
          .where(
            and(
              eq(conversationPins.conversationId, conversationId),
              eq(conversationPins.messageId, messageId),
              inArray(conversationPins.userId, targets),
            ),
          );
        changed = targets.filter((id) => access.memberIds.includes(id));
      }
    }
    const delivery = changed.length > 0 ? await journalPins(tx, conversationId, changed) : null;
    if (scope === 'both' && changed.length > 0) await fedRecord(tx, [{ conversationId, kind: FED_CONV_CHANGE.pin, entityId: messageId }]);
    return { kind: 'ok', delivery, list: await pinsListOf(me, conversationId, tx) };
  });
}

// ─── Пачки: пересылка и удаление выделенного (04.10, признак `conv5`) ───────────────────────────────────────────────

/** Номера журнала по сообщениям пачки: у каждого сообщения своё событие со своим `pts`, как у обычной отправки. */
function batchDeliveries(conversationId: string, messageIds: readonly string[], entries: readonly JournalEntry[], nums: readonly number[]): Delivery[] {
  return messageIds.map((messageId) => {
    const pts = new Map<string, number>();
    entries.forEach((e, k) => {
      if (e.messageId === messageId) pts.set(e.userId, nums[k]);
    });
    return { conversationId, messageId, pts };
  });
}

/**
 * Что пересылают — глазами пересылающего: сообщения беседы-источника, видимые ему (не удалены у обоих, не спрятаны им,
 * не чужие придержанные), в порядке ленты. Закрытый файл оригинала должен быть на месте: строка `attached` именно этого
 * сообщения (нет — файл уже удалён или убран, пересылать нечего). `missing` — что из запрошенного не годится.
 */
async function forwardSources(
  me: string,
  fromConversationId: string,
  ids: readonly string[],
  q: Q,
  only?: string,
): Promise<{ rows: MsgRow[]; files: AttachmentRow[] } | { missing: string[] }> {
  const raw = await q
    .select()
    .from(conversationMessages)
    .where(and(inArray(conversationMessages.id, [...ids]), eq(conversationMessages.conversationId, fromConversationId)));
  // G56 (`album1`): глазами пересылающего — без элементов альбома, спрятанных им «у меня»; `only` — один элемент альбома
  // (Telegram пересылает элемент группы отдельным сообщением, tdesktop `AddForwardMessageAction` по `PointState::GroupPart`):
  // новое сообщение — только с ним и без подписи (подпись у нас — всего альбома). Такого элемента нет — «нечего пересылать».
  const found = raw.map((m) => {
    const list = attachmentsForViewer(m.attachments, m.hiddenAttachments, me);
    if (only === undefined) return list === m.attachments ? m : { ...m, attachments: list };
    return { ...m, attachments: list.filter((a) => a.id === only), content: '', captionAbove: false };
  });
  // Служебную строку («X закрепил(а) сообщение», `pins2`) не переслать — как у Telegram: её нет среди доступного для пересылки.
  // G56: один элемент — у сообщения он должен быть (и не спрятан мной), иначе «нечего пересылать».
  // Аудит ЛС #236: «История для новых» (п.8) — до своего добавления не переслать; бывший участник группы (п.9) — только
  // ленту до выхода (`formerLeftAt`), как он её и видит.
  const [mem] = await q
    .select({ from: conversationMembers.historyFromKey, leftAt: conversationMembers.leftAt })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.conversationId, fromConversationId), eq(conversationMembers.userId, me)))
    .limit(1);
  const floor = mem?.from ?? 0;
  const until = mem?.leftAt ? await formerLeftAt(fromConversationId, me, q) : null;
  const inView = (m: MsgRow) => !!mem && m.sortKey >= floor && (!mem.leftAt || (!!until && m.createdAt.getTime() <= until.getTime()));
  const rows = found
    .filter((m) => messageView(m, me) === 'full' && inView(m))
    .filter((m) => !m.service)
    .filter((m) => only === undefined || m.attachments.length === 1);
  const ok = new Set(rows.map((m) => m.id));
  const missing = ids.filter((id) => !ok.has(id));
  if (missing.length > 0) return { missing };
  const fileIds = rows.flatMap((m) => m.attachments.flatMap((a) => (a.id ? [a.id] : [])));
  const files = fileIds.length
    ? await q.select().from(attachments).where(and(inArray(attachments.id, fileIds), eq(attachments.state, 'attached')))
    : [];
  const byId = new Map(files.map((f) => [f.id, f]));
  const broken = rows.filter((m) => m.attachments.some((a) => a.id && byId.get(a.id)?.messageId !== m.id));
  if (broken.length > 0) return { missing: broken.map((m) => m.id) };
  return { rows: rows.sort((a, b) => a.sortKey - b.sortKey), files };
}

export interface ForwardInput {
  /** id отправки ВСЕЙ пачки (из запроса); у каждого сообщения свой — `convRules.forwardClientId`. */
  clientId: string;
  /** Беседа, откуда пересылают; участие в ней проверил вызывающий. */
  fromConversationId: string;
  messageIds: string[];
  /** Получатель заблокировал пересылающего (`blockRules.dmDeliveryPlan`): вся пачка придержана, как обычная отправка. */
  withheld: boolean;
  /**
   * Переслать «без звука» (С3, `conv8`): флаг у КАЖДОГО сообщения пачки. Флаг оригинала не переносится — «без звука»
   * свойство отправки, а не сообщения. В отпечаток повтора (`forwardPayloadHash`) не входит, как и у отправки.
   */
  silent?: boolean;
  /**
   * «Скрыть имя отправителя» (G71, `fwd2`; Telegram `ForwardOptions::NoSenderNames`): копии уходят как обычные сообщения
   * пересылающего, без «переслано от» (`forwardedFrom` не ставится). Свойство отправки, в отпечаток повтора не входит.
   */
  hideSender?: boolean;
  /** «Скрыть подписи» (G71, `fwd2`; `NoNamesAndCaptions`): у сообщений с вложением текст-подпись не копируется. */
  hideCaptions?: boolean;
  /** G56 (`album1`): переслать ОДИН элемент альбома (`messageIds` — ровно одно сообщение): новое сообщение с ним одним. */
  attachmentId?: string;
}

export type ForwardResult =
  | { kind: 'created'; rows: MsgRow[]; deliveries: Delivery[] }
  | { kind: 'replay'; rows: MsgRow[] }
  | { kind: 'conflict' }
  | { kind: 'source-missing'; missing: string[] }
  | { kind: 'too-large' }
  | { kind: 'storage' }
  | { kind: 'not-found' };

/** Тот же id отправки параллельно вставили в ДРУГОЙ беседе (уникальный `(автор, client_id)`): откат и ответ по её строкам. */
class ForwardRace extends Error {}

/**
 * Переслать сообщения беседы-источника в беседу `access` (ЛС → ЛС, `conv5`). Каждое новое сообщение — как обычная
 * отправка пересылающего: свой ключ порядка (подряд, в порядке оригиналов), свой id отправки и отпечаток, строки журнала
 * и события той же аудитории (придержанное — только себе). Копируются текст и вложения, цитата — нет; «переслано от» —
 * `convRules.forwardedFromOf`. Вложения — КОПИИ файлов со своими строками (`attachments.copyForForward`, почему — там).
 *
 * Порядок: повтор по id отправки — до всякой работы (файлы второй раз не копируются) → проверка источника и пределов →
 * копии файлов ВНЕ транзакции (хранилище может быть медленным, замок беседы ждать его не должен) → транзакция: замок
 * беседы, повтор ещё раз (параллельный запрос с тем же id), источник ещё раз (пока копировали, оригинал могли удалить),
 * копии на месте → вставка пачки. Копии, которые не понадобились, бросаются (`discardForwardCopies`).
 * `created` в событии — только у ПОСЛЕДНЕГО сообщения пачки: звук, тост и счётчик у собеседника — один раз, как пуш.
 */
export async function forwardMessages(me: string, access: ConvAccess, input: ForwardInput): Promise<ForwardResult> {
  const conversationId = access.conversationId;
  const expected = input.messageIds.map((_, index) => ({
    clientId: forwardClientId(input.clientId, index),
    // G56: один элемент — другая пачка, чем всё сообщение (тот же id отправки с другим элементом — 409).
    hash: forwardPayloadHash({
      conversationId,
      fromConversationId: input.fromConversationId,
      messageIds: input.attachmentId ? input.messageIds.map((id) => `${id}/${input.attachmentId}`) : input.messageIds,
      index,
    }),
  }));
  const clientIds = expected.map((x) => x.clientId);
  const already = (q: Q) =>
    q
      .select()
      .from(conversationMessages)
      .where(and(eq(conversationMessages.authorId, me), inArray(conversationMessages.clientId, clientIds)));
  const decide = (existing: readonly MsgRow[]): ForwardResult | null => {
    const d = forwardReplayDecision(existing, expected);
    if (d === 'insert') return null;
    if (d === 'conflict') return { kind: 'conflict' };
    const byClient = new Map(existing.map((r) => [r.clientId, r]));
    return { kind: 'replay', rows: clientIds.map((id) => byClient.get(id)).filter((r): r is MsgRow => !!r) };
  };

  const early = decide(await already(db));
  if (early) return early;
  const sources = await forwardSources(me, input.fromConversationId, input.messageIds, db, input.attachmentId);
  if ('missing' in sources) return { kind: 'source-missing', missing: sources.missing };
  // «Прослушать один раз» (`voice3`, G54) не пересылается: для пересылки такого сообщения нет (как у Telegram).
  const once = sources.rows.filter((m) => m.attachments.some((a) => a.once === true)).map((m) => m.id);
  if (once.length > 0) return { kind: 'source-missing', missing: once };
  // Опрос (`convpoll1`) пересылается НОВЫМ открытым опросом (голоса — у каждой копии свои); в беседу с людьми других инстансов —
  // опросом, если все их дома объявили `dmpoll1` (`convPollFederates`), иначе только запасным текстом (`convHasRemote`).
  const pollRemote = sources.rows.some((m) => m.media?.kind === 'poll')
    ? (await convHasRemote(db, conversationId)) && !(await convPollFederates(db, conversationId))
    : false;
  const bytes = sources.files.reduce((sum, f) => sum + f.size, 0);
  if (sources.files.length > FORWARD_ATTACHMENTS_MAX || bytes > FORWARD_BYTES_MAX) return { kind: 'too-large' };

  let copies = new Map<string, AttachmentRow>();
  if (sources.files.length > 0) {
    if (!privateAttachmentsReady() && !(await attachmentStore.ensureReady())) return { kind: 'storage' };
    try {
      copies = await copyForForward({ ownerId: me, conversationId, sources: sources.files });
    } catch (e) {
      // Сверх суточного объёма (копии считаются в него, ревью `bigfile1` M2) — 429 с текстом, не «сбой хранилища».
      if (e instanceof DailyQuotaError) throw e;
      // Оригинал удалили, пока копировали (его файл уже убран), — это «нечего пересылать», а не сбой хранилища.
      const again = await forwardSources(me, input.fromConversationId, input.messageIds, db, input.attachmentId);
      return 'missing' in again ? { kind: 'source-missing', missing: again.missing } : { kind: 'storage' };
    }
  }
  const copyIds = [...copies.values()].map((r) => r.id);

  let res: ForwardResult;
  try {
    res = await db.transaction(async (tx): Promise<ForwardResult> => {
      const lock = await lockConversation(tx, conversationId);
      if (!lock) return { kind: 'not-found' };
      // Параллельный запрос с тем же id успел раньше: в этой беседе нас упорядочил замок.
      const raced = decide(await already(tx));
      if (raced) return raced;
      const current = await forwardSources(me, input.fromConversationId, input.messageIds, tx, input.attachmentId);
      if ('missing' in current) return { kind: 'source-missing', missing: current.missing };
      if (copyIds.length > 0) {
        // Копии всё ещё незавершённые (их не вытеснила параллельная загрузка и не убрала уборка) — под замок строк.
        const held = await tx
          .select({ id: attachments.id })
          .from(attachments)
          .where(
            and(
              inArray(attachments.id, copyIds),
              eq(attachments.ownerId, me),
              eq(attachments.conversationId, conversationId),
              eq(attachments.state, 'pending'),
            ),
          )
          .for('update');
        if (held.length !== copyIds.length) return { kind: 'storage' };
      }
      const authorIds = [...new Set(current.rows.map((m) => m.authorId))];
      const authorRows = await tx
        .select({ id: users.id, name: users.displayName, deletedAt: users.deletedAt })
        .from(users)
        .where(inArray(users.id, authorIds));
      const names = new Map(authorRows.map((u) => [u.id, u.name]));
      // Автор оригинала удалён — снимок сразу с признаком `deleted` (05.10), как после обезличивания (`accountRows`).
      const deletedAuthors = new Set(authorRows.filter((u) => u.deletedAt).map((u) => u.id));
      const values = current.rows.map((src, i) => ({
        id: uuidv7(),
        conversationId,
        authorId: me,
        clientId: expected[i].clientId,
        payloadHash: expected[i].hash,
        sortKey: lock.nextKey + i,
        content: input.hideCaptions && src.attachments.length > 0 ? '' : src.content,
        attachments: src.attachments.map((a): Attachment => {
          if (!a.id) return { ...a }; // старое вложение из публичного бакета (до 1в) — ссылка как есть, файл общий и не удаляется (Р17)
          const copy = copies.get(a.id);
          if (!copy) throw new Error('нет копии вложения для пересылки');
          return storedAttachment(copy, { id: copy.id, width: a.width, height: a.height, waveform: a.waveform, durationMs: a.durationMs, asFile: a.asFile, gif: a.gif, spoiler: a.spoiler, round: a.round });
        }),
        replyToId: null,
        // Стикер (0092, `stickers2`) пересылается как есть — он и так копия, файл публичный.
        sticker: src.sticker ?? null,
        // Геопозиция / контакт (G69) — тоже снимок, пересылается как есть вместе с запасным `content`.
        // Трансляция (`geolive1`) пересылается обычной (статичной) геопозицией — как у Telegram: пересланная точка не движется.
        media:
          src.media?.kind === 'geolive'
            ? { kind: 'geo' as const, lat: src.media.lat, lon: src.media.lon, accuracy: src.media.accuracy }
            : src.media?.kind === 'poll'
              ? pollRemote
                ? null
                : { ...src.media, closed: false }
              : (src.media ?? null),
        // Ссылка на карту в запасной фразе геопозиции — не повод для карточки превью (как при отправке, `routes/conv.ts`).
        ...(src.media ? { noPreview: true } : {}),
        withheld: input.withheld,
        silent: input.silent === true, // своё, а не оригинала (`src.silent` не читается намеренно)
        // «Подпись над медиа» (G48, `media2`) — свойство самого сообщения, как подпись и вложения: пересылка его сохраняет.
        captionAbove: src.captionAbove && !(input.hideCaptions && src.attachments.length > 0),
        forwardedFrom: input.hideSender
          ? null
          : forwardedFromOf({
              authorId: src.authorId,
              authorName: names.get(src.authorId) ?? '',
              createdAt: src.createdAt,
              forwardedFrom: src.forwardedFrom,
              authorDeleted: deletedAuthors.has(src.authorId),
            }),
      }));
      // Точки для теста гонки того же id отправки в другой беседе (`dmWriteBarrier.ts`): проверки пройдены, вставки ещё
      // нет / пачка вставлена, но не зафиксирована.
      await dmWriteBarrier.beforeForwardInsert?.({ tx });
      const inserted = await tx
        .insert(conversationMessages)
        .values(values)
        .onConflictDoNothing({
          target: [conversationMessages.authorId, conversationMessages.clientId],
          where: sql`client_id IS NOT NULL`,
        })
        .returning();
      if (inserted.length !== values.length) throw new ForwardRace();
      await dmWriteBarrier.afterForwardInsert?.();
      const byId = new Map(inserted.map((r) => [r.id, r]));
      const rows = values.map((v) => byId.get(v.id)).filter((r): r is MsgRow => !!r);
      for (const row of rows) {
        const own = row.attachments.flatMap((a) => (a.id ? [a.id] : []));
        if (own.length > 0) {
          await tx.update(attachments).set({ state: 'attached', messageId: row.id }).where(inArray(attachments.id, own));
        }
      }
      const lastKey = lock.nextKey + rows.length - 1;
      await tx
        .update(conversations)
        .set(
          input.withheld
            ? { lastSortKey: lastKey }
            : {
                lastSortKey: lastKey,
                // Придержанное беседу не поднимает (как у отправки): сдвиг выдал бы получателю, что заблокированный пишет.
                lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, ${rows[rows.length - 1].createdAt.toISOString()}::timestamptz)`,
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
      await unarchiveOnMessage(tx, conversationId, me, audience);
      const entries = rows.flatMap((row) => msgEntries(audience, conversationId, row.id));
      const nums = entryPts(entries, await journal(tx, entries));
      const deliveries = batchDeliveries(conversationId, rows.map((r) => r.id), entries, nums);
      deliveries[deliveries.length - 1].created = true;
      return { kind: 'created', rows, deliveries };
    });
  } catch (e) {
    await discardForwardCopies(copyIds).catch(() => {});
    if (!(e instanceof ForwardRace)) throw e;
    return decide(await already(db)) ?? { kind: 'conflict' };
  }
  if (res.kind !== 'created') await discardForwardCopies(copyIds).catch(() => {});
  return res;
}

export type DeleteManyResult =
  | {
      kind: 'ok';
      deliveries: Delivery[];
      /** Что действительно изменилось (пропущенное — нет), в порядке ленты; `own` — моё (чужое меняет моё непрочитанное). */
      changed: { messageId: string; withheld: boolean; own: boolean }[];
      /** `both`: время беседы после удаления (как у одиночного); `me` — `null`. */
      lastMessageAt: string | null;
    }
  | { kind: 'not-found'; missing: string[] }
  | { kind: 'forbidden'; ids: string[] };

/**
 * Удалить пачкой (`conv5`) — правила и следы те же, что у удаления по одному (`deleteMessage`): `both` — надгробие
 * своих у всех, а с правом на чужое (`opts.othersForBoth`, С1: беседа 1:1) — и чужих видимых (файлы — после фиксации, в
 * фоне), `me` — спрятать любые видимые у себя. Решение по каждому — `convRules.batchDeleteDecision`; пачка целиком или
 * ничего: есть не этой беседы — `not-found`, чужое видимое «у обоих» без права — `forbidden`, и тогда не меняется ничего.
 * Строки журнала и события — по одному на сообщение, в порядке ленты.
 */
export async function deleteMessages(
  me: string,
  access: ConvAccess,
  ids: readonly string[],
  scope: 'me' | 'both',
  opts: DeleteOptions = {},
): Promise<DeleteManyResult> {
  const conversationId = access.conversationId;
  let purge: string[] = [];
  const res = await db.transaction(async (tx): Promise<DeleteManyResult> => {
    const lock = await lockConversation(tx, conversationId);
    if (!lock) return { kind: 'not-found', missing: [...ids] };
    const othersForBoth = !!opts.othersForBoth && othersDeletableForBoth(lock.kind);
    const found = await tx
      .select()
      .from(conversationMessages)
      .where(and(inArray(conversationMessages.id, [...ids]), eq(conversationMessages.conversationId, conversationId)))
      .for('update');
    const byId = new Map(found.map((m) => [m.id, m]));
    const plan = ids.map((id) => ({ id, action: batchDeleteDecision(byId.get(id), me, scope, othersForBoth) }));
    const missing = plan.filter((p) => p.action === 'not-found').map((p) => p.id);
    if (missing.length > 0) return { kind: 'not-found', missing };
    const forbidden = plan.filter((p) => p.action === 'forbidden').map((p) => p.id);
    if (forbidden.length > 0) return { kind: 'forbidden', ids: forbidden };
    const todo = plan
      .filter((p) => p.action === 'hide' || p.action === 'tombstone')
      .map((p) => byId.get(p.id))
      .filter((m): m is MsgRow => !!m)
      .sort((a, b) => a.sortKey - b.sortKey);
    if (todo.length === 0) return { kind: 'ok', deliveries: [], changed: [], lastMessageAt: null };
    const todoIds = todo.map((m) => m.id);
    let lastMessageAt: string | null = null;
    // С2: «у меня» снимает мои закрепы этих сообщений, «у обоих» — закрепы у всех (как у удаления по одному).
    let unpinned: string[] = [];
    if (scope === 'me') {
      await tx
        .update(conversationMessages)
        .set({ hiddenFor: sql`array_append(${conversationMessages.hiddenFor}, ${me})` })
        .where(inArray(conversationMessages.id, todoIds));
      unpinned = await removePins(tx, todoIds, me);
    } else {
      // Надгробия — как у одиночного: текст, вложения и снимок «Переслано от» стираются (Р19 «без следа»).
      await tx
        .update(conversationMessages)
        .set({ deletedAt: new Date(), content: '', attachments: [], forwardedFrom: null, sticker: null, service: null, media: null, keyboard: null })
        .where(inArray(conversationMessages.id, todoIds));
      await tx.delete(conversationMessageReactions).where(inArray(conversationMessageReactions.messageId, todoIds));
      unpinned = (await removePins(tx, todoIds, null)).filter((id) => access.memberIds.includes(id));
      // Закрытые файлы — «удалено» в этой же транзакции (выдача сразу 404), сами файлы — после фиксации (Р19).
      const dead = await tx
        .update(attachments)
        .set({ state: 'deleted', deletedAt: new Date() })
        .where(and(inArray(attachments.messageId, todoIds), inArray(attachments.state, ['attached', 'remote'])))
        .returning({ key: attachments.storageKey });
      purge = dead.map((d) => d.key);
      // Время беседы — по последнему ОСТАВШЕМУСЯ, один раз на пачку; придержанное беседу не поднимало и здесь не считается.
      const [conv] = await tx
        .update(conversations)
        .set({
          lastMessageAt: sql`(SELECT max(created_at) FROM conversation_messages
            WHERE conversation_id = ${conversationId} AND NOT withheld AND deleted_at IS NULL)`,
        })
        .where(eq(conversations.id, conversationId))
        .returning({ at: conversations.lastMessageAt });
      lastMessageAt = conv?.at ? conv.at.toISOString() : null;
    }
    const entries = [
      ...todo.flatMap((m) =>
        msgEntries(
          changeAudience({
            action: scope === 'me' ? 'delete-me' : 'delete-both',
            actorId: me,
            memberIds: access.memberIds,
            withheld: m.withheld,
            blockedActor: new Set(),
          }),
          conversationId,
          m.id,
        ),
      ),
      // Списки закреплённого — после всех строк по сообщениям: событие со списком уходит последним.
      ...pinEntries(unpinned, conversationId),
    ];
    const nums = entryPts(entries, await journal(tx, entries));
    return {
      kind: 'ok',
      deliveries: withPinDeliveries(conversationId, todoIds, entries, nums),
      changed: todo.map((m) => ({ messageId: m.id, withheld: m.withheld, own: m.authorId === me })),
      lastMessageAt,
    };
  });
  // Файлы — только после фиксации и в фоне, как у одиночного удаления: зависшее хранилище не держит рассылку.
  if (purge.length > 0) void purgeDeleted(purge).catch(() => {});
  return res;
}

// ─── Очистить историю и удалить чат (07.10, #211, G01, признак `conv12`) ──────────────────────────────────────────────

export type ClearBatch = Extract<DeleteManyResult, { kind: 'ok' }>;

/**
 * «Очистить историю» беседы (`POST /conv/:id/clear`) и её часть в «Удалить чат»: вся переписка до ключа `upToKey`
 * (`null` — до последнего сообщения на момент вызова; пришедшее во время очистки не трогается) — обычным удалением пачками
 * (`deleteMessages`, по `MESSAGE_BATCH_MAX`), каждая — своей транзакцией. Что уходит, решает то же правило, что у
 * удаления пачкой (`convRules.batchDeleteDecision`): `me` — всё видимое мне прячется у меня; `both` — моё и чужое
 * (только 1:1, `othersDeletableForBoth`) становится надгробием у всех, а чужое, которое я уже спрятал «у меня»,
 * у собеседника остаётся (как у пачки). Собеседник на старом клиенте видит обычные события удаления (`dm.delete`).
 * Возвращает пачки — рассылку (новую и старую) делает вызывающий, как у `POST /conv/:id/messages/delete`.
 */
export async function clearHistory(
  me: string,
  access: ConvAccess,
  scope: 'me' | 'both',
  upToKey: number | null = null,
): Promise<ClearBatch[]> {
  const cid = access.conversationId;
  const [conv] = await db
    .select({ kind: conversations.kind, last: conversations.lastSortKey })
    .from(conversations)
    .where(eq(conversations.id, cid));
  if (!conv) return [];
  const bound = upToKey ?? toNum(conv.last);
  const othersForBoth = othersDeletableForBoth(conv.kind === 'direct' ? 'direct' : 'group');
  const out: ClearBatch[] = [];
  let after = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, cid),
          gt(conversationMessages.sortKey, after),
          lte(conversationMessages.sortKey, bound),
          isNull(conversationMessages.deletedAt),
          // Кандидаты сразу в запросе (у долгой беседы спрятанного «у меня» — тысячи): дошедшее до меня, а у `me` и у
          // чужого — ещё не спрятанное мной. Окончательно решает `batchDeleteDecision` ниже.
          or(eq(conversationMessages.withheld, false), eq(conversationMessages.authorId, me)),
          scope === 'me'
            ? sql`NOT (${me} = ANY(${conversationMessages.hiddenFor}))`
            : or(eq(conversationMessages.authorId, me), sql`NOT (${me} = ANY(${conversationMessages.hiddenFor}))`),
        ),
      )
      .orderBy(asc(conversationMessages.sortKey))
      .limit(MESSAGE_BATCH_MAX);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].sortKey;
    const ids = rows
      .filter((m) => {
        const a = batchDeleteDecision(m, me, scope, othersForBoth);
        return a === 'hide' || a === 'tombstone';
      })
      .map((m) => m.id);
    if (ids.length > 0) {
      const res = await deleteMessages(me, access, ids, scope, { othersForBoth: true });
      // Сообщение удалили между выборкой и пачкой (собеседник, другое моё устройство) — оно и так ушло; пачку не роняем.
      if (res.kind === 'ok') out.push(res);
    }
    if (rows.length < MESSAGE_BATCH_MAX) break;
  }
  return out;
}

export type HideResult = { kind: 'not-found' } | { kind: 'ok'; upToKey: number; delivery: Delivery };

/**
 * «Удалить чат» (`POST /conv/:id/hide`): убрать беседу из МОЕГО списка (`forBoth` в беседе 1:1 — и из списка собеседника),
 * пока не придёт новое сообщение (`clearedFromMe`). Метка — ключ порядка «сейчас» (`lockConversation`: следующее
 * сообщение получит ключ больше); закреп беседы снимается (иначе убранная занимала бы место в лимите закрепов). Журнал
 * каждому убравшему строкой `'conv'` — сводка придёт его устройствам как `ConvLeft`. Переписку до метки очищает
 * вызывающий (`clearHistory` с `upToKey`) — ПОСЛЕ этой транзакции: пришедшее между ними сообщение уже вернёт беседу.
 */
export async function hideConversation(me: string, access: ConvAccess, forBoth: boolean): Promise<HideResult> {
  const cid = access.conversationId;
  return db.transaction(async (tx): Promise<HideResult> => {
    const lock = await lockConversation(tx, cid);
    if (!lock) return { kind: 'not-found' };
    const upToKey = lock.nextKey - 1;
    const who = forBoth && othersDeletableForBoth(lock.kind) ? access.memberIds : [me];
    await tx
      .update(conversationMembers)
      .set({ hiddenKey: upToKey, pinnedAt: null })
      .where(and(eq(conversationMembers.conversationId, cid), inArray(conversationMembers.userId, who), isNull(conversationMembers.leftAt)));
    const pts = await journal(
      tx,
      who.map((userId) => ({ userId, conversationId: cid, kind: 'conv' as const, messageId: null })),
    );
    return { kind: 'ok', upToKey, delivery: { conversationId: cid, messageId: null, pts } };
  });
}

/**
 * «Удалить группу» у бывшей группы (08.10, `groups3`): только у меня, как «Удалить чат» (`hideConversation`), но строка
 * участника — уже вышедшего. Дальше бывшая группа приходит прежним «вышел» без `former`. `null` — я ей не бывший участник.
 */
export async function hideFormerGroup(me: string, conversationId: string): Promise<Delivery | null> {
  return db.transaction(async (tx) => {
    if (!(await formerLeftAt(conversationId, me, tx))) return null;
    const lock = await lockConversation(tx, conversationId);
    if (!lock) return null;
    await tx
      .update(conversationMembers)
      .set({ hiddenKey: lock.nextKey - 1, pinnedAt: null })
      .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me), isNotNull(conversationMembers.leftAt)));
    const pts = await journal(tx, [{ userId: me, conversationId, kind: 'conv' as const, messageId: null }]);
    return { conversationId, messageId: null, pts };
  });
}

// ─── Удаление аккаунта: снимки «Переслано от» (04.10, находка Codex к `conv5`) ──────────────────────────────────────

/**
 * Снимки «Переслано от» человека уже обезличены в базе — той же транзакцией, что и сам аккаунт
 * (`accountRows.anonymizeAccountRows`). Здесь участникам бесед с такими копиями сообщается, как о правке: строка журнала
 * `msg` на каждую живую копию, `Delivery` — для `deliverMany` у вызывающего. Без этого кеш клиента (IndexedDB) держал бы
 * прежнее имя: догонка приносит только сообщения из журнала, а уже загруженное окно ленты без события не перечитывается.
 * Аудитория — как у правки (`changeAudience`): придержанная копия — только её автору; удалённые аккаунты (и сам
 * обезличенный) строк журнала не получают. Надгробия пропускаются — их вид `gone` и так (а снимка у них с 04.10 нет
 * вовсе: удаление у обоих его стирает). Каждая беседа — своя
 * транзакция с обычным порядком замков писателей (беседа → журнал), поэтому зовётся ПОСЛЕ фиксации удаления аккаунта.
 */
export async function journalForwardedFrom(userId: string): Promise<Delivery[]> {
  const copies = await db
    .select({
      id: conversationMessages.id,
      conversationId: conversationMessages.conversationId,
      authorId: conversationMessages.authorId,
      withheld: conversationMessages.withheld,
      sortKey: conversationMessages.sortKey,
    })
    .from(conversationMessages)
    .where(and(sql`${conversationMessages.forwardedFrom}->>'userId' = ${userId}`, isNull(conversationMessages.deletedAt)));
  const byConv = new Map<string, typeof copies>();
  for (const c of copies) byConv.set(c.conversationId, [...(byConv.get(c.conversationId) ?? []), c]);
  const out: Delivery[] = [];
  for (const conversationId of [...byConv.keys()].sort()) {
    const list = (byConv.get(conversationId) ?? []).sort((a, b) => a.sortKey - b.sortKey);
    const deliveries = await db.transaction(async (tx): Promise<Delivery[]> => {
      if (!(await lockConversation(tx, conversationId))) return [];
      const members = (
        await tx
          .select({ userId: conversationMembers.userId })
          .from(conversationMembers)
          .innerJoin(users, eq(users.id, conversationMembers.userId))
          .where(
            and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt), isNull(users.deletedAt)),
          )
      ).map((r) => r.userId);
      const entries = list.flatMap((m) =>
        msgEntries(
          changeAudience({ action: 'edit', actorId: m.authorId, memberIds: members, withheld: m.withheld, blockedActor: new Set() }).filter(
            (id) => members.includes(id),
          ),
          conversationId,
          m.id,
        ),
      );
      if (entries.length === 0) return [];
      const nums = entryPts(entries, await journal(tx, entries));
      return batchDeliveries(conversationId, list.map((m) => m.id), entries, nums);
    });
    out.push(...deliveries);
  }
  return out;
}

// ─── Служебные выборки бесед ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Мои беседы (без вышедших и без ещё не показанных мне — `hiddenFromMe`, 05.10) — id, для сводки непрочитанного
 * (`unread.ts`): пустая беседа, открытая другим, до первого сообщения не считается.
 */
export async function myConversationIds(me: string): Promise<string[]> {
  const rows = await db
    .select({ id: conversationMembers.conversationId })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(
        eq(conversationMembers.userId, me),
        isNull(conversationMembers.leftAt),
        sql`NOT ${hiddenFromMe(me, sql`${conversationMembers.pending}`, sql`${conversationMembers.conversationId}`)}`,
        sql`NOT ${clearedFromMe(me, sql`${conversationMembers.hiddenKey}`, sql`${conversationMembers.conversationId}`)}`,
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Беседа уже показана человеку (`hiddenFromMe`, 05.10) — для «печатает» шлюза (`gatewayTyping.ts`): в беседу, которой у
 * получателя ещё нет в списке (её открыл другой, и ни одно сообщение до него не дошло), «печатает» не шлём — иначе он
 * узнал бы о беседе раньше первого сообщения, а от заблокированного — вообще узнал бы. Не участник — `false`.
 * Убранная получателем («Удалить чат», `conv12`, `clearedFromMe`) — тоже «нет», пока до него не дойдёт новое сообщение.
 */
export async function conversationShownTo(conversationId: string, userId: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT (${hiddenFromMe(userId, sql`m.pending`, sql`m.conversation_id`)}
      OR ${clearedFromMe(userId, sql`m.hidden_key`, sql`m.conversation_id`)}) AS hidden
    FROM conversation_members m WHERE m.conversation_id = ${conversationId} AND m.user_id = ${userId}`);
  const row = (res.rows as { hidden: unknown }[])[0];
  return !!row && row.hidden !== true;
}

/**
 * Непрочитанное человека по беседам: `id → число` (нули не кладутся). ОДНО правило на все места — сводка рейла
 * (`unread.ts`), события удаления — и то же, что `unreadSql`/`convRules.countsAsUnread`.
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

// ─── Рассылка ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * После фиксации: каждому, у кого вырос `pts`, — `conv.change` с его сводкой беседы и его видом сообщения, только на
 * соединения с `caps: ['conv1']`. Потерянное событие не страшно: журнал и есть очередь, клиент догонит по `pts`.
 * Беседа ещё не показана человеку (`hiddenFromMe`, 05.10) — события ему нет вовсе (не «вышел»: он в ней и не был): номер
 * он догонит, а в догонке её нет так же, как в списке.
 */
export async function deliver(d: Delivery | null): Promise<void> {
  if (!d) return;
  botUpdatesOf([d]);
  // ⚠️ Лениво: `realtime.ts` открывает Redis при ЗАГРУЗКЕ модуля. Статический импорт делал бы этот модуль (а с ним
  // `unread.ts`, `cleanup.ts` и любой тест на PGlite) держателем открытого Redis — так 30.09 висел `accountCleanup.itest`.
  const { publishToUser } = await import('./realtime.js');
  const rows = d.messageId ? await db.select().from(conversationMessages).where(eq(conversationMessages.id, d.messageId)) : [];
  // Группа (`groups1`): события — только соединениям, объявившим группы; старый клиент о ней не узнаёт.
  const [conv] = await db.select({ kind: conversations.kind }).from(conversations).where(eq(conversations.id, d.conversationId)).limit(1);
  const cap = conv?.kind === 'group' ? FEATURE_GROUPS1 : CAP_CONV1;
  // «Избранное» (`saved1`) — как группа: только соединениям с `groups1` (беседа 1:1 с ключом «я:я»).
  const capOut = cap === CAP_CONV1 && (await groupIdsAmong(db, [d.conversationId])).size > 0 ? FEATURE_GROUPS1 : cap;
  /**
   * Сводка беседы глазами человека; `null` — беседа ему ещё не показана (события нет). Аудит ЛС #236, п.12: `summariesFor`
   * тяжёлый, а один человек бывает в `pts`, `pinPts` и `schedPts` одной доставки — считаем раз на человека.
   */
  const summaries = new Map<string, Promise<ConvSummary | ConvLeft | undefined | null>>();
  const summaryOf = (userId: string): Promise<ConvSummary | ConvLeft | undefined | null> => {
    let p = summaries.get(userId);
    if (!p) {
      p = (async () => {
        const hidden = new Set<string>();
        const [summary] = await summariesFor(userId, [d.conversationId], db, hidden);
        return hidden.size > 0 ? null : summary;
      })();
      summaries.set(userId, p);
    }
    return p;
  };
  for (const [userId, pts] of d.pts) {
    const summary = await summaryOf(userId);
    if (summary === null) continue;
    const message = d.messageId ? (await messagesForViewer(rows, userId, db)).get(d.messageId) : undefined;
    await publishToUser(
      userId,
      {
        t: 'conv.change',
        pts,
        conversation: summary ?? { id: d.conversationId, left: true },
        ...(message ? { message } : {}),
        ...(d.created ? { created: true as const } : {}),
      },
      { cap: capOut },
    );
  }
  // С2: события со списком закреплённого — ПОСЛЕ событий по сообщению: номер у человека следующий за ними.
  for (const [userId, pts] of d.pinPts ?? []) {
    const summary = await summaryOf(userId);
    if (summary === null) continue;
    await publishToUser(userId, await pinsChange(userId, d.conversationId, pts, summary), { cap: capOut });
  }
  // С4: список отложенных — только автору и последним (отложенное ушло: сначала сообщение, затем список без него).
  for (const [userId, pts] of d.schedPts ?? []) {
    const summary = await summaryOf(userId);
    if (summary === null) continue;
    await publishToUser(userId, await scheduledChange(userId, d.conversationId, pts, summary), { cap: capOut });
  }
}

/** `conv.change` со списком отложенных (С4): сводка беседы, без сообщения, список МОИХ отложенных — целиком. */
async function scheduledChange(
  userId: string,
  conversationId: string,
  pts: number,
  summary: ConvSummary | ConvLeft | undefined,
): Promise<GatewayServerMessage> {
  return {
    t: 'conv.change',
    pts,
    conversation: summary ?? { id: conversationId, left: true },
    scheduled: await scheduledFor(userId, conversationId, db),
  };
}

/** `conv.change` со списком закреплённого (С2): сводка беседы, без сообщения, список — целиком глазами получателя. */
async function pinsChange(
  userId: string,
  conversationId: string,
  pts: number,
  summary: ConvSummary | ConvLeft | undefined,
): Promise<GatewayServerMessage> {
  return {
    t: 'conv.change',
    pts,
    conversation: summary ?? { id: conversationId, left: true },
    pins: await pinsFor(userId, conversationId, db),
  };
}

/**
 * Рассылка пачки (`conv5`: пересылка, удаление выделенного) — то же, что `deliver` на каждое сообщение по порядку, но
 * сводка и виды сообщений читаются один раз на человека, а не на каждое сообщение. События одного человека уходят в
 * порядке пачки — номера `pts` у него подряд, клиент применяет их как обычные. Сводка в каждом — уже итоговая (как и у
 * `deliver`, вид может быть новее номера события: свежесть клиент держит по номерам).
 */
/**
 * Боты (#229): крючки, а не импорт — модуль ботов тянет Redis и маршруты Bot API, а этот модуль живёт и без них (тесты на
 * PGlite). Подключает `routes/botApi.ts` при регистрации; без крючков бесед с ботами просто нет событий для ботов.
 * - `record` — те же записи, что уходят людям, → события в журнал бота-участника (`bots/botUpdates.ts`);
 * - `chatMember` — человек открыл беседу с ботом / удалил её (`routes/conv.ts`);
 * - `enabled` — боты включены на инстансе (настройка читается в момент вызова; `q` — текущая транзакция, если она есть).
 */
/** Статус человека в беседе с ботом: открыл (`member`), удалил у себя (`left`), заблокировал бота (`kicked`, аудит 26.10). */
export type BotChatStatus = 'member' | 'left' | 'kicked';
export interface BotConvHooks {
  record(ds: readonly Delivery[]): Promise<void>;
  chatMember(botId: string, humanId: string, conversationId: string, status: BotChatStatus, old?: BotChatStatus): Promise<void>;
  enabled(q?: Q): Promise<boolean>;
}
let botConvHooks: BotConvHooks | null = null;
export function configureBotConv(hooks: BotConvHooks | null): void {
  botConvHooks = hooks;
}
export function botConv(): BotConvHooks | null {
  return botConvHooks;
}

/**
 * Очередь журнала ботов по беседам (аудит 26.10): `record` идёт в фоне, и две записи подряд (сообщение → правка) без очереди
 * могли лечь в журнал бота в обратном порядке — `update_id` раньше у правки. Цепочка обещаний на беседу (в беседе 1:1 бот
 * один, так что это очередь на бота в этой беседе): следующая запись ждёт прошлую. Пачка из нескольких бесед ждёт хвосты
 * всех своих. Хвост снимается, когда очередь беседы опустела.
 */
const botChains = new Map<string, Promise<void>>();
function enqueueBot(conversationIds: readonly string[], job: () => Promise<void>): void {
  const keys = [...new Set(conversationIds)];
  const prev = Promise.all(keys.map((k) => botChains.get(k)));
  const run = prev.then(job).catch((err) => console.warn('[bots] журнал событий:', err instanceof Error ? err.message : err));
  for (const k of keys) botChains.set(k, run);
  void run.finally(() => {
    for (const k of keys) if (botChains.get(k) === run) botChains.delete(k);
  });
}

/** В фоне: сбой журнала бота не мешает рассылке людям. По порядку вызовов в каждой беседе (`enqueueBot`). */
function botUpdatesOf(ds: readonly Delivery[]): void {
  const hooks = botConvHooks;
  if (!hooks) return;
  enqueueBot(
    ds.map((d) => d.conversationId),
    () => hooks.record(ds),
  );
}

/**
 * `my_chat_member` (человек открыл / удалил у себя / заблокировал / разблокировал беседу с ботом) — в ту же очередь беседы,
 * что и сообщения: «открыл» встаёт в журнал раньше первого сообщения. Для маршрутов (`routes/conv.ts`, `routes/blocks.ts`).
 */
export function queueBotChatMember(botId: string, humanId: string, conversationId: string, status: BotChatStatus, old?: BotChatStatus): void {
  const hooks = botConvHooks;
  if (!hooks) return;
  enqueueBot([conversationId], () => hooks.chatMember(botId, humanId, conversationId, status, old));
}

export async function deliverMany(list: readonly (Delivery | null)[]): Promise<void> {
  const ds = list.filter((d): d is Delivery => d !== null);
  if (ds.length === 0) return;
  botUpdatesOf(ds);
  // ⚠️ Лениво, как в `deliver`: `realtime.ts` открывает Redis при загрузке модуля.
  const { publishToUser } = await import('./realtime.js');
  const ids = [...new Set(ds.flatMap((d) => (d.messageId ? [d.messageId] : [])))];
  const rows = ids.length ? await db.select().from(conversationMessages).where(inArray(conversationMessages.id, ids)) : [];
  // Группы (`groups1`) — только соединениям, объявившим группы, как в `deliver`.
  const groupIds = await groupIdsAmong(db, [...new Set(ds.map((d) => d.conversationId))]);
  const people = [
    ...new Set(
      ds.flatMap((d) => [...d.pts.keys(), ...(d.pinPts ? [...d.pinPts.keys()] : []), ...(d.schedPts ? [...d.schedPts.keys()] : [])]),
    ),
  ];
  for (const userId of people) {
    const mine = ds.filter((d) => d.pts.has(userId) || !!d.pinPts?.has(userId) || !!d.schedPts?.has(userId));
    const convIds = [...new Set(mine.map((d) => d.conversationId))];
    const hidden = new Set<string>();
    const summaries = new Map((await summariesFor(userId, convIds, db, hidden)).map((s) => [s.id, s]));
    const wanted = new Set(mine.flatMap((d) => (d.messageId && d.pts.has(userId) ? [d.messageId] : [])));
    const views = await messagesForViewer(rows.filter((r) => wanted.has(r.id)), userId, db);
    for (const d of mine) {
      // Беседа ещё не показана человеку (05.10) — событий по ней нет, как в `deliver`.
      if (hidden.has(d.conversationId)) continue;
      if (d.pts.has(userId)) {
        const message = d.messageId ? views.get(d.messageId) : undefined;
        await publishToUser(
          userId,
          {
            t: 'conv.change',
            pts: d.pts.get(userId) ?? 0,
            conversation: summaries.get(d.conversationId) ?? { id: d.conversationId, left: true },
            ...(message ? { message } : {}),
            ...(d.created ? { created: true as const } : {}),
          },
          { cap: groupIds.has(d.conversationId) ? FEATURE_GROUPS1 : CAP_CONV1 },
        );
      }
      // С2: событие со списком закреплённого — после события по сообщению этой же записи (`withPinDeliveries`).
      const pinPts = d.pinPts?.get(userId);
      if (pinPts !== undefined) {
        await publishToUser(userId, await pinsChange(userId, d.conversationId, pinPts, summaries.get(d.conversationId)), {
          cap: groupIds.has(d.conversationId) ? FEATURE_GROUPS1 : CAP_CONV1,
        });
      }
      // С4: список отложенных — последним, как у `deliver`.
      const schedPts = d.schedPts?.get(userId);
      if (schedPts !== undefined) {
        await publishToUser(userId, await scheduledChange(userId, d.conversationId, schedPts, summaries.get(d.conversationId)), {
          cap: groupIds.has(d.conversationId) ? FEATURE_GROUPS1 : CAP_CONV1,
        });
      }
    }
  }
}

// ─── Геопозиция и контакт (14.10, G69, `geocontact1`; провод — `dmmedia1`) ──────────────────────────────────────────────
// Правила вида и подписи — `shared/convMedia.ts`. Здесь — то, что ходит в базу: снимок карточки контакта и разбор провода.
// Видимость контакта: человек есть и не удалён (кого ещё можно — решение за владельцем, G69).

type MediaQ = typeof db | Tx;

/** Как мы знаем инстанс соседа (домен и название по связке); связки нет — пусто. */
async function mediaHomeLabel(q: MediaQ, instanceId: string): Promise<{ domain: string | null; name: string | null }> {
  const [l] = await q
    .select({ domain: federationLinks.domain, theirName: federationLinks.theirName, localName: federationLinks.localName })
    .from(federationLinks)
    .where(eq(federationLinks.instanceId, instanceId))
    .limit(1);
  return { domain: l?.domain ?? null, name: (l?.localName ?? l?.theirName ?? '').trim() || null };
}

const mediaUserCols = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  avatarUrl: users.avatarUrl,
  homeInstanceId: users.homeInstanceId,
  homeUserId: users.homeUserId,
  homeUsername: users.homeUsername,
  deletedAt: users.deletedAt,
};

/** Снимок карточки контакта по строке человека (своей или теневой строке соседа). */
async function contactSnapshot(
  q: MediaQ,
  u: { id: string; username: string; displayName: string; avatarUrl: string | null; homeInstanceId: string | null; homeUserId: string | null; homeUsername: string | null },
): Promise<ConvContactMedia> {
  const home = u.homeInstanceId ? { instanceId: u.homeInstanceId, userId: u.homeUserId ?? u.id, ...(await mediaHomeLabel(q, u.homeInstanceId)) } : null;
  return {
    kind: 'contact',
    userId: u.id,
    // Человек соседа — его логин на доме, как у собеседников между инстансами (`otherUser`).
    username: (u.homeInstanceId ? u.homeUsername : null) || u.username,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    ...(home ? { home } : {}),
  };
}

/**
 * Вид сообщения из тела отправки (`routes/conv.ts`): геопозиция — по диапазонам, контакт — СНИМКОМ из базы (клиенту не верим).
 * `bad-geo` — координаты вне диапазона, `no-contact` — человека нет или он удалён.
 */
export async function resolveConvMedia(input: ConvMediaInput): Promise<ConvMediaMark | 'bad-geo' | 'no-contact' | { pollError: string }> {
  if (input.kind === 'geo') return geoMedia(input.lat, input.lon, input.accuracy ?? null) ?? 'bad-geo';
  // Трансляция геопозиции (`geolive1`): срок только из списка (15 мин / 1 ч / 8 ч), начало и конец ставит сервер.
  if (input.kind === 'geolive') return geoLiveStart(input, Date.now()) ?? 'bad-geo';
  // Опрос (`convpoll1`): черновик — общей проверкой формы и сервера (`shared/convPoll.ts`).
  if (input.kind === 'poll') {
    const d = convPollDraft(input);
    return d.ok ? d.poll : { pollError: d.error };
  }
  const [u] = await db.select(mediaUserCols).from(users).where(eq(users.id, input.userId)).limit(1);
  if (!u || u.deletedAt) return 'no-contact';
  return contactSnapshot(db, u);
}

/**
 * Провод соседа → вид сообщения копии (`federation/convAccept.ts`). Контакт ищется у нас: личность с нашим id — своя строка;
 * человек другого инстанса — теневая строка с этим домом; не нашли — карточка без перехода (`userId: null`), подпись из провода.
 */
export async function convMediaFromWire(q: MediaQ, w: FedConvMediaWire, selfInstanceId: string): Promise<ConvMediaMark> {
  if (w.kind === 'geo') return { kind: 'geo', lat: w.lat, lon: w.lon, accuracy: w.accuracy };
  // Опрос (`dmpoll1`): хранимая форма, как у местного (`convPollDraft`): нулевые итоги, правильный ответ и пояснение викторины —
  // голоса живут строками `conv_poll_votes` (свои и зеркало соседа), вид смотрящему считает выдача (`convPollView`).
  if (w.kind === 'poll') {
    return {
      kind: 'poll',
      question: w.question,
      options: w.options.map((o) => ({ id: o.id, text: o.text, votes: 0 })),
      anonymous: w.anonymous,
      multi: w.multi,
      quiz: w.quiz,
      closed: w.closed,
      voters: 0,
      my: [],
      revealed: false,
      ...(w.quiz ? { correct: w.correct, solution: w.solution } : {}),
    };
  }
  const ours = w.person.instanceId === selfInstanceId;
  const [u] = await q
    .select(mediaUserCols)
    .from(users)
    .where(
      ours
        ? and(eq(users.id, w.person.userId), isNull(users.homeInstanceId))
        : and(eq(users.homeInstanceId, w.person.instanceId), eq(users.homeUserId, w.person.userId)),
    )
    .limit(1);
  if (u && !u.deletedAt) return contactSnapshot(q, u);
  return {
    kind: 'contact',
    userId: null,
    username: w.username,
    displayName: w.name,
    avatarUrl: w.avatarUrl,
    ...(ours ? {} : { home: { instanceId: w.person.instanceId, userId: w.person.userId, ...(await mediaHomeLabel(q, w.person.instanceId)) } }),
  };
}

/**
 * В беседе есть человек другого инстанса (14.10, опрос `convpoll1`): группа живёт у другого хоста (`origin_instance_id`) или среди
 * участников (и бывших — их копии у соседа живут дальше) есть теневая строка. Опрос в такую беседу — только если все её чужие дома
 * объявили `dmpoll1` (`convPollFederates`); иначе — 403 / пересылка запасным текстом.
 */
export async function convHasRemote(q: Q, conversationId: string): Promise<boolean> {
  const [c] = await q.select({ origin: conversations.originInstanceId }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (c?.origin) return true;
  const [m] = await q
    .select({ id: users.id })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(and(eq(conversationMembers.conversationId, conversationId), isNotNull(users.homeInstanceId)))
    .limit(1);
  return !!m;
}

/**
 * Опрос в беседе с людьми других инстансов (`dmpoll1`, 14.10): можно, только если журнал на связку пишется (`FEDERATION_DM_ENABLED`,
 * крючок `record`) и КАЖДЫЙ чужой дом беседы — хост группы и дома участников, включая бывших (их копии живут дальше), — объявил
 * `dmpoll1` в своей визитке (`federation_links.features`). Хоть один дом без признака — его копия была бы текстом, а голоса его людей
 * не доехали бы: опрос не создаётся (403 `conv_poll_federated`, как до признака) и пересылается запасным текстом.
 */
export async function convPollFederates(q: Q, conversationId: string): Promise<boolean> {
  if (!fedHooks?.record) return false;
  const [c] = await q.select({ origin: conversations.originInstanceId }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  const homes = new Set<string>(c?.origin ? [c.origin] : []);
  const rows = await q
    .selectDistinct({ home: users.homeInstanceId })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(and(eq(conversationMembers.conversationId, conversationId), isNotNull(users.homeInstanceId)));
  for (const r of rows) if (r.home) homes.add(r.home);
  if (homes.size === 0) return true;
  const links = await q
    .select({ instanceId: federationLinks.instanceId, features: federationLinks.features })
    .from(federationLinks)
    .where(inArray(federationLinks.instanceId, [...homes]));
  return [...homes].every((h) => links.some((l) => l.instanceId === h && l.features.includes(FED_FEATURES.dmpoll1)));
}

/** Опрос (`dmpoll1`): дома из списка, объявившие признак в визитке (`federation_links.features`) — для `ConvSummary.fedPoll`. */
async function homesWithPolls(q: Q, homes: readonly string[]): Promise<Set<string>> {
  const links = await q
    .select({ instanceId: federationLinks.instanceId, features: federationLinks.features })
    .from(federationLinks)
    .where(inArray(federationLinks.instanceId, [...homes]));
  return new Set(links.filter((l) => l.features.includes(FED_FEATURES.dmpoll1)).map((l) => l.instanceId));
}
