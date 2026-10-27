/**
 * Правила окна выбора источника показа (`components/ScreenShareDialog.tsx`) — чистое, без React и Tauri,
 * чтобы проверить из Node (#237, «Сменить окно или экран»).
 *
 * Два режима одного окна: `start` — «Начать трансляцию» (как было), `switch` — смена источника идущего
 * показа. В режиме смены: блок качества скрыт (качество меняется только новым показом — решение
 * владельца 27.10), текущий источник выделен и помечен, кнопка «Показывать это» / «Уже показывается»,
 * вкладка другого вида скрыта (камера↔экран бесшовно не меняется — это разные участники).
 * Образец — Telegram Desktop: тот же пикер, текущий источник выделен (`ui/desktop_capture_choose_source.cpp`,
 * `updateButtonsVisibility`), кнопка зависит от выбора.
 */

export type ShareDialogMode = 'start' | 'switch';
export type ShareDialogTab = 'window' | 'screen' | 'camera';

/** Что показывается сейчас: окно/экран нативного показа или камера (вкладка «Камеры»). */
export type CurrentShare = { sourceId: string; isWindow: boolean } | { deviceId: string };

const isNativeCurrent = (c: CurrentShare | null | undefined): c is { sourceId: string; isWindow: boolean } =>
  !!c && 'sourceId' in c;
const isCameraCurrent = (c: CurrentShare | null | undefined): c is { deviceId: string } => !!c && 'deviceId' in c;

/** Вкладки окна. В режиме смены остаётся только тот вид, что идёт сейчас. */
export function shareDialogTabs(mode: ShareDialogMode, current?: CurrentShare | null): ShareDialogTab[] {
  if (mode === 'start') return ['window', 'screen', 'camera'];
  if (isCameraCurrent(current)) return ['camera'];
  return ['window', 'screen'];
}

/** С какой вкладки открыться: в режиме смены — с вида текущего источника. */
export function shareDialogInitialTab(mode: ShareDialogMode, current?: CurrentShare | null): ShareDialogTab {
  if (mode === 'start') return 'window';
  if (isCameraCurrent(current)) return 'camera';
  return isNativeCurrent(current) && !current.isWindow ? 'screen' : 'window';
}

/** Какая карточка выбрана при открытии: в режиме смены — текущая (кнопка тогда «Уже показывается»). */
export function shareDialogInitialSelection(mode: ShareDialogMode, current?: CurrentShare | null): string | null {
  if (mode === 'start' || !current) return null;
  return isCameraCurrent(current) ? current.deviceId : current.sourceId;
}

/**
 * Карточка `id` на вкладке `tab` — текущий источник? Сравнение по ПАРЕ (id + вид): id окна и id экрана
 * из разных пространств и могут совпасть, и «Экран 1» не должен помечаться текущим из-за окна с тем же id.
 */
export function isCurrentCard(
  mode: ShareDialogMode,
  tab: ShareDialogTab,
  id: string | null,
  current?: CurrentShare | null,
): boolean {
  if (mode !== 'switch' || !current || !id) return false;
  if (tab === 'camera') return isCameraCurrent(current) && current.deviceId === id;
  return isNativeCurrent(current) && current.sourceId === id && current.isWindow === (tab === 'window');
}

export function shareDialogTitle(mode: ShareDialogMode): string {
  return mode === 'switch' ? 'Сменить источник показа' : 'Демонстрация экрана';
}

/** Подпись главной кнопки. `isCurrent` — выбран тот источник, что и так идёт. */
export function shareDialogConfirmLabel(mode: ShareDialogMode, busy: boolean, isCurrent: boolean): string {
  if (mode === 'start') return busy ? 'Запуск…' : 'Начать трансляцию';
  if (busy) return 'Переключение…';
  return isCurrent ? 'Уже показывается' : 'Показывать это';
}

/** Главная кнопка недоступна: ничего не выбрано, идёт запрос, а в режиме смены — выбран текущий источник. */
export function shareDialogConfirmDisabled(
  mode: ShareDialogMode,
  selectedId: string | null,
  busy: boolean,
  isCurrent: boolean,
): boolean {
  return !selectedId || busy || (mode === 'switch' && isCurrent);
}

/** Строка вместо блока качества в режиме смены. */
export const SHARE_SWITCH_QUALITY_NOTE = 'Качество меняется только новым показом';
