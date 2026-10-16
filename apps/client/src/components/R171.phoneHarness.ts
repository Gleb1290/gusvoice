import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as ReactDom from 'react-dom';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

export { React };
export const sourceOf = (name: string) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
export const noop = () => {};
export const icon = ({ name }: { name: string }) => React.createElement('i', { 'data-icon': name });
export function load<T>(source: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module, exports: module.exports, document, window, navigator, URL, performance, console,
    ...globals, require: (id: string) => ({ react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDom,
      ...dependencies } as Record<string, unknown>)[id] ?? new Proxy({}, { get: (_t, key) => {
      throw new Error(`Неописанная граница ${id}.${String(key)}`);
    } }) });
  return module.exports as T;
}
export async function environment(check: (host: HTMLDivElement, render: (element: React.ReactNode) => Promise<void>) => Promise<void>) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await check(host, async element => { await React.act(async () => { root.render(element); for (let i = 0; i < 5; i++) await Promise.resolve(); }); });
  } finally {
    await React.act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister();
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}
export async function click(host: ParentNode, selector: string) {
  const el = host.querySelector<HTMLButtonElement>(selector); assert.ok(!!el, selector);
  await React.act(async () => el.click());
}
export function reactProps(el: Element): Record<string, any> {
  const key = Object.keys(el).find(k => k.startsWith('__reactProps$')); assert.ok(key, 'обработчики настоящего смонтированного React DOM');
  return (el as unknown as Record<string, Record<string, any>>)[key];
}
export function mutate(source: string, anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'единственный точный якорь'); return source.replace(anchor, replacement);
}
