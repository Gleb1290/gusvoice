import { photoCompressible } from './attachRules';
import type { DrawMark } from './photoDrawRules';

/**
 * Правка вложений до отправки (08.10, #211, G49) — ЧИСТЫЕ правила. Источники (поведение, не код): Telegram Desktop
 * `editor/photo_editor.cpp` (поворот, отражение, пропорции рамки), `editor/editor_crop.cpp` (рамка с ручками по углам и краям,
 * наименьший размер), `boxes/send_files_box.cpp` (меню плитки: «Заменить вложение», «Переименовать файл»); Android
 * `PhotoCropView` (поворот против часовой). Код Telegram не копировали.
 *
 * Рамка кадра — доли (0…1) ВИДИМОГО изображения: уже повёрнутого и отражённого. Поворот кнопкой — всегда против часовой на
 * экране (значок `rotate`, как в просмотрщике), поэтому при отражении угол модели идёт в другую сторону.
 */

/** Рамка кадра в долях видимого изображения. */
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Пропорции рамки: «Свободно», «Квадрат», «Оригинал» (как у видимого снимка — после поворота). */
export type CropAspect = 'free' | 'square' | 'original';

/** Состояние редактора: угол модели (градусы против часовой, 0/90/180/270), отражение по горизонтали, рамка, пропорции. */
export interface PhotoEdit {
  angle: 0 | 90 | 180 | 270;
  flipped: boolean;
  crop: CropBox;
  aspect: CropAspect;
  /** Нарисованное и надписи (14.10, G49): в пикселях исходника, см. `photoDrawRules.ts`; нет — ничего не рисовали. */
  marks?: DrawMark[];
}

export const FULL_CROP: CropBox = { x: 0, y: 0, w: 1, h: 1 };

export const PRISTINE_EDIT: PhotoEdit = { angle: 0, flipped: false, crop: FULL_CROP, aspect: 'free' };

/** Наименьшая сторона рамки на экране, px (у Telegram Desktop `photoEditorCropMinSize` — того же порядка). */
export const CROP_MIN_PX = 40;

/** Ручки рамки: углы, края и «вся рамка» (сдвиг). */
export type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

/** Что правится редактором: фото, которые браузер декодирует холстом (GIF, SVG — нет: анимация и вектор потеряются). */
export function photoEditable(mime: string): boolean {
  return photoCompressible(mime) && !/heic|heif/i.test(mime);
}

/** Размер видимого изображения при угле `angle`: 90 и 270 меняют стороны местами. */
export function rotatedSize(w: number, h: number, angle: PhotoEdit['angle']): { w: number; h: number } {
  return angle === 90 || angle === 270 ? { w: h, h: w } : { w, h };
}

