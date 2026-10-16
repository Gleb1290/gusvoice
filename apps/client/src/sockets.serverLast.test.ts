import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as channel from './channelRules';
import * as last from './serverRowRules';
import * as subs from './gatewaySubs';

const source = readFileSync(new URL('./sockets.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const storeSource = readFileSync(new URL('./store.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const noop = () => {};
function fixture(raw = source) {
  const sockets: Socket[] = [], appended: string[] = [], updated: string[] = [], removed: string[] = [];
  let patches = 0, loads = 0, resyncs = 0;
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 1; onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: string }) => void;
    constructor(_url: string) { sockets.push(this); }
    send(_frame: string) {} close() { this.readyState = 3; }
    receive(value: unknown) { assert.ok(this.onmessage); this.onmessage({ data: JSON.stringify(value) }); }
  }
  const state = {
    user: { id: 'me', username: 'dmtest_a', status: 'online' }, serverFeatures: [], convActive: false,
    currentChannelId: null, currentServerId: null, mobilePane: 'list', view: 'dm',
    bootstrap: { channels: [{ id: 'ch', name: 'general' }] },
    servers: [{ id: 'a', lastMessage: null }, { id: 'b', lastMessage: null }, { id: 'legacy' }] as Array<{ id: string; lastMessage?: shared.ServerLastMessage | null }>,
    appendMessage: (id: string, m: shared.Message) => { appended.push(`${id}:${m.id}`); },
    updateMessage: (id: string, m: shared.Message) => { updated.push(`${id}:${m.id}`); },
    removeMessage: (id: string, msgId: string) => { removed.push(`${id}:${msgId}`); },
    loadServers: async () => { loads++; }, resyncAfterReconnect: async () => { resyncs++; },
    rejoinVoiceAfterOutage: async () => {}, setActivities: noop,
  };
  const store = { getState: () => state, setState: (patch: Partial<typeof state>) => { patches++; Object.assign(state, patch); }, subscribe: () => noop };
  const forbidden = (label: string) => () => assert.fail(`сценарий не выполняет ${label}`);
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, './channelRules': channel, './serverRowRules': last, './gatewaySubs': subs,
    './store': { useStore: store, voiceIsHere: forbidden('voiceIsHere') },
    './api': { getToken: () => 'synthetic-token', api: { listServers: async () => state.servers, getActivities: async () => ({ activities: {} }) } },
    './config': { config: {}, gatewayWsUrl: () => 'ws://localhost/gateway' },
    './connState': { resetGatewayLive: noop, setGatewayLive: noop },
    './presenceVisibility': { presentNow: () => true, watchPresence: noop }, './bgGateways': { setBgPresent: noop },
    './notifications': { setNotifyPrefs: noop, clearOsNotifications: noop, windowFocused: () => false,
      osNotifyLevel: () => 'none', authorName: forbidden('authorName'), channelNoticeGroup: forbidden('channelNoticeGroup'),
      coinNotifyLevel: forbidden('coinNotifyLevel'), messagePreview: forbidden('messagePreview'), osNotify: forbidden('osNotify'), osNotifyRaw: forbidden('osNotifyRaw') },
    './channelPrefs': { notifyLevel: () => 'none' }, './hotkeys': { isMobile: () => false },
    './notifyRules': { shouldOsNotify: () => false, passesThrottle: forbidden('passesThrottle') },
    './socketHealth': { CONNECT_TIMEOUT_MS: 15000, PING_MS: 25000, socketStale: () => false },
    './typing': { dropTyping: noop, noteTyping: forbidden('noteTyping') },
    './sounds': { playSound: forbidden('playSound'), playClip: forbidden('playClip') },
    './callStore': { useCall: forbidden('useCall') }, './callView': { serverCalls: () => false },
    './dmStickers': { useDmStickers: forbidden('useDmStickers') }, './dmFolders': { useDmFolders: forbidden('useDmFolders') },
    './peerName': { peerNameNow: forbidden('peerNameNow') }, './contacts': { useContacts: forbidden('useContacts') },
    './savedGifs': { applyRemoteGifs: forbidden('applyRemoteGifs') },
    './dmListRules': Object.fromEntries(['dmIncomingDecision', 'dmMuteOf', 'dmMutedDecision', 'dmSilentDecision', 'muteActive', 'muteSoundOff'].map(k => [k, forbidden(k)])),
    './readByView': { feedCovered: forbidden('feedCovered') }, './coinsCue': { shouldPulseWallet: forbidden('shouldPulseWallet') },
    './economyClient': { ensureEconomy: forbidden('ensureEconomy') }, './memberName': { resolveMemberName: forbidden('resolveMemberName') },
    './flashWindow': { flashWindow: forbidden('flashWindow') }, './coinNotifyRules': { shouldNotifyCoin: forbidden('shouldNotifyCoin') },
    './convSyncRules': { serverPush2: () => false }, './effectsBus': { fireEffect: forbidden('fireEffect') },
    './effectsDom': { pulseChip: forbidden('pulseChip') }, './tipMode': { shouldPlayTipCue: forbidden('shouldPlayTipCue') },
    './toast': { toast: forbidden('toast'), toastError: forbidden('toastError') },
    './dmOnline': { clearDmActivity: forbidden('clearDmActivity'), noteDmActivity: forbidden('noteDmActivity') },
  };
  const module = { exports: {} as typeof import('./sockets') };
  let timer = 0;
  // Целый sockets.ts: только границы транспорта/стора и внешних эффектов подставлены, правила lastMessage настоящие.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, WebSocket: Socket, window: { addEventListener: noop }, document: { addEventListener: noop },
      setTimeout: () => ++timer, clearTimeout: noop, setInterval: () => ++timer, clearInterval: noop,
      require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `описана граница ${id}`); return deps[id]; } });
  module.exports.connectGateway();
  return { module: module.exports, state, sockets, appended, updated, removed, patches: () => patches, loads: () => loads, resyncs: () => resyncs };
}
function message(id = 'm', mine = true, createdAt = '2026-10-12T12:00:00Z'): shared.Message {
  return { id, channelId: 'ch', content: 'Текст', createdAt, editedAt: null, reactions: [], replyTo: null, attachments: [],
    author: { id: mine ? 'me' : 'peer', username: 'dmtest_b', displayName: 'Участник B', avatarUrl: null } };
}
function create(raw = source) {
  for (const mine of [true, false]) {
    const f = fixture(raw); const before = f.state.servers;
    f.sockets[0].receive({ t: 'message.create', channelId: 'ch', serverId: 'b', message: message('m', mine) });
    assert.equal(f.state.servers[1].lastMessage?.id, 'm', 'create обновляет последнее нужного сервера');
    assert.equal(f.state.servers[1].lastMessage?.channelName, 'general'); assert.equal(f.state.servers[1].lastMessage?.authorId, mine ? 'me' : 'peer');
    assert.equal(f.state.servers[0], before[0]); assert.equal(f.state.servers[2], before[2]); assert.equal(f.patches(), 1);
    assert.equal(f.appended.join(','), 'ch:m', 'канальная лента обновляется как прежде');
  }
}
it('R180 настоящее message.create обновляет нужный сервер и свою или чужую ленту, остальные строки сохраняются', () => {
  // Превью собственных сообщений должно обновляться вне ветки чужого автора/уведомлений.
  create();
});
it('R180 create без serverId, для старого бэкенда и более старое сообщение не меняют список серверов', () => {
  // Старый протокол и запоздавшая доставка не должны включать новую строку или отматывать её назад.
  for (const id of [undefined, 'legacy', 'missing', 'b']) {
    const f = fixture(); const before = f.state.servers;
    f.state.servers[1].lastMessage = last.serverLastFromMessage(message('new') as shared.Message, 'ch', 'general');
    f.sockets[0].receive({ t: 'message.create', channelId: 'ch', serverId: id, message: message('old', true, '2026-10-11T12:00:00Z') });
    assert.equal(f.state.servers, before); assert.equal(f.patches(), 0); assert.equal(f.appended.length, 1);
  }
});
function update(raw = source) {
  for (const id of ['last', 'other']) {
    const f = fixture(raw); f.state.servers[1].lastMessage = last.serverLastFromMessage(message('last') as shared.Message, 'original-channel', 'Название');
    const before = f.state.servers;
    f.sockets[0].receive({ t: 'message.update', channelId: 'new-channel', message: { ...message(id, true, '2026-10-13T00:00:00Z'), content: 'Правка' } });
    assert.equal(f.state.servers[1].lastMessage?.text, id === 'last' ? 'Правка' : 'Текст', 'update меняет только последний id');
    assert.equal(f.state.servers[1].lastMessage?.channelId, 'original-channel'); assert.equal(f.state.servers[1].lastMessage?.channelName, 'Название');
    assert.equal(f.state.servers[1].lastMessage?.createdAt, '2026-10-12T12:00:00Z'); assert.equal(f.patches(), id === 'last' ? 1 : 0);
    if (id !== 'last') assert.equal(f.state.servers, before);
    assert.equal(f.updated.join(','), `new-channel:${id}`);
  }
}
it('R180 настоящее message.update меняет текст последнего, сохраняя канал и время, чужой id оставляет массив', () => {
  // Дата правки не должна менять порядок серверов, а правка соседнего сообщения — заменять последнее.
  update();
});
function remove(raw = source) {
  for (const id of ['last', 'other']) {
    const f = fixture(raw); f.state.servers[1].lastMessage = last.serverLastFromMessage(message('last') as shared.Message, 'ch');
    f.sockets[0].receive({ t: 'message.delete', channelId: 'ch', messageId: id });
    assert.equal(f.loads(), id === 'last' ? 1 : 0, 'delete перечитывает серверы только для последнего id');
    assert.equal(f.removed.join(','), `ch:${id}`);
  }
}
it('R180 удаление последнего перечитывает серверы, удаление другого только убирает сообщение из ленты', () => {
  // Предыдущее последнее знает сервер; лишний reload при каждой чужой правке создаёт ненужный трафик.
  remove();
});
it('R180 переподключение вызывает resync, первое соединение не повторяет начальную загрузку', async () => {
  // Проверяется настоящий onopen транспорта; само действие стора отдельно защищено AST ниже.
  const f = fixture(); assert.ok(f.sockets[0].onopen); f.sockets[0].onopen(); assert.equal(f.resyncs(), 0);
  f.module.connectGateway(); assert.ok(f.sockets[1].onopen); f.sockets[1].onopen(); assert.equal(f.resyncs(), 1);
  await Promise.resolve(); await Promise.resolve();
});
function resyncGuard(raw = storeSource) {
  const ast = ts.createSourceFile('store.ts', raw, ts.ScriptTarget.Latest, true);
  const actions: ts.PropertyAssignment[] = [];
  const visit = (node: ts.Node) => { if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'resyncAfterReconnect') actions.push(node); ts.forEachChild(node, visit); }; visit(ast);
  assert.equal(actions.length, 1); const action = actions[0].initializer; assert.equal(ts.isArrowFunction(action), true);
  assert.equal(ts.isBlock((action as ts.ArrowFunction).body), true); const body = (action as ts.ArrowFunction).body as ts.Block;
  // Непосредственный statement, а не вызов только внутри currentServerId-ветки или комментария.
  assert.equal(body.statements.some(n => ts.isExpressionStatement(n) && n.expression.getText(ast) === 'void get().loadServers().catch(() => {})'), true,
    'resync безусловно запрашивает список серверов и поглощает сетевой отказ');
}
it('R180 resyncAfterReconnect запрашивает loadServers вне условия открытого сервера, отказ не ломает остальное', () => {
  // AST целого стора не подменяет action-копией: это страж проводки, не прогон живого API.
  resyncGuard(); const anchor = 'void get().loadServers().catch(() => {});'; assert.equal(storeSource.split(anchor).length - 1, 1);
  assert.throws(() => resyncGuard(storeSource.replace(anchor, '')), assert.AssertionError);
});
for (const [name, anchor, replacement, check, target] of [
  ['нет create превью', 'applyServerMessageCreate(store.servers, msg.serverId, serverLastFromMessage(msg.message, msg.channelId, chName))', 'store.servers', create, 'create обновляет последнее'],
  ['нет update превью', 'applyServerMessageUpdate(store.servers, serverLastFromMessage(msg.message, msg.channelId))', 'store.servers', update, 'update меняет только последний'],
  ['reload при любом delete', 'if (isServerLastMessage(store.servers, msg.messageId)) void store.loadServers();', 'void store.loadServers();', remove, 'delete перечитывает серверы'],
] as const) it(`R180 контрфакт ${name} обнаруживается настоящим обработчиком кадра`, () => {
  // Оригинал перед мутацией; ошибки импортов/VM не заменяют адресную проверку эффекта сообщения.
  check(); assert.equal(source.split(anchor).length - 1, 1);
  assert.throws(() => check(source.replace(anchor, replacement)), e => e instanceof assert.AssertionError && e.message.includes(target));
});
