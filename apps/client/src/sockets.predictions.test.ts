import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as shared from '@gusvoice/shared';
import * as subs from './gatewaySubs';
import { event, question, sourceOf, load, pairedAsync, iso, FixedDate, noop, flush, type Edit, type LazyEdit } from './predictions.harness';
import type { PredictionStateMsg, PredictionsView, PredictionToast } from './store';

const source = sourceOf('./sockets.ts'), P = 'R338 socket: ';
const msg = (ev: shared.PredictionEventDto | null = event(), eventId = ev?.id ?? 'event'): PredictionStateMsg => ({
  t: 'prediction.state', serverId: 's', serverNow: iso(), event: ev, eventId,
});
const view = (events: shared.PredictionEventDto[] = []): PredictionsView => ({ enabled: true, betMax: 300, canManage: false, events, skewMs: 0 });
function fixture(raw: string) {
  const sounds: string[] = [], applied: PredictionStateMsg[] = [], toasts: PredictionToast[] = [];
  const ensures: Array<[string | null | undefined, boolean | undefined]> = [], sockets: Socket[] = [];
  const state = {
    user: { id: 'me', economyPreview: true } as { id: string; economyPreview: boolean } | null,
    bootstrap: { server: { id: 's' } } as { server: { id: string } } | null,
    currentServerId: 'stale', serverFeatures: [], convActive: false,
    voice: { serverId: 's', channelId: 'vc' } as { serverId: string; channelId: string } | null,
    duels: {}, economy: {}, wheel: {}, predictions: {} as Record<string, PredictionsView>,
    selfDeafened: false, activitiesOpen: null as { serverId: string; view: 'events' | 'list' } | null,
    setActivities: noop, resyncAfterReconnect: async () => {}, rejoinVoiceAfterOutage: async () => {},
    setPredictionToast: (toast: PredictionToast) => { toasts.push(toast); },
    applyPredictionEvent: (message: PredictionStateMsg) => {
      applied.push(message); const prev = state.predictions[message.serverId];
      if (!prev) return false;
      state.predictions[message.serverId] = { ...prev, events: message.event ? [message.event, ...prev.events.filter(e => e.id !== message.eventId)]
        : prev.events.filter(e => e.id !== message.eventId) };
      return true;
    },
  };
  class Socket {
    static OPEN = 1; static CONNECTING = 0; readyState = 0;
    onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: string }) => void;
    constructor(_url: string) { sockets.push(this); }
    send(_frame: string) {} close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; assert.ok(this.onopen, 'R338 setup: установлен onopen'); this.onopen(); }
    receive(frame: unknown) { assert.ok(this.onmessage, 'R338 setup: установлен onmessage'); this.onmessage({ data: JSON.stringify(frame) }); }
  }
  const deps: Record<string, unknown> = Object.fromEntries([
    './channelRules', './serverRowRules', './dmListRules', './readByView', './coinsCue', './memberName', './flashWindow', './coinNotifyRules',
    './notifyRules', './dmStickers', './dmFolders', './peerName', './contacts', './savedGifs', './channelPrefs', './hotkeys', './effectsBus',
    './effectsDom', './tipMode', './toast', './dmOnline', './typing',
  ].map(id => [id, {}]));
  Object.assign(deps, {
    '@gusvoice/shared': shared, './gatewaySubs': subs, './store': { useStore: { getState: () => state, subscribe: () => noop } },
    './api': { api: { listServers: async () => [{ id: 's' }, { id: 'voice' }, { id: 'unopened' }], getActivities: async () => ({ activities: {} }) }, getToken: () => 'synthetic-unused-session' },
    './config': { config: { economyEnabled: true }, gatewayWsUrl: () => 'ws://localhost/synthetic-gateway' },
    './connState': { resetGatewayLive: noop, setGatewayLive: noop }, './presenceVisibility': { presentNow: () => true, watchPresence: noop },
    './bgGateways': { setBgPresent: noop }, './notifications': { setNotifyPrefs: noop, windowFocused: () => false },
    './socketHealth': { CONNECT_TIMEOUT_MS: 15_000, PING_MS: 25_000, socketStale: () => false }, './callStore': {},
    './callView': { serverCalls: () => false }, './convSyncRules': { serverPush2: () => false },
    './sounds': { playSound: (sound: string) => sounds.push(sound) },
    './economyClient': { ensureEconomy: noop, ensureDuel: noop, ensureWheel: noop,
      ensurePredictions: (id: string | null | undefined, force?: boolean) => ensures.push([id, force]) },
  });
  let timer = 0;
  const m = load<typeof import('./sockets')>(raw, deps, { Date: FixedDate, WebSocket: Socket,
    window: { addEventListener: noop }, document: { addEventListener: noop },
    setTimeout: () => ++timer, clearTimeout: noop, setInterval: () => ++timer, clearInterval: noop });
  m.connectGateway();
  assert.equal(sockets.length, 1, 'R338 setup: создан gateway'); sockets[0].open();
  return { state, sounds, applied, toasts, ensures, socket: sockets[0] };
}
type Fixture = ReturnType<typeof fixture>;
function test(title: string, check: (f: Fixture) => void | Promise<void>, edits: readonly LazyEdit[]) {
  it(`R338 сокет событий: ${title}`, () => pairedAsync(source, async raw => { await check(fixture(raw)); }, edits, P));
}
const READY = 'for (const id of new Set([sid, store.voice?.serverId])) if (id && store.predictions?.[id]) ensurePredictions(id, true);';
test('ready обновляет только существующие снимки окна и голоса с force, без дубля', async f => {
  f.state.voice = { serverId: 'voice', channelId: 'vc' };
  f.state.predictions = { s: view(), voice: view(), unopened: view(), stale: view() };
  f.socket.receive({ t: 'ready' }); await flush();
  assert.deepEqual(f.ensures, [['s', true], ['voice', true]], P + 'ready два нужных снимка');
  f.ensures.length = 0; f.state.voice.serverId = 's';
  f.socket.receive({ t: 'ready' }); await flush();
  assert.deepEqual(f.ensures, [['s', true]], P + 'одинаковый сервер не удваивается');
  f.ensures.length = 0; f.state.predictions = {};
  f.socket.receive({ t: 'ready' }); await flush();
  assert.deepEqual(f.ensures, [], P + 'без снимка ready молчит');
}, [() => [READY, READY.replace('if (id && store.predictions?.[id])', 'if (id)')],
  () => [READY, READY.replace('ensurePredictions(id, true)', 'ensurePredictions(id)')],
  () => [READY, READY.replace('new Set([sid, store.voice?.serverId])', '[sid, store.voice?.serverId]')],
  () => [READY, READY.replace('[sid, store.voice?.serverId]', '[sid]')]]);

