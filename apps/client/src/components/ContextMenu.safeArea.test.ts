import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, after, it } from 'node:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import type { ContextMenuProps } from './ContextMenu';

before(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(() => GlobalRegistrator.unregister());

async function dropCheck(options: { drop?: boolean; x?: number; y?: number; count?: number; source?: string } = {}) {
  const { drop = true, x = 330, y = 50, count = 3 } = options;
  const fixture = layoutFixture(48, 1, 32);
  fixture.property(window, 'matchMedia', { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  fixture.property(HTMLElement.prototype, 'offsetWidth', { get: () => 196 });
  fixture.property(HTMLElement.prototype, 'offsetHeight', { get() { return (this as HTMLElement).classList.contains('ctx-item') ? 20 : 100; } });
  fixture.property(HTMLElement.prototype, 'offsetTop', { get() { return (this as HTMLElement).classList.contains('ctx-item') ? Array.from((this as HTMLElement).parentElement!.children).indexOf(this as HTMLElement) * 20 : 0; } });
  class Observer { observe() {} disconnect() {} }
  const raw = options.source ?? readFileSync(new URL('./ContextMenu.tsx', import.meta.url), 'utf8');
  const Menu = evaluate(raw, {
    react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': jsx, '../popover': fixture.popover,
    '../bigReaction': {}, '../imageViewer': { useImageViewerOpen: () => false },
    './Icon': { Icon: () => null }, './StatusDot': { StatusDot: () => null },
  }, { ...fixture.globals, HTMLElement, ResizeObserver: Observer, setTimeout, clearTimeout, Event }).ContextMenu as React.ComponentType<ContextMenuProps>;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    const anchor = new DOMRect(x, y, 40, 20);
    await React.act(async () => root.render(React.createElement(Menu, {
      anchor, drop, align: 'end', width: 196, fit: true, onClose() {},
      children: Array.from({ length: count }, (_, i) => React.createElement('button', { key: i, className: 'ctx-item' }, `Пункт ${i}`)),
    })));
    const stack = document.querySelector<HTMLElement>('.ctx-stack'); assert.ok(!!stack);
    assert.equal(!!document.querySelector('.ctx-sheet-backdrop'), false, 'якорное меню телефона не становится листом');
    assert.equal(stack!.classList.contains('drop'), drop, 'drop-класс принадлежит только выпадающей ветке');
    // Здесь замер границ подставлен; clampAxis/placeByHalf и весь ContextMenu настоящие.
    const expectedTop = drop ? Math.max(40, Math.min(y, 444)) : (fixture.popover.placeByHalf as Function)(anchor, 196, 100, 'end', 8, 8, { vw: 390, vh: 552, top: 32 }).top;
    assert.equal(Number.parseFloat(stack!.style.top), expectedTop, 'верх dropdown совпадает с кнопкой с учётом вставок');
    assert.equal(Number.parseFloat(stack!.style.left), Math.max(8, Math.min(x + 40 - 196, 186)), 'правый край у кнопки, за экран не выходит');
    const card = stack!.querySelector<HTMLElement>('.ctx-menu'); assert.ok(!!card);
    assert.equal(card!.style.getPropertyValue('--drop-ms'), drop ? `${150 + 16 * count}ms` : '', 'длительность растёт по числу пунктов');
    const delays = Array.from(card!.children, child => (child as HTMLElement).style.getPropertyValue('--drop-at'));
    assert.deepEqual(delays, drop ? Array.from({ length: count }, (_, i) => `${Math.round((150 + 16 * count) * Math.min(100, i * 20 + 10) / 100)}ms`) : Array.from({ length: count }, () => ''), 'задержки следуют положению пункта по высоте карточки');
  } finally {
    await React.act(async () => root.unmount()); host.remove(); fixture.restore();
  }
}
it('R161 выпадающее меню телефона накрывает кнопку верхом и правым краем, не становится листом', () => dropCheck());
it('R161 выпадающее меню прижимается у обоих краёв и системных вставок', async () => {
  for (const [x, y] of [[0, 0], [380, 580]]) await dropCheck({ x, y });
});
it('R161 без drop сохраняется обычное размещение placeByHalf без задержек', () => dropCheck({ drop: false }));
it('R161 ноль и несколько пунктов задают свою длительность и порядок задержек', async () => {
  for (const count of [0, 1, 5]) await dropCheck({ count });
});
function dropMutant(from: string, to: string) {
  const raw = readFileSync(new URL('./ContextMenu.tsx', import.meta.url), 'utf8');
  assert.equal(raw.split(from).length - 1, 1, 'мутант меняет единственный якорь целого ContextMenu');
  return raw.replace(from, to);
}
it('R161 игнорирование drop обнаруживается реальным размещением', async () => {
  await dropCheck();
  await assert.rejects(dropCheck({ source: dropMutant('if (anchor && drop) {', 'if (anchor && false) {') }), assert.AssertionError);
});
it('R161 потеря числа пунктов в длительности dropdown обнаруживается', async () => {
  await dropCheck();
  await assert.rejects(dropCheck({ source: dropMutant('150 + 16 * shown', '150') }), assert.AssertionError);
});

function evaluate(source: string, dependencies: Record<string, unknown>, globals: Record<string, unknown>) {
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    ...globals, module, exports: module.exports,
    require: (id: string) => {
      assert.ok(id in dependencies, `внешняя зависимость названа явно: ${id}`);
      return dependencies[id];
    },
  });
  return module.exports;
}

