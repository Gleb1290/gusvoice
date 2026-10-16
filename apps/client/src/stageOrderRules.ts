/**
 * Порядок плиток сцены голосового канала, расставленный перетаскиванием (12.10). Чистые правила без
 * DOM и хранилища: применение сохранённого порядка к текущему составу, слияние при сохранении,
 * перестановка при перетаскивании, разбор и обрезка того, что лежит в localStorage.
 *
 * Порядок — список ключей плиток: `p:<identity>` у человека, `s:<identity владельца>` у карточки
 * показа (спутник `<id>#screen` сводится к владельцу, см. `stageTileKey`).
 */

/** Сколько ключей держим в сохранённом порядке одной сетки (видимые + запомненные ушедшие). */
export const STAGE_ORDER_MAX_KEYS = 64;
/** Сколько каналов помним; сверх — вытесняем тот, что дольше всех не трогали. */
export const STAGE_ORDER_MAX_CHANNELS = 40;
/** Сколько разных чисел колонок помним у одного канала (окно тянут — колонок бывает много). */
export const STAGE_ORDER_MAX_COLS = 8;

/** Ключ плитки человека. */
export function personTileKey(identity: string): string {
  return `p:${identity}`;
}

/** Ключ карточки показа: спутник нативного показа `<id>#screen` — под ключом владельца. */
export function streamTileKey(identity: string): string {
  return `s:${identity.endsWith('#screen') ? identity.slice(0, -'#screen'.length) : identity}`;
}

/**
 * Текущий состав в порядке по умолчанию + сохранённый порядок → порядок показа.
 * Ключи, которые есть в сохранённом, идут по своему сохранённому месту; новых там нет — встают после
 * них в порядке по умолчанию. Ушедшие (есть в сохранённом, нет в составе) просто пропускаются.
 * Повторы в составе схлопываются (первый выигрывает) — иначе React получил бы два одинаковых ключа.
 */
export function applyStageOrder(defaultKeys: readonly string[], saved: readonly string[] | null | undefined): string[] {
  const present = new Set<string>();
  const unique: string[] = [];
  for (const k of defaultKeys) {
    if (present.has(k)) continue;
    present.add(k);
    unique.push(k);
  }
  if (!saved || saved.length === 0) return unique;
  const known: string[] = [];
  const seen = new Set<string>();
  for (const k of saved) {
    if (present.has(k) && !seen.has(k)) {
      seen.add(k);
      known.push(k);
    }
  }
  return [...known, ...unique.filter((k) => !seen.has(k))];
}

/**
 * Что сохранить после перетаскивания. `visible` — новый порядок того, что на экране; ушедшие из
 * прежнего `saved` не теряются: каждый встаёт сразу после ближайшего своего предшественника по
 * прежнему списку (вернулся человек — оказался там же, где был). Длина — не больше `maxKeys`:
 * сверх неё отбрасываются запомненные ушедшие с конца, видимые не отбрасываются никогда.
 */
export function mergeStageOrder(
  saved: readonly string[] | null | undefined,
  visible: readonly string[],
  maxKeys: number = STAGE_ORDER_MAX_KEYS,
): string[] {
  const result = applyStageOrder(visible, null);
  const inResult = new Set(result);
  const absent: string[] = [];
  if (saved) {
    let prev: string | null = null;
    for (const k of saved) {
      if (inResult.has(k)) {
        prev = k;
        continue;
      }
      const at = prev === null ? 0 : result.indexOf(prev) + 1;
      result.splice(at, 0, k);
      inResult.add(k);
      absent.push(k);
      prev = k;
    }
  }
  if (result.length > maxKeys) {
    const visibleSet = new Set(visible);
    let extra = result.length - maxKeys;
    for (let i = result.length - 1; i >= 0 && extra > 0; i--) {
      if (!visibleSet.has(result[i])) {
        result.splice(i, 1);
        extra--;
      }
    }
  }
  return result;
}

/** Переставить `key` на место `toIndex` (остальные сдвигаются). Нет ключа или место то же — копия как есть. */
export function moveStageKey(order: readonly string[], key: string, toIndex: number): string[] {
  const from = order.indexOf(key);
  const next = [...order];
  if (from < 0) return next;
  const to = Math.max(0, Math.min(order.length - 1, Math.trunc(toIndex)));
  if (to === from) return next;
  next.splice(from, 1);
  next.splice(to, 0, key);
  return next;
}

