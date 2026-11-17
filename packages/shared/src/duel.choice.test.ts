import { counterfact as runCounterfact } from '../test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as actual from './duel.js';
import type { DuelSide, GreedyState, RpsHand } from './duel.js';

type Rules = typeof actual;
type Mutation = { from: string; to: string };
const source = readFileSync(new URL('./duel.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function load(raw: string): Rules {
  const module = { exports: {} };
  // Исполняем целый модуль; мутация не пишет приложение на диск и не вырезает алгоритм в тест.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    require(id: string) { assert.fail(`R333 подготовка: неожиданный импорт shared/duel ${id}`); },
  }, { timeout: 2_000 });
  return module.exports as Rules;
}

function counterfact(check: (rules: Rules) => void, mutations: Mutation | Mutation[]): void {
  check(actual);
  check(load(source));
  for (const { from, to } of Array.isArray(mutations) ? mutations : [mutations]) {

    runCounterfact(() => {
      assert.equal(source.split(from).length, 2, `R333 подготовка: единственный якорь ${from}`);
      const mutant = source.replace(from, to);
      assert.notEqual(mutant, source, 'R333 подготовка: мутант действительно меняет модуль');
      assert.throws(() => check(load(mutant)), (error: unknown) =>
        error instanceof assert.AssertionError && error.message.startsWith('R333 проверка:'),
      'убийство — адресный AssertionError хоста, не ошибка импорта/синтаксиса/VM');
    });
    check(load(source));
  }
}

const sides: DuelSide[] = ['challenger', 'target'];
const other = (side: DuelSide): DuelSide => side === 'challenger' ? 'target' : 'challenger';
const state = (side: DuelSide, extra: Partial<GreedyState> = {}): GreedyState => ({
  scores: { challenger: 3, target: 5 }, turn: side, turnPoints: 8, n: 4,
  lastRoll: { by: side, die: 4 }, burned: 6, winner: null, ...extra,
});

describe('R333 КНБ: таблица всех девяти сочетаний рук', () => {
  const hands: RpsHand[] = ['rock', 'paper', 'scissors'];
  // Ожидания — независимая таблица, не вызов той же функции с переставленными аргументами.
  const winners: (DuelSide | null)[][] = [
    [null, 'target', 'challenger'],
    ['challenger', null, 'target'],
    ['target', 'challenger', null],
  ];
  for (let i = 0; i < hands.length; i++) for (let j = 0; j < hands.length; j++) {
    const a = hands[i], b = hands[j], winner = winners[i][j];
    it(`${a} против ${b}: ${winner === null ? 'ничья, никто не бьёт другого' : `побеждает ${winner}`}`, () => {
      const beatsMutation: Mutation = winner === 'challenger'
        ? { from: `(a === '${a}' && b === '${b}')`, to: 'false' }
        : { from: "return (a === 'rock' && b === 'scissors')",
          to: `return (a === '${a}' && b === '${b}') || (a === 'rock' && b === 'scissors')` };
      const winnerMutation: Mutation = winner === 'challenger'
        ? { from: "if (rpsBeats(challenger, target)) return 'challenger';", to: "if (rpsBeats(challenger, target)) return 'target';" }
        : winner === 'target'
          ? { from: "if (rpsBeats(target, challenger)) return 'target';", to: "if (rpsBeats(target, challenger)) return 'challenger';" }
          : { from: "if (rpsBeats(target, challenger)) return 'target';\n  return null;",
            to: "if (rpsBeats(target, challenger)) return 'target';\n  return 'challenger';" };
      counterfact(r => {
        assert.equal(r.rpsBeats(a, b), winner === 'challenger', 'R333 проверка: ровно выигрышная рука бьёт вторую');
        assert.equal(r.rpsRoundWinner(a, b), winner, 'R333 проверка: победитель или честная ничья');
      }, [beatsMutation, winnerMutation]);
    });
  }
});

