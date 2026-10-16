import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { formatDuration } from '@gusvoice/shared';

before(() => { GlobalRegistrator.register({ url: 'http://localhost/' }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(() => { GlobalRegistrator.unregister(); });
type Props = { a: { url: string; name: string; contentType: string; size: number; gif?: boolean; durationMs?: number }; href: string; sizeLabel: string; maxW: number; maxH: number; autoplay?: boolean };
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
    react: React, 'react/jsx-runtime': { jsx, jsxs, Fragment }, '@gusvoice/shared': { formatDuration },
    '../fileActions': { attachmentKey: () => 'video' }, '../imageSize': { attachmentBox: () => ({ width: 200, height: 100 }) },
    '../toast': { toast() {} }, '../videoPip': { pipSupported: () => false, openPip: () => Promise.resolve() },
    './FileCard': { FileCard: () => React.createElement('div', { className: 'file-card' }), DownloadBadge: () => null },
    './Icon': { Icon: ({ name, size }: { name: string; size: number }) => React.createElement('svg', { 'data-icon': name, width: size, height: size }) }, './SpoilerCover': { SpoilerCover: () => null },
  };
  const module = { exports: {} as { videoTimeLeftMs: (duration: number, currentTime: number) => number | null; playWhileVisible: (v: HTMLVideoElement) => () => void; VideoAttachment: React.ComponentType<Props> } };
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
  assert.equal(io.observed[0] === video, true, 'наблюдается именно переданное видео');
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
      if (expected) assert.equal(loaded.observers[n]!.observed[0] === host.querySelector('video'), true);
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
    assert.equal(loaded.observers[0]!.disconnected, 1); assert.ok(host.querySelector('.file-card')); assert.equal(host.querySelector('video') === null, true);
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

const inputs: readonly [number, number, number | null][] = [
  [12, 0, 12000], [11.6, 0.8, 10000], [11.6, 3.3, 8000],
  [10, 10, 0], [10, 10.4, 0],
  [NaN, 1, null], [Infinity, 1, null], [-Infinity, 1, null], [0, 0, null], [-5, 0, null],
  [12, NaN, 12000], [12, -1, 12000], [12, Infinity, 12000],
];
function checkTimeLeft(module: Loaded) {
  for (const [duration, time, expected] of inputs)
    assert.equal(module.videoTimeLeftMs(duration, time), expected, `duration=${duration}, currentTime=${time}`);
}

it('остаток видео округляется вниз в миллисекундах, не отрицателен и переживает неизвестные метаданные', () => {
  checkTimeLeft(load());
});

// Транспилируется весь TSX, зависимости подменены в прежнем whole-module fixture.
async function withMutant(from: string, to: string, check: (module: Loaded) => Promise<void> | void) {
  await check(load());
  const mutant = load(source => {
    assert.equal(source.split(from).length, 2, 'якорь мутанта уникален');
    return source.replace(from, to);
  });
  await assert.rejects(async () => check(mutant), assert.AssertionError);
}

for (const [name, from, to] of [
  ['округление к ближайшей секунде', 'Math.floor(duration - t)', 'Math.round(duration - t)'],
  ['отрицательный остаток после конца', 'Math.max(0, Math.floor(duration - t))', 'Math.floor(duration - t)'],
  ['бесконечная длительность', '!Number.isFinite(duration) || duration <= 0', 'duration <= 0'],
  ['секунды вместо миллисекунд', 'Math.max(0, Math.floor(duration - t)) * 1000', 'Math.max(0, Math.floor(duration - t))'],
] as const) {
  it(`контрфакт «${name}» нарушает договор отсчёта`, async () => {
    await withMutant(from, to, checkTimeLeft);
  });
}

const countdownAttachment = {
  url: '/api/att/countdown/view/video.mp4', name: 'video.mp4', contentType: 'video/mp4',
  size: 1234, width: 640, height: 360, durationMs: 12000,
};

async function checkPlayback(module: Loaded, autoplay: boolean, gif = false) {
  const host = document.createElement('div');
  document.body.append(host);
  let root: ReturnType<typeof createRoot> | undefined;
  const proto = HTMLVideoElement.prototype;
  const addDescriptor = Object.getOwnPropertyDescriptor(proto, 'addEventListener');
  const removeDescriptor = Object.getOwnPropertyDescriptor(proto, 'removeEventListener');
  const originalAdd = proto.addEventListener;
  const originalRemove = proto.removeEventListener;
  const listeners: { video: HTMLVideoElement; listener: EventListenerOrEventListenerObject; removed: boolean }[] = [];
  // React тоже ставит собственный timeupdate. Отделяем его от подписки эффекта числом
  // регистраций и точной парой add/remove, а не утверждением «setState не бросил после unmount».
  Object.defineProperty(proto, 'addEventListener', { configurable: true, value: function (
    this: HTMLVideoElement, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions,
  ) {
    if (type === 'timeupdate') listeners.push({ video: this, listener, removed: false });
    originalAdd.call(this, type, listener, options);
  } });
  Object.defineProperty(proto, 'removeEventListener', { configurable: true, value: function (
    this: HTMLVideoElement, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions,
  ) {
    if (type === 'timeupdate') {
      const entry = listeners.find(entry => entry.video === this && entry.listener === listener && !entry.removed);
      if (entry) entry.removed = true;
    }
    originalRemove.call(this, type, listener, options);
  } });
  try {
    root = createRoot(host);
    await React.act(async () => {
      root!.render(React.createElement(module.VideoAttachment, {
        a: { ...countdownAttachment, gif }, href: '/download', sizeLabel: '1 КБ', maxW: 400, maxH: 300, autoplay,
      }));
    });
    const video = host.querySelector<HTMLVideoElement>('video'); assert.ok(video);
    Object.defineProperty(video, 'duration', { configurable: true, value: 12 });
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 4 });
    const label = () => host.querySelector('.att-dur');
    assert.equal(label()?.textContent, gif ? 'GIF' : '0:12', 'до первого timeupdate показана полная длительность');
    await React.act(async () => { video.dispatchEvent(new Event('timeupdate')); });
    assert.equal(label()?.textContent, gif ? 'GIF' : autoplay ? '0:08' : '0:12', 'подпись зависит от фактического хода видео');
    assert.equal(label()?.classList.contains('muted'), autoplay && !gif, 'беззвучный отсчёт только у автоиграющего не-GIF');
    assert.equal(!!label()?.querySelector('svg'), autoplay && !gif, 'значок без звука не добавляется к кадру и GIF');
    if (autoplay && !gif) {
      assert.equal(label()?.querySelector('svg')?.getAttribute('width'), '12', 'значок без звука имеет размер 12');
    }
    assert.equal(!!host.querySelector('.att-play svg'), !autoplay, '▶ есть только у остановленного кадра');
    const registered = listeners.filter(entry => entry.video === video);
    assert.equal(registered.length, autoplay && !gif ? 2 : 1,
      'к React-обработчику добавляется один countdown listener только для autoplay не-GIF');
    React.act(() => root!.unmount()); root = undefined;
    assert.equal(registered.filter(entry => entry.removed).length, autoplay && !gif ? 1 : 0,
      'размонтирование удалило ровно ту подписку отсчёта, которую создал эффект');
  } finally {
    if (root) React.act(() => root!.unmount());
    host.remove();
    if (addDescriptor) Object.defineProperty(proto, 'addEventListener', addDescriptor); else Reflect.deleteProperty(proto, 'addEventListener');
    if (removeDescriptor) Object.defineProperty(proto, 'removeEventListener', removeDescriptor); else Reflect.deleteProperty(proto, 'removeEventListener');
  }
}

it('автоиграющее видео показывает 0:12 до события, 0:08 после него и убирает слушателя при закрытии', async () => {
  await checkPlayback(load(), true);
});
it('выключенный автоплей оставляет полную длительность и ▶ без значка без звука', async () => {
  await checkPlayback(load(), false);
});
it('GIF сохраняет подпись GIF без звукового значка и подписки отсчёта', async () => {
  await checkPlayback(load(), true, true);
});

for (const [name, from, to, autoplay, gif] of [
  ['подпись всегда полная', 'formatDuration(play && left !== null ? left : ms)', 'formatDuration(ms)', true, false],
  ['значок без условия игры', '{play ? <Icon name="volume-off" size={12} /> : null}', '{<Icon name="volume-off" size={12} />}', false, false],
  ['GIF подписан на отсчёт', '!v || !playing || gifFlag || failed', '!v || !playing || failed', true, true],
  ['слушатель не снимается', "return () => v.removeEventListener('timeupdate', tick);", 'return () => {};', true, false],
] as const) {
  it(`контрфакт «${name}» обнаруживается поведением настоящего видео-компонента`, async () => {
    await withMutant(from, to, module => checkPlayback(module, autoplay, gif));
  });
}
