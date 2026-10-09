import { ATTACH_MAX, PHOTO_MAX_SIDE, PHOTO_STANDARD_SIDE } from './attachRules';

/**
 * Окно отправки файлов на ПК (07.10, #211, G48 + G37) — чистые правила. Источник — Telegram Desktop:
 * `boxes/send_files_box.cpp` (`refreshTitleText`, `setupSendWayControls`, `updateSendWayControls`: «Группировать» /
 * «Отправить как документы», «Запомнить выбор» только при отличии от прежнего выбора), `ui/chat/attach/attach_prepare.cpp`
 * (`hasGroupOption`, `hasSendImagesAsPhotosOption`, `PrepareFilesBundle`) и `history/history_drag_area.cpp` (две зоны броска:
 * «без сжатия» сверху, «быстро» снизу). Тексты — русские слова Telegram: «Группировать», «Отправить как файлы».
 */

export type SendKind = 'photo' | 'video' | 'file';

/** Вид файла для окна: картинка — «фото», видео — «видео», всё остальное (и голосовое/музыка) — «файл». */
export function sendKind(f: { type: string }): SendKind {
  if (f.type.startsWith('image/')) return 'photo';
  if (f.type.startsWith('video/')) return 'video';
  return 'file';
}

/** Выбор способа отправки: `group` — одним сообщением (альбомом), `asFile` — без сжатия, карточками файлов. */
export interface SendWay {
  group: boolean;
  asFile: boolean;
  /** «Высокое качество» (G48, `media2`): фото сжимаются до 2560 px, а не 1280. Нет поля — обычное; в хранилище пишется только `true`. */
  hd?: boolean;
}

export const DEFAULT_WAY: SendWay = { group: true, asFile: false };

/** Ключ запомненного выбора («Запомнить выбор»). */
export const SEND_WAY_KEY = 'gv_send_way';

/** Запомненный выбор из строки хранилища; порча или чужой вид — выбор по умолчанию. */
export function parseWay(raw: string | null): SendWay {
  if (!raw) return DEFAULT_WAY;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return {
        group: typeof o.group === 'boolean' ? o.group : DEFAULT_WAY.group,
        asFile: typeof o.asFile === 'boolean' ? o.asFile : DEFAULT_WAY.asFile,
        ...(o.hd === true ? { hd: true } : {}),
      };
    }
  } catch {
    /* порча — по умолчанию */
  }
  return DEFAULT_WAY;
}

/**
 * Заголовок окна (`refreshTitleText`): несколько файлов — «Выбрано изображений: N», если все картинки, иначе «Выбрано файлов:
 * N»; один — по виду: «Отправить изображение» / «Отправить видео» / «Отправить файл».
 */
export function boxTitle(files: readonly { type: string }[]): string {
  if (files.length > 1) {
    const photos = files.filter((f) => sendKind(f) === 'photo').length;
    return photos === files.length ? `Выбрано изображений: ${files.length}` : `Выбрано файлов: ${files.length}`;
  }
  const kind = files[0] ? sendKind(files[0]) : 'file';
  return kind === 'photo' ? 'Отправить изображение' : kind === 'video' ? 'Отправить видео' : 'Отправить файл';
}

/**
 * «Группировать» есть, когда в списке рядом лежат два файла одного вида (`PreparedList::hasGroupOption`): подряд одинаковые,
 * видео с фото, файл с фото. Один файл — группировать нечего.
 */
export function hasGroupOption(files: readonly { type: string }[]): boolean {
  if (files.length < 2) return false;
  let last: SendKind | null = null;
  for (const f of files) {
    const k = sendKind(f);
    if (last !== null) {
      const media = (x: SendKind) => x === 'photo' || x === 'video';
      if (k === last || (media(k) && media(last)) || (k === 'file' && last === 'photo') || (k === 'photo' && last === 'file')) {
        return true;
      }
    }
    last = k;
  }
  return false;
}

/** «Отправить как файлы» есть, пока среди файлов есть картинка или видео (`hasSendImagesAsPhotosOption`). */
export function hasAsFileOption(files: readonly { type: string }[]): boolean {
  return files.some((f) => sendKind(f) !== 'file');
}

/** «Запомнить выбор» виден, когда выбор отличается от того, с которого окно открылось (`_wayRemember`). */
export function rememberVisible(first: SendWay, now: SendWay): boolean {
  return first.group !== now.group || first.asFile !== now.asFile || !!first.hd !== !!now.hd;
}

/**
 * «Высокое качество» есть, пока выбор идёт со сжатием и хоть одно фото крупнее обычного предела по стороне
 * (`PreparedList::hasSendLargePhotosOption` + `PreparedFile::canUseHighQualityPhoto`). `dims` — размеры фото окна по порядку
 * (`null` — ещё не узнали или не картинка).
 */
export function hdOptionVisible(dims: readonly ({ w: number; h: number } | null)[], way: SendWay): boolean {
  if (way.asFile) return false;
  return dims.some((d) => !!d && Math.max(d.w, d.h) > PHOTO_STANDARD_SIDE);
}

/** Длинная сторона сжатого фото окна: «Высокое качество» — 2560, иначе 1280 (Telegram Desktop). Сервер без `media2` — как прежде, 2560. */
export function photoSideFor(way: SendWay, media2: boolean): number {
  if (!media2) return PHOTO_MAX_SIDE;
  return way.hd === true ? PHOTO_MAX_SIDE : PHOTO_STANDARD_SIDE;
}

