import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './desktopKeysRules';

function mutated(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./desktopKeysRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
  return module.exports as typeof rules;
}

it('Ctrl+W/F4 прячет, Ctrl+Q выходит, Ctrl+\\ открывает меню; модификаторы остаются чужими', () => {
  const key = (code: string, patch = {}) => rules.windowKey({ code, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, ...patch });
  assert.equal(key('KeyW'), 'hide'); assert.equal(key('F4'), 'hide'); assert.equal(key('KeyQ'), 'quit'); assert.equal(key('Backslash'), 'chatMenu');
  for (const patch of [{ ctrlKey: false }, { altKey: true }, { shiftKey: true }, { metaKey: true }]) assert.equal(key('KeyQ', patch), null);
  const mutant = mutated('e.shiftKey ||', 'false ||');
  assert.throws(() => assert.equal(mutant.windowKey({ code: 'KeyW', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }), null), assert.AssertionError,
    'мутант перехватывает браузерное сочетание Ctrl+Shift+W');
});

it('выход спрашивает только при реальном звонке, голосе или загрузке и перечисляет причины', () => {
  const empty = { inCall: false, inVoice: false, uploading: false };
  assert.deepEqual(rules.quitBlockers(empty), []);
  assert.deepEqual(rules.quitBlockers({ inCall: true, inVoice: true, uploading: true }), ['идёт звонок', 'вы в голосовом канале', 'идёт загрузка файла']);
  assert.deepEqual(rules.quitBlockers({ ...empty, uploading: true }), ['идёт загрузка файла']);
  const mutant = mutated('if (s.inCall) out.push', 'if (true) out.push');
  assert.notDeepEqual(mutant.quitBlockers(empty), [], 'мутант безусловно блокирует обычный выход');
});
