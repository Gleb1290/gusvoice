import {
  FEATURE_READERS1,
  FEATURE_CONV3,
  FEATURE_CONV4,
  FEATURE_CONV5,
  FEATURE_CONV6,
  FEATURE_CONV7,
  FEATURE_CONV8,
  FEATURE_CONV9,
  FEATURE_CONV10,
  FEATURE_CONV11,
  FEATURE_CONV12,
  FEATURE_SEARCH1,
  FEATURE_CONV13,
  FEATURE_ARCHIVE1,
  FEATURE_VOICE3,
  FEATURE_TTL_MEDIA1,
  FEATURE_CIRCLES1,
  FEATURE_ALBUM1,
  FEATURE_QUOTE1,
  FEATURE_LINKPREV1,
  FEATURE_GROUPS1,
  FEATURE_FEDM3,
  FEATURE_FEDM4,
  FEATURE_FEDM5,
  FEATURE_SAVED1,
  FEATURE_REACTUNREAD1,
  FEATURE_GSEARCH1,
  FEATURE_SRVSEARCH1,
  FEATURE_FREQ1,
  FEATURE_FREQ2,
  FEATURE_BIGREACT1,
  FEATURE_MEDIA1,
  FEATURE_PUSH2,
  FEATURE_PUSH3,
  FEATURE_PUSH4,
  FEATURE_PINORDER1,
  FEATURE_PINORDER2,
  FEATURE_PINSET1,
  FEATURE_FWD2,
  FEATURE_GIFS1,
  FEATURE_GEOCONTACT1,
  FEATURE_CONVPOLL1,
  FEATURE_GEOLIVE1,
  FEATURE_YAMAP1,
  FEATURE_OSMMAP1,
  FEATURE_MEDIA2,
} from '@gusvoice/shared';
import type {
  ConvGone,
  ConvHistoryResponse,
  ConvLastMessage,
  ConvLeft,
  ConvListResponse,
  ConvMessage,
  ConvMute,
  ConvPin,
  ConvScheduled,
  ConvSummary,
  DmChannel,
  GatewayServerMessage,
} from '@gusvoice/shared';
import { byRecent } from './dmListRules';

/**
 * ЛС, этап 2 (шаг 2а): беседы `/api/conv/*` на клиенте — чистые правила догонки и слияния (`docs/dm/STAGE2.md`).
 *
 * Сервер (этап 1) ведёт на каждого человека журнал с номером `pts`: каждое изменение в беседах — строка журнала, живое
 * событие `conv.change` несёт номер этой строки, а после обрыва клиент просит «всё после N» (`/api/conv/sync`). Здесь —
 * всё, что решает, применить ли пришедшее, где дыра и как слить ответ с тем, что уже в памяти. Без `window`, `fetch`,
 * стора и сокетов: обвязка — `convStore.ts`.
 *
 * 🔴 **Главное правило — свежесть у каждой части, а не один номер на всё.** Сервер собирает сводку и вид сообщения для
 * события ПОСЛЕ фиксации, в момент рассылки (`conversations.deliver`), а писатели фиксируются и рассылают независимо.
 * Поэтому событие с номером 101 может прийти позже ответа истории, снятого на 105, и нести вид старше него, а события
 * одного человека — прийти 102 раньше 101. Каждая часть помнит номер, по который она верна, и изменение с номером `P`
 * применяется к ней, только если `P` больше:
 * - сводка беседы — `summaryPts[id]`;
 * - сообщение — `msgPts[id]` (номер снимка истории или события, из которого пришёл его вид). Один номер на всё окно не
 *   годится: подгружена часть истории, догонка приносит правку старого сообщения с номером меньше последнего снимка
 *   хвоста — и она была бы выброшена;
 * - вставка сообщения, которого в окне нет, — только если номер больше `basePts` окна (номер последнего снимка хвоста):
 *   иначе опоздавшее событие о сообщении, которое уже удалили, вставило бы «призрака»;
 * - удалённое (`gone`) не возвращается никогда: удаление у обоих и «у меня» необратимы, поэтому id запоминается навсегда.
 */

export type ConvChangeEvent = Omit<Extract<GatewayServerMessage, { t: 'conv.change' }>, 't'>;

export interface ConvWindow {
  /** Номер последнего снимка ХВОСТА окна (ответ истории без курсора или `after`, дошедший до конца). */
  basePts: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  /**
   * Окно из кеша на диске (шаг 2б) или после смены токена: ссылок на закрытые файлы в нём нет (или они погасли). Первая
   * свежая порция `latest` заменяет такое окно целиком, не сохраняя «старую прокрутку» без ссылок.
   */
  stale?: boolean;
}

export interface ConvState {
  /** Номер журнала, по который применено всё; `null` — список ещё не загружали. */
  pts: number | null;
  phase: 'idle' | 'syncing' | 'live';
  /** События, пришедшие во время догонки, — по возрастанию номера. */
  buffer: ConvChangeEvent[];
  summaries: Record<string, ConvSummary>;
  summaryPts: Record<string, number>;
  windows: Record<string, ConvWindow>;
  msgPts: Record<string, number>;
  /** id сообщений, которых для меня больше нет, — навсегда. */
  gone: Record<string, true>;
  /**
   * Закреплённые (С2, раунд 12 порция 7): МОИ закреплённые по беседе — список ЦЕЛИКОМ и номер, по который он верен
   * (`applyPins`). Беседы нет — список не загружали или забыли (`dropPins`): лента попросит его заново. Поле
   * необязательное: пустое состояние (`emptyConvState`), кеш на диске и прежние снимки его не знают.
   */
  pins?: Record<string, ConvPinsEntry>;
  /**
   * Отложенные (С4, раунд 12 порция 8): МОИ отложенные по беседе — список ЦЕЛИКОМ и номер, по который он верен
   * (`applyScheduled`). Беседы нет — список не загружали или забыли (`dropScheduled`): вид «Отложенные» попросит его
   * заново. Необязательное, как `pins`: пустое состояние, кеш на диске и прежние снимки поля не знают.
   */
  scheduled?: Record<string, ConvScheduledEntry>;
}

/** Закреплённые одной беседы в памяти: от старых к новым по ленте (как отдаёт сервер) и свежесть — номер журнала. */
export interface ConvPinsEntry {
  pts: number;
  list: ConvPin[];
}

/** Отложенные одной беседы в памяти: сначала по времени, затем «когда будет в сети» (как отдаёт сервер), и свежесть. */
export interface ConvScheduledEntry {
  pts: number;
  list: ConvScheduled[];
}

/** Сообщения беседы в памяти — по `(sortKey, id)`, старые сверху. */
export type ConvMessages = Record<string, ConvMessage[]>;

export function emptyConvState(): ConvState {
  return { pts: null, phase: 'idle', buffer: [], summaries: {}, summaryPts: {}, windows: {}, msgPts: {}, gone: {} };
}

export function compareConv(a: Pick<ConvMessage, 'sortKey' | 'id'>, b: Pick<ConvMessage, 'sortKey' | 'id'>): number {
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Курсор истории — непрозрачная строка сервера `"<sortKey>_<id>"` (`convRules.encodeCursor`). */
export function convCursor(m: Pick<ConvMessage, 'sortKey' | 'id'>): string {
  return `${m.sortKey}_${m.id}`;
}

export function isConvGone(m: ConvMessage | ConvGone): m is ConvGone {
  return (m as ConvGone).gone === true;
}

export function isConvLeft(s: ConvSummary | ConvLeft): s is ConvLeft {
  return (s as ConvLeft).left === true;
}

// ─── Догонка: что делать с событием ────────────────────────────────────────────────────────────────────────────────

export type EventDecision = 'apply' | 'skip' | 'gap' | 'buffer';

/**
 * Живое событие с номером `P`. Номера одного человека идут подряд (сервер пишет ровно одну строку журнала на участника
 * за действие), поэтому `P > pts + 1` — это пропуск: догонять, а не перескакивать.
 */
export function eventDecision(state: Pick<ConvState, 'pts' | 'phase'>, P: number): EventDecision {
  if (state.phase !== 'live' || state.pts === null) return 'buffer';
  if (P <= state.pts) return 'skip';
  if (P === state.pts + 1) return 'apply';
  return 'gap';
}

/** Положить событие в буфер: по возрастанию номера, повтор номера не дублируется. */
export function bufferEvent(buffer: readonly ConvChangeEvent[], ev: ConvChangeEvent): ConvChangeEvent[] {
  if (buffer.some((b) => b.pts === ev.pts)) return [...buffer];
  return [...buffer, ev].sort((a, b) => a.pts - b.pts);
}

/**
 * Разбор буфера после догонки: выбросить уже учтённое, применить идущие подряд, на первой дыре остановиться.
 * `gap: true` — нужна ещё одна догонка; оставшиеся события возвращаются, чтобы не терять их.
 */
export function drainPlan(
  pts: number,
  buffer: readonly ConvChangeEvent[],
): { apply: ConvChangeEvent[]; rest: ConvChangeEvent[]; gap: boolean } {
  const apply: ConvChangeEvent[] = [];
  let cur = pts;
  const sorted = [...buffer].sort((a, b) => a.pts - b.pts);
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.pts <= cur) continue;
    if (ev.pts !== cur + 1) return { apply, rest: sorted.slice(i), gap: true };
    apply.push(ev);
    cur = ev.pts;
  }
  return { apply, rest: [], gap: false };
}

