/**
 * Общая арифметика всплывающих слоёв: контекстных меню, поповеров, подсказок.
 *
 * ## Две системы координат
 *
 * Настройка масштаба интерфейса (#8, `uiPrefs.ts`) вешает CSS `zoom` на `<html>`. Из-за этого в
 * приложении одновременно живут ДВЕ шкалы, и перепутать их очень легко:
 *
 * | Что                                   | В чём меряет         |
 * |---------------------------------------|----------------------|
 * | `getBoundingClientRect()`, `clientX`  | **экранные** (× zoom)|
 * | `documentElement.clientWidth`, `100vw`| **экранные**         |
 * | CSS `left/top/width`, `offsetWidth`   | **вёрсточные**       |
 *
 * Вёрсточное значение при отрисовке умножается на zoom. Поэтому `left = anchor.left`, где anchor
 * пришёл из `getBoundingClientRect()`, ставит элемент в `anchor.left × zoom` — при масштабе
 * «Крупный» (1.15) поповер уезжал вправо на 15% ширины экрана. Ровно так пикер эмодзи вылезал
 * за кромку, хотя кламп был на месте и на 100% работал безупречно.
 *
 * **Правило: всё считаем в ВЁРСТОЧНЫХ единицах.** Любой прямоугольник и любую координату мыши,
 * пришедшую из DOM-события, сначала прогнать через `toLayout*`; размер слоя брать из `offsetWidth`
 * (он уже вёрсточный), а НЕ из констант, скопированных в JS из CSS.
 *
 * Та же ловушка уже описана в `SidebarResizer.tsx` (делит `clientX` на zoom) и в `styles.css`
 * (`100vw/100vh` не совпадают с экраном при zoom ≠ 1) — это третье место, где она аукнулась.
 */

/** Масштаб интерфейса, применённый к корню. 1, если настройка не трогалась. */
export function rootZoom(): number {
  return parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
}

/**
 * Видимая область В ВЁРСТОЧНЫХ единицах — то есть уже поделённая на zoom, чтобы её можно было
 * сравнивать с `offsetWidth` и подставлять в CSS `left/top`.
 *
 * `clientWidth`, а не `innerWidth`: второй считает ширину скроллбара — ровно тот зазор, что
 * выталкивает прижатый вправо слой за кромку. `visualViewport` — то, что реально видно: на мобиле
 * layout-вьюпорт остаётся полной высоты, пока клавиатура закрывает низ, и «низ экрана» оказывается
 * под клавиатурой. Берём меньшее из двух, никогда не большее.
 */
/**
 * Видимая область в вёрсточных единицах.
 *
 * Вынесена отдельным типом, потому что `placeByAnchor`/`placeByPoint` принимают её НЕОБЯЗАТЕЛЬНЫМ
 * параметром: сами они чистые, а вот `viewport()` читает `document`, и без этого параметра весь
 * выбор стороны был непроверяемым вне браузера. В приложении параметр не передают — берётся
 * настоящий вьюпорт; передают только тесты.
 */
export type Viewport = { vw: number; vh: number };

export function viewport(): Viewport {
  const z = rootZoom();
  const vv = window.visualViewport;
  return {
    vw: Math.min(document.documentElement.clientWidth, vv?.width ?? Infinity) / z,
    vh: Math.min(document.documentElement.clientHeight, vv?.height ?? Infinity) / z,
  };
}

/** Экранный прямоугольник (из `getBoundingClientRect`) → вёрсточный. */
export function toLayoutRect(r: DOMRect): DOMRect {
  const z = rootZoom();
  if (z === 1) return r;
  return new DOMRect(r.x / z, r.y / z, r.width / z, r.height / z);
}

/** Экранная точка (из `clientX/clientY` события) → вёрсточная. */
export function toLayoutPoint(x: number, y: number): { x: number; y: number } {
  const z = rootZoom();
  return z === 1 ? { x, y } : { x: x / z, y: y / z };
}

/**
 * Загнать отрезок [start, start+size] внутрь [0, extent] с отступом pad — всё в вёрсточных единицах.
 * Если слой шире экрана — прижимаем к началу: пусть лучше торчит предсказуемо вправо/вниз,
 * чем уезжает влево за кромку, где до него не добраться вообще.
 *
 * Это СТРАХОВКА, а не способ размещения: сползание вдоль кромки может накрыть саму кнопку.
 * Штатно сторону выбирают `placeByAnchor` / `placeByPoint` ниже.
 */
export function clampAxis(start: number, size: number, extent: number, pad = 8): number {
  return Math.max(pad, Math.min(start, extent - size - pad));
}

