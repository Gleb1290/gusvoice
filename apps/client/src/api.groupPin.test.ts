import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';

const raw = readFileSync(new URL('./api.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(source = raw) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const unused = () => assert.fail('IO вне проверки API закрепа');
  const deps: Record<string, unknown> = {
    './bgGateways': { mirrorToBg: unused }, './config': { config: { apiUrl: 'https://pin.example.test' },
      activeInstance: () => null, activeInstanceId: () => null, instances: () => [], updateActiveInstance: unused, updateInstance: unused },
    './imageSize': { measureMediaFile: unused },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, URL, Response, Headers, AbortSignal, Error, TypeError,
      localStorage: { getItem: (key: string) => { assert.equal(key, 'gv_token'); return null; }, setItem: unused, removeItem: unused },
      fetch: async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{"pts":1,"pins":[]}', { status: 200 }); },
      require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `объявленный импорт полного API: ${id}`); return deps[id]; },
    });
  return { api: (module.exports as typeof import('./api')).api, calls };
}
async function check(source: string, scope: 'me' | 'both', notify?: boolean) {
  const f = load(source);
  const response = await f.api.convPin('conversation', 'message', scope, notify);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://pin.example.test/api/conv/conversation/messages/message/pin');
  assert.equal(f.calls[0].init.method, 'PUT');
  const expected = notify === undefined ? { for: scope } : { for: scope, notify };
  assert.equal(f.calls[0].init.body, JSON.stringify(expected), 'G4-api-body: notify отсутствует полностью либо сохраняет точный boolean');
  assert.deepEqual(response, { pts: 1, pins: [] });
}
for (const scope of ['me', 'both'] as const) it(`R214 API закрепа без notify шлёт ровно {for:${scope}}`, () => check(raw, scope));
for (const notify of [true, false]) it(`R214 API общего закрепа сохраняет notify=${notify}`, () => check(raw, 'both', notify));

for (const [label, from, to, notify, actual, expected] of [
  ['снятая галочка теряется как отсутствующая', 'notify === undefined ? { for: scope }', '!notify ? { for: scope }', false, '{"for":"both"}', '{"for":"both","notify":false}'],
  ['включённое уведомление теряется', '{ for: scope, notify }) satisfies ConvPinRequest', '{ for: scope }) satisfies ConvPinRequest', true, '{"for":"both"}', '{"for":"both","notify":true}'],
] as const) it(`R214 API контрфакт: ${label}`, async () => {
  await check(raw, 'both', notify);
  assert.equal(raw.split(from).length - 1, 1, 'у мутации тела закрепа один якорь');
  await assert.rejects(check(raw.replace(from, to), 'both', notify), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith('G4-api-body:') && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected);
});
