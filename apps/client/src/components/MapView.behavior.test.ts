import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import * as rules from '../mapRules';
import type { MapViewProps } from './MapView';

const raw = readFileSync(new URL('./MapView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
before(() => { GlobalRegistrator.register({ url: 'https://map-view.invalid' }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(async () => { Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); await GlobalRegistrator.unregister(); });
type XY = { lat: number; lng: number };
async function fixture(initial: MapViewProps, check: (f: {
  options: Record<string, unknown>; moves: Array<{ lat: number; lon: number }>; eases: Record<string, unknown>[];
  gesture(event: boolean, pixels: number): Promise<void>; render(props: Partial<MapViewProps>): Promise<void>;
}) => Promise<void>, source = raw) {
  const moves: Array<{ lat: number; lon: number }> = [], eases: Record<string, unknown>[] = [];
  let options!: Record<string, unknown>, removed = 0, failures = 0, center: XY = { lat: 10, lng: 20 };
  const listeners = new Map<string, (e: { originalEvent?: unknown }) => void>();
  class FakeMap {
    constructor(value: Record<string, unknown>) { options = value; }
    addControl() {} on(name: string, cb: (e: { originalEvent?: unknown }) => void) { listeners.set(name, cb); }
    getCenter() { return { ...center }; }
    // Это явная граница MapLibre: один шаг долготы здесь равен одному экранному пикселю, не измерение happy-dom.
    project(point: XY) { return { x: point.lng, y: point.lat }; }
    getZoom() { return 9; } getSource() { return undefined; }
    jumpTo() {} fitBounds() {} setStyle() {}
    easeTo(value: Record<string, unknown>) { eases.push(value); }
    remove() { removed++; }
  }
  class FakeMarker {
    constructor(private opts: { element: HTMLElement }) {}
    setLngLat() { return this; } addTo() { return this; } remove() {} getElement() { return this.opts.element; }
  }
  const ml = { Map: FakeMap, Marker: FakeMarker, AttributionControl: class {}, NavigationControl: class {}, getWorkerUrl: () => 'worker', setWorkerUrl() {} };
  const deps: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsx, '../mapRules': rules,
    '../mapSource': { loadMapInfo: async () => ({ bounds: [-50, -20, 80, 70], center: [30, 40], minzoom: 0 }), mapApiBase: () => '/api/maps', mapTransformRequest: () => ({}) },
    'maplibre-gl': ml, '../mapStyle': { buildMapStyle: () => ({}) }, 'maplibre-gl/dist/maplibre-gl-worker.mjs?url': { default: 'worker' }, 'maplibre-gl/dist/maplibre-gl.css': {} };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, window, document, MutationObserver, getComputedStyle,
      require(id: string) { assert.ok(Object.hasOwn(deps, id), `MapView: незаявленный импорт ${id}`); return deps[id]; } });
  const { MapView } = module.exports as typeof import('./MapView');
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let props: MapViewProps = { ...initial, onUserMove: value => moves.push(value), onFail: () => { failures++; } };
  const render = async (next: Partial<MapViewProps>) => { props = { ...props, ...next }; await React.act(async () => { root.render(React.createElement(MapView, props)); for (let i = 0; i < 12; i++) await Promise.resolve(); }); };
  try {
    await render({}); assert.ok(options, 'настоящий эффект создал MapLibre через закрытые импорты');
    await check({ options, moves, eases, render, async gesture(event, pixels) {
      await React.act(async () => {
        listeners.get('movestart')!({ originalEvent: event ? new Event('pointerdown') : undefined });
        center = { lat: center.lat, lng: center.lng + pixels }; listeners.get('moveend')!({});
      });
    } });
  } finally { await React.act(async () => root.unmount()); host.remove(); }
  assert.equal(removed, 1, 'MapLibre снят вместе с компонентом');
  assert.equal(failures, 0, 'исключения loader/MapLibre не спрятаны в штатном onFail');
}

async function gestures(source = raw) {
  await fixture({ points: [], interactive: true }, async f => {
    await f.gesture(false, 20); assert.equal(f.moves.length, 0, 'R231-map-event: программное движение не выбирает место');
    await f.gesture(true, 5.999); assert.equal(f.moves.length, 0, 'R231-map-small: движение меньше 6 px не выбирает место');
    await f.gesture(true, 6); assert.equal(f.moves.length, 1, 'R231-map-edge: ровно 6 px выбирают место');
    assert.equal(f.moves[0]!.lat, 10); assert.equal(f.moves[0]!.lon, 51.999);
    await f.gesture(false, 20); assert.equal(f.moves.length, 1, 'программный ход после жеста тоже не выбирает место');
  }, source);
}
it('R231 только реальный жест сдвигает выбранное место, порог проверен с обеих сторон', () => gestures());
it('R231 recenter возвращает камеру к первой актуальной точке и не ниже масштаба одиночного места', () => fixture({ points: [{ lat: 50, lon: 30 }, { lat: 60, lon: 40 }], recenter: 0 }, async f => {
  assert.equal(f.eases.length, 0); await f.render({ recenter: 1 });
  assert.equal(JSON.stringify(f.eases), JSON.stringify([{ center: [30, 50], zoom: rules.MAP_POINT_ZOOM, duration: 500 }]));
  await f.render({ points: [{ lat: 51, lon: 31 }], recenter: 2 });
  assert.equal(JSON.stringify(f.eases[1]), JSON.stringify({ center: [31, 51], zoom: rules.MAP_POINT_ZOOM, duration: 500 }));
}));
it('R231 emptyCenter без точек ставит долготу перед широтой и масштаб одиночной точки', () => fixture({ points: [], emptyCenter: { lat: 55, lon: 37 }, emptyFit: true }, async f => {
  assert.equal(JSON.stringify(f.options.center), '[37,55]'); assert.equal(f.options.zoom, rules.MAP_POINT_ZOOM); assert.equal(f.options.bounds, undefined);
}));
it('R231 без последнего места emptyFit показывает весь файл карты, а не нулевой меридиан крупно', () => fixture({ points: [], emptyFit: true }, async f => {
  assert.equal(JSON.stringify(f.options.bounds), '[[-50,-20],[80,70]]'); assert.equal(f.options.center, undefined);
}));
for (const m of [
  { label: 'программное движение принято за жест', from: 'if (!e.originalEvent) return;', to: '', prefix: 'R231-map-event:', actual: 1, expected: 0 },
  { label: 'порог отвергает ровно 6 пикселей', from: '< USER_MOVE_MIN_PX', to: '<= USER_MOVE_MIN_PX', prefix: 'R231-map-edge:', actual: 0, expected: 1 },
]) it(`R231 контрфакт MapView: ${m.label}`, async () => {
  await gestures(raw); assert.equal(raw.split(m.from).length - 1, 1, 'единственный якорь мутации');
  await assert.rejects(() => gestures(raw.replace(m.from, m.to)), e => e instanceof assert.AssertionError && e.message.startsWith(m.prefix)
    && e.operator === 'strictEqual' && e.actual === m.actual && e.expected === m.expected);
});
