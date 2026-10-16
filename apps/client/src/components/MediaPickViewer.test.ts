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
import { formatDuration } from '../attachRules';
import type { GalleryItem } from '../nativeMedia';
import type * as Viewer from './MediaPickViewer';

const source = readFileSync(new URL('./MediaPickViewer.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Props = Parameters<typeof Viewer.MediaPickViewer>[0];
function photo(id: string, video = false): Viewer.PickEntry {
  return { kind: 'gallery', item: { id, kind: video ? 'video' : 'image', mime: video ? 'video/mp4' : 'image/jpeg',
    size: 10, width: 40, height: 30, durationMs: video ? 7000 : 0, added: 1, name: id, rot: 0 } };
}
type Job = { item: GalleryItem; maxBytes?: number; onBytes?: (got: number) => void; cancelled: number; resolve(file: File | null): void };
type Fixture = {
  jobs: Job[]; thumbs: string[]; revoked: string[]; made: string[];
  toggles: string[]; sends: Viewer.PickEntry[]; ready: { item: GalleryItem; file: File }[];
  render(patch: Partial<Props>): Promise<void>; settle(): Promise<void>; unmount(): Promise<void>;
  swipe(dx: number, dy?: number, target?: Element, y?: number): Promise<void>;
  module: typeof Viewer;
};
// Полный модуль в VM: React настоящий, единственная IO-граница — Android-мост.
async function fixture(entries: Viewer.PickEntry[], start: number, check: (f: Fixture) => Promise<void>, raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  const jobs: Job[] = [], thumbs: string[] = [], revoked: string[] = [], made: string[] = [], toggles: string[] = [];
  const sends: Viewer.PickEntry[] = [];
  const ready: { item: GalleryItem; file: File }[] = [];
  let clock = 1000;
  const dependencies: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM,
    '../attachRules': { formatDuration }, './Icon': { Icon: () => null },
    '../nativeMedia': {
      galleryThumb: async (item: GalleryItem) => { thumbs.push(item.id); return `blob:thumb-${item.id}`; },
      galleryOriginal: (item: GalleryItem, maxBytes?: number, onBytes?: (got: number) => void) => {
        let resolve!: Job['resolve'];
        const done = new Promise<File | null>(r => { resolve = r; });
        const job: Job = { item, maxBytes, onBytes, cancelled: 0, resolve }; jobs.push(job);
        return { done, cancel: () => { job.cancelled++; } };
      },
    },
  };
  const module = { exports: {} as typeof Viewer };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module, exports: module.exports, window, document, Date: { now: () => clock += 151 },
    URL: { createObjectURL: (f: File) => { const url = `blob:full-${f.name}`; made.push(url); return url; },
      revokeObjectURL: (url: string) => revoked.push(url) },
    require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `известная зависимость ${id}`); return dependencies[id]; } });
  let props: Props = { entries, start, caption: 'начало', counter: null, busy: false,
    numberOf: i => i.id === 'b' ? 3 : 0, onCaption: caption => { props = { ...props, caption }; },
    onToggle: i => toggles.push(i.id), onSend: e => sends.push(e), onClose: () => {},
    maxBytes: 512 * 1024 * 1024, onReady: (item, file) => ready.push({ item, file }) };
  const settle = async () => { await React.act(async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); }); };
  const render = async (patch: Partial<Props>) => {
    props = { ...props, ...patch };
    await React.act(async () => root.render(React.createElement(module.exports.MediaPickViewer, props))); await settle();
  };
  const unmount = async () => { if (mounted) { await React.act(async () => root.unmount()); mounted = false; } };
  try {
    await render({});
    await check({ jobs, thumbs, revoked, made, toggles, sends, ready, module: module.exports, render, settle, unmount,
      swipe: async (dx, dy = 0, target = document.querySelector('.pick-stage')!, y = 100) => {
        await React.act(async () => {
          target.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: y }));
          target.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, clientX: 100 + dx, clientY: y + dy }));
        }); await settle();
      } });
  } finally {
    await unmount(); host.remove();
    await GlobalRegistrator.unregister();
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}
const position = () => document.querySelector('.pick-pos')?.textContent;
async function mutate(check: (raw?: string) => Promise<void>, from: string, to: string) {
  await check(source);
  assert.equal(source.split(from).length - 1, 1, 'ровно один якорь');
  await assert.rejects(() => check(source.replace(from, to)), assert.AssertionError);
}

