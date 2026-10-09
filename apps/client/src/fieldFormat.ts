import { FORMAT_MARKERS, stripFormatting, type InlineFormat } from '@gusvoice/shared';

/**
 * Форматирование в поле ввода сообщения (G20, G51, #211) — чистые правила, без DOM.
 *
 * Формат хранится в тексте маркерами (`shared/textFormat.ts`), поэтому «сделать жирным» = обернуть выделение в `**…**`, а
 * повторное нажатие на том же выделении — снять обёртку (переключатель, как в Telegram Desktop 02·4.2). Без выделения
 * сочетание ничего не делает. Моноширинный по целым строкам — блок кода, иначе строчный код. Цитата — `> ` в начале строк.
 * «Без форматирования» снимает все маркеры внутри выделения и вокруг него.
 */

export type FieldFormat = InlineFormat | 'quote' | 'clear';

export interface FieldEdit {
  value: string;
  /** Выделение после правки — на тех же словах, чтобы второе нажатие сняло формат. */
  start: number;
  end: number;
}

export interface FormatKey {
  /** `KeyboardEvent.code` — по физической клавише: в русской раскладке `key` у Ctrl+B — «и». */
  code: string;
  ctrlOrMeta: boolean;
  shift: boolean;
  alt: boolean;
}

/**
 * Сочетание → формат. Набор Telegram Desktop (02·4.2): Ctrl+B / I / U, Ctrl+Shift+X (зачёркнутый), Ctrl+Shift+M (моно),
 * Ctrl+Shift+P (скрытый), Ctrl+Shift+. (цитата), Ctrl+Shift+N (без форматирования). В приложении Android с клавиатурой —
 * ещё его собственные (02·4.3): Ctrl+E (моно), Ctrl+Shift+S (зачёркнутый). С Alt — не наше (как у обоих Telegram).
 * Ctrl+K (ссылка) не берём: ссылок с подписью у нас нет (`messageText.tsx`), а Ctrl+K — поиск бесед.
 */
export function formatHotkey(k: FormatKey, android = false): FieldFormat | null {
  if (!k.ctrlOrMeta || k.alt) return null;
  if (!k.shift) {
    if (k.code === 'KeyB') return 'bold';
    if (k.code === 'KeyI') return 'italic';
    if (k.code === 'KeyU') return 'underline';
    if (android && k.code === 'KeyE') return 'mono';
    return null;
  }
  if (k.code === 'KeyX') return 'strike';
  if (k.code === 'KeyM') return 'mono';
  if (k.code === 'KeyP') return 'spoiler';
  if (k.code === 'Period') return 'quote';
  if (k.code === 'KeyN') return 'clear';
  if (android && k.code === 'KeyS') return 'strike';
  return null;
}

/** Подписи и клавиши подменю «Форматирование» (ПК, 02·4.4) — порядок Telegram Desktop. */
export const FORMAT_MENU: readonly { kind: FieldFormat; label: string; shortcut: string }[] = [
  { kind: 'bold', label: 'Жирный', shortcut: 'Ctrl+B' },
  { kind: 'italic', label: 'Курсив', shortcut: 'Ctrl+I' },
  { kind: 'underline', label: 'Подчёркнутый', shortcut: 'Ctrl+U' },
  { kind: 'strike', label: 'Зачёркнутый', shortcut: 'Ctrl+Shift+X' },
  { kind: 'quote', label: 'Цитата', shortcut: 'Ctrl+Shift+.' },
  { kind: 'mono', label: 'Моноширинный', shortcut: 'Ctrl+Shift+M' },
  { kind: 'spoiler', label: 'Скрытый', shortcut: 'Ctrl+Shift+P' },
];

