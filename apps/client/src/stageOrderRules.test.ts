import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './stageOrderRules';

const source = readFileSync(new URL('./stageOrderRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Rules = typeof rules;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function load(raw: string): Rules {
  const module = { exports: {} as Rules };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { throw Error(`Неизвестный импорт ${id}`); } });
  return module.exports;
}
function mutation(anchor: string, replacement: string, check: (r: Rules) => void) {
  assert.equal(source.split(anchor).length - 1, 1, 'якорь уникален');
  check(rules);
  assert.throws(() => check(load(source.replace(anchor, replacement))), assert.AssertionError);
}
function apply(r: Rules) {
  assert.deepEqual(plain(r.applyStageOrder(['a', 'b', 'c', 'a'], ['b', 'gone', 'b', 'a'])), ['b', 'a', 'c']);
  assert.deepEqual(plain(r.applyStageOrder(['a', 'a', 'b'], null)), ['a', 'b']);
}
function merge(r: Rules) { assert.deepEqual(plain(r.mergeStageOrder(['lost0', 'a', 'lost1', 'lost2', 'b'], ['b', 'a'])), ['lost0', 'b', 'a', 'lost1', 'lost2']); }
function cap(r: Rules) { assert.deepEqual(plain(r.mergeStageOrder(['a', 'x', 'b', 'y'], ['b', 'a'], 2)), ['b', 'a']); }
function move(r: Rules) { assert.deepEqual(plain(r.moveStageKey(['a', 'b', 'c'], 'a', 2)), ['b', 'c', 'a']); assert.deepEqual(plain(r.moveStageKey(['a', 'b', 'c'], 'c', -1)), ['c', 'a', 'b']); }
// Класс ошибки: новые плитки вытесняют сохранённые или появляются дубликаты React key.
it('R169 известные плитки по месту, ушедшие пропущены, новые в конце, повторы схлопнуты', () => apply(rules));
// Класс ошибки: пустая настройка меняет порядок по умолчанию.
it('R169 null, undefined и пустой порядок оставляют уникальный состав по умолчанию', () => {
  for (const saved of [null, undefined, []]) assert.deepEqual(rules.applyStageOrder(['a', 'a', 'b'], saved), ['a', 'b']);
  assert.deepEqual(rules.applyStageOrder([], ['a']), []);
});
// Класс ошибки: потеря прежнего места вернувшегося участника.
it('R169 ушедшие возвращаются после прежнего левого соседа, без него в начало', () => merge(rules));
// Класс ошибки: лимит режет видимые плитки вместо памяти об ушедших.
it('R169 обрезаются ушедшие с конца, видимые сохраняются даже сверх лимита', () => {
  cap(rules); assert.deepEqual(rules.mergeStageOrder(['a', 'x', 'b', 'y'], ['b', 'a'], 3), ['b', 'y', 'a']);
  assert.deepEqual(rules.mergeStageOrder(null, ['a', 'b', 'c'], 1), ['a', 'b', 'c']);
  const visible = Array.from({ length: 65 }, (_, i) => `v${i}`);
  assert.deepEqual(rules.mergeStageOrder(['gone', ...visible], visible), visible);
  assert.equal(rules.mergeStageOrder(Array.from({ length: 64 }, (_, i) => `k${i}`), []).length, 64);
});
// Класс ошибки: неправильный индекс после удаления и изменение входного массива.
it('R169 перенос вперёд и назад зажимает и округляет индекс, отсутствующий ключ даёт копию', () => {
  move(rules); const a = ['a', 'b', 'c'];
  assert.deepEqual(rules.moveStageKey(a, 'c', 1.9), ['a', 'c', 'b']);
  assert.deepEqual(rules.moveStageKey(a, 'a', 100), ['b', 'c', 'a']);
  for (const key of ['missing', 'b']) { const b = rules.moveStageKey(a, key, 1); assert.deepEqual(b, a); assert.notEqual(b, a); }
  assert.deepEqual(a, ['a', 'b', 'c']); assert.deepEqual(rules.moveStageKey([], 'a', 0), []);
});
// Класс ошибки: сравнение лишь длины и коллизия человека с показом.
it('R169 равенство поэлементно, порядок по умолчанию уникален, ключи показов отделены от людей', () => {
  assert.equal(rules.sameStageOrder(['a'], ['b']), false); assert.equal(rules.sameStageOrder([], []), true);
  assert.equal(rules.sameStageOrder(['a'], []), false); assert.equal(rules.sameStageOrder(['a'], ['a']), true);
  assert.equal(rules.isDefaultStageOrder(['a', 'a', 'b'], ['a', 'b']), true);
  assert.equal(rules.isDefaultStageOrder(['a', 'b'], ['b', 'a']), false);
  assert.equal(rules.personTileKey('u'), 'p:u'); assert.equal(rules.streamTileKey('u'), 's:u');
  assert.equal(rules.streamTileKey('u#screen'), 's:u'); assert.equal(rules.streamTileKey('u#screen-other'), 's:u#screen-other');
});
// Класс ошибки: повреждённое хранилище роняет все каналы.
it('R169 битые JSON и структуры отвергаются, корректный сосед битого канала сохраняется', () => {
  for (const raw of [null, undefined, '', '{bad', 'null', '[]', '1', '{}', '{"channels":[]}']) assert.deepEqual(rules.parseStageOrders(raw), {});
  const parsed = rules.parseStageOrders(JSON.stringify({ channels: { bad: [], bad2: { cols: [] }, good: { at: 'bad', cols: {
    0: ['bad'], abc: ['bad'], 1000: ['bad'], '01': ['bad'], 1: ['', 1, null, 'x'.repeat(201), 'x'.repeat(200), 'a'], 999: ['z'], 2: 'bad', 3: [],
  } } } }));
  assert.deepEqual(parsed, { good: { at: 0, cols: { 1: ['x'.repeat(200), 'a'], 999: ['z'] } } });
  const keys = Array.from({ length: 65 }, (_, i) => `k${i}`);
  assert.equal(rules.parseStageOrders(JSON.stringify({ channels: { good: { at: 12, cols: { 2: keys } } } })).good.cols['2'].length, 64);
  assert.deepEqual(rules.parseStageOrders(rules.serializeStageOrders({ a: { at: 1, cols: { 2: ['a'] } } })), { a: { at: 1, cols: { 2: ['a'] } } });
});
function eviction(r: Rules) {
  const initial = { oldest: { at: 1, cols: { 1: ['a'] } }, newest: { at: 20, cols: { 1: ['b'] } } };
  const next = r.putStageOrder(initial, 'current', 2, ['c'], 0, 2);
  assert.deepEqual(Object.keys(next).sort(), ['current', 'newest']);
}
// Класс ошибки: вытеснение свежего или текущего канала и мутация исходника.
it('R169 лимит сорока каналов вытесняет старейший, текущий не вытесняется даже с ранним at', () => {
  eviction(rules); const input: rules.StageOrders = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, { at: i, cols: { 1: ['a'] } }]));
  assert.equal(Object.keys(rules.putStageOrder(input, 'c39', 2, ['b'], 100)).length, 40);
  const next = rules.putStageOrder(input, 'new', 1, ['x'], -1);
  assert.equal(Object.keys(next).length, 40); assert.equal('c0' in next, false); assert.equal('new' in next, true);
  assert.equal(Object.keys(input).length, 40); assert.equal(input.c39.cols['2'], undefined);
});
// Класс ошибки: обрезка ближайшей ширины вместо наиболее далёкой.
it('R169 восемь ширин сохраняются, девятая удаляет наиболее далёкую, текущая всегда остаётся', () => {
  let orders: rules.StageOrders = {};
  for (let n = 1; n <= 8; n++) orders = rules.putStageOrder(orders, 'a', n, [String(n)], n);
  assert.equal(Object.keys(orders.a.cols).length, 8);
  const next = rules.putStageOrder(orders, 'a', 9, ['new'], 9);
  assert.equal(Object.keys(next.a.cols).length, 8); assert.equal(next.a.cols['1'], undefined); assert.deepEqual(next.a.cols['9'], ['new']);
  assert.deepEqual(orders.a.cols['1'], ['1']);
});
// Класс ошибки: лимит колонки вытесняет текущую или сохранённые массивы связаны с входом.
it('R169 текущая средняя ширина переживает удаление дальних, входные массивы копируются', () => {
  const cols = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 100].map(n => [String(n), ['old']]));
  const initial = { a: { at: 1, cols } }; const order = ['new'];
  const result = rules.putStageOrder(initial, 'a', 5, order, 2);
  assert.equal(Object.keys(result.a.cols).length, 8); assert.equal(result.a.cols['100'], undefined);
  order.push('later'); assert.deepEqual(result.a.cols['5'], ['new']); assert.deepEqual(initial.a.cols['5'], ['old']);
});
// Класс ошибки: сброс другого канала или лишнее уведомление при отсутствии записи.
it('R169 сброс отсутствующего возвращает тот же объект, существующего удаляет только его', () => {
  const a = { a: { at: 1, cols: { 1: ['x'], 2: ['y'] } }, b: { at: 2, cols: { 1: ['z'] } } };
  assert.equal(rules.dropStageOrders(a, 'missing'), a); assert.deepEqual(rules.dropStageOrders(a, 'a'), { b: a.b }); assert.equal('a' in a, true);
});
function edges(r: Rules) {
  const slots = [{ x: 10, y: 20, w: 100, h: 50 }, { x: 120, y: 20, w: 100, h: 50 }];
  for (const [x, y, result] of [[10, 20, 0], [109.99, 69.99, 0], [110, 20, null], [10, 70, null], [115, 30, null], [120, 20, 1], [9, 20, null]] as const)
    assert.equal(r.stageDropIndex({ x, y }, slots), result);
  assert.equal(r.stageDropIndex({ x: 0, y: 0 }, []), null);
}
// Класс ошибки: включённая правая или нижняя граница перескакивает через зазор.
it('R169 ячейка включает левый верхний край, исключает правый нижний и зазор', () => edges(rules));
// Класс ошибки: регрессии порядка обнаруживаются целым исполняемым модулем.
it('R169 мутанты новых в начале и несхлопнутых повторов убиваются', () => {
  mutation('return [...known, ...unique.filter((k) => !seen.has(k))];', 'return [...unique.filter((k) => !seen.has(k)), ...known];', apply);
  mutation('if (present.has(k)) continue;', 'if (false) continue;', apply);
});
// Класс ошибки: регрессии памяти об ушедших и лимита.
it('R169 мутанты потери ушедших и удаления видимых убиваются', () => {
  mutation('result.splice(at, 0, k);', '// пропущено', merge);
  mutation('if (!visibleSet.has(result[i])) {', 'if (visibleSet.has(result[i])) {', cap);
});
// Класс ошибки: перенос без зажима или вставка до удаления.
it('R169 мутанты переноса до удаления и отсутствующего зажима убиваются', () => {
  mutation('next.splice(from, 1);\n  next.splice(to, 0, key);', 'next.splice(to, 0, key);\n  next.splice(from, 1);', move);
  mutation('Math.max(0, Math.min(order.length - 1, Math.trunc(toIndex)))', 'Math.trunc(toIndex)', move);
});
// Класс ошибки: равенство длины вместо содержимого и коллизия префиксов.
it('R169 мутанты сравнения только длины и одинакового префикса убиваются', () => {
  mutation('a.length === b.length && a.every((k, i) => k === b[i])', 'a.length === b.length', r => assert.equal(r.isDefaultStageOrder(['a', 'b'], ['b', 'a']), false));
  mutation('return `p:${identity}`;', 'return `s:${identity}`;', r => assert.equal(r.personTileKey('u'), 'p:u'));
});
// Класс ошибки: вытеснение нового или текущего канала.
it('R169 мутанты вытеснения новейшего и текущего убиваются', () => {
  mutation('.sort((a, b) => next[a].at - next[b].at)', '.sort((a, b) => next[b].at - next[a].at)', eviction);
  mutation('.filter((id) => id !== channelId)', '.filter(() => true)', eviction);
});
// Класс ошибки: включение исключённой границы.
it('R169 мутант включительной правой границы убивается', () => mutation('center.x < s.x + s.w', 'center.x <= s.x + s.w', edges));
