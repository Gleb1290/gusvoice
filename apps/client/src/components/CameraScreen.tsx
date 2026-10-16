import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HOLD_TO_RECORD_MS, formatDuration, megabytes, ATTACH_MAX_BYTES, videoSoftLimit } from '../attachRules';
import { setTorch, startRecording, takeSnapshot, torchSupported, type Facing, type Recording } from '../cameraCapture';
import { Icon } from './Icon';

/** Снимок или запись, ждущие «Отправить» / «Переснять». */
export interface CameraShot {
  file: File;
  url: string;
  kind: 'photo' | 'video';
}

/**
 * Живая картинка камеры первой ячейкой сетки листа (как у Telegram: высокая, на две строки, значок камеры в углу). Без
 * потока — тёмная ячейка со значком: нажатие откроет камеру, а разрешение спросит уже она.
 */
export function CameraCell({
  stream,
  facing,
  onOpen,
  onHold,
  short = false,
}: {
  stream: MediaStream | null;
  facing: Facing;
  onOpen: () => void;
  /**
   * Удержание дольше `HOLD_TO_RECORD_MS` (10.10, #218: системная камера Android — тап = фото, удержание = видео, жест затвора
   * Telegram). Нет — удержание ничего не значит, как раньше.
   */
  onHold?: () => void;
  /** Одна строка вместо двух (`MediaSheet.camShort`: сетка не длиннее ряда — как `hasCameraSpaceRow` Telegram). */
  short?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const holdTimer = useRef(0);
  /** Удержание уже сработало — следующий `click` того же нажатия не открывает ещё и снимок. */
  const held = useRef(false);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    if (stream) void v.play().catch(() => undefined);
  }, [stream]);
  useEffect(() => () => window.clearTimeout(holdTimer.current), []);
  const release = () => window.clearTimeout(holdTimer.current);
  const hold = onHold
    ? {
        onPointerDown: () => {
          held.current = false;
          window.clearTimeout(holdTimer.current);
          holdTimer.current = window.setTimeout(() => {
            held.current = true;
            onHold();
          }, HOLD_TO_RECORD_MS);
        },
        onPointerUp: release,
        onPointerCancel: release,
        onPointerLeave: release,
        onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
      }
    : {};
  return (
    <button
      type="button"
      className={short ? 'gal-cam short' : 'gal-cam'}
      onClick={() => {
        if (held.current) {
          held.current = false;
          return;
        }
        onOpen();
      }}
      aria-label="Камера"
      {...hold}
    >
      {stream ? <video ref={ref} className={facing === 'user' ? 'mirror' : undefined} autoPlay muted playsInline /> : null}
      <span className="gal-cam-ico">
        <Icon name="camera" size={22} />
      </span>
    </button>
  );
}

/**
 * Своя камера на весь экран (как у Telegram): нажатие кнопки — снимок, удержание — видео, пока держишь (красная точка и
 * время сверху), смена основной и фронтальной камеры, фонарик (если трек умеет), закрыть. После снимка или записи —
 * предпросмотр с «Переснять» и «Отправить». Поток владеет лист (`MediaSheet`): тот же, что в ячейке, — переход без
 * перезапуска камеры.
 */
