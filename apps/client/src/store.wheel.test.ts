import assert from 'node:assert/strict';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { create } from 'zustand';
import type { WheelRoundDto, WheelSnapshotDto } from '@gusvoice/shared';
import * as channel from './channelRules';
import * as conv from './convSyncRules';
import * as stream from './streamAudioRules';
import * as history from './historyPage';
import type { WheelResultMsg, WheelStateMsg } from './store';

const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const NOW = Date.parse('2026-10-28T12:00:00Z');
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
type Module = Pick<typeof import('./store'), 'useStore' | 'wheelViewOf' | 'applyWheelState' | 'applyWheelResult'>;
type Edit = readonly [from: string, to: string];
type LazyEdit = Edit | (() => Edit);
const round = (id = 'live'): WheelRoundDto => ({
  id, state: 'open', lockAt: iso(30_000), settleAt: null, commit: 'a'.repeat(64), sector: null,
  bets: [{ userId: 'me', pick: 1, amount: 10 }],
});
const snapshot = (): WheelSnapshotDto => ({
  serverId: 'server', serverNow: iso(5_000), enabled: true, betMax: 137, jackpot: 15,
  round: round(), last: null, cooldownUntil: null,
});
const stateEvent = (value: WheelRoundDto | null = round('next')): WheelStateMsg => ({
  t: 'wheel.state', serverId: 'server', serverNow: iso(8_000), round: value, jackpot: 23,
});
const resultEvent = (id = 'live'): WheelResultMsg => ({
  t: 'wheel.result', serverId: 'server', serverNow: iso(9_000), jackpot: 2, cooldownUntil: iso(19_000),
  last: { id, sector: 1, seed: 'b'.repeat(64), commit: 'a'.repeat(64), jackpotHit: false,
    jackpotPaid: 0, settledAt: iso(9_000), winners: [{ userId: 'me', pick: 1, payout: 19 }] },
});

function fixture(raw = source): Module {
  const noop = () => {};
  const fail = (name: string) => new Proxy({}, { get(_target, key) {
    assert.fail(`R329 setup: постороннее действие ${name}.${String(key)}`);
  } });
  const deps: Record<string, unknown> = {
    zustand: { create }, './api': { api: fail('api') }, './config': { activeInstanceId: () => 'home' },
    './channelRules': channel, './convSyncRules': conv, './streamAudioRules': stream, './historyPage': history,
    './convStore': { createConvActions: () => ({}) }, './instanceScope': { scopedGetItem: () => null },
    './channelPrefs': { markChannelSeen: noop }, './lastPlace': {}, './tabSync': {},
    './hotkeys': { isMobile: () => false }, './sounds': {},
  };
  for (const id of ['./convCacheRules', './dmListRules', './convCache', './nativeUnifiedPush', './tipHints',
    './toastRules', './profilePatch', './voiceCueRules', './voiceSession']) deps[id] = fail(id);
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? NOW : value instanceof Date ? value.getTime() : value); }
    static override now() { return NOW; }
  }
  const module = { exports: {} as Module };
  // Полный store.ts и настоящее create Zustand: действие не копируется и не вырезается из исходника.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    module, exports: module.exports, Date: TestDate,
    localStorage: { getItem: () => null },
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `R329 setup: закрытый импорт ${id}`); return deps[id]; },
  });
  return module.exports;
}

function paired(title: string, check: (module: Module) => void, edits: readonly LazyEdit[]) {
  it(`R329 стор колеса: ${title}`, () => {
    check(fixture());
    for (const edit of edits) {
      counterfact(() => {
        const [from, to] = typeof edit === 'function' ? edit() : edit;
        assert.equal(source.split(from).length, 2, 'R329 setup: уникальный якорь целого store.ts');
        assert.throws(() => check(fixture(source.replace(from, to))), error =>
          error instanceof assert.AssertionError && error.message.startsWith('R329 wheel:'),
        'мутант ломает адресный инвариант, а не загрузку модуля');
      });
      check(fixture());
    }
  });
}

