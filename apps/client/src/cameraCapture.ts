import { baseMime, captureName, pickRecorderType, recordingFull, type RecorderPick } from './attachRules';
import { isAndroid } from './hotkeys';
import { compressPhoto } from './imageCompress';

/**
 * Камера листа вложений (05.10, «как в Telegram»): живая картинка в первой ячейке сетки и своя камера на весь экран — снимок
 * нажатием, видео удержанием. Всё внутри WebView: `getUserMedia`, кадр — `ImageCapture.takePhoto()` (полное разрешение
 * сенсора) или кадр `<video>` через холст, видео — `MediaRecorder`. Разрешение камеры в приложении Android выдаёт WebView
 * клиент wry (`RustWebChromeClient.onPermissionRequest` → системное окно CAMERA), в браузере — сам браузер.
 */

export type Facing = 'environment' | 'user';

/** Камера в этой среде вообще есть: защищённый адрес и `getUserMedia` (в приложении — всегда, в браузере — по HTTPS). */
export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && (typeof isSecureContext === 'undefined' || isSecureContext);
}

/**
 * Разрешение на камеру уже есть — живую картинку в ячейке можно включать без окна системы. В браузере — по Permissions API
 * (Firefox имени `camera` не знает — тогда «не знаем», ячейка ждёт нажатия); в приложении спрашивает натив (`nativeMediaInfo`).
 */
export async function cameraAllowedQuietly(): Promise<boolean> {
  try {
    const st = await navigator.permissions?.query({ name: 'camera' as PermissionName });
    return st?.state === 'granted';
  } catch {
    return false;
  }
}

/** Поток камеры: 1280×720 — и для ячейки, и для экрана (смена разрешения перезапускала бы камеру), и для видео в 25 МБ; на миг снимка — 1920×1440 (`takeSnapshot`). */
export async function openCamera(facing: Facing): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: STREAM_W }, height: { ideal: STREAM_H } },
    audio: false,
  });
}

export function stopStream(s: MediaStream | null | undefined): void {
  s?.getTracks().forEach((t) => t.stop());
}

/** Камер больше одной — есть что переключать (до первого разрешения браузер может вернуть пустые подписи, но не число). */
export async function cameraCount(): Promise<number> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length;
  } catch {
    return 0;
  }
}

type TorchCaps = MediaTrackCapabilities & { torch?: boolean };

/** Трек умеет фонарик (Chromium на Android — у основной камеры). */
export function torchSupported(track: MediaStreamTrack | null | undefined): boolean {
  try {
    return !!(track?.getCapabilities?.() as TorchCaps | undefined)?.torch;
  } catch {
    return false;
  }
}

