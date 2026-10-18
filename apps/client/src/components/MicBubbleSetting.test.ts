import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { AudioSettings } from '../audioSettings';
import * as rules from '../micActionRules';

const source = readFileSync(new URL('./MicBubbleSetting.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const toggleSource = readFileSync(new URL('./Toggle.tsx', import.meta.url), 'utf8');
const defaults: AudioSettings = {
  inputDeviceId: '', outputDeviceId: '', cameraDeviceId: '', noiseSuppression: false, noiseFilter: 'off',
  echoCancellation: true, autoGainControl: true, pushToTalk: false, pttKey: 'Space', inputGain: 1,
  vadThreshold: .01, pttReleaseMs: 150,
};
interface Fixture {
  host: HTMLDivElement;
  confirmations: Record<string, unknown>[];
  opened: () => number;
  updates: { tag: string; next: AudioSettings }[];
  setPermission: (value: boolean) => void;
  setLive: (value: AudioSettings) => void;
  render: (value: AudioSettings, tag?: string) => Promise<void>;
  click: () => Promise<void>;
  visibility: (value: DocumentVisibilityState) => Promise<void>;
  focus: () => Promise<void>;
}

async function withBubble(options: { android?: boolean; bridge?: boolean; permission?: boolean; confirm?: boolean;
  settings?: Partial<AudioSettings> }, check: (f: Fixture) => Promise<void> | void, raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const confirmations: Record<string, unknown>[] = [];
  const updates: Fixture['updates'] = [];
  let opened = 0, permission = options.permission ?? false;
  let live = { ...defaults, ...options.settings };
  const docRegistrations = new Set<EventListenerOrEventListenerObject>();
  const winRegistrations = new Set<EventListenerOrEventListenerObject>();
  // Считаем только два слушателя компонента: React регистрирует собственные события на контейнере.
  const docAdd = document.addEventListener, docRemove = document.removeEventListener;
  const winAdd = window.addEventListener, winRemove = window.removeEventListener;
  document.addEventListener = function (type: string, callback: any, opts?: any) {
    if (type === 'visibilitychange') docRegistrations.add(callback);
    return docAdd.call(this, type, callback, opts);
  };
  document.removeEventListener = function (type: string, callback: any, opts?: any) {
    if (type === 'visibilitychange') docRegistrations.delete(callback);
    return docRemove.call(this, type, callback, opts);
  };
  window.addEventListener = function (type: string, callback: any, opts?: any) {
    if (type === 'focus') winRegistrations.add(callback);
    return winAdd.call(this, type, callback, opts);
  };
  window.removeEventListener = function (type: string, callback: any, opts?: any) {
    if (type === 'focus') winRegistrations.delete(callback);
    return winRemove.call(this, type, callback, opts);
  };
  function load(text: string, dependencies: Record<string, unknown>) {
    const module = { exports: {} as Record<string, React.ComponentType<any>> };
    // Целые модули TSX, включая настоящий Toggle: кликаем настоящий role=switch, а не проп фикстуры.
    runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, document, window, require: (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `R251 неописанный импорт ${id}`);
      return dependencies[id];
    } });
    return module.exports;
  }
  try {
    const deps = {
      react: React, 'react/jsx-runtime': jsx,
      '../audioSettings': { getAudioSettings: () => live },
      '../confirm': { confirmAction: async (details: Record<string, unknown>) => {
        confirmations.push(details); return options.confirm ?? true;
      } },
      '../hotkeys': { isAndroid: () => options.android ?? true },
      '../micActionRules': rules,
      '../nativeMicActions': { micBubbleSupported: () => options.bridge ?? true,
        canDrawOverlays: () => permission, openOverlaySettings: () => { opened++; } },
      './Toggle': load(toggleSource, { 'react/jsx-runtime': jsx }),
    };
    const Component = load(raw, deps).MicBubbleSetting;
    function draw(value: AudioSettings, tag: string) {
      root.render(React.createElement(Component, { s: value,
        update: (next: AudioSettings) => {
          updates.push({ tag, next: { ...next } }); live = { ...next };
          draw(live, tag);
        } }));
    }
    async function render(value: AudioSettings, tag = 'initial') {
      await React.act(async () => draw(value, tag));
    }
    await render(live);
    await check({ host, confirmations, updates, opened: () => opened,
      setPermission: value => { permission = value; }, setLive: value => { live = value; }, render,
      click: async () => {
        const button = host.querySelector<HTMLButtonElement>('button[role="switch"]');
        assert.ok(button, 'R251 переключатель доступен в поддерживаемом APK');
        await React.act(async () => button.click());
      },
      visibility: async value => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value });
        await React.act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
      },
      focus: async () => { await React.act(async () => window.dispatchEvent(new window.Event('focus'))); },
    });
  } finally {
    try {
      await React.act(async () => root.unmount());
      assert.equal(docRegistrations.size + winRegistrations.size, 0,
        'R251 ожидание возврата снимает слушатели при завершении или unmount');
    } finally {
      document.addEventListener = docAdd; document.removeEventListener = docRemove;
      window.addEventListener = winAdd; window.removeEventListener = winRemove;
      host.remove(); await GlobalRegistrator.unregister();
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  }
}