/**
 * Спойлер есть, когда всё выбранное — фото и видео и они уходят кадрами, а не файлами (`PreparedList::hasSpoilerMenu`: все
 * файлы — медиа и есть сжатие).
 */
export function spoilerMenuVisible(files: readonly { type: string }[], way: SendWay): boolean {
  return files.length > 0 && !way.asFile && files.every((f) => sendKind(f) !== 'file');
}

/** «Подпись над медиа» есть там же, где виден кадр: подпись рисуется над фото или альбомом (`Type::CaptionUp`). */
export function captionMoveVisible(files: readonly { type: string }[], way: SendWay): boolean {
  return files.length > 0 && !way.asFile && files.some((f) => sendKind(f) !== 'file');
}

/**
 * Спойлеры отправки в индексах файлов списка: только у фото и видео и только пока они кадры (не «как файлы»); индексы вне
 * списка и у обычных файлов отбрасываются. Порядок по возрастанию.
 */
export function spoilerIndexes(files: readonly { type: string }[], marked: ReadonlySet<number>, way: SendWay): number[] {
  if (way.asFile) return [];
  return [...marked].filter((i) => i >= 0 && i < files.length && sendKind(files[i]!) !== 'file').sort((a, b) => a - b);
}

/** Одно сообщение плана отправки: файлы и подпись. */
export interface SendPlanItem {
  files: File[];
  content: string;
}

/**
 * Как разложить выбранное по сообщениям (`PrepareFilesBundle`): с «Группировать» картинки и видео уходят одним сообщением
 * (альбом), остальные файлы — другим (медиа первым); «как файлы» — все вместе, они и так карточки; без группировки — по
 * сообщению на файл. Подпись — у первого сообщения. В сообщении не больше `ATTACH_MAX` файлов — лишнее переходит в следующее.
 */
export function planSend(files: readonly File[], caption: string, way: SendWay): SendPlanItem[] {
  const group = way.group && hasGroupOption(files);
  let batches: File[][];
  if (!group) batches = files.map((f) => [f]);
  else if (way.asFile) batches = [[...files]];
  else {
    const media = files.filter((f) => sendKind(f) !== 'file');
    const rest = files.filter((f) => sendKind(f) === 'file');
    batches = [media, rest].filter((b) => b.length > 0);
  }
  const out: File[][] = [];
  for (const b of batches) for (let i = 0; i < b.length; i += ATTACH_MAX) out.push(b.slice(i, i + ATTACH_MAX));
  return out.map((b, i) => ({ files: b, content: i === 0 ? caption : '' }));
}

/** Переставить файл с места `from` на место `to` (перетаскивание строк окна); вне списка — список как был. */
export function moveFile<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const out = [...list];
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it!);
  return out;
}

/** Что показывать при броске (`history_drag_area.cpp`, `DragState`): картинки — две зоны; видео с файлами — две; файлы — одна. */
export type DropKind = 'images' | 'media' | 'files';

/** Вид броска по типам перетаскиваемого (в `dragenter` видны только типы, не содержимое). */
export function dropKind(types: readonly string[]): DropKind {
  if (types.length === 0) return 'files';
  const kinds = types.map((t) => sendKind({ type: t }));
  if (kinds.every((k) => k === 'photo')) return 'images';
  if (kinds.some((k) => k !== 'file')) return 'media';
  return 'files';
}

export type DropZone = 'top' | 'bottom';

export interface DropText {
  title: string;
  hint: string;
}

/**
 * Тексты зон (`lang.strings`: `lng_drag_images_here` + `lng_drag_to_send_no_compression`, `lng_drag_photos_here` +
 * `lng_drag_to_send_quick`, `lng_drag_files_here` + `lng_drag_to_send_files`, `lng_drag_media_here` +
 * `lng_drag_to_send_media`). Верхняя зона — без сжатия / как документы, нижняя — быстро / как медиа; у файлов зона одна.
 */
export function dropTexts(kind: DropKind): { top: DropText; bottom: DropText | null } {
  if (kind === 'images') {
    return {
      top: { title: 'Отпустите изображения', hint: 'чтобы отправить их без сжатия' },
      bottom: { title: 'Отпустите фото', hint: 'чтобы отправить их быстро' },
    };
  }
  if (kind === 'media') {
    return {
      top: { title: 'Отпустите файлы', hint: 'чтобы отправить их как документы' },
      bottom: { title: 'Отпустите фото и видео', hint: 'чтобы отправить их как медиафайлы' },
    };
  }
  return { top: { title: 'Отпустите файлы', hint: 'чтобы отправить их как документы' }, bottom: null };
}

/** Зона по высоте указателя: верхняя половина — верхняя зона. Зона одна — всегда верхняя. */
export function zoneAt(y: number, top: number, height: number, two: boolean): DropZone {
  if (!two || height <= 0) return 'top';
  return y - top < height / 2 ? 'top' : 'bottom';
}

/** Способ отправки для зоны: верхняя — без сжатия (как файлы), нижняя — быстро (сжатые, альбомом). */
export function wayForZone(zone: DropZone): Partial<SendWay> {
  return zone === 'top' ? { asFile: true } : { asFile: false };
}

/**
 * Подпись после вставки картинки с текстом (`history_widget.cpp`, вставка из буфера): текст из буфера становится подписью;
 * в поле уже что-то было — подпись продолжает его через пробел.
 */
export function captionAfterPaste(current: string, pasted: string): string {
  const add = pasted.trim();
  if (!add) return current;
  return current.trim() ? `${current.trimEnd()} ${add}` : add;
}
