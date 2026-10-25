import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Block = { selectors: string[]; body: string; open: number; end: number };

// Только верхний уровень: правильное правило внутри @media не подменяет базовый стиль окна.
// Комментарии не участвуют в проверке; кавычки/экранирование не дают строковым скобкам ломать scope.
function cssBlocks(raw: string) {
  const clean = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: Block[] = [];
  let depth = 0, start = 0, open = -1;
  let quote = '';
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (char === '}') {
      depth--;
      assert.ok(depth >= 0, 'R283 CSS имеет сбалансированные блоки');
      if (depth === 0) {
        blocks.push({ selectors: clean.slice(start, open).trim().split(',').map(s => s.trim()),
          body: clean.slice(open + 1, i), open, end: i });
        start = i + 1;
      }
    } else if (char === ';' && depth === 0) start = i + 1; // @import / @charset, если появятся.
  }
  assert.equal(depth, 0, 'R283 CSS закрывает все блоки');
  assert.equal(quote, '', 'R283 CSS закрывает строковые литералы');
  return { clean, blocks };
}

function declarations(raw: string, selector: string) {
  const rules = cssBlocks(raw).blocks.filter(b => b.selectors.includes(selector));
  assert.ok(rules.length > 0, `R283 действует базовое правило ${selector}`);
  const values = new Map<string, string>();
  for (const rule of rules) for (const item of rule.body.split(';')) {
    const colon = item.indexOf(':');
    if (colon < 0) continue;
    values.set(item.slice(0, colon).trim(), item.slice(colon + 1).trim().replace(/\s+/g, ' '));
  }
  return values; // Последнее объявление того же свойства побеждает, а не первое удобное совпадение.
}

const markers = {
  height: 'R283 окно ограничено живой высотой под полосой десктопа',
  overflow: 'R283 листается тело шпаргалки',
  shrink: 'R283 тело может сжаться до высоты окна',
  columns: 'R283 колонки имеют минимальную ширину 300px',
  grid: 'R283 старый grid не отменяет перетекание строк',
  row: 'R283 строка не разрывается между колонками',
  heading: 'R283 заголовок не отрывается от первой строки',
};

function boundedDialog(raw: string) {
  const modal = declarations(raw, '.modal');
  assert.equal(modal.get('display'), 'flex', 'R283 базовая модалка задаёт flex-контейнер');
  assert.equal(modal.get('flex-direction'), 'column', 'R283 шапка и тело идут вертикально');
  const sheet = declarations(raw, '.modal.cheatsheet');
  assert.equal(sheet.get('max-height')?.replace(/\s+/g, ''),
    'calc(100dvh-var(--gv-titlebar-h,0px)-2*var(--sp-6))', markers.height);
  assert.equal(sheet.get('overflow'), 'hidden', 'R283 наружное окно не листает шапку вместе с телом');
  assert.equal(declarations(raw, '.cheat-head').get('flex'), 'none', 'R283 шапка не сжимается длинным списком');
}

function scrollingColumns(raw: string) {
  const body = declarations(raw, '.cheat-body');
  assert.equal(body.get('overflow-y'), 'auto', markers.overflow);
  assert.equal(body.get('min-height'), '0', markers.shrink);
  assert.equal(body.get('flex'), '1 1 auto', 'R283 тело занимает свободную высоту под шапкой');
  assert.equal(body.get('columns'), '2 300px', markers.columns);
  assert.equal(body.get('display') === 'grid' || body.has('grid-template-columns'), false, markers.grid);
}

function unbrokenRows(raw: string) {
  assert.equal(declarations(raw, '.cheat-row').get('break-inside'), 'avoid', markers.row);
  assert.equal(declarations(raw, '.cheat-sec-title').get('break-after'), 'avoid', markers.heading);
  const key = declarations(raw, 'kbd.cheat-key');
  assert.equal(key.get('white-space'), 'nowrap', 'R283 подпись клавиши не переносится внутри капсулы');
  assert.equal(key.get('box-sizing'), 'border-box', 'R283 минимальная ширина капсулы включает её границу');
}

function changeDeclaration(raw: string, selector: string, from: string, to: string) {
  const { clean, blocks } = cssBlocks(raw);
  const matches = blocks.filter(b => b.selectors.includes(selector));
  assert.equal(matches.length, 1, `R283 однозначный селектор мутанта ${selector}`);
  const block = matches[0];
  assert.equal(block.body.split(from).length - 1, 1, `R283 однозначное объявление мутанта ${from}`);
  return clean.slice(0, block.open + 1) + block.body.replace(from, to) + clean.slice(block.end);
}

function failsAt(marker: string) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.split('\n')[0] === marker;
}

it('R283 высота шпаргалки учитывает динамический экран и titlebar, шапка остаётся вне прокрутки', () => {
  // Иначе длинный список срежет шапку сверху или уйдёт под полосу настольного окна.
  boundedDialog(css);
});

it('R283 тело шпаргалки сжимается и прокручивается, узкое окно допускает одну колонку', () => {
  // Две колонки без минимальной ширины не адаптируются, а flex без min-height:0 распирает окно.
  scrollingColumns(css);
});

it('R283 строки не делятся на колонки, заголовок остаётся с первой строкой, клавиши цельные', () => {
  // Читаемость теряется, если описание и сочетание окажутся в разных колонках.
  unbrokenRows(css);
});

it('R283 потеря высоты, прокрутки или возврат grid ловятся даже при правильном CSS в комментарии', () => {
  // Отрицательный контроль отличает действующие декларации от старого текста и проверяет оригинал первым.
  boundedDialog(css); scrollingColumns(css); unbrokenRows(css);
  const cases = [
    ['.modal.cheatsheet', 'max-height: calc(100dvh - var(--gv-titlebar-h, 0px) - 2 * var(--sp-6));', '', boundedDialog, markers.height],
    ['.cheat-body', 'overflow-y: auto;', '', scrollingColumns, markers.overflow],
    ['.cheat-body', 'columns: 2 300px;', 'display: grid; grid-template-columns: 1fr 1fr;', scrollingColumns, markers.columns],
    ['.cheat-body', 'columns: 2 300px;', 'columns: 2 300px; display: grid; grid-template-columns: 1fr 1fr;', scrollingColumns, markers.grid],
    ['.cheat-body', 'min-height: 0;', '', scrollingColumns, markers.shrink],
    ['.cheat-row', 'break-inside: avoid;', '', unbrokenRows, markers.row],
    ['.cheat-sec-title', 'break-after: avoid;', '', unbrokenRows, markers.heading],
  ] as const;
  for (const [selector, from, to, check, marker] of cases) {
    check(css);
    const changed = changeDeclaration(css, selector, from, to);
    assert.notEqual(changed, css);
    const comment = `\n/* ${selector} { ${from} } */`;
    assert.throws(() => check(changed + comment), failsAt(marker));
  }
  // Настоящее позднее переопределение важнее раннего правильного значения той же специфичности.
  assert.throws(() => scrollingColumns(css + '\n.cheat-body { overflow-y: hidden; }'), failsAt(markers.overflow));
});
