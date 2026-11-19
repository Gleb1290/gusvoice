import assert from 'node:assert/strict';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { createServer, type ViteDevServer } from 'vite';
import type { Instance } from './configRules';

const homeId = 'local-home';
const neighborId = 'local-neighbor';
const homeHost = 'home.invalid';
const neighborHost = 'neighbor.invalid';
const homeToken = 'fixture-home';
const neighborToken = 'fixture-neighbor';
const savedServer = { id: 'saved-neighbor-server', name: 'Гостиная соседа', iconUrl: null };
const voiceRoom = 'guest-voice';
const readySetup = { needsSetup: false, tokenConfigured: false, wizardPending: false };
const ownProfile = { id: 'home-profile', username: 'home', displayName: 'Домашний профиль', superAdmin: false };
const guestProfile = { id: 'guest-profile', username: 'guest', displayName: 'Гостевой профиль', superAdmin: true };

type Outcome = 'hang' | 'offline' | 'ok' | 'unauthorized';
type Boot = {
  active?: string;
  neighbor?: 'saved' | 'without-token';
  homeMe: Outcome;
  homeSetup?: Outcome;
  holdHomeServers?: boolean;
  holdHomeMeAfterFirst?: boolean;
  deliverLateHome?: boolean;
  neighborMe?: 'ok' | 'unauthorized';
};

type RequestLog = { host: string; path: string; method: string; authorization: string | null; active: string | null };
type Scene = {
  calls: RequestLog[];
  sockets: string[];
  selectNeighbor: () => Promise<void>;
  selectHome: () => Promise<void>;
  layout: { mounts: number; unmounts: number };
  homeServers: ReturnType<typeof deferredResponse>;
  homeMe: ReturnType<typeof deferredResponse>;
  homeSetup: ReturnType<typeof deferredResponse>;
  store: typeof import('./store').useStore;
};

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function entry(id: string, host: string, name: string, token: string | null, order: number): Instance {
  return { id, apiUrl: `https://${host}`, presenceWs: `wss://${host}`, pushGateway: '', ntfyServer: '',
    domain: host, name, token, order, federationInstanceId: host };
}

