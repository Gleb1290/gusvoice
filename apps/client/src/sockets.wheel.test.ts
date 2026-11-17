import assert from 'node:assert/strict';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as subs from './gatewaySubs';
import * as visibility from './economyVisible';
import type { WheelView } from './wheelRules';
import type { WheelResultMsg, WheelStateMsg } from './store';

const source = readFileSync(new URL('./sockets.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const economySource = readFileSync(new URL('./economyClient.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const NOW = '2026-10-28T12:00:00.000Z';
const noop = () => {};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
type Event = WheelStateMsg | WheelResultMsg;
type Edit = { module?: 'economy'; from: string; to: string };
const view = (id = 'open'): WheelView => ({
  serverId: id, serverNow: NOW, enabled: true, betMax: 300, jackpot: 7, last: null, cooldownUntil: null, skewMs: 0,
  round: { id: 'round', state: 'open', lockAt: NOW, settleAt: null, sector: null, commit: 'a'.repeat(64),
    bets: [{ userId: 'me', pick: 1, amount: 10 }] },
});
const result = (): WheelResultMsg => ({
  t: 'wheel.result', serverId: 'open', serverNow: NOW, jackpot: 3, cooldownUntil: NOW,
  last: { id: 'round', sector: 1, seed: 'b'.repeat(64), commit: 'a'.repeat(64), settledAt: NOW,
    jackpotHit: false, jackpotPaid: 0, winners: [{ userId: 'me', pick: 1, payout: 19 }] },
});

function load<T>(raw: string, deps: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} as T };
  // Оба модуля исполняются целиком; сетевой кадр проходит настоящий switch sockets.ts.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, { module, exports: module.exports, ...globals,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `R329 setup: закрытый импорт ${id}`); return deps[id]; },
  });
  return module.exports;
}

