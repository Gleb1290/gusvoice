import { stripFormatting } from '@gusvoice/shared';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { applyFieldFormat, formatHotkey, type FieldEdit, type FieldFormat } from './fieldFormat';
import { isMobile } from './hotkeys';

/**
 * Форматирование в поле ввода — DOM-половина (G20, G52, #211): правка поля так, чтобы работал Ctrl+Z, сочетания клавиш,
 * вставка из HTML с форматом и Ctrl+Shift+V. Правила — в `fieldFormat.ts`, разбор HTML — `htmlToMarkdown` ниже.
 *
 * Поле участвует, только если помечено `data-fmt` (поле ЛС/канала и правка на месте): поиск, имя и прочие поля — нет.
 */

type Field = HTMLTextAreaElement | HTMLInputElement;

export function isFormatField(el: Element | null): el is Field {
  return !!el && (el as HTMLElement).dataset?.fmt === '1';
}

/**
 * Записать правку в поле через `execCommand('insertText')` — так она попадает в историю отмены (Ctrl+Z возвращает, как у
 * Telegram), а React получает обычное событие `input`. Меняем только изменившийся кусок (общие начало и конец — на месте).
 * Нет `execCommand` — нативный сеттер и `input`, как `EditContextMenu`.
 */
export function applyEditToField(el: Field, edit: FieldEdit): void {
  const prev = el.value;
  const next = edit.value;
  let p = 0;
  while (p < prev.length && p < next.length && prev[p] === next[p]) p++;
  let s = 0;
  while (s < prev.length - p && s < next.length - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  const insert = next.slice(p, next.length - s);
  el.focus();
  el.setSelectionRange(p, prev.length - s);
  let ok = false;
  try {
    ok = insert ? document.execCommand('insertText', false, insert) : document.execCommand('delete');
  } catch {
    ok = false;
  }
  if (!ok || el.value !== next) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.setSelectionRange(edit.start, edit.end);
}

/** Применить формат к выделению поля. `false` — менять нечего (нет выделения). */
export function formatField(el: Field, kind: FieldFormat): boolean {
  const edit = applyFieldFormat(el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0, kind);
  if (!edit) return false;
  applyEditToField(el, edit);
  return true;
}

let plainPasteAt = 0;

/**
 * Сочетания форматирования в поле (02·4.2). `true` — сочетание наше (событие погашено, даже если выделения нет: Ctrl+B не
 * должен открыть браузерное). Ctrl+Shift+V только запоминается: сама вставка придёт событием `paste`.
 */
export function handleFormatKey(e: KeyboardEvent<Field>): boolean {
  const ctrlOrMeta = e.ctrlKey || e.metaKey;
  if (ctrlOrMeta && e.shiftKey && !e.altKey && e.code === 'KeyV') {
    plainPasteAt = performance.now();
    return false;
  }
  const kind = formatHotkey({ code: e.code, ctrlOrMeta, shift: e.shiftKey, alt: e.altKey }, isMobile());
  if (!kind) return false;
  e.preventDefault();
  formatField(e.currentTarget, kind);
  return true;
}

/**
 * Вставка (02·4.11): HTML из буфера (Telegram, браузер, редактор, наши же сообщения) → маркеры формата. Как у Telegram
 * Desktop: если слова разобранного HTML не совпали с простым текстом буфера — вставляем простой текст (не наш случай —
 * пусть вставляет браузер). Ctrl+Shift+V — всегда простой текст. `true` — вставили сами.
 */
export function handleFormatPaste(e: ClipboardEvent<Field>): boolean {
  if (performance.now() - plainPasteAt < 1500) {
    plainPasteAt = 0;
    return false;
  }
  const html = e.clipboardData?.getData('text/html');
  const plain = e.clipboardData?.getData('text/plain') ?? '';
  if (!html) return false;
  const md = htmlToMarkdown(html, plain);
  if (md === null) return false;
  e.preventDefault();
  const el = e.currentTarget;
  const lo = Math.min(el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length);
  const hi = Math.max(el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length);
  const value = el.value.slice(0, lo) + md + el.value.slice(hi);
  applyEditToField(el, { value, start: lo + md.length, end: lo + md.length });
  return true;
}

// ─── HTML → маркеры ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Ctx {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  spoiler: boolean;
  code: boolean;
}

