import assert from 'node:assert/strict';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as subs from './gatewaySubs';
import type { GamesLaunchNotice } from './gamesLaunchRules';

const source = readFileSync(new URL('./sockets.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Edit = { from: string; to: string };
const noop = () => {};
function fixture(edit?: Edit) {
  const notices: GamesLaunchNotice[] = [], sockets: Socket[] = [];
  const state = { user: { id: 'me' } as { id: string } | null, bootstrap: { server: { id: 'open' } },
    serverFeatures: [], convActive: false, voice: null, setActivities: noop,
    resyncAfterReconnect: async () => {}, rejoinVoiceAfterOutage: async () => {},
    setGamesLaunchNotice(value: GamesLaunchNotice) { notices.push(JSON.parse(JSON.stringify(value))); } };
  class Socket {
    static OPEN = 1; static CONNECTING = 0; readyState = 0;
    onopen?: () => void; onclose?: () => void; onmessage?: (event: { data: string }) => void;
    constructor(_url: string) { sockets.push(this); }
    send(_data: string) {} close() { this.readyState = 3; }
    open() { this.readyState = 1; assert.ok(this.onopen, 'R343 setup: настоящий onopen'); this.onopen(); }
    receive(msg: unknown) { assert.ok(this.onmessage, 'R343 setup: настоящий onmessage'); this.onmessage({ data: JSON.stringify(msg) }); }
  }
  const deps: Record<string, unknown> = Object.fromEntries(['./channelRules', './serverRowRules', './dmListRules', './readByView', './coinsCue',
    './memberName', './flashWindow', './coinNotifyRules', './notifyRules', './dmStickers', './dmFolders', './peerName', './contacts', './savedGifs',
    './channelPrefs', './hotkeys', './effectsBus', './effectsDom', './tipMode', './toast', './dmOnline', './typing'].map(id => [id, {}]));
  Object.assign(deps, {
    '@gusvoice/shared': shared, './gatewaySubs': subs, './store': { useStore: { getState: () => state, subscribe: () => noop } },
    './api': { api: { listServers: async () => [], getActivities: async () => ({ activities: {} }) }, getToken: () => 'synthetic-unused' },
    './config': { config: {}, gatewayWsUrl: () => 'ws://localhost/synthetic' }, './connState': { resetGatewayLive: noop, setGatewayLive: noop },
    './presenceVisibility': { presentNow: () => true, watchPresence: noop }, './bgGateways': { setBgPresent: noop },
    './notifications': { setNotifyPrefs: noop, windowFocused: () => false }, './socketHealth': { CONNECT_TIMEOUT_MS: 15000, PING_MS: 25000, socketStale: () => false },
    './callStore': {}, './callView': { serverCalls: () => false }, './convSyncRules': { serverPush2: () => false }, './sounds': { playSound: noop },
    './economyClient': { ensureEconomy: noop, ensureWheel: noop, ensureDuel: noop, ensurePredictions: noop },
  });
  let raw = source;
  if (edit) { assert.equal(raw.split(edit.from).length, 2, 'R343 setup: один адресный якорь полного sockets'); raw = raw.replace(edit.from, edit.to); }
  const module = { exports: {} as typeof import('./sockets') };
  runInNewContext(ts.transpileModule(raw, { fileName: 'sockets.ts', compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, WebSocket: Socket, window: { addEventListener: noop }, document: { addEventListener: noop },
      setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop,
      require(id: string) { assert.ok(Object.hasOwn(deps, id), `R343 setup: закрытый импорт ${id}`); return deps[id]; } }, { timeout: 2000 });
  module.exports.connectGateway(); sockets[0].open();
  return { state, notices, socket: sockets[0] };
}
type Fixture = ReturnType<typeof fixture>;
function paired(title: string, check: (f: Fixture) => void, edits: Edit[]) {
  it(`R343 games.launched: ${title}`, () => {
    check(fixture());
    for (const edit of edits) {
      counterfact(() => { assert.throws(() => check(fixture(edit)), e => e instanceof assert.AssertionError && e.message.startsWith('R343 launch socket:')); });
      check(fixture());
    }
  });
}
const msg = (ids: unknown = ['me'], gift = 500) => ({ t: 'games.launched', serverId: 'source', at: '2026-10-29T12:00:00Z', gift, people: 2, giftedUserIds: ids });
const SET = 'store.setGamesLaunchNotice({ serverId: msg.serverId, at: msg.at, gift: msg.gift, mine });';
paired('получатель видит свой подарок и адрес именно сервера события, не открытого', f => {
  f.socket.receive(msg());
  assert.deepEqual(f.notices, [{ serverId: 'source', at: '2026-10-29T12:00:00Z', gift: 500, mine: 500 }], 'R343 launch socket: адрес, дата и личная сумма дошли в стор');
}, [{ from: SET, to: (counterfact(() => SET.replace('msg.serverId', 'store.bootstrap.server.id')) ?? '') },
  { from: 'Array.isArray(msg.giftedUserIds)', to: 'false' }, { from: SET, to: 'void 0;' }]);
paired('обычный зритель и вышедший пользователь не присваивают чужой подарок', f => {
  f.socket.receive(msg(['other'])); f.state.user = null; f.socket.receive(msg());
  assert.deepEqual(f.notices.map(n => n.mine), [0, 0], 'R343 launch socket: без своей строки подарок нулевой');
}, [{ from: 'msg.giftedUserIds.includes(me)', to: 'true' },
  { from: "case 'games.launched': {\n        const me = store.user?.id;", to: "case 'games.launched': {\n        const me = 'me';" }]);
paired('нулевой подарок не отменяет саму карточку запуска', f => {
  f.socket.receive(msg(['me'], 0));
  assert.deepEqual(f.notices, [{ serverId: 'source', at: '2026-10-29T12:00:00Z', gift: 0, mine: 0 }], 'R343 launch socket: запуск без эмиссии всё равно доставлен');
}, [{ from: SET, to: 'if (msg.gift) ' + SET }]);
