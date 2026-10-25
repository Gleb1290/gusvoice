import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
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
type Props = React.ComponentProps<typeof import('./Lightbox')['Lightbox']>;
let createRoot: typeof import('react-dom/client')['createRoot'];
before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/', settings: { enableImageFileLoading: false } });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  createRoot = (await import('react-dom/client')).createRoot;
});
after(() => GlobalRegistrator.unregister());

type Options = { once?: boolean; video?: boolean; deadline?: number | null; text?: string };
async function scene(options: Options, check: (s: {
  tick: (now: number) => Promise<void>; root: () => Element | null;
  protectedCount: () => number; releasedCount: () => number; closedCount: () => number;
  timers: Map<number, { run: () => void; ms: number }>; unmount: () => Promise<void>;
}) => Promise<void>) {
  let now = 5000, protectedCount = 0, releasedCount = 0, closedCount = 0, nextTimer = 1, unmounted = false;
  const timers = new Map<number, { run: () => void; ms: number }>();
  // Часы и расписание — внешняя граница. Настоящие useEffect/setState/cleanup и DOM остаются React.
  class Clock extends Date { static override now() { return now; } }
  const frameWindow = {
    setInterval: (run: () => void, ms: number) => { const id = nextTimer++; timers.set(id, { run, ms }); return id; },
    clearInterval: (id: number) => { timers.delete(id); },
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
    getSelection: window.getSelection.bind(window),
    innerWidth: 1000, innerHeight: 800,
  };
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM,
    '../lightboxGestures': gestures, '../lightboxZoom': zoom, '../mediaViewerRules': viewer,
    '../fileActions': { subscribeFileJobs: () => () => {}, fileJobOf: () => null,
      downloadInApp: () => false, progressRatio: () => 0, progressText: () => '' },
    '../pcDownloads': { canShareFiles: () => true, ringDownloads: () => false, savedFilePath: () => null,
      shareDownload: () => Promise.resolve(), showInFolder: () => {}, startDownload: () => {}, toggleDownload: () => {} },
    './FileCard': { ProgressRing: () => null }, '../nativeMedia': { nativeMediaAvailable: () => false },
    '../phoneLayout': { usePhoneLayout: () => false }, '../toast': { toast: () => {} },
    '../videoPip': { pipSupported: () => true, openPip: () => Promise.resolve() },
    './ContextMenu': { MenuItem: (p: { label: string }) => React.createElement('button', {}, p.label) },
    './Icon': { Icon: () => null }, './VideoAttachment': { BLANK_POSTER: '', videoFrameSrc: (url: string) => url },
    './VoiceSpeedButton': { VoiceSpeedButton: () => React.createElement('button', { 'data-speed': true }, 'Скорость') },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(options.text ?? source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { module, exports: module.exports, document, window: frameWindow, Date: Clock,
    Element, HTMLVideoElement, performance, requestAnimationFrame: window.requestAnimationFrame.bind(window),
    require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `явный импорт ${id}`); return deps[id]; } });
  const Component = (module.exports as typeof import('./Lightbox')).Lightbox;
  const protect = () => { protectedCount++; return () => { releasedCount++; }; };
  const images: Props['images'] = [{ url: '/private-media', name: 'Одноразовое медиа', video: options.video,
    // Проводку MessagePane (без downloadUrl/actions у once) отдельно проверяет AST-страж.
    ...(options.once === false ? { downloadUrl: '/ordinary-download' } : {}) }];
  function Parent() {
    const [shown, setShown] = React.useState(true);
    return shown ? React.createElement(Component, { images, index: 0, onIndex: () => {},
      onClose: () => { closedCount++; setShown(false); },
      ...(options.once === false ? {} : { once: { deadline: options.deadline ?? null, protect } }),
    }) : null;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true; await React.act(async () => root.unmount()); host.remove();
  };
  try {
    await React.act(async () => root.render(React.createElement(Parent)));
    await check({
      tick: async value => { now = value; await React.act(async () => { [...timers.values()].forEach(timer => timer.run()); }); },
      root: () => document.querySelector('.lightbox'), protectedCount: () => protectedCount,
      releasedCount: () => releasedCount, closedCount: () => closedCount, timers, unmount,
    });
  } finally { await unmount(); }
}

