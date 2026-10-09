import type { Attachment } from '@gusvoice/shared';
import { api } from './api';
import { addDownload, doneHrefOf, patchDownload } from './downloadList';
import {
  attachmentKey,
  attachmentMime,
  cancelFileJob,
  fetchWithProgress,
  filesViaNative,
  progressRatio,
  trackFileJob,
  type DownloadNote,
} from './fileActions';
import { toast } from './toast';

/**
 * Скачивание на ПК и в браузере телефона (G31 / G59 / G10, 08.10): кольцо прогресса с отменой на карточке файла, у «⬇»
 * фото и видео и у «Скачать» просмотра, как у Telegram (tdesktop `history_view_document.cpp`: круг с ✕, пока качается;
 * повторный щелчок — отмена), запись в список «Загрузки» этой вкладки (`downloadList.ts`) и «Поделиться» из просмотра
 * системным окном браузера. Ход — общий с приложением Android (`fileActions.trackFileJob`: `fileJobOf` по ключу).
 *
 * Байты качает страница по ссылке «Скачать» (выдача бэкенда с CORS, как у приложения), потом сохраняет тем же путём, что
 * прежняя ссылка: `<a download>` — только по объектной ссылке. Браузер кладёт файл в свои «Загрузки», десктоп-оболочка —
 * в папку из настроек со своим тостом. Файл целиком проходит через память вкладки.
 */

/**
 * Что качаем: `key` — ключ вложения (`attachmentKey`; у аватара в просмотре — сама ссылка), `url` — ссылка «Скачать», `type`
 * — тип файла (выдача публичных говорит `application/octet-stream`).
 */
export interface DownloadTarget {
  key: string;
  url: string;
  name: string;
  size?: number;
  type?: string;
}

export function attachmentTarget(a: Attachment): DownloadTarget {
  return { key: attachmentKey(a), url: api.attachmentDownloadUrl(a), name: a.name, size: a.size, type: attachmentMime(a) };
}

/**
 * Вести «Скачать» страницей (с кольцом и отменой) — везде, кроме приложения Android (там натив, `fileActions.ts`). Нет
 * потоков у `fetch` или объектных ссылок — по-старому: ссылка с `download`, загрузку ведёт браузер или оболочка.
 */
export function ringDownloads(): boolean {
  return (
    !filesViaNative() &&
    typeof ReadableStream !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  );
}

/** Сохранить на диск по объектной ссылке (`<a download>`), следующей задачей — щелчок из меню гасит синхронный. */
export function saveObjectUrl(href: string, name: string): void {
  window.setTimeout(() => {
    const link = document.createElement('a');
    link.href = href;
    link.download = name;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, 0);
}

async function runDownload(t: DownloadTarget): Promise<void> {
  const job = trackFileJob(t.key, 'download', t.size || 0);
  if (!job) return;
  const type = t.type || 'application/octet-stream';
  const rec = addDownload({ key: t.key, url: t.url, name: t.name, type, total: t.size || 0 });
  try {
    const blob = await fetchWithProgress(
      t.url,
      (loaded, total) => {
        if (!job.live()) return;
        const all = total || t.size || 0;
        job.progress(loaded, all);
        patchDownload(rec, { loaded, total: all });
      },
      job.signal,
      t.size,
    );
    if (!job.live()) {
      patchDownload(rec, { state: 'cancelled' });
      return;
    }
    // Тип — от вложения: «Открыть» в списке смотрит на него, а выдача публичных его не знает.
    const href = URL.createObjectURL(blob.slice(0, blob.size, type));
    patchDownload(rec, { state: 'done', loaded: blob.size, total: blob.size, href });
    saveObjectUrl(href, t.name);
  } catch {
    if (job.signal.aborted) {
      patchDownload(rec, { state: 'cancelled' });
      return;
    }
    patchDownload(rec, { state: 'failed' });
    toast('error', 'Не удалось скачать файл', t.name);
  } finally {
    job.end();
  }
}

/**
 * Начать скачивание (меню «Сохранить как…», «Повторить» в списке). Уже идёт — ничего; уже скачано в этом сеансе —
 * сохраняется то же самое без сети.
 */
export function startDownload(t: DownloadTarget): void {
  // Приложение Android со старым WebView (`legacyDownloadsAvailable` ниже): `blob:` там не сохранить — качает системный DownloadManager.
  if (legacyDownloadsAvailable()) {
    legacyDownloadWithToast(t.url, t.name, t.type, 'save');
    return;
  }
  const done = doneHrefOf(t.key);
  if (done) {
    saveObjectUrl(done, t.name);
    return;
  }
  void runDownload(t);
}

/** Щелчок по карточке файла, «⬇» у фото и видео, «Скачать» просмотра: идёт загрузка — отменить, иначе скачать. */
export function toggleDownload(t: DownloadTarget): void {
  if (cancelFileJob(t.key)) return;
  startDownload(t);
}

/** Есть ли у браузера системное «Поделиться» файлом (`navigator.canShare({ files })`: Edge и Chrome на Windows, телефоны). */
export function canShareFiles(): boolean {
  try {
    return (
      !filesViaNative() &&
      typeof navigator !== 'undefined' &&
      typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [new File([''], 'file.jpg', { type: 'image/jpeg' })] })
    );
  } catch {
    return false;
  }
}

