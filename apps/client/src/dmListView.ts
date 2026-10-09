/**
 * Вид списка бесед: «только аватары» на ПК и «две / три строки» (G34).
 *
 * Только аватары — Telegram Desktop `Dialogs::Widget` в узком режиме: колонка списка тоньше половины
 * `st::columnMinimalWidthLeft` (260 px / 2 = 130) сворачивается до `_narrowWidth` = `padding.left + photoSize + padding.left`
 * (10 + 46 + 10 = 66 px; у нас аватар 46 px (`DM_ROW_AVA`), поля по 13 — 72, как рельс серверов). Между 130 и нижней границей обычной колонки
 * (у нас `SIDEBAR_MIN`) ширина держится на нижней границе. Размер пишет `uiPrefs.setSidebarWidth`, режим читает `useSidebarNarrow`.
 *
 * Две / три строки — Telegram Android `SharedConfig.useThreeLinesLayout` («Вид списка чатов»: Two lines / Three lines,
 * `DialogCell`: высота 70 → 76 dp, текст последнего сообщения до двух строк, имя автора в группе — отдельной строкой). Настройка
 * этого устройства (localStorage `gv_list_lines`), аккаунт не синкает: у Telegram она тоже локальная. Переключатель —
 * «Настройки → Вид → Вид списка бесед» (`UserSettingsModal.tsx`).
 */
import { useSyncExternalStore } from 'react';

/** Ширина колонки в режиме «только аватары», px (стоит и в хранилище вместо обычной ширины). */
export const LIST_NARROW_W = 72;
/** Аватар в строке списка на ПК, px: tdesktop `defaultDialogRow.photoSize` 46 (высота строки 62 — `--dm-row-h` в `styles.css`). */
export const DM_ROW_AVA = 46;
/** Тоньше этого при перетаскивании ручки список сворачивается в аватары (tdesktop `columnMinimalWidthLeft / 2`). */
export const LIST_NARROW_BELOW = 130;

/**
 * Куда встанет колонка при перетаскивании ручки в `raw` px. `allowNarrow` — открыт список бесед (у каналов сервера узкого
 * режима нет): тогда тоньше порога — «только аватары», иначе — обычная ширина в пределах `min`…`max`.
 */
export function snapListWidth(raw: number, allowNarrow: boolean, min: number, max: number): number {
  if (allowNarrow && raw < LIST_NARROW_BELOW) return LIST_NARROW_W;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

/** Ширина, которую реально получит колонка: сохранённое «только аватары» вне списка бесед — обычная (`fallback`). */
export function effectiveListWidth(stored: number, allowNarrow: boolean, fallback: number): number {
  return stored === LIST_NARROW_W && !allowNarrow ? fallback : stored;
}

export type ListLines = 'two' | 'three';
export const LIST_LINES_DEFAULT: ListLines = 'two';
const LINES_KEY = 'gv_list_lines';

export function getListLines(): ListLines {
  try {
    return localStorage.getItem(LINES_KEY) === 'three' ? 'three' : LIST_LINES_DEFAULT;
  } catch {
    return LIST_LINES_DEFAULT;
  }
}

const subs = new Set<() => void>();
function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function setListLines(v: ListLines): void {
  try {
    localStorage.setItem(LINES_KEY, v);
  } catch {
    /* хранилище недоступно — остаётся вид по умолчанию */
  }
  for (const f of subs) f();
}

/** Вид строк списка; меняется сразу при переключении в настройках. */
export function useListLines(): ListLines {
  return useSyncExternalStore(subscribe, getListLines, () => LIST_LINES_DEFAULT);
}
