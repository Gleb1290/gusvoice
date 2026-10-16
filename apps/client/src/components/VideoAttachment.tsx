import { formatDuration, type Attachment } from '@gusvoice/shared';
import { useEffect, useRef, useState } from 'react';
import { attachmentKey } from '../fileActions';
import { attachmentBox } from '../imageSize';
import { toast } from '../toast';
import { openPip, pipSupported } from '../videoPip';
import { DownloadBadge, FileCard } from './FileCard';
import { Icon } from './Icon';
import { SpoilerCover } from './SpoilerCover';

/**
 * Видео в ленте (06.10, как у Telegram): не карточка файла, а кадр с кнопкой ▶ и длительностью; нажатие — просмотр на весь
 * экран (`Lightbox`, тот же набор, что у фото). Кадр — сам `<video preload="metadata">` без своего сервера превью:
 * браузер берёт только начало файла (метаданные и первый кадр, диапазонами), большое видео заранее целиком не качается.
 * Ссылка — сама `a.url` (у `<video>` CORS не нужен; выдача закрытых файлов ЛС и хранилище отдают диапазоны — перемотка).
 *
 * 🔴 **Почему `#t=0.1` и прозрачный `poster`** (стенд 06.10, Android WebView 145): без постера WebView рисует на месте
 * видео свою серую заглушку с ▶ — даже когда кадр уже есть (`readyState` 4), пока не было ни воспроизведения, ни перехода.
 * Фрагмент `#t=0.1` — начальный переход: кадр показывается. Прозрачный постер закрывает заглушку до первого кадра.
 *
 * Место — по подсказке размера во вложении (сервер хранит её у видео с 06.10), нет её — 16:9 до метаданных; пришли
 * метаданные — по ним. Длительность — так же: метаданные, иначе подсказка.
 *
 * Не играет (кодек, повреждён) — вместо кадра карточка файла: в приложении её откроет системный плеер, в вебе — скачать.
 * Ячейка альбома (`fill`) остаётся ячейкой: просмотр скажет, что видео не играет, а «Скачать» там есть.
 *
 * «Картинка в картинке» (решение владельца Р-3, волна 6): кнопка у кадра рядом со «Скачать» (на ПК — при наведении, как
 * она) — видео сразу играет в плавающем окошке (`videoPip.openPip`), лента остаётся под рукой. Нет API (Android WebView)
 * — кнопки нет. Атрибут `disablePictureInPicture` у кадра снят: он стоял с первой версии видео (06.10) без причины.
 */

/** Прозрачная точка вместо постера (см. выше). */
export const BLANK_POSTER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Адрес для кадра в ленте: с 0,1 с (см. выше). Свой фрагмент у ссылки уже есть — не трогаем. */
export function videoFrameSrc(url: string): string {
  return url.includes('#') ? url : `${url}#t=0.1`;
}

/**
 * Беззвучное видео в ленте играет, пока хоть часть его на экране, и стоит, когда ушло за край (решение владельца 15, D6; у
 * Telegram так же: играет видимое). Корень наблюдателя — окно (`null`): пересечение считается и с обрезкой прокручиваемой
 * лентой, отдельный корень не нужен. Первое срабатывание приходит сразу после `observe` — ролик, смонтированный за краем
 * (подгрузка вверх), встаёт, не успев пойти. Возвращает отмену. Нет `IntersectionObserver` — играет как раньше.
 */
export function playWhileVisible(v: HTMLVideoElement): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {};
  const io = new IntersectionObserver((entries) => {
    const e = entries[entries.length - 1];
    if (!e) return;
    if (e.isIntersecting) void v.play().catch(() => {});
    else v.pause();
  });
  io.observe(v);
  return () => io.disconnect();
}

