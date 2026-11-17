import assert from 'node:assert/strict';
import { it } from 'node:test';
import { create } from 'zustand';
import * as channel from './channelRules';
import * as conv from './convSyncRules';
import * as stream from './streamAudioRules';
import * as history from './historyPage';
import { sourceOf, load, edited, event, snapshot, question, normal, iso, NOW, FixedDate, noop, type Edit } from './predictions.harness';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import type { PredictionStateMsg } from './store';

const source = sourceOf('./store.ts');
type Module = Pick<typeof import('./store'), 'useStore' | 'predictionsViewOf' | 'applyPredictionState' | 'applyDuelState'>;
const P = 'R338 store: ';
const stateEvent = (ev: ReturnType<typeof event> | null = event('next'), eventId = ev?.id ?? 'event'): PredictionStateMsg => ({
  t: 'prediction.state', serverId: 's', serverNow: iso(8_000), eventId, event: ev,
});
function fixture(raw: string): Module {
  const fail = (name: string) => new Proxy({}, { get(_target, key) { assert.fail(`R338 setup: постороннее IO ${name}.${String(key)}`); } });
  const deps: Record<string, unknown> = {
    zustand: { create }, './api': { api: fail('api') }, './config': { activeInstanceId: () => 'home' },
    './channelRules': channel, './convSyncRules': conv, './streamAudioRules': stream, './historyPage': history,
    './convStore': { createConvActions: () => ({}) }, './instanceScope': { scopedGetItem: () => null },
    './channelPrefs': { markChannelSeen: noop }, './lastPlace': {}, './tabSync': {}, './hotkeys': { isMobile: () => false }, './sounds': {},
  };
  for (const id of ['./convCacheRules', './dmListRules', './convCache', './nativeUnifiedPush', './tipHints', './toastRules',
    './profilePatch', './voiceCueRules', './voiceSession']) deps[id] = fail(id);
  return load(raw, deps, { Date: FixedDate, localStorage: { getItem: () => null } });
}
type LazyEdit = Edit | (() => Edit);
function paired(raw: string, check: (raw: string) => void, edits: readonly LazyEdit[], prefix: string) {
  check(raw);
  for (const edit of edits) {
    counterfact(() => {
      const mutant = edited(raw, typeof edit === 'function' ? edit() : edit);
      assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.startsWith(prefix),
        'контрфакт убит адресным host AssertionError, не setup/import/исключением');
    });
    check(raw);
  }
}
function test(title: string, check: (m: Module) => void, edits: readonly LazyEdit[]) {
  it(`R338 лента в сторе: ${title}`, () => paired(source, raw => check(fixture(raw)), edits, P));
}

test('снимок сортирует копию массива и сохраняет настройки; skew знаковый и безопасен для битой даты', m => {
  const events = [event('old', { createdAt: iso(-10_000) }), event('new', { createdAt: iso(1_000) }), event('broken', { createdAt: 'bad' })];
  const snap = snapshot(events); const before = normal(snap);
  for (const offset of [-5_000, 5_000]) {
    const v = m.predictionsViewOf({ ...snap, serverNow: iso(offset) }, NOW);
    assert.deepEqual(normal(v.events.map(e => e.id)), ['new', 'old', 'broken'], P + 'новые сверху');
    assert.equal(v.skewMs, offset, P + 'skew сервер минус клиент');
    assert.deepEqual([v.enabled, v.canManage, v.betMax], [true, true, 321], P + 'настройки снимка');
  }
  assert.deepEqual(snap, before, P + 'снимок не сортируется на месте');
  assert.equal(m.predictionsViewOf({ ...snap, serverNow: 'bad' }, NOW).skewMs, 0, P + 'битая дата безопасна');
  m.useStore.getState().setPredictions('s', snap);
  assert.equal(m.useStore.getState().predictions.s.skewMs, 5_000, P + 'action пользуется настоящими местными часами');
}, [['(Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)', '(Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0)'],
  ['return [...events].sort(', 'return events.sort('], ['predictionsViewOf(snap, Date.now())', 'predictionsViewOf(snap, Date.now() + 1)']]);

