import type { Attachment } from '@gusvoice/shared';
import { api } from './api';
import {
  canOpenFileNative,
  canSaveFileNative,
  NativeFileError,
  openFileNative,
  reopenFileNative,
  saveFileNative,
  saveMediaNative,
  shareFileNative,
} from './nativeMedia';
import { toast } from './toast';

/**
 * Файлы из ленты в приложении Android (06.10, как у Telegram). У WebView приложения нет обработчика загрузок: ссылка с
 * `download` на карточке файла, «⬇» у фото и «Скачать» просмотра молча ничего не делали. Здесь — замена для приложения:
 *
 * - **нажатие на карточку файла** — файл качается (кольцо прогресса на карточке, повторное нажатие — отмена) и
 *   открывается системным приложением по типу (натив: копия в кеше + ACTION_VIEW через FileProvider). Второе нажатие в
 *   этом запуске открывает уже скачанную копию без новой загрузки (`reopen`);
 * - **«⬇» на карточке и у фото / видео, «Скачать» просмотра** — файл в «Загрузки» (Download/GusVoice, Android 10+);
 *   ниже Android 10 туда без разрешения на запись не положить — тогда файл открывается (сохранить можно оттуда).
 *
 * Байты качает страница по ссылке «Скачать» (`api.attachmentDownloadUrl`: закрытый файл ЛС — его `/api/att/…`, публичный
 * файл канала — выдача бэкенда `/api/download/attachment`): у прямой ссылки хранилища CORS нет. Вне приложения (веб,
 * десктоп, браузер телефона) всё как было — обычная ссылка, загрузку делает браузер или оболочка.
 *
 * Состояние загрузок — здесь, а не в карточке: лента может пересоздать строку (окно ленты, перерисовка), а загрузка
 * идёт дальше, и карточка, появившись снова, показывает её прогресс (`fileJobOf` + `subscribeFileJobs`).
 */

/**
 * Что делает загрузка: открыть системным приложением, положить в «Загрузки», видео — в галерею (`gallery`), или отдать в
 * системное окно «Поделиться» (`share`) — последние два из меню сообщения (07.10).
 */
export type FileJobKind = 'open' | 'save' | 'gallery' | 'share' | 'download';

export interface FileJob {
  kind: FileJobKind;
  /** Сколько байт пришло. */
  loaded: number;
  /** Сколько всего: `Content-Length` выдачи, нет его — размер из вложения; 0 — неизвестно. */
  total: number;
}

/** Ключ вложения: закрытый файл ЛС — его `id` (ссылка у каждого смотрящего своя и обновляется), старый публичный — ссылка. */
export function attachmentKey(a: Pick<Attachment, 'id' | 'url'>): string {
  return a.id || a.url;
}

/**
 * Вес в подписи карточки — те же единицы, что у самой карточки в ленте (`AttachmentView.kb` — это она же): «12 KB»,
 * «1.5 MB». Непустой файл меньше полукилобайта — «1 KB», а не «0 KB» (приёмка 06.10: файл в 46 байт был подписан «0 KB»):
 * ноль — только у пустого.
 */
export function sizeText(n: number): string {
  if (n > 0 && n < 1024) return '1 KB';
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Подпись идущей загрузки вместо веса: «1.2 MB / 4.5 MB»; всего неизвестно — сколько пришло. */
export function progressText(loaded: number, total: number): string {
  return total > 0 ? `${sizeText(Math.min(loaded, total))} / ${sizeText(total)}` : sizeText(loaded);
}

/** Доля для кольца прогресса, 0…1; всего неизвестно — 0. */
export function progressRatio(loaded: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(1, loaded / total)) : 0;
}

