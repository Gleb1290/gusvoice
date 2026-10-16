import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as rules from '../attachRules';
import * as longText from '../longTextRules';
import type { GalleryItem } from '../nativeMedia';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const raw = read('./MediaSheet.tsx');
const unused = () => assert.fail('граница вне жеста галереи');
function load<T>(source: string, deps: Record<string, unknown>, globals: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
  { module, exports: module.exports, ...globals, require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `импорт целого UI-модуля: ${id}`); return deps[id]; } });
  return module.exports as T;
}
type Scene = {
  selected(): string; cell(index: number): HTMLButtonElement; notes(): number;
  point(index: number, type: string, options?: { mouse?: boolean; dx?: number; y?: number }): Promise<Event>;
  advance(ms: number): Promise<void>; click(index: number): Promise<MouseEvent>; touchMove(): Promise<Event>;
};
async function fixture(work: (f: Scene) => Promise<void>, source = raw, options: { room?: number; blocked?: number } = {}) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const realSet = window.setTimeout, realClear = window.clearTimeout;
  const oldHit = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
  let now = 1000, id = 10000, noteCount = 0;
  const timers = new Map<number, { at: number; run(): void }>();
  const frames = new Map<number, FrameRequestCallback>();
  window.setTimeout = ((fn: () => void, ms = 0) => {
    if (ms === 2600) noteCount++;
    const key = ++id; timers.set(key, { at: now + ms, run: fn }); return key;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((key: number) => { timers.delete(key); }) as typeof window.clearTimeout;
  const request = (fn: FrameRequestCallback) => { const key = ++id; frames.set(key, fn); return key; };
  const cancel = (key: number) => { frames.delete(key); };
  class ClockDate extends Date { static now() { return now; } }
  class QuietIntersection { observe() {} unobserve() {} disconnect() {} }
  const globals = { window, document, URL, File, DOMException, Element, HTMLElement, navigator,
    IntersectionObserver: QuietIntersection, requestAnimationFrame: request, cancelAnimationFrame: cancel, Date: ClockDate, performance };
  const common = { react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': jsx };
  const icon = load<typeof import('./Icon')>(read('./Icon.tsx'), common, globals);
  const bottom = load<typeof import('./BottomSheet')>(read('./BottomSheet.tsx'), { ...common, './Icon': icon }, globals);
  const items: GalleryItem[] = Array.from({ length: 5 }, (_, index) => ({ id: `photo-${index}`, kind: index === options.blocked ? 'video' : 'image',
    mime: index === options.blocked ? 'video/mp4' : 'image/jpeg', size: index === options.blocked ? rules.ATTACH_MAX_BYTES + 1 : 100,
    width: 100, height: 80, durationMs: 1, added: index, name: `${index}.jpg`, rot: 0 }));
  const deps = { ...common, '../attachRules': rules, '../longTextRules': longText,
    '../api': { api: { attachmentDownloadUrl: unused } }, '../store': { useStore: (select: (s: { dmMessages: object }) => unknown) => select({ dmMessages: {} }) },
    '../cameraCapture': { cameraSupported: () => false, cameraAllowedQuietly: async () => false, cameraCount: unused, openCamera: unused, stopStream: () => {} },
    '../nativeMedia': { nativeMediaInfo: async () => ({ perm: 'granted', asked: true, camera: false, mic: false, capture: false }),
      galleryAlbums: async () => [], galleryPage: async () => ({ items, end: true }), galleryThumb: unused,
      cancelNativeFiles: () => {}, galleryFiles: unused, galleryPermission: unused, pickDocumentsNative: unused,
      captureNative: unused, captureErrorCode: unused, cameraPermissionNative: unused },
    '../toast': { toast: unused }, '../confirm': { confirmAction: unused }, './BottomSheet': bottom,
    './CameraScreen': { CameraCell: unused, CameraScreen: unused }, './ContextMenu': { MenuItem: unused },
    './MediaPickViewer': { MediaPickViewer: unused }, './SchedPick': { SchedPick: unused }, './Icon': icon };
  try {
    // Целый настоящий MediaSheet, его закрытый useGallerySweep и GalleryCell. Правила и React не подменены.
    const { MediaSheet } = load<typeof import('./MediaSheet')>(source, deps, globals);
    await React.act(async () => { root.render(React.createElement(MediaSheet, { native: true, room: options.room ?? 10, caption: '',
      onSend: unused, onAttach: unused, onClose: unused, onSystemPick: unused })); });
    const list = document.querySelector<HTMLElement>('.gal-scroll'); assert.ok(list, 'настоящий список галереи смонтирован');
    const cells = () => [...list.querySelectorAll<HTMLButtonElement>('button.gal-cell')];
    assert.equal(cells().length, 5, 'пять настоящих GalleryCell пришли из IO галереи');
    list.getBoundingClientRect = () => new DOMRect(0, 100, 300, 500);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: (x: number) => cells()[Math.round((x - 40) / 40)]?.querySelector('.gal-check') ?? null });
    const selected = () => JSON.stringify(cells().map(cell => ({ id: cell.dataset.gid, n: Number(cell.querySelector('.gal-check')?.textContent) || 0 }))
      .filter(cell => cell.n > 0).sort((a, b) => a.n - b.n).map(cell => cell.id));
    await work({ selected, cell: index => cells()[index], notes: () => noteCount,
      async point(index, type, point = {}) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        for (const [key, value] of Object.entries({ pointerType: point.mouse ? 'mouse' : 'touch', pointerId: 71, isPrimary: true,
          button: 0, clientX: 40 + index * 40 + (point.dx ?? 0), clientY: point.y ?? 300 })) Object.defineProperty(event, key, { value });
        await React.act(async () => { (type === 'pointerdown' ? cells()[index] : list).dispatchEvent(event); }); return event;
      },
      async advance(ms) {
        await React.act(async () => {
          now += ms;
          for (const [key, timer] of [...timers]) if (timer.at <= now && timers.delete(key)) timer.run();
        });
      },
      async click(index) {
        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        await React.act(async () => { cells()[index].querySelector('.gal-check')!.dispatchEvent(event); }); return event;
      },
      async touchMove() { const event = new Event('touchmove', { bubbles: true, cancelable: true }); await React.act(async () => { list.dispatchEvent(event); }); return event; },
    });
  } finally {
    await React.act(async () => root.unmount()); host.remove();
    window.setTimeout = realSet; window.clearTimeout = realClear;
    if (oldHit) Object.defineProperty(document, 'elementFromPoint', oldHit); else Reflect.deleteProperty(document, 'elementFromPoint');
    await GlobalRegistrator.unregister();
    if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}
