import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import * as rules from '../chatSearchRules';
import type { ChatSearchCtl, ChatSearchSource } from './ChatSearch';

const source = readFileSync(new URL('./ChatSearch.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const backSource = readFileSync(new URL('../androidBack.ts', import.meta.url), 'utf8');
function mutate(from: string, to: string): string {
  assert.equal(source.split(from).length - 1, 1, 'мутация меняет ровно один якорь целого модуля');
  return source.replace(from, to);
}
type State = { mobilePane: string; adminOpen: boolean; settingsOpen: boolean; mobileProfileOpen: boolean; mobileMembersOpen: boolean };
type Fixture = {
  ctl(): ChatSearchCtl; pane(): string; settings(): boolean;
  open(): Promise<void>; query(value: string): Promise<void>; patch(value: Partial<State>): Promise<void>;
  back(): Promise<boolean>; unmount(): Promise<void>; listeners(): number; handlers(): number; exit(): boolean;
};
async function fixture(check: (f: Fixture) => Promise<void>, raw = source): Promise<void> {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  let ctl!: ChatSearchCtl;
  let setOpen!: (value: boolean) => void;
  let handlerCount = 0;
  let state: State = { mobilePane: 'content', adminOpen: false, settingsOpen: false, mobileProfileOpen: false, mobileMembersOpen: false };
  const listeners = new Set<(next: State, prev: State) => void>();
  const patch = (value: Partial<State>) => {
    const prev = state; state = { ...state, ...value };
    for (const fn of [...listeners]) fn(state, prev);
  };
  const store = { getState: () => ({ ...state,
    setMobilePane: (mobilePane: string) => patch({ mobilePane }),
    setSettingsOpen: (settingsOpen: boolean) => patch({ settingsOpen }),
    setAdminOpen: (adminOpen: boolean) => patch({ adminOpen }),
    setMobileProfileOpen: (mobileProfileOpen: boolean) => patch({ mobileProfileOpen }),
    setMobileMembersOpen: (mobileMembersOpen: boolean) => patch({ mobileMembersOpen }),
  }), subscribe: (fn: (next: State, prev: State) => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
  function load<T>(text: string, deps: Record<string, unknown>): T {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(text, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText, { module, exports: module.exports, window, document, HTMLElement, KeyboardEvent,
      requestAnimationFrame: () => 0, require(id: string) {
        assert.ok(Object.hasOwn(deps, id), `неожиданный импорт ${id}`); return deps[id];
      } });
    return module.exports as T;
  }
  try {
    // Настоящие оба модуля; подменены только стор, I/O и визуальные оболочки.
    const back = load<typeof import('../androidBack')>(backSource, {
      './hotkeys': { isAndroid: () => true }, './store': { useStore: store },
    });
    const chat = load<typeof import('./ChatSearch')>(raw, {
      react: React, 'react/jsx-runtime': jsx, '../chatSearchRules': rules,
      '../androidBack': { pushBackHandler: (fn: () => boolean) => {
        handlerCount++; const dispose = back.pushBackHandler(fn);
        return () => { handlerCount--; dispose(); };
      } },
      '../store': { useStore: store }, '../phoneLayout': { usePhoneLayout: () => true },
      '../dialogChrome': { useDialogChrome: () => React.useRef(null) },
      './BottomSheet': { BottomSheet: () => null }, './Icon': { Icon: () => null },
    });
    function Harness() {
      const [open, updateOpen] = React.useState(false); setOpen = updateOpen;
      const src: ChatSearchSource = { open, setOpen: updateOpen,
        search: async () => ({ hits: [], total: 0, next: null }), jumpToDate: async () => null };
      ctl = chat.useChatSearch(src, async () => {}, 'dm-one');
      return null;
    }
    await React.act(async () => root.render(React.createElement(Harness)));
    const unmount = async () => { if (mounted) { mounted = false; await React.act(async () => root.unmount()); } };
    await check({ ctl: () => ctl, pane: () => state.mobilePane, settings: () => state.settingsOpen,
      open: async () => { await React.act(async () => setOpen(true)); },
      query: async value => { await React.act(async () => ctl.setQuery(value)); },
      patch: async value => { await React.act(async () => patch(value)); },
      back: async () => { let result = false; await React.act(async () => { result = back.stepBack(); }); return result; },
      unmount, listeners: () => listeners.size, handlers: () => handlerCount, exit: () => chat.exitChatSearch(),
    });
  } finally {
    try { if (mounted) await React.act(async () => root.unmount()); }
    finally {
      host.remove(); await GlobalRegistrator.unregister();
      if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  }
}
async function closesSearch(raw = source) {
  await fixture(async f => {
    await f.open(); await f.query('гусь');
    assert.equal(await f.back(), true, 'назад обработана');
    assert.equal(f.ctl().open, false, 'системная назад закрывает поиск');
    assert.equal(f.ctl().query, '', 'закрытие очищает запрос');
    assert.equal(f.pane(), 'content', 'одна назад не уводит беседу в список');
    assert.equal(f.handlers(), 0); assert.equal(f.listeners(), 0);
    // Второе самостоятельное нажатие уже навигирует, а не попадает в старый перехватчик.
    assert.equal(await f.back(), true); assert.equal(f.pane(), 'list');
  }, raw);
}
async function leavesChat(raw = source) {
  await fixture(async f => {
    await f.open(); await f.query('старый запрос'); await f.patch({ mobilePane: 'list' });
    assert.equal(f.ctl().open, false, 'уход из content закрывает поиск');
    assert.equal(f.ctl().query, '', 'уход очищает запрос');
    assert.equal(f.listeners(), 0); assert.equal(f.handlers(), 0);
    await f.patch({ mobilePane: 'content' }); await f.open();
    assert.equal(f.ctl().query, '', 'новый вход не восстанавливает прежний запрос');
  }, raw);
}
it('R158 системная назад закрывает поиск, очищает запрос и оставляет беседу открытой', async () => closesSearch());
it('R158 уход content→list закрывает поиск и новый вход не сохраняет старый запрос', async () => leavesChat());
it('R158 поиск уступает назад настройкам поверх беседы и берёт следующее нажатие', async () => {
  await fixture(async f => {
    await f.open(); await f.query('гусь'); await f.patch({ settingsOpen: true });
    assert.equal(await f.back(), true); assert.equal(f.settings(), false);
    assert.equal(f.ctl().open, true, 'поиск под настройками остаётся открытым');
    assert.equal(f.ctl().query, 'гусь'); assert.equal(f.pane(), 'content');
    assert.equal(await f.back(), true); assert.equal(f.ctl().open, false); assert.equal(f.pane(), 'content');
  });
});
it('R158 закрытый поиск не регистрирует подписку и не перехватывает навигацию', async () => {
  await fixture(async f => {
    assert.equal(f.listeners(), 0); assert.equal(f.handlers(), 0); assert.equal(f.exit(), false);
    assert.equal(await f.back(), true); assert.equal(f.pane(), 'list');
  });
});
it('R158 размонтирование открытого поиска снимает подписку, перехватчик и выход шапки', async () => {
  await fixture(async f => {
    await f.open(); assert.equal(f.listeners(), 1); assert.equal(f.handlers(), 1);
    await f.unmount(); assert.equal(f.listeners(), 0); assert.equal(f.handlers(), 0); assert.equal(f.exit(), false);
    assert.equal(await f.back(), true); assert.equal(f.pane(), 'list');
  });
});
it('R158 контрфакт без регистрации назад уводит беседу вместо закрытия поиска', async () => {
  await closesSearch();
  await assert.rejects(closesSearch(mutate('const back = pushBackHandler(() => {', 'const back = ((_fn: () => boolean) => () => {})(() => {')),
    (error: unknown) => error instanceof assert.AssertionError && error.message.includes('одна назад не уводит беседу'));
});
it('R158 контрфакт без подписки сохраняет поиск после ухода к списку', async () => {
  await leavesChat();
  await assert.rejects(leavesChat(mutate('const unsub = useStore.subscribe((s, prev) => {', 'const unsub = ((_fn: (s: any, prev: any) => void) => () => {})((s, prev) => {')),
    (error: unknown) => error instanceof assert.AssertionError && error.message.includes('уход из content закрывает поиск'));
});
it('R158 контрфакт return false после закрытия делает два шага одной назад', async () => {
  await closesSearch();
  await assert.rejects(closesSearch(mutate('      close();\n      return true;\n    });', '      close();\n      return false;\n    });')),
    (error: unknown) => error instanceof assert.AssertionError && error.message.includes('одна назад не уводит беседу'));
});
