import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, before, after } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement, act, useState, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import ts from 'typescript';
import { useHoverPanel as originalHook, hoverPanelOpened, HOVER_OPEN_MS, HOVER_CLOSE_MS } from './hoverPanel';
import { getExprTab, type ExprTab } from './components/ExprTabs';

type Hook = typeof originalHook;
let registered = false;
let oldMatchMedia: typeof window.matchMedia;
before(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  registered = true;
  oldMatchMedia = window.matchMedia;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(() => {
  if (registered) GlobalRegistrator.unregister();
});

function mutantHook(): Hook {
  const source = readFileSync(new URL('./hoverPanel.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const changed = source.replace('export const HOVER_OPEN_MS = 200;', 'export const HOVER_OPEN_MS = 0;');
  assert.notEqual(changed, source, 'мутант меняет настоящий таймер наведения');
  const module = { exports: {} as Record<string, unknown> };
  const js = ts.transpileModule(changed, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, { module, exports: module.exports, require: (id: string) => {
    assert.equal(id, 'react'); return { useEffect: ReactHooks.useEffect, useRef: ReactHooks.useRef };
  }, window, document });
  return module.exports.useHoverPanel as Hook;
}
import * as ReactHooks from 'react';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function mouseEvent(target: EventTarget, type: string, relatedTarget?: EventTarget | null) {
  const event = new MouseEvent(type, { bubbles: true });
  if (relatedTarget !== undefined) Object.defineProperty(event, 'relatedTarget', { configurable: true, value: relatedTarget });
  target.dispatchEvent(event);
}

async function mounted(hook: Hook, hoverAvailable: boolean, check: (host: HTMLDivElement, counts: { open: number; close: number; triggerClick: number; pin: number }) => Promise<void>, pin?: () => boolean, closeState = true) {
  window.matchMedia = (() => ({ matches: hoverAvailable, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  const host = document.createElement('div'); document.body.append(host);
  let root: Root | null = createRoot(host);
  const counts = { open: 0, close: 0, triggerClick: 0, pin: 0 };
  const Harness: ComponentType = () => {
    const [open, setOpen] = useState(false);
    const props = hook({ isOpen: open, open: () => { counts.open++; setOpen(true); }, close: () => { counts.close++; if (closeState) setOpen(false); }, panel: '.panel', trigger: '.trigger', pin: pin ? () => { counts.pin++; return pin(); } : undefined });
    return createElement('div', { 'data-open': String(open) },
      createElement('button', { className: 'trigger', onMouseEnter: props.onMouseEnter, onMouseLeave: props.onMouseLeave, onClick: () => { counts.triggerClick++; } }, 'trigger'),
      open ? createElement('div', { className: 'panel' }, 'panel') : null);
  };
  try {
    await act(async () => { root!.render(createElement(Harness)); });
    await check(host, counts);
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    root = null; host.remove(); document.body.classList.remove('expr-hover'); window.matchMedia = oldMatchMedia;
  }
}

it('наведение открывает только после 200 мс, закрывается после ухода на 300 мс и возврат отменяет таймер', async () => {
  await mounted(originalHook, true, async (host, counts) => {
    const trigger = host.querySelector<HTMLButtonElement>('.trigger')!;
    await act(async () => { Simulate.mouseEnter(trigger); await wait(100); Simulate.mouseLeave(trigger); await wait(120); });
    assert.equal(counts.open, 0, 'короткий пролёт не раскрывает панель');

    await act(async () => { Simulate.mouseEnter(trigger); await wait(220); });
    assert.equal(counts.open, 1, 'устойчивое наведение раскрывает панель по порогу');
    assert.equal(hoverPanelOpened(), true); assert.ok(document.body.classList.contains('expr-hover'));

    const panel = host.querySelector<HTMLElement>('.panel')!;
    await act(async () => { mouseEvent(window, 'mousemove'); await wait(180); mouseEvent(panel, 'mousemove'); });
    assert.equal(counts.close, 0, 'возврат на панель отменяет закрытие до истечения 300 мс');
    await act(async () => { mouseEvent(window, 'mousemove'); await wait(320); });
    assert.equal(counts.close, 1, 'после ухода за пределы триггера и панели панель закрывается');
    assert.equal(hoverPanelOpened(), false); assert.ok(!document.body.classList.contains('expr-hover'));
    void panel;
  });
});

it('на тач-экране иконка не раскрывает панель по hover, а короткий порог-мутант заметно открывает её', async () => {
  await mounted(originalHook, false, async (host, counts) => {
    await act(async () => { Simulate.mouseEnter(host.querySelector('.trigger')!); await wait(220); });
    assert.equal(counts.open, 0, 'у устройства без hover панель остаётся закрытой');
  });
  await assert.rejects(() => mounted(mutantHook(), true, async (host, counts) => {
    await act(async () => { Simulate.mouseEnter(host.querySelector('.trigger')!); await wait(100); });
    assert.equal(counts.open, 0, 'до порога панель ещё должна быть закрыта');
  }), assert.AssertionError, 'исполняемый мутант с нулевой задержкой проходит через тот же DOM/React сценарий');
});

it('закрепление закрывает hover-панель и гасит click, отказ оставить её открытой', async () => {
  // `pin` — решение компонента колонки: true закрывает поповер, false не ломает прежнюю открытую панель.
  await mounted(originalHook, true, async (host, counts) => {
    await act(async () => { Simulate.mouseEnter(host.querySelector('.trigger')!); await wait(220); });
    assert.equal(host.querySelector('.panel') !== null, true, 'hover открыл панель перед щелчком');
    await act(async () => { host.querySelector<HTMLButtonElement>('.trigger')!.click(); await wait(10); });
    assert.equal(counts.pin, 1, 'клик спрашивает, удалось ли закрепить колонку');
    assert.equal(counts.close, 1, 'успешное закрепление закрывает всплывающую панель');
    assert.equal(counts.triggerClick, 0, 'клик закрепления не проваливается в обычный onClick триггера');
    assert.equal(hoverPanelOpened(), false, 'после успешного закрепления режим наведения снят');
  }, () => true, false);
  const remainsOpen = async (hook: Hook) => mounted(hook, true, async (host, counts) => {
    await act(async () => { Simulate.mouseEnter(host.querySelector('.trigger')!); await wait(220); });
    await act(async () => { host.querySelector<HTMLButtonElement>('.trigger')!.click(); await wait(10); });
    assert.equal(counts.pin, 1, 'колонка была предложена для закрепления');
    assert.equal(counts.close, 0, 'отказ закрепить не закрывает открытую панель');
    assert.equal(host.querySelector('.panel') !== null, true, 'поповер остаётся на месте');
    assert.equal(counts.triggerClick, 0, 'оба решения не пропускают click к повторному открытию');
  }, () => false, false);
  await remainsOpen(originalHook);
  const source = readFileSync(new URL('./hoverPanel.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const original = 'if (opts.current.pin?.()) opts.current.close();';
  assert.ok(source.includes(original), 'найдено реальное условие закрытия после решения pin');
  const mutant = original.replace('if (opts.current.pin?.()) ', '');
  const invoke = (statement: string, pinned: boolean) => {
    let closed = 0;
    runInNewContext(statement, { opts: { current: { pin: () => pinned, close: () => { closed++; } } } });
    return closed;
  };
  assert.equal(invoke(original, false), 0, 'исходное условие не закрывает при отказе');
  assert.equal(invoke(original, true), 1, 'исходное условие закрывает после успешного закрепления');
  assert.equal(invoke(mutant, false), 1, 'исполняемый мутант вызывает close без результата pin');
});

function expressionHoverSelectors() {
  const raw = readFileSync(new URL('./components/MessagePane.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('MessagePane.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'emojiHover') declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(declarations.length, 1, 'используется именно конфигурация emojiHover, не меню скрепки');
  const call = declarations[0].initializer;
  assert.ok(call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'useHoverPanel');
  assert.equal(call.arguments.length, 1);
  const options = call.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(options));
  const value = (name: string) => {
    const fields = options.properties.filter(ts.isPropertyAssignment).filter(property => property.name.getText(tree) === name);
    assert.equal(fields.length, 1, `настроен один ${name}`);
    const literal = fields[0].initializer;
    assert.ok(ts.isStringLiteralLike(literal), `${name} взят из живого строкового литерала`);
    return literal.text;
  };
  // Никакого eval: берём два значения AST и передаём их настоящему useHoverPanel.
  return { panel: value('panel'), trigger: value('trigger') };
}

function expressionClock() {
  const savedSet = Object.getOwnPropertyDescriptor(window, 'setTimeout');
  const savedClear = Object.getOwnPropertyDescriptor(window, 'clearTimeout');
  const tasks = new Map<number, { at: number; run: () => void }>();
  let now = 0, nextId = 1;
  Object.defineProperty(window, 'setTimeout', { configurable: true, value: (fn: () => void, ms = 0) => {
    assert.equal(typeof fn, 'function', 'часы принимают callback, не исполняемый текст');
    const id = nextId++;
    tasks.set(id, { at: now + ms, run: fn });
    return id;
  } });
  Object.defineProperty(window, 'clearTimeout', { configurable: true, value: (id: number) => { tasks.delete(id); } });
  return {
    advance(ms: number) {
      const end = now + ms;
      let turns = 0;
      for (;;) {
        const due = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        assert.ok(++turns < 1000, 'часы не зациклены callback-ом');
        tasks.delete(due[0]); now = due[1].at; due[1].run();
      }
      now = end;
    },
    restore() {
      tasks.clear();
      if (savedSet) Object.defineProperty(window, 'setTimeout', savedSet); else Reflect.deleteProperty(window, 'setTimeout');
      if (savedClear) Object.defineProperty(window, 'clearTimeout', savedClear); else Reflect.deleteProperty(window, 'clearTimeout');
    },
  };
}

// Те же корни, что у настоящих пикеров: отдельный AST-страж проверяет их против live JSX ref={popRef}.
const expressionRoots: Record<ExprTab, string> = { emoji: 'emoji-pop', stickers: 'sticker-pop', gifs: 'sticker-pop gif-pop' };
async function mountedExpression(tab: ExprTab, check: (f: {
  host: HTMLDivElement; trigger: HTMLButtonElement; outside: HTMLElement;
  counts: { open: number; close: number }; tick(ms: number): Promise<void>;
}) => Promise<void>) {
  const selectors = expressionHoverSelectors();
  const previousTab = localStorage.getItem('gv_expr_tab');
  const previousMatchMedia = window.matchMedia;
  const host = document.createElement('div');
  document.body.append(host);
  const clock = expressionClock();
  const root = createRoot(host);
  const counts = { open: 0, close: 0 };
  const Component = () => {
    const [open, setOpen] = useState(false);
    const [selected] = useState(getExprTab);
    const handlers = originalHook({ ...selectors, isOpen: open,
      open: () => { counts.open++; setOpen(true); }, close: () => { counts.close++; setOpen(false); } });
    return createElement('div', null,
      createElement('div', { className: 'composer' }, createElement('button', {
        className: 'att-btn emoji', onMouseEnter: handlers.onMouseEnter, onMouseLeave: handlers.onMouseLeave,
      }, 'эмодзи')),
      open ? createElement('div', { className: expressionRoots[selected], 'data-expr-tab': selected },
        createElement('button', { 'data-panel-child': '1' }, 'ячейка панели')) : null,
      createElement('div', { 'data-outside': '1' }, 'вне панели'));
  };
  try {
    localStorage.setItem('gv_expr_tab', tab);
    window.matchMedia = (() => ({ matches: true, media: '', onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
    await act(async () => { root.render(createElement(Component)); });
    assert.equal(host.querySelectorAll('[data-expr-tab]').length, 0, 'сохранённая вкладка сама панель не открывает');
    const trigger = host.querySelector<HTMLButtonElement>(selectors.trigger);
    const outside = host.querySelector<HTMLElement>('[data-outside]');
    assert.ok(trigger && outside);
    await check({ host, trigger, outside, counts,
      tick: async ms => { await act(async () => { clock.advance(ms); }); } });
  } finally {
    try { await act(async () => { root.unmount(); }); }
    finally {
      clock.restore(); host.remove(); window.matchMedia = previousMatchMedia;
      if (previousTab === null) localStorage.removeItem('gv_expr_tab'); else localStorage.setItem('gv_expr_tab', previousTab);
      document.body.classList.remove('expr-hover');
    }
  }
}

for (const tab of ['stickers', 'gifs', 'emoji'] as const) {
  it(`R293 ${tab}: последняя вкладка открывается наведением, держится над вложенной ячейкой и закрывается только после ухода`, async () => {
    await mountedExpression(tab, async f => {
      await act(async () => { Simulate.mouseEnter(f.trigger); });
      await f.tick(HOVER_OPEN_MS - 1);
      assert.equal(f.counts.open, 0, 'пролёт короче порога не открывает сохранённую вкладку');
      await f.tick(1);
      assert.equal(f.counts.open, 1);
      assert.equal(f.host.querySelectorAll(`[data-expr-tab="${tab}"]`).length, 1, 'открылась именно сохранённая вкладка');
      assert.equal(hoverPanelOpened(), true);
      const child = f.host.querySelector<HTMLElement>('[data-panel-child]'); assert.ok(child);
      await act(async () => { Simulate.mouseLeave(f.trigger); mouseEvent(child, 'mousemove'); });
      await f.tick(HOVER_CLOSE_MS + 1);
      assert.equal(f.host.querySelectorAll('[data-expr-tab]').length, 1, `R293 ${tab}: мышь внутри панели не запускает закрытие`);
      assert.equal(f.counts.close, 0);
      // Возврат в панель до границы также отменяет уже запущенный таймер.
      await act(async () => { mouseEvent(f.outside, 'mousemove'); });
      await f.tick(HOVER_CLOSE_MS - 1);
      assert.equal(f.counts.close, 0, 'до порога ухода панель не закрыта');
      await act(async () => { mouseEvent(child, 'mousemove'); });
      await f.tick(HOVER_CLOSE_MS + 1);
      assert.equal(f.counts.close, 0, 'возврат на вложенный элемент отменяет таймер');
      await act(async () => { mouseEvent(f.outside, 'mousemove'); });
      await f.tick(HOVER_CLOSE_MS - 1);
      assert.equal(f.host.querySelectorAll('[data-expr-tab]').length, 1);
      await f.tick(1);
      assert.equal(f.host.querySelectorAll('[data-expr-tab]').length, 0, 'полный уход закрывает панель ровно на пороге');
      assert.equal(f.counts.close, 1);
      assert.equal(hoverPanelOpened(), false);
    });
  });

  it(`R293 ${tab}: pointerdown во вложенной ячейке закрепляет hover-панель и отменяет ожидаемое закрытие`, async () => {
    await mountedExpression(tab, async f => {
      await act(async () => { Simulate.mouseEnter(f.trigger); });
      await f.tick(HOVER_OPEN_MS);
      assert.equal(f.host.querySelectorAll(`[data-expr-tab="${tab}"]`).length, 1);
      const child = f.host.querySelector<HTMLElement>('[data-panel-child]'); assert.ok(child);
      await act(async () => { mouseEvent(f.outside, 'mousemove'); });
      await f.tick(HOVER_CLOSE_MS - 1);
      await act(async () => { child.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
      assert.equal(hoverPanelOpened(), false, `R293 ${tab}: pointerdown переводит панель из hover в закреплённую`);
      assert.equal(document.body.classList.contains('expr-hover'), false);
      await act(async () => { mouseEvent(f.outside, 'mousemove'); });
      await f.tick(HOVER_CLOSE_MS * 2);
      assert.equal(f.host.querySelectorAll('[data-expr-tab]').length, 1, 'закреплённая панель остаётся после ухода и старого таймера');
      assert.equal(f.counts.close, 0);
      assert.equal(f.counts.open, 1, 'закрепление не открывает вторую панель');
    });
  });
}
