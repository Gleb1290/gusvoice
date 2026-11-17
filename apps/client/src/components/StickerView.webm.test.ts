import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
const compiled = ts.transpileModule(readFileSync(new URL('./StickerView.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

type Media = {
  ready: number; time: number; paused: boolean; seeking: boolean; duration: number;
  error: MediaError | null; plays: number; pauses: number; seeks: number[];
  play?: () => Promise<void>; seekThrows?: boolean;
};
type Props = Parameters<typeof import('./StickerView').StickerView>[0];
function deferred() {
  let resolve!: () => void, reject!: (e: Error) => void;
  const promise = new Promise<void>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(check: (f: {
  host: HTMLDivElement; video(): HTMLVideoElement; media(v?: HTMLVideoElement): Media;
  render(p: Partial<Props>): Promise<void>; event(name: string, v?: HTMLVideoElement): Promise<void>;
  visible(value: boolean): Promise<void>; settle(fn: () => void): Promise<void>; unmount(): Promise<void>;
}) => Promise<void>, initial: Partial<Props> = {}, setup?: (s: Media) => void) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  const noNetwork = (() => { throw new Error('сеть в тесте запрещена'); }) as typeof fetch;
  globalThis.fetch = window.fetch = noNetwork;
  let hidden = false, mounted = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  const states = new WeakMap<HTMLVideoElement, Media>();
  const media = (v: HTMLVideoElement): Media => {
    let s = states.get(v);
    if (!s) {
      s = { ready: 4, time: 0, paused: true, seeking: false, duration: 1, error: null,
        plays: 0, pauses: 0, seeks: [] };
      setup?.(s); states.set(v, s);
    }
    return s;
  };
  const proto = window.HTMLMediaElement.prototype;
  for (const [name, field] of [['readyState', 'ready'], ['paused', 'paused'], ['seeking', 'seeking'],
    ['duration', 'duration'], ['error', 'error']] as const) {
    Object.defineProperty(proto, name, { configurable: true, get(this: HTMLVideoElement) { return media(this)[field]; } });
  }
  Object.defineProperty(proto, 'currentTime', { configurable: true,
    get(this: HTMLVideoElement) { return media(this).time; },
    set(this: HTMLVideoElement, value: number) {
      const s = media(this);
      if (s.seekThrows) throw new Error('seek недоступен');
      s.seeks.push(value); s.time = value; s.seeking = true;
    },
  });
  proto.play = function () {
    const s = media(this as HTMLVideoElement); s.plays++;
    if (s.play) return s.play();
    s.paused = false; return Promise.resolve();
  };
  proto.pause = function () { const s = media(this as HTMLVideoElement); s.pauses++; s.paused = true; };
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports, require: createRequire(import.meta.url), document });
  const { StickerView } = module.exports as typeof import('./StickerView');
  let props: Props = { url: 'https://media.invalid/a.webm', format: 'webm', emoji: '🦆', ...initial };
  const video = () => { const v = host.querySelector('video'); assert.ok(v); return v; };
  const render = async (p: Partial<Props>) => {
    props = { ...props, ...p };
    await React.act(async () => root.render(React.createElement(StickerView, props)));
  };
  const unmount = async () => { if (mounted) { mounted = false; await React.act(async () => root.unmount()); } };
  try {
    await render({});
    await check({ host, video, media: v => media(v ?? video()), render, unmount,
      event: async (name, v = video()) => { await React.act(async () => { v.dispatchEvent(new window.Event(name)); }); },
      visible: async value => {
        hidden = !value;
        await React.act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
      },
      settle: async fn => { await React.act(async () => { fn(); }); },
    });
  } finally {
    try { await unmount(); } finally {
      globalThis.fetch = originalFetch;
      host.remove(); await GlobalRegistrator.unregister();
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  }
}

it('готовое видео запускается явно и сохраняет размеры, подпись и атрибуты стикера', () => fixture(async f => {
  assert.equal(f.media().plays, 1); assert.equal(f.media().paused, false);
  const v = f.video();
  assert.equal(v.style.width, '72px'); assert.equal(v.style.height, '72px');
  assert.equal(v.getAttribute('aria-label'), '🦆'); assert.equal(v.loop, true);
  assert.equal(v.muted, true); assert.equal(v.hasAttribute('playsinline'), true); assert.equal(v.preload, 'metadata');
}, { size: 72 }));

it('статическое превью декодируется tiny seek без запуска анимации', () => fixture(async f => {
  assert.equal(f.media().plays, 0); assert.equal(f.media().paused, true);
  assert.deepEqual(f.media().seeks, [0.001]);
  f.media().seeking = false;
  await f.event('seeked'); await f.event('loadeddata'); await f.event('canplay');
  assert.deepEqual(f.media().seeks, [0.001]); assert.equal(f.media().plays, 0);
  assert.equal(f.video().style.width, '22px');
}, { animate: false, size: 22 }));

it('превью ждёт метаданные и принимает неизвестную длительность без повторяющихся seek', async () => {
  for (const duration of [NaN, Infinity]) await fixture(async f => {
    assert.deepEqual(f.media().seeks, []);
    f.media().ready = 1; await f.event('loadedmetadata');
    assert.deepEqual(f.media().seeks, [0.001]);
    await f.event('loadedmetadata'); await f.event('canplay');
    assert.equal(f.media().seeks.length, 1); assert.equal(f.media().plays, 0);
  }, { animate: false }, s => { s.ready = 0; s.duration = duration; });
});

it('смена animate запускает видео, останавливает его и сохраняет последний кадр', () => fixture(async f => {
  await f.render({ animate: true }); assert.equal(f.media().plays, 1);
  f.media().time = 0.6; const seeks = f.media().seeks.length;
  await f.render({ animate: false });
  assert.equal(f.media().paused, true); assert.equal(f.media().time, 0.6);
  assert.equal(f.media().seeks.length, seeks);
}, { animate: false }));

it('скрытие останавливает видео, готовность в фоне не запускает, возврат возобновляет', () => fixture(async f => {
  await f.visible(false); assert.equal(f.media().paused, true);
  await f.event('loadeddata'); await f.event('canplay'); assert.equal(f.media().plays, 1);
  await f.visible(true); assert.equal(f.media().plays, 2); assert.equal(f.media().paused, false);
}));

it('loadeddata и canplay запускают готовое paused видео без дублирования работающего', () => fixture(async f => {
  f.media().paused = true; await f.event('loadeddata'); assert.equal(f.media().plays, 2);
  await f.event('canplay'); assert.equal(f.media().plays, 2);
  f.media().paused = true; await f.event('canplay'); assert.equal(f.media().plays, 3);
}));

it('ожидающий play объединяет сигналы готовности в одну попытку', async () => {
  const d = deferred();
  await fixture(async f => {
    await f.event('loadeddata'); await f.event('canplay'); assert.equal(f.media().plays, 1);
    await f.settle(() => { f.media().paused = false; d.resolve(); });
    await f.event('canplay'); assert.equal(f.media().plays, 1);
  }, {}, s => { s.play = () => d.promise; });
});

it('отказ play показывает эмодзи до статического кадра и не создаёт цикл повторов', () => fixture(async f => {
  assert.ok(f.host.querySelector('.sticker-fallback')); assert.equal(f.media().plays, 1);
  assert.deepEqual(f.media().seeks, [0.001]);
  f.media().seeking = false; await f.event('seeked');
  assert.equal(f.host.querySelector('.sticker-fallback'), null);
  await f.event('loadeddata'); await f.event('canplay'); assert.equal(f.media().plays, 1);
  f.media().play = undefined; await f.visible(false); await f.visible(true);
  assert.equal(f.media().plays, 2); assert.equal(f.media().paused, false);
}, {}, s => { s.play = () => Promise.reject(new Error('NotAllowedError')); }));

it('неподдерживаемый seek оставляет видимый fallback без спина', () => fixture(async f => {
  assert.equal(f.host.querySelector('.sticker-fallback')?.textContent?.trim(), '❔');
  await f.event('loadedmetadata'); await f.event('canplay');
  assert.equal(f.media().plays, 0); assert.equal(f.media().paused, true);
  assert.ok(f.host.querySelector('.sticker-fallback'));
}, { animate: false, emoji: '' }, s => { s.seekThrows = true; }));

it('ошибка медиа останавливает видео и сохраняет видимый эмодзи до смены URL', () => fixture(async f => {
  await f.event('error'); assert.equal(f.media().paused, true);
  assert.equal(f.host.querySelector('.sticker-fallback')?.textContent?.trim(), '🦆');
  await f.event('loadeddata'); await f.event('canplay'); await f.visible(true);
  assert.equal(f.media().plays, 1); assert.ok(f.host.querySelector('.sticker-fallback'));
  await f.render({ url: 'https://media.invalid/b.webm' });
  assert.equal(f.host.querySelector('.sticker-fallback'), null); assert.equal(f.media().plays, 1);
}));

it('поздние результаты старого play не останавливают новое поколение или новый URL', async () => {
  for (const result of ['resolve', 'reject'] as const) for (const change of ['intent', 'url']) {
    const d = deferred(); let first = true;
    await fixture(async f => {
      const old = f.video(); f.media().play = undefined;
      if (change === 'intent') {
        await f.render({ animate: false }); await f.render({ animate: true });
      } else {
        await f.render({ url: 'https://media.invalid/new.webm' });
        assert.notEqual(f.video(), old); assert.equal(f.media(old).paused, true);
      }
      const pauses = f.media().pauses;
      await f.settle(() => result === 'resolve' ? d.resolve() : d.reject(new Error('AbortError')));
      assert.equal(f.media().pauses, pauses); assert.equal(f.media().paused, false);
      assert.equal(f.host.querySelector('.sticker-fallback'), null);
      if (change === 'url') {
        await f.event('loadeddata', old); await f.event('error', old);
        assert.equal(f.host.querySelector('.sticker-fallback'), null); assert.equal(f.media().paused, false);
      }
    }, {}, s => { if (first) { first = false; s.play = () => d.promise; } });
  }
});

it('размонтирование останавливает видео и игнорирует события и поздний отказ play', async () => {
  const d = deferred();
  await fixture(async f => {
    const v = f.video(), s = f.media(); await f.unmount();
    assert.equal(s.paused, true); const pauses = s.pauses;
    await f.event('canplay', v); await f.event('error', v); await f.visible(true);
    await f.settle(() => d.reject(new Error('AbortError')));
    assert.equal(s.plays, 1); assert.equal(s.pauses, pauses); assert.equal(f.host.childElementCount, 0);
  }, {}, s => { s.play = () => d.promise; });
});
