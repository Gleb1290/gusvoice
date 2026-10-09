import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as rules from './dmBackBadge';

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./dmBackBadge.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'заменяется действующее правило');
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
  return module.exports as typeof rules;
}

it('бейдж считает только другие беседы с флагом непрочитанного, включая флаг без числа', () => {
  // Остаток открытой беседы и опоздавшие числовые сводки не должны раздувать кнопку «Назад».
  const check = (api: typeof rules) => {
    assert.equal(api.dmBackBadgeCount([], [], null), 0);
    const list = [{ id: 'open', unread: 90 }, { id: 'no-flag', unread: 20 }, { id: 'zero', unread: 0 }, { id: 'missing' }, { id: 'many', unread: 4 }];
    assert.equal(api.dmBackBadgeCount(list, ['open', 'zero', 'missing', 'many'], 'open'), 6);
    assert.equal(api.dmBackBadgeCount(list, [], undefined), 0);
    assert.equal(api.dmBackBadgeCount([{ id: 'x', unread: 2 }], ['x'], null), 2);
  };
  check(rules);
  for (const api of [mutant('d.id === currentDmId || ', ''), mutant('!unreadDms.includes(d.id)', 'false'), mutant('d.unread : 1', 'd.unread : 0')])
    assert.throws(() => check(api), assert.AssertionError);
});

it('ровно 99 показываются числом, только 100 и выше сокращаются', () => {
  // Ошибка на единицу преждевременно прячет точное число непрочитанных.
  const check = (api: typeof rules) => {
    assert.equal(api.dmBackBadgeLabel(0), '0');
    assert.equal(api.dmBackBadgeLabel(99), '99');
    assert.equal(api.dmBackBadgeLabel(100), '99+');
    assert.equal(api.dmBackBadgeLabel(999), '99+');
  };
  check(rules);
  assert.throws(() => check(mutant('n > 99', 'n >= 99')), assert.AssertionError);
});
