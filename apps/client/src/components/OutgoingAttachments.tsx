import type { Attachment } from '@gusvoice/shared';
import { memo, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { progressRatio, progressText } from '../fileActions';
import { attachmentBox, measureMediaFile } from '../imageSize';
import { subscribeUpload, uploadOf } from '../uploadProgress';
import { ATT_IMG_MAX_H, ATT_IMG_MAX_W, isImage, isVideo, kb } from './AttachmentView';
import { ProgressRing } from './FileCard';
import { Icon } from './Icon';
import { SpoilerParticles } from './SpoilerCover';

/**
 * Вложения строки «в пути» (порция «Отправка», 07.10; Telegram `04-media-gestures.md` FA-01, `01-message.md` 1.24/6.22):
 * фото и видео — сразу миниатюрой с устройства, а поверх — кольцо загрузки с крестиком (нажатие — «Отменить отправку»);
 * у файла кольцо с крестиком стоит на месте значка, вместо веса — «ушло / всего». Вид — те же классы, что у вложения
 * сохранённого сообщения (`AttachmentView`, `FileCard`): по ответу сервера строка сменяется сообщением без прыжка.
 *
 * Размер кадра меряется на устройстве (`measureMediaFile`) один раз на файл; ленту об этом извещает `useLocalDims` — без
 * размера одиночное фото рисуется обычным пузырём, как старое вложение без размера (`bubbleLook`).
 */

type Dims = { width: number; height: number; durationMs?: number } | null;
const dims = new WeakMap<File, Dims | 'pending'>();
const dimListeners = new Set<() => void>();
let dimVersion = 0;

function measure(file: File): Dims {
  const known = dims.get(file);
  if (known !== undefined) return known === 'pending' ? null : known;
  if (!isImage(file.type) && !isVideo(file.type)) {
    dims.set(file, null);
    return null;
  }
  dims.set(file, 'pending');
  void measureMediaFile(file)
    .catch(() => null)
    .then((d) => {
      dims.set(file, d);
      dimVersion++;
      for (const fn of dimListeners) fn();
    });
  return null;
}

function subscribeDims(fn: () => void): () => void {
  dimListeners.add(fn);
  return () => {
    dimListeners.delete(fn);
  };
}

/** Лента перерисовывается, когда у какого-то файла «в пути» стал известен размер (раз на файл). */
export function useLocalDims(): number {
  return useSyncExternalStore(subscribeDims, () => dimVersion);
}

/**
 * Файлы строки как вложения — для `bubbleLook` (вид пузыря тот же, что будет у сообщения). Ссылки здесь нет: миниатюру
 * рисует `OutgoingAttachments` по своей ссылке на файл.
 */
export function localAttachments(files: readonly File[]): Attachment[] {
  return files.map((f, i) => {
    const d = measure(f);
    return {
      id: `local-${i}`,
      url: '',
      name: f.name,
      contentType: f.type || 'application/octet-stream',
      size: f.size,
      width: d?.width ?? null,
      height: d?.height ?? null,
      durationMs: d?.durationMs ?? null,
    } as Attachment;
  });
}

/** Ссылки на файлы с устройства — на время жизни строки (уходит строка — ссылки гасятся). */
function useObjectUrls(files: readonly File[]): string[] {
  const urls = useMemo(
    () => files.map((f) => (isImage(f.type) || isVideo(f.type) ? URL.createObjectURL(f) : '')),
    [files],
  );
  useEffect(
    () => () => {
      for (const u of urls) if (u) URL.revokeObjectURL(u);
    },
    [urls],
  );
  return urls;
}

function useUpload(rowKey: string, index: number) {
  const subscribe = useCallback((fn: () => void) => subscribeUpload(rowKey, fn), [rowKey]);
  return useSyncExternalStore(subscribe, () => uploadOf(rowKey, index));
}

/** Кольцо загрузки файла `index` строки `rowKey` с крестиком «Отменить отправку». Загружен — кольца нет. */
function UploadRing({
  rowKey,
  index,
  onCancel,
  media,
}: {
  rowKey: string;
  index: number;
  onCancel: (rowKey: string) => void;
  media: boolean;
}) {
  const up = useUpload(rowKey, index);
  if (up?.done) return null;
  const ratio = up ? progressRatio(up.loaded, up.total) : 0;
  return (
    <button
      type="button"
      className={media ? 'att-up' : 'att-up att-up-file'}
      aria-label="Отменить отправку"
      title="Отменить отправку"
      onClick={(e) => {
        e.stopPropagation();
        onCancel(rowKey);
      }}
    >
      <ProgressRing ratio={ratio} />
    </button>
  );
}

/** «ушло / всего» у файла, пока грузится; загружен или не начинал — вес. */
function UploadSize({ rowKey, index, size }: { rowKey: string; index: number; size: number }) {
  const up = useUpload(rowKey, index);
  return <span className="att-file-size">{up && !up.done && up.total > 0 ? progressText(up.loaded, up.total) : kb(size)}</span>;
}

export const OutgoingAttachments = memo(function OutgoingAttachments({
  rowKey,
  files,
  uploaded,
  spoilers,
  sending,
  fill,
  onCancel,
}: {
  rowKey: string;
  files: readonly File[];
  /** Какие файлы уже на сервере (очередь ЛС помнит это между попытками); нет — судим по `uploadProgress`. */
  uploaded?: readonly unknown[];
  /** Индексы файлов под спойлером (G48, `media2`): у отправителя кадр «в пути» тоже размыт — не показываем то, что скрыто от других. */
  spoilers?: readonly number[];
  /** Строка ещё отправляется: кольца есть. «Не отправлено» — без колец (там «Повторить»). */
  sending: boolean;
  /** Ячейки альбома: размер задаёт сетка (`AttachmentView` `fill`). */
  fill: boolean;
  /** «Отменить отправку» строки (стабильная функция — строка не перерисовывается на каждую букву в поле). */
  onCancel: (rowKey: string) => void;
}) {
  const urls = useObjectUrls(files);
  return (
    <>
      {files.map((f, i) => {
        const ring = sending && !uploaded?.[i] ? <UploadRing rowKey={rowKey} index={i} onCancel={onCancel} media={!!urls[i]} /> : null;
        if (urls[i]) {
          const d = measure(f);
          const box = fill ? null : attachmentBox(d?.width ?? null, d?.height ?? null, ATT_IMG_MAX_W, ATT_IMG_MAX_H);
          const style = box ? { width: box.width, aspectRatio: `${box.width} / ${box.height}` } : undefined;
          return (
            <div
              key={i}
              className={`${isVideo(f.type) ? 'att-img-wrap att-video att-out' : 'att-img-wrap att-out'}${spoilers?.includes(i) ? ' spoiled' : ''}`}
            >
              {isVideo(f.type) ? (
                <video className="att-img" src={urls[i]} muted playsInline preload="metadata" style={style} />
              ) : (
                <img className="att-img" src={urls[i]} alt={f.name} style={style} />
              )}
              {spoilers?.includes(i) ? <SpoilerParticles /> : null}
              {ring}
            </div>
          );
        }
        return (
          <span key={i} className={ring ? 'att-file att-out busy' : 'att-file att-out'} title={f.name}>
            <span className="att-file-icon">{ring ?? <Icon name="paperclip" size={16} />}</span>
            <span className="att-file-name">{f.name}</span>
            <UploadSize rowKey={rowKey} index={i} size={f.size} />
          </span>
        );
      })}
    </>
  );
});
