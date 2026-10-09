import assert from 'node:assert/strict';
import { after, afterEach, before, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createServer, type ViteDevServer } from 'vite';
import { act, createElement as el } from 'react';
import type { Root } from 'react-dom/client';

let server: ViteDevServer;
let cacheDir = '';
let createRoot: typeof import('react-dom/client').createRoot;
let Select: typeof import('./Select').Select;
let useDialogChrome: typeof import('../dialogChrome').useDialogChrome;
let root: Root | undefined;
let host: HTMLDivElement;
let mobile = false;
let closed = 0;
let originalMatchMedia: typeof window.matchMedia;
let originalAdd: typeof window.addEventListener;
let originalRemove: typeof window.removeEventListener;
const activeWindowKeys = new Set<EventListenerOrEventListenerObject>();

async function flush(render?: () => void) {
  await act(async () => { render?.(); await new Promise<void>((resolve) => setImmediate(resolve)); });
}
async function mount() {
  const Dialog = () => {
    const ref = useDialogChrome<HTMLDivElement>(() => { closed++; });
    return el('div', { className: 'modal-overlay' },
      el('div', { ref, className: 'modal settings-modal', role: 'dialog', 'aria-modal': 'true', tabIndex: -1 },
        el('h1', { id: 'settings-title' }, 'Настройки'),
        el(Select, { value: 'mic', options: [{ value: 'mic', label: 'Микрофон' }, { value: 'other', label: 'Другой' }], onChange: () => {}, title: 'Устройство' }),
      ),
    );
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await flush(() => root!.render(el(Dialog)));
  await flush();
}
async function unmount() {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined; host?.remove();
  await flush();
}
function keyEscape(target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}
async function pressEscape(target: EventTarget = window) {
  let event!: KeyboardEvent;
  await flush(() => { event = keyEscape(target); });
  return event;
}

before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  createRoot = (await import('react-dom/client')).createRoot;
  cacheDir = mkdtempSync(join(tmpdir(), 'gusvoice-dialog-chrome-'));
  server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false, cacheDir,
    optimizeDeps: { noDiscovery: true, include: [] }, esbuild: { jsx: 'automatic' }, define: { 'import.meta.env': '{}' },
    plugins: [{ name: 'dialog-test-empty-env', enforce: 'pre', transform(source, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/config.ts')) return;
      return source.replaceAll('import.meta.env.', '({}).');
    } }],
    resolve: { alias: { '@gusvoice/shared': fileURLToPath(new URL('../../../../packages/shared/src/index.ts', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, watch: null, ws: false }, appType: 'custom', logLevel: 'error',
  });
  Select = (await server.ssrLoadModule('/src/components/Select.tsx')).Select;
  useDialogChrome = (await server.ssrLoadModule('/src/dialogChrome.ts')).useDialogChrome;
  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: mobile && query === '(max-width: 620px)', media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  })) as typeof window.matchMedia;
  originalAdd = window.addEventListener;
  originalRemove = window.removeEventListener;
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === 'keydown') activeWindowKeys.add(listener);
    return originalAdd.call(window, type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === 'keydown') activeWindowKeys.delete(listener);
    return originalRemove.call(window, type, listener, options);
  }) as typeof window.removeEventListener;
});

afterEach(async () => {
  await unmount();
  document.querySelectorAll('.sheet-scrim, .dd-pop, .modal-overlay').forEach((node) => node.remove());
  mobile = false; closed = 0;
});

after(async () => {
  await unmount();
  await server?.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  window.matchMedia = originalMatchMedia;
  window.addEventListener = originalAdd;
  window.removeEventListener = originalRemove;
  GlobalRegistrator.unregister();
});

it('Esc сначала закрывает мобильный лист выбора, а следующий — settings dialog', async () => {
  mobile = true;
  await mount();
  const trigger = document.querySelector<HTMLButtonElement>('[role="combobox"]'); assert.ok(trigger);
  const baseline = activeWindowKeys.size;
  await flush(() => trigger!.click());
  assert.ok(document.body.querySelector('.sheet.dd-sheet'), 'Select открыл реальный телефонный лист в портале body');
  assert.equal(activeWindowKeys.size, baseline + 1, 'только открытый телефонный Select добавил временный window keydown listener');

  const first = await pressEscape();
  assert.equal(first.defaultPrevented, false, 'Select закрывает лист без гашения Esc у верхнего settings dialog');
  assert.equal(document.body.querySelector('.sheet.dd-sheet'), null, 'первый Esc снял лист');
  assert.equal(closed, 0, 'первый Esc не закрыл родительские настройки');
  assert.equal(activeWindowKeys.size, baseline, 'закрытие листа сняло его window listener');

  await pressEscape();
  assert.equal(closed, 1, 'следующий Esc дошёл до диалога после исчезновения слоя');
});

