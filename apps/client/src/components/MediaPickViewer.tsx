import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatDuration } from '../attachRules';
import { galleryOriginal, galleryThumb, type GalleryItem } from '../nativeMedia';
import { Icon } from './Icon';

/** Что листает просмотр: элемент своей галереи или готовый файл (снимок системной камеры). */
export type PickEntry = { kind: 'gallery'; item: GalleryItem } | { kind: 'file'; file: File; url: string; video: boolean };

/** Сторона картинки просмотра в пикселях устройства: экран × плотность, не больше предела моста (`MediaBridge.thumb`, 1440). */
export function viewerPx(cssWidth: number, dpr: number): number {
  const px = Math.round(Math.max(1, cssWidth) * (Number.isFinite(dpr) && dpr > 0 ? dpr : 1));
  return Math.min(1440, Math.max(320, px));
}

/** Сколько соседних фото с каждой стороны тянуть крупно заранее (видео — только открытое: оно тяжёлое). */
const FULL_NEAR = 1;

/**
 * Видео больше этого, байт, само не тянется: кадр, длительность и «Видео N МБ» с кнопкой воспроизведения. Байты идут мостом
 * целиком до первого кадра (WebView не может играть `content://`, а MP4 камеры с `moov` в конце по частям не проигрывается —
 * см. `docs/codemap/client.md`, «порция 4»); замер эмулятора 10.10 — в карте.
 */
export const VIEW_AUTO_VIDEO_BYTES = 64 * 1024 * 1024;

type FullJob = { url: string | null; cancel: () => void; got: number; failed: boolean; lastTick: number };

