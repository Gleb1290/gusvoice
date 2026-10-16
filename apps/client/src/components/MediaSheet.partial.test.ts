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
import type { GalleryPerm } from '../attachRules';
import type { GalleryItem } from '../nativeMedia';
import type * as Sheet from './MediaSheet';
import type * as Camera from './CameraScreen';
type MediaPickViewerProps = React.ComponentProps<typeof import('./MediaPickViewer').MediaPickViewer>;

const source = readFileSync(new URL('./MediaSheet.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const cameraSource = readFileSync(new URL('./CameraScreen.tsx', import.meta.url), 'utf8');
const viewerSource = readFileSync(new URL('./MediaPickViewer.tsx', import.meta.url), 'utf8');
const unused = () => assert.fail('действие вне проверяемого контракта листа');
const noView = () => null;
function item(i: number): GalleryItem {
  return { id: `photo-${i}`, kind: 'image', mime: 'image/jpeg', size: 123, width: 40, height: 30,
    durationMs: 0, added: i, name: `${i}.jpg`, rot: 0 };
}
type Page = { items: GalleryItem[]; end: boolean };
type Fixture = {
  host: HTMLDivElement; permissions: string[]; pages: Array<{ before: GalleryItem | null; count: number }>;
  sends: Array<{ files: File[]; caption: string; how: Sheet.MediaSendHow }>;
  captures: Array<{ video: boolean; maxBytes: number }>;
  cameraRequests: string[];
  cameraOpens: string[];
  cameraPreview(): boolean;
  reads: Array<{ ids: string[]; compress: boolean }>;
  ready(i: number): Promise<File>;
  confirmations: Array<{ title: string; confirmLabel: string; cancelLabel: string; icon: 'camera' | 'photo' }>;
  closed(): number;
  closeTop(): Promise<void>;
  fireHold(): Promise<void>;
  legacyToggle(): Promise<number>;
  returnVisible(): Promise<void>; settle(): Promise<void>; finishPage(): Promise<void>;
};

// Полный MediaSheet и настоящий CameraCell; границы — мост Android, камера, стор и внешние оболочки.
// Наблюдатели намеренно не сообщают пересечений: тест не имитирует геометрию или нижнюю подгрузку.
async function fixture(perm: GalleryPerm, count: number, check: (f: Fixture) => Promise<void>,
  raw = source, pending = false, options: { camera?: boolean; capture?: boolean; captureResult?: 'file' | 'cancel' | 'denied'; confirm?: boolean; asked?: boolean; permissionResult?: GalleryPerm; cameraPermission?: 'granted' | 'denied' | null; readyViewer?: boolean; skipMiddle?: boolean } = {}) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const priorAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  const priorConfirm = window.confirm;
  const priorCreateElement = document.createElement;
  // В happy-dom MediaStream внутренний и не выставлен в window. Подменяем только
  // аппаратную границу видео: настоящий CameraCell получает/читает тот же fake stream.
  document.createElement = function (this: Document, ...args: Parameters<Document['createElement']>) {
    const element = priorCreateElement.apply(this, args);
    if (element.localName === 'video') {
      let stream: unknown = null;
      Object.defineProperty(element, 'srcObject', { configurable: true,
        get: () => stream, set: (value: unknown) => { stream = value; } });
    }
    return element;
  } as Document['createElement'];
  window.confirm = () => false;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const permissions: string[] = [];
  const sends: Fixture['sends'] = [];
  const captures: Fixture['captures'] = [];
  const cameraRequests: string[] = [];
  const cameraOpens: string[] = [];
  const cameraStream = { getVideoTracks: () => [] };
  let cameraPermissionGranted = false;
  const reads: Fixture['reads'] = [];
  let viewer: MediaPickViewerProps | undefined;
  const confirmations: Fixture['confirmations'] = [];
  let closed = 0;
  let topClose = () => {};
  let hold: (() => void) | undefined;
  const realSetTimeout = window.setTimeout.bind(window);
  if (options.capture) window.setTimeout = ((handler: () => void, delay?: number) => {
    if (delay === attachRules.HOLD_TO_RECORD_MS) { hold = handler; return 98765; }
    return realSetTimeout(handler, delay);
  }) as typeof window.setTimeout;
  const pages: Fixture['pages'] = [];
  let release: ((p: Page) => void) | undefined;
  // Один стабильный ответ моста: повторный запрос не создаёт новых висящих обещаний.
  const pendingPage = pending ? new Promise<Page>(resolve => { release = resolve; }) : null;
  const page = () => ({ items: Array.from({ length: count }, (_, i) => item(i)), end: true });
  const settle = async () => { await React.act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };
  const state = { dmMessages: {} };
  const cameraDeps = { cameraSupported: () => true, cameraAllowedQuietly: async () => false,
    cameraCount: async () => 1,
    // Начальный camera=false не запрещает превью после успешного camPerm.
    // Но до разрешения (и после отказа/ответа старого моста) запрос остаётся ошибкой контракта.
    openCamera: async (facing: string) => {
      assert.ok(options.camera || cameraPermissionGranted, 'живое превью открывается только с доступом к камере');
      cameraOpens.push(facing);
      return cameraStream;
    },
    stopStream: () => {}, setTorch: unused,
    startRecording: unused, takeSnapshot: unused, torchSupported: unused };
  const dependencies: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM,
    '../attachRules': attachRules, '../longTextRules': longTextRules,
    '../api': { api: { attachmentDownloadUrl: unused } },
    '../cameraCapture': cameraDeps,
    '../nativeMedia': {
      cameraPermissionNative: async () => {
        cameraRequests.push('camPerm');
        cameraPermissionGranted = options.cameraPermission === 'granted';
        return options.cameraPermission ?? null;
      },
      nativeMediaInfo: async () => ({ perm, asked: options.asked ?? true, camera: options.camera ?? false, mic: false, capture: options.capture ?? false }),
      galleryPermission: async (action: string) => { permissions.push(action); return options.permissionResult ?? perm; },
      galleryAlbums: async () => [],
      galleryOriginal: () => ({ done: Promise.resolve(null), cancel: () => {} }),
      captureErrorCode: () => 'camera-denied',
      captureNative: async (args: { video: boolean; maxBytes: number }) => {
        captures.push(args);
        if (options.captureResult === 'denied') throw new Error('camera-denied');
        return { files: options.captureResult === 'cancel' ? [] : [new File(['shot'], args.video ? 'shot.mp4' : 'shot.jpg', { type: args.video ? 'video/mp4' : 'image/jpeg' })], skipped: [], cancelled: options.captureResult === 'cancel' };
      },
      galleryPage: (before: GalleryItem | null, amount: number) => {
        pages.push({ before, count: amount });
        if (pending) assert.equal(pages.length, 1, 'до ответа моста запрашивается только первая порция');
        return pendingPage ?? Promise.resolve(page());
      },
      cancelNativeFiles: () => {}, galleryThumb: async () => null,
      galleryFiles: async (items: GalleryItem[], args: { compress: boolean }) => {
        reads.push({ ids: Array.from(items, i => i.id), compress: args.compress });
        const indexes = items.map((_, k) => k).filter(k => !options.skipMiddle || k !== 1);
        return { files: indexes.map(k => new File(['bridge'], items[k].name, { type: items[k].mime })),
          indexes, skipped: options.skipMiddle ? [{ name: items[1].name, reason: 'too-big' }] : [] };
      }, pickDocumentsNative: unused,
    },
    '../store': { useStore: (select: (s: typeof state) => unknown) => select(state) },
    '../toast': { toast: () => { assert.ok(options.skipMiddle, 'предупреждение только о намеренно пропущенном файле'); } },
    '../confirm': { confirmAction: async (args: Fixture['confirmations'][number]) => { confirmations.push(args); return options.confirm ?? false; } },
    './BottomSheet': { BottomSheet: ({ children, onClose }: { children: React.ReactNode; onClose: () => void }) => { topClose = onClose; return React.createElement('section', null, children); } },
    './ContextMenu': { MenuItem: noView }, './Icon': { Icon: noView }, './SchedPick': { SchedPick: noView },
  };
  class QuietObserver { observe() {} disconnect() {} unobserve() {} }
  function load<T>(rawModule: string): T {
    const module = { exports: {} as T };
    runInNewContext(ts.transpileModule(rawModule, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
    } }).outputText, { module, exports: module.exports, window, document, File,
      URL: { createObjectURL: () => 'blob:shot', revokeObjectURL: () => {} }, DOMException,
      IntersectionObserver: QuietObserver, require: (id: string) => {
        assert.ok(Object.hasOwn(dependencies, id), `неожиданная зависимость ${id}`);
        return dependencies[id];
      } });
    return module.exports;
  }
  try {
    dependencies['./CameraScreen'] = load<typeof Camera>(cameraSource);
    dependencies['./MediaPickViewer'] = options.readyViewer
      ? { MediaPickViewer: (props: MediaPickViewerProps) => { viewer = props; return null; } }
      : load<typeof import('./MediaPickViewer')>(viewerSource);
    const { MediaSheet, GalleryCell } = load<typeof Sheet & { GalleryCell: React.ComponentType<Record<string, unknown>> }>(`${raw}\nexport { GalleryCell };`);
    await React.act(async () => root.render(React.createElement(MediaSheet, {
      native: true, room: 10, caption: ' подпись ', onSend: (files, caption, how) => sends.push({ files, caption, how }), onAttach: unused, onSystemPick: unused, onClose: () => closed++,
    })));
    await settle();
    await check({ host, permissions, pages, sends, captures, cameraRequests, cameraOpens,
      cameraPreview: () => (host.querySelector<HTMLVideoElement>('button.gal-cam video')?.srcObject as unknown) === cameraStream,
      reads, confirmations, closed: () => closed, settle,
      ready: async (i) => {
        await React.act(async () => host.querySelectorAll<HTMLButtonElement>('button.gal-cell')[i].click()); await settle();
        const file = new File(['ready'], `ready-${i}.jpg`, { type: 'image/jpeg' });
        assert.ok(viewer?.onReady, 'лист передал onReady в просмотр');
        await React.act(async () => viewer!.onReady!(item(i), file));
        await React.act(async () => topClose()); await settle();
        return file;
      },
      closeTop: async () => { await React.act(async () => topClose()); await settle(); },
      fireHold: async () => { assert.ok(hold, 'настоящая CameraCell поставила таймер удержания'); await React.act(async () => hold!()); await settle(); },
      legacyToggle: async () => {
        let n = 0;
        await React.act(async () => root.render(React.createElement(GalleryCell, {
          item: item(0), n: 0, big: false, thumbs: { get: () => undefined }, root: { current: null }, onToggle: () => n++,
        })));
        await React.act(async () => host.querySelector<HTMLButtonElement>('button.gal-cell')!.click());
        return n;
      },
      finishPage: async () => {
        assert.ok(release, 'первая порция действительно ждёт ответа моста');
        await React.act(async () => release!(page())); await settle();
      },
      returnVisible: async () => {
        await React.act(async () => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await settle();
        await React.act(async () => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await settle();
      },
    });
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally {
      window.setTimeout = realSetTimeout;
      window.confirm = priorConfirm;
      document.createElement = priorCreateElement;
      host.remove();
      try { await GlobalRegistrator.unregister(); }
      finally {
        if (priorAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', priorAct);
        else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      }
    }
  }
}
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const b = [...host.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === label);
  assert.ok(!!b, `есть кнопка «${label}»`); return b!;
}
async function checkEmpty(raw = source) {
  await fixture('partial', 0, async f => {
    assert.equal(f.host.querySelector('.gal-empty')?.textContent, 'Здесь пока нет фото и видео');
    assert.equal(!!f.host.querySelector('.gal-notice'), false);
    assert.equal(!!f.host.querySelector('.gal-system'), false, 'пустой разрешённый набор не подменяется системной плиткой');
    assert.ok(!f.host.textContent?.includes('Открыть доступ ко всем'));
    assert.ok(!f.host.textContent?.includes('Выбрать фото и видео'));
    assert.equal(f.pages.length, 1);
  }, raw);
  await fixture('granted', 0, async f => {
    assert.equal(f.host.querySelector('.gal-empty')?.textContent, 'Здесь пока нет фото и видео');
    assert.equal(!!f.host.querySelector('.gal-notice'), false);
    assert.ok(!f.host.textContent?.includes('Открыть доступ ко всем'));
  }, raw);
  await fixture('partial', 1, async f => {
    assert.equal(!!f.host.querySelector('.gal-notice'), false);
    assert.equal(!!f.host.querySelector('.gal-empty'), false);
  }, raw);
}
async function checkReturn(raw = source) {
  for (const perm of ['partial', 'granted'] as const) {
    await fixture(perm, 1, async f => {
      assert.equal(f.pages.length, 1, 'первая загрузка одна');
      assert.deepEqual(f.permissions, [], 'первое монтирование не является возвратом из системы');
      await f.returnVisible();
      assert.deepEqual(f.permissions, ['check']);
      assert.equal(f.pages.length, 1, 'неизменившийся доступ не перечитывает галерею');
      for (const p of f.pages) { assert.equal(p.before, null); assert.equal(p.count, attachRules.GALLERY_PAGE); }
    }, raw);
  }
}
async function checkCamera(raw = source) {
  for (const count of [0, 1, 2, 3]) {
    await fixture('granted', count, async f => {
      assert.equal(f.host.querySelectorAll('button.gal-cell').length, count);
      const cam = f.host.querySelector('button.gal-cam'); assert.ok(!!cam, 'ячейка камеры доступна');
      assert.equal(cam!.classList.contains('short'), count <= 2, 'с доступом к камере граница короткой плитки — два фото');
    }, raw, false, { camera: true });
  }
  await fixture('blocked', 0, async f => {
    assert.ok(!!f.host.querySelector('.gal-system'));
    assert.ok(!!f.host.querySelector('button.gal-cam'));
    assert.equal(f.host.querySelector('button.gal-cam')!.classList.contains('short'), false);
    assert.equal(f.pages.length, 0);
  }, raw);
  await checkLoadingCamera(raw);
}
async function checkLoadingCamera(raw = source) {
  await fixture('partial', 0, async f => {
    assert.equal(f.pages.length, 1, 'первая порция уже запрошена и ещё не отвечена');
    assert.equal(f.host.querySelectorAll('.gal-cell.sk').length, 8, 'наблюдаем загрузку, не готовую пустую галерею');
    const cam = f.host.querySelector('button.gal-cam');
    assert.ok(!!cam, 'настоящая ячейка камеры уже смонтирована');
    // Не отдаём узел happy-dom в AssertionError: inspect разворачивает DOM/React-граф,
    // и неверный класс должен дать короткую ошибку поведения, а не исчерпать память.
    assert.equal(cam!.classList.contains('short'), false, 'пустая загрузка пока оставляет высокую камеру');
    await f.finishPage();
    assert.equal(f.host.querySelector('button.gal-cam')?.classList.contains('short'), true,
      'после пустого ответа камера короткая');
  }, raw, true);
}
async function mutant(check: (s?: string) => Promise<void>, from: string, to: string) {
  await check(source);
  assert.equal(source.split(from).length - 1, 1, 'один точный якорь мутации');
  const changed = source.replace(from, to); assert.notEqual(changed, source);
  await assert.rejects(() => check(changed), assert.AssertionError);
}
it('R150 partial не имеет собственной плашки и читается как разрешённый доступ', () => checkEmpty());
it('R150 возвращение hidden→visible проверяет доступ без повторной загрузки неизменившегося набора', () => checkReturn());
it('R150 мутант загрузки галереи при каждой смене видимости обнаруживается на неизменившемся доступе', () => mutant(checkReturn,
  '[native, permOk, perm, loadMore]', '[native, permOk, perm, visible, loadMore]'));
it('R150 мутант принудительной перечитки после проверки доступа обнаруживается на partial и granted', () => mutant(checkReturn,
  'setPerm((prev) => (prev === p ? prev : p));',
  'setPerm((prev) => (prev === p ? prev : p)); void loadMore(true);'));
it('R151 камера доступна при 0–3 фото, отказе доступа и незавершённой загрузке', () => checkCamera());
it('R150 мутант возврата текста «Открыть доступ ко всем» обнаруживается в DOM', () => mutant(checkEmpty,
  '<div className="gal-empty">Здесь пока нет фото и видео</div>',
  '<div className="gal-empty">Открыть доступ ко всем</div>'));

async function checkOpen(raw = source) {
  await fixture('granted', 3, async f => {
    const cells = [...f.host.querySelectorAll<HTMLButtonElement>('button.gal-cell')];
    await React.act(async () => cells[1].click()); await f.settle();
    assert.equal(document.querySelector('.pick-pos')?.textContent, '2 из 3');
    assert.equal(cells[1].getAttribute('aria-pressed'), 'false', 'открытие не выбирает');
    await f.closeTop();
    assert.equal(!!document.querySelector('.pick-viewer'), false, 'первое закрытие убирает только просмотр');
    assert.equal(f.closed(), 0);
    await React.act(async () => cells[0].querySelector<HTMLElement>('.gal-check')!.click()); await f.settle();
    assert.equal(cells[0].getAttribute('aria-pressed'), 'true', 'кружок выбирает без просмотра');
    assert.equal(!!document.querySelector('.pick-viewer'), false);
    await React.act(async () => cells[2].click()); await f.settle();
    await React.act(async () => document.querySelector<HTMLButtonElement>('.pick-check')!.click()); await f.settle();
    assert.equal(document.querySelector('.pick-check')?.textContent, '2', 'номер учитывает уже выбранное в сетке');
    await React.act(async () => document.querySelector<HTMLButtonElement>('.pick-viewer .gal-send-btn')!.click()); await f.settle();
    assert.deepEqual(f.sends.map(s => ({ names: Array.from(s.files, x => x.name), caption: s.caption, how: s.how })),
      [{ names: ['0.jpg', '2.jpg'], caption: 'подпись', how: 'now' }]);
  }, raw);
  await fixture('granted', 2, async f => {
    await React.act(async () => f.host.querySelectorAll<HTMLButtonElement>('button.gal-cell')[1].click()); await f.settle();
    await React.act(async () => document.querySelector<HTMLButtonElement>('.pick-viewer .gal-send-btn')!.click()); await f.settle();
    assert.deepEqual(Array.from(f.sends[0].files, x => x.name), ['1.jpg'], 'без выбора отправлено только открытое');
    assert.equal(f.sends[0].caption, 'подпись');
  }, raw);
}
it('R151 тап открывает, кружок выбирает; закрытие просмотра не закрывает лист, отправка берёт выбор или текущее', () => checkOpen());
it('R151 мутант переставленных открытия и выбора обнаруживается настоящей GalleryCell', () => mutant(checkOpen,
  "if (onOpen && !(e.target as Element).closest?.('.gal-check')) onOpen(item);",
  "if (onOpen && (e.target as Element).closest?.('.gal-check')) onOpen(item);"));
it('R151 мутант отправки только текущего вместо всего выбора обнаруживается', () => mutant(checkOpen,
  "chosen.length ? chosen : [entry.item]", "[entry.item]"));
it('R153/R154 прежняя камера без sysCapture сохраняет границу короткой плитки 2/3 даже без разрешения', async () => {
  await checkCamera();
  for (const count of [2, 3]) await fixture('granted', count, async f => {
    assert.equal(f.host.querySelector('button.gal-cam')?.classList.contains('short'), count === 2);
  });
});
it('R153 мутант границы короткой камеры обнаруживается на ровно двух фото', () => mutant(checkCamera,
  'items.length + 1 <= 3', 'items.length + 1 < 3'));
it('R153 мутант короткой камеры во время незавершённой загрузки обнаруживается', () => mutant(checkLoadingCamera,
  ' && !(loading && items.length === 0)', ''));

async function checkCapture(raw = source) {
  for (const video of [false, true]) await fixture('granted', 0, async f => {
    const cam = f.host.querySelector<HTMLButtonElement>('button.gal-cam')!;
    if (video) {
      await React.act(async () => cam.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })));
      await f.fireHold();
      await React.act(async () => { cam.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true })); cam.click(); });
    } else await React.act(async () => cam.click());
    await f.settle();
    assert.deepEqual(f.captures.map(capture => ({ ...capture })), [{ video, maxBytes: attachRules.ATTACH_MAX_BYTES }]);
    assert.equal(!!document.querySelector('.pick-viewer'), true);
    assert.equal(!!document.querySelector('.cam-screen'), false, 'системный снимок не открывает собственную камеру');
    assert.equal(!!document.querySelector('.pick-check'), false, 'готовый файл без кружка');
    await React.act(async () => document.querySelector<HTMLButtonElement>('.pick-viewer .gal-send-btn')!.click()); await f.settle();
    assert.equal(f.sends[0].files[0].name, video ? 'shot.mp4' : 'shot.jpg');
    assert.equal(f.sends[0].caption, 'подпись');
  }, raw, false, { capture: true, camera: true });
}
it('R150/R151 настоящая CameraCell направляет тап в фото и удержание в видео один раз, снимок — в общий просмотр', () => checkCapture());
it('R150 мутант перепутанного фото и видео обнаруживается системным вызовом', () => mutant(checkCapture,
  'onHold={sysCapture ? () => void systemCamera(true) : undefined}',
  'onHold={sysCapture ? () => void systemCamera(false) : undefined}'));
