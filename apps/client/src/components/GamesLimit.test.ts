import assert from 'node:assert/strict';
import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import { it } from 'node:test';
import * as economy from '../economy';
import type { EconomyView, GamesWallet } from '../economy';
import { React, environment, load, reactProps, sourceOf } from './R171.phoneHarness';

// R358: целые GamesLimit и Toggle, настоящие React/JSX/хуки и смонтированный DOM.
// Только API, store и непредметный Icon/asset заменены. Результат проверяется через
// действия пользователя, отправленные PATCH и новое состояние, не копию расчёта.
const source = sourceOf('GamesLimit');
type Edit = { from: string; to: string };
type Reply = { optedOut: boolean; tipsOptOut: boolean; games?: GamesWallet };
const normal = <T>(v: T): T => JSON.parse(JSON.stringify(v));
// R359: это авария harness, НЕ доказательство kill. В сообщение/actual никогда
// не кладём DOM: AssertionError иначе может инспектировать огромный граф
// happy-dom → React fiber → props даже для совершенно конечного рендера.
class LimitHarnessGuardError extends Error {
  constructor(operation: string) { super(`R359/limit/guard: превышен бюджет ${operation}`); }
}
function counter(operation: string, limit = 200) {
  let count = 0;
  return () => { if (++count > limit) throw new LimitHarnessGuardError(operation); };
}
function* bounded<T>(values: Iterable<T>): Generator<T> {
  const step = counter('итераций');
  for (const value of values) { step(); yield value; }
}
function games(patch: Partial<GamesWallet> = {}): GamesWallet {
  return { optOut: false, lossLimit: 1000, effectiveLimit: 600, lossToday: 120, lossLimitRaise: null, ...patch };
}
function view(patch: Partial<GamesWallet> = {}, serverMax = 3000): EconomyView {
  return { enabled: true, currencyName: 'Монеты', iconUrl: null, canManage: false, awayPercent: 25, settings: null,
    wallet: { balance: 900, earnedTotal: 100, seasonEarned: 50, optedOut: false, tipsOptOut: false, games: games(patch) },
    season: { id: 'autumn', name: 'Осень' }, level: { level: 1, title: 'Новичок', points: 100, nextAt: 200, progress: 0.5 },
    levelStages: [], crown: null, shop: [], gamesEnabled: true, gamesDailyLossMax: serverMax };
}
function fixture(raw: string) {
  const rendered = counter('рендеров');
  const stateWritten = counter('setState');
  // Настоящие hooks/setters остаются настоящими, включая functional updater;
  // единственная добавка — конечный бюджет на каждую свежую original/mutant VM.
  function useGuardedState<T>(initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
    const [value, setValue] = React.useState(initial);
    const guardedSetValue = React.useCallback((next: React.SetStateAction<T>) => { stateWritten(); setValue(next); }, [setValue]);
    return [value, guardedSetValue];
  }
  const calls: Array<{ serverId: string; patch: Record<string, unknown> }> = [];
  const changes: Array<{ serverId: string; view: EconomyView }> = [];
  let reply: Reply | Promise<Reply> = { optedOut: false, tipsOptOut: false };
  const state = { economy: { s: view() } as Record<string, EconomyView>, setEconomy(serverId: string, next: EconomyView) {
    changes.push({ serverId, view: next }); state.economy[serverId] = next;
  } };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  const toggle = load<Record<string, React.ComponentType<any>>>(new URL('./Toggle.tsx', import.meta.url), sourceOf('Toggle'), {});
  const component = load<{ GamesLimit: (props: { serverId: string }) => React.ReactNode }>(new URL('./GamesLimit.tsx', import.meta.url), raw, {
    react: { ...React, useState: useGuardedState },
    '../api': { api: { async setEconomyOptOut(serverId: string, patch: Record<string, unknown>) {
      calls.push({ serverId, patch: normal(patch) }); return reply;
    } } }, '../economy': economy, '../store': { useStore }, './Toggle': toggle,
    '../assets/guscoin.svg': { default: '/synthetic-coin.svg' },
    './Icon': { Icon: ({ name }: { name: string }) => React.createElement('i', { 'data-icon': name }) },
  });
  function GuardedGamesLimit(props: { serverId: string }) {
    rendered();
    // ЦЕЛАЯ экспортированная функция выполняется под настоящим React dispatcher.
    // Hooks принадлежат этой обёртке, поэтому считаются и её state-ререндеры,
    // а не только вызовы внешнего root.render.
    return component.GamesLimit(props);
  }
  return { state, calls, changes, reply(value: Reply | Promise<Reply>) { reply = value; },
    element: () => React.createElement(GuardedGamesLimit, { serverId: 's' }) };
}
type Fixture = ReturnType<typeof fixture>;
type Check = (f: Fixture, host: HTMLDivElement, render: (element: React.ReactNode) => Promise<void>) => Promise<void>;
async function run(raw: string, check: Check) {
  await environment(async (host, render) => { await check(fixture(raw), host, render); });
}
function paired(title: string, check: Check, edits: Edit[] = []) {
  it(title, async () => {
    await run(source, check);
    await counterfact(async () => { for (const edit of bounded(edits)) {
      assert.equal(source.split(edit.from).length, 2, 'R358/limit/setup: якорь единственный');
      await assert.rejects(run(source.replace(edit.from, edit.to), check),
        e => !(e instanceof LimitHarnessGuardError) && e instanceof assert.AssertionError && e.message.startsWith('R358/limit/behavior:'),
        'мутант падает на адресном поведении, не setup/import/DOM');
      await run(source, check);
    } });
  });
}
function one<T extends Element>(host: ParentNode, selector: string): T {
  const result = host.querySelectorAll<T>(selector);
  assert.equal(result.length, 1, `R358/limit/setup: один ${selector}`); return result[0];
}
async function click(node: HTMLButtonElement) {
  await React.act(async () => { node.click(); for (let i = 0; i < 6; i++) await Promise.resolve(); });
}
async function open(host: ParentNode) { await click(one<HTMLButtonElement>(host, '.act-limit-row')); }
const switchOf = (host: ParentNode) => one<HTMLButtonElement>(host, '[role="switch"]');
const chips = (host: ParentNode) => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const customInput = (host: ParentNode) => one<HTMLInputElement>(host, 'input[aria-label="Своя сумма предела"]');
const put = (host: ParentNode) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Поставить')!;
async function type(host: ParentNode, value: string) {
  await React.act(async () => { reactProps(customInput(host)).onChange({ target: { value } }); });
}
async function key(host: ParentNode, value: string) {
  await React.act(async () => {
    // Как и ввод выше, доставляем событие настоящему React-обработчику: happy-dom dispatchEvent здесь его не вызывает.
    reactProps(customInput(host)).onKeyDown({ key: value, preventDefault() {} });
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve };
}

paired('R358 сундук скрыт без снимка/новых полей, при выключенных играх и обоих самоотказах, но доступен обычному участнику', async (f, host, render) => {
  const absent = view(); delete absent.wallet.games;
  const serverOff = view(); serverOff.gamesEnabled = false;
  const optedOut = view(); optedOut.wallet.optedOut = true;
  const gamesOff = view({ optOut: true });
  for (const data of bounded([undefined, absent, serverOff, optedOut, gamesOff])) {
    if (data) f.state.economy.s = data; else delete f.state.economy.s;
    await render(f.element());
    assert.equal(host.querySelectorAll('.act-limit').length, 0, 'R358/limit/behavior: пять вариантов скрывают весь блок');
  }
  f.state.economy.s = view(); await render(f.element());
  assert.equal(host.querySelectorAll('.act-limit').length, 1, 'R358/limit/behavior: участник без settings видит сундук');
  assert.deepEqual(f.calls, [], 'R358/limit/behavior: просмотр не запрашивает PATCH');
}, [{ from: 'if (!view || !seen || view.wallet.optedOut || seen.games.optOut) return null;', to: 'if (!view || !seen) return null;' }]);

paired('R358 сводка и шкала берут effectiveLimit, а не личный либо серверный предел', async (f, host, render) => {
  await render(f.element());
  assert.equal(host.querySelector('.act-limit-sum')?.textContent, 'Сегодня можно проиграть ещё 480', 'R358/limit/behavior: 600 минус 120, не 1000 минус 120');
  await open(host);
  const meter = one<HTMLElement>(host, '[role="meter"]');
  assert.equal(meter.getAttribute('aria-valuemax'), '600', 'R358/limit/behavior: максимум шкалы эффективный');
  assert.equal(meter.getAttribute('aria-valuenow'), '120', 'R358/limit/behavior: сегодня потеряно 120');
  assert.equal(meter.querySelector('span')?.style.width, '20%', 'R358/limit/behavior: заполнение 120/600');
  assert.ok(host.textContent?.includes('Сегодня проиграно 120 из 600 — можно ещё 480.'), 'R358/limit/behavior: сводка и подробности согласованы');
}, [{ from: 'const limit = games.effectiveLimit;', to: 'const limit = games.lossLimit;' }]);

paired('R358 остаток не отрицателен: ровно предел и сверх него закрывают сундук, отрицательный проигрыш считается нулём', async (f, host, render) => {
  for (const lossToday of bounded([600, 601])) {
    f.state.economy.s = view({ lossToday }); await render(f.element());
    assert.equal(host.querySelector('.act-limit-sum')?.textContent, 'На сегодня сундук закрыт — предел исчерпан', 'R358/limit/behavior: предел и предел+1 закрыты');
  }
  f.state.economy.s = view({ effectiveLimit: 0, lossToday: 0 }); await render(f.element());
  assert.equal(host.querySelector('.act-limit-sum')?.textContent, 'На сегодня сундук закрыт — предел исчерпан', 'R358/limit/behavior: числовой ноль не unlimited');
  f.state.economy.s = view({ lossToday: -1 }); await render(f.element());
  assert.equal(host.querySelector('.act-limit-sum')?.textContent, 'Сегодня можно проиграть ещё 600', 'R358/limit/behavior: отрицательная потеря не увеличивает бюджет');
}, [{ from: 'Math.max(0, limit - lost)', to: 'limit - lost' }]);

paired('R358 null означает «без предела» и без шкалы, в отличие от числового нуля', async (f, host, render) => {
  f.state.economy.s = view({ effectiveLimit: null }); await render(f.element()); await open(host);
  assert.equal(host.querySelector('.act-limit-sum')?.textContent, 'Сегодня проигрыш без предела', 'R358/limit/behavior: null не превращён в ноль');
  assert.equal(host.querySelectorAll('[role="meter"]').length, 0, 'R358/limit/behavior: unlimited не рисует ложную шкалу');
  assert.ok(host.textContent?.includes('Сегодня проиграно 120 — предела нет.'), 'R358/limit/behavior: пояснение unlimited');
}, [{ from: 'const limit = games.effectiveLimit;', to: 'const limit = games.effectiveLimit ?? 0;' }]);

paired('R358 выключение своего предела отправляет ровно gamesLossLimit:null, не ноль и не другие настройки', async (f, host, render) => {
  await render(f.element()); await open(host);
  assert.equal(switchOf(host).getAttribute('aria-checked'), 'true', 'R358/limit/behavior: текущий личный предел включён');
  await click(switchOf(host));
  assert.deepEqual(f.calls, [{ serverId: 's', patch: { gamesLossLimit: null } }], 'R358/limit/behavior: ровно null');
}, [{ from: 'if (games.lossLimit !== null) void save(null);', to: 'if (games.lossLimit !== null) void save(0);' }]);

paired('R358 включение «Свой предел» лишь открывает выбор; отмена незавершённого выбора ничего не сохраняет', async (f, host, render) => {
  f.state.economy.s = view({ lossLimit: null }); await render(f.element()); await open(host);
  assert.equal(switchOf(host).getAttribute('aria-checked'), 'false', 'R358/limit/behavior: изначально своего предела нет');
  assert.equal(chips(host).length, 0, 'R358/limit/behavior: выключенный не показывает суммы');
  await click(switchOf(host));
  assert.equal(switchOf(host).getAttribute('aria-checked'), 'true', 'R358/limit/behavior: включение локально');
  assert.equal(chips(host).length, 3, 'R358/limit/behavior: появились варианты суммы');
  assert.equal(put(host).disabled, true, 'R358/limit/behavior: без введённой суммы сохранять нечего');
  assert.deepEqual(f.calls, [], 'R358/limit/behavior: само включение не отправляет число');
  await click(switchOf(host));
  assert.deepEqual(f.calls, [], 'R358/limit/behavior: отмена без прежнего личного предела не шлёт null');
});

paired('R358 пресеты не превышают потолок сервера, при нуле показаны все три; нажатие посылает число', async (f, host, render) => {
  f.state.economy.s = view({}, 600); await render(f.element()); await open(host);
  assert.deepEqual(chips(host).map(b => Number(b.textContent)), [100, 500], 'R358/limit/behavior: выше серверного 600 нет 1000, разрешённые 100/500 видны');
  for (const b of bounded(chips(host))) assert.ok(Number(b.textContent) <= 600, 'R358/limit/behavior: ни одного чипа выше сервера');
  await click(chips(host)[1]);
  assert.deepEqual(f.calls, [{ serverId: 's', patch: { gamesLossLimit: 500 } }], 'R358/limit/behavior: чип передаёт число, не строку');
  f.state.economy.s = view({}, 0); await render(f.element());
  assert.deepEqual(chips(host).map(b => Number(b.textContent)), [100, 500, 1000], 'R358/limit/behavior: серверный 0 не скрывает все пресеты');
}, [{ from: 'LIMIT_PRESETS.filter((v) => serverMax === 0 || v < serverMax)', to: 'LIMIT_PRESETS' }]);

paired('R358 своя сумма отклоняет пустоту, дробь, отрицательное и предел+1; принимает ноль и ровно верхний предел', async (f, host, render) => {
  await render(f.element()); await open(host);
  for (const value of bounded(['', ' ', '-1', '0.5', '1000001', 'NaN', 'Infinity'])) {
    await type(host, value);
    assert.equal(put(host).disabled, true, 'R358/limit/behavior: некорректная сумма не активирует кнопку');
    await key(host, 'Enter');
    assert.deepEqual(f.calls, [], 'R358/limit/behavior: Enter не обходит валидацию');
  }
  for (const value of bounded(['0', '1000000'])) {
    await type(host, value);
    assert.equal(put(host).disabled, false, 'R358/limit/behavior: обе включённые границы проходят');
    await click(put(host));
  }
  assert.deepEqual(f.calls.map(c => c.patch), [{ gamesLossLimit: 0 }, { gamesLossLimit: 1000000 }], 'R358/limit/behavior: допустимые границы сохранены числами');
}, [{ from: 'Number.isInteger(customValue)', to: 'Number.isFinite(customValue)' }]);

paired('R358 Enter равен «Поставить», другая клавиша не сохраняет; custom принимает сумму ровно серверного потолка', async (f, host, render) => {
  f.state.economy.s = view({}, 500); await render(f.element()); await open(host);
  await type(host, '500'); await key(host, 'Escape');
  assert.deepEqual(normal(f.calls), [], 'R358/limit/behavior: посторонняя клавиша не сохраняет');
  await key(host, 'Enter'); await type(host, '500'); await click(put(host));
  assert.deepEqual(f.calls.map(c => c.patch), [{ gamesLossLimit: 500 }, { gamesLossLimit: 500 }], 'R358/limit/behavior: Enter и кнопка сохраняют одну числовую сумму');
  assert.equal(customInput(host).value, '', 'R358/limit/behavior: поле очищено после сохранения');
}, [{ from: "if (e.key === 'Enter' && customOk)", to: "if (e.key === 'NumpadEnter' && customOk)" }]);

paired('R358 без серверного повышения нет статуса; число обещает ровно назначенный предел и отмечает будущий чип', async (f, host, render) => {
  await render(f.element()); await open(host);
  assert.equal(host.querySelectorAll('[role="status"]').length, 0, 'R358/limit/behavior: нет выдуманного повышения');
  f.state.economy.s = view({ lossLimit: 100, lossLimitRaise: { value: 500, from: '2026-10-29T21:00:00Z' } }); await render(f.element());
  assert.equal(host.querySelector('[role="status"]')?.textContent, 'Предел вырастет до 500 с 00:00 МСК', 'R358/limit/behavior: показано серверное число');
  assert.deepEqual(chips(host).filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.textContent), ['500'], 'R358/limit/behavior: отложенная сумма уже выбрана, не текущая 100');
}, [{ from: '{raise && (', to: '{false && (' }]);