function checked(f: Fixture) { return f.host.querySelector('[role="switch"]')?.getAttribute('aria-checked'); }

async function checkUnsupported(raw = source) {
  // ПК/веб отличаются от старого APK: закрываем обе независимые половины условия поддержки.
  for (const options of [{ android: false, bridge: true }, { android: false, bridge: false },
    { android: true, bridge: false }]) await withBubble(options, f => {
    assert.equal(f.host.textContent, '', 'R251 неподдерживаемая платформа не предлагает пузырь');
    assert.equal(f.host.querySelector('[role="switch"]'), null);
  }, raw);
}
it('R251 ПК, веб и старый APK не показывают недоступную строку и подсказку', () => checkUnsupported());
it('R251 поддерживаемый Android показывает выключенный переключатель при старых настройках без micBubble', async () => {
  await withBubble({}, f => {
    assert.ok(f.host.textContent?.includes('Кнопка поверх приложений'));
    assert.equal(checked(f), 'false');
  });
});

async function checkCancel(raw = source) {
  await withBubble({ confirm: false }, async f => {
    await f.click();
    assert.equal(f.confirmations.length, 1);
    assert.equal(f.confirmations[0].confirmLabel, 'Открыть настройки');
    assert.equal(f.confirmations[0].cancelLabel, 'Не сейчас');
    assert.equal(f.opened(), 0, 'R251 отказ не открывает настройки Android');
    f.setPermission(true); await f.visibility('hidden'); await f.visibility('visible');
    assert.equal(f.updates.length, 0, 'R251 отказ не оставляет ожидание разрешения');
    assert.equal(checked(f), 'false');
  }, raw);
}
it('R251 отказ в объясняющем окне не открывает Android и не оставляет скрытого включения', () => checkCancel());

async function checkPrematureFocus(raw = source) {
  await withBubble({}, async f => {
    await f.click();
    assert.equal(f.opened(), 1);
    f.setPermission(true); await f.focus();
    assert.equal(f.updates.length, 0, 'R251 focus без ухода не включает пузырь');
    assert.equal(checked(f), 'false');
    // В том же ожидании настоящий уход всё ещё разрешает включение.
    await f.visibility('hidden'); await f.visibility('visible');
    assert.equal(f.updates.length, 1);
    assert.equal(checked(f), 'true');
  }, raw);
}
it('R251 focus после собственного окна не считается возвратом, но последующий уход и возврат включает пузырь', () => checkPrematureFocus());

for (const event of ['visible', 'focus'] as const) it(`R251 возврат через ${event} после hidden включает пузырь только с разрешением`, async () => {
  await withBubble({}, async f => {
    await f.click(); await f.visibility('hidden');
    assert.equal(f.updates.length, 0);
    f.setPermission(true);
    if (event === 'visible') await f.visibility('visible');
    else {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      await f.focus();
    }
    assert.equal(f.updates.length, 1);
    assert.equal(f.updates[0].next.micBubble, true);
    assert.equal(checked(f), 'true');
    await f.focus(); await f.visibility('visible');
    assert.equal(f.updates.length, 1, 'R251 завершённое ожидание не дублирует включение');
    assert.equal(f.confirmations.length, 1);
  });
});

