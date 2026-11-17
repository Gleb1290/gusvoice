import { counterfact } from "../../../packages/shared/test/counterfacts.js";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as subs from './gatewaySubs';
import type { DuelStateMsg, VoiceConnection } from './store';

const source = readFileSync(new URL('./sockets.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Edit = readonly [string, string];
type LazyEdit = Edit | (() => Edit);
const noop = () => {};
const normal = (v: unknown) => JSON.parse(JSON.stringify(v));
const NOW = Date.parse('2026-10-28T12:00:00Z');
const duel = (patch: Partial<shared.DuelDto> = {}): shared.DuelDto => ({ id: 'd', serverId: 's', channelId: 'c', game: 'dice',
  challengerId: 'a', targetId: 'me', amount: 10, feePercent: 10, state: 'invited', inviteUntil: new Date(NOW + 30_000).toISOString(),
  commit: 'a'.repeat(64), rollNo: 0, turnUntil: null, rolls: [], winnerId: null, payout: null, seed: null, reason: null, settledAt: null, ...patch });
const event = (d: shared.DuelDto | null): DuelStateMsg => ({ t: 'duel.state', serverId: 's', channelId: 'c', serverNow: new Date(NOW).toISOString(), duel: d });
function fixture(raw = source) {
  const sockets: Socket[] = [], sounds: string[] = [], applied: DuelStateMsg[] = [], toasts: unknown[] = [], ensures: unknown[][] = [];
  let voiceHere = true;
  const state = {
    user: { id: 'me' } as { id: string } | null, bootstrap: { server: { id: 's' } }, serverFeatures: [], convActive: false,
    voice: { serverId: 's', channelId: 'c' } as (Pick<VoiceConnection, 'serverId' | 'channelId'> & Partial<Pick<VoiceConnection, 'instanceId'>>) | null,
    duels: {} as Record<string, { duel: shared.DuelDto } | null>, duelInvite: null as { duel: shared.DuelDto } | null,
    gameToast: null as { id: string } | null, selfDeafened: false,
    activitiesOpen: null as { view: string; channelId?: string } | null,
    setActivities: noop, resyncAfterReconnect: async () => {}, rejoinVoiceAfterOutage: async () => {},
    applyDuelEvent(msg: DuelStateMsg) {
      applied.push(msg); state.duels[msg.channelId] = msg.duel ? { duel: msg.duel } : null;
      if (msg.duel?.state === 'invited' && msg.duel.targetId === state.user?.id) state.duelInvite = { duel: msg.duel };
      else if (state.duelInvite?.duel.id === msg.duel?.id) state.duelInvite = null;
    },
    setGameToast(t: { id: string }) { toasts.push(t); state.gameToast = t; },
  };
  const store = { getState: () => state, subscribe: () => noop };
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; sent: Array<{ t: string; caps?: string[] }> = [];
    onopen?: () => void; onclose?: () => void; onmessage?: (event: { data: string }) => void;
    constructor(_url: string) { sockets.push(this); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; assert.ok(this.onopen, 'R334 setup: onopen установлен'); this.onopen(); }
    receive(msg: unknown) { assert.ok(this.onmessage, 'R334 setup: onmessage установлен'); this.onmessage({ data: JSON.stringify(msg) }); }
  }
  const deps: Record<string, unknown> = Object.fromEntries(['./channelRules', './serverRowRules', './dmListRules', './readByView', './coinsCue', './memberName',
    './flashWindow', './coinNotifyRules', './notifyRules', './dmStickers', './dmFolders', './peerName', './contacts', './savedGifs', './channelPrefs',
    './hotkeys', './effectsBus', './effectsDom', './tipMode', './toast', './dmOnline', './typing'].map(id => [id, {}]));
  Object.assign(deps, {
    '@gusvoice/shared': shared, './gatewaySubs': subs, './store': { useStore: store, voiceIsHere: () => voiceHere },
    './api': { api: { listServers: async () => [], getActivities: async () => ({ activities: {} }) }, getToken: () => 'synthetic-unused' },
    './config': { config: {}, gatewayWsUrl: () => 'ws://localhost/synthetic' },
    './connState': { resetGatewayLive: noop, setGatewayLive: noop }, './presenceVisibility': { presentNow: () => true, watchPresence: noop },
    './bgGateways': { setBgPresent: noop }, './notifications': { setNotifyPrefs: noop, windowFocused: () => false },
    './socketHealth': { CONNECT_TIMEOUT_MS: 15_000, PING_MS: 25_000, socketStale: () => false },
    './callStore': {}, './callView': { serverCalls: () => false }, './convSyncRules': { serverPush2: () => false },
    './sounds': { playSound: (name: string) => sounds.push(name) },
    './economyClient': { ensureEconomy: noop, ensureWheel: noop, ensurePredictions: noop,
      ensureDuel: (...args: unknown[]) => ensures.push(args) },
  });
  const module = { exports: {} as typeof import('./sockets') };
  class TestDate extends Date { static override now() { return NOW; } }
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date: TestDate, WebSocket: Socket, window: { addEventListener: noop }, document: { addEventListener: noop },
      setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop, require(id: string) {
        assert.ok(Object.hasOwn(deps, id), `R334 setup: закрытый импорт ${id}`); return deps[id];
      } });
  module.exports.connectGateway(); sockets[0].open();
  return { socket: sockets[0], state, sounds, applied, toasts, ensures, setVoiceHere: (value: boolean) => { voiceHere = value; } };
}
type Fixture = ReturnType<typeof fixture>;
function paired(title: string, check: (f: Fixture) => void, ...edits: LazyEdit[]) {
  it(title, () => {
    check(fixture());
    for (const edit of edits) {
      counterfact(() => {
        const [from, to] = typeof edit === 'function' ? edit() : edit;
        assert.equal(source.split(from).length, 2, 'R334 setup: уникальный якорь целого sockets');
        assert.throws(() => check(fixture(source.replace(from, to))), e => e instanceof assert.AssertionError && e.message.startsWith('duel socket:'),
          'контрфакт ломает наблюдаемый dispatch, не импорт');
      });
      check(fixture());
    }
  });
}
paired('R337 identify действительно объявляет duel2 шлюзу', f => {
  const frame = f.socket.sent.find(x => x.t === 'identify');
  assert.equal(frame?.caps?.filter(x => x === shared.FEATURE_DUEL2).length, 1, 'duel socket: выборные игры объявлены один раз');
}, ['caps?.push(FEATURE_DUEL2);', '']);
paired('R334 ready перечитывает известный null канала голоса с force, незагруженный канал не создаёт', f => {
  f.state.duels.c = null; f.socket.receive({ t: 'ready' });
  assert.deepEqual(f.ensures, [['s', 'c', true]], 'duel socket: reconnect восстанавливает даже пустой снимок');
  f.ensures.length = 0; f.state.duels = {}; f.socket.receive({ t: 'ready' });
  assert.deepEqual(f.ensures, [], 'duel socket: ready не загружает ненужную дуэль');
}, ['if (vc && store.duels?.[vc] !== undefined) ensureDuel(store.voice?.serverId ?? sid, vc, true);',
  'if (vc && store.duels?.[vc]) ensureDuel(store.voice?.serverId ?? sid, vc, true);']);
