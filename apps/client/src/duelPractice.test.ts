import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as practice from './duelPractice';

type Api = typeof practice;
type State = practice.PracticeState;
type Edit = readonly [string, string];
const source = readFileSync(new URL('./duelPractice.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const now = Date.parse('2026-10-29T12:00:00Z');

it('тренировка 21 не расходует случай на кости при входе, первый ход бросает два, добор один', () => {
  let calls = 0;
  const random = { unit: () => .99, die: () => { calls++; return 3; } };
  let s = practice.practiceStart('twentyone', 'me', now, random);
  assert.equal(calls, 0);
  assert.deepEqual(s.duel.twentyOne!.totals, { challenger: 0, target: 0 });
  assert.deepEqual(s.duel.twentyOne!.rolls, []);
  assert.equal(s.duel.twentyOne!.first, 'challenger');
  assert.equal(s.hidden.botAt, null);
  assert.equal(practice.practiceTick(s, now + 2000, random), s);
  assert.equal(practice.practiceMove(s, 'stop', now, random), null);
  s = practice.practiceMove(s, 'roll', now, random)!;
  assert.equal(calls, 2);
  assert.equal(s.duel.twentyOne!.totals.challenger, 6);
  s = practice.practiceTick(s, s.hidden.botAt!, random);
  assert.equal(calls, 4);
  const shown = practice.practiceShownDuel(s).twentyOne!;
  assert.equal(shown.totals.target, 0);
  assert.ok(shown.rolls.filter(r => r.by === 'target').every(r => r.die === 0));
  s = practice.practiceMove(s, 'roll', now + 5000, random)!;
  assert.equal(calls, 5);
  assert.equal(s.duel.twentyOne!.totals.challenger, 9);
});

it('просрочка первого хода тренировки раскрывает пару и передаёт ход без раннего сравнения', () => {
  const random = rng([5, 6, 2, 3]);
  const start = practice.practiceStart('twentyone', 'me', now, random);
  const s = practice.practiceTick(start, start.hidden.deadline!, random);
  assert.equal(s.duel.twentyOne!.totals.challenger, 11);
  assert.equal(s.duel.twentyOne!.started!.challenger, true);
  assert.equal(s.duel.twentyOne!.standing.challenger, false);
  assert.equal(s.duel.twentyOne!.timeouts.challenger, 1);
  assert.equal(s.duel.twentyOne!.finished, false);
  assert.equal(s.duel.winnerId, null);
});
const normal = (v: unknown) => JSON.parse(JSON.stringify(v));
const rng = (dice: number[] = [], units: number[] = [], fallback = 0): practice.PracticeRng => ({
  die: () => dice.shift() ?? 1,
  unit: () => units.shift() ?? fallback,
});
function load(raw = source, crypto: { getRandomValues(a: Uint32Array): Uint32Array } = globalThis.crypto): Api {
  const module = { exports: {} };
  // Исполняется целый модуль с единственным настоящим чистым импортом; куски функций не вырезаются.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, crypto, Uint32Array, require: (id: string) => {
      assert.equal(id, '@gusvoice/shared', 'R354/practice/import'); return shared;
    } });
  return module.exports as Api;
}
function paired(title: string, check: (p: Api) => void, ...edits: Edit[]) {
  it(title, () => {
    check(practice);
    for (const [from, to] of edits) {
      counterfact(() => {
        assert.equal(source.split(from).length - 1, 1, 'R354/practice/setup: единственная игла');
        assert.throws(() => check(load(source.replace(from, to))), e => e instanceof assert.AssertionError && e.message.startsWith('R354/practice/'),
          'контрфакт нарушает адресное правило, не загрузку модуля');
      });
      check(practice);
    }
  });
}
const need = (s: State | null): State => { assert.ok(s, 'R354/practice/ход принят'); return s; };
const settle = (p: Api, s: State, random = rng()) => {
  assert.notEqual(s.hidden.settleAt, null, 'R354/practice/запланирован итог');
  return p.practiceTick(s, s.hidden.settleAt!, random);
};
const greedyState = (p: Api, patch: Partial<shared.DuelGreedyDto> = {}): State => {
  const s = p.practiceStart('greedy', 'me', now, rng());
  return { ...s, duel: { ...s.duel, greedy: { ...s.duel.greedy!, ...patch } } };
};

