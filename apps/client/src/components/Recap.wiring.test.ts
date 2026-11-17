import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from '../gameBoardRules';
import type { RecapDto } from '@gusvoice/shared';

const source = readFileSync(new URL('./MainLayout.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const NOW = Date.parse('2026-10-29T12:00:00Z');
type Props = Record<string, any>;
type Element = { type: unknown; props: Props };
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements)
  : node && typeof node === 'object' && 'props' in node ? [node as Element, ...elements((node as Element).props.children)] : [];
type Edit = { from: string; to: string };
function fixture(edit?: Edit) {
  let cursor = 0, cheat = false; const states: unknown[] = [];
  const scene = () => null;
  const input = (kind: 'economy' | 'games'): RecapDto => ({ kind, periodId: 'm2026-10', name: 'Октябрь', from: '', to: '',
    frozenAt: new Date(NOW - 1000).toISOString(), preview: false, me: {} as RecapDto['me'], server: {} as RecapDto['server'] });
  const requested: unknown[] = [];
  const state: Props = {
    bootstrap: { server: { id: 'server' }, channels: [], categories: [] },
    economy: { server: { enabled: true } }, user: { id: 'me', economyWelcomeSeen: true, superAdmin: true },
    recaps: { server: { economy: input('economy'), games: input('games') } }, recapOpen: null, activitiesOpen: null,
    openRecap(value: unknown) { requested.push(value); state.recapOpen = value; },
    view: 'dm', dms: [], convActive: false, conv: { pts: null }, unreadDms: [], mobilePane: 'list',
    settingsOpen: false, adminOpen: false, incomingPoke: null, economyWelcomeOpen: false,
    voice: null, setEconomyWelcomeOpen() {},
  };
  const useStore = Object.assign((select: (s: Props) => unknown) => select(state), { getState: () => state });
  const noop = () => {};
  const jsx = (type: unknown, props: Props): Element => ({ type, props });
  const deps: Record<string, unknown> = {
    react: { lazy: () => scene, Suspense: 'suspense', useEffect: noop, useState(initial: unknown) {
      const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [states[i], (next: unknown) => { states[i] = typeof next === 'function' ? (next as (old: unknown) => unknown)(states[i]) : next; }];
    } }, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, '../store': { useStore },
    '../hotkeys': { isMobile: () => false }, '../dmArchiveRules': { withoutArchived: () => [] },
    '../cheatSheet': { useCheatSheetOpen: () => cheat, openCheatSheet: noop, closeCheatSheet: noop, toggleCheatSheet: noop },
    '../dmCompose': { openDmCompose: noop }, '../dmRules': { dmNeedsServerUpdate: () => false, dmEmptyHint: () => '', DM_SERVER_UPDATE_TEXT: '' },
    '../dmSelection': { useSelectionOpen: () => false, exitSelection: () => false }, './ChatSearch': { exitChatSearch: () => false },
    '../schedView': { backFromSchedView: () => false, useSchedViewOpen: () => false },
    '../dmBackBadge': { dmBackBadgeCount: () => 0, dmBackBadgeLabel: () => '' }, '../useSwipeBack': { useSwipeBack: noop },
    '../phoneLayout': { usePhoneLayout: () => false, isPhoneUiNow: () => false }, '../feedNavRules': { feedNavKey: () => null, feedNavTarget: () => null },
    '../gameBoardClient': { ensureRecaps: noop, recapStorage: () => null }, '../gameBoardRules': rules,
    './Activities': { ActivitiesHost: () => null }, './CallLayer': { CallBar: () => null, CallLayer: () => null },
    './ChatSwitch': { ChatSwitchHost: () => null }, './ContactEditModal': { ContactEditHost: () => null }, './DesktopKeys': { DesktopKeysHost: () => null },
  };
  for (const name of ['AdminPanel', 'ChannelSidebar', 'MobileCallChip', 'MobileProfile', 'ChatView', 'DmChatView', 'DmSidebar', 'PhoneServerList',
    'EconomyWelcome', 'RecountNotice', 'FeatherLayer', 'BigReactionLayer', 'EffectsBench', 'GooseBonusHost', 'HotkeyCheatSheet', 'Goose', 'Icon',
    'ImageViewerHost', 'MobileNav', 'ServerMembersPanel', 'ServerRail', 'SidebarResizer', 'PokeModal', 'ServerClosedModal', 'ToastHost',
    'UserSettingsModal', 'VoiceChannelView', 'VoiceConnection']) deps[`./${name}`] = { [name]: () => null };
  class FixedDate extends Date { static override now() { return NOW; } }
  let raw = source;
  if (edit) { assert.equal(raw.split(edit.from).length, 2, 'R340 setup: уникальный якорь полного MainLayout'); raw = raw.replace(edit.from, edit.to); }
  const module = { exports: {} as { MainLayout: () => unknown } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, Date: FixedDate, window: {}, document: { querySelector: () => null },
      require(id: string) { assert.ok(Object.hasOwn(deps, id), `R340 setup: закрытый import ${id}`); return deps[id]; } });
  return { state, requested, cheat: () => { cheat = true; }, render() { cursor = 0; return module.exports.MainLayout(); },
    cards(tree: unknown) { return elements(tree).filter(e => e.type === scene); } };
}
type Fixture = ReturnType<typeof fixture>;
function paired(title: string, check: (f: Fixture) => void, edit: Edit | (() => Edit)) {
  it(`R340 итоги в MainLayout: ${title}`, () => {
    check(fixture());
    counterfact(() => {
      const mutation = typeof edit === 'function' ? edit() : edit;
      assert.throws(() => check(fixture(mutation)), e => e instanceof assert.AssertionError && e.message.startsWith('R340 показ:'));
    });
    check(fixture());
  });
}
const gate = '!recount && !welcomeOpen && !settingsOpen && !adminOpen && !cheatOpen && !benchOpen && !incomingPoke && !activitiesOpen';
for (const blocker of ['recount', 'welcome', 'settings', 'admin', 'cheat', 'poke', 'activities'] as const) paired(`${blocker} блокирует автоматические итоги`, f => {
  if (blocker === 'recount') f.state.economy.server.recount = { amount: 3, seasonId: 'oct' };
  if (blocker === 'welcome') f.state.user.economyWelcomeSeen = false;
  if (blocker === 'settings') f.state.settingsOpen = true;
  if (blocker === 'admin') f.state.adminOpen = true;
  if (blocker === 'cheat') f.cheat();
  if (blocker === 'poke') f.state.incomingPoke = { id: 'poke' };
  if (blocker === 'activities') f.state.activitiesOpen = { serverId: 'server', view: 'list' };
  assert.equal(f.cards(f.render()).length, 0, 'R340 показ: автоматические итоги не перекрывают занятый экран');
}, () => ({ from: gate, to: blocker === 'activities' ? gate.replace(' && !activitiesOpen', '')
  : gate.replace(`!${{ recount: 'recount', welcome: 'welcomeOpen', settings: 'settingsOpen', admin: 'adminOpen', cheat: 'cheatOpen', poke: 'incomingPoke' }[blocker]} && `, '') }));

