import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { gamesView } from '../economy';

const read = (name: string) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const layoutSource = read('MainLayout');
const walletSource = read('CoinWalletModal');
type Props = Record<string, unknown>;
type Element = { type: unknown; props: Props };
const jsx = (type: unknown, props: Props): Element => ({ type, props });
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const e = tree as Element;
  return [e, ...elements(e.props.children)];
}
function one(tree: unknown, predicate: (e: Element) => boolean, address: string): Element {
  const found = elements(tree).filter(predicate);
  assert.equal(found.length, 1, address);
  return found[0];
}
function replaceOnce(raw: string, needle: string, next: string): string {
  assert.equal(raw.split(needle).length, 2, `R318/подготовка/якорь/${needle}`);
  return raw.replace(needle, next);
}
function killed(check: () => void, address: string) {
  assert.throws(check, (e: unknown) => e instanceof assert.AssertionError && e.message.split('\n')[0] === address);
}
function runtime() {
  let cursor = 0;
  let mounted = false;
  const states: unknown[] = [];
  const effects: Array<() => void | (() => void)> = [];
  return { react: {
    lazy: () => () => null, Suspense: 'suspense',
    useState(initial: unknown) {
      const i = cursor++;
      if (!(i in states)) states[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [states[i], (next: unknown) => { states[i] = typeof next === 'function'
        ? (next as (old: unknown) => unknown)(states[i]) : next; }];
    },
    useEffect(effect: () => void | (() => void)) { if (!mounted) effects.push(effect); },
  }, begin() { cursor = 0; }, mount() { mounted = true; effects.forEach(fn => fn()); } };
}
function load(raw: string, deps: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const module = { exports: {} as Record<string, (p?: Props) => unknown> };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { module, exports: module.exports, ...extra,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `R318/подготовка/импорт/${id}`); return deps[id]; },
  });
  return module.exports;
}

