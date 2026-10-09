import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './pinchRules';

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./pinchRules.ts', import.meta.url), 'utf8'); assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
  return module.exports as typeof rules;
}

it('увеличение начинается строго выше 1,005, а расстояние между пальцами евклидово', () => {
  assert.equal(rules.pinchStarted(1.005), false); assert.equal(rules.pinchStarted(1.0051), true);
  assert.equal(rules.pinchDistance(0, 0, 3, 4), 5);
  assert.equal(rules.PINCH_FINISH_MS, 220); assert.equal(rules.PINCH_FINISH_EASING, 'cubic-bezier(0.25, 0.1, 0.25, 1)');
  const broken = mutant('scale > PINCH_START_SCALE', 'scale >= PINCH_START_SCALE');
  assert.throws(() => assert.equal(broken.pinchStarted(1.005), false), assert.AssertionError,
    'мутант показывает слой до реального изменения масштаба');
});

it('щипок не уменьшает исходный размер и нулевая начальная дистанция не делит на ноль', () => {
  assert.equal(rules.pinchScale(0, 0), 1); assert.equal(rules.pinchScale(5, 10), 1);
  assert.equal(rules.pinchScale(15, 10), 1.5);
  assert.equal(rules.pinchTransform(1.5, 4, -2), 'translate(4px, -2px) scale(1.5)');
  const broken = mutant('Math.max(1, dist / startDist)', 'dist / startDist');
  assert.throws(() => assert.equal(broken.pinchScale(5, 10), 1), assert.AssertionError,
    'мутант уменьшает изображение под слоем и открывает пустые края');
});