/** Пункты меню выделения на телефоне — порядок и подписи Telegram Android (02·4.5), без ссылки и даты. */
export const FORMAT_TOUCH_MENU: readonly { kind: FieldFormat; label: string }[] = [
  { kind: 'quote', label: 'Цитировать' },
  { kind: 'spoiler', label: 'Скрытый' },
  { kind: 'bold', label: 'Жирный' },
  { kind: 'italic', label: 'Курсив' },
  { kind: 'mono', label: 'Моно' },
  { kind: 'strike', label: 'Зачёркнутый' },
  { kind: 'underline', label: 'Подчёркнутый' },
  { kind: 'clear', label: 'Обычный' },
];

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/** Выделение `[start, end)` → новое значение и выделение. `null` — менять нечего (пустое выделение, нет формата у «clear»). */
export function applyFieldFormat(value: string, start: number, end: number, kind: FieldFormat): FieldEdit | null {
  let lo = Math.max(0, Math.min(start, end, value.length));
  let hi = Math.min(value.length, Math.max(start, end));
  if (lo === hi) return null;
  if (kind === 'quote') return toggleQuote(value, lo, hi);
  if (kind === 'clear') return clearFormat(value, lo, hi);
  // Пробелы по краям — снаружи маркеров: двойной клик в Windows берёт слово вместе с пробелом, а `** слово **` уже не жирный.
  while (lo < hi && isSpace(value[lo])) lo++;
  while (hi > lo && isSpace(value[hi - 1])) hi--;
  if (lo === hi) return null;
  if (kind === 'mono' && wholeLines(value, lo, hi)) return toggleCodeBlock(value, lo, hi);
  return toggleInline(value, lo, hi, FORMAT_MARKERS[kind]);
}

function wholeLines(value: string, lo: number, hi: number): boolean {
  const lineStart = value.lastIndexOf('\n', lo - 1) + 1;
  const lineEnd = value.indexOf('\n', hi);
  return /^\s*$/.test(value.slice(lineStart, lo)) && /^\s*$/.test(value.slice(hi, lineEnd < 0 ? value.length : lineEnd));
}

function wrapped(s: string, o: string, c: string): boolean {
  return s.length > o.length + c.length && s.startsWith(o) && s.endsWith(c);
}

function toggleInline(value: string, lo: number, hi: number, [o, c]: readonly [string, string]): FieldEdit {
  // Маркеры снаружи выделения — снять (второе нажатие на том же выделении). Сквозь другие обёртки: в `__**x**__` с
  // выделенным `x` Ctrl+I снимает курсив, а не добавляет третий слой.
  let a = lo;
  let b = hi;
  for (;;) {
    if (a >= o.length && value.slice(a - o.length, a) === o && value.slice(b, b + c.length) === c) {
      const next = value.slice(0, a - o.length) + value.slice(a, b) + value.slice(b + c.length);
      return { value: next, start: lo - o.length, end: hi - o.length };
    }
    const layer = Object.values(FORMAT_MARKERS).find(
      ([lo2, hi2]) => a >= lo2.length && value.slice(a - lo2.length, a) === lo2 && value.slice(b, b + hi2.length) === hi2,
    );
    if (!layer) break;
    a -= layer[0].length;
    b += layer[1].length;
  }
  const sel = value.slice(lo, hi);
  // По строкам: строчный формат у нас не переходит через перевод строки (`messageText.tsx` разбирает построчно).
  const lines = sel.split('\n');
  const filled = lines.filter((l) => l.trim());
  const allWrapped = filled.length > 0 && filled.every((l) => wrapped(l.trim(), o, c));
  const out = lines
    .map((l) => {
      const t = l.trim();
      if (!t) return l;
      const a = l.indexOf(t);
      const body = allWrapped ? t.slice(o.length, t.length - c.length) : o + t + c;
      return l.slice(0, a) + body + l.slice(a + t.length);
    })
    .join('\n');
  const next = value.slice(0, lo) + out + value.slice(hi);
  // Одна строка и обёртка — выделение на словах внутри маркеров; иначе — на всём изменённом куске.
  if (!allWrapped && lines.length === 1) return { value: next, start: lo + o.length, end: hi + o.length };
  return { value: next, start: lo, end: lo + out.length };
}

const FENCE_OPEN = '```\n';
const FENCE_CLOSE = '\n```';

function toggleCodeBlock(value: string, lo: number, hi: number): FieldEdit {
  if (value.slice(lo - FENCE_OPEN.length, lo) === FENCE_OPEN && value.slice(hi, hi + FENCE_CLOSE.length) === FENCE_CLOSE) {
    const next = value.slice(0, lo - FENCE_OPEN.length) + value.slice(lo, hi) + value.slice(hi + FENCE_CLOSE.length);
    return { value: next, start: lo - FENCE_OPEN.length, end: hi - FENCE_OPEN.length };
  }
  const sel = value.slice(lo, hi);
  if (sel.startsWith('```') && sel.endsWith('```') && sel.length >= 6) {
    const inner = sel.slice(3, -3).replace(/^\n/, '').replace(/\n$/, '');
    return { value: value.slice(0, lo) + inner + value.slice(hi), start: lo, end: lo + inner.length };
  }
  const next = value.slice(0, lo) + FENCE_OPEN + sel + FENCE_CLOSE + value.slice(hi);
  return { value: next, start: lo + FENCE_OPEN.length, end: hi + FENCE_OPEN.length };
}

