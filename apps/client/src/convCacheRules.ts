import type { ConvMessage, ConvSummary } from '@gusvoice/shared';
import { compareConv, emptyConvState, type ConvState } from './convSyncRules';
import type { PersistedOutboxItem } from './outboxRules';
import type { FeedPlace } from './feedWindowRules';

/**
 * ЛС, этап 2 (шаг 2б): кеш бесед на диске — чистые правила (`docs/dm/STAGE2.md`, «Кеш на диске и первый кадр»).
 * Хранилище (IndexedDB) — `convCache.ts`, запись по изменениям стора — `convCacheWriter.ts`.
 *
 * Одна запись на `инстанс|человек`: список бесед, хвосты открывавшихся лент и номер журнала, по который всё это верно, —
 * одной записью, поэтому после перезапуска клиент догоняет ровно с этого номера и ничего не теряет между «снимок
 * записан» и «номер записан».
 */

/** Версия схемы записи: другая — запись выбрасывается, а не переводится. */
export const CONV_CACHE_SCHEMA = 1;
/** Сколько последних сообщений беседы кладём: столько же приносит первая порция после запуска — ссылки обновятся все. */
export const CACHE_MESSAGES = 50;
/** Лент в записи не больше — самые свежие по последнему сообщению. */
export const CACHE_WINDOWS = 20;
/** Сколько id удалённых помнить (чтобы опоздавшее событие не вернуло их после перезапуска). */
export const CACHE_GONE = 500;

export interface ConvCacheRecord {
  v: number;
  pts: number;
  savedAt: number;
  summaries: ConvSummary[];
  /** Хвосты лент по беседе, старые сверху; у закрытых вложений ссылки вырезаны. */
  messages: Record<string, ConvMessage[]>;
  gone: string[];
  /** Исходящие, ещё не ушедшие (шаг 2в), — без самих файлов. Необязательное: записи 2б его не несут. */
  outbox?: PersistedOutboxItem[];
  /** Черновики на этом устройстве (шаг 2д). Необязательное. */
  drafts?: Record<string, { text: string; replyToId: string | null }>;
  /** Места в беседах (шаг 2г): где человек ушёл, если не снизу. */
  places?: Record<string, FeedPlace>;
  /** Беседы с черновиком, ещё не записанным на сервер (Р7): после перезапуска уходят, и пришедшее их не затирает. */
  draftDirty?: string[];
}

/**
 * Ключ записи. Инстанс — его федеративный id, а без него — адрес API (веб без реестра, соседи без федерации); НЕ
 * локальный id записи реестра и НЕ `activeInstanceId()` на лету: вкладка живёт долго, а другая вкладка могла уже
 * переключить реестр. Человек — `userId`: другой аккаунт того же инстанса — другая запись.
 */
export function convCacheKey(instance: { federationInstanceId?: string | null; apiUrl?: string | null } | null, fallbackApi: string, userId: string): string {
  const inst = instance?.federationInstanceId || instance?.apiUrl || fallbackApi;
  return `${convCacheInstancePart(inst)}|${userId}`;
}

type RegistryEntry = { federationInstanceId?: string | null; apiUrl?: string | null; userId?: string | null };

/**
 * Что стереть из кеша, когда записи реестра убраны (удаление сервера, «Отмена» на входе в только что добавленный).
 * Все записи сервера (по префиксу) — только если в реестре не осталось другой записи ЭТОГО ЖЕ сервера: иначе у двух
 * записей одного сервера префикс общий, и удаление лишней стёрло бы черновики и неотправленное основного аккаунта.
 * Тогда — только запись человека удалённой записи, и то если его же аккаунт не остался в другой.
 */
export function cacheWipeOnRemove(
  removed: readonly RegistryEntry[],
  remaining: readonly RegistryEntry[],
): { instances: string[]; keys: string[] } {
  const partOf = (e: RegistryEntry) => convCacheInstancePart(e.federationInstanceId || e.apiUrl || '');
  const instances: string[] = [];
  const keys: string[] = [];
  for (const e of removed) {
    const inst = e.federationInstanceId || e.apiUrl;
    if (!inst) continue;
    const same = remaining.filter((r) => partOf(r) === partOf(e));
    if (same.length === 0) instances.push(inst);
    else if (e.userId && !same.some((r) => r.userId === e.userId)) keys.push(convCacheKey(e, inst, e.userId));
  }
  return { instances, keys };
}

