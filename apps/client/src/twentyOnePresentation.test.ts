import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { DuelDto, DuelSide, DuelTwentyOneDto } from '@gusvoice/shared';
import {
  advanceTwentyOnePresentation as advance, createTwentyOnePresentation as create,
  syncTwentyOnePresentation as sync, twentyOneCanMove as canMove, twentyOneNextAt as nextAt,
  twentyOneRollLabel,
} from './twentyOnePresentation';

type Input = Pick<DuelDto, 'id' | 'state' | 'twentyOne'>;
function initial(): Input {
  return { id: 'first', state: 'playing', twentyOne: {
    first: 'challenger', turn: 'challenger', seq: 0, finished: false, winner: null,
    totals: { challenger: 11, target: 0 }, standing: { challenger: false, target: false },
    timeouts: { challenger: 0, target: 0 }, hidden: { target: true },
    rolls: [{ by: 'challenger', die: 5 }, { by: 'challenger', die: 6 },
      { by: 'target', die: 0 }, { by: 'target', die: 0 }],
  } };
}
function change(d: Input, patch: Partial<DuelTwentyOneDto>): Input {
  return { ...d, twentyOne: { ...d.twentyOne!, ...patch } };
}
function roll(d: Input, die: number, side: DuelSide = 'challenger'): Input {
  const g = d.twentyOne!;
  return change(d, { seq: g.seq + 1, turn: side === 'challenger' ? 'target' : 'challenger',
    totals: { ...g.totals, [side]: g.totals[side] + die }, rolls: [...g.rolls, { by: side, die }] });
}

function unopened(): Input {
  return change(initial(), { totals: { challenger: 0, target: 0 }, rolls: [],
    started: { challenger: false, target: false } });
}
function opening(d = unopened()): Input {
  return change(d, { seq: 1, turn: 'target', totals: { challenger: 11, target: 0 },
    started: { challenger: true, target: false }, rolls: [{ by: 'challenger', die: 5 }, { by: 'challenger', die: 6 }] });
}

it('пустая доска требует два стартовых кубика и запрещает стоп; после пары разрешает добор и стоп', () => {
  const d = unopened(), p = create(d);
  assert.deepEqual(p.shown.challenger, { total: 0, die: null });
  assert.equal(twentyOneRollLabel(d, 'challenger'), 'Бросить 2 кубика');
  assert.equal(canMove(d, 'challenger', false, p), true);
  assert.equal(canMove(d, 'challenger', false, p, 'stop'), false);
  const after = change(opening(d), { turn: 'challenger' });
  assert.equal(twentyOneRollLabel(after, 'challenger'), 'Ещё кубик');
  assert.equal(canMove(after, 'challenger', false, create(after), 'stop'), true);
  assert.equal(canMove(initial(), 'challenger', false, create(initial()), 'stop'), true, 'legacy');
});

it('стартовая пара имеет общую дельту и таймлайн, следующий добор показывает одну кость', () => {
  const d = unopened(), after = opening(d);
  let p = sync(create(d), after, 100);
  assert.deepEqual(p.shown.challenger, { total: 0, die: 6, dice: [5, 6] });
  assert.equal(p.active!.die, 11);
  assert.deepEqual(p.active!.dice, [5, 6]);
  assert.equal(p.queue.length, 0);
  p = advance(p, 1600); assert.equal(p.active!.phase, 'delta');
  p = advance(p, 2150); assert.equal(p.active!.phase, 'adding');
  p = advance(p, 3000); assert.equal(p.shown.challenger.total, 11);
  const fresh = roll(after, 4);
  p = sync(p, fresh, 3100);
  assert.equal(p.shown.challenger.dice, undefined);
  assert.equal(p.active!.die, 4);
  assert.equal(p.shown.challenger.total, 11);
  assert.equal(sync(create(d), after, 100, true).shown.challenger.total, 11);
  const masked = change(after, { hidden: { challenger: true, target: true } });
  assert.deepEqual(sync(create(d), masked, 100).shown.challenger, { total: null, die: null });
});

