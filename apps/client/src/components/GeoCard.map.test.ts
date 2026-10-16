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
import * as hotkeys from '../hotkeys';
import * as safety from '../linkSafety';
import * as dangerousRules from '../dangerousLinkRules';
import * as confirm from '../confirm';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const source = read('./ConvMediaCard.tsx');
const yandex = 'https://yandex.ru/maps/?pt=20,10&z=16&l=map';
const geo: shared.ConvGeoMedia = { kind: 'geo', lat: 10, lon: 20, accuracy: 15 };
before(() => {
  GlobalRegistrator.register({ url: 'https://geo.example.test' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

type Options = { features?: string[]; fail?: boolean; noObserver?: boolean; deferred?: boolean; bridge?: 'handled' | 'declined' | 'throws' | 'missing'; theme?: 'light' | 'dark' };
function moduleOf<T>(raw: string, deps: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { module, exports: module.exports, ...globals,
    require(id: string) { assert.equal(Object.hasOwn(deps, id), true, `явный импорт целого GeoCard: ${id}`); return deps[id]; } });
  return module.exports as T;
}
function build(options: Options = {}, raw = source) {
  const web: unknown[][] = [], native: string[][] = [], requests: string[] = [], revoked: string[] = [];
  let finish!: (blob: Blob) => void;
  const pending = options.deferred ? new Promise<Blob>(resolve => { finish = resolve; }) : undefined;
  const physicalWindow: { open(...args: unknown[]): void; GusVoiceNative?: { openExternalUri?: (uri: string, fallback: string) => boolean } } = {
    open: (...args) => { web.push(args); },
  };
  if (options.bridge) physicalWindow.GusVoiceNative = options.bridge === 'missing' ? {} : { openExternalUri(uri, fallback) {
    native.push([uri, fallback]);
    if (options.bridge === 'throws') throw new Error('fixture native unavailable');
    return options.bridge === 'handled';
  } };
  // Весь linkGuard и его циклический dangerousLink настоящие. Подменено только открытие ОС/вкладки и config.
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  function linkModule(name: './linkGuard' | './dangerousLink'): Record<string, unknown> {
    const hit = cache.get(name); if (hit) return hit.exports;
    const module = { exports: {} as Record<string, unknown> }; cache.set(name, module);
    const deps: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM,
      './config': { config: { apiUrl: 'https://api.geo.example.test' } }, './hotkeys': hotkeys,
      './desktopWindow': { openExternal: async (url: string) => { web.push([url, 'OS']); } }, './linkSafety': safety,
      './dangerousLinkRules': dangerousRules, './confirm': confirm, './components/Icon': { Icon } };
    runInNewContext(ts.transpileModule(read(`.${name}.tsx`), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText, { module, exports: module.exports, URL, document, location, window: physicalWindow,
      require(id: string) {
        if (id === './linkGuard' || id === './dangerousLink') return linkModule(id);
        assert.equal(Object.hasOwn(deps, id), true, `явный импорт целого ${name}: ${id}`); return deps[id];
      } });
    return module.exports;
  }
  const pictures = moduleOf<typeof import('../mapImage')>(read('../mapImage.ts'), {
    '@gusvoice/shared': shared, './api': { api: { mapStaticImage(path: string) {
      requests.push(path); return pending ?? (options.fail ? Promise.reject(new Error('fixture map unavailable'))
        : Promise.resolve(new Blob(['map'], { type: 'image/png' })));
    } } },
  }, { document, URL: { createObjectURL: () => 'blob:geo-card-map', revokeObjectURL: (url: string) => revoked.push(url) } });
  const observers: Observer[] = [];
  class Observer {
    targets: Element[] = []; disconnects = 0;
    constructor(readonly callback: (entries: { isIntersecting: boolean }[]) => void, readonly options: IntersectionObserverInit) { observers.push(this); }
    observe(target: Element) { this.targets.push(target); }
    disconnect() { this.disconnects++; }
  }
  const store = create<{ serverFeatures: string[] }>(() => ({ serverFeatures: options.features ?? ['yamap1'] }));
  const card = moduleOf<typeof import('./ConvMediaCard')>(raw, {
    '@gusvoice/shared': shared, react: React, 'react/jsx-runtime': jsx, '../convSyncRules': sync,
    '../linkGuard': linkModule('./linkGuard'), '../mapImage': pictures, '../store': { useStore: store }, './Avatar': { Avatar }, './Icon': { Icon },
  }, { window: physicalWindow, IntersectionObserver: options.noObserver ? undefined : Observer });
  return { card, web, native, requests, observers, store, revoked, finish: () => finish(new Blob(['late-map'], { type: 'image/png' })) };
}
async function fixture(options: Options, work: (f: ReturnType<typeof build> & {
  host: HTMLDivElement; enter(visible?: boolean): Promise<void>; unmount(): Promise<void>; flush(): Promise<void>;
}) => Promise<void>, raw = source) {
  const previousTheme = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', options.theme ?? 'dark');
  const f = build(options, raw), host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); let mounted = true;
  const flush = async () => { await React.act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); }); };
  const unmount = async () => { if (mounted) { mounted = false; await React.act(async () => root.unmount()); } };
  try {
    await React.act(async () => root.render(React.createElement(f.card.GeoCard, { geo })));
    await work({ ...f, host, flush, unmount, async enter(visible = true) {
      assert.ok(f.observers[0], 'карточка подписалась на физический наблюдатель');
      await React.act(async () => { f.observers[0]!.callback([{ isIntersecting: visible }]); for (let n = 0; n < 8; n++) await Promise.resolve(); });
    } });
  } finally {
    await unmount(); host.remove();
    if (previousTheme === null) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', previousTheme);
  }
}
function opensWeb(raw = source) {
  const f = build({}, raw); f.card.openGeoExternally(10, 20);
  assert.equal(f.web[0]?.[0], yandex, 'R220-geo-web: во внешних картах долгота идёт первой и провайдер Яндекс');
  assert.deepEqual(f.web, [[yandex, '_blank', 'noopener,noreferrer']]); assert.deepEqual(f.native, []);
}
it('R220 веб открывает Яндекс с pt=долгота,широта, масштабом 16 и картой без нативного моста', () => opensWeb());
it('R220 Android открывает geo через мост с запасной ссылкой Яндекса и не дублирует вкладку', () => {
  const f = build({ bridge: 'handled' }); f.card.openGeoExternally(10, 20);
  assert.deepEqual(f.native, [['geo:10,20?q=10,20', yandex]]); assert.deepEqual(f.web, []);
});
it('R220 отказ, исключение и старый мост без метода открывают запасной Яндекс, а не OSM', () => {
  for (const bridge of ['declined', 'throws', 'missing'] as const) {
    const f = build({ bridge }); f.card.openGeoExternally(10, 20);
    assert.deepEqual(f.web, [[yandex, '_blank', 'noopener,noreferrer']]);
    assert.deepEqual(f.native, bridge === 'missing' ? [] : [['geo:10,20?q=10,20', yandex]]);
  }
});
it('R220 без yamap1 координаты и точность остаются, но нет наблюдателя, картинки и сетевого запроса', async () => {
  await fixture({ features: ['geocontact1'] }, async f => {
    assert.equal(f.host.querySelector('button')!.classList.contains('has-map'), false);
    assert.equal(f.host.querySelector('.msg-geo-map'), null); assert.equal(f.host.querySelector('img'), null);
    assert.match(f.host.textContent ?? '', /Геопозиция/); assert.match(f.host.textContent ?? '', /10.*20/);
    assert.match(f.host.textContent ?? '', /15/); assert.deepEqual(f.requests, []); assert.equal(f.observers.length, 0);
  });
});
async function waitsForObserver(raw = source) {
  await fixture({}, async f => {
    assert.equal(f.requests.length, 0, 'R220-geo-near: картинка не запрашивается до входа в наблюдатель');
    assert.equal(f.host.querySelector('img'), null); assert.equal(f.host.querySelector('button')!.classList.contains('has-map'), true);
    assert.equal(f.observers.length, 1); assert.equal(f.observers[0]!.options.rootMargin, '240px');
    assert.equal(f.observers[0]!.targets[0], f.host.querySelector('.msg-geo-map'));
    await f.enter(false); assert.equal(f.requests.length, 0);
    await f.enter(); assert.equal(f.requests.length, 1); assert.equal(f.host.querySelector('img')?.getAttribute('src'), 'blob:geo-card-map');
    assert.equal(f.host.querySelector('img')?.getAttribute('draggable'), 'false');
    assert.equal(f.observers[0]!.disconnects, 1); await f.enter(); assert.equal(f.requests.length, 1);
  }, raw);
}
it('R220 настоящий GeoCard ждёт входа в IntersectionObserver, затем показывает одну карту и отключает наблюдение', () => waitsForObserver());
it('R220 отсутствие IntersectionObserver разрешает картинку сразу, светлая тема доходит до своего сервера', async () => {
  await fixture({ noObserver: true, theme: 'light' }, async f => {
    await f.flush(); assert.equal(f.requests.length, 1); assert.equal(f.observers.length, 0);
    const path = new URL(f.requests[0]!, 'https://geo.example.test'); assert.equal(path.searchParams.get('theme'), 'light');
    assert.equal(f.host.querySelector('img')?.getAttribute('src'), 'blob:geo-card-map');
  });
});
async function failure(raw = source) {
  await fixture({ fail: true }, async f => {
    await f.enter(); assert.equal(f.requests.length, 1);
    assert.equal(f.host.querySelector('button')!.classList.contains('has-map'), false, 'R220-geo-fail: отказ убирает вид карты');
    assert.equal(f.host.querySelector('.msg-geo-map'), null); assert.match(f.host.textContent ?? '', /Геопозиция/);
  }, raw);
}
it('R220 отказ загрузки снимает has-map и место картинки, но не координаты карточки', () => failure());
it('R220 ошибка декодирования img тоже снимает карту с карточки', async () => {
  await fixture({}, async f => {
    await f.enter(); const img = f.host.querySelector('img'); assert.ok(img);
    await React.act(async () => img.dispatchEvent(new Event('error')));
    assert.equal(f.host.querySelector('button')!.classList.contains('has-map'), false); assert.equal(f.host.querySelector('img'), null);
  });
});
it('R220 размонтирование до видимости отключает наблюдателя и не запускает сеть', async () => {
  await fixture({}, async f => { await f.unmount(); assert.equal(f.observers[0]!.disconnects, 1); assert.deepEqual(f.requests, []); });
});
it('R220 уже начатая карта не меняет DOM после размонтирования', async () => {
  await fixture({ deferred: true }, async f => {
    await f.enter(); assert.equal(f.requests.length, 1); await f.unmount();
    await React.act(async () => { f.finish(); for (let n = 0; n < 8; n++) await Promise.resolve(); });
    assert.equal(f.host.childElementCount, 0);
  });
});
it('R220 нажатие настоящей карточки открывает Яндекс и не передаёт клик строке сообщения', async () => {
  await fixture({ features: [] }, async f => {
    // React делегирует на корень: соседний native listener на том же host не был бы родительской строкой.
    let outerClicks = 0; const onOuterClick = () => outerClicks++; document.body.addEventListener('click', onOuterClick);
    try {
      await React.act(async () => f.host.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      assert.deepEqual(f.web, [[yandex, '_blank', 'noopener,noreferrer']]); assert.equal(outerClicks, 0);
    } finally { document.body.removeEventListener('click', onOuterClick); }
  });
});
for (const [label, from, to, check, prefix, actual, expected] of [
  ['вернулся OSM', 'const web = yandexMapsUrl(lat, lon);', 'const web = osmUrl(lat, lon);', opensWeb, 'R220-geo-web:', 'https://www.openstreetmap.org/?mlat=10&mlon=20#map=16/10/20', yandex],
  ['перепутаны координаты pt', 'const web = yandexMapsUrl(lat, lon);', 'const web = yandexMapsUrl(lon, lat);', opensWeb, 'R220-geo-web:', 'https://yandex.ru/maps/?pt=10,20&z=16&l=map', yandex],
  ['сеть стартует до наблюдателя', 'if (!near) return;', 'if (false) return;', waitsForObserver, 'R220-geo-near:', 1, 0],
  ['отказ оставил has-map', 'const withMap = mapOn && !mapFailed;', 'const withMap = mapOn;', failure, 'R220-geo-fail:', true, false],
] as const) it(`R220 контрфакт карты: ${label}`, async () => {
  await check(source); assert.equal(source.split(from).length - 1, 1);
  let mutated = source.replace(from, to);
  if (label === 'вернулся OSM') {
    const importAnchor = '  yandexMapsUrl,'; assert.equal(source.split(importAnchor).length - 1, 1);
    mutated = mutated.replace(importAnchor, '  yandexMapsUrl,\n  osmUrl,');
  }
  await assert.rejects(Promise.resolve().then(() => check(mutated)), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});
