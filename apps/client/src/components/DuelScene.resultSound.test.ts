import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { DuelDto, DuelGame } from '@gusvoice/shared';
import * as shared from '@gusvoice/shared';
import * as rules from '../duelRules';
import * as economy from '../economy';
import * as wheel from '../wheelRules';
import { React, environment, load, sourceOf } from './R171.phoneHarness';

// R377: настоящая сцена и React-эффекты, без Vite, игл и контрфактов.
const source = sourceOf('DuelScene');
const noop = () => {};
const now = Date.parse('2026-10-30T12:00:00Z');
const art = { default: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=' };
function duel(id: string, game: DuelGame = 'rps', challengerId = 'me'): DuelDto {
  return { id, serverId: 's', channelId: 'c', game, challengerId, targetId: challengerId === 'me' ? 'peer' : 'me',
    amount: 10, feePercent: 10, state: 'playing', inviteUntil: null, commit: 'a'.repeat(64), rollNo: 0, turnUntil: null,
    rolls: [], winnerId: null, payout: null, seed: null, reason: null, settledAt: null, moveUntil: new Date(now + 20_000).toISOString(),
    rps: { seq: 1, wins: { challenger: 0, target: 0 }, rounds: [], ready: { challenger: false, target: false } },
    greedy: { seq: 1, first: 'challenger', turn: 'challenger', scores: { challenger: 0, target: 0 }, turnPoints: 0,
      rolls: [], lastRoll: null, burned: 0, timeouts: { challenger: 0, target: 0 } } };
}
function fixture() {
  const sounds: string[] = [];
  const state = { user: { id: 'me' } as { id: string } | null, selfDeafened: false,
    voice: { channelId: 'c' }, economy: { s: { iconUrl: null } }, duels: { c: { duel: duel('initial'), skewMs: 0 } } };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  const { default: Scene } = load<typeof import('./DuelScene')>(new URL('./DuelScene.tsx', import.meta.url), source, {
    '@gusvoice/shared': shared, '../api': { api: {} }, '../benchMock': { isMockEconomy: () => false },
    '../assets/guscoin.svg': art, '../assets/duel/judge.png': art,
    '../assets/duel/duelist.png': art, '../assets/duel/duelist-sash.png': art,
    '../duelRules': rules, '../economy': economy, '../wheelRules': wheel, '../duelPractice': {},
    '../economyClient': { ensureDuel: noop }, '../phoneLayout': { usePhoneLayout: () => false }, '../store': { useStore },
    '../sounds': { playSound: (event: string) => sounds.push(event) },
    './Avatar': { Avatar: () => null }, './Icon': { Icon: () => null }, './BottomSheet': {},
    './Duel': { useDuelPeople: () => (id: string) => ({ name: id, avatar: null }), useNowTick: () => now,
      CountRing: () => null, applyDuelReply: noop, duelFailText: String },
  }, { fetch: () => { throw new Error('Сеть в тесте сцены запрещена'); } });
  return { state, sounds, element: () => React.createElement(Scene, { serverId: 's', channelId: 'c', onClose: noop, onBack: noop }),
    set(d: DuelDto) { state.duels.c = { duel: d, skewMs: 0 }; } };
}

it('проигрыш в открытой сцене звучит один раз для обеих ролей во всех трёх играх', async () => {
  await environment(async (_host, render) => {
    const f = fixture();
    for (const game of ['rps', 'dice', 'greedy'] as const) for (const challenger of ['me', 'peer']) {
      f.sounds.length = 0;
      const d = duel(`${game}-${challenger}`, game, challenger);
      f.set(d); await render(f.element());
      assert.deepEqual(f.sounds, [], 'начало партии ещё не является поражением');
      const settled = { ...d, state: 'settled' as const, winnerId: 'peer' };
      f.set(settled); await render(f.element());
      assert.deepEqual(f.sounds, ['duelLose'], `${game}: проигравшему не подменяют поражение победой`);
      f.set({ ...settled }); await render(f.element());
      assert.deepEqual(f.sounds, ['duelLose'], 'повтор снимка не дублирует звук итога');
      await render(null);
    }
  });
});

it('открытая сцена не озвучивает ничью, зрителю, вышедшему пользователю и при деафене', async () => {
  await environment(async (_host, render) => {
    const f = fixture();
    for (const [id, viewer, winner, deafened] of [
      ['spectator', 'viewer', 'peer', false], ['draw', 'me', null, false], ['logout', null, 'peer', false],
      ['deaf-lose', 'me', 'peer', true], ['deaf-win', 'me', 'me', true],
    ] as const) {
      f.state.user = viewer ? { id: viewer } : null; f.state.selfDeafened = deafened;
      const d = duel(id); f.set(d); await render(f.element());
      f.set({ ...d, state: 'settled', winnerId: winner }); await render(f.element());
      assert.deepEqual(f.sounds, [], id);
      f.state.selfDeafened = false; await render(f.element());
      assert.deepEqual(f.sounds, [], 'снятие деафена не проигрывает старый итог');
      await render(null);
    }
  });
});

it('старый итог открывается молча, новая победа сохраняет отдельный победный звук', async () => {
  await environment(async (_host, render) => {
    const f = fixture();
    for (const winnerId of ['me', 'peer']) {
      const old = { ...duel(`old-${winnerId}`), state: 'settled' as const, winnerId };
      f.set(old); await render(f.element()); f.set({ ...old }); await render(f.element());
      assert.deepEqual(f.sounds, [], 'открытие результата не запускает старую победу или поражение');
      await render(null);
    }
    const next = duel('next'); f.set(next); await render(f.element());
    f.set({ ...next, state: 'settled', winnerId: 'me' }); await render(f.element());
    assert.deepEqual(f.sounds, ['duelWin'], 'звук поражения не вытеснил звук победы');
  });
});
