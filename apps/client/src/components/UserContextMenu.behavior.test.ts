import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, it } from 'node:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createServer, type ViteDevServer } from 'vite';
import type { UserMenuTarget } from './UserContextMenu';

let server: ViteDevServer;
let UserContextMenu: typeof import('./UserContextMenu').UserContextMenu;
let store: typeof import('../store').useStore;
let initial: ReturnType<typeof store.getState>;
let root: Root | undefined;
let host: HTMLDivElement;

before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false,
    cacheDir: mkdtempSync(join(tmpdir(), 'gusvoice-user-context-menu-test-')), optimizeDeps: { noDiscovery: true, include: [] },
    esbuild: { jsx: 'automatic' }, define: { 'import.meta.env': '{}' },
    plugins: [{ name: 'user-context-menu-test-empty-env', enforce: 'pre', transform(source, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/config.ts')) return;
      return source.replaceAll('import.meta.env.', '({}).');
    } }],
    resolve: { alias: { '@gusvoice/shared': fileURLToPath(new URL('../../../../packages/shared/src/index.ts', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, watch: null, ws: false }, appType: 'custom', logLevel: 'error' });
  UserContextMenu = (await server.ssrLoadModule('/src/components/UserContextMenu.tsx')).UserContextMenu;
  store = (await server.ssrLoadModule('/src/store.ts')).useStore;
  initial = store.getState();
});

async function mount(target: UserMenuTarget, patch: Partial<ReturnType<typeof store.getState>> = {}) {
  store.setState({ ...initial, user: { id: 'local-user', username: 'local', displayName: 'Локальный' } as never,
    members: [], presence: {}, onlineUsers: [], serverFeatures: [], ...patch }, true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(createElement(UserContextMenu, { target, pos: { x: 12, y: 18 }, onClose() {} })); });
}

async function unmount() {
  if (root) await act(async () => root!.unmount());
  root = undefined; host?.remove();
}

afterEach(async () => {
  await unmount();
  if (initial) store.setState(initial, true);
});

after(async () => {
  try { await server?.close(); }
  finally { await GlobalRegistrator.unregister(); }
});

it('показывает личную громкость при каждом независимом признаке голоса, но не самому себе', async () => {
  // Приглушать человека имеет смысл только в голосовом контексте; три источника могут приходить с разных экранов.
  const base: UserMenuTarget = { userId: 'peer-a', name: 'Сосед' };
  const hasControl = () => !!document.querySelector('.ctx-vol2') &&
    !!document.querySelector<HTMLInputElement>('.ctx-vol2 input[type="range"]') &&
    !!document.querySelector('.ctx-vol2 .ctx-vol2-spk') &&
    [...document.querySelectorAll('.ctx-item .ctx-label-main')].some((el) => el.textContent === 'Заглушить для себя');

  await mount({ ...base, participant: { isMicrophoneEnabled: true, attributes: {} } as never });
  assert.equal(hasControl(), true, 'живой участник в звонке'); await unmount();

  await mount({ ...base, voiceChannelId: 'voice-a' });
  assert.equal(hasControl(), true, 'цель находится в голосовом канале'); await unmount();

  await mount(base, { presence: { 'voice-a': [{ userId: 'peer-a' }] } as never });
  assert.equal(hasControl(), true, 'присутствие подтверждает голос, даже если канал не передан в target'); await unmount();

  await mount({ ...base, participant: { isMicrophoneEnabled: true, attributes: {} } as never, voiceChannelId: 'voice-a' },
    { presence: { 'voice-a': [{ userId: 'peer-a' }] } as never, user: { id: 'peer-a', username: 'peer-a', displayName: 'Сосед' } as never });
  assert.equal(hasControl(), false, 'самому себе личная громкость и локальная заглушка не предлагаются даже при всех сигналах');
});

it('не показывает локальную громкость в текстовой беседе без признаков голоса', async () => {
  // В текстовом групповом чате ползунок без живого голосового адресата вводил бы в заблуждение.
  await mount({ userId: 'peer-b', name: 'Другой собеседник', micMuted: true, serverMuted: true });
  assert.equal(document.querySelector('.ctx-vol2') === null, true);
});