function megabytesText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1).replace('.', ',')} МБ`;
}

/** Сдвиг пальца по горизонтали больше этого, px, — следующий / прошлый элемент. */
const SWIPE_PX = 60;

/**
 * Просмотр выбора в листе вложений — как Telegram Android `PhotoViewer.openPhotoForSelect` (tg-src
 * ChatAttachAlertPhotoLayout.java, строки 906-1052): тап по фото сетки открывает его крупно; листание пальцем по всей
 * галерее, кружок выбора с номером в углу, поле подписи и «Отправить» (ничего не выбрано — уходит открытое). Снимок системной
 * камеры — тот же просмотр с одним файлом, без кружка. Сначала — миниатюра моста размером экрана, следом крупно: фото — тем
 * же сжатием, что уйдёт (2560 px), видео — оригинал, играет со своими кнопками (Telegram `PhotoViewer` играет видео выбора
 * сразу). Тянется только открытый элемент и соседние фото (`galleryOriginal`, `FULL_NEAR`); пролистанное отменяется.
 */
export function MediaPickViewer({
  entries,
  start,
  numberOf,
  caption,
  counter,
  busy,
  onCaption,
  onToggle,
  onSend,
  onClose,
  maxBytes,
  onReady,
}: {
  entries: PickEntry[];
  start: number;
  /** Номер в выборе (0 — не выбран); у файлов кружка нет. */
  numberOf: (item: GalleryItem) => number;
  caption: string;
  counter: { text: string; over: boolean } | null;
  busy: boolean;
  onCaption: (text: string) => void;
  onToggle: (item: GalleryItem) => void;
  /** Отправить: `entry` — открытый сейчас (если выбора нет, уходит он). */
  onSend: (entry: PickEntry) => void;
  onClose: () => void;
  /** Предел файла беседы: крупнее — не тянем (и не отправить). */
  maxBytes?: number;
  /** Фото получено тем же сжатием, что уходит при отправке, — зовущий может отправить его, не сжимая второй раз. */
  onReady?: (item: GalleryItem, file: File) => void;
}) {
  const [index, setIndex] = useState(() => Math.min(Math.max(0, start), Math.max(0, entries.length - 1)));
  const entry = entries[index];
  const [src, setSrc] = useState<string | null>(null);
  const down = useRef<{ x: number; y: number } | null>(null);
  const full = useRef(new Map<string, FullJob>());
  const [, setFullTick] = useState(0);
  /** Крупное видео, которому нажали «играть» (`VIEW_AUTO_VIDEO_BYTES`). */
  const [allowBig, setAllowBig] = useState<string | null>(null);
  /** Ключ открытого элемента: эффекты не перезапускаются, когда зовущий пересобрал массив с теми же элементами. */
  const key = entry ? (entry.kind === 'gallery' ? `g${entry.item.id}` : entry.url) : '';

  // Крупно — открытое и соседние фото; ушедшее из окна отменяем и отпускаем.
  useEffect(() => {
    const want: GalleryItem[] = [];
    const cur = entries[index];
    if (cur?.kind === 'gallery' && (cur.item.kind === 'image' || cur.item.size <= VIEW_AUTO_VIDEO_BYTES || allowBig === cur.item.id)) {
      want.push(cur.item);
    }
    for (let d = 1; d <= FULL_NEAR; d++) {
      for (const e of [entries[index + d], entries[index - d]]) if (e?.kind === 'gallery' && e.item.kind === 'image') want.push(e.item);
    }
    const keep = new Set(want.map((i) => i.id));
    for (const [id, job] of full.current) {
      if (keep.has(id)) continue;
      job.cancel();
      if (job.url) URL.revokeObjectURL(job.url);
      full.current.delete(id);
    }
    let started = false;
    for (const it of want) {
      if (full.current.has(it.id)) continue;
      started = true;
      const job: FullJob = { url: null, cancel: () => undefined, got: 0, failed: false, lastTick: 0 };
      const run = galleryOriginal(it, maxBytes, (got) => {
        job.got = got;
        // Ход загрузки — не чаще раза в 150 мс (части по 512 КБ идут сотнями в секунду).
        const now = Date.now();
        if (now - job.lastTick > 150) {
          job.lastTick = now;
          setFullTick((t) => t + 1);
        }
      });
      job.cancel = run.cancel;
      full.current.set(it.id, job);
      void run.done.then((f) => {
        if (full.current.get(it.id) !== job) return;
        if (!f) {
          job.failed = true;
          setFullTick((t) => t + 1);
          return;
        }
        job.url = URL.createObjectURL(f);
        if (it.kind === 'image') onReady?.(it, f);
        setFullTick((t) => t + 1);
      });
    }
    // Загрузка живёт в ref: без перерисовки кнопка «Видео N МБ» висела бы до первой части потока.
    if (started) setFullTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, index, entries.length, allowBig]);

  useEffect(() => {
    const jobs = full.current;
    return () => {
      for (const job of jobs.values()) {
        job.cancel();
        if (job.url) URL.revokeObjectURL(job.url);
      }
      jobs.clear();
    };
  }, []);

  useEffect(() => {
    if (!entry) return;
    if (entry.kind === 'file') {
      setSrc(entry.url);
      return;
    }
    let on = true;
    let made: string | null = null;
    setSrc(null);
    void galleryThumb(entry.item, viewerPx(window.innerWidth, window.devicePixelRatio || 1)).then((u) => {
      if (!on) {
        if (u) URL.revokeObjectURL(u);
        return;
      }
      made = u;
      setSrc(u);
    });
    return () => {
      on = false;
      if (made) URL.revokeObjectURL(made);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!entry) return null;
  const job = entry.kind === 'gallery' ? full.current.get(entry.item.id) : undefined;
  const fullUrl = job?.url ?? null;
  /** Крупное видео ждёт нажатия «играть». */
  const bigWait = entry.kind === 'gallery' && entry.item.kind === 'video' && !job && entry.item.size > VIEW_AUTO_VIDEO_BYTES;
  const pct = job && !job.url && !job.failed && entry.kind === 'gallery' && entry.item.size > 0 ? Math.min(99, Math.floor((job.got / entry.item.size) * 100)) : null;
  const n = entry.kind === 'gallery' ? numberOf(entry.item) : 0;
  const video = entry.kind === 'gallery' ? entry.item.kind === 'video' : entry.video;
  const many = entries.length > 1;
  const go = (d: number) => setIndex((i) => Math.min(entries.length - 1, Math.max(0, i + d)));

  return createPortal(
    <div className="pick-viewer" role="dialog" aria-modal="true" aria-label="Просмотр" onContextMenu={(e) => e.preventDefault()}>
      <div
        className="pick-stage"
        onPointerDown={(e) => {
          // Полоса перемотки видео внизу — не листание: протяжка по ней иначе уводила на соседний элемент.
          const t = e.target as HTMLElement;
          if (t.tagName === 'VIDEO' && e.clientY > t.getBoundingClientRect().bottom - 64) {
            down.current = null;
            return;
          }
          down.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const d = down.current;
          down.current = null;
          if (!d || !many) return;
          const dx = e.clientX - d.x;
          if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(e.clientY - d.y)) go(dx < 0 ? 1 : -1);
        }}
        onPointerCancel={() => {
          down.current = null;
        }}
      >
        {entry.kind === 'file' && video ? (
          <video className="pick-media" src={entry.url} autoPlay loop playsInline controls />
        ) : video && fullUrl ? (
          <video key={fullUrl} className="pick-media" src={fullUrl} poster={src ?? undefined} autoPlay playsInline controls />
        ) : fullUrl || src ? (
          <img className="pick-media" src={fullUrl ?? src ?? undefined} alt="" draggable={false} />
        ) : (
          <span className="pick-wait" aria-hidden="true" />
        )}
        {entry.kind === 'gallery' && video && bigWait && (
          <button type="button" className="pick-play" aria-label="Смотреть видео" onClick={() => setAllowBig(entry.item.id)}>
            <Icon name="play" size={30} />
            <span>Видео {megabytesText(entry.item.size)}</span>
          </button>
        )}
        {entry.kind === 'gallery' && video && !fullUrl && !bigWait && !job?.failed && (
          <span className="pick-load" aria-live="polite">
            <span className="pick-wait" aria-hidden="true" />
            {pct !== null && pct > 0 && <span>{pct}%</span>}
          </span>
        )}
        {entry.kind === 'gallery' && video && job?.failed && <span className="pick-load">Видео не открылось</span>}
        {entry.kind === 'gallery' && video && !fullUrl && (
          <span className="pick-dur">
            <Icon name="play" size={14} />
            {formatDuration(entry.item.durationMs)}
          </span>
        )}
      </div>
      <div className="pick-top">
        <button type="button" className="pick-close" aria-label="Закрыть" onClick={onClose}>
          <Icon name="chevron-left" size={24} />
        </button>
        {many && (
          <span className="pick-pos">
            {index + 1} из {entries.length}
          </span>
        )}
        {entry.kind === 'gallery' && (
          <button
            type="button"
            className={`pick-check${n ? ' on' : ''}`}
            aria-pressed={n > 0}
            aria-label={n ? `Выбрано ${n}, убрать` : 'Выбрать'}
            onClick={() => onToggle(entry.item)}
          >
            {n || ''}
          </button>
        )}
      </div>
      <div className="pick-bar">
        <label className="gal-caption">
          <textarea
            rows={1}
            value={caption}
            placeholder="Добавить подпись…"
            onChange={(e) => {
              onCaption(e.target.value);
              const t = e.currentTarget;
              t.style.height = 'auto';
              t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
            }}
          />
          {counter && (
            <span className={counter.over ? 'send-count gal over' : 'send-count gal'} aria-live="polite">
              {counter.text}
            </span>
          )}
        </label>
        <button type="button" className="gal-send-btn" aria-label="Отправить" disabled={busy} onClick={() => onSend(entry)}>
          <Icon name="send" size={22} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
