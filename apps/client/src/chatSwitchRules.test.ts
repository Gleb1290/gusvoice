import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './chatSwitchRules';

function mutated(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./chatSwitchRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
  return module.exports as typeof rules;
}

it('окно начинается только с Ctrl+Tab без Alt и Meta; его клавиши сохраняют назначение', () => {
  const checkMeta = (api: typeof rules) => assert.equal(api.isChatSwitchStart({ code: 'Tab', ctrlKey: true, altKey: false, metaKey: true }), false);
  assert.equal(rules.isChatSwitchStart({ code: 'Tab', ctrlKey: true, altKey: false, metaKey: false }), true);
  for (const patch of [{ code: 'KeyA' }, { ctrlKey: false }, { altKey: true }, { metaKey: true }])
    assert.equal(rules.isChatSwitchStart({ code: 'Tab', ctrlKey: true, altKey: false, metaKey: false, ...patch }), false);
  for (const [code, shift, action] of [['Tab', false, 'next'], ['Tab', true, 'prev'], ['ArrowRight', false, 'right'], ['ArrowLeft', false, 'left'],
    ['ArrowUp', false, 'up'], ['ArrowDown', false, 'down'], ['Escape', false, 'close'], ['Enter', false, 'choose'], ['NumpadEnter', false, 'choose'], ['KeyQ', false, 'remove']] as const)
    assert.equal(rules.chatSwitchAction({ code, shiftKey: shift, altKey: false }), action);
  assert.equal(rules.chatSwitchAction({ code: 'KeyQ', shiftKey: false, altKey: true }), null);
  checkMeta(rules);
  checkMeta(mutated('!e.metaKey', '!e.metaKey'));
  assert.throws(() => checkMeta(mutated('!e.metaKey', 'true')), assert.AssertionError,
    'мутант пропускает Meta+Ctrl, которое принадлежит системной клавише');
});

it('недавние не дублируются и ограничены 14 плитками, текущая и неизвестные беседы обрабатываются отдельно', () => {
  const recent = Array.from({ length: 18 }, (_, i) => `c${i}`);
  const checkRecent = (api: typeof rules) => {
    assert.equal(api.pushRecent(['a', 'b', 'a'], 'a').join(','), 'a,b');
    assert.equal(api.pushRecent(recent, 'new').length, 14);
  };
  checkRecent(rules);
  checkRecent(mutated('recent.filter((x) => x !== id)', 'recent.filter((x) => x !== id)'));
  assert.throws(() => checkRecent(mutated('recent.filter((x) => x !== id)', 'recent')), assert.AssertionError,
    'мутант оставляет дубликат выбранной беседы');
  assert.throws(() => checkRecent(mutated('.slice(0, max)', '.slice(0, max + 1)')), assert.AssertionError,
    'мутант оставляет пятнадцатую плитку');
  const checkList = (api: typeof rules) => assert.equal(api.chatSwitchList(['gone', 'b', 'a', 'b'], ['a', 'b', 'c'], 'c', 2).join(','), 'c,b');
  checkList(rules);
  checkList(mutated('id && known.has(id) && !out.includes(id)', 'id && known.has(id) && !out.includes(id)'));
  assert.throws(() => checkList(mutated('id && known.has(id) && !out.includes(id)', 'id && !out.includes(id)')), assert.AssertionError,
    'мутант добавляет удалённую беседу, которой уже нет в списке');
  assert.throws(() => checkList(mutated('return out.slice(0, max);', 'return out;')), assert.AssertionError,
    'мутант игнорирует предел плиток после объединения недавних и всех бесед');
  assert.deepEqual(rules.chatSwitchList(['gone', 'b', 'a', 'b'], ['a', 'b', 'c'], 'c'), ['c', 'b', 'a']);
  assert.deepEqual(rules.chatSwitchLayout(1), { rows: 1, perRow: 1 });
  assert.deepEqual(rules.chatSwitchLayout(7), { rows: 1, perRow: 7 });
  assert.deepEqual(rules.chatSwitchLayout(8), { rows: 2, perRow: 4 });
  assert.deepEqual(rules.chatSwitchLayout(14), { rows: 2, perRow: 7 });
});

it('переключение и удаление плитки не зацикливают выбор и сохраняют ближайшего соседа', () => {
  assert.equal(rules.stepNext(-1, 3), 0); assert.equal(rules.stepNext(2, 3), 0); assert.equal(rules.stepNext(0, 3), 1);
  assert.equal(rules.stepPrev(0, 3), 2); assert.equal(rules.stepPrev(1, 3), 0);
  assert.equal(rules.stepRow(0, 8, 4, 'up'), 4); assert.equal(rules.stepRow(0, 8, 4, 'down'), 4);
  assert.equal(rules.moveSelection('close', 1, 3), null);
  assert.deepEqual(rules.removeTile(['a', 'b', 'c'], 1), { ids: ['a', 'c'], selected: 1 });
  assert.deepEqual(rules.removeTile(['a', 'b', 'c'], 2), { ids: ['a', 'b'], selected: 1 });
  assert.deepEqual(rules.removeTile(['a'], 0), { ids: [], selected: -1 });
  const check = (api: typeof rules) => assert.equal(api.stepNext(2, 3), 0);
  check(rules);
  check(mutated('selected + 1 >= count', 'selected + 1 >= count'));
  assert.throws(() => check(mutated('selected + 1 >= count', 'selected + 1 > count')), assert.AssertionError,
    'мутант уходит за последнюю плитку вместо возврата к первой');
});