// ─── Сводки бесед ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Полный список (`GET /api/conv`) — снимок на номер `res.pts`. Беседа, которой в нём нет, для меня исчезла, КРОМЕ той,
 * что пришла событием новее снимка (список мог сниматься раньше, чем её создали).
 */
export function applyList(state: ConvState, res: ConvListResponse): ConvState {
  const summaries: Record<string, ConvSummary> = {};
  const summaryPts: Record<string, number> = {};
  // Бывшие группы (08.10, `groups3`) — в списке наравне, только на чтение (`ConvSummary.former`).
  for (const c of [...res.conversations, ...(res.former ?? []).filter((f) => !!f.former)]) {
    const own = state.summaryPts[c.id];
    if (own !== undefined && own > res.pts) {
      summaries[c.id] = state.summaries[c.id];
      summaryPts[c.id] = own;
    } else {
      summaries[c.id] = c;
      summaryPts[c.id] = res.pts;
    }
  }
  for (const [id, own] of Object.entries(state.summaryPts)) {
    if (!(id in summaries) && own > res.pts && state.summaries[id]) {
      summaries[id] = state.summaries[id];
      summaryPts[id] = own;
    }
  }
  const windows: Record<string, ConvWindow> = {};
  for (const id of Object.keys(state.windows)) if (id in summaries) windows[id] = state.windows[id];
  return { ...state, pts: Math.max(state.pts ?? 0, res.pts), summaries, summaryPts, windows };
}

/** Сводка беседы (или «вышел») с номером `P`. `dropped` — беседа ушла из списка: её ленту обвязка убирает. */
export function applySummary(
  state: ConvState,
  s: ConvSummary | ConvLeft,
  P: number,
): { state: ConvState; dropped: string | null } {
  const own = state.summaryPts[s.id];
  if (own !== undefined && P <= own) return { state, dropped: null };
  // Бывшая группа (08.10, `groups3`): вышел или удалили — беседа остаётся только на чтение, лента не сбрасывается.
  if (isConvLeft(s) && s.former?.former && s.former.id === s.id) {
    return {
      state: { ...state, summaries: { ...state.summaries, [s.id]: s.former }, summaryPts: { ...state.summaryPts, [s.id]: P } },
      dropped: null,
    };
  }
  if (isConvLeft(s)) {
    const { [s.id]: _s, ...summaries } = state.summaries;
    const { [s.id]: _w, ...windows } = state.windows;
    return { state: { ...state, summaries, windows, summaryPts: { ...state.summaryPts, [s.id]: P } }, dropped: s.id };
  }
  const next = keepChatPrefs(state.summaries[s.id], s);
  return {
    state: { ...state, summaries: { ...state.summaries, [s.id]: next }, summaryPts: { ...state.summaryPts, [s.id]: P } },
    dropped: null,
  };
}

/**
 * Закреп и заглушка в сводке-событии без этих полей (07.10, `conv11`): событие собрал бэкенд постарше — смешанные версии
 * на выкатке (на стенде — соседний бэкенд на той же базе), — и оно не знает о них, а не «снимает». Берутся прежние значения,
 * иначе беседа на миг выпадала бы из закреплённых и снова звенела. Полный список (`applyList`) берётся как есть: после
 * отката сервера закреп уходит с первым же списком.
 */
export function keepChatPrefs(prev: ConvSummary | undefined, s: ConvSummary): ConvSummary {
  if (
    !prev ||
    (s.pinnedAt !== undefined &&
      s.muted !== undefined &&
      s.markedUnread !== undefined &&
      (s.archived !== undefined || prev.archived === undefined) &&
      (s.unreadReactions !== undefined || prev.unreadReactions === undefined))
  )
    return s;
  if (prev.pinnedAt === undefined && prev.muted === undefined && prev.markedUnread === undefined && prev.archived === undefined && prev.unreadReactions === undefined)
    return s;
  return {
    ...s,
    ...(s.pinnedAt === undefined && prev.pinnedAt !== undefined ? { pinnedAt: prev.pinnedAt } : {}),
    ...(s.muted === undefined && prev.muted !== undefined ? { muted: prev.muted } : {}),
    // 07.10 (`conv13`): то же для пометки «непрочитанным» — событие бэкенда постарше о ней не знает, а не «снимает».
    ...(s.markedUnread === undefined && prev.markedUnread !== undefined ? { markedUnread: prev.markedUnread } : {}),
    // 07.10 (`archive1`): то же для архива — событие бэкенда постарше о нём не знает, а не «возвращает из архива».
    ...(s.archived === undefined && prev.archived !== undefined ? { archived: prev.archived } : {}),
    // 07.10 (`reactunread1`, G24): то же для числа непрочитанных реакций — событие бэкенда постарше о нём не знает, а не «гасит».
    ...(s.unreadReactions === undefined && prev.unreadReactions !== undefined ? { unreadReactions: prev.unreadReactions } : {}),
  };
}

// ─── Сообщения ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Вид сообщения с номером `P` (событие или догонка). Окна беседы нет в памяти — сообщение не хранится (лента подтянет
 * его сама при открытии), но удаление запоминается.
 */
export function applyMessage(
  state: ConvState,
  list: readonly ConvMessage[] | undefined,
  m: ConvMessage | ConvGone,
  P: number,
): { state: ConvState; list: ConvMessage[] | undefined } {
  const convId = m.conversationId;
  if (isConvGone(m)) {
    const gone = { ...state.gone, [m.id]: true as const };
    const next = list?.some((x) => x.id === m.id) ? list.filter((x) => x.id !== m.id) : list ? [...list] : undefined;
    return { state: { ...state, gone }, list: next };
  }
  if (state.gone[m.id]) return { state, list: list ? [...list] : undefined };
  const own = state.msgPts[m.id];
  if (own !== undefined && P <= own) return { state, list: list ? [...list] : undefined };
  const win = state.windows[convId];
  if (!list || !win) return { state, list: list ? [...list] : undefined };
  const idx = list.findIndex((x) => x.id === m.id);
  if (idx !== -1) {
    const next = [...list];
    next[idx] = m;
    return { state: { ...state, msgPts: { ...state.msgPts, [m.id]: P } }, list: next };
  }
  if (P <= win.basePts || !insideWindow(list, win, m)) return { state, list: [...list] };
  return {
    state: { ...state, msgPts: { ...state.msgPts, [m.id]: P } },
    list: [...list, m].sort(compareConv),
  };
}

/**
 * Попадает ли сообщение в загруженное окно: не старше первого, если выше есть ещё история, и не новее последнего,
 * если ниже есть ещё история. Пустое окно без истории по краям принимает всё.
 */
function insideWindow(list: readonly ConvMessage[], win: ConvWindow, m: ConvMessage): boolean {
  if (list.length === 0) return !win.hasMoreBefore && !win.hasMoreAfter;
  if (win.hasMoreBefore && compareConv(m, list[0]) < 0) return false;
  if (win.hasMoreAfter && compareConv(m, list[list.length - 1]) > 0) return false;
  return true;
}

export type PageKind = 'latest' | 'older' | 'newer' | 'jump';

/**
 * Ответ истории на номер `page.pts`. `latest` — последние сообщения (открытие, перечитка): хвост окна; прежние
 * сообщения старше порции остаются (подгруженная прокрутка не пропадает), кроме случая, когда порция с ними не
 * смыкается (проспали больше порции) — тогда окно начинается с неё. `older`/`newer` — куски по курсору. `jump` (шаг 2г)
 * — окно ЗАМЕНЯЕТСЯ порцией (открытие у непрочитанного `after`, переход к цитате и возврат на место `around`): прежний
 * кусок с ней обычно не смыкается, а склейка через дыру показала бы соседями сообщения из разных мест истории.
 */
