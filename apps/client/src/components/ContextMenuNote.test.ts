import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import * as sync from '../convSyncRules';
import * as list from '../dmListRules';
import { testVmImports } from '../testVmImports';

let menu: typeof import('./ContextMenu');
let priorAct: PropertyDescriptor | undefined;
before(() => {
  priorAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  GlobalRegistrator.register({ settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  menu = load<typeof import('./ContextMenu')>('./ContextMenu.tsx', { './Icon': { Icon: () => null } });
});
after(async () => {
  try { await GlobalRegistrator.unregister(); }
  finally {
    if (priorAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', priorAct);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

function load<T>(file: string, mocks: Record<string, unknown> = {}): T {
  const source = new URL(file, import.meta.url);
  const module = { exports: {} };
  // Целый продуктовый модуль: ни вырезания JSX, ни запасного исполнения зависимостей.
  runInNewContext(ts.transpileModule(readFileSync(source, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, {
    module, exports: module.exports, window, document, Date,
    require: testVmImports(source, { react: React, 'react/jsx-runtime': jsx, ...mocks }),
  });
  return module.exports as T;
}

async function scene(check: (host: HTMLDivElement, render: (node: React.ReactNode) => Promise<void>) => Promise<void>) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try { await check(host, async node => { await React.act(async () => root.render(node)); }); }
  finally { await React.act(async () => root.unmount()); host.remove(); }
}

it('справка и клавиатурная подсказка сохраняют текст и различаются при смене пункта', async () => {
  await scene(async (host, render) => {
    await render(React.createElement(menu.MenuItem, { label: 'Уведомления', shortcut: '3 ч', note: true }));
    assert.equal(host.querySelector('.ctx-note')?.textContent, '3 ч');
    await render(React.createElement(menu.MenuItem, { label: 'Ответить', shortcut: 'R' }));
    assert.equal(host.querySelector('.ctx-shortcut')?.textContent, 'R');
    assert.equal(host.querySelector('.ctx-note'), null);
    await render(React.createElement(menu.MenuItem, { label: 'Уведомления', note: true }));
    assert.equal(host.querySelector('.ctx-shortcut'), null, 'без текста пустая справка не появляется');
    assert.equal(host.querySelector('[role="menuitem"]')?.textContent, 'Уведомления');
  });
});

it('в телефонном листе срок остаётся видимым, клавиша скрыта; на ПК видны оба', async () => {
  const style = document.createElement('style');
  // Полный stylesheet, без поиска селекторов и пинов на конкретные CSS-декларации.
  style.textContent = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  document.head.append(style);
  try {
    // Отдельный DOM на каждый замер: HappyDOM кэширует computed style предков.
    for (const sheet of [false, true]) for (const note of [false, true]) await scene(async (host, render) => {
      host.className = sheet ? 'ctx-menu sheet' : 'ctx-menu';
      const text = note ? '3 ч' : 'R';
      await render(React.createElement(menu.MenuItem, { label: 'Пункт', shortcut: text, note }));
      const hint = host.querySelector('.ctx-shortcut');
      assert.ok(hint);
      assert.equal(hint.textContent, text);
      const display = getComputedStyle(hint).display;
      if (sheet) assert.ok(display, 'DOM-фикстура вычислила display подсказки листа');
      assert.equal(display === 'none', sheet && !note);
    });
  } finally { style.remove(); }
});

it('меню уведомлений показывает остаток конечной заглушки и убирает его для бессрочной', async () => {
  const state = { serverFeatures: ['conv13'] };
  const chat = load<typeof import('./DmChatView')>('./DmChatView.tsx', {
    './ContextMenu': menu, './Icon': { Icon: () => null },
    '../store': { useStore: (select: (s: typeof state) => unknown) => select(state) },
    '../convSyncRules': sync, '../dmListRules': list,
  });
  const now = Date.UTC(2026, 9, 31);
  await scene(async (host, render) => {
    for (const until of [new Date(now + 3 * 3_600_000).toISOString(), null]) {
      await render(React.createElement(chat.DmMuteMenuItems, { peerId: 'peer', mute: { until }, now, onDone() {} }));
      assert.equal(host.querySelector('.ctx-label-main')?.textContent, 'Включить уведомления');
      assert.equal(host.querySelector('.ctx-note')?.textContent ?? null, until ? '3 ч' : null);
    }
  });
});

it('меню строки беседы показывает конечный срок как справку, а бессрочный — без срока', async () => {
  const state = {
    convActive: true, serverFeatures: ['conv11', 'conv13'], blockedUsers: [], pushMutedDmUsers: [], pushMuteUntil: {},
    user: { notifyDm: true, notifyGroups: true }, pushAlwaysTargets: [],
    dms: [{ id: 'conversation', otherUser: { id: 'peer' }, muted: { until: null as string | null } }],
    conv: { summaries: {} },
  };
  const row = load<typeof import('./DmRowMenu')>('./DmRowMenu.tsx', {
    './ContextMenu': { ...menu, ContextMenu: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children) },
    './Icon': { Icon: () => null }, '../convSyncRules': sync, '../dmListRules': list,
    '../notifyExceptionsRules': { notifyAlwaysAction: () => null },
    '../store': { useStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) },
    './DmFolderBar': { useFoldersOn: () => false },
  });
  let open: ReturnType<typeof row.useDmRowMenu>['openDmMenu'];
  function Row() { const value = row.useDmRowMenu(); open = value.openDmMenu; return value.menu; }
  await scene(async (host, render) => {
    await render(React.createElement(Row));
    for (const until of [new Date(Date.now() + 3 * 3_600_000).toISOString(), null]) {
      state.dms[0].muted.until = until;
      await React.act(async () => open(state.dms[0] as Parameters<typeof open>[0], { x: 10, y: 20 }));
      const item = [...host.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.startsWith('Включить уведомления'));
      assert.ok(item);
      assert.equal(item.querySelector('.ctx-note')?.textContent ?? null, until ? '3 ч' : null);
    }
  });
});