export type Placed = { left: number; top: number };

/** Влезает ли отрезок целиком. */
function fits(start: number, size: number, extent: number, pad: number): boolean {
  return start >= pad && start + size <= extent - pad;
}

/**
 * Выбрать сторону из списка вариантов: первый, что влезает целиком; если ни один не влез —
 * тот, у которого видно больше всего, и уже его прижать клампом.
 *
 * Перебор, а не арифметика «если не лезет — отзеркалить»: вариантов всего четыре, зато порядок
 * списка = приоритет, и его видно глазами в месте вызова.
 */
function pick(
  cands: Placed[],
  w: number,
  h: number,
  vw: number,
  vh: number,
  pad: number,
): Placed {
  for (const c of cands) {
    if (fits(c.left, w, vw, pad) && fits(c.top, h, vh, pad)) return c;
  }
  const visible = (c: Placed) =>
    Math.max(0, Math.min(c.left + w, vw - pad) - Math.max(c.left, pad)) *
    Math.max(0, Math.min(c.top + h, vh - pad) - Math.max(c.top, pad));
  const best = cands.reduce((a, b) => (visible(b) > visible(a) ? b : a));
  return { left: clampAxis(best.left, w, vw, pad), top: clampAxis(best.top, h, vh, pad) };
}

/**
 * Поповер, привязанный к элементу (кнопка реакций, «?»): раскрывается ОТ кнопки в ту сторону,
 * где есть место. По вертикали приоритет у «над кнопкой» — типовой триггер стоит у нижней кромки
 * (композер, панель действий сообщения), и снизу места обычно нет.
 *
 * `anchor` ОБЯЗАН быть уже вёрсточным (`toLayoutRect`), иначе при масштабе ≠ 100% всё уедет.
 */
export function placeByAnchor(anchor: DOMRect, w: number, h: number, pad = 8, vp?: Viewport): Placed {
  const { vw, vh } = vp ?? viewport();
  const tops = [anchor.top - h - pad, anchor.bottom + pad]; // выше кнопки, ниже кнопки
  const lefts = [anchor.right - w, anchor.left]; // правым краем по кнопке, левым краем по кнопке
  const cands: Placed[] = [];
  for (const top of tops) for (const left of lefts) cands.push({ left, top });
  return pick(cands, w, h, vw, vh, pad);
}

/**
 * Меню в точке курсора: раскрывается ИЗ точки в свободный квадрант — вниз-вправо, вниз-влево,
 * вверх-вправо, вверх-влево. Именно так ведут себя контекстные меню везде, и именно поэтому
 * меню у нижней кромки не должно ползти вверх вдоль неё, накрывая курсор.
 *
 * Точка ОБЯЗАНА быть уже вёрсточной (`toLayoutPoint`).
 */
export function placeByPoint(x: number, y: number, w: number, h: number, pad = 8, vp?: Viewport): Placed {
  const { vw, vh } = vp ?? viewport();
  const cands: Placed[] = [
    { left: x, top: y }, // вниз-вправо
    { left: x - w, top: y }, // вниз-влево
    { left: x, top: y - h }, // вверх-вправо
    { left: x - w, top: y - h }, // вверх-влево
  ];
  return pick(cands, w, h, vw, vh, pad);
}

/**
 * Публикует вьюпорт в вёрсточных единицах как `--vw-px` / `--vh-px`, чтобы CSS мог ограничивать
 * размеры слоёв, не завися от zoom.
 *
 * `100vw`/`100dvh` для этого не годятся: при zoom ≠ 1 они дают ЭКРАННЫЙ размер, который потом
 * ещё раз умножается на zoom при отрисовке. `max-height: calc(100dvh - 16px)` при масштабе
 * «Крупный» разрешал меню быть в 1.15 раза выше экрана — то есть ограничение не работало.
 *
 * Идемпотентно; вызывается на старте и после смены масштаба.
 */
let varsInstalled = false;
export function refreshViewportVars(): void {
  const { vw, vh } = viewport();
  const s = document.documentElement.style;
  s.setProperty('--vw-px', `${vw}px`);
  s.setProperty('--vh-px', `${vh}px`);
}
export function installViewportVars(): void {
  refreshViewportVars();
  if (varsInstalled) return;
  varsInstalled = true;
  window.addEventListener('resize', refreshViewportVars);
  // Клавиатура на мобиле шлёт только это событие, window.resize при ней не приходит.
  window.visualViewport?.addEventListener('resize', refreshViewportVars);
}
