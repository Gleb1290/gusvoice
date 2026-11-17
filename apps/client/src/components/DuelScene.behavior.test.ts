import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as shared from '@gusvoice/shared';
import * as rules from '../duelRules';
import * as economy from '../economy';
import * as wheel from '../wheelRules';
import { React, environment, load, sourceOf } from './R171.phoneHarness';

const source = sourceOf('DuelScene'), duelSource = sourceOf('Duel');
const noop = () => {};
const now = Date.parse('2026-10-28T12:00:00Z');
const duel = (game: shared.DuelGame = 'rps'): shared.DuelDto => ({ id: 'd', serverId: 's', channelId: 'c', game,
  challengerId: 'me', targetId: 'peer', amount: 10, feePercent: 10, state: 'playing', inviteUntil: null, commit: 'a'.repeat(64),
  rollNo: 0, turnUntil: null, rolls: [], winnerId: null, payout: null, seed: null, reason: null, settledAt: null,
  moveUntil: new Date(now + 20_000).toISOString(),
  rps: { seq: 4, wins: { challenger: 0, target: 0 }, rounds: [], ready: { challenger: false, target: false } },
  greedy: { seq: 11, first: 'challenger', turn: 'challenger', scores: { challenger: 0, target: 0 }, turnPoints: 0,
    rolls: [], lastRoll: null, burned: 0, timeouts: { challenger: 0, target: 0 } },
});
function fixture(raw: string) {
  const sounds: string[] = [], requests: unknown[][] = [], replies: unknown[][] = [], ensures: unknown[][] = [];
  const state = { user: { id: 'me', displayName: 'Я' }, members: [], presence: { c: [{ userId: 'me', displayName: 'Я' }, { userId: 'peer', displayName: 'Соперник' }] },
    voice: { channelId: 'c' }, economy: { s: { iconUrl: null } }, duels: { c: { duel: duel(), skewMs: 0 } as rules.DuelView }, selfDeafened: false,
    applyDuelEvent: (...args: unknown[]) => replies.push(args) };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  let failure: Error | null = null, timerNo = 0, elapsed = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const fakeWindow = { addEventListener: noop, removeEventListener: noop,
    setTimeout(cb: () => void, ms = 0) { const id = ++timerNo; timers.set(id, { at: elapsed + ms, cb }); return id; },
    clearTimeout(id: number) { timers.delete(id); } };
  const deps = {
    '@gusvoice/shared': shared, '../api': { api: {
      duelAction: async (...args: unknown[]) => { requests.push(args); return { duel: state.duels.c.duel, serverNow: new Date(now).toISOString() }; },
      duelMove: async (...args: unknown[]) => { requests.push(args); if (failure) throw failure;
        return { duel: state.duels.c.duel, serverNow: new Date(now).toISOString(), myHand: 'rock' }; },
    } }, '../assets/guscoin.svg': { default: '/synthetic.svg' }, '../duelRules': rules, '../economy': economy,
    '../phoneLayout': { usePhoneLayout: () => false }, '../store': { useStore }, '../wheelRules': wheel,
    './Avatar': { Avatar: () => React.createElement('span') }, './Icon': { Icon: () => React.createElement('i') },
    './BottomSheet': { BottomSheet: ({ children }: { children: React.ReactNode }) => children },
  };
  const duelModule = load<typeof import('./Duel')>(new URL('./Duel.tsx', import.meta.url), duelSource, deps, { window: fakeWindow });
  const module = load<typeof import('./DuelScene')>(new URL('./DuelScene.tsx', import.meta.url), raw, { ...deps,
    '../benchMock': { isMockEconomy: () => false }, '../assets/duel/judge.png': { default: '/synthetic-judge.png' },
    '../assets/duel/duelist.png': { default: '/synthetic-duelist.png' },
    '../assets/duel/duelist-sash.png': { default: '/synthetic-sash.png' },
    '../economyClient': { ensureDuel: (...args: unknown[]) => ensures.push(args) }, '../sounds': { playSound: (name: string) => sounds.push(name) },
    './Duel': { ...duelModule, useNowTick: () => now },
  }, { window: fakeWindow, Date: class extends Date { static now() { return now + elapsed; } } });
  return { state, sounds, requests, replies, ensures, timers, fail: (e: Error) => { failure = e; },
    element: () => React.createElement(module.default, { serverId: 's', channelId: 'c', onClose: noop, onBack: noop }),
    async advance(ms: number) {
      const end = elapsed + ms;
      await React.act(async () => {
        for (;;) {
          const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
          if (!next) break;
          elapsed = next[1].at; timers.delete(next[0]); next[1].cb();
        }
        elapsed = end;
      });
    } };
}
type Fixture = ReturnType<typeof fixture>;
type Check = (f: Fixture, host: HTMLDivElement, render: (n: React.ReactNode) => Promise<void>) => Promise<void>;
async function run(raw: string, check: Check) { await environment(async (host, render) => { await check(fixture(raw), host, render); }); }
function paired(title: string, check: Check) {
  it(title, async () => { await run(source, check); });
}