// R378: звук зависит от устройства в голосе, доставка карточки — нет. Без контрфактов.
it('приглашение звучит цели в своём голосовом канале один раз, не вызывающему и не при деафене', () => {
  const f = fixture();
  f.socket.receive(event(duel())); f.socket.receive(event(duel()));
  assert.deepEqual(f.sounds, ['duelInvite'], 'duel socket: повтор одного приглашения молчит');
  assert.equal(f.applied.length, 2, 'duel socket: повтор всё равно дошёл до среза');
  f.socket.receive(event(duel({ id: 'next', targetId: 'other', challengerId: 'me' })));
  f.state.selfDeafened = true; f.socket.receive(event(duel({ id: 'muted' })));
  assert.deepEqual(f.sounds, ['duelInvite'], 'duel socket: чужой вызов и деафен молчат');
  assert.equal(f.state.duelInvite?.duel.id, 'muted', 'деафен не скрывает адресную карточку');
  assert.equal(f.applied.length, 4, 'все снимки по-прежнему применены');
});
it('вне голоса, в другом канале и на чужом инстансе вызов доставляет карточку без звука', () => {
  const rows: Array<{ title: string; voice: Fixture['state']['voice']; here: boolean }> = [
    { title: 'голоса нет', voice: null, here: true },
    { title: 'другой канал', voice: { serverId: 's', channelId: 'other' }, here: true },
    { title: 'тот же канал на чужом инстансе', voice: { serverId: 's', channelId: 'c', instanceId: 'remote' }, here: false },
  ];
  for (const row of rows) {
    const f = fixture(); f.state.voice = row.voice; f.setVoiceHere(row.here);
    const d = duel({ id: row.title });
    f.socket.receive(event(d)); f.socket.receive(event(d));
    assert.deepEqual(f.sounds, [], row.title);
    assert.deepEqual(normal(f.state.duelInvite?.duel), d, 'тишина не теряет карточку с данными вызова');
    assert.equal(f.applied.length, 2, 'даже повтор снимка применён, не отрезан голосовым гейтом');
  }
});
it('одна учётка получает карточку на ПК и телефоне, но вызов звучит только на ПК в голосе', () => {
  const pc = fixture(), phone = fixture(); phone.state.voice = null;
  assert.equal(pc.state.user?.id, phone.state.user?.id);
  const d = duel();
  for (const f of [pc, phone]) {
    f.socket.receive(event(d)); f.socket.receive(event(d));
    assert.deepEqual(normal(f.state.duelInvite?.duel), d);
    assert.equal(f.applied.length, 2);
  }
  assert.deepEqual(pc.sounds, ['duelInvite']);
  assert.deepEqual(phone.sounds, []);
});
it('тот же сокет учитывает вход и выход из голоса, но не озвучивает повтор старой карточки после входа', () => {
  const f = fixture(); f.state.voice = null;
  const old = duel({ id: 'before-join' }); f.socket.receive(event(old));
  assert.deepEqual(f.sounds, []);
  f.state.voice = { serverId: 's', channelId: 'c' };
  f.socket.receive(event(old));
  assert.deepEqual(f.sounds, [], 'вход в голос не переигрывает уже полученный вызов');
  f.socket.receive(event(duel({ id: 'in-voice' })));
  assert.deepEqual(f.sounds, ['duelInvite'], 'новый вызов после входа слышен');
  f.state.voice = null; f.socket.receive(event(duel({ id: 'after-leave' })));
  assert.deepEqual(f.sounds, ['duelInvite'], 'после выхода новый вызов снова тихий');
  assert.equal(f.state.duelInvite?.duel.id, 'after-leave', 'карточки обновляются и после выхода');
  assert.equal(f.applied.length, 4);
});
const TOAST = "if (started && !player && store.voice?.channelId === msg.channelId && store.gameToast?.id !== d.id)";
paired('R334 тост зрителю в канале содержит адрес игры, живёт 10 секунд и не повторяется', f => {
  const d = duel({ state: 'playing', targetId: 'b', game: 'greedy' });
  f.socket.receive(event(d)); f.socket.receive(event(d));
  f.state.gameToast = null; f.socket.receive(event(d));
  f.state.duels = {}; f.state.gameToast = { id: 'd' }; f.socket.receive(event(d));
  assert.deepEqual(normal(f.toasts), [{ id: 'd', serverId: 's', channelId: 'c', challengerId: 'a', targetId: 'b', amount: 10,
    until: NOW + 10_000, game: 'greedy' }], 'duel socket: один адресный тост начала партии');
}, () => [TOAST, TOAST.replace('started && ', '')], () => [TOAST, TOAST.replace(' && store.gameToast?.id !== d.id', '')],
  ['until: Date.now() + 10_000,', 'until: Date.now(),']);
