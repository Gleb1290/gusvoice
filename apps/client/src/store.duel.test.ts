import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { create } from 'zustand';
import type { DuelDto, DuelSnapshotDto } from '@gusvoice/shared';
import * as channel from './channelRules';
import * as conv from './convSyncRules';
import * as stream from './streamAudioRules';
import * as history from './historyPage';
import type { DuelSlice, DuelStateMsg } from './store';

const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
type Module = Pick<typeof import('./store'), 'useStore' | 'applyDuelSnapshot' | 'applyDuelState' | 'carryMyHand'>;
const NOW = Date.parse('2026-10-28T12:00:00Z');
const iso = (n = 0) => new Date(NOW + n).toISOString();
const normal = (v: unknown) => JSON.parse(JSON.stringify(v));
const duel = (patch: Partial<DuelDto> = {}): DuelDto => ({ id: 'duel', serverId: 's', channelId: 'c', game: 'dice',
  challengerId: 'a', targetId: 'me', amount: 10, feePercent: 10, state: 'invited', inviteUntil: iso(30_000), commit: 'a'.repeat(64),
  rollNo: 0, turnUntil: null, rolls: [], winnerId: null, payout: null, seed: null, reason: null, settledAt: null, ...patch });
const event = (d: DuelDto | null): DuelStateMsg => ({ t: 'duel.state', serverId: 's', channelId: 'c', serverNow: iso(3_000), duel: d });
const snap = (d: DuelDto | null, extra: Partial<DuelSnapshotDto> = {}): DuelSnapshotDto => ({ duel: d, myInvite: null, serverNow: iso(-2_000), ...extra });
function fixture(): Module {
  const noop = () => {};
  const fail = (name: string) => new Proxy({}, { get(_t, key) { assert.fail(`R334 setup: постороннее действие ${name}.${String(key)}`); } });
  const deps: Record<string, unknown> = {
    zustand: { create }, './api': { api: fail('api') }, './config': { activeInstanceId: () => 'synthetic-instance' },
    './channelRules': channel, './convSyncRules': conv, './streamAudioRules': stream, './historyPage': history,
    './convStore': { createConvActions: () => ({}) }, './instanceScope': { scopedGetItem: () => null },
    './channelPrefs': { markChannelSeen: noop }, './lastPlace': {}, './tabSync': {}, './hotkeys': { isMobile: () => false }, './sounds': {},
  };
  for (const id of ['./convCacheRules', './dmListRules', './convCache', './nativeUnifiedPush', './tipHints', './toastRules',
    './profilePatch', './voiceCueRules', './voiceSession']) deps[id] = fail(id);
  class TestDate extends Date { static override now() { return NOW; } }
  const module = { exports: {} as Module };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date: TestDate, localStorage: { getItem: () => null }, require(id: string) {
      assert.ok(Object.hasOwn(deps, id), `R334 setup: закрытый импорт ${id}`); return deps[id];
    } });
  module.exports.useStore.setState({ user: { id: 'me' } as never });
  return module.exports;
}
function paired(title: string, check: (m: Module) => void) {
  it(title, () => check(fixture()));
}
paired('R334 снимок пишет партию в свой канал с поправкой часов и не изменяет соседей', m => {
  const store = m.useStore;
  store.getState().setDuelSnapshot('other', 'other-c', snap(duel({ id: 'neighbor' })));
  const other = store.getState().duels['other-c'];
  store.getState().setDuelSnapshot('s', 'c', snap(duel()));
  assert.equal(store.getState().duels.c?.duel.id, 'duel', 'duel store: снимок пишет партию канала');
  assert.equal(store.getState().duels.c?.skewMs, -2_000, 'duel store: snapshot считает сервер минус клиент');
  assert.equal(store.getState().duels['other-c'], other, 'duel store: соседний канал не изменён');
  store.getState().setDuelSnapshot('s', 'c', snap(null));
  assert.equal(store.getState().duels.c, null, 'duel store: null снимка означает известное отсутствие партии');
});
paired('R334 снимок без входящего вызова снимает только вызов этого сервера', m => {
  const prev: DuelSlice = { duels: {}, duelInvite: { duel: duel(), skewMs: 0 } };
  const before = normal(prev);
  assert.equal(m.applyDuelSnapshot(prev, 's', 'c', snap(null), NOW).duelInvite, null, 'duel store: свой отсутствующий вызов снят');
  assert.equal(m.applyDuelSnapshot(prev, 'other', 'd', snap(null), NOW).duelInvite, prev.duelInvite, 'duel store: чужой вызов сохранён');
  const incoming = duel({ id: 'new' });
  assert.equal(m.applyDuelSnapshot(prev, 's', 'c', snap(null, { myInvite: incoming }), NOW).duelInvite?.duel, incoming, 'duel store: новый вызов принят');
  assert.equal(m.applyDuelSnapshot(prev, 's', 'c', snap(null, { myInvite: { ...incoming, state: 'playing' } }), NOW).duelInvite, null,
    'duel store: уже принятая партия не превращается во входящий вызов');
  assert.deepEqual(normal(prev), before, 'duel store: исходный срез не мутирован');
});
paired('R334 лимиты снимка обновляют свой сервер, старый снимок сохраняет прежние, комиссия без поля равна 10', m => {
  const store = m.useStore;
  store.setState({ duelLimits: { s: { betMax: 80, feePercent: 7 }, other: { betMax: 90, feePercent: 8 } } });
  store.getState().setDuelSnapshot('s', 'c', snap(null));
  assert.deepEqual(normal(store.getState().duelLimits.s), { betMax: 80, feePercent: 7 }, 'duel store: старый снимок не стирает лимиты');
  store.getState().setDuelSnapshot('s', 'c', snap(null, { betMax: 0 }));
  assert.deepEqual(normal(store.getState().duelLimits.s), { betMax: 0, feePercent: 10 }, 'duel store: нулевой потолок и default комиссии');
  store.getState().setDuelSnapshot('s', 'c', snap(null, { betMax: 300, feePercent: 0 }));
  assert.deepEqual(normal(store.getState().duelLimits.s), { betMax: 300, feePercent: 0 }, 'duel store: нулевая комиссия не заменяется default');
  assert.deepEqual(normal(store.getState().duelLimits.other), { betMax: 90, feePercent: 8 }, 'duel store: лимиты другого сервера сохранены');
});
paired('R334 invited сохраняется только цели, любое другое состояние той же партии снимает входящий вызов', m => {
  const store = m.useStore;
  for (const state of ['playing', 'settled', 'cancelled'] as const) {
    store.getState().setDuelSnapshot('s', 'c', snap(null)); // independent invitation lifecycle per case
    store.getState().applyDuelEvent(event(duel()));
    assert.equal(store.getState().duelInvite?.duel.id, 'duel', 'duel store: входящий вызов положен цели');
    assert.equal(store.getState().duelInvite?.skewMs, 3_000, 'duel store: событие имеет свои часы');
    store.getState().applyDuelEvent(event(duel({ state })));
    assert.equal(store.getState().duelInvite, null, 'duel store: завершившийся вызов не висит поверх сцены');
  }
  store.getState().applyDuelEvent(event(duel({ targetId: 'peer' })));
  assert.equal(store.getState().duelInvite, null, 'duel store: чужой вызов не становится моим');
});
paired('R334 опоздавший чужой итог не затирает живую партию, собственный итог закрывает её', m => {
  const store = m.useStore;
  for (const state of ['invited', 'playing'] as const) for (const ended of ['settled', 'cancelled'] as const) {
    store.getState().setDuelSnapshot('s', 'c', snap(duel({ id: 'new', state })));
    const current = store.getState().duels.c;
    store.getState().applyDuelEvent(event(duel({ id: 'old', state: ended })));
    assert.equal(store.getState().duels.c, current, 'duel store: старый чужой итог не убивает новую игру');
    store.getState().applyDuelEvent(event(duel({ id: 'new', state: ended })));
    assert.equal(store.getState().duels.c?.duel.state, ended, 'duel store: свой итог применяется');
  }
  store.getState().setDuelSnapshot('s', 'c', snap(null));
  store.getState().applyDuelEvent(event(duel({ state: 'settled' })));
  assert.equal(store.getState().duels.c?.duel.state, 'settled', 'duel store: итог без живой партии не теряется');
});
paired('R334 null очищает канал и его вызов, но не чужой вызов', m => {
  const store = m.useStore;
  store.getState().applyDuelEvent(event(duel()));
  store.getState().applyDuelEvent(event(null));
  assert.equal(store.getState().duels.c, null, 'duel store: канал явно очищен');
  assert.equal(store.getState().duelInvite, null, 'duel store: вызов очищенного канала снят');
  store.getState().applyDuelEvent({ ...event(duel({ channelId: 'neighbor' })), channelId: 'neighbor' });
  const invite = store.getState().duelInvite;
  store.getState().applyDuelEvent(event(null));
  assert.equal(store.getState().duelInvite, invite, 'duel store: вызов другого канала остаётся');
});

