import { count } from './plural';

/**
 * Длинный текст в поле ввода (порция «Отправка», 07.10; ресерч Telegram `02-composer.md` 10.3, 12.2) — чистые правила.
 *
 * По Telegram (поведение сверено с исходниками 07.10, `S:/gv-stand/tg-src`):
 * - поле НЕ ограничивает набор (Desktop `history_widget.cpp`: `textExceedsMaxSize` → у поля появляется кнопка «Send text as
 *   a file» (`textFileOffer`); отправка идёт как обычно — `apiwrap.cpp` режет текст по пределу (`TextUtilities::CutPart`)
 *   на несколько сообщений; «−N» красным (`CharactersLimitLabel`) у Desktop только при ПРАВКЕ и у подписи; вставка, после
 *   которой в поле ≥ 8 пределов (`SendAsFilePasteThreshold`), сразу уходит файлом `message.txt` (`PrepareTextAsFile`,
 *   `pastedTextBecomesFile`); Android режет по 4096; Web K — по пробелам). Разрез у Desktop — `CutPart`, наш — «умный»:
 *   текст длиннее предела сообщения при отправке режется на несколько сообщений (`splitLongText`): место разреза ищем только во второй половине допустимой
 *   длины и берём лучшее по убыванию: пустая строка между абзацами → перевод строки → конец предложения → конец части
 *   предложения → пробел → граница слова → посреди слова (пару UTF-16 эмодзи не рвём). Разметку (`||спойлер||`,
 *   `**жирный**`, `` `код` ``) по возможности не рвём;
 * - где резать нельзя, предел жёсткий: правка сообщения, подпись к вложениям, отложенное. Там — счётчик у кнопки
 *   (`composerCounter`: при остатке ≤ 100, как у Telegram Android; сверх предела «−N», как у Desktop) и отказ словами
 *   Telegram (`tooLongText`) вместо сырой строки проверки сервера (`humanLengthError`).
 *
 * Предел считается в UTF-16 (`String.length`) — так же считает сервер (`z.string().max(4096)`) и Telegram (Android
 * `maxMessageLength` = 4096, Desktop `message_length_limit_default` = 4096).
 */

/** Предел текста одного сообщения — тот же, что у сервера (`routes/conv.ts`, `routes/messages.ts`, `routes/dm.ts`). */
export const MESSAGE_TEXT_MAX = 4096;

/**
 * Больше этого за одну отправку не режем: 8 пределов (у Telegram Desktop такая вставка уже уходит файлом `message.txt`,
 * 12.2). Предел отправки сервера — 20 сообщений за 10 с (`authGuard.messageSendBlock`): 8 кусков (худший случай разреза
 * во второй половине — 16) в него укладываются. Столько же сервер принимает и в черновик (`convRules.DRAFT_TEXT_MAX`).
 */
export const SPLIT_TEXT_MAX = MESSAGE_TEXT_MAX * 8;

/** Счётчик остатка появляется, когда до предела осталось столько (Telegram Android — 100). */
export const COUNTER_FROM = 100;

