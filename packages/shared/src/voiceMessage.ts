/**
 * Голосовые сообщения (#20) — чистые правила, без записи и без DOM.
 *
 * Огибающая считается ОДИН раз на записи и едет вместе с вложением. Считать её при отрисовке
 * значило бы качать и декодировать каждое голосовое в истории только ради полосок — на канале с
 * сотней сообщений это минуты работы и десятки мегабайт трафика впустую.
 */

/** Сколько столбиков в полоске. Больше — не разглядеть, меньше — все записи выглядят одинаково. */
export const WAVEFORM_BUCKETS = 48;
/** Потолок длины записи: 30 минут (с 09.10, было 5; при 32 кбит/с файл около 7 МБ — влезает в 25 МБ потолок загрузки). Всё, что длиннее, — это уже файл, а не «голосовое». */
export const VOICE_MAX_MS = 30 * 60 * 1000;

/**
 * Свернуть звуковые отсчёты в огибающую из целых 0..100.
 *
 * Берём МАКСИМУМ модуля в корзине, а не среднее: среднее по речи с паузами стремится к нулю, и
 * полоска получается ровной ниточкой без всякого рисунка.
 */
export function peaksFrom(samples: Float32Array, buckets = WAVEFORM_BUCKETS): number[] {
  if (buckets <= 0) return [];
  if (samples.length === 0) return new Array(buckets).fill(0);

  const size = samples.length / buckets;
  const raw: number[] = [];
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * size);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * size)));
    let peak = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > peak) peak = v;
    }
    raw.push(peak);
  }

  // Нормируем на собственный максимум: тихая запись иначе рисуется как пустая полоска, хотя
  // слышно её нормально — громкость микрофонов различается на порядок.
  const loudest = Math.max(...raw);
  if (loudest <= 0) return raw.map(() => 0);
  return raw.map((v) => Math.round((v / loudest) * 100));
}

/** `0:07`, `1:23`, `12:05`. Часов не бывает — запись ограничена пятью минутами. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Вложение — голосовое сообщение? Признак — наличие огибающей, её ставит только запись. */
/**
 * Кружок (`Attachment.round`, 08.10, `circles1`): видео с пометкой сервера. «Прослушано» и «один раз» у него те же, что у
 * голосового (`isListenable`).
 */
export function isRoundVideo(a: { round?: true; contentType: string }): boolean {
  return a.round === true && a.contentType.startsWith('video/');
}

/**
 * Одноразовое фото или видео (19.10, #226, признак сервера `ttlmedia1`; Telegram `ttl_seconds` у фото и видео, tdesktop
 * `send_files_box.cpp` «Self-Destruct Timer»): `once` у картинки или видео, показанных кадром (не «как файл», не GIF, не
 * кружок). У получателя — закрытая размытая плитка; открыл — просмотр с отсчётом (`onceTtl`, с) или до закрытия, потом
 * сгорает у обоих (та же ручка `once-spent`, что у голосового).
 */
export function isOnceMedia(a: { once?: true; contentType: string; asFile?: true; gif?: true; round?: true }): boolean {
  if (a.once !== true || a.asFile || a.gif || a.round) return false;
  return (a.contentType.startsWith('image/') && a.contentType !== 'image/gif') || a.contentType.startsWith('video/');
}

/** Потолок таймера одноразового фото/видео, с (tdesktop: свой выбор 1…60). */
export const ONCE_TTL_MAX = 60;

/** «Один раз», который можно потратить (`once-spent`): голосовое, кружок, фото или видео с пометкой `once`. */
export function isOnceSpendable(a: {
  once?: true;
  waveform?: number[] | null;
  contentType: string;
  round?: true;
  asFile?: true;
  gif?: true;
}): boolean {
  return a.once === true && (isListenable(a) || isOnceMedia(a));
}

/** Вложение, у которого есть «прослушано» (`voice1`) и «один раз» (`voice3`): голосовое или кружок. */
export function isListenable(a: { waveform?: number[] | null; contentType: string; round?: true }): boolean {
  return isVoiceMessage(a) || isRoundVideo(a);
}

export function isVoiceMessage(a: { waveform?: number[] | null; contentType: string }): boolean {
  return !!a.waveform?.length && a.contentType.startsWith('audio/');
}

