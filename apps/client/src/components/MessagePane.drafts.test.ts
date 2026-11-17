import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessagePort } from 'node:worker_threads';
import { it, after, before } from 'node:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createServer, type ViteDevServer } from 'vite';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import type { ConvSummary } from '@gusvoice/shared';
import { createConvActions, type ConvDeps, type ConvHost } from '../convStore';
import { emptyConvState, updateDrafts, type ConvChangeEvent } from '../convSyncRules';
import type { Props } from './MessagePane.behavior.harness';
import type { MessagePane } from './MessagePane';

const P = 'R369/pane/check/';
const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
const activeHandles = () => (process as unknown as { _getActiveHandles(): object[] })._getActiveHandles();
const oldHandles = new Set(activeHandles());
let runtime: ViteDevServer | undefined, Pane: typeof MessagePane, registered = false;
const restoredGlobals: Array<[object, string, PropertyDescriptor | undefined]> = [];

async function bounded<T>(label: string, work: () => Promise<T>, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
      timer = nativeSet(() => reject(new Error(`R369/pane/timeout/${label}`)), ms);
    })]);
  } finally { if (timer) nativeClear(timer); }
}
function budget() {
  const counts = new Map<string, number>(); let failure: Error | undefined;
  return {
    step(kind: string) {
      const count = (counts.get(kind) ?? 0) + 1; counts.set(kind, count);
      if (count > 200) { failure = new Error(`R369/pane/budget/${kind}`); throw failure; }
    },
    check() { if (failure) throw failure; },
  };
}
type Budget = ReturnType<typeof budget>;
type Edit = { from: string; to: string };
async function openRuntime(edit?: Edit) {
  // Тот же шов, что MessagePane.behavior.harness: целый Vite SSR-граф, без env-файла/сервера/наблюдателя.
  return bounded('createServer', () => createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false,
    cacheDir: mkdtempSync(join(tmpdir(), 'gusvoice-drafts-test-')), optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{ name: 'bounded-draft-counterfact', enforce: 'pre', transform(code, id) {
      if (!edit || !id.replaceAll('\\', '/').endsWith('/components/MessagePane.tsx')) return;
      code = code.replace(/\r\n/g, '\n');
      if (code.split(edit.from).length !== 2) throw new Error('R369/pane/setup/неединственный-якорь');
      return code.replace(edit.from, edit.to);
    } }],
    esbuild: { jsx: 'automatic' }, resolve: { alias: {
      '@gusvoice/shared': fileURLToPath(new URL('../../../../packages/shared/src/index.ts', import.meta.url)),
    } }, server: { middlewareMode: true, hmr: false, watch: null, ws: false }, appType: 'custom', logLevel: 'error',
  }));
}
async function loadPane(server: ViteDevServer): Promise<typeof MessagePane> {
  const mod = await bounded('ssrLoadModule', () => server.ssrLoadModule('/src/components/MessagePane.tsx'));
  if (typeof mod.MessagePane !== 'function') throw new Error('R369/pane/setup/нет-MessagePane');
  return mod.MessagePane;
}
before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' }); registered = true;
  class ClosedSocket { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} }
  for (const target of [globalThis, window]) {
    for (const [name, value] of Object.entries({ IS_REACT_ACT_ENVIRONMENT: true, WebSocket: ClosedSocket,
      fetch: async () => new Response(null, { status: 503 }) })) {
      restoredGlobals.push([target, name, Object.getOwnPropertyDescriptor(target, name)]);
      Object.defineProperty(target, name, { configurable: true, writable: true, value });
    }
  }
  runtime = await openRuntime(); Pane = await loadPane(runtime);
}, { timeout: 40_000 });
after(async () => {
  try { if (runtime) await bounded('Vite.close', () => runtime!.close()); }
  finally {
    try { if (registered) await bounded('HappyDOM.abort', () => (window as unknown as { happyDOM: { abort(): Promise<void> } }).happyDOM.abort()); }
    finally {
      try {
        for (const [target, name, descriptor] of restoredGlobals.reverse()) {
          if (descriptor) Object.defineProperty(target, name, descriptor); else Reflect.deleteProperty(target, name);
        }
        if (registered) await bounded('unregister', () => GlobalRegistrator.unregister());
      }
      finally {
        for (const handle of activeHandles()) if (!oldHandles.has(handle) && handle instanceof MessagePort) handle.unref();
      }
    }
  }
}, { timeout: 50_000 });