// Dice cases exercise transitions directly; obsolete source-string mutants were removed for this cluster.
it('кубики начинают скрытыми до двух побед со сроком 15 секунд, игрок раскрывает только свои кости', () => {
  const random = rng([6, 5, 2, 3]);
  const start = practice.practiceStart('dice', 'me', now, random);
  assert.equal(start.duel.diceTarget, 2);
  assert.deepEqual(start.duel.rolls, [{ challenger: null, target: null }]);
  assert.equal(start.duel.turnUntil, new Date(now + 15_000).toISOString());
  assert.equal(start.duel.amount, 0);
  const mine = need(practice.practiceMove(start, 'roll', now + 10, random));
  assert.deepEqual(mine.duel.rolls, [{ challenger: [6, 5], target: null }]);
  assert.equal(practice.practiceMove(mine, 'roll', now + 11, random), null);
  assert.equal(practice.practiceTick(mine, mine.hidden.botAt! - 1, random), mine);
  const both = practice.practiceTick(mine, mine.hidden.botAt!, random);
  assert.deepEqual(both.duel.rolls[0].target, [2, 3]);
  assert.equal(both.hidden.settleAt, null);
  assert.deepEqual(both.duel.rolls[1], { challenger: null, target: null });
});
it('кубики считают 1:1 и заканчивают только второй победой любой стороны после полной анимации', () => {
  for (const [win, lose, winner] of [
    [[6, 6, 1, 1], [1, 1, 6, 6], 'me'],
    [[1, 1, 6, 6], [6, 6, 1, 1], practice.PRACTICE_CAPTAIN_ID],
  ] as const) {
    const random = rng([...win, ...lose, ...win]);
    let s = practice.practiceStart('dice', 'me', now, random);
    let at = now;
    for (let n = 0; n < 3; n++) {
      const mine = need(practice.practiceMove(s, 'roll', at, random));
      const botAt = mine.hidden.botAt!;
      s = practice.practiceTick(mine, botAt, random);
      assert.equal(s.duel.state, 'playing');
      assert.equal(s.duel.amount, 0);
      assert.equal(s.duel.payout, null);
      if (n < 2) {
        assert.equal(s.hidden.settleAt, null);
        assert.equal(s.duel.rollNo, n + 1);
        assert.deepEqual(s.duel.rolls.at(-1), { challenger: null, target: null });
      } else {
        assert.equal(s.hidden.settleAt, botAt + shared.DUEL_ROLL_ANIM_MS);
        assert.equal(practice.practiceTick(s, s.hidden.settleAt! - 1, random), s);
      }
      at = botAt + 1;
    }
    assert.equal(settle(practice, s, random).duel.winnerId, winner);
  }
});
it('ничьи кубиков не дают очков, открывают новый срок и завершаются возвратным итогом после восьми бросков', () => {
  const random = rng();
  let s = practice.practiceStart('dice', 'me', now, random);
  for (let n = 0; n < 8; n++) {
    const at = s.hidden.deadline!;
    s = practice.practiceTick(s, at, random);
    if (n < 7) {
      assert.equal(s.duel.rollNo, n + 1);
      assert.deepEqual(s.duel.rolls.at(-1), { challenger: null, target: null });
      assert.equal(s.hidden.deadline, at + shared.DUEL_ROLL_TURN_MS);
      assert.equal(s.hidden.settleAt, null);
    }
  }
  assert.notEqual(s.hidden.settleAt, null);
  s = settle(practice, s, random);
  assert.equal(s.duel.state, 'settled');
  assert.equal(s.duel.reason, 'draw-limit');
  assert.equal(s.duel.winnerId, null);
  assert.equal(s.duel.payout, null);
});
it('судья раскрывает недостающие стороны каждого броска и ждёт вторую победу, не перебрасывая показанное', () => {
  const random = rng([2, 3, 6, 6, 2, 3, 6, 6]);
  const start = practice.practiceStart('dice', 'me', now, random);
  const first = practice.practiceTick(start, now + shared.DUEL_ROLL_TURN_MS, random);
  assert.deepEqual(first.duel.rolls[0], { challenger: [6, 6], target: [2, 3] });
  assert.equal(first.hidden.settleAt, null);
  assert.equal(first.duel.rollNo, 1);
  const due = first.hidden.deadline!;
  const second = practice.practiceTick(first, due, random);
  assert.deepEqual(second.duel.rolls[0], first.duel.rolls[0]);
  assert.deepEqual(second.duel.rolls[1], { challenger: [6, 6], target: [2, 3] });
  assert.equal(second.hidden.settleAt, due + shared.DUEL_ROLL_ANIM_MS);
  assert.equal(settle(practice, second, random).duel.winnerId, 'me');
});
it('старые тренировочные данные без цели или с целью один сохраняют победу с первого броска', () => {
  for (const target of [undefined, 1] as const) {
    const random = rng([6, 6, 1, 1]);
    const start = practice.practiceStart('dice', 'me', now, random);
    const { diceTarget: _target, ...old } = start.duel;
    const initial = { ...start, duel: target ? { ...old, diceTarget: target } : old };
    const mine = need(practice.practiceMove(initial, 'roll', now, random));
    const both = practice.practiceTick(mine, mine.hidden.botAt!, random);
    assert.notEqual(both.hidden.settleAt, null);
    assert.equal(both.duel.rolls.length, 1);
    assert.equal(settle(practice, both, random).duel.winnerId, 'me');
  }
});