async function checkPx(raw = source) {
  await fixture([], 0, async f => {
    for (const [css, dpr, expected] of [[319, 1, 320], [320, 1, 320], [321, 1, 321], [720, 2, 1440], [721, 2, 1440], [500, NaN, 500], [500, Infinity, 500], [500, 0, 500], [500, -2, 500], [-1, 2, 320], [400.4, 1, 400]])
      assert.equal(f.module.viewerPx(css, dpr), expected, `${css}×${dpr}`);
  }, raw);
}
it('R151 viewerPx ограничивает экран 320…1440 и заменяет неверную плотность на единицу', () => checkPx());
it('R151 мутант без верхнего предела viewerPx обнаруживается', () => mutate(checkPx,
  'Math.min(1440, Math.max(320, px))', 'Math.max(320, px)'));

async function checkSwipe(raw = source) {
  await fixture([photo('a'), photo('b'), photo('c')], 1, async f => {
    assert.equal(position(), '2 из 3');
    assert.equal(document.querySelector('.pick-check')?.textContent, '3');
    assert.equal(document.querySelector('.pick-check')?.getAttribute('aria-pressed'), 'true');
    await React.act(async () => document.querySelector<HTMLButtonElement>('.pick-check')!.click());
    assert.deepEqual(f.toggles, ['b']);
    await f.swipe(-60); assert.equal(position(), '2 из 3', 'ровно 60 ещё не листает');
    await f.swipe(-61, 61); assert.equal(position(), '2 из 3', 'диагональ не горизонтальная');
    await f.swipe(-61); assert.equal(position(), '3 из 3');
    await f.swipe(-100); assert.equal(position(), '3 из 3');
    await React.act(async () => document.querySelector<HTMLButtonElement>('.gal-send-btn')!.click());
    assert.equal(f.sends[0].kind === 'gallery' && f.sends[0].item.id, 'c');
    await f.swipe(61); await f.swipe(61); await f.swipe(61); assert.equal(position(), '1 из 3');
    await React.act(async () => {
      const stage = document.querySelector('.pick-stage')!;
      stage.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 100 }));
      stage.dispatchEvent(new window.PointerEvent('pointercancel', { bubbles: true }));
      stage.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, clientX: 0 }));
    }); await f.settle(); assert.equal(position(), '1 из 3', 'отмена сбрасывает протяжку');
  }, raw);
}
it('R151 просмотр начинает с заданного индекса, передаёт номер/текущий элемент и листает строго после 60px', () => checkSwipe());
it('R151 мутант включённой границы 60px обнаруживается', () => mutate(checkSwipe,
  'Math.abs(dx) > SWIPE_PX', 'Math.abs(dx) >= SWIPE_PX'));
it('R151 старт за пределами зажимается, одиночный файл не имеет кружка и счётчика', async () => {
  for (const [start, expected] of [[-1, '1 из 2'], [50, '2 из 2']] as const) await fixture([photo('a'), photo('b')], start, async () => {
    assert.equal(position(), expected);
  });
  await fixture([{ kind: 'file', file: new File(['v'], 'v.mp4'), url: 'blob:camera', video: true }], 9, async f => {
    assert.equal(!!document.querySelector('.pick-check, .pick-pos'), false);
    const video = document.querySelector('video')!; assert.equal(video.getAttribute('src'), 'blob:camera');
    assert.equal(video.controls, true);
    await f.swipe(-100); assert.equal(position(), undefined);
    await React.act(async () => document.querySelector<HTMLButtonElement>('.gal-send-btn')!.click());
    assert.equal(f.sends[0].kind, 'file'); assert.equal(f.jobs.length, 0); assert.equal(f.thumbs.length, 0);
  });
});
it('R151 подпись и счётчик обновляются без смены текущего фото, занятая отправка отключена', async () => {
  await fixture([photo('a'), photo('b')], 1, async f => {
    assert.equal(document.querySelector('textarea')?.value, 'начало');
    await f.render({ caption: 'новая подпись', counter: { text: '−1', over: true }, busy: true });
    assert.equal(document.querySelector('textarea')?.value, 'новая подпись');
    assert.equal(document.querySelector('.send-count.gal.over')?.textContent, '−1');
    assert.equal(document.querySelector<HTMLButtonElement>('.gal-send-btn')?.disabled, true);
    assert.equal(position(), '2 из 2');
    assert.deepEqual(f.thumbs, ['b']);
    await f.render({ busy: false, counter: { text: '100', over: false } });
    assert.equal(document.querySelector<HTMLButtonElement>('.gal-send-btn')?.disabled, false);
    assert.equal(!!document.querySelector('.send-count.over'), false);
  });
});