it('настоящая доска сохраняет узел и класс суммы во время пары, блокирует повтор и скрытую вкладку', async () => {
  const { React, environment, load, sourceOf, reactProps } = await import('./components/R171.phoneHarness');
  await environment(async (host, render) => {
    let clock = 100, timerNo = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    class Clock extends Date { static override now() { return clock; } }
    const calls: string[] = [];
    const board = load<typeof import('./components/TwentyOneBoard')>(new URL('./components/TwentyOneBoard.tsx', import.meta.url), sourceOf('TwentyOneBoard'), {
      '../twentyOnePresentation': await import('./twentyOnePresentation'),
      '../assets/duel/judge.png': { default: 'judge.png' }, '../sounds': { playSound() {} },
      '../store': { useStore: { getState: () => ({ selfDeafened: true }) } },
      './DuelArt': { Duelist: () => null, Die: ({ v, rolling }: { v: number | null; rolling: boolean }) =>
        React.createElement('i', { 'data-die': v ?? '?', 'data-rolling': rolling }) },
    }, { Date: Clock, window: {
      setTimeout(fn: () => void, ms: number) { timers.set(++timerNo, { at: clock + ms, fn }); return timerNo; },
      clearTimeout(n: number) { timers.delete(n); },
    } });
    const draw = (d: Input, busy = false) => render(React.createElement(board.TwentyOneBoard, {
      duel: { ...d, challengerId: 'me', targetId: 'peer' } as DuelDto, mySide: 'challenger', busy,
      people: id => ({ name: id, avatar: null }), phone: false, onMove: move => calls.push(move),
    }));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    const d = unopened(); await draw(d);
    const buttons = () => [...host.querySelectorAll('button')];
    assert.equal(buttons()[0].textContent, 'Бросить 2 кубика');
    assert.equal(buttons()[1].disabled, true);
    const click = reactProps(buttons()[0]).onClick;
    click(); click(); assert.deepEqual(calls, ['roll']);
    await draw(opening(d));
    const total = host.querySelector('.twentyone-total')!, className = total.className;
    assert.equal(host.querySelectorAll('.me [data-rolling="true"]').length, 2);
    for (const at of [1600, 2150, 3000]) {
      clock = at;
      await React.act(async () => { for (const [id, timer] of [...timers]) if (timer.at <= at) { timers.delete(id); timer.fn(); } });
      assert.equal(host.querySelector('.twentyone-total'), total);
      assert.equal(total.className, className);
      if (at < 3000) assert.equal(total.querySelector('.twentyone-score-delta')!.textContent, '+11');
    }
    const mine = change(opening(d), { turn: 'challenger' }); await draw(mine);
    assert.equal(buttons()[0].textContent, 'Ещё кубик'); assert.equal(buttons()[1].disabled, false);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    reactProps(buttons()[0]).onClick(); assert.deepEqual(calls, ['roll']);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    await draw(mine, true); assert.equal(buttons()[0].disabled, true);
    await draw(roll(mine, 4));
    assert.equal(host.querySelectorAll('.me [data-rolling="true"]').length, 1);
    assert.equal(host.querySelectorAll('.me .twentyone-die-slot').length, 2, 'резерв двух слотов сохраняется');
    await render(React.createElement('div'));
    assert.equal(timers.size, 0, 'уход со сцены очищает таймер фазы');
  });
});

it('открытие и повторный снимок показывают только последний кубик без проигрывания истории', () => {
  const d = roll(initial(), 3);
  const p = create(d);
  assert.deepEqual(p.shown.challenger, { total: 14, die: 3 });
  assert.equal(p.active, null);
  assert.equal(nextAt(p), null);
  assert.deepEqual(sync(p, structuredClone(d), 500), p);
});

