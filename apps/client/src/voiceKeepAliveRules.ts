/**
 * Правила «фонового голоса» на Android (#209, Xiaomi/HyperOS) — чистые функции и константы без DOM.
 * Механика и почему так — `voiceKeepAlive.ts`; здесь то, что проверяется без браузера.
 */

/** Части защиты. `mix` — общий контекст звука + шумовая подложка, `loop` — неслышная дорожка в выводе WebRTC,
 *  `renderer` — важный приоритет рендерера WebView (натив). */
export type KeepAlivePart = 'mix' | 'loop' | 'renderer';

/**
 * Выключатель без релиза: `localStorage['gv.voiceKeepAlive'] = '0'` снимает всё (поведение как до #209),
 * `localStorage['gv.voiceKeepAlive.<part>'] = '0'` — одну часть. Любое другое значение или отсутствие ключа —
 * умолчание из `KEEPALIVE_DEFAULTS`. Ставится в консоли WebView (CDP) и действует со следующего входа в голос
 * (общий контекст — с перезапуска приложения).
 */
export const KEEPALIVE_FLAG_KEY = 'gv.voiceKeepAlive';

/** Умолчания частей. Выключить часть для всех — поменять здесь (это уже релиз). */
export const KEEPALIVE_DEFAULTS: Readonly<Record<KeepAlivePart, boolean>> = { mix: true, loop: true, renderer: true };

/** Включена ли часть: только Android; общий ключ `'0'` гасит всё; ключ части `'0'`/`'1'` перекрывает умолчание. */
export function keepAliveEnabled(part: KeepAlivePart, android: boolean, read: (key: string) => string | null): boolean {
  if (!android) return false;
  if (read(KEEPALIVE_FLAG_KEY) === '0') return false;
  const own = read(`${KEEPALIVE_FLAG_KEY}.${part}`);
  if (own === '0') return false;
  if (own === '1') return true;
  return KEEPALIVE_DEFAULTS[part];
}

/**
 * Шумовая подложка в общем контексте: модуль каждого сэмпла в [A/2, A], A = 1e-4 (−80 dBFS). Нижняя граница
 * ≈ 1,6 младшего бита int16 — после перевода в 16 бит сэмпл не округляется в ноль (правило HyperOS считает
 * именно нули). Неслышно: −80 dBFS ниже шума любого телефонного тракта.
 */
export const MIX_NOISE_AMPLITUDE = 1e-4;

/**
 * Петля в вывод WebRTC: громкость отправляемого шума. WebRTC считает звук в int16, PCMU (μ-law) кодирует
 * модуль < 4 младших битов в ноль; при модуле 12…24 младших бита декодер отдаёт 8…24. A = 7.5e-4 (≈ −62 dBFS)
 * → модуль сэмпла [A/2, A] = 12…24 бита.
 */
export const LOOP_SEND_AMPLITUDE = 7.5e-4;

/**
 * Громкость элемента петли. Громкость элемента WebRTC применяет к int16 с отбрасыванием дробной части:
 * 8 × 0.15 = 1,2 → 1, 24 × 0.15 = 3,6 → 3 — на выходе 1…3 младших бита (≈ −80…−90 dBFS), не ноль и не слышно.
 */
export const LOOP_ELEMENT_VOLUME = 0.15;

/** Длина буфера шума, секунды (зациклен). Секунда — без слышимой периодичности и без лишней памяти. */
export const NOISE_BUFFER_SECONDS = 1;

/**
 * Шум без нулей: модуль каждого сэмпла в [amplitude/2, amplitude], знак случайный. `rand` — источник [0, 1)
 * (подменяется в проверках).
 */
export function noiseSamples(length: number, amplitude: number, rand: () => number = Math.random): Float32Array {
  const out = new Float32Array(Math.max(0, Math.floor(length)));
  const a = Math.abs(amplitude);
  for (let i = 0; i < out.length; i++) {
    const mag = a * (0.5 + 0.5 * rand());
    out[i] = rand() < 0.5 ? -mag : mag;
  }
  return out;
}

/** Уровень в dBFS для амплитуды (1 = 0 dBFS). */
export function dbfs(amplitude: number): number {
  return 20 * Math.log10(Math.abs(amplitude));
}

/**
 * Кодеки петли в порядке предпочтения: PCMU, PCMA (почти бесплатные по процессору — тяжёлая петля на Opus
 * подозревалась в «механизме 2»), Opus — запасной. Прочие (RED, CN, telephone-event) выкидываются: CN включил бы
 * подавление тишины, а нам нужен непрерывный поток. Пусто — оставить выбор браузеру.
 */
export function pickLoopCodecs<T extends { mimeType: string }>(codecs: readonly T[]): T[] {
  const order = ['audio/pcmu', 'audio/pcma', 'audio/opus'];
  const picked: T[] = [];
  for (const mime of order) for (const c of codecs) if (c.mimeType.toLowerCase() === mime) picked.push(c);
  return picked;
}
