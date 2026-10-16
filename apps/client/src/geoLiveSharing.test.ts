import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { create } from 'zustand';
import * as shared from '@gusvoice/shared';

type Api = typeof import('./geoLiveSharing');
type Share = import('./geoLiveSharing').GeoLiveShare;
const source = readFileSync(new URL('./geoLiveSharing.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const storeSource = readFileSync(new URL('./store.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const restored = (messageId: string, native = false, until = 900_000, instanceId = 'home'): Share => ({ messageId, conversationId: `conv-${messageId}`, native, until, instanceId });
function fixture(options: { raw?: string; android?: boolean; bridge?: boolean; seed?: string; hidden?: boolean } = {}) {
  const storage = new Map<string, string>(); if (options.seed !== undefined) storage.set('gv_geolive', options.seed);
  const state = { now: 0, instance: 'home', token: 'fixture-token-not-secret', nativeAccept: true, nativeThrow: false, nativeIds: '[]', fail: null as unknown, hidden: options.hidden ?? false };
  const updates: { conv: string; id: string; point: { lat: number; lon: number; accuracy: number | null; heading: number | null } }[] = [];
  const stops: [string, string][] = [], edits: unknown[] = [], watches: unknown[] = [], clears: number[] = [], nativeStarts: unknown[] = [], nativeStops: string[] = [];
  let watchCallback: ((p: GeolocationPosition) => void) | undefined, watchSeq = 0, timerSeq = 0, nativeClears = 0;
  const intervals = new Map<number, () => void>(); let pending: Promise<unknown> | undefined;
  const bridge = {
    startLiveLocation(json: string) { nativeStarts.push(JSON.parse(json)); if (state.nativeThrow) throw new Error('fixture native unavailable'); return state.nativeAccept; },
    stopLiveLocation(id: string) { nativeStops.push(id); }, stopAllLiveLocations() { nativeClears++; }, liveLocationIds() { return state.nativeIds; },
  };
  const dependencies: Record<string, unknown> = {
    '@gusvoice/shared': shared, zustand: { create },
    './api': { getToken: () => state.token, api: {
      convGeoLiveUpdate(conv: string, id: string, point: typeof updates[number]['point']) { updates.push({ conv, id, point: plain(point) }); return pending ?? (state.fail ? Promise.reject(state.fail) : Promise.resolve()); },
      async convGeoLiveStop(conv: string, id: string) { stops.push([conv, id]); return { id, media: { stopped: true } }; },
    } },
    './config': { activeInstanceId: () => state.instance, config: { apiUrl: 'https://fixture.invalid/api' } },
    './hotkeys': { isAndroid: () => options.android === true },
    './store': { useStore: { getState: () => ({ convAfterEdit(conv: string, msg: unknown) { edits.push([conv, plain(msg)]); } }) } },
  };
  class Clock extends Date { static now() { return state.now; } }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(options.raw ?? source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date: Clock, console: { warn() {} },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    navigator: { geolocation: {
      watchPosition(fn: (p: GeolocationPosition) => void, _error: unknown, opts: unknown) { watchCallback = fn; watches.push(plain(opts)); return ++watchSeq; },
      clearWatch(id: number) { clears.push(id); },
    } },
    document: { get visibilityState() { return state.hidden ? 'hidden' : 'visible'; } },
    window: { GusVoiceNative: options.bridge ? bridge : undefined, setInterval(fn: () => void, ms: number) { assert.equal(ms, 10_000); intervals.set(++timerSeq, fn); return timerSeq; }, clearInterval(id: number) { intervals.delete(id); } },
    require(id: string) { assert.ok(id in dependencies, `неожиданная зависимость ${id}`); return dependencies[id]; },
  });
  const api = module.exports as Api;
  return { api, state, storage, updates, stops, edits, watches, clears, intervals, nativeStarts, nativeStops,
    get nativeClears() { return nativeClears; }, list() { return Array.from(api.useGeoLive.getState().list, s => plain(s)) as Share[]; },
    begin(id = 'm1', until = 900_000) { api.beginGeoLive(`conv-${id}`, id, { until, lat: 55, lon: 37, accuracy: 10, heading: null }); },
    async fix(now: number, lat = 55.001, lon = 37, accuracy = 15, heading: number | null = 90) {
      state.now = now; assert.ok(watchCallback, 'подписка геолокации действительно установлена');
      watchCallback({ coords: { latitude: lat, longitude: lon, accuracy, heading } } as GeolocationPosition);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    tick(now: number) { state.now = now; for (const fn of [...intervals.values()]) fn(); },
    defer(promise: Promise<unknown> | undefined) { pending = promise; },
  };
}
it('R225 одна подписка страницы ведёт несколько трансляций, повтор begin заменяет запись без лишнего watcher', async () => {
  const f = fixture(); f.begin('a'); f.begin('b'); f.begin('a');
  assert.equal(f.watches.length, 1); assert.equal(f.intervals.size, 1); assert.deepEqual(f.list().map(s => s.messageId), ['b', 'a']);
  assert.deepEqual(f.watches[0], { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  await f.fix(4999); assert.equal(f.updates.length, 0);
  await f.fix(5000); assert.deepEqual(f.updates.map(p => p.id), ['b', 'a']); assert.deepEqual(f.updates[0]!.point, { lat: 55.001, lon: 37, accuracy: 15, heading: 90 });
  assert.equal(f.api.geoLiveShareOf(f.api.useGeoLive.getState().list, 'missing'), undefined);
  assert.equal(f.api.geoLiveShareOf(f.api.useGeoLive.getState().list, 'a')?.conversationId, 'conv-a');
});
it('R225 точка чужого активного инстанса не отправляется, возвращение к своему инстансу возобновляет отправку', async () => {
  const f = fixture(); f.begin(); f.state.instance = 'neighbor'; await f.fix(5000); assert.equal(f.updates.length, 0);
  f.state.instance = 'home'; await f.fix(5000); assert.equal(f.updates.length, 1);
});
it('R225 незавершённый запрос не повторяется даже после sendGap, после его завершения следующая точка принимается', async () => {
  const f = fixture(); f.begin(); let resolve!: () => void;
  f.defer(new Promise<void>(ok => { resolve = ok; })); await f.fix(5000); await f.fix(10000, 55.002); assert.equal(f.updates.length, 1);
  resolve(); for (let i = 0; i < 5; i++) await Promise.resolve(); f.defer(undefined);
  await f.fix(10000, 55.002); assert.equal(f.updates.length, 2);
  await f.fix(15000, 55.003, 37, NaN, NaN); assert.deepEqual(f.updates.at(-1)!.point, { lat: 55.003, lon: 37, accuracy: null, heading: null });
});
async function permanent(status: number, raw = source) {
  const f = fixture({ raw }); f.begin(); f.state.fail = { status }; await f.fix(5000);
  assert.equal(f.list().length, 0, `R225-status-${status}: окончательный отказ снимает трансляцию`);
  assert.deepEqual(f.clears, [1]); assert.equal(f.intervals.size, 0); assert.equal(f.storage.has('gv_geolive'), false);
}
it('R225 числовые 403 и 404 снимают запись и прекращают подписку на геолокацию', async () => {
  await permanent(403); await permanent(404);
});
it('R225 сеть, 429 и строковый status сохраняют запись, следующая допустимая точка повторяет запрос', async () => {
  for (const error of [new Error('fixture network'), { status: 429 }, { status: '403' }, null]) {
    const f = fixture(); f.begin(); f.state.fail = error; await f.fix(5000);
    assert.equal(f.list().length, 1); assert.equal(f.watches.length, 1); assert.equal(f.storage.has('gv_geolive'), true);
    f.state.fail = null; await f.fix(9999, 55.002); assert.equal(f.updates.length, 1);
    await f.fix(10000, 55.002); assert.equal(f.updates.length, 2); f.api.stopAllGeoLiveLocal();
  }
});
it('R225 Android передаёт адрес и тестовый токен службе, не запускает страницу; отказ/нет токена возвращают page fallback', async () => {
  const f = fixture({ android: true, bridge: true }); f.begin();
  assert.equal(f.list()[0]!.native, true); assert.equal(f.watches.length, 0);
  assert.deepEqual(f.nativeStarts[0], { apiUrl: 'https://fixture.invalid/api', token: 'fixture-token-not-secret', conversationId: 'conv-m1', messageId: 'm1', until: 900000, backgroundMs: shared.GEO_LIVE_LIMITS.backgroundMs });
  for (const mode of ['false', 'throw', 'no-token', 'old-apk', 'web'] as const) {
    const f = fixture({ android: mode !== 'web', bridge: mode !== 'old-apk' });
    if (mode === 'false') f.state.nativeAccept = false; if (mode === 'throw') f.state.nativeThrow = true; if (mode === 'no-token') f.state.token = '';
    f.begin(); assert.equal(f.list()[0]!.native, false); assert.equal(f.watches.length, 1); await f.fix(5000); assert.equal(f.updates.length, 1);
  }
});
it('R225 stopGeoLive выключает только свою службу/подписку, вызывает API и переносит ответ в convAfterEdit', async () => {
  const f = fixture({ android: true, bridge: true }); f.begin('a'); f.begin('b');
  await f.api.stopGeoLive('conv-a', 'a'); assert.deepEqual(f.nativeStops, ['a']); assert.deepEqual(f.list().map(s => s.messageId), ['b']);
  assert.deepEqual(f.stops, [['conv-a', 'a']]); assert.deepEqual(f.edits, [['conv-a', { id: 'a', media: { stopped: true } }]]);
  const page = fixture(); page.begin(); await page.api.stopGeoLive('conv-m1', 'm1'); assert.deepEqual(page.clears, [1]); assert.equal(page.intervals.size, 0);
});
function cleanup(raw = source) {
  const f = fixture({ raw, android: true, bridge: true }); f.begin('native'); f.state.nativeAccept = false; f.begin('page');
  assert.equal(f.list().length, 2); assert.equal(f.watches.length, 1); f.api.stopAllGeoLiveLocal();
  assert.equal(f.nativeClears, 1, 'R225-native-cleanup: выход прекращает также Android службу');
  assert.equal(f.list().length, 0); assert.deepEqual(f.clears, [1]); assert.equal(f.intervals.size, 0); assert.equal(f.storage.has('gv_geolive'), false); assert.equal(f.stops.length, 0);
  f.begin('again'); assert.equal(f.watches.length, 2); assert.equal(f.list().length, 1);
}
it('R225 stopAll прекращает нативную и page трансляции на месте без API, после него можно начать снова', () => cleanup());
it('R225 ровно until снимает запись, до until она остаётся; потеря токена тоже очищает page запись', () => {
  const f = fixture(); f.begin('a', 10000); f.tick(9999); assert.equal(f.list().length, 1);
  f.tick(10000); assert.equal(f.list().length, 0); assert.deepEqual(f.clears, [1]);
  f.begin('b', 20000); f.state.token = ''; f.tick(10001); assert.equal(f.list().length, 0); assert.equal(f.storage.has('gv_geolive'), false);
});
it('R225 restart возвращает только неистёкшие валидные page записи, битое хранилище не ломает старт', () => {
  const f = fixture({ seed: JSON.stringify([restored('active', false, 1), restored('expired', false, 0), { messageId: 'invalid', until: 5 }]) });
  f.api.resumeGeoLive(); assert.deepEqual(f.list().map(s => s.messageId), ['active']); assert.equal(f.watches.length, 1);
  f.tick(1); assert.equal(f.list().length, 0);
  for (const seed of ['{', 'null', '{}', '42']) { const f = fixture({ seed }); f.api.resumeGeoLive(); assert.equal(f.list().length, 0); assert.equal(f.watches.length, 0); }
});
it('R225 restart службы не дублирует живую, мёртвую запускает только из видимого окна и при отказе ведёт страницей', () => {
  const seed = JSON.stringify([restored('native', true)]);
  const alive = fixture({ android: true, bridge: true, seed }); alive.state.nativeIds = '["native"]'; alive.api.resumeGeoLive(); assert.equal(alive.nativeStarts.length, 0); assert.equal(alive.list()[0]!.native, true);
  const visible = fixture({ android: true, bridge: true, seed }); visible.api.resumeGeoLive(); assert.equal(visible.nativeStarts.length, 1); assert.equal(visible.list()[0]!.native, true);
  const hidden = fixture({ android: true, bridge: true, hidden: true, seed }); hidden.api.resumeGeoLive(); assert.equal(hidden.nativeStarts.length, 0); assert.equal(hidden.list().length, 0);
  const rejected = fixture({ android: true, bridge: true, seed }); rejected.state.nativeAccept = false; rejected.api.resumeGeoLive(); assert.equal(rejected.list()[0]!.native, false); assert.equal(rejected.watches.length, 1);
});
it('R225 учёт нативной службы удаляет остановленную ею трансляцию, плохой ответ моста не теряет запись', () => {
  const f = fixture({ android: true, bridge: true }); f.begin(); f.state.nativeIds = 'broken'; f.tick(10000); assert.equal(f.list().length, 1);
  f.state.nativeIds = '["m1"]'; f.tick(20000); assert.equal(f.list().length, 1);
  f.state.nativeIds = '[]'; f.tick(30000); assert.equal(f.list().length, 0); assert.equal(f.intervals.size, 0);
});
function logoutGuard(raw = storeSource) {
  const file = ts.createSourceFile('store.ts', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let logout: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'logout' && ts.isArrowFunction(node.initializer)) logout = node.initializer.body;
    ts.forEachChild(node, visit);
  }
  visit(file); assert.ok(logout);
  const calls: string[] = [], imports: string[] = [];
  function collect(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) calls.push(node.expression.name.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0]!)) imports.push((node.arguments[0] as ts.StringLiteral).text);
    ts.forEachChild(node, collect);
  }
  collect(logout); assert.equal(calls.includes('stopAllGeoLiveLocal') && imports.includes('./geoLiveSharing'), true, 'R225-logout: logout гасит локальные трансляции');
}
it('R225 logout реального store содержит вызов stopAllGeoLiveLocal через импорт менеджера', () => logoutGuard());
for (const status of [403, 404]) it(`R225 контрфакт: статус ${status} перестал снимать трансляцию`, async () => {
  await permanent(status, source); const from = 'st === 403 || st === 404'; assert.equal(source.split(from).length - 1, 1);
  await assert.rejects(permanent(status, source.replace(from, 'false')), e => e instanceof assert.AssertionError
    && e.message.startsWith(`R225-status-${status}:`) && e.operator === 'strictEqual' && e.actual === 1 && e.expected === 0);
});
it('R225 контрфакт: выход забыл выключить нативную службу', () => {
  cleanup(source); const from = 'liveBridge()?.stopAllLiveLocations?.();'; assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => cleanup(source.replace(from, '')), e => e instanceof assert.AssertionError
    && e.message.startsWith('R225-native-cleanup:') && e.operator === 'strictEqual' && e.actual === 0 && e.expected === 1);
});
it('R225 контрфакт: logout больше не вызывает менеджер трансляций', () => {
  logoutGuard(storeSource);
  const from = "void import('./geoLiveSharing').then((m) => m.stopAllGeoLiveLocal(), () => {});"; assert.equal(storeSource.split(from).length - 1, 1);
  assert.throws(() => logoutGuard(storeSource.replace(from, '')), e => e instanceof assert.AssertionError
    && e.message.startsWith('R225-logout:') && e.operator === 'strictEqual' && e.actual === false && e.expected === true);
});