const GUARD = 'const next = applyPredictionState(get().predictions[msg.serverId], msg, Date.now());\n    if (!next) return false;';
test('без снимка undefined и false, без записи и без уведомления подписчиков', m => {
  assert.equal(m.applyPredictionState(undefined, stateEvent(), NOW), undefined, P + 'событие не придумывает настройки');
  const store = m.useStore; const before = store.getState(); let updates = 0;
  const off = store.subscribe(() => updates++);
  assert.equal(store.getState().applyPredictionEvent(stateEvent()), false, P + 'нужен снимок');
  assert.equal(store.getState(), before, P + 'нет записи даже корня');
  assert.equal(updates, 0, P + 'нет уведомления'); off();
}, [() => [GUARD, GUARD.replace('if (!next) return false;', 'if (!next) return true;')],
  () => [GUARD, GUARD.replace('if (!next) return false;', 'if (!next) { set({ predictions: {} }); return false; }')]]);

test('null удаляет только нужное событие, настройки и соседний сервер не затронуты', m => {
  const store = m.useStore;
  store.getState().setPredictions('s', snapshot([event(), event('keep')]));
  store.getState().setPredictions('other', snapshot());
  const previous = store.getState().predictions.s, before = normal(previous), other = store.getState().predictions.other;
  assert.equal(store.getState().applyPredictionEvent(stateEvent(null)), true, P + 'null применён');
  const view = store.getState().predictions.s;
  assert.deepEqual(normal(view.events.map(e => e.id)), ['keep'], P + 'удалён адресный id');
  assert.deepEqual([view.enabled, view.canManage, view.betMax, view.skewMs], [true, true, 321, 8_000], P + 'сохранены настройки и новые часы');
  assert.equal(store.getState().predictions.other, other, P + 'соседний сервер тот же');
  assert.deepEqual(normal(previous), before, P + 'прошлое не мутировано');
}, [['events: prev.events.filter((e) => e.id !== msg.eventId)', 'events: prev.events.filter((e) => e.id === msg.eventId)'],
  ['[msg.serverId]: next } }));\n    return true;\n  },\n  setPredictionToast:', "['wrong']: next } }));\n    return true;\n  },\n  setPredictionToast:"]]);

const MINE = 'mine: q.mine ?? old.questions.find((o) => o.id === q.id)?.mine ?? null';
test('рассылка mine:null сохраняет мою ставку по id вопроса, явная новая mine важнее; новые вопросы пустые', m => {
  const first = question('first'), second = question('second');
  first.mine = { optionId: 'a', amount: 10, payout: null, refunded: false };
  second.mine = { optionId: 'b', amount: 30, payout: null, refunded: false };
  const previous = m.predictionsViewOf(snapshot([event('event', { questions: [first, second] })]), NOW);
  const before = normal(previous);
  const explicit = { optionId: 'a', amount: 99, payout: null, refunded: false };
  const changed = event('event', { title: 'Новый заголовок', questions: [question('second'), { ...question('first'), mine: explicit }, question('new')] });
  const next = m.applyPredictionState(previous, stateEvent(changed), NOW)!;
  assert.deepEqual(normal(next.events[0].questions.map(q => q.mine)), [second.mine, explicit, null], P + 'mine по id и приоритет явного ответа');
  assert.equal(next.events[0].title, 'Новый заголовок', P + 'остальные поля обновлены');
  assert.deepEqual(normal(previous), before, P + 'прошлый снимок не изменён');
}, [[MINE, 'mine: q.mine'], [MINE, 'mine: old.questions[0]?.mine ?? q.mine ?? null']]);

test('новое событие добавляется сверху, обновление заменяет без дублей, повтор не множит ленту', m => {
  let previous = m.predictionsViewOf(snapshot([event('old', { createdAt: iso(-10_000) })]), NOW);
  const newest = event('new', { createdAt: iso(10_000) });
  previous = m.applyPredictionState(previous, stateEvent(newest), NOW)!;
  assert.deepEqual(normal(previous.events.map(e => e.id)), ['new', 'old'], P + 'новое сверху');
  const changed = { ...newest, state: 'locked' as const };
  previous = m.applyPredictionState(previous, stateEvent(changed), NOW)!;
  previous = m.applyPredictionState(previous, stateEvent(changed), NOW)!;
  assert.deepEqual(normal(previous.events.map(e => [e.id, e.state])), [['new', 'locked'], ['old', 'open']], P + 'замена без дублей');
}, [['[merged, ...prev.events.filter((e) => e.id !== ev.id)]', '[merged, ...prev.events]'],
  ['const ev = msg.event;', 'const ev = { ...msg.event, createdAt: "1970-01-01T00:00:00Z" };']]);