const rps = (seq = 1): NonNullable<DuelDto['rps']> => ({ seq, wins: { challenger: 0, target: 0 }, rounds: [], ready: { challenger: false, target: true } });
paired('R337 своя рука переживает общий push только той же партии и того же раунда', m => {
  const d = duel({ game: 'rps', state: 'playing', rps: rps() });
  const view = { duel: d, skewMs: 0, myHand: 'rock' as const };
  assert.equal(m.carryMyHand(view, { ...d }), 'rock', 'duel store: свой ход не исчезает от общего push');
  for (const next of [null, { ...d, id: 'other' }, { ...d, rps: rps(2) }, { ...d, rps: undefined },
    { ...d, state: 'settled' as const }, { ...d, state: 'cancelled' as const }])
    assert.equal(m.carryMyHand(view, next), null, 'duel store: рука не переносится за границу партии или раунда');
  m.useStore.getState().setDuelSnapshot('s', 'c', snap(d, { myHand: 'rock' }));
  m.useStore.getState().applyDuelEvent(event({ ...d }));
  assert.equal(m.useStore.getState().duels.c?.myHand, 'rock', 'duel store: action использует перенос руки');
});
paired('R337 личный ответ главнее сохранённой руки, null и итог снимают её', m => {
  const store = m.useStore, d = duel({ game: 'rps', state: 'playing', rps: rps() });
  store.getState().setDuelSnapshot('s', 'c', snap(d, { myHand: 'rock' }));
  store.getState().applyDuelEvent(event(d), 'paper');
  assert.equal(store.getState().duels.c?.myHand, 'paper', 'duel store: личный ответ главнее прошлого значения');
  store.getState().applyDuelEvent(event(d), null);
  assert.equal(Object.hasOwn(store.getState().duels.c!, 'myHand'), false, 'duel store: явный null не воскрешает старую руку');
  store.getState().applyDuelEvent(event({ ...d, state: 'settled' }), 'rock');
  assert.equal(Object.hasOwn(store.getState().duels.c!, 'myHand'), false, 'duel store: итог не содержит скрытого хода');
});
paired('R337 снимок не добавляет пустой myHand, но принимает сделанный тайный ход', m => {
  const d = duel({ game: 'rps', state: 'playing', rps: rps() });
  for (const myHand of [undefined, null, 'scissors'] as const) {
    m.useStore.getState().setDuelSnapshot('s', 'c', snap(d, { myHand }));
    const view = m.useStore.getState().duels.c!;
    assert.equal(Object.hasOwn(view, 'myHand'), myHand === 'scissors', 'duel store: optional поле появляется только при руке');
    if (myHand) assert.equal(view.myHand, myHand, 'duel store: snapshot переносит личный ход');
  }
});

