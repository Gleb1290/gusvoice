import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as shared from '@gusvoice/shared';
import * as subs from './gatewaySubs';
import { event, FixedDate, iso, load, noop, edited, sourceOf, type Edit } from './predictions.harness';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
function paired(source: string, check: (raw: string) => void, edits: readonly Edit[], prefix: string): void {
  check(source);
  for (const edit of edits) {
    counterfact(() => {
        const mutant = edited(source, edit);
        assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.startsWith(prefix),
          'контрфакт убит адресным host AssertionError, не setup/import/исключением');
    });
    check(source);
  }
}
import type { PredictionStateMsg, PredictionsView } from './store';

const source = sourceOf('./predictionSounds.ts'), socketSource = sourceOf('./sockets.ts');
const P = 'R351 звуки событий: ';
type Toast = { id: string; kind: 'new' | 'win' };
type SoundState = { predictionToast: Toast | null; selfDeafened: boolean };

function openFixture(raw: string) {
  const sounds: string[] = [];
  let state: SoundState = { predictionToast: null, selfDeafened: false };
  const listeners = new Set<(s: SoundState, prev: SoundState) => void>();
  const module = load<typeof import('./predictionSounds')>(raw, {
    './sounds': { playSound: (name: string) => sounds.push(name) },
    './store': { useStore: { subscribe(callback: (s: SoundState, prev: SoundState) => void) {
      listeners.add(callback); return () => { listeners.delete(callback); };
    } } },
  });
  const uninstall = module.installPredictionOpenSound();
  return { sounds, listeners, uninstall,
    update(patch: Partial<SoundState>) {
      const prev = state; state = { ...prev, ...patch };
      for (const listener of listeners) listener(state, prev);
    } };
}
function openTest(title: string, check: (f: ReturnType<typeof openFixture>) => void, edits: Edit[]) {
  it(`R351 ${title}`, () => paired(source, raw => check(openFixture(raw)), edits, P));
}

// Смена другого поля стора и новый объект того же тоста не означают новое событие для слушателя.
openTest('новый тост играет чайку один раз, повтор того же id и прочие обновления молчат', f => {
  f.update({ predictionToast: { id: 'new:a', kind: 'new' } });
  f.update({ predictionToast: { id: 'new:a', kind: 'new' } });
  f.update({ selfDeafened: false });
  assert.deepEqual(f.sounds, ['predictionOpen'], P + 'одна чайка на появление нового id');
  f.update({ predictionToast: { id: 'new:b', kind: 'new' } });
  assert.deepEqual(f.sounds, ['predictionOpen', 'predictionOpen'], P + 'другое событие не потеряно');
}, [["t.id === prev.predictionToast?.id", 'false'], ["playSound('predictionOpen')", "playSound('predictionClosed')"]]);

// Полка результата не является объявлением: иначе победа получила бы одновременно две разные мелодии.
openTest('пустая полка и выигрышный тост не играют чайку; следующий new играет', f => {
  f.update({ predictionToast: null });
  f.update({ predictionToast: { id: 'win:a', kind: 'win' } });
  assert.deepEqual(f.sounds, [], P + 'пустая полка и итог молчат');
  f.update({ predictionToast: { id: 'new:b', kind: 'new' } });
  assert.deepEqual(f.sounds, ['predictionOpen'], P + 'настоящий анонс принят');
}, [["t.kind !== 'new'", 'false']]);

// Выключение глухоты не должно задним числом проигрывать уже увиденное объявление.
openTest('деафен глушит чайку, снятие деафена не повторяет тост, новый тост после него звучит', f => {
  f.update({ selfDeafened: true, predictionToast: { id: 'new:a', kind: 'new' } });
  f.update({ selfDeafened: false });
  assert.deepEqual(f.sounds, [], P + 'заглушенный анонс не догоняет после деафена');
  f.update({ predictionToast: { id: 'new:b', kind: 'new' } });
  assert.deepEqual(f.sounds, ['predictionOpen'], P + 'новое объявление после деафена слышно');
}, [["if (!s.selfDeafened) playSound('predictionOpen');", "playSound('predictionOpen');"]]);

