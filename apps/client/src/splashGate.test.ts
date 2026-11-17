import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('./splashGate.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
type Options = {
  bridge?: 'none' | 'no-core'; active?: unknown;
  listen?: 'missing' | 'reject' | 'late' | 'already-finished';
  invoke?: (call: number) => Promise<unknown>;
};
function fixture(options: Options = {}) {
  let active = Object.hasOwn(options, 'active') ? options.active : true;
  let calls = 0, touches = 0, unsubscribes = 0, settled = 0;
  let event: (() => void) | undefined, late: ((off: () => void) => void) | undefined;
  const timers = new Map<number, () => void>();
  const off = () => { unsubscribes++; event = undefined; };
  const core = { invoke: async () => {
    calls++;
    return options.invoke ? options.invoke(calls) : active;
  } };
  const listen = async (_name: string, callback: () => void) => {
    if (options.listen === 'reject') throw new Error('subscription unavailable');
    if (options.listen === 'already-finished') active = false;
    event = callback;
    if (options.listen === 'late') return new Promise<() => void>(resolve => { late = resolve; });
    return off;
  };
  const window = options.bridge === 'none' ? {} : { __TAURI__: {
    ...(options.bridge === 'no-core' ? {} : { core }),
    ...(options.listen === 'missing' ? {} : { event: { listen } }),
  } };
  const deps: Record<string, unknown> = {
    './config': { activeInstanceId: () => 'home' },
    './voiceSession': { touchVoiceSession: () => { touches++; } },
    './updater': { updateLog() {} },
  };
  const module = { exports: {} as typeof import('./splashGate') };
  runInNewContext(code, {
    module, exports: module.exports, window, require: (name: string) => deps[name],
    setInterval: (callback: () => void) => { timers.set(1, callback); return 1; },
    clearInterval: (id: number) => { timers.delete(id); },
  });
  return {
    start: (keepAlive?: () => void) => {
      const promise = module.exports.afterSplash(keepAlive);
      void promise.then(() => { settled++; });
      return promise;
    },
    tick: async () => { for (const callback of [...timers.values()]) callback(); await flush(); },
    finish: () => event?.(), late: () => late?.(off), deactivate: () => { active = false; },
    counts: () => ({ touches, unsubscribes, settled, timers: timers.size }),
  };
}

it('без активной заставки ожидание завершается сразу и ничего не продлевает', async () => {
  for (const options of [
    { bridge: 'none' }, { bridge: 'no-core' }, { active: false }, { active: 'true' },
    { active: 1 }, { active: null }, { active: undefined },
    { invoke: async () => { throw new Error('bridge unavailable'); } },
  ] satisfies Options[]) {
    const h = fixture(options);
    let keepAlive = 0;
    await h.start(() => { keepAlive++; });
    assert.equal(keepAlive, 0);
    assert.deepEqual(h.counts(), { touches: 0, unsubscribes: 0, settled: 1, timers: 0 });
  }
  // Сам gate не имеет права продлевать произвольную сохранённую сессию без допуска App.
  const h = fixture();
  const pending = h.start(); await flush();
  await h.tick();
  assert.equal(h.counts().touches, 0);
  h.finish(); await pending;
});

it('активная заставка вызывает только переданный lease и событие освобождает ресурсы один раз', async () => {
  for (const mode of [undefined, 'late'] as const) {
    const h = fixture({ listen: mode });
    let keepAlive = 0;
    const pending = h.start(() => { keepAlive++; }); await flush();
    assert.equal(h.counts().settled, 0);
    await h.tick(); await h.tick();
    assert.equal(keepAlive, 2);
    assert.equal(h.counts().touches, 0);
    h.finish(); h.finish(); await pending;
    h.late(); await flush();
    assert.equal(h.counts().unsubscribes, 1);
    assert.equal(h.counts().timers, 0);
    await h.tick();
    assert.equal(keepAlive, 2);
  }
});

it('опрос завершает ожидание при потере события или ошибке IPC, гонка с событием безопасна', async () => {
  for (const listen of ['missing', 'reject', 'already-finished'] as const) {
    const h = fixture({ listen });
    const pending = h.start(); await flush();
    h.deactivate(); await h.tick(); await pending;
    assert.equal(h.counts().settled, 1);
    assert.equal(h.counts().timers, 0);
  }
  const failed = fixture({ invoke: async call => {
    if (call === 1) return true;
    throw new Error('poll unavailable');
  } });
  const failure = failed.start(); await flush(); await failed.tick(); await failure;
  assert.equal(failed.counts().unsubscribes, 1);

  let resolve!: (value: boolean) => void;
  const response = new Promise<boolean>(done => { resolve = done; });
  const h = fixture({ invoke: async call => call === 1 ? true : response });
  const pending = h.start(); await flush(); await h.tick();
  h.finish(); await pending;
  resolve(false); await flush();
  assert.deepEqual(h.counts(), { touches: 0, unsubscribes: 1, settled: 1, timers: 0 });
});