function registry(): Instance[] {
  return JSON.parse(localStorage.getItem('gv_instances') ?? '[]') as Instance[];
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function flush(work?: () => void) {
  await act(async () => {
    work?.();
    await wait(0);
  });
}

async function waitFor(ready: () => unknown, message: string) {
  const deadline = Date.now() + 6500;
  while (!ready() && Date.now() < deadline) {
    await act(async () => { await wait(25); });
  }
  assert.ok(ready(), message);
}

function answer(outcome: Outcome, body: object, pending: ReturnType<typeof deferredResponse>, signal?: AbortSignal | null) {
  switch (outcome) {
    case 'hang':
      if (!signal) return pending.promise;
      signal.throwIfAborted();
      return new Promise<Response>((resolve, reject) => {
        // fetch может быть отменён при дедлайне или при переходе. Если отмены не было,
        // ответ домашнего запроса останется в полёте и сможет прийти после открытия B.
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        void pending.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    case 'offline': throw new TypeError('Failed to fetch');
    case 'ok': return Response.json(body);
    case 'unauthorized': return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

async function coldStart(options: Boot, verify: (scene: Scene) => Promise<void>) {
  // Каждая загрузка получает новый DOM и граф SSR-модулей: API и стор читают накопленное состояние как при перезапуске.
  const calls: RequestLog[] = [];
  const sockets: string[] = [];
  const homeServers = deferredResponse();
  const homeMe = deferredResponse();
  const layout = { mounts: 0, unmounts: 0 };
  let homeProfiles = 0;
  const homeSetup = deferredResponse();
  let server: ViteDevServer | undefined;
  let root: Root | undefined;
  const broadcastChannel = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel');
  GlobalRegistrator.register({
    url: `https://${homeHost}/`,
    settings: { disableJavaScriptFileLoading: true, enableImageFileLoading: false },
  });
  try {
    const home = entry(homeId, homeHost, 'Дом', homeToken, 0);
    const entries = [home];
    if (options.neighbor) {
      entries.push({
        ...entry(neighborId, neighborHost, 'Сосед', options.neighbor === 'saved' ? neighborToken : null, 1),
        guestOf: homeId,
        userId: 'cached-guest',
        displayName: 'Устаревший профиль из кеша',
        servers: [savedServer],
      });
      localStorage.setItem('gv_last_place', JSON.stringify({ instanceId: neighborId, serverId: savedServer.id }));
    }
    localStorage.setItem('gv_instances', JSON.stringify(entries));
    localStorage.setItem('gv_active_instance', options.active ?? homeId);
    localStorage.setItem('gv_mi_debug', '1');

    class ClosedSocket {
      readyState = 3;
      constructor(url: string | URL) { sockets.push(String(url)); }
      close() {}
      send() {}
      addEventListener() {}
      removeEventListener() {}
    }

    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const auth = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const active = activeId();
      calls.push({ host: url.host, path: url.pathname, method, authorization: auth.get('Authorization'), active });
      const { host, pathname } = url;
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      // Фоновые шлюзы опрашивают соседние записи независимо от загрузки активного инстанса.
      // У них свои ответы, иначе поздний ответ A разбудит сразу два несвязанных запроса.
      if (host === homeHost && active !== homeId) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      if (pathname === '/api/unread') return Response.json({ error: 'Unauthorized' }, { status: 401 });
      if (method === 'GET' && host === homeHost) {
        if (pathname === '/api/auth/me') {
          const outcome = ++homeProfiles > 1 && options.holdHomeMeAfterFirst ? 'hang' : options.homeMe;
          return answer(outcome, ownProfile, homeMe, options.deliverLateHome ? undefined : signal);
        }
        if (pathname === '/api/setup/status') {
          return answer(options.homeSetup ?? 'ok', readySetup, homeSetup, options.deliverLateHome ? undefined : signal);
        }
        if (pathname === '/api/servers') return options.holdHomeServers ? homeServers.promise : Response.json([]);
      }
      if (host === neighborHost && method === 'POST' && pathname === `/api/channels/${voiceRoom}/voice/token`
        && auth.get('Authorization') === `Bearer ${neighborToken}`) {
        return Response.json({ url: 'wss://media.invalid', token: 'fixture-voice', channelName: 'Голос B' });
      }
      if (method === 'GET' && host === neighborHost) {
        if (pathname === '/api/setup/status') return Response.json(readySetup);
        if (auth.get('Authorization') !== `Bearer ${neighborToken}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (pathname === '/api/auth/me') return answer(options.neighborMe ?? 'ok', guestProfile, homeMe);
        if (pathname === '/api/servers') return Response.json([savedServer]);
        if (pathname === `/api/servers/${savedServer.id}`) return Response.json({
          server: savedServer, categories: [], channels: [], roles: [], permissions: '0',
          member: { userId: guestProfile.id, roles: [] }, reads: {}, sounds: {}, emojis: [],
          stickerPacks: [], stickersEnabled: false,
        });
      }
      // Любая непрописанная ручка недоступна, включая вход и выпуск нового гостевого доступа.
      return new Response(null, { status: 503 });
    };
    Object.assign(globalThis, {
      IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchStub, WebSocket: ClosedSocket, BroadcastChannel: undefined,
    });

    Object.defineProperty(globalThis, '__gusvoiceColdStartLayout', { value: layout, configurable: true });
    const { createRoot } = await import('react-dom/client');
    server = await createServer({
      root: fileURLToPath(new URL('../', import.meta.url)),
      configFile: false,
      envFile: false,
      optimizeDeps: { noDiscovery: true, include: [] },
      esbuild: { jsx: 'automatic' },
      server: { middlewareMode: true, hmr: false, watch: null, ws: false },
      plugins: [{
        name: 'cold-start-layout-boundary',
        enforce: 'pre',
        resolveId(source, importer) {
          if (source === './components/MainLayout' && importer?.replaceAll('\\', '/').endsWith('/src/App.tsx')) {
            return '\0cold-start-layout';
          }
        },
        load(id) {
          if (id !== '\0cold-start-layout') return;
          // Тяжёлые панели за границей запуска. Профиль и открытый сервер выводим из настоящего стора.
          return `
            import { createElement, useEffect } from 'react';
            import { useStore } from '/src/store.ts';
            export function MainLayout({ connectionScreen } = {}) {
              const user = useStore(s => s.user);
              const boot = useStore(s => s.bootstrap);
              useEffect(() => {
                const layout = globalThis.__gusvoiceColdStartLayout;
                layout.mounts++;
                return () => { layout.unmounts++; };
              }, []);
              return createElement('main', { 'data-cold-start': '' },
                connectionScreen ?? [user?.displayName, boot?.server.name].filter(Boolean).join(' / '));
            }
          `;
        },
      }],
    });
    const { App } = await server.ssrLoadModule('/src/App.tsx') as typeof import('./App');
    const { useStore: store } = await server.ssrLoadModule('/src/store.ts') as typeof import('./store');
    const { switchInstance } = await server.ssrLoadModule('/src/instanceSwitch.ts') as typeof import('./instanceSwitch');
    assert.equal(store.getState().user, null, 'до монтирования загружен только реестр');
    assert.equal(store.getState().currentServerId, null);
    const seenUsers = new Set<string>();
    const unsubscribe = store.subscribe(({ user }) => { if (user) seenUsers.add(user.id); });
    try {
      const host = document.createElement('div');
      document.body.append(host);
      const app = root = createRoot(host);
      await flush(() => app.render(createElement(App)));
      await verify({
        calls, sockets, layout, homeServers, homeMe, homeSetup, store,
        selectNeighbor: () => switchInstance(neighborId),
        selectHome: () => switchInstance(homeId),
      });
      assert.ok(!seenUsers.has('cached-guest'), 'профиль из кеша не становится авторизованным');
      assert.ok(!calls.some(({ method, path }) => method === 'POST' && path === '/api/auth/login'),
        'холодный запуск не отправляет форму входа');
    } finally {
      unsubscribe();
    }
  } finally {
    try {
      if (root) act(() => root!.unmount());
      await server?.close();
    } finally {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
      Reflect.deleteProperty(globalThis, '__gusvoiceColdStartLayout');
      try {
        await GlobalRegistrator.unregister();
      } finally {
        if (broadcastChannel) Object.defineProperty(globalThis, 'BroadcastChannel', broadcastChannel);
        else Reflect.deleteProperty(globalThis, 'BroadcastChannel');
      }
    }
  }
}

function activeId() {
  return localStorage.getItem('gv_active_instance');
}

function main() {
  return document.querySelector('[data-cold-start]');
}

function mainText() {
  return main()?.textContent;
}

function findButton(text: RegExp) {
  return [...document.querySelectorAll('button')].find((button) => text.test(button.textContent ?? ''));
}

function assertNeighbor(scene: Scene) {
  assert.equal(activeId(), neighborId);
  assert.equal(scene.store.getState().user?.id, guestProfile.id);
  assert.equal(scene.store.getState().currentServerId, savedServer.id);
  assert.equal(mainText(), `${guestProfile.displayName} / ${savedServer.name}`);
  assert.ok(scene.calls.some((call) =>
    call.host === neighborHost && call.path === `/api/servers/${savedServer.id}`
      && call.authorization === `Bearer ${neighborToken}`), 'сервер загружен с сохранённым доступом B');
  assert.equal(registry().find((item) => item.id === neighborId)?.token, neighborToken);
  assert.equal(registry().find((item) => item.id === homeId)?.token, homeToken);
  assert.equal(document.querySelector('input[type=password]'), null);
}

for (const scenario of [
  { name: 'зависший профиль и поздний сетевой отказ', homeMe: 'hang', homeSetup: 'ok', late: 'offline' },
  { name: 'зависшие профиль и мастер, затем поздние успешные ответы', homeMe: 'hang', homeSetup: 'hang', late: 'ok' },
  { name: 'быстрый сетевой отказ', homeMe: 'offline', homeSetup: 'ok', late: null },
  { name: 'быстрый сетевой отказ и зависший мастер', homeMe: 'offline', homeSetup: 'hang', late: null },
  { name: 'зависший профиль и поздний 401 дома', homeMe: 'hang', homeSetup: 'ok', late: 'unauthorized' },
] as const) {
  it(`открывает сохранённый сервер соседа при отказе дома: ${scenario.name}`, { timeout: 25000 }, async () => {
    await coldStart({ ...scenario, neighbor: 'saved', deliverLateHome: true }, async (scene) => {
      assert.ok(scene.calls.some((call) => call.host === homeHost && call.path === '/api/auth/me'));
      if (scenario.homeSetup === 'hang') {
        assert.ok(scene.calls.some((call) => call.host === homeHost && call.path === '/api/setup/status'),
          'поздний статус относится к запросу, отправленному на дом');
      }
      const choose = findButton(/перейти в .*neighbor\.invalid/i);
      assert.ok(choose, 'сохранённый B доступен для выбора до ответа дома');
      await flush(() => choose.click());
      await waitFor(() => mainText()?.includes(savedServer.name), 'сервер соседа должен открыться до ответа дома');
      assertNeighbor(scene);
      const before = scene.calls.length;
      await flush(() => {
        if (scenario.homeMe === 'hang') {
          if (scenario.late === 'offline') scene.homeMe.reject(new TypeError('Failed to fetch'));
          else if (scenario.late === 'unauthorized') {
            scene.homeMe.resolve(Response.json({ error: 'Unauthorized' }, { status: 401 }));
          } else {
            scene.homeMe.resolve(Response.json(ownProfile, { headers: { 'x-refresh-token': 'late-home-refresh' } }));
          }
        }
        if (scenario.homeSetup === 'hang') {
          scene.homeSetup.resolve(Response.json({ ...readySetup, wizardPending: true }));
        }
      });
      // Сетевой отказ может запланировать повтор позже, уже с активным доступом B.
      if (scenario.late === 'offline') await act(async () => { await wait(1700); });
      assertNeighbor(scene);
      assert.deepEqual(scene.calls.slice(before).filter((call) => call.path === '/api/auth/me' && call.host === neighborHost), [],
        'завершение старого запроса не запускает новый вход');
    });
  });
}

it('сохранённый доступ открывает сервер при запуске сразу на соседе', { timeout: 25000 }, async () => {
  await coldStart({ active: neighborId, neighbor: 'saved', homeMe: 'hang' }, async (scene) => {
    await waitFor(() => mainText()?.includes(savedServer.name), 'контрольная гостевая сессия открывается');
    assertNeighbor(scene);
    assert.ok(!scene.calls.some(({ active, host, path }) => active === homeId && host === homeHost && path === '/api/auth/me'));
  });
});

for (const neighbor of [undefined, 'without-token'] as const) {
  it(neighbor ? 'снимок соседа без доступа не подменяет вход' : 'без соседа отказ дома объяснён и домашняя сессия сохранена',
    { timeout: 25000 }, async () => {
      await coldStart({ neighbor, homeMe: 'offline', homeSetup: 'hang' }, async ({ calls, store }) => {
        const retry = () => [...document.querySelectorAll('button')].find((button) => /попробовать снова/i.test(button.textContent ?? ''));
        await waitFor(retry, 'при отказе без доступа приложение предлагает повторить запуск');
        assert.match(document.body.textContent ?? '', /не отвеча|недоступ/i);
        assert.equal(activeId(), homeId);
        assert.equal(registry().find((item) => item.id === homeId)?.token, homeToken);
        assert.equal(store.getState().user, null);
        assert.equal(store.getState().currentServerId, null);
        assert.equal(mainText(), undefined);
        assert.equal(document.querySelector('input[type=password]'), null);
        assert.ok(!calls.some((call) => call.host === neighborHost && call.path === '/api/auth/me'),
          'снимка сервера недостаточно для попытки гостевого входа');
      });
    });
}

it('401 гостя отзывает его сохранённый доступ и открывает домашнюю сессию', { timeout: 25000 }, async () => {
  await coldStart({ active: neighborId, neighbor: 'saved', homeMe: 'ok', neighborMe: 'unauthorized' },
    async ({ calls, store }) => {
      await waitFor(() => mainText() === ownProfile.displayName, 'после гостевого 401 открывается домашний профиль');
      assert.equal(activeId(), homeId);
      assert.equal(store.getState().user?.id, ownProfile.id);
      assert.equal(store.getState().currentServerId, null);
      assert.equal(registry().find((item) => item.id === neighborId)?.token, null);
      assert.equal(registry().find((item) => item.id === homeId)?.token, homeToken);
      assert.deepEqual(calls.filter(({ path }) => path === '/api/auth/me').map(({ host, authorization }) => [host, authorization]), [
        [neighborHost, `Bearer ${neighborToken}`],
        [homeHost, `Bearer ${homeToken}`],
      ]);
      assert.equal(document.querySelector('input[type=password]'), null);
    });
});

it('поздний список серверов дома не запускает повторный bootstrap на B', { timeout: 25000 }, async () => {
  await coldStart({ homeMe: 'ok', neighbor: 'saved', holdHomeServers: true }, async (scene) => {
    const homeListRequested = () => scene.calls.some(({ host, path }) => host === homeHost && path === '/api/servers');
    await waitFor(homeListRequested, 'App должен начать домашний bootstrap');
    assert.equal(scene.store.getState().user?.id, ownProfile.id);
    assert.equal(activeId(), homeId);

    await act(async () => { await scene.selectNeighbor(); });
    await waitFor(() => mainText()?.includes(savedServer.name), 'B открывается при незавершённом bootstrap дома');
    assertNeighbor(scene);

    const sideEffects = () => ({
      sockets: scene.sockets.slice(),
      loads: scene.calls.filter(({ path }) =>
        path === '/api/blocks' || path === '/api/push/mutes' || path === '/api/servers' || path.startsWith('/api/servers/')),
    });
    const before = sideEffects();
    assert.ok(before.sockets.some((url) => new URL(url).host === neighborHost), 'B действительно подключил шлюз');
    assert.ok(before.loads.some(({ host, path }) => host === neighborHost && path === '/api/blocks'),
      'B действительно загрузил данные после списка серверов');

    const homeServer = { id: 'late-home-server', name: 'Поздний сервер дома', iconUrl: null };
    await flush(() => { scene.homeServers.resolve(Response.json([homeServer])); });
    await flush();

    assertNeighbor(scene);
    assert.deepEqual(scene.store.getState().servers.map(({ id }) => id), [savedServer.id]);
    assert.deepEqual(registry().find(({ id }) => id === neighborId)?.servers, [savedServer]);
    assert.deepEqual(sideEffects(), before, 'поздний bootstrap A не открыл сокеты и не перезапустил загрузки');
  });
});

it('возврат в голос B с экрана восстановления сохраняет MainLayout до выхода', { timeout: 25000 }, async () => {
  await coldStart({ homeMe: 'ok', neighbor: 'saved', holdHomeMeAfterFirst: true, deliverLateHome: true }, async (scene) => {
    await waitFor(() => mainText() === ownProfile.displayName, 'домашний профиль открыт');
    await act(async () => { await scene.selectNeighbor(); });
    await waitFor(() => mainText()?.includes(savedServer.name), 'профиль и сервер B открыты');
    assertNeighbor(scene);
    await act(async () => {
      await scene.store.getState().joinVoice(voiceRoom);
      scene.store.getState().setVoiceState('connected');
    });
    const voice = scene.store.getState().voice;
    assert.ok(voice);
    assert.equal(voice.instanceId, neighborId);
    const layout = main();
    assert.ok(layout);
    const lifetime = { ...scene.layout };

    await act(async () => { await scene.selectHome(); });
    const returnToVoice = () => findButton(/вернуться к инстансу голосового канала/i);
    await waitFor(returnToVoice, 'App передал экран восстановления в MainLayout');
    assert.equal(activeId(), homeId);
    assert.equal(main(), layout);
    assert.ok(layout.contains(returnToVoice() ?? null));
    assert.equal(scene.store.getState().voice, voice);
    assert.deepEqual(scene.layout, lifetime);

    await flush(() => returnToVoice()!.click());
    await waitFor(() => mainText()?.includes(savedServer.name), 'кнопка восстановления вернула в B');
    await flush(() => { scene.homeMe.resolve(Response.json(ownProfile)); });
    assertNeighbor(scene);
    assert.equal(main(), layout);
    assert.equal(scene.store.getState().voice, voice);
    assert.equal(scene.store.getState().voiceState, 'connected');
    assert.deepEqual(scene.layout, lifetime);

    await act(async () => { await scene.store.getState().logout(); });
    assert.equal(main(), null);
    assert.equal(scene.store.getState().voice, null);
    assert.deepEqual(scene.layout, { ...lifetime, unmounts: lifetime.unmounts + 1 });
  });
});