// HappyDOM не измеряет layout и CSS env/max. Подменяется только браузерный замер:
// настоящие viewportAboveSafeBottom/placeByHalf и весь ContextMenu остаются исполняемыми.
function layoutFixture(bottom = 48, zoom = 1, top = 0) {
  const changes: Array<() => void> = [];
  const property = (target: object, name: string, descriptor: PropertyDescriptor) => {
    const old = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, ...descriptor });
    changes.push(() => { if (old) Object.defineProperty(target, name, old); else Reflect.deleteProperty(target, name); });
  };
  property(document.documentElement, 'clientWidth', { value: 390 });
  property(document.documentElement, 'clientHeight', { value: 600 });
  property(window, 'innerHeight', { value: 600 });
  property(window, 'innerWidth', { value: 390 });
  property(window, 'visualViewport', { value: null });
  const oldSab = document.documentElement.style.getPropertyValue('--gv-sab');
  document.documentElement.style.setProperty('--gv-sab', `${bottom}px`);
  changes.push(() => { document.documentElement.style.setProperty('--gv-sab', oldSab); });
  const oldSat = document.documentElement.style.getPropertyValue('--gv-sat');
  document.documentElement.style.setProperty('--gv-sat', `${top}px`);
  changes.push(() => { document.documentElement.style.setProperty('--gv-sat', oldSat); });
  const assignedCss = new WeakMap<Element, string>();
  const probeDocument = {
    documentElement: document.documentElement,
    body: document.body,
    createElement(tag: string) {
      const element = document.createElement(tag);
      // HappyDOM отбрасывает env() даже при записи cssText: перехватываем сырую
      // строку на конкретной пробе, не читаем результат его CSS-парсера.
      property(element.style, 'cssText', {
        get: () => assignedCss.get(element) ?? '',
        set: (value: string) => { assignedCss.set(element, value); },
      });
      return element;
    },
  };
  const computed = (element: Element) => {
    if (element === document.documentElement) return { zoom: String(zoom) };
    // Не выдаём вставку пробе, которая перестала читать native fallback.
    const written = assignedCss.get(element) ?? '';
    assert.match(written, /(?:^|;)\s*padding-bottom\s*:\s*max\(env\(safe-area-inset-bottom\),\s*var\(--gv-sab,\s*0px\)\)\s*(?:;|$)/,
      'проба измеряет ту же max-вставку, что CSS');
    assert.ok(document.body.contains(element), 'проба подключена к DOM до измерения');
    assert.match(written, /padding-top:max\(env\(safe-area-inset-top\), var\(--gv-sat, 0px\)\)/);
    return { paddingTop: document.documentElement.style.getPropertyValue('--gv-sat'), paddingBottom: document.documentElement.style.getPropertyValue('--gv-sab') };
  };
  const globals = { window, document, DOMRect, getComputedStyle: computed };
  const popover = evaluate(readFileSync(new URL('../popover.ts', import.meta.url), 'utf8'), {}, { ...globals, document: probeDocument });
  return { globals, popover, property, restore: () => { for (const undo of changes.reverse()) undo(); } };
}

