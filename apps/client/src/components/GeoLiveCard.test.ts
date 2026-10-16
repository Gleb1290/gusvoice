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
import * as toast from '../toast';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const raw = read('./GeoLiveCard.tsx'), baseNow = 2_000_000;
const live: shared.ConvGeoLiveMedia = { kind: 'geolive', lat: 55, lon: 37, accuracy: 15, heading: null, period: 900, startedAt: baseNow, updatedAt: baseNow, until: baseNow + 900_000, stopped: false };
before(() => { GlobalRegistrator.register({ url: 'https://live.invalid' }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(async () => { Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); await GlobalRegistrator.unregister(); });
type Options = { features?: string[]; failMap?: boolean; source?: string; delayStop?: boolean; rejectStop?: boolean };
async function fixture(options: Options, work: (f: {
  host: HTMLDivElement; stops: string[][]; external: string[]; maps: Record<string, unknown>[]; follows: unknown[];
  render(value: shared.ConvGeoLiveMedia, mine?: boolean): Promise<void>; bar(id: string | undefined, list: { conversationId: string; messageId: string }[]): Promise<void>;
  click(selector: string): Promise<void>; tick(now: number): Promise<void>; finishStop(): Promise<void>;
}) => Promise<void>) {
  let now = baseNow, timerId = 0, finish!: () => void;
  type Timer = { callback: () => void; kind: 'timeout' | 'interval'; delay: number; due: number };
  const timers = new Map<number, Timer>(), stops: string[][] = [], external: string[] = [], maps: Record<string, unknown>[] = [], follows: unknown[] = [];
  class Clock extends Date { static now() { return now; } }
  const clockWindow = new Proxy(window, { get(target, key) {
    if (key === 'setTimeout' || key === 'setInterval') return (callback: () => void, delay = 0) => {
      const kind = key === 'setInterval' ? 'interval' : 'timeout', gap = Math.max(kind === 'interval' ? 1 : 0, Number(delay) || 0);
      timers.set(++timerId, { callback, kind, delay: gap, due: now + gap }); return timerId;
    };
    if (key === 'clearTimeout' || key === 'clearInterval') return (id: number) => timers.delete(id);
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  function load<T>(source: string, deps: Record<string, unknown>): T {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { module, exports: module.exports, window: clockWindow, document, location, navigator, localStorage, HTMLElement, Element, Node, Event, URL, Error,
        Date: Clock, getComputedStyle, MutationObserver, IntersectionObserver: undefined, console,
        require(id: string) { assert.equal(Object.hasOwn(deps, id), true, `целый geolive UI: ${id}`); return deps[id]; } });
    return module.exports as T;
  }
  class MapIo {
    constructor(spec: Record<string, unknown>) { maps.push(spec); }
    addControl() {} on() {} getSource() { return { setData() {} }; } jumpTo() {} fitBounds() {} easeTo(value: unknown) { follows.push(value); } setStyle() {} remove() {}
  }
  class MapBoundary extends MapIo { constructor(spec: Record<string, unknown>) { super(spec); if (options.failMap) throw new Error('fixture WebGL unavailable'); } }
  class MarkerIo { constructor(readonly options: { element: HTMLElement }) {} setLngLat() { return this; } addTo() { return this; } remove() {} getElement() { return this.options.element; } }
  const common = { react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM }, store = create(() => ({ serverFeatures: options.features ?? [], convAfterEdit() {} }));
  const { Icon } = load<typeof import('./Icon')>(read('./Icon.tsx'), common);
  const pictures = load<typeof import('../mapImage')>(read('../mapImage.ts'), { '@gusvoice/shared': shared, './api': { api: {} } });
  const sourceApi = load<typeof import('../mapSource')>(read('../mapSource.ts'), { '@gusvoice/shared': shared,
    './api': { api: { async mapInfo() { return { minzoom: 0, maxzoom: 14, bounds: [-180, -85, 180, 85], center: [37, 55] }; } }, getToken: () => 'fixture-token' }, './config': { config: { apiUrl: 'https://api.live.invalid' } } });
  const view = load(read('./MapView.tsx'), { ...common, '../mapRules': mapRules, '../mapSource': sourceApi, '../mapStyle': style,
    'maplibre-gl': { getWorkerUrl: () => 'worker', setWorkerUrl() {}, Map: MapBoundary, Marker: MarkerIo, AttributionControl: class {}, NavigationControl: class {} },
    'maplibre-gl/dist/maplibre-gl-worker.mjs?url': { default: 'worker' }, 'maplibre-gl/dist/maplibre-gl.css': {} });
  const back = load(read('../androidBack.ts'), { './hotkeys': hotkeys, './store': { useStore: store } }), chrome = load(read('../dialogChrome.ts'), { react: React, './androidBack': back });
  const mapLive = load(read('./GeoMapLive.tsx'), { ...common, '@gusvoice/shared': shared, '../dialogChrome': chrome, '../mapImage': pictures, './Icon': { Icon }, './MapView': view });
  const card = load(read('./ConvMediaCard.tsx'), { ...common, '@gusvoice/shared': shared, '../convSyncRules': sync, '../linkGuard': { openLink: (url: string) => external.push(url) },
    '../mapImage': pictures, '../store': { useStore: store }, './Icon': { Icon }, './Avatar': {}, './GeoMapLive': mapLive });
  const sharing = load<typeof import('../geoLiveSharing')>(read('../geoLiveSharing.ts'), { '@gusvoice/shared': shared, zustand: { create }, './hotkeys': hotkeys,
    './config': { config: { apiUrl: 'https://api.live.invalid' }, activeInstanceId: () => 'fixture-instance' }, './store': { useStore: store },
    './api': { getToken: () => 'fixture-token', api: { async convGeoLiveStop(conversationId: string, messageId: string) {
      stops.push([conversationId, messageId]); if (options.rejectStop) throw new Error('Остановка недоступна');
      if (options.delayStop) await new Promise<void>(resolve => { finish = resolve; }); return { id: messageId };
    } } } });
  const components = load<typeof import('./GeoLiveCard')>(options.source ?? raw, { ...common, '@gusvoice/shared': shared, '../convSyncRules': sync,
    '../geoLiveSharing': sharing, '../mapImage': pictures, '../store': { useStore: store }, '../toast': toast, './ConvMediaCard': card, './Icon': { Icon }, './GeoMapLive': mapLive });
  localStorage.removeItem('gv_geolive'); toast.useToasts.setState({ toasts: [] });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const flush = async () => React.act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
  try { await work({ host, stops, external, maps, follows,
    async render(value, mine = true) { await React.act(async () => root.render(React.createElement(components.GeoLiveCard, { live: value, mine, conversationId: 'mine-conv', messageId: 'mine-message' }))); await flush(); },
    async bar(id, list) { const rows = list.map(row => ({ ...row, until: live.until, instanceId: 'fixture-instance', native: false })); localStorage.setItem('gv_geolive', JSON.stringify(rows)); await React.act(async () => { sharing.useGeoLive.setState({ list: rows }); root.render(React.createElement(components.GeoLiveBar, { conversationId: id })); }); await flush(); },
    async click(selector) { const button = host.querySelector(selector) ?? document.querySelector(selector); assert.ok(button, selector); await React.act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await flush(); },
    async tick(at) {
      assert.ok(at >= now, 'часы идут только вперёд');
      let fired = 0;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= at).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) break;
        assert.ok(++fired <= 10_000, 'защита от бесконечного нулевого interval');
        const [id, timer] = next; now = timer.due;
        if (timer.kind === 'timeout') timers.delete(id); else timer.due += timer.delay;
        await React.act(async () => timer.callback()); await flush();
      }
      now = at; await flush();
    },
    async finishStop() { finish(); await flush(); },
  }); } finally { await React.act(async () => root.unmount()); sharing.stopAllGeoLiveLocal(); host.remove(); localStorage.removeItem('gv_geolive'); }
}
async function ownership(source = raw) { await fixture({ source }, async f => {
  await f.render(live, false); assert.equal(f.host.querySelectorAll('.msg-contact-act').length, 0, 'R225-stop-owner: чужую трансляцию нельзя остановить');
  await f.render(live); assert.equal(f.host.querySelectorAll('.msg-contact-act').length, 1);
  await f.render({ ...live, stopped: true }); assert.equal(f.host.querySelectorAll('.msg-contact-act').length, 0, 'R225-stop-ended: завершённую трансляцию нельзя остановить повторно');
}); }
it('R225 Остановить видна только автору незавершённой трансляции', () => ownership());
it('R225 карточка пересчитывает завершение по наступившим таймерам и границе until без новых данных', async () => {
  await fixture({}, async f => {
    await f.render(live); assert.equal(f.host.querySelectorAll('.geo-live-ring').length, 1);
    await f.tick(live.until - 1); assert.equal(f.host.querySelector('.geo-live')!.classList.contains('ended'), false);
    await f.tick(live.until); assert.equal(f.host.querySelector('.geo-live')!.classList.contains('ended'), true);
    assert.equal(f.host.querySelectorAll('.geo-live-ring,.msg-contact-act').length, 0); assert.match(f.host.textContent ?? '', /трансляция завершена/);
  });
  // until между тиками 15-секундного interval: завершение обязан доставить отдельный timeout на until + 50 мс.
  await fixture({}, async f => {
    const staggered = { ...live, startedAt: live.startedAt - 10_000, updatedAt: live.updatedAt - 10_000, until: live.until - 10_000 };
    await f.render(staggered);
    await f.tick(staggered.until - 1); assert.equal(f.host.querySelector('.geo-live')!.classList.contains('ended'), false);
    await f.tick(staggered.until); assert.equal(f.host.querySelector('.geo-live')!.classList.contains('ended'), false);
    await f.tick(staggered.until + 49); assert.equal(f.host.querySelector('.geo-live')!.classList.contains('ended'), false);
    await f.tick(staggered.until + 50); assert.equal(f.host.querySelector('.geo-live')!.classList.contains('ended'), true);
    assert.equal(f.host.querySelectorAll('.geo-live-ring,.msg-contact-act').length, 0);
  });
});
it('R225 двойное нажатие во время запроса не дублирует стоп, завершение снимает busy', async () => fixture({ delayStop: true }, async f => {
  await f.render(live); await f.click('.msg-contact-act'); assert.equal((f.host.querySelector('.msg-contact-act') as HTMLButtonElement).disabled, true);
  await f.click('.msg-contact-act'); assert.deepEqual(f.stops, [['mine-conv', 'mine-message']]); await f.finishStop(); assert.equal((f.host.querySelector('.msg-contact-act') as HTMLButtonElement).disabled, false);
}));
it('R225 ошибка остановки показывает настоящий тост и разрешает повтор', async () => fixture({ rejectStop: true }, async f => {
  await f.render(live); await f.click('.msg-contact-act'); assert.equal(toast.useToasts.getState().toasts.length, 1); assert.equal((f.host.querySelector('.msg-contact-act') as HTMLButtonElement).disabled, false);
}));
async function follows(source = raw) { await fixture({ features: ['osmmap1'], source }, async f => {
  await f.render(live); assert.equal(f.maps.length, 1); const before = f.follows.length;
  await f.render({ ...live, lat: 56, lon: 38, updatedAt: baseNow + 1000 }); assert.equal(f.follows.length > before, true, 'R225-map-follow: идущая точка ведёт камеру');
  await f.click('.msg-geo'); assert.equal(document.querySelector('.geo-full')?.getAttribute('aria-label'), 'Геопозиция в реальном времени'); assert.equal(f.maps.length, 2);
  const at = f.follows.length; await f.tick(live.until); assert.equal(f.follows.length, at);
  await f.render({ ...live, lat: 57, lon: 39, updatedAt: live.until, stopped: true }); assert.equal(f.follows.length === at, true, 'R225-ended-follow: после завершения обе камеры не преследуют метку');
  await f.click('.geo-full-foot button'); assert.equal(new URL(f.external[0]!).searchParams.get('pt'), '39,57');
}); }
it('R225 OSM следует за текущей точкой в карточке и fullscreen, после конца follow выключен', () => follows());
for (const failMap of [false, true]) it(`R225 текущие координаты открываются внешне ${failMap ? 'после отказа OSM' : 'без osmmap1'}`, async () => fixture({ features: failMap ? ['osmmap1'] : [], failMap }, async f => {
  await f.render(live); await f.render({ ...live, lat: 56, lon: 38, updatedAt: baseNow + 1000 }); await f.click('.msg-geo');
  assert.equal(new URL(f.external[0]!).searchParams.get('pt'), '38,56'); assert.equal(document.querySelector('.geo-full'), null);
}));
async function barScope(source = raw) { await fixture({ source }, async f => {
  const rows = [{ conversationId: 'mine-conv', messageId: 'a' }, { conversationId: 'other-conv', messageId: 'b' }, { conversationId: 'mine-conv', messageId: 'c' }];
  await f.bar(undefined, rows); assert.equal(f.host.querySelector('.geo-live-bar'), null);
  await f.bar('missing', rows); assert.equal(f.host.querySelectorAll('.geo-live-bar').length, 0, 'R225-bar-hidden: чужая беседа без моих трансляций не показывает плашку');
  await f.bar('mine-conv', rows); await f.click('.geo-live-bar button');
  assert.equal(JSON.stringify(f.stops), JSON.stringify([['mine-conv', 'a'], ['mine-conv', 'c']]), 'R225-bar-scope: стоп только своих сообщений этой беседы');
}); }
it('R225 GeoLiveBar скрыта вне нужной беседы и останавливает только её трансляции', () => barScope());
for (const m of [
  { label: 'владелец', from: 'mine && !ended && (', to: '!ended && (', check: ownership, prefix: 'R225-stop-owner:', actual: 1, expected: 0 },
  { label: 'завершение', from: 'mine && !ended && (', to: 'mine && (', check: ownership, prefix: 'R225-stop-ended:', actual: 1, expected: 0 },
  { label: 'следование', from: 'follow={!ended} onFail={failOsm}', to: 'follow={false} onFail={failOsm}', check: follows, prefix: 'R225-map-follow:', actual: false, expected: true },
  { label: 'полноэкранное следование после конца', from: 'follow={!ended}\n            title=', to: 'follow={true}\n            title=', check: follows, prefix: 'R225-ended-follow:', actual: false, expected: true },
  { label: 'беседа плашки', from: 's.conversationId === conversationId', to: 'true', check: barScope, prefix: 'R225-bar-hidden:', actual: 1, expected: 0 },
]) it(`R225 контрфакт карточки: ${m.label}`, async () => {
  await m.check(raw); assert.equal(raw.split(m.from).length - 1, 1);
  await assert.rejects(() => m.check(raw.replace(m.from, m.to)), e => e instanceof assert.AssertionError && e.message.startsWith(m.prefix)
    && e.operator === 'strictEqual' && e.actual === m.actual && e.expected === m.expected);
});