export function applyPage(
  state: ConvState,
  list: readonly ConvMessage[] | undefined,
  convId: string,
  page: ConvHistoryResponse,
  kind: PageKind,
): { state: ConvState; list: ConvMessage[] } {
  const msgPts = { ...state.msgPts };
  const incoming: ConvMessage[] = [];
  for (const m of page.messages) {
    if (state.gone[m.id]) continue;
    const own = msgPts[m.id];
    if (own !== undefined && own > page.pts) {
      const kept = list?.find((x) => x.id === m.id);
      if (kept) incoming.push(kept);
      continue;
    }
    msgPts[m.id] = page.pts;
    incoming.push(m);
  }
  const prev = state.windows[convId];
  const have = list ?? [];
  let merged: ConvMessage[];
  let win: ConvWindow;
  if (kind === 'jump') {
    // Порция дошла до хвоста — сообщения новее снимка, пришедшие событиями во время запроса, не теряем (как `latest`).
    const newer = page.hasMoreAfter
      ? []
      : have.filter((x) => (state.msgPts[x.id] ?? 0) > page.pts && !incoming.some((y) => y.id === x.id));
    merged = dedupe([...incoming, ...newer]);
    win = { basePts: page.pts, hasMoreBefore: page.hasMoreBefore, hasMoreAfter: page.hasMoreAfter };
  } else if (kind === 'latest' || !prev) {
    const first = incoming[0];
    // Старое окно смыкается с порцией, если его сообщения из прежних снимков доходят до её первого. Сообщения новее
    // снимка (пришли событиями во время запроса) смыкание не доказывают: между ними и старым окном может быть дыра.
    const oldPart = have.filter((x) => (state.msgPts[x.id] ?? 0) <= page.pts);
    const joins = !!first && oldPart.some((x) => compareConv(x, first) >= 0);
    // Раньше порции истории нет (`!hasMoreBefore`) — всё старое в памяти удалено; не смыкается — между ними дыра.
    const older = first && joins && page.hasMoreBefore && !prev?.stale ? have.filter((x) => compareConv(x, first) < 0) : [];
    // Сообщения новее снимка, пришедшие событиями во время запроса, не теряем.
    const newer = have.filter((x) => (state.msgPts[x.id] ?? 0) > page.pts && !incoming.some((y) => y.id === x.id));
    merged = dedupe([...older, ...incoming, ...newer]);
    win = {
      basePts: Math.max(prev?.basePts ?? 0, page.pts),
      hasMoreBefore: older.length > 0 ? (prev?.hasMoreBefore ?? page.hasMoreBefore) : page.hasMoreBefore,
      hasMoreAfter: page.hasMoreAfter,
    };
  } else if (kind === 'older') {
    merged = dedupe([...incoming, ...have]);
    win = { ...prev, hasMoreBefore: page.hasMoreBefore };
  } else {
    merged = dedupe([...have, ...incoming]);
    win = { ...prev, hasMoreAfter: page.hasMoreAfter, basePts: page.hasMoreAfter ? prev.basePts : Math.max(prev.basePts, page.pts) };
  }
  return { state: { ...state, msgPts, windows: { ...state.windows, [convId]: win } }, list: merged };
}

/**
 * Отрезать край окна (шаг 2г, `feedWindowRules.trimPlan`): лента не растёт с историей. Отрезанный край помечается «там
 * есть ещё». Номера свежести отрезанных забываются: иначе порция, снятая раньше события об отрезанном сообщении, его бы
 * выбросила (`own > page.pts`, а оставить нечего), и в окне появилась бы дыра.
 */
export function trimWindow(
  state: ConvState,
  list: readonly ConvMessage[],
  convId: string,
  side: 'top' | 'bottom',
  count: number,
): { state: ConvState; list: ConvMessage[] } {
  const win = state.windows[convId];
  if (!win || count <= 0 || count >= list.length) return { state, list: [...list] };
  const cut = side === 'top' ? list.slice(0, count) : list.slice(list.length - count);
  const next = side === 'top' ? list.slice(count) : list.slice(0, list.length - count);
  const msgPts = { ...state.msgPts };
  for (const m of cut) delete msgPts[m.id];
  const w = side === 'top' ? { ...win, hasMoreBefore: true } : { ...win, hasMoreAfter: true };
  return { state: { ...state, msgPts, windows: { ...state.windows, [convId]: w } }, list: next };
}

function dedupe(list: ConvMessage[]): ConvMessage[] {
  const seen = new Map<string, ConvMessage>();
  for (const m of list) seen.set(m.id, m);
  return [...seen.values()].sort(compareConv);
}

/**
 * Своё сообщение из ответа отправки (201 или повтор 200). Номера у ответа нет — вставляем с нулевой свежестью, любое
 * событие о нём его обновит. Окна нет — не храним (как у события).
 */
export function applySent(
  state: ConvState,
  list: readonly ConvMessage[] | undefined,
  m: ConvMessage,
): { state: ConvState; list: ConvMessage[] | undefined } {
  if (!list || state.gone[m.id] || list.some((x) => x.id === m.id)) return { state, list: list ? [...list] : undefined };
  return { state: { ...state, msgPts: { ...state.msgPts, [m.id]: state.msgPts[m.id] ?? 0 } }, list: [...list, m].sort(compareConv) };
}

/**
 * Ответ правки: номера нет, поэтому берём его, только если он правка НОВЕЕ того, что в памяти (`editedAt` у правок
 * растёт) — иначе опоздавший ответ откатил бы правку, уже пришедшую событием.
 */
export function applyEdited(list: readonly ConvMessage[] | undefined, m: ConvMessage): ConvMessage[] | undefined {
  if (!list) return undefined;
  return list.map((x) => {
    if (x.id !== m.id) return x;
    if (x.editedAt && m.editedAt && Date.parse(x.editedAt) >= Date.parse(m.editedAt)) return x;
    return { ...m, reactions: x.reactions };
  });
}

/** Удалил сам (ответ 204): убрать и запомнить навсегда. */
export function applyRemoved(
  state: ConvState,
  list: readonly ConvMessage[] | undefined,
  messageId: string,
): { state: ConvState; list: ConvMessage[] | undefined } {
  return {
    state: { ...state, gone: { ...state.gone, [messageId]: true } },
    list: list ? list.filter((x) => x.id !== messageId) : undefined,
  };
}

// ─── Для интерфейса ────────────────────────────────────────────────────────────────────────────────────────────────

/** Как стёртый аккаунт выглядит в списке (сервер: `accountRules.DELETED_DISPLAY_NAME`). */
const GONE_PEER = { username: '', displayName: 'Удалённый пользователь', avatarUrl: null };

/** Имя «Избранного» в списке, «Переслать» и шапке (Telegram: «Saved Messages», `lng_saved_messages`). */
export const SAVED_NAME = 'Избранное';

/** Сводка беседы → строка списка ЛС, которую читает интерфейс (`DmSidebar`, `DmChatView`). */
export function summaryToDm(s: ConvSummary): DmChannel {
  return {
    id: s.id,
    // Группа (07.10, `groups1`): «собеседник» строки — сама группа (название и фото), id с приставкой `group:` — его нет
    // среди людей, и правила «человека» (блок, заглушка, «в сети») его не находят. Участники — в `group`.
    // «Избранное» (08.10, `saved1`): так же — служебный id `saved:` (правила «человека» его не находят: ни «в сети», ни блока,
    // ни звонка), имя — «Избранное»; аватар рисует `SavedAvatar` по признаку `saved`.
    otherUser: s.group
      ? { id: `group:${s.id}`, username: '', displayName: s.group.title, avatarUrl: s.group.avatarUrl }
      : s.saved
        ? { id: `saved:${s.id}`, username: '', displayName: SAVED_NAME, avatarUrl: null }
        : (s.otherUser ?? { id: `gone:${s.id}`, ...GONE_PEER }),
    ...(s.group ? { group: s.group } : {}),
    ...(s.saved ? { saved: true } : {}),
    createdAt: s.createdAt,
    lastMessageAt: s.lastMessageAt,
    unread: s.unread,
    // 07.10 (`conv11`): закреп и заглушка — только когда сервер их прислал (нет поля — сервер постарше).
    ...(s.pinnedAt !== undefined ? { pinnedAt: s.pinnedAt } : {}),
    ...(s.muted !== undefined ? { muted: s.muted } : {}),
    // 07.10 (`conv13`): пометка «непрочитанным» — точка без числа, только когда сервер её прислал.
    ...(s.markedUnread ? { markedUnread: true } : {}),
    // 07.10 (`archive1`, G41): беседа в моём архиве — только когда сервер прислал.
    ...(s.archived ? { archived: true } : {}),
    // 08.10 (`stranger1`, С7): плашка незнакомца горит — только когда сервер прислал.
    ...(s.stranger ? { stranger: true } : {}),
    // 07.10 (`reactunread1`, G24): сколько моих сообщений с непрочитанными реакциями (значок ♥ в строке) и упоминаний («@», группы).
    ...(s.unreadReactions ? { unreadReactions: s.unreadReactions } : {}),
    ...(s.unreadMentions ? { unreadMentions: s.unreadMentions } : {}),
  };
}

/** Порядок списка: закреплённые первыми (07.10, `conv11`), дальше свежие сверху — одно правило `dmListRules.byRecent`. */
function recent(a: ConvSummary, b: ConvSummary): number {
  return byRecent(a, b);
}

/**
 * Сервер умеет закреп беседы в списке и заглушку со сроком (07.10, `conv11`): только тогда показывать «Закрепить» и меню
 * сроков у колокольчика. Без признака колокольчик глушит навсегда, как раньше (старый сервер `seconds` отбросит молча).
 */
export function serverChatPrefs(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CONV11);
}

/**
 * Сервер умеет «Очистить историю» и «Удалить чат» (07.10, `conv12`, G01): только тогда эти пункты есть в меню строки
 * беседы. Старый сервер ответил бы 404.
 */
export function serverChatClear(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CONV12);
}

/** Сервер считает непрочитанные реакции на мои сообщения (G24, `reactunread1`): кнопка «♥» над «вниз» и значок в строке. */
export function serverReactionsUnread(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_REACTUNREAD1);
}

/** Сервер шлёт «большую» реакцию удержанием (G43, `bigreact1`): без признака удержание в полосе реакций — как было. */
export function serverBigReactions(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_BIGREACT1);
}

