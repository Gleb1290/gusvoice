import { formatDuration, isMusicFile, isRoundVideo, isVoiceMessage, type Attachment } from '@gusvoice/shared';
import { useState } from 'react';
import { api } from '../api';
import { loadedByHandHas, markLoadedByHand, saveDataOn, useAutoDownload, useAutoLoad } from '../autoDownload';
import { shouldAutoplayRound } from '../autoDownloadRules';
import { attachmentBox } from '../imageSize';
// Файлы и видео в ленте (06.10): карточка файла и «⬇» (в приложении Android — натив), видео — кадр с ▶.
import { DownloadBadge, FileCard } from './FileCard';
import { attachmentKey, sizeText } from '../fileActions';
import { Icon } from './Icon';
import { SpoilerCover, useSpoilerHidden } from './SpoilerCover';
import { VideoAttachment } from './VideoAttachment';
import { RoundVideo } from './RoundVideo';
import { MusicFileCard, VoiceMessage, type VoiceMeta } from './VoiceMessage';

/**
 * Вложение в ленте — картинка, видео, голосовое или карточка файла. Вынесено из `MessagePane` (06.10), чтобы вид «Отложенные»
 * (`ScheduledView`, отложенные с вложениями — признак сервера `conv10`) рисовал файлы ровно как лента: те же классы, место
 * под картинку по размеру, заглушка без ссылки, скачивание через бэкенд. Видео (06.10) — кадр с ▶ и длительностью
 * (`VideoAttachment`), не карточка; карточка файла и «⬇» — `FileCard.tsx` (в приложении Android — открыть / в «Загрузки»).
 */

export const isImage = (ct: string) => ct.startsWith('image/');
/** Видео (06.10) — кадр с ▶ в ленте и просмотр на весь экран, как фото; не карточка файла. */
export const isVideo = (ct: string) => ct.startsWith('video/');
/** Потолок картинки в ленте — те же числа, что в `.att-img` (styles.css): 360 × 300. */
export const ATT_IMG_MAX_W = 360;
export const ATT_IMG_MAX_H = 300;
/** Вес под карточкой, кадром видео и в полосе прикреплённого — правилом `fileActions.sizeText` (одно на всех: «12 KB», меньше
 * килобайта — «1 KB», 06.10). */
export const kb = sizeText;

/**
 * `fill` — ячейка альбома (раунд 10): размер задаёт сетка, картинка её заполняет, поэтому ни ширины, ни пропорции в
 * стиле — иначе встроенный стиль перебил бы сетку.
 */
