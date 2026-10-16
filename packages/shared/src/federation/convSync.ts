/**
 * ЛС между инстансами, этап Э2 (#141, `docs/dm/FEDERATION.md` §3.2–3.4): провод «прочих» записей журнала на связку —
 * реакции, «прочитано до», закреп «у обоих» — и звонок в дверь `conv.changed`.
 *
 * 🔴 Каждая запись — ТЕКУЩЕЕ состояние того, чем владеет отдающий дом (его людей), а не действие: три клика по реакции
 * сворачиваются в итог, потерянная строка журнала лечится следующей. Получатель заменяет у себя только записи людей
 * отдающего инстанса; своё от соседа не принимает (§3.2). Разбор — терпимый: незнакомые поля молча, негодная запись
 * внутри списка выбрасывается по одной, негодный конверт — `null`.
 *
 * ЧИСТЫЙ модуль (без ввода-вывода). Исторические примеры — `fixtures/v1/conv-changes-page-e2.json`, `event-conv-changed.json`.
 */
import { fedId } from './fieldRules';
import { parsePersonRef, serializePersonRef, type FedConvChange, type FedPersonRef } from './convWire';

/** Новые виды строк журнала Э2 (рядом с `FED_CONV_CHANGE` Э0: `msg`/`conv`/`pin`/`read`). */
export const FED_CONV_CHANGE_E2 = {
  /** Реакции людей отдающего дома на одно сообщение (`entity_id` = id сообщения). */
  react: 'react',
  /**
   * Э3 часть 3: «прослушано» голосового/кружка людьми отдающего дома (`entity_id` = id сообщения). Старый сосед строку
   * незнакомого вида пропускает — у его автора просто не загорится «прослушано», как до Э3.
   */
  listen: 'listen',
  /**
   * Опрос (признак связки `dmpoll1`): голоса людей отдающего дома в опросе (`entity_id` = id сообщения-опроса), ТЕКУЩЕЕ
   * состояние — отмена голоса = человек пропал из списка. Только соседу с `dmpoll1` (`KIND_FEATURE`): у старого опрос — текст.
   */
  vote: 'pollvote',
} as const;

/** Звонок в дверь: «в моём журнале для тебя есть новое до номера `seq`» — сосед забирает `GET /fed/v1/conv/changes`. */
export const FED_CONV_CHANGED_EVENT = 'conv.changed';

/** Ф9 (решение владельца 12.10): опоздание больше пяти минут — пометка «отправлено в ЧЧ:ММ, доставлено позже». */
export const FED_DM_LATE_MS = 5 * 60_000;

/**
 * Опоздало ли сообщение: момент прихода к нам (мс) позже отправки на доме автора больше чем на `FED_DM_LATE_MS`.
 * Часы двух инстансов расходятся на секунды — порог в минутах это поглощает; отрицательная разница (часы автора спешат) —
 * не опоздание.
 */
export function deliveredLate(createdAtMs: number, arrivedAtMs: number): boolean {
  return Number.isFinite(createdAtMs) && Number.isFinite(arrivedAtMs) && arrivedAtMs - createdAtMs > FED_DM_LATE_MS;
}

const EMOJI_MAX = 64;
const LIST_MAX = 200;

// ─── Реакции (`react`) ───────────────────────────────────────────────────────────────────────────────────────────────

export interface FedConvReactionsWire {
  messageId: string;
  /** Все текущие реакции людей отдающего дома на это сообщение; пусто — все сняты. */
  reactions: { user: FedPersonRef; emoji: string }[];
}

export function serializeConvReactionsWire(r: FedConvReactionsWire): Record<string, unknown> {
  return {
    message_id: r.messageId,
    reactions: r.reactions.map((x) => ({ user: serializePersonRef(x.user), emoji: x.emoji })),
  };
}

export function parseConvReactionsWire(raw: unknown): FedConvReactionsWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const messageId = fedId(r.message_id);
  if (!messageId || !Array.isArray(r.reactions)) return null;
  const reactions: FedConvReactionsWire['reactions'] = [];
  for (const it of r.reactions.slice(0, LIST_MAX)) {
    if (!it || typeof it !== 'object') continue;
    const i = it as Record<string, unknown>;
    const user = parsePersonRef(i.user);
    const emoji = typeof i.emoji === 'string' && i.emoji.length > 0 && i.emoji.length <= EMOJI_MAX ? i.emoji : null;
    if (user && emoji) reactions.push({ user, emoji });
  }
  return { messageId, reactions };
}

// ─── «Прочитано до» (`read`) ─────────────────────────────────────────────────────────────────────────────────────────

