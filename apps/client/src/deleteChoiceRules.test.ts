import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './deleteChoiceRules';

it('ПК помнит только выбор «у себя», телефон всегда начинает со снятой галочкой', () => {
  const store = new Map<string, string>(); const io = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
  assert.equal(rules.deleteBothDefault(false, io), true); assert.equal(rules.deleteBothDefault(true, io), false);
  rules.rememberDeleteChoice(false, io); assert.equal(rules.deleteBothDefault(false, io), false);
  rules.rememberDeleteChoice(true, io); assert.equal(rules.deleteBothDefault(false, io), true);
  assert.equal(rules.deleteRememberAvailable(false), true); assert.equal(rules.deleteRememberAvailable(true), false);
  const source = readFileSync(new URL('./deleteChoiceRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(source.includes('if (phone) return false;'));
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace('if (phone) return false;', 'if (phone) return true;'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
  const phoneDefaultMutant = module.exports as typeof rules;
  assert.throws(() => assert.equal(phoneDefaultMutant.deleteBothDefault(true, io), false), assert.AssertionError,
    'мутант включает отзыв сообщения у собеседника на телефоне по умолчанию');
});

it('«Запомнить выбор» появляется только когда галочка изменилась от исходной', () => {
  assert.equal(rules.rememberRowVisible({ checked: false, remember: true }, true), true);
  assert.equal(rules.rememberRowVisible({ checked: false, remember: true }, false), false);
  assert.equal(rules.rememberRowVisible({ checked: true }, false), false);
  assert.equal(rules.rememberRowVisible(undefined, true), false);
  const source = readFileSync(new URL('./deleteChoiceRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('current !== spec.checked'));
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace('current !== spec.checked', 'true'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports });
  const broken = module.exports as typeof rules;
  assert.throws(() => assert.equal(broken.rememberRowVisible({ checked: false, remember: true }, false), false), assert.AssertionError,
    'мутант показывает запоминание, хотя человек оставил галочку в состоянии по умолчанию');
});