/** Сервер ищет сообщения каналов по всем моим серверам (G35, `srvsearch1`): вкладки «Все / Личные / Серверы» в поиске из списка. */
export function serverServersSearch(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_SRVSEARCH1);
}

/** Сервер считает «Частые» (G35, `freq1`): полоса «Частые» в пустом поиске из списка вместо «Людей» по свежести. */
export function serverFrequent(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_FREQ1);
}

/**
 * «Убрать из частых» хранит сервер (09.10, `freq2`; у Telegram — `contacts.resetTopPeerRating`): скрытие видно на всех моих
 * устройствах. Без признака убранные помнит устройство (`localStorage`, как при `freq1`).
 */
export function serverFrequentHide(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_FREQ2);
}

/** Сервер ищет по тексту во всех беседах (G35, `gsearch1`): «Сообщения», «Недавние», «Люди» и чипы в поиске из списка. */
export function serverGlobalSearch(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_GSEARCH1);
}

/** Сервер отдаёт общие медиа беседы (G29, `media1`): блок «Медиа / Файлы / Ссылки / GIF / Голосовые» в профиле. */
export function serverSharedMedia(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_MEDIA1);
}

/**
 * «Реакции увидены» у себя до ответа сервера (G24, `reactunread1`): число в сводке уменьшается на `n` сообщений (`null` — все,
 * «Прочитать все»), не ниже нуля; свежесть сводки не трогаем (подтверждение придёт событием).
 */
export function patchReactionsRead(state: ConvState, convId: string, n: number | null): ConvState {
  const s = state.summaries[convId];
  const cur = s?.unreadReactions ?? 0;
  if (!s || cur === 0) return state;
  const next = n === null ? 0 : Math.max(0, cur - n);
  return { ...state, summaries: { ...state.summaries, [convId]: { ...s, unreadReactions: next } } };
}

/** Снять `reactionUnread` у сообщений ленты: у перечисленных (`ids`) или у всех (`null`). Ничего не изменилось — тот же массив. */
export function clearReactionUnread<T extends { id: string; reactionUnread?: true }>(list: readonly T[], ids: readonly string[] | null): readonly T[] {
  const set = ids ? new Set(ids) : null;
  let changed = false;
  const out = list.map((m) => {
    if (!m.reactionUnread || (set && !set.has(m.id))) return m;
    changed = true;
    const { reactionUnread: _drop, ...rest } = m;
    return rest as T;
  });
  return changed ? out : list;
}

/** Сервер умеет поиск по беседе и «Перейти к дате» (G05, G25, `search1`): лупа, Ctrl+F в ЛС, календарь по дате. */
export function serverChatSearch(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_SEARCH1);
}

/**
 * Закреп беседы у себя до ответа сервера (07.10): сводка с новым `pinnedAt`, номер свежести не трогаем — событие сервера
 * (оно новее) поставит точное время. Сводки нет или то же — то же состояние.
 */
/**
 * Сервер умеет ручной порядок закреплённых бесед (08.10, `pinorder1`, G02/G42): только тогда строку закреплённой можно
 * перетащить и в меню есть «Поднять выше» / «Опустить ниже». Старый сервер ответил бы 404.
 */
export function serverPinOrder(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_PINORDER1);
}

/**
 * У каждой своей папки — свой порядок закреплённых (09.10, `pinorder2`; Telegram `pinned_peers` фильтра): в папке работают
 * перетаскивание и «Поднять выше» / «Опустить ниже», порядок — `DmFolder.pinned`. Без признака в папке порядок общий и не меняется.
 */
export function serverFolderPinOrder(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_PINORDER2);
}

/**
 * Свой НАБОР закреплённых в папке (09.10, `pinset1`; Telegram `pinned_peers` фильтра): «Закрепить» в своей папке — только в ней,
 * папка без набора (`DmFolder.pinnedOwn`) переводится один раз (`useDmFolderUi`). Без признака — как при `pinorder2`.
 */
export function serverFolderPinSet(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_PINSET1);
}

/** Новые отметки закрепа нескольких бесед разом (перестановка, `pinorder1`); незакреплённые и неизвестные не трогаются. */
export function patchConvPinOrder(state: ConvState, stamps: Readonly<Record<string, string | null>>): ConvState {
  let summaries: ConvState['summaries'] | null = null;
  for (const [id, at] of Object.entries(stamps)) {
    const s = state.summaries[id];
    if (!s || (s.pinnedAt ?? null) === at || (at !== null && !s.pinnedAt)) continue;
    summaries ??= { ...state.summaries };
    summaries[id] = { ...s, pinnedAt: at };
  }
  return summaries ? { ...state, summaries } : state;
}

export function patchConvPinned(state: ConvState, convId: string, pinnedAt: string | null): ConvState {
  const s = state.summaries[convId];
  if (!s || (s.pinnedAt ?? null) === pinnedAt) return state;
  return { ...state, summaries: { ...state.summaries, [convId]: { ...s, pinnedAt } } };
}

/**
 * Сервер умеет «Пометить как непрочитанное», «Прочитать все» и «Выключить звук» (07.10, `conv13`, G04 и G03): только тогда
 * эти пункты есть в меню. Старый сервер ответил бы 404 или заглушил полностью.
 */
export function serverUnreadMark(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CONV13);
}

/** Сервер умеет «Избранное» (08.10, `saved1`, С6): только тогда есть строка в «Переслать», «Написать» и Ctrl+0. */
export function serverSaved(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_SAVED1) && !!features?.includes(FEATURE_GROUPS1);
}

/** Сервер умеет группы ЛС (07.10, `groups1`, С4): только тогда в «Написать» есть «Новая группа». */
export function serverGroups(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_GROUPS1);
}

/** Опрос в ЛС (14.10, `convpoll1`): пункт «Опрос» в листе вложений ЛС, голос, «Остановить опрос», «Посмотреть голоса». */
export function serverConvPoll(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CONVPOLL1);
}

/** Геопозиция в реальном времени в ЛС (14.10, `geolive1`): пункт «Транслировать геопозицию», точки, «Остановить». */
export function serverGeoLive(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_GEOLIVE1);
}

/** «Мои GIF» и вкладка «GIF» (07.10, Р-7): сервер с `gifs1`. */
export function serverGifs(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_GIFS1);
}

/** Геопозиция и карточка контакта в ЛС (14.10, G69, `geocontact1`): пункты «Геопозиция» и «Контакт» в листе вложений. */
export function serverGeoContact(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_GEOCONTACT1);
}

/** Картинка карты в карточке геопозиции (14.10, `yamap1`): сервер проксирует Static API Яндекса (`GET /api/maps/static`). */
export function serverYandexMap(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_YAMAP1);
}

/** Своя карта OpenStreetMap (14.10, `osmmap1`): плитки PMTiles с нашего сервера, живая карта вместо картинки Яндекса (`MapView`). */
export function serverOsmMap(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_OSMMAP1);
}

/** Сервер умеет архив бесед (07.10, `archive1`, G41): только тогда есть строка «Архив» и пункты «В архив» / «Вернуть из архива». */
export function serverArchive(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_ARCHIVE1);
}

/** Сервер умеет голосовое «Прослушать один раз» (`voice3`, G54): без признака кнопки «1» в панели записи нет. */
export function serverVoiceOnce(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_VOICE3);
}

/** Сервер умеет одноразовые фото и видео (`ttlmedia1`, #226): без признака нет пункта «Таймер самоуничтожения». */
export function serverOnceMedia(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_TTL_MEDIA1);
}

/** G56 (13.10, `album1`): сервер умеет удалить/переслать одно фото альбома (`albumItemRules.serverAlbumItems` — то же для ленты). */
export function serverAlbumItemsOn(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_ALBUM1);
}

/** Сервер умеет кружки (08.10, `circles1`, G68): пометку `round` у видео, «Видеосообщение» в списке и пуше. */
export function serverRounds(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CIRCLES1);
}

/** Архив у себя до ответа сервера (07.10, `archive1`): сводка с новым `archived`, свежесть не трогаем. */
export function patchConvArchived(state: ConvState, convId: string, archived: boolean): ConvState {
  const s = state.summaries[convId];
  if (!s || (s.archived === true) === archived) return state;
  return { ...state, summaries: { ...state.summaries, [convId]: { ...s, archived } } };
}

/** Плашка незнакомца гаснет у себя до ответа сервера (08.10, `stranger1`, С7): сводка без `stranger`, свежесть не трогаем. */
export function patchConvStrangerHidden(state: ConvState, convId: string): ConvState {
  const s = state.summaries[convId];
  if (!s || s.stranger !== true) return state;
  const { stranger: _gone, ...rest } = s;
  return { ...state, summaries: { ...state.summaries, [convId]: rest } };
}

/** Пометка «непрочитанным» у себя до ответа сервера (07.10, `conv13`): сводка с новым `markedUnread`, свежесть не трогаем. */
export function patchConvUnreadMark(state: ConvState, convId: string, marked: boolean): ConvState {
  const s = state.summaries[convId];
  if (!s || (s.markedUnread === true) === marked) return state;
  return { ...state, summaries: { ...state.summaries, [convId]: { ...s, markedUnread: marked } } };
}

