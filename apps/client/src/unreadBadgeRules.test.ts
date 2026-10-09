import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as dmListRules from './dmListRules';
import * as rules from './unreadBadgeRules';

function mutant(source: string, from: string, to: string): typeof rules {
  assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.equal(id, './dmListRules'); return dmListRules; } });
  return module.exports as typeof rules;
}

it('значок суммирует действующие непрочитанные, игнорируя полную заглушку, но считая soundOnly', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const list = [
    { id: 'normal', unread: 3 },
    { id: 'muted', unread: 10, muted: { until: null } },
    { id: 'sound', unread: 4, muted: { until: null, soundOnly: true } },
    { id: 'expired', unread: 2, muted: { until: '2026-10-08T11:00:00Z' } },
    { id: 'empty', unread: 0 },
  ];
  const source = readFileSync(new URL('./unreadBadgeRules.ts', import.meta.url), 'utf8');
  const check = (api: typeof rules) => assert.equal(api.unreadBadgeCount(list, now), 9);
  check(rules);
  check(mutant(source, '!muteActive(d.muted, now)', '!muteActive(d.muted, now)'));
  const broken = mutant(source, '!muteActive(d.muted, now)', 'false');
  assert.throws(() => check(broken), assert.AssertionError,
    'мутант включает заглушённые беседы в значок Windows/трея');
});

it('сводка по беседам не включает нулевые записи и «только что прочитано» учитывает исчезнувшие', () => {
  assert.deepEqual(rules.unreadByConv([{ id: 'a', unread: 2 }, { id: 'b', unread: 0 }, { id: 'c' }]), { a: 2 });
  assert.deepEqual(rules.convsJustRead({ a: 2, b: 1, c: 0 }, { a: 0, b: 2, d: 1 }), ['a']);
  assert.deepEqual(rules.convsJustRead({}, { a: 1 }), []);
});
