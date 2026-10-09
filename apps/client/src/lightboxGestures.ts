/**
 * Жесты просмотрщика фото и видео (G11, сверка с Telegram 07.10, ресерч `04-media-gestures.md`) — чистые правила без DOM:
 * числа порогов и решения «что делает этот жест». Ведёт их `components/Lightbox.tsx`.
 *
 * Пальцы (Telegram Android, VA-*):
 * - горизонтальный свайп при масштабе «по размеру» — соседний файл: сдвиг больше трети ширины или быстрый бросок (VA-16);
 *   соседа нет — резиновое сопротивление;
 * - смахивание вниз — закрыть: картинка идёт за пальцем, фон светлеет, отпустили дальше шестой части высоты — закрыто,
 *   иначе возврат (VA-17); вверх не закрывает;
 * - тап у края (полоса `min(135, ширина/8)`) — соседний файл сразу, без ожидания двойного (VA-11);
 * - тап по середине — спрятать или показать панель (VA-10); двойной тап — ×3 в точке касания и обратно (VA-12).
 * Мышь (Telegram Desktop, VD-*): колесо листает, Ctrl+колесо — масштаб по курсору, Ctrl+0 — сброс (VD-16, VD-17),
 * увеличенное фото тащится мышью (VD-19).
 */
import { pinchStep, type ZoomPoint } from './lightboxZoom';

/** Палец ушёл от касания на столько px — направление жеста решено (у свайп-ответа ленты — `SWIPE_LOCK_PX`). */
export const GESTURE_LOCK_PX = 10;
/** Бросок быстрее этого (px/с) листает и без трети ширины (Telegram: 650 dp/с). */
export const FLING_PX_S = 650;
/** Двойной тап: второй не позже этого после первого, мс. */
export const DOUBLE_TAP_MS = 260;
/** И не дальше этого от первого, px. */
export const DOUBLE_TAP_PX = 30;
/** Масштаб двойного тапа (Telegram: ×3). */
export const DOUBLE_TAP_ZOOM = 3;
/** Мышь сдвинулась дальше — это перетаскивание, а не щелчок (щелчок мимо фото закрыл бы просмотр). */
export const DRAG_CLICK_PX = 4;

export type GestureAxis = 'wait' | 'page' | 'dismiss' | 'none';

/**
 * Чей жест одного пальца при масштабе «по размеру», по смещению от касания: `wait` — палец ещё рядом; `page` — горизонталь
 * (листание); `dismiss` — вниз ИЛИ вверх и круче вдвое, чем вбок (Telegram: «вертикаль в 2 раза больше горизонтали»; вверх закрывает
 * тоже — Android `PhotoViewer`, решение владельца 08.10); `none` — прочее (наискось) — жест ничего не делает.
 */
export function gestureAxis(dx: number, dy: number, lock = GESTURE_LOCK_PX): GestureAxis {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < lock && ay < lock) return 'wait';
  if (ax >= ay) return 'page';
  return ay >= ax * 2 ? 'dismiss' : 'none';
}

/** Сдвиг картинки за пальцем при листании: соседа в эту сторону нет — резина (треть пути). */
export function pageDragOffset(dx: number, hasPrev: boolean, hasNext: boolean): number {
  const blocked = dx > 0 ? !hasPrev : dx < 0 ? !hasNext : false;
  return blocked ? dx / 3 : dx;
}

/**
 * Куда листнуть, когда палец отпустили: `1` — следующий (тянули влево), `-1` — предыдущий, `0` — вернуть на место.
 * `vx` — скорость в конце, px/с (влево отрицательная). Бросок против сдвига (дёрнули обратно) не листает.
 */
export function pageSwipeResult(dx: number, vx: number, width: number, hasPrev: boolean, hasNext: boolean): -1 | 0 | 1 {
  const far = width > 0 && Math.abs(dx) > width / 3;
  const fling = Math.abs(vx) > FLING_PX_S && Math.sign(vx) === Math.sign(dx);
  if (!far && !fling) return 0;
  if (dx < 0) return hasNext ? 1 : 0;
  if (dx > 0) return hasPrev ? -1 : 0;
  return 0;
}

/** Смахнули вниз дальше шестой части высоты — закрыть. */
export function dismissResult(dy: number, height: number): boolean {
  return height > 0 && dy > height / 6;
}

