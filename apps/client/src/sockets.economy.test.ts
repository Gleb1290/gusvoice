import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as subs from './gatewaySubs';
import * as visibility from './economyVisible';

const source = readFileSync(new URL('./sockets.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const economySource = readFileSync(new URL('./economyClient.ts', import.meta.url), 'utf8');
const noop = () => {};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
type View = { balance: number; goose: { offerId: string } | null };

function load<T>(raw: string, deps: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} as T };
  // Исполняются целые модули: ready действительно доходит до ensureEconomy и обновления снимка.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, { module, exports: module.exports, ...globals,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `описана граница ${id}`); return deps[id]; },
  });
  return module.exports;
}

function fixture(raw = source) {
  const requests: string[] = [], ensureCalls: { id: string; force: boolean | undefined }[] = [];
  const live: boolean[] = [], sockets: Socket[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0, resyncs = 0;
  const state = {
    user: { id: 'viewer', economyPreview: true }, serverFeatures: [], convActive: false,
    bootstrap: { server: { id: 'server-a' } } as { server: { id: string } } | null,
    currentServerId: 'stale-server',
    economy: { 'server-a': { balance: 1, goose: null } } as Record<string, View>,
    setEconomy: (id: string, view: View) => { state.economy[id] = view; },
    setActivities: noop,
    resyncAfterReconnect: async () => { resyncs++; }, rejoinVoiceAfterOutage: async () => {},
  };
  const store = { getState: () => state, subscribe: () => noop };
  let fetchView = async (_id: string): Promise<View> => ({ balance: 20 + requests.length, goose: { offerId: `offer-${requests.length}` } });
  const api = {
    listServers: async () => [], getActivities: async () => ({ activities: {} }),
    getEconomy: (id: string) => { requests.push(id); return fetchView(id); },
  };
  const config = { economyEnabled: true };
  const economy = load<typeof import('./economyClient')>(economySource, {
    './api': { api }, './config': { config }, './store': { useStore: store }, './economyVisible': visibility,
  });
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; sent: unknown[] = [];
    onopen?: () => void; onclose?: () => void; onmessage?: (event: { data: string }) => void;
    constructor(_url: string) { sockets.push(this); }
    send(frame: string) { this.sent.push(JSON.parse(frame)); }
    open() { this.readyState = 1; assert.ok(this.onopen); this.onopen(); }
    close() { this.readyState = 3; this.onclose?.(); }
    receive(frame: unknown) { assert.ok(this.onmessage); this.onmessage({ data: JSON.stringify(frame) }); }
  }
  // Остальные ветки протокола здесь не вызываются, но все импорты перечислены явно.
  const deps: Record<string, unknown> = Object.fromEntries([
    './channelRules', './serverRowRules', './dmListRules', './readByView', './coinsCue', './memberName',
    './flashWindow', './coinNotifyRules', './notifyRules', './sounds', './dmStickers', './dmFolders',
    './peerName', './contacts', './savedGifs', './channelPrefs', './hotkeys', './effectsBus', './effectsDom',
    './tipMode', './toast', './dmOnline', './typing',
  ].map(id => [id, {}]));
  Object.assign(deps, {
    '@gusvoice/shared': shared, './gatewaySubs': subs, './store': { useStore: store },
    './api': { api, getToken: () => 'synthetic-token' },
    './config': { config, gatewayWsUrl: () => 'ws://localhost/gateway' },
    './connState': { resetGatewayLive: noop, setGatewayLive: (on: boolean) => live.push(on) },
    './presenceVisibility': { presentNow: () => true, watchPresence: noop }, './bgGateways': { setBgPresent: noop },
    './notifications': { setNotifyPrefs: noop, windowFocused: () => false },
    './socketHealth': { CONNECT_TIMEOUT_MS: 15000, PING_MS: 25000, socketStale: () => false },
    './callStore': {}, './callView': { serverCalls: () => false }, './convSyncRules': { serverPush2: () => false },
    './economyClient': { ensureEconomy: (id: string, force?: boolean) => {
      ensureCalls.push({ id, force }); economy.ensureEconomy(id, force);
    } },
  });
  const module = load<typeof import('./sockets')>(raw, deps, {
    WebSocket: Socket, window: { addEventListener: noop }, document: { addEventListener: noop },
    setTimeout: (fn: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id), setInterval: () => ++nextTimer, clearInterval: noop,
  });
  module.connectGateway(); sockets[0].open();
  return { state, module, sockets, requests, ensureCalls, live, resyncs: () => resyncs,
    fetch: (fn: typeof fetchView) => { fetchView = fn; },
    reconnect() {
      sockets.at(-1)!.close();
      const entry = [...timers].find(([, timer]) => timer.ms === 2000);
      assert.ok(entry, 'onclose назначил переподключение'); timers.delete(entry[0]); entry[1].fn();
      sockets.at(-1)!.open();
    },
  };
}

async function everyReady(raw = source) {
  const f = fixture(raw);
  assert.equal(f.requests.length, 0, 'открытие сокета ещё не является ready');
  for (let n = 1; n <= 2; n++) {
    f.sockets[0].receive({ t: 'ready' }); await flush();
    assert.equal(f.requests.length, n, 'R249 ready-refresh: каждый ready перечитывает уже имеющийся снимок');
    assert.deepEqual(f.state.economy['server-a'], { balance: 20 + n, goose: { offerId: `offer-${n}` } });
    assert.deepEqual(f.ensureCalls[n - 1], { id: 'server-a', force: true });
  }
}
// Класс ошибки: готовый кеш или отсутствие бесед/звонков блокирует восстановление гуся и баланса.
it('R249 каждый ready принудительно обновляет готовый снимок экономики вместе с гусём и балансом', () => everyReady());

