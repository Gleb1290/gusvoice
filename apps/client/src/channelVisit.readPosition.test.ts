import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, after, it } from 'node:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { createStore } from 'zustand/vanilla';
import ts from 'typescript';
import type { ConvMessage, ConvSummary, ConvSyncResponse } from '@gusvoice/shared';
import { createConvActions, type ConvHost, type ConvDeps } from './convStore';
import { emptyConvState } from './convSyncRules';

before(() => { GlobalRegistrator.register(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(() => { GlobalRegistrator.unregister(); });
const sum = (key: number): ConvSummary => ({ id: 'c', kind: 'direct', otherUser: null,
  createdAt: '2026-11-08T00:00:00Z', lastMessageAt: null, lastMessage: { id: 'tail', sortKey: 100, authorId: 'peer', text: '', attachments: 0, createdAt: '2026-11-08T00:00:00Z' },
  lastReadKey: key, unread: key < 100 ? 90 : 0 });
const message: ConvMessage = { id: 'history', channelId: 'c', conversationId: 'c', sortKey: 1, clientId: null,
  content: '', author: { id: 'peer', username: 'peer', displayName: 'Peer', avatarUrl: null },
  createdAt: '2026-11-08T00:00:00Z', editedAt: null, replyTo: null, attachments: [], reactions: [] };
const source = ts.transpileModule(readFileSync(new URL('./channelVisit.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
async function mounted() {
  let finish!: (r: ConvSyncResponse) => void;
  const pending = new Promise<ConvSyncResponse>((r) => { finish = r; });
  const reads: number[] = []; const marks: number[] = [];
  const noop = () => {};
  type Host = ConvHost & { instanceEpoch: number; convCacheKey: string; readDmNow: (id: string) => void;
    readChannelNow: () => void; convEnsureList: () => Promise<void>; convKeepPosition: (id: string) => void };
  const store = createStore<Host>(() => ({ conv: { ...emptyConvState(), pts: 0, phase: 'idle', summaries: { c: sum(10) } },
    convActive: true, instanceEpoch: 1, convCacheKey: 'instance-a|me', currentDmId: 'c', view: 'dm', mobilePane: 'content',
    dmMessages: { c: [message] }, dms: [], unreadDms: ['c'], historyFailed: [], drafts: {}, outbox: {},
    readDmNow: noop, readChannelNow: noop, convEnsureList: async () => {}, convKeepPosition: noop,
  }));
  const noIO = async (): Promise<never> => { throw new Error('неожиданный IO'); };
  const api: ConvDeps['api'] = { convSync: () => pending, convHistory: noIO, convList: noIO,
    convDirect: noIO, convSend: noIO, convUpload: noIO, convRead: async (_id, key) => { reads.push(key); return { lastReadKey: key }; } };
  const actions = createConvActions((patch) => store.setState(patch), store.getState, { api, now: () => 1000,
    setTimeout: () => 1, clearTimeout: noop, onOnline: noop, isMobile: () => true, readByView: () => true,
    windowed: () => true, markChannelSeen: noop });
  store.setState({ convEnsureList: actions.convEnsureList, convKeepPosition: actions.convKeepPosition, readDmNow: actions.convReadNow });
  const useStore = Object.assign((select: (s: Host) => unknown) => React.useSyncExternalStore(store.subscribe, () => select(store.getState())),
    { getState: store.getState, subscribe: store.subscribe });
  const module = { exports: {} as typeof import('./channelVisit') };
  const deps: Record<string, unknown> = { react: React, './store': { useStore },
    './channelPrefs': { lastSeenAt: () => null, markChannelSeen: () => marks.push(store.getState().instanceEpoch) },
    './hotkeys': { isMobile: () => true }, './notifications': { windowFocused: () => true } };
  runInNewContext(source, { module, exports: module.exports, window, document, require: (id: string) => {
    assert.ok(Object.hasOwn(deps, id), id); return deps[id];
  } });
  let latest!: ReturnType<typeof module.exports.useChannelVisit>;
  function Viewer() { latest = module.exports.useChannelVisit('c', 'dm'); return React.createElement('div', { className: 'messages' }); }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await React.act(async () => { root.render(React.createElement(Viewer)); });
  return { store, actions, reads, marks, current: () => latest, host,
    finish: async () => { await React.act(async () => { finish({ reset: false, pts: 1, more: false, conversations: [sum(100)], messages: [] }); }); },
    close: () => { React.act(() => root.unmount()); host.remove(); } };
}

it('визит ждёт актуальное прочитанное, а настоящий readByView не читает невидимый кешированный хвост', async () => {
  const f = await mounted();
  try {
    assert.equal(f.current().started, false); assert.equal(f.current().readKey, 10);
    assert.deepEqual(f.reads, []);
    const initial = f.current().visitKey; await f.finish();
    assert.equal(f.current().started, true); assert.equal(f.current().readKey, 100);
    assert.notEqual(f.current().visitKey, initial); assert.deepEqual(f.reads, []);
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
      await React.act(async () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const next = { ...sum(110), lastMessage: { ...sum(110).lastMessage!, id: 'remote-tail', sortKey: 110 } };
      f.store.setState({ conv: { ...f.store.getState().conv, phase: 'live', summaries: { c: next } } });
      await React.act(async () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      assert.equal(f.current().readKey, 110, 'возобновление приложения переснимает cursor, даже если компонент не размонтировался');
      assert.deepEqual(f.reads, []);
    } finally {
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
      else Reflect.deleteProperty(document, 'visibilityState');
    }
  } finally { f.close(); }
});

it('догонка не перебивает ручную историю или явную цитату, а действие вне ленты не мешает открытию', async () => {
  for (const mode of ['outside', 'history', 'jump']) {
    const f = await mounted();
    try {
      const initial = f.current().visitKey;
      await React.act(async () => {
        if (mode === 'jump') await f.actions.convJumpTo('c', 'history');
        else (mode === 'history' ? f.host.querySelector('.messages')! : document.body)
          .dispatchEvent(new Event(mode === 'history' ? 'wheel' : 'pointerdown', { bubbles: true }));
      });
      await f.finish();
      assert.equal(f.current().readKey, mode === 'outside' ? 100 : 10);
      assert.equal(f.current().visitKey === initial, mode !== 'outside');
      const active = f.current();
      await React.act(async () => { f.store.setState({ conv: { ...f.store.getState().conv, summaries: { c: sum(100) } } }); });
      assert.equal(f.current().readKey, active.readKey); assert.equal(f.current().visitKey, active.visitKey);
      assert.deepEqual(f.reads, []);
    } finally { f.close(); }
  }
});

it('cleanup и поздняя догонка старого визита не пишут прочитанное одноимённой беседе другого инстанса', async () => {
  const f = await mounted();
  try {
    await React.act(async () => {
      f.actions.convReset();
      f.store.setState({ instanceEpoch: 2, convCacheKey: 'instance-b|me',
        conv: { ...emptyConvState(), phase: 'live', summaries: { c: sum(2) } } });
    });
    assert.deepEqual(f.marks, [], 'cleanup старого инстанса не пишет в текущий registry');
    assert.equal(f.current().readKey, 2);
    await f.finish();
    assert.equal(f.current().readKey, 2); assert.deepEqual(f.reads, []); assert.deepEqual(f.marks, []);
  } finally { f.close(); }
});
