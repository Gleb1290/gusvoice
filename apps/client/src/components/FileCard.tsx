import type { Attachment } from '@gusvoice/shared';
import { useSyncExternalStore } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  attachmentKey,
  fileJobOf,
  filesViaNative,
  openAttachmentFile,
  progressRatio,
  progressText,
  saveAttachmentFile,
  subscribeFileJobs,
  type FileJob,
} from '../fileActions';
import { confirmLaunch } from '../fileLaunch';
import {
  attachmentTarget, desktopFileOpenAvailable, isOpeningDownloadedFile, legacyDownloadWithToast, legacyDownloadsAvailable,
  openDownloadedFile, ringDownloads, subscribeDownloadedFileOpening, toggleDownload,
} from '../pcDownloads';
import { Icon } from './Icon';

/**
 * Карточка файла в ленте и «⬇» у фото и видео (06.10). Веб, десктоп и браузер телефона — прежняя ссылка на выдачу
 * бэкенда с `Content-Disposition: attachment`: загрузку делает браузер или оболочка. Приложение Android (мост медиа,
 * `fileActions.ts`): нажатие на карточку — скачать с прогрессом и открыть системным приложением, «⬇» — в «Загрузки»;
 * пока файл качается, вместо скрепки — кольцо прогресса с крестиком (нажатие — отмена), вместо веса — «пришло / всего».
 * ПК и браузер телефона (`pcDownloads.ts`): скачивание с кольцом и отменой. В Windows нажатие по карточке открывает
 * готовый локальный файл; «⬇» сохраняет копию. Средняя кнопка и Ctrl / Shift оставляют переход по ссылке.
 */

/** Идущая загрузка этого вложения (общая для карточки, «⬇» и повторно смонтированной строки). */
function useFileJob(a: Attachment): FileJob | null {
  const key = attachmentKey(a);
  return useSyncExternalStore(subscribeFileJobs, () => fileJobOf(key));
}

/** Кольцо прогресса (как у Telegram на файле): дуга — доля, внутри — крестик «отменить». */
export function ProgressRing({ ratio }: { ratio: number }) {
  const r = 8;
  const len = 2 * Math.PI * r;
  return (
    <span className="att-ring" aria-hidden="true">
      <svg className="att-ring-arc" viewBox="0 0 20 20" width="20" height="20">
        <circle className="att-ring-track" cx="10" cy="10" r={r} />
        <circle
          className="att-ring-bar"
          cx="10"
          cy="10"
          r={r}
          strokeDasharray={`${(len * ratio).toFixed(2)} ${len.toFixed(2)}`}
          transform="rotate(-90 10 10)"
        />
      </svg>
      <Icon name="close" size={10} />
    </span>
  );
}