export async function setTorch(track: MediaStreamTrack, on: boolean): Promise<boolean> {
  try {
    await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

interface PhotoRange {
  max?: number;
}
interface ImageCaptureLike {
  takePhoto(settings?: { imageWidth?: number; imageHeight?: number }): Promise<Blob>;
  getPhotoCapabilities?(): Promise<{ imageWidth?: PhotoRange; imageHeight?: PhotoRange }>;
}
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Кадр с `<video>` через холст — запасной путь снимка (разрешение потока). */
function frameOf(video: HTMLVideoElement): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = video.videoWidth || 1280;
  c.height = video.videoHeight || 720;
  const ctx = c.getContext('2d');
  if (!ctx) return Promise.reject(new Error('no 2d context'));
  ctx.drawImage(video, 0, 0, c.width, c.height);
  return new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', 0.92));
}

/** Сколько ждём снимок сенсора: кадр в полном разрешении (12–50 Мп) Camera2 отдаёт дольше кадра превью. */
const PHOTO_TIMEOUT_MS = 6000;

/**
 * Поток на время снимка — 4:3 1920×1440, как предел снимка камеры Telegram Android (`photoMaxWidth/Height`,
 * `CameraView.java:760-783`). 🔴 WebView снимает `takePhoto()` по размеру ПОТОКА, а не сенсора: на эмуляторе (Android 16,
 * WebView 145) при потоке 1280×720 снимок — 1280×720 даже с явным `imageWidth/Height`, при потоке 1920×1440 — 3840×2160
 * (#218 п.6, «снимок плохой»). Поэтому перед снимком поток поднимаем (`applyConstraints`, ~10 мс), после — возвращаем
 * `STREAM_W×STREAM_H`: превью ячейки и видео остаются лёгкими.
 */
const SNAP_W = 1920;
const SNAP_H = 1440;
const STREAM_W = 1280;
const STREAM_H = 720;

/**
 * Самый крупный кадр, который отдаёт сенсор (`getPhotoCapabilities`: `imageWidth.max` × `imageHeight.max`). Без явного размера
 * Chromium снимает кадр «поближе к» размеру ПОТОКА — 1280×720 — и снимок выходил не лучше кадра превью (#218 п.6). Telegram
 * Android снимает своей Camera2 до 1920×1440 (`CameraView.java:760-783`) и тоже без сжатия превью; дальше у нас то же сжатие,
 * что у галереи (длинная сторона 2560). Не узнали — `null`, снимаем как раньше.
 */
async function largestPhoto(ic: ImageCaptureLike): Promise<{ imageWidth: number; imageHeight: number } | null> {
  try {
    const caps = await withTimeout(ic.getPhotoCapabilities?.() ?? Promise.reject(new Error('no caps')), 1500);
    const w = caps.imageWidth?.max ?? 0;
    const h = caps.imageHeight?.max ?? 0;
    return w > 0 && h > 0 ? { imageWidth: w, imageHeight: h } : null;
  } catch {
    return null;
  }
}

/**
 * Снимок: сначала `ImageCapture.takePhoto()` в ПОЛНОМ разрешении сенсора (`largestPhoto`; есть в Chromium и WebView), не
 * вышло за 6 с — кадр потока. Затем то же сжатие, что у фото из галереи (2560 px, JPEG 0.85, без метаданных). Каким путём
 * и какого размера вышел кадр — в консоль (`[camera] snapshot`): на устройстве иначе не узнать, сработал ли сенсор.
 */
export async function takeSnapshot(video: HTMLVideoElement, track: MediaStreamTrack | null): Promise<File> {
  let blob: Blob | null = null;
  let how = 'frame';
  const IC = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
  const live = !!track && track.readyState === 'live';
  let raised = false;
  if (track && live && typeof track.applyConstraints === 'function') {
    try {
      await withTimeout(track.applyConstraints({ width: { ideal: SNAP_W }, height: { ideal: SNAP_H } }), 1500);
      raised = true;
    } catch {
      raised = false;
    }
  }
  if (IC && track && track.readyState === 'live') {
    try {
      const ic = new IC(track);
      const size = await largestPhoto(ic);
      try {
        blob = await withTimeout(size ? ic.takePhoto(size) : ic.takePhoto(), PHOTO_TIMEOUT_MS);
        how = size ? `sensor ${size.imageWidth}x${size.imageHeight}` : 'sensor default';
      } catch (e) {
        // Размер не принят (бывает у фронтальной) — ещё раз без него, как до #218; не уложился по времени — сразу кадр потока.
        if (!size || (e instanceof Error && e.message === 'timeout')) throw e;
        blob = await withTimeout(ic.takePhoto(), PHOTO_TIMEOUT_MS);
        how = 'sensor default';
      }
    } catch {
      blob = null;
    }
  }
  try {
    if (!blob || blob.size === 0) {
      blob = await frameOf(video);
      how = `frame ${video.videoWidth}x${video.videoHeight}`;
    }
  } finally {
    // Поток — обратно в лёгкий: превью и видео (25 МБ) остаются на STREAM_W×STREAM_H.
    if (raised && track && track.readyState === 'live') {
      void track.applyConstraints({ width: { ideal: STREAM_W }, height: { ideal: STREAM_H } }).catch(() => undefined);
    }
  }
  console.info('[camera] snapshot', how, blob.size);
  const raw = new File([blob], captureName('photo', new Date(), 'jpg'), { type: 'image/jpeg' });
  return compressPhoto(raw);
}

/** Звук для видео: сырой микрофон в приложении Android — как у голоса (`VoiceConnection`: обработка WebView портит звук). */
async function openMic(): Promise<MediaStreamTrack | null> {
  try {
    const raw = isAndroid();
    const s = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: !raw, noiseSuppression: !raw, autoGainControl: !raw },
        video: false,
      }),
      2500,
    );
    return s.getAudioTracks()[0] ?? null;
  } catch {
    return null;
  }
}

export interface Recording {
  /** Остановить и получить файл; `null` — записать не вышло (пусто). */
  stop(): Promise<File | null>;
  /** Записано байт на сейчас (для предела 25 МБ). */
  bytes(): number;
}

export function recorderType(): RecorderPick | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return pickRecorderType((m) => MediaRecorder.isTypeSupported(m));
}

/**
 * Запись видео, пока держат кнопку: видео — трек камеры, звук — свой трек микрофона (берётся на время записи, без звука —
 * если микрофона нет или его не дали). Порции раз в секунду: у предела сервера (`VIDEO_SOFT_LIMIT`) запись останавливается
 * сама (`onFull`). `opts.softLimit` — свой предел записи (`attachRules.videoSoftLimit`: в ЛС по `bigfile1` до 1 ГиБ). `opts.mic: false` — у приложения нет разрешения на микрофон (натив знает, `nativeMediaInfo().mic`):
 * пишем без звука и окна не просим — оно «скрывает» страницу, и поток камеры гаснет посреди записи («Видео не записалось»).
 */
export async function startRecording(
  video: MediaStreamTrack,
  onFull: () => void,
  opts: { mic?: boolean; softLimit?: number } = {},
): Promise<Recording | null> {
  const pick = recorderType();
  if (!pick) return null;
  const mic = opts.mic === false ? null : await openMic();
  const stream = new MediaStream(mic ? [video, mic] : [video]);
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(stream, { mimeType: pick.mime, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 96_000 });
  } catch {
    try {
      rec = new MediaRecorder(stream);
    } catch {
      mic?.stop();
      return null;
    }
  }
  const chunks: Blob[] = [];
  let size = 0;
  let full = false;
  rec.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    chunks.push(e.data);
    size += e.data.size;
    if (!full && recordingFull(size, opts.softLimit)) {
      full = true;
      onFull();
    }
  };
  const stopped = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
  });
  rec.start(1000);
  return {
    bytes: () => size,
    async stop() {
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      mic?.stop();
      if (chunks.length === 0) return null;
      const type = baseMime(rec.mimeType || pick.mime).startsWith('video/mp4') ? 'video/mp4' : pick.type;
      return new File(chunks, captureName('video', new Date(), type === 'video/mp4' ? 'mp4' : 'webm'), { type });
    },
  };
}
