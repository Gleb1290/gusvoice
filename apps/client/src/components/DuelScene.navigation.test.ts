import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as shared from '@gusvoice/shared';
import * as practice from '../duelPractice';
import * as rules from '../duelRules';
import * as economy from '../economy';
import * as wheel from '../wheelRules';
import * as predictions from '../predictionRules';
import { React, environment, load, sourceOf } from './R171.phoneHarness';

const sources = { scene: sourceOf('DuelScene'), card: sourceOf('Duel'), host: sourceOf('Activities') };
type Sources = typeof sources;
const now = Date.parse('2026-10-29T12:00:00Z');
const noop = () => {};
const normal = (value: unknown) => JSON.parse(JSON.stringify(value));
function duel(state: shared.DuelState = 'playing'): shared.DuelDto {
  const d = practice.practiceStart('dice', 'me', now, { unit: () => 0, die: () => 1 }).duel;
  return { ...d, id: 'synthetic-duel', serverId: 's', channelId: 'c', targetId: 'peer', amount: 25,
    state, feePercent: 10, inviteUntil: new Date(now + 30_000).toISOString(),
    settledAt: new Date(now - shared.DUEL_REMATCH_PAUSE_MS - 1).toISOString(),
    winnerId: state === 'settled' ? 'me' : null, payout: state === 'settled' ? 45 : null };
}
function fixture(raw: Sources, phone: boolean) {
  let backed = 0, closed = 0;
  let hookEntries = 0, stateUpdates = 0, requests = 0;
  const safety = (ok: boolean, label: string) => {
    if (!ok) throw new Error(`R359/nav/safety/${label}`);
  };
  // Ограничить нужно и внутренние обновления React, не только внешние вызовы render.
  // Ошибка бюджета не AssertionError и никогда не считается адресным падением мутанта.
  const boundedReact = { ...React, useState<T>(initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
    safety(++hookEntries <= 2000, 'hook-entries');
    const [value, dispatch] = React.useState(initial);
    const update = React.useCallback((next: React.SetStateAction<T>) => {
      safety(++stateUpdates <= 200, 'state-updates'); dispatch(next);
    }, [dispatch]);
    return [value, update];
  } };
  const challenges: unknown[][] = [], transitions: unknown[] = [];
  type Act = { serverId: string; view: string; channelId?: string; practiceGame?: shared.DuelGame };
  const state = {
    user: { id: 'me', displayName: 'Игрок' }, members: [], selfDeafened: true,
    presence: { c: [{ userId: 'me', displayName: 'Игрок' }, { userId: 'peer', displayName: 'Соперник' }] },
    voice: { serverId: 's', channelId: 'c' }, bootstrap: { server: { id: 's' } },
    economy: { s: { gamesEnabled: true, iconUrl: null, wallet: { balance: 100, games: { effectiveLimit: 100, lossToday: 0 } } } },
    duels: { c: { duel: duel(), skewMs: 0 } } as Record<string, rules.DuelView | null>,
    duelLimits: { s: { betMax: 100, feePercent: 10 } }, wheel: {}, predictions: {},
    serverFeatures: [shared.FEATURE_DUEL2, shared.FEATURE_DUEL21], activitiesOpen: null as Act | null, predictionToast: null,
    applyDuelEvent: noop, setPredictionToast: noop,
    openActivities(value: Act | null) { transitions.push(value); state.activitiesOpen = value; },
  };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  const deps = {
    react: boundedReact,
    '@gusvoice/shared': shared, '../duelRules': rules, '../duelPractice': practice, '../economy': economy,
    '../wheelRules': wheel, '../predictionRules': predictions, '../store': { useStore, voiceIsHere: () => true },
    '../api': { api: { async challengeDuel(...args: unknown[]) {
      challenges.push(args); return { duel: duel(), serverNow: new Date(now).toISOString() };
    } } }, '../benchMock': { isMockEconomy: () => false },
    '../economyClient': { ensureDuel: noop, ensureEconomy: noop, ensureWheel: noop, ensurePredictions: noop },
    '../phoneLayout': { usePhoneLayout: () => phone }, '../sounds': { playSound: noop },
    '../assets/guscoin.svg': { default: '/synthetic-coin.svg' }, '../assets/duel/judge.png': { default: '/synthetic-judge.png' },
    '../assets/duel/duelist.png': { default: '/synthetic-duelist.png' }, '../assets/duel/duelist-sash.png': { default: '/synthetic-sash.png' },
    './Avatar': { Avatar: () => React.createElement('i') }, './Icon': { Icon: () => React.createElement('i') },
    './BottomSheet': { BottomSheet: ({ children, onBack }: { children: React.ReactNode; onBack: () => void }) =>
      React.createElement('section', null, React.createElement('button', { className: 'sheet-back', onClick: onBack }, 'Назад'), children) },
  };
  const card = load<typeof import('./Duel')>(new URL('./Duel.tsx', import.meta.url), raw.card, deps);
  const scene = load<typeof import('./DuelScene')>(new URL('./DuelScene.tsx', import.meta.url), raw.scene, { ...deps, './Duel': { ...card, useNowTick: () => now } });
  // Ленивый ребёнок заменён на кнопку, но весь ActivitiesHost и его настоящие onBack/backToForm исполняются.
  const host = load<typeof import('./Activities')>(new URL('./Activities.tsx', import.meta.url), raw.host, { ...deps,
    './Duel': { ...card, DuelInvite: () => null, GameToastShelf: () => null },
    './GameBoard': { GameBoardScene: () => null }, './GamesLimit': { GamesLimit: () => null },
    './DuelScene': { default: ({ onBack }: { onBack: () => void }) => React.createElement('button', { className: 'host-scene-back', onClick: onBack }, 'Назад') },
    './WheelScene': { default: () => null }, './Predictions': { default: () => null },
  });
  const onBack = () => { backed++; }, onClose = () => { closed++; };
  return { state, challenges, transitions, backed: () => backed, closed: () => closed,
    renderRequested() { safety(++requests <= 200, 'render-requests'); },
    scene: (key = 'scene') => React.createElement(scene.default, { key, serverId: 's', channelId: 'c', onBack, onClose }),
    card: () => React.createElement(card.DuelNewCard, { serverId: 's', targetId: 'peer', onBack, onClose, onOpenScene: noop, onPractice: noop }),
    host: () => React.createElement(host.ActivitiesHost),
  };
}
type Fixture = ReturnType<typeof fixture>;
type Check = (f: Fixture, host: HTMLDivElement, render: (n: React.ReactNode) => Promise<void>) => Promise<void>;
const one = <T extends Element>(host: ParentNode, selector: string): T => {
  const found = host.querySelectorAll<T>(selector); assert.equal(found.length, 1, `R358/nav/check/один ${selector}`); return found[0];
};
async function click(button: HTMLButtonElement) { await React.act(async () => { button.click(); for (let i = 0; i < 6; i++) await Promise.resolve(); }); }
async function run(raw: Sources, phone: boolean, check: Check) {
  await environment(async (host, render) => {
    const f = fixture(raw, phone);
    await check(f, host, async element => { f.renderRequested(); await render(element); });
  });
}
function paired(title: string, check: Check, phone = false) {
  it(title, async () => { await run(sources, phone, check); });
}