async function turns(guard: Budget) { for (let i = 0; i < 8; i++) { guard.step('work'); await Promise.resolve(); } }
function uiClock(guard: Budget) {
  let time = 0, next = -1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const saved: Array<[object, string, PropertyDescriptor | undefined]> = [];
  for (const target of [globalThis, window]) {
    const set = target.setTimeout.bind(target), clear = target.clearTimeout.bind(target);
    for (const [name, value] of Object.entries({
      setTimeout(handler: TimerHandler, ms?: number, ...args: unknown[]) {
        guard.step('timers');
        if (typeof handler === 'function' && ms === 300) {
          const id = next--; timers.set(id, { at: time + ms, run: () => handler(...args) }); return id;
        }
        return set(handler as () => void, ms, ...args);
      },
      clearTimeout(id: unknown) {
        if (typeof id === 'number' && timers.delete(id)) return;
        clear(id as never);
      },
      fetch: async () => { guard.step('IO'); return new Response(null, { status: 503 }); },
    })) {
      saved.push([target, name, Object.getOwnPropertyDescriptor(target, name)]);
      Object.defineProperty(target, name, { configurable: true, writable: true, value });
    }
  }
  return {
    async advance(ms: number) {
      time += ms;
      await act(async () => {
        for (let turn = 0; turn < 200; turn++) {
          const entry = [...timers].find(([, timer]) => timer.at <= time); if (!entry) break;
          guard.step('timer-work'); timers.delete(entry[0]); entry[1].run();
        }
        if ([...timers.values()].some(timer => timer.at <= time)) throw new Error('R369/pane/budget/UI-timer-pump');
        await turns(guard);
      });
      guard.check();
    },
    pending: () => timers.size,
    restore() {
      timers.clear();
      for (const [target, name, descriptor] of saved.reverse()) {
        if (descriptor) Object.defineProperty(target, name, descriptor); else Reflect.deleteProperty(target, name);
      }
    },
  };
}
type Scene = {
  changed: Array<[string, string | null]>; order: string[]; clock: ReturnType<typeof uiClock>;
  value(): string; remote(text: string, rev: number): Promise<void>; type(text: string): Promise<void>; leave(): Promise<void>;
};
async function scene(component: typeof MessagePane, check: (scene: Scene) => Promise<void>, options: {
  changed?: (text: string, replyToId: string | null) => void; left?: () => void; guard?: Budget;
} = {}) {
  const guard = options.guard ?? budget(), clock = uiClock(guard), host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); let mounted = true;
  const changed: Scene['changed'] = [], order: string[] = [];
  let props: Props = { title: 'Беседа', placeholder: 'Написать', messages: [], meId: 'member-one', feedId: 'chat-one',
    onSend: async () => {}, onEdit: async () => {}, onDelete: async () => {}, draft: { text: '', replyToId: null },
    draftRemote: { text: '', replyToId: null, rev: 0 },
    onDraftChange(text, replyToId) {
      guard.step('IO'); changed.push([text, replyToId]); order.push(`change:${text}`); options.changed?.(text, replyToId);
    },
    onDraftLeave() { guard.step('IO'); order.push('leave'); options.left?.(); },
  };
  // Direct call сохраняет настоящие hooks/handlers; счётчик видит и внутренние setState-рендеры MessagePane.
  function BoundedPane(p: Props) { guard.step('render'); return component(p); }
  const render = async () => { guard.step('updates'); await act(async () => { root.render(createElement(BoundedPane, props)); await turns(guard); }); guard.check(); };
  const field = () => {
    const fields = host.querySelectorAll<HTMLTextAreaElement>('.composer textarea');
    assert.equal(fields.length, 1, 'R369/pane/setup/настоящее-поле'); return fields[0];
  };
  const leave = async () => { if (!mounted) return; mounted = false; guard.step('updates'); await act(async () => { root.unmount(); await turns(guard); }); guard.check(); };
  try {
    await render();
    await check({ changed, order, clock, value: () => field().value, leave,
      remote: async (text, rev) => { props = { ...props, draftRemote: { text, replyToId: null, rev } }; await render(); },
      type: async text => {
        guard.step('events'); await act(async () => { Simulate.change(field(), { target: { value: text } as unknown as EventTarget }); await turns(guard); }); guard.check();
      },
    });
  } finally { try { await leave(); } finally { host.remove(); clock.restore(); } }
}

