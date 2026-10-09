import { FEATURE_BIGFILE1, FEATURE_CONV10 } from '@gusvoice/shared';

/**
 * Вложения «как в Telegram» (решение владельца 05.10): скрепка — «Фото или видео» / «Файл», своя галерея в приложении
 * Android (`MediaSheet`, мост `nativeMedia.ts`), камера первой ячейкой листа. Здесь — чистые правила без React, DOM и моста.
 */

/** Сколько вложений берёт одно сообщение — тот же предел, что режет `MessagePane.addFiles` (`fitAttachments`). */
export const ATTACH_MAX = 10;

/**
 * Предел одного файла, байт: `limits.fileSize` у `@fastify/multipart` бэкенда (`packages/backend/src/index.ts`). Больше —
 * сервер ответит 413; галерея такое не даёт выбрать, а натив не тянет (копировать в память 300 МБ ради отказа незачем).
 */
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Предел файла в ЛС и путь загрузки по объявлению сервера (`bigfile1`, 09.10): признак есть и сервер назвал предел
 * (`dmFileMaxBytes` в `/auth/me`) — кусками до него; иначе — прежние 25 МБ одним запросом. Каналы серверов — всегда 25 МБ.
 */
export function dmFileLimitFrom(
  features: readonly string[] | null | undefined,
  maxBytes: number | null | undefined,
): { chunked: boolean; max: number } {
  const on = !!features?.includes(FEATURE_BIGFILE1) && typeof maxBytes === 'number' && maxBytes > ATTACH_MAX_BYTES;
  return on ? { chunked: true, max: maxBytes } : { chunked: false, max: ATTACH_MAX_BYTES };
}

/** Предел активного инстанса — ставит `App.loadMe` из `/auth/me` (вне стора: нужен в момент выбора и загрузки, не для рисования). */
let dmLimit = dmFileLimitFrom(null, null);
export function setDmFileLimit(features: readonly string[] | null | undefined, maxBytes: number | null | undefined): void {
  dmLimit = dmFileLimitFrom(features, maxBytes);
}
/** Слать ли крупные файлы ЛС кусками (`api.convUpload` → `chunkedUpload.ts`). */
export function dmChunkedUploads(): boolean {
  return dmLimit.chunked;
}
/** Предел одного файла в ЛС на активном инстансе, байт. */
export function dmAttachMaxBytes(): number {
  return dmLimit.max;
}

/**
 * Чем открыть «Фото или видео»:
 * - `native` — своя галерея: в приложении Android есть мост `GusVoiceMedia` (`MediaBridge.kt`);
 * - `sheet` — лист с камерой и системным выбором: палец, камера есть, это не оболочка ПК (браузер телефона; приложение
 *   Android со старым WebView, где моста нет);
 * - `input` — системный выбор файла с `accept="image/*,video/*"` (ПК: браузер и приложение).
 */
export type AttachMode = 'native' | 'sheet' | 'input';

export function attachMode(env: {
  nativeGallery: boolean;
  coarse: boolean;
  camera: boolean;
  desktopShell: boolean;
}): AttachMode {
  if (env.nativeGallery) return 'native';
  if (!env.desktopShell && env.coarse && env.camera) return 'sheet';
  return 'input';
}

/** Сколько ещё можно добавить к тому, что уже лежит в поле ввода. */
export function attachRoom(pendingCount: number, max = ATTACH_MAX): number {
  return Math.max(0, max - Math.max(0, pendingCount));
}

/**
 * Что из выбранных файлов войдёт в поле вложений (06.10): сообщение берёт не больше `max`, лишние — хвост выбора.
 * `dropped` — сколько не вошло: раньше `slice(0, 10)` в `MessagePane.addFiles` отбрасывал их МОЛЧА, и человек видел
 * меньше файлов, чем выбрал, не зная почему.
 */
export function fitAttachments<T>(
  pendingCount: number,
  incoming: readonly T[],
  max = ATTACH_MAX,
): { taken: T[]; dropped: number } {
  const taken = incoming.slice(0, attachRoom(pendingCount, max));
  return { taken, dropped: incoming.length - taken.length };
}

