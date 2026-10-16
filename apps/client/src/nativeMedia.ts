import { ATTACH_MAX, ATTACH_MAX_BYTES, baseMime, type GalleryPerm } from './attachRules';

/**
 * Мост к медиа Android-оболочки (05.10, вложения «как в Telegram»): своя галерея, системное приложение «Файлы», «Сохранить»
 * и «Копировать изображение» для меню фото. Натив — `MediaBridge.kt`.
 *
 * **Канал — объект `window.GusVoiceMedia`.** Его вставляет только оболочка Android (`WebViewCompat.addWebMessageListener`,
 * происхождение `http(s)://tauri.localhost`) и только там, где WebView умеет сообщения с `ArrayBuffer`
 * (`WEB_MESSAGE_ARRAY_BUFFER`). Нет объекта — нет натива: браузер, ПК, старая сборка APK, старый WebView; зовущий тогда идёт
 * системным выбором файла.
 *
 * **Байты — сообщениями `ArrayBuffer`, без base64.** Миниатюры и оригиналы идут сюда частями по 512 КБ, файлы для
 * «Сохранить» / «Копировать» — туда так же. Путь через протокол ассетов Tauri (`convertFileSrc`) отвергнут: он требует
 * фичу `protocol-asset` у крейта `tauri` и область в `tauri.conf.json` — то есть правку сборки и ПК, и телефона ради одного
 * Android, а без Range-запроса читает файл в память целиком.
 *
 * Протокол (строки — JSON):
 * - `→ {op, id, …}` — запрос; `← {id, …}` — ответ или событие запроса;
 * - `← {id, bin: {…}}` и СРАЗУ за ним `ArrayBuffer` — двоичная часть (натив шлёт пару одним заходом главного потока, поэтому
 *   между заголовком и байтами чужое сообщение не встанет);
 * - файлы: `← {id, file: i, name, mime, size}` → части `{id, bin: {file: i}}` + байты → `{id, file: i, end: true}` или
 *   `{id, file: i, skip: 'too-big' | 'unreadable'}`; в конце `{id, done: true}`;
 * - туда: `→ {op: 'put', id, name, mime, then}` → `ArrayBuffer`-части → `→ {op: 'putEnd', id}` → `← {id, ok}`. Части не
 *   несут id, поэтому отправки «туда» идут строго по одной (`putChain`). `then`: `save` (галерея), `copy` (буфер обмена),
 *   с 06.10 — `open` (копия в кеше приложения + системное приложение по типу; ответ `{token}` или `error: 'no-app'`) и
 *   `download` («Загрузки», Download/GusVoice, Android 10+; ниже — `error: 'unsupported'`);
 * - `→ {op: 'reopen', id, token, mime}` → `← {id, ok}` / `error: 'missing' | 'no-app'` — открыть уже скачанное (06.10);
 * - альбомы (10.10, #218): `→ {op: 'albums'}` → `← {id, ok, albums: [{id, name, count, only?, cover}]}`; у сборки старше —
 *   `error: 'unknown-op'`, и списка альбомов нет. `page` понимает `bucket` (id папки) и `only: 'video'`; старая сборка их не
 *   читает и отдаёт всю галерею — поэтому клиент шлёт их, только получив альбомы;
 * - `open` с `view: true` (10.10) — оригинал для просмотра выбора в своей очереди натива, отправку он не задерживает;
 * - «Поделиться в GusVoice» (09.10): `→ {op: 'shared'}` → `← {id, ok, share: {token, text, subject, dropped, files} | null}`;
 *   `→ {op: 'sharedOpen', token}` → поток файлов, как у `docs`; `→ {op: 'sharedDrop', token}` → `← {id, ok}`.
 */

