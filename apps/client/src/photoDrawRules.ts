/**
 * Рисование и надписи в редакторе фото до отправки (14.10, #211, G49) — ЧИСТЫЕ правила (холст и указатели — `PhotoEditor.tsx`).
 * Источники (поведение, не код): Telegram Desktop `editor/color_picker.cpp` (палитра из десяти цветов `PaletteColors`, толщина кисти
 * `kMinBrushWidth`…`kMaxBrushWidth`, инструменты «Кисть» / «Ластик»), `editor/scene/scene_item_text.cpp` (надпись — вещь на сцене,
 * её можно двигать и менять цвет); Android `Components/Paint/Views/ColorPicker.java` (`COLORS`, вес кисти) и `PhotoPaintView`
 * (отмена последнего штриха). Код Telegram не копировали.
 *
 * Метки хранятся в ПИКСЕЛЯХ ИСХОДНИКА, делённых на `markUnit` (короткую сторону): поворот, отражение и обрезка потом их не
 * сдвигают — картинка с метками поворачивается как одно целое, а на выходе рисуется тем же `applyEditTransform`, что и снимок.
 */

/** Точка метки: пиксели исходника ÷ `markUnit`. */
export interface MarkPoint {
  x: number;
  y: number;
}

/** Штрих кисти или ластика (ластик стирает всё нарисованное ниже, снимок не трогает). */
export interface StrokeMark {
  kind: 'stroke';
  color: string;
  /** Толщина в долях `markUnit`. */
  width: number;
  erase?: boolean;
  points: MarkPoint[];
}

/** Надпись: центр в (x, y), кегль `size` в долях `markUnit`. */
export interface TextMark {
  kind: 'text';
  color: string;
  size: number;
  text: string;
  x: number;
  y: number;
}

export type DrawMark = StrokeMark | TextMark;

/** Палитра (Telegram Desktop `PaletteColors`): чёрный, белый, красный, оранжевый, жёлтый, зелёный, голубой, синий, лиловый, розовый. */
export const MARK_PALETTE: readonly string[] = [
  '#000000',
  '#ffffff',
  '#ea2739',
  '#fc964d',
  '#fcde65',
  '#80c864',
  '#49c5ed',
  '#3051e3',
  '#db3ad2',
  '#ff72a9',
];

/** Цвет по умолчанию — красный (первый цвет полосы цветов Telegram Android). */
export const DEFAULT_MARK_COLOR = '#ea2739';

/** Толщина кисти, доли короткой стороны: от тонкой до жирной (у Desktop 1…25 px на ~900-пиксельном холсте). */
export const BRUSH_MIN = 0.003;
export const BRUSH_MAX = 0.05;
export const BRUSH_DEFAULT = 0.012;

/** Кегль надписи, доли короткой стороны. */
export const TEXT_MIN = 0.03;
export const TEXT_MAX = 0.2;
export const TEXT_DEFAULT = 0.07;

/** Шаг движка толщины и кегля (внутри — 0…100, наружу — доля). */
export const SLIDER_STEPS = 100;

