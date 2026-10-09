import { PHOTO_MAX_SIDE, PHOTO_QUALITY, compressedName, fitWithin, photoCompressible } from './attachRules';

/**
 * Сжатие фото «как в Telegram» в браузере (05.10): «Фото или видео» через системный выбор и снимки камеры листа. В
 * приложении Android фото из своей галереи сжимает натив (`MediaBridge.compressedJpeg`) — те же числа из `attachRules`.
 *
 * Длинная сторона до 2560 px (`maxSide`; окно отправки файлов с `media2` даёт 1280 у обычного фото, `PHOTO_STANDARD_SIDE`), JPEG 0.85. Поворот по EXIF применяет сам браузер при декодировании (`imageOrientation:
 * 'from-image'`), а холст метаданных не переносит вовсе — GPS и модель телефона не уходят. Прозрачное — на белом (JPEG
 * альфы не знает). Не вышло (HEIC, который браузер не декодирует, нехватка памяти, нет `createImageBitmap`) — уходит
 * оригинал: потерять вложение хуже, чем не сжать его.
 */
export async function compressPhoto(file: File, maxSide: number = PHOTO_MAX_SIDE): Promise<File> {
  if (!photoCompressible(file.type) || typeof createImageBitmap !== 'function') return file;
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const { w, h } = fitWithin(bmp.width, bmp.height, maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob || blob.size === 0) return file;
    return new File([blob], compressedName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bmp?.close();
  }
}

/** Сжать фото в списке (видео и остальное — как есть), по одному: двенадцать мегапикселей разом — много памяти телефона. */
export async function compressPhotos(files: readonly File[], maxSide: number = PHOTO_MAX_SIDE): Promise<File[]> {
  const out: File[] = [];
  for (const f of files) out.push(await compressPhoto(f, maxSide));
  return out;
}