function fixture(edit?: Edit) {
  const requests: string[] = [], ensureCalls: { id: string | null | undefined; force: boolean | undefined }[] = [];
  const sounds: string[] = [], applied: Event[] = [], sockets: Socket[] = [];
  const state = {
    user: { id: 'me', economyPreview: true } as { id: string; economyPreview: boolean } | null,
    bootstrap: { server: { id: 'open' } } as { server: { id: string } } | null,
    currentServerId: 'stale', serverFeatures: [], convActive: false,
    voice: { serverId: 'voice', channelId: 'voice-channel' } as { serverId: string; channelId: string } | null,
    duels: {}, economy: {}, wheel: {} as Record<string, WheelView>,
    activitiesOpen: null as { serverId: string; view: 'wheel' | 'list' } | null, selfDeafened: false,
    setActivities: noop, resyncAfterReconnect: async () => {}, rejoinVoiceAfterOutage: async () => {},
    setWheel: (id: string, snap: shared.WheelSnapshotDto) => { state.wheel[id] = { ...snap, skewMs: 0 }; },
    applyWheelEvent: (msg: Event) => {
      applied.push(msg);
      const before = state.wheel[msg.serverId];
      if (!before) return false;
      // Граница стора здесь наблюдаемая; настоящие слияния отдельно покрыты store.wheel.test.ts.
      // После события round уже нет: звук обязан читать ставки из снимка ДО вызова action.
      state.wheel[msg.serverId] = { ...before, round: msg.t === 'wheel.state' ? msg.round : null };
      return true;
    },
  };
  const store = { getState: () => state, subscribe: () => noop };
  let fetchWheel = async (id: string): Promise<shared.WheelSnapshotDto> => view(id);
  const api = {
    listServers: async () => [{ id: 'open' }, { id: 'voice' }, { id: 'unopened' }],
    getActivities: async () => ({ activities: {} }),
    getWheel: (id: string) => { requests.push(id); return fetchWheel(id); },
  };
  const config = { economyEnabled: true };
  const economy = load<typeof import('./economyClient')>(edit?.module === 'economy'
    ? economySource.replace(edit.from, edit.to) : economySource, {
    './api': { api }, './config': { config }, './store': { useStore: store }, './economyVisible': visibility,
  });
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; sent: unknown[] = [];
    onopen?: () => void; onclose?: () => void; onmessage?: (event: { data: string }) => void;
    constructor(_url: string) { sockets.push(this); }
    send(frame: string) { this.sent.push(JSON.parse(frame)); }
    open() { this.readyState = 1; assert.ok(this.onopen, 'R329 setup: onopen установлен'); this.onopen(); }
    close() { this.readyState = 3; this.onclose?.(); }
    receive(frame: unknown) { assert.ok(this.onmessage, 'R329 setup: onmessage установлен'); this.onmessage({ data: JSON.stringify(frame) }); }
  }
  const deps: Record<string, unknown> = Object.fromEntries([
    './channelRules', './serverRowRules', './dmListRules', './readByView', './coinsCue', './memberName',
    './flashWindow', './coinNotifyRules', './notifyRules', './dmStickers', './dmFolders', './peerName',
    './contacts', './savedGifs', './channelPrefs', './hotkeys', './effectsBus', './effectsDom', './tipMode',
    './toast', './dmOnline', './typing',
  ].map(id => [id, {}]));
  Object.assign(deps, {
    '@gusvoice/shared': shared, './gatewaySubs': subs, './store': { useStore: store },
    './api': { api, getToken: () => 'synthetic-unused-token' },
    './config': { config, gatewayWsUrl: () => 'ws://localhost/synthetic-gateway' },
    './connState': { resetGatewayLive: noop, setGatewayLive: noop },
    './presenceVisibility': { presentNow: () => true, watchPresence: noop }, './bgGateways': { setBgPresent: noop },
    './notifications': { setNotifyPrefs: noop, windowFocused: () => false },
    './socketHealth': { CONNECT_TIMEOUT_MS: 15_000, PING_MS: 25_000, socketStale: () => false },
    './callStore': {}, './callView': { serverCalls: () => false }, './convSyncRules': { serverPush2: () => false },
    './sounds': { playSound: (event: string) => sounds.push(event) },
    './economyClient': {
      ensureEconomy: noop, ensureDuel: noop, ensurePredictions: noop,
      ensureWheel: (id: string | null | undefined, force?: boolean) => { ensureCalls.push({ id, force }); economy.ensureWheel(id, force); },
    },
  });
  let timer = 0;
  const module = load<typeof import('./sockets')>(edit && !edit.module ? source.replace(edit.from, edit.to) : source, deps, {
    WebSocket: Socket, window: { addEventListener: noop }, document: { addEventListener: noop },
    setTimeout: () => ++timer, clearTimeout: noop, setInterval: () => ++timer, clearInterval: noop,
  });
  module.connectGateway();
  sockets[0].open();
  return { state, requests, ensureCalls, sounds, applied, socket: sockets[0],
    fetch: (fn: typeof fetchWheel) => { fetchWheel = fn; } };
}
type Fixture = ReturnType<typeof fixture>;

function paired(title: string, check: (f: Fixture) => void | Promise<void>, edits: readonly Edit[]) {
  it(`R329 сокет колеса: ${title}`, async () => {
    await check(fixture());
    for (const edit of edits) {
      await counterfact(async () => {
        const original = edit.module === 'economy' ? economySource : source;
        assert.equal(original.split(edit.from).length, 2, 'R329 setup: уникальный якорь целого модуля');
        await assert.rejects(async () => check(fixture(edit)), error =>
          error instanceof assert.AssertionError && error.message.startsWith('R329 wheel socket:'),
        'мутант ломает адресный результат dispatch, не импорт или сборку');
      });
      await check(fixture());
    }
  });
}