it('настольный Select не вешает мобильный window listener и отдаёт Esc своему списку', async () => {
  mobile = false;
  await mount();
  const trigger = document.querySelector<HTMLButtonElement>('[role="combobox"]'); assert.ok(trigger);
  const baseline = activeWindowKeys.size;
  await flush(() => trigger!.click());
  const pop = document.body.querySelector<HTMLElement>('.dd-pop'); assert.ok(pop, 'настольный список открылся');
  assert.equal(activeWindowKeys.size, baseline, 'настольная версия не добавляет mobile keydown listener');

  const outside = await pressEscape();
  assert.equal(outside.defaultPrevented, false, 'вне списка desktop Select не перехватывает window Escape');
  assert.ok(document.body.querySelector('.dd-pop'), 'верхний список остаётся открытым до Escape на нём');
  assert.equal(closed, 0, 'dialog не закрывается, пока .dd-pop находится поверх него');

  const inside = await pressEscape(pop);
  assert.equal(inside.defaultPrevented, true, 'React handler списка обработал Escape на desktop');
  assert.equal(document.body.querySelector('.dd-pop'), null, 'список закрылся');
  assert.equal(closed, 0, 'обработанный Select Escape не закрыл окно');
  await pressEscape();
  assert.equal(closed, 1, 'после закрытия списка следующий Esc закрывает окно');
});

it('settings dialog уважает уже погашенный Esc и закрывается после снятия слоя', async () => {
  mobile = false;
  await mount();
  const layer = document.createElement('div'); layer.className = 'ctx-menu'; document.body.append(layer);
  await pressEscape();
  assert.equal(closed, 0, 'настоящее меню поверх окна оставляет Esc ему');
  layer.remove();
  const prevented = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); prevented.preventDefault();
  await flush(() => window.dispatchEvent(prevented));
  assert.equal(closed, 0, 'уже погашенный клавишный захват не закрывает настройки');
  await pressEscape();
  assert.equal(closed, 1, 'без слоя и preventDefault окно закрывается');
});

it('лист устройства поверх полного UserSettingsModal забирает первый Esc и оставляет окно открытым', async () => {
  // Композиция маленького Dialog не ловит случай, когда само окно настроек добавило свой обработчик Esc.
  mobile = true;
  const { UserSettingsModal } = await server.ssrLoadModule('/src/components/UserSettingsModal.tsx') as typeof import('./UserSettingsModal');
  const { useStore } = await server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const snapshot = useStore.getState();
  const originalDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { enumerateDevices: async () => [] } });
  try {
    useStore.setState({ user: { id: 'self', username: 'self', displayName: 'Свой', avatarUrl: null }, serverFeatures: [] } as never);
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await flush(() => root!.render(el(UserSettingsModal, { onClose: () => { closed++; } })));
    await flush();
    const trigger = document.querySelector<HTMLButtonElement>('.settings-modal [role="combobox"]');
    assert.ok(trigger, 'реальная вкладка звука содержит выбор устройства');
    await flush(() => trigger!.click());
    assert.ok(document.querySelector('.sheet.dd-sheet'), 'на телефоне устройство выбирается в листе над полным окном');
    await pressEscape();
    assert.equal(document.querySelector('.sheet.dd-sheet'), null, 'первый Escape закрывает лист');
    assert.equal(closed, 0, 'полное окно настроек не закрыто тем же событием');
    assert.ok(document.querySelector('.settings-modal'), 'настройки остались в DOM');
    await pressEscape();
    assert.equal(closed, 1, 'после снятия листа следующий Escape закрывает настройки');
  } finally {
    await unmount();
    useStore.setState(snapshot, true);
    if (originalDevices) Object.defineProperty(navigator, 'mediaDevices', originalDevices);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
  }
});