it('старые партии серии не заменяют текущую, следующая партия и новая серия принимаются', () => {
  const m = fixture();
  const series: NonNullable<DuelDto['series']> = {
    id: 'session', round: 3, status: 'active', nextAt: null, score: { challenger: 1, target: 1, draws: 0 },
  };
  const d = duel({ id: 'third', state: 'playing', series });
  const prev: DuelSlice = { duels: { c: { duel: d, skewMs: 0 } }, duelInvite: null };
  for (const state of ['invited', 'playing', 'settled', 'cancelled'] as const) {
    const old = duel({ id: 'second', state, series: { ...series, round: 2 } });
    assert.equal(m.applyDuelState(prev, event(old), 'me', NOW), prev);
  }
  const fourth = duel({ id: 'fourth', state: 'playing', series: { ...series, round: 4 } });
  assert.equal(m.applyDuelState(prev, event(fourth), 'me', NOW).duels.c?.duel.id, 'fourth');
  const finished: DuelSlice = { ...prev, duels: { c: { duel: { ...d, state: 'settled' }, skewMs: 0 } } };
  const fresh = duel({ id: 'fresh', series: { ...series, id: 'new-session', round: 1, status: 'offered' } });
  assert.equal(m.applyDuelState(finished, event(fresh), 'me', NOW).duels.c?.duel.id, 'fresh');
});

