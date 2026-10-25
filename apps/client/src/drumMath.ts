/**
 * Барабан выбора (`components/DrumPicker.tsx`) — чистая математика без DOM. Опора — tdesktop
 * `ui/widgets/vertical_drum_picker.cpp` (`DefaultPaintCallback`: затухание и сжатие крайних строк, `increaseShift`: границы,
 * `handleWheelEvent`: шаг колеса, `handleMouseEvent`: щелчок по строке) и `ui/boxes/time_picker_box.cpp` (высота 200, строка 40,
 * `startIndex` — ближайшее значение). Код Telegram не копирован.
 */

/** Высота окна барабана и строки, px (tdesktop `historyMessagesTTLPickerHeight` / `…ItemHeight`). */
export const DRUM_HEIGHT = 200;
export const DRUM_ITEM_HEIGHT = 40;
/** Сжатие строки у края (tdesktop `kMinYScale`). */
export const DRUM_MIN_Y_SCALE = 0.2;
/** Доводка к строке, мс (tdesktop `st::fadeWrapDuration`). */
export const DRUM_SNAP_MS = 200;
/** Один «щелчок» колеса мыши в `deltaY` (Qt `DefaultDeltasPerStep` = 120; в браузере обычно 100). */
export const DRUM_WHEEL_STEP = 100;
/** Как далеко летит барабан после броска: секунд скорости (мягкое трение). */
export const DRUM_FLING_SECONDS = 0.22;

export function easeOutCubic(t: number): number {
  const r = 1 - Math.min(1, Math.max(0, t));
  return 1 - r * r * r;
}

/** Положение (в строках; целое = строка по центру) в границы списка. */
export function clampPos(pos: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, pos));
}

/** Строка, стоящая по центру (для `onChange`). */
export function centerIndex(pos: number, count: number): number {
  return clampPos(Math.round(pos), count);
}

/** Ближайшее к `start` значение списка (tdesktop `TimePickerBox`: `lower_bound` и сравнение расстояний). */
export function nearestIndex(values: readonly number[], start: number): number {
  if (values.length === 0) return 0;
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i]! - start) < Math.abs(values[best]! - start)) best = i;
  }
  return best;
}

/**
 * Вид строки `index` при центре `pos`: смещение от центра окна (px), сжатие по высоте и прозрачность. Как
 * `DefaultPaintCallback`: расстояние от центра в долях половины высоты, прозрачность `1 − d`, сжатие `0.2 + 0.8·easeOutCubic(1 − d)`.
 */
export function drumRowLook(
  index: number,
  pos: number,
  itemHeight = DRUM_ITEM_HEIGHT,
  height = DRUM_HEIGHT,
): { offset: number; scale: number; opacity: number } {
  const offset = (index - pos) * itemHeight;
  const d = Math.min(1, Math.abs(offset) / (height / 2));
  const rev = 1 - d;
  return { offset, scale: DRUM_MIN_Y_SCALE + (1 - DRUM_MIN_Y_SCALE) * easeOutCubic(rev), opacity: rev };
}

/** Шаги колеса из накопленной прокрутки: целых шагов со знаком и остаток. */
export function wheelSteps(acc: number, step = DRUM_WHEEL_STEP): { steps: number; rest: number } {
  const steps = Math.trunc(acc / step);
  return { steps, rest: acc - steps * step };
}

/** Строка, по которой щёлкнули; `y` — от верха окна барабана (tdesktop: прыжок на `centerOffset − y / itemHeight`). */
export function tapTarget(pos: number, y: number, itemHeight = DRUM_ITEM_HEIGHT, height = DRUM_HEIGHT, count = Infinity): number {
  return clampPos(Math.round(pos + (y - height / 2) / itemHeight), count);
}

/**
 * Куда долетит барабан после броска: `velocity` — строк в секунду (положительная — к большим номерам), доводка к целой строке.
 * Без скорости — просто ближайшая строка (как tdesktop после отпускания).
 */
export function flingTarget(pos: number, velocity: number, count: number): number {
  return clampPos(Math.round(pos + velocity * DRUM_FLING_SECONDS), count);
}

/** Длительность доводки, мс: от 200 (одна строка) до 600 (далеко). */
export function snapDuration(from: number, to: number): number {
  return Math.round(Math.min(600, DRUM_SNAP_MS + Math.abs(to - from) * 40));
}
