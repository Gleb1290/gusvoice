import { ROUND_MAX_MS, ROUND_SIDE } from '@gusvoice/shared';
import type { VoiceRecording, VoiceTake } from './voiceRecorder';

/**
 * Запись видеосообщения-кружка (08.10, #211, G68, признак сервера `circles1`).
 *
 * Цифры — из исходников Telegram (`S:\gv-stand\tg-src`, код не копирован): Android `InstantCameraView` +
 * `MessagesController.roundVideoSize` 384 px, `roundVideoBitrate` 1000 кбит/с, `roundAudioBitrate` 64 кбит/с, потолок 60 с;
 * tdesktop `ui/controls/round_video_recorder.cpp` — квадрат 400 px, `kMaxDuration` 60 с, звук 64 кбит/с.
 *
 * Камера отдаёт кадр своей пропорции — квадрат вырезаем по центру на холсте (`ROUND_SIDE` × `ROUND_SIDE`) и пишем поток холста
 * вместе с дорожкой микрофона в `MediaRecorder` (WebM/VP8+Opus — что даёт браузер). Предпросмотр — тот же поток холста:
 * человек видит ровно то, что уедет. Интерфейс — как у голосового (`VoiceRecording`): удержание, замок, пауза, отмена и
 * отправка идут через тот же `voiceHoldController`.
 */
export interface RoundRecording extends VoiceRecording {
  /** Квадратный поток для круглого предпросмотра (без звука). */
  preview: MediaStream;
  /** Передняя камера — предпросмотр зеркалим, как Telegram (запись не зеркальная). */
  front: () => boolean;
  /** Сменить камеру (передняя ↔ задняя); нет второй — молча остаётся прежняя. */
  flip: () => Promise<void>;
}

const FPS = 30;
const VIDEO_BPS = 1_000_000;
const AUDIO_BPS = 64_000;

export function roundRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  );
}

function pickMime(): string {
  const candidates = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'];
  return candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
}

function cameraConstraints(facing: 'user' | 'environment'): MediaTrackConstraints {
  return { facingMode: facing, width: { ideal: 640 }, height: { ideal: 640 }, frameRate: { ideal: FPS } };
}

export async function startRoundRecording(): Promise<RoundRecording> {
  let facing: 'user' | 'environment' = 'user';
  const cam = await navigator.mediaDevices.getUserMedia({
    video: cameraConstraints(facing),
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let videoTrack = cam.getVideoTracks()[0] ?? null;
  const audioTracks = cam.getAudioTracks();

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream(videoTrack ? [videoTrack] : []);
  await video.play().catch(() => {});

  const canvas = document.createElement('canvas');
  canvas.width = ROUND_SIDE;
  canvas.height = ROUND_SIDE;
  const g = canvas.getContext('2d');
  const draw = () => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!g || !vw || !vh) return;
    // Квадрат по центру кадра (Android `InstantCameraView` режет так же — по меньшей стороне).
    const s = Math.min(vw, vh);
    g.drawImage(video, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, ROUND_SIDE, ROUND_SIDE);
  };
  draw();
  // Таймер, а не `requestAnimationFrame`: кадры идут и в свёрнутом окне (rAF там встаёт, и кружок замер бы).
  const frames = window.setInterval(draw, Math.round(1000 / FPS));
  const canvasStream = canvas.captureStream(FPS);
  const preview = new MediaStream(canvasStream.getVideoTracks());
  const recStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);

  const mime = pickMime();
  const rec = new MediaRecorder(recStream, {
    ...(mime ? { mimeType: mime } : {}),
    videoBitsPerSecond: VIDEO_BPS,
    audioBitsPerSecond: AUDIO_BPS,
  });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  // Куски раз в секунду: снимок паузы и остановка не ждут весь файл одним куском.
  rec.start(1000);
  const startedAt = Date.now();
  let activeMs = 0;
  let runFrom: number | null = startedAt;
  const elapsed = () => Math.min(activeMs + (runFrom === null ? 0 : Date.now() - runFrom), ROUND_MAX_MS);

  // Уровень микрофона — для таймера/полосы, как у голосового.
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  if (audioTracks.length) ctx.createMediaStreamSource(new MediaStream(audioTracks)).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  let released = false;
  const cleanup = () => {
    if (released) return;
    released = true;
    clearInterval(frames);
    for (const t of [...cam.getTracks(), ...(videoTrack ? [videoTrack] : []), ...canvasStream.getTracks()]) t.stop();
    video.srcObject = null;
    void ctx.close().catch(() => {});
  };
  rec.addEventListener('stop', cleanup);

  let done = false;
  let limit = setTimeout(() => {
    if (!done && rec.state === 'recording') rec.stop();
  }, ROUND_MAX_MS);

  const fileOf = (): File => {
    const type = rec.mimeType || mime || 'video/webm';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    return new File([new Blob(chunks, { type })], `round-${startedAt}.${ext}`, { type: type.split(';')[0] });
  };
  const take = (): VoiceTake => ({ file: fileOf(), durationMs: elapsed(), waveform: [], round: { side: ROUND_SIDE } });

  return {
    startedAt,
    elapsed,
    preview,
    front: () => facing === 'user',
    flip: async () => {
      if (released) return;
      const next = facing === 'user' ? 'environment' : 'user';
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(next) });
      } catch {
        return;
      }
      const t = s.getVideoTracks()[0];
      if (!t || released) {
        for (const x of s.getTracks()) x.stop();
        return;
      }
      videoTrack?.stop();
      videoTrack = t;
      facing = next;
      video.srcObject = new MediaStream([t]);
      await video.play().catch(() => {});
    },
    pause: async () => {
      if (rec.state === 'recording') {
        if (runFrom !== null) activeMs += Date.now() - runFrom;
        runFrom = null;
        clearTimeout(limit);
        const flushed = new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1000);
          rec.addEventListener('dataavailable', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        rec.pause();
        try {
          rec.requestData();
          await flushed;
        } catch {
          /* старый движок без requestData на паузе — показываем то, что уже пришло */
        }
      }
      return take();
    },
    resume: () => {
      if (done || rec.state !== 'paused') return;
      rec.resume();
      runFrom = Date.now();
      limit = setTimeout(() => {
        if (!done && rec.state === 'recording') rec.stop();
      }, ROUND_MAX_MS - elapsed());
    },
    level: () => {
      if (released || runFrom === null || !audioTracks.length) return 0;
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      return Math.min(1, peak);
    },
    cancel: () => {
      done = true;
      clearTimeout(limit);
      if (rec.state !== 'inactive') rec.stop();
      cleanup();
    },
    stop: () =>
      new Promise<VoiceTake>((resolve, reject) => {
        if (done) return reject(new Error('запись уже завершена'));
        done = true;
        clearTimeout(limit);
        rec.onstop = () => {
          cleanup();
          // Длина — по часам и не больше потолка (как у голосового: у WebM из MediaRecorder длительности в заголовке нет).
          resolve(take());
        };
        if (rec.state !== 'inactive') rec.stop();
        else rec.onstop?.(new Event('stop'));
      }),
  };
}
