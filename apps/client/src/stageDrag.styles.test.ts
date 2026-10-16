import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const dragSource = readFileSync(new URL('./useStageDrag.ts', import.meta.url), 'utf8');

type CssRule = { selectors: string[]; declarations: Map<string, string> };

// Для этих простых правил достаточно плоского CSS-разбора: комментарии убираются, а селекторы
// выбираются только из блоков без вложенных фигурных скобок (media-внутренние правила тоже видны).
function cssRules(raw: string): CssRule[] {
  const uncommented = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  for (const match of uncommented.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const header = match[1].trim();
    if (!header || header.startsWith('@')) continue;
    const declarations = new Map<string, string>();
    for (const declaration of match[2].split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
    rules.push({ selectors: header.split(',').map(selector => selector.trim()), declarations });
  }
  return rules;
}

function dragTimingConstants(source = dragSource): { hold: number; hint: number } {
  const file = ts.createSourceFile('useStageDrag.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Map<string, number>();
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        ['STAGE_DRAG_HOLD_MS', 'STAGE_DRAG_HINT_MS'].includes(node.name.text) &&
        node.initializer && ts.isNumericLiteral(node.initializer)) {
      found.set(node.name.text, Number(node.initializer.text));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  const hold = found.get('STAGE_DRAG_HOLD_MS'); const hint = found.get('STAGE_DRAG_HINT_MS');
  assert.equal(typeof hold, 'number', 'в useStageDrag явно задана длительность удержания');
  assert.equal(typeof hint, 'number', 'в useStageDrag явно задана длительность подсказки');
  return { hold: hold!, hint: hint! };
}

function pressingTransition(raw = css, timingSource = dragSource): string | undefined {
  const pressing = cssRules(raw).find(rule => rule.selectors.includes(".stage-dnd > [data-drag='pressing']"));
  const transition = pressing?.declarations.get('transition');
  assert.ok(transition, 'состояние pressing применяется к контейнеру любого режима .stage-dnd');
  const duration = /(?:^|,)\s*transform\s+([\d.]+)ms\s+linear(?:\s*,|$)/.exec(transition)?.[1];
  assert.ok(duration, 'анимация поджатия имеет явную длительность transform в миллисекундах');
  const { hold, hint } = dragTimingConstants(timingSource);
  assert.equal(hold - hint, 350, 'удержание минус подсказка равно согласованным 350 мс');
  assert.equal(Number(duration), hold - hint, 'поджатие завершается ровно в момент подъёма плитки');
  return transition;
}

function draggingControlsOpacity(raw = css): string | undefined {
  const rule = cssRules(raw).find(candidate => candidate.selectors.includes('.stage-dnd[data-dragging] .screen-controls'));
  const opacity = rule?.declarations.get('opacity');
  assert.equal(opacity, '0', 'контролы показа прозрачны только под селектором активного перетаскивания');
  return opacity;
}

function draggingOverflowAnchor(raw = css): string | undefined {
  const rule = cssRules(raw).find(candidate => candidate.selectors.includes('.stage-dnd[data-dragging]') &&
    candidate.declarations.has('overflow-anchor'));
  const value = rule?.declarations.get('overflow-anchor');
  assert.equal(value, 'none', 'браузер не должен якорить прокрутку, пока DOM-плитки переставляются');
  return value;
}

it('R246 плитка поджимается 350 мс — до подъёма через HOLD минус HINT', () => {
  pressingTransition();
  const rules = cssRules(css);
  assert.equal(rules.find(rule => rule.selectors.includes('.stage-dnd'))?.declarations.get('position'), 'relative',
    'гнездо и offsetLeft режима просмотра считаются от своего контейнера');
  for (const phase of ['lifted', 'settling']) assert.equal(
    rules.find(rule => rule.selectors.includes(`.stage-dnd > [data-drag='${phase}']`))?.declarations.get('z-index'), '2',
    'подъём и посадка в режиме просмотра рисуются поверх соседей, не только в stage-grid');
});

it('R246 возврат долгого таймера или старого селектора сцены обнаруживается по исходному CSS', () => {
  pressingTransition();
  const oldDuration = css.replace("transition: transform 350ms linear, box-shadow var(--t-fast) ease-out;",
    "transition: transform 1.7s linear, box-shadow var(--t-fast) ease-out;");
  assert.throws(() => pressingTransition(oldDuration), assert.AssertionError,
    'сохранённые 1.7 секунды уже не соответствуют короткому удержанию');
  const oldSelector = css.replace(".stage-dnd > [data-drag='pressing']", ".stage-grid > [data-drag='pressing']");
  assert.throws(() => pressingTransition(oldSelector), assert.AssertionError,
    'режим просмотра использует .stage-dnd, а не только сетку');
});

it('R246 screen-controls скрыты только селектором перетаскивания сцены', () => {
  draggingControlsOpacity();
});

it('R246 мутант показа screen-controls во время перетаскивания обнаруживается', () => {
  draggingControlsOpacity();
  const shown = css.replace(".stage-dnd[data-dragging] .screen-controls {\n  opacity: 0;",
    ".stage-dnd[data-dragging] .screen-controls {\n  opacity: 1;");
  assert.throws(() => draggingControlsOpacity(shown), assert.AssertionError,
    'управление показом не должно ловить отпускание вместо завершения жеста');
});

it('R247 прокрутка сцены теряет anchoring только во время перетаскивания — близкие селекторы не подходят', () => {
  // Иначе браузер сам возвращает полосу к прежней плитке при изменении порядка DOM.
  draggingOverflowAnchor();
  const block = '.stage-dnd[data-dragging] {\n  overflow-anchor: none;\n}';
  assert.equal(css.split(block).length - 1, 1, 'точный блок присутствует один раз в исходном CSS');
  for (const mutant of [
    css.replace(block, ''),
    css.replace(block, block.replace('overflow-anchor: none;', 'overflow-anchor: auto;')),
    css.replace(block, block.replace('.stage-dnd[data-dragging]', '.stage-grid[data-dragging]')),
    css.replace(block, block.replace('.stage-dnd[data-dragging]', '.stage-dnd')),
  ]) {
    assert.throws(() => draggingOverflowAnchor(mutant), assert.AssertionError,
      'удаление свойства, auto и селекторы без общего контейнера в состоянии dragging должны ловиться');
  }
});