export function AttachmentView({
  a,
  onOpen,
  fill = false,
  voice,
}: {
  a: Attachment;
  onOpen?: (a: Attachment) => void;
  fill?: boolean;
  /** Сообщение голосового (07.10, G12): «не прослушано» и автопереход; нет — отложенные и прочие места без точек. */
  voice?: VoiceMeta;
}) {
  // Спойлер (G48, `media2`): фото и видео размыты и закрыты крышкой, пока смотрящий не нажмёт (локально).
  const hidden = useSpoilerHidden(a);
  // «Данные и память» (G32): грузить ли сразу и играть ли само — правило `autoDownloadRules.ts`, источник ленты — из
  // `MessagePane` (`AutoDownloadSource`). «Скачать» нажато — помним до перезагрузки (`loadedByHand`).
  const auto = useAutoLoad(a);
  // Кружок играет сам по своему переключателю «Видеосообщения» (tdesktop: отдельный тип `AutoPlayVideoMessage`).
  const autoSettings = useAutoDownload();
  const roundAutoplay = shouldAutoplayRound(autoSettings, saveDataOn());
  const key = attachmentKey(a);
  const [byHand, setByHand] = useState(() => loadedByHandHas(key));
  // B12: файла нет в хранилище / не картинка — вместо сырой браузерной «битой» картинки аккуратная плитка (как Telegram).
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  /* Закрытый файл ЛС из кеша на диске (этап 2, шаг 2б): ссылки нет — она своя у каждого и гаснет, поэтому не
     кешируется. Держим место по размеру и ждём свежую порцию — она приносит ссылку за доли секунды. */
  // Э3 (#141, `fedm3`): копия файла с инстанса автора ещё едет — к файлу не обращаемся (отдача ответила бы 503), рисуем заглушку «Загружается…».
  if (a.fedState === 'copying') return <CopyingAttachment a={a} fill={fill} />;
  if (!a.url) {
    // Видео держит место так же, как фото: в ленте оно тоже кадр, а не карточка (06.10).
    if (!a.asFile && (isImage(a.contentType) || isVideo(a.contentType))) {
      const box = fill ? null : attachmentBox(a.width, a.height, ATT_IMG_MAX_W, ATT_IMG_MAX_H);
      return (
        <div
          className="att-img att-pending"
          aria-label={a.name}
          style={box ? { width: box.width, aspectRatio: `${box.width} / ${box.height}` } : undefined}
        />
      );
    }
    return (
      <span className="att-file att-pending" title={a.name}>
        <span className="att-file-icon">
          <Icon name="paperclip" size={16} />
        </span>
        <span className="att-file-name">{a.name}</span>
        <span className="att-file-size">{kb(a.size)}</span>
      </span>
    );
  }
  // Real download goes through the backend (Content-Disposition: attachment) — the
  // <a download> attribute is ignored cross-origin, so a plain MinIO link just NAVIGATES.
  const dl = api.attachmentDownloadUrl(a);
  // Одноразовое фото/видео (`ttlmedia1`, #226): закрытая плитка, кадр не показываем; открыть может только получатель.
  if (onceMediaTile(a)) return <OnceMediaTile a={a} mine={!!voice?.mine} fill={fill} onOpen={onOpen} />;
  // Голосовое (#20) — плеер с полоской, а не карточка файла. Признак — огибающая на вложении;
  // просто скинутый mp3 остаётся файлом, полоски у него нет.
  if (isVoiceMessage(a)) return <VoiceMessage a={a} meta={voice} />;
  // Кружок (`circles1`, G68): круг в ленте, беззвучно по кругу, нажатие — со звуком. «Данные и память» решают, качать ли
  // его сразу и играть ли само (как видео); не качается — обычная заглушка ниже.
  if (isRoundVideo(a) && (auto.load || byHand)) return <RoundVideo a={a} meta={voice} autoplay={roundAutoplay} />;
  // «Отправить как файл» (G48): картинка и видео — карточкой файла, без кадра и просмотра.
  if (a.asFile) return <FileCard a={a} href={dl} sizeLabel={kb(a.size)} />;
  // Не под автозагрузкой (G32) — заглушка с весом и «Скачать», ничего не качаем, пока не нажмут.
  if (!auto.load && !byHand && (auto.kind === 'photo' || auto.kind === 'video' || auto.kind === 'gif')) {
    return (
      <MediaStub
        a={a}
        kind={auto.kind}
        fill={fill}
        onLoad={() => {
          markLoadedByHand(key);
          setByHand(true);
          // Видео — сразу просмотр (там оно играет с докачкой), как у Telegram; фото и GIF — догружаются на месте.
          if (auto.kind === 'video') onOpen?.(a);
        }}
      />
    );
  }
  if (isVideo(a.contentType)) {
    return (
      <VideoAttachment
        a={a}
        href={dl}
        sizeLabel={kb(a.size)}
        onOpen={onOpen}
        fill={fill}
        maxW={ATT_IMG_MAX_W}
        maxH={ATT_IMG_MAX_H}
        hidden={hidden}
        autoplay={auto.autoplay}
      />
    );
  }
  if (isImage(a.contentType)) {
    const box = fill ? null : attachmentBox(a.width, a.height, ATT_IMG_MAX_W, ATT_IMG_MAX_H);
    if (brokenUrl === a.url) {
      return (
        <div
          className="att-img att-pending att-broken"
          role="img"
          aria-label={a.name}
          title={a.name}
          style={box ? { width: box.width, aspectRatio: `${box.width} / ${box.height}` } : undefined}
        >
          <Icon name="photo" size={32} />
        </div>
      );
    }
    return (
      <div className={`att-img-wrap${hidden ? ' spoiled' : ''}`}>
        <button type="button" className="att-img-link" title={a.name} onClick={() => onOpen?.(a)}>
          {/* data-ctxsave: это КОНТЕНТ — правый клик оставляет «Сохранить изображение» (#75). */}
          {/* Место под картинку — заранее, по размеру из вложения (#194): иначе лента прыгает, пока
              картинки догружаются. `auto` в пропорции — после загрузки верх берёт настоящий файл. */}
          <img
            className="att-img"
            data-ctxsave
            src={a.url}
            alt={a.name}
            loading="lazy"
            onError={() => setBrokenUrl(a.url)}
            style={box ? { width: box.width, aspectRatio: `auto ${box.width} / ${box.height}` } : undefined}
          />
        </button>
        {/* «⬇»: веб и десктоп — ссылка как была; приложение Android — в «Загрузки» (`FileCard.tsx`, 06.10). */}
        <DownloadBadge a={a} href={dl} />
        {hidden && <SpoilerCover a={a} />}
      </div>
    );
  }
  // Аудиофайл (15.10; звук не бывает ни картинкой, ни видео, ни «как файл» — проверка последней, приёмка 0.9.0): mp3/m4a/ogg/opus/flac/wav — музыкальной карточкой с ▶ и длительностью, как Telegram;
  // форматы, которых WebView не играет, остаются файлом (`isMusicFile`, `shared/voiceMessage.ts`). «⬇» — тот же значок, что у картинки.
  if (isMusicFile(a))
    return <MusicFileCard a={a} sizeLabel={kb(a.size)} meta={voice} badge={<DownloadBadge a={a} href={dl} cls="att-file-dl att-audio-dl" />} />;
  // Карточка файла: веб и десктоп — прежняя ссылка; приложение Android — открыть / в «Загрузки» с прогрессом (06.10).
  return <FileCard a={a} href={dl} sizeLabel={kb(a.size)} />;
}