/**
 * Тост, когда часть выбранных файлов не вошла (`fitAttachments.dropped > 0`). Слова — те же, что у листа вложений
 * (`MediaSheet`: «Не больше N вложений — лишние не добавлены», «В сообщении уже 10 вложений»): точный и при пустом
 * поле, и при полном, и когда файлы докладывают к уже выбранным.
 */
export function droppedAttachText(max = ATTACH_MAX): string {
  return `В сообщении не больше ${max} вложений — лишние не добавлены`;
}

/**
 * Нажатие по миниатюре: номер = порядок нажатия (как у Telegram), снятие сдвигает номера следующих. Мест нет — новое не
 * берём (`full`), выбранное снимается всегда.
 */
export function toggleSelected(order: readonly string[], id: string, room: number): { order: string[]; full: boolean } {
  if (order.includes(id)) return { order: order.filter((x) => x !== id), full: false };
  if (order.length >= room) return { order: [...order], full: true };
  return { order: [...order, id], full: false };
}

/** Номер на миниатюре (1…N) или 0 — не выбрана. */
export function selectedNumber(order: readonly string[], id: string): number {
  return order.indexOf(id) + 1;
}

/** Файл больше предела сервера. Размер неизвестен (0) — пропускаем, решит натив по байтам. */
export function tooBig(size: number, max = ATTACH_MAX_BYTES): boolean {
  return size > max;
}

/**
 * Элемент галереи не уйдёт по размеру: оригиналом (видео, GIF, «без сжатия») — больше предела сервера. Фото со сжатием
 * уходит всегда: 2560 px в JPEG — заведомо меньше 25 МБ, каким бы ни был оригинал.
 */
export function overLimit(
  item: { kind: 'image' | 'video'; mime: string; size: number },
  compress: boolean,
  max = ATTACH_MAX_BYTES,
): boolean {
  const squeezed = compress && item.kind === 'image' && photoCompressible(item.mime);
  return !squeezed && tooBig(item.size, max);
}

/** Длительность на миниатюре видео и на записи: «0:07», «1:02», «1:02:03». Отрицательное и не число — «0:00». */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Мегабайты для подписи «больше 25 МБ»: целое, если ровно, иначе одна цифра после запятой. */
export function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(1).replace('.', ',');
}

/**
 * Что пишет запись видео камеры (`MediaRecorder`): первый тип, который понимает браузер. MP4 — раньше WebM: его играют
 * все (WebM из `MediaRecorder` без длительности в заголовке, перемотка у него хромает). Тип ФАЙЛА — без кодеков: сервер
 * принимает видео только с заявленным `video/mp4` или `video/webm` ровно (`attachmentRules.resolveAttachmentMime`), с
 * `;codecs=…` оно ушло бы безликими байтами.
 */
export const RECORDER_TYPES: readonly string[] = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export type RecorderPick = { mime: string; type: 'video/mp4' | 'video/webm'; ext: 'mp4' | 'webm' };

export function pickRecorderType(isSupported: (mime: string) => boolean): RecorderPick | null {
  for (const mime of RECORDER_TYPES) {
    let ok = false;
    try {
      ok = isSupported(mime);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    const mp4 = mime.startsWith('video/mp4');
    return { mime, type: mp4 ? 'video/mp4' : 'video/webm', ext: mp4 ? 'mp4' : 'webm' };
  }
  return null;
}

/** Тип файла без параметров: `video/mp4;codecs=avc1` → `video/mp4`. */
export function baseMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase();
}