const QUOTE_LINE = /^\s*>\s?/;

function toggleQuote(value: string, lo: number, hi: number): FieldEdit {
  if (hi > lo && value[hi - 1] === '\n') hi--;
  const a = value.lastIndexOf('\n', lo - 1) + 1;
  const bIdx = value.indexOf('\n', hi);
  const b = bIdx < 0 ? value.length : bIdx;
  const lines = value.slice(a, b).split('\n');
  const all = lines.filter((l) => l.trim()).every((l) => QUOTE_LINE.test(l));
  const block = lines.map((l) => (all ? l.replace(QUOTE_LINE, '') : `> ${l}`)).join('\n');
  return { value: value.slice(0, a) + block + value.slice(b), start: a, end: a + block.length };
}

function clearFormat(value: string, lo: number, hi: number): FieldEdit | null {
  let v = value;
  let changed = true;
  let any = false;
  // Обёртки вокруг выделения — все подряд (жирный курсив = две обёртки).
  while (changed) {
    changed = false;
    for (const [o, c] of [...Object.values(FORMAT_MARKERS), [FENCE_OPEN, FENCE_CLOSE] as const]) {
      if (lo >= o.length && v.slice(lo - o.length, lo) === o && v.slice(hi, hi + c.length) === c) {
        v = v.slice(0, lo - o.length) + v.slice(lo, hi) + v.slice(hi + c.length);
        lo -= o.length;
        hi -= o.length;
        changed = any = true;
      }
    }
  }
  const sel = v.slice(lo, hi);
  const plain = stripFormatting(sel, { spoiler: 'keep' });
  if (!any && plain === sel) return null;
  return { value: v.slice(0, lo) + plain + v.slice(hi), start: lo, end: lo + plain.length };
}

/** Есть ли что снимать «Без форматирования» — пункт меню неактивен, если нет (02·4.4). */
export function selectionHasFormat(value: string, start: number, end: number): boolean {
  return applyFieldFormat(value, start, end, 'clear') !== null;
}

// ─── Автозамены при наборе (02·4.7, Telegram Desktop) ───────────────────────────────────────────────────────────────

export interface Replacement {
  value: string;
  caret: number;
  /** Что вернуть Backspace сразу после замены: на месте `at` стоит `to`, было `from`. */
  undo: { at: number; from: string; to: string };
}

const REPLACE: readonly [string, string][] = [
  ['--', '—'],
  ['<<', '«'],
  ['>>', '»'],
];

/**
 * Только что набранный знак (`typed` — один символ, НЕ вставка: при вставке Telegram не заменяет) замыкает пару — заменить.
 * Внутри кода (`` ` `` в строке или ```` ``` ```` блок) не трогаем: там `--` и `<<` — код.
 */
export function textReplacement(value: string, caret: number | null, typed: string | null | undefined): Replacement | null {
  if (caret == null || !typed || [...typed].length !== 1) return null;
  const before = value.slice(0, caret);
  const hit = REPLACE.find(([from]) => before.endsWith(from));
  if (!hit) return null;
  const fences = before.split('```').length - 1;
  if (fences % 2 === 1) return null;
  const line = before.slice(before.lastIndexOf('\n') + 1).replace(/```/g, '');
  if ((line.split('`').length - 1) % 2 === 1) return null;
  const [from, to] = hit;
  const at = caret - from.length;
  return { value: value.slice(0, at) + to + value.slice(caret), caret: at + to.length, undo: { at, from, to } };
}

/** Backspace сразу после замены — вернуть набранное (каретка стоит за заменой, выделения нет). Иначе `null`. */
export function revertReplacement(
  value: string,
  start: number | null,
  end: number | null,
  undo: Replacement['undo'] | null,
): { value: string; caret: number } | null {
  if (!undo || start == null || start !== end) return null;
  if (start !== undo.at + undo.to.length || value.slice(undo.at, start) !== undo.to) return null;
  return { value: value.slice(0, undo.at) + undo.from + value.slice(start), caret: undo.at + undo.from.length };
}
