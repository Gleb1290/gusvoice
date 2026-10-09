import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createServer, type ViteDevServer } from 'vite';
import type { UserLastSeen } from '@gusvoice/shared';
import type { useLastSeen as HookType } from '../useLastSeen';

type Hook = typeof HookType;
type State = {
  serverFeatures: string[];
  onlineUsers: string[];
  dmOnlineUsers: string[];
  dmAwayUsers?: string[];
  user: { lastSeenPrivacy?: string; status?: string } | null;
};
type SeenModule = typeof import('../useLastSeen');

let server: ViteDevServer;
let useLastSeen: Hook;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const appliedMutants = new Set<string>();
const globals = globalThis as typeof globalThis & {
  __gvLastSeenState?: State;
  __gvLastSeenApi?: (userId: string) => Promise<UserLastSeen>;
  __gvLastSeenSetState?: (state: State) => void;
  __gvLastSeenObserved?: State;
};
const delay = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const offlineResponse = (userId = 'peer'): UserLastSeen => ({
  userId,
  online: false,
  at: '2026-09-01T12:00:00.000Z',
  approx: 'long',
  exact: false,
  byMe: false,
  canCall: false,
});

function mutate(source: string, name: string): string {
  const scopeMutants: Record<string, string> = {
    'away-hides-server': '!s.dmAwayUsers?.includes(userId)',
    'away-ignored-in-dm': 'true',
  };
  if (name in scopeMutants) {
    const anchor = "(scope === 'server' || !s.dmAwayUsers?.includes(userId))";
    assert.ok(source.includes(anchor), `найден контекст gatewayOnline для ${name}`);
    appliedMutants.add(name); return source.replace(anchor, `(${scopeMutants[name]})`);
  }
  const original = 's.onlineUsers.includes(userId) && serverPresence4(s.serverFeatures)';
  const variants: Record<string, string> = {
    'without-presence4': 's.onlineUsers.includes(userId)',
    'dm-online-is-global': '(s.onlineUsers.includes(userId) || s.dmOnlineUsers.includes(userId)) && serverPresence4(s.serverFeatures)',
  };
  assert.ok(source.includes(original), `найдена точка мутации «${name}»`);
  const replacement = variants[name];
  assert.ok(replacement, `мутант «${name}» определён`);
  const changed = source.replace(original, replacement);
  assert.notEqual(changed, source, `мутант «${name}» изменяет реальный hook`);
  appliedMutants.add(name);
  return changed;
}

before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globals.__gvLastSeenState = { serverFeatures: [], onlineUsers: [], dmOnlineUsers: [], user: null };
  const fixtures: Record<string, string> = {
    '\0gv-lastseen:api': `export const api = { userLastSeen: (userId) => globalThis.__gvLastSeenApi(userId) };`,
    '\0gv-lastseen:store': `
      import { useSyncExternalStore } from 'react';
      let state = globalThis.__gvLastSeenState;
      const listeners = new Set();
      function setState(next) { state = next; globalThis.__gvLastSeenState = next; for (const listener of listeners) listener(); }
      globalThis.__gvLastSeenSetState = setState;
      export function useStore(selector) {
        return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => { globalThis.__gvLastSeenObserved = state; return selector(state); }, () => selector(state));
      }
      useStore.getState = () => state;
    `,
  };
  server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    envFile: false,
    cacheDir: mkdtempSync(join(tmpdir(), 'gusvoice-last-seen-test-')),
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
      name: 'last-seen-hook-fixtures',
      enforce: 'pre',
      resolveId(source, importer) {
        const owner = (importer ?? '').replaceAll('\\', '/').split('?')[0];
        if ((owner.endsWith('/useLastSeen.ts') || owner.endsWith('/dmOnline.ts')) && source === './api') return '\0gv-lastseen:api';
        if ((owner.endsWith('/useLastSeen.ts') || owner.endsWith('/dmOnline.ts')) && source === './store') return '\0gv-lastseen:store';
        return null;
      },
      load(id) { return fixtures[id]; },
      transform(code, id) {
        const normalized = id.replaceAll('\\', '/');
        if (!normalized.includes('/useLastSeen.ts?lastseenmutant=')) return null;
        const name = normalized.split('lastseenmutant=')[1]?.split('&')[0] ?? '';
        return name ? mutate(code.replace(/\r\n/g, '\n'), name) : null;
      },
    }],
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@gusvoice/shared': fileURLToPath(new URL('../../../../packages/shared/src/index.ts', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    appType: 'custom',
    logLevel: 'error',
  });
  useLastSeen = (await server.ssrLoadModule('/src/useLastSeen.ts') as SeenModule).useLastSeen;
});

async function renderSeen(hook: Hook, state: State, response: UserLastSeen, scope: 'dm' | 'server' = 'dm'): Promise<{ seen: UserLastSeen | null; calls: string[] }> {
  globals.__gvLastSeenSetState?.(state);
  assert.ok(globals.__gvLastSeenSetState, 'минимальный Zustand-подобный store fixture загружен');
  globals.__gvLastSeenObserved = undefined;
  const calls: string[] = [];
  globals.__gvLastSeenApi = async (userId) => { calls.push(userId); return response; };
  let seen: UserLastSeen | null = null;
  function Probe() { seen = hook('peer', scope); return null; }
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(Probe)); await delay(25); });
  // Passive effects flush after the render act callback; this second turn lets its zero-delay API request settle.
  await act(async () => { await delay(25); });
  const observed = globals.__gvLastSeenObserved as State | undefined;
  assert.ok(observed, 'fixture отследил чтение snapshot из store');
  assert.deepEqual(observed.serverFeatures, state.serverFeatures, 'hook читает переданный store snapshot');
  return { seen, calls };
}

