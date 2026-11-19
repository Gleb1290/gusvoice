import assert from 'node:assert/strict';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement, type ComponentType, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { createServer, type ViteDevServer } from 'vite';

it('голос соседа остаётся смонтированным при A → B → A и снимается при выходе', { timeout: 30000 }, async () => {
  GlobalRegistrator.register({
    url: 'https://home.invalid/',
    settings: { disableJavaScriptFileLoading: true, enableImageFileLoading: false },
  });
  const counts = { mounts: 0, unmounts: 0 };
  const globals = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    __gusvoiceRecoveryVoice?: typeof counts;
  };
  const home = { id: 'a', name: 'Дом', apiUrl: 'https://home.invalid', token: 'fixture-a', order: 0 };
  const neighbor = { id: 'b', name: 'Сосед', apiUrl: 'https://neighbor.invalid', token: 'fixture-b', order: 1, guestOf: home.id };
  const profiles = new Map([
    [home.id, { id: 'profile-a', username: 'home', displayName: 'Домашний профиль', avatarUrl: null }],
    [neighbor.id, { id: 'profile-b', username: 'guest', displayName: 'Гостевой профиль', avatarUrl: null }],
  ]);
  const active = () => localStorage.getItem('gv_active_instance');
  const room = 'voice-b';
  let recovering = false;
  let recoveryRequested = false;
  let respondHome!: (response: Response) => void;
  const homeResponse = new Promise<Response>((resolve) => { respondHome = resolve; });

  let server: ViteDevServer | undefined;
  let root: Root | undefined;
  try {
    localStorage.setItem('gv_instances', JSON.stringify([home, neighbor]));
    localStorage.setItem('gv_active_instance', home.id);
    const fetchStub: typeof fetch = async (input, init) => {
      const { origin, pathname } = new URL(input instanceof Request ? input.url : String(input), location.href);
      const instance = [home, neighbor].find(({ apiUrl }) => apiUrl === origin);
      const authorization = new Headers(init?.headers).get('Authorization');
      if (pathname === '/api/unread') return new Response(null, { status: 401 }); // фоновые шлюзы
      if (!instance || authorization !== `Bearer ${instance.token}`) return new Response(null, { status: 401 });
      if (pathname === '/api/auth/me') {
        if (recovering && instance.id === home.id && active() === home.id) {
          recoveryRequested = true;
          return homeResponse;
        }
        return Response.json(profiles.get(instance.id));
      }
      if (pathname === `/api/channels/${room}/voice/token` && init?.method === 'POST' && instance.id === neighbor.id) {
        return Response.json({ url: 'wss://media.invalid', token: 'fixture-voice', channelName: 'Комната B' });
      }
      return new Response(null, { status: 503 });
    };
    class OfflineSocket {
      close() {}
      send() {}
      addEventListener() {}
      removeEventListener() {}
    }
    Object.assign(globals, {
      IS_REACT_ACT_ENVIRONMENT: true, __gusvoiceRecoveryVoice: counts, fetch: fetchStub, WebSocket: OfflineSocket,
    });

    const { createRoot } = await import('react-dom/client');
    server = await createServer({
      root: fileURLToPath(new URL('../../', import.meta.url)),
      configFile: false,
      envFile: false,
      optimizeDeps: { noDiscovery: true, include: [] },
      esbuild: { jsx: 'automatic' },
      server: { middlewareMode: true, hmr: false, watch: null, ws: false },
      plugins: [{
        name: 'voice-lifecycle-probe',
        enforce: 'pre',
        resolveId(source, importer) {
          if (source === './VoiceConnection' && importer?.replaceAll('\\', '/').endsWith('/MainLayout.tsx')) {
            return '\0voice-lifecycle-probe';
          }
        },
        load(id) {
          if (id !== '\0voice-lifecycle-probe') return;
          return `
            import { createElement, useEffect, useState } from 'react';
            import { RoomContext } from '@livekit/components-react';
            import { Room } from 'livekit-client';
            export function VoiceConnection({ children }) {
              const [room] = useState(() => new Room());
              useEffect(() => {
                const counts = globalThis.__gusvoiceRecoveryVoice;
                counts.mounts++;
                return () => { counts.unmounts++; };
              }, []);
              return createElement(RoomContext.Provider, { value: room },
                createElement('div', { 'data-voice-lifecycle': '' }, children));
            }
          `;
        },
      }],
    });

    const { MainLayout } = await server.ssrLoadModule('/src/components/MainLayout.tsx') as {
      MainLayout: ComponentType<{ connectionScreen?: ReactNode }>;
    };
    const { useStore } = await server.ssrLoadModule('/src/store.ts') as typeof import('../store');
    const { switchInstance } = await server.ssrLoadModule('/src/instanceSwitch.ts') as typeof import('../instanceSwitch');
    const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
    const store = useStore.getState;
    const authenticate = async () => store().setAuth(await api.me());

    const host = document.createElement('div');
    document.body.append(host);
    const tree = root = createRoot(host);
    const render = (connectionScreen?: ReactNode) => tree.render(createElement(MainLayout, { connectionScreen }));
    const voiceNode = () => host.querySelector('[data-voice-lifecycle]');
    const recoveryScreen = createElement('p', { role: 'status' }, 'Подключаем дом');

    await act(async () => {
      await authenticate();
      render();
    });
    assert.equal(store().user?.id, 'profile-a');
    assert.equal(voiceNode(), null);

    await act(async () => {
      await switchInstance(neighbor.id);
      await authenticate();
      await store().joinVoice(room);
      // Подмена медиатранспорта сообщает о подключении комнаты без вызова LiveKit connect.
      store().setVoiceState('connected');
    });
    assert.equal(active(), neighbor.id);
    assert.equal(store().user?.id, 'profile-b');
    const voice = store().voice;
    assert.ok(voice);
    assert.equal(voice.instanceId, neighbor.id);
    assert.equal(voice.channelId, room);
    const mountedVoice = voiceNode();
    assert.ok(mountedVoice);
    assert.deepEqual(counts, { mounts: 1, unmounts: 0 });

    let recovery!: Promise<void>;
    await act(async () => {
      await switchInstance(home.id);
      recovering = true;
      recovery = authenticate();
      render(recoveryScreen);
    });
    assert.equal(active(), home.id);
    assert.ok(recoveryRequested);
    assert.equal(store().user?.id, 'profile-b', 'пока дом отвечает, прежний профиль ещё в сторе');
    const status = host.querySelector('[role=status]');
    assert.equal(status?.textContent, 'Подключаем дом', 'MainLayout показывает переданный экран восстановления');
    assert.ok(mountedVoice.contains(status ?? null), 'тот же голосовой хост остаётся родителем экрана');
    assert.equal(voiceNode(), mountedVoice);
    assert.equal(store().voice, voice);
    assert.deepEqual(counts, { mounts: 1, unmounts: 0 });

    await act(async () => {
      respondHome(Response.json(profiles.get(home.id)));
      await recovery;
      render();
    });
    assert.equal(store().user?.id, 'profile-a');
    assert.equal(host.querySelector('[role=status]'), null);
    assert.equal(voiceNode(), mountedVoice);
    assert.equal(store().voice, voice, 'домашний профиль не заменяет голосовую сессию B');
    assert.equal(store().voiceState, 'connected');
    assert.deepEqual(counts, { mounts: 1, unmounts: 0 });

    // Оставляем MainLayout смонтированным, чтобы именно logout освободил голосовой хост.
    await act(async () => { await store().logout(); });
    assert.equal(store().user, null);
    assert.equal(store().voice, null);
    assert.equal(voiceNode(), null);
    assert.deepEqual(counts, { mounts: 1, unmounts: 1 });
  } finally {
    try {
      if (root) act(() => root!.unmount());
      await server?.close();
    } finally {
      delete globals.IS_REACT_ACT_ENVIRONMENT;
      delete globals.__gusvoiceRecoveryVoice;
      await GlobalRegistrator.unregister();
    }
  }
});
