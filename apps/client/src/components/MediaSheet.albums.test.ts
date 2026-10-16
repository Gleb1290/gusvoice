import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import * as attachRules from '../attachRules';
import * as longTextRules from '../longTextRules';
import type { GalleryAlbum, GalleryItem } from '../nativeMedia';

const source = readFileSync(new URL('./MediaSheet.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const photo = (id: string): GalleryItem => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg',
  size: 100, width: 30, height: 20, durationMs: 0, added: 1, rot: 0 });
const all: GalleryAlbum = { id: '', name: '', count: 3, only: null, cover: null };
const folder = (id: string): GalleryAlbum => ({ id, name: id, count: 2, only: null, cover: null });
type Page = { items: GalleryItem[]; end: boolean };
const page = (...ids: string[]): Page => ({ items: ids.map(photo), end: true });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function mutate(from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'единственный якорь мутации');
  return source.replace(from, to);
}
async function fixture(check: (f: {
  host: HTMLDivElement; choose(name: string): Promise<void>; settle(): Promise<void>;
  requests: Array<GalleryAlbum | null>; sent: string[][];
}) => Promise<void>, options: {
  albums?: GalleryAlbum[] | null; albumsThrow?: boolean; source?: string;
  load?: (album: GalleryAlbum | null) => Promise<Page>;
} = {}) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const requests: Array<GalleryAlbum | null> = [];
  const sent: string[][] = [];
  const noView = () => null;
  const unused = () => assert.fail('действие вне проверки альбомов');
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM,
    '../attachRules': attachRules, '../longTextRules': longTextRules,
    '../api': { api: { attachmentDownloadUrl: unused } },
    '../cameraCapture': { cameraSupported: () => false, cameraAllowedQuietly: async () => true,
      cameraCount: unused, openCamera: unused, stopStream() {} },
    '../nativeMedia': {
      nativeMediaInfo: async () => ({ perm: 'granted', asked: true, camera: true, mic: false, capture: true }),
      galleryAlbums: () => {
        if (options.albumsThrow) throw new Error('старый мост');
        return Promise.resolve(options.albums === undefined ? [all, folder('A'), folder('B')] : options.albums);
      },
      galleryPage: (_before: GalleryItem | null, _count: number, album: GalleryAlbum | null) => {
        requests.push(album); return options.load?.(album) ?? Promise.resolve(album ? page(`${album.id}-photo`) : page('one', 'two', 'three'));
      },
      galleryThumb: async () => null, cancelNativeFiles() {},
      galleryFiles: async (items: GalleryItem[]) => {
        sent.push(items.map(item => item.id));
        return { files: items.map(item => new File(['image'], item.name, { type: item.mime })), skipped: [] };
      },
      galleryPermission: unused, captureNative: unused, captureErrorCode: unused, pickDocumentsNative: unused,
      cameraPermissionNative: unused,
    },
    '../store': { useStore: (select: (state: unknown) => unknown) => select({ dmMessages: {} }) },
    '../toast': { toast: unused }, '../confirm': { confirmAction: unused },
    './BottomSheet': { BottomSheet: ({ title, children }: { title?: React.ReactNode; children: React.ReactNode }) =>
      React.createElement('section', null, React.createElement('header', null, title), children) },
    './CameraScreen': { CameraScreen: noView, CameraCell: ({ short }: { short: boolean }) => React.createElement('button', { className: `gal-cam${short ? ' short' : ''}` }) },
    './ContextMenu': { MenuItem: noView }, './Icon': { Icon: noView }, './SchedPick': { SchedPick: noView },
    './MediaPickViewer': { MediaPickViewer: noView },
  };
  class QuietObserver { observe() {} unobserve() {} disconnect() {} }
  const module = { exports: {} };
  const settle = async () => React.act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
  try {
    // Полный MediaSheet, подменены только внешние оболочки, камера и I/O моста.
    runInNewContext(ts.transpileModule(options.source ?? source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText, { module, exports: module.exports, window, document, URL, File, DOMException,
      IntersectionObserver: QuietObserver, require(id: string) { assert.ok(Object.hasOwn(deps, id), `неожиданный импорт ${id}`); return deps[id]; } });
    const { MediaSheet } = module.exports as typeof import('./MediaSheet');
    await React.act(async () => root.render(React.createElement(MediaSheet, {
      native: true, room: 10, caption: 'подпись', onSend() {}, onClose() {}, onAttach: unused, onSystemPick: unused,
    })));
    await settle();
    const choose = async (name: string) => {
      const title = host.querySelector<HTMLButtonElement>('.gal-album-btn'); assert.ok(title);
      await React.act(async () => title.click());
      const row = [...host.querySelectorAll<HTMLButtonElement>('.gal-album')]
        .find(button => button.querySelector('.gal-album-name')?.textContent === name);
      assert.ok(row, `есть альбом ${name}`);
      await React.act(async () => row.click()); await settle();
    };
    await check({ host, choose, settle, requests, sent });
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally {
      host.remove(); await GlobalRegistrator.unregister();
      if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  }
}

it('R153 список альбомов появляется только при двух и более, отсутствие и синхронный отказ не ломают сетку', async () => {
  // Старый мост и один альбом оставляют лист без бессмысленного выпадающего меню.
  for (const options of [{ albums: null }, { albums: [all] }, { albumsThrow: true }]) await fixture(async f => {
    assert.equal(!!f.host.querySelector('.gal-album-btn'), false);
    assert.equal(f.host.querySelectorAll('.gal-cell').length, 3);
  }, options);
  await fixture(async f => assert.equal(f.host.querySelector('.gal-album-btn')?.textContent, 'Галерея'), { albums: [all, folder('A')] });
});
it('R153 выбор альбома меняет заголовок, сбрасывает порцию и скрывает камеру, все медиа возвращают её', async () => {
  await fixture(async f => {
    assert.equal(!!f.host.querySelector('.gal-cam'), true);
    await f.choose('A');
    assert.equal(f.host.querySelector('.gal-album-btn')?.textContent, 'A');
    assert.equal(f.host.querySelectorAll('.gal-cell').length, 1);
    assert.equal(!!f.host.querySelector('.gal-cam'), false);
    assert.equal(f.requests.at(-1)?.id, 'A');
    await f.choose('Все медиа');
    assert.equal(f.requests.at(-1), null);
    assert.equal(f.host.querySelectorAll('.gal-cell').length, 3);
    assert.equal(!!f.host.querySelector('.gal-cam'), true);
  });
});
async function persists(raw = source) {
  // Выбранное из первой папки должно уйти в отправку даже при другой видимой сетке.
  await fixture(async f => {
    const check = f.host.querySelector<HTMLElement>('.gal-check'); assert.ok(check);
    await React.act(async () => check.click()); await f.settle();
    await f.choose('A');
    const send = f.host.querySelector<HTMLButtonElement>('.gal-send-btn'); assert.ok(send);
    await React.act(async () => send.click()); await f.settle();
    assert.deepEqual(f.sent, [['one']], 'выбор из прежнего альбома остаётся отправляемым');
  }, { source: raw });
}
it('R153 выбранное переживает смену альбома и отправляется из кеша seen', async () => persists());
async function stale(raw = source) {
  const a = deferred<Page>(); const b = deferred<Page>();
  await fixture(async f => {
    await f.choose('A'); await f.choose('B');
    await React.act(async () => b.resolve(page('fresh-one', 'fresh-two'))); await f.settle();
    assert.equal(f.host.querySelectorAll('.gal-cell').length, 2);
    await React.act(async () => a.resolve(page('obsolete'))); await f.settle();
    assert.equal(f.host.querySelectorAll('.gal-cell').length, 2, 'поздняя порция прежнего альбома не заменяет текущую');
    assert.equal(f.host.querySelector('.gal-album-btn')?.textContent, 'B');
  }, { source: raw, load: album => album?.id === 'A' ? a.promise : album?.id === 'B' ? b.promise : Promise.resolve(page('initial')) });
}
it('R153 ответ прежнего альбома после нового не подменяет текущую сетку', async () => stale());
it('R153 контрфакт chosen по items теряет выбранное из другого альбома', async () => {
  await persists();
  const raw = mutate('order.map((id) => seen.current.get(id))', 'order.map((id) => items.find((item) => item.id === id))');
  await assert.rejects(persists(raw), (error: unknown) => error instanceof assert.AssertionError && error.message.includes('прежнего альбома'));
});
it('R153 контрфакт без проверки поколения принимает позднюю порцию прежнего альбома', async () => {
  await stale();
  const raw = mutate('if (!alive.current || gen !== genRef.current) return;', 'if (!alive.current) return;');
  await assert.rejects(stale(raw), (error: unknown) => error instanceof assert.AssertionError && error.message.includes('поздняя порция'));
});
