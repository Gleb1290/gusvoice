import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as rules from '../stageLayoutRules';
import type { StageLayout } from '../stageLayoutRules';
import type { StageLayoutPicker as StageLayoutPickerType } from './StageLayoutPicker';

const source = readFileSync(new URL('./StageLayoutPicker.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Picker = typeof StageLayoutPickerType;
let previousActEnvironment: PropertyDescriptor | undefined;

before(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(async () => {
  await GlobalRegistrator.unregister();
  if (previousActEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousActEnvironment);
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

function load(initial: StageLayout, raw = source) {
  let selected = initial;
  let updateHook: React.Dispatch<React.SetStateAction<StageLayout>> | undefined;
  const writes: StageLayout[] = [];
  const icon = ({ name }: { name: string }) => React.createElement('i', { 'data-icon': name });
  const deps = {
    react: React,
    'react/jsx-runtime': jsx,
    '../stageLayoutRules': rules,
    '../stageLayoutPrefs': {
      useStageLayout: () => {
        const [layout, setLayout] = React.useState(selected);
        updateHook = setLayout;
        return layout;
      },
      setStageLayout: (layout: StageLayout) => { writes.push(layout); selected = layout; updateHook?.(layout); },
    },
    './ContextMenu': { ContextMenu: ({ children, drop }: { children: React.ReactNode; drop: boolean }) =>
      React.createElement('div', { className: 'ctx-menu', 'data-drop': String(drop) }, children) },
    './Icon': { Icon: icon },
  };
  const module = { exports: {} as { StageLayoutPicker: Picker } };
  const compiled = ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  runInNewContext(compiled, { module, exports: module.exports,
    require: (id: string) => {
      const dependency = (deps as Record<string, unknown>)[id];
      if (dependency) return dependency;
      throw new Error(`Неописанная зависимость ${id}`);
    },
  });
  return { Component: module.exports.StageLayoutPicker, writes, selected: () => selected };
}

async function fixture(phone: boolean, initial: StageLayout, check: (f: {
  host: HTMLDivElement; writes: StageLayout[]; selected(): StageLayout;
  open(): Promise<void>; option(label: string): HTMLButtonElement | undefined;
}) => Promise<void>, raw = source) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const loaded = load(initial, raw);
  try {
    await React.act(async () => { root.render(React.createElement(loaded.Component, { phone })); });
    const event = () => React.act(async () => { host.querySelector<HTMLButtonElement>('.stage-layout-btn')!.click(); });
    const option = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find(button => button.querySelector('.ctx-label-main')?.textContent === label);
    await check({ host, writes: loaded.writes, selected: loaded.selected, open: event, option });
  } finally {
    await React.act(async () => { root.unmount(); });
    host.remove();
  }
}

// Класс ошибки: недоступная на телефоне компоновка захламляет меню или рабочий стол теряет выбор.
it('R248 телефон предлагает три режима, рабочий стол — все пять', async () => {
  await fixture(true, 'auto', async ({ open, host }) => {
    await open();
    assert.deepEqual([...host.querySelectorAll('.ctx-label-main')].map(node => node.textContent), ['Авто', 'Фокус', 'Говорящий']);
    assert.equal(host.querySelector('.ctx-menu')?.getAttribute('data-drop'), 'true');
  });
  await fixture(false, 'auto', async ({ open, host }) => {
    await open();
    assert.deepEqual([...host.querySelectorAll('.ctx-label-main')].map(node => node.textContent),
      ['Авто', 'Сетка', 'Фокус', 'Сбоку', 'Говорящий']);
    assert.equal(host.querySelector('.ctx-menu')?.getAttribute('data-drop'), 'false');
  });
  for (const saved of ['side', 'grid'] as const) await fixture(true, saved, async ({ open, host, option, writes, selected }) => {
    assert.equal(host.querySelector<HTMLButtonElement>('.stage-layout-btn')?.title, 'Вид: Авто');
    await open();
    assert.equal(option('Авто')?.getAttribute('aria-checked'), 'true');
    assert.equal(option('Фокус')?.getAttribute('aria-checked'), 'false');
    assert.deepEqual(writes, [], 'fallback на телефоне не перезаписывает сохранённый выбор');
    assert.equal(selected(), saved);
  });
});

// Класс ошибки: экранный диктор получает неверный радио-выбор или шапка описывает другой вид.
it('R248 текущий режим отмечен aria-checked, а кнопка называет действующий вид', () => fixture(false, 'focus', async ({ open, host, option }) => {
  assert.equal(host.querySelector<HTMLButtonElement>('.stage-layout-btn')?.title, 'Вид: Фокус');
  await open();
  assert.equal(option('Фокус')?.getAttribute('aria-checked'), 'true');
  assert.equal(option('Авто')?.getAttribute('aria-checked'), 'false');
  assert.equal(option('Фокус')?.classList.contains('active'), true);
}));

// Класс ошибки: клик не сохраняет режим, не закрывает меню или ошибочно запускает удалённое действие.
it('R248 выбор режима вызывает только локальную запись, обновляет title и закрывает меню', () => fixture(false, 'auto', async ({ open, host, option, writes, selected }) => {
  await open();
  assert.ok(option('Сбоку'));
  await React.act(async () => { option('Сбоку')!.click(); });
  assert.deepEqual(writes, ['side'], 'пикер сохраняет ровно выбранную раскладку, без API-действий');
  assert.equal(selected(), 'side');
  assert.equal(host.querySelector('.ctx-menu'), null, 'выбор закрывает всплывающее меню');
  assert.equal(host.querySelector<HTMLButtonElement>('.stage-layout-btn')?.getAttribute('aria-expanded'), 'false');
  assert.equal(host.querySelector<HTMLButtonElement>('.stage-layout-btn')?.title, 'Вид: Сбоку');
}));

// Класс ошибки: мобильная версия может записать режим, которого не предлагает и не умеет отображать.
it('R248 телефонный выбор не может записать недоступные Сетку или Сбоку', () => fixture(true, 'auto', async ({ open, option, writes }) => {
  await open();
  assert.equal(option('Сетка'), undefined); assert.equal(option('Сбоку'), undefined);
  assert.deepEqual(writes, []);
}));

function pickerContract(raw = source) {
  assert.equal(raw.split('stageLayoutChoices(phone)').length - 1, 1, 'пикер выбирает доступные пункты по устройству');
  assert.equal(raw.split('aria-checked={l === current}').length - 1, 1, 'текущий вариант отмечен как выбранный radio-пункт');
  assert.equal(raw.split('setStageLayout(l);\n                close();').length - 1, 1,
    'после записи выбранного режима меню закрывается');
}

// Класс ошибки: мобильное меню показывает лишние режимы, семантическая отметка инвертируется или меню зависает после выбора.
it('R248 исходные мутанты выбора устройства, radio-отметки и закрытия меню обнаруживаются', () => {
  pickerContract();
  assert.throws(() => pickerContract(source.replace('stageLayoutChoices(phone)', 'stageLayoutChoices(false)')), assert.AssertionError);
  assert.throws(() => pickerContract(source.replace('aria-checked={l === current}', 'aria-checked={l !== current}')),
    assert.AssertionError);
  const closeAfterSave = 'setStageLayout(l);\n                close();';
  assert.throws(() => pickerContract(source.replace(closeAfterSave, 'setStageLayout(l);')), assert.AssertionError);
});
