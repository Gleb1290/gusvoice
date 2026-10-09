import assert from 'node:assert/strict';
import { after, afterEach, before, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createServer, type ViteDevServer } from 'vite';
import { act, createElement, Fragment, type ComponentType } from 'react';
import type { Root } from 'react-dom/client';
import { feedNavKey, feedNavTarget } from '../feedNavRules';

type MenuModule = typeof import('./UserContextMenu');
type UserMenuTarget = import('./UserContextMenu').UserMenuTarget;
type Store = typeof import('../store').useStore;

let server: ViteDevServer;
let createRoot: typeof import('react-dom/client').createRoot;
let store: Store;
let initial: ReturnType<Store['getState']>;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let cacheDir = '';

const wait = () => new Promise<void>(resolve => setImmediate(resolve));
async function flush(render?: () => void) {
  await act(async () => { render?.(); await wait(); });
}
async function mount(component: ComponentType) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await flush(() => root!.render(createElement(component)));
  await flush();
}
async function unmount() {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined; host?.remove(); host = undefined;
}

function makeProfileProbe(useUserMenu: MenuModule['useUserMenu'], target: UserMenuTarget): ComponentType {
  return function ProfileProbe() {
    const { openAt, menu } = useUserMenu();
    return createElement(Fragment, null,
      createElement('button', { type: 'button', onClick: () => openAt({ x: 123, y: 234 }, target, 'profile') }, 'Открыть профиль'),
      menu,
    );
  };
}

async function openProfile(module: MenuModule, rosterUser?: { id: string; username: string; displayName: string; avatarUrl: null }) {
  store.setState({
    ...initial,
    user: { id: 'self', username: 'self', displayName: 'Я', avatarUrl: null } as never,
    members: rosterUser ? [{ user: rosterUser, roleIds: [], joinedAt: null }] as never : [],
    bootstrap: null,
    onlineUsers: [],
    userStatuses: {},
  } as never, true);
  const target: UserMenuTarget = {
    userId: 'peer', name: 'Собеседник', avatarUrl: null, username: 'dm-login',
  };
  await mount(makeProfileProbe(module.useUserMenu, target));
}

before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => new Response(null, { status: 503 }),
    WebSocket: class ClosedSocket { static OPEN = 1; readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} },
  });
  createRoot = (await import('react-dom/client')).createRoot;
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1024 });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 768 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.classList.contains('ctx-menu') ? 320 : 100; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.classList.contains('ctx-menu') ? 280 : 20; } });
  cacheDir = mkdtempSync(join(tmpdir(), 'gusvoice-round24-menu-'));
  server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    envFile: false,
    cacheDir,
    optimizeDeps: { noDiscovery: true, include: [] },
    esbuild: { jsx: 'automatic' },
    plugins: [{
      name: 'round24-user-menu-fallback-mutant',
      enforce: 'pre',
      transform(source, id) {
        if (!id.replaceAll('\\', '/').includes('/components/UserContextMenu.tsx?codex-no-target-username')) return;
        const from = 'const username = member?.user.username ?? (isSelf ? me?.username : undefined) ?? target.username;';
        assert.ok(source.includes(from), 'fallback mutant anchors the actual roster→self→target chain');
        return source.replace(from, from.replace('?? target.username', '?? undefined'));
      },
    }],
    resolve: { alias: { '@gusvoice/shared': fileURLToPath(new URL('../../../../packages/shared/src/index.ts', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    appType: 'custom',
    logLevel: 'error',
  });
  store = (await server.ssrLoadModule('/src/store.ts')).useStore;
  initial = store.getState();
});

afterEach(async () => {
  await unmount();
  if (store && initial) store.setState(initial, true);
  document.querySelectorAll('[aria-modal="true"]').forEach(node => node.remove());
  document.querySelectorAll('.ctx-menu,.ctx-sheet-backdrop').forEach(node => node.remove());
});

