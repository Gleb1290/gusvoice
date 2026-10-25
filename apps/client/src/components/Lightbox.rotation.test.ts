import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as gestures from '../lightboxGestures';
import * as zoom from '../lightboxZoom';
import * as viewer from '../mediaViewerRules';

const source = readFileSync(new URL('./Lightbox.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let createRoot: typeof import('react-dom/client')['createRoot'];
before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/', settings: { enableImageFileLoading: false } });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  createRoot = (await import('react-dom/client')).createRoot;
});
after(() => GlobalRegistrator.unregister());

type Options = { text?: string; phone?: boolean; video?: boolean };
type Scene = {
  image: () => HTMLImageElement | null;
  root: () => Element | null;
  resize: (w: number, h: number) => Promise<void>;
  key: (key: string, ctrlKey?: boolean) => Promise<void>;
  zoomOffCenter: () => Promise<void>;
  rotate: () => Promise<void>;
  close: () => Promise<void>;
  unmount: () => Promise<void>;
  listeners: Set<EventListenerOrEventListenerObject>;
};

// Исполняется ВЕСЬ настоящий компонент с настоящими React effect/ref/state/portal.
// Happy DOM не считает layout: только измеряемую внешнюю границу задаём явно.
// Это не проверка CSS, Android orientation или реального браузерного вписывания.
async function scene(options: Options, check: (s: Scene) => Promise<void>) {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let nextTimer = 1, unmounted = false;
  const timers = new Map<number, () => void>();
  let width = 400, height = 640;
  const frameWindow = {
    innerWidth: width, innerHeight: height,
    setTimeout: (run: () => void) => { const id = nextTimer++; timers.set(id, run); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    getSelection: window.getSelection.bind(window),
    addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
      if (type === 'resize') listeners.add(fn);
      window.addEventListener(type, fn);
    },
    removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
      if (type === 'resize') listeners.delete(fn);
      window.removeEventListener(type, fn);
    },
  };
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM,
    '../lightboxGestures': gestures, '../lightboxZoom': zoom, '../mediaViewerRules': viewer,
    '../fileActions': { subscribeFileJobs: () => () => {}, fileJobOf: () => null,
      downloadInApp: () => false, progressRatio: () => 0, progressText: () => '' },
    '../pcDownloads': { canShareFiles: () => false, ringDownloads: () => false, savedFilePath: () => null,
      shareDownload: () => Promise.resolve(), showInFolder: () => {}, startDownload: () => {}, toggleDownload: () => {} },
    './FileCard': { ProgressRing: () => null }, '../nativeMedia': { nativeMediaAvailable: () => false },
    '../phoneLayout': { usePhoneLayout: () => options.phone ?? true }, '../toast': { toast: () => {} },
    '../videoPip': { pipSupported: () => false, openPip: () => Promise.resolve() },
    './ContextMenu': { MenuItem: () => null }, './Icon': { Icon: () => null },
    './VideoAttachment': { BLANK_POSTER: '', videoFrameSrc: (url: string) => url },
    './VoiceSpeedButton': { VoiceSpeedButton: () => null },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(options.text ?? source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { module, exports: module.exports, document, window: frameWindow,
    Element, HTMLVideoElement, performance,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `явный импорт ${id}`); return deps[id]; } });
  const Component = (module.exports as typeof import('./Lightbox')).Lightbox;
  function Parent() {
    const [shown, setShown] = React.useState(true);
    return shown ? React.createElement(Component, {
      images: [{ url: '/ordinary-media', name: 'Обычное медиа', video: options.video, downloadUrl: '/download' }],
      index: 0, onIndex: () => {}, onClose: () => setShown(false),
    }) : null;
  }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const image = () => document.querySelector<HTMLImageElement>('.lightbox img.lb-img');
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await React.act(async () => root.unmount());
    host.remove();
  };
  try {
    await React.act(async () => root.render(React.createElement(Parent)));
    const stage = document.querySelector<HTMLElement>('.lightbox .lb-stage');
    assert.equal(!!stage, true);
    Object.defineProperties(stage!, { clientWidth: { get: () => width }, clientHeight: { get: () => height } });
    // Нулевые padding заданы стилем, не подменой getComputedStyle или алгоритма rotateFit.
    stage!.style.padding = '0px';
    if (!options.video) {
      const img = image(); assert.equal(!!img, true);
      Object.defineProperties(img!, {
        naturalWidth: { value: 256 }, naturalHeight: { value: 256 },
        offsetWidth: { value: 256 }, offsetHeight: { value: 256 },
        getBoundingClientRect: { value: () => ({ x: width / 2 - 128, y: height / 2 - 128,
          left: width / 2 - 128, top: height / 2 - 128, width: 256, height: 256,
          right: width / 2 + 128, bottom: height / 2 + 128, toJSON: () => ({}) }) },
      });
      await React.act(async () => { img!.dispatchEvent(new window.Event('load')); });
    }
    await check({ image, root: () => document.querySelector('.lightbox'), listeners, unmount,
      resize: async (w, h) => {
        width = w; height = h; frameWindow.innerWidth = w; frameWindow.innerHeight = h;
        await React.act(async () => { window.dispatchEvent(new window.Event('resize')); });
      },
      key: async (key, ctrlKey = false) => {
        await React.act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key, ctrlKey })); });
      },
      zoomOffCenter: async () => {
        await React.act(async () => {
          const event = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -1 });
          // happy-dom 20.14.5 наследует WheelEvent от UIEvent, а не MouseEvent:
          // ctrlKey И clientX/Y из init теряются. Без координат zoomAt получил бы NaN вместо сдвига.
          Object.defineProperties(event, {
            ctrlKey: { value: true }, clientX: { value: 300 }, clientY: { value: 320 },
          });
          assert.deepEqual([event.ctrlKey, event.deltaY, event.clientX, event.clientY], [true, -1, 300, 320],
            'R277: событие действительно несёт Ctrl и точку увеличения');
          document.querySelector('.lightbox')!.dispatchEvent(event);
        });
      },
      rotate: async () => {
        const button = document.querySelector<HTMLButtonElement>('.lightbox [title="Повернуть"]');
        assert.equal(!!button, true);
        await React.act(async () => button!.click());
      },
      close: async () => {
        await React.act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); });
      },
    });
  } finally {
    await unmount();
    // При мутанте cleanup не оставляем чужой listener следующим сценам.
    for (const listener of listeners) window.removeEventListener('resize', listener);
  }
}

