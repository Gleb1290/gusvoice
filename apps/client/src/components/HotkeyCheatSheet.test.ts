import assert, { AssertionError } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';

const source = readFileSync(new URL('./HotkeyCheatSheet.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const chromeSource = readFileSync(new URL('../dialogChrome.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const CAPTURE_MARKER = 'R283: первый Esc не закрывает нижний диалог';
const PREVENT_MARKER = 'R283: шпаргалка помечает свой Esc обработанным';
const ALT_MARKER = 'R283: строка «Эта шпаргалка» показывает оба сочетания';
let createRoot: typeof import('react-dom/client')['createRoot'];

before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  createRoot = (await import('react-dom/client')).createRoot;
});
after(() => {
  GlobalRegistrator.unregister();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

// Исполняем оба модуля целиком; неизвестный импорт не получает молчаливую заглушку.
function load<T>(raw: string, deps: Record<string, unknown>, frameWindow: object): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    module, exports: module.exports, document, window: frameWindow,
    require: (id: string) => {
      assert.ok(Object.hasOwn(deps, id), `R283: разрешён только явный импорт ${id}`);
      return deps[id];
    },
  });
  return module.exports as T;
}

type Scene = {
  host: HTMLDivElement;
  opener: HTMLButtonElement;
  sheet: () => HTMLElement | null;
  lower: () => HTMLElement | null;
  counts: { sheet: number; lower: number };
  listenerCount: () => number;
  key: (key: string, prevented?: boolean) => Promise<KeyboardEvent>;
  mountSheet: () => Promise<void>;
};

async function withScene(raw: string, check: (scene: Scene) => Promise<void>) {
  const listeners = new Map<EventListenerOrEventListenerObject, boolean>();
  const frameWindow = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject, capture = false) => {
      if (type === 'keydown') listeners.set(listener, capture);
      window.addEventListener(type, listener, capture);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject, capture = false) => {
      if (type === 'keydown' && listeners.get(listener) === capture) listeners.delete(listener);
      window.removeEventListener(type, listener, capture);
    },
  };
  const { HotkeyCheatSheet } = load<{ HotkeyCheatSheet: React.FC<{ onClose: () => void }> }>(raw, {
    react: React, 'react/jsx-runtime': jsx,
    '../audioSettings': { getAudioSettings: () => ({ pushToTalk: true, pttKey: 'Alt+KeyP' }) },
    '../hotkeys': {
      getHotkeys: () => ({ mute: 'Ctrl+KeyM', deafen: 'Ctrl+KeyD', screenShare: '' }),
      formatCombo: (combo: string) => combo.replace(/Key/g, '').split('+').join(' + '),
      isDesktop: () => false, isTauri: () => false,
    },
    '../sendMode': { getSendMode: () => 'enter' },
    './Icon': { Icon: () => null },
  }, frameWindow);
  const { useDialogChrome } = load<typeof import('../dialogChrome')>(chromeSource, {
    react: React,
    // Внешних листов/меню нет: изоляция должна зависеть от capture/defaultPrevented, а не от layerAbove.
    './androidBack': { layerAbove: () => false },
  }, frameWindow);
  const counts = { sheet: 0, lower: 0 };
  function LowerDialog() {
    const ref = useDialogChrome(() => { counts.lower++; });
    return React.createElement('div', { ref, className: 'settings-modal', role: 'dialog', tabIndex: -1 },
      React.createElement('button', { type: 'button', className: 'open-cheatsheet' }, 'Все сочетания клавиш'));
  }
  function UpperDialog() {
    const [shown, setShown] = React.useState(true);
    return shown ? React.createElement(HotkeyCheatSheet, {
      onClose: () => { counts.sheet++; setShown(false); },
    }) : null;
  }
  const host = document.createElement('div');
  const lowerHost = document.createElement('div');
  document.body.append(lowerHost, host);
  const lowerRoot = createRoot(lowerHost);
  const upperRoot = createRoot(host);
  let cycle = 0;
  try {
    // Нижний bubbling listener регистрируется раньше верхнего: без capture он успеет закрыть настройки.
    await React.act(async () => lowerRoot.render(React.createElement(LowerDialog)));
    assert.equal(listeners.size, 1, 'R283: нижний диалог первым установил свой Esc listener');
    const opener = lowerHost.querySelector<HTMLButtonElement>('.open-cheatsheet');
    assert.ok(opener, 'R283: у нижнего диалога есть открывающая кнопка');
    const mountSheet = async () => {
      opener.focus();
      await React.act(async () => upperRoot.render(React.createElement(UpperDialog, { key: ++cycle })));
    };
    await mountSheet();
    await check({
      host, opener, counts, mountSheet,
      sheet: () => host.querySelector<HTMLElement>('.modal.cheatsheet'),
      lower: () => lowerHost.querySelector<HTMLElement>('.settings-modal'),
      listenerCount: () => listeners.size,
      key: async (key, prevented = false) => {
        const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        if (prevented) event.preventDefault();
        await React.act(async () => {
          (host.querySelector('.modal.cheatsheet') ?? opener).dispatchEvent(event);
        });
        return event;
      },
    });
  } finally {
    await React.act(async () => upperRoot.unmount());
    await React.act(async () => lowerRoot.unmount());
    host.remove(); lowerHost.remove();
    // Даже повреждённый cleanup мутанта не должен оставлять listeners соседнему сценарию.
    const remaining = listeners.size;
    for (const [listener, capture] of listeners) window.removeEventListener('keydown', listener, capture);
    assert.equal(remaining, 0, 'R283: после размонтирования обоих окон не осталось Esc listeners');
  }
}