/** Часть ключа про инстанс — по ней при удалении инстанса из реестра стираются все его записи. */
export function convCacheInstancePart(inst: string): string {
  return inst.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Ссылку на закрытый файл ЛС кешировать нельзя (`/api/att/<id>/<смотрящий>/<подпись>`): она своя у каждого смотрящего,
 * гаснет со сменой поколения токенов и сама по себе даёт доступ к файлу. В кеш идёт вложение без ссылки — с `id`,
 * размерами и огибающей; лента рисует на его месте заглушку, настоящую ссылку приносит свежая порция.
 * Старые публичные вложения (без `id`) — как есть.
 * Миниатюра в цитате (05.10, `MessageReplyPreview.thumb`) — такая же ссылка смотрящего на файл: в кеш цитата идёт без
 * неё (на её месте значок фото), вид и подпись цитаты остаются.
 */
export function stripAttachmentUrls(m: ConvMessage): ConvMessage {
  const files = m.attachments.some((a) => a.id);
  const quote = m.replyTo && m.replyTo.thumb !== undefined ? m.replyTo : null;
  if (!files && !quote) return m;
  let out: ConvMessage = files ? { ...m, attachments: m.attachments.map((a) => (a.id ? { ...a, url: '' } : a)) } : m;
  if (quote) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { thumb, ...replyTo } = quote;
    out = { ...out, replyTo };
  }
  return out;
}

/** Снимок для записи. `null` — списка ещё нет (номер неизвестен), писать нечего. */
export function buildRecord(
  conv: ConvState,
  messages: Record<string, readonly ConvMessage[] | undefined>,
  now: number,
  outbox: PersistedOutboxItem[] = [],
  drafts: Record<string, { text: string; replyToId: string | null }> = {},
  places: Record<string, FeedPlace> = {},
  draftDirty: readonly string[] = [],
): ConvCacheRecord | null {
  if (conv.pts === null) return null;
  const summaries = Object.values(conv.summaries);
  const recent = [...summaries]
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))
    .map((s) => s.id)
    // Окно не у хвоста (открыли у непрочитанного, перешли к цитате) первым кадром не годится: подъём считает окна
    // хвостами (`hydrateState`), и кусок из середины встал бы на место последних сообщений.
    .filter((id) => conv.windows[id] && !conv.windows[id].hasMoreAfter && (messages[id]?.length ?? 0) > 0)
    .slice(0, CACHE_WINDOWS);
  const out: Record<string, ConvMessage[]> = {};
  for (const id of recent) out[id] = (messages[id] ?? []).slice(-CACHE_MESSAGES).map(stripAttachmentUrls);
  return {
    v: CONV_CACHE_SCHEMA,
    pts: conv.pts,
    savedAt: now,
    summaries,
    messages: out,
    gone: Object.keys(conv.gone).slice(-CACHE_GONE),
    outbox,
    drafts,
    places,
    draftDirty: [...draftDirty],
  };
}

/** Запасной снимок, когда место кончилось: только список, без лент. */
export function withoutMessages(r: ConvCacheRecord): ConvCacheRecord {
  return { ...r, messages: {} };
}

/**
 * Писать ли поверх того, что уже лежит. Другая вкладка того же человека могла уйти дальше по журналу — её запись
 * новее, и затирать её своим более старым снимком нельзя. Равный номер — пишем (ленты могли подгрузиться).
 */
export function shouldOverwrite(stored: { pts: number } | null | undefined, next: { pts: number }): boolean {
  return !stored || typeof stored.pts !== 'number' || next.pts >= stored.pts;
}

/**
 * Запись с диска годится? Чужая схема, битая форма, номер не число — выбросить. Внутри — поштучно: битая сводка,
 * сообщение или исходящая отбрасываются по одной. Запись читается ДО сети при каждом запуске, и одна испорченная
 * строка, упавшая в подъёме или отрисовке, роняла бы приложение на этом устройстве раз за разом.
 */
export function acceptRecord(raw: unknown): ConvCacheRecord | null {
  const r = raw as Partial<ConvCacheRecord> | null;
  if (!r || typeof r !== 'object') return null;
  if (r.v !== CONV_CACHE_SCHEMA) return null;
  if (typeof r.pts !== 'number' || !Number.isSafeInteger(r.pts) || r.pts < 0) return null;
  if (!Array.isArray(r.summaries) || typeof r.messages !== 'object' || r.messages === null) return null;
  const messages: Record<string, ConvMessage[]> = {};
  for (const [id, list] of Object.entries(r.messages as Record<string, unknown>)) {
    if (Array.isArray(list)) messages[id] = list.filter(isCachedMessage);
  }
  return {
    v: r.v,
    pts: r.pts,
    savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0,
    summaries: r.summaries.filter(isCachedSummary),
    messages,
    gone: Array.isArray(r.gone) ? r.gone.filter((x): x is string => typeof x === 'string') : [],
    outbox: Array.isArray(r.outbox) ? r.outbox.filter(isPersistedItem) : [],
    drafts: acceptDrafts(r.drafts),
    places: acceptPlaces(r.places),
    draftDirty: Array.isArray(r.draftDirty) ? r.draftDirty.filter(isStr) : [],
  };
}

