import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type * as API from './quickReaction';

function load(from?: string, to = ''): typeof API {
  let source = readFileSync(new URL('./quickReaction.ts', import.meta.url), 'utf8');
  if (from) { assert.ok(source.includes(from)); source = source.replace(from, to); }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.equal(id, 'react'); return {}; } });
  return module.exports as typeof API;
}
it('неизвестный режим даёт реакцию, пробелы и граница 32 символа не ломают настройку', () => {
  // Негодный кеш не должен молча выключить реакцию или отправить серверу слишком длинный emoji.
  const check = (api: typeof API) => {
    for (const raw of [undefined, null, '', 'bogus', '__proto__']) assert.equal(api.parseDoubleClickAction(raw), 'react');
    for (const raw of ['react', 'reply', 'none'] as const) assert.equal(api.parseDoubleClickAction(raw), raw);
    for (const raw of [undefined, null, '', ' ', 'x'.repeat(33)]) assert.equal(api.parseQuickReaction(raw), '👍');
    assert.equal(api.parseQuickReaction(' x '.repeat(1)), 'x');
    assert.equal(api.parseQuickReaction('x'.repeat(32)), 'x'.repeat(32));
    assert.equal(api.parseQuickReaction(' 🔥 '), '🔥');
  };
  check(load());
  assert.throws(() => check(load("DOUBLE_CLICK_DEFAULT: DoubleClickAction = 'react'", "DOUBLE_CLICK_DEFAULT: DoubleClickAction = 'reply'")), assert.AssertionError);
});
it('быстрая реакция первая, чужая вытесняет хвост, исходный набор не меняется', () => {
  // Нельзя расширить полосу или потерять выбранную реакцию на следующем открытии.
  const check = (api: typeof API) => {
    const set = ['👍', '🔥', '❤️'];
    assert.deepEqual(Array.from(api.quickBarOrder(set, '🔥')), ['🔥', '👍', '❤️']);
    assert.deepEqual(Array.from(api.quickBarOrder(set, '🙂')), ['🙂', '👍', '🔥']);
    assert.deepEqual(set, ['👍', '🔥', '❤️']);
    assert.deepEqual(Array.from(api.quickBarOrder([], '🙂')), ['🙂']);
  };
  check(load());
  assert.throws(() => check(load('[quick, ...rest]', '[...rest, quick]')), assert.AssertionError);
  assert.throws(() => check(load('.slice(0, Math.max(set.length, 1))', '')), assert.AssertionError);
});