const READY = 'for (const id of new Set([sid, store.voice?.serverId])) if (id && store.wheel?.[id]) ensureWheel(id, true);';
paired('ready форсирует только имеющиеся снимки открытого и голосового серверов, без дубля', async f => {
  f.state.wheel = { open: view(), voice: view('voice'), unopened: view('unopened'), stale: view('stale') };
  assert.equal(f.ensureCalls.length, 0, 'R329 wheel socket: open ещё не ready');
  f.socket.receive({ t: 'ready' }); await flush();
  assert.deepEqual(f.ensureCalls, [{ id: 'open', force: true }, { id: 'voice', force: true }], 'R329 wheel socket: ready обновляет только два нужных снимка с force');
  assert.deepEqual(f.requests, ['open', 'voice'], 'R329 wheel socket: реальные запросы не захватывают все серверы');
  f.ensureCalls.length = 0; f.requests.length = 0;
  f.state.voice = { serverId: 'open', channelId: 'voice-channel' };
  f.socket.receive({ t: 'ready' }); await flush();
  assert.deepEqual(f.ensureCalls, [{ id: 'open', force: true }], 'R329 wheel socket: один сервер голоса и окна не удваивает ensure');
  f.ensureCalls.length = 0; f.requests.length = 0;
  f.state.wheel = {}; f.socket.receive({ t: 'ready' }); await flush();
  assert.deepEqual(f.ensureCalls, [], 'R329 wheel socket: ready не создаёт ещё не нужные снимки');
  f.state.bootstrap = null; f.state.voice = null; f.state.wheel = { stale: view('stale') };
  f.socket.receive({ t: 'ready' }); await flush();
  assert.deepEqual(f.ensureCalls, [], 'R329 wheel socket: старый currentServerId не заменяет отсутствующий bootstrap');
}, [
  { from: READY, to: 'for (const id of new Set([sid])) if (id && store.wheel?.[id]) ensureWheel(id, true);' },
  { from: READY, to: 'for (const id of new Set([store.voice?.serverId])) if (id && store.wheel?.[id]) ensureWheel(id, true);' },
  { from: READY, to: 'for (const id of Object.keys(store.wheel ?? {})) ensureWheel(id, true);' },
  { from: READY, to: 'for (const id of new Set([sid, store.voice?.serverId])) if (id) ensureWheel(id, true);' },
  { from: READY, to: (counterfact(() => READY.replace('ensureWheel(id, true)', 'ensureWheel(id)')) ?? '') },
  { from: READY, to: (counterfact(() => READY.replace('new Set([sid, store.voice?.serverId])', '[sid, store.voice?.serverId]')) ?? '') },
]);

paired('повтор ready во время загрузки объединяет запросы, следующий после ответа снова обновляет', async f => {
  f.state.voice = null; f.state.wheel.open = view();
  const pending: Array<(snap: shared.WheelSnapshotDto) => void> = [];
  f.fetch(() => new Promise<shared.WheelSnapshotDto>(resolve => pending.push(resolve)));
  f.socket.receive({ t: 'ready' }); f.socket.receive({ t: 'ready' });
  assert.equal(f.ensureCalls.length, 2, 'R329 wheel socket: каждый ready доходит до загрузчика');
  assert.deepEqual(f.requests, ['open'], 'R329 wheel socket: незаконченный HTTP-запрос не размножен');
  for (const done of pending) done({ ...view(), jackpot: 42 });
  await flush();
  assert.equal(f.state.wheel.open.jackpot, 42, 'R329 wheel socket: настоящий загрузчик применил ответ');
  f.fetch(async () => ({ ...view(), jackpot: 43 }));
  f.socket.receive({ t: 'ready' }); await flush();
  assert.deepEqual(f.requests, ['open', 'open'], 'R329 wheel socket: после ответа следующий ready снова загружает');
  assert.equal(f.state.wheel.open.jackpot, 43, 'R329 wheel socket: кеш обновлён повторно');
}, [{ module: 'economy', from: 'if (wheelInFlight.has(serverId)) return;', to: '' },
  { module: 'economy', from: '.finally(() => wheelInFlight.delete(serverId));', to: '.finally(() => {});' }]);