function layout(raw = layoutSource) {
  const hooks = runtime();
  let cheat = false;
  let key: ((e: unknown) => void) | undefined;
  const economyView = { enabled: true, currencyName: 'Перья', iconUrl: '/coin.png',
    season: { id: 'oct', name: 'Октябрь' }, recount: { amount: 37, seasonId: 'oct' } as
      { amount: number; seasonId: string } | undefined };
  const state = {
    bootstrap: { server: { id: 'server-a' }, channels: [], categories: [] }, economy: { 'server-a': economyView },
    voice: { channelId: 'voice-a' }, view: 'dm', dms: [], convActive: false, conv: { pts: null }, unreadDms: [],
    mobilePane: 'list', settingsOpen: false, adminOpen: false, incomingPoke: null as unknown,
    user: { economyWelcomeSeen: true, superAdmin: true }, economyWelcomeOpen: false,
    recaps: {}, recapOpen: null, activitiesOpen: null, openRecap() {},
    setEconomyWelcomeOpen() {}, setEconomy(id: string, view: typeof economyView) {
      assert.equal(id, 'server-a'); state.economy['server-a'] = view;
    },
  };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  const refs: Record<string, () => null> = {};
  const deps: Record<string, unknown> = {
    './Activities': { ActivitiesButton: () => null, ActivitiesHost: () => null },
    '../gameBoardClient': { ensureRecaps() {}, recapStorage: () => null },
    '../gameBoardRules': { readRecapSeen: () => null, recapAutoQueue: () => [] },
    react: hooks.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '../store': { useStore }, '../hotkeys': { isMobile: () => false },
    '../dmArchiveRules': { withoutArchived: () => [] },
    '../cheatSheet': { useCheatSheetOpen: () => cheat, openCheatSheet() {}, closeCheatSheet() {}, toggleCheatSheet() {} },
    '../dmCompose': { openDmCompose() {} },
    '../dmRules': { dmNeedsServerUpdate: () => false, dmEmptyHint: () => '', DM_SERVER_UPDATE_TEXT: '' },
    '../dmSelection': { useSelectionOpen: () => false, exitSelection: () => false },
    './ChatSearch': { exitChatSearch: () => false },
    '../schedView': { backFromSchedView: () => false, useSchedViewOpen: () => false },
    '../dmBackBadge': { dmBackBadgeCount: () => 0, dmBackBadgeLabel: () => '' },
    '../useSwipeBack': { useSwipeBack() {} },
    '../phoneLayout': { usePhoneLayout: () => false, isPhoneUiNow: () => false },
    '../feedNavRules': { feedNavKey: () => null, feedNavTarget: () => null },
  };
  for (const name of ['AdminPanel', 'ChannelSidebar', 'MobileCallChip', 'MobileProfile', 'ChatView', 'DmChatView',
    'DmSidebar', 'PhoneServerList', 'EconomyWelcome', 'RecountNotice', 'FeatherLayer', 'BigReactionLayer',
    'EffectsBench', 'GooseBonusHost', 'HotkeyCheatSheet', 'Goose', 'Icon', 'ImageViewerHost', 'MobileNav',
    'ServerMembersPanel', 'ServerRail', 'SidebarResizer', 'PokeModal', 'ServerClosedModal', 'ToastHost',
    'UserSettingsModal', 'VoiceChannelView', 'VoiceConnection']) {
    refs[name] = () => null; deps[`./${name}`] = { [name]: refs[name] };
  }
  deps['./CallLayer'] = { CallBar: () => null, CallLayer: () => null };
  deps['./ChatSwitch'] = { ChatSwitchHost: () => null };
  deps['./ContactEditModal'] = { ContactEditHost: () => null };
  deps['./DesktopKeys'] = { DesktopKeysHost: () => null };
  const mod = load(raw, deps, { window: {
    addEventListener(name: string, fn: (e: unknown) => void) { assert.equal(name, 'keydown'); key = fn; },
    removeEventListener() {},
  }, document: { querySelector: () => null } });
  return { state, refs, hooks, render() { hooks.begin(); return mod.MainLayout(); },
    setCheat(value: boolean) { cheat = value; },
    bench() { key?.({ ctrlKey: true, altKey: true, shiftKey: false, code: 'KeyE', preventDefault() {} }); },
  };
}
const blockers = ['welcome', 'requestedWelcome', 'settings', 'admin', 'cheat', 'bench', 'poke'] as const;
type Blocker = typeof blockers[number];
function layoutCheck(raw: string, blocker?: Blocker) {
  const f = layout(raw);
  f.render(); f.hooks.mount();
  if (blocker === 'welcome') f.state.user.economyWelcomeSeen = false;
  if (blocker === 'requestedWelcome') f.state.economyWelcomeOpen = true;
  if (blocker === 'settings') f.state.settingsOpen = true;
  if (blocker === 'admin') f.state.adminOpen = true;
  if (blocker === 'cheat') f.setCheat(true);
  if (blocker === 'bench') f.bench();
  if (blocker === 'poke') f.state.incomingPoke = { id: 'poke-a' };
  const tree = f.render();
  assert.equal(elements(tree).filter(e => e.type === f.refs.RecountNotice).length, blocker ? 0 : 1,
    `R318/layout/${blocker ?? 'free'}/card`);
  const host = one(tree, e => e.type === f.refs.GooseBonusHost, 'R318/layout/host');
  if (!blocker) assert.equal(host.props.presentationAllowed, false, 'R318/layout/card-hides-goose');
  return f;
}
function layoutCloseCheck(raw: string) {
  const f = layoutCheck(raw);
  const card = one(f.render(), e => e.type === f.refs.RecountNotice, 'R318/layout/card');
  assert.equal(card.props.amount, 37); assert.equal(card.props.currencyName, 'Перья');
  assert.equal(card.props.iconUrl, '/coin.png'); assert.equal(card.props.seasonName, 'Октябрь');
  assert.equal(card.props.markSeenOn, 'server-a', 'R318/layout/markSeenOn');
  (card.props.onClose as () => void)();
  assert.equal(f.state.economy['server-a'].recount, undefined, 'R318/layout/clear-snapshot');
  // Поздний пуш старого снимка не должен воскресить уже закрытую карточку в той же сессии.
  f.state.economy['server-a'].recount = { amount: 37, seasonId: 'oct' };
  assert.equal(elements(f.render()).some(e => e.type === f.refs.RecountNotice), false, 'R318/layout/session');
}
it('R318 авто-показ передаёт сумму/сезон/сервер и при закрытии гасит снимок и повтор на сессию', () => {
  layoutCloseCheck(layoutSource);
});
it('R318 авто-показ отсутствует без доплаты, на выключенной экономике и без открытого сервера', () => {
  for (const scenario of ['no-recount', 'disabled', 'no-server'] as const) dataGateCheck(layoutSource, scenario);
});
function dataGateCheck(raw: string, scenario: 'no-recount' | 'disabled' | 'no-server') {
  const f = layout(raw);
  if (scenario === 'no-recount') f.state.economy['server-a'].recount = undefined;
  if (scenario === 'disabled') f.state.economy['server-a'].enabled = false;
  if (scenario === 'no-server') Object.assign(f.state, { bootstrap: null });
  assert.equal(elements(f.render()).some(e => e.type === f.refs.RecountNotice), false, `R318/layout/data/${scenario}`);
}
it('R318 контрфакт авто-показа: выключенная экономика не показывает старую доплату из кеша', () => {
  dataGateCheck(layoutSource, 'disabled');
  counterfact(() => {
    killed(() => dataGateCheck(replaceOnce(layoutSource, ' && recountView?.enabled', ''), 'disabled'), 'R318/layout/data/disabled');
  });
});
for (const [name, needle, next, address] of [
  ['сервер отметки', 'markSeenOn={recountServerId ?? undefined}', '', 'R318/layout/markSeenOn'],
  ['сброс снимка', 'if (cur?.recount) st.setEconomy(serverId, { ...cur, recount: undefined });', '', 'R318/layout/clear-snapshot'],
  ['сессионный запрет', ' && !recountDismissed.includes(recountServerId)', '', 'R318/layout/session'],
] as const) it(`R318 контрфакт авто-показа: ${name}`, () => {
  layoutCloseCheck(layoutSource);
  counterfact(() => {
    killed(() => layoutCloseCheck(replaceOnce(layoutSource, needle, next)), address);
  });
});
for (const blocker of blockers) it(`R318 авто-показ ждёт закрытия: ${blocker}`, () => {
  layoutCheck(layoutSource, blocker);
});
for (const [blocker, guard] of [
  ['welcome', '!welcomeOpen'], ['settings', '!settingsOpen'], ['admin', '!adminOpen'],
  ['cheat', '!cheatOpen'], ['bench', '!benchOpen'], ['poke', '!incomingPoke'],
] as const) it(`R318 контрфакт авто-показа: потеря запрета ${blocker}`, () => {
  layoutCheck(layoutSource, blocker);
  counterfact(() => {
    const expression = '!!recount && !welcomeOpen && !settingsOpen && !adminOpen && !cheatOpen && !benchOpen && !incomingPoke';
    const mutant = replaceOnce(layoutSource, expression, expression.replace(` && ${guard}`, ''));
    killed(() => layoutCheck(mutant, blocker), `R318/layout/${blocker}/card`);
  });
});
it('R318 контрфакт авто-показа: карточка запрещает выглядывать бонусному гусю', () => {
  layoutCheck(layoutSource);
  counterfact(() => {
    killed(() => layoutCheck(replaceOnce(layoutSource, '!recountOpen &&', '')), 'R318/layout/card-hides-goose');
  });
});

