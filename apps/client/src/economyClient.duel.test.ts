import assert from 'node:assert/strict';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as visibility from './economyVisible';
import type { DuelSnapshotDto } from '@gusvoice/shared';

const source = readFileSync(new URL('./economyClient.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Edit = readonly [string, string];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const snapshot = (): DuelSnapshotDto => ({ duel: null, myInvite: null, serverNow: '2026-10-28T12:00:00Z' });
function fixture(raw = source) {
  const requests: Array<{ server: string; channel: string; resolve(s: DuelSnapshotDto): void; reject(e: Error): void }> = [];
  const writes: Array<[string, string, DuelSnapshotDto]> = [];
  const state = { duels: {} as Record<string, unknown>, setDuelSnapshot(server: string, channel: string, snap: DuelSnapshotDto) {
    writes.push([server, channel, snap]); state.duels[channel] = snap.duel;
  } };
  const deps: Record<string, unknown> = { './api': { api: { getDuel: (server: string, channel: string) =>
    new Promise<DuelSnapshotDto>((resolve, reject) => requests.push({ server, channel, resolve, reject })) } },
  './store': { useStore: { getState: () => state } }, './config': { config: { economyEnabled: false } }, './economyVisible': visibility };
  const module = { exports: {} as typeof import('./economyClient') };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require(id: string) { assert.ok(Object.hasOwn(deps, id), `R334 setup: закрытый импорт ${id}`); return deps[id]; } });
  return { client: module.exports, state, requests, writes };
}
type Fixture = ReturnType<typeof fixture>;
function paired(title: string, check: (f: Fixture) => Promise<void>, ...edits: Edit[]) {
  it(`R334 ensureDuel: ${title}`, async () => {
    await check(fixture());
    for (const [from, to] of edits) {
      await counterfact(async () => {
      assert.equal(source.split(from).length, 2, 'R334 setup: уникальный якорь целого economyClient');
      await assert.rejects(async () => check(fixture(source.replace(from, to))), e =>
        e instanceof assert.AssertionError && e.message.startsWith('duel fetch:'), 'контрфакт ломает запрос/запись, не импорт');
      });
      await check(fixture());
    }
  });
}
paired('без любого id молчит, пара сервер+канал загружается без второго флага экономики', async f => {
  for (const absent of [null, undefined, '']) { f.client.ensureDuel(absent, 'c'); f.client.ensureDuel('s', absent); }
  assert.equal(f.requests.length, 0, 'duel fetch: без адреса запросов нет');
  f.client.ensureDuel('s', 'c');
  assert.deepEqual(f.requests.map(r => [r.server, r.channel]), [['s', 'c']], 'duel fetch: корректный адрес не требует экономики повторно');
  f.requests[0].resolve(snapshot()); await flush();
}, ['if (!serverId || !channelId) return;', 'if (!serverId) return;'],
  ['if (!serverId || !channelId) return;', 'if (!serverId || !channelId || !config.economyEnabled) return;']);
paired('null тоже готовый кеш, force перечитывает и найденную, и отсутствующую партию', async f => {
  for (const value of [null, { duel: { id: 'cached' } }]) {
    f.state.duels.c = value;
    const before = f.requests.length;
    f.client.ensureDuel('s', 'c');
    assert.equal(f.requests.length, before, 'duel fetch: отсутствие партии уже известно из снимка');
    f.client.ensureDuel('s', 'c', true);
    assert.equal(f.requests.length, before + 1, 'duel fetch: force обходит готовый кеш');
    f.requests.at(-1)!.resolve(snapshot()); await flush();
  }
}, ['if (!force && useStore.getState().duels?.[channelId] !== undefined) return;', 'if (!force && useStore.getState().duels?.[channelId]) return;'],
  ['if (!force && useStore.getState().duels?.[channelId] !== undefined) return;', 'if (useStore.getState().duels?.[channelId] !== undefined) return;']);
paired('один канал объединяет обычные и force запросы в полёте', async f => {
  f.client.ensureDuel('s', 'c'); f.client.ensureDuel('s', 'c', true); f.client.ensureDuel('s', 'c');
  assert.equal(f.requests.length, 1, 'duel fetch: один HTTP на канал в полёте');
  f.requests[0].resolve(snapshot()); await flush();
  assert.equal(f.writes.length, 1, 'duel fetch: снимок записывается один раз');
}, ['if (duelInFlight.has(channelId)) return;', '']);
paired('разные каналы независимы, обратный порядок ответов сохраняет полный адрес', async f => {
  f.client.ensureDuel('a', 'c1'); f.client.ensureDuel('b', 'c2');
  assert.deepEqual(f.requests.map(r => [r.server, r.channel]), [['a', 'c1'], ['b', 'c2']], 'duel fetch: каждый канал имеет свой запрос');
  f.requests[1].resolve(snapshot()); await flush(); f.requests[0].resolve(snapshot()); await flush();
  assert.deepEqual(f.writes.map(w => w.slice(0, 2)), [['b', 'c2'], ['a', 'c1']], 'duel fetch: ответ не перепутал сервер и канал');
}, ['setDuelSnapshot(serverId, channelId, snap)', "setDuelSnapshot(serverId, 'wrong', snap)"]);
paired('отказ транспорта ничего не пишет и освобождает повтор', async f => {
  f.client.ensureDuel('s', 'c'); f.requests[0].reject(new Error('synthetic offline')); await flush();
  assert.equal(f.writes.length, 0, 'duel fetch: ошибка не притворяется пустым снимком');
  f.client.ensureDuel('s', 'c');
  assert.equal(f.requests.length, 2, 'duel fetch: после ошибки канал снова доступен для загрузки');
  f.requests[1].resolve(snapshot()); await flush();
  assert.equal(f.writes.length, 1, 'duel fetch: повтор применён');
}, ['.finally(() => duelInFlight.delete(channelId));', '.finally(() => {});']);
paired('успех освобождает следующий force и смена инстанса сбрасывает lock', async f => {
  f.client.ensureDuel('s', 'c'); f.requests[0].resolve(snapshot()); await flush();
  f.client.ensureDuel('s', 'c', true);
  assert.equal(f.requests.length, 2, 'duel fetch: следующий force после ответа снова делает запрос');
  f.client.clearEconomyInFlight(); f.client.ensureDuel('s', 'c', true);
  assert.equal(f.requests.length, 3, 'duel fetch: смена инстанса не наследует чужой lock');
  f.requests.slice(1).forEach(r => r.resolve(snapshot())); await flush();
}, ['  duelInFlight.clear();', '']);
