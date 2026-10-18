import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { FederationSwitchPatch, FederationSwitchView } from '@gusvoice/shared';

const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const view: FederationSwitchView = { enabled: true, source: 'panel', dmEnabled: false, dmSource: 'off', status: 'ready', problem: null };
type ApiModule = typeof import('./api');
function fixture(body: unknown = view, status = 200, raw = source) {
  const requests: { url: string; init: RequestInit }[] = [];
  const unexpected = () => assert.fail('Неожиданная IO-граница API переключателя');
  const dependencies: Record<string, unknown> = {
    './bgGateways': { mirrorToBg: unexpected },
    './config': { config: { apiUrl: 'https://api.example.test' }, activeInstance: () => null, activeInstanceId: () => null,
      instances: () => [], updateActiveInstance: unexpected, updateInstance: unexpected },
    './imageSize': { measureMediaFile: unexpected },
  };
  const module = { exports: {} as ApiModule };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports, URL, Response, Headers, AbortSignal, Error, TypeError,
    localStorage: { getItem: (key: string) => { assert.equal(key, 'gv_token'); return 'test-only-session'; }, setItem: unexpected, removeItem: unexpected },
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    },
    require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `Неописанный импорт API: ${id}`); return dependencies[id]; },
  });
  return { api: module.exports.api, requests };
}

it('R257 API читает переключатель отдельным GET с авторизацией и без тела', async () => {
  // Старый обзор возвращает 404 при выключении: состояние тумблера должно запрашиваться другой ручкой.
  const f = fixture();
  assert.deepEqual(await f.api.federationSwitch(), view);
  assert.equal(f.requests.length, 1);
  const { url, init } = f.requests[0];
  assert.equal(url, 'https://api.example.test/api/admin/federation/switch');
  assert.equal(init.method, 'GET');
  assert.equal(init.body, undefined);
  assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only-session');
});

async function patchProbe(raw = source) {
  for (const patch of [{ enabled: true }, { enabled: false }, { dmEnabled: true }, { dmEnabled: false },
    { enabled: true, dmEnabled: false }] satisfies FederationSwitchPatch[]) {
    const f = fixture(view, 200, raw);
    assert.deepEqual(await f.api.federationSetSwitch(patch), view);
    assert.equal(f.requests.length, 1);
    const { url, init } = f.requests[0];
    assert.equal(url, 'https://api.example.test/api/admin/federation/switch');
    assert.equal(init.method, 'PATCH', 'R257 изменение переключателя посылается PATCH');
    assert.deepEqual(JSON.parse(String(init.body)), patch, 'R257 неуказанный флаг не дописывается и false не теряется');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only-session');
  }
}
it('R257 API отправляет частичный PATCH без неявного изменения соседнего тумблера', async () => {
  // Отсутствующее поле и false имеют разный смысл на сервере.
  await patchProbe();
});

it('R257 API сохраняет машинные 409-отказы и их статус для человеческих подсказок', async () => {
  for (const refusal of ['env_locked', 'dm_env_locked', 'federation_off']) {
    const f = fixture({ error: refusal }, 409);
    await assert.rejects(f.api.federationSetSwitch({ enabled: false }), (e: unknown) =>
      e instanceof Error && e.message === refusal && (e as Error & { status: number }).status === 409);
    assert.equal(f.requests.length, 1);
  }
});

it('R257 API отличает 404 старого сервера от серверной ошибки и не превращает их в состояние off', async () => {
  // Решение о совместимости принимает UI по status; транспорт не должен скрыть настоящий сбой.
  for (const status of [404, 500]) {
    const f = fixture({ error: 'switch-unavailable' }, status);
    await assert.rejects(f.api.federationSwitch(), (e: unknown) => e instanceof Error
      && e.message === 'switch-unavailable' && (e as Error & { status: number }).status === status);
  }
});

it('R257 контрфакт POST вместо PATCH обнаруживается после проверки настоящего транспорта', async () => {
  await patchProbe();
  const anchor = "req<FederationSwitchView>('PATCH', '/admin/federation/switch', patch)";
  assert.equal(source.split(anchor).length - 1, 1, 'единственное изменение переключателя');
  await assert.rejects(() => patchProbe(source.replace(anchor, "req<FederationSwitchView>('POST', '/admin/federation/switch', patch)")),
    (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith('R257 изменение переключателя посылается PATCH'));
});
