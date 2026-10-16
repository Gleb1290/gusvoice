/**
 * Раскрытие панели стикеров / GIF протяжкой вверх на телефоне (#218) — числа и решения Telegram Android
 * (`ChatActivityEnterView.java`, ветка 12.x). Чистые функции: разметка и касания — в `MessagePane` (`exprLift`).
 *
 * Как у Telegram: потянуть за верх панели (строку наборов, `EmojiView.DraggableScrollSlidingTabStrip`,
 * `EmojiView.java:1239-1310`) — панель вместе с полем ввода едет вверх до шапки беседы; отпустить — доезжает
 * до раскрытой или обратно по скорости и доле пути. Только вкладки «Стикеры» и «GIF» (`stickersTabOpen`,
 * `ChatActivityEnterView.java:812`); с набранным текстом свёрнутая не тянется (`allowDragging`, `:12574-12576`).
 */

/** Сдвиг пальца, после которого протяжка — наша, а не тап (`ViewConfiguration.getScaledTouchSlop()` = 8dp). */
export const EXPAND_SLOP = 8;
/** Бросок быстрее 200dp/с решает сам, без доли пути (`onDragEnd`, `ChatActivityEnterView.java:12542`). */
export const EXPAND_FLING = 200;
/** Доля пути: свёрнутую раскрывает от 0.4, раскрытую сворачивает до 0.6 (там же). */
export const EXPAND_OPEN_AT = 0.4;
export const EXPAND_CLOSE_AT = 0.6;
/** Доезд — 300 мс, `CubicBezierInterpolator.DEFAULT` (0.25, 0.1, 0.25, 1) = CSS `ease` (`setStickersExpanded`, `:13779-13780`, сворачивание — `:13837`). */
export const EXPAND_MS = 300;
/** Зазор между шапкой и полем ввода у раскрытой панели (`- dp(6)` в `stickersExpandedHeight`, `:12513-12518`). */
export const EXPAND_GAP = 6;

/**
 * Насколько панель выше своей обычной высоты, когда раскрыта: от низа шапки + 6 до низа беседы минус поле ввода
 * (`stickersExpandedHeight = height − statusBar − navBar − dp(6) − actionBar − getHeight()`), минус обычная высота.
 * Не меньше нуля: на низком окне раскрывать некуда.
 */
export function expandedExtra(p: { headerBottom: number; chatBottom: number; composerHeight: number; panelHeight: number }): number {
  const full = p.chatBottom - p.headerBottom - EXPAND_GAP - p.composerHeight;
  return Math.max(0, Math.round(full - p.panelHeight));
}

/** Надбавка во время протяжки: с чего начали плюс путь пальца вверх, в пределах [0, max] (`onDrag`, `:12559-12570`). */
export function dragExtra(startExtra: number, dy: number, max: number): number {
  return Math.max(0, Math.min(max, startExtra - dy));
}

/**
 * Отпустили — раскрыта ли панель (`onDragEnd`, `:12542`). `velocityY` — px/с, вниз положительная (как `getYVelocity`),
 * `progress` — доля пути 0…1 (0 — обычная высота, 1 — раскрыта).
 */
export function expandAfterDrag(wasExpanded: boolean, velocityY: number, progress: number): boolean {
  const flip =
    (wasExpanded && velocityY >= EXPAND_FLING) ||
    (!wasExpanded && velocityY <= -EXPAND_FLING) ||
    (wasExpanded && progress <= EXPAND_CLOSE_AT) ||
    (!wasExpanded && progress >= EXPAND_OPEN_AT);
  return flip ? !wasExpanded : wasExpanded;
}

/**
 * Можно ли тянуть (`allowDragging`, `:12574-12576`): вкладка стикеров или GIF; есть хоть один стикер — свои наборы, недавние
 * или избранные (`emojiView.areThereAnyStickers()` = в сетке стикеров есть строки, `EmojiView.java:6445-6447`; то же условие
 * и на вкладке GIF — отдельного у Telegram нет); свёрнутую с набранным текстом — нельзя.
 */
export function canDragExpand(tab: string, expanded: boolean, text: string, hasStickers: boolean): boolean {
  if (tab !== 'stickers' && tab !== 'gifs') return false;
  if (!hasStickers) return false;
  return expanded || text.length === 0;
}
