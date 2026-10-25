import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as shared from '@gusvoice/shared';
import * as math from '../drumMath';
import * as rules from '../onceMediaRules';

const menuSource = readFileSync(new URL('./OnceTimerMenu.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const drumSource = readFileSync(new URL('./DrumPicker.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let createRoot: typeof import('react-dom/client')['createRoot'];
let previousAct: PropertyDescriptor | undefined;

before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  createRoot = (await import('react-dom/client')).createRoot;
});
after(() => {
  GlobalRegistrator.unregister();
  if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

function replaceOnce(raw: string, from: string, to: string) {
  assert.equal(raw.split(from).length - 1, 1, 'единственная точка мутации');
  return raw.replace(from, to);
}

function wholeModule<T>(source: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, {
    module, exports: module.exports,
    // reduced-motion выключает только анимацию, не обработчики и математику.
    // happy-dom не измеряет layout: тест не утверждает, что строки визуально размещены правильно.
    window: { matchMedia: () => ({ matches: true }),
      setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) },
    performance, cancelAnimationFrame: () => {},
    requestAnimationFrame: () => { throw new Error('В reduced-motion кадры не нужны'); },
    require: (name: string) => {
      assert.equal(Object.hasOwn(deps, name), true, `явная зависимость ${name}`);
      return deps[name];
    },
  });
  return module.exports as T;
}

type Options = { current?: number | null; menu?: string; drum?: string; back?: boolean };
type Scene = {
  host: HTMLDivElement; choices: (number | null)[]; backs(): number;
  button(text: string): HTMLButtonElement;
  click(text: string): Promise<void>;
  open(): Promise<void>;
  wheel(deltaY: number, deltaMode?: number): Promise<WheelEvent>;
  key(key: string): Promise<KeyboardEvent>;
  pointer(type: string, clientY: number, pointerId?: number, button?: number): Promise<void>;
  selected(): string | null;
};

async function scene(options: Options, check: (s: Scene) => Promise<void>) {
  // Оба TSX-модуля целиком. Только MenuItem — leaf, чтобы не затянуть порталы, store и API.
  const drum = wholeModule<typeof import('./DrumPicker')>(options.drum ?? drumSource, {
    react: React, 'react/jsx-runtime': jsx, '../drumMath': math,
  });
  const menu = wholeModule<typeof import('./OnceTimerMenu')>(options.menu ?? menuSource, {
    react: React, 'react/jsx-runtime': jsx, '@gusvoice/shared': shared, '../onceMediaRules': rules,
    './DrumPicker': drum,
    './ContextMenu': { MenuItem: (p: { label: string; onClick: () => void; active?: boolean }) =>
      React.createElement('button', { onClick: p.onClick, 'aria-pressed': p.active }, p.label) },
  });
  const choices: (number | null)[] = [];
  let backs = 0;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const button = (text: string) => {
    const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text);
    assert.ok(found, `найдена кнопка ${text}`); return found;
  };
  const click = (text: string) => React.act(async () => { button(text).click(); });
  const drumRoot = () => {
    const found = host.querySelector<HTMLElement>('[role="listbox"]');
    assert.ok(found, 'настоящий DrumPicker смонтирован'); return found;
  };
  try {
    await React.act(async () => root.render(React.createElement(menu.OnceTimerItems, {
      current: options.current === undefined ? null : options.current,
      onChoose: n => { choices.push(n); }, onBack: options.back ? () => { backs++; } : undefined,
    })));
    await check({ host, choices, backs: () => backs, button, click,
      open: async () => {
        const custom = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.startsWith('Своё время'));
        assert.ok(custom); await React.act(async () => custom.click());
      },
      selected: () => {
        const id = drumRoot().getAttribute('aria-activedescendant');
        return [...host.querySelectorAll('[role="option"]')].find(row => row.id === id)?.textContent ?? null;
      },
      wheel: async (deltaY, deltaMode = 0) => {
        const e = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, deltaMode });
        await React.act(async () => { drumRoot().dispatchEvent(e); }); return e;
      },
      key: async key => {
        const e = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key });
        await React.act(async () => { drumRoot().dispatchEvent(e); }); return e;
      },
      pointer: async (type, clientY, pointerId = 1, button = 0) => {
        const e = new window.PointerEvent(type, { bubbles: true, pointerId, button, clientY });
        await React.act(async () => { drumRoot().dispatchEvent(e); });
      },
    });
  } finally {
    await React.act(async () => root.unmount()); host.remove();
  }
}

