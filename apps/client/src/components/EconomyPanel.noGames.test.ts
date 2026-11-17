import assert from 'node:assert/strict';
import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import * as economy from '../economy';
import type { EconomySettingsDto } from '../economy';

const source = readFileSync(new URL('./EconomyPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const P = 'R363/coins/check/';
type Props = Record<string, unknown> & { children?: React.ReactNode };
type Element = React.ReactElement<Props>;
function settings(enabled: boolean | undefined): EconomySettingsDto {
  return { enabled: true, currencyName: 'Монеты', iconUrl: null, ratePer5min: 10, alonePercent: 25, companyPercent: 150,
    dailyCap: 800, decayAfterMinutes: 120, decayPercent: 50, mutedPercent: 50, deafenedPercent: 10, awayPercent: 25,
    payoutMinutes: 10, compensateOnRaise: false, tipAmount: 5, tipTaxPercent: 0, tipDailyOut: 100, tipDailyIn: 100,
    tipDailyPair: 100, seasonLength: 'quarter', gooseBonus: 5, gooseMinutes: 30, gooseDeafenedBonus: 1, streakBonus: 1,
    retroGrantedAt: null, gamesEnabled: enabled, gamesBetMax: 320, gamesDailyLossMax: 1700, gamesFeePercent: 17, gamesPairDailyMax: 2600 };
}
function treeElements(tree: React.ReactNode): Element[] {
  let budget = 20_000;
  const visit = (node: React.ReactNode): Element[] => {
    if (--budget < 0) throw new Error('R363/coins/budget/tree');
    if (Array.isArray(node)) return node.flatMap(visit);
    if (!React.isValidElement<Props>(node)) return [];
    return [node, ...visit(node.props.children)];
  };
  return visit(tree);
}
function text(tree: React.ReactNode): string {
  // Данные JSX не содержат DOM/fiber: в assertions уходят только строки и маленькие DTO.
  const pending: React.ReactNode[] = [tree], out: string[] = [];
  for (let visited = 0; pending.length; visited++) {
    if (visited >= 20_000) throw new Error('R363/coins/budget/text');
    const node = pending.pop();
    if (node == null || typeof node === 'boolean') continue;
    if (Array.isArray(node)) pending.push(...node.slice().reverse());
    else if (React.isValidElement<Props>(node)) pending.push(node.props.children);
    else out.push(String(node));
  }
  return out.join('');
}
function fixture(raw: string, initial: EconomySettingsDto) {
  const states: unknown[] = [initial], refs: { current: unknown }[] = [];
  const calls: unknown[][] = [];
  let cursor = 0, refCursor = 0, renders = 0, updates = 0, hooks = 0;
  const step = (ok: boolean) => { if (!ok) throw new Error('R363/coins/budget/hooks-render-state'); };
  const unused = () => { throw new Error('R363/coins/setup/неожиданное-IO'); };
  const deps: Record<string, unknown> = {
    react: { ...React, useState(value: unknown) {
      step(++hooks <= 2000); const i = cursor++;
      if (!(i in states)) states[i] = typeof value === 'function' ? (value as () => unknown)() : value;
      return [states[i], (next: unknown) => {
        step(++updates <= 200); states[i] = typeof next === 'function' ? (next as (v: unknown) => unknown)(states[i]) : next;
      }];
    }, useRef(current: unknown) { return refs[refCursor++] ??= { current }; }, useEffect() {}, useCallback: (fn: unknown) => fn },
    'react/jsx-runtime': jsx, '../economy': economy,
    '../api': { api: new Proxy({ saveEconomy: async (server: string, value: EconomySettingsDto) => {
      step(calls.length < 10); calls.push([server, JSON.parse(JSON.stringify(value))]);
    } }, { get: (obj, key) => key in obj ? obj[key as keyof typeof obj] : unused }) },
    '../confirm': { alertDialog: unused, confirmAction: unused }, './Toggle': { Toggle: () => null },
  };
  const module = { exports: {} as { EconomyPanel: (p: { serverId: string }) => React.ReactNode } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { module, exports: module.exports, window: { setTimeout: () => 1, clearTimeout() {} },
    require(id: string) { assert.equal(Object.hasOwn(deps, id), true, 'R363/coins/setup/import/' + id); return deps[id]; },
  }, { timeout: 1000 });
  return { calls, render() {
    step(++renders <= 200); cursor = 0; refCursor = 0;
    return module.exports.EconomyPanel({ serverId: 'synthetic-server' });
  } };
}
async function paired(check: (raw: string) => void | Promise<void>, from: string, to: string) {
  await check(source);
  await counterfact(async () => {
    assert.equal(source.split(from).length - 1, 1, 'R363/coins/setup/единственный-якорь');
    await assert.rejects(async () => check(source.replace(from, to)), e => e instanceof assert.AssertionError && e.message.startsWith(P));
  });
  await check(source);
}

it('R363 Монеты не показывают игровые настройки ни при включённых, ни при выключенных или старых играх', async () => {
  // После переноса нужен парный контроль: обычная экономика по-прежнему видна, исчезли только игровые настройки.
  await paired(raw => {
    for (const enabled of [true, false, undefined]) {
      const tree = fixture(raw, settings(enabled)).render(), nodes = treeElements(tree);
      assert.equal(text(tree).includes('Монеты на этом сервере'), true, P + 'экономика-не-исчезла');
      const visible = text(tree) + nodes.map(node => String(node.props.label ?? '')).join(' ');
      assert.doesNotMatch(visible, /Мини-игры|Потолок проигрыша|Запустить игры/, P + 'игры-в-отдельном-разделе');
      assert.equal(nodes.filter(node => node.type === 'button' && text(node) === 'Сохранить').length, 1, P + 'экономику-можно-сохранить');
    }
  }, '<div className="eco-panel">', '<div className="eco-panel"><p>Мини-игры</p>');
});

it('R363 сохранение Монет меняет валюту, но не теряет присланные сервером поля games*', async () => {
  // Скрытие полей в интерфейсе не должно стать обнулением чужого раздела при сохранении всего DTO.
  await paired(async raw => {
    const zero = { ...settings(true), gamesDailyLossMax: 0, gamesPairDailyMax: 0, gamesFeePercent: 0 };
    const legacy = settings(undefined);
    for (const key of Object.keys(legacy)) if (key.startsWith('games')) delete (legacy as unknown as Record<string, unknown>)[key];
    for (const initial of [settings(true), settings(false), zero, legacy]) {
      const before = JSON.stringify(initial), f = fixture(raw, initial);
      const label = treeElements(f.render()).find(node => node.type === 'label' && text(node).includes('Как называется валюта'));
      assert.equal(!!label, true, 'R363/coins/setup/поле-валюты');
      const field = treeElements(label).find(node => node.type === 'input');
      assert.equal(!!field, true, 'R363/coins/setup/input-валюты');
      (field!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'Жетоны' } });
      const save = treeElements(f.render()).find(node => node.type === 'button' && text(node) === 'Сохранить');
      assert.equal(!!save, true, 'R363/coins/setup/save');
      (save!.props.onClick as () => void)();
      for (let i = 0; i < 6; i++) await Promise.resolve();
      assert.deepEqual(f.calls, [['synthetic-server', { ...initial, currencyName: 'Жетоны' }]], P + 'games-сохранены-без-изменений');
      assert.equal(JSON.stringify(initial), before, P + 'исходный-снимок-не-изменён');
    }
  }, 'await api.saveEconomy(serverId, settings);',
  "await api.saveEconomy(serverId, Object.fromEntries(Object.entries(settings).filter(([key]) => !key.startsWith('games'))));");
});