export interface FedConvReadsWire {
  /** Для каждого человека отдающего дома в беседе — последнее прочитанное сообщение (id, не ключ: ключи у домов свои). */
  reads: { user: FedPersonRef; messageId: string }[];
}

export function serializeConvReadsWire(r: FedConvReadsWire): Record<string, unknown> {
  return { reads: r.reads.map((x) => ({ user: serializePersonRef(x.user), message_id: x.messageId })) };
}

export function parseConvReadsWire(raw: unknown): FedConvReadsWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.reads)) return null;
  const reads: FedConvReadsWire['reads'] = [];
  for (const it of r.reads.slice(0, LIST_MAX)) {
    if (!it || typeof it !== 'object') continue;
    const i = it as Record<string, unknown>;
    const user = parsePersonRef(i.user);
    const messageId = fedId(i.message_id);
    if (user && messageId) reads.push({ user, messageId });
  }
  return { reads };
}

// ─── Закреп «у обоих» (`pin`) ────────────────────────────────────────────────────────────────────────────────────────

export interface FedConvPinWire {
  messageId: string;
  /** Закреплено ли сообщение «у обоих» на доме отдающего (у человека получателя там есть строка закрепа). */
  pinned: boolean;
  /** Кто закрепил (человек отдающего дома); у снятого — `null`. */
  by: FedPersonRef | null;
}

export function serializeConvPinWire(p: FedConvPinWire): Record<string, unknown> {
  return { message_id: p.messageId, pinned: p.pinned, by: p.by ? serializePersonRef(p.by) : null };
}

export function parseConvPinWire(raw: unknown): FedConvPinWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const messageId = fedId(r.message_id);
  if (!messageId || typeof r.pinned !== 'boolean') return null;
  return { messageId, pinned: r.pinned, by: r.pinned ? parsePersonRef(r.by) : null };
}

// ─── «Прослушано» голосового или кружка (`listen`, Э3 часть 3) ──────────────────────────────────────────────────────

export interface FedConvListenWire {
  messageId: string;
  /**
   * Все люди отдающего дома, прослушавшие это сообщение (строки `conversation_voice_listens`); текущее состояние, не
   * действие. Отменить «прослушано» нельзя, но получатель всё равно заменяет строки людей этого дома целиком.
   */
  listeners: FedPersonRef[];
  /**
   * «Один раз» (`once`, признак `dm2once`) у копии отдающего дома уже потрачено (`once_spent_at`): копия стёрта, автор гасит
   * оригинал у себя. Просто «прослушано» (воспроизведение началось) оригинал не трогает — копия у слушателя ещё играет.
   * В проводе ключ есть только со значением `true`.
   */
  spent?: boolean;
}

export function serializeConvListenWire(l: FedConvListenWire): Record<string, unknown> {
  return { message_id: l.messageId, listeners: l.listeners.map((u) => serializePersonRef(u)), ...(l.spent ? { spent: true } : {}) };
}

export function parseConvListenWire(raw: unknown): FedConvListenWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const messageId = fedId(r.message_id);
  if (!messageId || !Array.isArray(r.listeners)) return null;
  const listeners: FedPersonRef[] = [];
  for (const it of r.listeners.slice(0, LIST_MAX)) {
    const u = parsePersonRef(it);
    if (u) listeners.push(u);
  }
  return { messageId, listeners, ...(r.spent === true ? { spent: true } : {}) };
}

// ─── Голоса в опросе (`pollvote`, признак `dmpoll1`) ─────────────────────────────────────────────────────────────────

/** Вариантов у опроса не больше десяти (`CONV_POLL_LIMITS.maxOptions`), id варианта — короткая строка («0»…«9»). */
const POLL_OPTIONS_MAX = 10;
const POLL_OPTION_ID_MAX = 8;

export interface FedConvPollVotesWire {
  messageId: string;
  /**
   * Все голоса людей отдающего дома (у хоста группы — и людей третьих домов) в этом опросе: человек и отмеченные им варианты.
   * Не голосовал / отменил голос — его в списке нет; пусто — голосов этого дома нет. Получатель заменяет ими голоса тех же людей.
   */
  voters: { user: FedPersonRef; options: string[] }[];
}

export function serializeConvPollVotesWire(v: FedConvPollVotesWire): Record<string, unknown> {
  return { message_id: v.messageId, voters: v.voters.map((x) => ({ user: serializePersonRef(x.user), options: x.options })) };
}