// Этап 5 добавил такой же guard у applyPredictionEvent: мутация обязана попадать именно
// в wheel-action целого модуля, не подменять чужую ленту и не падать на неоднозначном якоре.
const WHEEL_EVENT_GUARD = `  applyWheelEvent: (msg) => {
    const prev = get().wheel[msg.serverId];
    const next = msg.t === 'wheel.state' ? applyWheelState(prev, msg, Date.now()) : applyWheelResult(prev, msg, Date.now());
    if (!next) return false;`;

paired('снимок получает знаковую поправку часов, битая дата не даёт NaN', m => {
  for (const offset of [5_000, -7_000, 0]) {
    const snap = { ...snapshot(), serverNow: iso(offset) };
    const before = normal(snap);
    const view = m.wheelViewOf(snap, NOW);
    assert.equal(view.skewMs, offset, 'R329 wheel: часы сервера минус местные часы');
    assert.deepEqual(normal({ ...view, skewMs: undefined }), before, 'R329 wheel: все поля снимка сохранены');
    assert.deepEqual(snap, before, 'R329 wheel: входной снимок не изменён');
    m.useStore.getState().setWheel('server', snap);
    assert.equal(m.useStore.getState().wheel.server.skewMs, offset, 'R329 wheel: setWheel использует местные часы');
  }
  assert.equal(m.wheelViewOf({ ...snapshot(), serverNow: 'broken' }, NOW).skewMs, 0, 'R329 wheel: битая дата даёт нулевую поправку');
}, [
  ['return Number.isFinite(t) ? t - nowMs : 0;', 'return Number.isFinite(t) ? nowMs - t : 0;'],
  ['wheelViewOf(snap, Date.now())', 'wheelViewOf(snap, Date.now() + 1)'],
]);

paired('событие без снимка не создаёт настройки и не будит подписчиков', m => {
  const store = m.useStore;
  const before = store.getState();
  let updates = 0;
  const off = store.subscribe(() => updates++);
  for (const msg of [stateEvent(), resultEvent()]) {
    const pure = msg.t === 'wheel.state' ? m.applyWheelState(undefined, msg, NOW) : m.applyWheelResult(undefined, msg, NOW);
    assert.equal(pure, undefined, 'R329 wheel: событие не придумывает отсутствующий снимок');
    assert.equal(store.getState().applyWheelEvent(msg), false, 'R329 wheel: вызывающий получает сигнал загрузить снимок');
    assert.equal(store.getState(), before, 'R329 wheel: неизвестный сервер не меняет даже корень стора');
    assert.equal(updates, 0, 'R329 wheel: отсутствующий снимок не уведомляет подписчиков');
    assert.equal(Object.hasOwn(store.getState().wheel, 'server'), false, 'R329 wheel: ключ сервера не появился');
  }
  off();
}, [
  () => [WHEEL_EVENT_GUARD, WHEEL_EVENT_GUARD.replace('if (!next) return false;', 'if (!next) return true;')],
  () => [WHEEL_EVENT_GUARD, WHEEL_EVENT_GUARD.replace('if (!next) return false;', 'if (!next) { set((s) => ({ wheel: { ...s.wheel, [msg.serverId]: next } })); return false; }')],
]);