// Снятие установленного слушателя — настоящая уборка подписки, не только флаг внутри callback.
openTest('удаление слушателя снимает подписку и больше не звучит', f => {
  f.update({ predictionToast: { id: 'new:a', kind: 'new' } });
  assert.deepEqual(f.sounds, ['predictionOpen'], P + 'до уборки анонс звучит');
  f.uninstall();
  assert.equal(f.listeners.size, 0, P + 'подписка действительно снята');
  f.update({ predictionToast: { id: 'new:b', kind: 'new' } });
  assert.deepEqual(f.sounds, ['predictionOpen'], P + 'после уборки новый анонс молчит');
}, [[source, (counterfact(() => source.replace('return useStore.subscribe(', 'useStore.subscribe(')
  .replace('  });\n}', '  });\n  return () => {};\n}')) ?? '')]]);

// predictionClosed в актуальном коде приходит НЕ из predictionToast, а из живого open→locked в sockets.ts.
// Этот харнесс исполняет весь sockets.ts с теми же границами IO, что sockets.predictions.test.ts.
function closedFixture(raw: string) {
  const sounds: string[] = [], sockets: Socket[] = [];
  const state = {
    user: { id: 'me', economyPreview: true }, bootstrap: { server: { id: 's' } }, currentServerId: 's',
    serverFeatures: [], convActive: false,
    voice: { serverId: 's', channelId: 'vc' } as { serverId: string; channelId: string } | null,
    duels: {}, economy: {}, wheel: {}, predictions: {} as Record<string, PredictionsView>,
    selfDeafened: false, activitiesOpen: null,
    setActivities: noop, setPredictionToast: noop, resyncAfterReconnect: async () => {}, rejoinVoiceAfterOutage: async () => {},
    applyPredictionEvent(message: PredictionStateMsg) {
      const prev = state.predictions[message.serverId];
      if (!prev) return false;
      state.predictions[message.serverId] = { ...prev, events: message.event
        ? [message.event, ...prev.events.filter(e => e.id !== message.eventId)] : prev.events.filter(e => e.id !== message.eventId) };
      return true;
    },
  };
  class Socket {
    static OPEN = 1; static CONNECTING = 0; readyState = 0;
    onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: string }) => void;
    constructor(_url: string) { sockets.push(this); }
    send(_frame: string) {} close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; assert.ok(this.onopen, 'R351 setup: gateway onopen'); this.onopen(); }
    receive(frame: unknown) { assert.ok(this.onmessage, 'R351 setup: gateway onmessage'); this.onmessage({ data: JSON.stringify(frame) }); }
  }
  const deps: Record<string, unknown> = Object.fromEntries([
    './channelRules', './serverRowRules', './dmListRules', './readByView', './coinsCue', './memberName', './flashWindow', './coinNotifyRules',
    './notifyRules', './dmStickers', './dmFolders', './peerName', './contacts', './savedGifs', './channelPrefs', './hotkeys', './effectsBus',
    './effectsDom', './tipMode', './toast', './dmOnline', './typing',
  ].map(id => [id, {}]));
  Object.assign(deps, {
    '@gusvoice/shared': shared, './gatewaySubs': subs, './store': { useStore: { getState: () => state, subscribe: () => noop } },
    './api': { api: { listServers: async () => [{ id: 's' }], getActivities: async () => ({ activities: {} }) }, getToken: () => 'synthetic-session' },
    './config': { config: { economyEnabled: true }, gatewayWsUrl: () => 'ws://localhost/synthetic-gateway' },
    './connState': { resetGatewayLive: noop, setGatewayLive: noop }, './presenceVisibility': { presentNow: () => true, watchPresence: noop },
    './bgGateways': { setBgPresent: noop }, './notifications': { setNotifyPrefs: noop, windowFocused: () => false },
    './socketHealth': { CONNECT_TIMEOUT_MS: 15_000, PING_MS: 25_000, socketStale: () => false }, './callStore': {},
    './callView': { serverCalls: () => false }, './convSyncRules': { serverPush2: () => false },
    './sounds': { playSound: (name: string) => sounds.push(name) },
    './economyClient': { ensureEconomy: noop, ensureDuel: noop, ensureWheel: noop, ensurePredictions: noop },
  });
  let timer = 0;
  const module = load<typeof import('./sockets')>(raw, deps, { Date: FixedDate, WebSocket: Socket,
    window: { addEventListener: noop }, document: { addEventListener: noop },
    setTimeout: () => ++timer, clearTimeout: noop, setInterval: () => ++timer, clearInterval: noop });
  module.connectGateway();
  assert.equal(sockets.length, 1, 'R351 setup: один gateway'); sockets[0].open();
  function before(ev = event()) {
    state.predictions.s = { enabled: true, betMax: 300, canManage: false, events: [ev], skewMs: 0 };
  }
  function receive(ev: shared.PredictionEventDto) {
    sockets[0].receive({ t: 'prediction.state', serverId: 's', serverNow: iso(), event: ev, eventId: ev.id });
  }
  return { state, sounds, before, receive };
}
function closedTest(title: string, check: (f: ReturnType<typeof closedFixture>) => void, edits: Edit[]) {
  it(`R351 ${title}`, () => paired(socketSource, raw => check(closedFixture(raw)), edits, P));
}

