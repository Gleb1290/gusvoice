import { gvScreenSharePreview } from './nativeScreenShare';

/**
 * Откуда берётся кадр для превью показа (#115) — браузерная половина.
 *
 * Путей два, и они не пересекаются: на десктопе показ публикует отдельный нативный участник, и
 * кадра в этой вкладке нет вовсе — его отдаёт Rust; в вебе и на Android показ идёт обычным треком,
 * и кадр рисуем сами.
 *
 * ⚠️ Оба возвращают `null`, когда показывать нечего. Это не «ошибка», а нормальный ответ: цикл
 * отправки крутится всё время в голосовом канале и по `null` просто пропускает такт.
 */

/** Ширина превью. Та же, что у нативного сборщика, — зритель не должен видеть разницы по источнику. */
const PREVIEW_W = 320;

/** Качество JPEG. 0.6 — на кадре в 320 px артефактов не видно, а вес втрое меньше PNG. */
const JPEG_Q = 0.6;

/** Сколько ждём первый кадр с трека, прежде чем счесть такт неудачным. */
const FRAME_WAIT_MS = 1_000;

/**
 * Дождаться, пока в `<video>` появится картинка с размерами. `loadeddata` иногда приходит с нулевыми
 * размерами (трек ещё договаривается), поэтому проверяем именно их, а не факт события.
 */
function firstFrame(video: HTMLVideoElement): Promise<boolean> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timeout);
      video.removeEventListener('loadeddata', onData);
      resolve(ok);
    };
    const onData = () => done(video.videoWidth > 0 && video.videoHeight > 0);
    const timeout = setTimeout(() => done(false), FRAME_WAIT_MS);
    video.addEventListener('loadeddata', onData);
  });
}

/**
 * Снять кадр с локального трека показа (веб/Android) и вернуть его data-URL'ом.
 *
 * Элемент создаётся и убирается на КАЖДЫЙ такт. Держать его постоянно было бы дешевле по созданию,
 * но дороже по сути: подключённый `<video>` рисует трек непрерывно, а нам нужен один кадр раз в
 * несколько секунд.
 */
export async function grabTrackPreview(track: MediaStreamTrack): Promise<string | null> {
  if (track.readyState !== 'live') return null;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  try {
    video.srcObject = new MediaStream([track]);
    await video.play().catch(() => {});
    if (!(await firstFrame(video))) return null;

    const sw = video.videoWidth;
    const sh = video.videoHeight;
    const tw = Math.max(1, Math.min(PREVIEW_W, sw));
    const th = Math.max(1, Math.round((sh * tw) / sw));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, tw, th);
    return canvas.toDataURL('image/jpeg', JPEG_Q);
  } catch {
    // Трек мог закончиться прямо посреди снятия — это штатный конец показа, а не сбой.
    return null;
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

/**
 * Кадр для превью, откуда бы показ ни шёл: сперва спрашиваем нативный показ, и только если его нет —
 * снимаем с локального трека. Порядок именно такой, потому что на десктопе можно показывать и
 * по-браузерному, а обратное невозможно: нативный кадр есть только когда идёт нативный показ.
 */
export async function grabPreview(track: MediaStreamTrack | null): Promise<string | null> {
  const native = await gvScreenSharePreview();
  if (native) return native;
  return track ? grabTrackPreview(track) : null;
}
