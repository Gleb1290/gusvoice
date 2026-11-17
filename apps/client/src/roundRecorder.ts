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
  /** Фактическая передняя камера — предпросмотр зеркалим, запись не зеркальная. */
  front: () => boolean;
  /** Только во время записи; параллельные вызовы разделяют попытку. Ошибка — после восстановления старой камеры. */
  flip: () => Promise<void>;
}

type Facing = 'user' | 'environment';
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

function cameraConstraints(facing: Facing): MediaTrackConstraints {
  return { facingMode: facing, width: { ideal: 640 }, height: { ideal: 640 }, frameRate: { ideal: FPS } };
}

function labelFacing(label: string): Facing | undefined {
  if (/front|user|facetime|передн|фронт/i.test(label)) return 'user';
  if (/back|rear|environment|задн|тылов/i.test(label)) return 'environment';
  return undefined;
}

function trackFacing(track: MediaStreamTrack, devices: MediaDeviceInfo[] = []): Facing | undefined {
  const settings = track.getSettings();
  if (settings.facingMode === 'user' || settings.facingMode === 'environment') return settings.facingMode;
  return labelFacing(track.label) ?? labelFacing(devices.find((d) => d.deviceId === settings.deviceId)?.label ?? '');
}

export async function startRoundRecording(): Promise<RoundRecording> {
  let facing: Facing = 'user';
  let deviceId: string | undefined;
  let videoTrack: MediaStreamTrack | null = null;
  let video: HTMLVideoElement | undefined;
  let rec: MediaRecorder | undefined;
  let ctx: AudioContext | undefined;
  let frames: number | undefined;
  let limit: ReturnType<typeof setTimeout> | undefined;
  let released = false;
  let done = false;
  let switching: Promise<void> | undefined;
  const owned = new Set<MediaStreamTrack>();
  const own = (stream: MediaStream) => { for (const t of stream.getTracks()) owned.add(t); return stream; };
  const release = (tracks: MediaStreamTrack[]) => {
    for (const t of tracks) {
      if (owned.delete(t)) t.stop();
    }
  };
  const ended = () => done || released;
  const cleanup = () => {
    if (released) return;
    released = true;
    clearInterval(frames);
    clearTimeout(limit);
    release([...owned]);
    if (video) video.srcObject = null;
    if (ctx) void ctx.close().catch(() => {});
  };

  const devices = async () => {
    try { return await navigator.mediaDevices.enumerateDevices(); } catch { return []; }
  };

  try {
    const cam = own(await navigator.mediaDevices.getUserMedia({
      video: cameraConstraints(facing),
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }));
    videoTrack = cam.getVideoTracks()[0] ?? null;
    if (!videoTrack || videoTrack.readyState === 'ended') throw new Error('Камера не передаёт видео');
    facing = trackFacing(videoTrack) ?? trackFacing(videoTrack, await devices()) ?? facing;
    deviceId = videoTrack.getSettings().deviceId;
    const audioTracks = cam.getAudioTracks();
    // Принимаем только используемые дорожки, в том числе у нестандартного getUserMedia.
    release(cam.getTracks().filter((t) => t !== videoTrack && !audioTracks.includes(t)));

    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([videoTrack]);
    await video.play();

    const canvas = document.createElement('canvas');
    canvas.width = ROUND_SIDE;
    canvas.height = ROUND_SIDE;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Не удалось создать холст записи');
    const draw = () => {
      if (!video || !videoTrack || videoTrack.readyState === 'ended' || video.readyState < 2) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      const s = Math.min(vw, vh);
      g.drawImage(video, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, ROUND_SIDE, ROUND_SIDE);
    };
    draw();
    // Между камерами холст держит последний кадр; микрофон и encoder продолжают работать.
    frames = window.setInterval(draw, Math.round(1000 / FPS));
    const canvasStream = own(canvas.captureStream(FPS));
    const preview = new MediaStream(canvasStream.getVideoTracks());
    const recStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
    const mime = pickMime();
    const recorder = rec = new MediaRecorder(recStream, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: VIDEO_BPS,
      audioBitsPerSecond: AUDIO_BPS,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const audioContext = ctx = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    if (audioTracks.length) audioContext.createMediaStreamSource(new MediaStream(audioTracks)).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    recorder.start(1000);
    const startedAt = Date.now();
    let activeMs = 0;
    let runFrom: number | null = startedAt;
    const elapsed = () => Math.min(activeMs + (runFrom === null ? 0 : Date.now() - runFrom), ROUND_MAX_MS);
    const freeze = () => {
      activeMs = elapsed();
      runFrom = null;
    };
    recorder.addEventListener('stop', () => { freeze(); cleanup(); });
    const armLimit = () => setTimeout(() => {
      if (!ended() && recorder.state === 'recording') { freeze(); recorder.stop(); cleanup(); }
    }, ROUND_MAX_MS - elapsed());
    limit = armLimit();

    const attach = async (stream: MediaStream, expected: Facing, previousId?: string) => {
      const track = stream.getVideoTracks()[0];
      try {
        if (ended()) { release(stream.getTracks()); return; }
        if (!track || track.readyState === 'ended') throw new Error('Камера не передаёт видео');
        let actual = trackFacing(track);
        if (!actual) actual = trackFacing(track, await devices());
        if (ended()) { release(stream.getTracks()); return; }
        const id = track.getSettings().deviceId;
        if ((actual && actual !== expected) || (previousId && id === previousId)) {
          throw new Error('Браузер вернул прежнюю камеру');
        }
        // Без facingMode и отличающегося deviceId переключение не подтверждено.
        if (!actual && (!id || (previousId && id === previousId))) {
          throw new Error('Не удалось определить камеру');
        }
        release(stream.getTracks().filter((t) => t !== track));
        video!.srcObject = new MediaStream([track]);
        await video!.play();
        if (ended()) { release(stream.getTracks()); return; }
        videoTrack = track;
        facing = actual ?? expected;
        deviceId = id;
      } catch (error) {
        release(stream.getTracks());
        if (video) video.srcObject = null;
        throw error;
      }
    };
    const open = async (constraints: MediaTrackConstraints, target: Facing, previousId?: string) => {
      const stream = own(await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false }));
      await attach(stream, target, previousId);
    };
    const switchCamera = async () => {
      const previousFacing = facing;
      const previousId = deviceId;
      const next: Facing = facing === 'user' ? 'environment' : 'user';
      if (videoTrack) release([videoTrack]);
      videoTrack = null;
      video!.srcObject = null;
      try {
        try {
          await open({ ...cameraConstraints(next), facingMode: { exact: next } }, next, previousId);
        } catch (error) {
          if (ended()) return;
          // WebView может игнорировать facingMode. После разрешения deviceId обычно доступен.
          const cameras = (await devices()).filter((d) => d.kind === 'videoinput' && d.deviceId !== previousId);
          if (ended()) return;
          const labelled = cameras.find((d) => labelFacing(d.label) === next);
          const candidate = labelled ?? cameras.find((d) => !labelFacing(d.label));
          if (!candidate) throw error;
          await open({ ...cameraConstraints(next), deviceId: { exact: candidate.deviceId }, facingMode: undefined }, next, previousId);
        }
      } catch (error) {
        if (ended()) return;
        try {
          await open({
            ...cameraConstraints(previousFacing),
            ...(previousId ? { deviceId: { exact: previousId }, facingMode: undefined } : { facingMode: { exact: previousFacing } }),
          }, previousFacing);
        } catch (recoveryError) {
          if (ended()) return;
          throw new AggregateError([error, recoveryError], 'Не удалось переключить и восстановить камеру');
        }
        if (!ended()) throw error;
      }
    };

    const fileOf = (): File => {
      const type = recorder.mimeType || mime || 'video/webm';
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      return new File([new Blob(chunks, { type })], `round-${startedAt}.${ext}`, { type: type.split(';')[0] });
    };
    const take = (): VoiceTake => ({ file: fileOf(), durationMs: elapsed(), waveform: [], round: { side: ROUND_SIDE } });
    return {
      startedAt, elapsed, preview,
      front: () => facing === 'user',
      flip: () => {
        if (ended() || recorder.state !== 'recording') return Promise.resolve();
        if (switching) return switching;
        switching = switchCamera().finally(() => { switching = undefined; });
        return switching;
      },
      pause: async () => {
        if (!ended() && recorder.state === 'recording') {
          freeze();
          clearTimeout(limit);
          const flushed = new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 1000);
            recorder.addEventListener('dataavailable', () => { clearTimeout(t); resolve(); }, { once: true });
          });
          recorder.pause();
          try { recorder.requestData(); await flushed; } catch { /* старый движок: уже накопленные куски */ }
        }
        return take();
      },
      resume: () => {
        if (ended() || recorder.state !== 'paused') return;
        recorder.resume();
        runFrom = Date.now();
        limit = armLimit();
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
        freeze();
        clearTimeout(limit);
        if (recorder.state !== 'inactive') recorder.stop();
        cleanup();
      },
      stop: () => new Promise<VoiceTake>((resolve, reject) => {
        if (done) return reject(new Error('запись уже завершена'));
        done = true;
        freeze();
        clearTimeout(limit);
        recorder.onstop = () => { cleanup(); resolve(take()); };
        if (recorder.state !== 'inactive') recorder.stop();
        else recorder.onstop?.(new Event('stop'));
        cleanup();
      }),
    };
  } catch (error) {
    if (rec && rec.state !== 'inactive') rec.stop();
    cleanup();
    throw error;
  }
}
