import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as shared from '@gusvoice/shared';
import * as rules from '../duelRules';
import * as economy from '../economy';
import * as wheel from '../wheelRules';
import * as practice from '../duelPractice';
import { React, environment, load, sourceOf } from './R171.phoneHarness';

const noop = () => {};
const now = Date.parse('2026-10-28T12:00:00Z');
const stamp = new Date(now).toISOString();
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function duel(series = true): shared.DuelDto {
  return { id: 'd', serverId: 's', channelId: 'c', game: 'rps', challengerId: 'me', targetId: 'peer', amount: 10,
    feePercent: 10, state: 'settled', inviteUntil: null, commit: 'a'.repeat(64), rollNo: 0, turnUntil: null, rolls: [],
    winnerId: 'me', payout: 18, seed: null, reason: null, settledAt: stamp, moveUntil: null,
    rps: { seq: 2, wins: { challenger: 2, target: 1 }, rounds: [], ready: { challenger: false, target: false } },
    ...(series ? { series: { id: 'series', status: 'active', round: 3, score: { challenger: 2, target: 1, draws: 1 },
      nextAt: new Date(now + 3000).toISOString() } } : {}),
  } as shared.DuelDto;
}
function fixture() {
  const pulses: any[][] = [], controls: any[][] = [], challenges: any[][] = [], replies: any[] = [], moves: any[][] = [];
  const state = { user: { id: 'me', displayName: 'Я' }, members: [],
    presence: { c: [{ userId: 'me', displayName: 'Я' }, { userId: 'peer', displayName: 'Соперник' }] },
    voice: { channelId: 'c' }, economy: { s: { iconUrl: null } },
    duels: { c: { duel: duel(), skewMs: 0 } as rules.DuelView }, selfDeafened: true,
    applyDuelEvent: (event: { duel: shared.DuelDto }) => { replies.push(event.duel); state.duels.c = { duel: event.duel, skewMs: 0 }; } };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  let pulseReply: (() => Promise<any>) | null = null, stopReply: (() => Promise<any>) | null = null;
  let elapsed = 0, timerNo = 0, backs = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const fakeWindow = { addEventListener: noop, removeEventListener: noop,
    setTimeout(cb: () => void, ms = 0) { const id = ++timerNo; timers.set(id, { at: elapsed + ms, cb }); return id; },
    clearTimeout(id: number) { timers.delete(id); } };
  const api = {
    duelSeriesPulse: async (...args: any[]) => { pulses.push(args); return pulseReply ? pulseReply() : { duel: state.duels.c.duel, serverNow: stamp }; },
    duelSeriesControl: async (...args: any[]) => { controls.push(args); return args[2] === 'stop' && stopReply ? stopReply() : { duel: null, serverNow: stamp }; },
    challengeDuel: async (...args: any[]) => { challenges.push(args); return { duel: null, serverNow: stamp }; },
    duelMove: async (...args: any[]) => { moves.push(args); return { duel: state.duels.c.duel, serverNow: stamp }; },
  };
  const deps = { '@gusvoice/shared': shared, '../api': { api }, '../assets/guscoin.svg': { default: '/coin.svg' },
    '../duelRules': rules, '../economy': economy, '../phoneLayout': { usePhoneLayout: () => false },
    '../store': { useStore }, '../wheelRules': wheel, './Avatar': { Avatar: () => null }, './Icon': { Icon: () => null },
    './BottomSheet': { BottomSheet: ({ children }: { children: React.ReactNode }) => children } };
  const globals = { window: fakeWindow, crypto: { randomUUID: () => 'stable-client-id' } };
  const duelModule = load<typeof import('./Duel')>(new URL('./Duel.tsx', import.meta.url), sourceOf('Duel'), deps, globals);
  const scene = load<typeof import('./DuelScene')>(new URL('./DuelScene.tsx', import.meta.url), sourceOf('DuelScene'), { ...deps,
    '../duelPractice': practice, '../benchMock': { isMockEconomy: () => false }, '../assets/duel/judge.png': { default: '/judge.png' },
    '../assets/duel/duelist.png': { default: '/duelist.png' }, '../assets/duel/duelist-sash.png': { default: '/sash.png' },
    '../economyClient': { ensureDuel: noop }, '../sounds': { playSound: noop },
    './Duel': { ...duelModule, useNowTick: () => now + elapsed },
  }, globals);
  return { state, pulses, controls, challenges, replies, moves, get backs() { return backs; },
    onPulse: (fn: () => Promise<any>) => { pulseReply = fn; }, onStop: (fn: () => Promise<any>) => { stopReply = fn; },
    element: () => React.createElement(scene.default, { serverId: 's', channelId: 'c', onClose: noop, onBack: () => { backs++; } }),
    async advance(ms: number) { const end = elapsed + ms; let steps = 0; await React.act(async () => {
      for (;;) { const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        if (++steps > 200) throw new Error('Превышен бюджет таймеров серии');
        elapsed = next[1].at; timers.delete(next[0]); next[1].cb();
        for (let i = 0; i < 5; i++) await Promise.resolve(); }
      elapsed = end;
    }); },
  };
}
async function press(host: ParentNode, label: string) {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
  assert.ok(button, `кнопка «${label}»`);
  await React.act(async () => { button.click(); for (let i = 0; i < 6; i++) await Promise.resolve(); });
}

