import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const source = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
type Rule = { selector: string; body: string; media: string[]; start: number; end: number };
// Разбираем вложенные блоки, а не ищем декларацию где-нибудь в 24 тысячах строк.
// Это страж исходного CSS, не вычисленная браузером каскадная таблица/скриншот.
function rules(text: string): Rule[] {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length));
  const result: Rule[] = [];
  function parse(from: number, to: number, media: string[]) {
    let cursor = from;
    while (cursor < to) {
      const open = clean.indexOf('{', cursor); if (open < 0 || open >= to) break;
      const header = clean.slice(cursor, open).trim();
      let depth = 1, quote = '', end = open + 1;
      for (; end < to && depth > 0; end++) {
        const c = clean[end];
        if (quote) { if (c === '\\') end++; else if (c === quote) quote = ''; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '{') depth++; else if (c === '}') depth--;
      }
      assert.equal(depth, 0, `незакрытый блок ${header}`);
      if (header.startsWith('@')) parse(open + 1, end - 1, [...media, header]);
      else result.push({ selector: header, body: clean.slice(open + 1, end - 1), media, start: open + 1, end: end - 1 });
      cursor = end;
    }
  }
  parse(0, clean.length, []); return result;
}
const phone = '@media (max-width: 760px)';
function declarations(text: string, selector: string, scope: string | null = phone) {
  const values = new Map<string, string>();
  for (const r of rules(text)) {
    if (!r.selector.split(',').map(s => s.trim()).includes(selector) || (scope ? !r.media.includes(scope) : r.media.length !== 0)) continue;
    for (const entry of r.body.split(';')) {
      const colon = entry.indexOf(':'); if (colon < 0) continue;
      values.set(entry.slice(0, colon).trim(), entry.slice(colon + 1).trim().replace(/\s+/g, ' '));
    }
  }
  return values;
}
function value(text: string, selector: string, property: string, expected: string, scope: string | null = phone) {
  assert.equal(declarations(text, selector, scope).get(property), expected, `${selector} ${property}`);
}
function change(selector: string, property: string, replacement: string, scope: string | null = phone) {
  const candidates = rules(source).filter(r => r.selector.split(',').map(s => s.trim()).includes(selector) && (scope ? r.media.includes(scope) : r.media.length === 0) && new RegExp(`(?:^|;)\\s*${property}\\s*:`).test(r.body));
  const r = candidates.at(-1); assert.ok(r, `${selector} ${property}`);
  const pattern = new RegExp(`((?:^|;)\\s*${property}\\s*:)\\s*[^;]+`);
  const body = source.slice(r.start, r.end).replace(pattern, `$1 ${replacement}`);
  const changed = source.slice(0, r.start) + body + source.slice(r.end); assert.notEqual(changed, source); return changed;
}
function pair(selector: string, property: string, expected: string, bad: string, scope: string | null = phone) {
  value(source, selector, property, expected, scope);
  assert.throws(() => value(change(selector, property, bad, scope), selector, property, expected, scope), assert.AssertionError);
}
const chat = '.app.m-content .chat';
it('CSS: поле и строка ответа подняты на expr-lift с доездом 300мс ease, панель анимирует отрицательный отступ', () => {
  for (const layer of ['composer', 'reply-strip']) {
    const sel = `${chat}.has-expr-under > .${layer}`;
    pair(sel, 'transform', 'translateY(calc(-1 * var(--expr-lift, 0px)))', 'none');
    pair(sel, 'transition', 'transform 300ms ease', 'none');
  }
  pair(`${chat} > .expr-under`, 'transition', 'height 300ms ease, margin-top 300ms ease', 'height 300ms ease');
});
it('CSS: шапка ниже scrim 81, mobile-back 80, поле и панель выше на 82', () => {
  pair(`${chat} > .expr-scrim`, 'z-index', '81', '79');
  pair(`${chat} > .expr-under`, 'z-index', '82', '80');
  for (const layer of ['composer', 'reply-strip']) pair(`${chat}.has-expr-under > .${layer}`, 'z-index', '82', '80');
  value(source, '.app.m-content .mobile-back', 'z-index', '80');
  value(source, `${chat} > .chat-top`, 'z-index', '6');
});
it('CSS: scrim перекрывает беседу полностью, чёрный 0.4, касания проходят насквозь', () => {
  const sel = `${chat} > .expr-scrim`;
  for (const [prop, expected, bad] of [['position', 'absolute', 'relative'], ['inset', '0', '56px 0 0'], ['background', 'rgb(0 0 0 / 0.4)', 'transparent'], ['pointer-events', 'none', 'auto']]) pair(sel, prop, expected, bad);
});
it('CSS: во время протяжки четыре слоя без перехода, а поиск и вкладки допускают только pan-x', () => {
  for (const layer of ['reply-strip', 'composer', 'expr-under', 'expr-scrim']) pair(`${chat}.expr-dragging > .${layer}`, 'transition', 'none', 'all 300ms ease');
  for (const handle of ['emoji-search', 'emoji-tabs']) pair(`${chat} > .expr-under .${handle}`, 'touch-action', 'pan-x', 'auto');
});
it('CSS: капсула закрепа гаснет 320мс и скрывается на нуле, базовое состояние остаётся видимым', () => {
  const cap = `${chat}.expr-up > .chat-top > .top-capsule`;
  pair(cap, 'opacity', '0', '1'); pair(cap, 'visibility', 'hidden', 'visible');
  pair(cap, 'transition', 'opacity 320ms cubic-bezier(0.23, 1, 0.32, 1), visibility 0s 320ms', 'none');
  value(source, `${chat} > .chat-top > .top-capsule`, 'transition', 'opacity 320ms cubic-bezier(0.23, 1, 0.32, 1), visibility 0s');
});
it('CSS: сетка 72×82 без зазоров ограничена панелью под полем и телефонным media', () => {
  const grid = `${chat} > .expr-under .sticker-grid`;
  pair(grid, 'grid-template-columns', 'repeat(auto-fill, minmax(72px, 1fr))', 'repeat(auto-fill, minmax(64px, 1fr))');
  pair(grid, 'grid-auto-rows', '82px', '72px'); pair(grid, 'gap', '0', '4px');
  const check = (text: string) => {
    for (const r of rules(text).filter(r => /grid-template-columns\s*:\s*repeat\(auto-fill, minmax\(72px, 1fr\)\)/.test(r.body) || /grid-auto-rows\s*:\s*82px/.test(r.body))) {
      assert.ok(r.media.includes(phone));
      for (const selector of r.selector.split(',')) assert.ok(selector.includes('.expr-under'), 'не затрагивает всплывающие окна/док ПК');
    }
  };
  check(source);
  const bad = source.replace(`${grid} {`, `${chat} > .sticker-grid {`); assert.notEqual(bad, source); assert.throws(() => check(bad), assert.AssertionError);
});
it('CSS: шапка просмотрщика полупрозрачная, имя 20 жирным, назад занимает 56 и даёт отступ имени 72', () => {
  pair('.lightbox .lb-top', 'background', 'rgb(0 0 0 / 0.5)', 'transparent');
  pair('.lightbox .lb-name', 'font-size', '20px', '16px'); pair('.lightbox .lb-name', 'font-weight', '700', '400');
  pair('.lightbox .lb-back', 'width', '56px', '40px'); pair('.lightbox .lb-back', 'height', '56px', '40px');
  value(source, '.lightbox .lb-top', 'gap', 'var(--sp-4)'); value(source, '.lightbox .lb-back', 'margin-right', 'calc(16px - var(--sp-4))');
  pair('.lightbox .lb-sub', 'font-size', '14px', '12px');
});
it('CSS: пилюля номера 23px по центру на 10px ниже шапки и прячется в lb-bare', () => {
  const sel = '.lightbox .lb-count';
  for (const [prop, expected, bad] of [['top', 'calc(56px + max(env(safe-area-inset-top), var(--gv-sat, 0px)) + 10px)', '56px'], ['left', '50%', '0'], ['transform', 'translateX(-50%)', 'none'], ['height', '23px', '30px'], ['border-radius', 'var(--r-pill)', '0']]) pair(sel, prop, expected, bad);
  pair('.lightbox.lb-bare .lb-count', 'opacity', '0', '1', null);
  pair('.lightbox.lb-bare .lb-count', 'pointer-events', 'none', 'auto', null);
});