const button = (host: ParentNode, selector: string) => {
  const found = host.querySelectorAll<HTMLButtonElement>(selector);
  assert.equal(found.length, 1, `duel scene: единственный ${selector}`); return found[0];
};
async function click(b: HTMLButtonElement) { await React.act(async () => { b.click(); for (let i = 0; i < 6; i++) await Promise.resolve(); }); }
for (const game of ['rps', 'greedy'] as const) paired(`R337 ${game} передаёт seq именно своего состояния и личный ответ в стор`, async (f, host, render) => {
  f.state.duels.c = { duel: duel(game), skewMs: 0 };
  await render(f.element());
  await click(button(host, game === 'rps' ? '.rps-pick:first-of-type' : '.gr-actions .dc-roll'));
  assert.deepEqual(f.requests, [['s', 'd', game === 'rps' ? 4 : 11, game === 'rps' ? 'rock' : 'roll']], 'duel scene: номер хода взят из выбранной игры');
  assert.equal(f.replies[0]?.[1], 'rock', 'duel scene: личный ответ не теряет myHand');
});
paired('R337 stale_seq объясняется и принудительно перечитывает снимок своего канала', async (f, host, render) => {
  f.fail(Object.assign(new Error('generic'), { reason: 'stale_seq' }));
  await render(f.element()); f.ensures.length = 0;
  await click(button(host, '.rps-pick:first-of-type'));
  assert.equal(host.querySelector('.wh-err')?.textContent?.trim(), 'Ход уже засчитан — партия обновилась', 'duel scene: reason stale_seq показан человеку');
  assert.deepEqual(f.ensures, [['s', 'c', true]], 'duel scene: после устаревшего хода снимок принудительно обновлён');
});
paired('R337 Стоп выключен при нуле, ровно одно очко позволяет забрать копилку', async (f, host, render) => {
  f.state.duels.c = { duel: duel('greedy'), skewMs: 0 };
  await render(f.element());
  assert.equal(button(host, '.gr-actions .ew-btn:not(.dc-roll)').disabled, true, 'duel scene: пустую копилку нельзя остановить');
  f.state.duels.c = { duel: { ...duel('greedy'), greedy: { ...duel('greedy').greedy!, turnPoints: 1 } }, skewMs: 0 };
  await render(f.element());
  assert.equal(button(host, '.gr-actions .ew-btn:not(.dc-roll)').disabled, false, 'duel scene: одно очко уже можно забрать');
  await click(button(host, '.gr-actions .ew-btn:not(.dc-roll)'));
  assert.deepEqual(f.requests, [['s', 'd', 11, 'stop']], 'duel scene: Стоп доходит как move, не roll');
});
paired('R341 этап7 КНБ молчит при открытии старого раунда и звучит rpsReveal на новом раскрытии один раз', async (f, host, render) => {
  const d = duel();
  d.rps!.rounds = [{ challenger: 'rock', target: 'scissors', winner: 'challenger' }];
  f.state.duels.c = { duel: d, skewMs: 0 };
  await render(f.element());
  assert.deepEqual(f.sounds, [], 'duel scene: ранее раскрытая рука открывается молча');
  const next = { ...d, rps: { ...d.rps!, seq: 5, rounds: [...d.rps!.rounds, { challenger: 'paper', target: 'rock', winner: 'challenger' } as const] } };
  f.state.duels.c = { duel: next, skewMs: 0 }; await render(f.element());
  assert.deepEqual(f.sounds, ['rpsReveal'], 'duel scene: новое раскрытие озвучено отдельным событием');
  assert.equal(host.querySelectorAll('.rps-hand.reveal').length, 2, 'duel scene: обе руки раскрыты разом');
  f.state.duels.c = { duel: { ...next }, skewMs: 0 }; await render(f.element());
  assert.deepEqual(f.sounds, ['rpsReveal'], 'duel scene: повтор push без нового раунда молчит');
});
paired('R341 этап7 деафен заглушает свежее раскрытие КНБ', async (f, _host, render) => {
  await render(f.element()); f.state.selfDeafened = true;
  const d = duel(); d.rps!.rounds = [{ challenger: 'rock', target: 'paper', winner: 'target' }];
  f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  assert.deepEqual(f.sounds, [], 'duel scene: деафен сильнее нового раскрытия');
});
const rolled = (old: shared.DuelDto, die: number): shared.DuelDto => ({ ...old, greedy: { ...old.greedy!,
  rolls: [...old.greedy!.rolls, die], lastRoll: { die, by: 'challenger' }, burned: die === 1 ? 8 : 0 } });