/**
 * Э3 (#141, `fedm3`): вложение с `fedState: 'copying'` — файл прислал человек другого инстанса, и его копия на наш инстанс ещё едет.
 * Ни запроса к файлу, ни просмотра, ни скачивания (нет `data-att` — меню файла не цепляется). Фото, видео, GIF — плитка того же размера
 * (по `width`/`height`), затенённая, в центре крутилка, в углу «Загружается…» (как заглушка `MediaStub`, у Telegram — круг загрузки на
 * месте медиа); кружок — круг с крутилкой; голосовое — плеер неактивен, подпись «загружается»; файл — карточка без ссылки.
 */
function CopyingAttachment({ a, fill }: { a: Attachment; fill: boolean }) {
  if (isVoiceMessage(a)) {
    const bars = a.waveform?.length ? a.waveform : Array.from({ length: 40 }, () => 20);
    return (
      <div className="voice-msg voice-copying" aria-busy="true" aria-label="Голосовое сообщение загружается">
        <span className="voice-play" aria-disabled="true">
          <span className="confirm-spin att-spin" aria-hidden="true" />
        </span>
        <div className="voice-wave" role="presentation">
          {bars.map((v, i) => (
            <span key={i} className="voice-bar" style={{ height: `${Math.max(8, v)}%` }} />
          ))}
        </div>
        <span className="voice-time">{a.durationMs ? formatDuration(a.durationMs) : ''}</span>
        <span className="voice-copying-note">загружается</span>
      </div>
    );
  }
  if (isRoundVideo(a)) {
    return (
      <div className="round-msg" aria-busy="true" aria-label="Видеосообщение загружается">
        <div className="round-msg-btn att-copying">
          <span className="confirm-spin att-spin big" aria-hidden="true" />
        </div>
      </div>
    );
  }
  if (!a.asFile && (isImage(a.contentType) || isVideo(a.contentType))) {
    const box = fill ? null : attachmentBox(a.width || STUB_VIDEO_W, a.height || STUB_VIDEO_H, ATT_IMG_MAX_W, ATT_IMG_MAX_H);
    return (
      <div className="att-img-wrap">
        <div className="att-video att-copying" aria-busy="true" aria-label={`${a.name}: загружается`} title={a.name}>
          <span className="att-img att-pending" style={box ? { width: box.width, aspectRatio: `${box.width} / ${box.height}` } : undefined} />
          <span className="att-play" aria-hidden="true">
            <span className="confirm-spin att-spin big" />
          </span>
          <span className="att-dur" aria-hidden="true">
            Загружается… · {kb(a.size)}
          </span>
        </div>
      </div>
    );
  }
  return (
    <span className="att-file att-copying" title={a.name} aria-busy="true">
      <span className="att-file-icon">
        <span className="confirm-spin att-spin" aria-hidden="true" />
      </span>
      <span className="att-file-name">{a.name}</span>
      <span className="att-file-size">загружается · {kb(a.size)}</span>
    </span>
  );
}

/** Нет размера во вложении — видео держит 16:9, фото — квадрат (как место до загрузки). */
const STUB_VIDEO_W = 1280;
const STUB_VIDEO_H = 720;

