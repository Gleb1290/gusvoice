import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Rule = { selectors: string[]; declarations: Map<string, string> };

// CSS-only guard: selector/declaration parsing, without asking a browser to calculate layout.
function rules(raw: string): Rule[] {
  const clean = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const result: Rule[] = [];
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const header = match[1].trim();
    if (!header || header.startsWith('@')) continue;
    const declarations = new Map<string, string>();
    for (const part of match[2].split(';')) {
      const colon = part.indexOf(':');
      if (colon >= 0) declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
    }
    result.push({ selectors: header.split(',').map(item => item.trim()), declarations });
  }
  return result;
}

function replaceDeclaration(raw: string, selector: string, property: string, nextValue: string): string {
  // Пробелами маскируем комментарии, чтобы CSS-индексы оставались прежними и подмена не попадала в комментарий.
  const withoutComments = raw.replace(/\/\*[\s\S]*?\*\//g, comment => ' '.repeat(comment.length));
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!match[1].trim().split(',').map(item => item.trim()).includes(selector)) continue;
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(`(${escaped}\\s*:\\s*)[^;]+;`);
    if (!declaration.test(match[2])) continue;
    const bodyStart = match.index! + match[0].indexOf('{') + 1;
    const bodyEnd = bodyStart + match[2].length;
    const nextBody = raw.slice(bodyStart, bodyEnd).replace(declaration, `$1${nextValue};`);
    return raw.slice(0, bodyStart) + nextBody + raw.slice(bodyEnd);
  }
  assert.fail(`Нет декларации ${property} у ${selector}`);
}

function mobileBody(raw: string, selector: string): string {
  const clean = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const media = '@media (max-width: 760px)';
  let from = 0;
  while (true) {
    const start = clean.indexOf(media, from);
    if (start < 0) break;
    const open = clean.indexOf('{', start);
    if (open < 0) break;
    let depth = 1; let close = open + 1;
    for (; close < clean.length && depth > 0; close++) {
      if (clean[close] === '{') depth++;
      else if (clean[close] === '}') depth--;
    }
    const body = clean.slice(open + 1, close - 1);
    if (body.includes(selector)) return body;
    from = close;
  }
  assert.fail(`Нет ${selector} внутри мобильного @media (max-width: 760px)`);
}

function stripDeclarations(raw = css) {
  const rule = rules(raw).find(candidate => candidate.selectors.includes('.voice-stage.watching .stage-streams') &&
    candidate.declarations.has('flex-wrap'));
  assert.ok(rule, 'полоса закрытых показов имеет отдельное правило в режиме просмотра');
  assert.equal(rule.declarations.get('flex-wrap'), 'nowrap', 'карточки остаются в одном ряду');
  assert.equal(rule.declarations.get('overflow-x'), 'auto', 'лишние карточки доступны горизонтальной прокруткой');
  assert.equal(rule.declarations.get('overflow-y'), 'hidden', 'вертикальная полоса не создаёт второй ряд');
  assert.equal(rule.declarations.get('justify-content'), 'safe center', 'переполнение начинается от начала, а не режет первые карточки');
}

function hoverDragException(raw = css) {
  const rule = rules(raw).find(candidate => candidate.selectors.includes('.voice-stage.watching .stream-card:hover:not([data-drag])'));
  assert.equal(rule?.declarations.get('transform'), 'none',
    'hover не перебивает pressing/lifted-плитку, отмеченную data-drag');
}

function mobilePeopleRows(raw = css) {
  const selector = '.app.m-content .voice-stage.watching .stage-people';
  const rule = rules(mobileBody(raw, selector)).find(candidate => candidate.selectors.includes(selector));
  assert.equal(rule?.declarations.get('grid-auto-rows'), 'max-content',
    'в телефоне ряды участников сохраняют высоту плитки, а не делят контейнер пополам');
}

function sideLayout(raw = css) {
  const parsed = rules(raw);
  const main = parsed.find(candidate => candidate.selectors.includes('.voice-stage.side .stage-main'))?.declarations;
  assert.ok(main, 'в режиме Сбоку существует отдельная область крупного содержимого');
  assert.equal(main.get('display'), 'flex'); assert.equal(main.get('flex'), '1 1 0');
  assert.equal(main.get('min-width'), '0', 'крупное содержимое может сжиматься рядом с колонкой');
  const side = parsed.find(candidate => candidate.selectors.includes('.voice-stage.side .stage-side') &&
    candidate.declarations.has('width'))?.declarations;
  assert.ok(side, 'в режиме Сбоку существует отдельная боковая колонка');
  assert.equal(side.get('display'), 'flex'); assert.equal(side.get('flex-direction'), 'column');
  assert.equal(side.get('width'), 'calc(var(--stage-side-w) + 12px)');
}

// Класс ошибки: карточки переносятся в несколько рядов, а обычный center обрезает начало переполнения.
it('R248 полоса показа остаётся в одном безопасно центрированном ряду с горизонтальной прокруткой', () => {
  stripDeclarations();
  for (const [property, value] of [['flex-wrap', 'wrap'], ['justify-content', 'center'], ['overflow-x', 'hidden']])
    assert.throws(() => stripDeclarations(replaceDeclaration(css, '.voice-stage.watching .stage-streams', property, value)),
      assert.AssertionError, `мутант ${property}: ${value} должен быть обнаружен`);
});

// Класс ошибки: специфичный hover сбрасывает transform состояния pressing/lifted у перетаскиваемой карточки.
it('R248 hover-эффект не отменяет drag-state у карточки показа', () => {
  hoverDragException();
  const oldSelector = '.voice-stage.watching .stream-card:hover:not([data-drag])';
  assert.equal(css.split(oldSelector).length - 1, 1);
  assert.throws(() => hoverDragException(css.replace(oldSelector,
    '.voice-stage.watching .stream-card:hover')), assert.AssertionError,
  'без :not([data-drag]) более специфичный hover снова перекроет состояние удержания');
});

// Класс ошибки: grid ужимает строки по доступной высоте и плитки второго ряда наезжают на первый.
it('R248 мобильная полоса людей строит ряды по высоте плитки, не по доле контейнера', () => {
  mobilePeopleRows();
  const selector = '.app.m-content .voice-stage.watching .stage-people';
  assert.throws(() => mobilePeopleRows(replaceDeclaration(css, selector, 'grid-auto-rows', '1fr')), assert.AssertionError,
    '1fr снова ужимает ряды и накладывает нижние плитки на верхние');
});

// Класс ошибки: режим Сбоку теряет одну из областей или сжимает крупное содержимое за колонку.
it('R248 режим Сбоку сохраняет крупную основную область и отдельную боковую колонку', () => {
  sideLayout();
  const side = '.voice-stage.side .stage-side';
  const sideRule = /\.voice-stage\.side \.stage-side\s*\{/g;
  assert.equal([...css.matchAll(sideRule)].length, 1);
  assert.throws(() => sideLayout(css.replace(sideRule, '.voice-stage.side .stage-side-removed {')), assert.AssertionError,
    'переименование селектора не должно молча оставить режим без боковой колонки');
});