paired('R358 отложенное null означает снятие предела, а не повышение до null или нуля', async (f, host, render) => {
  f.state.economy.s = view({ lossLimitRaise: { value: null, from: '2026-10-29T21:00:00Z' } });
  await render(f.element()); await open(host);
  assert.equal(host.querySelector('[role="status"]')?.textContent, 'Свой предел снимется с 00:00 МСК', 'R358/limit/behavior: null снимает свой предел с полуночи');
}, [{ from: "raise.value === null ? 'Свой предел снимется с 00:00 МСК'", to: "false ? 'Свой предел снимется с 00:00 МСК'" }]);

paired('R358 старый ответ без games не стирает store, новый games меняет только игровой кошелёк актуального снимка', async (f, host, render) => {
  await render(f.element()); await open(host);
  const original = normal(f.state.economy.s);
  await click(chips(host)[0]);
  assert.deepEqual(normal(f.changes), [], 'R358/limit/behavior: ответ без games не записывает undefined');
  assert.deepEqual(f.state.economy.s, original, 'R358/limit/behavior: старый ответ не портит games и баланс');
  const d = deferred<Reply>(); f.reply(d.promise); await click(chips(host)[1]);
  const current = { ...f.state.economy.s, currencyName: 'Жетоны', wallet: { ...f.state.economy.s.wallet, balance: 777 } };
  f.state.economy.s = current;
  const nextGames = games({ lossLimit: 500, effectiveLimit: 500, lossToday: 123 });
  await React.act(async () => { d.resolve({ optedOut: false, tipsOptOut: false, games: nextGames }); for (let i = 0; i < 6; i++) await Promise.resolve(); });
  assert.equal(f.changes.length, 1, 'R358/limit/behavior: новый games применён один раз');
  assert.equal(f.changes[0].serverId, 's', 'R358/limit/behavior: запись в правильный сервер');
  assert.deepEqual(normal(f.state.economy.s), normal({ ...current, wallet: { ...current.wallet, games: nextGames } }), 'R358/limit/behavior: ответ не откатывает полученные тем временем валюту и баланс');
}, [{ from: 'if (result.games) setEconomy', to: 'setEconomy' }]);