it('R265 своё время показывает настоящий барабан с 60 склонениями, без ползунка', () => scene({}, async s => {
  assert.equal(!!s.host.querySelector('input[type="range"],.gv-range'), false);
  await s.open();
  assert.equal(!!s.host.querySelector('input[type="range"],.gv-range'), false);
  assert.equal(s.host.querySelectorAll('.drum[role="listbox"]').length, 1);
  assert.equal(s.host.querySelector('[role="listbox"]')?.getAttribute('aria-label'), 'Своё время, секунд');
  // Независимый словарь окончаний по десяткам: не вычисляем oracle вызовом secondsLabel.
  const first = ['секунда', 'секунды', 'секунды', 'секунды', 'секунд', 'секунд', 'секунд', 'секунд', 'секунд', 'секунд'];
  const afterTwenty = ['секунда', 'секунды', 'секунды', 'секунды', 'секунд', 'секунд', 'секунд', 'секунд', 'секунд', 'секунд'];
  const endings = [...first, ...Array<string>(10).fill('секунд'), ...afterTwenty, ...afterTwenty, ...afterTwenty, ...afterTwenty];
  assert.deepEqual([...s.host.querySelectorAll('[role="option"]')].map(row => row.textContent), endings.map((end, i) => `${i + 1} ${end}`));
  s.button('Отмена'); s.button('Готово');
  assert.equal(s.selected(), '10 секунд');
  assert.deepEqual(s.choices, [], 'открытие не отправляет таймер');
}));

it('R265 отмена и возврат из своего времени не отправляют выбор, повторный вход сбрасывает черновик', async () => {
  for (const exit of ['Отмена', 'Своё время']) await scene({ current: 21 }, async s => {
    await s.open(); assert.equal(s.selected(), '21 секунда');
    await s.key('ArrowDown'); assert.equal(s.selected(), '22 секунды');
    await s.click(exit);
    assert.equal(!!s.host.querySelector('[role="listbox"]'), false);
    assert.deepEqual(s.choices, []);
    await s.open(); assert.equal(s.selected(), '21 секунда');
  });
});

async function doneContract(options: Options = {}) {
  await scene({ current: 21, ...options }, async s => {
    await s.open(); await s.key('ArrowDown');
    assert.equal(s.selected(), '22 секунды');
    await s.click('Готово');
    assert.deepEqual(s.choices, [22], 'R265:Готово-отправляет-выбранное-не-null');
  });
}

it('R265 Готово отправляет изменённое число секунд, а не исходное значение и не null', () => doneContract());

it('R265 Enter подтверждает обе границы 1 и 60 секунд', async () => {
  for (const [key, value] of [['Home', 1], ['End', 60]] as const) await scene({}, async s => {
    await s.open(); await s.key(key);
    const enter = await s.key('Enter'); assert.equal(enter.defaultPrevented, true);
    assert.deepEqual(s.choices, [value]);
  });
});

it('R265 прежние готовые таймеры, просмотр один раз и не удалять сохраняют контракт', async () => {
  for (const [text, value] of [['Просмотр один раз', 0], ['3 секунды', 3], ['10 секунд', 10],
    ['30 секунд', 30], ['Не удалять', null]] as const) await scene({ back: true }, async s => {
    await s.click('Таймер самоуничтожения'); assert.equal(s.backs(), 1); assert.deepEqual(s.choices, []);
    await s.click(text); assert.deepEqual(s.choices, [value]);
  });
});

