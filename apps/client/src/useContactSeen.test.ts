import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as labels from './lastSeenText';

const actDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
before(() => { GlobalRegistrator.register({ url: 'http://localhost/' }); Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true }); });
after(() => {
  GlobalRegistrator.unregister();
  if (actDescriptor) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actDescriptor);
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});
function replaceOnce(source: string, anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, `единственный якорь ${anchor}`);
  return source.replace(anchor, replacement);
}

async function scenario(features: string[], enabled: boolean, ids: string[], fail = false, mutate?: (s: string) => string) {
  const source = readFileSync(new URL('./useContactSeen.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const changed = mutate ? mutate(source) : source;
  if (mutate) assert.notEqual(changed, source, 'мутант изменил реальный модуль');
  const calls: string[][] = [];
  const dependencies: Record<string, unknown> = {
    react: React,
    './lastSeenText': labels,
    './store': { useStore: (selector: (s: { serverFeatures: string[] }) => unknown) => selector({ serverFeatures: features }) },
    './api': { api: { usersLastSeen: async (batch: string[]) => {
      calls.push(Array.from(batch));
      if (fail) throw new Error('сеть');
      return { items: batch.map(userId => ({ userId, online: true, exact: true, at: null, approx: null, byMe: false })) };
    } } },
  };
  const module = { exports: {} as typeof import('./useContactSeen') };
  runInNewContext(ts.transpileModule(changed, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `неописанная граница ${id}`); return dependencies[id]; } });
  let result = new Map<string, string>();
  const online = new Set<string>();
  function Probe() { result = module.exports.useContactSeen(ids, online, enabled); return null; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => { root.render(React.createElement(Probe)); });
    await React.act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return { calls, size: result.size, first: result.get(ids[0]!) };
  } finally { await React.act(async () => root.unmount()); host.remove(); }
}

it('R169 без признака сервера и при выключенном телефоне нет ни подписи, ни запроса', async () => {
  // Клиент старого сервера не должен вызывать неизвестную ручку; выключенный экран не тратит лимит.
  for (const [features, enabled] of [[[], true], [['lastseen1'], false]] as const) {
    const s = await scenario([...features], enabled, ['a']); assert.equal(s.size, 0); assert.equal(s.calls.length, 0);
  }
  const s = await scenario(['lastseen1'], true, []); assert.equal(s.size, 0); assert.equal(s.calls.length, 0);
});
it('R169 двести контактов идут одним пакетом, повторные id не создают запросов', async () => {
  // Запрос на каждого исчерпал бы лимит API ещё при открытии списка.
  const ids = Array.from({ length: 200 }, (_, i) => `u${i}`);
  const s = await scenario(['lastseen1'], true, [...ids, ids[0]!]);
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0]!.length, 200); assert.equal(s.size, 200);
  assert.equal(s.first, 'был(а) только что');
});
it('R169 двести первый контакт попадает во второй пакет, а 401-й в третий', async () => {
  // Граница чанка проверяется с обеих сторон, чтобы хвост не потерялся и не ушёл сверх лимита.
  for (const n of [201, 401]) {
    const ids = Array.from({ length: n }, (_, i) => `u${i}`); const s = await scenario(['lastseen1'], true, ids);
    assert.deepEqual(s.calls.map(c => c.length), n === 201 ? [200, 1] : [200, 200, 1]);
    assert.equal(s.size, n); assert.equal(new Set(s.calls.flat()).size, n);
  }
});
it('R169 отказ API оставляет пустую карту для прежнего @ника', async () => {
  // Ошибка сети не должна подменяться выдуманным статусом или отвергнутым Promise.
  const s = await scenario(['lastseen1'], true, ['a', 'b'], true);
  assert.equal(s.calls.length, 1); assert.equal(s.size, 0);
});
it('R169 контрфакты выключенного экрана и запроса на каждого отвергаются', async () => {
  // Настоящий модуль с ошибкой должен нарушить контракт, а не только совпасть с текстовым якорем.
  const baselineDisabled = await scenario(['lastseen1'], false, ['a']); assert.equal(baselineDisabled.calls.length, 0);
  const disabled = await scenario(['lastseen1'], false, ['a'], false, s => replaceOnce(s, '&& enabled', '&& true'));
  assert.throws(() => assert.equal(disabled.calls.length, 0), assert.AssertionError);
  const baselineBatch = await scenario(['lastseen1'], true, ['a', 'b']); assert.equal(baselineBatch.calls.length, 1);
  const perUser = await scenario(['lastseen1'], true, ['a', 'b'], false, s => replaceOnce(s, 'const BATCH = 200;', 'const BATCH = 1;'));
  assert.throws(() => assert.equal(perUser.calls.length, 1), assert.AssertionError);
});
