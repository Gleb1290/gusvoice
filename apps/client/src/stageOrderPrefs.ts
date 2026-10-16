import { useSyncExternalStore } from 'react';
import {
  dropStageOrders,
  mergeStageOrder,
  parseStageOrders,
  putStageOrder,
  serializeStageOrders,
  type StageOrders,
} from './stageOrderRules';

/**
 * Раскладка плиток сцены, расставленная перетаскиванием (12.10). Локально на этом устройстве (как
 * `stageViewPrefs.ts`), на сервер не уходит. Ключ — канал + число колонок сетки: у каждой ширины окна
 * своя раскладка. Правила (слияние, обрезка, вытеснение) — чистые, в `stageOrderRules.ts`.
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

/** Сохранённый порядок сетки канала при этом числе колонок; нет — `null`. */
export function getStageOrder(channelId: string | null, cols: number): string[] | null {
  if (!channelId) return null;
  return current[channelId]?.cols[String(cols)] ?? null;
}

/** Есть ли у канала хоть одна сохранённая раскладка (для пункта «Сбросить раскладку плиток»). */
export function hasStageOrder(channelId: string | null): boolean {
  return !!channelId && !!current[channelId];
}

/** Запомнить новый видимый порядок; ушедшие из прежнего списка остаются на своих местах. */
export function saveStageOrder(channelId: string, cols: number, visible: readonly string[]): void {
  const merged = mergeStageOrder(getStageOrder(channelId, cols), visible);
  write(putStageOrder(current, channelId, cols, merged, Date.now()));
}

/** Сбросить раскладки канала при всех ширинах окна. */
export function resetStageOrder(channelId: string): void {
  write(dropStageOrders(current, channelId));
}

/** Подписка на смену раскладок. Возвращает отписку. */
export function onStageOrder(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Порядок для сцены — перерисовка по смене (ссылка стабильна, пока записи не было). */
export function useStageOrder(channelId: string | null, cols: number): string[] | null {
  return useSyncExternalStore(onStageOrder, () => getStageOrder(channelId, cols));
}

/** Для меню канала: есть ли что сбрасывать. */
export function useHasStageOrder(channelId: string | null): boolean {
  return useSyncExternalStore(onStageOrder, () => hasStageOrder(channelId));
}
