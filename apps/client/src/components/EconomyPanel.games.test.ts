import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createContext, Script } from 'node:vm';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import * as economy from '../economy';
import type { EconomySettingsDto } from '../economy';

const source = readFileSync(new URL('./GamesSettingsPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const economySource = readFileSync(new URL('./EconomyPanel.tsx', import.meta.url), 'utf8');
const VM_TIMEOUT_MS = 500;
const BUDGET = 200;
type Props = Record<string, unknown> & { children?: React.ReactNode };
type Element = React.ReactElement<Props>;
class HarnessBudgetError extends Error {}
function elements(node: React.ReactNode): Element[] {
  let visits = 0;
  const visit = (value: React.ReactNode): Element[] => {
    if (++visits > BUDGET) throw new HarnessBudgetError('R363: обход JSX превысил 200 шагов');
    if (Array.isArray(value)) return value.flatMap(visit);
    if (!React.isValidElement<Props>(value)) return [];
    return [value, ...visit(value.props.children)];
  };
  return visit(node);
}
function text(node: React.ReactNode): string {
  let visits = 0;
  const visit = (value: React.ReactNode): string => {
    if (++visits > BUDGET) throw new HarnessBudgetError('R363: чтение JSX превысило 200 шагов');
    if (value == null || typeof value === 'boolean') return '';
    if (Array.isArray(value)) return value.map(visit).join('');
    if (React.isValidElement<Props>(value)) return visit(value.props.children);
    return String(value);
  };
  return visit(node);
}
function settings(patch: Partial<EconomySettingsDto> = {}): EconomySettingsDto {
  return { enabled: true, currencyName: 'Монеты', iconUrl: null,
    ratePer5min: 10, alonePercent: 25, companyPercent: 150, dailyCap: 800,
    decayAfterMinutes: 120, decayPercent: 50, mutedPercent: 50, deafenedPercent: 10,
    awayPercent: 25, payoutMinutes: 10, compensateOnRaise: false,
    tipAmount: 5, tipTaxPercent: 0, tipDailyOut: 100, tipDailyIn: 100, tipDailyPair: 100,
    seasonLength: 'quarter', gooseBonus: 5, gooseMinutes: 30, gooseDeafenedBonus: 1,
    streakBonus: 1, retroGrantedAt: null, gamesEnabled: true,
    gamesBetMax: 300, gamesDailyLossMax: 3000, gamesFeePercent: 10, ...patch };
}
const fields = [
  ['gamesBetMax', 'Максимальная ставка', 420],
  ['gamesDailyLossMax', 'Потолок проигрыша в сутки на человека', 1700],
  ['gamesFeePercent', 'Комиссия дуэлей и прогнозов', 17],
] as const;
const unused = () => { throw new Error('R326/подготовка/непредметный I/O'); };
function fixture(raw: string, initial: EconomySettingsDto) {
  let cursor = 0, refCursor = 0;
  // R363: settings, busy, error, saved, noEconomy, gamesLocked, gamesLaunch,
  // loadedGamesOn, savedGamesOn, launchGift; lossCapBefore — отдельный стабильный ref.
  const states: unknown[] = [initial, false, null, false, false, undefined, undefined,
    !!initial.gamesEnabled, !!initial.gamesEnabled, economy.LAUNCH_GIFT_SLIDER.default];
  const refs: { current: unknown }[] = [];
  const calls: Array<{ serverId: string; settings: EconomySettingsDto }> = [];
  const counters = new Map<string, number>();
  let exceeded: string | null = null;
  function step(kind: string) {
    const count = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, count);
    if (count > BUDGET) {
      exceeded = kind;
      throw new HarnessBudgetError(`R363: ${kind} превысил 200 вызовов`);
    }
  }
  const deps: Record<string, unknown> = {
    react: { ...React, useState(value: unknown) {
      step('useState');
      const index = cursor++;
      if (!(index in states)) states[index] = typeof value === 'function' ? (value as () => unknown)() : value;
      return [states[index], (next: unknown) => {
        step('setter');
        states[index] = typeof next === 'function' ? (next as (current: unknown) => unknown)(states[index]) : next;
      }];
    }, useEffect() { step('useEffect'); }, useRef(current: unknown) {
      step('useRef');
      // Настоящий React сохраняет ref между рендерами: новый объект скрывал бы потерю прежнего предела.
      const index = refCursor++; return refs[index] ??= { current };
    }, useCallback: (fn: unknown) => { step('useCallback'); return fn; } },
    'react/jsx-runtime': jsxRuntime, '../economy': economy,
    '../api': { api: new Proxy({ saveEconomy: async (serverId: string, next: EconomySettingsDto) => {
      step('saveEconomy');
      calls.push({ serverId, settings: JSON.parse(JSON.stringify(next)) });
    } }, { get(target, key) { return key in target ? target[key as keyof typeof target] : unused; } }) },
    '../confirm': { alertDialog: unused, confirmAction: unused }, './Toggle': { Toggle: () => null },
    './GameTitlesCard': { GameTitlesCard: () => null },
  };
  const context = createContext({
    window: { setTimeout: () => { step('timer'); return 1; }, clearTimeout() { step('timer'); } },
    require(id: string) {
      step('require');
      if (!Object.hasOwn(deps, id)) throw new Error(`R326/подготовка/импорт/${id}`);
      return deps[id];
    },
  });
  function load(body: string, filename: string): Record<string, unknown> {
    const module = { exports: {} as Record<string, unknown> };
    context.module = module; context.exports = module.exports;
    const compiled = ts.transpileModule(body, { fileName: filename, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } });
    new Script(`(function(module, exports, require) {\n${compiled.outputText}\n})(module, exports, require);`, { filename })
      .runInContext(context, { timeout: VM_TIMEOUT_MS });
    return module.exports;
  }
  // Оба модуля целиком: Slider взят из настоящего EconomyPanel, а не вырезан/переписан.
  deps['./EconomyPanel'] = load(economySource, 'EconomyPanel.tsx');
  const panel = load(raw, 'GamesSettingsPanel.tsx').GamesSettingsPanel;
  if (typeof panel !== 'function') throw new Error('R363/подготовка/GamesSettingsPanel');
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
      // Если production поймал ошибку бюджета, она всё равно не становится адресным kill.
      if (exceeded) throw new HarnessBudgetError(`R363: превышен бюджет ${exceeded}`);
    }
    return result;
  }
  return { calls, invoke, render() {
    step('render'); cursor = 0; refCursor = 0;
    return invoke(panel as (props: { serverId: string }) => React.ReactNode, { serverId: 'server-games' });
  } };
}
function sliders(tree: React.ReactNode): Element[] {
  return elements(tree).filter(node => fields.some(([, label]) => node.props.label === label));
}
function range(f: ReturnType<typeof fixture>, slider: Element): Element {
  assert.equal(typeof slider.type, 'function', 'R326/подготовка/настоящий Slider');
  const tree = f.invoke(slider.type as (props: Props) => React.ReactNode, slider.props);
  const input = elements(tree).find(node => node.type === 'input' && node.props.type === 'range');
  assert.equal(Boolean(input), true, 'R326/подготовка/range'); return input!;
}
function mutate(needle: string, next: string): string {
  assert.equal(source.split(needle).length, 2, `R326/подготовка/уникальный якорь/${needle}`);
  return source.replace(needle, next);
}
async function guarded(check: (raw: string) => void | Promise<void>, needle: string, next: string, address: string) {
  await check(source);
  await counterfact(async () => {
    await assert.rejects(async () => check(mutate(needle, next)), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.split('\n')[0] === address);
  });
  await check(source); // Независимая загрузка исходника после мутанта, без временной правки приложения.
}

