import { counterfact as runCounterfact } from '../test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as actual from './duel.js';
import type { DuelGreedyDto, DuelSide } from './duel.js';

type Rules = typeof actual;
type Mutation = { from: string; to: string };
const source = readFileSync(new URL('./duel.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sides: DuelSide[] = ['challenger', 'target'];
const viewers: (DuelSide | null)[] = [...sides, null];
const state = (turn: DuelSide): DuelGreedyDto => ({
  scores: { challenger: 11, target: 17 }, turn, turnPoints: 8,
  lastRoll: { by: turn, die: 6 }, burned: 9,
  timeouts: { challenger: 2, target: 1 }, seq: 23, first: 'target', rolls: [2, 1, 6, 3, 1, 5],
});

function load(raw: string): Rules {
  const module = { exports: {} };
  // Целый настоящий модуль, а не копия/вырезка greedyHide.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    require(id: string) { assert.fail(`R356 подготовка: неожиданный импорт shared/duel ${id}`); },
  }, { timeout: 2_000 });
  return module.exports as Rules;
}

function expected(g: DuelGreedyDto, viewer: DuelSide | null): DuelGreedyDto {
  const ownTurn = g.turn === viewer;
  const ownLast = g.lastRoll?.by === viewer;
  return {
    scores: { challenger: viewer === 'challenger' ? 11 : 0, target: viewer === 'target' ? 17 : 0 },
    turn: g.turn, turnPoints: ownTurn ? 8 : 0,
    lastRoll: g.lastRoll && (ownLast || g.lastRoll.die === 1) ? { ...g.lastRoll } : null,
    burned: ownLast || !g.lastRoll ? 9 : 0,
    timeouts: { challenger: 2, target: 1 }, seq: 23, first: 'target',
    rolls: [0, 1, 0, 0, 1, 0], hidden: { challenger: viewer !== 'challenger', target: viewer !== 'target' },
  };
}

function checkMask(rules: Rules, viewer: DuelSide | null, turn: DuelSide): void {
  const g = state(turn), saved = normal(g);
  const shown = rules.greedyHide(g, viewer);
  assert.deepEqual(normal(shown), expected(g, viewer), 'R356 проверка: свой счёт открыт, чужие числа скрыты, метаданные сохранены');
  assert.equal(shown.rolls.length, g.rolls.length, 'R356 проверка: факт каждого броска сохраняется без его значения');
  assert.deepEqual(g, saved, 'R356 проверка: маска не меняет полный исходник');
}

describe('R356 маска Жадного гуся: своё открыто, чужое скрыто', () => {
  for (const viewer of viewers) for (const turn of sides) {
    it(`смотрящий ${viewer ?? 'зритель'}, ход ${turn}: счёт, копилка и последний бросок показаны только владельцу`, () => {
      checkMask(actual, viewer, turn);
    });
  }

  for (const viewer of viewers) for (const by of sides) {
    it(`смотрящий ${viewer ?? 'зритель'}, единица у ${by}: сгорание видно, чужая сгоревшая сумма скрыта`, () => {
      const g = state(by);
      // После единицы ход уже у другой стороны: burned относится к lastRoll.by, не к turn.
      g.turn = by === 'challenger' ? 'target' : 'challenger';
      g.lastRoll = { by, die: 1 };
      const saved = normal(g), shown = actual.greedyHide(g, viewer);
      assert.deepEqual(normal(shown), expected(g, viewer), 'R356 проверка: единица публична, сумма сгорания только своя');
      assert.deepEqual(g, saved, 'R356 проверка: показ сгорания не меняет исходник');
    });
  }

  for (const viewer of viewers) {
    it(`смотрящий ${viewer ?? 'зритель'}: отсутствие последнего броска остаётся null`, () => {
      const g = state('target');
      g.lastRoll = null;
      assert.deepEqual(normal(actual.greedyHide(g, viewer)), expected(g, viewer), 'R356 проверка: null не превращается в поддельный бросок');
    });
  }

  it('маска владеет своими вложенными объектами и не превращает пустую историю в бросок', () => {
    const g = state('challenger'), saved = normal(g), shown = actual.greedyHide(g, 'challenger');
    shown.scores.challenger = 99;
    shown.timeouts.target = 99;
    shown.lastRoll!.die = 2;
    shown.rolls.push(1);
    shown.hidden!.target = false;
    assert.deepEqual(g, saved, 'R356 проверка: изменение показанного DTO не портит полный вид');
    g.rolls = [];
    assert.deepEqual(actual.greedyHide(g, null).rolls, [], 'R356 проверка: ноль бросков остаётся нулём бросков');
  });

  it('контрфакты ловят скрытие своей стороны, утечки бросков/сгорания, длину истории и потерю hidden', () => {
    const check = (rules: Rules) => { for (const viewer of viewers) for (const turn of sides) checkMask(rules, viewer, turn); };
    const mutations: Mutation[] = [
      { from: "const hide = { challenger: viewer !== 'challenger', target: viewer !== 'target' };",
        to: "const hide = { challenger: viewer === 'challenger', target: viewer === 'target' };" },
      { from: 'lastRoll: !last || (lastHidden && last.die !== 1) ? null : { by: last.by, die: last.die },',
        to: 'lastRoll: !last ? null : { by: last.by, die: last.die },' },
      { from: 'burned: lastHidden ? 0 : g.burned,', to: 'burned: g.burned,' },
      { from: 'rolls: g.rolls.map((v) => (v === 1 ? 1 : 0)),', to: 'rolls: [...g.rolls],' },
      { from: 'rolls: g.rolls.map((v) => (v === 1 ? 1 : 0)),', to: 'rolls: g.rolls.map((v) => (v === 1 ? 1 : 0)).slice(1),' },
      { from: 'hidden: hide,', to: '' },
    ];
    check(actual);
    check(load(source));
    for (const { from, to } of mutations) {

      runCounterfact(() => {
        assert.equal(source.split(from).length, 2, `R356 подготовка: единственный якорь ${from}`);
        const mutant = load(source.replace(from, to));
        assert.throws(() => check(mutant), (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith('R356 проверка:'),
          'контрфакт убивается утверждением о поведении, не ошибкой загрузки');
      });
      check(load(source));
    }
  });
});
