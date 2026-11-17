import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as practice from './duelPractice';

type Api = typeof practice;
type Edit = readonly [string, string];
const source = readFileSync(new URL('./duelPractice.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const now = Date.parse('2026-10-29T12:00:00Z');
const normal = (v: unknown) => JSON.parse(JSON.stringify(v));
const random: practice.PracticeRng = { unit: () => 0, die: () => 6 };
function load(raw: string): Api {
  const module = { exports: {} };
  // Целый настоящий модуль, включая step/greedyAct, а не копия проверяемого выражения.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, crypto: globalThis.crypto, Uint32Array, require: (id: string) => {
      assert.equal(id, '@gusvoice/shared', 'R356/practice/setup/import'); return shared;
    } });
  return module.exports as Api;
}
function paired(title: string, check: (p: Api) => void, ...edits: Edit[]) {
  it(title, () => {
    check(practice);
    for (const [from, to] of edits) {
      counterfact(() => {
        assert.equal(source.split(from).length - 1, 1, 'R356/practice/setup/единственная игла');
        assert.throws(() => check(load(source.replace(from, to))),
          e => e instanceof assert.AssertionError && e.message.startsWith('R356/practice/check/'),
          'контрфакт нарушает правило, ошибка настройки/импорта не засчитывается');
      });
      check(practice);
    }
  });
}
function state(p: Api): practice.PracticeState {
  const s = p.practiceStart('greedy', 'me', now, random);
  s.duel.greedy = { ...s.duel.greedy!, scores: { challenger: 7, target: 4 }, turn: 'target', turnPoints: 12,
    lastRoll: { by: 'target', die: 6 }, rolls: [5, 2, 4, 6, 6], seq: 7, burned: 0 };
  return s;
}

paired('R356 тренировка скрывает только капитана в обоих ходах и не меняет полное состояние движка', p => {
  for (const turn of ['challenger', 'target'] as const) {
    const s = state(p); s.duel.greedy!.turn = turn;
    const before = normal(s);
    const shown = p.practiceShownDuel(s);
    assert.notEqual(shown, s.duel, 'R356/practice/check/маска — отдельный DTO');
    assert.deepEqual(normal(shown.greedy), normal(shared.greedyHide(s.duel.greedy!, 'challenger')), 'R356/practice/check/та же маска сервера');
    assert.equal(shown.greedy!.scores.challenger, 7, 'R356/practice/check/свой счёт открыт');
    assert.equal(shown.greedy!.scores.target, 0, 'R356/practice/check/капитан закрыт');
    assert.deepEqual(normal(shown.greedy!.hidden), { challenger: false, target: true }, 'R356/practice/check/признак скрытой стороны');
    assert.deepEqual(normal(s), before, 'R356/practice/check/движок остался полным');
  }
}, ["greedyHide(d.greedy, 'challenger')", "greedyHide(d.greedy, 'target')"],
['return { ...d, greedy: greedyHide(d.greedy, \'challenger\') };', 'return d;']);

paired('R356 решённая тренировка раскрывает капитана уже во время анимации до settled', p => {
  const s = state(p); s.duel.greedy!.scores.target = 16; s.duel.greedy!.turnPoints = 0;
  s.hidden.botAt = now + 10; s.hidden.deadline = now + 30_000;
  const decided = p.practiceTick(s, now + 10, random);
  assert.equal(decided.duel.state, 'playing', 'R356/practice/check/идёт анимация');
  assert.equal(decided.duel.moveUntil, null, 'R356/practice/check/решение сняло срок');
  assert.equal(decided.duel.greedy!.scores.target, 22, 'R356/practice/check/полный победный счёт');
  assert.equal(p.practiceShownDuel(decided), decided.duel, 'R356/practice/check/решённое не маскируется');
  const settled = p.practiceTick(decided, decided.hidden.settleAt!, random);
  assert.equal(settled.duel.state, 'settled', 'R356/practice/check/итог');
  assert.equal(p.practiceShownDuel(settled), settled.duel, 'R356/practice/check/итог целиком');
}, [" || !d.moveUntil", '']);

paired('R356 другие игры, отменённая партия и DTO без гуся проходят без маски и без копирования', p => {
  for (const game of ['dice', 'rps'] as const) {
    const s = p.practiceStart(game, 'me', now, random);
    assert.equal(p.practiceShownDuel(s), s.duel, 'R356/practice/check/другая игра целиком');
  }
  const cancelled = state(p); cancelled.duel.state = 'cancelled';
  assert.equal(p.practiceShownDuel(cancelled), cancelled.duel, 'R356/practice/check/отмена целиком');
  const absent = state(p); delete absent.duel.greedy;
  assert.equal(p.practiceShownDuel(absent), absent.duel, 'R356/practice/check/нет greedy');
}, [" || d.state !== 'playing'", '']);

paired('R356 капитан принимает решение по полной копилке, хотя игрок видит вместо неё ноль', p => {
  const s = state(p), before = normal(s);
  s.hidden.botAt = now + 10; s.hidden.deadline = now + 30_000;
  assert.equal(p.practiceShownDuel(s).greedy!.turnPoints, 0, 'R356/practice/check/показ скрыт');
  let dice = 0;
  const after = p.practiceTick(s, now + 10, { unit: () => 0, die: () => { dice++; return 6; } });
  assert.equal(dice, 0, 'R356/practice/check/капитан остановился, а не бросил по нулю маски');
  assert.equal(after.duel.greedy!.scores.target, 16, 'R356/practice/check/вся копилка зачислена');
  assert.equal(after.duel.greedy!.turn, 'challenger', 'R356/practice/check/ход передан');
  assert.deepEqual(normal(s.duel), before.duel, 'R356/practice/check/вход не изменён');
}, ['botGreedyWants(d.greedy!, h.botGoal)', 'botGreedyWants(practiceShownDuel(s).greedy!, h.botGoal)']);

paired('R356 капитан учитывает настоящие числа обоих счетов и границы цели и угрозы', p => {
  const wants = (mine: number, rival: number, points: number) => p.botGreedyWants({ scores: { target: mine, challenger: rival }, turnPoints: points }, 12);
  assert.equal(wants(0, 14, 11), 'roll', 'R356/practice/check/ниже цели бросает');
  assert.equal(wants(0, 14, 12), 'stop', 'R356/practice/check/на цели забирает');
  assert.equal(wants(0, 15, 12), 'roll', 'R356/practice/check/угроза ровно 15');
  assert.equal(wants(18, 0, 1), 'roll', 'R356/practice/check/до победы не хватает');
  assert.equal(wants(18, 0, 2), 'stop', 'R356/practice/check/добрал до победы');
}, ['rival >= GREEDY_TARGET - 5', 'rival > GREEDY_TARGET - 5'],
['Math.min(goal, GREEDY_TARGET - mine)', 'goal']);
