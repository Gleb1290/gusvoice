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
export function patchDownload(id: number, patch: Partial<Pick<DownloadEntry, 'loaded' | 'total' | 'state' | 'href'>>): void {
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