async function walletCheck(raw: string) {
  const hooks = runtime();
  const RecountNotice = () => null;
  const entries = [
    { id: 'recount-a', reason: 'recount', amount: 37, createdAt: '2026-10-28T10:00:00Z', data: { seasonId: 'oct' } },
    { id: 'voice-a', reason: 'voice', amount: 2, createdAt: '2026-10-28T11:00:00Z', data: {} },
  ];
  const calls: string[] = [];
  let walletClosed = 0;
  const deps: Record<string, unknown> = {
    react: hooks.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    // ShopSection остаётся JSX-границей: расчёт аренды не относится к журналу перерасчёта.
    '@gusvoice/shared': new Proxy({}, { get(_target, name) {
      throw new Error(`R318/неожиданно читается shared/${String(name)}`);
    } }),
    '../api': { api: {
      getEconomyLedger: async () => entries, getLeaderboard: async () => null,
      markRecountSeen: async () => { calls.push('seen'); },
    } },
    '../store': { useStore: (select: (s: unknown) => unknown) => select({ user: { id: 'me' }, recaps: {}, openRecap() {}, setEconomyWelcomeOpen() {} }) },
    '../memberName': { useNameResolver: () => () => 'Друг' },
    '../economy': { gamesView, LEDGER_REASON: { recount: 'Перерасчёт сезона', voice: 'За время в голосе' } },
    './RecountNotice': { RecountNotice }, './Goose': { Goose: () => null }, './Icon': { Icon: () => null },
    './GameBoard': { GameBoardSection: () => null, MyGameTitles: () => null },
    '../benchMock': { isMockEconomy: () => false, mockLeaderboard() {} },
    '../economyClient': { ensureEconomy() {} }, '../ledgerCsv': { ledgerCsv() {}, ledgerFileName() {} },
    '../streakView': { streakCaption() {}, streakDots() {}, streakExplain() {} }, '../toast': { toast() {}, toastError() {} },
  };
  const mod = load(raw, deps);
  const props = { serverId: 'server-a', view: { currencyName: 'Перья', iconUrl: '/coin.png',
    season: { id: 'oct', name: 'Октябрь' }, wallet: { balance: 100, earnedTotal: 100, seasonEarned: 100 } },
    onViewChange() {}, onClose() { walletClosed++; } };
  const render = () => { hooks.begin(); return mod.CoinWalletModal(props); };
  render(); hooks.mount(); await Promise.resolve(); await Promise.resolve();
  let tree = render();
  assert.equal(elements(tree).some(e => e.type === RecountNotice), false, 'R318/wallet/initially-hidden');
  const row = one(tree, e => e.props.className === 'wallet-entry wallet-entry-btn', 'R318/wallet/row');
  assert.equal(row.type, 'button', 'R318/wallet/button');
  assert.equal(row.props.type, 'button', 'R318/wallet/button-type');
  assert.equal(elements(tree).filter(e => e.type === 'div' && e.props.className === 'wallet-entry').length, 1,
    'R318/wallet/ordinary-not-button');
  (row.props.onClick as () => void)();
  tree = render();
  const card = one(tree, e => e.type === RecountNotice, 'R318/wallet/card');
  assert.equal(card.props.amount, 37, 'R318/wallet/amount');
  assert.equal(card.props.currencyName, 'Перья'); assert.equal(card.props.iconUrl, '/coin.png');
  assert.equal(card.props.seasonName, 'Октябрь');
  assert.equal(card.props.markSeenOn, undefined, 'R318/wallet/no-markSeenOn');
  (card.props.onClose as () => void)();
  assert.equal(elements(render()).some(e => e.type === RecountNotice), false, 'R318/wallet/close');
  assert.equal(calls.length, 0, 'R318/wallet/no-mark-api');
  assert.equal(walletClosed, 0, 'R318/wallet/keep-wallet');
}
it('R318 журнал: перерасчёт — настоящая кнопка; открывает ту же карточку без отметки, закрывается отдельно от кошелька', async () => {
  await walletCheck(walletSource);
});
for (const [name, needle, next, address] of [
  ['тип строки', '                <button\n                  type="button"\n                  className="wallet-entry wallet-entry-btn"',
    '                <div\n                  type="button"\n                  className="wallet-entry wallet-entry-btn"', 'R318/wallet/button'],
  ['причина строки', "entry.reason === 'recount' ?", "entry.reason === 'voice' ?", 'R318/wallet/amount'],
  ['открытие карточки', 'onClick={() => setRecountShown(entry)}', 'onClick={() => {}}', 'R318/wallet/card'],
  ['запрет отметки', 'amount={recountShown.amount}', 'markSeenOn={serverId} amount={recountShown.amount}', 'R318/wallet/no-markSeenOn'],
  ['прямой вызов API', 'onClick={() => setRecountShown(entry)}', 'onClick={() => { api.markRecountSeen(serverId); setRecountShown(entry); }}', 'R318/wallet/no-mark-api'],
] as const) it(`R318 контрфакт журнала: ${name}`, async () => {
  await walletCheck(walletSource);
  await counterfact(async () => {
    let mutant = replaceOnce(walletSource, needle, next);
    // JSX должен оставаться валиден: меняем парный закрывающий тег, а не ловим ошибку транспиляции.
    if (name === 'тип строки') mutant = replaceOnce(mutant, '                </button>\n              ) : (', '                </div>\n              ) : (');
    await assert.rejects(() => walletCheck(mutant), (e: unknown) => e instanceof assert.AssertionError && e.message.split('\n')[0] === address);
  });
});
