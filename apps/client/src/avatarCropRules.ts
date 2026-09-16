/**
 * Геометрия кадрирования аватара — чистая, БЕЗ DOM и canvas.
 *
 * Вынуто из `AvatarCropModal.tsx` по просьбе Codex (2026-07-27). Ошибка тут вырезает не тот кусок
 * картинки — причём молча: человек видит в рамке одно, а загружается другое.
 */

/** Квадратное окно, в котором человек кадрирует, и размер экспортируемого аватара (px). */
export const VIEW = 280;
export const OUT = 256;

/** Во сколько раз можно приблизить относительно минимального масштаба. */
export const MAX_ZOOM = 4;

export interface Size {
  w: number;
  h: number;
}
export interface Offset {
  x: number;
  y: number;
}

/**
 * Наименьший масштаб, при котором картинка ещё накрывает окно целиком.
 * ⚠️ `max`, а не `min`: нужно закрыть ОБЕ стороны, поэтому берём тот масштаб, которого требует
 * более узкая сторона. С `min` внутри рамки оставались бы пустые поля.
 */
export function coverScale(nat: Size, view = VIEW): number {
  return Math.max(view / nat.w, view / nat.h);
}

/** Смещение, при котором картинка данного масштаба стоит по центру окна. */
export function centerOffset(nat: Size, scale: number, view = VIEW): Offset {
  return { x: (view - nat.w * scale) / 2, y: (view - nat.h * scale) / 2 };
}

/** Прижать смещение так, чтобы картинка накрывала окно со всех сторон (без пустых полей в рамке). */
export function clampOffset(off: Offset, scale: number, nat: Size, view = VIEW): Offset {
  const w = nat.w * scale;
  const h = nat.h * scale;
  return { x: Math.min(0, Math.max(view - w, off.x)), y: Math.min(0, Math.max(view - h, off.y)) };
}

/**
 * Приблизить/отдалить к целевому масштабу ВОКРУГ ЦЕНТРА окна, чтобы кадрируемый объект не уезжал.
 * Масштаб зажимается в `[minScale, minScale * MAX_ZOOM]`, смещение — правилом накрытия.
 */
export function zoomTo(
  cur: { scale: number; off: Offset },
  target: number,
  minScale: number,
  nat: Size,
  view = VIEW,
): { scale: number; off: Offset } {
  const scale = Math.max(minScale, Math.min(minScale * MAX_ZOOM, target));
  const c = view / 2;
  const k = scale / cur.scale;
  return {
    scale,
    off: clampOffset({ x: c - (c - cur.off.x) * k, y: c - (c - cur.off.y) * k }, scale, nat, view),
  };
}

/**
 * Область ИСХОДНОЙ картинки, которая попадёт в аватар: то, что видно в окне, пересчитанное в
 * координаты оригинала. Отдаётся прямо в `drawImage(img, sx, sy, size, size, 0, 0, OUT, OUT)`.
 */
export function sourceRect(off: Offset, scale: number, view = VIEW): { sx: number; sy: number; size: number } {
  return { sx: -off.x / scale, sy: -off.y / scale, size: view / scale };
}

/** Положение ползунка зума 0..1 — для медовой заливки (`--p`). */
export function zoomFraction(scale: number, minScale: number): number {
  if (minScale <= 0) return 0;
  return (scale - minScale) / (minScale * (MAX_ZOOM - 1));
}
