/**
 * Список «Загрузки» этой вкладки (G31, 08.10; tdesktop `data/data_download_manager.cpp` + раздел «Загрузки» в настройках,
 * Android `SearchDownloadsContainer`): что качали за сеанс — с ходом, отменой, «Открыть» и «Сохранить снова». Хранится только
 * в памяти вкладки (перезагрузка — список пуст): файлы на диске браузер нам не показывает, «Удалить с диска» и «Показать в
 * папке» вебу недоступны. Скачанное держится объектной ссылкой (`blob:`) — «Сохранить снова» и «Открыть» не качают заново;
 * убрали запись или очистили список — ссылка освобождается.
 */

export type DownloadState = 'loading' | 'done' | 'failed' | 'cancelled';

export interface DownloadEntry {
  /** Номер записи в сеансе (растёт). */
  id: number;
  /** Ключ вложения (`fileActions.attachmentKey`) или ссылка — по нему карточка и просмотр находят идущую загрузку. */
  key: string;
  /** Ссылка «Скачать» — для «Повторить». */
  url: string;
  name: string;
  /** Тип файла (для «Открыть»: что браузер покажет сам). */
  type: string;
  loaded: number;
  total: number;
  state: DownloadState;
  /** Когда начали, мс. */
  at: number;
  /** Скачанное — объектная ссылка (`URL.createObjectURL`), пока запись в списке. */
  href?: string;
  /** Где файл лёг на диск — путь от оболочки десктопа (`gv-download-done`); у браузера и Android его нет. «Показать в папке». */
  path?: string;
}

/** Сколько записей держим: старые законченные уходят (и их объектные ссылки освобождаются). */
export const DOWNLOAD_LIST_MAX = 50;

let list: readonly DownloadEntry[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function set(next: readonly DownloadEntry[]): void {
  list = next;
  for (const fn of listeners) fn();
}

function release(e: DownloadEntry): void {
  if (!e.href) return;
  try {
    URL.revokeObjectURL(e.href);
  } catch {
    /* нечего освобождать */
  }
}

/** Записи, новые сверху. Один и тот же массив, пока ничего не поменялось (годится для `useSyncExternalStore`). */
export function downloadsSnapshot(): readonly DownloadEntry[] {
  return list;
}

export function subscribeDownloads(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Новая загрузка — сверху; сверх `DOWNLOAD_LIST_MAX` уходят самые старые законченные. Возвращает номер записи. */
export function addDownload(d: { key: string; url: string; name: string; type: string; total: number }): number {
  const id = ++seq;
  const entry: DownloadEntry = { ...d, id, loaded: 0, state: 'loading', at: Date.now() };
  let next = [entry, ...list];
  while (next.length > DOWNLOAD_LIST_MAX) {
    const i = next.map((x) => x.state !== 'loading').lastIndexOf(true);
    if (i < 0) break;
    release(next[i]);
    next = next.filter((_, j) => j !== i);
  }
  set(next);
  return id;
}

/** Поправить запись (ход, итог). Нет такой — ничего. */
export function patchDownload(id: number, patch: Partial<Pick<DownloadEntry, 'loaded' | 'total' | 'state' | 'href' | 'path'>>): void {
  if (!list.some((e) => e.id === id)) return;
  set(list.map((e) => (e.id === id ? { ...e, ...patch } : e)));
}

/** Убрать запись из списка (идущую — нельзя: её сперва отменяют). */
export function removeDownload(id: number): void {
  const e = list.find((x) => x.id === id);
  if (!e || e.state === 'loading') return;
  release(e);
  set(list.filter((x) => x.id !== id));
}

/** «Очистить список загрузок» (Android `SearchDownloadsContainer`): уходят все законченные, идущие остаются. */
export function clearDownloads(): void {
  const keep = list.filter((e) => e.state === 'loading');
  if (keep.length === list.length) return;
  for (const e of list) if (e.state !== 'loading') release(e);
  set(keep);
}

/** Скачанное в этом сеансе по ключу (самое свежее) — чтобы «Скачать» ещё раз не тянуло файл из сети. */
export function doneHrefOf(key: string): string | undefined {
  return list.find((e) => e.key === key && e.state === 'done' && e.href)?.href;
}

/**
 * Что браузер покажет сам в новой вкладке («Открыть» в списке): растровые картинки, видео, звук, PDF и простой текст.
 * Остальное вкладка отдала бы обратно загрузкой — пункта нет. 🔴 Объектная ссылка живёт в НАШЕМ источнике: SVG, HTML и
 * прочий XML со скриптом выполнились бы с доступом ко входу — их нет никогда (тип файла задаёт отправитель).
 */
export function opensInBrowser(type: string): boolean {
  const t = type.toLowerCase().split(';')[0].trim();
  return (
    /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(t) ||
    /^(video|audio)\/[a-z0-9.+-]+$/.test(t) ||
    t === 'application/pdf' ||
    t === 'text/plain'
  );
}

/** Сколько путей «ссылка → файл на диске» держим (хватает на сеанс; старые уходят первыми). */
const SAVED_BY_URL_MAX = 200;
const savedByUrl = new Map<string, string>();

/** Имя файла из пути Windows или POSIX. */
function baseNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Имя на диске = имя записи, с поправкой на «имя (1).ext», которое оболочка даёт при совпадении (`lib.rs unique_in`). */
function sameSavedName(entryName: string, onDisk: string): boolean {
  return onDisk === entryName || onDisk.replace(/ \(\d+\)(?=(\.[^.]*)?$)/, '') === entryName;
}

/**
 * Оболочка десктопа сказала, куда легло скачанное (`gv-download-done`: ссылка, откуда качали, и путь файла). Запоминаем путь по
 * ссылке (фото и файлы, которые качает сам WebView2 по адресу выдачи) и пишем в запись списка: сперва та, чья объектная
 * ссылка равна `url`; ссылку WebView2 не отдал или она `blob:` без записи — самая свежая готовая запись без пути с тем же
 * именем. Для «Показать в папке» (tdesktop `File::ShowInFolder`, `core/file_utilities.cpp`).
 */
export function noteSavedFile(f: { url?: string; path: string }): void {
  if (!f.path) return;
  const url = f.url || '';
  if (url) {
    savedByUrl.delete(url);
    savedByUrl.set(url, f.path);
    while (savedByUrl.size > SAVED_BY_URL_MAX) {
      const first = savedByUrl.keys().next().value;
      if (first === undefined) break;
      savedByUrl.delete(first);
    }
  }
  let hit = url ? list.find((e) => e.href === url) : undefined;
  if (!hit && (!url || url.startsWith('blob:'))) {
    const onDisk = baseNameOf(f.path);
    hit = list.find((e) => e.state === 'done' && !e.path && sameSavedName(e.name, onDisk));
  }
  if (hit) patchDownload(hit.id, { path: f.path });
}

/**
 * Путь скачанного файла на диске (для «Показать в папке»): запись списка по ключу вложения, иначе по ссылке «Скачать» —
 * фото качает WebView2 сам, записи в списке у них нет. Нет — файл в этом сеансе не сохраняли (пункта нет).
 */
export function savedPathOf(key: string, url?: string): string | undefined {
  return list.find((e) => e.key === key && e.state === 'done' && e.path)?.path ?? (url ? savedByUrl.get(url) : undefined);
}
