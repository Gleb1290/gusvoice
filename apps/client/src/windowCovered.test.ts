import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

type Callback = (event: { payload: unknown }) => void;

const classes = new Set<string>();
const callbacks = new Map<string, Callback>();
const removed: string[] = [];
const initial = new Map<string, unknown>([
  ['gv_window_covered', false],
  ['gv_game_foreground', true],
]);

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Windows' },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    documentElement: {
      classList: {
        toggle(name: string, force: boolean) {
          if (force) classes.add(name);
          else classes.delete(name);
        },
      },
    },
  },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    __TAURI_INTERNALS__: {},
    __TAURI__: {
      event: {
        async listen(name: string, cb: Callback) {
          callbacks.set(name, cb);
          return () => { removed.push(name); };
        },
      },
      core: {
        async invoke(name: string) {
          if (name === 'gv_game_foreground_unsupported') throw new Error('old shell');
          return initial.get(name);
        },
      },
    },
  },
});

const { isGameForeground, isWindowCovered, watchWindowCovered } = await import('./windowCovered.js');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('признаки перекрытого окна и игры', () => {
  it('начальные ответы и события ставят классы, а отписка снимает оба', async () => {
    // Ловит потерю начального состояния после reload и вечную заморозку после размонтирования.
    const stop = watchWindowCovered();
    await flush();
    assert.equal(isWindowCovered(), false);
    assert.equal(isGameForeground(), true);
    assert.equal(classes.has('gv-game-fg'), true);
    callbacks.get('gv://covered')?.({ payload: true });
    callbacks.get('gv://game-foreground')?.({ payload: false });
    assert.equal(isWindowCovered(), true);
    assert.equal(isGameForeground(), false);
    assert.equal(classes.has('gv-covered'), true);
    stop();
    assert.deepEqual(removed.sort(), ['gv://covered', 'gv://game-foreground']);
    assert.equal(isWindowCovered(), false);
    assert.equal(isGameForeground(), false);
    assert.deepEqual([...classes], []);
  });

  it('старая оболочка без команды игры не бросает исключение', async () => {
    // Ловит отказ запуска клиента после обновления веба раньше десктопной оболочки.
    const core = (globalThis.window as unknown as { __TAURI__: { core: { invoke: (name: string) => Promise<unknown> } } }).__TAURI__.core;
    const original = core.invoke;
    core.invoke = async (name) => name === 'gv_game_foreground' ? Promise.reject(new Error('unknown command')) : false;
    const stop = watchWindowCovered();
    await flush();
    assert.equal(isGameForeground(), false);
    stop();
    core.invoke = original;
  });
});
