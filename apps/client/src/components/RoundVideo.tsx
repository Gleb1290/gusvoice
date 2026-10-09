import { formatDuration, type Attachment } from '@gusvoice/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from 'react';
import type { RoundRecording } from '../roundRecorder';
import { voiceHeardKey, voiceUnheard } from '../voicePlayback';
import { getVoicePlayerState, markHeard, pauseVoice, spendOnce, subscribeVoicePlayer, useVoiceBubble } from '../voicePlayer';
import { Icon } from './Icon';
import type { VoiceMeta } from './VoiceMessage';

/**
 * Видеосообщение-кружок (08.10, #211, G68, `Attachment.round`, признак сервера `circles1`).
 *
 * Как Telegram (`S:\gv-stand\tg-src`, код не копирован): Android `ChatMessageCell` (круг `roundMessageSize` = 60 % меньшей
 * стороны экрана; играющий со звуком — `roundPlayingMessageSize` = ширина − 28 dp), tdesktop `history_view_video.cpp` /
 * `chat.style` `maxVideoMessageSize` 240 px, Web K `videoNote`. В ленте играет беззвучно по кругу (если «Данные и память»
 * разрешают автовоспроизведение видео), нажатие — с начала со звуком (на телефоне — крупнее), кольцо прогресса по краю
 * (ползунок: тяга по кольцу и стрелки перематывают, решение владельца 32); нажатие во время игры — пауза/дальше (на паузе
 * дуга уходит внутрь, на ней ручка). Конец — обратно в беззвучный круг. «Прослушано» (`voice1`, точка) и «один раз»
 * (`voice3`) — общие с голосовыми (`voicePlayer.markHeard` / `spendOnce`); голосовое на время кружка встаёт, и наоборот.
 * Чужой одноразовый кружок сам не играет и размыт до нажатия.
 *
 * `src` — запись перед отправкой (адрес файла в памяти): без меты, без точек.
 */

/** Кружок, который сейчас играет со звуком: новый глушит прежний (как второе голосовое — первое). */
let soundOwner: (() => void) | null = null;

type Mode = 'loop' | 'sound';

const RING_R = 48.5;
const RING_LEN = 2 * Math.PI * RING_R;

/**
 * Кольцо прогресса и перемотка (08.10, решение владельца 32), цифры Telegram: tdesktop `history_view_video_message_seek.cpp`
 * + `chat.style` (`historyVideoMessageSeek*`), Android `ChatMessageCell.drawRoundProgress` / `checkRoundSeekbar`. Толщина
 * дуги, отступы, ручка — в `styles.css` (`.round-msg-prog`, `.round-msg-knob`); здесь — зона захвата и шаги.
 */
/** Ширина полосы захвата у края круга (tdesktop `historyVideoMessageSeekGrabBand` 40 px); у маленького круга — не больше половины радиуса. */
const SEEK_BAND = 40;
/** Сдвиг до начала тяги, когда кружок играет (tdesktop `startDragDistance`): короче — это нажатие (пауза). */
const SEEK_SLOP = 4;
/** Перемотка во время тяги — не чаще (tdesktop `kSeekPreviewInterval`, Android — 100 мс). */
const SEEK_THROTTLE_MS = 100;
/** Шаг стрелок ←/→ у ползунка. */
const SEEK_KEY_S = 5;

/** Доля круга под точкой: 0 — верх, дальше по часовой (tdesktop `updateRoundSeeking`, Android `checkRoundSeekbar`). */
function seekShare(box: DOMRect, x: number, y: number): number {
  const dx = x - (box.left + box.width / 2);
  const dy = y - (box.top + box.height / 2);
  const turn = Math.atan2(dx, -dy) / (2 * Math.PI);
  return Math.min(1, Math.max(0, turn < 0 ? turn + 1 : turn));
}