paired('R354 КНБ прячет руку капитана до общего раскрытия и отказывает повторному ходу игрока', p => {
  const random = rng([], [0, 0]);
  const start = p.practiceStart('rps', 'me', now, random);
  const bot = p.practiceTick(start, start.hidden.botAt!, random);
  assert.equal(bot.hidden.botHand, 'rock', 'R354/practice/rps/hidden-hand');
  assert.deepEqual(normal(bot.duel.rps?.ready), { challenger: false, target: true }, 'R354/practice/rps/bot-ready');
  assert.deepEqual(normal(bot.duel.rps?.rounds), [], 'R354/practice/rps/no-public-hand');
  const waiting = need(p.practiceMove(start, 'paper', now + 1, random));
  assert.equal(waiting.myHand, 'paper', 'R354/practice/rps/mine-private');
  assert.deepEqual(normal(waiting.duel.rps?.ready), { challenger: true, target: false }, 'R354/practice/rps/mine-ready');
  assert.equal(p.practiceMove(waiting, 'scissors', now + 2, random), null, 'R354/practice/rps/no-replace-hand');
  const revealed = need(p.practiceMove(bot, 'paper', bot.hidden.botAt ?? now + 701, random));
  assert.deepEqual(normal(revealed.duel.rps!.rounds[0]), { challenger: 'paper', target: 'rock', winner: 'challenger' }, 'R354/practice/rps/reveal');
  assert.deepEqual(normal(revealed.duel.rps!.ready), { challenger: false, target: false }, 'R354/practice/rps/reset-ready');
}, ['const winner = rpsRoundWinner(mine, bot);', 'const winner = rpsRoundWinner(bot, mine);'],
['rps: { rounds, ready: { challenger: false, target: false }, wins, seq: rounds.length }', 'rps: { rounds, ready: rps.ready, wins, seq: rounds.length }']);
paired('R354 КНБ решается второй победой, а не первой; капитан может выиграть так же, как игрок', p => {
  for (const [hand, winner] of [['paper', 'me'], ['scissors', practice.PRACTICE_CAPTAIN_ID]] as const) {
    const random = rng();
    let s = p.practiceStart('rps', 'me', now, random);
    for (let n = 0; n < 2; n++) {
      s = p.practiceTick(s, s.hidden.botAt!, random);
      s = need(p.practiceMove(s, hand, now + n * 4_000 + 800, random));
      assert.equal(s.duel.rps!.rounds.length, n + 1, 'R354/practice/rps/rounds');
      if (n === 0) assert.equal(s.hidden.settleAt, null, 'R354/practice/rps/not-one-win');
    }
    assert.equal(s.duel.state, 'playing', 'R354/practice/rps/result-delayed');
    s = settle(p, s, random);
    assert.equal(s.duel.winnerId, winner, 'R354/practice/rps/two-wins');
  }
}, ['wins.challenger >= RPS_WINS', 'wins.challenger >= 1']);
paired('R354 семь ничьих КНБ завершаются draw-limit, седьмой раунд не начинает восьмой', p => {
  const random = rng();
  let s = p.practiceStart('rps', 'me', now, random);
  for (let n = 0; n < shared.RPS_MAX_ROUNDS; n++) {
    const at = s.hidden.botAt!;
    s = p.practiceTick(s, at, random);
    s = need(p.practiceMove(s, 'rock', at + 1, random));
    if (n < 6) assert.equal(s.hidden.settleAt, null, 'R354/practice/rps/tie-not-final');
  }
  assert.equal(s.duel.rps!.rounds.length, 7, 'R354/practice/rps/seven');
  s = settle(p, s, random);
  assert.equal(s.duel.reason, 'draw-limit', 'R354/practice/rps/draw-limit');
  assert.equal(s.duel.winnerId, null, 'R354/practice/rps/draw');
  assert.equal(p.practiceNextAt(s), null, 'R354/practice/rps/no-eighth');
});
paired('R354 молчание в КНБ в точный срок приносит капитану победу timeout', p => {
  const random = rng();
  const start = p.practiceStart('rps', 'me', now, random);
  const ready = p.practiceTick(start, start.hidden.botAt!, random);
  assert.equal(p.practiceTick(ready, now + shared.DUEL_MOVE_MS - 1, random), ready, 'R354/practice/rps/timeout-last-ms');
  const lost = p.practiceTick(ready, now + shared.DUEL_MOVE_MS, random);
  assert.equal(lost.duel.state, 'settled', 'R354/practice/rps/timeout-exact');
  assert.equal(lost.duel.reason, 'timeout', 'R354/practice/rps/timeout');
  assert.equal(lost.duel.winnerId, practice.PRACTICE_CAPTAIN_ID, 'R354/practice/rps/silent-loses');
});