/**
 * «Прочитать все» (или одну беседу — `only`) у себя до событий сервера (07.10, `conv13`): в сводках нет ни числа, ни
 * пометки «непрочитанным».
 */
export function patchConvReadAll(state: ConvState, only?: string): ConvState {
  let summaries: Record<string, ConvSummary> | null = null;
  for (const [id, s] of Object.entries(state.summaries)) {
    if (only !== undefined && id !== only) continue;
    if (!(s.unread > 0) && !s.markedUnread) continue;
    summaries ??= { ...state.summaries };
    summaries[id] = { ...s, unread: 0, markedUnread: false };
  }
  return summaries ? { ...state, summaries } : state;
}

/**
 * Заглушка собеседника у себя до ответа сервера (07.10): у всех бесед с ним в сводке — новый `muted` (для 1:1 это одна
 * беседа). Правится только сводка, где сервер уже присылает поле (`conv11`); иначе источник — список заглушек.
 */
export function patchPeerMute(state: ConvState, userId: string, muted: ConvMute | null): ConvState {
  let summaries: Record<string, ConvSummary> | null = null;
  for (const [id, s] of Object.entries(state.summaries)) {
    if (s.otherUser?.id !== userId || s.muted === undefined) continue;
    // Та же заглушка — без копии: лишняя перерисовка и запись кеша ни к чему (Codex R17 п.6).
    if (s.muted === muted || (s.muted && muted && s.muted.until === muted.until && !!s.muted.soundOnly === !!muted.soundOnly))
      continue;
    summaries ??= { ...state.summaries };
    summaries[id] = { ...s, muted };
  }
  return summaries ? { ...state, summaries } : state;
}

/**
 * Собеседник сменил имя или аватар (`user.update`; удаление аккаунта приходит так же). Список ЛС в режиме бесед
 * пересобирается из сводок на каждом изменении, а журнал беседы о профиле не знает — без правки здесь следующее же
 * событие вернуло бы старое имя, и оно легло бы в кеш на диске. Номер свежести не трогаем: сводка новее с сервера и
 * так несёт текущий профиль.
 */
export function patchPeer(state: ConvState, userId: string, displayName: string, avatarUrl: string | null): ConvState {
  let summaries: Record<string, ConvSummary> | null = null;
  for (const [id, s] of Object.entries(state.summaries)) {
    if (s.otherUser?.id !== userId) continue;
    if (s.otherUser.displayName === displayName && s.otherUser.avatarUrl === avatarUrl) continue;
    summaries ??= { ...state.summaries };
    summaries[id] = { ...s, otherUser: { ...s.otherUser, displayName, avatarUrl } };
  }
  return summaries ? { ...state, summaries } : state;
}

// ─── «Прочитано собеседником» ✓✓ (Р6, признак сервера `conv4`) ──────────────────────────────────────────────────────

/** Сервер шлёт «прочитано собеседником» (Р6): объявил `conv4`. Здесь, а не в сторе, — как `serverKeepsDrafts`. */
export function serverSendsPeerRead(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CONV4);
}

/** Сервер отдаёт «кто прочитал» своё сообщение в группе (15.10, `readers1`); без признака строки «N прочитали» нет. */
export function serverReaders(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_READERS1);
}

/**
 * Сервер умеет пересылку ЛС → ЛС и удаление пачкой (04.10, `conv5`): только тогда показывать «Переслать» и удаление
 * выделенного. Сервер без признака этих ручек не знает — пункты не показываются вовсе (а не падают ошибкой). Нужен ещё
 * режим бесед (`convActive`): ручки — `/api/conv/*`.
 */
export function serverBatchActions(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CONV5);
}

/**
 * Сервер удаляет ЧУЖОЕ сообщение «у обоих» в беседе 1:1 (С1, 04.10, `conv6`, как в Telegram): только тогда у чужого
 * показывать галочку «Также удалить для собеседника» — в одиночном удалении и в пачке (галочка — на все выбранные).
 * Сервер без признака отвечает на чужое «у обоих» 403 — галочки у чужого нет (только «Удалить у себя»). Нужен ещё режим
 * бесед (`convActive`): право дают только ручки `/api/conv/*`, старые `/api/dm*` удаляют чужое лишь у себя.
 */
export function serverDeletesOthersForBoth(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CONV6);
}

/**
 * Сервер умеет закреп в беседе 1:1 (С2, 05.10, `conv7`, как в Telegram): только тогда показывать «Закрепить»/«Открепить»
 * в меню сообщения ЛС, окно с галочкой «Также закрепить для собеседника» и полосу закрепа. Список — `api.convPins`
 * (`pts` + мои закреплённые от старых к новым, у каждого `forBoth` — спрашивать ли при откреплении «Также открепить для
 * собеседника»), изменения — `conv.change` с полем `pins` (список целиком) и `pins` в догонке. Сервер без признака ручек
 * не знает — пунктов нет вовсе. Нужен ещё режим бесед (`convActive`): закреп есть только у `/api/conv/*`.
 */
export function serverDmPins(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CONV7);
}

/**
 * Сервер умеет «Отправить без звука» (С3, 05.10, `conv8`, как в Telegram): только тогда показывать этот пункт в меню
 * кнопки «Отправить» и слать `silent: true` (`api.convSend`, `api.convForward`). Сервер без признака поле молча
 * отбрасывает — сообщение прозвенело бы у собеседника, хотя человек просил тишины; поэтому без признака пункта нет вовсе.
 * Нужен ещё режим бесед (`convActive`): флаг есть только у `/api/conv/*`. Приёмная сторона признака не ждёт: `silent` в
 * сообщении уважается всегда (`dmListRules.dmSilentDecision`).
 */
export function serverSilentSend(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CONV8);
}

/**
 * Сервер умеет флаги отправки (07.10, #211, G19 + G48, `linkprev1`): `noPreview` у сообщения («Отправить без превью» —
 * крестик на полосе превью над полем) и `asFile` у вложения («Отправить как файлы» — картинка карточкой файла). Без признака
 * клиент полей не шлёт (старый сервер их молча отбросит, и «без превью» не сработало бы), а полосу превью над полем не рисует.
 */
export function serverSendFlags(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_LINKPREV1);
}

/**
 * Сервер умеет «скрыть имя отправителя» и «скрыть подписи» у пересылки (07.10, #211, G71, `fwd2`). Без признака
 * переключателей в окне «Переслать» нет: старый сервер поля бы отбросил и выдал автора.
 */
export function serverForwardOptions(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_FWD2);
}

/**
 * Сервер умеет отложенные сообщения (С4, 05.10, `conv9`, как в Telegram): только тогда показывать в меню кнопки
 * «Отправить» пункты «Отправить позже» и «Когда будет в сети» и вход «Отложенные» в поле ввода. Сервер без признака ручек
 * `/conv/:id/scheduled*` не знает — пунктов нет вовсе. Нужен ещё режим бесед (`convActive`): отложенные есть только у
 * `/api/conv/*`. Число для входа — `ConvSummary.scheduledCount` (0 — входа нет), список — `api.convScheduled`,
 * изменения — `conv.change` с полем `scheduled` (список ЦЕЛИКОМ, только моим устройствам) и `scheduled` в догонке.
 * «Когда будет в сети» — только пока собеседник не в сети (в сети — это то же, что «Отправить»).
 */
export function serverScheduled(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CONV9);
}

/**
 * Сервер принимает отложенные С ВЛОЖЕНИЯМИ (06.10, `conv10`): только тогда «Отправить позже» и «Когда будет в сети» в меню
 * кнопки «Отправить» и в меню удержания листа вложений (`MediaSheet`) доступны, когда выбраны файлы. Файлы грузятся заранее
 * (`api.convUpload`), отложенное создаётся с их id (`ConvScheduleRequest.attachments`), в списке у такого — `attachments`
 * (ссылки свои у смотрящего — кешировать только `id`). Сервер без признака на вложения у отложенного отвечает 400 — пункты
 * серые с подписью «Только текст, без вложений». Сам по себе признак ничего не включает: нужен ещё `serverScheduled`.
 */
export function serverScheduledAttachments(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CONV10);
}

/**
 * Ключ ✓✓ беседы для ленты: только 1:1 и только число. `null` — отметок «прочитано» нет: поля нет (сервер до `conv4`
 * или сводка снята до его обновления) либо сравнивать не с кем. Моё сообщение с `sortKey <= ключ` прочитано.
 */
export function peerReadKeyOf(s: ConvSummary | undefined): number | null {
  return s && s.kind === 'direct' && typeof s.peerReadKey === 'number' ? s.peerReadKey : null;
}

/**
 * Есть сводка без поля `peerReadKey`. От сервера с `conv4` такая снята ДО его обновления (кеш на диске): догонка
 * приносит только задетые беседы, и у остальных навсегда осталась бы одна галочка — список надо перечитать. `null` —
 * поле есть («сравнивать не с кем»), перечитывать незачем.
 */
export function lacksPeerRead(summaries: Record<string, ConvSummary>): boolean {
  return Object.values(summaries).some((s) => s.peerReadKey === undefined);
}

