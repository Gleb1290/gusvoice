import type { Attachment } from '@gusvoice/shared';
import { api } from './api';
import { isMobile } from './hotkeys';
import { canCopyImageNative, canSaveImageNative, copyImageNative, saveImageNative } from './nativeMedia';
import { toast } from './toast';

/**
 * «Копировать изображение» и «Сохранить как…» для фото в сообщении (замечание владельца 05.10, как у Telegram Desktop):
 * пункты нашего меню сообщения — правый клик по фото и ячейке альбома, ЛС и каналы (`MessagePane`, меню раунда 12). ПК —
 * веб и десктоп-приложение. Приложение на телефоне (06.10) — через мост медиа Android (`nativeMedia.ts`, `MediaBridge.kt`):
 * «Сохранить» кладёт файл в Pictures/GusVoice (в галерею), «Копировать» — картинку в буфер обмена. Пункты есть, только пока
 * мост доступен (`canCopyImageNative` / `canSaveImageNative`): старая сборка APK, старый WebView, Android ниже 10 — без них.
 *
 * Байты фото — `fetch` с CORS: `<img>` ленты грузится без CORS, холст с ним «испорчен» (`toBlob` бросает). Адрес — тот же,
 * что у «Скачать» вложения (`api.attachmentDownloadUrl`): закрытый файл ЛС — его ссылка `/api/att/<id>/<смотрящий>/<подпись>`
 * (бэкенд; CORS — свой клиент и оболочки Tauri), публичный файл канала — выдача бэкенда `/api/download/attachment` (у
 * хранилища CORS выключен). Этот же адрес отдаётся нативу (`nativeMedia.bytesOf` — тот же `fetch`).
 */

/** Можно ли положить картинку в буфер обмена: на телефоне — мост приложения, иначе Clipboard API с картинками. */
export function canCopyImage(): boolean {
  if (isMobile()) return canCopyImageNative();
  return typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
}

/** Можно ли сохранить фото: на телефоне — в галерею через мост (Android 10+), иначе файлом (веб — загрузка браузера, десктоп — загрузки оболочки). */
export function canSaveImage(): boolean {
  if (isMobile()) return canSaveImageNative();
  return true;
}

const SAVED_TO_GALLERY = 'Сохранено в галерею';

/**
 * Фото, на которое указывает касание (телефон, 06.10: «Копировать изображение» / «Сохранить в галерею» в меню у пузыря):
 * картинка в `.att-img-link` (фото и ячейка альбома) — вложение с тем же `src` (`AttachmentView` отдаёт `a.url`); по прочему
 * месту (`target` пуст или не картинка) — единственная картинка сообщения (тап по подписи сообщения с одним фото). Альбом из
 * нескольких без указания на ячейку — `undefined`: какое из них, не угадать. Вложения без ссылки (ещё грузится закрытый
 * файл ЛС) не в счёт. Тап по самому фото открывает просмотр, меню от него не появляется, — остаются долгое нажатие на фото
 * в канале (в ЛС оно — выделение) и тап по подписи.
 */
export function photoFromTouch(attachments: readonly Attachment[] | undefined, target: Element | null): Attachment | undefined {
  const cell = target?.closest('.att-img-link');
  // Ячейка без картинки — видео (06.10, кадр `<video>`): пунктов фото у него нет, соседнее фото альбома не подставляем.
  if (cell) {
    const src = cell.querySelector('img')?.getAttribute('src');
    return src ? attachments?.find((a) => a.url === src) : undefined;
  }
  const images = (attachments ?? []).filter((a) => a.url && a.contentType.startsWith('image/'));
  return images.length === 1 ? images[0] : undefined;
}

/** Начало PNG: `89 50 4E 47 0D 0A 1A 0A`. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Файл — уже PNG (по байтам, а не по типу: публичная выдача отдаёт `application/octet-stream`). */
export function isPngBytes(head: Uint8Array): boolean {
  return head.length >= PNG_MAGIC.length && PNG_MAGIC.every((b, i) => head[i] === b);
}

