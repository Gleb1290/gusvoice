/**
 * Подозрительные адреса: когда ссылку НЕЛЬЗЯ открывать молча (#218, п.4).
 *
 * Как у Telegram: обычная видимая ссылка открывается сразу, окно «Открыть ссылку?» — только если адрес похож на подделку.
 * Правило перенесено по смыслу (код не копировался — GPL) из tweb `helpers/string/isSuspiciousUrl.ts:71-110` (логин/пароль
 * в адресе, битый punycode, смешение письменностей в метке по UTS #39, кириллица/греческий/армянский рядом с латиницей) и
 * Android `AndroidUtilities.checkHostForPunycode` (`:5480-5516`, латиница вместе с не-латиницей в хосте). Подсветка
 * «символов из другого алфавита» — tdesktop `core/click_handler_types.cpp:410-540` (`SuspiciousRanges`,
 * `lng_open_link_suspicious_chars`); хост в окне показывается в Юникоде (`DisplayUrlWithUnicodeHost` `:38-58`).
 */

/** Письменности, в которых допустима метка домена (UTS #39 «recommended scripts»). Всё прочее — приём подделки. */
const RECOMMENDED_SCRIPTS = [
  'Latin', 'Cyrillic', 'Greek', 'Armenian', 'Hebrew', 'Arabic', 'Thaana',
  'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala',
  'Thai', 'Lao', 'Tibetan', 'Myanmar', 'Georgian', 'Ethiopic', 'Khmer',
  'Han', 'Hiragana', 'Katakana', 'Hangul', 'Bopomofo',
] as const;
type Script = (typeof RECOMMENDED_SCRIPTS)[number];

const SCRIPT_RE = RECOMMENDED_SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, 'u')] as const);
const LETTER_RE = /\p{L}/u;
/** Цифры, дефис и «нейтральные» буквы (японская «ー») не принадлежат никакой письменности. */
const NEUTRAL_RE = /[\p{Script=Common}\p{Script=Inherited}]/u;
/** Письменности, которые могут сосуществовать в одной метке. */
const ALLOWED_MIXES: Script[][] = [
  ['Han', 'Hiragana', 'Katakana'],
  ['Han', 'Hangul'],
  ['Han', 'Bopomofo'],
];
/** Письменности с буквами, неотличимыми от латинских: `аррӏе.com` целиком кириллический и всё равно подделка. */
const LATIN_LOOKALIKES: Script[] = ['Cyrillic', 'Greek', 'Armenian'];

const scriptCache = new Map<string, Script | null>();
function scriptOf(ch: string): Script | null {
  let s = scriptCache.get(ch);
  if (s === undefined) {
    if (scriptCache.size > 1024) scriptCache.clear();
    s = SCRIPT_RE.find(([, re]) => re.test(ch))?.[0] ?? null;
    scriptCache.set(ch, s);
  }
  return s;
}

/** Письменности метки; `null` — в ней буква вне разрешённых письменностей. */
function labelScripts(label: string): Set<Script> | null {
  const out = new Set<Script>();
  for (const ch of label) {
    if (!LETTER_RE.test(ch) || NEUTRAL_RE.test(ch)) continue;
    const s = scriptOf(ch);
    if (!s) return null;
    out.add(s);
  }
  return out;
}

/* ── Punycode (RFC 3492): метка `xn--…` → Юникод. Браузер отдаёт хост уже в punycode, а смотреть нужно на буквы. ── */
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

function adapt(delta: number, numPoints: number, first: boolean): number {
  delta = first ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > ((BASE - T_MIN) * T_MAX) >> 1) {
    delta = Math.floor(delta / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * delta) / (delta + SKEW));
}

/** Разбор одной метки без префикса `xn--`; бросает на битых данных. */
function punycodeDecode(input: string): string {
  if (!input) throw new Error('punycode: пустая метка');
  const out: number[] = [];
  const basic = input.lastIndexOf('-');
  for (let j = 0; j < Math.max(basic, 0); j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) throw new Error('punycode: не ASCII');
    out.push(c);
  }
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length; ) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (idx >= input.length) throw new Error('punycode: обрыв');
      const c = input.charCodeAt(idx++);
      // Границы с обеих сторон: `c - 48 < 10` пропускал и символы НИЖЕ '0' (отрицательная цифра → чужой символ вместо отказа).
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 97 : BASE;
      if (digit >= BASE) throw new Error('punycode: цифра');
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
    }
    const len = out.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff) throw new Error('punycode: вне диапазона');
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** Хост в Юникоде: метки `xn--` раскрыты. Битый punycode — исключение. */
export function unicodeHost(host: string): string {
  return host
    .split('.')
    .map((label) => (/^xn--/i.test(label) ? punycodeDecode(label.slice(4)) : label))
    .join('.');
}