function checkAlt(scene: Scene) {
  const row = Array.from(scene.host.querySelectorAll('.cheat-body .cheat-row')).find(
    (item) => item.querySelector('.cheat-label')?.textContent === 'Эта шпаргалка',
  );
  assert.ok(row, 'R283: сочетания показаны в строке тела, а не только в подсказке шапки');
  assert.deepEqual(Array.from(row.querySelectorAll('kbd.cheat-key'), (key) => key.textContent), ['?', 'Ctrl', '/'], ALT_MARKER);
  assert.equal(row.querySelector('.cheat-or')?.textContent, 'или', 'R283: варианты разделены словом «или»');
  assert.deepEqual(Array.from(row.querySelector('.cheat-keys')!.children, (item) => item.textContent), ['?', 'или', 'Ctrl', '/'],
    'R283: «или» стоит между клавишами первого и второго сочетаний');
}

async function checkEscape(scene: Scene) {
  const before = { ...scene.counts };
  const event = await scene.key('Escape');
  assert.equal(event.defaultPrevented, true, PREVENT_MARKER);
  assert.equal(scene.counts.lower, before.lower, CAPTURE_MARKER);
  assert.equal(scene.counts.sheet, before.sheet + 1, 'R283: один Esc вызвал onClose шпаргалки ровно один раз');
  assert.equal(scene.sheet(), null, 'R283: закрывшаяся шпаргалка размонтирована');
  assert.ok(scene.lower(), 'R283: настройки остались в DOM');
  assert.equal(document.activeElement, scene.opener, 'R283: после закрытия фокус вернулся на открывшую кнопку');
  assert.equal(scene.listenerCount(), 1, 'R283: снят только listener шпаргалки');
}

function replaceOnce(raw: string, needle: string, replacement: string) {
  assert.equal(raw.split(needle).length - 1, 1, `R283: единственный якорь мутанта ${needle}`);
  const changed = raw.replace(needle, replacement);
  assert.notEqual(changed, raw, 'R283: мутант действительно изменил исходник');
  return changed;
}

async function rejectsDomain(check: () => void | Promise<void>, marker: string) {
  await assert.rejects(async () => { await check(); }, (error: unknown) =>
    error instanceof AssertionError && error.message.split('\n')[0] === marker,
  `R283: мутант обязан упасть именно на доменном assertion «${marker}»`);
}