it('R150 отмена системной камеры не открывает экран и не показывает ошибку', async () => {
  await fixture('granted', 0, async f => {
    await React.act(async () => f.host.querySelector<HTMLButtonElement>('button.gal-cam')!.click()); await f.settle();
    assert.equal(f.captures.length, 1);
    assert.equal(!!document.querySelector('.pick-viewer, .cam-screen, .gal-note'), false);
    assert.equal(f.sends.length, 0);
  }, source, false, { capture: true, camera: true, captureResult: 'cancel' });
});
async function checkSettings(raw = source) {
  for (const entrance of ['blocked', 'ask', 'camera'] as const) for (const confirm of [false, true]) {
    await fixture(entrance === 'camera' ? 'granted' : entrance, 0, async f => {
      const trigger = entrance === 'camera'
        ? f.host.querySelector<HTMLButtonElement>('button.gal-cam')!
        : button(f.host, entrance === 'blocked' ? 'Настройки' : 'Разрешить');
      await React.act(async () => trigger.click()); await f.settle();
      assert.deepEqual(f.confirmations.map(({ title, confirmLabel, cancelLabel, icon }) => ({ title, confirmLabel, cancelLabel, icon })),
        [{ title: entrance === 'camera' ? 'Нет доступа к камере' : 'Нет доступа к фото и видео', confirmLabel: 'Настройки', cancelLabel: 'Не сейчас', icon: entrance === 'camera' ? 'camera' : 'photo' }]);
      assert.equal(f.permissions.filter(x => x === 'settings').length, confirm ? 1 : 0);
    }, raw, false, { capture: entrance === 'camera', camera: entrance === 'camera', captureResult: 'denied', confirm });
  }
}
it('R151 три входа отказа предлагают Настройки/Не сейчас через confirmAction', () => checkSettings());
it('R151 мутант window.confirm вместо приложения обнаруживается отсутствием confirmAction', () => mutant(checkSettings,
  'const ok = await confirmAction({', 'const ok = window.confirm.call(window, {'));
