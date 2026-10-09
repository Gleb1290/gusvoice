import { useCallback, useLayoutEffect, useState } from 'react';

/**
 * Панель эмодзи / стикеров / GIF, закреплённая колонкой справа от ленты (G61; решение владельца 08.10, п.12: «Да, колонкой»).
 *
 * Сверка с Telegram Desktop (`ComposeControls::toggleTabbedSelectorMode`, `SessionController::canShowThirdSection`,
 * `window.style`): панель наведением — всплывающая `TabbedPanel`; щелчок по кнопке смайлика, если окно вмещает третью колонку
 * (`minimalThreeColumnWidth` = список бесед 260 + главная 380 + третья 292), закрепляет её в третьей колонке
 * (`setTabbedSelectorSectionEnabled(true)` — запоминается), иначе панель просто остаётся открытой; щелчок по кнопке при закреплённой
 * панели закрывает колонку (`closeThirdSection`). Колонка — `emojiPanWidth` 345 (в вилке третьей колонки 292…392); главная
 * часть не уже `columnMinimalWidthMain` 380. Окно стало тесным — колонка пропадает, настройка остаётся и вернётся в широком окне.
 *
 * Список бесед у нас — отдельная колонка вне ленты, поэтому порог считается по ширине самой беседы (`.chat`): 380 + 345.
 */
export const EXPR_DOCK_W = 345;
export const EXPR_DOCK_MIN_MAIN = 380;
export const EXPR_DOCK_MIN_CHAT = EXPR_DOCK_W + EXPR_DOCK_MIN_MAIN;

const KEY = 'gv_expr_dock';

/** Закреплена ли панель (настройка одного человека, хранится в браузере; по умолчанию — нет). */
export function getExprDock(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setExprDock(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* приватный режим — закрепление просто не запомнится */
  }
}

/** Помещается ли колонка рядом с лентой при такой ширине беседы (вместе с колонкой). */
export function exprDockFits(chatWidth: number): boolean {
  return chatWidth >= EXPR_DOCK_MIN_CHAT;
}

/**
 * `pinned` — настройка; `fits` — окно вмещает колонку; `docked` — колонка показана сейчас (`enabled`: ПК, поле ввода на месте).
 * `chat` — элемент беседы (колбэк-реф: появляется не с первого кадра). Ширина — `offsetWidth` беседы: отступ под колонку на неё не влияет, поэтому «поместится» не мигает от самого закрепления.
 */
export function useExprDock(chat: HTMLElement | null, enabled: boolean) {
  const [pinned, setPinnedState] = useState(getExprDock);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = chat;
    if (!el) return;
    setWidth(el.offsetWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [chat]);
  const setPinned = useCallback((on: boolean) => {
    setExprDock(on);
    setPinnedState(on);
  }, []);
  const fits = exprDockFits(width);
  return { pinned, fits, docked: enabled && pinned && fits, canPin: enabled && fits, setPinned };
}