paired('state заменяет раунд, отмена очищает его, настройки и соседний сервер остаются', m => {
  const store = m.useStore;
  for (const enabled of [true, false]) {
    store.getState().setWheel('server', { ...snapshot(), enabled });
    store.getState().setWheel('other', { ...snapshot(), serverId: 'other' });
    const other = store.getState().wheel.other;
    for (const msg of [stateEvent(), stateEvent(null)]) {
      const previous = store.getState().wheel.server;
      const before = normal(previous);
      assert.equal(store.getState().applyWheelEvent(msg), true, 'R329 wheel: существующий снимок принимает state');
      const view = store.getState().wheel.server;
      assert.deepEqual(normal(view.round), msg.round, 'R329 wheel: новый раунд и явная отмена применены');
      assert.equal(view.enabled, enabled, 'R329 wheel: событие не меняет локально известный enabled');
      assert.equal(view.betMax, 137, 'R329 wheel: событие не теряет потолок ставки');
      assert.equal(view.jackpot, 23, 'R329 wheel: сундук обновлён событием');
      assert.equal(view.serverNow, msg.serverNow, 'R329 wheel: время сервера обновлено');
      assert.equal(view.skewMs, 8_000, 'R329 wheel: часы пересчитаны при событии');
      assert.equal(store.getState().wheel.other, other, 'R329 wheel: соседний сервер не затронут');
      assert.deepEqual(normal(previous), before, 'R329 wheel: прежний снимок не мутирован');
    }
  }
}, [
  ['round: msg.round, jackpot: msg.jackpot, serverNow: msg.serverNow', 'round: prev.round, jackpot: msg.jackpot, serverNow: msg.serverNow'],
  ['return { ...prev, round: msg.round,', 'return { ...prev, enabled: true, betMax: 0, round: msg.round,'],
  ['return { ...prev, round: msg.round, jackpot: msg.jackpot, serverNow: msg.serverNow, skewMs: clockSkew(msg.serverNow, nowMs) };',
    'return { ...prev, round: msg.round, jackpot: msg.jackpot, serverNow: msg.serverNow, skewMs: prev.skewMs };'],
]);

paired('итог текущего раунда закрывает его, сохраняет результат и паузу', m => {
  const store = m.useStore;
  store.getState().setWheel('server', snapshot());
  const previous = store.getState().wheel.server;
  const before = normal(previous);
  const msg = resultEvent();
  assert.equal(store.getState().applyWheelEvent(msg), true, 'R329 wheel: существующий снимок принимает result');
  const view = store.getState().wheel.server;
  assert.equal(view.round, null, 'R329 wheel: завершённый текущий раунд закрыт');
  assert.deepEqual(normal(view.last), msg.last, 'R329 wheel: раскрытый итог сохранён целиком');
  assert.equal(view.cooldownUntil, msg.cooldownUntil, 'R329 wheel: сохранена серверная пауза');
  assert.equal(view.jackpot, 2, 'R329 wheel: итог обновляет сундук');
  assert.equal(view.serverNow, msg.serverNow, 'R329 wheel: итог обновляет часы сервера');
  assert.equal(view.skewMs, 9_000, 'R329 wheel: итог обновляет поправку часов');
  assert.equal(view.enabled, true, 'R329 wheel: итог сохраняет enabled');
  assert.equal(view.betMax, 137, 'R329 wheel: итог сохраняет потолок');
  assert.deepEqual(normal(previous), before, 'R329 wheel: прошлый снимок результата не мутирован');
}, [
  ['round: prev.round && prev.round.id !== msg.last.id ? prev.round : null,', 'round: prev.round,'],
  ['last: msg.last,', 'last: prev.last,'],
  ['cooldownUntil: msg.cooldownUntil,', 'cooldownUntil: prev.cooldownUntil,'],
]);

paired('опоздавший чужой итог не стирает живой раунд и не создаёт раунд из пустоты', m => {
  const store = m.useStore;
  for (const current of [round('newer'), null]) {
    store.getState().setWheel('server', { ...snapshot(), enabled: false, round: current });
    const previousRound = store.getState().wheel.server.round;
    const msg = resultEvent('older');
    store.getState().applyWheelEvent(msg);
    const view = store.getState().wheel.server;
    assert.equal(view.round, previousRound, 'R329 wheel: чужой итог сохраняет более новый раунд или отсутствие раунда');
    assert.deepEqual(normal(view.last), msg.last, 'R329 wheel: чужой итог всё же доступен как последний');
    assert.equal(view.enabled, false, 'R329 wheel: результат не включает выключенную игру');
    assert.equal(view.betMax, 137, 'R329 wheel: результат не сбрасывает настройки');
  }
}, [
  ['round: prev.round && prev.round.id !== msg.last.id ? prev.round : null,', 'round: null,'],
]);
