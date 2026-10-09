import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './swipeBack';

function loadMutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./swipeBack.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
  return module.exports as typeof rules;
}

it('свайп начинает слой только вправо и почти горизонтально, а вертикаль и свайп-ответ остаются чужими', () => {
  assert.equal(rules.swipeBackIntent(24, 0), 'track');
  assert.equal(rules.swipeBackIntent(24, 8), 'wait', 'равно трём вертикальным смещениям недостаточно');
  assert.equal(rules.swipeBackIntent(25, 8), 'track');
  assert.equal(rules.swipeBackIntent(-10, 0), 'other');
  assert.equal(rules.swipeBackIntent(10, 20), 'other');
  assert.equal(rules.swipeBackIntent(23, 0), 'wait');
  const mutant = loadMutant('dx > SWIPE_BACK_RATIO * ay', 'dx >= SWIPE_BACK_RATIO * ay');
  assert.throws(() => assert.equal(mutant.swipeBackIntent(24, 8), 'wait'), assert.AssertionError,
    'мутант захватывает жест ровно на границе отношения 3 к 1');
});

it('возврат завершается на границе трети или броске 1350 px/с, offset зажат в ширину', () => {
  assert.equal(rules.swipeBackCommit(100, 0, 300), false);
  assert.equal(rules.swipeBackCommit(101, 0, 300), true);
  assert.equal(rules.swipeBackCommit(0, 1349, 300), false);
  assert.equal(rules.swipeBackCommit(0, 1350, 300), true);
  assert.equal(rules.swipeBackCommit(1000, 5000, 0), false);
  assert.deepEqual([-10, 0, 40, 120].map(x => rules.swipeBackOffset(x, 100)), [0, 0, 40, 100]);
});
