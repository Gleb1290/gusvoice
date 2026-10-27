import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as attRules from './attLinkRules';
import { load, mutate, sourceOf } from './R304.testHarness';
import type * as Links from './attLinks';

const source = sourceOf('attLinks');
const firstId = '12345678-abcd-abcd-abcd-1234567890ab';
const secondId = '12345678-abcd-abcd-abcd-1234567890ac';
const url = (id = firstId, suffix = '') => `https://voice.example/api/att/${id}/me/${'s'.repeat(32)}.1234567890${suffix}`;
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function fixture(raw = source, status = 404) {
  const batches: string[][] = [], requests: { input: unknown; init: unknown }[] = [], timers: (() => void)[] = [];
  const listeners = new Map<string, { fn: unknown; capture: unknown }>();
  const original = { status } as Response, renewed = { status: 200 } as Response;
  const win = { location: { origin: 'https://voice.example', href: 'https://voice.example/' },
    fetch: async (input: unknown, init: unknown) => {
      requests.push({ input, init }); return requests.length === 1 ? original : renewed;
    } };
  let reject = false;
  const mod = load<typeof Links>(raw, { './api': { api: {
    apiBaseUrl: () => 'https://voice.example/api',
    attLinks: async (ids: string[]) => {
      batches.push([...ids]); if (reject) throw new Error('offline');
      return { links: Object.fromEntries(ids.filter(id => id !== secondId).map(id => [id, url(id, '?fresh')])) };
    },
  } }, './attLinkRules': attRules }, {
    window: win, document: { addEventListener: (name: string, fn: unknown, capture: unknown) => { listeners.set(name, { fn, capture }); } },
    setTimeout: (fn: () => void, ms: number) => { assert.equal(ms, 30); timers.push(fn); return timers.length; },
  });
  return { mod, win, batches, requests, original, renewed, listeners,
    reject: () => { reject = true; }, flush: async () => { timers.splice(0).forEach(fn => fn()); await tick(); } };
}
async function oneAttempt(raw: string) {
  const f = fixture(raw), p = f.mod.renewAttLink(url()); await f.flush(); await p;
  const again = f.mod.renewAttLink(url()); await f.flush();
  assert.equal(await again, null, 'одна попытка на ту же исходную ссылку');
  assert.equal(f.batches.length, 1);
}
it('R304 истёкшая ссылка продлевается ровно один раз', async () => { await oneAttempt(source); });
it('R304 разные файлы и разные формы одного id собираются в одну пачку без дублей', async () => {
  const f = fixture(), a = f.mod.renewAttLink(url()), duplicate = f.mod.renewAttLink(url(firstId, '?another')),
    b = f.mod.renewAttLink(url(secondId));
  assert.equal(f.batches.length, 0, 'запрос не уходит до окна накопления');
  await f.flush(); assert.equal(await a, url(firstId, '?fresh')); assert.equal(await duplicate, await a);
  assert.equal(await b, null, 'недоступный id сервер не вернул');
  assert.equal(JSON.stringify(f.batches), JSON.stringify([[firstId, secondId]]));
  const next = f.mod.renewAttLink(url(firstId, '?fresh')); await f.flush(); await next;
  assert.equal(f.batches.length, 2, 'обновлённая ссылка позже тоже может истечь');
});
async function foreign(raw: string) {
  const f = fixture(raw), p = f.mod.renewAttLink(url().replace('voice.example', 'other.example'));
  await f.flush(); assert.equal(await p, null, 'чужой origin не продлевается'); assert.equal(f.batches.length, 0);
}
it('R304 чужой origin и обычные API-адреса не обращаются за подписью', async () => {
  await foreign(source); const f = fixture();
  assert.equal(await f.mod.renewAttLink('https://voice.example/api/media/x'), null); assert.equal(f.batches.length, 0);
});
it('R304 ошибка сервера разрешает ожидающих в null и не открывает бесконечный повтор', async () => {
  const f = fixture(); f.reject(); const p = f.mod.renewAttLink(url()); await f.flush();
  assert.equal(await p, null); assert.equal(await f.mod.renewAttLink(url()), null); assert.equal(f.batches.length, 1);
});
async function fetchCase(raw: string, status: number, target: string, retry: boolean) {
  const f = fixture(raw, status); f.mod.installAttLinkRenewal(); f.mod.installAttLinkRenewal();
  assert.equal(f.listeners.get('error')?.capture, true, 'ошибки media слушаются на фазе захвата');
  const init = { credentials: 'omit' as const };
  const p = f.win.fetch(target, init); await tick(); await f.flush(); const result = await p;
  assert.equal(f.requests.length, retry ? 2 : 1, 'fetch повторяет только доступное вложение после 403/404');
  assert.equal(result, retry ? f.renewed : f.original);
  if (retry) { assert.equal(f.requests[1].input, url(firstId, '?fresh')); assert.equal(f.requests[1].init, init); }
}
for (const status of [200, 401, 403, 404, 429, 500]) it(`R304 fetch статуса ${status} повторяется только для 403/404`, async () => {
  await fetchCase(source, status, url(), status === 403 || status === 404);
});
it('R304 fetch чужого вложения и обычного URL после 404 остаётся единственным запросом', async () => {
  await fetchCase(source, 404, url().replace('voice.example', 'other.example'), false);
  await fetchCase(source, 404, 'https://voice.example/api/conv/messages', false);
});
for (const [title, anchor, replacement, check, marker] of [
  ['повтор исходной ссылки', 'if (!id || tried.has(url))', 'if (!id)', oneAttempt, 'одна попытка на ту же исходную ссылку'],
  ['чужой origin', 'if (!isAttLink(url) || !ours(url))', 'if (!isAttLink(url))', foreign, 'чужой origin не продлевается'],
  ['повтор после 500', '(res.status !== 404 && res.status !== 403)', 'false', (raw: string) => fetchCase(raw, 500, url(), false), 'fetch повторяет только доступное вложение'],
] as const) it(`R304 контрфакт attLinks: ${title} обнаруживается тем же сценарием`, async () => {
  await check(source); await assert.rejects(check(mutate(source, anchor, replacement)),
    e => e instanceof assert.AssertionError && e.message.includes(marker));
});
