import assert from 'node:assert/strict';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as visibility from './economyVisible';
import type { WheelSnapshotDto } from '@gusvoice/shared';

// Весь настоящий economyClient; подменены только транспорт и IO-граница стора.
const source = readFileSync(new URL('./economyClient.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
type Edit = { from: string; to: string };
const snap = (serverId: string): WheelSnapshotDto => ({ serverId, enabled: true, betMax: 300, jackpot: 7,
  serverNow: '2026-10-28T12:00:00.000Z', round: null, last: null, cooldownUntil: null });
function fixture(edit?: Edit) {
  let raw = source;
  if (edit) {
    assert.equal(raw.split(edit.from).length, 2, 'R329 setup: уникальный якорь целого economyClient');
    raw = raw.replace(edit.from, edit.to);
  }
  const requests: Array<{ id: string; resolve(value: WheelSnapshotDto): void; reject(error: Error): void }> = [];
  const writes: Array<{ id: string; value: WheelSnapshotDto }> = [];
  const state = { user: { economyPreview: false }, economy: {}, wheel: {} as Record<string, WheelSnapshotDto>,
    setWheel(id: string, value: WheelSnapshotDto) { writes.push({ id, value: normal(value) }); state.wheel[id] = value; } };
  const deps: Record<string, unknown> = {
    './api': { api: { getWheel: (id: string) => new Promise<WheelSnapshotDto>((resolve, reject) => requests.push({ id, resolve, reject })) } },
    './config': { config: { economyEnabled: false } }, './store': { useStore: { getState: () => state } },
    './economyVisible': visibility,
  };
  const module = { exports: {} as typeof import('./economyClient') };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, { module, exports: module.exports,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `R329 setup: закрытый импорт ${id}`); return deps[id]; },
  });
  return { client: module.exports, requests, writes, state };
}
type Fixture = ReturnType<typeof fixture>;
function paired(title: string, check: (f: Fixture) => Promise<void>, edit: Edit | (() => Edit)) {
  it(`R329 ensureWheel: ${title}`, async () => {
    await check(fixture());
    await counterfact(async () => {
    await assert.rejects(check(fixture(typeof edit === 'function' ? edit() : edit)), e => e instanceof assert.AssertionError && e.message.startsWith('R329 загрузка:'),
      'мутант обязан ломать транспортный инвариант, а не загрузку модуля');
    });
    await check(fixture());
  });
}
const header = 'export function ensureWheel(serverId: string | null | undefined, force = false): void {\n  if (!serverId) return;';

// Отсутствие сервера не должно создавать бессмысленный сетевой запрос.
paired('пустой id молчит, корректный сервер загружается', async f => {
  for (const id of [null, undefined, '']) f.client.ensureWheel(id);
  assert.equal(f.requests.length, 0, 'R329 загрузка: без id запросов нет');
  f.client.ensureWheel('s');
  assert.deepEqual(f.requests.map(r => r.id), ['s'], 'R329 загрузка: корректный id принят');
  f.requests[0].resolve(snap('s')); await flush();
}, () => ({ from: header, to: header.replace('  if (!serverId) return;', '') }));

// Возврат фокуса и ready должны обходить готовый кеш, иначе пропущенный итог остаётся навсегда.
paired('готовый кеш не перечитывается без force, но force обновляет его', async f => {
  f.state.wheel.s = snap('s');
  f.client.ensureWheel('s');
  assert.equal(f.requests.length, 0, 'R329 загрузка: кеш без force не перечитывается');
  f.client.ensureWheel('s', true);
  assert.equal(f.requests.length, 1, 'R329 загрузка: force обходит кеш');
  f.requests[0].resolve({ ...snap('s'), jackpot: 19 }); await flush();
  assert.equal(f.state.wheel.s.jackpot, 19, 'R329 загрузка: свежий снимок применён');
}, { from: 'if (!force && useStore.getState().wheel?.[serverId]) return;', to: 'if (useStore.getState().wheel?.[serverId]) return;' });

// Две кнопки и ready одновременно не должны отправлять три одинаковых запроса.
paired('запрос в полёте склеивает обычные и принудительные вызовы', async f => {
  f.client.ensureWheel('s'); f.client.ensureWheel('s', true); f.client.ensureWheel('s');
  assert.equal(f.requests.length, 1, 'R329 загрузка: один запрос в полёте на сервер');
  f.requests[0].resolve(snap('s')); await flush();
  assert.equal(f.writes.length, 1, 'R329 загрузка: один ответ один раз записан');
}, { from: 'if (wheelInFlight.has(serverId)) return;', to: '' });

// Параллельные ответы разных серверов не должны переписать один и тот же ключ.
paired('разные серверы грузятся независимо и ответы попадают в свой ключ', async f => {
  f.client.ensureWheel('a'); f.client.ensureWheel('b');
  assert.deepEqual(f.requests.map(r => r.id), ['a', 'b'], 'R329 загрузка: независимые запросы двух серверов');
  f.requests[1].resolve(snap('b')); await flush();
  f.requests[0].resolve(snap('a')); await flush();
  assert.deepEqual(f.writes.map(w => [w.id, w.value.serverId]), [['b', 'b'], ['a', 'a']], 'R329 загрузка: каждый ответ применён в свой сервер');
}, { from: 'useStore.getState().setWheel(serverId, snap)', to: "useStore.getState().setWheel('wrong-server', snap)" });

// Обрыв транспорта не должен навечно оставить запись «запрос уже идёт».
paired('ошибка ничего не пишет и освобождает повторную загрузку', async f => {
  f.client.ensureWheel('s');
  f.requests[0].reject(new Error('synthetic offline')); await flush();
  assert.equal(f.writes.length, 0, 'R329 загрузка: ошибка не подменяет снимок');
  f.client.ensureWheel('s');
  assert.equal(f.requests.length, 2, 'R329 загрузка: после ошибки можно повторить запрос');
  f.requests[1].resolve(snap('s')); await flush();
  assert.equal(f.writes.length, 1, 'R329 загрузка: повтор успешно применён');
}, { from: '.finally(() => wheelInFlight.delete(serverId));', to: '.finally(() => {});' });

// Смена инстанса обязана позволять запросить такой же id заново, не наследуя чужой lock.
paired('clearEconomyInFlight очищает в том числе колесо', async f => {
  f.client.ensureWheel('s'); f.client.clearEconomyInFlight(); f.client.ensureWheel('s', true);
  assert.equal(f.requests.length, 2, 'R329 загрузка: смена инстанса сбросила колесо в полёте');
  // Одинаковые синтетические ответы: отдельный протокол отмены старого инстанса здесь не моделируется.
  f.requests.forEach(r => r.resolve(snap('s'))); await flush();
}, { from: '  wheelInFlight.clear();', to: '' });

// Видимость экономики решает вызывающий: дублирующий гейт здесь ломает восстановление уже открытой игры.
paired('вызывающий может загрузить снимок без повторной проверки флага экономики', async f => {
  f.client.ensureWheel('s');
  assert.equal(f.requests.length, 1, 'R329 загрузка: ensureWheel не добавляет второй гейт экономики');
  f.requests[0].resolve(snap('s')); await flush();
}, { from: header, to: `${header}\n  if (!config.economyEnabled) return;` });