/** Карточка файла (не картинка, не видео, не голосовое). `sizeLabel` — вес так, как его пишет лента. */
export function FileCard({ a, href, sizeLabel }: { a: Attachment; href: string; sizeLabel: string }) {
  const job = useFileJob(a);
  const desktop = desktopFileOpenAvailable();
  const key = attachmentKey(a);
  const opening = useSyncExternalStore(subscribeDownloadedFileOpening, () => desktop && isOpeningDownloadedFile(key), () => false);
  if (!filesViaNative() && ringDownloads()) {
    const onClick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
      if (desktop && isOpeningDownloadedFile(key)) {
        e.preventDefault();
        return;
      }
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      const t = attachmentTarget(a);
      const save = (e.target as Element).closest('.att-file-dl');
      // Приложение со старым WebView (`pcDownloads.legacyDownloadsAvailable`): «⬇» — в «Загрузки», нажатие на карточку — скачать и открыть.
      if (legacyDownloadsAvailable() && !job) {
        if (save) legacyDownloadWithToast(t.url, t.name, t.type, 'save');
        else void confirmLaunch(a.name).then((ok) => ok && legacyDownloadWithToast(t.url, t.name, t.type, 'open'));
        return;
      }
      if (!save && desktop) void openDownloadedFile(t);
      else toggleDownload(t);
    };
    return (
      <a
        href={href}
        className={`att-file${job ? ' busy' : ''}${opening ? ' att-file-opening' : ''}`}
        title={opening ? 'Открывается…' : job ? 'Отменить загрузку' : desktop ? a.name : `Скачать ${a.name}`}
        aria-busy={opening || undefined}
        aria-disabled={opening || undefined}
        onClick={onClick}
        data-att={attachmentKey(a)}
      >
        <span className="att-file-icon">
          {job ? <ProgressRing ratio={progressRatio(job.loaded, job.total)} /> : <Icon name="paperclip" size={16} />}
        </span>
        <span className="att-file-name">{a.name}</span>
        <span className="att-file-size">{opening ? 'Открывается…' : job ? progressText(job.loaded, job.total) : sizeLabel}</span>
        {job ? null : (
          <span className="att-file-dl" title={desktop ? 'Скачать' : undefined}>
            <Icon name="download" size={15} />
          </span>
        )}
      </a>
    );
  }
  if (!filesViaNative()) {
    return (
      <a href={href} className="att-file" title={`Скачать ${a.name}`} data-att={attachmentKey(a)}>
        <span className="att-file-icon">
          <Icon name="paperclip" size={16} />
        </span>
        <span className="att-file-name">{a.name}</span>
        <span className="att-file-size">{sizeLabel}</span>
        <span className="att-file-dl">
          <Icon name="download" size={15} />
        </span>
      </a>
    );
  }
  // Приложение: ссылка остаётся ссылкой (тот же вид, фокус, долгое нажатие), но переход гасим — делает натив.
  const onClick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (!job && (e.target as Element).closest('.att-file-dl')) saveAttachmentFile(a);
    else if (job) openAttachmentFile(a); // идёт загрузка — повторное нажатие отменяет, спрашивать нечего
    // G77: исполняемое и неизвестное — сперва окно «Запустить / Открыть?» (`fileLaunch.ts`), потом загрузка и ACTION_VIEW.
    else void confirmLaunch(a.name).then((ok) => ok && openAttachmentFile(a));
  };
  return (
    <a
      href={href}
      className={job ? 'att-file busy' : 'att-file'}
      title={job ? 'Отменить' : `Открыть ${a.name}`}
      onClick={onClick}
      data-att={attachmentKey(a)}
    >
      <span className="att-file-icon">
        {job ? <ProgressRing ratio={progressRatio(job.loaded, job.total)} /> : <Icon name="paperclip" size={16} />}
      </span>
      <span className="att-file-name">{a.name}</span>
      <span className="att-file-size">{job ? progressText(job.loaded, job.total) : sizeLabel}</span>
      {job ? null : (
        <span className="att-file-dl" title="Скачать в «Загрузки»">
          <Icon name="download" size={15} />
        </span>
      )}
    </a>
  );
}

/**
 * «⬇» в углу фото и видео (в пузырях ЛС скрыт стилями — там «Скачать» в просмотре). Приложение: в «Загрузки», пока
 * качается — кольцо; повторное нажатие — отмена.
 */
export function DownloadBadge({ a, href, cls = 'att-dl' }: { a: Attachment; href: string; /** Класс значка: в углу картинки — `att-dl`, в строке карточки звука — `att-file-dl`. */ cls?: string }) {
  const job = useFileJob(a);
  const onClick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation();
    if (!filesViaNative()) {
      // ПК (G31): скачать страницей с кольцом и отменой; без потоков — ссылка как была.
      if (!ringDownloads() || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      toggleDownload(attachmentTarget(a));
      return;
    }
    e.preventDefault();
    saveAttachmentFile(a);
  };
  return (
    <a className={job ? `${cls} busy` : cls} href={href} title={job ? 'Отменить загрузку' : 'Скачать'} onClick={onClick}>
      {job ? <ProgressRing ratio={progressRatio(job.loaded, job.total)} /> : <Icon name="download" size={15} />}
    </a>
  );
}