paired('R354 Жадный гусь выбирает первого строго по половине и не принимает чужой ход или пустой Стоп', p => {
  for (const [unit, first] of [[0, 'challenger'], [0.499999, 'challenger'], [0.5, 'target'], [0.999999, 'target']] as const) {
    const s = p.practiceStart('greedy', 'me', now, rng([], [unit]));
    assert.equal(s.duel.greedy!.first, first, 'R354/practice/greedy/first-boundary');
    assert.equal(p.practiceMove(s, 'stop', now, rng()), null, 'R354/practice/greedy/no-empty-stop');
    if (first === 'target') assert.equal(p.practiceMove(s, 'roll', now, rng([6])), null, 'R354/practice/greedy/not-my-turn');
    else assert.notEqual(p.practiceMove(s, 'roll', now, rng([6])), null, 'R354/practice/greedy/my-roll');
  }
}, ["rng.unit() < 0.5 ? 'challenger' : 'target'", "rng.unit() <= 0.5 ? 'challenger' : 'target'"]);
paired('R354 единица сжигает копилку Жадного гуся, сохраняет счёт и передаёт ход капитану', p => {
  const s = greedyState(p, { scores: { challenger: 4, target: 2 }, turnPoints: 9 });
  const burned = need(p.practiceMove(s, 'roll', now + 1, rng([1])));
  assert.deepEqual(normal(burned.duel.greedy!.scores), { challenger: 4, target: 2 }, 'R354/practice/greedy/burn-not-score');
  assert.equal(burned.duel.greedy!.turnPoints, 0, 'R354/practice/greedy/burn-pot');
  assert.equal(burned.duel.greedy!.burned, 9, 'R354/practice/greedy/burn-amount');
  assert.equal(burned.duel.greedy!.turn, 'target', 'R354/practice/greedy/pass');
  assert.deepEqual(normal(burned.duel.greedy!.lastRoll), { by: 'challenger', die: 1 }, 'R354/practice/greedy/burn-side');
});
paired('R354 ровно двадцать очков Жадного гуся решают партию после анимации, девятнадцать ещё нет', p => {
  for (const [points, finished] of [[13, false], [14, true]] as const) {
    const s = greedyState(p, { turnPoints: points });
    const rolled = need(p.practiceMove(s, 'roll', now, rng([6])));
    assert.equal(rolled.hidden.settleAt !== null, finished, 'R354/practice/greedy/target-boundary');
    if (finished) {
      assert.equal(rolled.hidden.settleAt, now + shared.DUEL_ROLL_ANIM_MS, 'R354/practice/greedy/win-delay');
      assert.equal(settle(p, rolled).duel.winnerId, 'me', 'R354/practice/greedy/win');
    } else assert.equal(rolled.duel.greedy!.turnPoints, 19, 'R354/practice/greedy/still-playing');
  }
});
paired('R354 просрочка Жадного гуся с копилкой делает Стоп, пустая бросает, обе прибавляют timeout', p => {
  for (const points of [0, 5]) {
    const s = greedyState(p, { turnPoints: points });
    const after = p.practiceTick(s, s.hidden.deadline!, rng([3]));
    assert.equal(after.duel.greedy!.timeouts.challenger, 1, 'R354/practice/greedy/auto-timeout');
    if (points) {
      assert.equal(after.duel.greedy!.scores.challenger, 5, 'R354/practice/greedy/auto-stop');
      assert.equal(after.duel.greedy!.turn, 'target', 'R354/practice/greedy/auto-stop-pass');
      assert.equal(after.duel.greedy!.rolls.length, 0, 'R354/practice/greedy/stop-not-roll');
    } else {
      assert.equal(after.duel.greedy!.turnPoints, 3, 'R354/practice/greedy/auto-roll');
      assert.deepEqual(normal(after.duel.greedy!.rolls), [3], 'R354/practice/greedy/auto-roll-history');
    }
  }
});
paired('R354 ручной допустимый ход сбрасывает свои просрочки, не затрагивая счётчик капитана', p => {
  const s = greedyState(p, { timeouts: { challenger: 2, target: 1 } });
  const after = need(p.practiceMove(s, 'roll', now, rng([4])));
  assert.deepEqual(normal(after.duel.greedy!.timeouts), { challenger: 0, target: 1 }, 'R354/practice/greedy/manual-reset');
}, ['[side]: auto ? g.timeouts[side] + 1 : 0', '[side]: auto ? g.timeouts[side] + 1 : g.timeouts[side]']);
paired('R354 третья подряд просрочка Жадного гуся — немедленное поражение, вторая ещё автоматический ход', p => {
  for (const count of [1, 2]) {
    const s = greedyState(p, { timeouts: { challenger: count, target: 0 } });
    const after = p.practiceTick(s, s.hidden.deadline!, rng([2]));
    assert.equal(after.duel.greedy!.timeouts.challenger, count + 1, 'R354/practice/greedy/timeout-count');
    assert.equal(after.duel.state, count === 2 ? 'settled' : 'playing', 'R354/practice/greedy/third-timeout');
    if (count === 2) {
      assert.equal(after.duel.reason, 'timeout', 'R354/practice/greedy/timeout-reason');
      assert.equal(after.duel.winnerId, practice.PRACTICE_CAPTAIN_ID, 'R354/practice/greedy/timeout-winner');
      assert.equal(after.duel.greedy!.rolls.length, 0, 'R354/practice/greedy/third-not-roll');
    }
  }
}, ['g.timeouts[side] + 1 >= GREEDY_MAX_TIMEOUTS', 'g.timeouts[side] + 1 > GREEDY_MAX_TIMEOUTS']);
paired('R354 капитан Жадного гуся бросает с пустой копилкой, останавливается на цели и рискует при угрозе соперника', p => {
  const wants = (mine: number, rival: number, points: number, goal = 12) => p.botGreedyWants({ scores: { challenger: rival, target: mine }, turnPoints: points }, goal);
  assert.equal(wants(0, 0, 0), 'roll', 'R354/practice/bot/empty');
  assert.equal(wants(0, 0, 11), 'roll', 'R354/practice/bot/below-goal');
  assert.equal(wants(0, 0, 12), 'stop', 'R354/practice/bot/at-goal');
  assert.equal(wants(0, 14, 15), 'stop', 'R354/practice/bot/rival-below-threat');
  assert.equal(wants(0, 15, 15), 'roll', 'R354/practice/bot/rival-threat');
  assert.equal(wants(18, 0, 1), 'roll', 'R354/practice/bot/one-point-to-win');
}, ['rival >= GREEDY_TARGET - 5', 'rival > GREEDY_TARGET - 5']);