describe('R333 общие пределы и проверяемый первый ход', () => {
  it('выборный ход длится 20 секунд, КНБ до двух побед и семи раундов, гусь до 20 и трёх просрочек', () => {
    const constants = { DUEL_MOVE_MS: 20_000, RPS_WINS: 2, RPS_MAX_ROUNDS: 7, GREEDY_TARGET: 20, GREEDY_MAX_TIMEOUTS: 3 } as const;
    counterfact(r => assert.deepEqual(Object.fromEntries(Object.keys(constants).map(k => [k, r[k as keyof typeof constants]])),
      constants, 'R333 проверка: точные опубликованные пределы'),
    Object.entries(constants).map(([name, value]) => ({ from: `export const ${name} = ${value === 20_000 ? '20_000' : value};`,
      to: `export const ${name} = ${value + 1};` })));
  });

  it('первый ход берётся из младшего бита первого байта, обе стороны доступны', () => {
    counterfact(r => {
      for (let byte = 0; byte < 256; byte++) {
        assert.equal(r.greedyFirstSide(new Uint8Array([byte, byte ^ 1])), byte % 2 ? 'challenger' : 'target',
          'R333 проверка: каждый первый байт выбирает сторону только по младшему биту');
      }
      assert.equal(r.greedyFirstInput('round', 'public-seed'), 'gv-duel-first:round:public-seed',
        'R333 проверка: отдельный домен первого хода с id и зерном');
    }, [
      { from: '(hash[0] & 1) === 1', to: '(hash[1] & 1) === 1' },
      { from: '`gv-duel-first:${roundId}:${seedHex}`', to: '`gv-duel-roll:${roundId}:${seedHex}:0`' },
    ]);
  });

  for (const side of sides) it(`начальная партия ${side}: обе копилки пусты, ещё нет броска и победителя`, () => {
    counterfact(r => assert.deepEqual(normal(r.greedyStart(side)), {
      scores: { challenger: 0, target: 0 }, turn: side, turnPoints: 0, n: 0, lastRoll: null, burned: 0, winner: null,
    }, 'R333 проверка: чистое начальное состояние обеих сторон'),
    { from: 'turn: first, turnPoints: 0', to: "turn: first === 'challenger' ? 'target' : 'challenger', turnPoints: 0" });
  });
});

