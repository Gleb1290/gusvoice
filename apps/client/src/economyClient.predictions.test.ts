import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as visibility from './economyVisible';
import type { PredictionSnapshotDto } from '@gusvoice/shared';
import { sourceOf, load, pairedAsync, snapshot, flush, type LazyEdit } from './predictions.harness';

const source = sourceOf('./economyClient.ts'), P = 'R338 load: ';
function fixture(raw: string) {
  const requests: Array<{ id: string; resolve(value: PredictionSnapshotDto): void; reject(error: Error): void }> = [];
  const writes: Array<{ id: string; value: PredictionSnapshotDto }> = [];
  const state = { user: { economyPreview: false }, economy: {}, predictions: {} as Record<string, PredictionSnapshotDto>,
    setPredictions(id: string, value: PredictionSnapshotDto) { writes.push({ id, value }); state.predictions[id] = value; } };
  const client = load<typeof import('./economyClient')>(raw, {
    './api': { api: { getPredictions: (id: string) => new Promise<PredictionSnapshotDto>((resolve, reject) => requests.push({ id, resolve, reject })) } },
    './config': { config: { economyEnabled: false } }, './store': { useStore: { getState: () => state } }, './economyVisible': visibility,
  });
  return { client, state, requests, writes };
}
type Fixture = ReturnType<typeof fixture>;
function test(title: string, check: (f: Fixture) => Promise<void>, edits: readonly LazyEdit[]) {
  it(`R338 загрузка событий: ${title}`, () => pairedAsync(source, raw => check(fixture(raw)), edits, P));
}
const HEADER = 'export function ensurePredictions(serverId: string | null | undefined, force = false): void {\n  if (!serverId) return;';
test('пустой id не ходит в сеть, корректный грузится без повторного гейта видимости экономики', async f => {
  for (const id of [null, undefined, '']) f.client.ensurePredictions(id);
  assert.equal(f.requests.length, 0, P + 'пустой id молчит');
  f.client.ensurePredictions('s');
  assert.deepEqual(f.requests.map(r => r.id), ['s'], P + 'решение о видимости у вызывающего');
  f.requests[0].resolve(snapshot()); await flush();
}, [() => [HEADER, HEADER.replace('  if (!serverId) return;', '')], () => [HEADER, `${HEADER}\n  if (!config.economyEnabled) return;`]]);
test('кеш не опрашивается, force перечитывает и записывает ответ', async f => {
  f.state.predictions.s = snapshot(); f.client.ensurePredictions('s');
  assert.equal(f.requests.length, 0, P + 'готовый кеш');
  f.client.ensurePredictions('s', true);
  assert.equal(f.requests.length, 1, P + 'force обходит кеш');
  f.requests[0].resolve({ ...snapshot(), betMax: 777 }); await flush();
  assert.equal(f.state.predictions.s.betMax, 777, P + 'ответ применён');
}, [['if (!force && useStore.getState().predictions?.[serverId]) return;', 'if (useStore.getState().predictions?.[serverId]) return;'],
  ['useStore.getState().setPredictions(serverId, snap)', 'void snap']]);
test('обычный и force склеиваются в полёте, разные серверы независимы', async f => {
  f.client.ensurePredictions('a'); f.client.ensurePredictions('a', true); f.client.ensurePredictions('b');
  assert.deepEqual(f.requests.map(r => r.id), ['a', 'b'], P + 'один запрос на сервер');
  f.requests[1].resolve({ ...snapshot(), serverId: 'b' }); f.requests[0].resolve({ ...snapshot(), serverId: 'a' }); await flush();
  assert.deepEqual(f.writes.map(w => [w.id, w.value.serverId]), [['b', 'b'], ['a', 'a']], P + 'ответы в свои ключи');
}, [['if (predictionsInFlight.has(serverId)) return;', ''],
  ['useStore.getState().setPredictions(serverId, snap)', "useStore.getState().setPredictions('wrong', snap)"]]);
test('ошибка ничего не пишет и позволяет повтор; успешный ответ тоже освобождает lock', async f => {
  f.client.ensurePredictions('s'); f.requests[0].reject(new Error('synthetic offline')); await flush();
  assert.equal(f.writes.length, 0, P + 'ошибка без записи');
  f.client.ensurePredictions('s'); assert.equal(f.requests.length, 2, P + 'повтор после ошибки');
  f.requests[1].resolve(snapshot()); await flush(); f.client.ensurePredictions('s', true);
  assert.equal(f.requests.length, 3, P + 'повтор после успеха');
  f.requests[2].resolve(snapshot()); await flush();
}, [['.finally(() => predictionsInFlight.delete(serverId));', '.finally(() => {});']]);
test('смена инстанса очищает незавершённый lock событий', async f => {
  f.client.ensurePredictions('s'); f.client.clearEconomyInFlight(); f.client.ensurePredictions('s', true);
  assert.equal(f.requests.length, 2, P + 'clear снимает lock');
  f.requests.forEach(r => r.resolve(snapshot())); await flush();
}, [['  predictionsInFlight.clear();', '']]);
