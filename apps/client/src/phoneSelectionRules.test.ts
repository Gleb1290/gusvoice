import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './phoneSelectionRules';

it('user-select берётся у первого явного предка, auto и пустые значения пропускаются', () => {
  // Ловит уничтожение разрешённого выделения из-за запрета на более далёком предке.
  const check = (api: typeof rules) => {
    for (const [values, expected] of [
      [['auto', 'auto', 'none'], 'none'], [['auto', 'text', 'none'], 'text'], [['none', 'text'], 'none'],
      [[], 'auto'], [['', undefined, 'all'], 'all'], [['auto', 'auto'], 'auto'], [[null, 'contain', 'none'], 'contain'],
    ] as const) assert.equal(api.effectiveUserSelect(values), expected);
  };
  check(rules);
  const source = readFileSync(new URL('./phoneSelectionRules.ts', import.meta.url), 'utf8');
  for (const [from, to] of [["v && v !== 'auto'", 'v'], ['if (v && v !== \'auto\') return v;', "if (v === 'none') return v;"]]) {
    assert.ok(source.includes(from)); const module = { exports: {} };
    runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
    assert.throws(() => check(module.exports as typeof rules), assert.AssertionError);
  }
});

it('снимается только запрещённое выделение интерфейса телефона, поля и разрешённый текст сохраняются', () => {
  // Страховка от капель Android не должна уничтожать выделение для копирования в редакторе.
  const check = (api: typeof rules) => {
    const s = { phone: true, collapsed: false, fieldFocused: false, anchorUserSelect: 'none' };
    assert.equal(api.shouldDropSelection(s), true);
    for (const patch of [{ phone: false }, { collapsed: true }, { fieldFocused: true }, ...['all', 'text', 'auto', ''].map(anchorUserSelect => ({ anchorUserSelect }))]) assert.equal(api.shouldDropSelection({ ...s, ...patch }), false);
  };
  check(rules);
  const source = readFileSync(new URL('./phoneSelectionRules.ts', import.meta.url), 'utf8');
  for (const [a,b] of [['!s.phone || ', ''], ['s.collapsed || ', ''], [' || s.fieldFocused', ''], ["=== 'none'", "!== 'text'"]]) {
    assert.ok(source.includes(a), 'мутант меняет действующую ветку');
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(source.replace(a,b), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
    assert.throws(() => check(module.exports as typeof rules), assert.AssertionError);
  }
});
