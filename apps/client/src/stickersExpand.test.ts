import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './stickersExpand';

const source = readFileSync(new URL('./stickersExpand.ts', import.meta.url), 'utf8');
type Rules = typeof rules;
function compiled(text: string): Rules {
  // Контрфакт исполняет весь чистый модуль, а не копию формулы или вырезанный кусок.
  const module = { exports: {} };
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, { exports: module.exports, module }, { timeout: 1000 });
  return module.exports as Rules;
}
function mutant(from: string, to: string, check: (r: Rules) => void) {
  assert.equal(source.split(from).length - 1, 1, 'мутация попадает ровно в одно место');
  check(rules);
  assert.throws(() => check(compiled(source.replace(from, to))), assert.AssertionError);
}

it('свёрнутая панель: бросок вверх от −200 раскрывает даже при малой доле, −199 ещё не бросок', () => {
  for (const v of [-201, -200]) assert.equal(rules.expandAfterDrag(false, v, 0.1), true);
  for (const v of [-199, 0, 200]) assert.equal(rules.expandAfterDrag(false, v, 0.39), false);
});
it('раскрытая панель: бросок вниз от 200 сворачивает, 199 сохраняет раскрытие', () => {
  for (const v of [200, 201]) assert.equal(rules.expandAfterDrag(true, v, 0.9), false);
  for (const v of [-200, 0, 199]) assert.equal(rules.expandAfterDrag(true, v, 0.9), true);
});
it('доля ровно 0.4 раскрывает, чуть меньше — нет; ровно 0.6 сворачивает, чуть больше — нет', () => {
  for (const [open, frac, expected] of [[false, 0.399, false], [false, 0.4, true], [false, 0.401, true], [true, 0.599, false], [true, 0.6, false], [true, 0.601, true]] as const)
    assert.equal(rules.expandAfterDrag(open, 0, frac), expected);
});
it('бросок может перевесить долю в обе стороны и состояние не переключается дважды', () => {
  assert.equal(rules.expandAfterDrag(false, -200, 0.8), true);
  assert.equal(rules.expandAfterDrag(true, 200, 0.2), false);
  assert.equal(rules.expandAfterDrag(false, 500, 0.4), true);
  assert.equal(rules.expandAfterDrag(true, -500, 0.6), false);
});
const geometry = { headerBottom: 60, chatBottom: 800, composerHeight: 50, panelHeight: 200 };
it('надбавка учитывает шапку, поле, обычную панель и зазор 6; нехватка высоты даёт ноль', () => {
  assert.equal(rules.expandedExtra(geometry), 484);
  assert.equal(rules.expandedExtra({ ...geometry, chatBottom: 316 }), 0);
  assert.equal(rules.expandedExtra({ ...geometry, chatBottom: 315 }), 0);
  assert.equal(rules.expandedExtra({ ...geometry, chatBottom: 317 }), 1);
});
it('надбавка округляется на обеих сторонах половины пикселя', () => {
  assert.equal(rules.expandedExtra({ ...geometry, chatBottom: 800.49 }), 484);
  assert.equal(rules.expandedExtra({ ...geometry, chatBottom: 800.5 }), 485);
});
it('протяжка вычитает путь вниз и зажимается на обеих границах, включая нулевой максимум', () => {
  for (const [start, dy, max, result] of [[30, -20, 100, 50], [30, 20, 100, 10], [30, 30, 100, 0], [30, 31, 100, 0], [30, -70, 100, 100], [30, -71, 100, 100], [0, -50, 0, 0]])
    assert.equal(rules.dragExtra(start, dy, max), result);
});
it('только стикеры и GIF с хотя бы одним стикером разрешают протяжку', () => {
  for (const tab of ['emoji', '', 'unknown']) for (const open of [false, true]) assert.equal(rules.canDragExpand(tab, open, '', true), false);
  for (const tab of ['stickers', 'gifs']) for (const open of [false, true]) {
    assert.equal(rules.canDragExpand(tab, open, '', false), false);
    assert.equal(rules.canDragExpand(tab, open, '', true), true);
  }
});
it('любой набранный текст блокирует только свёрнутую панель, раскрытая допускает даже пробел', () => {
  for (const tab of ['stickers', 'gifs']) for (const text of ['текст', ' ', '\n']) {
    assert.equal(rules.canDragExpand(tab, false, text, true), false);
    assert.equal(rules.canDragExpand(tab, true, text, true), true);
  }
});
it('числа TG: начало 8, бросок 200, доезд 300 и зазор 6', () => {
  assert.deepEqual([rules.EXPAND_SLOP, rules.EXPAND_FLING, rules.EXPAND_MS, rules.EXPAND_GAP], [8, 200, 300, 6]);
});
it('контрфакт: поменять пороги раскрытия и сворачивания местами нельзя', () => {
  const changed = source.replace('EXPAND_OPEN_AT = 0.4', 'EXPAND_OPEN_AT = 0.6').replace('EXPAND_CLOSE_AT = 0.6', 'EXPAND_CLOSE_AT = 0.4');
  const check = (r: Rules) => { assert.equal(r.expandAfterDrag(false, 0, 0.4), true); assert.equal(r.expandAfterDrag(true, 0, 0.6), false); };
  check(rules); assert.throws(() => check(compiled(changed)), assert.AssertionError);
});
for (const [label, from, to, check] of [
  ['знак броска вверх', 'velocityY <= -EXPAND_FLING', 'velocityY >= EXPAND_FLING', (r: Rules) => assert.equal(r.expandAfterDrag(false, -200, 0.1), true)],
  ['границу броска вниз', 'velocityY >= EXPAND_FLING', 'velocityY > EXPAND_FLING', (r: Rules) => assert.equal(r.expandAfterDrag(true, 200, 0.9), false)],
  ['границу броска вверх', 'velocityY <= -EXPAND_FLING', 'velocityY < -EXPAND_FLING', (r: Rules) => assert.equal(r.expandAfterDrag(false, -200, 0.1), true)],
  ['границу доли раскрытия', 'progress >= EXPAND_OPEN_AT', 'progress > EXPAND_OPEN_AT', (r: Rules) => assert.equal(r.expandAfterDrag(false, 0, 0.4), true)],
  ['границу доли сворачивания', 'progress <= EXPAND_CLOSE_AT', 'progress < EXPAND_CLOSE_AT', (r: Rules) => assert.equal(r.expandAfterDrag(true, 0, 0.6), false)],
  ['защиту текста', 'return expanded || text.length === 0;', 'return true;', (r: Rules) => assert.equal(r.canDragExpand('stickers', false, 'a', true), false)],
  ['наличие стикеров', 'if (!hasStickers) return false;', '', (r: Rules) => assert.equal(r.canDragExpand('gifs', true, '', false), false)],
  ['округление', 'Math.round(full - p.panelHeight)', 'Math.floor(full - p.panelHeight)', (r: Rules) => assert.equal(r.expandedExtra({ ...geometry, chatBottom: 800.5 }), 485)],
] as const) it(`контрфакт ловит ${label}`, () => mutant(from, to, check));
