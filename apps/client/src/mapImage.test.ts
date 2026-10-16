import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import { serverYandexMap } from './convSyncRules';

type Api = typeof import('./mapImage');
const source = readFileSync(new URL('./mapImage.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function fixture(raw = source) {
  const clock = { now: 0 }, state = { fail: false, theme: 'dark' }, calls: string[] = [], revoked: string[] = [], blobs: Blob[] = [];
  let next = 0, deferred: Promise<Blob> | undefined;
  class Clock extends Date { static now() { return clock.now; } }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date: Clock, URL: { createObjectURL(blob: Blob) { blobs.push(blob); return `blob:map-${++next}`; }, revokeObjectURL(url: string) { revoked.push(url); } },
      document: { documentElement: { getAttribute(key: string) { assert.equal(key, 'data-theme'); return state.theme; } } },
      require(id: string) { if (id === '@gusvoice/shared') return shared; assert.equal(id, './api'); return { api: { mapStaticImage(path: string) {
        calls.push(path); return deferred ?? (state.fail ? Promise.reject(new Error('fixture network failure')) : Promise.resolve(new Blob(['fixture map'], { type: 'image/png' })));
      } } }; } });
  return { api: module.exports as Api, clock, state, calls, revoked, blobs, defer(promise: Promise<Blob>) { deferred = promise; } };
}
it('R220 yamap1 включается только своим признаком, тема карты следует атрибуту страницы', () => {
  assert.equal(serverYandexMap(['yamap1']), true);
  for (const features of [undefined, null, [], ['yamap10'], ['geocontact1']]) assert.equal(serverYandexMap(features), false);
  const f = fixture(); assert.equal(f.api.mapThemeNow(), 'dark'); f.state.theme = 'light'; assert.equal(f.api.mapThemeNow(), 'light');
  f.state.theme = 'other'; assert.equal(f.api.mapThemeNow(), 'dark');
});
it('R220 одно место повторно берётся из памяти, другая тема имеет отдельную картинку', async () => {
  const f = fixture(), url = await f.api.loadMapImage(10, 20, 'dark');
  assert.equal(url, 'blob:map-1'); assert.equal(await f.api.loadMapImage(10, 20, 'dark'), url); assert.equal(f.calls.length, 1);
  const path = new URL(f.calls[0]!, 'https://fixture.invalid'); assert.equal(path.pathname, '/maps/static');
  assert.equal(path.searchParams.get('lat'), '10'); assert.equal(path.searchParams.get('lon'), '20'); assert.equal(path.searchParams.get('w'), '560'); assert.equal(path.searchParams.get('h'), '320');
  assert.equal(await f.api.loadMapImage(10, 20, 'light'), 'blob:map-2'); assert.equal(f.calls.length, 2); assert.deepEqual(f.revoked, []);
});
it('R220 два одновременных показа одного места ждут одно и то же обещание без второго HTTP', async () => {
  const f = fixture(); let resolve!: (blob: Blob) => void;
  f.defer(new Promise(ok => { resolve = ok; }));
  const first = f.api.loadMapImage(10, 20, 'dark'), second = f.api.loadMapImage(10, 20, 'dark');
  assert.equal(first, second); assert.equal(f.calls.length, 1); resolve(new Blob(['map']));
  assert.equal(await first, 'blob:map-1'); assert.equal(await second, 'blob:map-1'); assert.equal(f.blobs.length, 1);
});
async function retry(raw = source) {
  const f = fixture(raw); f.state.fail = true;
  assert.equal(await f.api.loadMapImage(10, 20, 'dark'), null); f.clock.now = 59_999;
  assert.equal(await f.api.loadMapImage(10, 20, 'dark'), null); assert.equal(f.calls.length, 1, 'R220-map-retry: отказ запоминается до минуты');
  f.clock.now++; f.state.fail = false; assert.equal(await f.api.loadMapImage(10, 20, 'dark'), 'blob:map-1'); assert.equal(f.calls.length, 2);
}
it('R220 отказ не повторяется до 59999 мс, ровно через минуту запрос возобновляется и кешируется', () => retry());
async function cap(raw = source) {
  const f = fixture(raw); for (let lat = 0; lat < 60; lat++) await f.api.loadMapImage(lat, 20, 'dark');
  assert.deepEqual(f.revoked, [], 'ровно 60 картинок ещё сохраняются'); await f.api.loadMapImage(60, 20, 'dark');
  assert.equal(f.revoked[0], 'blob:map-1', 'R220-map-cap: 61-я картинка освобождает старый blob'); assert.equal(f.revoked.length, 1);
  assert.equal(await f.api.loadMapImage(1, 20, 'dark'), 'blob:map-2'); assert.equal(f.calls.length, 61);
  await f.api.loadMapImage(0, 20, 'dark'); assert.equal(f.calls.length, 62);
}
it('R220 шестьдесят картинок в памяти разрешены, шестьдесят первая вытесняет старую и revoke её URL', () => cap());
it('R220 повторное место обновляет свежесть, при вытеснении освобождается следующий по возрасту URL', async () => {
  const f = fixture(); for (let lat = 0; lat < 60; lat++) await f.api.loadMapImage(lat, 20, 'dark');
  await f.api.loadMapImage(0, 20, 'dark'); await f.api.loadMapImage(60, 20, 'dark'); assert.deepEqual(f.revoked, ['blob:map-2']);
});
for (const [label, from, to, check, prefix, actual, expected] of [
  ['пропал предел памяти', 'urls.size > KEEP', 'false', cap, 'R220-map-cap:', undefined, 'blob:map-1'],
  ['сбой не ждёт минуту', 'const FAIL_MS = 60_000;', 'const FAIL_MS = 0;', retry, 'R220-map-retry:', 2, 1],
] as const) it(`R220 контрфакт кеша карты: ${label}`, async () => {
  await check(source); assert.equal(source.split(from).length - 1, 1);
  await assert.rejects(check(source.replace(from, to)), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});
