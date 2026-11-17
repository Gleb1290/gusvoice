import assert from 'node:assert/strict';
import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as economy from '../economy';
import type { EconomySettingsDto } from '../economy';

const source = readFileSync(new URL('./GamesSettingsPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sliderSource = readFileSync(new URL('./EconomyPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Props = Record<string, unknown>;
type Element = { type: unknown; props: Props };
const jsx = (type: unknown, props: Props): Element => ({ type, props });
function elements(tree: unknown): Element[] {
  const pending = [tree], out: Element[] = [];
  for (let visited = 0; pending.length; visited++) {
    if (visited >= 200) throw new Error('R363/budget/launch/elements');
    const current = pending.pop();
    if (Array.isArray(current)) pending.push(...current.slice().reverse());
    else if (current && typeof current === 'object' && 'props' in current) {
      const node = current as Element;
      out.push(node); pending.push(node.props.children);
    }
  }
  return out;
}
function text(tree: unknown): string {
  const pending = [tree], parts: string[] = [];
  for (let visited = 0; pending.length; visited++) {
    if (visited >= 200) throw new Error('R363/budget/launch/text');
    const current = pending.pop();
    if (current == null || typeof current === 'boolean') continue;
    if (Array.isArray(current)) pending.push(...current.slice().reverse());
    else if (typeof current === 'object' && 'props' in current) pending.push((current as Element).props.children);
    else parts.push(String(current));
  }
  return parts.join('');
}
function settings(gamesEnabled: boolean | undefined = false): EconomySettingsDto {
  return { enabled: true, currencyName: 'Перья', iconUrl: null, ratePer5min: 10, alonePercent: 25,
    companyPercent: 150, dailyCap: 800, decayAfterMinutes: 120, decayPercent: 50, mutedPercent: 50,
    deafenedPercent: 10, awayPercent: 25, payoutMinutes: 10, compensateOnRaise: false, tipAmount: 5,
    tipTaxPercent: 0, tipDailyOut: 100, tipDailyIn: 100, tipDailyPair: 100, seasonLength: 'quarter',
    gooseBonus: 5, gooseMinutes: 30, gooseDeafenedBonus: 1, streakBonus: 1, retroGrantedAt: null,
    gamesEnabled, gamesBetMax: 300, gamesDailyLossMax: 3000, gamesFeePercent: 10 };
}
interface Options {
  locked?: boolean;
  launched?: { at: string; gift: number; mine: number } | null;
  initial?: EconomySettingsDto;
  confirm?: boolean;
  reject?: boolean;
  seenEntries?: Array<[string, string]>;
}
const unused = () => { throw new Error('R343/подготовка/panel/unrelated-I/O'); };
async function fixture(raw: string, options: Options = {}) {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const effects: Array<() => unknown> = [];
  const counts = new Map<string, number>();
  const step = (kind: string) => {
    const count = (counts.get(kind) ?? 0) + 1; counts.set(kind, count);
    if (count > 200) throw new Error(`R363/budget/launch/${kind}`);
  };
  let cursor = 0, refCursor = 0;
  let mounted = false;
  const events: string[] = [];
  const seen = new Map<string, string>(options.seenEntries);
  const confirms: Array<{ title: string; body: string; confirmLabel: string }> = [];
  const calls: Array<[string, number]> = [];
  const alerts: Array<[string, string]> = [];
  const storage = { getItem: (key: string) => { step('IO'); return seen.get(key) ?? null; },
    setItem(key: string, value: string) { step('IO'); events.push('seen'); seen.set(key, value); },
    removeItem(key: string) { step('IO'); events.push('clear'); seen.delete(key); } };
  const Toggle = () => null;
  const api = {
    async getEconomy(id: string) {
      step('IO');
      assert.equal(id, 'server-launch', 'R343/подготовка/panel/get-id');
      return { settings: options.initial ?? settings(), gamesLocked: options.locked ?? false,
        gamesLaunch: options.launched === undefined ? null : options.launched, shop: [] };
    },
    async launchGames(id: string, gift: number) {
      step('IO');
      events.push('request'); calls.push([id, gift]);
      if (options.reject) throw new Error('games-locked');
      return { at: '2026-10-29T10:00:00.000Z', gift, people: gift ? 3 : 0 };
    },
  };
  const deps: Record<string, unknown> = {
    react: {
      useState(initial: unknown) {
        step('hooks');
        const index = cursor++;
        if (!(index in states)) states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
        return [states[index], (next: unknown) => {
          step('setters');
          states[index] = typeof next === 'function' ? (next as (current: unknown) => unknown)(states[index]) : next;
        }];
      },
      useEffect(effect: () => unknown) { step('hooks'); if (!mounted) effects.push(effect); },
      useRef(current: unknown) {
        step('hooks'); const index = refCursor++;
        return refs[index] ??= { current };
      },
      useCallback(fn: unknown) { step('hooks'); return fn; },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '../economy': { ...economy, launchStorage: () => storage },
    '../api': { api: new Proxy(api, { get(target, key) { return key in target ? target[key as keyof typeof api] : unused; } }) },
    '../confirm': {
      async confirmAction(value: { title: string; body: string; confirmLabel: string }) {
        step('IO');
        events.push('confirm'); confirms.push(value); return options.confirm !== false;
      },
      async alertDialog(title: string, body: string) { step('IO'); events.push('alert'); alerts.push([title, body]); },
    },
    './Toggle': { Toggle }, './GameTitlesCard': { GameTitlesCard: () => null },
  };
  function load<T>(rawSource: string): T {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(rawSource, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText, { module, exports: module.exports,
      window: { setTimeout: () => { step('IO'); return 1; }, clearTimeout() { step('IO'); } },
      require(id: string) { assert.ok(Object.hasOwn(deps, id), `R343/подготовка/panel/import/${id}`); return deps[id]; },
    }, { timeout: 200 });
    return module.exports as T;
  }
  // Оба целых production-модуля: используется экспортированный Slider, не его тестовая копия.
  // Сам EconomyPanel не монтируется: состояние/эффекты здесь принадлежат только разделу «Игры».
  const { Slider } = load<{ Slider: (props: Props) => unknown }>(sliderSource);
  deps['./EconomyPanel'] = { Slider };
  const module = load<{ GamesSettingsPanel: (props: { serverId: string }) => unknown }>(raw);
  function render() {
    step('render'); cursor = 0; refCursor = 0;
    const tree = module.GamesSettingsPanel({ serverId: 'server-launch' });
    // Порядок: settings, busy, error, saved, noEconomy, gamesLocked, gamesLaunch,
    // loadedGamesOn, savedGamesOn, launchGift. Ref lossCapBefore стабилен между рендерами.
    assert.equal(cursor, 10, 'R363/подготовка/panel/state-count');
    assert.equal(refCursor, 1, 'R363/подготовка/panel/ref-count');
    return tree;
  }
  render(); mounted = true;
  for (const effect of effects) { step('iteration'); effect(); }
  await settle();
  return { render, Toggle, events, seen, confirms, calls, alerts };
}
async function settle() { for (let n = 0; n < 8; n++) await Promise.resolve(); }
function button(tree: unknown): Element | undefined {
  return elements(tree).find(node => node.type === 'button' && text(node) === 'Запустить игры');
}
function slider(tree: unknown): Element | undefined {
  return elements(tree).find(node => node.props.label === 'Подарок за запуск каждому, кто сидит в голосе');
}
function range(node: Element): Element {
  assert.equal(typeof node.type, 'function', 'R343/подготовка/panel/real-slider');
  const input = elements((node.type as (props: Props) => unknown)(node.props)).find(node => node.type === 'input');
  assert.ok(input, 'R343/подготовка/panel/range'); return input;
}
async function launch(f: Awaited<ReturnType<typeof fixture>>, gift?: number) {
  if (gift !== undefined) {
    const field = slider(f.render()); assert.ok(field, 'R343/подготовка/panel/gift');
    (range(field).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: String(gift) } });
  }
  const action = button(f.render()); assert.ok(action, 'R343/подготовка/panel/button');
  (action.props.onClick as () => void)(); await settle();
}
function withEconomyImports(raw: string, names: string[]): string {
  if (!names.length) return raw;
  const file = ts.createSourceFile('GamesSettingsPanel.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = file.statements.filter((node): node is ts.ImportDeclaration => ts.isImportDeclaration(node)
    && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '../economy');
  assert.equal(imports.length, 1, 'R352/подготовка/panel/economy-import');
  const original = imports[0]!;
  const clause = original.importClause;
  assert.ok(clause?.namedBindings && ts.isNamedImports(clause.namedBindings), 'R352/подготовка/panel/named-imports');
  const named = clause.namedBindings;
  const additions = names.filter(name => !named.elements.some(element => element.name.text === name))
    .map(name => ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier(name)));
  const updated = ts.factory.updateImportDeclaration(original, original.modifiers,
    ts.factory.updateImportClause(clause, clause.isTypeOnly, clause.name,
      ts.factory.updateNamedImports(named, [...named.elements, ...additions])), original.moduleSpecifier, original.attributes);
  return ts.createPrinter().printFile(ts.factory.updateSourceFile(file,
    file.statements.map(statement => statement === original ? updated : statement)));
}
async function guarded(check: (raw: string) => Promise<void>, needle: string, next: string, address: string, imports: string[] = []) {
  await check(source);
  await counterfact(async () => {
  assert.equal(source.split(needle).length, 2, 'R343/подготовка/panel/unique');
  // У возвращённой I/O-операции должны быть настоящие импорты: ReferenceError не доказывает контракт панели.
  const mutant = withEconomyImports(source.replace(needle, next), imports);
  await assert.rejects(async () => check(mutant), (error: unknown) =>
    error instanceof assert.AssertionError && error.message.split('\n')[0] === address);
  });
  await check(source);
}
function gameRow(tree: unknown) {
  return elements(tree).find(node => node.props.className === 'eco-row-toggle'
    && elements(node).some(child => child.props.id === 'games-state-title'));
}