paired('R341 этап7 единица озвучивается greedyBurn ровно после докатывания, обычная кость не горит', async (f, host, render) => {
  let d = rolled(duel('greedy'), 1); f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  assert.deepEqual(f.sounds, [], 'duel scene: единица до открытия сцены не озвучивается заново');
  assert.equal(f.timers.size, 0, 'duel scene: старому броску не назначен отложенный burn');
  d = rolled(d, 3); f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element()); await f.advance(shared.DUEL_ROLL_ANIM_MS);
  assert.deepEqual(f.sounds, ['diceRoll'], 'duel scene: тройка стучит, но копилка не горит');
  d = rolled(d, 1); f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  assert.deepEqual(f.sounds, ['diceRoll', 'diceRoll'], 'duel scene: в начале единицы звучит только кубик');
  assert.equal(host.querySelector('.gr-burn'), null, 'duel scene: надпись ждёт конца броска');
  await f.advance(shared.DUEL_ROLL_ANIM_MS - 1);
  assert.deepEqual(f.sounds, ['diceRoll', 'diceRoll'], 'duel scene: за миллисекунду до конца ещё нет сгорания');
  await f.advance(1);
  assert.deepEqual(f.sounds, ['diceRoll', 'diceRoll', 'greedyBurn'], 'duel scene: сгорание совпало с концом анимации');
  assert.equal(host.querySelector('.gr-burn')?.textContent?.includes('Сгорело 8!'), true, 'duel scene: сгорание видно после остановки');
});
paired('R341 этап7 отложенный burn проверяет текущий деафен, а не его значение при броске', async (f, _host, render) => {
  let d = duel('greedy'); f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  d = rolled(d, 1); f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  f.state.selfDeafened = true; await f.advance(shared.DUEL_ROLL_ANIM_MS);
  assert.deepEqual(f.sounds, ['diceRoll'], 'duel scene: включённый за время полёта деафен глушит burn');
  d = rolled(d, 1); f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  f.state.selfDeafened = false; await f.advance(shared.DUEL_ROLL_ANIM_MS);
  assert.deepEqual(f.sounds, ['diceRoll', 'greedyBurn'], 'duel scene: снятый к завершению деафен разрешает burn');
});
paired('R341 этап7 useFresh отменяет таймер раскрытия КНБ при уходе со сцены', async (f, _host, render) => {
  await render(f.element()); const d = duel();
  d.rps!.rounds = [{ challenger: 'paper', target: 'scissors', winner: 'target' }];
  f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  assert.equal(f.timers.size, 1, 'duel scene: свежему раскрытию назначен один таймер');
  const other = { ...d, id: 'next-duel' };
  f.state.duels.c = { duel: other, skewMs: 0 }; await render(f.element());
  assert.equal(f.timers.size, 0, 'duel scene: другая партия отменяет раскрытие прежней');
  f.state.duels.c = { duel: { ...other, rps: { ...other.rps!, rounds: [...other.rps!.rounds, ...other.rps!.rounds] } }, skewMs: 0 };
  await render(f.element());
  assert.equal(f.timers.size, 1, 'duel scene: свежий раунд новой партии получил свой таймер');
  await render(null);
  assert.equal(f.timers.size, 0, 'duel scene: размонтирование очистило useFresh таймер');
});
paired('R342 единица не озвучивает сгорание после закрытия сцены за миллисекунду до конца броска', async (f, _host, render) => {
  let d = duel('greedy'); f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  d = rolled(d, 1); f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  assert.deepEqual(f.sounds, ['diceRoll'], 'duel scene: свежая единица запустила только звук броска');
  await f.advance(shared.DUEL_ROLL_ANIM_MS - 1);
  assert.deepEqual(f.sounds, ['diceRoll'], 'duel scene: за миллисекунду до завершения сгорание ещё молчит');
  await render(null);
  await f.advance(1);
  assert.deepEqual(f.sounds, ['diceRoll'], 'duel scene: размонтированная сцена отменила отложенный звук сгорания');
});