async function refit(text = source, phone = true) {
  await scene({ text, phone }, async s => {
    assert.equal(s.image()?.style.transform === 'scale(1.56)', true, 'исходный fit по явной портретной геометрии');
    await s.resize(800, 280);
    assert.equal(s.image()?.style.transform === 'scale(1.09)', true, 'R276:resize-пересчитывает-fit');
    await s.resize(400, 640);
    assert.equal(s.image()?.style.transform === 'scale(1.56)', true, 'обратный поворот не оставляет альбомный масштаб');
  });
}
for (const phone of [true, false]) {
  it(`R276 Lightbox: обычное фото заново вписывается после resize и обратно (${phone ? 'телефон' : 'ПК'})`, () => refit(source, phone));
}

async function preserveZoom(text = source) {
  await scene({ text }, async s => {
    await s.zoomOffCenter();
    const before = s.image()?.style.transform ?? '';
    assert.equal(before.includes('scale(1.81)') && before.includes('translate('), true, 'проверяется реальное увеличение со сдвигом');
    await s.resize(800, 280);
    assert.equal(s.image()?.style.transform === before, true, 'R276:resize-сохраняет-ручной-zoom-и-pan');
    await s.resize(400, 640);
    assert.equal(s.image()?.style.transform === before, true);
  });
}
it('R276 Lightbox: resize не сбрасывает выбранный человеком масштаб и сдвиг к точке', () => preserveZoom());

async function preserveRotation(text = source) {
  await scene({ text }, async s => {
    await s.rotate();
    const before = s.image()?.style.transform ?? '';
    assert.equal(before.includes('rotate(-90deg)') && before.includes('scale(1.56)'), true);
    // Квадрат после поворота остаётся ровно на baseZoom: регрессия без rotRef-границы
    // не прячется за ветку «масштаб отличается от базового».
    await s.resize(800, 280);
    assert.equal(s.image()?.style.transform === before, true, 'R276:resize-не-перевписывает-повёрнутое-фото');
  });
}
it('R276 Lightbox: повёрнутое пользователем фото сохраняет угол и масштаб даже при zoom === baseZoom', () => preserveRotation());

it('R276 Lightbox: обычное видео переживает resize без фото, потери плеера или закрытия', async () => {
  await scene({ video: true }, async s => {
    const player = s.root()?.querySelector('video');
    assert.equal(!!player && player.getAttribute('src') === '/ordinary-media', true);
    await s.resize(800, 280); await s.resize(400, 640);
    assert.equal(s.root()?.querySelector('video') === player, true);
    assert.equal(s.image() === null, true);
  });
});

for (const closing of [true, false]) {
  it(`R276 Lightbox: resize-listener снимается при ${closing ? 'закрытии через Escape' : 'размонтировании'}`, async () => {
    await scene({}, async s => {
      assert.equal(s.listeners.size === 1, true, 'один listener на открытый просмотр');
      await s.resize(800, 280);
      assert.equal(s.listeners.size === 1, true, 'перерисовка не размножает listener');
      if (closing) await s.close(); else await s.unmount();
      assert.equal(s.root() === null, true);
      assert.equal(s.listeners.size === 0, true, 'R276:закрытый-просмотр-снимает-resize');
      await s.resize(400, 640);
      assert.equal(s.root() === null, true);
    });
  });
}

for (const [label, anchor, replacement, check, marker] of [
  ['убрана подписка resize', "window.addEventListener('resize', onResize);", 'void onResize;', refit, 'R276:resize-пересчитывает-fit'],
  ['resize безусловно сбрасывает ручной zoom', 'if (rotRef.current === 0 && Math.abs(zoomRef.current - baseZoom.current) < 0.001) applyFit();', 'applyFit();', preserveZoom, 'R276:resize-сохраняет-ручной-zoom-и-pan'],
  ['resize игнорирует ручной поворот', 'rotRef.current === 0 && Math.abs(zoomRef.current - baseZoom.current) < 0.001', 'Math.abs(zoomRef.current - baseZoom.current) < 0.001', preserveRotation, 'R276:resize-не-перевписывает-повёрнутое-фото'],
] as const) {
  it(`R276 контрфакт Lightbox: ${label}`, async () => {
    await check();
    assert.equal(source.split(anchor).length - 1, 1, 'единственный участок настоящего модуля');
    await assert.rejects(() => check(source.replace(anchor, replacement)), error =>
      error instanceof assert.AssertionError && error.message.includes(marker));
  });
}
