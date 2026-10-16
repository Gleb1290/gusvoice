import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as convRules from './convSyncRules';
import * as rules from './attachRules';

type Rules = typeof rules;
const raw = readFileSync(new URL('./attachRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const ids = ['a', 'b', 'c', 'd', 'e'];
const show = (value: unknown) => JSON.stringify(value);
function load(source: string): Rules {
  const module = { exports: {} };
  const deps: Record<string, unknown> = { '@gusvoice/shared': shared, './convSyncRules': convRules };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `объявленный импорт полного attachRules: ${id}`); return deps[id]; } });
  return module.exports as Rules;
}
function rebase(r: Rules) {
  const base = ['seed'];
  assert.equal(show(r.sweepOrder(base, ids, 1, 3, true, 10)), '{"order":["seed","b","c","d"],"full":false}');
  assert.equal(show(r.sweepOrder(base, ids, 1, 1, true, 10)), '{"order":["seed","b"],"full":false}',
    'R218-base: обратный ход возвращает вышедшие из диапазона ячейки к исходному состоянию');
  assert.equal(show(base), '["seed"]', 'снимок до мазка не мутирует при прямом и обратном ходе');
}
function upward(r: Rules) {
  assert.equal(show(r.sweepOrder([], ids, 3, 1, true, 10)), '{"order":["d","c","b"],"full":false}',
    'R218-direction: вверх номера добавляются от якоря к текущей ячейке');
}
function room(r: Rules) {
  assert.equal(show(r.sweepOrder(['seed'], ids, 0, 3, true, 3)), '{"order":["seed","a","b"],"full":true}',
    'R218-room: предел останавливает добавление, сохраняя уже выбранное и full');
}
function blocked(r: Rules) {
  assert.equal(show(r.sweepOrder([], ids, 0, 2, true, 10, id => id === 'b')), '{"order":["a","c"],"full":false}',
    'R218-blocked: запрещённый файл пропускается, следующий допустимый всё ещё выбирается');
}
it('R218 мазок вперёд и обратно пересчитывается от неизменного снимка выбора', () => rebase(rules));
it('R218 мазок вверх сохраняет порядок прохода от якоря, а не порядок массива', () => upward(rules));
it('R218 снятие диапазона сохраняет остальные, обратный ход возвращает их из base', () => {
  const base = ['seed', 'd', 'b', 'c'];
  assert.equal(show(rules.sweepOrder(base, ids, 1, 3, false, 0)), '{"order":["seed"],"full":false}');
  assert.equal(show(rules.sweepOrder(base, ids, 1, 1, false, 0)), '{"order":["seed","d","c"],"full":false}');
  assert.equal(show(base), '["seed","d","b","c"]');
});
it('R218 ровно room ещё принимается без full, следующий элемент останавливает мазок', () => {
  assert.equal(show(rules.sweepOrder(['seed'], ids, 0, 1, true, 3)), '{"order":["seed","a","b"],"full":false}');
  room(rules);
});
it('R218 нулевой room не добавляет новый элемент и сообщает full', () => {
  assert.equal(show(rules.sweepOrder([], ids, 0, 0, true, 0)), '{"order":[],"full":true}');
});
it('R218 blocked не выбирается, но не мешает допустимым соседям', () => blocked(rules));
it('R218 снятие уже выбранного допускается независимо от room и blocked', () => {
  assert.equal(show(rules.sweepOrder(['a', 'b', 'c'], ids, 1, 1, false, 0, () => true)), '{"order":["a","c"],"full":false}');
});
for (const [anchor, cur] of [[-1, 0], [0, -1], [5, 2], [2, 5]]) it(`R218 индексы ${anchor}/${cur} вне сетки возвращают копию base без full`, () => {
  const base = ['seed']; const result = rules.sweepOrder(base, ids, anchor, cur, true, 0);
  assert.equal(show(result), '{"order":["seed"],"full":false}'); assert.notEqual(result.order, base);
});
it('R218 пустая сетка и повтор уже выбранного не расходуют room повторно', () => {
  assert.equal(show(rules.sweepOrder(['a'], [], 0, 0, true, 1)), '{"order":["a"],"full":false}');
  assert.equal(show(rules.sweepOrder(['a'], ids, 0, 0, true, 1)), '{"order":["a"],"full":false}');
});
it('R218 автопрокрутка молчит в середине и ровно на границах краевых полос', () => {
  for (const y of [64, 250, 436]) assert.equal(rules.sweepScrollSpeed(y, 500), 0);
});
it('R218 автопрокрутка движется вверх сверху и вниз снизу, к краю быстрее', () => {
  assert.equal(rules.sweepScrollSpeed(0, 100, 10, 2), -2, 'R218-scroll-sign: верхний край должен прокручиваться вверх');
  assert.equal(rules.sweepScrollSpeed(5, 100, 10, 2), -1);
  assert.equal(rules.sweepScrollSpeed(95, 100, 10, 2), 1);
  assert.equal(rules.sweepScrollSpeed(100, 100, 10, 2), 2);
});
function speedCap(r: Rules) {
  assert.equal(r.sweepScrollSpeed(-10, 100, 10, 2), -2, 'R218-scroll-cap: палец за верхним краем не разгоняет выше max');
  assert.equal(r.sweepScrollSpeed(110, 100, 10, 2), 2);
}
it('R218 палец за краем сохраняет максимум скорости в обе стороны', () => speedCap(rules));
it('R218 высота ровно две полосы отключает прокрутку, следующий пиксель разрешает', () => {
  for (const height of [0, 10, 20]) assert.equal(rules.sweepScrollSpeed(0, height, 10, 2), 0);
  assert.equal(rules.sweepScrollSpeed(0, 21, 10, 2), -2);
});
const files = [{ att: { name: 'ЕЖИК.TXT' } }, { att: { name: 'другой.pdf' } }, { att: { name: 'ёж.txt' } }];
function folded(r: Rules) {
  assert.equal(show(r.filterFilesByName(files, '  ёЖ  ')), '[{"att":{"name":"ЕЖИК.TXT"}},{"att":{"name":"ёж.txt"}}]',
    'R218-filter: регистр, ё/е и краевые пробелы не делят один запрос');
}
it('R218 пустой и пробельный запрос возвращают копию списка с теми же объектами', () => {
  for (const query of ['', ' \t ']) {
    const result = rules.filterFilesByName(files, query); assert.notEqual(result, files);
    assert.deepEqual(result, files); assert.equal(result[0], files[0]);
  }
});
it('R218 поиск нормализует регистр, ё/е и края, сохраняя исходный порядок', () => folded(rules));
it('R218 запрос без совпадений даёт пусто, подстрока имени принимается', () => {
  assert.deepEqual(rules.filterFilesByName(files, 'неизвестный'), []);
  assert.deepEqual(rules.filterFilesByName(files, 'ГоЙ.P'), [files[1]]);
});

