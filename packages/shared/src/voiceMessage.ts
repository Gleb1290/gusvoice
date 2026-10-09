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
