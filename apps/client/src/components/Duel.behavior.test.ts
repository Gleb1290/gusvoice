import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as shared from '@gusvoice/shared';
import * as rules from '../duelRules';
import * as economy from '../economy';
import * as wheel from '../wheelRules';
import { React, environment, load, sourceOf, reactProps } from './R171.phoneHarness';

const source = sourceOf('Duel');
const noop = () => {};
const normal = (v: unknown) => JSON.parse(JSON.stringify(v));
const now = Date.parse('2026-10-28T12:00:00Z');
const MAX_STORE_READS = 1_024;
const baseDuel = (): shared.DuelDto => ({ id: 'd', serverId: 's', channelId: 'c', game: 'dice', challengerId: 'peer', targetId: 'me',
  amount: 10, feePercent: 10, state: 'invited', inviteUntil: new Date(now + 30_000).toISOString(), commit: 'a'.repeat(64),
  rollNo: 0, turnUntil: null, rolls: [], winnerId: null, payout: null, seed: null, reason: null, settledAt: null });
function fixture(raw: string, pending = false) {
  const requests: Array<[string, { channelId: string; targetId: string; game: shared.DuelGame; amount: number }]> = [];
  const replies: unknown[][] = [], opened: unknown[][] = [];
  let failure: Error | null = null;
  let release: (() => void) | undefined;
  const waiting = pending ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  const eco = { gamesEnabled: true, iconUrl: null, wallet: { balance: 300, games: { effectiveLimit: 200, lossToday: 0 } } };
  const state = { user: { id: 'me', displayName: 'Я' }, voice: { channelId: 'c', serverId: 's' },
    members: [], presence: { c: [{ userId: 'me', displayName: 'Я' }, { userId: 'bot', displayName: 'Автомат', bot: true },
      { userId: 'peer', displayName: 'Соперник' }] },
    economy: { s: eco }, duelLimits: { s: { betMax: 100, feePercent: 10 } }, wheel: {}, duels: {},
    serverFeatures: [shared.FEATURE_DUEL2, shared.FEATURE_DUEL21], duelInvite: null as rules.DuelView | null,
    applyDuelEvent: (...args: unknown[]) => replies.push(args), gameToast: null, setGameToast: noop };
  let storeReads = 0;
  const useStore = Object.assign((select: (s: typeof state) => unknown) => {
    // У каждого рендера DuelInvite есть чтения стора. Это предохранитель, не успешный контрфакт:
    // обычный Error не пройдёт paired, который принимает только поведенческий AssertionError.
    if (++storeReads > MAX_STORE_READS) throw new Error(`R342 safety: Duel превысил ${MAX_STORE_READS} чтения стора — возможен цикл рендера`);
    return select(state);
  }, { getState: () => state });
  class TestDate extends Date { static override now() { return now; } }
  const module = load<typeof import('./Duel')>(new URL('./Duel.tsx', import.meta.url), raw, {
    '@gusvoice/shared': shared, '../api': { api: {
      challengeDuel: async (server: string, body: typeof requests[number][1]) => { requests.push([server, body]); await waiting; if (failure) throw failure;
        return { duel: baseDuel(), serverNow: new Date(now).toISOString() }; },
      duelAction: async (_s: string, _d: string, action: string) => ({ duel: { ...baseDuel(), state: action === 'accept' ? 'playing' : 'cancelled' }, serverNow: new Date(now).toISOString() }),
    } }, '../assets/guscoin.svg': { default: '/synthetic-coin.svg' }, '../duelRules': rules, '../economy': economy,
    '../phoneLayout': { usePhoneLayout: () => false }, '../store': { useStore }, '../wheelRules': wheel,
    './Avatar': { Avatar: () => React.createElement('span') }, './Icon': { Icon: () => React.createElement('i') },
    './BottomSheet': { BottomSheet: ({ children }: { children: React.ReactNode }) => children },
  }, { Date: TestDate });
  return { module, state, requests, replies, opened, release: () => release?.(), fail: (e: Error) => { failure = e; },
    card: () => React.createElement(module.DuelNewCard, { serverId: 's', targetId: 'peer', onClose: noop, onBack: noop,
      onOpenScene: (...args: unknown[]) => opened.push(args) }) };
}
type Fixture = ReturnType<typeof fixture>;
async function run(raw: string, check: (f: Fixture, host: HTMLDivElement, render: (n: React.ReactNode) => Promise<void>) => Promise<void>) {
  await environment(async (host, render) => { await check(fixture(raw), host, render); });
}
function paired(title: string, check: (f: Fixture, host: HTMLDivElement, render: (n: React.ReactNode) => Promise<void>) => Promise<void>) {
  it(title, async () => { await run(source, check); });
}