describe('R326/R363 GamesSettingsPanel: перенесённые правила настоящего компонента', () => {
  it('без gamesEnabled есть подсказка об обновлении без ползунков, полный сервер показывает ровно три', async () => {
    await guarded(raw => {
      const old = settings(); delete old.gamesEnabled;
      const oldTree = fixture(raw, old).render();
      assert.equal(sliders(oldTree).length, 0, 'R326/panel/old-server');
      assert.equal(text(oldTree).includes('пока не знает игр'), true);
      assert.equal(sliders(fixture(raw, settings()).render()).length, 3);
    }, 'if (settings.gamesEnabled === undefined) {', 'if (false) {', 'R326/panel/old-server');
  });
  it('false не прячет раздел: три ползунка остаются видны', async () => {
    await guarded(raw => {
      const tree = fixture(raw, settings({ gamesEnabled: false })).render();
      assert.equal(sliders(tree).length, 3, 'R326/panel/off-visible');
      assert.equal(text(tree).includes('Игры выключены'), true);
      assert.equal(sliders(fixture(raw, settings({ gamesEnabled: true })).render()).length, 3);
      // Нулевое новое поле существует: truthy-проверка прятала бы его вместе со старым отсутствующим.
      const zeros = fixture(raw, settings({ gamesBetMax: 0, gamesDailyLossMax: 0, gamesFeePercent: 0 })).render();
      assert.equal(sliders(zeros).length, 3);
      for (const slider of sliders(zeros)) assert.equal(slider.props.value, 0);
    }, 'if (settings.gamesEnabled === undefined) {', 'if (!settings.gamesEnabled) {', 'R326/panel/off-visible');
  });
  for (const [field, label] of fields) it(`«${label}» заблокирован при false и доступен при true`, async () => {
    // Класс ошибки: отключение сервера блокирует не все три настоящих input либо блокирует включённые игры.
    const address = `R326/panel/disabled/${field}`;
    await guarded(raw => {
      for (const enabled of [false, true]) {
        const f = fixture(raw, settings({ gamesEnabled: enabled }));
        const tree = f.render();
        assert.equal(sliders(tree).length, 3);
        const slider = sliders(tree).find(node => node.props.label === label)!;
        assert.equal(range(f, slider).props.disabled, !enabled, address);
      }
    }, `value={settings.${field}}\n          disabled={!settings.gamesEnabled}`,
    `value={settings.${field}}\n          disabled={false}`, address);
  });
  for (const [field, label, value] of fields) it(`«${label}» меняет и отправляет только ${field}`, async () => {
    // Класс ошибки: копипаста onChange пишет соседнее поле либо теряет преобразование строки в число.
    const address = `R326/panel/patch/${field}`;
    await guarded(async raw => {
      const initial = settings();
      const f = fixture(raw, initial);
      const slider = sliders(f.render()).find(node => node.props.label === label)!;
      assert.equal(slider.props.value, initial[field]);
      f.invoke(range(f, slider).props.onChange as (event: { target: { value: string } }) => void, { target: { value: String(value) } });
      const nextTree = f.render();
      const save = elements(nextTree).find(node => node.type === 'button' && text(node) === 'Сохранить');
      assert.equal(Boolean(save), true, 'R326/подготовка/кнопка сохранения');
      f.invoke(save!.props.onClick as () => void);
      await Promise.resolve();
      assert.equal(JSON.stringify(f.calls), JSON.stringify([{ serverId: 'server-games', settings: { ...initial, [field]: value } }]), address);
      assert.equal(initial[field], settings()[field]);
    }, `onChange={(v) => patch({ ${field}: v })}`, `onChange={(v) => patch({ dailyCap: v })}`, address);
  });
  it('тумблер включает именно gamesEnabled, не меняя экономику и пределы', async () => {
    await guarded(raw => {
      const initial = settings({ gamesEnabled: false });
      const f = fixture(raw, initial);
      const gameToggle = elements(f.render()).find(node => node.props.labelledBy === 'games-state-title');
      assert.equal(Boolean(gameToggle), true, 'R326/подготовка/игровой тумблер');
      f.invoke(gameToggle!.props.onChange as (value: boolean) => void, true);
      const next = sliders(f.render());
      assert.equal(next.every(node => range(f, node).props.disabled === false), true, 'R326/panel/toggle-own-field');
      assert.equal(next.length, 3);
    }, 'patch({ gamesEnabled: v })', 'patch({ enabled: v })', 'R326/panel/toggle-own-field');
  });
});

