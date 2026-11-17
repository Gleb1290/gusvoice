import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { DuelDto } from '@gusvoice/shared';
import { advanceDicePresentation as advance, createDicePresentation as create, diceNextAt, diceRoundResult, syncDicePresentation as sync } from './dicePresentation';

type Input = Pick<DuelDto, 'id' | 'rolls' | 'rollNo' | 'state'>;
const empty = (): Input => ({ id: 'party', state: 'playing', rollNo: 0, rolls: [{ challenger: null, target: null }] });
const resolved = (d = empty()): Input => ({ ...d, rollNo: 1, rolls: [{ challenger: [6, 5], target: [2, 3] }, { challenger: null, target: null }] });

it('поздний вход показывает известный результат без анимации и не придумывает скрытые кости', () => {
  const d = resolved(), p = create(d);
  assert.equal(p.active, null);
  assert.deepEqual(p.animations, {});
  assert.equal(diceRoundResult(d, 0)?.winner, 'challenger');
  assert.equal(diceRoundResult(d, 1), null);
});
it('свежая одна сторона анимируется, но победитель до второго раскрытия отсутствует', () => {
  const d: Input = { ...empty(), rolls: [{ challenger: [6, 5], target: null }] };
  const p = sync(create(empty()), d, 100);
  assert.equal(p.active, null);
  assert.equal(p.animations['0:challenger'], 1600);
  assert.equal(diceRoundResult(d, 0), null);
  assert.equal(diceNextAt(p, 100), 1600);
});
it('переход сервера к следующему броску сохраняет обе пары одного завершённого броска', () => {
  const d = resolved(), p = sync(create(empty()), d, 100);
  assert.deepEqual(p.active, { index: 0, at: 100 });
  const next: Input = { ...d, rolls: [d.rolls[0], { challenger: null, target: [1, 1] }] };
  const q = sync(p, next, 400);
  assert.equal(q.active?.index, 0);
  assert.deepEqual(diceRoundResult(next, q.active!.index), { index: 0, challenger: 11, target: 5, winner: 'challenger' });
});
it('итог получает две секунды после анимации, а повтор снимка не продлевает паузу', () => {
  const d = resolved(), p = sync(create(empty()), d, 100);
  const q = sync(p, { ...d }, 1000);
  assert.equal(q.active?.at, 100);
  assert.equal(diceNextAt(q, 1600), 3600);
  assert.ok(advance(q, 3599).active);
  assert.equal(advance(q, 3600).active, null);
});
it('быстрый второй результат не вытесняет первый, очередь сохраняет порядок', () => {
  const d = resolved(), p = sync(create(empty()), d, 100);
  const next: Input = { ...d, rollNo: 2, rolls: [d.rolls[0], { challenger: [1, 1], target: [6, 6] }, { challenger: null, target: null }] };
  const q = sync(p, next, 400);
  assert.equal(q.active?.index, 0);
  assert.deepEqual(q.queue, [1]);
  assert.deepEqual(advance(q, 3600).active, { index: 1, at: 3600 });
});
it('ничья остаётся явной ничьей, финальный settlement не стирает итог броска', () => {
  const d: Input = { ...empty(), rolls: [{ challenger: [2, 5], target: [3, 4] }] };
  assert.deepEqual(diceRoundResult(d, 0), { index: 0, challenger: 7, target: 7, winner: null });
  const p = sync(create(empty()), d, 100);
  assert.deepEqual(sync(p, { ...d, state: 'settled' }, 1600).active, p.active);
});
it('новая партия снимает прошлые результаты, уменьшенное движение сразу принимает снимок', () => {
  const d = resolved(), p = sync(create(empty()), d, 100);
  assert.equal(sync(p, { ...empty(), id: 'next' }, 200).active, null);
  assert.equal(sync(p, d, 200, true).active, null);
});
it('пропуск нескольких бросков после сна не создаёт очередь старых анимаций', () => {
  const d: Input = { ...resolved(), rollNo: 2, rolls: [{ challenger: [6, 5], target: [2, 3] }, { challenger: [1, 1], target: [6, 6] }, { challenger: null, target: null }] };
  const p = sync(create(empty()), d, 100);
  assert.equal(p.active, null);
  assert.deepEqual(p.queue, []);
  assert.equal(p.completed, 2);
});