for (const bottom of [0, 48, 800]) {
  it(`R114 вьюпорт над системной вставкой ${bottom} px не теряет ширину и не уходит в отрицательную высоту`, () => {
    const fixture = layoutFixture(bottom);
    const children = document.body.childElementCount;
    try {
      const viewport = fixture.popover.viewportAboveSafeBottom as () => { vw: number; vh: number };
      assert.deepEqual({ ...viewport() }, { vw: 390, vh: Math.max(0, 600 - bottom) });
      assert.equal(document.body.childElementCount, children, 'измерительная проба удалена');
    } finally { fixture.restore(); }
  });
}

async function anchoredMenuCheck(change?: (source: string) => string, point = false) {
  const fixture = layoutFixture(48, 1, point ? 32 : 0);
  if (point) fixture.property(window, 'innerWidth', { value: 900 });
  if (point) fixture.property(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  let height = 80;
  const observers: FakeResizeObserver[] = [];
  class FakeResizeObserver {
    target: Element | null = null;
    disconnected = false;
    constructor(readonly callback: () => void) { observers.push(this); }
    observe(target: Element) { this.target = target; }
    disconnect() { this.disconnected = true; }
  }
  fixture.property(HTMLElement.prototype, 'offsetWidth', { get() { return 220; } });
  fixture.property(HTMLElement.prototype, 'offsetHeight', { get() { return height; } });
  let source = readFileSync(new URL('./ContextMenu.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (change) { const mutated = change(source); assert.notEqual(mutated, source, 'мутант меняет настоящий ContextMenu'); source = mutated; }
  const exports = evaluate(source, {
    react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': jsx,
    '../popover': fixture.popover,
    '../bigReaction': {}, '../imageViewer': { useImageViewerOpen: () => false },
    './Icon': { Icon: () => null }, './StatusDot': { StatusDot: () => null },
  }, { ...fixture.globals, ResizeObserver: FakeResizeObserver, setTimeout, clearTimeout, Event });
  const Menu = exports.ContextMenu as React.ComponentType<ContextMenuProps>;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const anchor = new DOMRect(20, 220, 40, 20);
  const render = async (label: string) => React.act(async () => {
    root.render(React.createElement(Menu, { ...(point ? { pos: { x: 80, y: 220 }, bare: true } : { anchor }), onClose: () => {}, children: React.createElement('button', null, label) }));
  });
  try {
    await render('Выключить на время…');
    const stack = document.querySelector<HTMLElement>(point ? '.ctx-menu' : '.ctx-stack'); assert.ok(stack);
    assert.equal(stack.classList.contains('sheet'), false, 'на телефоне якорное меню не превращается в лист');
    const initialTop = parseFloat(stack.style.top);
    assert.equal(initialTop, point ? 220 : 248, 'короткий главный вид помещается под якорем');
    assert.ok(initialTop + height <= window.innerHeight - 48);
    height = 340;
    await render('Список сроков');
    // Само изменение children не является resize: сигнал посылает реальный браузерный boundary.
    await React.act(async () => { for (const observer of observers) if (observer.target === stack) observer.callback(); });
    const top = parseFloat(stack.style.top);
    assert.ok(Number.isFinite(top) && top + height <= window.innerHeight - 48,
      'список сроков после ResizeObserver целиком выше системной вставки');
    if (point) assert.ok(top >= 40, 'меню не под верхней вставкой');
    assert.equal(top, 204, 'место пересчитано по новой высоте, а не осталось 248');
  } finally {
    await React.act(async () => root.unmount()); host.remove();
    fixture.restore();
  }
  assert.ok(observers.every(observer => observer.disconnected), 'наблюдатель отключён при размонтировании');
}

it('R114 якорное меню сроков учитывает native низ и пересчитывается при росте без смены якоря', async () => {
  await anchoredMenuCheck();
  for (const change of [
    (source: string) => source.replace('8, 8, viewportAboveSafeBottom()', '8, 8'),
    (source: string) => source.replace("if (!anchored || !el || typeof ResizeObserver === 'undefined') return;", 'if (true) return;'),
  ]) {
    await assert.rejects(anchoredMenuCheck(change), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.includes('список сроков после ResizeObserver целиком выше системной вставки'));
  }
});

it('R117 меню по точке пересчитывает положение после роста карточки и отключает второй наблюдатель', async () => {
  await anchoredMenuCheck(undefined, true);
  await assert.rejects(anchoredMenuCheck(source => source.replace(
    "if (anchored || sheet || !el || typeof ResizeObserver === 'undefined') return;", 'if (true) return;'), true),
  (error: unknown) => error instanceof assert.AssertionError && error.message.includes('список сроков после ResizeObserver целиком выше системной вставки'));
});
