import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, after, it } from 'node:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { createStore } from 'zustand/vanilla';
import ts from 'typescript';

before(() => { GlobalRegistrator.register(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(() => { GlobalRegistrator.unregister(); });

it('без сводки визит ЛС не начат, первая сводка даёт настоящий ключ и новый номер визита', async () => {
  // Перезапуск сразу в беседу раньше списка иначе отмечал невидимый хвост прочитанным.
  const store = createStore(() => ({ mobilePane: 'content', readChannelNow: () => {}, readDmNow: () => {}, conv: { summaries: {} as Record<string, { lastReadKey: number }> } }));
  const useStore = Object.assign((select: (s: ReturnType<typeof store.getState>) => unknown) => React.useSyncExternalStore(store.subscribe, () => select(store.getState())), { getState: store.getState, subscribe: store.subscribe });
  const module = { exports: {} as typeof import('./channelVisit') };
  const code = ts.transpileModule(readFileSync(new URL('./channelVisit.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const deps: Record<string, unknown> = { react: React, './store': { useStore }, './channelPrefs': { lastSeenAt: () => null, markChannelSeen: () => {} }, './hotkeys': { isMobile: () => false }, './notifications': { windowFocused: () => true } };
  runInNewContext(code, { module, exports: module.exports, window, document, require: (id: string) => { assert.ok(Object.hasOwn(deps, id), id); return deps[id]; } });
  let latest: ReturnType<typeof module.exports.useChannelVisit> | undefined;
  function Viewer({ id }: { id: string }) { latest = module.exports.useChannelVisit(id, 'dm'); return null; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const current = () => { assert.ok(latest, 'настоящий hook отрисован'); return latest; };
  try {
    await React.act(async () => { root.render(React.createElement(Viewer, { id: 'c' })); });
    assert.equal(current().started, false); assert.equal(current().readKey, null);
    const unknownVisit = current().visitKey;
    await React.act(async () => { store.setState({ conv: { summaries: { c: { lastReadKey: 9 } } } }); });
    assert.equal(current().started, true); assert.equal(current().readKey, 9); assert.notEqual(current().visitKey, unknownVisit);
    const knownVisit = current().visitKey;
    await React.act(async () => { store.setState({ conv: { summaries: { c: { lastReadKey: 12 } } } }); });
    assert.equal(current().visitKey, knownVisit); assert.equal(current().readKey, 9, 'метка остаётся снимком начала, не текущей сводкой');
    await React.act(async () => { root.render(React.createElement(Viewer, { id: 'other' })); });
    assert.equal(current().started, false); assert.equal(current().readKey, null);
    await React.act(async () => { store.setState({ conv: { summaries: { other: { lastReadKey: 2 } } } }); });
    assert.equal(current().started, true); assert.equal(current().readKey, 2);
  } finally { React.act(() => root.unmount()); host.remove(); }
});