for (const kind of ['wheel.state', 'wheel.result'] as const) {
  const event: Event = kind === 'wheel.state'
    ? { t: kind, serverId: 'open', serverNow: NOW, jackpot: 4, round: null } : result();
  const anchor = kind === 'wheel.state'
    ? "case 'wheel.state':\n        if (!store.applyWheelEvent(msg)) ensureWheel(msg.serverId);"
    : "case 'wheel.result': {\n        const before = store.wheel[msg.serverId];\n        if (!store.applyWheelEvent(msg)) ensureWheel(msg.serverId);";
  paired(`${kind} до снимка догружает его, после снимка доставляется без лишнего HTTP`, async f => {
    f.socket.receive(event); await flush();
    assert.equal(f.applied.length, 1, 'R329 wheel socket: событие передано action стора');
    assert.deepEqual(f.ensureCalls, [{ id: 'open', force: undefined }], 'R329 wheel socket: отсутствующий снимок загружается по серверу события');
    assert.deepEqual(f.requests, ['open'], 'R329 wheel socket: fallback дошёл до реального getWheel');
    assert.ok(f.state.wheel.open, 'R329 wheel socket: загрузчик сохранил снимок');
    f.ensureCalls.length = 0;
    f.socket.receive(event); await flush();
    assert.equal(f.applied.length, 2, 'R329 wheel socket: следующее событие тоже доставлено');
    assert.deepEqual(f.ensureCalls, [], 'R329 wheel socket: готовый снимок не требует fallback');
    assert.deepEqual(f.requests, ['open'], 'R329 wheel socket: событие не опрашивает сервер при готовом снимке');
  }, [{ from: anchor, to: (counterfact(() => anchor.replace('if (!store.applyWheelEvent(msg)) ensureWheel(msg.serverId);', 'store.applyWheelEvent(msg);')) ?? '') },
    { from: anchor, to: (counterfact(() => anchor.replace('if (!store.applyWheelEvent(msg)) ensureWheel(msg.serverId);', 'store.applyWheelEvent(msg); ensureWheel(msg.serverId);')) ?? '') }]);
}

const SOUND = "if (!sceneOpen && iBet && msg.last.winners.some((w) => w.userId === me) && !store.selfDeafened) playSound('wheelWin');";
const cases: Array<{ title: string; prepare: (f: Fixture, event: WheelResultMsg) => void; wins: boolean; edit: Edit }> = [
  { title: 'ставивший победитель слышит выигрыш при закрытой сцене', prepare: noop, wins: true,
    edit: { from: SOUND, to: (counterfact(() => SOUND.replace("playSound('wheelWin')", 'void 0')) ?? '') } },
  { title: 'без пользователя звук не возникает', prepare: f => { f.state.user = null; }, wins: false,
    edit: { from: 'const me = store.user?.id;\n        const sceneOpen = store.activitiesOpen?.serverId === msg.serverId',
      to: "const me = 'me';\n        const sceneOpen = store.activitiesOpen?.serverId === msg.serverId" } },
  { title: 'победитель без своей ставки не получает звук', prepare: f => { f.state.wheel.open.round!.bets = [{ userId: 'other', pick: 1, amount: 10 }]; }, wins: false,
    edit: { from: SOUND, to: (counterfact(() => SOUND.replace(' && iBet', '')) ?? '') } },
  { title: 'проигравший со ставкой не получает звук', prepare: (_f, event) => { event.last.winners = [{ userId: 'other', pick: 1, payout: 19 }]; }, wins: false,
    edit: { from: SOUND, to: (counterfact(() => SOUND.replace(' && msg.last.winners.some((w) => w.userId === me)', '')) ?? '') } },
  { title: 'открытая сцена этого колеса сама отвечает за звук', prepare: f => { f.state.activitiesOpen = { serverId: 'open', view: 'wheel' }; }, wins: false,
    edit: { from: SOUND, to: (counterfact(() => SOUND.replace('!sceneOpen && ', '')) ?? '') } },
  { title: 'деафен заглушает выигрыш', prepare: f => { f.state.selfDeafened = true; }, wins: false,
    edit: { from: SOUND, to: (counterfact(() => SOUND.replace(' && !store.selfDeafened', '')) ?? '') } },
  { title: 'сцена другого сервера не заглушает этот выигрыш', prepare: f => { f.state.activitiesOpen = { serverId: 'other', view: 'wheel' }; }, wins: true,
    edit: { from: "const sceneOpen = store.activitiesOpen?.serverId === msg.serverId && store.activitiesOpen.view === 'wheel';",
      to: "const sceneOpen = store.activitiesOpen?.view === 'wheel';" } },
  { title: 'меню активностей того же сервера не считается сценой колеса', prepare: f => { f.state.activitiesOpen = { serverId: 'open', view: 'list' }; }, wins: true,
    edit: { from: "const sceneOpen = store.activitiesOpen?.serverId === msg.serverId && store.activitiesOpen.view === 'wheel';",
      to: 'const sceneOpen = store.activitiesOpen?.serverId === msg.serverId;' } },
];
for (const row of cases) paired(row.title, f => {
  f.state.wheel.open = view();
  const event = result();
  row.prepare(f, event);
  f.socket.receive(event);
  assert.deepEqual(f.sounds, row.wins ? ['wheelWin'] : [], `R329 wheel socket: ${row.title}`);
  assert.equal(f.applied.length, 1, 'R329 wheel socket: звук не заменяет доставку итога');
  assert.equal(f.state.wheel.open.round, null, 'R329 wheel socket: звук читает ставки до закрывающего action');
}, [row.edit]);

