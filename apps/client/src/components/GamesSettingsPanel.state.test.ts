import assert from 'node:assert/strict';
import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { createContext, Script } from 'node:vm';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import * as economy from '../economy';
import type { EconomySettingsDto, EconomyView } from '../economy';

const source = readFileSync(new URL('./GamesSettingsPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const economySource = readFileSync(new URL('./EconomyPanel.tsx', import.meta.url), 'utf8');
const BUDGET = 200;
const VM_TIMEOUT_MS = 500;
const SERVER = 'server-games-state';
type Props = Record<string, unknown> & { children?: React.ReactNode };
type Element = React.ReactElement<Props>;
class HarnessBudgetError extends Error {}

function elements(tree: React.ReactNode): Element[] {
  let visits = 0;
  const visit = (value: React.ReactNode): Element[] => {
    if (++visits > BUDGET) throw new HarnessBudgetError('R363: обход JSX превысил 200 шагов');
    if (Array.isArray(value)) return value.flatMap(visit);
    if (!React.isValidElement<Props>(value)) return [];
    return [value, ...visit(value.props.children)];
  };
  return visit(tree);
}

function text(tree: React.ReactNode): string {
  let visits = 0;
  const visit = (value: React.ReactNode): string => {
    if (++visits > BUDGET) throw new HarnessBudgetError('R363: чтение JSX превысило 200 шагов');
    if (value == null || typeof value === 'boolean') return '';
    if (Array.isArray(value)) return value.map(visit).join('');
    if (React.isValidElement<Props>(value)) return visit(value.props.children);
    return String(value);
  };
  return visit(tree);
}

function settings(gamesEnabled = false): EconomySettingsDto {
  return {
    enabled: true, currencyName: 'Монеты', iconUrl: null, ratePer5min: 10,
    alonePercent: 25, companyPercent: 150, dailyCap: 800, decayAfterMinutes: 120,
    decayPercent: 50, mutedPercent: 50, deafenedPercent: 10, awayPercent: 25,
    payoutMinutes: 10, compensateOnRaise: false, tipAmount: 5, tipTaxPercent: 0,
    tipDailyOut: 100, tipDailyIn: 100, tipDailyPair: 100, seasonLength: 'quarter',
    gooseBonus: 5, gooseMinutes: 30, gooseDeafenedBonus: 1, streakBonus: 1,
    retroGrantedAt: null, gamesEnabled, gamesBetMax: 300,
    gamesDailyLossMax: 3000, gamesFeePercent: 10,
  };
}

interface Options {
  settings?: EconomySettingsDto | null;
  locked?: boolean;
  gamesLaunch?: EconomyView['gamesLaunch'];
  deferSave?: boolean;
  deferLaunch?: boolean;
}

async function fixture(raw: string, options: Options = {}) {
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const effects: Array<() => unknown> = [];
  const counters = new Map<string, number>();
  let exceeded: string | null = null;
  let stateCursor = 0, refCursor = 0, mounted = false;
  let finishSave: (() => void) | undefined;
  let finishLaunch: (() => void) | undefined;
  const saves: Array<{ serverId: string; settings: EconomySettingsDto }> = [];
  const launches: Array<[string, number]> = [];
  const alerts: Array<[string, string]> = [];
  function step(kind: string) {
    const count = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, count);
    if (count > BUDGET) {
      exceeded = kind;
      throw new HarnessBudgetError(`R363: ${kind} превысил 200 вызовов`);
    }
  }
  function checkBudget() {
    if (exceeded) throw new HarnessBudgetError(`R363: превышен бюджет ${exceeded}`);
  }
  const api = {
    async getEconomy(serverId: string) {
      step('getEconomy');
      if (serverId !== SERVER) throw new Error('R363/подготовка/неверный сервер getEconomy');
      return {
        settings: options.settings === undefined ? settings() : options.settings,
        gamesLocked: options.locked,
        gamesLaunch: Object.hasOwn(options, 'gamesLaunch') ? options.gamesLaunch : null,
      };
    },
    async saveEconomy(serverId: string, next: EconomySettingsDto) {
      step('saveEconomy');
      saves.push({ serverId, settings: JSON.parse(JSON.stringify(next)) });
      if (options.deferSave) await new Promise<void>((resolve) => { finishSave = resolve; });
    },
    async launchGames(serverId: string, gift: number) {
      step('launchGames');
      launches.push([serverId, gift]);
      if (options.deferLaunch) await new Promise<void>((resolve) => { finishLaunch = resolve; });
      return { at: '2026-10-30T09:00:00.000Z', gift, people: gift > 0 ? 3 : 0 };
    },
  };
  const deps: Record<string, unknown> = {
    react: {
      ...React,
      useState(initial: unknown) {
        step('useState');
        const index = stateCursor++;
        if (!(index in states)) states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
        return [states[index], (next: unknown) => {
          step('setter');
          states[index] = typeof next === 'function' ? (next as (current: unknown) => unknown)(states[index]) : next;
        }];
      },
      useRef(current: unknown) {
        step('useRef');
        return refs[refCursor++] ??= { current };
      },
      useEffect(effect: () => unknown) {
        step('useEffect');
        if (!mounted) effects.push(effect);
      },
      useCallback: (fn: unknown) => { step('useCallback'); return fn; },
    },
    'react/jsx-runtime': jsxRuntime,
    '../economy': economy,
    '../api': { api: new Proxy(api, { get(target, key) {
      if (!(key in target)) throw new Error(`R363/подготовка/непредметный api.${String(key)}`);
      return target[key as keyof typeof target];
    } }) },
    '../confirm': {
      async confirmAction() { step('confirmAction'); return true; },
      async alertDialog(title: string, body: string) { step('alertDialog'); alerts.push([title, body]); },
    },
    './Toggle': { Toggle: () => null },
    './GameTitlesCard': { GameTitlesCard: () => null },
  };
  const context = createContext({
    window: { setTimeout: () => { step('timer'); return 1; }, clearTimeout() { step('timer'); } },
    require(id: string) {
      step('require');
      if (!Object.hasOwn(deps, id)) throw new Error(`R363/подготовка/неподменённый импорт ${id}`);
      return deps[id];
    },
  });
  function load(body: string, filename: string): Record<string, unknown> {
    const module = { exports: {} as Record<string, unknown> };
    context.module = module; context.exports = module.exports;
    const compiled = ts.transpileModule(body, { fileName: filename, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } });
    // Полные модули, обычная CommonJS-обёртка: ни Slider, ни обработчики не вырезаются из исходника.
    new Script(`(function(module, exports, require) {\n${compiled.outputText}\n})(module, exports, require);`, { filename })
      .runInContext(context, { timeout: VM_TIMEOUT_MS });
    checkBudget();
    return module.exports;
  }
  deps['./EconomyPanel'] = load(economySource, 'EconomyPanel.tsx');
  const panel = load(raw, 'GamesSettingsPanel.tsx').GamesSettingsPanel;
  if (typeof panel !== 'function') throw new Error('R363/подготовка/нет GamesSettingsPanel');
  const invokeScript = new Script('__result = __callback(...__args)');
  function invoke<T>(callback: (...args: never[]) => T, ...args: unknown[]): T {
    step('invoke');
    context.__callback = callback; context.__args = args;
    let result: T;
    try {
      invokeScript.runInContext(context, { timeout: VM_TIMEOUT_MS });
      result = context.__result as T;
    } finally {
      delete context.__callback; delete context.__args; delete context.__result;
      checkBudget();
    }
    return result;
  }
  function render(): React.ReactNode {
    step('render'); stateCursor = 0; refCursor = 0;
    return invoke(panel as (props: { serverId: string }) => React.ReactNode, { serverId: SERVER });
  }
  async function settle() {
    for (let tick = 0; tick < 8; tick++) { step('microtask'); await Promise.resolve(); }
    checkBudget();
  }
  const initialTree = render();
  mounted = true;
  for (const effect of effects) { step('effect'); invoke(effect); }
  await settle();
  return {
    render, invoke, settle, initialTree, saves, launches, alerts,
    completeSave() {
      step('resolveSave');
      if (!finishSave) throw new Error('R363/подготовка/save не ожидал ответа');
      finishSave();
    },
    completeLaunch() {
      step('resolveLaunch');
      if (!finishLaunch) throw new Error('R363/подготовка/launch не ожидал ответа');
      finishLaunch();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function title(tree: React.ReactNode): string {
  return text(elements(tree).find((node) => node.props.className === 'games-state-title'));
}
function button(tree: React.ReactNode, label: string): Element | undefined {
  return elements(tree).find((node) => node.type === 'button' && text(node) === label);
}
function toggle(f: Fixture, value: boolean) {
  const node = elements(f.render()).find((element) => element.props.labelledBy === 'games-state-title');
  if (!node) throw new Error('R363/подготовка/нет игрового Toggle');
  f.invoke(node.props.onChange as (value: boolean) => void, value);
}
function click(f: Fixture, label: string) {
  const node = button(f.render(), label);
  if (!node) throw new Error(`R363/подготовка/нет кнопки ${label}`);
  f.invoke(node.props.onClick as () => void);
}
function mutate(needle: string, next: string): string {
  assert.equal(source.split(needle).length - 1, 1, `R363/подготовка/единственный якорь ${needle}`);
  return source.replace(needle, next);
}
async function guarded(check: (raw: string) => Promise<void>, needle: string, next: string, address: string) {
  await check(source);
  await counterfact(() => assert.rejects(() => check(mutate(needle, next)), (error: unknown) =>
    error instanceof assert.AssertionError && error.message.split('\n')[0] === address));
  await check(source);
}

it('R363 несохранённое включение и выключение не меняют сохранённый заголовок и показывают подсказку', async () => {
  const address = 'R363/state/saved-title-not-draft';
  await guarded(async (raw) => {
    for (const enabled of [false, true]) {
      const f = await fixture(raw, { settings: settings(enabled), locked: false });
      const savedTitle = enabled ? 'Игры включены' : 'Игры выключены';
      assert.equal(title(f.render()), savedTitle, address);
      toggle(f, !enabled);
      const draftTree = f.render();
      assert.equal(title(draftTree), savedTitle, address);
      assert.equal(text(draftTree).includes(enabled ? 'Игры выключатся' : 'Игры включатся'), true);
      assert.equal(text(draftTree).includes('когда вы нажмёте «Сохранить»'), true);
      assert.equal(f.saves.length, 0);
      toggle(f, enabled);
      assert.equal(text(f.render()).includes('когда вы нажмёте «Сохранить»'), false);
    }
  }, "{savedGamesOn ? 'Игры включены' : 'Игры выключены'}",
  "{settings.gamesEnabled ? 'Игры включены' : 'Игры выключены'}", address);
});

it('R363 saveEconomy меняет заголовок лишь после ответа и сохраняет весь черновик в обоих направлениях', async () => {
  const address = 'R363/state/save-updates-title';
  await guarded(async (raw) => {
    for (const enabled of [false, true]) {
      const initial = settings(enabled);
      const f = await fixture(raw, { settings: initial, locked: false, deferSave: true });
      toggle(f, !enabled);
      click(f, 'Сохранить');
      await f.settle();
      assert.equal(title(f.render()), enabled ? 'Игры включены' : 'Игры выключены');
      assert.equal(JSON.stringify(f.saves), JSON.stringify([{ serverId: SERVER, settings: { ...initial, gamesEnabled: !enabled } }]));
      f.completeSave();
      await f.settle();
      const savedTree = f.render();
      assert.equal(title(savedTree), enabled ? 'Игры выключены' : 'Игры включены', address);
      assert.equal(text(savedTree).includes('когда вы нажмёте «Сохранить»'), false);
      assert.equal(text(savedTree).includes('Сохранено'), true);
    }
  }, '      setSavedGamesOn(!!settings.gamesEnabled);', '', address);
});

it('R363 launchGames включает сохранённое состояние после ответа и убирает одноразовую кнопку', async () => {
  const address = 'R363/state/launch-updates-title';
  await guarded(async (raw) => {
    const f = await fixture(raw, { settings: settings(false), locked: false, deferLaunch: true });
    assert.equal(title(f.render()), 'Игры выключены');
    click(f, 'Запустить игры');
    await f.settle();
    assert.equal(title(f.render()), 'Игры выключены');
    assert.equal(JSON.stringify(f.launches), JSON.stringify([[SERVER, economy.LAUNCH_GIFT_SLIDER.default]]));
    f.completeLaunch();
    await f.settle();
    const launchedTree = f.render();
    assert.equal(title(launchedTree), 'Игры включены', address);
    assert.equal(Boolean(button(launchedTree, 'Запустить игры')), false);
    assert.equal(text(launchedTree).includes('когда вы нажмёте «Сохранить»'), false);
    assert.equal(text(launchedTree).includes('Запущены'), true);
    assert.equal(text(launchedTree).includes('подарок за запуск — 500 монет'), true);
    assert.equal(f.alerts.length, 1);
    const checked = elements(launchedTree).find((node) => node.props.labelledBy === 'games-state-title')?.props.checked;
    assert.equal(checked, true);
  }, '      setSavedGamesOn(true);', '', address);
});

it('R363 ответ settings:null заменяет загрузку подсказкой открыть Монеты, обычные настройки остаются панелью', async () => {
  const address = 'R363/state/no-economy-is-not-loading';
  await guarded(async (raw) => {
    const empty = await fixture(raw, { settings: null });
    assert.equal(text(empty.initialTree).includes('Загрузка…'), true);
    const emptyText = text(empty.render());
    assert.equal(emptyText.includes('Сначала откройте раздел «Монеты»'), true, address);
    assert.equal(emptyText.includes('Загрузка…'), false, address);
    const ready = await fixture(raw, { settings: settings(false) });
    assert.equal(title(ready.render()), 'Игры выключены');
    assert.equal(text(ready.render()).includes('Сначала откройте раздел «Монеты»'), false);
  }, '          setNoEconomy(true);', '', address);
});

it('R363 он ниже обещается только вместе с видимой кнопкой запуска, замок и старый сервер её не обещают', async () => {
  const address = 'R363/state/no-invisible-launch-promise';
  await guarded(async (raw) => {
    const cases: Array<{ locked?: boolean; gamesLaunch: EconomyView['gamesLaunch']; visible: boolean }> = [
      { locked: false, gamesLaunch: null, visible: true },
      { locked: true, gamesLaunch: null, visible: false },
      { gamesLaunch: null, visible: false },
      { locked: false, gamesLaunch: undefined, visible: false },
      { locked: false, gamesLaunch: { at: '2026-10-30T09:00:00.000Z', gift: 0, mine: 0 }, visible: false },
    ];
    for (const entry of cases) {
      const f = await fixture(raw, { settings: settings(false), locked: entry.locked, gamesLaunch: entry.gamesLaunch });
      const tree = f.render();
      assert.equal(text(tree).includes('он ниже'), entry.visible, address);
      assert.equal(Boolean(button(tree, 'Запустить игры')), entry.visible);
    }
  }, "      ? launchButtonVisible({ gamesLaunch, gamesLocked })\n        ? 'Торжественного запуска ещё не было — он ниже.'\n        : 'Торжественного запуска ещё не было.'",
  "      ? 'Торжественного запуска ещё не было — он ниже.'", address);
});
