/**
 * «Папка → ZIP» (решение владельца 13.10): бросок ПАПКИ в окно чата собирается в браузере в один файл `<папка>.zip` и идёт в
 * обычное окно отправки. Правила (обход, имена, пределы, заголовки) — `folderZipRules.ts`; здесь — то, что трогает браузер:
 * `FileSystemEntry`, `Blob`, `CompressionStream`, тост «Упаковываю…». Источник поведения — Telegram Desktop
 * `storage_folder_archive.cpp` (`PrepareFolderArchive` / `WriteArchive`), см. шапку rules.
 *
 * Архив собирается как `Blob` из кусков: заголовки в памяти, тела — ссылки на сами файлы (без сжатия) или сжатые браузером
 * (`CompressionStream('deflate-raw')`, браузер держит их на диске сам). Так папка в сотни мегабайт не раздувает память.
 */
import { dmAttachMaxBytes } from './attachRules';
import {
  FOLDER_REFUSE_TEXT,
  FolderZipError,
  ZIP_MAX_BYTES,
  type FileInfo,
  type FsDirNode,
  type FsNode,
  type ZipEntry,
  type ZipRecord,
  centralHeader,
  crc32Update,
  endRecord,
  folderZipErrorText,
  isStoredName,
  localHeader,
  planDrop,
  walkFolder,
  zipFileName,
} from './folderZipRules';
import { toast, updateToast, useToasts } from './toast';

/** `FileSystemEntry` → узел обхода (`readEntries` отдаёт порциями и сам знает, когда конец — пустой ответ). */
function nodeOf(entry: FileSystemEntry): FsNode<File> {
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    return {
      kind: 'dir',
      name: entry.name,
      readBatch: () => new Promise<FsNode<File>[]>((ok, no) => reader.readEntries((list) => ok(list.map(nodeOf)), no)),
    };
  }
  return {
    kind: 'file',
    name: entry.name,
    file: () => new Promise<File>((ok, no) => (entry as FileSystemFileEntry).file(ok, no)),
  };
}

const canDeflate = () => typeof CompressionStream === 'function';

/** Один проход по файлу: CRC и (если `deflate`) сжатое тело; `onBytes` — сколько прочитано. */
async function readFile(
  file: File,
  deflate: boolean,
  onBytes: (n: number) => void,
  isCancelled: () => boolean,
): Promise<{ crc: number; packed: Blob | null }> {
  let crc = 0;
  const body = new Response(file).body;
  if (!body) throw new FolderZipError('failed');
  const tap = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, ctl) {
      if (isCancelled()) throw new FolderZipError('cancelled');
      crc = crc32Update(crc, chunk);
      onBytes(chunk.length);
      ctl.enqueue(chunk);
    },
  });
  const counted = body.pipeThrough(tap);
  if (!deflate) {
    const reader = counted.getReader();
    while (!(await reader.read()).done) {
      /* читаем до конца ради CRC */
    }
    return { crc, packed: null };
  }
  const packed = await new Response(counted.pipeThrough(new CompressionStream('deflate-raw'))).blob();
  return { crc, packed };
}

