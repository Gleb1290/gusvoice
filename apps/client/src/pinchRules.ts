/**
 * Щипок по фото прямо в ленте (G43, телефон): правила жеста — без DOM, чтобы их проверял тест. Цифры — Telegram для
 * Android (`PinchToZoomHelper.checkPinchToZoom` / `finishZoom`): увеличение включается, когда расстояние между пальцами выросло
 * больше чем на 0,5 % от нажатия; отпустили любой из двух пальцев — картинка возвращается на место за 220 мс по кривой
 * `CubicBezierInterpolator.DEFAULT`. Что щипком не увеличивается (стикеры, кружки, документы, видео без автовоспроизведения,
 * размытые превью), решает `feedPinch.ts` по разметке.
 */

/** Во сколько раз пальцы разошлись, чтобы увеличение началось (`pinchScale > 1.005f`). */
export const PINCH_START_SCALE = 1.005;
/** Возврат картинки на место после отпускания (`finishTransition.setDuration(220)`). */
export const PINCH_FINISH_MS = 220;
/** Кривая возврата — `CubicBezierInterpolator.DEFAULT` (0,25 · 0,1 · 0,25 · 1). */
export const PINCH_FINISH_EASING = 'cubic-bezier(0.25, 0.1, 0.25, 1)';

/** Расстояние между двумя касаниями. */
export function pinchDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/** Увеличение вышло на порог: слой поверх ленты пора показывать. */
export function pinchStarted(scale: number): boolean {
  return scale > PINCH_START_SCALE;
}

/**
 * Масштаб слоя: расстояние сейчас к расстоянию при старте слоя. Меньше единицы не бывает — слой всегда накрывает свой снимок в
 * ленте, а уменьшить фото щипком Telegram не даёт (под слоем остаётся то же фото). Нулевое начальное расстояние — 1.
 */
export function pinchScale(dist: number, startDist: number): number {
  if (!(startDist > 0)) return 1;
  return Math.max(1, dist / startDist);
}

/**
 * CSS слоя: сдвиг центра щипка (`dx`, `dy` — на сколько ушёл центр между пальцами от старта слоя) и масштаб вокруг точки
 * старта (`transform-origin` слоя). Точка фото под центром пальцев идёт за ним, как у Telegram.
 */
export function pinchTransform(scale: number, dx: number, dy: number): string {
  return `translate(${dx}px, ${dy}px) scale(${scale})`;
}