it('добор держит старый счёт 1500 мс, показывает плюс 550 мс и прибавляет после 850 мс гашения', () => {
  const d = initial();
  let p = sync(create(d), roll(d, 3), 100);
  assert.equal(p.active?.phase, 'rolling');
  assert.deepEqual(p.shown.challenger, { total: 11, die: 3 });
  assert.equal(nextAt(p), 1600);
  p = advance(p, 1599);
  assert.equal(p.active?.phase, 'rolling');
  p = advance(p, 1600);
  assert.equal(p.active?.phase, 'delta');
  assert.equal(p.active?.die, 3);
  assert.equal(p.shown.challenger.total, 11);
  assert.equal(nextAt(p), 2150);
  p = advance(p, 2149);
  assert.equal(p.active?.phase, 'delta');
  p = advance(p, 2150);
  assert.equal(p.active?.phase, 'adding');
  assert.equal(p.shown.challenger.total, 11);
  assert.equal(nextAt(p), 3000);
  p = advance(p, 2999);
  assert.equal(p.shown.challenger.total, 11);
  p = advance(p, 3000);
  assert.deepEqual(p.shown.challenger, { total: 14, die: 3 });
  assert.equal(p.active, null);
});

it('чужой ход, стоп и итог не обрывают собственный финальный бросок', () => {
  const d = change(initial(), { totals: { challenger: 19, target: 0 } });
  const final = roll(d, 3);
  let p = sync(create(d), final, 10);
  const startedAt = p.active!.startedAt;
  const settled = { ...change(final, { seq: 2, finished: true,
    standing: { challenger: true, target: true }, hidden: {},
    totals: { challenger: 22, target: 20 },
    rolls: final.twentyOne!.rolls.map(r => r.by === 'target' ? { ...r, die: 5 } : r),
  }), state: 'settled' as const };
  p = sync(p, settled, 900);
  assert.equal(p.active?.startedAt, startedAt);
  assert.equal(p.shown.challenger.total, 19);
  assert.deepEqual(p.shown.target, { total: 20, die: 5 });
  p = advance(p, 1510);
  assert.equal(p.active?.phase, 'delta');
  p = advance(p, 2910);
  assert.equal(p.shown.challenger.total, 22);
  assert.equal(p.active, null);
});

it('быстрые последовательные доборы показываются по очереди, не отменяя предыдущий', () => {
  const d = initial();
  const first = roll(d, 2);
  const second = roll(first, 4);
  let p = sync(create(d), first, 100);
  p = sync(p, second, 200);
  assert.equal(p.active?.die, 2);
  assert.equal(p.queue.length, 1);
  assert.equal(p.shown.challenger.total, 11);
  p = advance(p, 3000);
  assert.equal(p.shown.challenger.total, 13);
  assert.equal(p.active?.die, 4);
  assert.equal(p.active?.startedAt, 3000);
  p = advance(p, 5900);
  assert.deepEqual(p.shown.challenger, { total: 17, die: 4 });
  assert.equal(p.queue.length, 0);
  assert.equal(p.active, null);
});

it('скрытый противник не отдаёт числа или дельту даже при полном входном DTO, раскрытие не играет старые кости', () => {
  const d = initial();
  const fullButHidden = change(roll(d, 6, 'target'), { totals: { challenger: 11, target: 16 } });
  let p = sync(create(d), fullButHidden, 100);
  assert.deepEqual(p.shown.target, { total: null, die: null });
  assert.deepEqual(p.latest.target, { total: null, die: null });
  assert.equal(p.active, null);
  assert.deepEqual(p.queue, []);
  const revealed = { ...change(fullButHidden, { finished: true, hidden: {} }), state: 'settled' as const };
  p = sync(p, revealed, 200);
  assert.deepEqual(p.shown.target, { total: 16, die: 6 });
  assert.equal(p.active, null);
  // Повторная установка маски должна вычистить уже видимую анимацию, а не только подпись.
  const visible = change(d, { hidden: {} });
  let active = sync(create(visible), roll(visible, 2, 'target'), 0);
  assert.ok(active.active);
  active = sync(active, change(roll(visible, 2, 'target'), { hidden: { target: true } }), 200);
  assert.equal(active.active, null);
  assert.deepEqual(active.shown.target, { total: null, die: null });
});