const BLOCK = new Set(['p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'table', 'section', 'article', 'header', 'footer']);
const SKIP = new Set(['style', 'script', 'head', 'title', 'meta', 'link', 'template', 'noscript']);

/** Обернуть кусок маркерами: пробелы по краям — снаружи, по строкам (строчный формат не переходит строку). */
function wrap(inner: string, o: string, c: string): string {
  return inner
    .split('\n')
    .map((l) => {
      const t = l.trim();
      if (!t) return l;
      const a = l.indexOf(t);
      return l.slice(0, a) + o + t + c + l.slice(a + t.length);
    })
    .join('\n');
}

function styleOf(el: Element): CSSStyleDeclaration | null {
  return (el as HTMLElement).style ?? null;
}

function walk(node: Node, ctx: Ctx): string {
  if (node.nodeType === 3) {
    const t = node.textContent ?? '';
    return t.replace(/[ \t\r\n\f]+/g, ' ');
  }
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP.has(tag)) return '';
  if (tag === 'br') return '\n';
  if (tag === 'img') return el.getAttribute('alt') ?? '';
  if (tag === 'pre') return `\n\`\`\`\n${(el.textContent ?? '').replace(/\n$/, '')}\n\`\`\`\n`;
  const cls = ` ${el.getAttribute('class') ?? ''} `;
  const st = styleOf(el);
  const weight = st?.fontWeight ?? '';
  const deco = `${st?.textDecoration ?? ''} ${st?.textDecorationLine ?? ''}`;
  const want: Ctx = {
    // Google Docs оборачивает всё в `<b style="font-weight:normal">` — это не жирный.
    bold: ((tag === 'b' || tag === 'strong') && weight !== 'normal' && weight !== '400') || weight === 'bold' || Number(weight) >= 600,
    italic: tag === 'i' || tag === 'em' || st?.fontStyle === 'italic',
    underline: tag === 'u' || tag === 'ins' || /underline/.test(deco),
    strike: tag === 's' || tag === 'strike' || tag === 'del' || /line-through/.test(deco),
    spoiler: tag === 'tg-spoiler' || / (tg-spoiler|spoiler)( |$)/.test(cls),
    code: tag === 'code' || tag === 'kbd' || tag === 'samp' || /monospace/.test(st?.fontFamily ?? ''),
  };
  const inner: Ctx = {
    bold: ctx.bold || want.bold,
    italic: ctx.italic || want.italic,
    underline: ctx.underline || want.underline,
    strike: ctx.strike || want.strike,
    spoiler: ctx.spoiler || want.spoiler,
    code: ctx.code || want.code,
  };
  if (want.code && !ctx.code) {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ');
    return text.trim() ? wrap(text, '`', '`') : text;
  }
  let out = '';
  for (const ch of Array.from(el.childNodes)) out += walk(ch, inner);
  if (tag === 'blockquote') {
    const body = out.replace(/^\n+|\n+$/g, '');
    return `\n${body
      .split('\n')
      .map((l) => `> ${l.trim()}`)
      .join('\n')}\n`;
  }
  if (want.strike && !ctx.strike) out = wrap(out, '~~', '~~');
  if (want.underline && !ctx.underline) out = wrap(out, '<u>', '</u>');
  if (want.italic && !ctx.italic) out = wrap(out, '__', '__');
  if (want.bold && !ctx.bold) out = wrap(out, '**', '**');
  if (want.spoiler && !ctx.spoiler) out = wrap(out, '||', '||');
  if (BLOCK.has(tag)) out = `\n${out}\n`;
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * HTML буфера → текст с маркерами формата. `null` — формата нет или слова не совпали с простым текстом буфера (тогда
 * Telegram Desktop вставляет простой текст, 02·4.11). Ссылка с подписью — подписью (так же её даёт простой текст буфера).
 * `DOMParser` документ не исполняет: скрипты не запускаются, картинки не грузятся.
 */
export function htmlToMarkdown(html: string, plain: string): string | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }
  const raw = walk(doc.body, { bold: false, italic: false, underline: false, strike: false, spoiler: false, code: false });
  const md = raw
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/^ (?=\S)/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
  if (!md || md === plain) return null;
  if (norm(stripFormatting(md, { spoiler: 'keep' })) !== norm(plain)) return null;
  if (norm(md) === norm(plain)) return null;
  return md;
}