/** Объект, который вставляет `addWebMessageListener`: `postMessage` строки или `ArrayBuffer`, ответы — в `onmessage`. */
interface MediaChannel {
  postMessage(message: string | ArrayBuffer): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

type Msg = { id: string; ok?: boolean; error?: string; done?: boolean; bin?: Record<string, unknown> } & Record<string, unknown>;

interface Waiter {
  onMsg(m: Msg): void;
  onBin?(head: Msg, buf: ArrayBuffer): void;
}

function channel(): MediaChannel | null {
  if (typeof window === 'undefined') return null;
  const ch = (window as unknown as { GusVoiceMedia?: MediaChannel }).GusVoiceMedia;
  return ch && typeof ch.postMessage === 'function' ? ch : null;
}

/** Есть ли натив медиа (приложение Android с поддерживающим WebView). Вне приложения — всегда `false`. */
export function nativeMediaAvailable(): boolean {
  return channel() !== null;
}

const waiters = new Map<string, Waiter>();
let wiredTo: MediaChannel | null = null;
let binHead: Msg | null = null;
let seq = 0;

function wire(ch: MediaChannel): void {
  if (wiredTo === ch) return;
  wiredTo = ch;
  ch.onmessage = (ev: MessageEvent) => {
    const d: unknown = ev.data;
    if (typeof d === 'string') {
      let m: Msg;
      try {
        m = JSON.parse(d) as Msg;
      } catch {
        return;
      }
      if (!m || typeof m.id !== 'string') return;
      if (m.bin) {
        binHead = m;
        return;
      }
      waiters.get(m.id)?.onMsg(m);
      return;
    }
    if (d instanceof ArrayBuffer) {
      const head = binHead;
      binHead = null;
      if (head) waiters.get(head.id)?.onBin?.(head, d);
    }
  };
}

function start(op: string, args: Record<string, unknown>, waiter: Waiter): string {
  const ch = channel();
  if (!ch) throw new Error('native media unavailable');
  wire(ch);
  const id = `gm${++seq}`;
  waiters.set(id, waiter);
  ch.postMessage(JSON.stringify({ ...args, op, id }));
  return id;
}

/** Запрос с одним ответом. `timeoutMs` — для запросов без окна системы (окна разрешений и выбора ждут человека сколько угодно). */
function call(op: string, args: Record<string, unknown> = {}, timeoutMs = 0): Promise<Msg> {
  return new Promise<Msg>((resolve, reject) => {
    let timer = 0;
    let id = '';
    try {
      id = start(op, args, {
        onMsg(m) {
          waiters.delete(m.id);
          if (timer) window.clearTimeout(timer);
          resolve(m);
        },
      });
    } catch (e) {
      reject(e);
      return;
    }
    if (timeoutMs > 0) {
      timer = window.setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`native media: ${op} timed out`));
      }, timeoutMs);
    }
  });
}

// ——— Галерея ————————————————————————————————————————————————————————————————————————————————————————————————

export type { GalleryPerm };

/** Элемент галереи устройства (строка MediaStore). `added` — секунды, порядок и курсор подгрузки — `(added, id)` по убыванию. */
export interface GalleryItem {
  id: string;
  kind: 'image' | 'video';
  mime: string;
  size: number;
  width: number;
  height: number;
  /** Длительность видео, мс (у фото 0). */
  durationMs: number;
  added: number;
  name: string;
  /** Поворот по EXIF у фото (0/90/180/270): нужен только старым Android, где миниатюра его не учитывает. */
  rot: number;
}

export interface NativeMediaInfo {
  sdk: number;
  perm: GalleryPerm;
  /** Разрешение камеры у приложения уже есть — живую картинку в ячейке можно включать сразу, без окна системы. */
  camera: boolean;
  /**
   * Разрешение микрофона у приложения есть. Нет — видео с камеры листа пишется без звука и окна не просит: окно системы
   * «скрывает» страницу, и поток камеры гаснет посреди записи. Нет такого поля в ответе (старый натив) — считаем, что есть.
   */
  mic: boolean;
  /** «Сохранить в галерею» — Android 10+ (MediaStore без разрешения на запись). */
  canSave: boolean;
  /** Окно разрешения уже показывали: сами его больше не зовём — плашка с кнопкой «Разрешить». */
  asked: boolean;
  /** «Поделиться» файлом (`then: share`, 07.10). Нет поля (сборка старше) — нет и пункта. */
  canShare: boolean;
  /** «Поделиться в GusVoice» (09.10, G79): сборка принимает ACTION_SEND (`shared` / `sharedOpen` / `sharedDrop`). */
  canInbox: boolean;
  /**
   * Системная камера (10.10, #218): сборка отвечает на `capture` — ячейка камеры листа открывает камеру устройства (тап —
   * фото, удержание — видео). Нет поля (сборка старше) — своя камера листа (`CameraScreen`, getUserMedia).
   */
  capture: boolean;
}