function parse(url: string): URL | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `http://${url}`);
  } catch {
    return null;
  }
}

/**
 * Адрес выглядит как подделка: нельзя открывать без вопроса. Непонятный (не разбирается) тоже подозрителен.
 */
export function isSuspiciousUrl(url: string): boolean {
  const u = parse(url);
  if (!u) return true;
  // `https://почта.рф@evil.com` ведёт на evil.com: то, что похоже на хост, — всего лишь логин.
  if (u.username || u.password) return true;
  let host: string;
  try {
    host = unicodeHost(u.hostname);
  } catch {
    return true;
  }
  const labels = host.toLowerCase().split('.');
  if (labels.length > 1 && labels[0] === 'www') labels.shift();
  const all = new Set<Script>();
  for (const label of labels) {
    const sc = labelScripts(label);
    if (!sc) return true;
    if (sc.size > 1 && !ALLOWED_MIXES.some((mix) => [...sc].every((s) => mix.includes(s)))) return true;
    sc.forEach((s) => all.add(s));
  }
  // Каждая метка однородна, но кириллическая/греческая/армянская рядом с латинской — классический гомограф.
  return all.has('Latin') && LATIN_LOOKALIKES.some((s) => all.has(s));
}

/**
 * Адрес для окна: хост в Юникоде (как `DisplayUrlWithUnicodeHost`). Не раскрываем, если из Юникода не получается тот же
 * punycode — тогда показываем как есть.
 */
export function displayUrl(url: string): string {
  const u = parse(url);
  if (!u) return url;
  const ace = u.hostname;
  let uni: string;
  try {
    uni = unicodeHost(ace);
  } catch {
    return url;
  }
  if (uni === ace) return u.href;
  try {
    if (new URL(`http://${uni}`).hostname !== ace) return u.href;
  } catch {
    return u.href;
  }
  // Хост ищем ПОСЛЕ схемы и userinfo, а не первым вхождением: в `https://xn--x@xn--x/…` первое совпадение — логин.
  let at = u.href.indexOf('//') + 2;
  if (u.username || u.password) at = u.href.indexOf('@', at) + 1;
  return at > 1 && u.href.startsWith(ace, at) ? u.href.slice(0, at) + uni + u.href.slice(at + ace.length) : u.href;
}

/** Отрезок строки: `from` и `length` в единицах UTF-16 (как у `String.slice`). */
export type SuspiciousRange = { from: number; length: number };

/**
 * Символы хоста «из другого алфавита, чем остальной адрес» (tdesktop `SuspiciousRanges`). Латиница рядом с кириллицей/
 * греческим/армянским — подсвечиваем «двойников»; иначе — буквы меньшинства. Пусто — подсвечивать нечего.
 */
export function suspiciousRanges(shown: string): SuspiciousRange[] {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]*)/i.exec(shown);
  if (!m) return [];
  const hostFrom = m.index + m[0].length - m[1].length;
  const host = m[1];
  const counts = new Map<string, number>();
  const chars: { at: number; ch: string; s: string }[] = [];
  for (let at = 0; at < host.length; ) {
    const ch = String.fromCodePoint(host.codePointAt(at)!);
    if (LETTER_RE.test(ch) && !NEUTRAL_RE.test(ch)) {
      const s = scriptOf(ch) ?? 'Other';
      counts.set(s, (counts.get(s) ?? 0) + 1);
      chars.push({ at, ch, s });
    }
    at += ch.length;
  }
  if (counts.size < 2) return [];
  const lookalikes = LATIN_LOOKALIKES.filter((s) => counts.has(s));
  let bad: (s: string) => boolean;
  if (counts.has('Latin') && lookalikes.length) {
    bad = (s) => s !== 'Latin';
  } else {
    const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    bad = (s) => s !== main;
  }
  const out: SuspiciousRange[] = [];
  for (const c of chars) {
    if (!bad(c.s)) continue;
    const last = out[out.length - 1];
    if (last && last.from + last.length === hostFrom + c.at) last.length += c.ch.length;
    else out.push({ from: hostFrom + c.at, length: c.ch.length });
  }
  return out;
}

/** Подсвеченные символы должны быть видимыми (не метки/пробелы/управляющие) — иначе подсветка ничего не покажет. */
export function rangesVisible(shown: string, ranges: SuspiciousRange[]): boolean {
  return ranges.every((r) => !/[\p{M}\p{Z}\p{C}]/u.test(shown.slice(r.from, r.from + r.length)));
}