function noCap(tree: React.ReactNode): Element | undefined {
  return elements(tree).find(node => node.props.labelledBy === 'eco-games-no-cap');
}
function capValue(tree: React.ReactNode): number {
  const slider = sliders(tree).find(node => node.props.label === fields[1][1]);
  assert.equal(Boolean(slider), true, 'R358/panel/setup/ползунок предела'); return slider!.props.value as number;
}
async function saveGames(f: ReturnType<typeof fixture>) {
  const save = elements(f.render()).find(node => node.type === 'button' && text(node) === 'Сохранить');
  assert.equal(Boolean(save), true, 'R358/panel/setup/сохранить'); f.invoke(save!.props.onClick as () => void);
  await Promise.resolve(); await Promise.resolve();
}

it('R358 Без потолка отправляет ноль и возвращает прежние 3000, в том числе после повторного включения', async () => {
  // Нельзя терять сохранённый предел на перерендере или восстанавливать ноль текущего ползунка.
  const address = 'R358/panel/cap-memory';
  const check = async (raw: string) => {
    const initial = settings(), f = fixture(raw, initial);
    for (let cycle = 0; cycle < 2; cycle++) {
      assert.equal(noCap(f.render())?.props.checked, false, address);
      f.invoke(noCap(f.render())!.props.onChange as (on: boolean) => void, true);
      assert.equal(capValue(f.render()), 0, address);
      assert.equal(noCap(f.render())?.props.checked, true, address);
      await saveGames(f);
      assert.deepEqual(f.calls.at(-1), { serverId: 'server-games', settings: { ...initial, gamesDailyLossMax: 0 } }, address);
      f.invoke(noCap(f.render())!.props.onChange as (on: boolean) => void, false);
      assert.equal(capValue(f.render()), 3000, address);
      await saveGames(f);
      assert.deepEqual(f.calls.at(-1), { serverId: 'server-games', settings: initial }, address);
    }
  };
  await guarded(check, 'if (v) lossCapBefore.current = settings.gamesDailyLossMax || lossCapBefore.current;', '', address);
  await guarded(check, 'gamesDailyLossMax: v ? 0 : lossCapBefore.current', 'gamesDailyLossMax: v ? 1000 : lossCapBefore.current', address);
});

