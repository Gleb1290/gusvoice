import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, before, after } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement, act, useState, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import ts from 'typescript';
import { useHoverPanel as originalHook, hoverPanelOpened } from './hoverPanel';

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
