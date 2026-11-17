import { counterfact } from '../../../packages/shared/test/counterfacts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const titlebarSelector = ':where(html.gv-frameless) .ctx-menu:not(.sheet)';
const baseSelector = '.ctx-menu:not(.sheet)';
const pipSelector = '.ctx-menu.stream-pip-menu:not(.sheet)';
const titlebarCeiling = 'calc(var(--vh-px, 100dvh) - 16px - var(--gv-titlebar-h, 0px))';
type Rule = { selector: string; body: string };

// Happy-dom не считает max-height, env() и раскладку. Читаем живые верхнеуровневые
// правила; комментарий или правильный селектор внутри чужого media не заменяет их.
function rootRules(raw: string): Rule[] {
  const clean = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let cursor = 0;
  while (cursor < clean.length) {
    const open = clean.indexOf('{', cursor);
    if (open < 0) break;
    let end = open + 1, depth = 1;
    while (end < clean.length && depth) {
      if (clean[end] === '{') depth++;
      else if (clean[end] === '}') depth--;
      end++;
    }
    assert.equal(depth, 0, 'R315 CSS-блок сбалансирован');
    const selector = clean.slice(cursor, open).trim().replace(/\s+/g, ' ');
    if (!selector.startsWith('@')) rules.push({ selector, body: clean.slice(open + 1, end - 1) });
    cursor = end;
  }
  return rules;
}

function lastDeclaration(rule: Rule, property: string) {
  const values = rule.body.split(';').map(declaration => {
    const colon = declaration.indexOf(':');
    return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim().replace(/\s+/g, ' ')];
  });
  return values.filter(([name]) => name === property).at(-1)?.[1];
}

function titlebarRule(raw: string) {
  const rules = rootRules(raw).filter(rule => rule.selector.includes('html.gv-frameless')
    && rule.selector.includes('.ctx-menu:not(.sheet)'));
  assert.equal(rules.length, 1, 'R315-titlebar-rule: потолок меню задан отдельным живым правилом frameless');
  return rules[0];
}

function checkTitlebarCeiling(raw = css) {
  assert.equal(lastDeclaration(titlebarRule(raw), 'max-height'), titlebarCeiling,
    'R315-titlebar-ceiling: потолок вычитает полосу окна вместе с двумя зазорами');
}

// Это намеренно ограниченный подсчёт для трёх конкретных селекторов, не CSS-движок:
// :where имеет нулевой вес, :not передаёт вес простой .sheet. Иной синтаксис отвергается.
function menuSpecificity(selector: string) {
  const simple = selector.replace(/:where\([^()]*\)/g, '').replace(/:not\((\.[\w-]+)\)/g, '$1');
  const tokens = simple.match(/[.#]?[\w-]+/g) ?? [];
  assert.equal(simple.replace(/[.#]?[\w-]+/g, '').trim(), '', 'R315 допустим только описанный синтаксис селектора');
  const ids = tokens.filter(token => token.startsWith('#')).length;
  const classes = tokens.filter(token => token.startsWith('.')).length;
  const elements = tokens.length - ids - classes;
  assert.equal(tokens.length < 100, true, 'R315 вес ограниченного селектора не переполняет разряды');
  return ids * 10000 + classes * 100 + elements;
}

function checkTitlebarPriority(raw = css) {
  const rules = rootRules(raw);
  const titlebar = titlebarRule(raw);
  const base = rules.find(rule => rule.selector === baseSelector);
  const pip = rules.find(rule => rule.selector === pipSelector);
  assert.ok(base && pip, 'R315 базовое меню и меню PiP найдены в действующих правилах');
  assert.equal(lastDeclaration(pip, 'max-height'), 'calc(100vh - 2 * var(--sp-2))',
    'R315-pip-ceiling: окошко показа ограничено своим вьюпортом, а не главным окном');
  assert.equal(menuSpecificity(titlebar.selector) < menuSpecificity(pip.selector), true,
    'R315-titlebar-pip-priority: меню PiP сильнее позднего правила главного окна');
  assert.equal(menuSpecificity(titlebar.selector), menuSpecificity(base.selector),
    'R315-titlebar-base-priority: frameless не повышает вес базового меню');
}

function changeTitlebarRule(change: (rule: string) => string) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const anchor = `${titlebarSelector} {`;
  assert.equal(clean.split(anchor).length - 1, 1, 'R315 мутант адресует единственное правило frameless');
  const start = clean.indexOf(anchor), end = clean.indexOf('}', start) + 1;
  const original = clean.slice(start, end), changed = change(original);
  assert.notEqual(changed, original, 'R315 мутант действительно меняет настоящее правило');
  return clean.slice(0, start) + changed + clean.slice(end);
}

function cssFailure(marker: string, actual: unknown, expected: unknown) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(marker)
    && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected;
}

it('R315 потолок меню frameless вычитает полосу окна, а обычное меню сохраняет системные вставки', () => {
  checkTitlebarCeiling();
  const base = rootRules(css).find(rule => rule.selector === baseSelector);
  assert.ok(base);
  assert.equal(lastDeclaration(base, 'max-height')?.includes('--gv-titlebar-h'), false,
    'R315 правило без frameless не получает полосу окна');
  for (const inset of ['--gv-sat', '--gv-sab']) {
    assert.equal(lastDeclaration(base, 'max-height')?.includes(inset), true, `R315 обычное меню сохраняет ${inset}`);
  }
});

it('R315 where оставляет вес базового меню и не перебивает раннее правило меню PiP', () => {
  checkTitlebarPriority();
});

it('R315 удаление живого правила потолка обнаруживается даже при правильной формуле в комментарии и media', () => {
  checkTitlebarCeiling();
  counterfact(() => {
    const mutant = changeTitlebarRule(() => '')
      + `\n/* ${titlebarSelector} { max-height: ${titlebarCeiling}; } */`
      + `\n@media (max-width: 1px) { ${titlebarSelector} { max-height: ${titlebarCeiling}; } }`;
    assert.throws(() => checkTitlebarCeiling(mutant), cssFailure('R315-titlebar-rule:', 0, 1));
  });
});

it('R315 удаление вычитания полосы окна обнаруживается в действующей декларации потолка', () => {
  checkTitlebarCeiling();
  counterfact(() => {
    const mutant = changeTitlebarRule(rule => {
      const term = ' - var(--gv-titlebar-h, 0px)';
      assert.equal(rule.split(term).length - 1, 1, 'R315 единственное вычитание полосы в целевом правиле');
      return rule.replace(term, '');
    });
    assert.throws(() => checkTitlebarCeiling(mutant),
      cssFailure('R315-titlebar-ceiling:', 'calc(var(--vh-px, 100dvh) - 16px)', titlebarCeiling));
  });
});

it('R315 снятие where обнаруживается именно как потеря приоритета меню PiP', () => {
  checkTitlebarPriority();
  counterfact(() => {
    const mutant = changeTitlebarRule(rule => {
      const anchor = ':where(html.gv-frameless)';
      assert.equal(rule.split(anchor).length - 1, 1, 'R315 единственная where-обёртка целевого селектора');
      return rule.replace(anchor, 'html.gv-frameless');
    });
    assert.throws(() => checkTitlebarPriority(mutant), cssFailure('R315-titlebar-pip-priority:', false, true));
  });
});