for (const phone of [false, true]) {
  paired(`R358 ${phone ? 'телефон' : 'ПК'}: постоянный выход доступен в каждой фазе, реванш отключён до итога`, async (f, host, render) => {
    for (const phase of ['invited', 'playing', 'settled', 'cancelled', null] as const) {
      f.state.duels.c = phase === null ? null : { duel: duel(phase), skewMs: 0 };
      await render(f.scene(String(phase)));
      one(host, '.dc-body > .game-actions');
      if (phase === 'playing') {
        assert.equal(host.querySelectorAll('.game-actions button').length, 2);
        assert.equal(one<HTMLButtonElement>(host, '.game-actions-main').disabled, true, 'реванш остаётся на месте, но до итога недоступен');
      }
      const back = one<HTMLButtonElement>(host, phone ? '.sheet-back' : '.game-actions-back');
      assert.equal(back.textContent?.trim(), phone ? 'Назад' : 'К выбору игр', 'явный выход из игры');
      const before = f.backed(); await click(back);
      assert.equal(f.backed(), before + 1, 'R358/nav/check/шапка вызывает onBack');
      assert.equal(f.closed(), 0, 'R358/nav/check/назад не закрывает активности');
      if (phase === null) assert.deepEqual([...host.querySelectorAll('.game-actions button')].map(b => b.textContent?.trim()), ['К выбору игр'], 'R358/nav/check/пустой канал ведёт к форме');
    }
  }, phone);
}