/** Собрать архив из записей обхода. `onProgress` — доля 0…1 по несжатому размеру. */
export async function buildZip(
  entries: readonly ZipEntry<File>[],
  limit: number,
  onProgress: (fraction: number) => void,
  isCancelled: () => boolean,
): Promise<Blob> {
  const total = entries.reduce((s, e) => s + e.size, 0);
  let done = 0;
  const parts: BlobPart[] = [];
  const records: { rec: ZipRecord; offset: number }[] = [];
  let offset = 0;
  const push = (p: BlobPart, len: number) => {
    parts.push(p);
    offset += len;
  };
  const deflateOk = canDeflate();
  try {
    for (const e of entries) {
      if (isCancelled()) throw new FolderZipError('cancelled');
      const base = { path: e.path, dir: e.dir, modified: e.modified, size: e.size };
      let rec: ZipRecord;
      let body: Blob | null = null;
      if (e.dir || !e.source) {
        rec = { ...base, method: 0, crc: 0, packed: 0 };
      } else {
        const wantDeflate = deflateOk && e.size > 0 && !isStoredName(e.path);
        const r = await readFile(e.source, wantDeflate, (n) => {
          done += n;
          onProgress(total > 0 ? Math.min(1, done / total) : 1);
        }, isCancelled);
        // Сжатие не выиграло — кладём файл как есть (ссылкой, без копии).
        const useDeflate = r.packed !== null && r.packed.size < e.size;
        rec = { ...base, method: useDeflate ? 8 : 0, crc: r.crc, packed: useDeflate ? r.packed!.size : e.size };
        body = useDeflate ? r.packed : e.source;
      }
      const head = localHeader(rec);
      records.push({ rec, offset });
      push(head, head.length);
      if (body && rec.packed > 0) push(body, rec.packed);
      if (offset > limit) throw new FolderZipError('tooLarge', offset);
    }
  } catch (err) {
    if (err instanceof FolderZipError) throw err;
    throw new FolderZipError('failed'); // файл изменился или не читается посреди упаковки
  }
  const centralStart = offset;
  for (const { rec, offset: at } of records) {
    const c = centralHeader(rec, at);
    push(c, c.length);
  }
  const end = endRecord(records.length, offset - centralStart, centralStart);
  push(end, end.length);
  if (offset > limit) throw new FolderZipError('tooLarge', offset);
  onProgress(1);
  return new Blob(parts, { type: 'application/zip' });
}

/** Папку в архив: обход + сборка. Бросает `FolderZipError`. */
export async function zipDirectoryEntry(
  entry: FileSystemDirectoryEntry,
  limit: number,
  onProgress: (fraction: number) => void,
  isCancelled: () => boolean,
): Promise<File> {
  const root = nodeOf(entry) as FsDirNode<File & FileInfo>;
  const walked = await walkFolder(root, limit, isCancelled);
  const blob = await buildZip(walked.entries, limit, onProgress, isCancelled);
  return new File([blob], zipFileName(entry.name), { type: 'application/zip', lastModified: Date.now() });
}

/**
 * Что бросили в окно чата. Вызывать СРАЗУ в обработчике `drop`: после выхода из него `DataTransfer` пустеет.
 * Папок нет — вернёт обычный список файлов (синхронно, как раньше). Ровно одна папка и больше ничего — вернёт обещание
 * с одним файлом `<папка>.zip` (пока оно не готово, висит тост «Упаковываю…» с процентами; закрытие тоста отменяет упаковку).
 * Папка вместе с чем-то ещё — тост-объяснение и пустой список (Telegram такой бросок не принимает, `ComputeMimeDataState`).
 * Ошибки — тостом; пустой список = нечего добавлять.
 */
export function collectDrop(dt: DataTransfer, limit: number = dmAttachMaxBytes()): File[] | Promise<File[]> {
  const files = Array.from(dt.files);
  const entries = Array.from(dt.items ?? [])
    .filter((it) => it.kind === 'file')
    .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null));
  const dirs = entries.filter((e): e is FileSystemDirectoryEntry => !!e?.isDirectory);
  const plan = planDrop(dirs.length, entries.length - dirs.length);
  if (plan === 'files') return files;
  if (plan === 'refuse') {
    toast('info', FOLDER_REFUSE_TEXT);
    return [];
  }
  const dir = dirs[0]!;
  const max = Math.min(limit, ZIP_MAX_BYTES);
  const id = toast('info', `Упаковываю «${dir.name}»…`, undefined, { sticky: true });
  const isCancelled = () => !useToasts.getState().toasts.some((t) => t.id === id);
  let shown = -1;
  const onProgress = (f: number) => {
    const pct = Math.floor(f * 100);
    if (pct !== shown) {
      shown = pct;
      updateToast(id, { subtitle: `${pct}%` });
    }
  };
  return zipDirectoryEntry(dir, max, onProgress, isCancelled).then(
    (zip) => {
      useToasts.getState().dismiss(id);
      return [zip];
    },
    (err: unknown) => {
      useToasts.getState().dismiss(id);
      const e = err instanceof FolderZipError ? err : new FolderZipError('failed');
      if (e.code !== 'cancelled') toast('error', folderZipErrorText(e, dir.name, max));
      return [];
    },
  );
}