paired('кубики разделяют сумму броска и победы, явно объясняют цель партии', async (f, host, render) => {
  const d = { ...duel('dice'), diceTarget: 2 as const, rolls: [{ challenger: null, target: null }] };
  f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  assert.match(host.querySelector('.dice-phase')!.textContent!, /Партия до 2 побед/);
  assert.deepEqual([...host.querySelectorAll('.dice-victories b')].map(e => e.textContent), ['0/2', '0/2']);
  assert.equal(button(host, '.dc-roll').disabled, false);
  await click(button(host, '.dc-roll'));
  assert.deepEqual(f.requests, [['s', 'd', 'roll', 0]]);
});
paired('победитель броска появляется после остановки костей и остаётся при следующем ходе', async (f, host, render) => {
  const d = { ...duel('dice'), diceTarget: 2 as const, rolls: [{ challenger: null, target: null }] };
  f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  const next: shared.DuelDto = { ...d, rollNo: 1, rolls: [{ challenger: [6, 5], target: [2, 3] }, { challenger: null, target: null }] };
  f.state.duels.c = { duel: next, skewMs: 0 }; await render(f.element());
  assert.match(host.querySelector('.dice-round-result')!.textContent!, /кубики катятся/);
  assert.equal(host.querySelectorAll('.dice-player .rolling').length, 4, 'одновременное раскрытие действительно крутит обе новые пары');
  assert.equal(button(host, '.dc-roll').disabled, true);
  assert.deepEqual([...host.querySelectorAll('.dice-victories b')].map(e => e.textContent), ['0/2', '0/2']);
  await f.advance(1500);
  assert.match(host.querySelector('.dice-round-result')!.textContent!, /Бросок 1 · ты победил.*11 > 5.*\+1 победа/);
  assert.deepEqual([...host.querySelectorAll('.dice-victories b')].map(e => e.textContent), ['1/2', '0/2']);
  await f.advance(2000);
  assert.equal(button(host, '.dc-roll').disabled, false);
  assert.match(host.querySelector('.dice-phase')!.textContent!, /Бросок 2/);
  assert.match(host.querySelector('.dice-round-result')!.textContent!, /Бросок 1 · ты победил/);
  assert.deepEqual([...host.querySelectorAll('.dc-dice')].map(e => e.getAttribute('aria-label')), ['Кубики ещё не брошены', 'Кубики ещё не брошены']);
});
paired('новый бросок соперника во время показа итога не смешивается с прежними костями', async (f, host, render) => {
  const d = { ...duel('dice'), diceTarget: 2 as const, rolls: [{ challenger: null, target: null }] };
  f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  const next: shared.DuelDto = { ...d, rollNo: 1, rolls: [{ challenger: [6, 5], target: [2, 3] }, { challenger: null, target: null }] };
  f.state.duels.c = { duel: next, skewMs: 0 }; await render(f.element()); await f.advance(1500);
  f.state.duels.c = { duel: { ...next, rolls: [next.rolls[0], { challenger: null, target: [1, 1] }] }, skewMs: 0 };
  await render(f.element());
  assert.deepEqual([...host.querySelectorAll('.dc-dice')].map(e => e.getAttribute('aria-label')), ['Кубики: 6 и 5', 'Кубики: 2 и 3']);
  assert.deepEqual([...host.querySelectorAll('.dc-sum')].map(e => e.textContent), ['Сумма: 11', 'Сумма: 5']);
  await render(null); assert.equal(f.timers.size, 0);
});
paired('ничья не даёт победу, зритель не бросает, старая партия сохраняет цель в одну победу', async (f, host, render) => {
  const d: shared.DuelDto = { ...duel('dice'), challengerId: 'other', rolls: [{ challenger: [2, 5], target: [3, 4] }], rollNo: 1 };
  f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  assert.match(host.querySelector('.dice-phase')!.textContent!, /до 1 победы/);
  assert.match(host.querySelector('.dice-round-result')!.textContent!, /ничья.*7 = 7.*без очка/);
  assert.equal(button(host, '.dc-roll').disabled, true);
  assert.deepEqual([...host.querySelectorAll('.dice-victories b')].map(e => e.textContent), ['0/1', '0/1']);
});