/** Совпадают ли два порядка поэлементно. */
export function sameStageOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Порядок по умолчанию сохранять незачем: если перетаскивание вернуло всё как было и раньше ничего
 * не запоминали — записи не будет, и пункт «Сбросить раскладку» не появится зря.
 */
export function isDefaultStageOrder(defaultKeys: readonly string[], visible: readonly string[]): boolean {
  return sameStageOrder(applyStageOrder(defaultKeys, null), visible);
}

/** Сохранённые раскладки одного канала: число колонок → порядок; `at` — когда трогали (для вытеснения). */
export type StageChannelOrders = { at: number; cols: Record<string, string[]> };
export type StageOrders = Record<string, StageChannelOrders>;

/**
 * Разбор того, что лежит в хранилище. Чужое/испорченное отбрасывается по частям: битый канал не
 * роняет остальные, нестроковые ключи выкидываются, списки режутся до `STAGE_ORDER_MAX_KEYS`.
 */
export function parseStageOrders(raw: string | null | undefined): StageOrders {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const channels = (data as { channels?: unknown }).channels;
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) return {};
  const out: StageOrders = {};
  for (const [channelId, entry] of Object.entries(channels as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const at = Number((entry as { at?: unknown }).at);
    const cols = (entry as { cols?: unknown }).cols;
    if (!cols || typeof cols !== 'object' || Array.isArray(cols)) continue;
    const parsed: Record<string, string[]> = {};
    for (const [n, list] of Object.entries(cols as Record<string, unknown>)) {
      if (!/^[1-9]\d{0,2}$/.test(n) || !Array.isArray(list)) continue;
      const keys = list.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 200);
      if (keys.length > 0) parsed[n] = keys.slice(0, STAGE_ORDER_MAX_KEYS);
    }
    if (Object.keys(parsed).length > 0) out[channelId] = { at: Number.isFinite(at) ? at : 0, cols: parsed };
  }
  return out;
}

/** В строку для хранилища (с версией формата — на случай, если формат придётся менять добавлением). */
export function serializeStageOrders(orders: StageOrders): string {
  return JSON.stringify({ v: 1, channels: orders });
}

/**
 * Записать порядок сетки `channelId` × `cols` (новый объект, исходный не меняется). У канала
 * хранится не больше `STAGE_ORDER_MAX_COLS` чисел колонок (лишние — самые дальние от текущего),
 * каналов — не больше `maxChannels` (вытесняются дольше всех не тронутые).
 */
export function putStageOrder(
  orders: StageOrders,
  channelId: string,
  cols: number,
  order: readonly string[],
  now: number,
  maxChannels: number = STAGE_ORDER_MAX_CHANNELS,
): StageOrders {
  const prev = orders[channelId];
  const colsMap: Record<string, string[]> = { ...(prev?.cols ?? {}), [String(cols)]: [...order] };
  const colKeys = Object.keys(colsMap);
  if (colKeys.length > STAGE_ORDER_MAX_COLS) {
    colKeys
      .filter((n) => n !== String(cols))
      .sort((a, b) => Math.abs(Number(b) - cols) - Math.abs(Number(a) - cols))
      .slice(0, colKeys.length - STAGE_ORDER_MAX_COLS)
      .forEach((n) => delete colsMap[n]);
  }
  const next: StageOrders = { ...orders, [channelId]: { at: now, cols: colsMap } };
  const ids = Object.keys(next);
  if (ids.length > maxChannels) {
    ids
      .filter((id) => id !== channelId)
      .sort((a, b) => next[a].at - next[b].at)
      .slice(0, ids.length - maxChannels)
      .forEach((id) => delete next[id]);
  }
  return next;
}

/** Убрать все раскладки канала (все числа колонок). Нечего убирать — тот же объект. */
export function dropStageOrders(orders: StageOrders, channelId: string): StageOrders {
  if (!(channelId in orders)) return orders;
  const next = { ...orders };
  delete next[channelId];
  return next;
}

/**
 * Куда встаёт поднятая плитка. `center` — центр поднятой плитки, `slots` — ячейки сетки в порядке
 * показа (координаты раскладки, без анимационных сдвигов). Попали в ячейку — её индекс; в зазор
 * или мимо сетки — `null` (место не меняем, чтобы не дёргалось на пролёте).
 */
export function stageDropIndex(
  center: { x: number; y: number },
  slots: readonly { x: number; y: number; w: number; h: number }[],
): number | null {
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (center.x >= s.x && center.x < s.x + s.w && center.y >= s.y && center.y < s.y + s.h) return i;
  }
  return null;
}
