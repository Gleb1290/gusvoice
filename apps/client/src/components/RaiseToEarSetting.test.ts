import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, after, it } from 'node:test';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';

const settingSource = readFileSync(new URL('./RaiseToEarSetting.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const nativeSource = readFileSync(new URL('../nativeRaiseToEar.ts', import.meta.url), 'utf8');
const toggleSource = readFileSync(new URL('./Toggle.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
before(() => { GlobalRegistrator.register({ url: 'http://localhost/' }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(() => GlobalRegistrator.unregister());
type Native = typeof import('../nativeRaiseToEar');
type Mode = 'supported' | 'missing-bridge' | 'missing-set' | 'missing-supported' | 'no-sensor' | 'web' | 'throws';
function load<T>(source: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, window, ...globals,
    require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `объявленный импорт целого компонента или native-модуля: ${id}`); return dependencies[id]; },
  }); return module.exports as T;
}
async function fixture(mode: Mode, initial: string | null, work: (f: {
  host: HTMLElement; native: Native; values: Map<string, string>; writes: string[][]; calls: boolean[];
}) => Promise<void>, source = settingSource, toggle = toggleSource) {
  const savedBridge = Object.getOwnPropertyDescriptor(window, 'GusVoiceNative');
  const values = new Map<string, string>(initial === null ? [] : [['gv.raiseToEar', initial]]);
  const writes: string[][] = [], calls: boolean[] = [];
  const bridge = {
    ...(mode === 'missing-supported' ? {} : { raiseToEarSupported: () => {
      if (mode === 'throws') throw new Error('sensor-unavailable');
      return mode !== 'no-sensor';
    } }),
    ...(mode === 'missing-set' ? {} : { raiseToEarSet: (on: boolean) => calls.push(on) }),
  };
  if (mode === 'missing-bridge') Reflect.deleteProperty(window, 'GusVoiceNative');
  else Object.defineProperty(window, 'GusVoiceNative', { configurable: true, value: bridge });
  const native = load<Native>(nativeSource, { react: React, './hotkeys': { isAndroid: () => mode !== 'web' } }, {
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); writes.push([key, value]); } },
    console: { warn: () => {} },
  });
  const Toggle = load<typeof import('./Toggle')>(toggle, { 'react/jsx-runtime': jsx });
  const Setting = load<typeof import('./RaiseToEarSetting')>(source, {
    'react/jsx-runtime': jsx, '../nativeRaiseToEar': native, './Toggle': Toggle,
  }).RaiseToEarSetting;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => { root.render(React.createElement(Setting)); });
    await work({ host, native, values, writes, calls });
  } finally {
    await React.act(async () => root.unmount()); host.remove();
    if (savedBridge) Object.defineProperty(window, 'GusVoiceNative', savedBridge); else Reflect.deleteProperty(window, 'GusVoiceNative');
  }
}
async function unavailable(mode: Exclude<Mode, 'supported'>, source = settingSource) {
  await fixture(mode, null, async f => {
    assert.equal(!!f.host.querySelector('[role="switch"]'), false, 'R216-setting-availability: неподдержанное устройство не показывает переключатель');
    assert.equal(f.host.childElementCount, 0, 'без моста или датчика компонент возвращает null целиком');
    assert.equal(JSON.stringify(f.calls), '[]', 'скрытая настройка не управляет аудиомаршрутом');
    assert.equal(JSON.stringify(f.writes), '[]', 'скрытая настройка не перезаписывает пользовательское предпочтение');
  }, source);
}
async function clicks(source = settingSource, toggle = toggleSource) {
  await fixture('supported', null, async f => {
    const button = f.host.querySelector<HTMLButtonElement>('[role="switch"]');
    assert.ok(button, 'реальные Setting и Toggle показывают переключатель');
    const label = button.getAttribute('aria-labelledby');
    assert.equal(label ? f.host.querySelector(`#${label}`)?.textContent : null, 'Поднести к уху', 'переключатель имеет настоящее доступное имя');
    assert.equal(button.getAttribute('aria-checked'), 'true', 'отсутствующее предпочтение по умолчанию включено');
    await React.act(async () => { button.click(); });
    assert.equal(f.native.getRaiseToEarPref(), false, 'R216-setting-click: настоящий Toggle передаёт противоположное предпочтение');
    assert.equal(button.getAttribute('aria-checked'), 'false', 'реальная подписка preference обновляет разметку');
    assert.equal(f.values.get('gv.raiseToEar'), '0', 'первое нажатие пишет реальный формат выключения');
    await React.act(async () => { button.click(); });
    assert.equal(f.native.getRaiseToEarPref(), true, 'второе нажатие вновь включает предпочтение');
    assert.equal(button.getAttribute('aria-checked'), 'true');
    assert.equal(JSON.stringify(f.writes), '[["gv.raiseToEar","0"],["gv.raiseToEar","1"]]', 'оба клика проходят через настоящий setRaiseToEarPref');
    assert.equal(JSON.stringify(f.calls), '[]', 'настройка меняет предпочтение, а не сама захватывает датчик');
  }, source, toggle);
}
it('R216 настройка поддержанного Android имеет switch Поднести к уху и два клика меняют реальное предпочтение', () => clicks());
it('R216 сохранённое выключение отражается в switch, первый клик включает его', async () => {
  await fixture('supported', '0', async f => {
    const button = f.host.querySelector<HTMLButtonElement>('[role="switch"]'); assert.ok(button);
    assert.equal(button.getAttribute('aria-checked'), 'false');
    await React.act(async () => { button.click(); });
    assert.equal(button.getAttribute('aria-checked'), 'true');
    assert.equal(f.values.get('gv.raiseToEar'), '1');
  });
});
for (const [mode, label] of [
  ['missing-bridge', 'нет моста'], ['missing-set', 'нет метода переключения'], ['missing-supported', 'нет метода проверки датчика'],
  ['no-sensor', 'нет датчика'], ['web', 'это не Android'], ['throws', 'датчик бросил исключение'],
] as const) it(`R216 настройка возвращает null: ${label}`, () => unavailable(mode));
it('R216 внешняя смена предпочтения через настоящий native-модуль обновляет переключатель', async () => {
  await fixture('supported', null, async f => {
    const button = f.host.querySelector<HTMLButtonElement>('[role="switch"]'); assert.ok(button);
    await React.act(async () => { f.native.setRaiseToEarPref(false); });
    assert.equal(button.getAttribute('aria-checked'), 'false');
    await React.act(async () => { f.native.setRaiseToEarPref(true); });
    assert.equal(button.getAttribute('aria-checked'), 'true');
  });
});
it('R216 настройка контрфакт: отсутствие датчика ошибочно показывает switch', async () => {
  await unavailable('no-sensor', settingSource);
  const from = 'if (!raiseToEarSupported()) return null;';
  assert.equal(settingSource.split(from).length - 1, 1, 'один якорь поддержки в целом компоненте');
  await assert.rejects(unavailable('no-sensor', settingSource.replace(from, '')), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith('R216-setting-availability:') && error.operator === 'strictEqual' && error.actual === true && error.expected === false);
});
it('R216 настройка контрфакт: Toggle возвращает прежнее значение вместо противоположного', async () => {
  await clicks(settingSource, toggleSource);
  const from = 'onChange(!checked)';
  assert.equal(toggleSource.split(from).length - 1, 1, 'один якорь инверсии настоящего Toggle');
  await assert.rejects(clicks(settingSource, toggleSource.replace(from, 'onChange(checked)')), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith('R216-setting-click:') && error.operator === 'strictEqual' && error.actual === true && error.expected === false);
});
