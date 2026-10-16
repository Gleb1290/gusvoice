import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Rules = typeof import('./lastSeenRefresh');
const source = readFileSync(new URL('./lastSeenRefresh.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function fixture(epoch?: number, browser = true, raw = source) {
  let now = 0, visibilityState = 'hidden';
  let state = { lastSeenEpoch: epoch };
  const writes: number[] = [], visible: (() => void)[] = [], connections: ((s: string) => void)[] = [];
  class Clock extends Date { static now() { return now; } }
  const deps: Record<string, unknown> = {
    './connState': { onConnChange: (fn: (s: string) => void) => connections.push(fn) },
    './store': { useStore: { setState: (fn: (s: typeof state) => typeof state) => {
      state = fn(state); writes.push(state.lastSeenEpoch!);
    } } },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date: Clock,
      ...(browser ? { document: { get visibilityState() { return visibilityState; },
        addEventListener: (name: string, fn: () => void) => { assert.equal(name, 'visibilitychange'); visible.push(fn); } } } : {}),
      require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `явный импорт refresh: ${id}`); return deps[id]; } });
  return { api: module.exports as Rules, writes, visible, connections,
    time: (t: number) => { now = t; },
    visibility: (value: string) => { visibilityState = value; for (const fn of visible) fn(); },
    connect: (value: string) => { for (const fn of connections) fn(value); } };
}

// События возврата окна/сети приходят почти вместе: граница ровно 5 с не должна терять нужный перезапрос.
it('R208 перезапрос времени захода разрешён ровно через 5000 мс, до границы нет', () => {
  const { api } = fixture();
  assert.equal(api.REFRESH_MIN_GAP_MS, 5000);
  assert.equal(api.shouldRefreshLastSeen(0, null), true);
  assert.equal(api.shouldRefreshLastSeen(9999, 5000), false);
  assert.equal(api.shouldRefreshLastSeen(10000, 5000), true);
  assert.equal(api.shouldRefreshLastSeen(10001, 5000), true);
  assert.equal(api.shouldRefreshLastSeen(4999, 5000), false);
  assert.equal(api.shouldRefreshLastSeen(12, 10, 3), false);
  assert.equal(api.shouldRefreshLastSeen(13, 10, 3), true);
  assert.equal(api.shouldRefreshLastSeen(10, 10, 0), true);
});

// Повторный start не должен умножить слушателей, hidden/connecting не считаются возвращением к приложению.
it('R208 старт refresh одинарный, скрытая вкладка и connecting не поднимают эпоху', () => {
  const f = fixture(); f.api.startLastSeenRefresh(); f.api.startLastSeenRefresh();
  assert.equal(f.visible.length, 1); assert.equal(f.connections.length, 1);
  for (const state of ['hidden', 'prerender']) f.visibility(state);
  for (const state of ['connecting', 'offline', 'closed']) f.connect(state);
  assert.deepEqual(f.writes, []);
});

async function resumed(raw = source) {
  const f = fixture(7, true, raw); f.api.startLastSeenRefresh();
  f.visibility('visible');
  assert.deepEqual(f.writes, [8], 'возврат visible повышает прежнюю эпоху');
  f.time(4999); f.connect('online');
  assert.deepEqual(f.writes, [8], 'online до пяти секунд дедуплицируется');
  f.time(5000); f.connect('online');
  assert.deepEqual(f.writes, [8, 9], 'online на границе снова спрашивает статус');
  f.time(10000); f.visibility('hidden'); f.connect('connecting');
  assert.deepEqual(f.writes, [8, 9]);
  f.visibility('visible'); assert.deepEqual(f.writes, [8, 9, 10]);
}
// Сохранённая эпоха увеличивается, а не сбрасывается в 1; парные positive-события проверяются с настоящими callbacks.
it('R208 visible и online поднимают эпоху с общей дедупликацией', async () => { await resumed(); });

// Без document серверный/тестовый контекст может подключить сеть; первый bump не теряется из-за нуля часов.
it('R208 refresh без document работает от online, отсутствующая эпоха начинается с единицы', () => {
  const f = fixture(undefined, false); f.api.startLastSeenRefresh();
  assert.equal(f.visible.length, 0); f.connect('online'); assert.deepEqual(f.writes, [1]);
  assert.equal(f.api.bumpLastSeenEpoch(4999), false); assert.equal(f.api.bumpLastSeenEpoch(5000), true);
  assert.deepEqual(f.writes, [1, 2]);
});

// Ловит лишние HTTP-запросы при почти одновременном возвращении вкладки и шлюза, не ошибку VM.
it('R208 контрфакт без дедупликации преждевременно поднимает эпоху', async () => {
  await resumed();
  const anchor = 'if (!shouldRefreshLastSeen(now, last)) return false;';
  assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(resumed(source.replace(anchor, '')),
    e => e instanceof assert.AssertionError && e.message.startsWith('online до пяти секунд дедуплицируется')
      && JSON.stringify(e.actual) === '[8,9]' && JSON.stringify(e.expected) === '[8]');
});
