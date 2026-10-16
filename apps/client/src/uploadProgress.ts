/**
 * Прогресс загрузки вложений отправляемого сообщения (порция «Отправка», 07.10; ресерч Telegram `01-message.md` 1.24,
 * 6.22, `04-media-gestures.md` FA-01: кольцо с крестиком поверх миниатюры, у файла — у значка).
 *
 * 🔴 Отдельно от стора и состояния ленты НАМЕРЕННО (`docs/dm/playbook/12-render-perf.md`: «прогресс загрузки — через
 * ref, не через setState»): события `upload.onprogress` идут десятками в секунду, и каждое через стор перерисовывало бы
 * всю ленту. Здесь на них подписано только само кольцо (`useSyncExternalStore` по ключу строки).
 *
 * Ключ — id отправки строки «в пути» (`OutboxItem.key` / `outgoing.key`), номер — индекс файла в строке.
 */

export interface FileUpload {
  loaded: number;
  /** `0` — размер неизвестен (кольцо стоит в начале). */
  total: number;
  /** Файл загружен: кольца больше нет. */
  done: boolean;
}

const rows = new Map<string, Map<number, FileUpload>>();
const listeners = new Map<string, Set<() => void>>();

function emit(key: string): void {
  for (const fn of listeners.get(key) ?? []) fn();
}

function put(key: string, index: number, next: FileUpload): void {
  let row = rows.get(key);
  if (!row) rows.set(key, (row = new Map()));
  row.set(index, next);
  emit(key);
}

/** Пришли очередные байты файла `index` строки `key`. */
export function setUploadProgress(key: string, index: number, loaded: number, total: number): void {
  const prev = rows.get(key)?.get(index);
  if (prev && prev.done) return;
  if (prev && prev.loaded === loaded && prev.total === total) return;
  put(key, index, { loaded, total, done: false });
}

/** Файл `index` строки `key` загружен (кольцо уходит). */
export function setUploadDone(key: string, index: number): void {
  const prev = rows.get(key)?.get(index);
  put(key, index, { loaded: prev?.total ?? prev?.loaded ?? 0, total: prev?.total ?? 0, done: true });
}

/** Строка ушла, отменена или начата заново — забыть её прогресс. */
export function clearUploadProgress(key: string): void {
  if (!rows.delete(key)) return;
  emit(key);
}

/** Где сейчас файл `index` строки `key`; `null` — загрузка ещё не начиналась. Один и тот же объект до следующего события. */
export function uploadOf(key: string, index: number): FileUpload | null {
  return rows.get(key)?.get(index) ?? null;
}

/** Подписка на прогресс одной строки (для `useSyncExternalStore`). */
export function subscribeUpload(key: string, fn: () => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) listeners.delete(key);
  };
}

const signals = new Map<string, AbortSignal>();

/**
 * Сигнал отмены строки «в пути» без очереди ЛС (каналы): лента кладёт его перед `onSend`, зовущий
 * (`ChatView`, `DmChatView`) берёт по `sendKey` и отдаёт загрузке. `null` — строка ушла.
 */
export function setUploadSignal(key: string, signal: AbortSignal | null): void {
  if (signal) signals.set(key, signal);
  else signals.delete(key);
}

export function uploadSignal(key: string): AbortSignal | undefined {
  return signals.get(key);
}

/** Отказ «загрузку отменил сам человек» (XHR `abort`): строку не помечать «не отправлено». */
export function uploadAborted(): Error & { aborted: true } {
  return Object.assign(new Error('загрузка отменена'), { name: 'AbortError', aborted: true as const });
}

export function isUploadAborted(e: unknown): boolean {
  return (e as { aborted?: boolean } | null)?.aborted === true || (e as { name?: string } | null)?.name === 'AbortError';
}

/** Как зовущий узнаёт о байтах и как отменяет: оба необязательны (без них загрузка — прежним `fetch`). */
export interface UploadOpts {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

/** Идёт ли сейчас хоть одна загрузка файла (для вопроса «выйти?» по Ctrl+Q, G63). */
export function hasActiveUploads(): boolean {
  for (const row of rows.values()) for (const u of row.values()) if (!u.done) return true;
  return false;
}
