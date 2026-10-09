import assert from 'node:assert/strict';
import { after, afterEach, before, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createServer, type ViteDevServer } from 'vite';

type ReactionBar = ComponentType<any>;
type BigLayer = ComponentType<any>;
type Raf = (time: number) => void;

let server: ViteDevServer;
let Bar: ReactionBar;
let Layer: BigLayer;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let clock = 0;
let nextRaf = 1;
const frames = new Map<number, Raf>();
const mutationsApplied = new Set<string>();
const nextTimeouts = new Map<number, { at: number; run: () => void }>();
let nextTimeout = 1;
let timeoutClock = 0;
const originalNow = performance.now.bind(performance);
let originalWindowNow: typeof window.performance.now;
let originalRaf: typeof globalThis.requestAnimationFrame;
let originalCancelRaf: typeof globalThis.cancelAnimationFrame;
let originalWindowRaf: typeof window.requestAnimationFrame;
let originalWindowCancelRaf: typeof window.cancelAnimationFrame;
let originalWindowTimeout: typeof window.setTimeout;
let originalWindowClearTimeout: typeof window.clearTimeout;

const delay = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const currentGlobals = globalThis as typeof globalThis & {
  __gvBigEffect?: (request: { kind: string; conversationId: string; messageId: string; emoji: string }) => void;
  __gvCurrentDm?: string | null;
  __gvReducedMotion?: boolean;
};

function transformMutation(source: string, name: string): string {
  const variants: Record<string, [string, string]> = {
    ready: ['h.ready = true;\n      return;', 'h.ready = true;\n      fireBig(h.emoji);\n      return;'],
    click: ['if (swallowClick.current) {\n                swallowClick.current = false;\n                return;\n              }', 'if (false) {\n                swallowClick.current = false;\n                return;\n              }'],
    mouseguard: ['if (ev.pointerType === \'mouse\') return;', 'if (ev.button !== 0) return;'],
  };
  const pair = variants[name];
  assert.ok(pair, `задан исполняемый мутант ${name}`);
  assert.ok(source.includes(pair[0]), `найдена точка мутации ${name}`);
  const changed = source.replace(pair[0], pair[1]);
  assert.notEqual(changed, source, `мутант ${name} меняет исходник`);
  mutationsApplied.add(name);
  return changed;
}