after(async () => {
  await unmount();
  await server?.close();
  GlobalRegistrator.unregister();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

it('Alt+↑/↓ и Ctrl+Alt+Home/End исполняют реальный MainLayout handler и не зацикливают список', async () => {
  // В ЛС поле ввода не должно глушить глобальные клавиши, но список должен оставаться ограниченным.
  const source = readFileSync(fileURLToPath(new URL('./MainLayout.tsx', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('const onKey = (e: KeyboardEvent) => {');
  const end = source.indexOf('\n    window.addEventListener(\'keydown\', onKey);', start);
  assert.ok(start >= 0 && end > start, 'из исходника найден зарегистрированный onKey MainLayout');
  const handler = source.slice(start, end).trim();
  const module = { exports: {} as Record<string, unknown> };
  const compiled = `module.exports = (useStore, document, setBenchOpen, toggleCheatSheet, orderedTextChannels) => { ${handler}; return onKey; };`;
  const { runInNewContext } = await import('node:vm');
  const ts = await import('typescript');
  runInNewContext(ts.transpileModule(compiled, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports, feedNavKey, feedNavTarget });

  const selected: string[] = [];
  const state = {
    view: 'dm', dms: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], currentDmId: 'b', bootstrap: null,
    selectDm: async (id: string) => { selected.push(id); state.currentDmId = id; },
  };
  const useStore = { getState: () => state };
  const onKey = (module.exports as unknown as (store: typeof useStore, doc: Document, ...rest: unknown[]) => (e: KeyboardEvent) => void)(useStore, document, () => {}, () => {}, () => []);
  window.addEventListener('keydown', onKey);
  const input = document.createElement('textarea'); document.body.append(input);
  const press = (code: string, opts: { altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code, key: code.replace('Arrow', '') , ...opts });
    input.dispatchEvent(event);
    return event;
  };
  try {
    assert.equal(press('ArrowUp', { altKey: true }).defaultPrevented, true, 'Alt+↑ handled while textarea owns focus');
    assert.deepEqual(selected, ['a'], 'from second conversation, up selects the first');
    state.currentDmId = 'a';
    assert.equal(press('ArrowUp', { altKey: true }).defaultPrevented, true, 'boundary remains handled');
    assert.deepEqual(selected, ['a'], 'first conversation does not wrap to the last');
    state.currentDmId = 'b';
    press('ArrowDown', { altKey: true });
    press('Home', { altKey: true, ctrlKey: true });
    press('End', { altKey: true, ctrlKey: true });
    assert.deepEqual(selected, ['a', 'c', 'a', 'c'], 'down and absolute first/last select expected conversations');
    state.view = 'server';
    const channelView = press('ArrowUp', { altKey: true });
    assert.equal(channelView.defaultPrevented, false, 'DM shortcut does not consume channel navigation');
    state.view = 'dm'; state.dms = [];
    assert.equal(press('End', { altKey: true, ctrlKey: true }).defaultPrevented, false, 'empty list is ignored');
    state.dms = [{ id: 'a' }, { id: 'b' }];
    const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal);
    assert.equal(press('End', { altKey: true, ctrlKey: true }).defaultPrevented, false, 'modal owns keyboard while open');
    assert.deepEqual(selected, ['a', 'c', 'a', 'c'], 'modal does not change conversation');
    modal.remove();
    assert.equal(press('ArrowUp', { altKey: true, shiftKey: true }).defaultPrevented, false, 'shifted variant is not captured');
    assert.equal(press('ArrowUp', { altKey: true, metaKey: true }).defaultPrevented, false, 'Meta variant is not captured');
  } finally { window.removeEventListener('keydown', onKey); input.remove(); }
});

it('useUserMenu.openAt открывает профиль, передаёт позицию и предпочитает ростер перед target.username', async () => {
  // Из ЛС в ростере может не быть собеседника; target.username — единственный доступный @логин, но кэш имеет приоритет.
  const userMenu = await server.ssrLoadModule('/src/components/UserContextMenu.tsx') as MenuModule;
  await openProfile(userMenu);
  const open = host?.querySelector<HTMLButtonElement>('button');
  assert.ok(open, 'тестовый вызывающий открылся');
  await flush(() => open!.click());
  const card = document.body.querySelector('.pcard');
  assert.ok(card, 'openAt(view=profile) сразу показал реальную карточку профиля');
  assert.equal(card.querySelector('.pcard-handle')?.textContent, '@dm-login', 'без ростера виден логин из target');
  const menu = document.body.querySelector<HTMLElement>('.ctx-menu.bare');
  assert.ok(menu, 'карточка использует настоящий ContextMenu');
  assert.equal(menu.style.left, '123px', 'openAt передал экранный X');
  assert.equal(menu.style.top, '234px', 'openAt передал экранный Y');

  await unmount();
  await openProfile(userMenu, { id: 'peer', username: 'roster-login', displayName: 'Ростер', avatarUrl: null });
  const secondOpen = host?.querySelector<HTMLButtonElement>('button');
  assert.ok(secondOpen, 'повторно открылся тестовый вызывающий');
  await flush(() => secondOpen!.click());
  assert.equal(document.body.querySelector('.pcard-handle')?.textContent, '@roster-login', 'ростерный логин сильнее устаревшего target.username');
});

it('мутант без target.username не проходит реальный openAt из ЛС', async () => {
  // Поле логина в шапке ЛС нужно именно когда серверный ростер ещё не загружен или собеседника в нём нет.
  const mutant = await server.ssrLoadModule('/src/components/UserContextMenu.tsx?codex-no-target-username') as MenuModule;
  await openProfile(mutant);
  const open = host?.querySelector<HTMLButtonElement>('button');
  assert.ok(open, 'тестовый вызывающий мутанта открылся');
  await flush(() => open!.click());
  assert.throws(() => assert.ok(document.body.querySelector('.pcard-handle')?.textContent === '@dm-login', 'target username is visible in profile'), assert.AssertionError,
    'удалённый fallback из target обязан ломать сценарий ЛС');
});