/** Тип файла для системы: тип вложения без параметров; пусто — «просто байты» (натив тогда смотрит на расширение). */
export function attachmentMime(a: Pick<Attachment, 'contentType'>): string {
  return (a.contentType || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
}

/** Вести файлы нативом — только приложение Android с мостом медиа. Иначе ссылка как была. */
export function filesViaNative(): boolean {
  return canOpenFileNative();
}

/** Что делает «⬇» в приложении: «Загрузки» (Android 10+) или, ниже, открыть — сохранить можно из приложения просмотра. */
export function saveKind(): FileJobKind {
  return canSaveFileNative() ? 'save' : 'open';
}

export const SAVED_TO_DOWNLOADS = 'Сохранено в «Загрузки»';
const SAVED_TO_GALLERY = 'Сохранено в галерею';

// ——— Загрузки: состояние для карточек ——————————————————————————————————————————————————————————————————————————

interface Entry {
  job: FileJob;
  ctl: AbortController;
}

const jobs = new Map<string, Entry>();
const listeners = new Set<() => void>();
/** Открытые в этом запуске страницы: ключ вложения → метка копии у натива (`open/<метка>/<имя>` в кеше приложения). */
const opened = new Map<string, string>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Идущая загрузка вложения или `null`. Один и тот же объект, пока она не сдвинулась (годится для `useSyncExternalStore`). */
export function fileJobOf(key: string): FileJob | null {
  return jobs.get(key)?.job ?? null;
}

export function subscribeFileJobs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Байты по ссылке с прогрессом (частями из `body`, отчёт не чаще раза в 100 мс и в конце). `expected` — размер, если
 * выдача не сказала `Content-Length`. Без CORS-ссылки (прямая ссылка хранилища) упадёт — зовущий даёт ссылку «Скачать».
 */
export async function fetchWithProgress(
  url: string,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
  expected = 0,
): Promise<Blob> {
  const res = await fetch(url, { credentials: 'omit', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || expected;
  const type = res.headers.get('content-type') ?? '';
  if (!res.body) {
    const blob = await res.blob();
    onProgress(blob.size, total || blob.size);
    return blob;
  }
  const reader = res.body.getReader();
  const parts: BlobPart[] = [];
  let loaded = 0;
  let shown = 0;
  onProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    const now = Date.now();
    if (now - shown >= 100) {
      shown = now;
      onProgress(loaded, total);
    }
  }
  onProgress(loaded, total || loaded);
  return new Blob(parts, { type });
}

function report(kind: FileJobKind, e: unknown): void {
  const code = e instanceof NativeFileError ? e.code : '';
  if (kind === 'open' && code === 'no-app') {
    toast('info', 'Нет приложения, чтобы открыть этот файл', canSaveFileNative() ? 'Его можно сохранить в «Загрузки»: стрелка справа на карточке' : undefined);
    return;
  }
  if (kind === 'share') {
    toast('error', code === 'no-app' ? 'Нет приложения, чтобы поделиться файлом' : 'Не удалось поделиться файлом');
    return;
  }
  toast('error', kind === 'open' ? 'Не удалось открыть файл' : 'Не удалось сохранить файл');
}

async function run(a: Attachment, kind: FileJobKind): Promise<void> {
  const key = attachmentKey(a);
  const entry: Entry = { job: { kind, loaded: 0, total: a.size || 0 }, ctl: new AbortController() };
  jobs.set(key, entry);
  emit();
  const live = () => jobs.get(key) === entry && !entry.ctl.signal.aborted;
  try {
    const blob = await fetchWithProgress(
      api.attachmentDownloadUrl(a),
      (loaded, total) => {
        if (!live()) return;
        entry.job = { kind, loaded, total: total || a.size || 0 };
        emit();
      },
      entry.ctl.signal,
      a.size,
    );
    if (!live()) return;
    const mime = attachmentMime(a);
    if (kind === 'open') {
      const { token } = await openFileNative(blob, a.name, mime);
      if (token) opened.set(key, token);
    } else if (kind === 'gallery') {
      await saveMediaNative(blob, a.name, mime);
      toast('success', SAVED_TO_GALLERY, a.name);
    } else if (kind === 'share') {
      await shareFileNative(blob, a.name, mime);
    } else {
      await saveFileNative(blob, a.name, mime);
      toast('success', SAVED_TO_DOWNLOADS, a.name);
    }
  } catch (e) {
    // Отменили нажатием — молча.
    if (entry.ctl.signal.aborted) return;
    report(kind, e);
  } finally {
    if (jobs.get(key) === entry) {
      jobs.delete(key);
      emit();
    }
  }
}

/** Отменить идущую загрузку вложения (повторное нажатие, как у Telegram). Нет её — `false`. */
export function cancelFileJob(key: string): boolean {
  const e = jobs.get(key);
  if (!e) return false;
  e.ctl.abort();
  jobs.delete(key);
  emit();
  return true;
}

/**
 * Нажатие на карточку файла в приложении: идёт загрузка — отменить; файл уже открывали в этом запуске — открыть ту же
 * копию (её нет — скачать заново); иначе скачать с прогрессом и открыть системным приложением.
 */
export function openAttachmentFile(a: Attachment): void {
  const key = attachmentKey(a);
  if (cancelFileJob(key)) return;
  const token = opened.get(key);
  if (!token) {
    void run(a, 'open');
    return;
  }
  reopenFileNative(token, attachmentMime(a)).catch((e: unknown) => {
    if (e instanceof NativeFileError && e.code === 'missing') {
      opened.delete(key);
      void run(a, 'open');
    } else {
      report('open', e);
    }
  });
}

/** «⬇» в приложении: идёт загрузка — отменить; иначе скачать в «Загрузки» (ниже Android 10 — открыть). */
export function saveAttachmentFile(a: Attachment): void {
  const key = attachmentKey(a);
  if (cancelFileJob(key)) return;
  void run(a, saveKind());
}

/** Подпись хода «Скачать» в просмотре: `final` — итог (гаснет сам), иначе прогресс (держится, пока идёт). */
export interface DownloadNote {
  text: string;
  final: boolean;
}

/**
 * «Скачать» в просмотре (`Lightbox`: фото, видео, аватар) в приложении: файл — в «Загрузки» (ниже Android 10 —
 * открыть). Возвращает `true` — зовущий гасит переход по ссылке, ход и итог придут в `note` (общие тосты лежат ниже
 * просмотра). Вне приложения — `false`: ссылка с `download` делает своё, как было.
 */
export function downloadInApp(href: string, name: string, mime: string, note: (n: DownloadNote) => void): boolean {
  if (!filesViaNative()) return false;
  const kind = saveKind();
  void (async () => {
    try {
      const blob = await fetchWithProgress(href, (loaded, total) =>
        note({ text: `Скачивание… ${Math.round(progressRatio(loaded, total) * 100)} %`, final: false }),
      );
      if (kind === 'save') {
        await saveFileNative(blob, name, mime);
        note({ text: SAVED_TO_DOWNLOADS, final: true });
      } else {
        await openFileNative(blob, name, mime);
        note({ text: '', final: true });
      }
    } catch (e) {
      const noApp = e instanceof NativeFileError && e.code === 'no-app';
      note({ text: noApp ? 'Нет приложения, чтобы открыть этот файл' : 'Не удалось сохранить', final: true });
    }
  })();
  return true;
}

/**
 * Начать загрузку вложения с кольцом на карточке, как «⬇» (`run`), — для пунктов меню сообщения (`fileMenu.ts`, 07.10).
 * Уже идёт загрузка этого вложения — ничего (отмена — повторным нажатием на карточку, а не пунктом меню).
 */
export function startFileJob(a: Attachment, kind: FileJobKind): void {
  if (jobs.has(attachmentKey(a))) return;
  void run(a, kind);
}


/**
 * Загрузка, которую ведут снаружи (ПК: `pcDownloads.ts`, G31 08.10), — с тем же кольцом на карточке, «⬇» и в просмотре
 * (`fileJobOf` по ключу) и той же отменой (`cancelFileJob`). Уже идёт под этим ключом — `null`. `end()` снимает ход.
 */
export function trackFileJob(
  key: string,
  kind: FileJobKind,
  total: number,
): { signal: AbortSignal; live: () => boolean; progress: (loaded: number, total: number) => void; end: () => void } | null {
  if (jobs.has(key)) return null;
  const entry: Entry = { job: { kind, loaded: 0, total }, ctl: new AbortController() };
  jobs.set(key, entry);
  emit();
  const live = () => jobs.get(key) === entry && !entry.ctl.signal.aborted;
  return {
    signal: entry.ctl.signal,
    live,
    progress: (loaded, t) => {
      if (!live()) return;
      entry.job = { kind, loaded, total: t };
      emit();
    },
    end: () => {
      if (jobs.get(key) !== entry) return;
      jobs.delete(key);
      emit();
    },
  };
}
