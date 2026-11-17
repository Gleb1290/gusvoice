import assert from 'node:assert/strict';
import { before, after, it } from 'node:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { placeByPoint, viewportSafe } from './popover.ts';

before(() => GlobalRegistrator.register({ url: 'http://localhost/' }));
after(() => GlobalRegistrator.unregister());

type Measurement = {
  top?: number; bottom?: number; left?: number; right?: number; zoom?: number; titlebar?: number;
  width?: number; height?: number; visual?: { width: number; height: number };
};
function measure({ top = 0, bottom = 0, left = 0, right = 0, zoom = 1, titlebar = 0,
  width = 900, height = 600, visual }: Measurement = {}) {
  const restore: Array<() => void> = [];
  const patch = (target: object, key: string, descriptor: PropertyDescriptor) => {
    const old = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    restore.push(() => { if (old) Object.defineProperty(target, key, old); else Reflect.deleteProperty(target, key); });
  };
  const create = document.createElement.bind(document);
  let probe: HTMLElement | undefined;
  let measurements = 0;
  const children = document.body.childElementCount;
  patch(document.documentElement, 'clientWidth', { value: width });
  patch(document.documentElement, 'clientHeight', { value: height });
  patch(window, 'visualViewport', { value: visual ?? null });
  patch(document, 'createElement', { value: (tag: string) => { probe = create(tag); return probe; } });
  // HappyDOM не вычисляет env()/max(): здесь граница браузерного измерения,
  // а перевод viewport, учёт вставок и размещение меню — настоящие продуктовые функции.
  patch(globalThis, 'getComputedStyle', { value: (element: Element) => {
    if (element === document.documentElement) return { zoom: String(zoom) };
    assert.equal(element, probe);
    assert.ok(document.body.contains(element), 'измеряется подключённый к DOM элемент');
    measurements++;
    return { paddingTop: `${top}px`, paddingBottom: `${bottom}px`, paddingLeft: `${left}px`, paddingRight: `${right}px`, marginTop: `${titlebar}px` };
  } });
  try {
    const result = viewportSafe();
    assert.equal(measurements, 1);
    assert.equal(document.body.childElementCount, children, 'проба не остаётся в DOM после замера');
    assert.equal(probe?.isConnected, false);
    return result;
  } finally {
    probe?.remove();
    for (const undo of restore.reverse()) undo();
  }
}

it('без системных вставок доступно всё окно без лишних смещений', () => {
  assert.deepEqual(measure(), { vw: 900, vh: 600 });
});
it('навигация слева сдвигает начало доступной области, сохраняя правую кромку', () => {
  assert.deepEqual(measure({ left: 48 }), { vw: 900, vh: 600, left: 48 });
});
it('навигация справа сокращает правую кромку без левого сдвига', () => {
  assert.deepEqual(measure({ right: 48 }), { vw: 852, vh: 600 });
});
it('четыре разные вставки сохраняют свои стороны и не масштабируются повторно', () => {
  assert.deepEqual(measure({ top: 32, bottom: 24, left: 48, right: 36, zoom: 1.5 }),
    { vw: 564, vh: 376, top: 32, left: 48 });
});
it('полоса окна удерживает высокое меню ниже себя с зазором', () => {
  const vp = measure({ titlebar: 32 });
  assert.deepEqual(vp, { vw: 900, vh: 600, top: 32 });
  assert.equal(placeByPoint(400, 590, 200, 580, 8, vp).top, 40);
});
it('без полосы окна высокое меню может подниматься к прежней верхней границе', () => {
  const vp = measure();
  assert.equal(placeByPoint(400, 590, 200, 580, 8, vp).top, 10);
});
it('полоса окна складывается с верхней системной вставкой при увеличенном интерфейсе', () => {
  assert.deepEqual(measure({ top: 24, bottom: 12, left: 6, right: 4, zoom: 1.5, titlebar: 32 }),
    { vw: 596, vh: 388, top: 56, left: 6 });
});
it('на телефоне клавиатура сокращает доступное место, меню остаётся над нижней вставкой', () => {
  const vp = measure({ width: 390, height: 844, visual: { width: 390, height: 420 }, top: 24, bottom: 16 });
  assert.deepEqual(vp, { vw: 390, vh: 404, top: 24 });
  const placed = placeByPoint(380, 400, 200, 180, 8, vp);
  assert.deepEqual(placed, { left: 180, top: 216 });
});
it('visual viewport больше окна не расширяет доступную область', () => {
  assert.deepEqual(measure({ visual: { width: 1000, height: 700 } }), { vw: 900, vh: 600 });
});