/** Единица меток: короткая сторона исходника, px. */
export function markUnit(w: number, h: number): number {
  return Math.max(1, Math.min(w, h));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Положение движка 0…100 → значение между `lo` и `hi` (линейно). */
export function sliderToValue(step: number, lo: number, hi: number): number {
  const t = clamp(Number.isFinite(step) ? step : 0, 0, SLIDER_STEPS) / SLIDER_STEPS;
  return lo + (hi - lo) * t;
}

/** Значение → положение движка 0…100 (целое). */
export function valueToSlider(value: number, lo: number, hi: number): number {
  if (!(hi > lo) || !Number.isFinite(value)) return 0;
  return Math.round(clamp((value - lo) / (hi - lo), 0, 1) * SLIDER_STEPS);
}

/** Видимые координаты (px изображения на экране, уже повёрнутого и отражённого) → пиксели исходника. Обратно к `applyEditTransform`. */
export function visibleToSource(
  vx: number,
  vy: number,
  w: number,
  h: number,
  angle: 0 | 90 | 180 | 270,
  flipped: boolean,
): MarkPoint {
  const visW = angle === 90 || angle === 270 ? h : w;
  const qx = flipped ? visW - vx : vx;
  const qy = vy;
  if (angle === 90) return { x: w - qy, y: qx };
  if (angle === 180) return { x: w - qx, y: h - qy };
  if (angle === 270) return { x: qy, y: h - qx };
  return { x: qx, y: qy };
}

/** Пиксели исходника → видимые координаты (то же, что делает `applyEditTransform` с точкой). */
export function sourceToVisible(
  px: number,
  py: number,
  w: number,
  h: number,
  angle: 0 | 90 | 180 | 270,
  flipped: boolean,
): MarkPoint {
  const visW = angle === 90 || angle === 270 ? h : w;
  let qx = px;
  let qy = py;
  if (angle === 90) [qx, qy] = [py, w - px];
  else if (angle === 180) [qx, qy] = [w - px, h - py];
  else if (angle === 270) [qx, qy] = [h - py, px];
  return { x: flipped ? visW - qx : qx, y: qy };
}

/** Следующая точка штриха: ближе `minDist` (в долях единицы) к последней — пропускается, штрих не пухнет от дрожи указателя. */
export function appendPoint(points: readonly MarkPoint[], p: MarkPoint, minDist = 0.002): MarkPoint[] {
  const last = points[points.length - 1];
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < minDist) return points as MarkPoint[];
  return [...points, p];
}

/** Рамка надписи в единицах метки: центр (x, y), ширина по замеру `textWidth(text, size)` (в тех же единицах), высота — полторы строки. */
export function textBox(
  m: TextMark,
  textWidth: (text: string, size: number) => number,
): { x: number; y: number; w: number; h: number } {
  const w = Math.max(m.size, textWidth(m.text || ' ', m.size)) + m.size * 0.6;
  const h = m.size * 1.5;
  return { x: m.x - w / 2, y: m.y - h / 2, w, h };
}

/** Какая надпись под точкой (верхняя — позже добавленная); -1 — никакой. Точка и замер — в единицах метки. */
export function hitText(
  marks: readonly DrawMark[],
  p: MarkPoint,
  textWidth: (text: string, size: number) => number,
): number {
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i];
    if (m.kind !== 'text') continue;
    const b = textBox(m, textWidth);
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return i;
  }
  return -1;
}

/** «Отменить»: убирает последнюю метку (штрих или надпись). Пусто — пусто. */
export function undoMark(marks: readonly DrawMark[]): DrawMark[] {
  return marks.slice(0, -1);
}

/** Выбрасывает надписи без текста (создали и ничего не набрали) и штрихи без точек. */
export function pruneMarks(marks: readonly DrawMark[]): DrawMark[] {
  return marks.filter((m) => (m.kind === 'text' ? m.text.trim().length > 0 : m.points.length > 0));
}

/** Есть ли что запекать в картинку. */
export function hasMarks(marks: readonly DrawMark[] | undefined): boolean {
  return !!marks && pruneMarks(marks).length > 0;
}

/** Цвет обводки надписи, чтобы читалась на любом фоне: тёмная под светлым текстом и наоборот. */
export function textOutline(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return '#000000';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#000000' : '#ffffff';
}

/** Заменить поля надписи на месте (сдвиг, цвет, текст, кегль). Не надпись или вне списка — список как был. */
export function updateMark(marks: readonly DrawMark[], i: number, patch: Partial<Omit<TextMark, 'kind'>>): DrawMark[] {
  const cur = marks[i];
  if (!cur || cur.kind !== 'text') return marks.slice();
  const next = marks.slice();
  next[i] = { ...cur, ...patch };
  return next;
}

/** Убрать метку по номеру. */
export function removeMark(marks: readonly DrawMark[], i: number): DrawMark[] {
  return marks.filter((_, k) => k !== i);
}
