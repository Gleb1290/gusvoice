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
export type Viewport = {
  vw: number;
  vh: number;
  /**
   * Верхняя кромка доступной области (строка состояния, `--gv-sat`) — вёрсточная; нет — 0. По вертикали блоку
   * доступно `[top, vh]`: `vh` — нижняя кромка (у `viewportSafe()` уже без нижней вставки), а не высота.
   */
  top?: number;
  /**
   * Левая кромка доступной области (вырез камеры / панель навигации слева, `--gv-sal`, D23) — вёрсточная; нет — 0. Правая
   * вставка (`--gv-sar`) уже вычтена из `vw`: это правая кромка, как `vh` — нижняя.
   */
  left?: number;
};

/**
 * Вьюпорт без нижней системной вставки — для блоков у якоря на телефоне (приёмка S20+, 08.10: меню «Выключить на время…»
 * уходило на 12 px под панель навигации). Вставка — как в CSS, `max(env(safe-area-inset-bottom), var(--gv-sab, 0px))`
 * (`nativeSafeArea.ts`: WebView < ~M135 панель навигации в `env()` не отдаёт), замер — пробным элементом: `env()` из JS
 * иначе не прочитать. Значение вёрсточное, как и `viewport()`.
 */
export function viewportAboveSafeBottom(): Viewport {
  // С 09.10 — и под верхней вставкой: это `viewportSafe()` (`top` — только при ненулевой строке состояния).
  return viewportSafe();
}

export function viewport(): Viewport {
  const z = rootZoom();
  const vv = window.visualViewport;
  return {
    vw: Math.min(document.documentElement.clientWidth, vv?.width ?? Infinity) / z,
    vh: Math.min(document.documentElement.clientHeight, vv?.height ?? Infinity) / z,
  };
}

/**
 * Доступная область для меню, листов и всплывашек у якоря или точки = окно − верхняя − нижняя системная вставка
 * (разведка наплывов 09.10: при `--gv-sat` 32 / `--gv-sab` 48 полоса реакций вставала на y = 11 под строку состояния,
 * «Удалить» — на 35 px под панель навигации). Вставки — как в CSS, `max(env(safe-area-inset-*), var(--gv-sa*, 0px))`,
 * замер пробным элементом (как у `viewportAboveSafeBottom`). Возвращает `{ vw: правая кромка, vh: нижняя, top: верхняя, left: левая }` (боковые — D23, ландшафт: панель навигации сбоку).
 */
export function viewportSafe(): Viewport {
  const vp = viewport();
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;' +
    'padding-top:max(env(safe-area-inset-top), var(--gv-sat, 0px));' +
    'padding-bottom:max(env(safe-area-inset-bottom), var(--gv-sab, 0px));' +
    'padding-left:max(env(safe-area-inset-left), var(--gv-sal, 0px));' +
    'padding-right:max(env(safe-area-inset-right), var(--gv-sar, 0px))';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const sat = parseFloat(cs.paddingTop) || 0;
  const sab = parseFloat(cs.paddingBottom) || 0;
  const sal = parseFloat(cs.paddingLeft) || 0;
  const sar = parseFloat(cs.paddingRight) || 0;
  probe.remove();
  return safeArea(vp, sat, sab, sal, sar);
}

/**
 * Чистая часть `viewportSafe`: окно и вставки → доступная область (вставки больше окна — область пустая, не отрицательная).
 * `top` — только при ненулевой верхней вставке: без неё ответ тот же, что у прежнего `viewportAboveSafeBottom`.
 */
export function safeArea(vp: Viewport, sat: number, sab: number, sal = 0, sar = 0): Viewport {
  const top = Math.max(0, sat);
  const left = Math.max(0, sal);
  const vh = Math.max(top, vp.vh - Math.max(0, sab));
  const vw = Math.max(left, vp.vw - Math.max(0, sar));
  const out: Viewport = { vw, vh };
  if (top > 0) out.top = top;
  if (left > 0) out.left = left;
  return out;
}

