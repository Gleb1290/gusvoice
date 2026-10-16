/**
 * Свои всплывающие уведомления на ПК (G38, ND-07) — чистые правила стопки. Повторяют «свои» уведомления Telegram Desktop
 * (`window/notifications_manager_default.cpp`, размеры — `window/window.style`, настройки — `core/core_settings.h`,
 * `settings/sections/settings_notifications.cpp`). Окно и показ — `NotifyPopups.tsx` (окно `?window=notify`), доставка из
 * главного окна — `notifyPopupHost.ts`, нативная часть — `apps/desktop/src-tauri/src/notify_popup.rs`.
 */

/** Угол экрана (Telegram: `ScreenCorner`, умолчание `BottomRight`). */
export type PopupCorner = 'tl' | 'tr' | 'bl' | 'br';
export const POPUP_CORNERS: readonly PopupCorner[] = ['tl', 'tr', 'bl', 'br'];
export const POPUP_CORNER_DEFAULT: PopupCorner = 'br';

/** Сколько карточек на экране сразу: 1…5, по умолчанию 3 (Telegram: `kMaxNotificationsCount = 5`, `_notificationsCount = 3`). */
export const POPUP_COUNT_MAX = 5;
export const POPUP_COUNT_DEFAULT = 3;

/** Карточка: ширина и наименьшая высота (`notifyWidth: 320px`, `notifyMinHeight: 80px`), аватар 62 px (`notifyPhotoSize`). */
export const POPUP_WIDTH = 320;
export const POPUP_MIN_HEIGHT = 80;
export const POPUP_PHOTO = 62;
/** Плашка «Скрыть все» под стопкой (`notifyHideAllHeight: 36px`). */
export const POPUP_HIDE_ALL_HEIGHT = 36;

/**
 * Время жизни. Telegram ждёт ввода человека после показа (`checkLastInput`: на Windows — пока не «занят»), потом 3 с
 * (`notifyWaitLongHide: 3000`) и гасит за 4 с (`notifySlowHide: 4000`); наведение возвращает непрозрачность всем
 * (`stopAllHiding`), уход мыши — сразу медленное угасание (`leaveEventHook` → `startAllHiding`). Появление — 150 мс
 * (`notifyFastAnim`). Опрос ввода — раз в 300 мс (`_inputCheckTimer.callOnce(300)`).
 */
export const POPUP_HIDE_AFTER_MS = 3000;
export const POPUP_FADE_MS = 4000;
export const POPUP_FAST_MS = 150;
export const POPUP_INPUT_POLL_MS = 300;

/** Одна карточка. `tag` — метка обработчика клика в главном окне (`notifications.ts`), `conv` — беседа (есть — есть ответ). */
export interface PopupNotice {
  id: string;
  tag: string;
  /** Заголовок карточки: имя собеседника или название группы/канала (Telegram: имя чата). */
  title: string;
  /** Автор в группе — строкой перед текстом («Автор: текст», как у Telegram). */
  author?: string;
  body: string;
  /**
   * Вид вложения перед текстом — «Фото», «Голосовое сообщение», «📊 вопрос» (`notifications.popupPreview`; Telegram
   * `WithCaptionNotificationText`: вид выделен, подпись — через запятую). Нет — в строке только `body`.
   */
  kind?: string;
  avatar?: string | null;
  conv?: string;
  /** Группа уведомлений (беседа или канал): её прочли — карточки уходят (`popupDropGroup`). */
  group?: string;
}

/** Показанные (по порядку прихода) и ждущие места (`_queuedNotifications`). */
export interface PopupStack {
  shown: PopupNotice[];
  queue: PopupNotice[];
}

export const EMPTY_STACK: PopupStack = { shown: [], queue: [] };

export function popupCorner(v: unknown): PopupCorner {
  return POPUP_CORNERS.includes(v as PopupCorner) ? (v as PopupCorner) : POPUP_CORNER_DEFAULT;
}

