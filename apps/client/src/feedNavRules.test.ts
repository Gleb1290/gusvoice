import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './feedNavRules';

it('навигация распознаёт только Alt-стрелки и Ctrl+Alt края без Shift и Meta', () => {
  // Эти клавиши работают из textarea, но не должны отнимать выделение и системные сочетания.
  const e = { code: 'ArrowUp', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false };
  assert.equal(rules.feedNavKey(e), 'up'); assert.equal(rules.feedNavKey({ ...e, code: 'ArrowDown' }), 'down');
  assert.equal(rules.feedNavKey({ ...e, ctrlKey: true, code: 'Home' }), 'first'); assert.equal(rules.feedNavKey({ ...e, ctrlKey: true, code: 'End' }), 'last');
  for (const patch of [{ altKey: false }, { ctrlKey: true }, { shiftKey: true }, { metaKey: true }, { code: 'Home' }]) assert.equal(rules.feedNavKey({ ...e, ...patch }), null);
});

it('стрелки и края списка не зацикливаются, неизвестная текущая ведёт к первой', () => {
  // Повтор на последней строке не должен прыгать к первой или повторно выбирать текущую.
  const check = (api: typeof rules) => {
    const ids = ['a','b','c'];
    assert.equal(api.feedNavTarget([], 'a', 'down'), null);
    assert.equal(api.feedNavTarget(ids, 'absent', 'down'), 'a');
    assert.equal(api.feedNavTarget(ids, 'a', 'up'), null); assert.equal(api.feedNavTarget(ids, 'c', 'down'), null);
    assert.equal(api.feedNavTarget(ids, 'b', 'up'), 'a'); assert.equal(api.feedNavTarget(ids, 'b', 'down'), 'c');
    assert.equal(api.feedNavTarget(ids, 'a', 'first'), null); assert.equal(api.feedNavTarget(ids, 'c', 'last'), null);
  };
  check(rules);
  const source = readFileSync(new URL('./feedNavRules.ts', import.meta.url), 'utf8');
  for (const [a,b] of [['Math.max(0, Math.min(ids.length - 1, at))', 'at'], ["key === 'down' ? 1 : -1", "key === 'down' ? -1 : 1"]]) {
    assert.ok(source.includes(a), 'мутант найден'); const module = { exports: {} };
    runInNewContext(ts.transpileModule(source.replace(a,b), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
    assert.throws(() => check(module.exports as typeof rules), assert.AssertionError);
  }
});