before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  originalRaf = globalThis.requestAnimationFrame;
  originalCancelRaf = globalThis.cancelAnimationFrame;
  originalWindowRaf = window.requestAnimationFrame.bind(window);
  originalWindowCancelRaf = window.cancelAnimationFrame.bind(window);
  originalWindowTimeout = window.setTimeout.bind(window);
  originalWindowClearTimeout = window.clearTimeout.bind(window);
  originalWindowNow = window.performance.now.bind(window.performance);
  const raf = (callback: Raf) => { const id = nextRaf++; frames.set(id, callback); return id; };
  const cancel = (id: number) => { frames.delete(id); };
  Object.assign(globalThis, { requestAnimationFrame: raf, cancelAnimationFrame: cancel });
  window.requestAnimationFrame = raf;
  window.cancelAnimationFrame = cancel;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => clock });
  if (window.performance !== performance) Object.defineProperty(window.performance, 'now', { configurable: true, value: () => clock });
  window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (typeof callback !== 'function') return originalWindowTimeout(callback, ms, ...args);
    if (Number(ms ?? 0) !== 2050) return originalWindowTimeout(callback, ms, ...args);
    const id = nextTimeout++;
    nextTimeouts.set(id, { at: timeoutClock + Number(ms ?? 0), run: () => callback(...args) });
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { nextTimeouts.delete(id); }) as typeof window.clearTimeout;

  const stubs: Record<string, string> = {
    '\0gv-big:imageViewer': 'export const useImageViewerOpen = () => false;',
    '\0gv-big:popover': 'export const placeByHalf = () => null; export const placeByPoint = () => null; export const placeStackByPoint = () => null; export const toLayoutPoint = (x) => x; export const toLayoutRect = (x) => x;',
    '\0gv-big:icon': 'export const Icon = () => null;',
    '\0gv-big:statusDot': 'export const StatusDot = () => null;',
    '\0gv-big:effectsBus': `export function onEffect(callback) { globalThis.__gvBigEffect = callback; return () => { if (globalThis.__gvBigEffect === callback) globalThis.__gvBigEffect = undefined; }; }`,
    '\0gv-big:effectsDom': 'export const reducedMotion = () => !!globalThis.__gvReducedMotion;',
    '\0gv-big:liteMode': 'export const liteModeEnabled = () => false;',
    '\0gv-big:store': 'export const useStore = { getState: () => ({ currentDmId: globalThis.__gvCurrentDm ?? null }) };',
  };
  const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
  server = await createServer({
    root: sourceRoot,
    configFile: false,
    envFile: false,
    cacheDir: mkdtempSync(join(tmpdir(), 'gusvoice-big-reaction-test-')),
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
      name: 'big-reaction-test-fixtures',
      enforce: 'pre',
      resolveId(source, importer) {
        const owner = (importer ?? '').replaceAll('\\', '/').split('?')[0];
        if (owner.endsWith('/components/ContextMenu.tsx')) {
          if (source === '../imageViewer') return '\0gv-big:imageViewer';
          if (source === '../popover') return '\0gv-big:popover';
          if (source === './Icon') return '\0gv-big:icon';
          if (source === './StatusDot') return '\0gv-big:statusDot';
        }
        if (owner.endsWith('/components/BigReactionLayer.tsx')) {
          if (source === '../effectsBus') return '\0gv-big:effectsBus';
          if (source === '../effectsDom') return '\0gv-big:effectsDom';
          if (source === '../liteMode') return '\0gv-big:liteMode';
          if (source === '../store') return '\0gv-big:store';
        }
        return null;
      },
      load(id) { return stubs[id]; },
      transform(code, id) {
        const normalized = id.replaceAll('\\', '/');
        if (!normalized.includes('/components/ContextMenu.tsx?bigmutant=')) return null;
        const name = normalized.includes('bigmutant=ready') ? 'ready' : normalized.includes('bigmutant=click') ? 'click' : normalized.includes('bigmutant=mouseguard') ? 'mouseguard' : '';
        return name ? transformMutation(code.replace(/\r\n/g, '\n'), name) : null;
      },
    }],
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@gusvoice/shared': fileURLToPath(new URL('../../../../packages/shared/src/index.ts', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    appType: 'custom',
    logLevel: 'error',
  });
  Bar = (await server.ssrLoadModule('/src/components/ContextMenu.tsx')).ReactionBar;
  Layer = (await server.ssrLoadModule('/src/components/BigReactionLayer.tsx')).BigReactionLayer;
});

async function mount(component: ComponentType<any>, props: Record<string, unknown> = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(component, props)); await delay(); });
  return host;
}

async function unmount() {
  const current = root;
  root = null;
  if (current) await act(async () => { current.unmount(); await delay(0); });
  host?.remove(); host = null;
}

function pointer(target: Element, type: string, pointerType: string, x = 20, y = 20, button = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerType: { value: pointerType }, button: { value: button }, clientX: { value: x }, clientY: { value: y },
  });
  target.dispatchEvent(event);
  return event;
}

async function frameAt(ms: number) {
  clock = ms;
  const queued = [...frames.values()];
  frames.clear();
  await act(async () => { for (const callback of queued) callback(ms); await delay(0); });
}

