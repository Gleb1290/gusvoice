/**
 * Размер картинки-вложения — чтобы лента оставила под неё место ДО скачивания (#194, 23.09).
 *
 * 🔴 **Откуда взялось.** Браузер не знает размер картинки, пока её не скачал, и рисует на её месте
 * ноль. Открыл канал с картинками — лента встала внизу, картинки догрузились, всё уехало вверх.
 * Прижимание к низу по `load` каждой картинки было подпоркой, а не лечением.
 *
 * Размер меряет ОТПРАВИТЕЛЬ перед отправкой (файл у него в руках) и кладёт в вложение — поля
 * `width`/`height` в `Attachment` были заведены давно, но их никто не заполнял. Старые вложения
 * остаются без размеров — для них всё по-прежнему.
 *
 * ⚠️ Размер — со слов отправителя. Поэтому в ленте он задаёт только МЕСТО до загрузки
 * (`aspect-ratio: auto W / H`): после загрузки браузер берёт настоящую пропорцию файла, и неверный
 * размер картинку не исказит.
 */

/** Потолок, который принимает сервер (`routes/messages.ts`, `routes/dm.ts`). Больше — не картинка, а ошибка. */
export const IMAGE_DIM_MAX = 20_000;

/**
 * Размер картинки из файла или `null`, если это не картинка или разобрать не вышло. Не бросает:
 * без размера вложение всё равно уйдёт, просто без заранее оставленного места.
 */
export async function measureImageFile(file: Blob): Promise<{ width: number; height: number } | null> {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return null;
  try {
    const bmp = await createImageBitmap(file);
    const dims = { width: bmp.width, height: bmp.height };
    bmp.close();
    return validDims(dims.width, dims.height) ? dims : null;
  } catch {
    return null;
  }
}

function validDims(w: unknown, h: unknown): w is number {
  return (
    typeof w === 'number' &&
    typeof h === 'number' &&
    Number.isInteger(w) &&
    Number.isInteger(h) &&
    w > 0 &&
    h > 0 &&
    w <= IMAGE_DIM_MAX &&
    h <= IMAGE_DIM_MAX
  );
}

/**
 * Какой прямоугольник занять в ленте: вписать картинку в `maxW × maxH`, не увеличивая. Размера нет
 * или он негодный — `null` (рисуем по-старому).
 */
export function attachmentBox(
  w: number | null | undefined,
  h: number | null | undefined,
  maxW: number,
  maxH: number,
): { width: number; height: number } | null {
  if (!validDims(w, h)) return null;
  const hh = h as number;
  const k = Math.min(1, maxW / w, maxH / hh);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(hh * k)) };
}