describe('R333 Жадный гусь: только правила шага, без таймера и базы', () => {
  for (const side of sides) {
    it(`единица сжигает только копилку ${side}, передаёт ход и продвигает номер броска`, () => {
      counterfact(r => {
        const before = state(side), saved = normal(before);
        assert.deepEqual(normal(r.greedyStep(before, 'roll', 1)), { ...saved, turn: other(side), turnPoints: 0,
          n: 5, lastRoll: { by: side, die: 1 }, burned: 8 }, 'R333 проверка: единица сжигает ход, но не сохранённый счёт');
        assert.deepEqual(before, saved, 'R333 проверка: вход не изменён сгорающим броском');
      }, [
        { from: 'if (die === 1) return { ...s, scores, turn: otherSide(s.turn), turnPoints: 0, n: s.n + 1, lastRoll, burned: s.turnPoints };',
          to: 'if (die === 1) return { ...s, scores, turn: s.turn, turnPoints: 0, n: s.n + 1, lastRoll, burned: s.turnPoints };' },
        { from: 'lastRoll, burned: s.turnPoints };', to: 'lastRoll, burned: 0 };' },
      ]);
    });

    it(`«Стоп» с нулём ${side} запрещён, нельзя вечно пасовать`, () => {
      counterfact(r => assert.equal(r.greedyStep(state(side, { turnPoints: 0 }), 'stop'), null,
        'R333 проверка: пустую копилку нельзя остановить'),
      { from: 'if (s.turnPoints <= 0) return null;', to: 'if (s.turnPoints < 0) return null;' });
    });

    it(`«Стоп» с одним очком ${side} уже разрешён, без нового броска`, () => {
      counterfact(r => {
        const before = state(side, { turnPoints: 1 }), saved = normal(before);
        const scores = { ...before.scores, [side]: before.scores[side] + 1 };
        assert.deepEqual(normal(r.greedyStep(before, 'stop')), { ...saved, scores, turn: other(side), turnPoints: 0, burned: 0 },
          'R333 проверка: положительная копилка идёт только в счёт ходившего, n не меняется');
        assert.deepEqual(before, saved, 'R333 проверка: банковский стоп не меняет входной счёт');
      }, [
        { from: 'if (s.turnPoints <= 0) return null;', to: 'if (s.turnPoints <= 1) return null;' },
        { from: 'scores[s.turn] += s.turnPoints;', to: 'scores[otherSide(s.turn)] += s.turnPoints;' },
        { from: 'const scores = { ...s.scores };', to: 'const scores = s.scores;' },
      ]);
    });

    for (const die of [2, 6]) it(`грань ${die} у ${side} копится, не сохраняется и не передаёт ход раньше цели`, () => {
      counterfact(r => {
        const before = state(side, { turnPoints: 1 });
        assert.deepEqual(normal(r.greedyStep(before, 'roll', die)), { ...normal(before), turnPoints: 1 + die,
          n: 5, lastRoll: { by: side, die }, burned: 0 }, 'R333 проверка: грани 2 и 6 — обычные накопительные броски');
      }, [
        { from: 'const turnPoints = s.turnPoints + die;', to: 'const turnPoints = die;' },
        { from: 'return { ...s, scores, turnPoints, n: s.n + 1, lastRoll, burned: 0 };',
          to: 'return { ...s, scores, turn: otherSide(s.turn), turnPoints, n: s.n + 1, lastRoll, burned: 0 };' },
      ]);
    });

    for (const total of [19, 20, 21]) it(`сумма ${total} у ${side}: ${total < 20 ? 'ещё копит' : 'автостоп и победа'}`, () => {
      const at = total - 9; // Сохранённые очки + копилка 3 + грань 6 = total.
      counterfact(r => {
        const before = state(side, { scores: { challenger: 4, target: 7, [side]: at }, turnPoints: 3 });
        const after = r.greedyStep(before, 'roll', 6);
        assert.notEqual(after, null, 'R333 проверка: допустимый бросок у границы цели');
        assert.deepEqual(normal(after), { ...normal(before), scores: { ...before.scores, [side]: total < 20 ? at : total },
          turnPoints: total < 20 ? 9 : 0, n: 5, lastRoll: { by: side, die: 6 }, burned: 0,
          winner: total < 20 ? null : side }, 'R333 проверка: обе стороны порога 20 и засчитывание всей копилки');
      }, total < 20
        ? { from: 'scores[s.turn] + turnPoints >= GREEDY_TARGET', to: 'scores[s.turn] + turnPoints >= GREEDY_TARGET - 1' }
        : total === 20
          ? { from: 'scores[s.turn] + turnPoints >= GREEDY_TARGET', to: 'scores[s.turn] + turnPoints > GREEDY_TARGET' }
          : { from: 'scores[s.turn] + turnPoints >= GREEDY_TARGET', to: 'scores[s.turn] + turnPoints === GREEDY_TARGET' });
    });
  }

  for (const [die, mutation] of [
    [0, { from: 'die < 1', to: 'die < 0' }],
    [7, { from: 'die > 6', to: 'die > 7' }],
    [1.5, { from: '!Number.isInteger(die) || ', to: '' }],
    [NaN, { from: '!Number.isInteger(die) || ', to: '' }],
  ] as const) it(`кость ${String(die)} отклоняется, не оставляя полусделанного хода`, () => {
    counterfact(r => {
      const before = state('challenger'), saved = normal(before);
      assert.equal(r.greedyStep(before, 'roll', die), null, 'R333 проверка: только целые 1..6');
      assert.deepEqual(before, saved, 'R333 проверка: отказ не меняет партию');
    }, mutation);
  });

  for (const move of ['roll', 'stop'] as const) it(`после победы новый «${move}» не меняет решённую партию`, () => {
    counterfact(r => assert.equal(r.greedyStep(state('target', { winner: 'target' }), move, 2), null,
      'R333 проверка: завершённая партия больше не принимает действия'),
    { from: 'if (s.winner) return null;', to: 'if (false) return null;' });
  });
});