/** Точка в полосе захвата у края круга (tdesktop `VideoMessageSeek::grabPoint`). */
function inSeekBand(box: DOMRect, x: number, y: number): boolean {
  const r = box.width / 2;
  const band = Math.min(SEEK_BAND, r / 2);
  const d = Math.hypot(x - (box.left + r), y - (box.top + box.height / 2));
  return d <= r && d >= r - band;
}

export function RoundVideo({
  a,
  meta,
  autoplay,
  src,
}: {
  a?: Attachment;
  meta?: VoiceMeta;
  autoplay: boolean;
  src?: string;
}) {
  const url = src ?? a?.url ?? '';
  const ref = useRef<HTMLVideoElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const knobRef = useRef<HTMLSpanElement>(null);
  const [mode, setMode] = useState<Mode>('loop');
  /** Видео со звуком идёт (не пауза): от него — кадры кольца и вид «пауза» (дуга внутрь, ручка). */
  const [running, setRunning] = useState(false);
  const [grabbed, setGrabbed] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  /** Позиция для `aria-valuenow`, целые секунды (меняется раз в секунду — не каждый кадр). */
  const [pos, setPos] = useState(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const secret = !!meta?.once && !meta.mine;
  const silentLoop = autoplay && !secret && !src;
  const heardKey = meta ? voiceHeardKey(meta.conversationId, meta.messageId) : null;
  const view = useVoiceBubble(`round:${meta?.messageId ?? url}`, heardKey);
  const unheard = !!meta && voiceUnheard(meta.listened, view.heard);
  const durationMs = a?.durationMs ?? 0;
  /** Тяга по кольцу: палец/кнопка, начата ли перемотка, шло ли видео до неё, точка нажатия, время прошлой перемотки. */
  const drag = useRef<{ id: number; seeking: boolean; x: number; y: number; at: number } | null>(null);
  /** Доля, куда тянут: кольцо рисует её, а не `currentTime` (перемотка дросселируется). */
  const dragShare = useRef<number | null>(null);
  /** После тяги `click` того же нажатия — не пауза. */
  const swallowClick = useRef(false);

  // Беззвучный круг — только пока кружок на экране (Telegram играет видимые): ушёл из окна — стоп, пришёл — дальше.
  useEffect(() => {
    const v = ref.current;
    if (!v || !silentLoop || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => {
      if (modeRef.current !== 'loop') return;
      if (e?.isIntersecting) void v.play().catch(() => {});
      else v.pause();
    });
    io.observe(v);
    return () => io.disconnect();
  }, [silentLoop, url]);

  // Автовоспроизведение выключили в настройках (D7) — играющий беззвучный круг встаёт сразу, как обычные видео.
  useEffect(() => {
    const v = ref.current;
    if (v && !silentLoop && modeRef.current === 'loop' && !v.paused) v.pause();
  }, [silentLoop]);

  // Голосовое пошло — кружок со звуком встаёт.
  useEffect(
    () =>
      subscribeVoicePlayer(() => {
        if (modeRef.current === 'sound' && getVoicePlayerState().playing) ref.current?.pause();
      }),
    [],
  );

  function totalS(v: HTMLVideoElement): number {
    return Number.isFinite(v.duration) && v.duration > 0 ? v.duration : durationMs / 1000;
  }

  /** Кольцо, ручка, оставшееся время и `aria-valuenow` — по текущему кадру (или по тяге). */
  function paint() {
    const v = ref.current;
    if (!v) return;
    const total = totalS(v);
    const t = dragShare.current != null ? dragShare.current * total : v.currentTime;
    const p = total > 0 ? Math.min(1, Math.max(0, t / total)) : 0;
    const ring = ringRef.current;
    if (ring) ring.style.strokeDashoffset = String(100 * (1 - p));
    const knob = knobRef.current;
    if (knob) {
      knob.style.setProperty('--kx', String(Math.sin(2 * Math.PI * p)));
      knob.style.setProperty('--ky', String(Math.cos(2 * Math.PI * p)));
    }
    setLeft(Math.max(0, Math.round(total - t)) * 1000);
    setPos(Math.floor(t));
  }

  // Кадры кольца — только пока кружок со звуком реально идёт (пауза, тяга, беззвучный круг — ни одного кадра впустую;
  // timeupdate идёт 4 раза в секунду — кольцо дёргалось бы). «Оптимизированный режим» (`gv-lite`) — по timeupdate.
  useEffect(() => {
    if (mode !== 'sound') return;
    paint();
    const lite = !!ref.current?.ownerDocument.documentElement.classList.contains('gv-lite');
    if (!running || lite) return;
    let raf = 0;
    const step = () => {
      paint();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [mode, running, durationMs]);

  // Палец на полосе кольца не листает ленту (касание началось в полосе — `drag`): `touch-action` решается на касании для
  // всего круга, а листать по середине кружка надо.
  useEffect(() => {
    const b = btnRef.current;
    if (!b) return;
    const stop = (e: TouchEvent) => {
      if (drag.current && e.cancelable) e.preventDefault();
    };
    b.addEventListener('touchmove', stop, { passive: false });
    return () => b.removeEventListener('touchmove', stop);
  }, []);

  // Ушёл с экрана (другая беседа, окно ленты сдвинулось): звук — стоп; чужой одноразовый, начатый со звуком, — просмотрен
  // (Telegram: view-once сгорает и при закрытии).
  /** Постоянная ручка «заглушить меня» для `soundOwner` (функция `stopSound` новая на каждой отрисовке). */
  const stopRef = useRef<() => void>(() => {});
  const owner = useRef(() => stopRef.current()).current;
  const metaRef = useRef(meta);
  metaRef.current = meta;
  useEffect(
    () => () => {
      if (soundOwner === owner) soundOwner = null;
      const m = metaRef.current;
      if (modeRef.current !== 'loop' && m?.once && !m.mine) spendOnce(m);
    },
    [],
  );

  function stopSound() {
    const v = ref.current;
    if (!v) return;
    drag.current = null;
    dragShare.current = null;
    setGrabbed(false);
    v.muted = true;
    v.loop = true;
    setMode('loop');
    setRunning(false);
    setLeft(null);
    setPos(0);
    if (silentLoop) void v.play().catch(() => {});
    else {
      v.pause();
      v.currentTime = 0;
    }
  }

  stopRef.current = stopSound;

  function resume(v: HTMLVideoElement) {
    pauseVoice();
    setRunning(true);
    void v.play().catch(() => {});
  }

  function onClick() {
    const v = ref.current;
    if (!v) return;
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    if (mode === 'sound') {
      if (v.paused) resume(v);
      else v.pause();
      return;
    }
    if (soundOwner && soundOwner !== owner) soundOwner();
    soundOwner = owner;
    pauseVoice();
    v.muted = false;
    v.loop = false;
    v.currentTime = 0;
    setMode('sound');
    setRunning(true);
    void v.play().catch(() => {});
    if (meta && !meta.mine) markHeard(meta);
  }

  function onEnded() {
    if (modeRef.current !== 'sound') return;
    if (soundOwner === owner) soundOwner = null;
    if (meta?.once && !meta.mine) spendOnce(meta);
    stopSound();
  }

  /** Перемотать к доле `p` (во время тяги — не чаще `SEEK_THROTTLE_MS`, кольцо — сразу). */
  function seekShareTo(p: number, now: number, final: boolean) {
    const v = ref.current;
    const d = drag.current;
    if (!v) return;
    dragShare.current = final ? null : p;
    const total = totalS(v);
    if (final || !d || now - d.at >= SEEK_THROTTLE_MS) {
      if (d) d.at = now;
      // Ровно в конец — не «закончилось»: последний кадр, а не обратно в беззвучный круг.
      if (total > 0) v.currentTime = Math.min(p * total, Math.max(0, total - 0.05));
    }
    paint();
  }

  function beginSeek(e: ReactPointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    const v = ref.current;
    if (!d || !v) return;
    d.seeking = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* указатель уже отпущен */
    }
    // На время тяги — пауза (tdesktop `startSeeking`; Android тянет только на паузе), после — дальше.
    v.pause();
    setGrabbed(true);
  }

  function onPointerDown(e: ReactPointerEvent<HTMLButtonElement>) {
    const v = ref.current;
    if (mode !== 'sound' || !v || e.button !== 0) return;
    // D21: в режиме выбора кольцо не перематывает — нажатие уходит строке (выбор / снятие).
    if (e.currentTarget.closest('.messages.sel-mode')) return;
    const box = e.currentTarget.getBoundingClientRect();
    if (!inSeekBand(box, e.clientX, e.clientY)) return;
    drag.current = { id: e.pointerId, seeking: false, x: e.clientX, y: e.clientY, at: 0 };
    // Удержание на кольце — не меню сообщения (Android `cancelCheckLongPress`).
    e.stopPropagation();
    // На паузе ручка уже на кольце — тяга сразу (tdesktop / Android), во время игры — после сдвига (иначе это пауза).
    if (v.paused) {
      beginSeek(e);
      seekShareTo(seekShare(box, e.clientX, e.clientY), e.timeStamp, false);
    }
  }

  function onPointerMove(e: ReactPointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.seeking) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < SEEK_SLOP) return;
      beginSeek(e);
    }
    seekShareTo(seekShare(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY), e.timeStamp, false);
  }

  function onPointerEnd(e: ReactPointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    const v = ref.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.seeking || !v) return;
    const p = e.type === 'pointerup' ? seekShare(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY) : dragShare.current;
    if (p != null) seekShareTo(p, e.timeStamp, true);
    dragShare.current = null;
    setGrabbed(false);
    // `click` этого нажатия — не пауза; у пальца после сдвига его может и не быть — флаг гаснет следующей задачей.
    swallowClick.current = true;
    setTimeout(() => {
      swallowClick.current = false;
    }, 0);
    // Отпустили — дальше со звуком (Android `playMessage` после перемотки).
    resume(v);
  }

  function onTouchStart(e: ReactTouchEvent<HTMLButtonElement>) {
    const t = e.touches[0];
    if (mode !== 'sound' || !t || e.currentTarget.closest('.messages.sel-mode') || !inSeekBand(e.currentTarget.getBoundingClientRect(), t.clientX, t.clientY)) return;
    // Касание кольца не начинает удержание пузыря (меню / выделение — `MessagePane.onMsgTouchStart`).
    e.stopPropagation();
  }

  function onSeekKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    const v = ref.current;
    if (!v) return;
    const total = totalS(v);
    let t: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t = v.currentTime - SEEK_KEY_S;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t = v.currentTime + SEEK_KEY_S;
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = total;
    if (t == null) return;
    e.preventDefault();
    v.currentTime = Math.min(Math.max(0, t), Math.max(0, total - 0.05));
    paint();
  }

  const playing = mode === 'sound';
  /** Вид «пауза» (как TG): дуга уходит внутрь и толще, дорожка и ручка на ней — за неё тянут. */
  const seekView = playing && (!running || grabbed);
  const time = left ?? durationMs;
  const totalSec = Math.round((ref.current ? totalS(ref.current) : durationMs / 1000) || 0);
  return (
    <div
      className={`round-msg${playing ? ' playing' : ''}${seekView ? ' seek' : ''}${grabbed ? ' grabbed' : ''}${secret && !playing ? ' secret' : ''}`}
    >
      <button
        ref={btnRef}
        type="button"
        className="round-msg-btn"
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onTouchStart={onTouchStart}
        aria-label={playing ? (running ? 'Пауза' : 'Дальше') : 'Видеосообщение'}
      >
        <video
          ref={ref}
          className="round-msg-video"
          src={url}
          muted
          loop
          playsInline
          preload="metadata"
          autoPlay={silentLoop}
          onEnded={onEnded}
          onPlay={() => modeRef.current === 'sound' && setRunning(true)}
          onPause={() => modeRef.current === 'sound' && setRunning(false)}
          onSeeked={() => modeRef.current === 'sound' && paint()}
          onTimeUpdate={() => modeRef.current === 'sound' && !running && paint()}
        />
        {!playing && !silentLoop && (
          <span className="att-play" aria-hidden>
            {secret ? <span className="round-msg-once">1</span> : <Icon name="play" size={20} />}
          </span>
        )}
      </button>
      {playing && (
        <div
          className="round-msg-seek"
          role="slider"
          tabIndex={0}
          aria-label="Перемотка видеосообщения"
          aria-valuemin={0}
          aria-valuemax={totalSec}
          aria-valuenow={pos}
          aria-valuetext={`${formatDuration(pos * 1000)} из ${formatDuration(totalSec * 1000)}`}
          onKeyDown={onSeekKey}
        >
          <svg className="round-msg-prog" aria-hidden>
            <circle className="round-msg-track" />
            <circle ref={ringRef} pathLength={100} strokeDasharray="100" strokeDashoffset={100} />
          </svg>
          <span ref={knobRef} className="round-msg-knob" />
        </div>
      )}
      <span className="round-msg-time">
        {time > 0 && formatDuration(time)}
        {!playing && <Icon name="volume-off" size={12} />}
        {unheard && <span className="voice-dot" aria-label="Не просмотрено" />}
      </span>
    </div>
  );
}

