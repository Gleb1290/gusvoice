import { peaksFrom, VOICE_MAX_MS, WAVEFORM_BUCKETS } from '@gusvoice/shared';

/**
 * Запись голосового сообщения (#20).
 *
 * Пишем в WebM/Opus — то же, что уже гоняет голосовой канал, и то, что умеет каждый браузер,
 * где вообще есть `MediaRecorder`. Никакой перекодировки: файл уезжает как есть.
 */

/** Что вернулось после записи: сам файл, длительность и уже посчитанная огибающая. */
export interface VoiceTake {
  file: File;
  durationMs: number;
  waveform: number[];
}

export function voiceRecordingSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/** Первый тип, который поддерживает браузер. Порядок — от предпочтительного. */
function pickMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
}

/**
 * Идёт запись. `stop()` завершает и отдаёт результат, `cancel()` выбрасывает.
 *
 * Дорожку микрофона глушим в ОБОИХ случаях: не остановить её — значит оставить гореть индикатор
 * записи в браузере и держать устройство занятым.
 */
export interface VoiceRecording {
  stop: () => Promise<VoiceTake>;
  cancel: () => void;
  /** Текущий уровень 0..1 — для полоски «пишется» в композере. */
  level: () => number;
  startedAt: number;
}

export async function startVoiceRecording(): Promise<VoiceRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  rec.start();
  const startedAt = Date.now();

  // Отдельный анализатор только ради живого уровня в интерфейсе: у MediaRecorder своего нет.
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  const cleanup = () => {
    for (const t of stream.getTracks()) t.stop();
    void ctx.close().catch(() => {});
  };

  let done = false;

  // Жёсткий потолок: заснувшая запись иначе живёт, пока не кончится место.
  const limit = setTimeout(() => {
    if (!done && rec.state === 'recording') rec.stop();
  }, VOICE_MAX_MS);

  return {
    startedAt,
    level: () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) {
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
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
          const type = rec.mimeType || mime || 'audio/webm';
          const blob = new Blob(chunks, { type });
          // Длительность берём по часам, а не из файла: у WebM из MediaRecorder её в заголовке
          // обычно нет вовсе, и `<audio>.duration` до конца воспроизведения отдаёт Infinity.
          const durationMs = Date.now() - startedAt;
          // Расширение по типу, иначе файл уедет в бакет как `.bin`.
          const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
          const file = new File([blob], `voice-${startedAt}.${ext}`, { type });
          void waveformOf(blob)
            .then((waveform) => resolve({ file, durationMs, waveform }))
            // Полоски не вышло — отправляем ровную: сообщение важнее картинки.
            .catch(() => resolve({ file, durationMs, waveform: new Array(WAVEFORM_BUCKETS).fill(8) }));
        };
        if (rec.state !== 'inactive') rec.stop();
        else rec.onstop?.(new Event('stop'));
      }),
  };
}

/** Посчитать огибающую по записанному файлу. Считаем ОДИН раз, у отправителя. */
async function waveformOf(blob: Blob): Promise<number[]> {
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    return peaksFrom(audio.getChannelData(0), WAVEFORM_BUCKETS);
  } finally {
    void ctx.close().catch(() => {});
  }
}