/** Имя снимка и записи: `photo-2026-10-05-21-04-33.jpg` — так же именуются вставленные скриншоты (`onPasteFiles`). */
export function captureName(kind: 'photo' | 'video', at: Date, ext: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`;
  return `${kind}-${stamp}.${ext}`;
}

/** Удержание кнопки затвора дольше этого, мс, — запись видео, пока держишь; короче — снимок (как у Telegram). */
export const HOLD_TO_RECORD_MS = 300;

/** Запись останавливается сама, не дойдя до предела сервера: запас на хвост контейнера и последнюю порцию данных. */
export const VIDEO_SOFT_LIMIT = ATTACH_MAX_BYTES - 1024 * 1024;

export function recordingFull(bytes: number): boolean {
  return bytes >= VIDEO_SOFT_LIMIT;
}

/** Сколько элементов галереи просить за раз (сетка 3 колонки — 20 строк). */
export const GALLERY_PAGE = 60;

/** Миниатюра в пикселях устройства: ячейка × плотность экрана, в пределах 160…480 (больше — лишние байты по мосту). */
export function thumbPx(cellCss: number, dpr: number): number {
  const px = Math.round(Math.max(1, cellCss) * (Number.isFinite(dpr) && dpr > 0 ? dpr : 1));
  return Math.min(480, Math.max(160, px));
}

/** Состояние доступа к фото и видео (Android): всё, часть (выбор Android 14), можно спросить, запрещено «больше не спрашивать». */
export type GalleryPerm = 'granted' | 'partial' | 'ask' | 'blocked';

/** Плашка над сеткой по состоянию доступа: текст и кнопка (`ask` — спросить, `settings` — открыть настройки приложения). */
export function permNotice(perm: GalleryPerm): { text: string; button: string; action: 'ask' | 'settings' } | null {
  switch (perm) {
    case 'granted':
      return null;
    case 'partial':
      return { text: 'Открыт доступ к части фото и видео', button: 'Выбрать ещё', action: 'ask' };
    case 'ask':
      return { text: 'Чтобы показать фото и видео, нужен доступ к ним', button: 'Разрешить', action: 'ask' };
    case 'blocked':
      return { text: 'Доступ к фото и видео запрещён. Включите его в настройках приложения', button: 'Настройки', action: 'settings' };
  }
}

// ——— Сжатие фото «как в Telegram» ————————————————————————————————————————————————————————————————————————

/** Длинная сторона сжатого фото, px (Telegram — 2560). Те же числа у натива (`MediaBridge.PHOTO_MAX_SIDE`). */
export const PHOTO_MAX_SIDE = 2560;
/**
 * Обычное фото окна отправки файлов при «Высоком качестве» как выбор (`media2`, G48): Telegram Desktop `kStandardPhotoSideLimit`
 * = 1280 px у обычного, 2560 (`PHOTO_MAX_SIDE`) — у «Высокого качества» (`canUseHighQualityPhoto`: фото крупнее 1280 по стороне).
 */
export const PHOTO_STANDARD_SIDE = 1280;
/** Качество JPEG сжатого фото (у натива — 85 из 100). */
export const PHOTO_QUALITY = 0.85;

/** Какие картинки сжимаем: JPEG/PNG/WebP/BMP/HEIC/HEIF/AVIF. GIF (анимация), SVG и прочее — как есть. */
export function photoCompressible(mime: string): boolean {
  return /^image\/(jpeg|jpg|pjpeg|png|webp|bmp|heic|heif|avif)$/.test(baseMime(mime));
}

/** Вписать в квадрат `max`: меньше — как есть, больше — пропорционально, длинная сторона ровно `max`. */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  const longest = Math.max(w, h);
  if (!(longest > max)) return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  const k = max / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Имя сжатого: то же, расширение `.jpg` (`IMG_1.heic` → `IMG_1.jpg`, без расширения — дописываем). */
export function compressedName(name: string): string {
  const base = (name || 'photo').replace(/\.[a-z0-9]{1,5}$/i, '');
  return `${base || 'photo'}.jpg`;
}

// ——— Лист: заголовок выбора, признак сервера, недавние файлы ———————————————————————————————————————————————

/**
 * Заголовок листа при выборе (как у Telegram): «Выбрана 1 фотография», «Выбрано 3 фотографии», «Выбрано 5 видео»; фото и
 * видео вперемешку — «Выбрано 2 медиафайла».
 */
export function selectionTitle(photos: number, videos: number): string {
  const n = photos + videos;
  const form = (one: string, few: string, many: string) => {
    const a = n % 10;
    const b = n % 100;
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  };
  if (videos === 0) return `${form('Выбрана', 'Выбрано', 'Выбрано')} ${n} ${form('фотография', 'фотографии', 'фотографий')}`;
  if (photos === 0) return `Выбрано ${n} видео`;
  return `${form('Выбран', 'Выбрано', 'Выбрано')} ${n} ${form('медиафайл', 'медиафайла', 'медиафайлов')}`;
}

/**
 * Признак сервера «отложенные С ВЛОЖЕНИЯМИ» — `conv10` (06.10, `shared/ws.ts` `FEATURE_CONV10`). Без него сервер отложенные
 * принимает только текстом (400 на вложения), и пункты «Отправить позже» и «Когда будет в сети» в меню удержания листа —
 * серые. Правило одно на весь клиент — `convSyncRules.serverScheduledAttachments` (им же пользуется меню кнопки
 * «Отправить» поля ввода); здесь — то же правило под прежним именем листа.
 */
export const FEATURE_SCHEDULED_ATTACHMENTS = FEATURE_CONV10;

export { serverScheduledAttachments } from './convSyncRules';

/** Вложение из ленты для «Недавних файлов» — поля `Attachment`, которые нужны списку. */
export interface RecentSource {
  url: string;
  id?: string;
  name: string;
  contentType: string;
  size: number;
  waveform?: number[] | null;
}

export interface RecentFile<A extends RecentSource = RecentSource> {
  att: A;
  at: number;
}

/**
 * «Недавние файлы» вкладки «Файл»: вложения из бесед, что уже в памяти (отправленные и полученные), новые сверху, без
 * повторов и без голосовых. Повтор — тот же id или ссылка, а также то же имя с тем же размером (один файл, отправленный
 * дважды, — одна строка). Без ссылки (окно из кеша на диске, у закрытых файлов ссылок нет) — пропускаем: отправить такое
 * заново нечем.
 */
export function recentFilesOf<A extends RecentSource>(
  lists: Record<string, readonly { createdAt: string; attachments?: readonly A[] | null }[] | undefined>,
  limit = 20,
): RecentFile<A>[] {
  const all: RecentFile<A>[] = [];
  for (const list of Object.values(lists)) {
    for (const m of list ?? []) {
      const at = Date.parse(m.createdAt) || 0;
      for (const a of m.attachments ?? []) {
        if (!a?.url || (a.waveform && a.waveform.length)) continue;
        all.push({ att: a, at });
      }
    }
  }
  all.sort((x, y) => y.at - x.at);
  const seen = new Set<string>();
  const out: RecentFile<A>[] = [];
  if (limit <= 0) return out;
  for (const r of all) {
    // Повтор — по id ИЛИ по ссылке ИЛИ по «имя|размер»: id и ссылка — отдельные ключи (находка Codex 06.10).
    const keys = [r.att.id ? `id:${r.att.id}` : '', `url:${r.att.url}`, `${r.att.name}|${r.att.size}`].filter(Boolean);
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** Значок файла без миниатюры (как у Telegram): расширение до 4 букв и цвет по нему. */
export function fileBadge(name: string): { ext: string; tone: 'green' | 'honey' | 'red' | 'muted' } {
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? '').toLowerCase();
  const tone: 'green' | 'honey' | 'red' | 'muted' = /^(md|txt|doc|docx|odt|rtf|csv|xls|xlsx|ods)$/.test(ext)
    ? 'green'
    : /^(zip|rar|7z|tar|gz|conf|json|yaml|yml|ini|xml)$/.test(ext)
      ? 'honey'
      : /^(pdf|apk|exe|msi|ppt|pptx)$/.test(ext)
        ? 'red'
        : 'muted';
  return { ext: ext.slice(0, 4) || 'файл', tone };
}

/** Размер для строки файла: «429 Б», «17,2 КБ», «3,4 МБ» (запятая, как у Telegram на русском). */
export function fileSizeText(bytes: number): string {
  if (!(bytes > 0)) return '0 Б';
  if (bytes < 1024) return `${Math.round(bytes)} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

/** Тост про файлы, которые не ушли: «больше 25 МБ» и «не прочитать» — разными словами. */
export function skippedText(
  skipped: readonly { name: string; reason: 'too-big' | 'unreadable' }[],
  max = ATTACH_MAX_BYTES,
): string | null {
  if (skipped.length === 0) return null;
  const big = skipped.filter((s) => s.reason === 'too-big').map((s) => s.name);
  const bad = skipped.filter((s) => s.reason === 'unreadable').map((s) => s.name);
  const parts: string[] = [];
  if (big.length) parts.push(`Больше ${megabytes(max)} МБ — не отправить: ${big.join(', ')}`);
  if (bad.length) parts.push(`Не удалось прочитать: ${bad.join(', ')}`);
  return parts.join('. ');
}