async function checkDenied(raw = source) {
  await withBubble({}, async f => {
    await f.click(); await f.visibility('hidden'); await f.visibility('visible');
    assert.equal(f.updates.length, 0, 'R251 без разрешения возврат не включает пузырь');
    assert.equal(checked(f), 'false');
    f.setPermission(true); await f.focus(); await f.visibility('hidden'); await f.visibility('visible');
    assert.equal(f.updates.length, 0, 'R251 отказанное ожидание завершено без позднего включения');
    assert.equal(f.confirmations.length, 1, 'R251 отказ в Android не вызывает повторного окна');
    assert.equal(f.opened(), 1);
    // Новое осознанное нажатие с уже выданным разрешением работает без повторного запроса.
    await f.click(); assert.equal(checked(f), 'true');
    assert.equal(f.confirmations.length, 1);
  }, raw);
}
it('R251 возврат без разрешения оставляет выключено и не просит повторно без нового нажатия', () => checkDenied());

it('R251 выданное разрешение включает сразу, а выключение не требует разрешения и подтверждения', async () => {
  await withBubble({ permission: true }, async f => {
    await f.click(); assert.equal(checked(f), 'true');
    f.setPermission(false); await f.click(); assert.equal(checked(f), 'false');
    assert.deepEqual(f.updates.map(x => x.next.micBubble), [true, false]);
    assert.equal(f.confirmations.length, 0); assert.equal(f.opened(), 0);
  });
});
it('R251 подсказка о немой рации появляется только при pushToTalk без включённого пузыря', async () => {
  for (const pushToTalk of [false, true]) for (const micBubble of [false, true])
    await withBubble({ settings: { pushToTalk, micBubble } }, f => {
      assert.equal(f.host.textContent?.includes('Чтобы говорить с рацией'), pushToTalk && !micBubble);
      assert.equal(checked(f), String(micBubble));
    });
});
it('R251 возврат сохраняет свежие аудионастройки и вызывает новый update, не замыкание до ухода', async () => {
  await withBubble({}, async f => {
    await f.click(); await f.visibility('hidden');
    const changed = { ...defaults, inputGain: 1.7, outputDeviceId: 'new-output', pushToTalk: true };
    await f.render(changed, 'new-update');
    // Между последним рендером и возвратом настройки могли поменяться вне этой панели.
    f.setLive({ ...changed, inputDeviceId: 'new-input', pttReleaseMs: 350 });
    f.setPermission(true); await f.visibility('visible');
    assert.equal(f.updates.length, 1);
    assert.equal(f.updates[0].tag, 'new-update');
    assert.deepEqual(f.updates[0].next, { ...changed, inputDeviceId: 'new-input', pttReleaseMs: 350, micBubble: true });
  });
});

for (const [label, anchor, replacement, scenario, message] of [
  ['убран уход страницы', 'if (!left) return;', '', checkPrematureFocus, 'R251 focus без ухода не включает пузырь'],
  ['убрана проверка разрешения', 'if (canDrawOverlays()) updateRef.current', 'updateRef.current', checkDenied,
    'R251 без разрешения возврат не включает пузырь'],
  ['проигнорирован отказ', 'if (!ok) return;', '', checkCancel, 'R251 отказ не открывает настройки Android'],
  ['убрана поддержка платформы', 'if (!supported) return null;', '', checkUnsupported,
    'R251 неподдерживаемая платформа не предлагает пузырь'],
] as const) it(`R251 контрфакт «${label}» ловится AssertionError по поведению целого компонента`, async () => {
  await scenario();
  assert.equal(source.split(anchor).length - 1, 1, 'R251 мутант меняет ровно одно место');
  await assert.rejects(scenario(source.replace(anchor, replacement)), (error: unknown) =>
    error instanceof assert.AssertionError && error.message.startsWith(message) && error.operator === 'strictEqual');
});
