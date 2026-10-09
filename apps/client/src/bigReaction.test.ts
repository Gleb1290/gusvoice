import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './bigReaction';

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./bigReaction.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), `найдена точка мутации: ${from}`);
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports });
  return module.exports as typeof rules;
}

it('удержание растёт строго после 400 мс и достигает порога на точной временной границе', () => {
  // Android long-press начинается после таймаута; ровно 80% ещё не означает отпускание «большой» реакции.
  const check = (api: typeof rules) => {
    assert.equal(api.bigHoldProgress(400), 0);
    assert.equal(api.bigHoldOutcome(400, true), 'click');
    assert.equal(api.bigHoldProgress(401), 1 / 1500);
    assert.equal(api.bigHoldOutcome(401, true), 'cancel');
    assert.equal(api.bigHoldProgress(1150), 0.5);
    assert.equal(api.bigHoldProgress(1600), 0.8);
    assert.equal(api.bigHoldOutcome(1600, true), 'cancel');
    assert.equal(api.bigHoldOutcome(1601, true), 'big');
    assert.equal(api.bigHoldProgress(1900), 1);
    assert.equal(api.bigHoldOutcome(1900, false), 'big');
    assert.equal(api.bigHoldOutcome(1000, false), 'pending');
    assert.equal(api.bigHoldOutcome(1900, true, true), 'cancel');
  };
  check(rules);
  check(mutant('return p > BIG_RELEASE_AT ? \'big\' : \'cancel\';', 'return p > BIG_RELEASE_AT ? \'big\' : \'cancel\';'));
  assert.throws(() => check(mutant('return p > BIG_RELEASE_AT ? \'big\' : \'cancel\';',
    "return p >= BIG_RELEASE_AT ? 'big' : 'cancel';")), assert.AssertionError,
    'мутант включает большую реакцию ровно на 80% роста');
});

it('эффект не играет при любом из пяти запретов, даже если совпали несколько причин', () => {
  // Скрытое окно, настройка движения, лёгкий режим, другая беседа и невидимое сообщение — независимые запреты.
  const allowed = { tabHidden: false, reducedMotion: false, lite: false, convOpen: true, onScreen: true };
  const check = (api: typeof rules) => {
    assert.equal(api.shouldPlayBigEffect(allowed), true);
    for (const reason of [
      { tabHidden: true }, { reducedMotion: true }, { lite: true }, { convOpen: false }, { onScreen: false },
      { tabHidden: true, reducedMotion: true, lite: true, convOpen: false, onScreen: false },
    ]) assert.equal(api.shouldPlayBigEffect({ ...allowed, ...reason }), false);
  };
  check(rules);
  const mutations: [string, string][] = [
    ['c.tabHidden || c.reducedMotion || c.lite', 'c.reducedMotion || c.lite'],
    ['c.tabHidden || c.reducedMotion || c.lite', 'c.tabHidden || c.lite'],
    ['c.tabHidden || c.reducedMotion || c.lite', 'c.tabHidden || c.reducedMotion'],
    ['return c.convOpen && c.onScreen;', 'return c.onScreen;'],
    ['return c.convOpen && c.onScreen;', 'return c.convOpen;'],
  ];
  check(mutant('c.tabHidden || c.reducedMotion || c.lite', 'c.tabHidden || c.reducedMotion || c.lite'));
  check(mutant('return c.convOpen && c.onScreen;', 'return c.convOpen && c.onScreen;'));
  for (const [from, to] of mutations) {
    assert.throws(() => check(mutant(from, to)), assert.AssertionError,
      `мутант снимает независимый запрет: ${from} → ${to}`);
  }
});