paired('R334 игроку и сидящему в другом канале тост начала не показывается', f => {
  f.socket.receive(event(duel({ state: 'playing' })));
  f.state.voice = { serverId: 's', channelId: 'other' };
  f.socket.receive(event(duel({ id: 'other', state: 'playing', targetId: 'b' })));
  f.state.voice = null; f.socket.receive(event(duel({ id: 'none', state: 'playing', targetId: 'b' })));
  assert.deepEqual(f.toasts, [], 'duel socket: тост только постороннему зрителю своей комнаты');
}, () => [TOAST, TOAST.replace('!player && ', '')], () => [TOAST, TOAST.replace('store.voice?.channelId === msg.channelId && ', '')]);
// R377: звуковые итоги проверяются через настоящий dispatch, без подмены исходника.
it('выигрыш закрытой сцены звучит один раз, null и отсутствие пользователя безопасны', () => {
  const f = fixture();
  const d = duel({ state: 'settled', winnerId: 'me' });
  f.socket.receive(event(d)); f.socket.receive(event(d)); f.socket.receive(event(null));
  assert.deepEqual(f.sounds, ['duelWin'], 'duel socket: один итог один победный звук');
  f.state.user = null; f.socket.receive(event(duel({ id: 'anonymous', state: 'settled', winnerId: 'me' })));
  assert.deepEqual(f.sounds, ['duelWin'], 'duel socket: после выхода нет личного звука');
  assert.equal(f.applied.length, 4, 'duel socket: null и выход не блокируют обновление среза');
});
it('проигравший вызывающий и приглашённый слышат только поражение один раз во всех играх', () => {
  const f = fixture();
  const expected: string[] = [];
  for (const game of ['dice', 'greedy', 'rps'] as const) for (const challenger of [false, true]) {
    const d = duel({ id: `${game}-${challenger}`, game, state: 'playing',
      challengerId: challenger ? 'me' : 'a', targetId: challenger ? 'a' : 'me' });
    f.socket.receive(event(d));
    assert.deepEqual(f.sounds, expected, 'duel socket: начало партии не звучит как поражение');
    const settled = { ...d, state: 'settled' as const, winnerId: 'a' };
    f.socket.receive(event(settled)); f.socket.receive(event(settled));
    expected.push('duelLose');
    assert.deepEqual(f.sounds, expected, `duel socket: ${game}, вызывающий=${challenger}, без победного звука и дубля`);
  }
  assert.equal(f.applied.length, 18, 'duel socket: повтор итога доходит до среза, но не повторяет звук');
});
it('зритель, ничья и деафен не озвучивают итог, но обновляют дуэль', () => {
  const f = fixture();
  const cases = [
    { id: 'spectator-a', challengerId: 'a', targetId: 'b', winnerId: 'a', deafened: false },
    { id: 'spectator-b', challengerId: 'a', targetId: 'b', winnerId: 'b', deafened: false },
    { id: 'draw', challengerId: 'a', targetId: 'me', winnerId: null, deafened: false },
    { id: 'muted-win', challengerId: 'a', targetId: 'me', winnerId: 'me', deafened: true },
    { id: 'muted-lose', challengerId: 'a', targetId: 'me', winnerId: 'a', deafened: true },
  ];
  for (const { deafened, ...patch } of cases) {
    f.state.selfDeafened = deafened;
    f.socket.receive(event(duel({ ...patch, game: 'rps', state: 'settled' })));
    assert.deepEqual(f.sounds, [], `duel socket: ${patch.id} молчит`);
    assert.equal(f.state.duels.c?.duel.id, patch.id, 'duel socket: тишина не блокирует событие');
  }
  assert.equal(f.applied.length, cases.length);
});
it('открытая сцена своего канала не дублирует ни победу, ни поражение из сокета', () => {
  const f = fixture();
  f.state.activitiesOpen = { view: 'duel', channelId: 'c' };
  for (const winnerId of ['me', 'a']) f.socket.receive(event(duel({
    id: `open-${winnerId}`, game: 'rps', state: 'settled', winnerId,
  })));
  assert.deepEqual(f.sounds, [], 'duel socket: собственная сцена озвучивает оба исхода сама');
  assert.equal(f.applied.length, 2, 'duel socket: открытая сцена получает оба исхода');
});
it('сцена другого канала и список активностей не заглушают победу или поражение', () => {
  const f = fixture();
  for (const view of ['duel', 'list']) {
    f.state.activitiesOpen = { view, channelId: view === 'duel' ? 'other' : 'c' };
    for (const winnerId of ['me', 'a']) f.socket.receive(event(duel({
      id: `${view}-${winnerId}`, state: 'settled', winnerId,
    })));
  }
  assert.deepEqual(f.sounds, ['duelWin', 'duelLose', 'duelWin', 'duelLose'],
    'duel socket: только собственная сцена перехватывает оба звука');
  assert.equal(f.applied.length, 4);
});
