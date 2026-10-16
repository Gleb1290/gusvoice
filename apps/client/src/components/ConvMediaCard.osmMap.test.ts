import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as jsx from 'react/jsx-runtime';
import { create } from 'zustand';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as sync from '../convSyncRules';
import * as mapRules from '../mapRules';
import * as style from '../mapStyle';
import * as hotkeys from '../hotkeys';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const raw = read('./ConvMediaCard.tsx'), geo: shared.ConvGeoMedia = { kind: 'geo', lat: 55, lon: 37, accuracy: 15 };
before(() => { GlobalRegistrator.register({ url: 'https://maps.invalid' }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(async () => { Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); await GlobalRegistrator.unregister(); });
function load<T>(source: string, deps: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, window, document, location, HTMLElement, Element, Node, Event, URL, getComputedStyle,
      MutationObserver, IntersectionObserver: undefined, console, ...globals,
      require(id: string) { assert.equal(Object.hasOwn(deps, id), true, `целый модуль OSM UI: ${id}`); return deps[id]; } });
  return module.exports as T;
}
type Fixture = { host: HTMLDivElement; maps: Record<string, unknown>[]; images: string[]; external: string[]; fail(): void; flush(): Promise<void>; click(selector: string): Promise<void> };
async function fixture(features: string[], work: (f: Fixture) => Promise<void>, source = raw, initialFail = false) {
  const maps: Record<string, unknown>[] = [], images: string[] = [], external: string[] = [];
  let fail = initialFail;
  // Только граница WebGL/MapLibre заменена: все компоненты, mapSource/mapImage и построение стиля исполняются целиком.
  class MapIo {
    constructor(options: Record<string, unknown>) { maps.push(options); if (fail) throw new Error('fixture WebGL unavailable'); }
    addControl() {} on(_event: string, _callback: () => void) {} getSource() { return { setData() {} }; } jumpTo() {} fitBounds() {} easeTo() {} setStyle() {} remove() {}
  }
  class MarkerIo {
    constructor(readonly options: { element: HTMLElement }) {} setLngLat() { return this; } addTo() { return this; } remove() {} getElement() { return this.options.element; }
  }
  const common = { react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM }, store = create(() => ({ serverFeatures: features }));
  const { Icon } = load<typeof import('./Icon')>(read('./Icon.tsx'), common);
  const pictures = load<typeof import('../mapImage')>(read('../mapImage.ts'), { '@gusvoice/shared': shared, './api': { api: { async mapStaticImage(path: string) { images.push(path); return new Blob(['png'], { type: 'image/png' }); } } } },
    { URL: { createObjectURL: () => 'blob:r224-yandex', revokeObjectURL() {} } });
  const sourceApi = load<typeof import('../mapSource')>(read('../mapSource.ts'), { '@gusvoice/shared': shared,
    './api': { api: { async mapInfo() { return { minzoom: 0, maxzoom: 14, bounds: [-180, -85, 180, 85], center: [37, 55] }; } }, getToken: () => 'fixture-token' }, './config': { config: { apiUrl: 'https://api.maps.invalid' } } });
  const view = load<typeof import('./MapView')>(read('./MapView.tsx'), { ...common, '../mapRules': mapRules, '../mapSource': sourceApi, '../mapStyle': style,
    'maplibre-gl': { getWorkerUrl: () => 'worker', setWorkerUrl() {}, Map: MapIo, Marker: MarkerIo, AttributionControl: class {}, NavigationControl: class {} },
    'maplibre-gl/dist/maplibre-gl-worker.mjs?url': { default: 'worker' }, 'maplibre-gl/dist/maplibre-gl.css': {} });
  const back = load(read('../androidBack.ts'), { './hotkeys': hotkeys, './store': { useStore: store } });
  const chrome = load(read('../dialogChrome.ts'), { react: React, './androidBack': back });
  const live = load<typeof import('./GeoMapLive')>(read('./GeoMapLive.tsx'), { ...common, '@gusvoice/shared': shared, '../dialogChrome': chrome,
    '../mapImage': pictures, './Icon': { Icon }, './MapView': view });
  const card = load<typeof import('./ConvMediaCard')>(source, { ...common, '@gusvoice/shared': shared, '../convSyncRules': sync,
    '../linkGuard': { openLink: (url: string) => external.push(url) }, '../mapImage': pictures, '../store': { useStore: store }, './Icon': { Icon },
    './Avatar': { Avatar: () => assert.fail('геопозиция не рисует контакт') }, './GeoMapLive': live });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const flush = async () => { await React.act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); };
  try {
    await React.act(async () => root.render(React.createElement(card.GeoCard, { geo }))); await flush();
    await work({ host, maps, images, external, fail() { fail = true; }, flush,
      async click(selector) { const button = (host.querySelector(selector) ?? document.querySelector(selector)); assert.ok(button, selector); await React.act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await flush(); } });
  } finally { await React.act(async () => root.unmount()); host.remove(); }
}
it('R224 osmmap1 показывает настоящий GeoMapLive/MapView, клик открывает GeoMapFull и закрытие возвращает карточку', async () => fixture(['osmmap1'], async f => {
  assert.equal(f.host.querySelectorAll('.msg-geo-live .gv-map').length, 1); assert.equal(f.images.length, 0); assert.equal(f.maps.length, 1);
  assert.equal(f.maps[0]!.interactive, false); assert.deepEqual(f.maps[0]!.center, [37, 55]);
  await f.click('.msg-geo'); assert.equal(document.querySelectorAll('.geo-full[role="dialog"]').length, 1);
  assert.equal(f.maps.length, 2); assert.equal(f.maps[1]!.interactive, true); assert.deepEqual(f.external, []);
  await f.click('.geo-full .icon-close'); assert.equal(document.querySelector('.geo-full'), null);
}));
it('R224 yamap1 сохраняет картинку Яндекса и открытие внешних карт без MapLibre', async () => fixture(['yamap1'], async f => {
  assert.equal(f.host.querySelectorAll('img').length, 1); assert.equal(f.images.length, 1); assert.equal(f.maps.length, 0);
  await f.click('.msg-geo'); assert.equal(f.external.length, 1); assert.match(f.external[0]!, /^https:\/\/yandex\.ru\/maps\//); assert.equal(document.querySelector('.geo-full'), null);
}));
async function priority(source = raw) { await fixture(['yamap1', 'osmmap1'], async f => {
  assert.equal(f.maps.length, 1, 'R224-osm-priority: своя карта приоритетнее картинки'); assert.equal(f.images.length, 0);
}, source); }
it('R224 при двух признаках OSM имеет приоритет без фонового запроса картинки', () => priority());
async function fullFailure(source = raw) { await fixture(['yamap1', 'osmmap1'], async f => {
  f.fail(); await f.click('.msg-geo'); // Ошибка новой интерактивной карты не ломает маленькую: проверяем и этот независимый отказ.
  assert.equal(document.querySelector('.geo-full-fail')?.textContent, 'Карта недоступна'); await f.click('.geo-full .icon-close');
}, source); }
it('R224 ошибка WebGL в полноэкранной карте показывает локальный отказ, не уничтожая карточку', () => fullFailure());
async function fallback(source = raw) { await fixture(['yamap1', 'osmmap1'], async f => {
  assert.equal(f.images.length, 1, 'R224-osm-fallback: onFail маленькой карты переключает на Яндекс');
  assert.equal(f.host.querySelector('.msg-geo-live'), null); assert.equal(f.host.querySelector('img')?.getAttribute('src'), 'blob:r224-yandex');
  await f.click('.msg-geo'); assert.equal(f.external.length, 1); assert.equal(document.querySelector('.geo-full'), null);
}, source, true); }
it('R224 onFail маленькой OSM карты переключает на Яндекс и прежний внешний клик', () => fallback());
it('R224 без обоих признаков остаются координаты, нет запросов и карты', async () => fixture([], async f => {
  assert.equal(f.maps.length, 0); assert.equal(f.images.length, 0); assert.equal(f.host.querySelector('.msg-geo-map'), null); assert.match(f.host.textContent ?? '', /Геопозиция/);
}));
it('R224 контрфакт отключение приоритета OSM ловится оригинальным сценарием', async () => {
  await priority(raw); const from = 'const liveMap = osmOn && !osmFailed;'; assert.equal(raw.split(from).length - 1, 1);
  await assert.rejects(() => priority(raw.replace(from, 'const liveMap = osmOn && !osmFailed && !mapOn;')), e => e instanceof assert.AssertionError
    && e.message.startsWith('R224-osm-priority:') && e.operator === 'strictEqual' && e.actual === 0 && e.expected === 1);
});
it('R224 контрфакт игнорирование onFail не оставляет вечную пустую карту вместо Яндекса', async () => {
  await fallback(raw); const from = 'const liveMap = osmOn && !osmFailed;'; assert.equal(raw.split(from).length - 1, 1);
  await assert.rejects(() => fallback(raw.replace(from, 'const liveMap = osmOn;')), e => e instanceof assert.AssertionError
    && e.message.startsWith('R224-osm-fallback:') && e.operator === 'strictEqual' && e.actual === 0 && e.expected === 1);
});