it('готовность только в голосовом канале; пауза останавливает пульс и сохраняет clientId', async () => {
  await environment(async (host, render) => {
    const f = fixture(); f.state.voice.channelId = 'other'; await render(f.element());
    assert.equal(f.pulses.length, 0);
    f.state.voice.channelId = 'c'; await render(f.element());
    assert.equal(f.pulses.length, 1);
    const first = f.pulses[0][2];
    assert.equal(first.clientId, 'stable-client-id'); assert.equal(first.ready, true); assert.equal(first.visible, true);
    await press(host, 'Пауза серии'); const count = f.pulses.length;
    await f.advance(6000); assert.equal(f.pulses.length, count);
    await press(host, 'Продолжить серию'); assert.equal(f.pulses.length, count + 1);
    assert.equal(f.pulses.at(-1)![2].clientId, first.clientId);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await React.act(async () => document.dispatchEvent(new Event('visibilitychange')));
    const hiddenCount = f.pulses.length; await f.advance(6000); assert.equal(f.pulses.length, hiddenCount);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    await React.act(async () => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(f.pulses.length, hiddenCount + 1);
    await render(null); const closedCount = f.pulses.length; await f.advance(6000); assert.equal(f.pulses.length, closedCount);
  });
});

it('запоздавший ответ готовности не откатывает более свежий снимок партии', async () => {
  await environment(async (_host, render) => {
    const f = fixture(), pending = deferred<any>(); f.onPulse(() => pending.promise);
    const old = f.state.duels.c.duel!; await render(f.element());
    const fresh = { ...old, rps: { ...old.rps!, seq: 9 } }; f.state.duels.c = { duel: fresh, skewMs: 0 };
    await render(f.element());
    await React.act(async () => { pending.resolve({ duel: old, serverNow: stamp }); await pending.promise; });
    assert.equal(f.state.duels.c.duel?.rps?.seq, 9); assert.equal(f.replies.length, 0);
  });
});

it('зритель свободно выходит из чужой серии, одиночная партия не продлевает готовность', async () => {
  await environment(async (host, render) => {
    const f = fixture(); f.state.user.id = 'spectator';
    await render(f.element());
    await press(host, 'К выбору игр');
    assert.equal(f.backs, 1);
    assert.equal(f.pulses.length, 0);
    assert.equal(f.controls.length, 0, 'у зрителя нет права остановки чужой серии');
    await render(null);
    f.state.user.id = 'me'; f.state.duels.c = { duel: duel(false), skewMs: 0 };
    await render(f.element()); await f.advance(6000);
    assert.equal(f.pulses.length, 0);
    assert.equal(f.challenges.length, 0);
  });
});

it('21 показывает свою сумму и скрытого соперника, отправляет ход и ждёт обеих попыток', async () => {
  await environment(async (host, render) => {
    const f = fixture();
    const game: shared.DuelTwentyOneDto = { ...shared.twentyOneStart('challenger', { challenger: [5, 6], target: [4, 5] }),
      seq: 0, timeouts: { challenger: 0, target: 0 } };
    const d = { ...duel(false), state: 'playing' as const, game: 'twentyone' as const, payout: null, winnerId: null,
      moveUntil: new Date(now + 20_000).toISOString(), twentyOne: shared.twentyOneHide(game, 'challenger') };
    f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
    const totals = () => [...host.querySelectorAll('.twentyone-total')].map(el => el.textContent?.trim());
    assert.deepEqual(totals(), ['11 / 21', '? / 21']);
    await press(host, 'Ещё кубик');
    assert.deepEqual(f.moves, [['s', 'd', 0, 'roll']]);
    const waiting = { ...game, totals: { challenger: 21, target: 19 }, standing: { challenger: true, target: false }, turn: 'target' as const, seq: 2 };
    f.state.duels.c = { duel: { ...d, twentyOne: shared.twentyOneHide(waiting, 'challenger') }, skewMs: 0 };
    await render(f.element());
    assert.equal(host.querySelectorAll('.twentyone-actions button').length, 2);
    assert.ok([...host.querySelectorAll<HTMLButtonElement>('.twentyone-actions button')].every(button => button.disabled));
    assert.match(host.textContent ?? '', /Твоя попытка завершена.*ждём соперника/i);
    assert.equal(host.querySelector('.wh-result'), null, '21 ещё не даёт выплату до второго игрока');
    const ended = shared.twentyOneStep(waiting, 'roll', 3)!;
    f.state.duels.c = { duel: { ...d, state: 'settled', winnerId: 'me', payout: 18, moveUntil: null,
      twentyOne: { ...ended, seq: 3, timeouts: game.timeouts } }, skewMs: 0 };
    await render(f.element());
    assert.deepEqual(totals(), ['21 / 21', '22 / 21']);
    assert.match(host.textContent ?? '', /Перебор/);
    assert.match(host.querySelector('.wh-result')?.textContent ?? '', /Ты.*забираешь.*18/);
    assert.equal(f.challenges.length, 0);
  });
});

it('выход ждёт остановку, ошибка оставляет сцену; счёт и отсчёт сами не создают вызов', async () => {
  await environment(async (host, render) => {
    const f = fixture(), pending = deferred<any>(); f.onStop(() => pending.promise); await render(f.element());
    assert.match(host.querySelector('.duel-session-score')?.textContent ?? '', /2.*Ничьи:\s*1.*1/);
    assert.match(host.querySelector('.duel-series-status')?.textContent ?? '', /через 3 с/);
    await f.advance(4000); assert.equal(f.challenges.length, 0);
    await press(host, 'К выбору игр'); assert.equal(f.backs, 0);
    await React.act(async () => { pending.reject(new Error('offline')); try { await pending.promise; } catch {} });
    assert.equal(f.backs, 0); assert.match(host.querySelector('[role="alert"]')?.textContent ?? '', /Не удалось подтвердить остановку/);
    f.onStop(async () => ({ duel: null, serverNow: stamp })); await press(host, 'К выбору игр');
    assert.equal(f.backs, 1); assert.ok(f.controls.some(args => args[2] === 'stop'));
  });
});