async function checkFull(raw = source) {
  await fixture([photo('a'), photo('b'), photo('c', true), photo('d'), photo('e', true)], 1, async f => {
    assert.deepEqual(f.jobs.map(j => j.item.id).sort(), ['a', 'b'], 'соседнее видео не тянется заранее');
    await React.act(async () => f.jobs.forEach(j => j.resolve(new File(['full'], j.item.id)))); await f.settle();
    assert.equal(document.querySelector('img')?.getAttribute('src'), 'blob:full-b');
    await f.render({ caption: 'новая подпись', entries: [photo('a'), photo('b'), photo('c', true), photo('d'), photo('e', true)] });
    assert.deepEqual(f.thumbs, ['b'], 'смена подписи и пересборка массива не перезапускают миниатюру');
    assert.equal(f.jobs.length, 2);
    await f.swipe(-61);
    assert.equal(f.jobs.find(j => j.item.id === 'a')!.cancelled, 1);
    assert.ok(f.revoked.includes('blob:full-a'));
    assert.deepEqual(f.jobs.map(j => j.item.id).sort(), ['a', 'b', 'c', 'd']);
    await React.act(async () => f.jobs.find(j => j.item.id === 'c')!.resolve(new File(['video'], 'c'))); await f.settle();
    assert.equal(document.querySelector('video')?.getAttribute('src'), 'blob:full-c');
    assert.equal(document.querySelector('video')?.controls, true);
    await f.swipe(-61); assert.equal(f.jobs.find(j => j.item.id === 'c')!.cancelled, 1, 'видео отменяется сразу после ухода');
    assert.ok(f.revoked.includes('blob:full-c'));
    assert.equal(f.jobs.some(j => j.item.id === 'e'), false, 'соседнее тяжёлое видео не предзагружается');
    await f.unmount();
    assert.equal(f.jobs.every(j => j.cancelled === 1), true, 'каждая операция отменена ровно один раз');
    assert.ok(f.revoked.includes('blob:full-b'));
  }, raw);
}
it('R153 крупно тянутся открытое и соседние фото, видео только активное; уход отменяет и освобождает URL', () => checkFull());
it('R153 мутант предзагрузки соседнего видео обнаруживается', () => mutate(checkFull,
  "e?.kind === 'gallery' && e.item.kind === 'image'", "e?.kind === 'gallery'"));
it('R153 мутант без отмены ушедшей загрузки обнаруживается', () => mutate(checkFull,
  'job.cancel();\n      if (job.url)', 'void 0;\n      if (job.url)'));
it('R153 запоздавший полный файл не создаёт URL после отмены', async () => {
  await fixture([photo('a'), photo('b'), photo('c'), photo('d')], 0, async f => {
    const old = f.jobs[0];
    await f.swipe(-61); await f.swipe(-61);
    assert.equal(old.cancelled, 1);
    await React.act(async () => old.resolve(new File(['late'], 'late'))); await f.settle();
    assert.equal(f.made.includes('blob:full-late'), false);
  });
});
async function checkSeek(raw = source) {
  await fixture([photo('a', true), photo('b')], 0, async f => {
    await React.act(async () => f.jobs[0].resolve(new File(['v'], 'a'))); await f.settle();
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'getBoundingClientRect', { value: () => ({ bottom: 400 }) });
    await f.swipe(-100, 0, video, 337); assert.equal(position(), '1 из 2', 'нижние 64px — перемотка');
    await f.swipe(-100, 0, video, 336); assert.equal(position(), '2 из 2', 'ровно граница уже обычная протяжка');
  }, raw);
}
it('R153 перемотка по нижней полосе видео не листает галерею, выше границы листает', () => checkSeek());
it('R153 мутант без защиты перемотки обнаруживается', () => mutate(checkSeek,
  "t.tagName === 'VIDEO' && e.clientY > t.getBoundingClientRect().bottom - 64", 'false'));

const MIB = 1024 * 1024;
function videoOfSize(size: number): Viewer.PickEntry {
  const entry = photo('video', true);
  if (entry.kind === 'gallery') entry.item.size = size;
  return entry;
}
async function checkVideoThreshold(raw = source) {
  for (const size of [64 * MIB - 1, 64 * MIB]) {
    await fixture([videoOfSize(size)], 0, async f => {
      assert.equal(f.module.VIEW_AUTO_VIDEO_BYTES, 64 * MIB);
      assert.equal(f.jobs.length, 1, 'до границы включительно видео загружается само');
      assert.equal(document.querySelector('.pick-play') === null, true);
      assert.ok(document.querySelector('.pick-load'));
      await React.act(async () => f.jobs[0].resolve(new File(['v'], 'small.mp4'))); await f.settle();
      assert.equal(document.querySelector('video')?.getAttribute('src'), 'blob:full-small.mp4');
      assert.equal(document.querySelector('.pick-load, .pick-dur') === null, true);
      assert.equal(f.ready.length, 0, 'готовое видео не выдаётся как сжатое фото');
    }, raw);
  }
  await fixture([videoOfSize(64 * MIB + 1)], 0, async f => {
    assert.equal(f.jobs.length, 0, 'на один байт выше порога до нажатия мост не вызывается');
    assert.equal(document.querySelector('img')?.getAttribute('src'), 'blob:thumb-video');
    assert.equal(document.querySelector('video, .pick-load') === null, true);
    assert.equal(document.querySelector('.pick-play')?.textContent, 'Видео 64 МБ');
    assert.equal(document.querySelector('.pick-dur')?.textContent, formatDuration(7000));
    await f.render({ caption: 'не запускать загрузку' });
    assert.equal(f.jobs.length, 0);
    await React.act(async () => document.querySelector<HTMLButtonElement>('.pick-play')!.click()); await f.settle();
    assert.equal(f.jobs.length, 1);
    assert.equal(document.querySelector('.pick-play') === null, true);
  }, raw);
}
it('R154 видео до 64 МиБ включительно тянется само, выше порога ждёт нажатия поверх кадра', () => checkVideoThreshold());
it('R154 мутант строгой границы автозагрузки видео обнаруживается', () => mutate(checkVideoThreshold,
  'cur.item.size <= VIEW_AUTO_VIDEO_BYTES', 'cur.item.size < VIEW_AUTO_VIDEO_BYTES'));

