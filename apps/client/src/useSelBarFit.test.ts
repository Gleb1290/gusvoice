import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { fitSelBar, selBarCut } from './useSelBarFit';

const source = readFileSync(new URL('./useSelBarFit.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
before(() => {
  GlobalRegistrator.register();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(() => GlobalRegistrator.unregister());

type Step = 'plain' | 'n' | 'col';
function panel(widths: Record<Step, number[]>, client = 100) {
  const bar = document.createElement('div');
  const measurements: Step[] = [];
  let width = 300;
  Object.defineProperty(bar, 'clientWidth', { get: () => width });
  for (let i = 0; i < widths.plain.length; i++) {
    const label = document.createElement('span');
    label.className = 'sel-bar-label';
    Object.defineProperties(label, {
      clientWidth: { get: () => client },
      scrollWidth: { get: () => {
        const step = (bar.getAttribute('data-fit') ?? 'plain') as Step;
        measurements.push(step);
        return widths[step][i];
      } },
    });
    bar.append(label);
  }
  return { bar, measurements, widths, resize: (next: number) => { width = next; } };
}
function dimensions(plain: number[], n = plain, col = n): Record<Step, number[]> { return { plain, n, col }; }
function mutate(from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'мутант меняет ровно один участок');
  return source.replace(from, to);
}

// Исполняется целый модуль, не извлечённый фрагмент: зависимости хука контролируются отдельно от React.
function load(raw = source, observerOn = true) {
  let resolveFonts!: () => void;
  const ready = new Promise<void>(resolve => { resolveFonts = resolve; });
  const observers: { callback: () => void; watched: Element[]; disconnected: boolean }[] = [];
  class Observer {
    entry: typeof observers[number];
    constructor(callback: () => void) {
      this.entry = { callback, watched: [], disconnected: false };
      observers.push(this.entry);
    }
    observe(el: Element) { this.entry.watched.push(el); }
    disconnect() { this.entry.disconnected = true; }
  }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports,
    require: (id: string) => { assert.equal(id, 'react'); return React; },
    document: { fonts: { ready } }, ResizeObserver: observerOn ? Observer : undefined,
  });
  return { api: module.exports as typeof import('./useSelBarFit'), observers, resolveFonts };
}

it('R123 подписи короче доступной ширины и ровно на границе остаются без ступени', () => {
  // Ловит >=: точное совпадение ширин ещё не является обрезкой.
  for (const widths of [[99], [100], [0]]) {
    const p = panel(dimensions(widths));
    assert.equal(selBarCut(p.bar), false);
    fitSelBar(p.bar);
    assert.equal(p.bar.hasAttribute('data-fit'), false);
  }
});

it('R123 лишний пиксель хотя бы у последней подписи скрывает число, если этого хватает', () => {
  // Ловит проверку лишь первой кнопки и пропуск промежуточной ступени n.
  const p = panel(dimensions([99, 100, 101], [99, 100, 100]));
  assert.equal(selBarCut(p.bar), true);
  p.measurements.length = 0;
  fitSelBar(p.bar);
  assert.equal(p.bar.getAttribute('data-fit'), 'n');
  assert.deepEqual(p.measurements, ['plain', 'plain', 'plain', 'n', 'n', 'n']);
});

it('R123 оставшаяся после скрытия числа обрезка включает столбик, даже при предельно длинной подписи', () => {
  // Ловит остановку на n: ещё один замер обязателен перед решением.
  const p = panel(dimensions([101], [101], [1000]));
  fitSelBar(p.bar);
  assert.equal(p.bar.getAttribute('data-fit'), 'col');
  assert.deepEqual(p.measurements, ['plain', 'n']);
});

it('R123 старые n и col снимаются перед первым замером и не переживают расширение панели', () => {
  // Ловит липкую компактную раскладку после поворота телефона.
  for (const old of ['n', 'col']) {
    const p = panel(dimensions([100], [101], [101]));
    p.bar.setAttribute('data-fit', old);
    fitSelBar(p.bar);
    assert.equal(p.bar.hasAttribute('data-fit'), false);
    assert.deepEqual(p.measurements, ['plain']);
  }
});

it('R123 панель без подписей и пустые подписи не требуют компактного режима', () => {
  // Ловит ошибочное ужатие пустой панели/0 > 0 и поиск постороннего переполненного узла.
  for (const widths of [[], [0]]) {
    const p = panel(dimensions(widths), 0);
    const other = document.createElement('span');
    Object.defineProperties(other, { scrollWidth: { value: 999 }, clientWidth: { value: 1 } });
    p.bar.append(other);
    p.bar.setAttribute('data-fit', 'col');
    fitSelBar(p.bar);
    assert.equal(p.bar.hasAttribute('data-fit'), false);
  }
});

it('R123 контрфакты пропуска n, неснятого атрибута и обеих неверных границ обнаруживаются поведением', () => {
  // Мутанты проходят те же измерения, что оригинал; не копируем алгоритм в тест.
  const cases = [
    { raw: mutate("bar.setAttribute('data-fit', 'n');", "bar.setAttribute('data-fit', 'col');"), widths: dimensions([101], [100], [100]), old: null, expected: 'n' },
    { raw: mutate("bar.removeAttribute('data-fit');", ''), widths: dimensions([100], [100], [100]), old: 'col', expected: null },
    { raw: mutate('label.scrollWidth > label.clientWidth', 'label.scrollWidth >= label.clientWidth'), widths: dimensions([100]), old: null, expected: null },
    { raw: mutate('label.scrollWidth > label.clientWidth', 'label.scrollWidth < label.clientWidth'), widths: dimensions([101], [100]), old: null, expected: 'n' },
  ];
  for (const c of cases) {
    const check = (raw: string) => {
      const p = panel(c.widths);
      if (c.old) p.bar.setAttribute('data-fit', c.old);
      load(raw).api.fitSelBar(p.bar);
      assert.equal(p.bar.getAttribute('data-fit'), c.expected);
    };
    check(source);
    assert.throws(() => check(c.raw), assert.AssertionError);
  }
});

async function mounted(raw = source, observerOn = true, missingRef = false) {
  const h = load(raw, observerOn), p = panel(dimensions([101], [100]));
  const host = document.createElement('div');
  document.body.append(host, p.bar);
  const root = createRoot(host);
  const ref: React.RefObject<HTMLElement | null> = { current: missingRef ? null : p.bar };
  function Harness({ value }: { value: string }) { h.api.useSelBarFit(ref, value); return null; }
  const render = async (value: string) => { await React.act(async () => root.render(React.createElement(Harness, { value }))); };
  await render('1');
  return { ...h, ...p, render, async cleanup() {
    await React.act(async () => root.unmount());
    host.remove(); p.bar.remove();
  } };
}

it('R123 хук меряет при показе и смене ключа, но не при повторе того же ключа', async () => {
  // Ловит забытый key: новое число выбранных меняет доступное место для подписей.
  const h = await mounted();
  try {
    assert.equal(h.bar.getAttribute('data-fit'), 'n');
    h.measurements.length = 0;
    h.widths.plain = [100];
    await h.render('1');
    assert.equal(h.measurements.length, 0);
    await h.render('12');
    assert.equal(h.bar.hasAttribute('data-fit'), false);
    assert.deepEqual(h.measurements, ['plain']);
    assert.equal(h.observers[0].disconnected, true);
    assert.equal(h.observers.length, 2);
  } finally { await h.cleanup(); }
});

it('R123 ResizeObserver следит за самой панелью и перемеряет только при изменении её ширины', async () => {
  // Ловит бесконечное перемеривание от изменения высоты после n/col и пропущенный поворот.
  const h = await mounted();
  try {
    assert.equal(h.observers[0].watched[0], h.bar);
    h.measurements.length = 0;
    h.observers[0].callback();
    assert.equal(h.measurements.length, 0);
    h.widths.plain = [100]; h.resize(400);
    h.observers[0].callback();
    assert.equal(h.bar.hasAttribute('data-fit'), false);
    assert.deepEqual(h.measurements, ['plain']);
    h.measurements.length = 0;
    h.observers[0].callback();
    assert.equal(h.measurements.length, 0);
  } finally { await h.cleanup(); }
});

it('R123 догрузка шрифта повторяет замер, хотя ширина панели не менялась', async () => {
  // Ловит шрифт, ставший шире уже после первой подгонки.
  const h = await mounted();
  try {
    h.measurements.length = 0;
    h.widths.plain = [101]; h.widths.n = [101];
    await React.act(async () => { h.resolveFonts(); await Promise.resolve(); });
    assert.equal(h.bar.getAttribute('data-fit'), 'col');
    assert.deepEqual(h.measurements, ['plain', 'n']);
  } finally { await h.cleanup(); }
});

it('R123 размонтирование отключает наблюдателя и не допускает поздний замер догрузившегося шрифта', async () => {
  // Ловит позднее изменение DOM прежней панели после закрытия выбора.
  const h = await mounted();
  await h.cleanup();
  // DOM снова подключён: запрещён именно поздний эффект закрытого хука, а не только isConnected.
  document.body.append(h.bar);
  h.measurements.length = 0;
  try {
    await React.act(async () => { h.resolveFonts(); await Promise.resolve(); });
    assert.equal(h.observers[0].disconnected, true);
    assert.equal(h.measurements.length, 0);
  } finally { h.bar.remove(); }
});

it('R123 отключённая от документа панель не перемеряется после загрузки шрифта', async () => {
  // Ловит работу с отсоединённым DOM ещё до cleanup React.
  const h = await mounted();
  try {
    h.bar.remove(); h.measurements.length = 0;
    await React.act(async () => { h.resolveFonts(); await Promise.resolve(); });
    assert.equal(h.measurements.length, 0);
  } finally { await h.cleanup(); }
});

it('R123 отсутствие ResizeObserver и пустой ref не ломают показ панели', async () => {
  // Ловит необязательные браузерные API и условно ещё не показанную панель выбора.
  const h = await mounted(source, false);
  try { assert.equal(h.bar.getAttribute('data-fit'), 'n'); assert.equal(h.observers.length, 0); }
  finally { await h.cleanup(); }
  const absent = await mounted(source, true, true);
  try {
    assert.equal(absent.measurements.length, 0);
    assert.equal(absent.observers.length, 0);
    await React.act(async () => { absent.resolveFonts(); await Promise.resolve(); });
    assert.equal(absent.measurements.length, 0);
  } finally { await absent.cleanup(); }
});