/**
 * Слова об ОДНОМ вложении «как в Telegram» (решение владельца 08.10, п.30) — общие для строки списка бесед
 * (`dmRowRules.dmAttachmentPreview`) и цитаты ответа (`bubbleRules.replyQuoteLook`): голосовое — «Голосовое сообщение»,
 * кружок — «Видеосообщение», видео — «Видео» (без длительности), файл — его имя одной строкой (нет имени — «Файл», без
 * «Файл: »). Имя — как `previewText` у сервера: пробелы схлопнуты, не длиннее 200 знаков.
 */
export function attachmentWords(f: { kind: 'voice' | 'file'; video?: boolean; round?: boolean; name?: string | null }): string {
  if (f.kind === 'voice') return 'Голосовое сообщение';
  if (f.video) return f.round ? 'Видеосообщение' : 'Видео';
  const flat = typeof f.name === 'string' ? f.name.replace(/\s+/g, ' ').trim() : '';
  const chars = [...flat];
  return chars.length === 0 ? 'Файл' : chars.length <= 200 ? flat : `${chars.slice(0, 199).join('')}…`;
}

// ─── Аудиофайл (не голосовое) ───────────────────────────────────────────────────────────
/**
 * Аудиофайл в ленте — музыкальной карточкой, а не карточкой файла (15.10, приёмка 0.9.0: wav был «скрепкой с размером»;
 * карточка — `MusicFileCard` в `apps/client/src/components/VoiceMessage.tsx`).
 * Как Telegram: документ со звуком (`MessageObject.isMusic`) — ячейка с круглой кнопкой ▶, названием и длительностью
 * (Android `ChatMessageCell` `documentAttachType == DOCUMENT_ATTACH_TYPE_MUSIC`, Web K `audio.tsx`), голосовое — отдельно.
 *
 * Только форматы, которые ИГРАЕТ сам WebView / Chromium (Android System WebView, WebView2, Chrome): mp3, m4a/aac, ogg/oga
 * (Vorbis, Opus), opus, flac, wav, webm-звук. AMR, WMA, AIFF, MIDI WebView не играет — они остаются файлом.
 */

/** MIME, которые проигрываются (без параметров, в нижнем регистре). */
const PLAYABLE_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mpeg3',
  'audio/x-mpeg-3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/x-aac',
  'audio/aacp',
  'audio/ogg',
  'application/ogg',
  'audio/opus',
  'audio/flac',
  'audio/x-flac',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
  'audio/x-pn-wav',
  'audio/webm',
]);

/** Расширения тех же форматов — когда отправитель не знал типа (`application/octet-stream`, пусто). */
const PLAYABLE_EXT = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'weba']);

/** Типы «не знаю, что это»: по ним решает расширение. */
const UNKNOWN_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/x-unknown']);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * Показать вложение музыкальной карточкой? Голосовое (огибающая) и кружок — нет, у них свои плееры; «Отправить как файл»
 * у звука не бывает (флаг только у фото и видео), поэтому не смотрим.
 */
export function isMusicFile(a: { contentType: string; name: string; waveform?: number[] | null; round?: true }): boolean {
  if (isVoiceMessage(a) || isRoundVideo(a)) return false;
  const type = (a.contentType || '').split(';')[0].trim().toLowerCase();
  if (PLAYABLE_TYPES.has(type)) return true;
  if (UNKNOWN_TYPES.has(type)) return PLAYABLE_EXT.has(extOf(a.name));
  return false;
}

/** Название трека: имя файла без расширения (у Telegram — тег title, нет его — имя файла). Пустое — имя целиком. */
export function musicTitle(name: string): string {
  const i = name.lastIndexOf('.');
  const base = i > 0 ? name.slice(0, i) : name;
  return base.trim() || name;
}

/**
 * Подпись под названием: играет или стоит на паузе посреди — «0:12 / 3:45» (Telegram Android: `durationText` у музыки),
 * иначе «3:45 · 63 KB»; длительность ещё не узнали — только размер.
 */
export function musicSubtitle(p: { atMs: number; durationMs: number; started: boolean; sizeLabel: string }): string {
  const known = Number.isFinite(p.durationMs) && p.durationMs > 0;
  if (p.started) return known ? `${formatDuration(p.atMs)} / ${formatDuration(p.durationMs)}` : formatDuration(p.atMs);
  return known ? `${formatDuration(p.durationMs)} · ${p.sizeLabel}` : p.sizeLabel;
}