it('R151 GalleryCell без onOpen сохраняет выбор тапом для прежних вызывающих', async () => {
  await fixture('granted', 1, async f => assert.equal(await f.legacyToggle(), 1));
});

async function cameraRow(raw = source) {
  for (const capture of [false, true]) for (const camera of [false, true]) for (const perm of ['granted', 'ask', 'blocked'] as const) {
    await fixture(perm, 1, async f => {
      const row = capture && !camera && perm === 'granted';
      assert.equal(!!f.host.querySelector('.gal-cam-perm'), row, 'строка разрешения требует системную камеру и доступную галерею');
      assert.equal(!!f.host.querySelector('button.gal-cam'), !row, 'строка заменяет ячейку, а не дублирует её');
      if (row) assert.equal(f.host.querySelector('.gal-cam-perm button')?.textContent, 'Разрешить доступ к камере');
    }, raw, false, { capture, camera });
  }
}
it('R154 строка доступа заменяет камеру только при sysCapture, доступной галерее и отказе камеры', () => cameraRow());
it('R154 мутант без sysCapture ошибочно прячет прежнюю ячейку камеры', () => mutant(cameraRow,
  'showCam && native && sysCapture && permOk && !camAllowed', 'showCam && native && permOk && !camAllowed'));
it('R154 три ответа camPerm: разрешение возвращает ячейку, отказ предлагает настройки, старый мост открывает фото', async () => {
  for (const answer of ['granted', 'denied', null] as const) for (const confirm of [false, true]) {
    await fixture('granted', 1, async f => {
      assert.deepEqual(f.cameraOpens, [], 'без начального доступа живая камера не запускается');
      assert.equal(f.cameraPreview(), false);
      await React.act(async () => f.host.querySelector<HTMLButtonElement>('.gal-cam-perm button')!.click()); await f.settle();
      assert.deepEqual(f.cameraRequests, ['camPerm']);
      assert.deepEqual(f.cameraOpens, answer === 'granted' ? ['environment'] : [], 'только granted запускает одно живое превью');
      assert.equal(f.cameraPreview(), answer === 'granted', 'настоящая CameraCell получила поток разрешённой камеры');
      assert.equal(f.captures.length, answer === null ? 1 : 0);
      if (answer === null) assert.deepEqual({ ...f.captures[0] }, { video: false, maxBytes: attachRules.ATTACH_MAX_BYTES });
      assert.equal(f.confirmations.length, answer === 'denied' ? 1 : 0);
      if (answer === 'denied') {
        assert.equal(f.confirmations[0].title, 'Нет доступа к камере');
        assert.equal(f.confirmations[0].icon, 'camera');
      }
      assert.equal(f.permissions.filter(x => x === 'settings').length, answer === 'denied' && confirm ? 1 : 0);
      assert.equal(!!f.host.querySelector('.gal-cam-perm'), answer !== 'granted');
      assert.equal(!!f.host.querySelector('button.gal-cam'), answer === 'granted');
    }, source, false, { capture: true, cameraPermission: answer, captureResult: 'cancel', confirm });
  }
});