export function popupCount(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return POPUP_COUNT_DEFAULT;
  return Math.min(POPUP_COUNT_MAX, Math.max(1, Math.round(n)));
}

/** Пришла карточка: есть место — на экран, нет — в очередь (Telegram `showNextFromQueue`). */
export function popupPush(st: PopupStack, n: PopupNotice, max: number): PopupStack {
  if (st.shown.length < popupCount(max)) return { shown: [...st.shown, n], queue: st.queue };
  return { shown: st.shown, queue: [...st.queue, n] };
}

/** Освободилось место (закрыли, ушла по таймеру, уменьшили число) — добрать из очереди по порядку. */
export function popupFill(st: PopupStack, max: number): PopupStack {
  const lim = popupCount(max);
  if (st.shown.length > lim) return { shown: st.shown.slice(-lim), queue: [...st.shown.slice(0, -lim), ...st.queue] };
  const take = Math.max(0, lim - st.shown.length);
  if (!take || !st.queue.length) return st;
  return { shown: [...st.shown, ...st.queue.slice(0, take)], queue: st.queue.slice(take) };
}

/** Убрать карточку (крестик, правый клик, клик, угасла). */
export function popupRemove(st: PopupStack, id: string, max: number): PopupStack {
  return popupFill({ shown: st.shown.filter((x) => x.id !== id), queue: st.queue.filter((x) => x.id !== id) }, max);
}

/** Беседу (канал) прочитали в главном окне — её карточки уходят, как `unlinkHistory` у Telegram. */
export function popupDropGroup(st: PopupStack, group: string, max: number): PopupStack {
  return popupFill({ shown: st.shown.filter((x) => x.group !== group), queue: st.queue.filter((x) => x.group !== group) }, max);
}

/** «Скрыть все» видна, когда карточек больше одной или есть очередь (Telegram `moveWidgets`). */
export function popupShowsHideAll(st: PopupStack): boolean {
  return st.shown.length > 1 || st.queue.length > 0;
}

/**
 * Порядок отрисовки сверху вниз. Новая карточка — ближе всех к углу, старые отходят от него (Telegram `moveWidgets` идёт с
 * последней и копит сдвиг от угла): у нижних углов новая внизу, у верхних — вверху.
 */
export function popupOrder(shown: readonly PopupNotice[], corner: PopupCorner): PopupNotice[] {
  return corner.startsWith('t') ? [...shown].reverse() : [...shown];
}

/** Вторая строка карточки: в группе — «Автор: текст» (Telegram: `textCachedFor` с отправителем), в личной — текст. */
export function popupLine(n: Pick<PopupNotice, 'author' | 'body' | 'kind'>): string {
  const p = popupLineParts(n);
  return `${p.from}${p.kind}${p.text}`;
}

/**
 * Та же строка по частям — для вёрстки: `from` («Автор: ») и `kind` («Фото, » / «Фото») выделяются, как у Telegram
 * (`Ui::Text::Colorized` в `updateNotifyDisplay` и `WithCaptionNotificationText`); склеенные — ровно `popupLine`.
 */
export function popupLineParts(n: Pick<PopupNotice, 'author' | 'body' | 'kind'>): { from: string; kind: string; text: string } {
  const from = n.author ? `${n.author}: ` : '';
  const kind = n.kind ? (n.body ? `${n.kind}, ` : n.kind) : '';
  return { from, kind, text: n.body };
}

/**
 * Пора ли запускать таймер угасания. Telegram на Windows ждёт ввода человека ПОСЛЕ показа (`checkLastInput`): ушёл от
 * компьютера — карточка дождётся. `idleMs` — простой ввода по системе (`gv_os_idle_ms`), `null` — неизвестно (не ждём).
 */
export function popupInputSeen(shownAt: number, now: number, idleMs: number | null): boolean {
  if (idleMs === null) return true;
  return now - idleMs > shownAt;
}