paired('закрытие автоэкономики пропускает её на сессию, затем игры, затем ничего даже без storage', f => {
  let cards = f.cards(f.render());
  assert.equal(cards.length, 1, 'R340 показ: только одна сцена за раз'); assert.equal(cards[0].props.open.kind, 'economy', 'R340 показ: экономика первая');
  cards[0].props.onClose();
  cards = f.cards(f.render()); assert.equal(cards[0]?.props.open.kind, 'games', 'R340 показ: закрытая экономика не воскресает без storage');
  cards[0].props.onClose(); assert.equal(f.cards(f.render()).length, 0, 'R340 показ: оба вида пропущены до конца сессии');
}, { from: 'if (recapShown?.auto) setRecapSkipped((list) => [...list, `${recapShown.serverId}:${recapShown.kind}`]);', to: '' });

paired('ручной запрос поверх приветствия имеет приоритет над автопоказом', f => {
  f.state.user.economyWelcomeSeen = false; f.state.recapOpen = { serverId: 'server', kind: 'games', preview: true };
  const cards = f.cards(f.render()); assert.equal(cards.length, 1, 'R340 показ: ручной запрос действительно показан');
  assert.equal(cards[0].props.open.preview, true, 'R340 показ: ручной preview не подменён авто');
}, { from: 'recapRequested ??', to: 'null ??' });

paired('закрытие ручного preview не отмечает автоитоги просмотренными', f => {
  f.state.recapOpen = { serverId: 'server', kind: 'economy', preview: true };
  const card = f.cards(f.render())[0]; assert.ok(card, 'R340 показ: ручной preview открыт'); card.props.onClose();
  assert.equal(f.state.recapOpen, null, 'R340 показ: ручной запрос сброшен');
  assert.equal(f.cards(f.render())[0]?.props.open.kind, 'economy', 'R340 показ: просмотр черновика не съел настоящую экономику');
}, { from: 'if (recapShown?.auto) setRecapSkipped', to: 'if (recapShown) setRecapSkipped' });
