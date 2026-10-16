import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as rules from '../recordBlob';
import type { RecordCircle } from './RecordBlob';

const source = readFileSync(new URL('./RecordBlob.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const liteSource = readFileSync(new URL('../liteMode.ts', import.meta.url), 'utf8');
type Props = Parameters<typeof RecordCircle>[0];
type Fixture = {
  host: HTMLElement; raf: Map<number, (now: number) => void>; requests(): number; cancels: number[];
  contexts(): number; paints(): number; frame(now: number): Promise<void>; render(props?: Partial<Props>): Promise<void>;
  lite(value: boolean): Promise<void>; unmount(): Promise<void>;
};
function load<T>(raw: string, deps: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, window, document, localStorage, ...globals,
    require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `описана граница ${id}`); return deps[id]; },
  });
  return module.exports as T;
}
async function fixture(check: (f: Fixture) => Promise<void>, options: {
  hold?: boolean; lite?: boolean; reduced?: boolean; matchThrows?: boolean; dpr?: number;
} = {}, raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const raf = new Map<number, (now: number) => void>(); const cancels: number[] = [];
  let n = 0, now = 0, contexts = 0, paints = 0, mounted = true;
  const coordinates = (...values: number[]) => { for (const value of values) assert.equal(Number.isFinite(value), true, 'холст получает конечные координаты'); };
  const ctx = { globalAlpha: 1, fillStyle: '', setTransform: coordinates, clearRect: coordinates,
    beginPath() {}, closePath() {}, moveTo: coordinates, bezierCurveTo: coordinates, arc: coordinates, fill: () => { paints++; } };
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => { contexts++; return ctx; } });
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: options.dpr ?? 2 });
  window.matchMedia = ((query: string) => {
    if (options.matchThrows) throw new Error('fixture: matchMedia недоступен');
    return { matches: query === '(prefers-reduced-motion: reduce)' && !!options.reduced };
  }) as typeof window.matchMedia;
  let props: Props = { hold: options.hold ?? true, level: 0.5, slide: 0, recording: false, recBusy: false };
  const lite = load<typeof import('../liteMode')>(liteSource, { react: React });
  lite.setLiteModeEnabled(!!options.lite);
  const component = load<typeof import('./RecordBlob')>(raw, {
    react: React, 'react/jsx-runtime': jsx, '../liteMode': lite, '../recordBlob': rules,
  }, { performance: { now: () => now }, getComputedStyle: () => ({ color: '#445566' }),
    requestAnimationFrame: (fn: (now: number) => void) => { raf.set(++n, fn); return n; },
    cancelAnimationFrame: (id: number) => { cancels.push(id); raf.delete(id); },
  });
  const render = async (patch: Partial<Props> = {}) => {
    props = { ...props, ...patch };
    await React.act(async () => root.render(React.createElement(component.RecordCircle, props)));
  };
  const unmount = async () => { if (mounted) { mounted = false; await React.act(async () => root.unmount()); } };
  try {
    await render();
    await check({ host, raf, cancels, requests: () => n, contexts: () => contexts, paints: () => paints, render, unmount,
      lite: async value => { await React.act(async () => lite.setLiteModeEnabled(value)); },
      frame: async time => {
        assert.equal(raf.size, 1, 'одна ожидающая итерация холста');
        const [id, callback] = [...raf][0]; raf.delete(id); now = time;
        await React.act(async () => { callback(time); });
      },
    });
  } finally {
    try { await unmount(); } finally {
      host.remove(); await GlobalRegistrator.unregister();
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  }
}
// Класс ошибки: уже законченная запись оставляет декоративный холст и вечный rAF.
it('R176 без удержания и ещё не начавшегося ухода круг отсутствует и rAF не запрашивается', () => fixture(async f => {
  assert.equal(f.host.childElementCount, 0); assert.equal(f.raf.size, 0); assert.equal(f.requests(), 0); assert.equal(f.contexts(), 0);
}, { hold: false }));
// Класс ошибки: canvas не подключён к математике либо запускаются параллельные циклы вместо одного.
it('R176 удержание рисует настоящий холст, единственный цикл и размеры с DPR до трёх', async () => {
  for (const [dpr, pixels] of [[2, 544], [3, 816], [4, 816]]) await fixture(async f => {
    const canvas = f.host.querySelector<HTMLCanvasElement>('canvas.rec-blob'); assert.ok(!!canvas);
    assert.equal(canvas.width, pixels); assert.equal(canvas.height, pixels); assert.equal(f.contexts(), 1);
    assert.equal(f.raf.size, 1); await f.frame(300);
    assert.equal(f.paints() > 0, true); assert.equal(f.raf.size, 1); assert.equal(f.requests(), 2);
  }, { dpr });
});
async function completed(raw = source) {
  for (const [recording, recBusy, duration] of [[false, true, 360], [false, false, 200], [true, true, 200]] as const)
    await fixture(async f => {
      await f.frame(300); await f.render({ hold: false, recording, recBusy });
      assert.equal(!!f.host.querySelector('canvas.rec-blob'), true, 'уход ещё виден после конца удержания');
      await f.frame(316); await f.frame(316 + duration - 1);
      assert.equal(!!f.host.querySelector('canvas.rec-blob'), true, 'за миллисекунду до конца ещё не снят');
      const requested = f.requests(); await f.frame(316 + duration);
      assert.equal(f.host.childElementCount, 0, 'onDone снимает закончившийся холст');
      assert.equal(f.requests(), requested, 'завершённый уход не планирует следующий rAF');
      assert.equal(f.raf.size, 0); assert.equal(f.cancels.length > 0, true);
      await f.render(); assert.equal(f.requests(), requested, 'следующий render idle не перезапускает цикл');
    }, {}, raw);
}
// Класс ошибки: окончание send/cancel/lock не снимает холст либо цикл возобновляется после onDone.
it('R176 отправка 360, отмена и замок 200 доигрывают уход и полностью останавливают rAF', () => completed());
// Класс ошибки: новый холст не запускается для следующего удержания или смешивается с предыдущей сессией.
it('R176 следующее удержание после завершения создаёт один новый холст', () => fixture(async f => {
  await f.frame(300); await f.render({ hold: false }); await f.frame(316); await f.frame(516);
  assert.equal(f.raf.size, 0); const before = f.requests();
  await f.render({ hold: true, recBusy: false });
  assert.equal(!!f.host.querySelector('canvas.rec-blob'), true); assert.equal(f.raf.size, 1); assert.equal(f.requests(), before + 1);
}));
// Класс ошибки: запрос меньше движения игнорируется либо lite вытесняет его и продолжает анимацию.
it('R176 reduced-motion даёт неподвижный круг без canvas, имеет приоритет над gv-lite', async () => {
  for (const lite of [false, true]) await fixture(async f => {
    assert.equal(!!f.host.querySelector('.rec-circle.static'), true); assert.equal(!!f.host.querySelector('.rec-circle.lite'), false);
    assert.equal(!!f.host.querySelector('canvas'), false); assert.equal(f.contexts(), 0); assert.equal(f.requests(), 0);
    assert.equal(f.host.querySelector<HTMLElement>('.rec-circle')?.style.getPropertyValue('--lvl'), '0');
    await f.render({ hold: false, recording: true }); assert.equal(f.host.childElementCount, 0);
  }, { reduced: true, lite });
});
// Класс ошибки: оптимизированный режим выключает анимацию лишь CSS, но дорогой холст продолжает рисоваться.
it('R176 настоящий gv-lite даёт лёгкий круг с уровнем без canvas и сразу скрывает его после удержания', () => fixture(async f => {
  assert.equal(document.documentElement.classList.contains('gv-lite'), true);
  assert.equal(!!f.host.querySelector('.rec-circle.lite'), true); assert.equal(!!f.host.querySelector('canvas'), false);
  assert.equal(f.host.querySelector<HTMLElement>('.rec-circle')?.style.getPropertyValue('--lvl'), '0.5');
  assert.equal(f.contexts(), 0); assert.equal(f.requests(), 0);
  await f.render({ hold: false, recBusy: true }); assert.equal(f.host.childElementCount, 0);
}, { lite: true }));
// Класс ошибки: смена настройки lite во время записи оставляет старый rAF под лёгким кругом.
it('R176 включение gv-lite в ходе удержания снимает canvas и отменяет ожидающий кадр', () => fixture(async f => {
  assert.equal(f.raf.size, 1); await f.lite(true);
  assert.equal(!!f.host.querySelector('.rec-circle.lite'), true); assert.equal(!!f.host.querySelector('canvas'), false);
  assert.equal(f.raf.size, 0); assert.equal(f.cancels.length, 1);
}));
// Класс ошибки: неподдерживаемый matchMedia роняет запись вместо обычного режима холста.
it('R176 недоступный matchMedia не ломает обычное удержание', () => fixture(async f => {
  assert.equal(!!f.host.querySelector('canvas.rec-blob'), true); assert.equal(f.raf.size, 1);
}, { matchThrows: true }));
// Класс ошибки: размонтированный холст оставляет callback, удерживающий DOM и будящий CPU.
it('R176 размонтирование активной записи отменяет единственный ожидающий кадр', () => fixture(async f => {
  assert.equal(f.raf.size, 1); await f.unmount();
  assert.equal(f.raf.size, 0); assert.equal(f.cancels.length, 1);
}));
// Класс ошибки: контрфакт продолжает цикл после onDone даже если cleanup потом отменит лишний кадр.
it('R176 мутант rAF после onDone обнаруживается по числу запросов, не только отсутствию canvas', async () => {
  await completed();
  const anchor = 'if (st.exit && t >= 1) {\n        st.onDone();\n        return;\n      }';
  assert.equal(source.split(anchor).length - 1, 1, 'единственная граница окончания ухода');
  await assert.rejects(() => completed(source.replace(anchor, anchor.replace('        return;\n', ''))),
    e => e instanceof assert.AssertionError && e.message.includes('завершённый уход не планирует'));
});
