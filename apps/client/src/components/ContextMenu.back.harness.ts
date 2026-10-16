import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createPortal } from 'react-dom';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as popover from '../popover';
import * as big from '../bigReaction';

export const menuSource = readFileSync(new URL('./ContextMenu.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
export function loadMenu(raw = menuSource): typeof import('./ContextMenu') {
  const deps: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsx, 'react-dom': { createPortal },
    '../popover': popover, '../bigReaction': big, '../imageViewer': { useImageViewerOpen: () => false },
    './Icon': { Icon: () => null }, './StatusDot': { StatusDot: () => null } };
  // HappyDOM не рассчитывает layout: observer не генерирует геометрию; здесь проверяются события и DOM, не расположение меню.
  class NoResize { observe() {} disconnect() {} }
  const module = { exports: {} as typeof import('./ContextMenu') };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, window, document, Element, Node, Event, MouseEvent, KeyboardEvent, ResizeObserver: NoResize,
      require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `неописанная граница меню ${id}`); return deps[id]; } });
  return module.exports;
}
export async function withMenuDom(width: number, check: (host: HTMLDivElement, root: import('react-dom/client').Root) => Promise<void>) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  const match = window.matchMedia;
  window.matchMedia = (query: string) => ({ matches: query === '(max-width: 620px)' && width <= 620, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }) as MediaQueryList;
  const { createRoot } = await import('react-dom/client'); const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try { await check(host, root); }
  finally {
    try { await React.act(async () => root.unmount()); }
    finally { host.remove(); window.matchMedia = match; await GlobalRegistrator.unregister();
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); }
  }
}
export async function escapeMenu() { await React.act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); }
export function replaceMenu(anchor: string, replacement: string) {
  assert.equal(menuSource.split(anchor).length - 1, 1, 'якорь меню уникален'); return menuSource.replace(anchor, replacement);
}
