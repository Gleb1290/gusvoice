/**
 * Настройки своих всплывающих уведомлений на ПК (G38, ND-07) — на устройстве, как у Telegram Desktop (`core_settings`:
 * `nativeNotifications`, `notificationsCorner`, `notificationsCount`, `notificationsDisplayChecksum`).
 *
 * «Использовать уведомления Windows» по умолчанию ВЫКЛЮЧЕНО — как у Telegram Desktop на Windows
 * (`platform/win/notifications_manager_win.cpp`: `ByDefault()` = `false`), то есть по умолчанию — свои окна.
 */
import { popupCorner, popupCount, POPUP_CORNER_DEFAULT, POPUP_COUNT_DEFAULT, type PopupCorner } from './notifyPopupRules';

export interface NotifyPopupPrefs {
  /** Системные тосты вместо своих окон. */
  native: boolean;
  corner: PopupCorner;
  count: number;
  /** Имя монитора; пусто — монитор главного окна (как у Telegram без выбора). */
  monitor: string;
}

export const NOTIFY_POPUP_DEFAULTS: NotifyPopupPrefs = {
  native: false,
  corner: POPUP_CORNER_DEFAULT,
  count: POPUP_COUNT_DEFAULT,
  monitor: '',
};

const KEY = 'gv_notify_popup';

export function getNotifyPopupPrefs(): NotifyPopupPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...NOTIFY_POPUP_DEFAULTS };
    const p = JSON.parse(raw) as Partial<NotifyPopupPrefs> | null;
    if (!p || typeof p !== 'object') return { ...NOTIFY_POPUP_DEFAULTS };
    return {
      native: p.native === true,
      corner: popupCorner(p.corner),
      count: p.count === undefined ? POPUP_COUNT_DEFAULT : popupCount(p.count),
      monitor: typeof p.monitor === 'string' ? p.monitor : '',
    };
  } catch {
    return { ...NOTIFY_POPUP_DEFAULTS };
  }
}

const listeners = new Set<(p: NotifyPopupPrefs) => void>();

export function setNotifyPopupPrefs(patch: Partial<NotifyPopupPrefs>): NotifyPopupPrefs {
  const next = { ...getNotifyPopupPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* хранилище недоступно — настройка живёт до перезапуска */
  }
  for (const fn of listeners) fn(next);
  return next;
}

/** Подписка главного окна: сменили угол/число/монитор — переложить стопку на экране сразу (`notifyPopupHost.ts`). */
export function onNotifyPopupPrefs(fn: (p: NotifyPopupPrefs) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
