import { useSyncExternalStore } from 'react';
import {
  dropStageOrders,
  mergeStageOrder,
  parseStageOrders,
  putStageModeOrder,
  putStageOrder,
  serializeStageOrders,
  type StageOrderMode,
  type StageOrders,
} from './stageOrderRules';

/**
 * Раскладка плиток сцены, расставленная перетаскиванием (12.10). Локально на этом устройстве (как
 * `stageViewPrefs.ts`), на сервер не уходит. Ключ — канал + число колонок сетки: у каждой ширины окна
 * своя раскладка; у режима просмотра показа — канал + контейнер (`modes`, 16.10). Правила (слияние, обрезка, вытеснение) — чистые, в `stageOrderRules.ts`.
 */
const KEY = 'gv_stage_order';
const listeners = new Set<() => void>();

function read(): StageOrders {
  try {
    return parseStageOrders(localStorage.getItem(KEY));
  } catch {
    return {};
  }
}

// ⚠️ Объявлено до функций, но читается только из них — на загрузке модуля обращения нет (урок 18.09).
let current: StageOrders = read();

function write(next: StageOrders): void {
  if (next === current) return;
  current = next;
  try {
    if (Object.keys(next).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, serializeStageOrders(next));
  } catch {
    /* не запомнили — раскладка всё равно действует до перезагрузки */
  }
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* один слушатель не должен ронять остальных */
    }
  }
}

/**
 * Раскладка, к которой относится порядок: число колонок сетки «под окно» или контейнер режима просмотра
 * показа (`STAGE_ORDER_MODES`, 16.10). Одна точка входа на оба случая — сцена и меню канала не различают их.
 */
export type StageOrderLayout = number | StageOrderMode;

/** Сохранённый порядок канала в этой раскладке; нет — `null`. */
export function getStageOrder(channelId: string | null, layout: StageOrderLayout): string[] | null {
  if (!channelId) return null;
  if (typeof layout !== 'number') return current[channelId]?.modes?.[layout] ?? null;
  const cols = layout;
  return current[channelId]?.cols[String(cols)] ?? null;
}

/** Есть ли у канала хоть одна сохранённая раскладка (для пункта «Сбросить раскладку плиток»). */
export function hasStageOrder(channelId: string | null): boolean {
  return !!channelId && !!current[channelId];
}

/** Запомнить новый видимый порядок; ушедшие из прежнего списка остаются на своих местах. */
export function saveStageOrder(channelId: string, layout: StageOrderLayout, visible: readonly string[]): void {
  const merged = mergeStageOrder(getStageOrder(channelId, layout), visible);
  write(
    typeof layout === 'number'
      ? putStageOrder(current, channelId, layout, merged, Date.now())
      : putStageModeOrder(current, channelId, layout, merged, Date.now()),
  );
}

/** Сбросить раскладки канала при всех ширинах окна и во всех режимах просмотра. */
export function resetStageOrder(channelId: string): void {
  write(dropStageOrders(current, channelId));
}

/** Подписка на смену раскладок. Возвращает отписку. */
export function onStageOrder(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Порядок для сцены — перерисовка по смене (ссылка стабильна, пока записи не было). */
export function useStageOrder(channelId: string | null, layout: StageOrderLayout): string[] | null {
  return useSyncExternalStore(onStageOrder, () => getStageOrder(channelId, layout));
}

/** Для меню канала: есть ли что сбрасывать. */
export function useHasStageOrder(channelId: string | null): boolean {
  return useSyncExternalStore(onStageOrder, () => hasStageOrder(channelId));
}