/**
 * Состояние доступа из ответа моста. `partial` (READ_MEDIA_VISUAL_USER_SELECTED) с 10.10 мост не шлёт — разрешение не
 * объявлено, как у Telegram Android (#218); пришло всё же — это тоже «можно читать»: MediaStore отдаёт видимое приложению.
 */
function asPerm(v: unknown): GalleryPerm {
  return v === 'granted' || v === 'partial' ? 'granted' : v === 'blocked' ? 'blocked' : 'ask';
}

export async function nativeMediaInfo(): Promise<NativeMediaInfo> {
  const m = await call('info', {}, 8000);
  return {
    sdk: Number(m.sdk) || 0,
    perm: asPerm(m.perm),
    camera: m.camera === true,
    mic: m.mic !== false,
    canSave: m.canSave === true,
    asked: m.asked === true,
    canShare: m.canShare === true,
    canInbox: m.canInbox === true,
    capture: m.capture === true,
  };
}

/**
 * Доступ к фото и видео: `check` — узнать; `ask` — спросить окном системы; `settings` — открыть настройки приложения (после «больше не спрашивать»), ответ — состояние сразу,
 * вернувшись, зовущий проверяет заново.
 */
/**
 * Разрешение камеры окном системы (кнопка «Разрешить доступ к камере» листа, как Telegram `VIEW_TYPE_CAMERA_PERMISSION_BUTTON`):
 * `granted` / `denied` / `null` — сборка старше операции `camPerm` не знает (зовущий открывает камеру — она спросит сама).
 */
export async function cameraPermissionNative(): Promise<'granted' | 'denied' | null> {
  const m = await call('camPerm', {});
  if (m.ok === false) return m.error === 'unknown-op' ? null : 'denied';
  return m.camera === true ? 'granted' : 'denied';
}

export async function galleryPermission(mode: 'check' | 'ask' | 'settings'): Promise<GalleryPerm> {
  const m = await call('perm', { ask: mode === 'check' ? '' : mode }, mode === 'ask' ? 0 : 8000);
  return asPerm(m.perm);
}

/**
 * Альбом галереи (как Telegram Android `MediaController.AlbumEntry`): `id` — BUCKET_ID папки, `''` — вся галерея («Все медиа»
 * и, с `only: 'video'`, «Все видео»). `cover` — самый новый элемент (для миниатюры хватает id, вида и поворота).
 */
export interface GalleryAlbum {
  id: string;
  name: string;
  count: number;
  only: 'video' | null;
  cover: GalleryItem | null;
}

/** Альбомы галереи (`MediaBridge.albums`): у сборки без операции или при ошибке — `null`, и выбора альбома нет. */
export async function galleryAlbums(): Promise<GalleryAlbum[] | null> {
  let m: Msg;
  try {
    m = await call('albums', {}, 20000);
  } catch {
    return null;
  }
  if (m.ok === false || !Array.isArray(m.albums)) return null;
  return (m.albums as Record<string, unknown>[]).map((r): GalleryAlbum => {
    const c = r.cover && typeof r.cover === 'object' ? (r.cover as Record<string, unknown>) : null;
    const cid = c ? String(c.id ?? '') : '';
    return {
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      count: Number(r.count) || 0,
      only: r.only === 'video' ? 'video' : null,
      cover: cid
        ? { id: cid, kind: c?.kind === 'video' ? 'video' : 'image', mime: '', size: 0, width: 0, height: 0, durationMs: 0, added: 0, name: '', rot: Number(c?.rot) || 0 }
        : null,
    };
  });
}

/**
 * Порция галереи, новые сверху. `before` — последний элемент прошлой порции (курсор), без него — с начала. `album` — только
 * его элементы (папка или «Все видео»); без него и для «Все медиа» — вся галерея.
 */
