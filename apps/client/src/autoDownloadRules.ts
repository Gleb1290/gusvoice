/**
 * «Данные и память» → автозагрузка медиа (G32, FD-10, FA-07, FA-10, UN-24). ЧИСТОЕ правило «грузить ли вложение сразу»:
 * без браузера, без хранилища — его зовёт `AttachmentView` (лента ЛС и каналов), настройки хранит `autoDownload.ts`.
 *
 * Как у Telegram Desktop (`data/data_auto_download.cpp`, окно `boxes/auto_download_box.cpp`): три источника — личные
 * беседы, группы, каналы; у каждого свои переключатели по типам; два предела размера — «загрузка» (фото, по умолчанию
 * 10 МБ — `kDefaultDownloadLimit`) и «автовоспроизведение» (видео и GIF, 50 МБ — `kDefaultAutoPlayLimit`). Шаги ползунка —
 * `export/view/export_view_settings.cpp` `SizeLimitByIndex` (1…10 по 1, до 50 по 2, дальше по 5), обрезаны на 50 МБ:
 * больше один файл у нас не весит (предел выгрузки бэкенда — 25 МБ), и верхняя ступень значит «всё».
 *
 * Голосовые и файлы НЕ в переключателях, и это осознанно, а не пропуск:
 * - голосовое у нас заранее не качается вовсе — плеер берёт его по нажатию (`voicePlayer.ts`, `preload="metadata"` только
 *   у играющего); у Telegram Desktop голосовые тоже грузятся всегда, отдельного переключателя в окне нет;
 * - файл в ленте — карточка, качается только по нажатию; своего кэша файлов, куда класть заранее, в браузере нет.
 * Поэтому `shouldAutoLoad` для них — «да» (рисовать как раньше): заглушка поверх того, что и так грузится по нажатию,
 * была бы лишним шагом.
 *
 * «Экономия трафика» браузера (`navigator.connection.saveData`, Chromium): «в мобильной сети» мы не различаем — браузер
 * этого надёжно не знает, — но если человек сам попросил экономить, ведём себя как пресет «Низкий» Telegram для Android
 * (`DownloadController` `defaultLow`: фото до 1 МБ, видео до 500 КБ), автовоспроизведение выключено.
 */

/** Откуда сообщение — как `Data::AutoDownload::Source`: User / Group / Channel. */
export type MediaSource = 'dm' | 'group' | 'channel';
export const MEDIA_SOURCES: readonly MediaSource[] = ['dm', 'group', 'channel'];

/** Что качаем: фото, видео (кадр в ленте), GIF; файл и голосовое — см. шапку. */
export type MediaKind = 'photo' | 'video' | 'gif' | 'file' | 'voice';
/** Типы с переключателями (остальные решаются без настройки). */
export type SwitchKind = 'photo' | 'video' | 'gif';
export const SWITCH_KINDS: readonly SwitchKind[] = ['photo', 'video', 'gif'];

export interface AutoDownloadSettings {
  /** Какие типы качать сразу, по источникам. */
  photo: Record<MediaSource, boolean>;
  video: Record<MediaSource, boolean>;
  gif: Record<MediaSource, boolean>;
  /** Предел фото, МБ. */
  photoLimitMb: number;
  /** Предел видео и GIF, МБ (как «автовоспроизведение» Telegram). */
  videoLimitMb: number;
  /** GIF играют сами (как сейчас). Выкл — кадр с «GIF», играет по нажатию. */
  autoplayGif: boolean;
  /** Видео играют сами в ленте без звука. Выкл — кадр с ▶ (как было до G32). */
  autoplayVideo: boolean;
  /** Видеосообщения (кружки) играют сами без звука — свой переключатель, как `AutoPlayVideoMessage` в tdesktop. */
  autoplayRound: boolean;
}

const ALL_ON: Record<MediaSource, boolean> = { dm: true, group: true, channel: true };

/**
 * Заводские значения. Фото, видео и GIF — во всех источниках, как у Telegram (`SetDefaultsForSource` ставит предел, а не
 * ноль, всем трём). Автовоспроизведение видео и кружков включено (решение владельца 08.10: видео играет само без звука,
 * как в Telegram); раньше видео по умолчанию было кадром с ▶.
 */
export const AUTO_DOWNLOAD_DEFAULTS: AutoDownloadSettings = {
  photo: ALL_ON,
  video: ALL_ON,
  gif: ALL_ON,
  photoLimitMb: 10,
  videoLimitMb: 50,
  autoplayGif: true,
  autoplayVideo: true,
  autoplayRound: true,
};