paired('R358 незавершённый PATCH блокирует переключатель, чипы, ввод и кнопку; после ответа всё доступно', async (f, host, render) => {
  await render(f.element()); await open(host); await type(host, '750');
  const d = deferred<Reply>(); f.reply(d.promise); await click(put(host));
  assert.equal(switchOf(host).disabled, true, 'R358/limit/behavior: busy блокирует свой предел');
  assert.ok(chips(host).every(b => b.disabled), 'R358/limit/behavior: busy блокирует все чипы');
  assert.equal(customInput(host).disabled, true, 'R358/limit/behavior: busy блокирует ввод');
  assert.equal(put(host).disabled, true, 'R358/limit/behavior: busy блокирует отправку');
  await React.act(async () => { d.resolve({ optedOut: false, tipsOptOut: false }); for (let i = 0; i < 6; i++) await Promise.resolve(); });
  assert.equal(switchOf(host).disabled, false, 'R358/limit/behavior: после ответа переключатель доступен');
  assert.ok(chips(host).every(b => !b.disabled), 'R358/limit/behavior: после ответа чипы доступны');
  assert.equal(customInput(host).disabled, false, 'R358/limit/behavior: после ответа ввод доступен');
}, [{ from: 'disabled={busy}\n              labelledBy=', to: 'disabled={false}\n              labelledBy=' }]);