/** Рамка после поворота видимого изображения на 90° против часовой: точка (x, y) переходит в (y, 1 − x). */
export function rotateCropLeft(c: CropBox): CropBox {
  return { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
}

/** Рамка после отражения видимого изображения по горизонтали. */
export function flipCrop(c: CropBox): CropBox {
  return { ...c, x: 1 - c.x - c.w };
}

/** «Повернуть»: на экране — против часовой; при отражении модельный угол идёт по часовой (иначе картинка крутится не туда). */
export function rotateLeft(e: PhotoEdit): PhotoEdit {
  const step = e.flipped ? 270 : 90;
  return { ...e, angle: ((e.angle + step) % 360) as PhotoEdit['angle'], crop: rotateCropLeft(e.crop) };
}

/** «Отразить» по горизонтали. */
export function flipEdit(e: PhotoEdit): PhotoEdit {
  return { ...e, flipped: !e.flipped, crop: flipCrop(e.crop) };
}

/** Пропорция ширины к высоте для режима рамки; null — свободно. `vw`, `vh` — размер видимого изображения в px. */
export function aspectRatio(aspect: CropAspect, vw: number, vh: number): number | null {
  if (aspect === 'square') return 1;
  if (aspect === 'original') return vh > 0 ? vw / vh : null;
  return null;
}

/**
 * Рамка под пропорцию: наибольшая такой пропорции внутри снимка, по центру (как Android `PhotoCropView` при выборе
 * пропорции). Свободно — рамка как была.
 */
export function fitAspect(c: CropBox, ratio: number | null, vw: number, vh: number): CropBox {
  if (ratio === null || vw <= 0 || vh <= 0) return c;
  let w = vw;
  let h = w / ratio;
  if (h > vh) {
    h = vh;
    w = h * ratio;
  }
  return { x: (vw - w) / 2 / vw, y: (vh - h) / 2 / vh, w: w / vw, h: h / vh };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Перетаскивание ручки на `dx`, `dy` px экрана (`vw`, `vh` — размер снимка на экране). Рамка не выходит за снимок и не меньше
 * `min` px; при заданной пропорции тянутся только углы — противоположный угол стоит, пропорция держится.
 */
export function dragCrop(
  c: CropBox,
  handle: CropHandle,
  dx: number,
  dy: number,
  vw: number,
  vh: number,
  ratio: number | null,
  min: number = CROP_MIN_PX,
): CropBox {
  if (vw <= 0 || vh <= 0) return c;
  const minW = Math.min(min, vw);
  const minH = Math.min(min, vh);
  let x = c.x * vw;
  let y = c.y * vh;
  let w = c.w * vw;
  let h = c.h * vh;
  if (handle === 'move') {
    x = clamp(x + dx, 0, vw - w);
    y = clamp(y + dy, 0, vh - h);
  } else if (ratio !== null && handle.length === 2) {
    const west = handle.includes('w');
    const north = handle.includes('n');
    const ax = west ? x + w : x;
    const ay = north ? y + h : y;
    const wantW = w + (west ? -dx : dx);
    const wantH = h + (north ? -dy : dy);
    const roomW = west ? ax : vw - ax;
    const roomH = north ? ay : vh - ay;
    let nw = Math.max(wantW, wantH * ratio);
    nw = Math.min(nw, roomW, roomH * ratio);
    nw = Math.max(nw, Math.min(Math.max(minW, minH * ratio), roomW, roomH * ratio));
    const nh = nw / ratio;
    x = west ? ax - nw : ax;
    y = north ? ay - nh : ay;
    w = nw;
    h = nh;
  } else if (ratio === null) {
    if (handle.includes('w')) {
      const nx = clamp(x + dx, 0, x + w - minW);
      w = x + w - nx;
      x = nx;
    }
    if (handle.includes('e')) w = clamp(w + dx, minW, vw - x);
    if (handle.includes('n')) {
      const ny = clamp(y + dy, 0, y + h - minH);
      h = y + h - ny;
      y = ny;
    }
    if (handle.includes('s')) h = clamp(h + dy, minH, vh - y);
  }
  return { x: x / vw, y: y / vh, w: w / vw, h: h / vh };
}

/**
 * Рамка в пикселях снимка (`vw` × `vh` — видимый размер оригинала): целые, внутри снимка, не меньше 1 px. С пропорцией
 * (`ratio`) высота считается от ширины — «Квадрат» выходит ровно квадратным, хотя рамку тянули по округлённому экрану.
 */
export function cropPixels(
  c: CropBox,
  vw: number,
  vh: number,
  ratio: number | null = null,
): { x: number; y: number; w: number; h: number } {
  const x = clamp(Math.round(c.x * vw), 0, vw - 1);
  const y = clamp(Math.round(c.y * vh), 0, vh - 1);
  let w = clamp(Math.round(c.w * vw), 1, vw - x);
  let h = clamp(Math.round(ratio ? w / ratio : c.h * vh), 1, vh - y);
  if (ratio && Math.round(h * ratio) < w) w = clamp(Math.round(h * ratio), 1, vw - x);
  return { x, y, w, h };
}

/** Ничего не правили: «Готово» вернёт исходный файл без перекодирования. */
export function editIsPristine(e: PhotoEdit): boolean {
  const c = e.crop;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
  return e.angle === 0 && !e.flipped && near(c.x, 0) && near(c.y, 0) && near(c.w, 1) && near(c.h, 1);
}

/** Тип результата: JPEG / PNG / WebP — тот же (прозрачность PNG и WebP сохраняется), остальное — JPEG. */
export function editOutputType(mime: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  const m = mime.toLowerCase();
  if (m === 'image/png') return 'image/png';
  if (m === 'image/webp') return 'image/webp';
  return 'image/jpeg';
}

/** Имя результата: расширение — по типу результата, если у исходного другое. */
export function editedName(name: string, type: ReturnType<typeof editOutputType>): string {
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  const cur = m?.[1]?.toLowerCase();
  if (cur === ext || (ext === 'jpg' && cur === 'jpeg')) return name;
  const base = (m ? name.slice(0, -m[0].length) : name) || 'photo';
  return `${base}.${ext}`;
}

/**
 * «Переименовать файл» (Telegram Desktop `lng_rename_file`): имя при отправке. Пусто или то же — null (не менять). Без
 * расширения — дописывается прежнее (иначе файл у получателя не откроется двойным щелчком). Запрещённые в именах файлов
 * знаки (`\ / : * ? " < > |`) — на «_».
 */
export function renameTarget(oldName: string, input: string): string | null {
  const clean = input.trim().replace(/[\\/:*?"<>|]/g, '_');
  if (!clean || /^\.+$/.test(clean)) return null;
  const oldExt = /\.[a-z0-9]{1,8}$/i.exec(oldName)?.[0] ?? '';
  const next = /\.[a-z0-9]{1,8}$/i.test(clean) || !oldExt ? clean : `${clean}${oldExt}`;
  return next === oldName ? null : next;
}

/** Заменить элемент списка на месте (`Заменить вложение`, правка фото). Вне списка — список как был. */
export function replaceAt<T>(list: readonly T[], i: number, item: T): T[] {
  if (i < 0 || i >= list.length) return list.slice();
  const next = list.slice();
  next[i] = item;
  return next;
}

/** Задержка удержания перед перетаскиванием плитки пальцем, мс (Telegram Android — долгое нажатие системы, ~400 мс). */
export const REORDER_HOLD_MS = 350;

/** Сдвиг пальца до срабатывания удержания, px: больше — это прокрутка полосы, а не перетаскивание. */
export const REORDER_SLOP_PX = 8;