it('R343 панель: закрытый замок показывает подсказку вместо тумблера, но включённые игры можно выключить', async () => {
  await guarded(async raw => {
    const locked = await fixture(raw, { locked: true });
    const tree = locked.render();
    const row = gameRow(tree);
    assert.ok(row, 'R343/подготовка/panel/game-row');
    assert.equal(elements(row).filter(node => node.type === locked.Toggle).length, 0, 'R343/panel/locked-toggle');
    assert.equal(text(tree).includes('Игры пока проходят приёмку — включит их администратор инстанса.'), true, 'R343/panel/locked-hint');
    assert.equal(button(tree), undefined);
    const enabled = await fixture(raw, { locked: true, initial: settings(true) });
    const enabledRow = gameRow(enabled.render());
    assert.equal(elements(enabledRow).filter(node => node.type === enabled.Toggle).length, 1);
  }, '{toggleShown && (', '{true && (', 'R343/panel/locked-toggle');
});
it('R343 панель: ползунок и кнопка запуска доступны до запуска, после запуска и под замком скрыты', async () => {
  await guarded(async raw => {
    const open = (await fixture(raw)).render();
    assert.equal(!!button(open), true, 'R343/panel/launch-visible');
    const gift = slider(open); assert.ok(gift, 'R343/подготовка/panel/open-slider');
    const input = range(gift);
    assert.deepEqual([input.props.min, input.props.max, input.props.step, input.props.value], [0, 2000, 50, 500]);
    for (const options of [{ locked: true }, { launched: { at: '2026-10-29T10:00:00.000Z', gift: 500, mine: 0 } }]) {
      const closed = (await fixture(raw, options)).render();
      assert.equal(button(closed), undefined, 'R343/panel/launch-hidden');
      assert.equal(slider(closed), undefined);
    }
  }, 'launchButtonVisible({ gamesLaunch, gamesLocked }) && (', 'false && (', 'R343/panel/launch-visible');
});
it('R352 отмена подтверждения не трогает хранилище и API, согласие запускает ровно один запрос', async () => {
  await guarded(async raw => {
    const entries: Array<[string, string]> = [['gv_games_launch_seen:server-launch', 'earlier-launch'], ['unrelated', 'keep']];
    const cancel = await fixture(raw, { confirm: false, seenEntries: entries }); await launch(cancel);
    assert.equal(cancel.confirms.length, 1);
    assert.deepEqual(cancel.calls, [], 'R343/panel/cancel-no-request');
    assert.deepEqual([...cancel.seen], entries, 'R352/panel/cancel-keeps-seen');
    assert.deepEqual(cancel.events, ['confirm'], 'R352/panel/cancel-only-confirm');
    assert.deepEqual(cancel.alerts, []);
    const accept = await fixture(raw); await launch(accept);
    assert.deepEqual(accept.calls, [['server-launch', 500]], 'R343/panel/confirmed-request');
    assert.deepEqual(accept.events, ['confirm', 'request', 'alert'], 'R352/panel/confirmed-order');
    assert.equal(accept.confirms[0]?.confirmLabel, 'Запустить');
    assert.equal(accept.confirms[0]?.body.includes('получит 500 монет'), true);
  }, 'if (!ok) return;\n    setBusy(true);\n    setError(null);\n    try {\n      const res = await api.launchGames(serverId, gift);',
  'if (false) return;\n    setBusy(true);\n    setError(null);\n    try {\n      const res = await api.launchGames(serverId, gift);', 'R343/panel/cancel-no-request');
});
it('R343 ползунок передаёт выбранный подарок, включая ноль, в подтверждение и настоящий launchGames', async () => {
  await guarded(async raw => {
    for (const gift of [0, 50, 2000]) {
      const f = await fixture(raw); await launch(f, gift);
      assert.deepEqual(f.calls, [['server-launch', gift]], 'R343/panel/gift-request');
      assert.equal(f.confirms[0]?.body.includes(gift ? `получит ${gift} монет` : 'подарка не будет'), true);
      assert.equal(f.alerts[0]?.[0], 'Игры запущены');
      assert.equal(f.alerts[0]?.[1], gift ? `Подарили по ${gift} монет: 3 чел. в голосе.` : 'Без подарка.');
    }
  }, 'api.launchGames(serverId, gift)', 'api.launchGames(serverId, 500)', 'R343/panel/gift-request');
});
it('R352 успешный запуск идёт confirm → request → alert и оставляет «видел» нетронутым для сцены шлюза', async () => {
  await guarded(async raw => {
    // Проверяем и отсутствие отметки, и ранее сохранённую: панель не вправе ни создать, ни затереть её.
    for (const entries of [[], [['gv_games_launch_seen:server-launch', 'earlier-launch'], ['unrelated', 'keep']]] as Array<Array<[string, string]>>) {
      const f = await fixture(raw, { seenEntries: entries }); await launch(f);
      assert.deepEqual(f.events, ['confirm', 'request', 'alert'], 'R352/panel/success-keeps-seen');
      assert.deepEqual([...f.seen], entries, 'R352/panel/success-storage-unchanged');
      assert.deepEqual(f.calls, [['server-launch', 500]]);
      assert.equal(button(f.render()), undefined, 'R343/panel/success-hides-launch');
      const row = gameRow(f.render());
      assert.equal(elements(row).find(node => node.type === f.Toggle)?.props.checked, true, 'R343/panel/success-enables-games');
    }
  }, 'setError(null);\n    try {\n      const res = await api.launchGames(serverId, gift);',
  'setError(null);\n    writeLaunchSeen(launchStorage(), serverId);\n    try {\n      const res = await api.launchGames(serverId, gift);',
  'R352/panel/success-keeps-seen', ['writeLaunchSeen', 'launchStorage']);
});
it('R352 отказ идёт confirm → request без отметок и alert, показывает ошибку и оставляет повторный запуск', async () => {
  await guarded(async raw => {
    for (const entries of [[], [['gv_games_launch_seen:server-launch', 'earlier-launch'], ['unrelated', 'keep']]] as Array<Array<[string, string]>>) {
      const f = await fixture(raw, { reject: true, seenEntries: entries }); await launch(f);
      assert.deepEqual(f.events, ['confirm', 'request'], 'R352/panel/reject-keeps-seen');
      assert.deepEqual([...f.seen], entries, 'R352/panel/reject-storage-unchanged');
      assert.equal(text(f.render()).includes('games-locked'), true, 'R343/panel/reject-error');
      assert.equal(button(f.render())?.props.disabled, false, 'R343/panel/reject-retry');
      assert.deepEqual(f.alerts, []);
    }
  }, 'setError(null);\n    try {\n      const res = await api.launchGames(serverId, gift);',
  'setError(null);\n    writeLaunchSeen(launchStorage(), serverId);\n    try {\n      const res = await api.launchGames(serverId, gift);',
  'R352/panel/reject-keeps-seen', ['writeLaunchSeen', 'launchStorage']);
});
