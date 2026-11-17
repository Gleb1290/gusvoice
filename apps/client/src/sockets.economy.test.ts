import { counterfact } from '../../../packages/shared/test/counterfacts.js';
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
type View = { balance?: number; goose: { offerId: string } | null;
  gamesDailyLossMax?: number; wallet?: { balance: number; earnedTotal: number; seasonEarned: number;
    games: { lossToday: number; effectiveLimit: number; lossLimit?: number | null } } };

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
    setActivities: noop, voice: null,
    loadServers: async () => {}, refreshBootstrap: async (_id: string) => {},
    applyWallet(id: string, patch: { balance: number; earnedTotal: number; seasonEarned: number }) {
      const view = state.economy[id];
      if (view?.wallet) state.economy[id] = { ...view, wallet: { ...view.wallet, ...patch } };
    },
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
    './coinsCue': { shouldPulseWallet: () => false },
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
  return { state, module, client: economy, sockets, requests, ensureCalls, live, resyncs: () => resyncs,
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
it('повторные ready объединяются в один отложенный запрос и не применяют устаревший ответ', async () => {
  const f = fixture(); const pending: Array<(view: View) => void> = [];
  f.fetch(() => new Promise<View>(done => pending.push(done)));
  for (let i = 0; i < 3; i++) f.sockets[0].receive({ t: 'ready' });
  assert.equal(f.requests.length, 1);
  pending[0]({ balance: 50, goose: null }); await flush();
  assert.equal(f.state.economy['server-a'].balance, 1, 'старый GET не применяется');
  assert.equal(f.requests.length, 2, 'один trailing GET на все busy-force');
  pending[1]({ balance: 60, goose: null }); await flush();
  assert.equal(f.state.economy['server-a'].balance, 60);
  await flush(); assert.equal(f.requests.length, 2, 'без новых событий опроса нет');
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
  counterfact(() => assert.equal(source.split(call).length - 1, 1)); counterfact(() => assert.equal(source.split(server).length - 1, 1));
  await everyReady(); await activeServer();
  for (const replacement of ['if (sid) ensureEconomy(sid);', '/* снимок не обновляется */'])
    await counterfact(() => assert.rejects(() => everyReady(source.replace(call, replacement)),
      e => e instanceof assert.AssertionError && e.message.startsWith('R249 ready-refresh:')));
  await counterfact(() => assert.rejects(() => activeServer(source.replace(server, 'const sid = store.currentServerId;')),
    e => e instanceof assert.AssertionError && e.message.startsWith('R249 no-server:')));
  await counterfact(() => assert.rejects(() => activeServer(source.replace(call, 'ensureEconomy(sid, true);')),
    e => e instanceof assert.AssertionError && e.message.startsWith('R249 no-server:')));
});

// Настоящие socket → economyClient → API/стор, транспорт подменён управляемыми Promise.
const gameView = (lossToday: number, effectiveLimit = 15000): View => ({
  goose: null, gamesDailyLossMax: 15000,
  wallet: { balance: 50000, earnedTotal: 0, seasonEarned: 0, games: { lossToday, effectiveLimit } },
});
const walletEvent = (serverId = 'server-a') => ({ t: 'economy.wallet', serverId,
  balance: 50000, earnedTotal: 0, seasonEarned: 0 });

it('потолок 3000→15000 во время GET обновляет неоткрытый загруженный сервер и сохраняет личный предел', async () => {
  for (const personal of [null, 2000]) {
    const f = fixture();
    const oldView = { ...gameView(500, personal ?? 3000), gamesDailyLossMax: 3000 };
    f.state.economy['server-a'] = oldView;
    let bootstrapReads = 0;
    f.state.refreshBootstrap = async () => { bootstrapReads++; };
    const pending: Array<(view: View) => void> = [];
    f.fetch(() => new Promise<View>(done => pending.push(done)));
    f.client.ensureEconomy('server-a', true);
    for (let i = 0; i < 3; i++) f.sockets[0].receive({ t: 'server.invalidate', serverId: 'server-a' });
    assert.deepEqual(f.requests, ['server-a'], 'бурст изменений не запускает параллельные GET');
    pending[0](oldView); await flush();
    assert.deepEqual(f.requests, ['server-a', 'server-a'], 'после старого GET ровно один trailing');
    assert.equal(f.state.economy['server-a'].gamesDailyLossMax, 3000);
    pending[1](gameView(500, personal ?? 15000)); await flush();
    assert.equal(f.state.economy['server-a'].gamesDailyLossMax, 15000);
    assert.equal(f.state.economy['server-a'].wallet!.games.effectiveLimit, personal ?? 15000);
    assert.equal(bootstrapReads, 0, 'чужой bootstrap не запрашивается');
    f.state.currentServerId = 'server-a';
    f.fetch(async () => gameView(500, personal ?? 15000));
    f.sockets[0].receive({ t: 'server.invalidate', serverId: 'server-a' }); await flush();
    assert.equal(bootstrapReads, 1, 'открытый сервер по-прежнему обновляет права');
  }
});

it('старое событие wallet обновляет чистый проигрыш после частичного выигрыша, полного и возврата', async () => {
  const f = fixture(); f.state.economy['server-a'] = gameView(15000);
  const other = gameView(777); f.state.economy.other = other;
  for (const loss of [13500, 6000, 0]) {
    f.fetch(async () => gameView(loss)); f.sockets[0].receive(walletEvent()); await flush();
    assert.equal(f.state.economy['server-a'].wallet!.games.lossToday, loss);
    assert.equal(f.state.economy['server-a'].wallet!.games.effectiveLimit, 15000);
    assert.equal(f.state.economy.other, other, 'кошельки серверов изолированы');
  }
  assert.equal(f.requests.length, 3);
});

it('wallet во время GET не даёт старому проигрышу затереть свежий снимок', async () => {
  const f = fixture(); f.state.economy['server-a'] = gameView(15000);
  const pending: Array<(view: View) => void> = [];
  f.fetch(() => new Promise<View>(done => pending.push(done)));
  f.client.ensureEconomy('server-a', true);
  f.sockets[0].receive(walletEvent()); f.sockets[0].receive(walletEvent());
  pending[0](gameView(15000)); await flush(); assert.equal(f.requests.length, 2);
  pending[1](gameView(0)); await flush();
  assert.equal(f.state.economy['server-a'].wallet!.games.lossToday, 0);
  await flush(); assert.equal(f.requests.length, 2);
});

it('поздний GET не откатывает личный предел, сохранённый отдельным PATCH', async () => {
  const f = fixture(); f.state.economy['server-a'] = gameView(0);
  const pending: Array<(view: View) => void> = [];
  f.fetch(() => new Promise<View>(done => pending.push(done)));
  f.client.ensureEconomy('server-a', true);
  f.state.setEconomy('server-a', gameView(0, 2000));
  pending[0](gameView(0, 15000)); await flush();
  assert.equal(f.state.economy['server-a'].wallet!.games.effectiveLimit, 2000);
  assert.equal(f.requests.length, 2);
  pending[1](gameView(0, 2000)); await flush();
  assert.equal(f.state.economy['server-a'].wallet!.games.effectiveLimit, 2000);
});

it('смена инстанса отменяет старый ответ и не снимает дедуп нового запроса с тем же id', async () => {
  const f = fixture(); const pending: Array<(view: View) => void> = [];
  f.fetch(() => new Promise<View>(done => pending.push(done)));
  f.client.ensureEconomy('server-a', true); f.client.ensureEconomy('server-a', true);
  f.client.clearEconomyInFlight();
  f.client.ensureEconomy('server-a', true);
  pending[0](gameView(999)); await flush();
  assert.equal(f.state.economy['server-a'].wallet, undefined);
  assert.equal(f.requests.length, 2, 'старый dirty не запускает запрос к новому инстансу');
  f.client.ensureEconomy('server-a', true);
  assert.equal(f.requests.length, 2, 'старый finally не удалил новый inFlight');
  pending[1](gameView(888)); await flush(); assert.equal(f.requests.length, 3);
  pending[2](gameView(0)); await flush();
  assert.equal(f.state.economy['server-a'].wallet!.games.lossToday, 0);
});

it('busy-force переживает ошибку GET, обычный кеш и запрет показа не создают опроса', async () => {
  const f = fixture(); let reject!: (e: Error) => void;
  f.fetch(() => new Promise<View>((_done, fail) => { reject = fail; }));
  f.client.ensureEconomy('server-a'); assert.equal(f.requests.length, 0);
  f.client.ensureEconomy('server-a', true); f.client.ensureEconomy('server-a', true);
  f.fetch(async () => gameView(0)); reject(Error('offline')); await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.state.economy['server-a'].wallet!.games.lossToday, 0);
  f.state.user.economyPreview = false;
  f.sockets[0].receive({ t: 'server.invalidate', serverId: 'other' });
  f.sockets[0].receive(walletEvent()); await flush();
  assert.equal(f.requests.length, 2, 'force не обходит серверный запрет показа');
});