export async function galleryPage(
  before: GalleryItem | null,
  limit: number,
  album: GalleryAlbum | null = null,
): Promise<{ items: GalleryItem[]; end: boolean }> {
  const filter: Record<string, unknown> = {};
  if (album?.id) filter.bucket = album.id;
  if (album?.only) filter.only = album.only;
  const m = await call('page', { limit, before: before ? { added: before.added, id: before.id } : null, ...filter }, 20000);
  if (m.ok === false) throw new Error(`native media: page ${m.error ?? ''}`);
  const raw = Array.isArray(m.items) ? (m.items as Record<string, unknown>[]) : [];
  const items = raw.map(
    (r): GalleryItem => ({
      id: String(r.id ?? ''),
      kind: r.kind === 'video' ? 'video' : 'image',
      mime: String(r.mime ?? ''),
      size: Number(r.size) || 0,
      width: Number(r.w) || 0,
      height: Number(r.h) || 0,
      durationMs: Number(r.dur) || 0,
      added: Number(r.added) || 0,
      name: String(r.name ?? ''),
      rot: Number(r.rot) || 0,
    }),
  );
  return { items: items.filter((i) => i.id), end: m.end === true };
}

/** Миниатюра элемента — ссылка `blob:` на JPEG (снимать — `URL.revokeObjectURL` зовущего) или `null`, если её нет. */
export function galleryThumb(item: GalleryItem, px: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let timer = 0;
    let id = '';
    const finish = (url: string | null) => {
      waiters.delete(id);
      if (timer) window.clearTimeout(timer);
      resolve(url);
    };
    try {
      id = start('thumb', { mid: item.id, kind: item.kind, px, rot: item.rot }, {
        onMsg: () => finish(null),
        onBin: (_head, buf) => finish(URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }))),
      });
    } catch {
      resolve(null);
      return;
    }
    timer = window.setTimeout(() => finish(null), 20000);
  });
}

export interface NativeFilesResult {
  files: File[];
  skipped: { name: string; reason: 'too-big' | 'unreadable' }[];
  /** Окно выбора закрыли, ничего не выбрав (только `pickDocumentsNative`). */
  cancelled: boolean;
  /** Сколько выбранного не влезло в предел вложений (только `pickDocumentsNative`). */
  dropped: number;
  /** Номер элемента запроса у каждого файла `files` (тот же порядок): пропущенные (`skipped`) номера не получают. */
  indexes: number[];
}

export type FilesProgress = (doneFiles: number, totalFiles: number) => void;

/** id идущих потоков файлов — их и только их останавливает `cancelNativeFiles`. */
const streams = new Set<string>();

/** Принять поток файлов запроса (`open`, `docs`) в `File`-ы. */
/**
 * Каждые столько байт принятые части файла склеиваются в `Blob`, а массив частей отпускается. Предел файла ЛС — 1 ГиБ
 * (`4c67b515`: `MediaBridge.SHARE_MAX` 1 ГиБ, `PUT_MAX` 1032 МБ): копить весь файл частями `ArrayBuffer` в куче JS, а потом
 * `new File(части)` — пик около двух размеров файла (части + копия в `File`), 2 ГиБ роняют WebView телефона. Со склейкой в
 * куче живёт не больше одной порции: прежний `Blob` уже у хранилища блобов браузера, `new Blob([прежний, ...части])` его
 * не копирует в кучу.
 */
export const RECEIVE_FOLD_BYTES = 32 * 1024 * 1024;

/** Принимаемый файл: склеенное (`blob`) + части после последней склейки (`chunks`, `pending` байт). */
interface PartIn {
  name: string;
  mime: string;
  blob: Blob | null;
  chunks: ArrayBuffer[];
  pending: number;
}

/** Склеить накопленные части в `Blob` и отпустить их (`RECEIVE_FOLD_BYTES`). */
function foldPart(p: PartIn): void {
  if (!p.chunks.length) return;
  p.blob = new Blob(p.blob ? [p.blob, ...p.chunks] : p.chunks);
  p.chunks = [];
  p.pending = 0;
}