test('событие всегда передаётся стору, без снимка запрашивает fallback по серверу события', f => {
  f.socket.receive(msg());
  assert.equal(f.applied.length, 1, P + 'доставка action');
  assert.deepEqual(f.ensures, [['s', undefined]], P + 'fallback без снимка');
  f.state.predictions.s = view(); f.ensures.length = 0;
  f.socket.receive(msg(null));
  assert.equal(f.applied.length, 2, P + 'null тоже доставлен');
  assert.deepEqual(f.ensures, [], P + 'готовый снимок без HTTP');
}, [['if (!store.applyPredictionEvent(msg)) ensurePredictions(msg.serverId);', 'store.applyPredictionEvent(msg);'],
  ['if (!store.applyPredictionEvent(msg)) ensurePredictions(msg.serverId);', 'store.applyPredictionEvent(msg); ensurePredictions(msg.serverId);']]);

const NEW = 'ev.createdBy !== me &&';
test('новое событие даёт один тост сидящему в голосе этого сервера, даже при повторе без снимка', f => {
  // Парная граница к «ровно две минуты уже старое»: последняя миллисекунда перед пределом ещё новая.
  const fresh = event('event', { createdAt: iso(-119_999) });
  f.socket.receive(msg(fresh)); f.socket.receive(msg(fresh));
  assert.deepEqual(f.toasts.map(t => [t.id, t.serverId, t.eventId, t.kind, t.amount, t.until]),
    [['new:event', 's', 'event', 'new', 0, FixedDate.now() + 12_000]], P + 'один новый тост');
  assert.equal(f.sounds.length, 0, P + 'новое событие без звука');
}, [['          !predictionToastSeen.has(ev.id)', '          true'],
  ['predictionToastSeen.add(ev.id);', 'void 0;']]);

