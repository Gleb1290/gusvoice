import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as rules from './readByView';

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./readByView.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'мутант меняет существующую ветку');
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
  return module.exports as typeof rules;
}

it('чтение требует фокуса и отсутствия слоя, простой ровно 30 секунд блокирует только ПК', () => {
  // Открытая беседа под настройками или в забытом окне не является прочитанной.
  const check = (api: typeof rules) => {
    const g = { focused: true, covered: false, mobile: false, idleMs: 29999 };
    assert.equal(api.canMarkRead(g), true);
    assert.equal(api.canMarkRead({ ...g, idleMs: 30000 }), false);
    assert.equal(api.canMarkRead({ ...g, mobile: true, idleMs: 90000 }), true);
    for (const mobile of [false, true]) {
      assert.equal(api.canMarkRead({ ...g, mobile, focused: false }), false);
      assert.equal(api.canMarkRead({ ...g, mobile, covered: true }), false);
    }
  };
  check(rules);
  for (const api of [mutant('!g.covered', 'true'), mutant('g.mobile ||', 'false ||')]) assert.throws(() => check(api), assert.AssertionError);
});

it('прочитан только нижний край внутри окна с допуском один пиксель, высокая строка не читается заранее', () => {
  // Видимая верхушка длинного сообщения не означает, что человек увидел его конец.
  const check = (api: typeof rules) => {
    const f = (a: number[], top = 100, bottom = 200) => api.lastSeenIndex(a.length, i => a[i], top, bottom);
    assert.equal(f([]), -1);
    assert.equal(f([99, 100]), -1);
    assert.equal(f([250]), -1);
    assert.equal(f([101, 150, 201, 202]), 2);
    assert.equal(f([202]), -1);
    assert.equal(f([100, 150]), 1);
  };
  check(rules);
  for (const api of [mutant('<= viewBottom + 1', '< viewBottom + 1'), mutant('bottomAt(found) > viewTop', 'true')]) assert.throws(() => check(api), assert.AssertionError);
});