function receiveFiles(
  op: string,
  args: Record<string, unknown>,
  total: number,
  onProgress?: FilesProgress,
  onStart?: (sid: string) => void,
  onBytes?: (bytes: number) => void,
): Promise<NativeFilesResult> {
  return new Promise<NativeFilesResult>((resolve, reject) => {
    const files: File[] = [];
    const indexes: number[] = [];
    let bytes = 0;
    const skipped: NativeFilesResult['skipped'] = [];
    const parts = new Map<number, PartIn>();
    let finished = 0;
    let all = total;
    try {
      const sid = start(op, args, {
        onMsg(m) {
          if (m.ok === false && m.done !== true && typeof m.file !== 'number') {
            waiters.delete(m.id);
            reject(new Error(`native media: ${op} ${m.error ?? ''}`));
            return;
          }
          if (typeof m.total === 'number') all = m.total;
          if (typeof m.file === 'number') {
            const i = m.file;
            if (typeof m.name === 'string' && m.end !== true && m.skip === undefined) {
              parts.set(i, { name: m.name, mime: baseMime(String(m.mime ?? '')) || 'application/octet-stream', blob: null, chunks: [], pending: 0 });
              return;
            }
            const p = parts.get(i);
            parts.delete(i);
            if (m.end === true && p) {
              files.push(new File(p.blob ? [p.blob, ...p.chunks] : p.chunks, p.name, { type: p.mime }));
              indexes.push(i);
            }
            else skipped.push({ name: String(m.name ?? p?.name ?? 'файл'), reason: m.skip === 'too-big' ? 'too-big' : 'unreadable' });
            finished++;
            onProgress?.(finished, all);
            return;
          }
          if (m.done === true) {
            waiters.delete(m.id);
            streams.delete(m.id);
            resolve({ files, skipped, cancelled: m.cancelled === true, dropped: Number(m.dropped) || 0, indexes });
          }
        },
        onBin(head, buf) {
          const i = Number(head.bin?.file);
          const p = parts.get(i);
          if (!p) return;
          p.chunks.push(buf);
          p.pending += buf.byteLength;
          bytes += buf.byteLength;
          onBytes?.(bytes);
          if (p.pending >= RECEIVE_FOLD_BYTES) foldPart(p);
        },
      });
      streams.add(sid);
      onStart?.(sid);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Оригиналы выбранного в галерее → `File`-ы (тем же путём, что файлы из окна выбора — `addFiles`). `compress` — фото «как в
 * Telegram»: длинная сторона до 2560 px, JPEG 85, поворот по EXIF применён, метаданные (и GPS) не переносятся; GIF и видео —
 * как есть. Без сжатия — оригиналы байт в байт («Файл → Галерея»).
 */
export function galleryFiles(
  items: readonly GalleryItem[],
  opts: { compress: boolean; maxBytes?: number; onProgress?: FilesProgress },
): Promise<NativeFilesResult> {
  const list = items.map((i) => ({ id: i.id, kind: i.kind, name: i.name, mime: i.mime }));
  return receiveFiles('open', { items: list, compress: opts.compress, max: opts.maxBytes ?? ATTACH_MAX_BYTES }, list.length, opts.onProgress);
}

/**
 * Один элемент галереи крупно — для просмотра выбора (как Telegram `PhotoViewer`: фото во весь экран, видео играет). Фото —
 * тем же сжатием, что уходит при отправке (2560 px, JPEG 85, поворот по EXIF; HEIC так тоже показывается), GIF и видео —
 * оригинал. Байты — уже существующим потоком `open` (в своей очереди натива, `view: true`): страница с `http://tauri.localhost`
 * `content://` грузить не может, а перехват запросов WebView занят Tauri. `cancel` — остановить (пролистали дальше).
 */
export function galleryOriginal(
  item: GalleryItem,
  maxBytes = ATTACH_MAX_BYTES,
  onBytes?: (bytes: number) => void,
): { done: Promise<File | null>; cancel: () => void } {
  let sid = '';
  let stop = false;
  const cancel = () => {
    stop = true;
    const ch = channel();
    if (sid && ch && streams.has(sid)) ch.postMessage(JSON.stringify({ op: 'cancel', id: `${sid}-c`, target: sid }));
  };
  const list = [{ id: item.id, kind: item.kind, name: item.name, mime: item.mime }];
  const done = receiveFiles(
    'open',
    { items: list, compress: item.kind === 'image', max: maxBytes, view: true },
    1,
    undefined,
    (id) => {
      sid = id;
      if (stop) cancel();
    },
    onBytes,
  ).then(
    (r) => (stop ? null : (r.files[0] ?? null)),
    () => null,
  );
  return { done, cancel };
}

/**
 * Системная камера (10.10, #218; `NativeMediaInfo.capture`): `video` ложно — снимок (ACTION_IMAGE_CAPTURE), истинно — видео
 * (ACTION_VIDEO_CAPTURE, камера останавливает запись на `maxBytes`). Файл приходит тем же потоком, что «Файлы»: фото уже сжато
 * «как в Telegram» (2560 px, JPEG 85), видео — как есть. Закрыли камеру без снимка — `cancelled` и ни одного файла. Нет
 * разрешения камеры и человек отказал в окне — ошибка, `captureErrorCode` даёт `camera-denied`.
 */
export function captureNative(opts: { video: boolean; maxBytes?: number }): Promise<NativeFilesResult> {
  return receiveFiles('capture', { video: opts.video, max: opts.maxBytes ?? ATTACH_MAX_BYTES }, 1);
}

/** Код ошибки `captureNative` (`native media: capture <код>`): отказ в камере, камеры нет, уже открыта, прочее. */
export function captureErrorCode(e: unknown): 'camera-denied' | 'no-camera' | 'busy' | 'failed' {
  const m = /^native media: capture (\S+)/.exec(e instanceof Error ? e.message : '');
  const code = m?.[1];
  return code === 'camera-denied' || code === 'no-camera' || code === 'busy' ? code : 'failed';
}

/** Системное приложение «Файлы» (ACTION_OPEN_DOCUMENT, несколько). Закрыли без выбора — `cancelled`. */
export function pickDocumentsNative(opts: { limit?: number; maxBytes?: number; onProgress?: FilesProgress } = {}): Promise<NativeFilesResult> {
  return receiveFiles('docs', { limit: opts.limit ?? ATTACH_MAX, max: opts.maxBytes ?? ATTACH_MAX_BYTES }, 0, opts.onProgress);
}

// ——— «Поделиться в GusVoice» (09.10, G79) ——————————————————————————————————————————————————————————————————————

/**
 * Что пришло из чужого приложения (`MediaBridge.onShareIntent`, копии уже в кеше приложения) — сырой ответ `shared`, разбор —
 * `shareRules.parseIncomingShare`. Нет натива, старая сборка (ответ `unknown-op`) или ничего не ждёт — `null`.
 */
export async function sharedPeekNative(): Promise<unknown> {
  if (!nativeMediaAvailable()) return null;
  try {
    const m = await call('shared', {}, 8000);
    return m.ok === true ? (m.share ?? null) : null;
  } catch {
    return null;
  }
}

/** Байты пришедшего → `File`-ы (тот же поток, что у «Файлов»). Метка устарела (пришло новое) — ошибка `missing`. */
export function sharedFilesNative(token: string, onProgress?: FilesProgress): Promise<NativeFilesResult> {
  return receiveFiles('sharedOpen', { token }, 0, onProgress);
}

/** Забыть пришедшее: копии в кеше стираются. Чужая метка — ничего. Ошибки молча (натива нет — и забывать нечего). */
export async function sharedDropNative(token: string): Promise<void> {
  if (!nativeMediaAvailable()) return;
  try {
    await call('sharedDrop', { token }, 8000);
  } catch {
    /* старый натив / окно закрылось */
  }
}

// ——— Меню фото: «Сохранить» и «Копировать изображение» ———————————————————————————————————————————————————————

/** Версия Android из строки агента (`Android 14`); не Android — 0. Сокращённая строка Chrome пишет «10» — это нижняя граница. */
function androidMajor(): number {
  const m = /Android (\d+)/.exec(typeof navigator === 'undefined' ? '' : navigator.userAgent || '');
  return m ? Number(m[1]) : 0;
}

/** «Сохранить в галерею» через натив: приложение Android 10+ (Pictures/GusVoice). Нет — зовущий оставляет обычное скачивание. */
export function canSaveImageNative(): boolean {
  return nativeMediaAvailable() && androidMajor() >= 10;
}

/** «Копировать изображение» через натив (буфер обмена Android, ссылка FileProvider): любое приложение с мостом. */
export function canCopyImageNative(): boolean {
  return nativeMediaAvailable();
}

const PUT_CHUNK = 256 * 1024;
let putChain: Promise<unknown> = Promise.resolve();

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

function mimeOf(blob: Blob, name: string): string {
  const t = baseMime(blob.type || '');
  if (t && t !== 'application/octet-stream') return t;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? 'image/jpeg';
}

/**
 * Байты картинки: `Blob` — как есть; строка — `fetch`. ⚠️ Ссылка должна отдаваться приложению с CORS: адрес API
 * (`/api/att/…` закрытых файлов ЛС, `api.attachmentDownloadUrl(a)` для публичных) или `blob:`. Прямая ссылка хранилища
 * (публичный бакет MinIO / versitygw) CORS не отдаёт — `fetch` упадёт.
 */
async function bytesOf(src: string | Blob): Promise<Blob> {
  if (typeof src !== 'string') return src;
  const res = await fetch(src, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/** `mime` — тип, если он известен лучше байтов (файл ленты: выдача публичных отдаёт `application/octet-stream`). */
function putToNative(blob: Blob, name: string, then: 'save' | 'copy' | 'open' | 'download' | 'share', mime?: string): Promise<Msg> {
  const run = async (): Promise<Msg> => {
    const ch = channel();
    if (!ch) throw new Error('native media unavailable');
    wire(ch);
    const id = `gm${++seq}`;
    const done = new Promise<Msg>((resolve) => {
      waiters.set(id, {
        onMsg(m) {
          waiters.delete(m.id);
          resolve(m);
        },
      });
    });
    ch.postMessage(JSON.stringify({ op: 'put', id, name, mime: mime || mimeOf(blob, name), size: blob.size, then }));
    for (let at = 0; at < blob.size; at += PUT_CHUNK) {
      ch.postMessage(await blob.slice(at, Math.min(blob.size, at + PUT_CHUNK)).arrayBuffer());
    }
    ch.postMessage(JSON.stringify({ op: 'putEnd', id }));
    return done;
  };
  const next = putChain.then(run, run);
  putChain = next.catch(() => undefined);
  return next;
}

/** Имя файла для галереи и буфера: без пути, с расширением по типу (иначе MediaStore допишет своё). */
function fileNameFor(name: string, mime: string): string {
  const clean = (name || 'image').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120) || 'image';
  if (/\.[a-z0-9]{2,5}$/i.test(clean)) return clean;
  const ext = Object.entries(EXT_MIME).find(([, m]) => m === mime)?.[0] ?? 'jpg';
  return `${clean}.${ext}`;
}

/**
 * «Сохранить» из меню фото (Android): в галерею, папка Pictures/GusVoice (видео — Movies/GusVoice). Бросает при отказе —
 * зовущий показывает ошибку; успех — тост «Сохранено в галерею» на нём же.
 */
export async function saveImageNative(src: string | Blob, name: string): Promise<{ uri: string }> {
  const blob = await bytesOf(src);
  const m = await putToNative(blob, fileNameFor(name, mimeOf(blob, name)), 'save');
  if (m.ok !== true) throw new Error(`native media: save ${m.error ?? ''}`);
  return { uri: String(m.uri ?? '') };
}

/**
 * «Копировать изображение» из меню фото (Android): картинка в буфер обмена (ссылка FileProvider на копию в кеше
 * приложения). `systemNotice` — Android 13+ сам показывает плашку «Скопировано»; свой тост тогда лишний.
 */
export async function copyImageNative(src: string | Blob, name = 'image'): Promise<{ systemNotice: boolean }> {
  const blob = await bytesOf(src);
  const m = await putToNative(blob, fileNameFor(name, mimeOf(blob, name)), 'copy');
  if (m.ok !== true) throw new Error(`native media: copy ${m.error ?? ''}`);
  return { systemNotice: m.systemNotice === true };
}

// ——— Файлы из ленты: «открыть» и «Скачать» (06.10) ————————————————————————————————————————————————————————————

/**
 * Отказ натива по файлу: `code` — что сказал натив (`no-app` — нечем открыть, `unsupported` — «Загрузки» ниже Android 10,
 * `missing` — скачанной копии уже нет), иначе `failed`.
 */
export class NativeFileError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`native media: file ${code}`);
    this.code = code;
  }
}

/** Открыть файл из ленты системным приложением — любое приложение с мостом (FileProvider есть с Android 7). */
export function canOpenFileNative(): boolean {
  return nativeMediaAvailable();
}

/** «Скачать» в «Загрузки» через натив — Android 10+ (MediaStore без разрешения на запись). */
export function canSaveFileNative(): boolean {
  return nativeMediaAvailable() && androidMajor() >= 10;
}

/**
 * Имя файла для «Загрузок» и приложения просмотра: без пути и управляющих символов, не длиннее 120 знаков — расширение
 * при обрезке сохраняется (по нему система узнаёт тип). Расширение НЕ дописывается: файл — не обязательно картинка.
 */
export function nativeFileName(name: string): string {
  const clean = (name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'file';
  if (clean.length <= 120) return clean;
  const ext = /\.[a-z0-9]{1,8}$/i.exec(clean)?.[0] ?? '';
  return clean.slice(0, 120 - ext.length) + ext;
}

/**
 * Скачанный файл → копия в кеше приложения → системное приложение по типу (ACTION_VIEW через FileProvider). `token` —
 * метка копии для `reopenFileNative` (повторное нажатие без новой загрузки). Нечем открыть — `NativeFileError('no-app')`.
 */
export async function openFileNative(blob: Blob, name: string, mime: string): Promise<{ token: string }> {
  const m = await putToNative(blob, nativeFileName(name), 'open', mime);
  if (m.ok !== true) throw new NativeFileError(String(m.error ?? 'failed'));
  return { token: String(m.token ?? '') };
}

/** Открыть уже скачанное по метке. Копии больше нет (кеш почищен, приложение перезапускалось) — `NativeFileError('missing')`. */
export async function reopenFileNative(token: string, mime: string): Promise<void> {
  const m = await call('reopen', { token, mime }, 8000);
  if (m.ok !== true) throw new NativeFileError(String(m.error ?? 'failed'));
}

/** «Скачать»: файл в «Загрузки» (Download/GusVoice). Ниже Android 10 — `NativeFileError('unsupported')`. */
export async function saveFileNative(blob: Blob, name: string, mime: string): Promise<{ uri: string }> {
  const m = await putToNative(blob, nativeFileName(name), 'download', mime);
  if (m.ok !== true) throw new NativeFileError(String(m.error ?? 'failed'));
  return { uri: String(m.uri ?? '') };
}

/**
 * «Сохранить в галерею» для видео из ленты (меню сообщения, 07.10): Movies/GusVoice (картинка — Pictures/GusVoice). Тип —
 * от вложения: публичная выдача отдаёт `application/octet-stream`, и `mimeOf` по байтам принял бы видео за JPEG.
 */
export async function saveMediaNative(blob: Blob, name: string, mime: string): Promise<{ uri: string }> {
  const m = await putToNative(blob, fileNameFor(name, mime), 'save', mime);
  if (m.ok !== true) throw new NativeFileError(String(m.error ?? 'failed'));
  return { uri: String(m.uri ?? '') };
}

/** Есть ли у натива «Поделиться»: узнаём один раз (`info.canShare`); пока не узнали — нет. */
let shareKnown: boolean | null = null;

/**
 * «Поделиться» файлом (07.10, только приложение Android, как у Telegram): есть мост и он новый (`canShare` в `info`). Первый
 * вызов спрашивает натив и отвечает `false`; ответ приходит за миллисекунды — зовите заранее (`MessagePane` зовёт при
 * появлении ленты), чтобы к первому меню он уже был.
 */
export function canShareFileNative(): boolean {
  if (shareKnown === null && nativeMediaAvailable()) {
    shareKnown = false;
    nativeMediaInfo().then(
      (i) => {
        shareKnown = i.canShare;
      },
      () => {
        // Не ответил — спросим ещё раз при следующем меню.
        shareKnown = null;
      },
    );
  }
  return shareKnown === true;
}

/** Системное окно «Поделиться» с файлом (копия в кеше приложения, ACTION_SEND). Отказ — `NativeFileError`. */
export async function shareFileNative(blob: Blob, name: string, mime: string): Promise<void> {
  const m = await putToNative(blob, nativeFileName(name), 'share', mime);
  if (m.ok !== true) throw new NativeFileError(String(m.error ?? 'failed'));
}

/**
 * Остановить потоки файлов (лист закрыли, пока шли оригиналы): натив перестаёт читать и отвечает `done` — обещание
 * зовущего завершится с тем, что успело прийти. Без натива — ничего.
 */
export function cancelNativeFiles(): void {
  const ch = channel();
  if (!ch) return;
  for (const id of streams) ch.postMessage(JSON.stringify({ op: 'cancel', id: `${id}-c`, target: id }));
}