const isStr = (x: unknown): x is string => typeof x === 'string';
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';

/** Поля сводки, которые список и подъём читают без проверки. */
function isCachedSummary(x: unknown): x is ConvSummary {
  if (!isObj(x)) return false;
  const u = x.otherUser;
  return (
    isStr(x.id) &&
    isStr(x.createdAt) &&
    (x.lastMessageAt === null || isStr(x.lastMessageAt)) &&
    typeof x.unread === 'number' &&
    (u === null || (isObj(u) && isStr(u.id) && isStr(u.username)))
  );
}

/** Поля сообщения, которые лента читает без проверки. */
function isCachedMessage(x: unknown): x is ConvMessage {
  if (!isObj(x)) return false;
  const a = x.author;
  const f = x.forwardedFrom;
  return (
    isStr(x.id) &&
    typeof x.sortKey === 'number' &&
    Number.isFinite(x.sortKey) &&
    isStr(x.createdAt) &&
    isStr(x.content) &&
    isObj(a) &&
    isStr(a.id) &&
    Array.isArray(x.attachments) &&
    x.attachments.every(isObj) &&
    Array.isArray(x.reactions) &&
    // «Переслано от» (`conv5`) необязательно, но если есть — строка «Переслано от <имя>» читает его как есть.
    (f === undefined || f === null || (isObj(f) && isStr(f.userId) && isStr(f.displayName) && isStr(f.at)))
  );
}

function acceptPlaces(raw: unknown): Record<string, FeedPlace> {
  const out: Record<string, FeedPlace> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
    const v = p as { messageId?: unknown; offset?: unknown } | null;
    if (v && typeof v.messageId === 'string' && typeof v.offset === 'number' && Number.isFinite(v.offset)) {
      out[id] = { messageId: v.messageId, offset: v.offset };
    }
  }
  return out;
}

function acceptDrafts(raw: unknown): Record<string, { text: string; replyToId: string | null }> {
  const out: Record<string, { text: string; replyToId: string | null }> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, d] of Object.entries(raw as Record<string, unknown>)) {
    const v = d as { text?: unknown; replyToId?: unknown } | null;
    if (v && typeof v.text === 'string' && (v.replyToId === null || typeof v.replyToId === 'string')) {
      out[id] = { text: v.text.slice(0, 4000), replyToId: v.replyToId };
    }
  }
  return out;
}

function isPersistedItem(x: unknown): x is PersistedOutboxItem {
  const o = x as Partial<PersistedOutboxItem> | null;
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.key === 'string' &&
    typeof o.convId === 'string' &&
    typeof o.content === 'string' &&
    (o.replyToId == null || typeof o.replyToId === 'string') &&
    (o.status === 'sending' || o.status === 'failed') &&
    (o.error == null || typeof o.error === 'string') &&
    typeof o.attempts === 'number' &&
    Number.isFinite(o.attempts) &&
    Array.isArray(o.fileNames) &&
    o.fileNames.every(isStr) &&
    Array.isArray(o.uploaded) &&
    o.uploaded.every((u) => u == null || (isObj(u) && isStr(u.id)))
  );
}

/**
 * Состояние бесед из записи — первый кадр до сети. Всё верно по `r.pts`: сводки и сообщения получают этот номер,
 * догонка пойдёт с него и принесёт текущий вид всего, что изменилось после. Окна помечены `stale`: ссылок на закрытые
 * файлы в них нет, и первая свежая порция заменяет окно целиком.
 */
export function hydrateState(r: ConvCacheRecord): { conv: ConvState; messages: Record<string, ConvMessage[]> } {
  const conv = emptyConvState();
  conv.pts = r.pts;
  for (const s of r.summaries) {
    conv.summaries[s.id] = s;
    conv.summaryPts[s.id] = r.pts;
  }
  const messages: Record<string, ConvMessage[]> = {};
  for (const [id, list] of Object.entries(r.messages)) {
    if (!conv.summaries[id] || !Array.isArray(list)) continue;
    const sorted = [...list].sort(compareConv);
    messages[id] = sorted;
    conv.windows[id] = { basePts: r.pts, hasMoreBefore: true, hasMoreAfter: false, stale: true };
    for (const m of sorted) conv.msgPts[m.id] = r.pts;
  }
  for (const id of r.gone) conv.gone[id] = true;
  return { conv, messages };
}
