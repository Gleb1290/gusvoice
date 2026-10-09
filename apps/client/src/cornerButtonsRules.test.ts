import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './cornerButtonsRules';
function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./cornerButtonsRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from));
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
  return module.exports as typeof rules;
}
it('упоминания ниже реакций, нулевые и отрицательные счётчики не создают кнопок', () => {
  // Ловит лишнюю кнопку на нуле и перепутанную колонку навигации.
  const check = (api: typeof rules) => {
    const buttons = api.cornerButtons({ mentions: 2, reactions: 1000 });
    assert.equal(buttons.map((b) => b.kind).join(','), 'mentions,reactions');
    assert.equal(buttons[0]?.title, 'Непрочитанные упоминания: 2');
    assert.equal(buttons[1]?.title, 'Непрочитанные реакции: 1000');
    assert.equal(buttons[1]?.label, '999+');
    for (const n of [0, -1, undefined, NaN]) assert.equal(api.cornerButtons({ mentions: n, reactions: n }).length, 0);
  }; check(rules);
  assert.throws(() => check(mutant('m > 0', 'm >= 0')), assert.AssertionError);
  assert.throws(() => check(mutant('r > 0', 'r >= 0')), assert.AssertionError);
  assert.throws(() => check(mutant('return out;', 'return out.reverse();')), assert.AssertionError);
});
it('999 показывается точно, 1000 сокращается, отметки списка требуют положительного числа', () => {
  // Ловит раннее округление значка и пустые отметки рядом со счётчиком.
  const check = (api: typeof rules) => {
    assert.equal(api.cornerCountLabel(999), '999');
    assert.equal(api.cornerCountLabel(1000), '999+');
    assert.equal(api.cornerCountLabel(1), '1');
  }; check(rules);
  assert.throws(() => check(mutant('n > CORNER_COUNT_MAX', 'n >= CORNER_COUNT_MAX')), assert.AssertionError);
  assert.deepEqual(rules.rowMarks({}), { mentions: false, reactions: false });
  assert.deepEqual(rules.rowMarks({ unreadMentions: 0, unreadReactions: -1 }), { mentions: false, reactions: false });
  assert.deepEqual(rules.rowMarks({ unreadMentions: 1, unreadReactions: 2 }), { mentions: true, reactions: true });
});
it('видимые непрочитанные отмечаются по ленте ровно один раз', () => {
  // Ловит чтение вне экрана и двойное уменьшение счётчика.
  const check = (api: typeof rules) => assert.equal(api.reactionsToMark(['b', 'a', 'b', 'hidden', 'c'], new Set(['a', 'b', 'c'])).join(','), 'b,a,c');
  check(rules);
  assert.throws(() => check(mutant(' && !seen.has(id)', '')), assert.AssertionError);
  assert.deepEqual(rules.reactionsToMark([], new Set(['a'])), []);
  assert.deepEqual(rules.reactionsToMark(['a'], new Set()), []);
});
