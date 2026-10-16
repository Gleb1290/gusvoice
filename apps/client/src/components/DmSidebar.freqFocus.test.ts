import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, after, it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as lists from '../dmListRules';
import * as sync from '../convSyncRules';
import * as search from '../dmListSearchRules';
import * as folders from '../dmFolderView';
import * as dmRules from '../dmRules';

const source = readFileSync(new URL('./DmSidebar.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let createRoot: typeof import('react-dom/client')['createRoot'];
const actDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
before(async () => {
  GlobalRegistrator.register(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  createRoot = (await import('react-dom/client')).createRoot;
});
after(async () => { await GlobalRegistrator.unregister();
  if (actDescriptor) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actDescriptor);
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); });

async function scene(phone: boolean, raw = source, alreadyFocused = false) {
  const nil = () => null, noop = () => {};
  const dms = [{ id: 'dm', createdAt: '2026-10-09T00:00:00Z', lastMessageAt: null,
    otherUser: { id: 'peer', username: 'peer', displayName: 'Беседа', avatarUrl: null } }];
  const state = { dms, currentDmId: null, mobilePane: 'channels', view: 'dm', unreadDms: [], voice: null,
    user: { id: 'self' }, convActive: true, conv: { ...sync.emptyConvState(), phase: 'live', pts: 1 },
    serverFeatures: ['conv1', 'conv2', 'gsearch1', 'freq1'], drafts: {}, outbox: {}, pushMutedDmUsers: [], pushMuteUntil: {},
    blockedUsers: [], loadDms: async () => {}, selectDm: async () => {} };
  const useStore = Object.assign((pick: (s: typeof state) => unknown) => pick(state), { getState: () => state });
  let menu: ((open: boolean) => void) | undefined;
  const deps: Record<string, unknown> = {
    // Строки бесед вне контракта поиска изолированы на границе memo; состояние/refs/эффекты самого Sidebar настоящие.
    react: { ...React, memo: () => nil }, 'react/jsx-runtime': jsx,
    '../store': { useStore }, '../hotkeys': { isMobile: () => phone, isTauri: () => false },
    '../phoneLayout': { usePhoneLayout: () => phone }, '../peerName': { usePeerName: () => (_id: string, name: string) => name },
    '../dmListRules': lists, '../convSyncRules': sync, '../dmListSearchRules': search, '../dmFolderView': folders, '../dmRules': dmRules,
    '../dmCompose': { useDmCompose: () => ({ open: false }), closeDmCompose: noop },
    '../dmFolders': { useDmFolders: (pick: (s: { activeId: null }) => unknown) => pick({ activeId: null }) },
    '../dmOnline': { useVisibleOnline: () => new Set() }, '../voiceDrafts': { useVoiceDraftKeys: () => new Map() },
    '../connState': { useConnState: () => 'online', connLabel: () => null },
    '../uiPrefs': { useSidebarNarrow: () => false, setNarrowAllowed: noop }, '../dmListView': { useListLines: () => 'two' },
    '../androidBack': { pushBackHandler: () => noop }, './DmPinDrag': { useDmPinDrag: noop },
    './DmArchive': { useArchiveCollapsed: () => [false, noop] },
    './DmRowMenu': { useDmRowMenu: () => ({ openDmMenu: noop, menu: null }), useDmListMenu: () => ({ openListMenu: noop, menu: null }) },
    './DmFolderBar': { useDmFolderUi: () => ({ on: false, home: true, ownPins: null, bar: null }) },
    './DmListSwipe': { useSwipeCaps: () => ({}), useSwipeSetting: () => ['auto'], useDmListSwipe: () => ({ bind: {}, overlay: null }) },
    '../chatSwipe': { effectiveSwipe: () => null },
    './DmListSearch': {
      useRecentSearches: () => ({ recents: [], remove: noop, clear: noop, push: noop }),
      useFrequentHidden: () => ({ hidden: {}, hide: noop }), useFrequent: () => [],
      // Меню как внешняя подсистема: проверяем реальные callbacks родителя, не повторяем реализацию DmSearchHome.
      DmSearchHome: (p: { onMenuOpen: (open: boolean) => void }) => { menu = p.onMenuOpen; return React.createElement('div', { 'data-search-home': true }); },
      DmSearchChips: nil, DmMessageHits: nil,
    },
    './DmAllSearch': { DmSearchTabs: nil, DmKindHits: nil, AllMessageHits: nil },
    './SettingsShell': { SettingsSearch: (p: { inputRef: React.Ref<HTMLInputElement> } & React.InputHTMLAttributes<HTMLInputElement>) => {
      const { inputRef, ...rest } = p; return React.createElement('input', { ...rest, ref: inputRef });
    } },
    './Icon': { Icon: nil }, './GroupDialogs': { GroupDialogHost: nil }, './SharedMedia': { SharedMediaHost: nil },
    './SelfVoiceBar': { SelfVoiceBar: nil },
  };
  const tree = ts.createSourceFile('DmSidebar.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Set(tree.statements.filter(ts.isImportDeclaration).map(n => (n.moduleSpecifier as ts.StringLiteral).text));
  const module = { exports: {} };
  // Весь модуль, без извлечения onFindBlur/onFreqMenu и без eval фрагментов.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
  { module, exports: module.exports, window, document, Date,
    require: (id: string) => { assert.ok(imports.has(id) || id === 'react/jsx-runtime', id); return deps[id] ?? {}; } });
  const Sidebar = (module.exports as { DmSidebar: React.ComponentType }).DmSidebar;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Sidebar)));
    const field = host.querySelector('input'); assert.equal(!!field, true);
    await React.act(async () => field!.focus()); assert.equal(!!host.querySelector('[data-search-home]'), true);
    assert.equal(typeof menu, 'function');
    const nativeFocus = field!.focus.bind(field); let restored = 0;
    field!.focus = (options?: FocusOptions) => { restored++; assert.deepEqual({ ...options }, { preventScroll: true }); nativeFocus(options); };
    await React.act(async () => menu!(true));
    if (!alreadyFocused) {
      await React.act(async () => field!.blur());
      assert.equal(!!host.querySelector('[data-search-home]'), true, 'меню удерживает панель поиска после blur');
      assert.equal(document.activeElement !== field, true);
    }
    await React.act(async () => menu!(false));
    assert.equal(document.activeElement === field, true, 'закрытие меню возвращает фокус в поле');
    assert.equal(restored, alreadyFocused ? 0 : 1, 'лишний focus не вызывает повторную прокрутку');
    await React.act(async () => field!.blur());
    assert.equal(host.querySelector('[data-search-home]') === null, true, 'без меню обычный blur закрывает поиск');
  } finally { await React.act(async () => root.unmount()); host.remove(); }
}

for (const phone of [true, false]) {
  it(`R133 ${phone ? 'телефон' : 'ПК'}: меню частых держит поиск при blur и возвращает фокус после закрытия`, async () => {
    // Парные сценарии отличают удержание меню от обычного ухода из поиска.
    await scene(phone);
  });
}
it('R133 закрытие меню при уже активном поле не вызывает повторный focus', async () => {
  // Повторный focus с побочной прокруткой не нужен, если меню не увело поле.
  await scene(true, source, true);
});
it('R133 безусловный onBlur вместо onFindBlur закрывает панель под меню и отвергается', async () => {
  // Контрфакт меняет настоящую JSX-проводку обеих платформ, а не копию callback в тесте.
  await scene(true); await scene(false);
  const mutant = source.replaceAll('onBlur={onFindBlur}', 'onBlur={() => setFindFocused(false)}');
  assert.notEqual(mutant, source);
  for (const phone of [true, false]) await assert.rejects(scene(phone, mutant),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('меню удерживает панель поиска'));
});