async function select(f: Fixture, ids: number[]) {
  for (const i of ids) await React.act(async () => f.host.querySelectorAll<HTMLElement>('.gal-check')[i].click());
  await f.settle();
}
async function send(f: Fixture) {
  await React.act(async () => f.host.querySelector<HTMLButtonElement>('.gal-send-btn')!.click()); await f.settle();
}
async function readyOnly(raw = source) {
  await fixture('granted', 2, async f => {
    const a = await f.ready(0); const b = await f.ready(1);
    await select(f, [1, 0]); await send(f);
    assert.deepEqual(f.reads, [], 'готовые фото не отправляются на второе сжатие');
    assert.equal(f.sends[0].files[0] === b, true); assert.equal(f.sends[0].files[1] === a, true);
    assert.equal(f.sends[0].caption, 'подпись');
  }, raw, false, { readyViewer: true });
}
it('R154 готовые фото отправляются теми же File без galleryFiles, в порядке выбора', () => readyOnly());
async function mixedReady(raw = source) {
  await fixture('granted', 5, async f => {
    const ready = await f.ready(4);
    await select(f, [2, 1, 4, 0]); await send(f);
    assert.deepEqual(f.reads, [{ ids: ['photo-2', 'photo-1', 'photo-0'], compress: true }]);
    assert.deepEqual(Array.from(f.sends[0].files, file => file.name), ['2.jpg', 'ready-4.jpg', '0.jpg'], 'indexes сохраняют порядок при пропущенном среднем');
    assert.equal(f.sends[0].files[1] === ready, true);
  }, raw, false, { readyViewer: true, skipMiddle: true });
}
it('R154 готовое между файлами моста сохраняет порядок indexes даже при too-big в середине', () => mixedReady());
it('R154 мутант склейки без indexes переставляет готовое и файлы после пропуска', () => mutant(mixedReady,
  'const res = { ...got, files };', 'const res = { ...got, files: [...got.files, ...pre.filter(Boolean)] };'));
