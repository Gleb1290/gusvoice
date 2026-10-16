/**
 * «Папка → ZIP» при отправке в ЛС (решение владельца 13.10): чистые правила без DOM, React и сети — обход папки, имена,
 * пределы, заголовки ZIP. Обвязка с `FileSystemEntry`, `Blob` и `CompressionStream` — `folderZip.ts`.
 *
 * Источник поведения — Telegram Desktop `storage/storage_folder_archive.cpp` (+ `localimageloader.cpp`, `send_files_box.cpp`):
 * - ровно ОДНА папка в броске → файл `<имя папки>.zip` (`PrepareFolderArchive`, `ArchiveRootName`; имя пусто → «Archive»);
 *   папка + что-то ещё / несколько папок — бросок не принимается (`MimeDataState::None` в `ComputeMimeDataState`);
 * - внутри архива всё лежит под корнем `<папка>/…`, каждая вложенная папка — своя запись с `/` на конце (`WalkFolder`);
 *   скрытые файлы входят (`QDir::Hidden`), ссылки пропускаются (в браузере их не видно вовсе);
 * - уже сжатые расширения кладутся без сжатия, остальные — deflate (`AlreadyCompressedName` — тот же список);
 * - заранее оценивается размер по несжатым (`ArchiveSizeEstimate`) и сверяется с пределом вложения, а во время записи —
 *   по уже записанному (`io.writtenSize() > limit` → `TooLarge`); нечитаемый файл — «не удалось создать архив».
 * Отличие от Telegram: пустая папка не уходит пустым архивом (у Telegram пустой ФАЙЛ отклоняется тем же правилом —
 * `lng_send_image_empty`, а пустой архив бесполезен), и записи считаются ZIP32 (≤ 65 535 записей, ≤ 4 ГиБ): у нас
 * предел вложения 25 МБ / 1 ГиБ, до ZIP64 не доходит.
 */

/** Записей в ZIP32: счётчики в конце архива 16-битные. */
export const ZIP_MAX_ENTRIES = 65535;
/** Верх размера ZIP32 минус запас на конец архива — предел, выше которого `limit` не поднимаем. */
export const ZIP_MAX_BYTES = 0xffffffff - 1024 * 1024;
/** Запас Telegram на заголовок записи при оценке (`kArchiveEntryOverhead`) — у нас считаем точно (`storedZipSize`). */
export const ZIP_EXT_STORED: ReadonlySet<string> = new Set([
  '3gp', '7z', 'aac', 'apk', 'avi', 'avif', 'bz2', 'cab', 'docx', 'epub', 'flac', 'flv', 'gif', 'gz', 'heic', 'heif', 'jar', 'jpeg',
  'jpg', 'jxl', 'm4a', 'm4v', 'mkv', 'mov', 'mp3', 'mp4', 'odp', 'ods', 'odt', 'oga', 'ogg', 'opus', 'png', 'pptx', 'rar', 'tgz',
  'webm', 'webp', 'wma', 'wmv', 'xlsx', 'xz', 'zip', 'zst',
]);

/** Уже сжатый формат — пакуем без сжатия (`AlreadyCompressedName`): точка в начале имени («.gitignore») расширением не считается. */
export function isStoredName(name: string): boolean {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return ZIP_EXT_STORED.has(base.slice(dot + 1).toLowerCase());
}

export type FolderZipErrorCode = 'empty' | 'tooLarge' | 'tooMany' | 'failed' | 'cancelled';

export class FolderZipError extends Error {
  constructor(
    readonly code: FolderZipErrorCode,
    /** Сколько весит то, что не влезло (`tooLarge`), байт. */
    readonly bytes = 0,
  ) {
    super(`folder-zip:${code}`);
  }
}

/** Мегабайты для текста ошибки: «25», «1,5» (как `attachRules.megabytes`, но без зависимости от того модуля). */
function mb(bytes: number): string {
  const v = bytes / (1024 * 1024);
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ',');
}

/** Слова тоста для отказа (`lng_folder_archive_failed` «Failed to create archive.», `lng_send_image_empty`, `FileSizeLimitBox`). */
export function folderZipErrorText(err: FolderZipError, folder: string, max: number): string {
  const name = `«${folder}»`;
  switch (err.code) {
    case 'empty':
      return `В папке ${name} нет файлов — отправлять нечего`;
    case 'tooLarge':
      return `Папка ${name} весит ${mb(err.bytes)} МБ — больше предела ${mb(max)} МБ на вложение`;
    case 'tooMany':
      return `В папке ${name} больше ${ZIP_MAX_ENTRIES.toLocaleString('ru-RU')} файлов и папок — архив не собрать`;
    default:
      return `Не удалось создать архив из папки ${name}`;
  }
}