const JACKPOT = "if (!sceneOpen && iBet && msg.last.jackpotHit && !store.selfDeafened) playSound('wheelJackpot');";
const jackpotCases: Array<{ title: string; prepare: (f: Fixture, event: WheelResultMsg) => void; expected: string[]; edit: Edit }> = [
  { title: 'сундук заменяет обычную фанфару ровно одним wheelJackpot', prepare: noop, expected: ['wheelJackpot'],
    edit: { from: JACKPOT, to: (counterfact(() => JACKPOT.replace("playSound('wheelJackpot')", "playSound('wheelWin')")) ?? '') } },
  { title: 'ставившему сундук слышен и без победы по своему числу', prepare: (_f, e) => { e.last.winners = []; }, expected: ['wheelJackpot'],
    edit: { from: JACKPOT, to: (counterfact(() => JACKPOT.replace('iBet &&', 'iBet && msg.last.winners.some((w) => w.userId === me) &&')) ?? '') } },
  { title: 'без своей ставки сундук не присваивает звук зрителю', prepare: f => { f.state.wheel.open.round!.bets = []; }, expected: [],
    edit: { from: JACKPOT, to: (counterfact(() => JACKPOT.replace(' && iBet', '')) ?? '') } },
  { title: 'открытая сцена сама озвучивает сундук, сокет молчит', prepare: f => { f.state.activitiesOpen = { serverId: 'open', view: 'wheel' }; }, expected: [],
    edit: { from: JACKPOT, to: (counterfact(() => JACKPOT.replace('!sceneOpen && ', '')) ?? '') } },
  { title: 'глухота глушит в том числе редкий сундук', prepare: f => { f.state.selfDeafened = true; }, expected: [],
    edit: { from: JACKPOT, to: (counterfact(() => JACKPOT.replace(' && !store.selfDeafened', '')) ?? '') } },
  { title: 'обычный выигрыш без сундука сохраняет прежний wheelWin', prepare: (_f, e) => { e.last.jackpotHit = false; }, expected: ['wheelWin'],
    edit: { from: JACKPOT, to: (counterfact(() => JACKPOT.replace('msg.last.jackpotHit', 'true')) ?? '') } },
];
for (const row of jackpotCases) paired(`R341 ${row.title}`, f => {
  f.state.wheel.open = view();
  const event = result(); event.last.jackpotHit = true;
  row.prepare(f, event); f.socket.receive(event);
  assert.deepEqual(f.sounds, row.expected, `R329 wheel socket: R341 ${row.title}`);
  assert.equal(f.applied.length, 1, 'R329 wheel socket: R341 звук не мешает применить результат');
}, [row.edit]);