const one = <T extends Element>(host: ParentNode, selector: string): T => {
  const found = host.querySelectorAll<T>(selector);
  assert.equal(found.length, 1, `duel UI: единственный ${selector}`); return found[0];
};
async function click(el: HTMLButtonElement) { await React.act(async () => { el.click(); for (let i = 0; i < 6; i++) await Promise.resolve(); }); }
paired('R334 соперники формы исключают меня и ботов, обычный участник остаётся', async (f, host, render) => {
  await render(f.card());
  assert.deepEqual([...host.querySelectorAll('.duel-rival-name')].map(n => n.textContent), ['Соперник'], 'duel UI: выбирать можно только человека кроме меня');
  assert.equal(one<HTMLButtonElement>(host, '.duel-rival').getAttribute('aria-checked'), 'true', 'duel UI: адресат из контекстного меню выбран');
});
for (const game of shared.DUEL_GAMES) paired(`R337 выбранная игра ${game} и ставка доходят до API и ответ открывает сцену`, async (f, host, render) => {
  await render(f.card());
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('.duel-game')];
  await click(buttons[shared.DUEL_GAMES.indexOf(game)]);
  await click(one<HTMLButtonElement>(host, '.wh-place'));
  assert.deepEqual(normal(f.requests), [['s', { channelId: 'c', targetId: 'peer', game, amount: 10 }]], 'duel UI: API получает выбранную игру, адресата и ставку');
  assert.deepEqual(f.opened, [['c']], 'duel UI: успешный вызов открывает сцену своего канала');
  assert.equal(f.replies.length, 1, 'duel UI: ответ вызова применён к стору');
});
paired('R337 старый сервер выключает выборные игры и сбрасывает прежний выбор в dice', async (f, host, render) => {
  await render(f.card());
  await click([...host.querySelectorAll<HTMLButtonElement>('.duel-game')][1]);
  f.state.serverFeatures = [];
  await render(f.card());
  const games = [...host.querySelectorAll<HTMLButtonElement>('.duel-game')];
  assert.deepEqual(games.map(n => n.disabled), [false, true, true], 'duel UI: без duel2 доступны только кубики');
  assert.deepEqual(games.map(n => n.getAttribute('aria-checked')), ['true', 'false', 'false'], 'duel UI: скрытый старый выбор не остаётся активным');
  await click(one<HTMLButtonElement>(host, '.wh-place'));
  assert.equal(f.requests[0][1].game, 'dice', 'duel UI: API старого сервера не получает выборную игру');
});
paired('R337 отказ вызова использует reason и выбранную игру, generic message не прячет несовместимость соперника', async (f, host, render) => {
  f.fail(Object.assign(new Error('generic'), { reason: 'target_unavailable' }));
  await render(f.card()); await click([...host.querySelectorAll<HTMLButtonElement>('.duel-game')][1]);
  await click(one<HTMLButtonElement>(host, '.wh-place'));
  assert.equal(host.querySelector('[role="alert"]')?.textContent?.trim(), 'Эта игра на его версии пока не открывается — позови его на кубики',
    'duel UI: reason и выбранная игра объясняют отказ вызова');
  assert.deepEqual(f.opened, [], 'duel UI: неудачный вызов не открывает несуществующую сцену');
});
paired('R334 ставка ограничена каждым из трёх потолков, остаток ровно ноль отключает вызов', async (f, host, render) => {
  await render(f.card());
  for (const [betMax, balance, limit, loss, cap] of [[35, 80, 90, 0, 35], [75, 25, 90, 0, 25], [75, 80, 90, 70, 20], [75, 80, 90, 90, 0]]) {
    f.state.duelLimits.s.betMax = betMax; f.state.economy.s.wallet.balance = balance;
    f.state.economy.s.wallet.games.effectiveLimit = limit; f.state.economy.s.wallet.games.lossToday = loss;
    await render(f.card());
    const input = one<HTMLInputElement>(host, '.wh-amount-input');
    await React.act(async () => { reactProps(input).onChange({ target: { value: '999' } }); });
    assert.equal(input.max, cap ? String(cap) : '', 'duel UI: поле отражает самый тесный потолок');
    const button = one<HTMLButtonElement>(host, '.wh-place');
    assert.equal(button.disabled, cap === 0, 'duel UI: при нуле нельзя отправить ставку');
    if (cap > 0) { await click(button); assert.equal(f.requests.at(-1)![1].amount, cap, 'duel UI: завышенное поле зажато до потолка'); }
  }
});
paired('R334 причина сервера главнее общего message, личная рука ответа передаётся вторым аргументом', async f => {
  const error = Object.assign(new Error('generic'), { reason: 'poor' });
  assert.equal(f.module.duelFailText(error), 'Не хватает монет в сундуке', 'duel UI: reason не теряется за Error.message');
  const d = baseDuel(), serverNow = new Date(now).toISOString();
  for (const myHand of ['rock', null, undefined] as const) f.module.applyDuelReply('s', { duel: d, serverNow, myHand });
  assert.deepEqual(normal(f.replies), normal(['rock', null, undefined].map(hand => [{ t: 'duel.state', serverId: 's', channelId: 'c', duel: d, serverNow }, hand])),
    'duel UI: личный myHand и null доходят в общий action');
  assert.equal(f.replies[1][1], null, 'duel UI: явное снятие руки не становится отсутствующим полем');
  assert.equal(f.replies[2][1], undefined, 'duel UI: обычное событие не притворяется снятием руки');
});
paired('R334 вызов не перекрывает другую модалку, но без неё доступен и принимает партию', async (f, host, render) => {
  f.state.duelInvite = { duel: baseDuel(), skewMs: 0 };
  const blocker = document.createElement('div'); blocker.className = 'modal-overlay'; document.body.append(blocker);
  try {
    await render(React.createElement(f.module.DuelInvite, { onOpenScene: (...args: unknown[]) => f.opened.push(args) }));
    // Не передаём happy-dom Element в assertion: его диагностическая печать обходит большой
    // циклический граф DOM/React и может исчерпать память вместо полезного сообщения о guard.
    assert.equal(host.querySelector('.duel-invite') !== null, false, 'duel UI: другая модалка удерживает вызов в очереди');
    blocker.remove();
    await render(React.createElement(f.module.DuelInvite, { onOpenScene: (...args: unknown[]) => f.opened.push(args) }));
    assert.equal(host.querySelector('.duel-invite') !== null, true, 'duel UI: без другой модалки вызов виден');
    const accept = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Принять');
    assert.ok(accept, 'duel UI: есть действие принятия'); await click(accept);
    assert.deepEqual(f.opened, [['s', 'c']], 'duel UI: принятие открывает адресную сцену');
  } finally { blocker.remove(); }
});