it('R154 мутант нумерации пришедших файлов вместо indexes переносит последний файл перед готовым', () => mutant(mixedReady,
  'got.indexes?.[k] ?? k', 'k'));
it('R154 без готового фото используется обычный мост с compress и подписью', async () => {
  await fixture('granted', 1, async f => {
    await select(f, [0]); await send(f);
    assert.deepEqual(f.reads, [{ ids: ['photo-0'], compress: true }]);
    assert.deepEqual(Array.from(f.sends[0].files, file => file.name), ['0.jpg']);
  }, source, false, { readyViewer: true });
});
async function originalsReady(raw = source) {
  await fixture('granted', 1, async f => {
    await f.ready(0);
    await React.act(async () => button(f.host, 'Файл').click()); await f.settle();
    await React.act(async () => f.host.querySelectorAll<HTMLButtonElement>('.gal-row')[1].click()); await f.settle();
    await select(f, [0]); await send(f);
    assert.deepEqual(f.reads, [{ ids: ['photo-0'], compress: false }], 'originals игнорирует ready');
    assert.deepEqual(Array.from(f.sends[0].files, file => file.name), ['0.jpg']);
  }, raw, false, { readyViewer: true });
}
it('R154 режим без сжатия игнорирует ранее готовое фото и заново получает оригинал', () => originalsReady());
it('R154 мутант использования ready в originals лишает отправку оригинала', () => mutant(originalsReady,
  'const pre = originals ? [] : list.map', 'const pre = list.map'));
