/**
 * Размер картинки-вложения — чтобы лента оставила под неё место ДО скачивания (#194, 23.09).
 *
 * 🔴 **Откуда взялось.** Браузер не знает размер картинки, пока её не скачал, и рисует на её месте
 * ноль. Открыл канал с картинками — лента встала внизу, картинки догрузились, всё уехало вверх.
 * Прижимание к низу по `load` каждой картинки было подпоркой, а не лечением.
 *
 * Размер меряет ОТПРАВИТЕЛЬ перед отправкой (файл у него в руках) и кладёт в вложение — поля
 * `width`/`height` в `Attachment` были заведены давно, но их никто не заполнял. Старые вложения
 * остаются без размеров — для них всё по-прежнему.
 *
 * ⚠️ Размер — со слов отправителя. Поэтому в ленте он задаёт только МЕСТО до загрузки
 * (`aspect-ratio: auto W / H`): после загрузки браузер берёт настоящую пропорцию файла, и неверный
 * размер картинку не исказит.
 *
 * С 06.10 так же меряется видео (`measureVideoFile`): в ленте оно кадр, а не карточка файла.
 */
import { VOICE_MAX_MS } from '@gusvoice/shared';

/** Потолок, который принимает сервер (`routes/messages.ts`, `routes/dm.ts`). Больше — не картинка, а ошибка. */
export const IMAGE_DIM_MAX = 20_000;

/**
 * Размер картинки из файла или `null`, если это не картинка или разобрать не вышло. Не бросает:
 * без размера вложение всё равно уйдёт, просто без заранее оставленного места.
 */
export async function measureImageFile(file: Blob): Promise<{ width: number; height: number } | null> {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return null;
  try {
    const bmp = await createImageBitmap(file);
    const dims = { width: bmp.width, height: bmp.height };
    bmp.close();
    return validDims(dims.width, dims.height) ? dims : null;
  } catch {
    return null;
  }
}

/** Подсказки видео-вложения: размер кадра и длительность (06.10, видео в ленте кадром). */
export interface VideoHints {
  width: number;
  height: number;
  /** Длительность, мс; нет — сервер её не примет (длиннее `VOICE_MAX_MS`) или файл её не знает. */
  durationMs?: number;
}

/**
 * Подсказки из метаданных видео. Размер негодный — `null`. Длительность — только целая, положительная и не длиннее
 * `VOICE_MAX_MS` (30 минут): поле `durationMs` сервер заводил под голосовые и проверяет этим потолком — длиннее отказал
 * бы ВСЕЙ отправке (400), поэтому у длинного видео длительности в подсказке нет (лента возьмёт её из метаданных).
 */
export function videoHints(width: number, height: number, seconds: number): VideoHints | null {
  if (!validDims(width, height)) return null;
  const ms = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
  return ms > 0 && ms <= VOICE_MAX_MS ? { width, height, durationMs: ms } : { width, height };
}

/** Метаданные не пришли за это время — уходим без подсказок (вложение уйдёт и так). */
const VIDEO_PROBE_MS = 4000;

/**
 * Размер и длительность видео из файла (06.10): кадр в ленте получателя занимает место по размеру сразу, без прыжка, и
 * пишет длительность до загрузки. Не бросает; не вышло — `null`. Запись MediaRecorder (камера листа) длительности в
 * заголовке не несёт (`Infinity`) — тогда браузер ищет конец файла переходом далеко вперёд (файл локальный, это быстро).
 */
export async function measureVideoFile(file: Blob): Promise<VideoHints | null> {
  if (!file.type.startsWith('video/') || typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  let url = '';
  const v = document.createElement('video');
  const wait = (event: string, ms: number) =>
    new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        window.clearTimeout(timer);
        v.removeEventListener(event, onOk);
        v.removeEventListener('error', onErr);
        resolve(ok);
      };
      const onOk = () => done(true);
      const onErr = () => done(false);
      const timer = window.setTimeout(() => done(false), ms);
      v.addEventListener(event, onOk);
      v.addEventListener('error', onErr);
    });
  try {
    url = URL.createObjectURL(file);
    v.preload = 'metadata';
    v.muted = true;
    const loaded = wait('loadedmetadata', VIDEO_PROBE_MS);
    v.src = url;
    if (!(await loaded)) return null;
    if (!Number.isFinite(v.duration)) {
      const found = wait('durationchange', VIDEO_PROBE_MS);
      v.currentTime = 1e101;
      await found;
    }
    return videoHints(v.videoWidth, v.videoHeight, v.duration);
  } catch {
    return null;
  } finally {
    v.removeAttribute('src');
    if (url) URL.revokeObjectURL(url);
  }
}

/** Подсказки вложения по типу файла: картинка — размер, видео — размер и длительность, остальное — ничего. */
export function measureMediaFile(file: Blob): Promise<{ width: number; height: number; durationMs?: number } | null> {
  return file.type.startsWith('video/') ? measureVideoFile(file) : measureImageFile(file);
}

function validDims(w: unknown, h: unknown): w is number {
  return (
    typeof w === 'number' &&
    typeof h === 'number' &&
    Number.isInteger(w) &&
    Number.isInteger(h) &&
    w > 0 &&
    h > 0 &&
    w <= IMAGE_DIM_MAX &&
    h <= IMAGE_DIM_MAX
  );
}

/**
 * Какой прямоугольник занять в ленте: вписать картинку в `maxW × maxH`, не увеличивая. Размера нет
 * или он негодный — `null` (рисуем по-старому).
 */
export function attachmentBox(
  w: number | null | undefined,
  h: number | null | undefined,
  maxW: number,
  maxH: number,
): { width: number; height: number } | null {
  if (!validDims(w, h)) return null;
  const hh = h as number;
  const k = Math.min(1, maxW / w, maxH / hh);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(hh * k)) };
}
