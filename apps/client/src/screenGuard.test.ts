import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./screenGuard.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type BridgeWindow = {
  GusVoiceNative?: { setSecure?: (on: boolean) => void };
  __TAURI__?: { window?: { getCurrentWindow?: () => { setContentProtected?: (on: boolean) => Promise<void> } } };
};

// Исполняется весь production-модуль; каждый экземпляр имеет собственный настоящий holders.
function load(window: BridgeWindow, text = source): typeof import('./screenGuard') {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, window });
  return module.exports as typeof import('./screenGuard');
}

function refcount(text = source): void {
  const calls: boolean[] = [];
  const { protectScreen } = load({ GusVoiceNative: { setSecure: on => { calls.push(on); } } }, text);
  const first = protectScreen();
  const second = protectScreen();
  assert.deepEqual(calls, [true], 'R262:два-просмотра-включают-защиту-один-раз');
  first();
  assert.deepEqual(calls, [true], 'R262:первый-выход-не-снимает-защиту-второго');
  first();
  assert.deepEqual(calls, [true], 'R262:повторный-выход-не-уменьшает-чужой-счётчик');
  second();
  second();
  assert.deepEqual(calls, [true, false], 'R262:последний-выход-снимает-защиту-один-раз');
  const third = protectScreen();
  assert.deepEqual(calls, [true, false, true], 'новый просмотр после всех выходов снова защищён');
  third();
  assert.deepEqual(calls, [true, false, true, false]);
}

it('R262 Android: два просмотра не снимают защиту друг у друга, повторный release безопасен', () => refcount());

it('R262 Tauri: защищается текущее окно, последний выход возвращает обычный режим', async () => {
  const calls: boolean[] = [];
  let windows = 0;
  const { protectScreen } = load({ __TAURI__: { window: { getCurrentWindow: () => {
    windows++;
    return { setContentProtected: async on => { calls.push(on); } };
  } } } });
  const release = protectScreen();
  assert.deepEqual(calls, [true]);
  release();
  await Promise.resolve();
  assert.deepEqual(calls, [true, false]);
  assert.equal(windows, 2, 'защита обращается к текущему окну на включение и выключение');
});

it('R262 браузер и старые оболочки без методов не ломают просмотр и повторное закрытие', () => {
  for (const window of [{}, { GusVoiceNative: {} }, { __TAURI__: {} }, { __TAURI__: { window: {} } },
    { __TAURI__: { window: { getCurrentWindow: () => ({}) } } }]) {
    const { protectScreen } = load(window);
    assert.doesNotThrow(() => { const release = protectScreen(); release(); release(); });
  }
});

it('R262 отказ Android не мешает защите Tauri и последующему освобождению', () => {
  const calls: boolean[] = [];
  const { protectScreen } = load({
    GusVoiceNative: { setSecure: () => { throw new Error('старая оболочка'); } },
    __TAURI__: { window: { getCurrentWindow: () => ({ setContentProtected: async on => { calls.push(on); } }) } },
  });
  assert.doesNotThrow(() => protectScreen()());
  assert.deepEqual(calls, [true, false]);
});

it('R262 отказ Tauri синхронно или Promise rejection перехвачен и не ломает следующий просмотр', async () => {
  for (const fail of ['get', 'set', 'promise']) {
    const calls: boolean[] = [];
    let errors = 0;
    const { protectScreen } = load({
      GusVoiceNative: { setSecure: on => { calls.push(on); } },
      __TAURI__: { window: { getCurrentWindow: () => {
        if (fail === 'get') { errors++; throw new Error('нет окна'); }
        return { setContentProtected: () => {
          errors++;
          if (fail === 'set') throw new Error('нет права');
          return Promise.reject(new Error('permission denied'));
        } };
      } } },
    });
    assert.doesNotThrow(() => { protectScreen()(); protectScreen()(); });
    await Promise.resolve();
    assert.equal(errors, 4);
    assert.deepEqual(calls, [true, false, true, false]);
  }
});

for (const [label, anchor, replacement, failure] of [
  ['раннее снятие защиты', 'if (holders === 0) apply(false);', 'apply(false);', 'R262:первый-выход-не-снимает'],
  ['повторный release расходует чужой счётчик', 'if (done) return;', '', 'R262:повторный-выход-не-уменьшает'],
] as const) {
  it(`R262 контрфакт screenGuard: ${label}`, () => {
    refcount();
    assert.equal(source.split(anchor).length - 1, 1, 'уникальная production-мутация');
    assert.throws(() => refcount(source.replace(anchor, replacement)), error =>
      error instanceof assert.AssertionError && error.message.includes(failure));
  });
}
