import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as shared from '@gusvoice/shared';
import * as practice from '../duelPractice';
import * as rules from '../duelRules';
import * as economy from '../economy';
import * as wheel from '../wheelRules';
import { React, environment, load, sourceOf } from './R171.phoneHarness';

const sceneSource = sourceOf('DuelScene');
const cardSource = sourceOf('Duel');
const origin = Date.parse('2026-10-29T12:00:00Z');
const noop = () => {};
function fixture(phone = false) {
  let clock = origin, timerNo = 0, closed = 0, backed = 0;
  const apiCalls: unknown[][] = [], ensures: unknown[][] = [], selections: shared.DuelGame[] = [], sounds: string[] = [];
  let hidden = false;
  const documentListeners = new Set<() => void>();
  const fakeDocument = { get hidden() { return hidden; },
    addEventListener: (_name: string, cb: () => void) => documentListeners.add(cb),
    removeEventListener: (_name: string, cb: () => void) => documentListeners.delete(cb),
  };
  const timers = new Map<number, { at: number; cb: () => void }>();
  const listeners = new Map<string, Set<() => void>>();
  const random: practice.PracticeRng = { unit: () => 0, die: () => 1 };
  class ClockDate extends Date { static override now() { return clock; } }
  const fakeWindow = {
    setTimeout(cb: () => void, ms = 0) { const id = ++timerNo; timers.set(id, { at: clock + ms, cb }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    addEventListener(name: string, cb: () => void) {
      const set = listeners.get(name) ?? new Set(); set.add(cb); listeners.set(name, set);
    },
    removeEventListener(name: string, cb: () => void) { listeners.get(name)?.delete(cb); },
  };
  type Person = { userId: string; displayName: string; bot?: boolean };
  const state = {
    user: { id: 'me', displayName: 'Я' }, members: [],
    presence: { c: [{ userId: 'me', displayName: 'Я' }, { userId: 'bot', displayName: 'Автомат', bot: true }] as Person[] },
    voice: { channelId: 'c', serverId: 's' },
    economy: { s: { gamesEnabled: true, iconUrl: null, wallet: { balance: 100, games: { effectiveLimit: 100, lossToday: 0 } } } },
    duels: {} as Record<string, rules.DuelView>, duelLimits: { s: { betMax: 50, feePercent: 10 } }, wheel: {},
    serverFeatures: [] as string[], selfDeafened: false, applyDuelEvent: noop,
  };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  const api = new Proxy({}, { get: (_t, name) => async (...args: unknown[]) => {
    apiCalls.push([String(name), ...args]); return {};
  } });
  const deps = {
    '@gusvoice/shared': shared, '../api': { api }, '../assets/guscoin.svg': { default: '/synthetic-coin.svg' },
    '../duelRules': rules, '../economy': economy, '../wheelRules': wheel, '../store': { useStore },
    '../phoneLayout': { usePhoneLayout: () => phone },
    './Avatar': { Avatar: ({ name }: { name: string }) => React.createElement('span', { 'data-avatar': name }) },
    './Icon': { Icon: () => React.createElement('i') },
    './BottomSheet': { BottomSheet: ({ children, title }: { children: React.ReactNode; title: string }) => React.createElement('section', { 'data-sheet-title': title }, children) },
    '../assets/duel/duelist.png': { default: '/synthetic-duelist.png' },
    '../assets/duel/duelist-sash.png': { default: '/synthetic-sash.png' },
  };
  const globals = { window: fakeWindow, document: fakeDocument, Date: ClockDate };
  const card = load<typeof import('./Duel')>(new URL('./Duel.tsx', import.meta.url), cardSource, deps, globals);
  const localPractice: typeof practice = { ...practice,
    practiceStart: (game, id, at) => practice.practiceStart(game, id, at, random),
    practiceMove: (s, move, at) => practice.practiceMove(s, move, at, random),
    practiceTick: (s, at) => practice.practiceTick(s, at, random),
  };
  const scene = load<typeof import('./DuelScene')>(new URL('./DuelScene.tsx', import.meta.url), sceneSource, { ...deps,
    '../duelPractice': localPractice, '../benchMock': { isMockEconomy: () => false },
    '../assets/duel/judge.png': { default: '/synthetic-judge.png' },
    '../economyClient': { ensureDuel: (...args: unknown[]) => ensures.push(args) }, '../sounds': { playSound: (name: string) => sounds.push(name) },
    './Duel': { ...card, useNowTick: () => clock },
  }, globals);
  const onClose = () => { closed++; };
  return {
    state, apiCalls, ensures, selections, sounds, timers, listeners, documentListeners, closed: () => closed, backed: () => backed,
    scene: (game: shared.DuelGame = 'rps') => React.createElement(scene.default, { serverId: 's', channelId: 'c', practice: game, onClose, onBack: () => { backed++; } }),
    card: (withPractice = true) => React.createElement(card.DuelNewCard, { serverId: 's', targetId: 'peer', onClose, onBack: noop,
      onOpenScene: noop, ...(withPractice ? { onPractice: (game: shared.DuelGame) => selections.push(game) } : {}) }),
    async visibility(value: boolean) { hidden = value; await React.act(async () => { for (const cb of documentListeners) cb(); }); },
    async focus() { await React.act(async () => { for (const cb of listeners.get('focus') ?? []) cb(); }); },
    async advance(ms: number) {
      const end = clock + ms;
      let guard = 0;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        assert.ok(++guard < 1_000, 'R354/training/таймеры завершаются');
        clock = next[1].at; timers.delete(next[0]);
        // Эффекты должны увидеть новое состояние ДО поиска следующего срока в этой же перемотке.
        await React.act(async () => { next[1].cb(); for (let i = 0; i < 6; i++) await Promise.resolve(); });
      }
      clock = end;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
type Check = (f: Fixture, host: HTMLDivElement, render: (n: React.ReactNode) => Promise<void>) => Promise<void>;
async function run(check: Check, phone = false) {
  await environment(async (host, render) => { await check(fixture(phone), host, render); });
}
function one<T extends Element>(host: ParentNode, selector: string): T {
  const all = host.querySelectorAll<T>(selector);
  assert.equal(all.length, 1, `R354/training/единственный ${selector}`); return all[0];
}
async function click(el: HTMLButtonElement) {
  await React.act(async () => { el.click(); for (let i = 0; i < 6; i++) await Promise.resolve(); });
}
const action = (host: ParentNode, label: string) => {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(el => {
    const text = el.textContent?.trim() ?? '';
    return text === label || (el.matches('.rps-pick') && text.endsWith(label));
  });
  assert.equal(found.length, 1, `R354/training/кнопка ${label}`); return found[0];
};

it('R354 настоящая сцена тренировки КНБ делает локальный ход, не запрашивает API или снимок даже после фокуса', async () => run(async (f, host, render) => {
  await render(f.scene());
  assert.equal(host.querySelector('#dc-title')?.textContent?.includes('Тренировка с капитаном'), true, 'R354/training/заголовок');
  assert.deepEqual(f.ensures, [], 'R354/training/без снимка');
  await f.focus();
  assert.deepEqual(f.ensures, [], 'R354/training/без снимка');
  await click(action(host, 'Бумага'));
  assert.equal(host.querySelector('.rps-hand.picked')?.textContent, rules.RPS_HAND_INFO.paper.emoji, 'R354/training/локальная рука');
  assert.deepEqual(f.apiCalls, [], 'R354/training/без API');
  assert.equal(/Ставка\s+\d+.*банк/i.test(host.textContent ?? ''), false, 'R354/training/без банка');
}));

async function settleWin(f: Fixture, host: HTMLDivElement) {
  await click(action(host, 'Бумага'));
  await f.advance(4_000);
  await click(action(host, 'Бумага'));
  await f.advance(2_500);
  assert.equal(host.querySelector('.duel-practice-result')?.textContent?.trim(), 'Тренировка: ты выиграл');
}

it('вход в тренировку 21 ждёт нажатия, первый бросок показывает пару, добор — один кубик', async () => run(async (f, host, render) => {
  await render(f.scene('twentyone'));
  const own = () => one<HTMLElement>(host, '.twentyone-player.me');
  const total = () => own().querySelector('.twentyone-score-number')!.textContent;
  assert.equal(total(), '0');
  assert.equal(own().querySelectorAll('.dc-die.unknown').length, 2);
  assert.equal(action(host, 'Стоп').disabled, true);
  await f.advance(1000);
  assert.equal(total(), '0');
  assert.equal(own().querySelectorAll('.rolling').length, 0);
  await click(action(host, 'Бросить 2 кубика'));
  assert.equal(own().querySelectorAll('.rolling').length, 2);
  assert.equal(total(), '0');
  await f.advance(3000);
  assert.equal(total(), '2');
  assert.equal(own().querySelectorAll('.twentyone-die-slot:not(.empty)').length, 2);
  await click(action(host, 'Ещё кубик'));
  assert.equal(own().querySelectorAll('.rolling').length, 1);
  assert.equal(own().querySelectorAll('.twentyone-die-slot:not(.empty)').length, 1);
  assert.equal(total(), '2');
  await f.advance(3000);
  assert.equal(total(), '3');
  assert.deepEqual(f.apiCalls, []);
  assert.deepEqual(f.ensures, []);
}));
const round = (host: ParentNode) => one<HTMLElement>(host, '.duel-round-label').textContent?.trim();
const next = (host: ParentNode) => one<HTMLElement>(host, '.duel-next-round').textContent?.trim();
const score = (host: ParentNode) => [...one<HTMLElement>(host, '.duel-session-score').children].map(el => el.textContent?.trim());

it('КНБ показывает исход раунда и запрещает следующий выбор до конца раскрытия', async () => {
  await run(async (f, host, render) => {
    await render(f.scene());
    const phase = () => one<HTMLElement>(host, '.rps-phase').textContent?.trim();
    assert.equal(phase(), 'Раунд 1Выбери руку. Один выбор на раунд.');
    assert.equal(host.querySelectorAll('.rps-pick').length, 3);
    await click(action(host, 'Бумага'));
    assert.equal(phase(), 'Раунд 1Ход принят. Ждём соперника — руки откроются одновременно.');
    assert.equal(host.querySelectorAll('.rps-pick').length, 3);
    assert.ok([...host.querySelectorAll<HTMLButtonElement>('.rps-pick')].every(button => button.disabled));
    await f.advance(practice.PRACTICE_RPS_THINK_MS[0] + 20);
    assert.equal(phase(), 'Раунд 1 завершёнТы выиграл раунд. Счёт партии 1:0.');
    assert.equal(host.querySelectorAll('.rps-pick').length, 3);
    assert.ok([...host.querySelectorAll<HTMLButtonElement>('.rps-pick')].every(button => button.disabled));
    await f.advance(practice.PRACTICE_RPS_REVEAL_MS - 1);
    assert.equal(host.querySelectorAll('.rps-pick').length, 3);
    assert.ok([...host.querySelectorAll<HTMLButtonElement>('.rps-pick')].every(button => button.disabled));
    await f.advance(1);
    assert.equal(phase(), 'Раунд 2Выбери руку. Один выбор на раунд.');
    assert.equal(host.querySelectorAll('.rps-pick').length, 3);
    assert.deepEqual(f.apiCalls, []);
  });
});

it('после сыгранной партии отсчёт запускает следующий раунд один раз и без сети', async () => {
  await run(async (f, host, render) => {
    await render(f.scene());
    assert.equal(round(host), 'Партия 1');
    assert.deepEqual(score(host), ['Ты 0', 'Ничьи: 0', '0 Капитан']);
    assert.ok(action(host, 'К выбору игр'));
    await settleWin(f, host);
    assert.equal(round(host), 'Партия 1 завершена');
    assert.equal(next(host), 'Следующий раунд через 4 с');
    assert.deepEqual(score(host), ['Ты 1', 'Ничьи: 0', '0 Капитан']);
    assert.equal(f.sounds.filter(s => s === 'duelWin').length, 1);
    await f.advance(3_000);
    assert.equal(round(host), 'Партия 1 завершена');
    assert.equal(next(host), 'Следующий раунд через 1 с');
    await f.advance(1_000);
    assert.equal(round(host), 'Партия 2');
    assert.deepEqual(score(host), ['Ты 1', 'Ничьи: 0', '0 Капитан']);
    assert.equal(host.querySelector('.duel-practice-result'), null);
    assert.equal(host.querySelector('.rps-score')?.textContent?.trim(), '0 : 0');
    assert.equal(f.sounds.filter(s => s === 'duelWin').length, 1);
    assert.deepEqual(f.apiCalls, []);
    assert.deepEqual(f.ensures, []);
    await settleWin(f, host);
    assert.deepEqual(score(host), ['Ты 2', 'Ничьи: 0', '0 Капитан']);
    await click(action(host, 'Пауза'));
    await f.advance(20_000);
    assert.deepEqual(score(host), ['Ты 2', 'Ничьи: 0', '0 Капитан']);
  });
});

it('пауза сохраняет оставшийся отсчёт, продолжение доводит его до следующего раунда', async () => {
  await run(async (f, host, render) => {
    await render(f.scene()); await settleWin(f, host);
    await f.advance(2_000);
    assert.equal(next(host), 'Следующий раунд через 2 с');
    await click(action(host, 'Пауза'));
    assert.equal(next(host), 'Пауза между раундами.');
    await f.advance(20_000);
    assert.equal(round(host), 'Партия 1 завершена');
    await click(action(host, 'Продолжить'));
    assert.equal(next(host), 'Следующий раунд через 2 с');
    await f.advance(1_999);
    assert.equal(round(host), 'Партия 1 завершена');
    await f.advance(1);
    assert.equal(round(host), 'Партия 2');
  });
});

it('скрытая вкладка останавливает отсчёт и возобновляет его с оставшегося значения', async () => {
  await run(async (f, host, render) => {
    await render(f.scene()); await settleWin(f, host);
    await f.advance(1_000);
    await f.visibility(true);
    await f.advance(20_000);
    assert.equal(round(host), 'Партия 1 завершена');
    assert.equal(next(host), 'Следующий раунд через 3 с');
    await f.visibility(false);
    await f.advance(2_999);
    assert.equal(round(host), 'Партия 1 завершена');
    await f.advance(1);
    assert.equal(round(host), 'Партия 2');
  });
});

it('пустой раунд не перезапускается сам, но следующий можно начать вручную', async () => {
  await run(async (f, host, render) => {
    await render(f.scene());
    await f.advance(shared.DUEL_MOVE_MS + 100);
    assert.equal(round(host), 'Партия 1 завершена');
    assert.deepEqual(score(host), ['Ты 0', 'Ничьи: 0', '1 Капитан']);
    assert.equal(next(host), 'Ты не ходил — продолжим, когда будешь готов.');
    await f.advance(60_000);
    assert.equal(round(host), 'Партия 1 завершена');
    assert.deepEqual(score(host), ['Ты 0', 'Ничьи: 0', '1 Капитан']);
    await click(action(host, 'Следующий раунд'));
    assert.equal(round(host), 'Партия 2');
    assert.deepEqual(score(host), ['Ты 0', 'Ничьи: 0', '1 Капитан']);
    assert.deepEqual(f.apiCalls, []);
  });
});

it('ничья добавляется в счёт серии один раз и сохраняется в следующем раунде', async () => {
  await run(async (f, host, render) => {
    await render(f.scene());
    for (let n = 0; n < 7; n++) {
      await click(action(host, 'Камень'));
      await f.advance(n === 6 ? 2_500 : 4_000);
    }
    assert.equal(host.querySelector('.duel-practice-result')?.textContent?.trim(), 'Тренировка: ничья');
    assert.deepEqual(score(host), ['Ты 0', 'Ничьи: 1', '0 Капитан']);
    await click(action(host, 'Пауза'));
    await f.advance(20_000);
    assert.deepEqual(score(host), ['Ты 0', 'Ничьи: 1', '0 Капитан']);
    await click(action(host, 'Следующий раунд'));
    assert.equal(round(host), 'Партия 2');
    assert.deepEqual(score(host), ['Ты 0', 'Ничьи: 1', '0 Капитан']);
    assert.deepEqual(f.apiCalls, []);
  });
});

it('ручной переход отменяет ожидание, размонтирование снимает таймеры и обработчик видимости', async () => {
  await run(async (f, host, render) => {
    await render(f.scene()); await settleWin(f, host);
    await f.advance(1_000);
    await click(action(host, 'Следующий раунд'));
    assert.equal(round(host), 'Партия 2');
    await f.advance(3_100);
    assert.equal(round(host), 'Партия 2');
    await render(null);
    assert.equal(f.timers.size, 0);
    assert.equal(f.documentListeners.size, 0);
    const soundCount = f.sounds.length;
    await f.advance(60_000);
    assert.equal(f.sounds.length, soundCount);
    assert.deepEqual(f.apiCalls, []);
  });
});
it('R358 выбор игр вызывает onBack, крестик закрывает тренировку, размонтирование отменяет таймеры', async () => run(async (f, host, render) => {
  await render(f.scene());
  assert.ok(f.timers.size > 0, 'R354/training/назначен срок');
  // При молчании капитан выигрывает в срок; выход к форме не должен закрывать весь хост активностей.
  await f.advance(shared.DUEL_MOVE_MS + 100);
  await click(action(host, 'К выбору игр'));
  assert.equal(f.backed(), 1, 'R354/training/выход к выбору игр');
  assert.equal(f.closed(), 0, 'R354/training/выбор игр не закрывает');
  await click(one<HTMLButtonElement>(host, '.icon-close'));
  assert.equal(f.closed(), 1, 'R354/training/закрытие');
  await render(null);
  assert.equal(f.timers.size, 0, 'R354/training/таймеры сняты');
  await f.advance(60_000);
  assert.deepEqual(f.apiCalls, [], 'R354/training/после ухода без API');
}));
it('R354 один в голосе может выбрать любую из трёх тренировок без ставки и поддержки duel2 сервером', async () => run(async (f, host, render) => {
  await render(f.card());
  const place = one<HTMLButtonElement>(host, '.wh-place');
  assert.equal(place.textContent?.trim(), 'Тренировка с капитаном', 'R354/training/solo-кнопка');
  assert.equal(host.querySelector('.wh-amount') === null, true, 'R354/training/solo-без ставки');
  const games = [...host.querySelectorAll<HTMLButtonElement>('.duel-game')];
  assert.deepEqual(games.map(g => g.disabled), [false, false, false], 'R354/training/solo-все игры');
  for (let n = 0; n < shared.DUEL_GAMES.length; n++) {
    await click(games[n]); await click(one<HTMLButtonElement>(host, '.wh-place'));
  }
  assert.deepEqual(f.selections, [...shared.DUEL_GAMES], 'R354/training/solo-выбранная игра');
  assert.deepEqual(f.apiCalls, [], 'R354/training/solo-без API');
}));
it('R354 без callback тренировки одиночная форма сохраняет обычную отключённую кнопку вызова', async () => run(async (f, host, render) => {
  await render(f.card(false));
  assert.equal(host.querySelectorAll('.wh-amount').length, 1, 'R354/training/no-callback-обычная ставка');
  const button = one<HTMLButtonElement>(host, '.wh-place');
  assert.equal(button.textContent?.trim(), 'Выбери соперника', 'R354/training/no-callback-не мёртвая тренировка');
  assert.equal(button.disabled, true, 'R354/training/no-callback-нет адресата');
  assert.equal(host.querySelectorAll('.game-actions .game-actions-back').length, 0, 'R354/training/no-callback-нет мёртвой тренировки');
}));
it('R358 с соперником тренировка — вторичная кнопка общего ряда, отдающая выбранную игру без запроса', async () => run(async (f, host, render) => {
  f.state.presence.c.push({ userId: 'peer', displayName: 'Соперник' });
  f.state.serverFeatures = [shared.FEATURE_DUEL2, shared.FEATURE_DUEL21];
  await render(f.card());
  assert.equal(host.querySelectorAll('.wh-amount').length, 1, 'R354/training/rival-есть ставка');
  assert.equal(host.querySelectorAll('.wh-place').length, 1, 'R354/training/rival-один вызов');
  const games = [...host.querySelectorAll<HTMLButtonElement>('.duel-game')];
  await click(games[2]);
  const training = one<HTMLButtonElement>(host, '.game-actions .game-actions-back');
  assert.equal(training.textContent?.trim(), 'Тренировка', 'R354/training/rival-вторичная тренировка');
  assert.equal(training.classList.contains('ew-btn-main'), false, 'R354/training/rival-только вызов главный');
  assert.equal(host.querySelector('.duel-practice-link'), null, 'R354/training/rival-не старая ссылка');
  await click(training);
  assert.deepEqual(f.selections, ['twentyone'], 'R354/training/rival-кнопка берёт игру');
  await click(one<HTMLButtonElement>(host, '.duel-mode button:last-child'));
  assert.equal(host.querySelector('.wh-amount'), null, 'режим тренировки убирает ставку');
  await click(one<HTMLButtonElement>(host, '.wh-place'));
  assert.deepEqual(f.selections, ['twentyone', 'twentyone'], 'режим тренировки сохраняет выбор игры');
  await click(action(host, 'С людьми'));
  assert.equal(host.querySelectorAll('.wh-amount').length, 1, 'возврат к игре с людьми показывает ставку');
  assert.deepEqual(f.apiCalls, [], 'R354/training/rival-кнопка без API');
}));