it('без наступивших событий тик возвращает тот же объект, большой скачок догоняет восемь бросков по порядку', () => {
  const p = practice;
  const random = rng();
  const s = p.practiceStart('dice', 'me', now, random);
  assert.equal(p.practiceTick(s, p.practiceNextAt(s)! - 1, random), s, 'R354/practice/tick/no-copy');
  const end = p.practiceTick(s, now + 365 * 24 * 60 * 60_000, random);
  assert.equal(end.duel.state, 'settled', 'R354/practice/tick/catch-up');
  assert.equal(end.duel.rolls.length, 8, 'R354/practice/tick/ordered-rerolls');
  assert.equal(end.duel.reason, 'draw-limit', 'R354/practice/tick/ordered-result');
  assert.equal(p.practiceNextAt(end), null, 'R354/practice/tick/no-next');
  assert.equal(p.practiceTick(end, now + 10 ** 12, random), end, 'R354/practice/tick/settled-no-op');
  assert.equal(p.practiceMove(end, 'roll', now + 10 ** 12, random), null, 'R354/practice/tick/settled-no-move');
});
it('R354 защита догоняющего тика ограничивает цикл ровно тысячью переходов', () => {
  // Ограничение страхует вкладку от зависания при испорченном состоянии/будущем новом типе игры.
  const ast = ts.createSourceFile('duelPractice.ts', source, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(ts.isFunctionDeclaration).filter(n => n.name?.text === 'practiceTick');
  assert.equal(functions.length, 1, 'R354/practice/tick/function');
  const loops = functions[0].body!.statements.filter(ts.isForStatement);
  assert.equal(loops.length, 1, 'R354/practice/tick/one-loop');
  assert.equal(loops[0].condition?.getText(ast), 'i < 1_000', 'R354/practice/tick/finite-1000');
});
it('R354 честная кость cryptoRng выдаёт все 1…6 и отбрасывает четыре значения над кратным шести', () => {
  const check = (raw: string) => {
    const limit = 2 ** 32 - (2 ** 32 % 6);
    const queue = [0, 1, 2, 3, 4, 5, limit, limit + 1, limit + 2, limit + 3, 11];
    let reads = 0;
    const p = load(raw, { getRandomValues(a) { reads++; const v = queue.shift(); assert.notEqual(v, undefined, 'R354/practice/crypto/not-exhausted'); a[0] = v!; return a; } });
    assert.deepEqual(Array.from({ length: 6 }, () => p.cryptoRng.die()), [1, 2, 3, 4, 5, 6], 'R354/practice/crypto/all-faces');
    assert.equal(p.cryptoRng.die(), 6, 'R354/practice/crypto/rejection');
    assert.equal(reads, 11, 'R354/practice/crypto/rejected-four');
    assert.equal(queue.length, 0, 'R354/practice/crypto/read-accepted');
  };
  check(source);
  counterfact(() => {
    const needle = 'if (a[0] < limit) return (a[0] % 6) + 1;';
    assert.equal(source.split(needle).length - 1, 1, 'R354/practice/setup: игла rejection sampling');
    assert.throws(() => check(source.replace(needle, 'return (a[0] % 6) + 1;')),
      e => e instanceof assert.AssertionError && e.message.startsWith('R354/practice/crypto/rejection'),
      'простой остаток вместо отбрасывания нарушает честность кости');
  });
  check(source);
});
paired('R354 строки итога тренировки различают победу, поражение, ничью и ещё идущую партию', p => {
  const base = p.practiceStart('dice', 'me', now, rng()).duel;
  assert.equal(p.practiceLive({ duel: base } as State), true, 'R354/practice/result/live');
  assert.equal(p.practiceResultText(base), null, 'R354/practice/result/not-yet');
  for (const [winnerId, result, text] of [['me', 'win', 'Тренировка: ты выиграл'], [practice.PRACTICE_CAPTAIN_ID, 'loss', 'Тренировка: ты проиграл'], [null, 'draw', 'Тренировка: ничья']] as const) {
    const duel = { ...base, state: 'settled' as const, winnerId };
    assert.equal(p.practiceResult(duel), result, 'R354/practice/result/value');
    assert.equal(p.practiceResultText(duel), text, 'R354/practice/result/text');
    assert.equal(p.practiceLive({ duel } as State), false, 'R354/practice/result/not-live');
  }
});
