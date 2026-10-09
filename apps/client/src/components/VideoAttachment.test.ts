import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';

before(() => { GlobalRegistrator.register({ url: 'http://localhost/' }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(() => { GlobalRegistrator.unregister(); });
type Props = { a: { url: string; name: string; contentType: string; size: number; gif?: boolean }; href: string; sizeLabel: string; maxW: number; maxH: number; autoplay?: boolean };
function load(change?: (source: string) => string, noIO = false) {
  const observers: { emit: (...visible: boolean[]) => void; observed: Element[]; disconnected: number }[] = [];
  class FakeIO {
    observed: Element[] = []; disconnected = 0;
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) { observers.push(this); }
    emit(...visible: boolean[]) { this.callback(visible.map(isIntersecting => ({ isIntersecting }))); }
    observe(el: Element) { this.observed.push(el); }
    disconnect() { this.disconnected++; }
  }
  let source = readFileSync(new URL('./VideoAttachment.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (change) { const changed = change(source); assert.notEqual(changed, source, 'исходниковый мутант действительно меняет код'); source = changed; }
  const dependencies: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': { jsx, jsxs, Fragment }, '@gusvoice/shared': { formatDuration: () => '0:20' },
    '../fileActions': { attachmentKey: () => 'video' }, '../imageSize': { attachmentBox: () => ({ width: 200, height: 100 }) },
    '../toast': { toast() {} }, '../videoPip': { pipSupported: () => false, openPip: () => Promise.resolve() },
    './FileCard': { FileCard: () => React.createElement('div', { className: 'file-card' }), DownloadBadge: () => null },
    './Icon': { Icon: () => null }, './SpoilerCover': { SpoilerCover: () => null },
  };
  const module = { exports: {} as { playWhileVisible: (v: HTMLVideoElement) => () => void; VideoAttachment: React.ComponentType<Props> } };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, ...(noIO ? {} : { IntersectionObserver: FakeIO }),
    require: (id: string) => { assert.ok(id in dependencies, `неожиданный импорт ${id}`); return dependencies[id]; },
  });
  return { ...module.exports, observers };
}
type Loaded = ReturnType<typeof load>;
type Case = (loaded: Loaded) => Promise<void>;
const visibility: Case = async ({ playWhileVisible, observers }) => {
  const video = document.createElement('video'); let plays = 0; let pauses = 0;
  video.play = () => { plays++; return Promise.resolve(); }; video.pause = () => { pauses++; };
  const cancel = playWhileVisible(video); const io = observers[0]!;
  assert.equal(io.observed[0], video, 'наблюдается именно переданное видео');
  io.emit(true); assert.equal(plays, 1, 'видимое видео играет');
  io.emit(false); assert.equal(pauses, 1, 'невидимое видео встаёт');
  io.emit(true, false); assert.equal(pauses, 2, 'последняя запись пачки определяет видимость');
  io.emit(false, true); assert.equal(plays, 2, 'последняя запись возвращает воспроизведение');
  io.emit(); assert.equal(plays + pauses, 4, 'пустая пачка ничего не меняет');
  cancel(); assert.equal(io.disconnected, 1, 'отмена отключает наблюдатель');
};
const attachment = { url: '/clip.mp4', name: 'clip.mp4', contentType: 'video/mp4', size: 100 };
async function mounted(loaded: Loaded, autoplay: boolean | undefined, gif: boolean, check: (host: HTMLDivElement) => Promise<void>) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => { root.render(React.createElement(loaded.VideoAttachment, { a: { ...attachment, gif }, autoplay, href: '/download', sizeLabel: '100', maxW: 300, maxH: 300 })); });
    await check(host);
  } finally { await React.act(async () => { root.unmount(); }); host.remove(); }
}
const mounting: Case = async loaded => {
  for (const [autoplay, gif, expected] of [[true, false, true], [undefined, true, true], [false, false, false], [undefined, false, false], [false, true, false]] as const) {
    const n = loaded.observers.length;
    await mounted(loaded, autoplay, gif, async host => {
      assert.equal(loaded.observers.length - n, expected ? 1 : 0, 'наблюдатель только при автоматическом воспроизведении');
      if (expected) assert.equal(loaded.observers[n]!.observed[0], host.querySelector('video'));
    });
    if (expected) assert.equal(loaded.observers[n]!.disconnected, 1, 'unmount отключает видео');
  }
};
it('видимость видео: play/pause по последней записи, пустая пачка и отмена', async () => { await visibility(load()); });
it('видео: autoplay и GIF наблюдаются, выключенное воспроизведение — нет', async () => { await mounting(load()); });
it('ошибка видео переключает на файл и отключает наблюдение', async () => {
  const loaded = load();
  await mounted(loaded, true, false, async host => {
    await React.act(async () => { host.querySelector('video')!.dispatchEvent(new Event('error')); });
    assert.equal(loaded.observers[0]!.disconnected, 1); assert.ok(host.querySelector('.file-card')); assert.equal(host.querySelector('video'), null);
  });
});
it('без IntersectionObserver отмена безопасна, отказ play обработан', async () => {
  const video = document.createElement('video'); assert.doesNotThrow(() => load(undefined, true).playWhileVisible(video)());
  const loaded = load(); let caught = false;
  // Настоящий rejected Promise: перехватываем только факт вызова catch, не подменяем отказ успехом.
  video.play = () => { const promise = Promise.reject(new Error('autoplay denied')); const original = promise.catch.bind(promise);
    promise.catch = ((handler: (error: unknown) => unknown) => { caught = true; return original(handler); }) as typeof promise.catch; return promise; };
  const cancel = loaded.playWhileVisible(video); loaded.observers[0]!.emit(true);
  await Promise.resolve(); assert.equal(caught, true, 'отказ play обработан'); cancel();
});
for (const [name, anchor, replacement, check, failure] of [
  ['удалена пауза', 'else v.pause();', 'else { /* нет паузы */ }', visibility, 'невидимое видео встаёт'],
  ['инвертирована видимость', 'if (e.isIntersecting)', 'if (!e.isIntersecting)', visibility, 'видимое видео играет'],
  ['первая запись вместо последней', 'entries[entries.length - 1]', 'entries[0]', visibility, 'последняя запись пачки'],
  ['удалён disconnect', 'return () => io.disconnect();', 'return () => {};', visibility, 'отмена отключает'],
  ['наблюдатель всегда', 'if (!v || !playing || failed) return;', 'if (!v || failed) return;', mounting, 'наблюдатель только'],
] as [string, string, string, Case, string][]) {
  it(`видео: исходниковый мутант «${name}» ловится после зелёного оригинала`, async () => {
    await check(load());
    await assert.rejects(() => check(load(source => { assert.equal(source.split(anchor).length, 2, 'якорь мутанта уникален'); return source.replace(anchor, replacement); })),
      (error: unknown) => error instanceof assert.AssertionError && error.message.includes(failure));
  });
}