async function hold(f: Scene, index = 0) { await f.point(index, 'pointerdown'); await f.advance(500); }
it('R218 удержание 499 мс ещё не выбирает, ровно 500 мс ставит якорь с data-gid', async () => {
  await fixture(async f => {
    assert.equal(f.cell(0).getAttribute('data-gid'), 'photo-0', 'GalleryCell публикует id для настоящего hit-test');
    await f.point(0, 'pointerdown'); await f.advance(499); assert.equal(f.selected(), '[]');
    await f.advance(1); assert.equal(f.selected(), '["photo-0"]');
  });
});
it('R218 мазок по трём ячейкам выбирает по порядку, обратный ход снимает вышедшие из диапазона', async () => {
  await fixture(async f => {
    await hold(f); await f.point(2, 'pointermove'); assert.equal(f.selected(), '["photo-0","photo-1","photo-2"]');
    await f.point(1, 'pointermove'); assert.equal(f.selected(), '["photo-0","photo-1"]');
    await f.point(0, 'pointermove'); assert.equal(f.selected(), '["photo-0"]');
  });
});
async function moved(source = raw) {
  await fixture(async f => {
    await f.point(0, 'pointerdown'); await f.point(0, 'pointermove', { dx: 11 }); await f.advance(500);
    assert.equal(f.selected(), '[]', 'R218-slop: сдвиг больше 10 пикселей до удержания отменяет мазок');
    assert.equal((await f.touchMove()).defaultPrevented, false, 'отменённый мазок оставляет обычную прокрутку');
  }, source);
}
it('R218 сдвиг 11 пикселей до срока оставляет жест прокруткой', () => moved());
it('R218 ровно 10 пикселей ещё разрешают удержание', async () => {
  await fixture(async f => { await f.point(0, 'pointerdown'); await f.point(0, 'pointermove', { dx: 10 }); await f.advance(500); assert.equal(f.selected(), '["photo-0"]'); });
});
async function mouse(source = raw) {
  await fixture(async f => {
    await f.point(0, 'pointerdown', { mouse: true }); await f.advance(500); await f.point(2, 'pointermove', { mouse: true });
    assert.equal(f.selected(), '[]', 'R218-mouse: мышь не включает выбор мазком');
    await f.click(0); assert.equal(f.selected(), '["photo-0"]', 'обычный клик кружка мышью сохраняет выбор');
  }, source);
}
it('R218 мышь не начинает мазок, но обычный клик кружка работает', () => mouse());
async function clickSuppression(source = raw) {
  await fixture(async f => {
    await hold(f); await f.point(0, 'pointerup');
    const click = await f.click(4);
    assert.equal(click.defaultPrevented, true, 'R218-click: click сразу после мазка гасится в capture');
    assert.equal(f.selected(), '["photo-0"]', 'погашенный click не меняет выбор');
    await f.advance(399); assert.equal((await f.click(4)).defaultPrevented, true);
    await f.advance(1); assert.equal((await f.click(4)).defaultPrevented, false, 'ровно через 400 мс click снова принимается');
    assert.equal(f.selected(), '["photo-0","photo-4"]');
  }, source);
}
it('R218 pointerup гасит ближайший click, а ровно через 400 мс он проходит', () => clickSuppression());
it('R218 только активный мазок предотвращает touchmove, после pointerup прокрутка возвращается', async () => {
  await fixture(async f => {
    assert.equal((await f.touchMove()).defaultPrevented, false);
    await hold(f); assert.equal((await f.touchMove()).defaultPrevented, true);
    await f.point(0, 'pointerup'); assert.equal((await f.touchMove()).defaultPrevented, false);
  });
});
it('R218 при полном выборе onFull появляется один раз на весь мазок', async () => {
  await fixture(async f => {
    await hold(f); await f.point(2, 'pointermove'); await f.point(3, 'pointermove'); await f.point(4, 'pointermove');
    assert.equal(f.selected(), '["photo-0"]'); assert.equal(f.notes(), 1, 'один реальный showNote и один его таймер, не тост на каждую ячейку');
  }, raw, { room: 1 });
});
it('R218 при нулевом room удержание сообщает onFull один раз и не запускает мазок', async () => {
  await fixture(async f => {
    await hold(f); await f.point(2, 'pointermove'); assert.equal(f.selected(), '[]'); assert.equal(f.notes(), 1);
    assert.equal((await f.touchMove()).defaultPrevented, false);
  }, raw, { room: 0 });
});
it('R218 blocked-якорь не начинает мазок, допустимый сосед начинает', async () => {
  await fixture(async f => {
    await hold(f); assert.equal(f.selected(), '[]'); assert.equal((await f.touchMove()).defaultPrevented, false);
    await f.point(0, 'pointerup'); await hold(f, 1); assert.equal(f.selected(), '["photo-1"]');
  }, raw, { blocked: 0 });
});
for (const [label, from, to, scenario, prefix, actual, expected] of [
  ['click после мазка больше не гасится', 'if (Date.now() < suppressUntil) {', 'if (false) {', clickSuppression, 'R218-click:', false, true],
  ['сдвиг до удержания не отменяет таймер', '> SWEEP_SLOP_PX)', '> Number.POSITIVE_INFINITY)', moved, 'R218-slop:', '["photo-0"]', '[]'],
  ['мышь включена в мазок', "e.pointerType === 'mouse' || ", '', mouse, 'R218-mouse:', '["photo-0","photo-1","photo-2"]', '[]'],
] as const) it(`R218 хук контрфакт: ${label}`, async () => {
  await scenario(raw); assert.equal(raw.split(from).length - 1, 1, 'у мутации один якорь в полном MediaSheet');
  await assert.rejects(scenario(raw.replace(from, to)), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith(prefix) && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected);
});