it('принятые ходы КНБ, гуся, 21 и перебросы кубиков не откатываются старым heartbeat', () => {
  const m = fixture();
  const cases = [
    duel({ game: 'rps', state: 'playing', rps: rps(3) }),
    duel({ game: 'greedy', state: 'playing', greedy: {
      seq: 3, scores: { challenger: 3, target: 2 }, turn: 'target', turnPoints: 1,
      lastRoll: { by: 'challenger', die: 1 }, burned: 2, timeouts: { challenger: 0, target: 0 }, first: 'challenger', rolls: [2, 1],
    } }),
    duel({ game: 'twentyone', state: 'playing', twentyOne: {
      seq: 3, totals: { challenger: 12, target: 10 }, standing: { challenger: true, target: false },
      turn: 'target', first: 'challenger', finished: false, winner: null, timeouts: { challenger: 0, target: 0 },
      rolls: [{ by: 'challenger', die: 6 }, { by: 'challenger', die: 6 }, { by: 'target', die: 4 }, { by: 'target', die: 6 }],
    } }),
    duel({ game: 'dice', state: 'playing', rollNo: 3, rolls: [{ challenger: [3, 4], target: null }] }),
  ];
  for (const d of cases) {
    const prev: DuelSlice = { duels: { c: { duel: d, skewMs: 0 } }, duelInvite: null };
    const field = d.game === 'rps' ? 'rps' : d.game === 'greedy' ? 'greedy' : 'twentyOne';
    const older = d.game === 'dice' ? { ...d, rollNo: 2 } : { ...d, [field]: { ...d[field], seq: 2 } };
    assert.equal(m.applyDuelState(prev, event(older), 'me', NOW), prev, d.game);
    const newer = d.game === 'dice' ? { ...d, rollNo: 4 } : { ...d, [field]: { ...d[field], seq: 4 } };
    const applied = m.applyDuelState(prev, event(newer), 'me', NOW).duels.c!.duel;
    assert.equal(applied.game === 'dice' ? applied.rollNo : applied[field]?.seq, 4, d.game);
  }
  const d = cases[3];
  const prev: DuelSlice = { duels: { c: { duel: d, skewMs: 0 } }, duelInvite: null };
  const incoming = { ...d, rolls: [{ challenger: null, target: [5, 6] as [number, number] }] };
  const before = normal(prev), wire = normal(incoming);
  assert.deepEqual(normal(m.applyDuelState(prev, event(incoming), 'me', NOW).duels.c!.duel.rolls), [{ challenger: [3, 4], target: [5, 6] }]);
  assert.deepEqual(normal(prev), before); assert.deepEqual(normal(incoming), wire);
});

it('итог и отмена не возвращаются в игру, но принимают обновлённую остановку серии', () => {
  const m = fixture();
  for (const state of ['settled', 'cancelled'] as const) {
    const d = duel({ state, series: { id: 'session', round: 1, status: 'waiting', nextAt: iso(10_000), score: { challenger: 1, target: 0, draws: 0 } } });
    const prev: DuelSlice = { duels: { c: { duel: d, skewMs: 0 } }, duelInvite: null };
    for (const stale of ['invited', 'playing'] as const) assert.equal(m.applyDuelState(prev, event({ ...d, state: stale }), 'me', NOW), prev);
    const stopped = { ...d, series: { ...d.series!, status: 'stopped' as const, nextAt: null, stopReason: 'user_stop' as const } };
    assert.equal(m.applyDuelState(prev, event(stopped), 'me', NOW).duels.c?.duel.series?.status, 'stopped');
  }
});

