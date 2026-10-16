import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, after, it } from 'node:test';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot, type Root } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';

const hostSource = readFileSync(new URL('./RaiseToEarHost.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const nativeSource = readFileSync(new URL('../nativeRaiseToEar.ts', import.meta.url), 'utf8');
before(() => { GlobalRegistrator.register({ url: 'http://localhost/' }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(() => GlobalRegistrator.unregister());
type Native = typeof import('../nativeRaiseToEar');
type Options = { bridge?: boolean; android?: boolean; supported?: boolean; paused?: boolean; track?: boolean; voice?: boolean; enabled?: boolean };
function load<T>(source: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, window, ...globals,
    require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `объявленный импорт целого RaiseToEar-модуля: ${id}`); return dependencies[id]; },
  }); return module.exports as T;
}

async function fixture(options: Options, work: (f: {
  calls: boolean[]; native: Native; host: HTMLElement; unmount(): Promise<void>;
  player(playing: boolean, track?: boolean): Promise<void>; voice(on: boolean): Promise<void>;
}) => Promise<void>, source = hostSource) {
  const savedBridge = Object.getOwnPropertyDescriptor(window, 'GusVoiceNative');
  const calls: boolean[] = [];
  const values = new Map<string, string>(options.enabled === false ? [['gv.raiseToEar', '0']] : []);
  const warnings: unknown[][] = [];
  if (options.bridge === false) Reflect.deleteProperty(window, 'GusVoiceNative');
  else Object.defineProperty(window, 'GusVoiceNative', { configurable: true, value: {
    raiseToEarSupported: () => options.supported !== false, raiseToEarSet: (on: boolean) => calls.push(on),
  } });
  const native = load<Native>(nativeSource, { react: React, './hotkeys': { isAndroid: () => options.android !== false } }, {
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    console: { warn: (...args: unknown[]) => warnings.push(args) },
  });
  let player = { playing: options.paused !== true, track: options.track === false ? null : { id: 'voice-message' } };
  let state = { voice: options.voice ? { channelId: 'voice-channel' } : null };
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
  const Host = load<typeof import('./RaiseToEarHost')>(source, {
    react: React, 'react/jsx-runtime': jsx, '../nativeRaiseToEar': native,
    // Источники IO: реальные snapshot-подписки React, без подмены wanted/support/preferences.
    '../voicePlayer': { useVoicePlayer: () => React.useSyncExternalStore(subscribe, () => player, () => player) },
    '../store': { useStore: (selector: (s: typeof state) => unknown) => selector(React.useSyncExternalStore(subscribe, () => state, () => state)) },
  }).RaiseToEarHost;
  const host = document.createElement('div'); document.body.append(host);
  let root: Root | null = createRoot(host);
  const unmount = async () => { const current = root; root = null; if (current) await React.act(async () => current.unmount()); };
  const emit = () => { for (const fn of [...listeners]) fn(); };
  try {
    await React.act(async () => { root!.render(React.createElement(Host)); });
    assert.equal(host.childElementCount, 0, 'Host управляет мостом без собственной разметки');
    await work({ calls, native, host, unmount,
      async player(playing, track = true) { await React.act(async () => { player = { playing, track: track ? { id: 'voice-message' } : null }; emit(); }); },
      async voice(on) { await React.act(async () => { state = { voice: on ? { channelId: 'voice-channel' } : null }; emit(); }); },
    });
    assert.equal(warnings.length, 0, 'штатные IO-границы не породили исключение моста');
  } finally {
    await unmount(); host.remove();
    if (savedBridge) Object.defineProperty(window, 'GusVoiceNative', savedBridge); else Reflect.deleteProperty(window, 'GusVoiceNative');
  }
}
const trace = (calls: boolean[], expected: string, message: string) => assert.equal(JSON.stringify(calls), expected, message);
async function pause(source = hostSource) {
  await fixture({}, async f => {
    trace(f.calls, '[true]', 'R216-host-playing: играющее голосовое включает датчик');
    await f.player(false);
    trace(f.calls, '[true,false]', 'R216-host-pause: пауза освобождает датчик, а не сохраняет маршрут у уха');
    await f.player(true);
    trace(f.calls, '[true,false,true]', 'возобновление того же голосового снова включает датчик');
  }, source);
}
async function cleanup(source = hostSource) {
  await fixture({}, async f => {
    trace(f.calls, '[true]', 'перед снятием Host датчик действительно включён');
    await f.unmount();
    trace(f.calls, '[true,false]', 'R216-host-cleanup: размонтирование выключает датчик и возвращает маршрут');
  }, source);
}
it('R216 Host включает датчик только на воспроизведении, пауза выключает, продолжение снова включает', () => pause());
it('R216 Host закрытие голосового выключает датчик, новое голосовое снова разрешает слушание', async () => {
  await fixture({}, async f => {
    await f.player(false, false); trace(f.calls, '[true,false]', 'закрытие убирает активный трек и освобождает датчик');
    await f.player(true); trace(f.calls, '[true,false,true]', 'новый трек не остаётся навсегда запрещённым');
  });
});
it('R216 Host выключенная реальная настройка освобождает датчик, включение возвращает его', async () => {
  await fixture({}, async f => {
    await React.act(async () => { f.native.setRaiseToEarPref(false); });
    trace(f.calls, '[true,false]', 'реальная смена предпочтения выключает активное слушание');
    await React.act(async () => { f.native.setRaiseToEarPref(true); });
    trace(f.calls, '[true,false,true]', 'подписка настоящего native-модуля поднимает слушание после включения');
  });
});
it('R216 Host вход в голосовой канал запрещает датчик, выход разрешает играющее голосовое', async () => {
  await fixture({}, async f => {
    await f.voice(true); trace(f.calls, '[true,false]', 'store.voice != null освобождает датчик перед звуком канала');
    await f.voice(false); trace(f.calls, '[true,false,true]', 'store.voice === null возвращает разрешение');
  });
});
for (const [label, options] of [
  ['нет моста', { bridge: false }], ['нет датчика', { supported: false }], ['не Android', { android: false }],
  ['уже подключён голосовой канал', { voice: true }], ['настройка заранее выключена', { enabled: false }],
] as const) it(`R216 Host не включает датчик: ${label}`, async () => {
  await fixture(options, async f => { trace(f.calls, '[]', 'неподдержанное или запрещённое состояние не вызывает raiseToEarSet'); });
});
it('R216 Host открытая пауза не включает датчик, начало воспроизведения включает', async () => {
  await fixture({ paused: true }, async f => {
    trace(f.calls, '[]', 'пауза при создании Host не выдаётся за воспроизведение');
    await f.player(true); trace(f.calls, '[true]', 'переход с паузы в playing принимается');
  });
});
it('R216 Host без трека не включает датчик даже при playing, появление трека принимается', async () => {
  await fixture({ track: false }, async f => {
    trace(f.calls, '[]', 'playing без track не захватывает датчик');
    await f.player(true); trace(f.calls, '[true]', 'настоящий трек разрешает слушание');
  });
});
it('R216 Host размонтирование активного слушания обязательно выключает мост', () => cleanup());
for (const [label, from, to, scenario, prefix] of [
  ['cleanup не освобождает датчик', 'return () => setRaiseToEar(false);', 'return () => {};', cleanup, 'R216-host-cleanup:'],
  ['пауза считается воспроизведением', 'playing: player.playing', 'playing: true', pause, 'R216-host-pause:'],
] as const) it(`R216 Host контрфакт: ${label}`, async () => {
  await scenario(hostSource);
  assert.equal(hostSource.split(from).length - 1, 1, 'единственный якорь в настоящем целом Host');
  await assert.rejects(scenario(hostSource.replace(from, to)), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith(prefix) && error.operator === 'strictEqual' && error.actual === '[true]' && error.expected === '[true,false]');
});