export function CameraScreen({
  stream,
  error,
  facing,
  canFlip,
  shot,
  onShot,
  onRetake,
  onFlip,
  onClose,
  onSend,
  onNote,
  mic = true,
  maxBytes = ATTACH_MAX_BYTES,
}: {
  stream: MediaStream | null;
  error: string | null;
  facing: Facing;
  canFlip: boolean;
  /** Звук для видео: `false` — у приложения нет разрешения на микрофон, пишем без звука (`startRecording`). */
  mic?: boolean;
  /** Предел файла, байт: запись останавливается у него (в ЛС при `bigfile1` — до 1 ГиБ). Нет — 25 МБ. */
  maxBytes?: number;
  shot: CameraShot | null;
  onShot: (file: File) => void;
  onRetake: () => void;
  onFlip: () => void;
  onClose: () => void;
  onSend: (file: File) => void;
  /** Короткое сообщение поверх камеры (общие тосты лежат ниже листа и камеры — их не видно). */
  onNote: (text: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [recAt, setRecAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const holdTimer = useRef(0);
  const recording = useRef<Recording | null>(null);
  const starting = useRef(false);
  const released = useRef(false);
  const track = stream?.getVideoTracks()[0] ?? null;
  const torchOk = torchSupported(track);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    if (stream) void v.play().catch(() => undefined);
  }, [stream, shot]);

  // Поток сменился (смена камеры) — фонарик выключился вместе со старым треком.
  useEffect(() => setTorchOn(false), [stream]);

  // Поток пропал посреди записи (свернули приложение, камеру забрала другая программа) — запись заканчиваем тем, что
  // успело записаться, а не оставляем кнопку «идёт запись» навсегда.
  useEffect(() => {
    if (!stream && recording.current) void finishRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream]);

  // Время записи — раз в четверть секунды, только пока пишем.
  useEffect(() => {
    if (recAt === null) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [recAt]);

  // Закрыли посреди записи — запись бросаем, микрофон освобождаем.
  useEffect(
    () => () => {
      window.clearTimeout(holdTimer.current);
      const r = recording.current;
      recording.current = null;
      if (r) void r.stop();
    },
    [],
  );

  async function snap() {
    const v = videoRef.current;
    if (!v || !stream || busy) return;
    setBusy(true);
    try {
      onShot(await takeSnapshot(v, track));
    } catch {
      onNote('Не удалось сделать снимок');
    } finally {
      setBusy(false);
    }
  }

  async function beginRecording() {
    if (!track || starting.current || recording.current) return;
    starting.current = true;
    setRecAt(Date.now());
    const r = await startRecording(
      track,
      () => {
        onNote(`Видео дошло до ${megabytes(maxBytes)} МБ — запись остановлена`);
        void finishRecording();
      },
      { mic, softLimit: videoSoftLimit(maxBytes) },
    );
    starting.current = false;
    if (!r) {
      setRecAt(null);
      onNote('Запись видео здесь недоступна');
      return;
    }
    recording.current = r;
    // Отпустили, пока поднимался микрофон, — останавливаем сразу.
    if (released.current) void finishRecording();
  }

  async function finishRecording() {
    const r = recording.current;
    if (!r) return;
    recording.current = null;
    setBusy(true);
    try {
      const file = await r.stop();
      if (file) onShot(file);
      else onNote('Видео не записалось');
    } finally {
      setRecAt(null);
      setBusy(false);
    }
  }

  const onDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (busy || !stream) return;
    e.preventDefault();
    released.current = false;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* без захвата отпускание всё равно придёт на кнопку */
    }
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = 0;
      void beginRecording();
    }, HOLD_TO_RECORD_MS);
  };

  const onUp = () => {
    released.current = true;
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = 0;
      void snap();
      return;
    }
    if (recording.current) void finishRecording();
  };

  const onCancel = () => {
    released.current = true;
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = 0;
      return;
    }
    if (recording.current) void finishRecording();
  };

  const toggleTorch = async () => {
    if (!track) return;
    const next = !torchOn;
    if (await setTorch(track, next)) setTorchOn(next);
  };

  const recOn = recAt !== null;

  return createPortal(
    <div className="cam-screen" role="dialog" aria-modal="true" aria-label="Камера" onContextMenu={(e) => e.preventDefault()}>
      {shot ? (
        <>
          {shot.kind === 'photo' ? (
            <img className="cam-shot" src={shot.url} alt="" />
          ) : (
            <video className="cam-shot" src={shot.url} autoPlay loop playsInline controls />
          )}
          <div className="cam-preview-bar">
            <button type="button" className="cam-btn ghost" onClick={onRetake}>
              <Icon name="reset" size={20} />
              Переснять
            </button>
            <button type="button" className="cam-btn send" onClick={() => onSend(shot.file)}>
              <Icon name="send" size={20} />
              Отправить
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Без потока `<video>` не рисуем: пустой он в WebView Android показывает свой серый «постер» с кругом и
              треугольником — поверх него «Включаю камеру…» и «Нет доступа к камере» читались как чужая картинка. */}
          {stream && <video ref={videoRef} className={`cam-video${facing === 'user' ? ' mirror' : ''}`} autoPlay muted playsInline />}
          {!stream && (
            <div className="cam-empty">
              <Icon name="camera-off" size={40} />
              <span>{error ?? 'Включаю камеру…'}</span>
            </div>
          )}
          <div className="cam-top">
            <button type="button" className="cam-round" onClick={onClose} aria-label="Закрыть камеру">
              <Icon name="close" size={22} />
            </button>
            {recOn ? (
              <div className="cam-rec" role="timer">
                <span className="voice-rec-dot" />
                {formatDuration(now - (recAt ?? now))}
              </div>
            ) : (
              <span />
            )}
            {torchOk ? (
              <button
                type="button"
                className={`cam-round${torchOn ? ' on' : ''}`}
                onClick={() => void toggleTorch()}
                aria-pressed={torchOn}
                aria-label="Фонарик"
              >
                <Icon name="bolt" size={22} />
              </button>
            ) : (
              <span className="cam-round-gap" />
            )}
          </div>
          <div className="cam-bottom">
            {!recOn && <div className="cam-hint">Нажмите — фото, удерживайте — видео</div>}
            <div className="cam-controls">
              <span className="cam-round-gap" />
              <button
                type="button"
                className={`cam-shutter${recOn ? ' rec' : ''}${busy ? ' busy' : ''}`}
                aria-label={recOn ? 'Остановить запись' : 'Снять'}
                disabled={!stream}
                onPointerDown={onDown}
                onPointerUp={onUp}
                onPointerCancel={onCancel}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void snap();
                  }
                }}
              >
                <span />
              </button>
              {canFlip && !recOn ? (
                <button type="button" className="cam-round" onClick={onFlip} aria-label="Сменить камеру">
                  <Icon name="camera-flip" size={22} />
                </button>
              ) : (
                <span className="cam-round-gap" />
              )}
            </div>
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}