/** Фото — PNG для буфера: PNG — как есть; JPEG, WebP, GIF (первый кадр), AVIF, BMP — через `createImageBitmap` и холст. */
async function photoPng(att: Attachment): Promise<Blob> {
  const res = await fetch(api.attachmentDownloadUrl(att), { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.blob();
  if (isPngBytes(new Uint8Array(await raw.slice(0, PNG_MAGIC.length).arrayBuffer()))) {
    return raw.type === 'image/png' ? raw : new Blob([raw], { type: 'image/png' });
  }
  // Тип из вложения: выдача публичного файла говорит `application/octet-stream`, а расшифровщику нужен образ.
  const typed = att.contentType.startsWith('image/') ? new Blob([raw], { type: att.contentType }) : raw;
  const bmp = await createImageBitmap(typed);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d недоступен');
    ctx.drawImage(bmp, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG не получился'))), 'image/png'),
    );
  } finally {
    bmp.close();
  }
}

/**
 * Положить фото в буфер обмена картинкой PNG (Clipboard API браузеров кладёт только PNG). В `ClipboardItem` — обещание:
 * запись начинается сразу, пока жест ещё «свежий» (Safari без этого отказывает), а байты догружаются. Не вышло — бросает.
 */
export async function copyImage(att: Attachment): Promise<{ systemNotice: boolean }> {
  // Приложение на телефоне: байты читает и в буфер кладёт натив (ссылка FileProvider на копию в кеше приложения), PNG в
  // странице не собирается. `systemNotice` — Android 13+ сам показал «Скопировано», свой тост лишний (`copyConfirm.ts`).
  if (isMobile()) return copyImageNative(api.attachmentDownloadUrl(att), att.name);
  const png = photoPng(att);
  // Запись может отказать раньше, чем откажет само обещание (окно без фокуса), — тогда его отказ некому было бы принять.
  png.catch(() => {});
  let item: ClipboardItem;
  try {
    item = new ClipboardItem({ 'image/png': png });
  } catch {
    // Движок без обещаний в `ClipboardItem` — ждём картинку и кладём готовую.
    item = new ClipboardItem({ 'image/png': await png });
  }
  await navigator.clipboard.write([item]);
  return { systemNotice: false };
}

/**
 * Сохранить фото файлом с исходным именем — тем же путём, что «Скачать» у вложения: ссылка на выдачу с
 * `Content-Disposition: attachment` (атрибут `download` у чужого адреса браузеры не слушают — имя даёт заголовок).
 * Веб — загрузка браузера. Десктоп — загрузку WebView2 перехватывает оболочка (`lib.rs` `wire_download_notifications`):
 * папка загрузок из настроек, нет её — окно выбора папки (`downloads.ts`), по итогу тост «Файл скачан». Системного окна
 * «Сохранить как» у оболочки нет: в правах только `dialog:allow-open`, а записать файл по выбранному пути нечем (это
 * новая команда оболочки — только с релизом десктопа).
 *
 * Приложение на телефоне: `<a download>` в WebView молча ничего не делает, поэтому файл кладёт натив — в галерею
 * (Pictures/GusVoice, Android 10+), по итогу тост «Сохранено в галерею»; не вышло — бросает (зовущий показывает ошибку).
 *
 * ⚠️ Щелчок по ссылке — следующей задачей, а не сразу: меню, из пункта которого позвали, в этот момент ещё на экране, и у
 * меню у пузыря (узкое окно) перехват «щелчка мимо» (`ContextMenu`, `tapClose`) гасит его `preventDefault` — загрузка
 * молча не начиналась (стенд 05.10).
 */
export async function saveImage(att: Attachment): Promise<void> {
  const href = api.attachmentDownloadUrl(att);
  if (isMobile()) {
    await saveImageNative(href, att.name);
    toast('success', SAVED_TO_GALLERY);
    return;
  }
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  const a = document.createElement('a');
  a.href = href;
  a.download = att.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