/**
 * Перечитанный список → `peerReadKey` в сводки, где поля нет. Берём ТОЛЬКО это поле: на сервере оно не убывает
 * (`convRules.peerReadKey`), поэтому годится из снимка любого номера; остальное в сводке и её номер свежести ведут
 * журнал и события. Сводку целиком брать нельзя: по правилу свежести снимок того же номера, что кеш (журнал не
 * сдвигался), не применился бы вовсе, а в обход свежести — откатил бы своё, ещё не дошедшее до сервера (например,
 * «прочитано» до ответа). Нечего дописать — то же состояние.
 */
export function withPeerRead(state: ConvState, list: readonly ConvSummary[]): ConvState {
  let summaries: Record<string, ConvSummary> | null = null;
  for (const s of list) {
    const cur = state.summaries[s.id];
    if (!cur || cur.peerReadKey !== undefined || s.peerReadKey === undefined) continue;
    summaries ??= { ...state.summaries };
    summaries[s.id] = { ...cur, peerReadKey: s.peerReadKey };
  }
  return summaries ? { ...state, summaries } : state;
}

/** Список для интерфейса: свежие сверху. */
export function summariesToDms(summaries: Record<string, ConvSummary>): DmChannel[] {
  return Object.values(summaries).sort(recent).map(summaryToDm);
}

/**
 * Какие беседы горят после списка или догонки: с непрочитанным, кроме той, что на экране (как `seedDmList`). Число
 * в строке — из сводки как есть: сервер считает точно, ±1 на клиенте больше нет.
 */
export function seedUnread(summaries: Record<string, ConvSummary>, onScreenId: string | null): string[] {
  return Object.values(summaries)
    .filter((s) => s.unread > 0 && s.id !== onScreenId)
    .map((s) => s.id);
}

/**
 * Горит ли беседа после живого события. Сводка сказала «0» — гаснет (прочитал здесь или на другом устройстве).
 * Зажигает только НОВОЕ чужое сообщение, когда человек не смотрит (`light` — решение `dmIncomingDecision.countUnread`):
 * правка или реакция в прочитанной беседе не зажигают, а беседа, открытая в свёрнутом окне, горит (Б8) — фокус окна
 * сводка не видит.
 */
export function nextUnread(current: readonly string[], summary: ConvSummary, light: boolean): string[] {
  const has = current.includes(summary.id);
  if (summary.unread === 0) return has ? current.filter((x) => x !== summary.id) : [...current];
  if (light && !has) return [...current, summary.id];
  return [...current];
}

/** Ключ «прочитано до»: последнее сообщение в ленте, а без ленты — последнее из сводки. */
export function readKeyFor(list: readonly ConvMessage[] | undefined, summary: ConvSummary | undefined): number | null {
  const last = list && list.length > 0 ? list[list.length - 1] : null;
  if (last) return last.sortKey;
  return summary?.lastMessage?.sortKey ?? null;
}

/** Пакет отметки «прочитано до» на сервер, если дочитали не до конца (G09; Telegram ПК: `kReadRequestTimeout` = 3 с). */
export const READ_BATCH_MS = 3_000;

/**
 * «Прочитано» по видимому (G09, `readByView.ts`): ключ, до которого отмечать, — не дальше увиденного лентой. Увиденного
 * нет — `null`: ничего не отмечаем (беседа открыта, но лента ещё не показала ни одной строки целиком).
 */
export function clampReadKey(loadedKey: number | null, seenKey: number | undefined): number | null {
  if (loadedKey === null || seenKey === undefined) return null;
  return Math.min(loadedKey, seenKey);
}

/**
 * Через сколько отправить «прочитано до `key`»: `0` — сразу (дочитали до последнего сообщения беседы `lastKey`, как у
 * Telegram), иначе `READ_BATCH_MS`. Последнее неизвестно — пакетом.
 */
export function seenFlushDelay(key: number, lastKey: number | null | undefined): number {
  return lastKey !== null && lastKey !== undefined && key >= lastKey ? 0 : READ_BATCH_MS;
}

/** Черновик беседы на устройстве (шаг 2д): текст и ответ. */
export interface ConvDraft {
  text: string;
  replyToId: string | null;
}

/**
 * Переход черновиков стора (`store.setDraft`): пустой — ни текста, ни ответа — удалён; то же значение — тот же объект,
 * стор не пересоздаётся (иначе каждая буква будила бы подписчиков ленты).
 */
export function updateDrafts(
  drafts: Record<string, ConvDraft>,
  convId: string,
  text: string,
  replyToId: string | null,
): Record<string, ConvDraft> {
  const cur = drafts[convId];
  const empty = !text.trim() && !replyToId;
  if (empty ? !cur : cur && cur.text === text && cur.replyToId === replyToId) return drafts;
  const next = { ...drafts };
  if (empty) delete next[convId];
  else next[convId] = { text, replyToId };
  return next;
}

/**
 * Сервер хранит черновики (Р7): объявил `conv3`. Здесь, а не в сторе: стор значения из `@gusvoice/shared` не
 * импортирует (его грузит харнесс тестов с перечнем разрешённых модулей).
 */
export function serverKeepsDrafts(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CONV3);
}

/**
 * Черновик из сводки сервера (Р7) → черновик устройства. Применяем, только если:
 * - сервер черновики знает (`undefined` — сервер до `conv3`: своё не трогаем);
 * - здесь нет неотправленного на сервер (`dirty`) — набранное на этом устройстве важнее, оно уйдёт следом;
 * - это не своё эхо (метка устройства): опоздавшее событие о прошлой записи вернуло бы в поле старый текст;
 * - он отличается от того, что уже лежит (пусто = нет черновика).
 * Итог `null` — удалить черновик (его погасили на другом устройстве, например отправкой).
 */
export function remoteDraftDecision(p: {
  remote: ConvSummary['draft'];
  local: ConvDraft | undefined;
  dirty: boolean;
  device: string;
}): { apply: false } | { apply: true; draft: ConvDraft | null } {
  if (p.remote === undefined || p.dirty) return { apply: false };
  if (p.remote && p.remote.device === p.device) return { apply: false };
  const next = p.remote && (p.remote.text.trim() || p.remote.replyToId) ? { text: p.remote.text, replyToId: p.remote.replyToId } : null;
  const cur = p.local ?? null;
  if (next === null ? cur === null : !!cur && cur.text === next.text && cur.replyToId === next.replyToId) return { apply: false };
  return { apply: true, draft: next };
}

// ─── Закреп в ЛС (С2, признак `conv7`; раунд 12, порция 7) ────────────────────────────────────────────────────────────

/**
 * Список закреплённых беседы с номером `P`: ответ ручки (`api.convPins` / `convPin` / `convUnpin`), событие
 * `conv.change` с полем `pins` или догонка. Список приходит ЦЕЛИКОМ (замена, не дельта) и берётся, только если он НОВЕЕ
 * того, что в памяти (`P` больше), — правило свежести сводки: опоздавший ответ загрузки не откатит закреп, уже
 * пришедший событием. Тот же номер — тот же список (ответ своего закрепа и его эхо-событие): состояние не меняется.
 */
export function applyPins(state: ConvState, convId: string, list: readonly ConvPin[], P: number): ConvState {
  const own = state.pins?.[convId];
  if (own && P <= own.pts) return state;
  return { ...state, pins: { ...state.pins, [convId]: { pts: P, list: [...list] } } };
}

/**
 * Забыть списки закреплённых: одной беседы (`convId` — беседа ушла из списка) или все (смена токена: миниатюры — ссылки
 * прежнего поколения, они погасли). Открытая лента попросит свой список заново. Забывать нечего — то же состояние:
 * снимок без поля пустым полем не обрастает.
 */
export function dropPins(state: ConvState, convId?: string): ConvState {
  const pins = state.pins;
  if (!pins) return state;
  if (convId === undefined) return Object.keys(pins).length ? { ...state, pins: {} } : state;
  if (!(convId in pins)) return state;
  const { [convId]: _dropped, ...rest } = pins;
  return { ...state, pins: rest };
}

/** Предел закреплённых в беседе — зеркало сервера (`convRules.PINS_MAX`), только для текста отказа: 409 его не несёт в ошибке. */
export const DM_PINS_MAX = 50;

/** Отказ «список закреплённых полон»: 409 `{error: 'pin limit'}` (у ошибки `api` — `status` и текст `error`). */
export function isPinLimit(e: unknown): boolean {
  const x = e as { status?: unknown; message?: unknown } | null;
  return !!x && x.status === 409 && x.message === 'pin limit';
}

type PinPreviewSource = Pick<
  ConvLastMessage,
  'text' | 'attachments' | 'attachmentKind' | 'attachmentDurationMs' | 'attachmentName' | 'attachmentVideo' | 'attachmentGif' | 'attachmentRound'
>;

/**
 * Закреплённое одной строкой — правило цитат раунда 10 (`bubbleRules.replyQuoteLook`, HANDOFF §2.3) по превью сервера
 * (`ConvLastMessage`): текст; фото — подпись или «Фото»; голосовое — «Голосовое сообщение» (без длительности, 08.10); файл — имя файла,
 * видео (`attachmentVideo`, 05.10) — «Видео»;
 * стикер — «Стикер»; вид незнакомый или его нет (сервер до раунда 11) — подпись или «Вложение».
 * `list` — строка списка всех закреплённых (`.pins-pop`): миниатюры там нет, поэтому у фото с подписью впереди «Фото · »
 * (макет `Desktop-pins-3-list`); полоса показывает подпись рядом с миниатюрой.
 */