async function checkLimit(raw = source) {
  await fixture([videoOfSize(301 * MIB)], 0, async f => {
    assert.equal(document.querySelector('.pick-play')?.textContent, 'Видео 301 МБ');
    await React.act(async () => document.querySelector<HTMLButtonElement>('.pick-play')!.click()); await f.settle();
    assert.equal(f.jobs[0].maxBytes, 512 * MIB, 'предел беседы, не старые 25 МиБ');
    assert.equal(typeof f.jobs[0].onBytes, 'function');
    for (const [got, expected] of [[0, ''], [75.25 * MIB, '25%'], [301 * MIB, '99%'], [602 * MIB, '99%']] as const) {
      await React.act(async () => f.jobs[0].onBytes!(got)); await f.settle();
      assert.equal(document.querySelector('.pick-load')?.textContent, expected);
    }
    await React.act(async () => f.jobs[0].resolve(null)); await f.settle();
    assert.equal(document.querySelector('.pick-load')?.textContent, 'Видео не открылось');
    assert.equal(document.querySelector('.pick-load .pick-wait, video, .pick-play') === null, true);
    assert.equal(document.querySelector('img')?.getAttribute('src'), 'blob:thumb-video');
  }, raw);
  await fixture([photo('a'), photo('b')], 0, async f => {
    assert.equal(f.jobs.length, 2);
    assert.equal(f.jobs.every(j => j.maxBytes === 512 * MIB), true, 'предел передан и соседним фото');
  }, raw);
}
it('R154 предел беседы передаётся мосту, проценты считаются по размеру, отказ заменяет ожидание подписью', () => checkLimit());
it('R154 мутант старого предела просмотра 25 МиБ обнаруживается', () => mutate(checkLimit,
  'galleryOriginal(it, maxBytes,', 'galleryOriginal(it, 25 * 1024 * 1024,'));
it('R154 мутант потерянного предела беседы обнаруживается', () => mutate(checkLimit,
  'galleryOriginal(it, maxBytes,', 'galleryOriginal(it, undefined,'));

it('R154 готовое сжатое фото выдаётся один раз, видео и отменённое фото не выдаются', async () => {
  await fixture([photo('a'), photo('b'), photo('c', true), photo('d')], 0, async f => {
    const file = new File(['compressed'], 'a.jpg', { type: 'image/jpeg' });
    await React.act(async () => f.jobs.find(j => j.item.id === 'a')!.resolve(file)); await f.settle();
    assert.equal(f.ready.length, 1);
    assert.equal(f.ready[0].item.id, 'a'); assert.equal(f.ready[0].file, file);
    await f.render({ caption: 'другая подпись', entries: [photo('a'), photo('b'), photo('c', true), photo('d')] });
    assert.equal(f.ready.length, 1, 'перерисовка не выдаёт файл повторно');
    const pendingB = f.jobs.find(j => j.item.id === 'b')!;
    await f.swipe(-61); await f.swipe(-61); await f.swipe(-61);
    assert.equal(pendingB.cancelled, 1);
    await React.act(async () => {
      pendingB.resolve(new File(['late'], 'b.jpg'));
      f.jobs.find(j => j.item.id === 'c')!.resolve(new File(['video'], 'c.mp4'));
    }); await f.settle();
    assert.equal(f.ready.length, 1, 'запоздавшие результаты ушедших элементов игнорируются');
    await React.act(async () => f.jobs.find(j => j.item.id === 'd')!.resolve(null)); await f.settle();
    assert.equal(f.ready.length, 1, 'неполученное фото не попадает в кеш отправки');
  });
});