/**
 * Круглое окно записи кружка поверх ленты (Android `InstantCameraView` — круг с камерой по центру чата, tdesktop
 * `round_video_recorder.cpp` — круглый предпросмотр; кольцо — сколько из минуты записано). Окно ставится по центру ленты
 * (`.messages`), а не экрана: на ПК слева список бесед. Пишется — живой поток холста (зеркально у передней камеры, как у
 * Telegram; сама запись не зеркальная); на паузе — записанное (`RoundVideo` с адресом файла, нажатие — со звуком).
 */
export function RoundRecOverlay({
  live,
  previewUrl,
  previewMs,
  recMs,
  maxMs,
}: {
  live: RoundRecording | null;
  previewUrl: string | null;
  previewMs: number;
  recMs: number;
  maxMs: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [front, setFront] = useState(() => live?.front() ?? true);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = document.querySelector('.messages')?.getBoundingClientRect();
      setAt(r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);
  useEffect(() => {
    const v = ref.current;
    if (!v || !live || previewUrl) return;
    v.srcObject = live.preview;
    void v.play().catch(() => {});
    return () => {
      v.srcObject = null;
    };
  }, [live, previewUrl]);
  const p = Math.min(1, recMs / maxMs);
  return (
    <div
      ref={boxRef}
      className="round-rec"
      style={at ? { left: at.x, top: at.y } : undefined}
      role="group"
      aria-label="Запись видеосообщения"
    >
      <div className={`round-rec-circle${front && !previewUrl ? ' mirror' : ''}`}>
        {previewUrl ? (
          <RoundVideo src={previewUrl} autoplay={false} a={{ url: previewUrl, name: '', contentType: 'video/webm', size: 0, durationMs: previewMs }} />
        ) : (
          <>
            <video ref={ref} className="round-msg-video" muted playsInline autoPlay />
            <svg className="round-msg-ring rec" viewBox="0 0 100 100" aria-hidden>
              <circle cx="50" cy="50" r={RING_R} strokeDasharray={RING_LEN} strokeDashoffset={RING_LEN * (1 - p)} />
            </svg>
          </>
        )}
      </div>
      {live && !previewUrl && (
        <button
          type="button"
          className="round-rec-flip"
          title="Сменить камеру"
          onClick={() => void live.flip().then(() => setFront(live.front()))}
        >
          <Icon name="rotate" size={18} />
        </button>
      )}
    </div>
  );
}