/**
 * Сколько места по высоте у блока, чей верх стоит на `top` (список закреплённых под полосой закрепа): до нижней кромки
 * доступной области с отступом `pad`. Не меньше 0.
 */
export function roomBelow(top: number, vp: Viewport, pad = 8): number {
  return Math.max(0, vp.vh - pad - top);
}

/**
 * Потолок карточки меню в блоке «полоса реакций + карточка» (`.ctx-stack`; разведка наплывов 09.10, ландшафт 740×360:
 * «Изменить»/«Удалить» уходили за низ): доступная высота минус отступы `pad` сверху и снизу и всё, что в блоке над
 * карточкой (`cardTop` — полоса реакций и зазор, из разметки). Дальше карточка прокручивается внутри; полоса реакций
 * остаётся над ней целиком, как у Telegram (tweb `components/chat/contextMenu.ts`: полоса реакций над меню сообщения).
 */
export function stackCardMaxHeight(vp: Viewport, cardTop: number, pad = 8): number {
  return Math.max(0, vp.vh - (vp.top ?? 0) - 2 * pad - cardTop);
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
export function clampAxis(start: number, size: number, extent: number, pad = 8, min = 0): number {
  return Math.max(min + pad, Math.min(start, extent - size - pad));
}

export type Placed = { left: number; top: number };

/** Влезает ли отрезок целиком. */
function fits(start: number, size: number, extent: number, pad: number, min = 0): boolean {
  return start >= min + pad && start + size <= extent - pad;
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
  top0 = 0,
  left0 = 0,
): Placed {
  for (const c of cands) {
    if (fits(c.left, w, vw, pad, left0) && fits(c.top, h, vh, pad, top0)) return c;
  }
  const visible = (c: Placed) =>
    Math.max(0, Math.min(c.left + w, vw - pad) - Math.max(c.left, left0 + pad)) *
    Math.max(0, Math.min(c.top + h, vh - pad) - Math.max(c.top, top0 + pad));
  const best = cands.reduce((a, b) => (visible(b) > visible(a) ? b : a));
  return { left: clampAxis(best.left, w, vw, pad, left0), top: clampAxis(best.top, h, vh, pad, top0) };
}

/**
 * Поповер, привязанный к элементу (кнопка реакций, «?»): раскрывается ОТ кнопки в ту сторону,
 * где есть место. По вертикали приоритет у «над кнопкой» — типовой триггер стоит у нижней кромки
 * (композер, панель действий сообщения), и снизу места обычно нет.
 *
 * `anchor` ОБЯЗАН быть уже вёрсточным (`toLayoutRect`), иначе при масштабе ≠ 100% всё уедет.
 */
export function placeByAnchor(anchor: DOMRect, w: number, h: number, pad = 8, vp?: Viewport): Placed {
  const { vw, vh, top: top0 = 0, left: left0 = 0 } = vp ?? viewport();
  const tops = [anchor.top - h - pad, anchor.bottom + pad]; // выше кнопки, ниже кнопки
  const lefts = [anchor.right - w, anchor.left]; // правым краем по кнопке, левым краем по кнопке
  const cands: Placed[] = [];
  for (const top of tops) for (const left of lefts) cands.push({ left, top });
  return pick(cands, w, h, vw, vh, pad, top0, left0);
}

/**
 * Список выбора, прилипший к своему триггеру (#153): раскрывается вниз, а при нехватке места —
 * вверх, и в обе стороны имеет право ужаться.
 *
 * Отличие от `placeByAnchor` — в двух вещах, и обе из макета round 9. Во-первых, зазора нет: попап
 * продолжает триггер, у них общая кромка (у раскрытого триггера срезан нижний радиус), поэтому
 * `pad` здесь только про край экрана. Во-вторых, вместо «не влезло — поедем вдоль кромки» список
 * возвращает `maxHeight`: длинный перечень устройств не влезает В ПРИНЦИПЕ ни сверху, ни снизу, и
 * честный ответ для него — «вот столько места, дальше колесом», а не попытка накрыть собой поле,
 * из которого его открыли.
 *
 * `anchor` ОБЯЗАН быть вёрсточным (`toLayoutRect`).
 */
export function placeDropdown(
  anchor: DOMRect,
  w: number,
  h: number,
  pad = 8,
  vp?: Viewport,
): Placed & { maxHeight: number; up: boolean } {
  const { vw, vh, top: top0 = 0, left: left0 = 0 } = vp ?? viewport();
  const below = vh - pad - anchor.bottom;
  const above = anchor.top - pad - top0;
  // Вниз — по умолчанию; вверх уходим, только если снизу не влезло, а сверху влезает или просто
  // просторнее. Прыгать вверх «потому что там на пиксель больше» не надо: привычнее вниз.
  const up = h > below && (h <= above || above > below);
  const maxHeight = Math.max(0, Math.min(h, up ? above : below));
  const top = up ? anchor.top - maxHeight : anchor.bottom;
  const left = clampAxis(anchor.left, w, vw, pad, left0);
  return { left, top, maxHeight, up };
}

/**
 * Меню в точке курсора: раскрывается ИЗ точки в свободный квадрант — вниз-вправо, вниз-влево,
 * вверх-вправо, вверх-влево. Именно так ведут себя контекстные меню везде, и именно поэтому
 * меню у нижней кромки не должно ползти вверх вдоль неё, накрывая курсор.
 *
 * Точка ОБЯЗАНА быть уже вёрсточной (`toLayoutPoint`).
 */
export function placeByPoint(x: number, y: number, w: number, h: number, pad = 8, vp?: Viewport): Placed {
  const { vw, vh, top: top0 = 0, left: left0 = 0 } = vp ?? viewport();
  const cands: Placed[] = [
    { left: x, top: y }, // вниз-вправо
    { left: x - w, top: y }, // вниз-влево
    { left: x, top: y - h }, // вверх-вправо
    { left: x - w, top: y - h }, // вверх-влево
  ];
  return pick(cands, w, h, vw, vh, pad, top0, left0);
}

/**
 * Где карточка меню стоит внутри блока «полоса реакций + карточка» (`.ctx-stack`, раунд 12) и какого она размера —
 * в вёрсточных единицах, из РАЗМЕТКИ: `offsetLeft` / `offsetTop` / `offsetWidth` / `offsetHeight` карточки.
 */
export type CardBox = { left: number; top: number; w: number; h: number };

/**
 * Блок «полоса реакций + карточка» по точке клика (раунд 12, ПК): карточка встаёт от точки ровно как меню без полосы
 * (`placeByPoint`, свободный квадрант), полоса — над карточкой. Не влезла полоса сверху — блок целиком съезжает вниз
 * (кламп `top ≥ pad`), не влез справа — влево. Возвращает левый верхний угол БЛОКА; `w`, `h` — размер блока.
 *
 * Высота полосы и зазор под ней — из разметки (`card.top`), а не константой: зазор задаёт CSS (`gap: var(--sp-2)` у
 * `.ctx-stack`), и число в JS с ним разошлось бы молча — в макете расстановка считала 8, а стиль давал 4.
 *
 * Точка ОБЯЗАНА быть уже вёрсточной (`toLayoutPoint`).
 */
export function placeStackByPoint(
  x: number,
  y: number,
  w: number,
  h: number,
  card: CardBox,
  pad = 8,
  vp?: Viewport,
): Placed {
  const { vw, vh, top: top0 = 0, left: left0 = 0 } = vp ?? viewport();
  const c = placeByPoint(x, y, card.w, card.h, pad, { vw, vh, top: top0, left: left0 });
  return { left: clampAxis(c.left - card.left, w, vw, pad, left0), top: clampAxis(c.top - card.top, h, vh, pad, top0) };
}

/**
 * Блок у якоря «по половине экрана» (раунд 12, телефон): меню у пузыря, меню кнопки «Отправить». Якорь в нижней половине
 * окна — блок НАД ним, в верхней — ПОД ним, зазор `gap` (`--sp-3`). Не влез выбранной стороной — другой; не влез ни так,
 * ни так (сообщение выше экрана) — прижат к нижнему краю окна поверх якоря. По горизонтали — к краю якоря со стороны
 * автора: `'end'` — правый край блока по правому краю якоря (своё сообщение), `'start'` — левый по левому; дальше кламп
 * в окно `[pad, vw − w − pad]`.
 *
 * Отличие от `placeByAnchor`: там вертикаль — «сначала над кнопкой» (триггер обычно у нижней кромки), а якорь здесь —
 * строка ленты, она бывает где угодно, и сторону выбирает её место на экране: меню не закрывает соседние сообщения
 * с той стороны, где их больше.
 *
 * `anchor` ОБЯЗАН быть вёрсточным (`toLayoutRect`).
 */
export function placeByHalf(
  anchor: DOMRect,
  w: number,
  h: number,
  align: 'start' | 'end' = 'start',
  gap = 8,
  pad = 8,
  vp?: Viewport,
): Placed {
  const { vw, vh, top: top0 = 0, left: left0 = 0 } = vp ?? viewport();
  const above = anchor.top - gap - h;
  const below = anchor.bottom + gap;
  const fitsAt = (top: number) => fits(top, h, vh, pad, top0);
  // Середина — доступной области, а не окна: со вставками половины считаются от строки состояния до панели навигации.
  const [first, second] = (anchor.top + anchor.bottom) / 2 > (top0 + vh) / 2 ? [above, below] : [below, above];
  const top = fitsAt(first) ? first : fitsAt(second) ? second : vh - pad - h;
  const left = align === 'end' ? anchor.right - w : anchor.left;
  return { left: clampAxis(left, w, vw, pad, left0), top: clampAxis(top, h, vh, pad, top0) };
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
  refreshKeyboardFlag();
}

/** На сколько вьюпорт должен стать ниже «полного», чтобы счесть это экранной клавиатурой, а не строкой браузера (~56–110 px). */
export const KEYBOARD_MIN_SHRINK = 150;

/**
 * Открыта ли экранная клавиатура (чистая функция). Нужны оба признака: вьюпорт просел относительно самого высокого,
 * что видели при этой ширине, И фокус в поле ввода (иначе сворачивание адресной строки или масштаб щипком = «клавиатура»).
 * Telegram Android растит играющий кружок только в портрете и при закрытой клавиатуре (`ChatMessageCell.java`:
 * `isPlayingRound = … && !keyboardIsOpened && !isLandscape`) — у нас признак клавиатуры отдаётся CSS атрибутом `data-kb`.
 */
export function isKeyboardOpen(fullHeight: number, height: number, editableFocused: boolean): boolean {
  return editableFocused && fullHeight - height >= KEYBOARD_MIN_SHRINK;
}

let kbFullHeight = 0;
let kbWidth = 0;
function editableFocused(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return false;
  return a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable;
}
/** Ставит/снимает `data-kb` на `<html>`: CSS не даёт играющему кружку расти, пока открыта клавиатура. */
export function refreshKeyboardFlag(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  // Другая ширина = поворот экрана или смена окна: «полную» высоту копим заново. Масштаб щипком — не клавиатура.
  if (Math.abs(vv.width - kbWidth) > 1) {
    kbWidth = vv.width;
    kbFullHeight = 0;
  }
  if (vv.scale <= 1) kbFullHeight = Math.max(kbFullHeight, vv.height, window.innerHeight);
  const open = vv.scale <= 1 && isKeyboardOpen(kbFullHeight, vv.height, editableFocused());
  const root = document.documentElement;
  if (open) root.setAttribute('data-kb', '');
  else root.removeAttribute('data-kb');
}
export function installViewportVars(): void {
  refreshViewportVars();
  if (varsInstalled) return;
  varsInstalled = true;
  window.addEventListener('resize', refreshViewportVars);
  // Клавиатура на мобиле шлёт только это событие, window.resize при ней не приходит.
  window.visualViewport?.addEventListener('resize', refreshViewportVars);
  // Фокус в поле меняет признак клавиатуры без resize (клавиатура могла подняться раньше фокуса).
  document.addEventListener('focusin', refreshKeyboardFlag);
  document.addEventListener('focusout', refreshKeyboardFlag);
}