for (const first of ['challenger', 'target'] as const) paired(`второй бросок не крутит заново уже остановившиеся кубики ${first}`, async (f, host, render) => {
  const second = first === 'challenger' ? 'target' : 'challenger';
  const d: shared.DuelDto = { ...duel('dice'), diceTarget: 2, rolls: [{ challenger: null, target: null }] };
  f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  const partial: shared.DuelDto = { ...d, rolls: [{ ...d.rolls[0], [first]: [6, 5] }] };
  f.state.duels.c = { duel: partial, skewMs: 0 }; await render(f.element());
  const cards = () => host.querySelectorAll<HTMLElement>('.dice-player');
  const firstCard = () => cards()[first === 'challenger' ? 0 : 1];
  const secondCard = () => cards()[second === 'challenger' ? 0 : 1];
  assert.equal(firstCard().querySelectorAll('.rolling').length, 2);
  await f.advance(shared.DUEL_ROLL_ANIM_MS);
  const cubes = [...firstCard().querySelectorAll('.dc-tumble')];
  assert.equal(firstCard().querySelectorAll('.rolling').length, 0);
  assert.equal(firstCard().querySelector('.dc-sum')!.textContent, 'Сумма: 11');
  const both: shared.DuelDto = { ...partial, rollNo: 1, rolls: [{ ...partial.rolls[0], [second]: [2, 3] }, { challenger: null, target: null }] };
  f.state.duels.c = { duel: both, skewMs: 0 }; await render(f.element());
  assert.equal(firstCard().querySelectorAll('.rolling').length, 0);
  assert.ok([...firstCard().querySelectorAll('.dc-tumble')].every((cube, i) => cube === cubes[i]), 'уже показанные кубики не перемонтируются');
  assert.equal(firstCard().querySelector('.dc-sum')!.textContent, 'Сумма: 11');
  assert.equal(secondCard().querySelectorAll('.rolling').length, 2);
  await f.advance(shared.DUEL_ROLL_ANIM_MS);
  assert.equal(host.querySelectorAll('.dice-player .rolling').length, 0);
  assert.match(host.querySelector('.dice-round-result')!.textContent!, first === 'challenger' ? /11 > 5.*\+1 победа/ : /5 < 11.*\+1 победа/);
});

paired('второй игрок не перезапускает ещё идущую анимацию первого', async (f, host, render) => {
  const d: shared.DuelDto = { ...duel('dice'), diceTarget: 2, rolls: [{ challenger: null, target: null }] };
  f.state.duels.c = { duel: d, skewMs: 0 }; await render(f.element());
  const partial: shared.DuelDto = { ...d, rolls: [{ challenger: [6, 5], target: null }] };
  f.state.duels.c = { duel: partial, skewMs: 0 }; await render(f.element());
  const first = host.querySelector('.dice-player')!;
  const cubes = [...first.querySelectorAll('.dc-tumble')];
  await f.advance(500);
  f.state.duels.c = { duel: { ...partial, rollNo: 1, rolls: [{ challenger: [6, 5], target: [2, 3] }, { challenger: null, target: null }] }, skewMs: 0 };
  await render(f.element());
  assert.ok([...first.querySelectorAll('.dc-tumble')].every((cube, i) => cube === cubes[i]), 'узлы первой анимации сохранены');
  await f.advance(1000);
  assert.equal(first.querySelectorAll('.rolling').length, 0, 'первый закончил через свои 1500 мс');
  assert.equal(host.querySelectorAll('.dice-player')[1].querySelectorAll('.rolling').length, 2, 'второй ещё докатывает');
  await f.advance(500);
  assert.equal(host.querySelectorAll('.dice-player .rolling').length, 0);
});