export function parseConvPollVotesWire(raw: unknown): FedConvPollVotesWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const messageId = fedId(r.message_id);
  if (!messageId || !Array.isArray(r.voters)) return null;
  const voters: FedConvPollVotesWire['voters'] = [];
  for (const it of r.voters.slice(0, LIST_MAX)) {
    if (!it || typeof it !== 'object') continue;
    const i = it as Record<string, unknown>;
    const user = parsePersonRef(i.user);
    if (!user || !Array.isArray(i.options)) continue;
    const options = [
      ...new Set(
        i.options
          .slice(0, POLL_OPTIONS_MAX)
          .filter((o): o is string => typeof o === 'string' && o.length > 0 && o.length <= POLL_OPTION_ID_MAX),
      ),
    ];
    if (options.length > 0) voters.push({ user, options });
  }
  return { messageId, voters };
}

// ─── Звонок в дверь ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Нагрузка `conv.changed`: номер последней строки журнала для получателя на момент звонка. */
export function parseConvChangedPayload(raw: unknown): { seq: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const seq = (raw as Record<string, unknown>).seq;
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? { seq } : null;
}

// ─── Полный проход (`GET /fed/v1/conv/:id/export`, Э2 часть Б) ───────────────────────────────────────────────────────

/**
 * Полный проход по одной общей беседе — когда журнал на связку обрезан (`reset`, Ф12: 30 дней) или связку завели заново.
 * Отдающий дом отдаёт ТЕКУЩЕЕ состояние своих записей (как журнал, §3.2) страницами по порядку беседы: сообщения своих
 * людей (и надгробия чужих, Ф8), реакции своих людей на каждое сообщение страницы, на последней странице — «прочитано до»
 * и закрепы «у обоих». Строки — тех же видов и в том же проводе, что в журнале: получатель применяет их тем же приёмом.
 * `after` — id последнего сообщения прошлой страницы (ключи порядка у домов свои), `next` — курсор следующей; `null` — всё.
 */
export function fedConvExportPath(conversationId: string): string {
  return `/fed/v1/conv/${encodeURIComponent(conversationId)}/export`;
}

/** Сообщений на страницу полного прохода (строк — до двух на сообщение плюс хвост последней страницы). */
export const FED_CONV_EXPORT_MESSAGES = 100;
const EXPORT_ITEMS_MAX = FED_CONV_EXPORT_MESSAGES * 2 + LIST_MAX + 1;

export interface FedConvExportPage {
  instanceId: string;
  conversationId: string;
  next: string | null;
  /** Строки без номера журнала (`seq` = 0): порядок — порядок применения. */
  items: FedConvChange[];
  /**
   * Хвост Э7 (14.10, группы, добавление `marks_complete`): отметки этой страницы ПОЛНЫЕ — у каждого неудалённого сообщения окна, где
   * у владельцев отдающего дома есть реакция / закреп «для всех» / «прослушано» / голос в опросе (`pollvote`, `dmpoll1`), строка есть
   * (на этой странице или следующей).
   * Получил на ВСЕХ страницах беседы до последней — получатель снимает такие отметки владельцев отдающего дома, которых в выгрузке
   * не было (снятые за время разрыва). Нет поля (старый дом или отметки не отдавались) — ничего не снимается.
   */
  marksComplete?: true;
}

export function serializeConvExportPage(p: FedConvExportPage): Record<string, unknown> {
  return {
    instance_id: p.instanceId,
    conversation_id: p.conversationId,
    next: p.next,
    items: p.items.map((i) => ({ kind: i.kind, entity_id: i.entityId, entity: i.entity })),
    ...(p.marksComplete ? { marks_complete: true } : {}),
  };
}

export function parseConvExportPage(raw: unknown): FedConvExportPage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const instanceId = fedId(r.instance_id);
  const conversationId = fedId(r.conversation_id);
  if (!instanceId || !conversationId || !Array.isArray(r.items)) return null;
  const next = r.next === null || r.next === undefined ? null : fedId(r.next);
  if (r.next !== null && r.next !== undefined && !next) return null;
  const items: FedConvChange[] = [];
  for (const it of r.items.slice(0, EXPORT_ITEMS_MAX)) {
    if (!it || typeof it !== 'object') continue;
    const i = it as Record<string, unknown>;
    const kind = typeof i.kind === 'string' && i.kind.length > 0 && i.kind.length <= 32 ? i.kind : null;
    if (!kind) continue;
    items.push({
      seq: 0,
      kind,
      conversationId,
      entityId: fedId(i.entity_id),
      entity: i.entity && typeof i.entity === 'object' ? (i.entity as Record<string, unknown>) : null,
    });
  }
  return { instanceId, conversationId, next, items, ...(r.marks_complete === true ? { marksComplete: true as const } : {}) };
}