/** Скачанный для «Поделиться» файл, если окно не открылось (жест пользователя истёк, пока качали): второе нажатие — сразу. */
const sharePrepared = new Map<string, File>();

/**
 * «Поделиться» в просмотре (G10, как «Поделиться» Telegram Android `PhotoViewer`): файл качается страницей (ход — строкой
 * под именем), потом системное окно `navigator.share({ files })`. Браузер пускает окно только вскоре после нажатия: большой
 * файл качался дольше — файл остаётся готовым, подпись просит нажать ещё раз (второй раз без загрузки). Отмена окна — молча.
 */
export async function shareDownload(t: DownloadTarget, note: (n: DownloadNote) => void): Promise<void> {
  let file = sharePrepared.get(t.key);
  if (!file) {
    try {
      const blob = await fetchWithProgress(
        t.url,
        (loaded, total) => note({ text: `Подготовка… ${Math.round(progressRatio(loaded, total) * 100)} %`, final: false }),
        undefined,
        t.size,
      );
      file = new File([blob], t.name, { type: t.type || blob.type || 'application/octet-stream' });
    } catch {
      note({ text: 'Не удалось скачать файл', final: true });
      return;
    }
  }
  if (!navigator.canShare({ files: [file] })) {
    note({ text: 'Этим файлом нельзя поделиться', final: true });
    return;
  }
  try {
    await navigator.share({ files: [file] });
    sharePrepared.delete(t.key);
    note({ text: '', final: true });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'AbortError') {
      sharePrepared.delete(t.key);
      note({ text: '', final: true });
    } else if (name === 'NotAllowedError') {
      sharePrepared.set(t.key, file);
      note({ text: 'Файл готов — нажмите «Поделиться» ещё раз', final: true });
    } else {
      note({ text: 'Не удалось поделиться', final: true });
    }
  }
}

/**
 * Файлы в приложении Android со СТАРЫМ WebView (приёмка S20+ 09.10, WebView 111). Моста медиа (`GusVoiceMedia`) там нет — ему
 * нужны сообщения с `ArrayBuffer` (WebView 119+), — и `filesViaNative()` ложно: страница качала файл сама и отдавала его
 * `<a download>` по `blob:`, а загрузок у WebView приложения нет — «Сохранить» / «Открыть» молчали. Здесь — строковый мост
 * `GusVoiceNative.downloadFile(json)` (`MainActivity.kt` → `LegacyDownloads.kt`; живёт здесь, а не отдельным модулем — `startDownload` и `FileCard` зовут одно и то же): системный DownloadManager кладёт файл в
 * «Загрузки/GusVoice» (ход — в шторке), «Открыть» открывает его по готовности. Натив сам проверяет, что ссылка — «Скачать»
 * своего инстанса (`/api/att/…` или `/api/download/attachment`); токен не передаётся (обе ссылки без входа).
 * APK без метода (старая сборка) — `available()` ложно, всё как было.
 */

interface LegacyBridge {
  downloadFile?: (json: string) => string;
}

function legacyBridge(): LegacyBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { GusVoiceNative?: LegacyBridge }).GusVoiceNative ?? null;
}

/** Есть ли путь «старый WebView»: приложение Android с методом `downloadFile`, но без моста медиа. */
export function legacyDownloadsAvailable(): boolean {
  if (filesViaNative()) return false;
  return typeof legacyBridge()?.downloadFile === 'function';
}

export type LegacyThen = 'save' | 'open';

/** Ответ натива: `ok`, `denied` (не своя ссылка), `bad`, `error`; сбой самого моста — `error`. */
export function legacyDownload(url: string, name: string, mime: string | undefined, then: LegacyThen): string {
  const b = legacyBridge();
  if (!b || typeof b.downloadFile !== 'function') return 'error';
  // Белый список адресов у натива — список входов (`NotifAuth`), его шлёт `nativeUnifiedPush.syncNotifAuth` при старте и входе.
  try {
    return String(b.downloadFile(JSON.stringify({ url, name, mime: mime ?? '', then })));
  } catch {
    return 'error';
  }
}

/** То же с тостом: «качается» или «не удалось». Истина — загрузка поставлена. */
export function legacyDownloadWithToast(url: string, name: string, mime: string | undefined, then: LegacyThen): boolean {
  const r = legacyDownload(url, name, mime, then);
  if (r === 'ok') {
    toast('info', 'Файл скачивается', then === 'open' ? 'Откроется, когда загрузится' : 'Он появится в «Загрузках»');
    return true;
  }
  toast('error', 'Не удалось скачать файл', name);
  return false;
}
