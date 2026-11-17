import assert from 'node:assert/strict';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, it } from 'node:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { createStore } from 'zustand/vanilla';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as channelRules from './channelRules';
import * as dmRules from './dmListRules';
import * as serverRows from './serverRowRules';
import * as gatewaySubs from './gatewaySubs';

// Класс регрессии R345: браузер телефона не isMobile(), но скрытая списком лента не прочитана.
const files = {
  store: readFileSync(new URL('./store.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n'),
  sockets: readFileSync(new URL('./sockets.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n'),
  visit: readFileSync(new URL('./channelVisit.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n'),
  sidebar: readFileSync(new URL('./components/DmSidebar.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n'),
};
const PHONE = "return isMobile() || (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches);";
const PREFIX = 'R345 phone panes: ';
const noop = () => {};
type Screen = { width: number; native?: boolean; tauri?: boolean };
const screens: Screen[] = [
  { width: 760 }, { width: 384 }, { width: 761 }, { width: 1280 },
  { width: 1280, native: true }, { width: 384, tauri: true },
];
const phone = (s: Screen) => !!s.native || s.width <= 760;
function setup(ok: unknown, message: string): asserts ok { assert.ok(ok, `R345 setup: ${message}`); }
function edit(raw: string, from: string, to: string): string {
  assert.equal(raw.split(from).length - 1, 1, `R345 setup: единственный адресный якорь ${from}`);
  return raw.replace(from, to);
}
const oldPhone = (raw: string) => edit(raw, PHONE, 'return isMobile();');
function parsed(raw: string, tsx = false) {
  return ts.createSourceFile(tsx ? 'DmSidebar.tsx' : 'module.ts', raw, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function nodes(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const walk = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, walk); };
  walk(root); return found;
}
function functionText(raw: string, name: string): string {
  const ast = parsed(raw);
  const found = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.equal(found.length, 1, `R345 setup: целая функция ${name}`);
  return found[0].getText(ast);
}
function compile(raw: string, globals: Record<string, unknown>, deps: Record<string, unknown>, tsx = false): any {
  const module = { exports: {} };
  const code = ts.transpileModule(raw, { fileName: tsx ? 'DmSidebar.tsx' : 'module.ts', compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  runInNewContext(code, { module, exports: module.exports, ...globals,
    require(id: string) { setup(Object.hasOwn(deps, id), `закрытый импорт ${id}`); return deps[id]; },
  }, { timeout: 2000 });
  return module.exports;
}
function screenWindow(s: Screen) {
  return { addEventListener: noop, removeEventListener: noop,
    ...(s.tauri || s.native ? { __TAURI_INTERNALS__: {} } : {}),
    matchMedia(query: string) { assert.equal(query, '(max-width: 760px)', 'R345 setup: та же граница, что CSS'); return { matches: s.width <= 760 }; },
  };
}
function addressed(error: unknown): boolean {
  return error instanceof assert.AssertionError && error.message.startsWith(PREFIX);
}
function paired(title: string, raw: string, mutant: (value: string) => string, check: (value: string) => void) {
  it(`R345 ${title}`, () => { check(raw); counterfact(() => { assert.throws(() => check(mutant(raw)), addressed); }); check(raw); });
}
function pairedAsync(title: string, raw: string, mutant: (value: string) => string, check: (value: string) => Promise<void>) {
  it(`R345 ${title}`, async () => { await check(raw); await counterfact(async () => { await assert.rejects(check(mutant(raw)), addressed); }); await check(raw); });
}

// Store слишком велик для этого узкого сценария: берём AST-узлы ЦЕЛЫХ action-стрелок,
// не регулярку тела и не его переписанную копию. Ветви внутри action остаются неизменны.
function storeAction(raw: string, name: string, screen: Screen, initial: Record<string, any>) {
  const ast = parsed(raw);
  const candidates = nodes(ast, n => ts.isPropertyAssignment(n) && n.name.getText(ast) === name);
  assert.equal(candidates.length, 1, `R345 setup: настоящий action ${name}`);
  const property = candidates[0] as ts.PropertyAssignment;
  setup(ts.isArrowFunction(property.initializer), 'action задан полной стрелкой');
  const calls: string[] = [], marks: [string, number | undefined][] = [];
  let state: Record<string, any> = { leaveGuard: null, feedDownAsk: null,
    readDmNow: (id: string) => calls.push(`read:${id}`),
    convEnsureList: async () => { calls.push('ensure'); },
    refreshDmHistory: async (id: string) => { calls.push(`history:${id}`); },
    ...initial };
  const get = () => state;
  const set = (patch: object | ((value: typeof state) => object)) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  };
  const body = `${functionText(raw, 'phonePanes')}\nexport function actions(get: any, set: any) { return { ${property.getText(ast)} }; }`;
  const loaded = compile(body, { window: screenWindow(screen),
    isMobile: () => !!screen.native, isFeedOnScreen: channelRules.isFeedOnScreen,
    markChannelSeen: (id: string, at?: number) => marks.push([id, at]),
    publishTabEvent: (value: { kind: string }) => calls.push(value.kind),
    activeInstanceId: () => null, rememberPlace: noop,
  }, {});
  return { action: loaded.actions(get, set)[name] as (...args: any[]) => any, get, calls, marks };
}

paired('прочитанное с другого устройства двигает метку только скрытой списком ленты, не видимой', files.store, oldPhone, raw => {
  for (const s of screens) for (const pane of ['list', 'content'] as const) {
    const f = storeAction(raw, 'applyRemoteRead', s, { currentChannelId: 'channel', mobilePane: pane, view: 'server',
      mentionCounts: { channel: 1 }, unreadCounts: { channel: 4 }, mentionServers: {}, unreadServers: {} });
    f.action({ channelId: 'channel', at: '2026-10-29T12:00:00.000Z' });
    assert.equal(f.marks.length, phone(s) && pane === 'list' ? 1 : 0,
      PREFIX + 'скрытая лента получает метку удалённого чтения, видимая сохраняет черту');
    assert.equal(Object.hasOwn(f.get().unreadCounts, 'channel'), false, 'реальный action всё равно гасит общий счётчик');
    if (f.marks.length) assert.equal(f.marks[0][1], Date.parse('2026-10-29T12:00:00.000Z'));
  }
});

pairedAsync('выбор беседы из телефонного списка открывает историю, повторный выбор видимой не пересобирает окно', files.store, oldPhone, async raw => {
  for (const s of screens) for (const pane of ['list', 'content'] as const) {
    const f = storeAction(raw, 'selectDm', s, { currentDmId: 'dm', mobilePane: pane, view: 'dm',
      convActive: true, dmMessages: { dm: [] }, conv: { windows: { dm: { stale: false } } },
      unreadDms: ['dm'], dms: [{ id: 'dm', unread: 4 }] });
    await f.action('dm');
    const hidden = phone(s) && pane === 'list';
    assert.equal(f.calls.includes('history:dm'), hidden,
      PREFIX + 'возврат из списка является открытием, а не повторным кликом видимой беседы');
    assert.equal(f.calls.includes('ensure'), !hidden, 'видимая беседа только догоняет список');
    assert.equal(!!f.get().feedDownAsk, !hidden, 'прыжок в конец только при повторном выборе видимой');
    assert.equal(f.get().mobilePane, 'content', 'действие выбора действительно открывает экран беседы');
    assert.equal(f.get().currentDmId, 'dm');
    assert.equal(f.get().dms[0].unread, 0);
  }
});

function socketFixture(raw: string, s: Screen, pane: 'list' | 'content', kind: 'channel' | 'dm') {
  const calls: string[] = [], unread: boolean[] = [], timers = new Map<number, { fn: () => void; ms: number }>();
  let timer = 0;
  const sockets: Socket[] = [];
  const state = { user: { id: 'me', username: 'me' }, currentChannelId: 'channel', currentDmId: 'dm', mobilePane: pane,
    view: kind === 'channel' ? 'server' : 'dm', serverFeatures: [], servers: [], voice: null,
    bootstrap: { server: { id: 'server' }, member: { roleIds: [] }, channels: [{ id: 'channel', name: 'Канал' }] },
    convActive: true, pushMutedDmUsers: [], pushMuteUntil: {},
    markUnread: () => calls.push('unread-channel'), appendMessage: () => calls.push('append'),
    convReadNow: () => calls.push('read-dm'), convOnChange: (_m: unknown, count: boolean) => unread.push(count),
    setActivities: noop, resyncAfterReconnect: async () => {}, rejoinVoiceAfterOutage: async () => {},
  };
  class Socket {
    static OPEN = 1; static CONNECTING = 0; readyState = 0;
    onopen?: () => void; onmessage?: (event: { data: string }) => void;
    constructor(_url: string) { sockets.push(this); }
    close() { this.readyState = 3; } send(_data: string) {}
    receive(value: unknown) { setup(this.onmessage, 'настоящий socket.onmessage'); this.onmessage({ data: JSON.stringify(value) }); }
  }
  const deps: Record<string, unknown> = Object.fromEntries(['./coinsCue', './memberName', './coinNotifyRules', './dmStickers',
    './dmFolders', './contacts', './savedGifs', './effectsBus', './effectsDom', './tipMode', './toast'].map(id => [id, {}]));
  Object.assign(deps, {
    '@gusvoice/shared': shared, './gatewaySubs': gatewaySubs, './channelRules': channelRules, './dmListRules': dmRules,
    './serverRowRules': serverRows, './readByView': { feedCovered: () => false },
    './store': { useStore: { getState: () => state, subscribe: () => noop, setState: (p: object) => Object.assign(state, p) } },
    './api': { getToken: () => 'synthetic-unused', api: { listServers: async () => [], getActivities: async () => ({ activities: {} }),
      markChannelRead: async () => { calls.push('read-channel'); } } },
    './config': { config: {}, gatewayWsUrl: () => 'ws://localhost/synthetic' },
    './connState': { resetGatewayLive: noop, setGatewayLive: noop },
    './presenceVisibility': { presentNow: () => true, watchPresence: noop }, './bgGateways': { setBgPresent: noop },
    './channelPrefs': { notifyLevel: () => 'all' }, './hotkeys': { isMobile: () => !!s.native },
    './notifications': { setNotifyPrefs: noop, windowFocused: () => true, osNotifyLevel: () => 'none',
      osNotify: noop, osNotifyRaw: noop, authorName: () => 'Собеседник', messagePreview: () => 'Сообщение',
      popupPreview: () => 'Сообщение', channelNoticeGroup: () => 'channel', clearOsNotifications: noop },
    './notifyRules': { shouldOsNotify: () => false, passesThrottle: () => false }, './peerName': { peerNameNow: () => 'Собеседник' },
    './typing': { dropTyping: noop }, './dmOnline': { noteDmActivity: noop, clearDmActivity: noop },
    './flashWindow': { flashWindow: noop }, './sounds': { playSound: noop },
    './socketHealth': { CONNECT_TIMEOUT_MS: 15000, PING_MS: 25000, socketStale: () => false },
    './callStore': {}, './callView': { serverCalls: () => false }, './convSyncRules': { serverPush2: () => false },
    './economyClient': { ensureEconomy: noop, ensureWheel: noop, ensureDuel: noop, ensurePredictions: noop },
  });
  const loaded = compile(raw, { window: screenWindow(s), document: { addEventListener: noop }, WebSocket: Socket,
    setTimeout(fn: () => void, ms: number) { const id = ++timer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id: number) { timers.delete(id); }, setInterval: () => ++timer, clearInterval: noop,
  }, deps);
  loaded.connectGateway();
  setup(sockets[0]?.onopen, 'настоящий socket.onopen');
  sockets[0].readyState = 1; sockets[0].onopen();
  return { socket: sockets[0], calls, unread,
    flushReads() { for (const [id, value] of [...timers]) if (value.ms === 2000) { timers.delete(id); value.fn(); } } };
}
const message = { id: 'message', author: { id: 'peer', username: 'peer', displayName: 'Собеседник', avatarUrl: null },
  content: 'обычное сообщение', createdAt: '2026-10-29T12:00:00.000Z', attachments: [] };
for (const kind of ['channel', 'dm'] as const) {
  paired(`настоящий шлюз ${kind === 'channel' ? 'канала' : 'ЛС'} не отправляет прочитано за скрытую списком ленту`, files.sockets, oldPhone, raw => {
    for (const s of screens) for (const pane of ['list', 'content'] as const) {
      const f = socketFixture(raw, s, pane, kind);
      f.socket.receive(kind === 'channel' ? { t: 'message.create', channelId: 'channel', serverId: 'server', message }
        : { t: 'conv.change', conversation: { id: 'dm', kind: 'direct', otherUser: { id: 'peer' } }, message, created: true, pts: 1 });
      f.flushReads();
      const hidden = phone(s) && pane === 'list';
      assert.equal(f.calls.includes(kind === 'channel' ? 'read-channel' : 'read-dm'), !hidden,
        PREFIX + 'прочитано уходит только за действительно открытую ленту');
      assert.equal(kind === 'channel' ? f.calls.includes('unread-channel') : f.unread[0], hidden,
        PREFIX + 'сообщение скрытой ленты остаётся непрочитанным');
      if (kind === 'channel') assert.equal(f.calls.includes('append'), true, 'скрытый канал всё равно получает сообщение в кеш');
    }
  });
}

const originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
before(() => { GlobalRegistrator.register(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(() => {
  GlobalRegistrator.unregister();
  if (originalActEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
  else delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
async function visitScenario(raw: string, kind: 'channel' | 'dm') {
  for (const s of screens) for (const pane of ['list', 'content'] as const) {
    const previous = window.matchMedia;
    window.matchMedia = screenWindow(s).matchMedia as typeof window.matchMedia;
    const calls: string[] = [];
    const store = createStore(() => ({ mobilePane: pane as 'list' | 'content',
      readChannelNow: (id: string) => calls.push(`channel:${id}`), readDmNow: (id: string) => calls.push(`dm:${id}`),
      conv: { summaries: { feed: { lastReadKey: 17 } } } }));
    const useStore = Object.assign((select: (value: ReturnType<typeof store.getState>) => unknown) =>
      React.useSyncExternalStore(store.subscribe, () => select(store.getState())),
    { getState: store.getState, subscribe: store.subscribe });
    const loaded = compile(raw, { window, document }, { react: React, './store': { useStore },
      './channelPrefs': { lastSeenAt: () => 123, markChannelSeen: () => calls.push('seen') },
      './hotkeys': { isMobile: () => !!s.native }, './notifications': { windowFocused: () => true } });
    let latest: ReturnType<typeof import('./channelVisit').useChannelVisit> | undefined;
    function Viewer() { latest = loaded.useChannelVisit('feed', kind); return null; }
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    try {
      await React.act(async () => { root.render(React.createElement(Viewer)); });
      setup(latest, 'настоящий useChannelVisit отрисован');
      const hidden = phone(s) && pane === 'list';
      assert.equal(latest.started, !hidden, PREFIX + 'скрытая списком лента не начинает визит');
      const beforeFocus = calls.length;
      await React.act(async () => { window.dispatchEvent(new Event('focus')); });
      assert.equal(calls.length-beforeFocus, hidden ? 0 : 1, PREFIX + 'focus не читает ленту под списком');
      if (hidden) {
        assert.equal(latest.readKey, null, 'до открытия нет снимка прочитанного');
        await React.act(async () => { store.setState({ mobilePane: 'content' }); });
        assert.equal(latest.started, true, 'переход к содержимому начинает настоящий визит');
        if (kind === 'dm') assert.equal(latest.readKey, 17);
        await React.act(async () => { store.setState({ mobilePane: 'list' }); });
        const afterLeave = calls.length;
        await React.act(async () => { window.dispatchEvent(new Event('focus')); });
        assert.equal(calls.length, afterLeave, PREFIX + 'после ухода в список обработчик focus снят');
      }
    } finally { await React.act(async () => root.unmount()); host.remove(); window.matchMedia = previous; }
  }
}
for (const kind of ['channel', 'dm'] as const) {
  pairedAsync(`визит ${kind === 'channel' ? 'канала' : 'ЛС'} начинается при показе content, а не монтировании под списком`,
    files.visit, oldPhone, raw => visitScenario(raw, kind));
}

function sidebarDeclarations(raw: string) {
  const ast = parsed(raw, true);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'DmSidebar');
  setup(fn && ts.isFunctionDeclaration(fn) && fn.body, 'настоящая функция DmSidebar');
  const declarations = fn.body.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []);
  const get = (name: string) => {
    const found = declarations.find(n => ts.isIdentifier(n.name) && n.name.text === name)?.initializer;
    setup(found, `настоящая декларация DmSidebar.${name}`); return found;
  };
  return { ast, fn, get };
}
paired('список ЛС связывает видимую беседу с раскладкой, а не только с признаком нативного телефона', files.sidebar,
  raw => edit(raw, 'const mobile = isMobile() || phone;', 'const mobile = isMobile();'), raw => {
    const f = sidebarDeclarations(raw);
    assert.equal(f.get('phone').getText(f.ast), 'usePhoneLayout()', PREFIX + 'ширина взята из настоящего хука раскладки');
    const mobile = f.get('mobile');
    assert.equal(ts.isBinaryExpression(mobile) && mobile.operatorToken.kind === ts.SyntaxKind.BarBarToken
      && mobile.left.getText(f.ast) === 'isMobile()' && mobile.right.getText(f.ast) === 'phone', true,
    PREFIX + 'список ЛС сохраняет объединение native и ширины');
    const shown = f.get('shownDmId');
    setup(ts.isConditionalExpression(shown), 'shownDmId задан условием, не примером в комментарии');
    const calls = nodes(shown.condition, n => ts.isCallExpression(n) && n.expression.getText(f.ast) === 'isFeedOnScreen');
    assert.equal(calls.length, 1, PREFIX + 'выбранная беседа проходит реальный гейт видимости');
    const arg = (calls[0] as ts.CallExpression).arguments[0];
    assert.equal(ts.isObjectLiteralExpression(arg) && arg.properties.some(n => ts.isShorthandPropertyAssignment(n) && n.name.text === 'mobile')
      && arg.properties.some(n => ts.isShorthandPropertyAssignment(n) && n.name.text === 'mobilePane'), true,
    PREFIX + 'потребитель передаёт mobile и состояние экрана, не одну текущую беседу');
  });

paired('счётчики настоящей карты строк ЛС скрываются по shownDmId, а не по скрытой текущей беседе', files.sidebar,
  raw => edit(raw, 'const counted = unreadDms.includes(d.id) && d.id !== shownDmId;', 'const counted = unreadDms.includes(d.id) && d.id !== currentDmId;'), raw => {
    const f = sidebarDeclarations(raw);
    const maps = nodes(f.fn, n => ts.isCallExpression(n) && n.expression.getText(f.ast) === 'listRows.map');
    assert.equal(maps.length, 1, 'R345 setup: единственная карта реальных строк');
    const callback = (maps[0] as ts.CallExpression).arguments[0];
    setup(ts.isArrowFunction(callback) && ts.isBlock(callback.body), 'карта имеет целый callback');
    const counted = callback.body.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : [])
      .find(n => ts.isIdentifier(n.name) && n.name.text === 'counted')?.initializer;
    assert.equal(counted?.getText(f.ast), 'unreadDms.includes(d.id) && d.id !== shownDmId',
      PREFIX + 'непрочитанное скрывает только действительно показанная беседа');
    const rows = nodes(callback.body, n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(f.ast) === 'DmRow');
    assert.equal(rows.length, 1, 'R345 setup: карта действительно рисует DmRow');
    for (const name of ['unread', 'unreadN']) {
      const attr = (rows[0] as ts.JsxSelfClosingElement).attributes.properties.find(n => ts.isJsxAttribute(n) && n.name.getText(f.ast) === name);
      assert.equal(!!attr && ts.isJsxAttribute(attr) && !!attr.initializer && ts.isJsxExpression(attr.initializer)
        && attr.initializer.expression?.getText(f.ast) === name, true, PREFIX + 'DmRow получает вычисленный счётчик');
    }
  });