const SENTENCE_END = /[.!?…]/u;
const CLAUSE_END = /[,;:—–]/u;
const CLOSERS = /["'»”’)\]]/u;
const WORDISH = /[\p{L}\p{N}_]/u;

/** Где в тексте стоят `||` (границы спойлеров) — один раз на разрез, а не на каждую позицию. */
function pipeMarks(s: string): number[] {
  const out: number[] = [];
  for (let i = s.indexOf('||'); i !== -1; i = s.indexOf('||', i + 2)) out.push(i);
  return out;
}

/** Разметка, которую не стоит рвать: пара `||` по всему тексту, `**`, `~~`, `` ` `` — внутри строки. */
function insideMarkup(s: string, p: number, pipes: readonly number[]): boolean {
  let before = 0;
  while (before < pipes.length && pipes[before] < p) before++;
  if (before % 2 === 1) return true;
  const lineStart = s.lastIndexOf('\n', p - 1) + 1;
  const line = s.slice(lineStart, p);
  for (const mark of ['**', '~~', '`']) {
    let n = 0;
    for (let i = line.indexOf(mark); i !== -1; i = line.indexOf(mark, i + mark.length)) n++;
    if (n % 2 === 1) return true;
  }
  return false;
}

/** Предпоследний значимый символ перед пробелом на `p - 1`: пропускаем закрывающие кавычки и скобки. */
function punctBefore(s: string, p: number): string {
  let i = p - 2;
  while (i >= 0 && CLOSERS.test(s[i])) i--;
  return i >= 0 ? s[i] : '';
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === ' ';

/**
 * Насколько хорош разрез перед `s[p]` (чем меньше, тем лучше; `null` — здесь не режем). Разрез съедает пробелы и
 * переводы строк по обе стороны (`splitLongText` подрезает края кусков).
 */
function cutRank(s: string, p: number): number | null {
  const prev = s[p - 1];
  const next = s[p];
  if (prev === '\n') {
    // Пустая строка между абзацами: перед переводом строки — ещё перевод строки (возможно, через пробелы).
    let i = p - 2;
    while (i >= 0 && isSpace(s[i])) i--;
    return s[i] === '\n' ? 0 : 1;
  }
  if (next === '\n' || isSpace(next)) return null; // режем в конце пробела, а не в начале
  if (isSpace(prev)) {
    const punct = punctBefore(s, p);
    if (SENTENCE_END.test(punct)) return 2;
    if (CLAUSE_END.test(punct)) return 3;
    return 4;
  }
  // Граница слова без пробела: «слово-слово», «a/b», «…?x».
  if (WORDISH.test(prev) !== WORDISH.test(next)) return 5;
  return null;
}

/** Где резать `s` (длиннее `limit`): лучший разрез во второй половине предела; нет — посреди слова у самого предела. */
function cutPoint(s: string, limit: number): number {
  const lo = Math.max(1, Math.floor(limit / 2));
  let best = -1;
  let bestRank = Infinity;
  let bestMarked = -1;
  let bestMarkedRank = Infinity;
  const pipes = pipeMarks(s.slice(0, limit + 1));
  for (let p = limit; p >= lo; p--) {
    const rank = cutRank(s, p);
    if (rank === null) continue;
    if (insideMarkup(s, p, pipes)) {
      if (rank < bestMarkedRank) {
        bestMarkedRank = rank;
        bestMarked = p;
      }
      continue;
    }
    if (rank < bestRank) {
      bestRank = rank;
      best = p;
      if (rank === 0) break;
    }
  }
  if (best !== -1) return best;
  if (bestMarked !== -1) return bestMarked;
  // Посреди слова: не рвём суррогатную пару (эмодзи), склейку ZWJ и вариационный селектор.
  let p = limit;
  while (p > lo) {
    const code = s.charCodeAt(p);
    const lowSurrogate = code >= 0xdc00 && code <= 0xdfff;
    if (!lowSurrogate && s[p] !== '‍' && s[p] !== '️' && s[p - 1] !== '‍') break;
    p--;
  }
  return p;
}

/**
 * Разбить текст на сообщения не длиннее `limit` (порядок сохраняется; края кусков без пробелов и переводов строк). Текст
 * не длиннее предела — один кусок (обрезанный по краям); пустой — ни одного.
 */
export function splitLongText(text: string, limit = MESSAGE_TEXT_MAX): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const cut = cutPoint(rest, limit);
    const head = rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).trimStart();
    if (head) parts.push(head);
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Что делать с текстом при отправке. `split` — несколько сообщений (только без вложений); `too-long` — отказ: с
 * вложениями (подпись не режется, как у Telegram) или длиннее `SPLIT_TEXT_MAX`; `over` — на сколько знаков сократить.
 */
export type SendTextPlan =
  | { kind: 'one'; text: string }
  | { kind: 'split'; parts: string[] }
  | { kind: 'too-long'; over: number; caption: boolean };

export function sendTextPlan(text: string, hasFiles: boolean, limit = MESSAGE_TEXT_MAX): SendTextPlan {
  const t = text.trim();
  if (t.length <= limit) return { kind: 'one', text: t };
  if (hasFiles) return { kind: 'too-long', over: t.length - limit, caption: true };
  const cap = limit * 8;
  if (t.length > cap) return { kind: 'too-long', over: t.length - cap, caption: false };
  return { kind: 'split', parts: splitLongText(t, limit) };
}

/**
 * Отказ словами Telegram (10.3: «Слишком длинное сообщение. Пожалуйста, укоротите его на {count} символа.»; у подписи —
 * то же про подпись).
 */
export function tooLongText(over: number, caption = false): string {
  const n = count(over, 'символ', 'символа', 'символов');
  return caption
    ? `Слишком длинная подпись. Пожалуйста, укоротите её на ${n}.`
    : `Слишком длинное сообщение. Пожалуйста, укоротите его на ${n}.`;
}

/**
 * Раскладка «Поделиться в…» (09.10) по сообщениям одного места. `comment` — куски комментария окна (уходят первыми, как у
 * Telegram); `caption` — подпись к файлам (пусто — без подписи); `tail` — куски текста, который не влез в подпись или пришёл
 * без файлов (идут после файлов, по порядку). Подпись не режется: текст длиннее предела вместе с файлами уходит файлами БЕЗ
 * подписи, а сам текст — следом обычными сообщениями (ничего не теряем). Сверх 8 пределов — отказ (`error` — готовая строка).
 */
export type SharePlan = { ok: true; comment: string[]; caption: string; tail: string[] } | { ok: false; error: string };

export function sharePlan(text: string, comment: string, hasFiles: boolean, limit = MESSAGE_TEXT_MAX): SharePlan {
  const pieces = (raw: string): string[] | number => {
    const plan = sendTextPlan(raw, false, limit);
    if (plan.kind === 'too-long') return plan.over;
    if (plan.kind === 'split') return plan.parts;
    return plan.text ? [plan.text] : [];
  };
  const c = pieces(comment);
  if (typeof c === 'number') return { ok: false, error: tooLongText(c) };
  const t = text.trim();
  if (hasFiles && t.length > 0 && t.length <= limit) return { ok: true, comment: c, caption: t, tail: [] };
  const tail = pieces(t);
  if (typeof tail === 'number') return { ok: false, error: tooLongText(tail) };
  return { ok: true, comment: c, caption: '', tail };
}

/**
 * Счётчик у кнопки: только там, где предел жёсткий (`hard`: правка, подпись к вложениям), и с остатка ≤ `COUNTER_FROM`.
 * `text` — остаток («87») или перебор («−12», `over: true`).
 */
export function composerCounter(length: number, hard: boolean, limit = MESSAGE_TEXT_MAX): { text: string; over: boolean } | null {
  if (!hard) return null;
  const left = limit - length;
  if (left > COUNTER_FROM) return null;
  return left < 0 ? { text: `−${-left}`, over: true } : { text: String(left), over: false };
}

/**
 * Сырая строка проверки сервера про длину (zod: «String must contain at most 4000 character(s)») → словами. Не она —
 * `null`. Сервер с 07.10 отвечает по-русски сам, это — для серверов постарше.
 */
export function humanLengthError(raw: string): string | null {
  const m = /^String must contain at most (\d+) character\(s\)$/.exec(raw.trim());
  if (!m) return null;
  return `Слишком длинное сообщение: не больше ${m[1]} знаков`;
}

/** Имя файла, в который уходит длинный текст (Desktop `ui/controls/compose_ai_button_factory.cpp: PrepareTextAsFile`). */
export const TEXT_FILE_NAME = 'message.txt';
export const TEXT_FILE_MIME = 'text/plain';

/** Предел подписи к вложению у Telegram (Desktop `caption_length_limit_default`); у нас сервер принимает до `MESSAGE_TEXT_MAX`. */
export const TELEGRAM_CAPTION_MAX = 1024;

/**
 * Кнопка «Отправить текстом-файлом» у поля: текст длиннее предела и это не правка (Desktop `HistoryWidget::
 * updateSendAsFileVisibility`: `textExceedsMaxSize && !editingMessage`; длину считает по сырому тексту, без подрезки).
 */
export function textFileOffer(length: number, editing: boolean, limit = MESSAGE_TEXT_MAX): boolean {
  return !editing && length > limit;
}

/**
 * Вставка текста, после которой в поле станет не меньше 8 пределов, уходит файлом (Desktop `CheckLargeTextPaste`:
 * `текущий − выделенное + вставленное >= 8 × предел`). Пустая вставка — нет.
 */
export function pastedTextBecomesFile(current: number, selStart: number, selEnd: number, pasted: number, limit = MESSAGE_TEXT_MAX): boolean {
  if (pasted <= 0) return false;
  const selected = Math.abs(selEnd - selStart);
  return current - selected + pasted >= limit * 8;
}

/** Что станет в поле после вставки `pasted` на место выделения `[selStart, selEnd)` (порядок краёв не важен). */
export function textAfterPaste(current: string, selStart: number, selEnd: number, pasted: string): string {
  const a = Math.min(selStart, selEnd);
  const b = Math.max(selStart, selEnd);
  return current.slice(0, a) + pasted + current.slice(b);
}