/** Длительность из метаданных, мс; поток без длительности (запись MediaRecorder — `Infinity`) — 0. */
export function durationOf(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

/**
 * Сколько осталось у играющего в ленте видео, мс, целыми секундами вниз — как у Telegram: Web K пишет
 * `toHHMMSS(video.duration − video.currentTime)` (`tweb/src/components/wrappers/video.ts:555-566`), Android —
 * `duration − currentProgressMs / 1000` (`ChatMessageCell.java:5644-5658`). Длительности нет (поток, метаданные не пришли) — `null`:
 * подпись остаётся полной длительностью.
 */
export function videoTimeLeftMs(duration: number, currentTime: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const t = Number.isFinite(currentTime) && currentTime > 0 ? currentTime : 0;
  return Math.max(0, Math.floor(duration - t)) * 1000;
}

/** Нет размера во вложении (старое, или отправитель не померил) — место 16:9, пока не придут метаданные. */
const FALLBACK_W = 1280;
const FALLBACK_H = 720;

export function VideoAttachment({
  a,
  href,
  sizeLabel,
  onOpen,
  fill = false,
  maxW,
  maxH,
  hidden = false,
  autoplay,
}: {
  a: Attachment;
  /** «Скачать» — выдача бэкенда (`api.attachmentDownloadUrl`). */
  href: string;
  sizeLabel: string;
  onOpen?: (a: Attachment) => void;
  /** Ячейка альбома: размер задаёт сетка. */
  fill?: boolean;
  maxW: number;
  maxH: number;
  /** Под спойлером (G48, `media2`): кадр размыт и закрыт крышкой, без ▶ и «⬇» — до нажатия смотрящего. */
  hidden?: boolean;
  /**
   * Играть в ленте само, без звука и по кругу («Данные и память» → «Автовоспроизведение», G32, `autoDownloadRules.ts`).
   * Не задано — как до G32: GIF играет, видео — кадр с ▶.
   */
  autoplay?: boolean;
}) {
  const [meta, setMeta] = useState<{ w: number; h: number; ms: number } | null>(null);
  const [failed, setFailed] = useState(false);
  // Остаток играющего без звука видео (#218): `null` — ещё не играло, в подписи полная длительность.
  const [left, setLeft] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const gifFlag = a.gif === true;
  const playing = autoplay ?? gifFlag;
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !playing || failed) return;
    return playWhileVisible(v);
  }, [playing, failed, a.url]);
  /* Обратный отсчёт в подписи, пока видео играет само (не GIF): `timeupdate` идёт ~4 раза в секунду, а состояние меняется
     только со сменой целой секунды — перерисовка раз в 1 с, как `throttle(…, 1e3)` у Web K. На паузе (ушло за край) подпись
     стоит на последнем значении, на повторе (`loop`) снова начинается с полной длительности. */
  useEffect(() => {
    const v = videoRef.current;
    setLeft(null);
    if (!v || !playing || gifFlag || failed) return;
    const tick = () => setLeft(videoTimeLeftMs(v.duration, v.currentTime));
    v.addEventListener('timeupdate', tick);
    return () => v.removeEventListener('timeupdate', tick);
  }, [playing, gifFlag, failed, a.url]);
  if (failed && !fill) return <FileCard a={a} href={href} sizeLabel={sizeLabel} />;
  // Метаданные файла важнее подсказки отправителя: подсказка задаёт место сразу, файл его поправит, если она соврала.
  const w = meta?.w || a.width || FALLBACK_W;
  const h = meta?.h || a.height || FALLBACK_H;
  const box = fill ? null : attachmentBox(w, h, maxW, maxH);
  const ms = meta?.ms || a.durationMs || 0;
  // GIF (`gifs1`, Р-7, как у Telegram: mp4 без звука — `data_document.cpp` `isAnimation`): играет сам, по кругу, без
  // звука и без значка «▶»; в углу — «GIF»; нажатие — просмотрщик, как у видео.
  const gif = a.gif === true;
  const play = autoplay ?? gif;
  return (
    <div className={`att-img-wrap${hidden ? ' spoiled' : ''}`}>
      <button
        type="button"
        className="att-img-link att-video"
        data-att={attachmentKey(a)}
        title={a.name}
        aria-label={gif ? 'GIF' : ms ? `Видео, ${formatDuration(ms)}` : 'Видео'}
        onClick={() => onOpen?.(a)}
      >
        <video
          ref={videoRef}
          className="att-img"
          src={play ? a.url : videoFrameSrc(a.url)}
          poster={BLANK_POSTER}
          preload={play ? 'auto' : 'metadata'}
          autoPlay={play}
          loop={play}
          muted
          playsInline
          disableRemotePlayback
          tabIndex={-1}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setMeta({ w: v.videoWidth, h: v.videoHeight, ms: durationOf(v.duration) });
          }}
          onError={() => setFailed(true)}
          /* Пропорция — без `auto` (у картинки он есть): до метаданных «родной» размер у `<video>` даёт постер — точка 1×1,
             и с `auto` кадр стоял квадратом, пока не придёт начало файла (стенд 06.10, медленная сеть). */
          style={box ? { width: box.width, aspectRatio: `${box.width} / ${box.height}` } : undefined}
        />
        {gif ? (
          <span className="att-dur" aria-hidden="true">
            GIF
          </span>
        ) : null}
        {/* ▶ — у всего, что само не играет: видео без автовоспроизведения и GIF, у которого его выключили (G32). */}
        {!play ? (
          <span className="att-play" aria-hidden="true">
            <Icon name="play" size={20} />
          </span>
        ) : null}
        {/* Играет само — остаток и значок «без звука» справа от времени (Web K `video.ts:126-146` `nosound_filled`, Android
            `chat_msgNoSoundDrawable` `ChatMessageCell.java:25069-25082`); не играет — полная длительность и ▶. */}
        {!gif && ms > 0 ? (
          <span className={`att-dur${play ? ' muted' : ''}`} aria-hidden="true">
            {formatDuration(play && left !== null ? left : ms)}
            {play ? <Icon name="volume-off" size={12} /> : null}
          </span>
        ) : null}
      </button>
      <DownloadBadge a={a} href={href} />
      {hidden && <SpoilerCover a={a} />}
      {pipSupported() && !fill && !gif && !hidden ? (
        <button
          type="button"
          className="att-pip"
          title="Картинка в картинке"
          aria-label="Картинка в картинке"
          onClick={(e) => {
            e.stopPropagation();
            openPip({ url: a.url }).catch(() => toast('error', 'Не удалось открыть «Картинку в картинке»'));
          }}
        >
          <Icon name="pip" size={16} />
        </button>
      ) : null}
    </div>
  );
}
