import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as rules from './stageOrderRules';
import type * as Prefs from './stageOrderPrefs';

const source = readFileSync(new URL('./stageOrderPrefs.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const key = 'gv_stage_order';
function load(raw = source, initial?: string, broken = false) {
  const values = new Map<string, string>(initial === undefined ? [] : [[key, initial]]);
  const module = { exports: {} as typeof Prefs };
  const storage = {
    getItem: (k: string) => { if (broken) throw Error('storage unavailable'); return values.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (broken) throw Error('storage unavailable'); values.set(k, v); },
    removeItem: (k: string) => { if (broken) throw Error('storage unavailable'); values.delete(k); },
  };
  const deps: Record<string, unknown> = { react: React, './stageOrderRules': rules };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, localStorage: storage, require: (id: string) => {
      if (!Object.hasOwn(deps, id)) throw Error(`Неизвестный импорт ${id}`); return deps[id];
    } });
  return { ...module.exports, values };
}
function channels(raw = source) {
  const f = load(raw); f.saveStageOrder('a', 2, ['b', 'a']); f.saveStageOrder('a', 3, ['a', 'b']); f.saveStageOrder('b', 2, ['x']);
  assert.deepEqual(f.getStageOrder('a', 2), ['b', 'a']); assert.deepEqual(f.getStageOrder('a', 3), ['a', 'b']);
  assert.deepEqual(f.getStageOrder('b', 2), ['x']); assert.equal(f.getStageOrder('b', 3), null);
  f.resetStageOrder('a'); assert.equal(f.getStageOrder('a', 2), null); assert.equal(f.getStageOrder('a', 3), null);
  assert.deepEqual(f.getStageOrder('b', 2), ['x']); assert.equal(f.hasStageOrder('a'), false);
  f.resetStageOrder('b'); assert.equal(f.values.has(key), false);
}
// Класс ошибки: смешивание канала и ширины или сброс соседнего канала.
it('R169 сохранение разделено по каналу и колонкам, сброс всех ширин только целевого канала', () => channels());
// Класс ошибки: неверное чтение сохранённого снимка и запись на пустом канале.
it('R169 чтение корректной записи, отсутствие канала и битый JSON безопасны', () => {
  const f = load(source, rules.serializeStageOrders({ a: { at: 1, cols: { 2: ['b', 'a'] } } }));
  assert.deepEqual(f.getStageOrder('a', 2), ['b', 'a']); assert.equal(f.hasStageOrder('a'), true);
  assert.equal(f.hasStageOrder(null), false); assert.equal(f.getStageOrder(null, 2), null);
  assert.equal(f.getStageOrder('a', 1), null); assert.equal(load(source, '{bad').hasStageOrder('a'), false);
});
// Класс ошибки: потеря ушедшего ключа при повторной записи.
it('R169 сохранение сохраняет место ушедшей плитки до возвращения', () => {
  const f = load(); f.saveStageOrder('a', 2, ['a', 'gone', 'b']); f.saveStageOrder('a', 2, ['b', 'a']);
  assert.deepEqual(f.getStageOrder('a', 2), ['b', 'a', 'gone']);
  assert.deepEqual(rules.parseStageOrders(f.values.get(key)).a.cols['2'], ['b', 'a', 'gone']);
});
function notify(raw = source) {
  const f = load(raw); let calls = 0;
  const bad = f.onStageOrder(() => { throw Error('listener failed'); });
  const off = f.onStageOrder(() => calls++);
  assert.doesNotThrow(() => f.saveStageOrder('a', 2, ['a'])); assert.equal(calls, 1);
  f.resetStageOrder('missing'); assert.equal(calls, 1);
  f.resetStageOrder('a'); assert.equal(calls, 2);
  off(); bad(); f.saveStageOrder('a', 2, ['b']); assert.equal(calls, 2);
}
// Класс ошибки: исключение слушателя блокирует остальные, отписка не работает.
it('R169 уведомления после записи и сброса изолируют исключение и уважают отписку', () => notify());
// Класс ошибки: отказ storage роняет интерфейс или теряет локальный снимок.
it('R169 отказ чтения записи и удаления storage не ломает настройку в памяти', () => {
  const f = load(source, undefined, true); assert.equal(f.getStageOrder('a', 2), null);
  assert.doesNotThrow(() => f.saveStageOrder('a', 2, ['x'])); assert.deepEqual(f.getStageOrder('a', 2), ['x']);
  assert.doesNotThrow(() => f.resetStageOrder('a')); assert.equal(f.hasStageOrder('a'), false);
});
async function reactive(raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let f!: ReturnType<typeof load>;
  function Probe() { const has = f.useHasStageOrder('a'); const order = f.useStageOrder('a', 2); return React.createElement('output', null, `${has}:${order?.join(',') ?? 'null'}`); }
  try {
    f = load(raw);
    await React.act(async () => root.render(React.createElement(Probe))); assert.equal(host.textContent, 'false:null');
    await React.act(async () => f.saveStageOrder('a', 2, ['b', 'a'])); assert.equal(host.textContent, 'true:b,a');
    const before = f.getStageOrder('a', 2); assert.equal(f.getStageOrder('a', 2) === before, true);
    await React.act(async () => f.resetStageOrder('a')); assert.equal(host.textContent, 'false:null');
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally {
      host.remove();
      try { await GlobalRegistrator.unregister(); }
      finally {
        if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      }
    }
  }
}
// Класс ошибки: useSyncExternalStore не перерисовывает меню после reset.
it('R169 настоящие React хуки обновляют порядок и наличие раскладки после save и reset', () => reactive());
// Класс ошибки: отсутствие уведомлений незаметно оставляет устаревший UI.
it('R169 мутант без уведомлений обнаруживается React снимком', async () => {
  const anchor = 'for (const fn of listeners) {'; assert.equal(source.split(anchor).length - 1, 1);
  await reactive(); await assert.rejects(() => reactive(source.replace(anchor, 'for (const fn of []) {')), assert.AssertionError);
});
// Класс ошибки: ключ без колонок смешивает раскладки разных ширин.
it('R169 мутант чтения без числа колонок обнаруживается разными раскладками', () => {
  const anchor = 'current[channelId]?.cols[String(cols)]'; assert.equal(source.split(anchor).length - 1, 1);
  channels(); assert.throws(() => channels(source.replace(anchor, 'current[channelId]?.cols["2"]')), assert.AssertionError);
});