async function cleanup() {
  const current = root;
  root = null;
  if (current) await act(async () => { current.unmount(); await delay(0); });
  host?.remove(); host = null;
}

async function expectRestAsIs(hook: Hook, state: State, response: UserLastSeen) {
  const result = await renderSeen(hook, state, response);
  try {
    assert.equal(result.calls.length, 1, 'REST-ответ загружен для видимого last-seen профиля');
    assert.strictEqual(result.seen, response, 'без глобального presence online статус возвращается неизменённым');
  } finally { await cleanup(); }
}

it('presence4 перекрывает запоздалый REST offline, пока собеседник в onlineUsers', async () => {
  // Иначе свежая точка шлюза соседствует с «был(а) давно» из запаздывающего REST-ответа.
  const response = offlineResponse();
  const state: State = { serverFeatures: ['lastseen1', 'presence4'], onlineUsers: ['peer'], dmOnlineUsers: [], user: null };
  const unchanged = await renderSeen(useLastSeen, state, response);
  try {
    assert.equal(unchanged.calls.length, 1);
    assert.equal(unchanged.seen?.online, true);
    assert.equal(unchanged.seen?.at, null);
    assert.equal(unchanged.seen?.approx, null);
  } finally { await cleanup(); }

  const noFeature = (await server.ssrLoadModule('/src/useLastSeen.ts?lastseenmutant=without-presence4') as SeenModule).useLastSeen;
  await assert.rejects(() => expectRestAsIs(noFeature,
    { serverFeatures: ['lastseen1'], onlineUsers: ['peer'], dmOnlineUsers: [], user: null }, response), assert.AssertionError,
  'исполняемый мутант перекрывает REST без capability presence4');
  assert.ok(appliedMutants.has('without-presence4'), 'Vite загрузил реально изменённый hook');
});

it('без presence4 и при одном dmOnlineUsers ответ REST остаётся без изменений', async () => {
  // «Невидимый» онлайн действует только в ЛС и не должен превращать время посещения в глобальное «в сети».
  const response = offlineResponse();
  const withoutPresence = { serverFeatures: ['lastseen1'], onlineUsers: ['peer'], dmOnlineUsers: [], user: null };
  await expectRestAsIs(useLastSeen, withoutPresence, response);
  const dmOnly: State = { serverFeatures: ['lastseen1', 'presence4'], onlineUsers: [], dmOnlineUsers: ['peer'], user: null };
  await expectRestAsIs(useLastSeen, dmOnly, response);

  const mutant = (await server.ssrLoadModule('/src/useLastSeen.ts?lastseenmutant=dm-online-is-global') as SeenModule).useLastSeen;
  await assert.rejects(() => expectRestAsIs(mutant, dmOnly, response), assert.AssertionError,
    'исполняемый мутант принимает dmOnlineUsers за глобальное присутствие');
  assert.ok(appliedMutants.has('dm-online-is-global'), 'Vite загрузил реально изменённый hook');
});

it('серверный lastSeen оставляет сокет в сети даже при dmAway, ЛС сохраняет REST offline', async () => {
  const response = offlineResponse();
  const state: State = { serverFeatures: ['lastseen1', 'presence4', 'presence5'], onlineUsers: ['peer'], dmOnlineUsers: [], dmAwayUsers: ['peer'], user: null };
  const checkServer = async (hook: Hook) => {
    const result = await renderSeen(hook, state, response, 'server');
    try {
      assert.deepEqual(result.calls, ['peer']);
      assert.equal(result.seen?.online, true, 'серверный сокет перекрывает away lastSeen');
      assert.equal(result.seen?.at, null); assert.equal(result.seen?.approx, null);
    } finally { await cleanup(); }
  };
  await checkServer(useLastSeen);
  const dm = await renderSeen(useLastSeen, state, response, 'dm');
  try { assert.strictEqual(dm.seen, response, 'ЛС возвращает REST как есть при away'); } finally { await cleanup(); }
  const mutant = (await server.ssrLoadModule('/src/useLastSeen.ts?lastseenmutant=away-hides-server') as SeenModule).useLastSeen;
  await assert.rejects(() => checkServer(mutant), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('серверный сокет перекрывает away lastSeen'));
  assert.ok(appliedMutants.has('away-hides-server'));
});

it('ЛС не перекрывает REST при away, но после возвращения в окно перекрывает', async () => {
  const response = offlineResponse();
  const state: State = { serverFeatures: ['lastseen1', 'presence4', 'presence5'], onlineUsers: ['peer'], dmOnlineUsers: [], dmAwayUsers: ['peer'], user: null };
  const check = async (hook: Hook) => {
    const result = await renderSeen(hook, state, response, 'dm');
    try { assert.strictEqual(result.seen, response, 'away сохраняет REST без подмены'); } finally { await cleanup(); }
  };
  await check(useLastSeen);
  const back = await renderSeen(useLastSeen, { ...state, dmAwayUsers: [] }, response, 'dm');
  try { assert.equal(back.seen?.online, true); assert.equal(back.seen?.at, null); } finally { await cleanup(); }
  const mutant = (await server.ssrLoadModule('/src/useLastSeen.ts?lastseenmutant=away-ignored-in-dm') as SeenModule).useLastSeen;
  await assert.rejects(() => check(mutant), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('away сохраняет REST без подмены'));
  assert.ok(appliedMutants.has('away-ignored-in-dm'));
});

after(async () => {
  await cleanup();
  await server?.close();
  GlobalRegistrator.unregister();
  delete globals.__gvLastSeenState;
  delete globals.__gvLastSeenApi;
  delete globals.__gvLastSeenSetState;
  delete globals.__gvLastSeenObserved;
});