function click(target: Element) {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

async function eventInAct(work: () => void) {
  await act(async () => { work(); await delay(0); });
}

async function holdScenario(component: ReactionBar, expectBig: boolean) {
  const big: string[] = []; const picked: string[] = [];
  await mount(component, { reactions: ['🔥'], mine: [], onBig: (emoji: string) => big.push(emoji), onPick: (emoji: string) => picked.push(emoji) });
  try {
    const button = host!.querySelector<HTMLButtonElement>('.react-bar-btn')!;
    clock = 0;
    await eventInAct(() => pointer(button, 'pointerdown', 'touch'));
    await frameAt(expectBig ? 1900 : 1000);
    assert.deepEqual(big, [], 'готовность удержания сама ещё не отправляет событие');
    await eventInAct(() => pointer(button, 'pointerup', 'touch'));
    assert.deepEqual(big, expectBig ? ['🔥'] : [], 'событие отправляется ровно при отпускании после порога');
    await eventInAct(() => click(button));
    assert.deepEqual(picked, [], 'следующий click после длинного удержания не ставит обычную реакцию');
  } finally { await unmount(); }
}

async function shortTap(component: ReactionBar) {
  const big: string[] = []; const picked: string[] = [];
  await mount(component, { reactions: ['🔥'], mine: [], onBig: (emoji: string) => big.push(emoji), onPick: (emoji: string) => picked.push(emoji) });
  try {
    const button = host!.querySelector<HTMLButtonElement>('.react-bar-btn')!;
    clock = 100;
    await eventInAct(() => pointer(button, 'pointerdown', 'touch'));
    clock = 250;
    await eventInAct(() => pointer(button, 'pointerup', 'touch'));
    await eventInAct(() => click(button));
    assert.deepEqual(big, [], 'короткий тап не превращается в большой эффект');
    assert.deepEqual(picked, ['🔥'], 'короткий тап ставит обычную реакцию один раз');
  } finally { await unmount(); }
}

async function mouseHoldIsOrdinary(component: ReactionBar, buttonCode: number) {
  const big: string[] = []; const picked: string[] = [];
  await mount(component, { reactions: ['🔥'], mine: [], onBig: (emoji: string) => big.push(emoji), onPick: (emoji: string) => picked.push(emoji) });
  try {
    const button = host!.querySelector<HTMLButtonElement>('.react-bar-btn')!;
    clock = 0;
    await eventInAct(() => pointer(button, 'pointerdown', 'mouse', 20, 20, buttonCode));
    await frameAt(2000);
    assert.deepEqual(big, [], `мышь button=${buttonCode} не запускает большую реакцию после 2 с`);
    assert.equal(button.classList.contains('held'), false, 'мышь не получает визуальное состояние held');
    assert.equal(host!.querySelector('.react-bar.holding'), null, 'мышь не получает визуальное состояние holding');
    await eventInAct(() => pointer(button, 'pointerup', 'mouse', 20, 20, buttonCode));
    await eventInAct(() => click(button));
    assert.deepEqual(big, [], 'отпускание мыши также не отправляет onBig');
    assert.deepEqual(picked, ['🔥'], 'обычный click мышью ставит реакцию');
  } finally { await unmount(); }
}

it('ReactionBar отправляет big только на отпускании, отменяет раннее и сохраняет короткий тап', async () => {
  // Если отправить при достижении порога, меню закроется под пальцем и отпускание попадёт в сообщение под ним.
  await holdScenario(Bar, true);
  await holdScenario(Bar, false);
  await shortTap(Bar);
  await mouseHoldIsOrdinary(Bar, 0);
  await mouseHoldIsOrdinary(Bar, 2);
  const readyMutant = (await server.ssrLoadModule('/src/components/ContextMenu.tsx?bigmutant=ready')).ReactionBar as ReactionBar;
  await assert.rejects(() => holdScenario(readyMutant, true), assert.AssertionError,
    'исполняемый мутант отправляет реакцию до отпускания пальца');
  assert.ok(mutationsApplied.has('ready'), 'Vite действительно загрузил изменённый компонент');
  const clickMutant = (await server.ssrLoadModule('/src/components/ContextMenu.tsx?bigmutant=click')).ReactionBar as ReactionBar;
  await assert.rejects(() => holdScenario(clickMutant, true), assert.AssertionError,
    'исполняемый мутант пропускает обычный click после большой реакции');
  assert.ok(mutationsApplied.has('click'), 'Vite действительно загрузил изменённый компонент');
  const oldMouseGuard = (await server.ssrLoadModule('/src/components/ContextMenu.tsx?bigmutant=mouseguard')).ReactionBar as ReactionBar;
  await assert.rejects(() => mouseHoldIsOrdinary(oldMouseGuard, 0), assert.AssertionError,
    'исполняемый старый guard разрешает левой кнопке мыши удерживать большую реакцию');
  assert.ok(mutationsApplied.has('mouseguard'), 'Vite действительно загрузил изменённый мышиный guard');
});

it('контекстное меню после касания подавлено, мыши и старому бару оно остаётся доступно', async () => {
  // На телефоне системный long-press не должен открывать пункт быстрого эмодзи поверх уже выбранной реакции.
  const quick: string[] = []; const picked: string[] = [];
  await mount(Bar, { reactions: ['🔥'], mine: [], quick: '👍', onBig: () => {}, onPick: (emoji: string) => picked.push(emoji), onSetQuick: (emoji: string) => quick.push(emoji) });
  try {
    const button = host!.querySelector<HTMLButtonElement>('.react-bar-btn')!;
    await eventInAct(() => {
      pointer(button, 'pointerdown', 'touch');
      button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    assert.equal(host!.querySelector('.react-bar-setq'), null, 'палец не открывает меню «Выбрать по умолчанию»');
    await eventInAct(() => {
      pointer(button, 'pointerdown', 'mouse', 20, 20, 2);
      button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    assert.ok(host!.querySelector('.react-bar-setq'), 'правый клик мышью оставляет настройку быстрого эмодзи');
  } finally { await unmount(); }

  await mount(Bar, { reactions: ['🔥'], mine: [], onPick: (emoji: string) => picked.push(emoji), onSetQuick: (emoji: string) => quick.push(emoji) });
  try {
    const button = host!.querySelector<HTMLButtonElement>('.react-bar-btn')!;
    await eventInAct(() => {
      pointer(button, 'pointerdown', 'touch');
      button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    assert.ok(host!.querySelector('.react-bar-setq'), 'без onBig сохраняется прежнее поведение касания');
    await eventInAct(() => click(button));
    assert.deepEqual(picked, ['🔥'], 'без нового пропса обычный click по-прежнему ставит реакцию');
  } finally { await unmount(); }
});

function addMessage(id: string) {
  const feed = document.querySelector<HTMLDivElement>('.messages')!;
  const row = document.createElement('div'); row.dataset.mid = id;
  const bubble = document.createElement('div'); bubble.className = 'bubble'; row.append(bubble); feed.append(row);
  const rect = (left: number, top: number, width: number, height: number) => new DOMRect(left, top, width, height);
  feed.getBoundingClientRect = () => rect(0, 0, 500, 360);
  row.getBoundingClientRect = () => rect(80, 90, 200, 90);
  bubble.getBoundingClientRect = () => rect(80, 90, 200, 90);
}

async function emitBig(id: string) {
  await act(async () => {
    currentGlobals.__gvBigEffect?.({ kind: 'bigReaction', conversationId: 'dm-1', messageId: id, emoji: '🔥' });
    await delay(0);
  });
}

async function advanceTimeouts(to: number) {
  timeoutClock = to;
  const due = [...nextTimeouts.entries()].filter(([, timer]) => timer.at <= to);
  for (const [id, timer] of due) {
    nextTimeouts.delete(id);
    await act(async () => { timer.run(); await delay(0); });
  }
}

it('BigReactionLayer требует видимый messageId, уважает reduced-motion и убирает эффект через 2050 мс', async () => {
  // Чужое событие не должно рисоваться поверх другой беседы или пустого места, а декоративный слой обязан завершаться.
  currentGlobals.__gvCurrentDm = 'dm-1';
  currentGlobals.__gvReducedMotion = false;
  const feed = document.createElement('div'); feed.className = 'messages'; document.body.append(feed);
  await mount(Layer);
  try {
    await emitBig('missing');
    assert.equal(host!.querySelector('.big-react'), null, 'отсутствующий data-mid не создаёт пустой эффект');
    addMessage('present');
    await emitBig('present');
    assert.ok(host!.querySelector('.big-react'), 'эффект появляется только у существующего сообщения');
    assert.equal(nextTimeouts.size, 1, 'анимация зарегистрировала одно удаление');
    currentGlobals.__gvReducedMotion = true;
    await emitBig('present');
    assert.equal(host!.querySelectorAll('.big-react').length, 1, 'reduced-motion не добавляет новый эффект');
    await advanceTimeouts(2049);
    assert.ok(host!.querySelector('.big-react'), 'до cleanup-границы эффект остаётся');
    await advanceTimeouts(2050);
    assert.equal(host!.querySelector('.big-react'), null, 'после 2 с анимации и 50 мс страховки эффект удалён');
  } finally {
    await unmount(); feed.remove();
    currentGlobals.__gvCurrentDm = null; currentGlobals.__gvReducedMotion = false;
    nextTimeouts.clear(); timeoutClock = 0;
  }
});

afterEach(async () => {
  await unmount();
  frames.clear(); clock = 0;
});

after(async () => {
  window.setTimeout = originalWindowTimeout;
  window.clearTimeout = originalWindowClearTimeout;
  window.requestAnimationFrame = originalWindowRaf;
  window.cancelAnimationFrame = originalWindowCancelRaf;
  Object.assign(globalThis, { requestAnimationFrame: originalRaf, cancelAnimationFrame: originalCancelRaf });
  Object.defineProperty(performance, 'now', { configurable: true, value: originalNow });
  if (window.performance !== performance) Object.defineProperty(window.performance, 'now', { configurable: true, value: originalWindowNow });
  await server?.close();
  GlobalRegistrator.unregister();
});
