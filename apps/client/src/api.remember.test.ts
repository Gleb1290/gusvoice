import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { testVmImports } from './testVmImports.js';

it('вход и подтверждение почты отправляют rememberMe только при явном согласии', async () => {
  const sourceUrl = new URL('./api.ts', import.meta.url);
  const source = readFileSync(sourceUrl, 'utf8');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const unused = () => assert.fail('Неожиданное обращение к хранилищу');
  const dependencies = { './config': { config: { apiUrl: 'https://example.test' }, activeInstance: () => null,
    activeInstanceId: () => null, instances: () => [], updateActiveInstance: unused, updateInstance: unused } };
  const module = { exports: {} as { api: Record<string, (...args: any[]) => Promise<unknown>> } };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
    module, exports: module.exports, URL, Response, Headers, AbortSignal, Error, TypeError,
    localStorage: { getItem: () => null, setItem: unused, removeItem: unused },
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    require: testVmImports(sourceUrl, dependencies),
  });
  for (const [method, endpoint, fields] of [
    ['login', '/auth/login', { username: 'alice', password: 'pw' }],
    ['verify', '/auth/verify', { identifier: 'alice', code: '123456' }],
  ] as const) {
    const args = method === 'login' ? ['alice', 'pw'] : ['alice', '123456'];
    for (const choice of [undefined, false, true]) {
      await module.exports.api[method](...args, ...(choice === undefined ? [] : [choice]));
      const call = calls.at(-1)!;
      assert.equal(call.init.method, 'POST');
      assert.equal(call.url, `https://example.test/api${endpoint}`);
      assert.deepEqual(JSON.parse(String(call.init.body)), choice ? { ...fields, rememberMe: true } : fields);
    }
  }
  assert.equal(calls.length, 6);
});