it('готовность КНБ объединяется в том же раунде, новый раунд сбрасывает её и скрытую руку', () => {
  const m = fixture();
  const d = duel({ game: 'rps', state: 'playing', rps: { ...rps(1), ready: { challenger: true, target: false } } });
  const prev: DuelSlice = { duels: { c: { duel: d, skewMs: 0, myHand: 'rock' } }, duelInvite: null };
  const incoming = { ...d, rps: { ...rps(1), ready: { challenger: false, target: true } } };
  const before = normal(prev), wire = normal(incoming);
  const next = m.applyDuelState(prev, event(incoming), 'me', NOW);
  assert.deepEqual(normal(next.duels.c?.duel.rps?.ready), { challenger: true, target: true });
  assert.equal(next.duels.c?.myHand, 'rock');
  assert.deepEqual(normal(prev), before); assert.deepEqual(normal(incoming), wire);
  const advanced = m.applyDuelState(next, event({ ...d, rps: { ...rps(2), ready: { challenger: false, target: false } } }), 'me', NOW);
  assert.deepEqual(normal(advanced.duels.c?.duel.rps?.ready), { challenger: false, target: false });
  assert.equal(advanced.duels.c?.myHand, undefined);
});

it('поздний снимок до свежего push не очищает серию и вызов, новый пустой снимок очищает', () => {
  const m = fixture();
  const d = duel({ id: 'second', state: 'playing', series: {
    id: 'session', round: 2, status: 'active', nextAt: null, score: { challenger: 1, target: 0, draws: 0 },
  } });
  const initial: DuelSlice = { duels: {}, duelInvite: { duel: duel({ id: 'pending', channelId: 'other' }), skewMs: 0 } };
  const current = m.applyDuelState(initial, { ...event(d), serverNow: iso(5_000) }, 'me', NOW);
  assert.equal(current.duels.c?.serverNowMs, NOW + 5_000);
  const before = normal(current);
  for (const old of [null, { ...d, id: 'first', series: { ...d.series!, round: 1 } }]) {
    const late = snap(old, { serverNow: iso(4_000), betMax: 1, myInvite: null });
    assert.equal(m.applyDuelSnapshot(current, 's', 'c', late, NOW), current);
    assert.equal(current.duelInvite, initial.duelInvite);
  }
  assert.deepEqual(normal(current), before);
  const empty = m.applyDuelSnapshot(current, 's', 'c', snap(null, { serverNow: iso(6_000) }), NOW);
  assert.equal(empty.duels.c, null); assert.equal(empty.duelInvite, null);
  const legacy = m.applyDuelState({ duels: {}, duelInvite: null }, event(duel()), 'me', NOW);
  assert.equal(Object.hasOwn(legacy.duels.c!, 'serverNowMs'), false);
});

it('снимок серии не откатывает seq или принятую руку, свежий следующий раунд принимается', () => {
  const m = fixture();
  const d = duel({ game: 'rps', state: 'playing', rps: rps(2), series: {
    id: 'session', round: 1, status: 'active', nextAt: null, score: { challenger: 0, target: 0, draws: 0 },
  } });
  const current = m.applyDuelState({ duels: {}, duelInvite: null }, { ...event(d), serverNow: iso(5_000) }, 'me', NOW, 'rock');
  const older = snap({ ...d, rps: rps(1) }, { serverNow: iso(6_000), betMax: 300, feePercent: 0, myHand: null });
  const ignored = m.applyDuelSnapshot(current, 's', 'c', older, NOW);
  assert.equal(ignored.duels.c, current.duels.c);
  assert.deepEqual(normal(ignored.duelLimits?.s), { betMax: 300, feePercent: 0 });
  const same = snap({ ...d, rps: { ...rps(2), ready: { challenger: false, target: false } } }, { serverNow: iso(7_000), myHand: null });
  const wire = normal(same);
  const merged = m.applyDuelSnapshot(ignored, 's', 'c', same, NOW);
  assert.equal(merged.duels.c?.myHand, 'rock'); assert.equal(merged.duels.c?.duel.rps?.ready.target, true);
  assert.deepEqual(normal(same), wire);
  const newer = snap({ ...d, rps: { ...rps(3), ready: { challenger: false, target: false } } }, { serverNow: iso(8_000), myHand: null });
  const advanced = m.applyDuelSnapshot(merged, 's', 'c', newer, NOW);
  assert.equal(advanced.duels.c?.duel.rps?.seq, 3); assert.equal(advanced.duels.c?.duel.rps?.ready.target, false);
  assert.equal(advanced.duels.c?.myHand, undefined); assert.equal(advanced.duels.c?.serverNowMs, NOW + 8_000);
  const picked = m.applyDuelSnapshot(advanced, 's', 'c', snap({ ...d, rps: rps(3) }, { serverNow: iso(9_000), myHand: 'paper' }), NOW);
  assert.equal(picked.duels.c?.myHand, 'paper');
});
