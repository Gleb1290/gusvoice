import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './notifyPopupRules';

type Rules = typeof rules;
const notice = (id: string, group = id): rules.PopupNotice => ({ id, tag: `tag-${id}`, title: id, body: `текст ${id}`, group });
const ids = (rows: readonly rules.PopupNotice[]) => Array.from(rows, n => n.id).join(',');
const source = readFileSync(new URL('./notifyPopupRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw: string): Rules {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports });
  return module.exports as Rules;
}

function capacity(api: Rules) {
  let st = api.EMPTY_STACK;
  for (const id of ['1', '2', '3']) st = api.popupPush(st, notice(id), 3);
  assert.equal(ids(st.shown), '1,2,3'); assert.equal(st.queue.length, 0);
  st = api.popupPush(st, notice('4'), 3);
  assert.equal(st.shown.length, 3, 'R223-capacity: четвёртая карточка ждёт места');
  assert.equal(ids(st.queue), '4');
}
it('R223 ровно три карточки помещаются, четвёртая остаётся в очереди без изменения исходного стека', () => {
  capacity(rules);
  const st = { shown: [notice('1')], queue: [] };
  const next = rules.popupPush(st, notice('2'), 3);
  assert.equal(ids(st.shown), '1'); assert.equal(ids(next.shown), '1,2');
});
it('R223 закрытие показанной или ожидающей карточки добирает очередь по времени прихода', () => {
  const st = { shown: [notice('1'), notice('2'), notice('3')], queue: [notice('4'), notice('5')] };
  const next = rules.popupRemove(st, '2', 3);
  assert.equal(ids(next.shown), '1,3,4'); assert.equal(ids(next.queue), '5');
  const queued = rules.popupRemove(st, '4', 3);
  assert.equal(ids(queued.shown), '1,2,3'); assert.equal(ids(queued.queue), '5');
  assert.equal(ids(rules.popupRemove(st, 'missing', 3).shown), '1,2,3');
  assert.equal(ids(st.queue), '4,5');
});
it('R223 изменение вместимости сохраняет последние карточки, вытесненные добираются раньше прежней очереди', () => {
  const st = { shown: [notice('1'), notice('2'), notice('3')], queue: [notice('4'), notice('5')] };
  const less = rules.popupFill(st, 2);
  assert.equal(ids(less.shown), '2,3'); assert.equal(ids(less.queue), '1,4,5');
  const more = rules.popupFill(less, 5);
  assert.equal(ids(more.shown), '2,3,1,4,5'); assert.equal(ids(more.queue), '');
  assert.equal(rules.popupFill(st, 3), st);
  assert.equal(ids(rules.popupFill({ shown: [], queue: [notice('1')] }, 3).shown), '1');
});
it('R223 прочтение беседы удаляет её карточки и с экрана, и из очереди, не задевая другую беседу', () => {
  const st = { shown: [notice('1', 'A'), notice('2', 'B'), notice('3', 'A')], queue: [notice('4', 'A'), notice('5', 'B'), notice('6', 'C')] };
  const next = rules.popupDropGroup(st, 'A', 3);
  assert.equal(ids(next.shown), '2,5,6'); assert.equal(ids(next.queue), '');
  assert.equal(ids(rules.popupDropGroup(st, 'missing', 3).shown), '1,2,3');
  assert.equal(ids(st.shown), '1,2,3'); assert.equal(ids(st.queue), '4,5,6');
});
function order(api: Rules) {
  const shown = [notice('1'), notice('2'), notice('3')];
  for (const corner of ['br', 'bl'] as const) assert.equal(ids(api.popupOrder(shown, corner)), '1,2,3');
  for (const corner of ['tl', 'tr'] as const) assert.equal(ids(api.popupOrder(shown, corner)), '3,2,1', 'R223-order: новая сверху у верхнего угла');
  assert.equal(ids(shown), '1,2,3'); assert.notEqual(api.popupOrder(shown, 'br'), shown);
}
it('R223 новая карточка ближе к выбранному углу, исходный массив не переворачивается', () => order(rules));
function hideAll(api: Rules) {
  assert.equal(api.popupShowsHideAll({ shown: [], queue: [] }), false);
  assert.equal(api.popupShowsHideAll({ shown: [notice('1')], queue: [] }), false);
  assert.equal(api.popupShowsHideAll({ shown: [notice('1'), notice('2')], queue: [] }), true, 'R223-hide-all: несколько карточек без очереди тоже можно скрыть');
  assert.equal(api.popupShowsHideAll({ shown: [notice('1')], queue: [notice('2')] }), true);
}
it('R223 «Скрыть все» появляется при нескольких карточках или при непустой очереди', () => hideAll(rules));
it('R223 строка группы содержит автора, личная строка не получает лишнее двоеточие', () => {
  assert.equal(rules.popupLine({ author: 'Имя1', body: 'Привет' }), 'Имя1: Привет');
  assert.equal(rules.popupLine({ body: 'Привет' }), 'Привет');
  assert.equal(rules.popupLine({ author: '', body: 'Привет' }), 'Привет');
});
it('R223 настройки угла и количества принимают допустимые значения, округляют и зажимают границы 1…5', () => {
  for (const corner of ['tl', 'tr', 'bl', 'br']) assert.equal(rules.popupCorner(corner), corner);
  for (const value of [undefined, null, '', 'bad', 1, {}, 'BR']) assert.equal(rules.popupCorner(value), 'br');
  for (const value of [undefined, NaN, Infinity, -Infinity, 'мусор', {}]) assert.equal(rules.popupCount(value), 3);
  for (let n = 1; n <= 5; n++) assert.equal(rules.popupCount(n), n);
  assert.equal(rules.popupCount(0), 1); assert.equal(rules.popupCount(6), 5);
  assert.equal(rules.popupCount('4'), 4); assert.equal(rules.popupCount(2.49), 2); assert.equal(rules.popupCount(2.5), 3);
  // Текущее поведение Number(): пустое значение становится нулём, затем зажимается до единицы.
  for (const value of [null, '', false]) assert.equal(rules.popupCount(value), 1);
});
it('R223 угасание ждёт ввода строго после показа, неизвестный idle разрешает таймер', () => {
  assert.equal(rules.popupInputSeen(1000, 2000, 1001), false);
  assert.equal(rules.popupInputSeen(1000, 2000, 1000), false);
  assert.equal(rules.popupInputSeen(1000, 2000, 999), true);
  assert.equal(rules.popupInputSeen(1000, 2000, null), true);
});
for (const [label, from, to, check, prefix, actual, expected] of [
  ['лишнее место', 'st.shown.length < popupCount(max)', 'st.shown.length <= popupCount(max)', capacity, 'R223-capacity:', 4, 3],
  ['пропал переворот верхнего угла', '[...shown].reverse()', '[...shown]', order, 'R223-order:', '1,2,3', '3,2,1'],
  ['обе причины скрытия обязательны', 'st.shown.length > 1 || st.queue.length > 0', 'st.shown.length > 1 && st.queue.length > 0', hideAll, 'R223-hide-all:', false, true],
] as const) it(`R223 контрфакт стопки: ${label}`, () => {
  check(load(source)); assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => check(load(source.replace(from, to))), e => e instanceof assert.AssertionError
    && e.message.startsWith(prefix) && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});

function lineParts(api: Rules) {
  const cases: [Pick<rules.PopupNotice, 'author' | 'body' | 'kind'>, { from: string; kind: string; text: string }, string][] = [
    [{ author: 'Автор', kind: 'Фото', body: '' }, { from: 'Автор: ', kind: 'Фото', text: '' }, 'Автор: Фото'],
    [{ kind: 'Фото', body: '' }, { from: '', kind: 'Фото', text: '' }, 'Фото'],
    [{ author: 'Автор', kind: 'Фото', body: 'Подпись' }, { from: 'Автор: ', kind: 'Фото, ', text: 'Подпись' }, 'Автор: Фото, Подпись'],
    [{ kind: 'Фото', body: 'Подпись' }, { from: '', kind: 'Фото, ', text: 'Подпись' }, 'Фото, Подпись'],
    [{ author: 'Автор', body: 'Текст' }, { from: 'Автор: ', kind: '', text: 'Текст' }, 'Автор: Текст'],
    [{ author: '', kind: '', body: 'Текст' }, { from: '', kind: '', text: 'Текст' }, 'Текст'],
    [{ kind: '📊 Куда идём?', body: '' }, { from: '', kind: '📊 Куда идём?', text: '' }, '📊 Куда идём?'],
    [{ body: '' }, { from: '', kind: '', text: '' }, ''],
  ];
  for (const [notice, expected, line] of cases) {
    const parts = api.popupLineParts(notice);
    assert.equal(parts.kind, expected.kind, 'R233-line-separator: без подписи запятая не нужна');
    assert.deepEqual({ ...parts }, expected);
    assert.equal(api.popupLine(notice), line);
    assert.equal(parts.from + parts.kind + parts.text, api.popupLine(notice), 'R233-line-join: части составляют ровно ту же строку');
  }
}
it('R233 строка и выделенные части совпадают, у вида без подписи нет висящей запятой', () => lineParts(rules));
it('R233 контрфакт строки: запятая после вида добавляется даже без подписи', () => {
  lineParts(load(source));
  const from = "(n.body ? `${n.kind}, ` : n.kind)";
  assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => lineParts(load(source.replace(from, '`${n.kind}, `'))), e => e instanceof assert.AssertionError
    && e.message.startsWith('R233-line-separator:') && e.operator === 'strictEqual' && e.actual === 'Фото, ' && e.expected === 'Фото');
});