async function quiet(component = Pane) {
  await scene(component, async s => {
    await s.remote('с телефона', 1); assert.equal(s.value(), 'с телефона', P + 'нетронутое-принимает-remote');
    await s.clock.advance(300);
    assert.equal(s.changed.length, 0, P + 'remote-не-эхо');
    await s.remote('', 2); assert.equal(s.value(), '', P + 'удалённое-не-воскресает');
    await s.clock.advance(300); assert.equal(s.changed.length, 0, P + 'очистка-remote-не-эхо');
    await s.leave(); assert.equal(s.order.join('|'), 'leave', P + 'нетронутое-только-leave');
  });
}
async function typed(component = Pane) {
  await scene(component, async s => {
    await s.type('мой текст'); await s.remote('чужое пока pending', 1);
    assert.equal(s.value(), 'мой текст', P + 'pending-не-затирается');
    await s.clock.advance(300); assert.equal(s.clock.pending(), 0, 'R369/pane/setup/debounce-завершён');
    assert.equal(s.changed.map(value => value[0]).join('|'), 'мой текст', P + 'набор-отдан');
    await s.remote('чужое после debounce', 2);
    assert.equal(s.value(), 'мой текст', P + 'typed-после-debounce-не-затирается');
    // Пустое, но уже тронутое поле — тоже местная правка, не разрешение воскресить удалённое.
    await s.type(''); await s.clock.advance(300);
    assert.equal(s.changed.at(-1)?.[0], '', P + 'местная-очистка-отдана');
    await s.remote('старое стёртое', 3);
    assert.equal(s.value(), '', P + 'тронутое-пустое-не-воскресает');
  });
}
async function cleanup(component = Pane, debounced = false) {
  await scene(component, async s => {
    await s.type('старое'); await s.type('последнее');
    if (debounced) { await s.clock.advance(300); s.order.length = 0; }
    await s.remote('другой черновик в сторе', 1);
    await s.leave();
    assert.equal(s.order.join('|'), 'change:последнее|leave', P + 'последнее-flush-перед-leave');
    assert.equal(s.clock.pending(), 0, P + 'уход-не-оставляет-таймер');
  });
}
it('R369 MessagePane принимает remote в нетронутое поле без onDraftChange и без эха при уходе', { timeout: 15_000 }, () => quiet());
it('R369 MessagePane не отдаёт тронутое поле новому rev ни до, ни после debounce', { timeout: 15_000 }, () => typed());
it('R369 MessagePane на unmount отдаёт последнее набранное и flush до leave, включая уже отданное debounce', { timeout: 15_000 }, async () => {
  await cleanup(); await cleanup(Pane, true);
});

for (const [title, edit, check, address, actual, expected] of [
  ['убранного quiet', { from: '    if (!draftTyped.current && quiet && quiet.text === v.text && quiet.replyToId === v.replyToId) return;', to: '' }, quiet, P + 'remote-не-эхо', 1, 0],
  ['убранного typed', { from: '    if (draftTyped.current) return;', to: '' }, typed, P + 'typed-после-debounce-не-затирается', 'чужое после debounce', 'мой текст'],
  ['leave раньше flush', { from: '  useEffect(() => () => draftSaver.flush(), [draftSaver]);\n  useEffect(() => () => onDraftLeaveRef.current?.(), []);',
    to: '  useEffect(() => () => onDraftLeaveRef.current?.(), []);\n  useEffect(() => () => draftSaver.flush(), [draftSaver]);' }, cleanup, P + 'последнее-flush-перед-leave', 'leave|change:последнее', 'change:последнее|leave'],
] as const) {
  it(`R369 MessagePane контрфакт ${title} отвергается адресным поведением`, { timeout: 45_000 }, async () => {
    await check(Pane);
    await counterfact(async () => {
      const extra = await openRuntime(edit);
      try {
        const mutant = await loadPane(extra); // Подготовка вне assert.rejects, watchdog/setup не kill.
        await assert.rejects(() => bounded('сценарий-мутанта', () => check(mutant)), error => error instanceof assert.AssertionError
          && error.message.startsWith(address) && error.operator === 'strictEqual'
          && error.actual === actual && error.expected === expected, 'мутант нарушает адресный контракт, не setup/бюджет');
      } finally { await bounded('mutant.close', () => extra.close()); }
    }, { timeoutMs: 60000 });
    await check(Pane);
  });
}