it('R265 50 единиц колеса ещё не меняют строку, ровно 100 меняют одну и зажимают края', () => scene({ current: 21 }, async s => {
  await s.open();
  const half = await s.wheel(50); assert.equal(half.defaultPrevented, true);
  assert.equal(s.selected(), '21 секунда');
  await s.wheel(50); assert.equal(s.selected(), '22 секунды');
  await s.wheel(-100); assert.equal(s.selected(), '21 секунда');
  await s.wheel(100000); assert.equal(s.selected(), '60 секунд');
  await s.wheel(100); assert.equal(s.selected(), '60 секунд');
  await s.wheel(-100000); assert.equal(s.selected(), '1 секунда');
  await s.wheel(-100); assert.equal(s.selected(), '1 секунда');
  await s.wheel(100); assert.equal(s.selected(), '2 секунды', 'после границы движение внутрь не блокируется');
}));

async function dragContract(options: Options = {}) {
  await scene({ current: 21, ...options }, async s => {
    await s.open(); await s.pointer('pointerdown', 100); await s.pointer('pointermove', 140);
    assert.equal(s.selected(), '20 секунд', 'R265:перетаскивание-вниз-уменьшает-индекс');
    await s.pointer('pointermove', 100);
    assert.equal(s.selected(), '21 секунда', 'обратное движение возвращает строку');
  });
}

it('R265 настоящее перетаскивание ведёт содержимое за пальцем в обе стороны', () => dragContract());

it('R265 мелкое движение, чужой палец и правая кнопка не перетаскивают барабан', async () => {
  await scene({ current: 21 }, async s => {
    await s.open(); await s.pointer('pointerdown', 100); await s.pointer('pointermove', 103.999);
    assert.equal(s.selected(), '21 секунда');
    await s.pointer('pointermove', 140, 2); assert.equal(s.selected(), '21 секунда');
    await s.pointer('pointermove', 140); assert.equal(s.selected(), '20 секунд');
  });
  await scene({ current: 21 }, async s => {
    await s.open(); await s.pointer('pointerdown', 100, 1, 2); await s.pointer('pointermove', 140);
    assert.equal(s.selected(), '21 секунда');
  });
});

it('R265 стрелки и PageUp/PageDown двигают по строке и экрану, Escape оставлен хозяину', () => scene({ current: 21 }, async s => {
  await s.open();
  for (const [key, selected] of [['ArrowUp', '20 секунд'], ['ArrowLeft', '19 секунд'], ['ArrowRight', '20 секунд'],
    ['ArrowDown', '21 секунда'], ['PageDown', '26 секунд'], ['PageUp', '21 секунда']] as const) {
    assert.equal((await s.key(key)).defaultPrevented, true); assert.equal(s.selected(), selected);
  }
  assert.equal((await s.key('Escape')).defaultPrevented, false); assert.deepEqual(s.choices, []);
}));

it('R265 контрфакт знака настоящего pointermove падает на направлении, оригинал проходит первым', async () => {
  await dragContract();
  const mutant = replaceOnce(drumSource, 'pos.current - (e.clientY - d.lastY) / DRUM_ITEM_HEIGHT',
    'pos.current + (e.clientY - d.lastY) / DRUM_ITEM_HEIGHT');
  await assert.rejects(() => dragContract({ drum: mutant }), error =>
    error instanceof assert.AssertionError && error.message.includes('R265:перетаскивание-вниз-уменьшает-индекс'));
});

it('R265 контрфакт Готово → null падает на результате клика, оригинал проходит первым', async () => {
  await doneContract();
  const mutant = replaceOnce(menuSource, 'const done = () => onChoose(pick + 1);', 'const done = () => onChoose(null);');
  await assert.rejects(() => doneContract({ menu: mutant }), error =>
    error instanceof assert.AssertionError && error.message.includes('R265:Готово-отправляет-выбранное-не-null'));
});
