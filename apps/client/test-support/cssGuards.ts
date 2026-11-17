import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Запятые внутри :is(), :not(), функций и строк не разделяют селекторы/анимации.
export function splitList(text: string): string[] {
  const out: string[] = [];
  let start = 0, depth = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) { if (char === '\\') i++; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (char === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  return [...out, text.slice(start).trim()];
}

export interface Declaration { selectors: string[]; property: string; value: string; context: string[] }
export function declarations(raw: string): Declaration[] {
  const clean = raw.replace(/\/\*[\s\S]*?\*\//g, match => ' '.repeat(match.length));
  const out: Declaration[] = [];
  function block(from: number, to: number, context: string[]) {
    let header = from, quote = '', parens = 0;
    for (let i = from; i < to; i++) {
      const c = clean[i]!;
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '(') parens++;
      if (c === ')') parens--;
      if (c === ';' && parens === 0) { header = i + 1; continue; }
      if (c !== '{' || parens) continue;
      let end = i + 1, depth = 1, string = '';
      for (; end < to && depth; end++) {
        const next = clean[end]!;
        if (string) { if (next === '\\') end++; else if (next === string) string = ''; continue; }
        if (next === '"' || next === "'") string = next;
        else if (next === '{') depth++;
        else if (next === '}') depth--;
      }
      assert.equal(depth, 0, 'R354/viewport/setup/balanced-css');
      const name = clean.slice(header, i).trim();
      if (name.startsWith('@')) block(i + 1, end - 1, [...context, name]);
      else {
        const body = clean.slice(i + 1, end - 1);
        let start = 0, q = '', level = 0;
        for (let j = 0; j <= body.length; j++) {
          const next = body[j];
          if (q) { if (next === '\\') j++; else if (next === q) q = ''; continue; }
          if (next === '"' || next === "'") { q = next; continue; }
          if (next === '(') level++;
          if (next === ')') level--;
          if (j < body.length && (next !== ';' || level)) continue;
          const part = body.slice(start, j), colon = part.indexOf(':');
          if (colon >= 0) out.push({ selectors: splitList(name), context,
            property: part.slice(0, colon).trim(), value: part.slice(colon + 1).trim() });
          start = j + 1;
        }
      }
      i = end - 1; header = end;
    }
  }
  block(0, clean.length, []); return out;
}

export const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
export const rules = declarations(css);
export const phone = '@media (max-width: 760px)';
export const reduce = '@media (prefers-reduced-motion: reduce)';

// Только одинаковый селектор и одинаковая область; это не модель browser cascade.
export function values(selector: string, scope?: string): Map<string, string> {
  return new Map(rules.filter(rule => rule.selectors.includes(selector)
    && (scope ? rule.context.length === 1 && rule.context[0] === scope : rule.context.length === 0))
    .map(rule => [rule.property, rule.value.replace(/\s+/g, ' ')]));
}
export function value(selector: string, property: string, scope?: string): string {
  const found = values(selector, scope).get(property);
  assert.ok(found !== undefined, `${selector}: отсутствует ${property}`);
  return found;
}