export function pinPreview(m: PinPreviewSource, list = false): string {
  const caption = typeof m.text === 'string' ? m.text.trim() : '';
  const n = typeof m.attachments === 'number' && Number.isFinite(m.attachments) ? m.attachments : 0;
  if (n <= 0) return caption || 'Сообщение';
  // GIF (`attachmentGif`, `gifs1`): как в строке списка — «GIF» (у подписанного — подпись/«GIF · подпись» в списке закреплённых).
  if (m.attachmentGif === true) return caption ? (list ? `GIF · ${caption}` : caption) : 'GIF';
  switch (m.attachmentKind) {
    case 'photo':
      return caption ? (list ? `Фото · ${caption}` : caption) : 'Фото';
    case 'voice':
      // Решение владельца 08.10 («как Telegram»): без длительности.
      return 'Голосовое сообщение';
    case 'file': {
      // Кружок (`circles1`, G68): «Видеосообщение», как строка списка.
      if (m.attachmentRound === true && n === 1) return 'Видеосообщение';
      if (m.attachmentVideo === true) return 'Видео';
      const name = typeof m.attachmentName === 'string' ? m.attachmentName.trim() : '';
      return name || 'Файл';
    }
    case 'sticker':
      return 'Стикер';
    default:
      return caption || 'Вложение';
  }
}

/** Часы и минуты — тем же форматом, что время в пузыре и в подвале меню (`MessagePane.TIME_FMT`, `sentAtLabel`). */
const PIN_TIME = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
/** «27 сентября» — число и месяц в родительном падеже, по-русски, как весь интерфейс. */
const PIN_DAY = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' });

/**
 * Когда отправлено закреплённое — строка списка всех закреплённых (`.pin-when`, макет `Desktop-pins-3-list`): «сегодня,
 * 21:08», «вчера, 14:10», «27 сентября, 18:05», в прошлые годы — «31 декабря 2025, 23:59». Дни — календарные, по
 * местному времени; время из будущего (часы устройства отстают) — «сегодня». Не разбирается — пусто.
 */
export function pinWhenLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const time = PIN_TIME.format(d);
  const dayOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const day = dayOf(d);
  if (day >= dayOf(now)) return `сегодня, ${time}`;
  if (day === dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return `вчера, ${time}`;
  const date = PIN_DAY.format(d);
  return d.getFullYear() === now.getFullYear() ? `${date}, ${time}` : `${date} ${d.getFullYear()}, ${time}`;
}

// ─── Отложенные (С4, признак `conv9`; раунд 12, порция 8) ────────────────────────────────────────────────────────────

/**
 * Список моих отложенных беседы с номером `P`: ответ ручки (`api.convScheduled` / `convSchedule` / `convScheduledEdit` /
 * `convScheduledDelete` / «отправить сейчас»), событие `conv.change` с полем `scheduled` или догонка. Список приходит
 * ЦЕЛИКОМ (замена, не дельта) и берётся, только если он НОВЕЕ того, что в памяти, — то же правило свежести, что у
 * закрепа (`applyPins`): опоздавший ответ не вернёт уже ушедшее отложенное. Тот же номер — тот же список.
 */
export function applyScheduled(state: ConvState, convId: string, list: readonly ConvScheduled[], P: number): ConvState {
  const own = state.scheduled?.[convId];
  if (own && P <= own.pts) return state;
  return { ...state, scheduled: { ...state.scheduled, [convId]: { pts: P, list: [...list] } } };
}

/**
 * Забыть списки отложенных: одной беседы (`convId` — беседа ушла из списка) или все. Забывать нечего — то же состояние:
 * снимок без поля пустым полем не обрастает.
 */
export function dropScheduled(state: ConvState, convId?: string): ConvState {
  const scheduled = state.scheduled;
  if (!scheduled) return state;
  if (convId === undefined) return Object.keys(scheduled).length ? { ...state, scheduled: {} } : state;
  if (!(convId in scheduled)) return state;
  const { [convId]: _dropped, ...rest } = scheduled;
  return { ...state, scheduled: rest };
}

/**
 * Сколько у меня отложенных в беседе — вход «Отложенные сообщения: N» в поле ввода. Список уже в памяти — его длина (её
 * видит вид «Отложенные»); иначе — число из сводки (`scheduledCount`; нет поля — сервер до `conv9`, считать 0).
 */
export function scheduledCountOf(entry: ConvScheduledEntry | undefined, summary: ConvSummary | undefined): number {
  if (entry) return entry.list.length;
  const n = summary?.scheduledCount;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// ─── Длинный черновик (порция «Отправка», 07.10) ─────────────────────────────────────────────────────────────────────

/**
 * Потолок черновика, который клиент ШЛЁТ на сервер. Сервер с 07.10 принимает 4096 (`convRules.DRAFT_TEXT_MAX`), но клиент оставил
 * 4000: старый сервер длиннее 4000 отвергает (400), а черновик такой длины — не повод ломать запись в смешанной паре.
 */
export const DRAFT_SERVER_MAX = 4000;

/**
 * Текст черновика для записи на сервер (Р7). Поле ввода предел не держит (длинное при отправке режется на сообщения, как у
 * Telegram), а сервер черновик длиннее `DRAFT_SERVER_MAX` отвергает (400) — тогда запись не шла вовсе, на сервере
 * оставался старый черновик, и сводка с ним (с другого устройства) затирала набранное здесь. Поэтому на сервер уходит
 * начало текста (пару UTF-16 эмодзи не рвём): у этого устройства полный текст остаётся (своё эхо не применяется), на
 * другом — первые 4000 знаков.
 */
export function draftTextForServer(text: string, max = DRAFT_SERVER_MAX): string {
  if (text.length <= max) return text;
  let end = max;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return text.slice(0, end);
}

/** Сервер знает настройки уведомлений и отложенный пуш (G38, `push2`): «Показывать имя / текст», «Уведомления из групп». */
export function serverPush2(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_PUSH2);
}

/** Сервер знает «Личные сообщения», «Повторять уведомления» и повтор пуша (G38, `push3`). Исключения — заглушки, признака не нужно. */
export function serverPush3(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_PUSH3);
}

/**
 * Сервер знает исключение «Уведомления включены» (08.10, решение владельца 38, `push4`): пункт «Включить уведомления» в меню
 * беседы при выключенных «Личных» / группах и строка «Уведомления включены» в «Исключениях».
 */
export function serverPush4(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_PUSH4);
}

/**
 * Сервер умеет «Высокое качество», спойлер и подпись над медиа в окне отправки файлов (08.10, #211, G48, `media2`):
 * `spoiler` у вложения и `captionAbove` у сообщения. Без признака пунктов в окне нет: старый сервер поля молча отбросит,
 * и спойлер ушёл бы открытым фото. «Высокое качество» — клиентское, но предел 1280 px у обычного фото включается вместе с ним.
 */
export function serverMediaFlags(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_MEDIA2);
}

/**
 * Сервер умеет цитату фрагмента и «Ответить в другом чате» (`quote1`, G55): только тогда в меню есть «Ответить с цитатой»,
 * у выделения пальцем — «Цитировать», а нажатие на полосу ответа открывает окно параметров ответа.
 */
export function serverQuote(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_QUOTE1);
}

/**
 * ЛС между инстансами, Э2 часть Б (#141, Ф7, `docs/dm/FEDERATION.md` §1.6): сводка беседы с человеком соседа несёт `fedLink: 'broken'`,
 * пока связка разорвана или приостановлена, — беседа остаётся АРХИВОМ ТОЛЬКО ДЛЯ ЧТЕНИЯ (поле ввода заменено плашкой, записи нет).
 * Поля нет в `ConvSummary` (бэкенд добавляет его добавлением, правило 11), поэтому читаем его без типа.
 */
export function fedLinkBroken(summary: object | null | undefined): boolean {
  return (summary as { fedLink?: unknown } | null | undefined)?.fedLink === 'broken';
}

/**
 * Плашка вместо поля ввода у архива (Ф7); `label` — название инстанса собеседника (`peerHomeLabel`). Слово в слово как отказ записи
 * `federation.dm_link_broken` в `fedErrorText` (модуль не импортируем: у этого файла закрытый перечень зависимостей).
 */
export function fedLinkStale(summary: object | null | undefined): boolean {
  return (summary as { fedStale?: unknown } | null | undefined)?.fedStale === true;
}

/**
 * Исправления ревью ЛС 12.10, п. 7 (`ConvSummary.fedStale`): инстанс собеседника не забирает наши сообщения дольше 10 минут — плашка
 * над полем ввода (писать можно, доедут, когда заберёт). `label` — как у архива (`peerHomeLabel`).
 */
export function fedLinkStaleText(label: string | null | undefined): string {
  return label ? `Сообщения ждут, пока «${label}» их заберёт` : 'Сообщения ждут, пока инстанс собеседника их заберёт';
}