for (const [label, from, to, scenario, prefix, actual, expected] of [
  ['снимок base заменён текущим изменяемым выбором', '  const order = [...base];', '  const order = base as string[];', rebase,
    'R218-base:', '{"order":["seed","b","c","d"],"full":false}', '{"order":["seed","b"],"full":false}'],
  ['шаг идёт от текущей ячейки к якорю', 'for (let i = anchor; i !== cur + step; i += step) range.push(ids[i]!);',
    'for (let i = cur; i !== anchor - step; i -= step) range.push(ids[i]!);', upward,
    'R218-direction:', '{"order":["b","c","d"],"full":false}', '{"order":["d","c","b"],"full":false}'],
  ['room не ограничивает диапазон', 'if (order.length >= room) {', 'if (false) {', room, 'R218-room:',
    '{"order":["seed","a","b","c","d"],"full":false}', '{"order":["seed","a","b"],"full":true}'],
  ['blocked не проверяется', 'order.includes(id) || blocked(id)', 'order.includes(id)', blocked, 'R218-blocked:',
    '{"order":["a","b","c"],"full":false}', '{"order":["a","c"],"full":false}'],
  ['верхний край движется вниз', 'return -max * Math.min(1, (edge - y) / edge);', 'return max * Math.min(1, (edge - y) / edge);',
    (r: Rules) => assert.equal(r.sweepScrollSpeed(0, 100, 10, 2), -2, 'R218-scroll-sign: верхний край должен прокручиваться вверх'),
    'R218-scroll-sign:', 2, -2],
  ['за верхним краем нет ограничения max', 'return -max * Math.min(1, (edge - y) / edge);', 'return -max * ((edge - y) / edge);', speedCap,
    'R218-scroll-cap:', -4, -2],
  ['ё не нормализуется', ".replace(/ё/g, 'е')", '', folded, 'R218-filter:', '[{"att":{"name":"ёж.txt"}}]',
    '[{"att":{"name":"ЕЖИК.TXT"}},{"att":{"name":"ёж.txt"}}]'],
] as const) it(`R218 правила контрфакт: ${label}`, () => {
  scenario(load(raw)); assert.equal(raw.split(from).length - 1, 1, 'однозначная мутация полного attachRules');
  assert.throws(() => scenario(load(raw.replace(from, to))), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith(prefix) && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected);
});
