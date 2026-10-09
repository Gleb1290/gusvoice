/**
 * Выделение текста пальцем в ленте (#211, Telegram 2.02 / 4.34): чистые правила без DOM. Сам жест, маркеры и панель —
 * `components/TextSelection.tsx`; кто их зовёт — долгое нажатие ленты (`MessagePane.startLongPress`).
 *
 * Отрезок — смещения `[start, end)` в тексте сообщения, каким его видит лента: подряд склеенные текстовые узлы тела
 * (`.message-body` без времени и без нераскрытого спойлера).
 */

/** Не резать суррогатную пару (эмодзи, редкие иероглифы): смещение посреди пары сдвигаем к её концу или началу. */
export function snapOffset(text: string, off: number, forward = true): number {
  const o = Math.max(0, Math.min(off, text.length));
  if (o <= 0 || o >= text.length) return o;
  const hi = text.charCodeAt(o - 1);
  const lo = text.charCodeAt(o);
  const midPair = hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
  return midPair ? (forward ? o + 1 : o - 1) : o;
}

type Seg = { segment: string; index: number; isWordLike?: boolean };
type Segmenter = { segment(t: string): { containing(i: number): Seg | undefined } };

function segmenter(): Segmenter | null {
  const S = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => Segmenter }).Segmenter;
  return S ? new S(undefined, { granularity: 'word' }) : null;
}

const WORD_CH = /[\p{L}\p{N}\p{M}_'’-]/u;

/** Запасной путь без `Intl.Segmenter`: буквы, цифры, апостроф и дефис внутри слова. */
function wordByRegex(text: string, i: number): [number, number] {
  if (!WORD_CH.test(text[i] ?? '')) {
    // Палец на второй половине суррогатной пары (эмодзи) — начало на первой, иначе копируется пол-эмодзи.
    const lo = text.charCodeAt(i);
    const hi = i > 0 ? text.charCodeAt(i - 1) : 0;
    const start = lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff ? i - 1 : i;
    return [start, snapOffset(text, i + 1)];
  }
  let a = i;
  let b = i + 1;
  while (a > 0 && WORD_CH.test(text[a - 1])) a--;
  while (b < text.length && WORD_CH.test(text[b])) b++;
  return [a, b];
}

/**
 * Слово под символом `at` — как первое выделение Telegram по удержанию на тексте. Палец лёг на пробел — берём слово
 * слева (если его нет — справа); на знак препинания или эмодзи — сам этот знак.
 */
export function wordBounds(text: string, at: number): [number, number] {
  if (!text) return [0, 0];
  let i = Math.max(0, Math.min(at, text.length - 1));
  if (/\s/.test(text[i])) {
    let l = i;
    while (l > 0 && /\s/.test(text[l - 1])) l--;
    let r = i;
    while (r < text.length && /\s/.test(text[r])) r++;
    if (l > 0) i = l - 1;
    else if (r < text.length) i = r;
    else return [0, text.length];
  }
  const seg = segmenter();
  const s = seg?.segment(text).containing(i);
  if (s) return [s.index, s.index + s.segment.length];
  return wordByRegex(text, i);
}

/** Концы выделения по порядку: маркер, перетянутый за другой, меняется с ним ролями. Пустым выделение не бывает. */
export function orderedRange(a: number, b: number, len: number): [number, number] {
  let s = Math.max(0, Math.min(a, b, len));
  let e = Math.min(len, Math.max(a, b, 0));
  if (e <= s) {
    if (s >= len) s = Math.max(0, len - 1);
    e = Math.min(len, s + 1);
  }
  return [s, e];
}

/** Выделено ли всё сообщение (тогда «Выделить всё» в панели не показываем — как в Telegram). */
export function selectsAll(start: number, end: number, text: string): boolean {
  return text.slice(0, start).trim() === '' && text.slice(end).trim() === '';
}
