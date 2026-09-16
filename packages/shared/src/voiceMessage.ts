/**
 * Голосовые сообщения (#20) — чистые правила, без записи и без DOM.
 *
 * Огибающая считается ОДИН раз на записи и едет вместе с вложением. Считать её при отрисовке
 * значило бы качать и декодировать каждое голосовое в истории только ради полосок — на канале с
 * сотней сообщений это минуты работы и десятки мегабайт трафика впустую.
 */

/** Сколько столбиков в полоске. Больше — не разглядеть, меньше — все записи выглядят одинаково. */
export const WAVEFORM_BUCKETS = 48;
/** Потолок длины записи. Всё, что длиннее, — это уже файл, а не «голосовое». */
export const VOICE_MAX_MS = 5 * 60 * 1000;

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
export function isVoiceMessage(a: { waveform?: number[] | null; contentType: string }): boolean {
  return !!a.waveform?.length && a.contentType.startsWith('audio/');
}