/** Что делать с броском: ни одной папки — обычные файлы; ровно одна и больше ничего — архив; иначе не принимаем. */
export type DropPlan = 'files' | 'folder' | 'refuse';

export function planDrop(dirs: number, others: number): DropPlan {
  if (dirs === 0) return 'files';
  return dirs === 1 && others === 0 ? 'folder' : 'refuse';
}

/** Тост при отказе (Telegram такой бросок просто не принимает — у нас рамка уже показана, поэтому объясняем). */
export const FOLDER_REFUSE_TEXT = 'Папку можно отправить только одну и без других файлов — она уйдёт архивом';

/** Имя без разделителей пути и управляющих символов; пусто — «Archive» (`ArchiveRootName`). */
export function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex -- управляющие символы в имени запрещены в ZIP и в проводнике
  const clean = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim();
  return clean === '' || clean === '.' || clean === '..' ? 'Archive' : clean;
}

/** Имя файла-архива: `<папка>.zip`; слишком длинное имя урезаем, чтобы вместе с `.zip` оно влезло в 150 знаков. */
export function zipFileName(folder: string): string {
  const base = Array.from(safeName(folder)).slice(0, 146).join('');
  return `${base}.zip`;
}

/** Узел обхода: сама ФС (браузерный `FileSystemEntry`) прячется за этим, поэтому правила проверяются без DOM. */
export interface FsFileNode<F> {
  kind: 'file';
  name: string;
  /** Прочитать файл (может отказать: права, файл исчез). */
  file(): Promise<F>;
}
export interface FsDirNode<F> {
  kind: 'dir';
  name: string;
  /** Следующая порция содержимого; пустая — конец (`FileSystemDirectoryReader.readEntries` отдаёт по ~100 за раз). */
  readBatch(): Promise<FsNode<F>[]>;
}
export type FsNode<F> = FsFileNode<F> | FsDirNode<F>;

export interface ZipEntry<F> {
  /** Путь внутри архива с `/`; у папки — с `/` на конце. */
  path: string;
  dir: boolean;
  size: number;
  modified: number;
  source: F | null;
}

export interface FileInfo {
  size: number;
  lastModified: number;
}

/**
 * Размер архива, если ничего не сжимать, байт: заголовок записи (30 + имя) + тело + запись каталога (46 + имя) + конец (22).
 * Сжатие этот размер только уменьшает (запись сжатой берётся лишь когда она меньше), поэтому это верхняя граница.
 */
export function storedZipSize(entries: readonly { path: string; size: number }[]): number {
  let total = 22;
  for (const e of entries) total += 76 + 2 * utf8Length(e.path) + e.size;
  return total;
}

export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * Обход папки (`WalkFolder`): корень `<имя>/`, потом всё содержимое в глубину; в каждой папке сначала запись самой папки,
 * потом её содержимое по имени. Порции `readBatch` читаем до пустого ответа. Бросает `FolderZipError`: `tooMany` — записей больше
 * `ZIP_MAX_ENTRIES`, `tooLarge` — несжатый размер уже больше `limit` (обход прерывается сразу, не дочитывая гигабайты),
 * `failed` — что-то не прочиталось, `empty` — файлов нет вовсе. `isCancelled` проверяется между порциями.
 */