it('шпаргалка имеет отдельные шапку и тело, три озаглавленные секции и оба сочетания в строке навигации', async () => {
  // Класс ошибки: изменение вёрстки теряет доступность диалога или группу реальных строк.
  await withScene(source, async (scene) => {
    const box = scene.sheet(); assert.ok(box);
    assert.equal(box.getAttribute('role'), 'dialog');
    assert.equal(box.getAttribute('aria-modal'), 'true');
    assert.equal(box.getAttribute('aria-labelledby'), 'cheat-title');
    assert.equal(box.querySelector('#cheat-title')?.textContent, 'Горячие клавиши');
    assert.equal(box.tabIndex, -1);
    assert.equal(document.activeElement, box, 'R283: открытое окно получает фокус');
    const head = box.querySelector('.cheat-head');
    const body = box.querySelector('.cheat-body');
    assert.ok(head); assert.ok(body);
    assert.equal(head.parentElement, box);
    assert.equal(body.parentElement, box);
    assert.equal(head.nextElementSibling, body, 'R283: шапка перед листаемым телом, а не внутри него');
    const sections = Array.from(body.children);
    assert.equal(sections.length, 3);
    assert.ok(sections.every((section) => section.matches('section.cheat-sec')));
    assert.deepEqual(sections.map((section) => section.querySelector('h3')?.textContent), ['Голос', 'Навигация', 'Сообщения']);
    assert.deepEqual(sections.map((section) => section.getAttribute('aria-label')), ['Голос', 'Навигация', 'Сообщения']);
    checkAlt(scene);
  });
});

it('один Esc закрывает только шпаргалку, возвращает фокус и не оставляет обработчик после повторного открытия', async () => {
  // Класс ошибки: закрытие верхнего окна протекает в нижнее или оставляет живой listener после cleanup.
  await withScene(source, async (scene) => {
    assert.equal(scene.listenerCount(), 2);
    assert.equal((await scene.key('Enter')).defaultPrevented, false);
    assert.deepEqual(scene.counts, { sheet: 0, lower: 0 }, 'R283: обычная клавиша не закрывает окна');
    await scene.key('Escape', true);
    assert.deepEqual(scene.counts, { sheet: 0, lower: 0 }, 'R283: уже обработанный Esc не закрывает окна');
    assert.ok(scene.sheet());
    await checkEscape(scene);
    const next = await scene.key('Escape');
    assert.equal(next.defaultPrevented, false, 'R283: закрытая шпаргалка больше не перехватывает Esc');
    assert.deepEqual(scene.counts, { sheet: 1, lower: 1 }, 'R283: следующий Esc принадлежит настройкам');
    await scene.mountSheet();
    assert.equal(scene.listenerCount(), 2, 'R283: повторное открытие установило один новый listener');
    assert.equal(document.activeElement, scene.sheet());
    await checkEscape(scene);
    assert.deepEqual(scene.counts, { sheet: 2, lower: 1 });
  });
});

it('контрфакт без capture не проходит: раньше зарегистрированный Esc настроек не должен закрывать нижнее окно', async () => {
  // Класс ошибки: bubbling слушатель верхнего окна приходит слишком поздно для уже открытых настроек.
  await withScene(source, checkEscape);
  let changed = replaceOnce(source, "window.addEventListener('keydown', onKey, true);", "window.addEventListener('keydown', onKey);");
  changed = replaceOnce(changed, "window.removeEventListener('keydown', onKey, true);", "window.removeEventListener('keydown', onKey);");
  await withScene(changed, async (scene) => { await rejectsDomain(() => checkEscape(scene), CAPTURE_MARKER); });
});

it('контрфакт без preventDefault не проходит: обработанный шпаргалкой Esc должен быть погашен', async () => {
  // Класс ошибки: capture без preventDefault всё равно отдаёт тот же Esc нижнему диалогу.
  await withScene(source, checkEscape);
  const changed = replaceOnce(source, '      e.preventDefault();', '      /* мутант: Esc не погашен */');
  await withScene(changed, async (scene) => { await rejectsDomain(() => checkEscape(scene), PREVENT_MARKER); });
});

it('контрфакт без alt у строки не проходит, даже если Ctrl+/ по-прежнему показан в шапке', async () => {
  // Класс ошибки: проверка одной шапки скрыла бы потерю альтернативного сочетания в строке навигации.
  await withScene(source, async (scene) => { checkAlt(scene); });
  const changed = replaceOnce(source, ' alt={k.alt}', '');
  await withScene(changed, async (scene) => { await rejectsDomain(() => checkAlt(scene), ALT_MARKER); });
});