// Класс ошибки: экономику перечитывают лишь при первом соединении, а после обрыва гусь остаётся потерянным.
it('R249 закрытие сокета и настоящее переподключение повторяют загрузку после нового ready', async () => {
  const f = fixture(); f.sockets[0].receive({ t: 'ready' }); await flush();
  f.reconnect(); await flush(); assert.equal(f.resyncs(), 1); assert.equal(f.requests.length, 1);
  f.sockets[1].receive({ t: 'ready' }); await flush();
  assert.deepEqual(f.requests, ['server-a', 'server-a']); assert.equal(f.state.economy['server-a'].goose?.offerId, 'offer-2');
  assert.deepEqual(f.live, [true, false, true]);
});

async function activeServer(raw = source) {
  const f = fixture(raw); f.state.bootstrap = null;
  f.sockets[0].receive({ t: 'ready' }); await flush();
  assert.equal(f.ensureCalls.length, 0, 'R249 no-server: без открытого сервера нет даже вызова ensureEconomy');
  assert.deepEqual(f.requests, []);
  f.state.bootstrap = { server: { id: 'server-b' } };
  f.sockets[0].receive({ t: 'ready' }); await flush();
  assert.deepEqual(f.requests, ['server-b'], 'R249 active-server: сервер берётся из текущего bootstrap, не из прежнего выбора');
  assert.equal(f.state.economy['server-a'].balance, 1);
}
// Класс ошибки: ready запрашивает кошелёк отсутствующего или ранее открытого сервера.
it('R249 без bootstrap запросов нет, следующий ready использует актуальный открытый сервер', () => activeServer());

// Класс ошибки: повтор ready размножает незавершённые запросы либо навсегда блокирует последующие обновления.
it('R249 два ready во время запроса объединяются, а после ответа следующий ready снова обновляет снимок', async () => {
  const f = fixture(); let resolve!: (view: View) => void;
  f.fetch(() => new Promise<View>(done => { resolve = done; }));
  f.sockets[0].receive({ t: 'ready' }); f.sockets[0].receive({ t: 'ready' });
  assert.equal(f.ensureCalls.length, 2); assert.equal(f.requests.length, 1);
  resolve({ balance: 50, goose: { offerId: 'restored' } }); await flush();
  assert.equal(f.state.economy['server-a'].goose?.offerId, 'restored');
  f.fetch(async () => ({ balance: 60, goose: null }));
  f.sockets[0].receive({ t: 'ready' }); await flush();
  assert.equal(f.requests.length, 2); assert.deepEqual(f.state.economy['server-a'], { balance: 60, goose: null });
});

// Класс ошибки: сетевой отказ оставляет inFlight навсегда или рушит обработчик ready.
it('R249 отказ загрузки сохраняет прежний снимок и не мешает восстановлению на следующем ready', async () => {
  const f = fixture(); f.fetch(async () => { throw Error('temporary network failure'); });
  f.sockets[0].receive({ t: 'ready' }); await flush();
  assert.deepEqual(f.state.economy['server-a'], { balance: 1, goose: null });
  f.fetch(async () => ({ balance: 70, goose: { offerId: 'recovered' } }));
  f.sockets[0].receive({ t: 'ready' }); await flush();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.state.economy['server-a'], { balance: 70, goose: { offerId: 'recovered' } });
});

// Класс ошибки: запоздалый ready заменённого сокета обращается к кошельку уже другой сессии.
it('R249 ready старого сокета после замены игнорируется, новый сокет восстанавливает экономику', async () => {
  const f = fixture(); const old = f.sockets[0];
  f.reconnect(); old.receive({ t: 'ready' }); await flush();
  assert.equal(f.ensureCalls.length, 0);
  f.sockets[1].receive({ t: 'ready' }); await flush(); assert.deepEqual(f.requests, ['server-a']);
});

// Класс ошибки: транспорт съедает повторный offerId и не даёт хосту восстановить потерянное предложение.
it('R249 повтор goose.offer доставляется подписчику с прежним id, после отписки доставка прекращается', () => {
  const f = fixture(); const received: string[] = [];
  const off = f.module.onGooseOffer(offer => received.push(`${offer.serverId}:${offer.offerId}`));
  const offer = { t: 'goose.offer', serverId: 'server-a', offerId: 'hanging' };
  f.sockets[0].receive(offer); f.sockets[0].receive(offer); off(); f.sockets[0].receive(offer);
  assert.deepEqual(received, ['server-a:hanging', 'server-a:hanging']); assert.equal(f.requests.length, 0);
});

// Класс ошибки: внешне успешный ready перестаёт восстанавливать гуся при потере force, вызова или выбора сервера.
it('R249 контрфакты потерянного force, вызова и неверного сервера обнаруживаются настоящим путём ready', async () => {
  const call = 'if (sid) ensureEconomy(sid, true);';
  const server = 'const sid = store.bootstrap?.server.id;';
  assert.equal(source.split(call).length - 1, 1); assert.equal(source.split(server).length - 1, 1);
  await everyReady(); await activeServer();
  for (const replacement of ['if (sid) ensureEconomy(sid);', '/* снимок не обновляется */'])
    await assert.rejects(() => everyReady(source.replace(call, replacement)),
      e => e instanceof assert.AssertionError && e.message.startsWith('R249 ready-refresh:'));
  await assert.rejects(() => activeServer(source.replace(server, 'const sid = store.currentServerId;')),
    e => e instanceof assert.AssertionError && e.message.startsWith('R249 no-server:'));
  await assert.rejects(() => activeServer(source.replace(call, 'ensureEconomy(sid, true);')),
    e => e instanceof assert.AssertionError && e.message.startsWith('R249 no-server:'));
});