/**
 * Хвост Э7 (14.10, `ConvSummary.fedPeerDown`): дом собеседника 1:1 не отвечает дольше 10 минут — тот же признак, что у плашки
 * группы «Инстанс «X», где живёт группа, недоступен» (`groupChatRules.fedGroupDownText`). Плашка над полем (писать можно); важнее
 * «Сообщения ждут» (`fedLinkStale`): одна плашка, а «доедут, когда вернётся» покрывает и очередь.
 */
export function fedPeerDown(summary: object | null | undefined): boolean {
  return (summary as { fedPeerDown?: unknown } | null | undefined)?.fedPeerDown === true;
}

/** Текст плашки `fedPeerDown`; `label` — название инстанса собеседника для соседей, иначе домен (`peerHomeLabel`). */
export function fedPeerDownText(label: string | null | undefined): string {
  return label
    ? `Инстанс «${label}» недоступен — сообщения доедут, когда он вернётся`
    : 'Инстанс собеседника недоступен — сообщения доедут, когда он вернётся';
}

export function fedLinkBrokenText(label: string | null | undefined): string {
  return label
    ? `Связь с инстансом «${label}» разорвана — переписка доступна только для чтения`
    : 'Связь с инстансом собеседника разорвана — переписка доступна только для чтения';
}

/**
 * Подсказка у недоступных вложений в беседе с человеком другого инстанса (Э2 часть Б, п.1): файлы между инстансами ездят с Э3.
 * Показывается ДО отправки — у скрепки, при вставке и броске файла, — а не только отказом сервера `federation.dm_attachments_later`.
 */
export const FED_FILES_LATER_HINT = 'Вложения в переписке с людьми других инстансов появятся в следующем обновлении';

/** Сервер возит вложения между инстансами (Э3, #141, `fedm3`). Без признака вложения в беседах с людьми соседей закрыты, как в Э2. */
export function serverFedFiles(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_FEDM3);
}

/** Сервер переносит «печатает» и «в сети» / «был(а) в сети» людей соседних инстансов (Э4, #141, `fedm4`). */
export function serverFedPresence(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_FEDM4);
}

/**
 * Э4 (#141, `fedm4`): показывать ли статус собеседника в ЛС (шапка, карточка из ЛС): «в сети», точку, «был(а) …», «печатает».
 * У человека другого инстанса (`peerHome`) — только если сервер объявил `fedm4`: без него теневой пользователь никогда не «в сети»,
 * а его `last-seen` отдаёт «был(а) давно» — ложь про живого человека. Для местных — всегда, как раньше.
 */
export function peerPresenceShown(peerHome: boolean, features: readonly string[] | null | undefined): boolean {
  return !peerHome || serverFedPresence(features);
}

/** Э3 (#141, `fedm3`): наш сервер вложения умеет, а инстанс собеседника — ещё нет (`fedNoFiles` в сводке беседы). */
export const FED_FILES_PEER_HINT = 'Инстанс собеседника пока не принимает вложения — текст доходит';

/**
 * Э3 (#141, `fedm3`): закрыты ли вложения (файлы, голосовые, кружки, GIF) в беседе. Только в беседе с человеком другого инстанса
 * (`peerHome`) и только если сервер не объявил `fedm3` (`fedFiles`) ИЛИ у сводки беседы `fedNoFiles`. Возвращает подсказку для
 * `filesBlocked` (скрепка, вставка, бросок, «Поделиться», пересылка) или `null` — тогда беседа как обычная ЛС.
 */
export function fedFilesHint(peerHome: boolean, fedFiles: boolean, summary: { fedNoFiles?: unknown } | null | undefined): string | null {
  if (!peerHome) return null;
  if (!fedFiles) return FED_FILES_LATER_HINT;
  return summary?.fedNoFiles ? FED_FILES_PEER_HINT : null;
}

// ─── Э5 (#141, `fedm5`): «мой дом лежит — пишу через инстанс собеседника» ─────────────────────────────────────────────

/** Подсказка у всего, что в обход дома не уходит (вложения, голос, GIF, стикеры, правка, реакции, пересылка): уходит только текст. */
export const FED_VIA_TEXT_ONLY = 'Дом недоступен — пока только текст';

/** Сервер объявил обходной путь Э5 (`fedm5`): долгая сессия на инстансе собеседника и отчёт задним числом. */
export function serverFedVia(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_FEDM5);
}

/**
 * Э5: нужна ли беседе долгая сессия на инстансе собеседника — 1:1 с человеком другого инстанса (`peerHome`), сервер с `fedm5`, связь
 * не разорвана (архив, `fedLink: 'broken'`, пишется только на чтение). Местные беседы и сервер без `fedm5` — не нужна.
 */
export function fedViaWanted(peerHome: boolean, features: readonly string[] | null | undefined, summary: { fedLink?: unknown } | null | undefined): boolean {
  return peerHome && serverFedVia(features) && summary?.fedLink !== 'broken';
}

/** Плашка над полем ввода, пока дом недоступен и текст уходит через инстанс собеседника. */
export function fedViaBarText(self: string, peer: string): string {
  return `Инстанс «${self || 'Мой'}» недоступен — пишем через «${peer || 'инстанс собеседника'}»`;
}

/**
 * Э5: ошибка запроса к дому говорит «дома нет», а не «мне отказали»: запрос не дошёл (нет статуса: сбой сети, `TypeError`),
 * сервер молчал дольше срока (`timeout`) или шлюз/прокси ответил 502/503/504. Прочие отказы (400/403/404/409/429, 500) — дом ЖИВ и
 * решил сам: обходить его нельзя.
 */
export function isHomeDownError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const x = e as { status?: number; switched?: boolean; aborted?: boolean; name?: string };
  if (x.switched || x.aborted || x.name === 'AbortError') return false;
  if (typeof x.status === 'number') return x.status === 502 || x.status === 503 || x.status === 504;
  return true;
}

/**
 * Э5: годится ли строка очереди для обхода дома — ТОЛЬКО текст и ответ (бэкенд принимает `clientId`, `content`, `replyToId`, `silent`,
 * `noPreview`; остальное — 403 `federation.dm_via_limited`). Файлы, «как файлы», спойлер, подпись над медиа и цитата фрагмента — нет.
 */
export function viaSendable(it: {
  content: string;
  fileNames: readonly string[];
  asFile?: unknown;
  spoilers?: unknown;
  captionAbove?: unknown;
  replyQuote?: unknown;
}): boolean {
  return it.content.trim().length > 0 && it.fileNames.length === 0 && !it.asFile && !it.spoilers && !it.captionAbove && !it.replyQuote;
}

/**
 * Э5: свести страницу истории, снятую у ИНСТАНСА СОБЕСЕДНИКА (дом лежит), с окном беседы. Номера свежести `pts` у чужого инстанса
 * другие — их в окно НЕ пишем: добавляются только неизвестные сообщения (с `msgPts = 0`, любое событие дома их обновит), известные
 * остаются как есть (кеш дома первичен), удалённые не воскрешаются. Окно не трогаем, кроме добавления в хвост; без окна — ничего.
 */
export function applyViaPage(
  state: ConvState,
  list: readonly ConvMessage[] | undefined,
  convId: string,
  messages: readonly ConvMessage[],
): { state: ConvState; list: ConvMessage[] | undefined } {
  const win = state.windows[convId];
  // Окно не у хвоста (листают историю) — дописать в низ нельзя: между ними дыра.
  if (!list || !win || win.hasMoreAfter) return { state, list: list ? [...list] : undefined };
  const have = new Set(list.map((m) => m.id));
  const fresh = messages.filter((m) => !have.has(m.id) && !state.gone[m.id]);
  if (fresh.length === 0) return { state, list: [...list] };
  const msgPts = { ...state.msgPts };
  for (const m of fresh) msgPts[m.id] = msgPts[m.id] ?? 0;
  return { state: { ...state, msgPts }, list: dedupe([...list, ...fresh].sort(compareConv)) };
}

/**
 * «Кто может мне писать» (`msgpriv1`, 13.10): плашка вместо поля ввода, когда собеседник пускает только контакты
 * (`UserLastSeen.canMessage === false`). tdesktop `lng_restricted_send_non_premium` / `lng_send_non_premium_message_toast`
 * («{user} only accepts messages from contacts and Premium subscribers»; Premium у нас нет). Тот же текст без имени —
 * `fedErrorText.messagePrivacyText` (модули не связаны: их проверки держат закрытые перечни зависимостей).
 */
export function messagePrivacyPlateText(name: string): string {
  return `${name} принимает сообщения только от своих контактов.`;
}

/**
 * Писать боту нельзя (решение владельца 26.10, A): плашка вместо поля ввода по `otherUser.botUnavailable` сводки беседы —
 * `disabled` (бот выключен админом или все боты на сервере), `private` (бот не «Для всех», а я не владелец). Как плашка
 * заблокированного / «только контакты». Незнакомая причина (сервер новее) — как `disabled`.
 */
export function botUnavailablePlateText(reason: string, name: string): string {
  return reason === 'private' ? `${name} — приватный бот: писать ему может только его владелец.` : `${name} сейчас недоступен: бот выключен.`;
}