/** Ступени ползунка, МБ (`SizeLimitByIndex` Telegram Desktop до 50). */
export const LIMIT_STEPS_MB: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50,
];
export const LIMIT_MAX_MB = LIMIT_STEPS_MB[LIMIT_STEPS_MB.length - 1];

/** Пределы «Низкого» пресета Telegram для Android (`defaultLow`: 1048576 и 512000 байт) — при экономии трафика. */
export const SAVE_DATA_PHOTO_BYTES = 1048576;
export const SAVE_DATA_VIDEO_BYTES = 512000;

const MB = 1024 * 1024;

/** Ближайшая ступень ползунка к числу (из хранилища может прийти что угодно). */
export function snapLimit(mb: unknown, fallback: number): number {
  const n = typeof mb === 'number' && Number.isFinite(mb) ? mb : fallback;
  let best = LIMIT_STEPS_MB[0];
  for (const s of LIMIT_STEPS_MB) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  return best;
}

/** Номер ступени для ползунка. */
export function limitIndex(mb: number): number {
  const i = LIMIT_STEPS_MB.indexOf(snapLimit(mb, mb));
  return i < 0 ? 0 : i;
}

function bySource(raw: unknown, fallback: Record<MediaSource, boolean>): Record<MediaSource, boolean> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<MediaSource, unknown>>;
  const out = { ...fallback };
  for (const s of MEDIA_SOURCES) if (typeof r[s] === 'boolean') out[s] = r[s] as boolean;
  return out;
}

/**
 * Настройки из хранилища: битое и чужое поле — заводское значение, остальное сохраняется. Запись читается при каждой
 * отрисовке вложения, и испорченная строка не должна ни ронять ленту, ни сбрасывать всё остальное.
 */
export function acceptAutoDownload(raw: unknown): AutoDownloadSettings {
  const d = AUTO_DOWNLOAD_DEFAULTS;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AutoDownloadSettings, unknown>>;
  return {
    photo: bySource(r.photo, d.photo),
    video: bySource(r.video, d.video),
    gif: bySource(r.gif, d.gif),
    photoLimitMb: snapLimit(r.photoLimitMb, d.photoLimitMb),
    videoLimitMb: snapLimit(r.videoLimitMb, d.videoLimitMb),
    autoplayGif: typeof r.autoplayGif === 'boolean' ? r.autoplayGif : d.autoplayGif,
    autoplayVideo: typeof r.autoplayVideo === 'boolean' ? r.autoplayVideo : d.autoplayVideo,
    autoplayRound: typeof r.autoplayRound === 'boolean' ? r.autoplayRound : d.autoplayRound,
  };
}

/** Вложение — каким типом его считать. Голосовое — по огибающей (`isVoiceMessage`), «как файл» — файл. */
export function mediaKindOf(a: {
  contentType: string;
  asFile?: boolean;
  gif?: boolean;
  waveform?: number[] | null;
}): MediaKind {
  if (Array.isArray(a.waveform) && a.waveform.length > 0) return 'voice';
  if (a.asFile) return 'file';
  if (a.gif === true) return 'gif';
  if (a.contentType.startsWith('image/')) return 'photo';
  if (a.contentType.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * Грузить ли вложение сразу. `source` нет (отложенные, свои черновики, места без источника) — грузим, как раньше.
 * Размер неизвестен (0, старое вложение) — считаем, что в предел влезает: заглушка с «0 KB» хуже картинки.
 */
export function shouldAutoLoad(
  kind: MediaKind,
  size: number,
  source: MediaSource | null | undefined,
  s: AutoDownloadSettings,
  saveData = false,
): boolean {
  if (kind === 'file' || kind === 'voice') return true;
  if (!source) return true;
  if (!s[kind][source]) return false;
  const bytes = Number.isFinite(size) && size > 0 ? size : 0;
  if (kind === 'photo') return bytes <= (saveData ? Math.min(s.photoLimitMb * MB, SAVE_DATA_PHOTO_BYTES) : s.photoLimitMb * MB);
  return bytes <= (saveData ? Math.min(s.videoLimitMb * MB, SAVE_DATA_VIDEO_BYTES) : s.videoLimitMb * MB);
}

/** Играть ли видео или GIF в ленте само (без звука, по кругу). Экономия трафика — никогда. */
export function shouldAutoplay(kind: MediaKind, s: AutoDownloadSettings, saveData = false): boolean {
  if (saveData) return false;
  if (kind === 'gif') return s.autoplayGif;
  if (kind === 'video') return s.autoplayVideo;
  return false;
}

/** Играть ли кружок (видеосообщение) в ленте само, без звука. Экономия трафика — никогда. */
export function shouldAutoplayRound(s: AutoDownloadSettings, saveData = false): boolean {
  return !saveData && s.autoplayRound;
}
