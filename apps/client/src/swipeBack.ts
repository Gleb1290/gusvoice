/**
 * Свайп вправо по экрану беседы — «назад» к списку (07.10, #211, G16). Источник — Telegram Android
 * `ActionBarLayout.onTouchEvent` (слой уезжает за пальцем вправо): жест начинается после сдвига на 0.4 см вправо при условии
 * `|dx| / 3 > dy` (почти горизонтально), НЕ от края экрана; не начинается, если под пальцем горизонтально прокручиваемый
 * вид, который можно крутить влево (`findScrollingChild` — альбомы, блоки кода); отпустил — слой уходит, если он уехал дальше
 * трети ширины (`x < width / 3` — вернуть) или бросок быстрее 3500 px/с (`velX >= 3500`). Свайп влево остаётся свайпом-ответом
 * (`MessagePane`, `swipeIntent`): здесь влево — «чужой жест». Правила чистые, браузерная обвязка — `useSwipeBack.ts`.
 */

/** Сдвиг вправо, после которого жест начинается (Android: 0.4 см ≈ 15 CSS px; берём 24, чтобы не ловить дрожь пальца). */
export const SWIPE_BACK_START_PX = 24;
/** Почти горизонтально: сдвиг по x больше сдвига по y втрое (`Math.abs(dx) / 3 > dy`). */
export const SWIPE_BACK_RATIO = 3;
/** Дальше этой доли ширины слой уходит, ближе — возвращается. */
export const SWIPE_BACK_COMMIT = 1 / 3;
/**
 * Бросок быстрее этого уводит слой и без трети ширины. У Android 3500 px/с физических пикселей (~ 2.6 на CSS px у типичного
 * телефона) — в CSS px это около 1350.
 */
export const SWIPE_BACK_FLING = 1350;
/** Сдвиг, раньше которого палец ещё «не решил»: до него жест молчит. */
const DECIDE_PX = 10;

export type SwipeBackIntent = 'wait' | 'track' | 'other';

/** Что значит сдвиг пальца от точки касания: ждать, вести слой («track») или жест чужой (влево, вниз, вверх). */
export function swipeBackIntent(dx: number, dy: number): SwipeBackIntent {
  const ay = Math.abs(dy);
  if (dx <= -DECIDE_PX) return 'other'; // влево — свайп-ответ
  if (ay >= DECIDE_PX * 2 && ay * SWIPE_BACK_RATIO > Math.max(dx, 0)) return 'other'; // вертикаль — прокрутка ленты
  if (dx >= SWIPE_BACK_START_PX && dx > SWIPE_BACK_RATIO * ay) return 'track';
  return 'wait';
}

/** Уйти назад или вернуть слой: дальше трети ширины или бросок быстрее порога (скорость вправо — положительная). */
export function swipeBackCommit(dx: number, velocityX: number, width: number): boolean {
  if (width <= 0) return false;
  return dx > width * SWIPE_BACK_COMMIT || velocityX >= SWIPE_BACK_FLING;
}

/** Слой за пальцем: не левее нуля и не правее ширины. */
export function swipeBackOffset(dx: number, width: number): number {
  return Math.min(Math.max(dx, 0), Math.max(width, 0));
}

/*
 * Предиктивная «назад» Android 14+ (G16, анимация). Оболочка (`MainActivity`, AndroidX поверх `OnBackAnimationCallback`) шлёт
 * начало, ход (0..1) и отмену системного жеста от края. Источник — Telegram Android `ActionBarLayout.onBackProgress` /
 * `animateBackEndAnimation` и отрисовка в `drawChild`: экран беседы не едет за пальцем, а сжимается до 0.9 к дальнему от пальца
 * краю (опора — 82 dp от него, по высоте — точка касания); ход идёт через `StandardDecelerate` (кривая 0, 0, 0, 1). Отпустил —
 * экран уезжает вправо за край (+56 dp) за 380 мс (`EASE_OUT_QUINT`), отменил — возвращается за 320 мс.
 */

/** Сжатие экрана при полном ходе жеста (Telegram: `lerp(1, 0.9, …)`). */
export const PREDICTIVE_BACK_SCALE = 0.9;
/** Опора сжатия — столько CSS px от дальнего от пальца края (Telegram: `dp(82)`). */
export const PREDICTIVE_BACK_PIVOT_PX = 82;
/** Уход за край — ещё столько px после ширины (Telegram: `getMeasuredWidth() + dp(56)`). */
export const PREDICTIVE_BACK_OVERSHOOT_PX = 56;
/** Уход назад, мс (Telegram: не меньше 380 при предиктивном жесте). */
export const PREDICTIVE_BACK_COMMIT_MS = 380;
/** Возврат при отмене, мс (Telegram: не меньше 320). */
export const PREDICTIVE_BACK_CANCEL_MS = 320;
/** Кривая ухода и возврата (Telegram `CubicBezierInterpolator.EASE_OUT_QUINT`). */
export const PREDICTIVE_BACK_EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

/** Кривая Безье `(x1, y1, x2, y2)` от `x` (0..1) — как `PathInterpolator`. */
export function cubicBezierAt(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const t0 = Math.min(Math.max(x, 0), 1);
  const bez = (a: number, b: number, t: number) => 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (bez(x1, x2, mid) < t0) lo = mid;
    else hi = mid;
  }
  return bez(y1, y2, (lo + hi) / 2);
}

/** Сжатие экрана по ходу жеста `progress` (0..1): 1 → 0.9 через `StandardDecelerate`. */
export function predictiveBackScale(progress: number): number {
  return 1 - (1 - PREDICTIVE_BACK_SCALE) * cubicBezierAt(0, 0, 0, 1, progress);
}

/** Опора сжатия по x: жест от левого края (`edge` 0) — у правого края, от правого — у левого. */
export function predictiveBackOriginX(edge: number, width: number): number {
  return edge === 1 ? PREDICTIVE_BACK_PIVOT_PX : Math.max(width - PREDICTIVE_BACK_PIVOT_PX, 0);
}