it('R369 два устройства: A печатает и очищает при уходе, настоящий MessagePane B не шлёт черновик обратно', { timeout: 20_000 }, async () => {
  const guard = budget(); let now = 1_000, nextTimer = 0, pts = 0;
  const timers = new Map<number, { at: number; run: () => void }>(), queued: ConvChangeEvent[] = [];
  const calls: Array<{ device: string; text: string }> = [];
  const summary: ConvSummary = { id: 'chat-one', kind: 'direct', createdAt: '2026-10-01T00:00:00Z', lastMessageAt: null,
    lastMessage: null, unread: 0, lastReadKey: 0, otherUser: { id: 'member-two', username: 'member-two', displayName: 'Участник', avatarUrl: null } };
  function device(name: string) {
    let state: ConvHost = { conv: { ...emptyConvState(), pts: 0, phase: 'live' }, convActive: true, dms: [], dmMessages: {},
      unreadDms: [], historyFailed: [], currentDmId: 'chat-one', view: 'dm', mobilePane: 'content', outbox: {}, drafts: {}, draftDirty: [], draftRev: {} };
    let changes = 0;
    const forbidden = () => { throw new Error('R369/two/setup/неожиданный-API'); };
    const api = new Proxy({ convDraft: async (_id: string, body: { text: string; replyToId: string | null; device?: string }) => {
      guard.step('API'); calls.push({ device: name, text: body.text });
      queued.push({ pts: ++pts, conversation: { ...summary,
        draft: body.text || body.replyToId ? { ...body, device: body.device ?? name, at: new Date(now).toISOString() } : null } });
    } }, { get(target, key) { return Object.hasOwn(target, key) ? target[key as keyof typeof target] : forbidden; } });
    const actions = createConvActions(patch => { guard.step('store-updates'); state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; }, () => state, {
      api: api as unknown as ConvDeps['api'], now: () => now, draftsOnServer: () => true, draftDevice: name,
      setTimeout(run, ms) { guard.step('store-timers'); timers.set(++nextTimer, { at: now + ms, run }); return nextTimer; },
      clearTimeout(id) { timers.delete(id as number); }, onOnline() {}, isMobile: () => false, markChannelSeen() {},
    });
    return { actions, get: () => state, changes: () => changes, change(text: string, replyToId: string | null = null) {
      const drafts = updateDrafts(state.drafts, 'chat-one', text, replyToId);
      if (drafts === state.drafts) return;
      state = { ...state, drafts }; changes++; guard.step('convDraftChanged'); actions.convDraftChanged('chat-one');
    } };
  }
  const A = device('device-A'), B = device('device-B');
  const advance = async (ms: number) => {
    now += ms;
    for (let turn = 0; turn < 200; turn++) {
      const entry = [...timers].find(([, task]) => task.at <= now); if (!entry) break;
      guard.step('store-work'); timers.delete(entry[0]); entry[1].run(); await turns(guard);
    }
    if ([...timers.values()].some(task => task.at <= now)) throw new Error('R369/two/budget/timer-pump');
    await turns(guard); guard.check();
  };
  try {
    await scene(Pane, async s => {
      const deliver = async () => {
        for (const event of queued.splice(0)) {
          guard.step('delivery'); A.actions.convOnChange(event, false); B.actions.convOnChange(event, false);
          await s.remote(B.get().drafts['chat-one']?.text ?? '', B.get().draftRev?.['chat-one'] ?? 0);
        }
      };
      A.change('текст с A'); await advance(14_000); await deliver();
      assert.equal(s.value(), 'текст с A', P + 'B-получил-A');
      await s.clock.advance(300);
      assert.equal(s.changed.length, 0, P + 'B-не-вызывает-onDraftChange');
      assert.equal(B.changes(), 0, P + 'B-не-зовёт-convDraftChanged');
      await advance(14_000);
      assert.equal(calls.filter(call => call.device === 'device-B').length, 0, P + 'B-не-зовёт-api-convDraft');
      A.change(''); A.actions.convDraftLeave('chat-one'); await advance(0); await deliver();
      assert.equal(s.value(), '', P + 'B-получил-очистку-A');
      await s.clock.advance(300); await advance(14_000);
      assert.equal(s.value(), '', P + 'B-пусто-и-не-воскресает');
      assert.equal(s.changed.length, 0, P + 'очистка-B-не-вызывает-onDraftChange');
      assert.equal(B.changes(), 0, P + 'очистка-B-не-становится-набором');
      await s.leave(); await advance(0);
      assert.equal(s.changed.length, 0, P + 'уход-B-тоже-не-эхо');
      assert.equal(calls.map(call => `${call.device}:${call.text}`).join('|'), 'device-A:текст с A|device-A:', P + 'сервер-получил-только-два-изменения-A');
    }, { guard, changed: B.change, left: () => B.actions.convDraftLeave('chat-one') });
  } finally { A.actions.convReset(); B.actions.convReset(); timers.clear(); guard.check(); }
});