for (const video of [false, true]) {
  it(`R262 Lightbox: одноразовое ${video ? 'видео' : 'фото'} видно, без скачивания/меню/PiP/альбома, ПКМ подавлен`, async () => {
    await scene({ video }, async s => {
      const root = s.root(); assert.equal(!!root, true);
      assert.equal(root?.querySelector(video ? 'video' : 'img')?.getAttribute('src'), '/private-media');
      assert.equal(root?.querySelectorAll('a,[download],[title="Ещё"],[title="Картинка в картинке"],[title="Зациклить"],.lb-strip,.lb-nav').length, 0);
      assert.equal(root?.querySelector('.lb-once')?.textContent, '1');
      const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      await React.act(async () => { root!.dispatchEvent(event); });
      assert.equal(event.defaultPrevented, true);
      assert.equal(document.querySelectorAll('.lb-menu').length, 0);
      assert.equal(s.protectedCount(), 1); assert.equal(s.releasedCount(), 0);
      assert.equal(s.timers.size, 0, 'без таймера once живёт до закрытия');
      await s.tick(1_000_000);
      assert.equal(s.closedCount(), 0);
      const close = root?.querySelector<HTMLButtonElement>('[title="Закрыть"]');
      assert.equal(!!close, true);
      await React.act(async () => close!.click());
      assert.equal(s.closedCount(), 1); assert.equal(s.releasedCount(), 1);
      assert.equal(s.root() === null, true, 'закрытие убирает защищённое медиа из DOM');
    });
  });
}

async function countdown(text = source): Promise<void> {
  await scene({ deadline: 10_000, text }, async s => {
    assert.equal(s.root()?.querySelector('.lb-once')?.textContent, '5 с');
    assert.equal(s.timers.size, 1, 'R262:таймер-просмотра-зарегистрирован');
    assert.equal([...s.timers.values()][0].ms, 250);
    await s.tick(9_999);
    assert.equal(s.root()?.querySelector('.lb-once')?.textContent, '1 с', 'часть секунды не показывает преждевременный ноль');
    assert.equal(s.closedCount(), 0, 'за 1 мс до срока медиа ещё видно');
    await s.tick(10_000);
    assert.equal(s.closedCount(), 1, 'R262:ровно-deadline-закрывает-просмотр');
    assert.equal(s.root() === null, true);
    assert.equal(s.timers.size, 0, 'размонтирование отменяет отсчёт');
    assert.equal(s.releasedCount(), 1, 'закрытие по сроку освобождает защиту');
    await s.tick(11_000);
    assert.equal(s.closedCount(), 1, 'закрытый просмотр не продолжает сжигать сообщение');
  });
}
it('R262 Lightbox: отсчёт обновляется, за 1 мс до срока не закрывает, ровно deadline закрывает и очищает эффект', () => countdown());

async function protection(text = source): Promise<void> {
  await scene({ deadline: 10_000, text }, async s => {
    assert.equal(s.protectedCount(), 1, 'R262:защита-при-монтировании');
    assert.equal(s.releasedCount(), 0);
    await s.unmount();
    assert.equal(s.releasedCount(), 1, 'R262:выход-снимает-защиту');
    assert.equal(s.timers.size, 0);
  });
}
it('R262 Lightbox: уход из ленты до deadline освобождает защиту и интервал без вызова onClose', async () => {
  await protection();
  await scene({ deadline: 10_000 }, async s => {
    await s.unmount(); await s.tick(10_000);
    assert.equal(s.closedCount(), 0);
  });
});

it('R262 обычное видео парно сохраняет скачивание, меню и PiP, без защиты и once-интервала', async () => {
  await scene({ video: true, once: false }, async s => {
    const root = s.root();
    assert.equal(root?.querySelector('a[download]')?.getAttribute('href'), '/ordinary-download');
    assert.equal(root?.querySelector('a[download]')?.getAttribute('title'), 'Скачать');
    for (const title of ['Ещё', 'Картинка в картинке', 'Зациклить']) assert.equal(!!root?.querySelector(`[title="${title}"]`), true, title);
    assert.equal(root?.querySelector('.lb-once') === null, true);
    assert.equal(s.protectedCount(), 0); assert.equal(s.timers.size, 0);
  });
});

for (const [label, anchor, replacement, check, failure] of [
  ['срок стал строгим >', 'if (now >= onceDeadline) onCloseRef.current();', 'if (now > onceDeadline) onCloseRef.current();', countdown, 'R262:ровно-deadline-закрывает'],
  ['защита не вызывается', 'onceOn && onceProtect ? onceProtect() : undefined', 'undefined', protection, 'R262:защита-при-монтировании'],
] as const) {
  it(`R262 контрфакт Lightbox: ${label}`, async () => {
    await check();
    assert.equal(source.split(anchor).length - 1, 1, 'единственный участок настоящего компонента');
    await assert.rejects(() => check(source.replace(anchor, replacement)), error => error instanceof assert.AssertionError
      && error.message.includes(failure));
  });
}