for (const side of ['challenger', 'target'] as const) {
  paired(`R358 участник ${side}: итог и отмена дают К выбору игр и настоящий Реванш с прежней игрой и ставкой`, async (f, host, render) => {
    f.state.user.id = side === 'challenger' ? 'me' : 'peer';
    for (const phase of ['settled', 'cancelled'] as const) {
      const d = duel(phase); f.state.duels.c = { duel: d, skewMs: 0 };
      await render(f.scene(phase));
      assert.deepEqual([...host.querySelectorAll('.game-actions button')].map(b => b.textContent?.trim()), ['К выбору игр', 'Реванш'], 'R358/nav/check/пара действий участника');
      await click(one<HTMLButtonElement>(host, '.game-actions-back'));
      assert.equal(f.backed(), phase === 'settled' ? 1 : 2, 'R358/nav/check/выбор игр вызывает onBack');
      assert.equal(f.closed(), 0, 'R358/nav/check/выбор игр не закрывает');
      const rematch = one<HTMLButtonElement>(host, '.game-actions-main');
      assert.equal(rematch.disabled, false, 'R358/nav/check/пауза реванша уже прошла');
      const requestsBefore = f.challenges.length;
      await click(rematch);
      // Мутант без обработчика обязан дать маленький адресный diff, не JSON.parse(undefined)
      // и не случайное сравнение с прежним вызовом из предыдущей фазы.
      assert.equal(f.challenges.length, requestsBefore + 1, 'R358/nav/check/реванш создаёт ровно один новый вызов');
      assert.deepEqual(normal(f.challenges.at(-1)), ['s', { channelId: 'c', targetId: side === 'challenger' ? 'peer' : 'me', game: 'dice', amount: 25 }],
        'R358/nav/check/реванш прежнему сопернику');
    }
  });
}

paired('R358 зрителю итога и участнику вне канала доступен только выбор игр, не реванш', async (f, host, render) => {
  for (const viewer of ['spectator', 'outside'] as const) {
    f.state.user.id = viewer === 'spectator' ? 'spectator' : 'me';
    f.state.voice.channelId = viewer === 'outside' ? 'elsewhere' : 'c';
    f.state.duels.c = { duel: duel('settled'), skewMs: 0 };
    await render(f.scene(viewer));
    assert.deepEqual([...host.querySelectorAll('.game-actions button')].map(b => b.textContent?.trim()), ['К выбору игр'], 'R358/nav/check/без недоступного реванша');
    await click(one<HTMLButtonElement>(host, '.game-actions-back'));
  }
  assert.equal(f.backed(), 2, 'R358/nav/check/оба возвращаются к форме');
  assert.deepEqual(f.challenges, [], 'R358/nav/check/нет вызовов от зрителя');
});

for (const view of ['duel', 'duel-practice'] as const) {
  paired(`R358 настоящий ActivitiesHost возвращает ${view} к duel-new, не к списку активностей`, async (f, host, render) => {
    f.state.activitiesOpen = { serverId: 's', channelId: 'c', view, ...(view === 'duel-practice' ? { practiceGame: 'greedy' as const } : {}) };
    await render(f.host());
    await click(one<HTMLButtonElement>(host, '.host-scene-back'));
    assert.deepEqual(normal(f.transitions), [{ serverId: 's', view: 'duel-new' }], 'R358/nav/check/хост ведёт к форме');
  });
}

for (const solo of [false, true]) {
  paired(`R358 ${solo ? 'тренировочная' : 'обычная'} форма: все три подсказки непустые, одна главная wh-place в game-actions`, async (f, host, render) => {
    f.state.duels.c = null;
    if (solo) f.state.presence.c = [f.state.presence.c[0]];
    await render(f.card());
    const games = [...host.querySelectorAll<HTMLButtonElement>('.duel-game')];
    assert.equal(games.length, 3, 'R358/nav/check/три игры');
    for (let n = 0; n < games.length; n++) {
      await click(games[n]);
      const hint = one(host, '.duel-game-hint').textContent?.trim() ?? '';
      assert.ok(hint.length > 0, 'R358/nav/check/место подсказки не пусто');
      assert.match(hint, n === 0 ? /На бросок.*судья/ : n === 1 ? /На ход.*поражение/ : /На решение.*Стоп/, 'R358/nav/check/подсказка выбранной игры');
      assert.equal(host.querySelectorAll('.wh-place').length, 1, 'R358/nav/check/одна главная кнопка');
      one(host, '.game-actions > .wh-place.ew-btn-main.game-actions-main');
      assert.equal(host.querySelectorAll('.game-actions .ew-btn-main').length, 1, 'R358/nav/check/вторичная кнопка не главная');
    }
  });
}
