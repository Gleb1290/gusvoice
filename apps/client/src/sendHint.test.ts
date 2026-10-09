import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './sendHint';

it('подсказка ждёт пять знаков и полные сутки, а показывается не более трёх раз', () => {
  const day = rules.SEND_HINT_GAP_MS;
  assert.equal(rules.sendHintDue({ shows: 0, at: 0 }, day, 4), false);
  assert.equal(rules.sendHintDue({ shows: 0, at: 0 }, day, 5), true);
  assert.equal(rules.sendHintDue({ shows: 1, at: 1000 }, 1000 + day - 1, 10), false);
  assert.equal(rules.sendHintDue({ shows: 1, at: 1000 }, 1000 + day, 10), true);
  assert.equal(rules.sendHintDue({ shows: 3, at: 0 }, day * 20, 10), false);
  const source = readFileSync(new URL('./sendHint.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('now - s.at >= SEND_HINT_GAP_MS'));
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace('now - s.at >= SEND_HINT_GAP_MS', 'now - s.at > SEND_HINT_GAP_MS'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
  const mutant = module.exports as typeof rules;
  assert.throws(() => assert.equal(mutant.sendHintDue({ shows: 1, at: 1000 }, 1000 + day, 10), true), assert.AssertionError,
    'мутант пропускает точную границу суток');
});

it('битое хранилище безопасно сбрасывается, корректные счётчики нормализуются, показ записывается', () => {
  let raw: string | null = 'broken';
  const store = { getItem: (_key: string) => raw, setItem: (_key: string, value: string) => { raw = value; } };
  const source = readFileSync(new URL('./sendHint.ts', import.meta.url), 'utf8');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, localStorage: store });
  const api = module.exports as typeof rules;
  assert.equal(JSON.stringify(api.readSendHint()), JSON.stringify({ shows: 0, at: 0 }));
  raw = JSON.stringify({ shows: 2.8, at: 123, extra: true });
  assert.equal(JSON.stringify(api.readSendHint()), JSON.stringify({ shows: 2, at: 123 }));
  api.noteSendHintShown(456);
  assert.deepEqual(JSON.parse(raw!), { shows: 3, at: 456 });
});