it('пока вызов отправляется, параметры и режим нельзя изменить; после ошибки они доступны', async () => {
  await environment(async (host, render) => {
    const f = fixture(source, true);
    f.state.serverFeatures.push('duel-series1');
    f.fail(new Error('failed'));
    await render(React.createElement(f.module.DuelNewCard, { serverId: 's', targetId: 'peer', onClose: noop, onBack: noop,
      onOpenScene: noop, onPractice: noop }));
    const call = one<HTMLButtonElement>(host, '.game-actions-main');
    await React.act(async () => { call.click(); call.click(); });
    assert.equal(f.requests.length, 1);
    const controls = [...host.querySelectorAll<HTMLButtonElement>('.duel-mode button, .duel-rival, .duel-game, .wh-chip, .game-actions button')];
    assert.ok(controls.length > 5 && controls.every(b => b.disabled));
    assert.ok([...host.querySelectorAll<HTMLInputElement>('.duel-new input')].every(i => i.disabled));
    assert.equal(one<HTMLButtonElement>(host, '.wh-back').disabled, false);
    assert.equal(one<HTMLButtonElement>(host, '.icon-close').disabled, false);
    await React.act(async () => { f.release(); });
    assert.equal(call.disabled, false);
    assert.equal(one<HTMLButtonElement>(host, '.duel-rival').disabled, false);
    assert.equal(one<HTMLInputElement>(host, '.wh-amount-input').disabled, false);
  });
});