it('новая партия сбрасывает очередь и таймер, не изменяя серверные данные', () => {
  const d = initial();
  const snapshot = structuredClone(d);
  let p = sync(create(d), roll(d, 6), 100);
  p = sync(p, { ...d, id: 'second' }, 200);
  assert.equal(p.id, 'second');
  assert.equal(p.active, null);
  assert.equal(nextAt(p), null);
  assert.deepEqual(p.queue, []);
  assert.deepEqual(p.shown.challenger, { total: 11, die: 6 });
  assert.deepEqual(d, snapshot);
});

it('снимок после пропуска событий догоняет счёт без старых анимаций и не обрывает уже видимый бросок', () => {
  const d = initial();
  const first = roll(d, 1);
  const gap = roll(roll(first, 2), 3);
  let p = sync(create(d), gap, 100);
  assert.equal(p.active, null);
  assert.equal(p.shown.challenger.total, 17);
  p = sync(create(d), first, 100);
  p = sync(p, gap, 200);
  assert.equal(p.active?.die, 1);
  assert.equal(p.shown.challenger.total, 11);
  p = advance(p, 3000);
  assert.equal(p.shown.challenger.total, 17);
  assert.equal(p.active, null);
  assert.equal(sync(p, first, 3100), p, 'запоздавший снимок не откатывает счёт');
});

it('уменьшение движения обновляет число сразу, в том числе посреди броска', () => {
  const d = initial();
  const fresh = roll(d, 4);
  const p = sync(create(d), fresh, 100, true);
  assert.equal(p.shown.challenger.total, 15);
  assert.equal(p.active, null);
  assert.equal(nextAt(p), null);
  const active = sync(create(d), fresh, 100);
  const reduced = advance(active, 101, true);
  assert.equal(reduced.shown.challenger.total, 15);
  assert.equal(reduced.active, null);
  assert.deepEqual(reduced.queue, []);
  assert.equal(sync(active, fresh, 102, true).active, null);
});

it('ход разрешён только своему игроку без busy и закрыт во всех фазах показа, на чужом ходу, после стопа и итога', () => {
  const d = initial();
  const idle = create(d);
  assert.equal(canMove(d, 'challenger', false, idle), true);
  assert.equal(canMove(d, 'challenger', true, idle), false);
  assert.equal(canMove(d, null, false, idle), false);
  assert.equal(canMove(d, 'target', false, idle), false);
  assert.equal(canMove(change(d, { standing: { challenger: true, target: false } }), 'challenger', false, idle), false);
  assert.equal(canMove(change(d, { finished: true }), 'challenger', false, idle), false);
  const rolled = change(roll(d, 3), { turn: 'challenger' });
  let p = sync(idle, rolled, 0);
  for (const time of [0, 1500, 2050, 2899]) {
    p = advance(p, time);
    assert.equal(canMove(rolled, 'challenger', false, p), false);
    assert.equal(canMove({ ...rolled, state: 'settled' }, 'challenger', false, p), false);
  }
  p = advance(p, 2900);
  assert.equal(canMove(rolled, 'challenger', false, p), true);
  assert.equal(canMove({ ...rolled, state: 'settled' }, 'challenger', false, p), false);
});

it('после догоняющего снимка следующий свежий добор прибавляется к его точной базе', () => {
  const d = initial();
  const first = roll(d, 1);
  const gap = roll(roll(first, 2), 3);
  const fresh = roll(gap, 4);
  let p = sync(create(d), first, 0);
  p = sync(p, gap, 100);
  p = sync(p, fresh, 200);
  assert.equal(p.active?.die, 1);
  p = advance(p, 2900);
  assert.equal(p.active?.die, 4);
  assert.equal(p.shown.challenger.total, 17);
  p = advance(p, 5800);
  assert.equal(p.shown.challenger.total, 21);
});
