import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import type { DmChannel, UserLastSeen } from '@gusvoice/shared';
import * as convRules from '../convSyncRules';
import * as listRules from '../dmListRules';
import * as archiveRules from '../dmArchiveRules';
import * as callRules from '../callView';
import * as groupRules from '../groupChatRules';
import * as contactRules from '../contactRules';
import * as strangerRules from '../strangerBarRules';
import * as stickerRules from '../dmStickerRules';
import * as notifyRules from '../notifyExceptionsRules';
import * as lastSeenText from '../lastSeenText';

type Pane = Parameters<typeof import('./MessagePane').MessagePane>[0];
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const raw = read('./DmChatView.tsx'), paneRaw = read('./MessagePane.tsx');
const plate = 'Имя1 принимает сообщения только от своих контактов.';
const unused = () => assert.fail('граница вне плашки приватности сообщений');
function load<T>(source: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, { module, exports: module.exports,
    window, document, HTMLElement, Element, Node, Event, DOMRect, ResizeObserver, requestAnimationFrame, cancelAnimationFrame,
    localStorage, setTimeout, clearTimeout, Error,
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `импорт целого DmChatView и его правил: ${id}`); return deps[id]; } });
  return module.exports as T;
}
type Options = { phone?: boolean; kind?: 'group' | 'saved' | 'blocked' | 'former'; canMessage?: boolean; noLastSeen?: boolean; failedSnapshot?: boolean };
type Scene = { host: HTMLElement; fetches: string[]; pane(): Pane; change(value: boolean): Promise<void> };
async function fixture(options: Options, work: (f: Scene) => Promise<void>, source = raw) {
  GlobalRegistrator.register({ url: 'http://localhost/', width: options.phone ? 390 : 1200 });
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const dm = { id: 'conversation', otherUser: { id: 'peer', username: 'peer', displayName: 'Имя1', avatarUrl: null },
    ...(options.kind === 'saved' ? { saved: true } : {}),
    ...(options.kind === 'group' || options.kind === 'former' ? { group: { title: 'Группа1', members: [] } } : {}) } as DmChannel;
  let snapshot: UserLastSeen = { userId: 'peer', online: false, exact: false, at: null, approx: 'recently', byMe: false,
    ...(options.canMessage !== undefined ? { canMessage: options.canMessage } : {}) };
  const fetches: string[] = [], subs = new Set<() => void>(); let captured: Pane | undefined;
  let state = {
    user: { id: 'me', displayName: 'Имя2', avatarUrl: null, notifyDm: true }, dmMessages: { conversation: [] },
    pushMutedDmUsers: [], pushMuteUntil: {}, pushAlwaysTargets: [], convActive: true,
    serverFeatures: options.noLastSeen ? [shared.FEATURE_MSGPRIV1] : [shared.FEATURE_MSGPRIV1, shared.FEATURE_LASTSEEN1],
    conv: { summaries: options.kind === 'former' ? { conversation: { former: { removed: false } } } : {}, windows: {}, gone: {} },
    outbox: {}, drafts: {}, draftRev: {}, places: {}, dms: [dm], historyFailed: [],
    blockedUsers: options.kind === 'blocked' ? [{ id: 'peer' }] : [], onlineUsers: [], dmOnlineUsers: [], dmAwayUsers: [], lastSeenEpoch: 0,
  };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => React.useSyncExternalStore(
    notify => { subs.add(notify); return () => subs.delete(notify); }, () => select(state)), { getState: () => state });
  const useDmStickers = Object.assign((select: (s: { mine: never[]; recent: never[] }) => unknown) => select({ mine: [], recent: [] }), { getState: unused });
  const useCall = Object.assign((select: (s: { call: null }) => unknown) => select({ call: null }), { getState: unused });
  const api = { userLastSeen: async (id: string) => { fetches.push(id); if (options.failedSnapshot) throw new Error('snapshot-failed'); return snapshot; } };
  const common = { react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': jsx };
  const platform = { isMobile: () => false, isAndroid: () => false, isTauri: () => false };
  const phone = load<typeof import('../phoneLayout')>(read('../phoneLayout.ts'), { ...common, './hotkeys': platform });
  const online = load<typeof import('../dmOnline')>(read('../dmOnline.ts'), { ...common, '@gusvoice/shared': shared, './api': { api }, './store': { useStore } });
  const seen = load<typeof import('../useLastSeen')>(read('../useLastSeen.ts'), { ...common, './api': { api }, './dmOnline': online,
    './lastSeenText': lastSeenText, './store': { useStore } });
  const fit = load<typeof import('../statusFit')>(read('../statusFit.ts'), { ...common, './lastSeenText': lastSeenText });
  const contacts = { useContactList: () => [], useContacts: { getState: unused } };
  const names = load<typeof import('../peerName')>(read('../peerName.ts'), { ...common, './contactRules': contactRules, './contacts': contacts,
    './config': { activeInstanceId: () => 'instance-test' }, './store': { useStore } });
  const icon = load<typeof import('./Icon')>(read('./Icon.tsx'), common);
  const status = load<typeof import('./StatusDot')>(read('./StatusDot.tsx'), common);
  const lite = load<typeof import('../liteMode')>(read('../liteMode.ts'), common);
  const avatar = load<typeof import('./Avatar')>(read('./Avatar.tsx'), { ...common, '../liteMode': lite,
    '../windowCovered': { useWindowMotion: () => ({ covered: false, gameFg: false }) },
    '../firstFrame': { useFirstFrame: (url: string | null) => { assert.equal(url, null); return null; } } });
  const saved = load<typeof import('./SavedAvatar')>(read('./SavedAvatar.tsx'), { ...common, './Goose': { Goose: unused } });
  const sidebarDeps: Record<string, unknown> = { ...common, '../dmListRules': listRules };
  // Из целого DmSidebar выполняется только настоящий useMuteClock; другие экспорты не монтируются.
  for (const id of ['../api', '../hotkeys', '../store', '../dmOnline', '../useContactSeen', '../toast', '../dialogChrome', '../dmRules',
    '../channelRules', '../chatKeysRules', '../convSyncRules', '../dmArchiveRules', '../dmCompose', '../dmRowRules', '../phoneLayout',
    '../typing', '../androidBack', '../connState', './Avatar', '../contactRules', '../contacts', '../peerName', './SavedAvatar',
    './GroupDialogs', '../groupChatRules', './DmRowMenu', './DmFolderBar', '../dmFolderView', '../dmFolders', '../cornerButtonsRules',
    '../dmListSearchRules', './DmServerSearch', './DmAllSearch', './DmListSearch', './DmArchive', '../dragOut', '../dmListView',
    '../uiPrefs', '../filesDrop', './DmListSwipe', './DmPinDrag', '../chatSwipe', './BottomSheet', './Goose', './Icon', './SelfVoiceBar',
    './SettingsShell', './SharedMedia', './StatusDot', './VoicePanel', '../voiceDrafts']) sidebarDeps[id] = {};
  const sidebar = load<typeof import('./DmSidebar')>(read('./DmSidebar.tsx'), sidebarDeps);
  const deps = { ...common, '../dmStickerRules': stickerRules, '../dmStickers': { useDmStickers }, './StickerCatalogPanel': { StickerCatalogPanel: unused },
    '../channelVisit': { useChannelVisit: () => ({ newSince: null, readKey: 0, visitKey: 'visit', started: true }) },
    '../api': { api }, '../effectsBus': { fireEffect: unused }, '../chatSearchRules': { SEARCH_PAGE: 50 }, '../confirm': { confirmAction: unused },
    '../strangerBarRules': strangerRules, '../contactRules': contactRules, '../contacts': contacts, '../peerName': names,
    '../connState': { useConnState: () => null, connLabel: () => null }, '../sockets': { sendTyping: unused },
    '../notifications': { clearOsNotifications: () => {} }, '../store': { useStore },
    '../toast': { toast: unused, toastError: unused, useToasts: { getState: unused } },
    '../typing': { useTyping: () => [], useTypingAction: () => null, typingActionLabel: () => '' },
    './Avatar': avatar, '../callStore': { useCall, explainCallPrivacy: unused }, '../callView': callRules,
    './StrangerBar': { StrangerBar: unused, StrangerReportModal: unused }, './ContactEditModal': { removeContactAsk: unused },
    './ContextMenu': { ContextMenu: unused, MenuItem: unused, MenuDivider: unused },
    './dmClearActions': { clearHistory: unused, deleteChat: unused, deleteFormerGroup: unused }, './DmSidebar': sidebar,
    './FeedLoadError': { FeedLoadError: unused }, './Icon': icon, './DmArchive': { archiveDms: unused }, '../dmArchiveRules': archiveRules,
    './DesktopKeys': { CHAT_MENU_EVENT: 'privacy-test-menu' }, './UserContextMenu': { useUserMenu: () => ({ openAt: unused, menu: null }) },
    // Прозрачная UI-граница не вычисляет запрет: JSX ниже построен только настоящим DmChatView.
    './MessagePane': { MessagePane: (props: Pane) => { captured = props; return React.createElement('div', null,
      React.createElement('header', null, props.title, props.headerActions), props.composerNotice, props.composerReplacement); } },
    './ScheduledView': { ScheduledView: unused }, './StatusDot': status, '../useLastSeen': seen, '../dmOnline': online,
    '../lastSeenText': lastSeenText, '../statusFit': fit, './SavedAvatar': saved, '../groupChatRules': groupRules,
    './GroupDialogs': { leaveGroup: unused, openGroupInfo: unused }, '../clientId': { newClientId: unused }, '../convStore': { toOutboxRef: unused },
    '../convSyncRules': convRules, '../notifyExceptionsRules': notifyRules, '../dmListRules': listRules,
    '../muteRecent': { loadMuteRecent: () => [], saveMuteRecent: unused }, '../phoneLayout': phone };
  try {
    const component = load<typeof import('./DmChatView')>(source, deps);
    await React.act(async () => { root.render(React.createElement(component.DmChatView, { dm })); });
    // Реальный useLastSeen ждёт таймер перед API: здесь проходит настоящий запрос, не подмена результата хука.
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    assert.ok(captured, 'целый DmChatView передал props границе');
    await work({ host, fetches, pane: () => captured!, async change(value) {
      snapshot = { ...snapshot, canMessage: value };
      await React.act(async () => { state = { ...state, lastSeenEpoch: state.lastSeenEpoch + 1 }; for (const notify of subs) notify(); });
      await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    } });
  } finally {
    await React.act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister();
    if (prior) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', prior); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}
function privacyNodes(host: HTMLElement) {
  return [...host.querySelectorAll('.composer-blocked')].filter(node => node.textContent?.includes('принимает сообщения только от своих контактов.'));
}
async function denied(source = raw, phone = false) {
  await fixture({ canMessage: false, phone }, async f => {
    assert.equal(privacyNodes(f.host).length, 1, 'R212-chat-denied: ровно одна плашка при canMessage false');
    assert.equal(privacyNodes(f.host)[0].textContent, plate, 'R212-chat-name: отказ называет собеседника');
    assert.equal(privacyNodes(f.host)[0].getAttribute('role'), 'status');
    assert.ok(privacyNodes(f.host)[0].querySelector('svg'), 'настоящая плашка имеет замок');
    assert.equal(JSON.stringify(f.fetches), '["peer"]'); assert.ok(f.pane().composerReplacement);
  }, source);
}
async function allowed(source = raw) {
  await fixture({ canMessage: true }, async f => {
    assert.equal(privacyNodes(f.host).length, 0, 'R212-chat-allowed: разрешённая отправка не получает плашку отказа');
    assert.equal(f.pane().composerReplacement, undefined); assert.equal(JSON.stringify(f.fetches), '["peer"]');
  }, source);
}
for (const phone of [false, true]) it(`R212 ${phone ? 'телефон' : 'ПК'}: canMessage false заменяет ввод плашкой с именем`, () => denied(raw, phone));
it('R212 canMessage true сохраняет обычный ввод без плашки приватности', () => allowed());
it('R212 отсутствующий canMessage у старого ответа не означает запрет сообщений', async () => {
  await fixture({}, async f => { assert.equal(privacyNodes(f.host).length, 0); assert.equal(f.pane().composerReplacement, undefined); assert.equal(f.fetches.length, 1); });
});
it('R212 сервер без lastseen1 не запрашивает снимок и не выдумывает запрет', async () => {
  await fixture({ noLastSeen: true, canMessage: false }, async f => { assert.equal(privacyNodes(f.host).length, 0); assert.equal(f.fetches.length, 0); });
});
it('R212 ошибка last-seen не превращается в отказ сообщений', async () => {
  await fixture({ failedSnapshot: true }, async f => { assert.equal(privacyNodes(f.host).length, 0); assert.equal(f.pane().composerReplacement, undefined); });
});
for (const kind of ['group', 'saved', 'blocked', 'former'] as const) it(`R212 ${kind}: плашка приватности 1:1 не перекрывает собственное состояние`, async () => {
  await fixture({ kind, canMessage: false }, async f => {
    assert.equal(privacyNodes(f.host).length, 0);
    assert.equal(f.fetches.length, kind === 'blocked' ? 1 : 0, 'группа и Избранное не спрашивают снимок человека');
    if (kind === 'blocked') assert.equal(f.host.querySelector('.composer-blocked')?.textContent, 'Вы заблокировали Имя1.Разблокировать');
    else if (kind === 'former') assert.equal(f.host.querySelector('.composer-blocked')?.textContent, 'Вы покинули группу.Удалить группу');
    else assert.equal(f.pane().composerReplacement, undefined);
  });
});
it('R212 новый разрешающий снимок снимает плашку, новый запрещающий возвращает её', async () => {
  await fixture({ canMessage: false }, async f => {
    assert.equal(privacyNodes(f.host).length, 1); await f.change(true);
    assert.equal(privacyNodes(f.host).length, 0); assert.equal(f.pane().composerReplacement, undefined);
    await f.change(false); assert.equal(privacyNodes(f.host).length, 1); assert.equal(f.fetches.length, 3);
  });
});
const deniedLine = 'const messagesDenied = !group && !saved && !former && !blocked && lastSeen?.canMessage === false;';
for (const [label, from, to, scenario, prefix, actual, expected] of [
  ['запрет проигнорирован', deniedLine, 'const messagesDenied = false;', denied, 'R212-chat-denied:', 0, 1],
  ['разрешающий снимок считается запретом', 'lastSeen?.canMessage === false;', 'lastSeen?.canMessage === true;', allowed, 'R212-chat-allowed:', 1, 0],
  ['плашка называет не собеседника', 'messagePrivacyPlateText(peerName)', "messagePrivacyPlateText('Имя2')", denied,
    'R212-chat-name:', 'Имя2 принимает сообщения только от своих контактов.', plate],
] as const) it(`R212 DOM контрфакт: ${label}`, async () => {
  await scenario(raw); assert.equal(raw.split(from).length - 1, 1, 'один якорь в целом DmChatView');
  await assert.rejects(scenario(raw.replace(from, to)), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith(prefix) && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected);
});
function all<T extends ts.Node>(node: ts.Node, guard: (n: ts.Node) => n is T): T[] {
  const list: T[] = []; const visit = (n: ts.Node) => { if (guard(n)) list.push(n); ts.forEachChild(n, visit); }; visit(node); return list;
}
const compact = (n: ts.Node | undefined, sf: ts.SourceFile) => n?.getText(sf).replace(/\s/g, '') ?? '';
function guard(source = raw) {
  const sf = ts.createSourceFile('DmChatView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = all(sf, ts.isVariableDeclaration).filter(n => ts.isIdentifier(n.name) && n.name.text === 'messagesDenied');
  assert.equal(declarations.length, 1, 'единственная настоящая декларация messagesDenied');
  assert.equal(compact(declarations[0].initializer, sf), '!group&&!saved&&!former&&!blocked&&lastSeen?.canMessage===false',
    'R212-chat-guard: запрет 1:1 исключает группу, Избранное, бывшего и заблокированного');
}
function replacement(source = paneRaw) {
  const sf = ts.createSourceFile('MessagePane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes = all(sf, ts.isBinaryExpression).filter(n => ts.isIdentifier(n.left) && n.left.text === 'composerReplacement'
    && ts.isParenthesizedExpression(n.right) && ts.isJsxElement(n.right.expression) && n.right.expression.openingElement.tagName.getText(sf) === 'form');
  assert.equal(nodes.length, 1, 'единственное поле form в ветке composerReplacement');
  assert.equal(nodes[0].operatorToken.getText(sf), '??', 'R212-pane-replacement: настоящая плашка заменяет поле, а отсутствие плашки оставляет form');
}
it('R212 AST запрет сообщений адресован только доступной незаблокированной 1:1', () => guard());
it('R212 AST настоящий MessagePane заменяет поле composerReplacement и сохраняет ввод без неё', () => replacement());
for (const field of ['group', 'saved', 'former', 'blocked']) it(`R212 AST контрфакт: убран отдельный запрет ${field}`, () => {
  guard(); assert.equal(raw.split(deniedLine).length - 1, 1);
  const changed = raw.replace(deniedLine, deniedLine.replace(`!${field} && `, ''));
  const expected = '!group&&!saved&&!former&&!blocked&&lastSeen?.canMessage===false';
  const actual = expected.replace(`!${field}&&`, '');
  assert.throws(() => guard(changed), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith('R212-chat-guard:') && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected);
});
it('R212 AST контрфакт: плашка ошибочно соединена с полем вместо замены', () => {
  replacement(); const from = '(composerReplacement ?? ('; assert.equal(paneRaw.split(from).length - 1, 1);
  assert.throws(() => replacement(paneRaw.replace(from, '(composerReplacement && (')), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith('R212-pane-replacement:') && error.operator === 'strictEqual' && error.actual === '&&' && error.expected === '??');
});