it('R358 отсутствие прежнего потолка восстанавливает 1000 вместо нуля', async () => {
  // Сервер уже пришёл без потолка: переключатель должен позволить снова установить осмысленный предел.
  const address = 'R358/panel/cap-default';
  await guarded(async raw => {
    const initial = settings({ gamesDailyLossMax: 0 }), f = fixture(raw, initial);
    assert.equal(noCap(f.render())?.props.checked, true, address);
    f.invoke(noCap(f.render())!.props.onChange as (on: boolean) => void, false);
    assert.equal(capValue(f.render()), 1000, address);
    await saveGames(f);
    assert.deepEqual(f.calls, [{ serverId: 'server-games', settings: { ...initial, gamesDailyLossMax: 1000 } }], address);
  }, 'const lossCapBefore = useRef(1000);', 'const lossCapBefore = useRef(0);', address);
});

it('R358 ноль на ползунке включает Без потолка, положительная сумма выключает и сохраняется числом', async () => {
  // Ноль и переключатель — два представления одного поля, не два независимо сохраняемых режима.
  const address = 'R358/panel/cap-slider';
  await guarded(async raw => {
    const initial = settings(), f = fixture(raw, initial);
    for (const value of [0, 1700]) {
      const slider = sliders(f.render()).find(node => node.props.label === fields[1][1])!;
      f.invoke(range(f, slider).props.onChange as (e: { target: { value: string } }) => void, { target: { value: String(value) } });
      assert.equal(noCap(f.render())?.props.checked, value === 0, address);
      await saveGames(f);
      assert.deepEqual(f.calls.at(-1), { serverId: 'server-games', settings: { ...initial, gamesDailyLossMax: value } }, address);
    }
  }, 'checked={settings.gamesDailyLossMax === 0}', 'checked={false}', address);
});

it('R358 старый сервер без поля не получает Без потолка, выключенные игры блокируют переключатель', () => {
  // Новый переключатель соблюдает ту же совместимость и блокировку, что три игровых ползунка.
  const old = settings(); delete old.gamesDailyLossMax;
  assert.equal(Boolean(noCap(fixture(source, old).render())), false, 'R358/panel/cap-absent');
  for (const enabled of [false, true]) {
    const toggle = noCap(fixture(source, settings({ gamesEnabled: enabled })).render());
    assert.equal(Boolean(toggle), true, 'R358/panel/cap-present');
    assert.equal(toggle!.props.disabled, !enabled, 'R358/panel/cap-disabled');
  }
});