// Повтор сообщения без снимка тоже должен подавляться: одной проверки before.state недостаточно.
closedTest('живое закрытие даёт одну рынду; повтор со снимком и без снимка молчит', f => {
  const open = event(), locked = { ...open, state: 'locked' as const, lockedAt: iso() };
  f.before(open); f.receive(locked); f.receive(locked);
  f.state.predictions = {}; f.receive(locked);
  assert.deepEqual(f.sounds, ['predictionClosed'], P + 'одна рында на один переход');
}, [["playSound('predictionClosed')", "playSound('predictionOpen')"],
  ["!predictionToastSeen.has(`lock:${ev.id}`)", 'true']]);

// Снимок уже закрытого или давно закрытого события не должен звонить при переподключении.
closedTest('старый locked молчит, но известный open→locked принимается даже со старым lockedAt', f => {
  const locked = event('a', { state: 'locked', lockedAt: iso(-120_000) });
  f.receive(locked);
  assert.deepEqual(f.sounds, [], P + 'ровно двухминутное закрытие без снимка уже не свежее');
  f.before({ ...locked, state: 'open' }); f.receive(locked);
  assert.deepEqual(f.sounds, ['predictionClosed'], P + 'известный живой переход не теряется');
  f.before(event('b', { state: 'locked', lockedAt: iso() }));
  f.receive(event('b', { state: 'locked', lockedAt: iso() }));
  assert.deepEqual(f.sounds, ['predictionClosed'], P + 'уже закрытый снимок не звонит повторно');
}, [["const justLocked = ev.state === 'locked' && (before ? before.state === 'open' : fresh(ev.lockedAt));",
  "const justLocked = ev.state === 'locked';"]]);

// Закрытие слышит участник ставок вне голоса, но не произвольный зритель/создатель и не деафен.
closedTest('рында слышна поставившему вне голоса, но не создателю, постороннему или деафену', f => {
  f.state.voice = null;
  const ordinary = event('outsider', { state: 'locked', lockedAt: iso() }); f.receive(ordinary);
  const own = event('own', { state: 'locked', lockedAt: iso(), createdBy: 'me' }); f.state.voice = { serverId: 's', channelId: 'vc' }; f.receive(own);
  f.state.selfDeafened = true;
  f.receive(event('deaf', { state: 'locked', lockedAt: iso() }));
  assert.deepEqual(f.sounds, [], P + 'посторонний, создатель и деафен не слышат рынду');
  f.state.selfDeafened = false; f.state.voice = null;
  const mine = event('bettor', { state: 'locked', lockedAt: iso() });
  mine.questions[0].bets = [{ userId: 'me', optionId: 'a', amount: 10, payout: null, refunded: false }];
  f.receive(mine);
  assert.deepEqual(f.sounds, ['predictionClosed'], P + 'мой действующий взнос даёт рынду вне голоса');
}, [["me !== ev.createdBy && !predictionToastSeen.has(`lock:${ev.id}`)", "!predictionToastSeen.has(`lock:${ev.id}`)"],
  ["if (!store.selfDeafened) playSound('predictionClosed');", "playSound('predictionClosed');"],
  ["if (iBet || store.voice?.serverId === msg.serverId)", "if (store.voice?.serverId === msg.serverId)"]]);