/**
 * Заглушка нескачанного фото, видео или GIF (G32, как у Telegram: плитка на месте медиа, по центру — круг «Скачать», в углу —
 * вес, у видео — и длительность). Размытой миниатюры нет: превью вложений сервер не хранит (в `Attachment` нет поля), поэтому
 * плитка цвета `--bg-3` того же размера, что будет у медиа, — лента не прыгает, когда его скачают.
 */
function MediaStub({
  a,
  kind,
  fill,
  onLoad,
}: {
  a: Attachment;
  kind: 'photo' | 'video' | 'gif';
  fill: boolean;
  onLoad: () => void;
}) {
  const still = kind === 'photo';
  const w = a.width || (still ? ATT_IMG_MAX_H : STUB_VIDEO_W);
  const h = a.height || (still ? ATT_IMG_MAX_H : STUB_VIDEO_H);
  const box = fill ? null : attachmentBox(w, h, ATT_IMG_MAX_W, ATT_IMG_MAX_H);
  const ms = kind === 'video' ? a.durationMs || 0 : 0;
  const what = kind === 'photo' ? 'фото' : kind === 'gif' ? 'GIF' : 'видео';
  const badge = [kind === 'gif' ? 'GIF' : ms > 0 ? formatDuration(ms) : null, kb(a.size)].filter(Boolean).join(' · ');
  return (
    <div className="att-img-wrap">
      <button
        type="button"
        className="att-img-link att-video att-stub"
        data-att={attachmentKey(a)}
        title={a.name}
        aria-label={`Скачать ${what}, ${kb(a.size)}`}
        onClick={onLoad}
      >
        <span
          className="att-img att-pending"
          style={box ? { width: box.width, aspectRatio: `${box.width} / ${box.height}` } : undefined}
        />
        <span className="att-play" aria-hidden="true">
          <Icon name="download" size={20} />
        </span>
        <span className="att-dur" aria-hidden="true">
          {badge}
        </span>
      </button>
    </div>
  );
}

/**
 * Одноразовое фото или видео в ленте (19.10, #226; Telegram Android — размытая плитка с огнём «1» или таймером, по нажатию —
 * просмотр с отсчётом): заглушка БЕЗ загрузки файла (сервер отдаёт его получателю только после `once-open`), посередине —
 * значок «1» / число секунд. Получатель нажимает —
 * `onOpen` (лента ставит отметку `once-open` и открывает просмотр); у отправителя плитка не открывается — подсказка
 * tdesktop `lng_ttl_photo_tooltip_out`.
 */
/** Как `isOnceMedia` в `shared` — здесь своими силами: у модуля закрытый перечень импортов (проверки R159/R230). */
function onceMediaTile(a: Attachment): boolean {
  if (a.once !== true || a.asFile || a.gif || isRoundVideo(a) || isVoiceMessage(a)) return false;
  return (isImage(a.contentType) && a.contentType !== 'image/gif') || isVideo(a.contentType);
}

function OnceMediaTile({ a, mine, fill, onOpen }: { a: Attachment; mine: boolean; fill: boolean; onOpen?: (a: Attachment) => void }) {
  const [tip, setTip] = useState(false);
  const box = fill ? null : attachmentBox(a.width, a.height, ATT_IMG_MAX_W, ATT_IMG_MAX_H);
  const video = isVideo(a.contentType);
  const ttl = a.onceTtl ?? 0;
  const what = video ? 'видео' : 'фото';
  const hint = mine
    ? 'Сообщение исчезнет после того, как собеседник его просмотрит'
    : ttl
      ? `Одноразовое ${what}: после открытия исчезнет через ${ttl} с`
      : `Одноразовое ${what}: можно посмотреть один раз`;
  return (
    <button
      type="button"
      className={`att-once${mine ? ' mine' : ''}`}
      title={hint}
      aria-label={hint}
      style={box ? { width: box.width, aspectRatio: `${box.width} / ${box.height}` } : undefined}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (!mine) return onOpen?.(a);
        // Отправитель: подсказка поверх плитки на 3 с (tdesktop — всплывающая подсказка `lng_ttl_photo_tooltip_out`).
        setTip(true);
        window.setTimeout(() => setTip(false), 3000);
      }}
    >
      <span className="att-once-mark" aria-hidden="true">
        <Icon name={ttl ? 'clock' : 'flame'} size={22} />
        <span className="att-once-num">{ttl ? String(ttl) : '1'}</span>
      </span>
      {tip && <span className="att-once-tip">{hint}</span>}
    </button>
  );
}