export async function walkFolder<F extends FileInfo>(
  root: FsDirNode<F>,
  limit: number,
  isCancelled: () => boolean = () => false,
): Promise<{ entries: ZipEntry<F>[]; files: number; bytes: number; rootName: string }> {
  const rootName = safeName(root.name);
  const entries: ZipEntry<F>[] = [];
  let files = 0;
  let raw = 22;
  const add = (e: ZipEntry<F>) => {
    entries.push(e);
    if (entries.length > ZIP_MAX_ENTRIES) throw new FolderZipError('tooMany');
    raw += 76 + 2 * utf8Length(e.path) + e.size;
    if (raw > limit) throw new FolderZipError('tooLarge', raw);
  };
  const visit = async (dir: FsDirNode<F>, prefix: string, modified: number): Promise<void> => {
    add({ path: `${prefix}/`, dir: true, size: 0, modified, source: null });
    const kids: FsNode<F>[] = [];
    for (;;) {
      if (isCancelled()) throw new FolderZipError('cancelled');
      let batch: FsNode<F>[];
      try {
        batch = await dir.readBatch();
      } catch {
        throw new FolderZipError('failed');
      }
      if (batch.length === 0) break;
      kids.push(...batch);
    }
    kids.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Файлы порции читаем вместе (их `file()` — обращение к ФС), каталоги — по очереди: глубина, а не ширина, держит очередь.
    const infos = await Promise.all(
      kids.map(async (k) => {
        if (k.kind !== 'file') return null;
        try {
          return await k.file();
        } catch {
          throw new FolderZipError('failed');
        }
      }),
    );
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      const name = safeName(k.name);
      if (k.kind === 'dir') {
        await visit(k, `${prefix}/${name}`, modified);
      } else {
        const f = infos[i]!;
        files++;
        add({ path: `${prefix}/${name}`, dir: false, size: f.size, modified: f.lastModified, source: f });
      }
    }
  };
  await visit(root, rootName, Date.now());
  if (files === 0) throw new FolderZipError('empty');
  return { entries, files, bytes: raw, rootName };
}

/* ───────── ZIP: заголовки ───────── */

let crcTable: Uint32Array | null = null;
function table(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

/** CRC-32 (IEEE) по кускам: начинать с `0`, продолжать результатом предыдущего вызова. */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  const t = table();
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/** Дата и время записи в формате MS-DOS (2-секундная точность, не раньше 1980 — `FillEntryDate`). */
export function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface ZipRecord {
  path: string;
  dir: boolean;
  /** 0 — без сжатия, 8 — deflate. */
  method: 0 | 8;
  crc: number;
  /** Размер тела в архиве (сжатый) и исходный. */
  packed: number;
  size: number;
  modified: number;
}

const FLAG_UTF8 = 0x0800;
const VERSION = 20;

function nameBytes(path: string): Uint8Array<ArrayBuffer> {
  const b = new TextEncoder().encode(path);
  if (b.length > 0xffff) throw new FolderZipError('failed');
  return b as Uint8Array<ArrayBuffer>;
}

/** Заголовок записи перед телом (PKWARE APPNOTE 4.3.7). */
export function localHeader(r: ZipRecord): Uint8Array<ArrayBuffer> {
  const name = nameBytes(r.path);
  const out = new Uint8Array(30 + name.length);
  const v = new DataView(out.buffer);
  const { time, date } = dosDateTime(r.modified);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, VERSION, true);
  v.setUint16(6, FLAG_UTF8, true);
  v.setUint16(8, r.method, true);
  v.setUint16(10, time, true);
  v.setUint16(12, date, true);
  v.setUint32(14, r.crc >>> 0, true);
  v.setUint32(18, r.packed, true);
  v.setUint32(22, r.size, true);
  v.setUint16(26, name.length, true);
  v.setUint16(28, 0, true);
  out.set(name, 30);
  return out;
}

/** Запись оглавления (APPNOTE 4.3.12); `offset` — где лежит заголовок записи. Папка помечена DOS-атрибутом 0x10, как у Telegram. */
export function centralHeader(r: ZipRecord, offset: number): Uint8Array<ArrayBuffer> {
  const name = nameBytes(r.path);
  const out = new Uint8Array(46 + name.length);
  const v = new DataView(out.buffer);
  const { time, date } = dosDateTime(r.modified);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, VERSION, true);
  v.setUint16(6, VERSION, true);
  v.setUint16(8, FLAG_UTF8, true);
  v.setUint16(10, r.method, true);
  v.setUint16(12, time, true);
  v.setUint16(14, date, true);
  v.setUint32(16, r.crc >>> 0, true);
  v.setUint32(20, r.packed, true);
  v.setUint32(24, r.size, true);
  v.setUint16(28, name.length, true);
  v.setUint32(38, r.dir ? 0x10 : 0, true);
  v.setUint32(42, offset, true);
  out.set(name, 46);
  return out;
}

/** Конец архива (APPNOTE 4.3.16). */
export function endRecord(count: number, centralSize: number, centralOffset: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(22);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, centralSize, true);
  v.setUint32(16, centralOffset, true);
  return out;
}
