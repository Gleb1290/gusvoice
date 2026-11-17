import assert from 'node:assert/strict';
import { it } from 'node:test';
import { twentyOneHide, twentyOneStart, twentyOneStep, twentyOneWinner, type DuelTwentyOneDto } from './duel21.js';

const start = () => twentyOneStart('challenger', { challenger: [5, 6], target: [4, 6] });

it('новая партия ждёт стартовый бросок пары, стоп и одиночный бросок до него запрещены', () => {
  const s = twentyOneStart('target');
  assert.deepEqual(s.totals, { challenger: 0, target: 0 });
  assert.deepEqual(s.rolls, []);
  assert.equal(twentyOneStep(s, 'stop'), null);
  assert.equal(twentyOneStep(s, 'roll', 6), null);
  assert.equal(twentyOneStep(s, 'roll', [0, 6]), null);
  const a = twentyOneStep(s, 'roll', [1, 6])!;
  assert.equal(a.totals.target, 7);
  assert.equal(a.turn, 'challenger');
  assert.deepEqual(a.started, { challenger: false, target: true });
  const b = twentyOneStep(a, 'roll', [2, 3])!;
  assert.equal(twentyOneStep(b, 'roll', [4, 5]), null);
  const c = twentyOneStep(b, 'roll', 4)!;
  assert.equal(c.totals.target, 11);
  assert.equal(c.rolls.length, 5);
  assert.deepEqual(s.rolls, []);
});

it('после собственного старта можно остановиться, соперник сначала раскрывает пару и лишь затем завершает игру', () => {
  let s = twentyOneStep(twentyOneStart('challenger'), 'roll', [6, 6])!;
  s = twentyOneStep(s, 'roll', [5, 6])!;
  s = twentyOneStep(s, 'stop')!;
  assert.equal(s.finished, false);
  assert.equal(s.winner, null);
  s = twentyOneStep(s, 'stop')!;
  assert.equal(s.finished, true);
  assert.equal(s.winner, 'challenger');
});

it('у обоих по два стартовых кубика, первая сторона задана явно', () => {
  const s = start();
  assert.deepEqual(s.totals, { challenger: 11, target: 10 });
  assert.equal(s.rolls.length, 4);
  assert.equal(s.turn, 'challenger');
  assert.equal(s.finished, false);
  assert.deepEqual(s.standing, { challenger: false, target: false });
});

it('каждый добор передаёт решение сопернику, единица прибавляет очко', () => {
  const initial = start();
  const a = twentyOneStep(initial, 'roll', 1)!;
  assert.equal(a.totals.challenger, 12);
  assert.equal(a.turn, 'target');
  const b = twentyOneStep(a, 'roll', 6)!;
  assert.equal(b.totals.target, 16);
  assert.equal(b.turn, 'challenger');
  assert.deepEqual(initial.totals, { challenger: 11, target: 10 }, 'входное состояние не меняется');
});

it('ровно 21 останавливает свою попытку, но ждёт завершения второй', () => {
  const initial = { ...start(), totals: { challenger: 15, target: 20 } };
  const a = twentyOneStep(initial, 'roll', 6)!;
  assert.equal(a.standing.challenger, true);
  assert.equal(a.finished, false);
  assert.equal(a.winner, null);
  assert.equal(a.turn, 'target');
  const b = twentyOneStep(a, 'stop')!;
  assert.equal(b.finished, true);
  assert.equal(b.winner, 'challenger');
});

it('перебор не лишает соперника попытки, остановившийся больше не добирает', () => {
  const a = twentyOneStep({ ...start(), totals: { challenger: 20, target: 10 } }, 'roll', 2)!;
  assert.equal(a.standing.challenger, true);
  assert.equal(a.finished, false);
  const b = twentyOneStep(a, 'roll', 6)!;
  assert.equal(b.turn, 'target', 'после стопа соперника можно закончить свой добор');
  assert.equal(b.totals.target, 16);
  const c = twentyOneStep(b, 'stop')!;
  assert.equal(c.winner, 'target');
  assert.equal(twentyOneStep(c, 'roll', 1), null);
});

it('ближайший к 21 выигрывает, равенство и два перебора дают ничью', () => {
  for (const [a, b, winner] of [[20, 21, 'target'], [21, 22, 'challenger'], [22, 20, 'target'],
    [18, 17, 'challenger'], [21, 21, null], [22, 23, null], [20, 20, null]] as const) {
    assert.equal(twentyOneWinner({ challenger: a, target: b }), winner, `${a}:${b}`);
  }
});

it('до итога игрок видит только свои очки и кости, зритель не видит ничьих', () => {
  const s: DuelTwentyOneDto = { ...start(), seq: 0, timeouts: { challenger: 0, target: 0 } };
  const a = twentyOneHide(s, 'challenger');
  assert.equal(a.totals.challenger, 11);
  assert.equal(a.totals.target, 0);
  assert.deepEqual(a.rolls.map(r => r.die), [5, 6, 0, 0]);
  const b = twentyOneHide(s, 'target');
  assert.deepEqual(b.rolls.map(r => r.die), [0, 0, 4, 6]);
  assert.deepEqual(twentyOneHide(s, null).totals, { challenger: 0, target: 0 });
  const ended = { ...s, finished: true };
  assert.equal(twentyOneHide(ended, null), ended, 'после обоих стопов всё раскрывается');
  assert.equal(s.totals.target, 10, 'маска не портит расчёт');
});

it('принимаются грани 1 и 6, невозможные грани не изменяют игру', () => {
  for (const die of [1, 6]) assert.ok(twentyOneStep(start(), 'roll', die));
  for (const die of [0, 7, 1.5, NaN]) {
    assert.equal(twentyOneStep(start(), 'roll', die), null);
    assert.throws(() => twentyOneStart('target', { challenger: [1, die], target: [2, 3] }));
  }
});