/** Насколько тёмен фон при смахивании (1 — как обычно, к половине высоты — почти прозрачный). */
export function dismissDim(dy: number, height: number): number {
  if (height <= 0 || dy <= 0) return 1;
  return Math.max(0.15, 1 - dy / (height / 2));
}

/** Полоса у края, тап в которой листает: `min(135, ширина/8)` px (Telegram Android). */
export function edgeBand(width: number): number {
  return Math.min(135, width / 8);
}

/** Тап по экрану: `-1` — у левого края (предыдущий), `1` — у правого (следующий), `0` — середина. */
export function tapZone(x: number, width: number): -1 | 0 | 1 {
  const band = edgeBand(width);
  if (x < band) return -1;
  if (x > width - band) return 1;
  return 0;
}

/** Второй тап — пара первому: быстро и рядом. */
export function isDoubleTap(prev: { t: number; x: number; y: number } | null, t: number, x: number, y: number): boolean {
  return !!prev && t - prev.t <= DOUBLE_TAP_MS && Math.hypot(x - prev.x, y - prev.y) <= DOUBLE_TAP_PX;
}

/**
 * Масштаб к точке: точка картинки под `point` остаётся под ним (Ctrl+колесо по курсору, двойной тап в точке касания).
 * `center` — середина картинки без сдвига (экранная). Та же арифметика, что у щипка (`pinchStep`).
 */
export function zoomAt(p: {
  zoom0: number;
  pan0: ZoomPoint;
  center: ZoomPoint;
  point: ZoomPoint;
  zoom: number;
  min: number;
  max: number;
}): { zoom: number; pan: ZoomPoint } {
  const z0 = p.zoom0 > 0 ? p.zoom0 : 1;
  return pinchStep({
    zoom0: z0,
    pan0: p.pan0,
    center: p.center,
    mid0: p.point,
    mid: p.point,
    dist0: 1,
    dist: p.zoom / z0,
    min: p.min,
    max: p.max,
  });
}

/** Шаг Ctrl+колеса: вверх (`deltaY < 0`) — крупнее, на четверть, как кнопки; в пределах `min…max`. */
export function wheelZoomStep(zoom: number, deltaY: number, min: number, max: number): number {
  if (deltaY === 0) return zoom;
  const next = deltaY < 0 ? zoom + 0.25 : zoom - 0.25;
  return Math.min(max, Math.max(min, +next.toFixed(2)));
}

/** Порог колеса для одного листания, px (строчный и страничный режим листают сразу). */
export const WHEEL_PAGE_PX = 40;

/**
 * Колесо листает по одному файлу на серию событий (тачпад шлёт десятки мелких): копим путь серии, на пороге — шаг и
 * серия «отработана» до паузы (её отслеживает вызывающий). Ось — бóльшая из двух (тачпад двумя пальцами вбок тоже
 * листает). Возвращает накопленное и шаг: `1` — следующий (вниз/вправо), `-1` — предыдущий, `0` — ещё нет.
 */
export function wheelPageStep(acc: number, dx: number, dy: number, deltaMode: number): { acc: number; step: -1 | 0 | 1 } {
  const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
  const next = deltaMode !== 0 ? Math.sign(d) * WHEEL_PAGE_PX : acc + d;
  if (Math.abs(next) >= WHEEL_PAGE_PX) return { acc: 0, step: next > 0 ? 1 : -1 };
  return { acc: next, step: 0 };
}

/** Миниатюры внизу — окно вокруг текущей (листание всей медиатекой даёт сотни; рисуем соседей). `[from, to)`. */
export function stripWindow(len: number, index: number, radius = 20): [number, number] {
  if (len <= 0) return [0, 0];
  const from = Math.max(0, Math.min(index - radius, len - 2 * radius - 1));
  return [from, Math.min(len, from + 2 * radius + 1)];
}

/** Близко к краю загруженного — пора подтянуть ещё медиа беседы в эту сторону (`-1` старше, `1` новее, `0` — рано). */
export function nearMediaEdge(index: number, len: number, margin = 2): -1 | 0 | 1 {
  if (len <= 0) return 0;
  if (index <= margin) return -1;
  if (index >= len - 1 - margin) return 1;
  return 0;
}