for (const row of [
  { title: 'создателю не показывается', prep: (f: Fixture, ev: shared.PredictionEventDto) => { ev.createdBy = 'me'; }, edit: [NEW, 'true &&'] },
  { title: 'без голоса не показывается', prep: (f: Fixture) => { f.state.voice = null; }, edit: ['store.voice?.serverId === msg.serverId &&', 'true &&'] },
  { title: 'голос другого сервера не подходит', prep: (f: Fixture) => { f.state.voice!.serverId = 'other'; }, edit: ['store.voice?.serverId === msg.serverId &&', '!!store.voice &&'] },
  { title: 'открытая лента не получает новый тост', prep: (f: Fixture) => { f.state.activitiesOpen = { serverId: 's', view: 'events' }; }, edit: ['          !feedOpen &&', '          true &&'] },
  { title: 'событие уже в ленте не новое', prep: (f: Fixture) => { f.state.predictions.s = view([event()]); }, edit: ['          !before &&', '          true &&'] },
  { title: 'старое событие не новое — ровно две минуты уже поздно', prep: (_f: Fixture, ev: shared.PredictionEventDto) => { ev.createdAt = iso(-120_000); }, edit: ['fresh(ev.createdAt) &&', 'true &&'] },
] satisfies Array<{ title: string; prep(f: Fixture, ev: shared.PredictionEventDto): void; edit: Edit }>) {
  test(row.title, f => {
    const ev = event(); row.prep(f, ev); f.socket.receive(msg(ev));
    assert.deepEqual(f.toasts, [], P + row.title);
  }, [row.edit]);
}

const winner = () => event('won', { state: 'settled', settledAt: iso(), questions: [
  { ...question(), winnerOptionId: 'a', bets: [{ userId: 'me', optionId: 'a', amount: 100, payout: 280, refunded: false }] },
] });
test('выигрыш суммирует только угаданные невозвращённые вопросы, повтор не дублирует тост', f => {
  const ev = winner();
  ev.questions.push({ ...question('refund'), winnerOptionId: 'a', bets: [{ userId: 'me', optionId: 'a', amount: 11, payout: 11, refunded: true }] },
    { ...question('wrong'), winnerOptionId: 'b', bets: [{ userId: 'me', optionId: 'a', amount: 12, payout: 12, refunded: false }] },
    { ...question('other'), winnerOptionId: 'a', bets: [{ userId: 'other', optionId: 'a', amount: 20, payout: 30, refunded: false }] });
  f.socket.receive(msg(ev)); f.socket.receive(msg(ev));
  assert.deepEqual(f.toasts.map(t => [t.id, t.kind, t.amount]), [['win:won', 'win', 280]], P + 'только правильные личные выплаты');
  assert.deepEqual(f.sounds, ['predictionResult'], P + 'этап7 новый звук один раз, не duelWin');
}, [['b && !b.refunded && q.winnerOptionId === b.optionId &&', 'b && q.winnerOptionId === b.optionId &&'],
  ['b && !b.refunded && q.winnerOptionId === b.optionId &&', 'b && !b.refunded &&'],
  ["playSound('predictionResult')", "playSound('duelWin')"],
  ['predictionToastSeen.add(`win:${ev.id}`);', 'void 0;']]);

for (const [name, prepare, edit] of [
  ['глухота', (f: Fixture) => { f.state.selfDeafened = true; }, ['if (!feedOpen && !store.selfDeafened) playSound', 'if (!feedOpen) playSound']],
  ['открытая лента', (f: Fixture) => { f.state.activitiesOpen = { serverId: 's', view: 'events' }; }, ['if (!feedOpen && !store.selfDeafened) playSound', 'if (!store.selfDeafened) playSound']],
] as const) test(`этап7 ${name} глушит звук, но не выигрышный тост`, f => {
  prepare(f); f.socket.receive(msg(winner()));
  assert.deepEqual(f.sounds, [], P + 'этап7 звук заглушён');
  assert.deepEqual(f.toasts.map(t => [t.kind, t.amount]), [['win', 280]], P + 'этап7 тост сохранён');
}, [edit]);

test('старый раскрытый итог не празднуется, но переход известного locked в settled празднуется', f => {
  const ev = winner(); ev.settledAt = iso(-120_000);
  f.socket.receive(msg(ev)); assert.equal(f.toasts.length, 0, P + 'старый результат молчит');
  f.state.predictions.s = view([{ ...ev, state: 'locked' }]); f.socket.receive(msg(ev));
  assert.deepEqual(f.toasts.map(t => t.amount), [280], P + 'известный переход празднуется');
}, [["const justSettled = ev.state === 'settled' && (before ? before.state !== 'settled' : fresh(ev.settledAt));",
  "const justSettled = ev.state === 'settled';"]]);
