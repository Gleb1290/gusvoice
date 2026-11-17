import { counterfact as gatedCounterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as money from './gameMoneyRules.js';
import * as actual from './gameDuelRules.js';
import type { DuelGreedyData, DuelRoundData, DuelSide } from './gameDuelRules.js';

type Rules = typeof actual;
type Row = Parameters<Rules['duelDtoFor']>[0];
type Mutation = { from: string; to: string };
const source = readFileSync(new URL('./gameDuelRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const now = new Date('2026-10-29T12:00:00.000Z');
const sides: DuelSide[] = ['challenger', 'target'];
const viewers = ['alice', 'bob', 'spectator', null] as const;
const greedy = (turn: DuelSide = 'challenger'): DuelGreedyData => ({
  scores: { challenger: 11, target: 17 }, turn, turnPoints: 8, n: 6,
  lastRoll: { by: turn, die: 6 }, burned: 9, winner: null,
  timeouts: { challenger: 2, target: 1 }, seq: 23, first: 'target', rolls: [2, 1, 6, 3, 1, 5],
});
const data = (extra: Partial<DuelRoundData> = {}): DuelRoundData => ({
  channelId: 'voice', challengerId: 'alice', targetId: 'bob', game: 'greedy', amount: 45,
  feePercent: 7, commit: 'public-commit', seed: 'ab'.repeat(32), phase: 'moving', greedy: greedy(), ...extra,
});
const row = (extra: Partial<DuelRoundData> = {}, state = 'locked'): Row => ({
  id: 'round', serverId: 'server', state, lockAt: now, settleAt: now, settledAt: now,
  data: data(extra) as unknown as Record<string, unknown>,
});

function load(raw: string): Rules {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, Buffer,
    require(id: string) {
      if (id === 'node:crypto') return crypto;
      if (id === '@gusvoice/shared') return shared;
      if (id === './gameMoneyRules.js') return money;
      assert.fail(`R356 подготовка: неожиданный импорт gameDuelRules ${id}`);
    },
  }, { timeout: 2_000 });
  return module.exports as Rules;
}

function fullGreedy(g: DuelGreedyData): shared.DuelGreedyDto {
  return { scores: { ...g.scores }, turn: g.turn, turnPoints: g.turnPoints, lastRoll: g.lastRoll && { ...g.lastRoll },
    burned: g.burned, timeouts: { ...g.timeouts }, seq: g.seq, first: g.first, rolls: [...g.rolls] };
}

function checkFull(rules: Rules, input: Row, viewer: string | null): void {
  const saved = normal(input), g = (input.data as unknown as DuelRoundData).greedy!;
  const shown = rules.duelDtoFor(input, viewer);
  assert.deepEqual(normal(shown?.greedy), fullGreedy(g), 'R356 проверка: вне скрытой фазы полный счёт, копилка, сгорание и история');
  assert.deepEqual(normal(shown), normal(rules.duelDto(input)), 'R356 проверка: полный внешний DTO совпадает с duelDto');
  assert.equal(shown!.greedy!.hidden, undefined, 'R356 проверка: раскрытая партия больше не помечена скрытой');
  assert.deepEqual(normal(input), saved, 'R356 проверка: показ полного DTO не изменяет строку');
}

function checkMasked(rules: Rules, viewer: string | null, turn: DuelSide): void {
  const input = row({ greedy: greedy(turn) }), saved = normal(input);
  const shown = rules.duelDtoFor(input, viewer);
  const own = viewer === 'alice' ? 'challenger' : viewer === 'bob' ? 'target' : null;
  assert.deepEqual(normal(shown), {
    id: 'round', serverId: 'server', channelId: 'voice', game: 'greedy', challengerId: 'alice', targetId: 'bob',
    amount: 45, feePercent: 7, state: 'playing', inviteUntil: null, commit: 'public-commit', rollNo: 0,
    turnUntil: null, rolls: [], winnerId: null, payout: null, seed: null, reason: null, settledAt: null,
    greedy: {
      scores: { challenger: own === 'challenger' ? 11 : 0, target: own === 'target' ? 17 : 0 },
      turn, turnPoints: own === turn ? 8 : 0, lastRoll: own === turn ? { by: turn, die: 6 } : null,
      burned: own === turn ? 9 : 0, timeouts: { challenger: 2, target: 1 }, seq: 23, first: 'target',
      rolls: [0, 1, 0, 0, 1, 0], hidden: { challenger: own !== 'challenger', target: own !== 'target' },
    }, moveUntil: now.toISOString(),
  }, 'R356 проверка: полный договор DTO сохраняется, игроку только своё, зрителю ни одной стороны');
  assert.deepEqual(normal(input), saved, 'R356 проверка: маска не переписывает данные партии');
}

function checkOtherGame(rules: Rules, game: 'dice' | 'rps', viewer: string | null): void {
  // Наличие старого greedy в data не меняет игру; так контрфакт без game-guard проверяется поведением, не TypeError.
  const input = row({ game, phase: game === 'dice' ? 'playing' : 'moving',
    rolls: [[2, 5, 3, 6]], rollNo: 0, revealed: [{ challenger: true, target: true }],
    rps: { rounds: [{ challenger: 'paper', target: 'rock', winner: 'challenger' }],
      ready: { challenger: true, target: false }, wins: { challenger: 1, target: 0 } },
  });
  const saved = normal(input), shown = rules.duelDtoFor(input, viewer);
  assert.equal(shown?.game, game, 'R356 проверка: игра не меняется из-за постороннего состояния');
  assert.equal(shown?.greedy, undefined, 'R356 проверка: маска гуся никогда не добавляется КНБ и кубикам');
  assert.deepEqual(normal(shown?.rolls), [{ challenger: [2, 5], target: [3, 6] }], 'R356 проверка: открытые кубики не скрыты');
  assert.deepEqual(normal(shown), normal(rules.duelDto(input)), 'R356 проверка: чужая игра не подвергается маске');
  if (game === 'rps') assert.deepEqual(normal(shown?.rps), {
    rounds: [{ challenger: 'paper', target: 'rock', winner: 'challenger' }],
    ready: { challenger: true, target: false }, wins: { challenger: 1, target: 0 }, seq: 1,
  }, 'R356 проверка: открытые раунды КНБ и готовность сохранены');
  assert.deepEqual(normal(input), saved, 'R356 проверка: другая игра остаётся неизменной');
}

describe('R356 duelDtoFor: маска только у locked/moving гуся', () => {
  for (const viewer of viewers) for (const turn of sides) {
    it(`смотрящий ${viewer ?? 'null'}, ход ${turn}: свой вид DTO с неизменными открытыми полями`, () => checkMasked(actual, viewer, turn));
  }

  it('duelDto остаётся полным даже во время хода и его вложенные поля не ссылаются на строку', () => {
    const input = row(), saved = normal(input), shown = actual.duelDto(input)!;
    assert.deepEqual(shown.greedy, fullGreedy(greedy()), 'R356 проверка: внутренний DTO содержит обе стороны и все броски');
    assert.equal(shown.greedy!.hidden, undefined, 'R356 проверка: внутренний DTO без hidden');
    shown.greedy!.scores.target = 99;
    shown.greedy!.timeouts.target = 99;
    shown.greedy!.lastRoll!.die = 2;
    shown.greedy!.rolls.push(1);
    assert.deepEqual(normal(input), saved, 'R356 проверка: изменение полного DTO не меняет строку');
  });

  for (const finish of ['target-score', 'timeout'] as const) for (const viewer of viewers) {
    it(`locked/done после ${finish === 'target-score' ? 'достижения 20' : 'поражения по сроку'}: ${viewer ?? 'null'} видит обе стороны до расчёта`, () => {
      const g = greedy();
      g.scores.challenger = finish === 'target-score' ? 20 : 11;
      g.winner = finish === 'target-score' ? 'challenger' : null;
      const input = row({ phase: 'done', greedy: g, outcome: 'challenger', ...(finish === 'timeout' ? { reason: 'timeout' as const } : {}) });
      checkFull(actual, input, viewer);
      assert.equal(actual.duelDtoFor(input, viewer)!.state, 'playing', 'R356 проверка: раскрытие не дожидается settled');
    });
  }

  for (const state of ['open', 'settled', 'cancelled']) for (const viewer of viewers) {
    it(`${state} при оставшейся moving: ${viewer ?? 'null'} видит полное состояние`, () => {
      const input = row({ phase: 'moving', winnerId: 'bob', payout: 83 }, state);
      checkFull(actual, input, viewer);
      const shown = actual.duelDtoFor(input, viewer)!;
      assert.equal(shown.seed, state === 'settled' ? 'ab'.repeat(32) : null, 'R356 проверка: раскрытие счёта не раскрывает зерно до settled');
    });
  }

  for (const phase of [undefined, 'playing'] as const) for (const viewer of viewers) {
    it(`locked с фазой ${phase ?? 'не задана'}: ${viewer ?? 'null'} не получает маску без moving`, () => {
      checkFull(actual, row({ phase }), viewer);
    });
  }

  for (const game of ['dice', 'rps'] as const) for (const viewer of viewers) {
    it(`${game}: ${viewer ?? 'null'} получает прежние открытые данные без маски гуся`, () => checkOtherGame(actual, game, viewer));
  }

  it('битая строка остаётся null, а не превращается в замаскированную партию', () => {
    const input = row();
    delete input.data.channelId;
    assert.equal(actual.duelDtoFor(input, null), null, 'R356 проверка: испорченная строка не выдаётся зрителю');
    assert.equal(actual.duelDtoFor(input, 'alice'), null, 'R356 проверка: испорченная строка не выдаётся участнику');
  });

  it('контрфакты требуют одновременно moving, locked и игру greedy', () => {
    const check = (rules: Rules) => {
      checkMasked(rules, 'alice', 'target');
      checkFull(rules, row({ phase: 'done' }), 'alice');
      checkFull(rules, row({ phase: 'moving' }, 'cancelled'), 'alice');
      checkOtherGame(rules, 'rps', 'alice');
      checkOtherGame(rules, 'dice', null);
    };
    const mutations: Mutation[] = [
      { from: "if (row.state !== 'locked' || data.phase !== 'moving') return dto;", to: "if (row.state !== 'locked') return dto;" },
      { from: "if (row.state !== 'locked' || data.phase !== 'moving') return dto;", to: "if (data.phase !== 'moving') return dto;" },
      { from: "...(data.game === 'greedy' && data.greedy ? { greedy: greedyDto(data.greedy) } : {}),",
        to: '...(data.greedy ? { greedy: greedyDto(data.greedy) } : {}),' },
    ];
    check(actual);
    check(load(source));
    for (const { from, to } of mutations) {
      gatedCounterfact(() => {
      assert.equal(source.split(from).length, 2, `R356 подготовка: единственный якорь ${from}`);
      const mutant = load(source.replace(from, to));
      assert.throws(() => check(mutant), (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith('R356 проверка:'),
        'контрфакт убивается утверждением о поведении, не ошибкой загрузки');
});
      check(load(source));
    }
  });
});
