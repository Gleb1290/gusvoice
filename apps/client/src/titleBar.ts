/**
 * Своя полоса окна десктопа (#219): у главного окна Tauri `decorations: false`, полосу рисует клиент
 * (`components/WindowTitleBar.tsx`). Только Tauri-десктоп (`isDesktop()`); веб и Android её не видят.
 *
 * Здесь — связь с окном: свернуть / развернуть / закрыть (закрыть идёт тем же путём, что системный
 * крестик: `CloseRequested` → `gv-close-requested` → в трей или выйти, `desktopWindow.ts`), перетаскивание
 * и место кнопки «Развернуть» для нативной стороны (`titlebar.rs`): над ней лежит прозрачное окно,
 * которое отвечает Windows `HTMAXBUTTON` — без него Windows 11 не показывает меню раскладок.
 */
import { isDesktop } from './hotkeys';

/** Высота полосы в CSS-пикселях: системная полоса Windows 11 — 32 (кнопки 46 × 32). */
export const TITLEBAR_H = 32;
/** Ширина кнопки свернуть / развернуть / закрыть — системная Windows 11. */
export const TITLEBAR_BTN_W = 46;

/** Событие клиент → `titlebar.rs`: где кнопка «Развернуть». */
export const EVENT_MAX_RECT = 'gv-titlebar-max-rect';
/** Событие `titlebar.rs` → клиент: наведение и нажатие над кнопкой «Развернуть». */
export const EVENT_MAX_STATE = 'gv-titlebar-max-state';

export type MaxSpot = { right: number; top: number; width: number; height: number };
export type MaxHover = 'enter' | 'leave' | 'down' | 'up';

/**
 * Место кнопки для нативного окна: отступ от ПРАВОГО края окна, верх, ширина, высота — в физических
 * пикселях (CSS × `devicePixelRatio`: так учтены масштаб интерфейса и DPI монитора). От правого края —
 * чтобы при растягивании окна нативная сторона двигала его сама, без нового замера. Кнопки нет или она
 * нулевая — `null` (нативное окно прячется).
 */
export function maxButtonSpot(
  rect: { left: number; top: number; width: number; height: number } | null,
  viewportWidth: number,
  dpr: number,
): MaxSpot | null {
  if (!rect || rect.width <= 0 || rect.height <= 0 || !(dpr > 0)) return null;
  const right = viewportWidth - (rect.left + rect.width);
  if (right < 0 || rect.top < 0) return null;
  const px = (v: number) => Math.round(v * dpr);
  return { right: px(right), top: px(rect.top), width: px(rect.width), height: px(rect.height) };
}

/** Понятное состояние кнопки по событию нативного окна: подсвечена ли и нажата ли. */
export function nextMaxHover(prev: { hover: boolean; pressed: boolean }, ev: MaxHover): { hover: boolean; pressed: boolean } {
  switch (ev) {
    case 'enter':
      return { hover: true, pressed: false };
    case 'leave':
      return { hover: false, pressed: false };
    case 'down':
      return { hover: true, pressed: true };
    case 'up':
      return { hover: prev.hover, pressed: false };
    default:
      return prev;
  }
}

type TauriWindow = {
  minimize?: () => Promise<void>;
  toggleMaximize?: () => Promise<void>;
  close?: () => Promise<void>;
  startDragging?: () => Promise<void>;
  isMaximized?: () => Promise<boolean>;
  onResized?: (cb: () => void) => Promise<() => void>;
  onFocusChanged?: (cb: (e: { payload: boolean }) => void) => Promise<() => void>;
};
type TauriGlobal = {
  window?: { getCurrentWindow?: () => TauriWindow };
  event?: {
    emit?: (event: string, payload?: unknown) => Promise<void>;
    listen?: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
  };
};
function tauri(): TauriGlobal | null {
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}
function win(): TauriWindow | null {
  return tauri()?.window?.getCurrentWindow?.() ?? null;
}

/** Показывать ли свою полосу: только главное окно Tauri-десктопа. */
export function hasOwnTitleBar(): boolean {
  return isDesktop();
}

export function minimizeWindow(): void {
  void win()?.minimize?.()?.catch(() => {});
}
export function toggleMaximizeWindow(): void {
  void win()?.toggleMaximize?.()?.catch(() => {});
}
/** Как системный крестик: решение «в трей или выйти» принимает `CloseToTrayPrompt`. */
export function closeWindow(): void {
  void win()?.close?.()?.catch(() => {});
}
/**
 * Нажатие (`mousedown`: у него `detail` — номер щелчка подряд) на свободное место полосы: второй щелчок подряд — развернуть / восстановить (как у системной
 * полосы), иначе — нативное перетаскивание (`startDragging`, а не `data-tauri-drag-region`, см. `TipToast.tsx`).
 * Перетаскивание идёт системным путём: работают Aero Snap к краю и отрыв развёрнутого окна.
 */
export function titleBarPointerDown(e: { button: number; detail: number }): void {
  if (e.button !== 0) return;
  if (e.detail === 2) toggleMaximizeWindow();
  else void win()?.startDragging?.()?.catch(() => {});
}

/** Подписка на «развёрнуто ли окно» (иконка «Развернуть» ↔ «Восстановить») и «в фокусе ли» (приглушить полосу). */
export function watchWindowState(onMaximized: (m: boolean) => void, onFocused: (f: boolean) => void): () => void {
  const w = win();
  if (!w) return () => {};
  const offs: Array<() => void> = [];
  let dead = false;
  const keep = (p: Promise<() => void> | undefined) =>
    void p?.then((u) => (dead ? u() : offs.push(u))).catch(() => {});
  const sync = () =>
    void w
      .isMaximized?.()
      .then((m) => {
        if (!dead) onMaximized(m);
      })
      .catch(() => {});
  sync();
  keep(w.onResized?.(sync));
  keep(
    w.onFocusChanged?.((e) => {
      if (!dead) onFocused(e.payload);
    }),
  );
  return () => {
    dead = true;
    offs.forEach((u) => u());
  };
}

/** Сообщить нативной стороне место кнопки «Развернуть» (или `null` — спрятать её окно). */
export function reportMaxSpot(spot: MaxSpot | null): void {
  void tauri()?.event?.emit?.(EVENT_MAX_RECT, spot)?.catch(() => {});
}

/** Слушать наведение/нажатие над кнопкой «Развернуть» от нативного окна. */
export function onMaxHover(handler: (ev: MaxHover) => void): () => void {
  const listen = tauri()?.event?.listen;
  if (!listen) return () => {};
  let un: (() => void) | null = null;
  let dead = false;
  void listen(EVENT_MAX_STATE, (e) => {
    const p = e.payload;
    if (p === 'enter' || p === 'leave' || p === 'down' || p === 'up') handler(p);
  })
    .then((u) => (dead ? u() : (un = u)))
    .catch(() => {});
  return () => {
    dead = true;
    un?.();
  };
}
