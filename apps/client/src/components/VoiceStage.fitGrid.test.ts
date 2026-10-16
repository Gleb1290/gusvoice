import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { fitStageGrid, stageAvatarSize, STAGE_SCROLLBAR_PX, STAGE_GRID_HYSTERESIS_PX, type StageGridInput } from '../stageGridRules';
import * as stageOrderRules from '../stageOrderRules';

const source = readFileSync(new URL('./VoiceChannelView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Geometry = { width: number; height: number; clientWidth: number; zoom: number; padding: number; border: number };
type ProbeProps = { count: number; enabled: boolean };

// Исполняем весь производственный модуль, а не извлечённое тело хука. Единственный дополнительный
// export открывает приватный хук; React, его эффекты и чистый расчёт сетки остаются настоящими.
async function fixture(check: (f: {
  host: HTMLDivElement; geometry: Geometry; calls: StageGridInput[];
  resize(): Promise<void>; render(props: Partial<ProbeProps>): Promise<void>;
  observers: { disconnected: boolean; targets: Element[] }[];
}) => Promise<void>, raw = source, initial: Partial<ProbeProps> = {}) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const geometry: Geometry = { width: 280, height: 450, clientWidth: 280, zoom: 1, padding: 0, border: 0 };
  const calls: StageGridInput[] = [];
  const observers: FakeObserver[] = [];
  class FakeObserver {
    disconnected = false;
    targets: Element[] = [];
    constructor(readonly callback: () => void) { observers.push(this); }
    observe(el: Element) { this.targets.push(el); }
    disconnect() { this.disconnected = true; }
  }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let props: ProbeProps = { count: 8, enabled: true, ...initial };
  const module = { exports: {} as { useFitGrid: (count: number, enabled: boolean) => {
    ref: React.RefObject<HTMLDivElement>; layout: ReturnType<typeof fitStageGrid> | null; fits: boolean;
  } } };
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    '../stageOrderRules': stageOrderRules,
    '../stageOrderPrefs': { useStageOrder: () => null, saveStageOrder: () => {},
      useHasStageOrder: () => false, resetStageOrder: () => {} },
    '../useStageDrag': { useStageDrag: () => ({ preview: null, dragging: false,
      nestRef: { current: null }, onPointerDown: () => {} }) },
    '../stageGridRules': { stageAvatarSize, STAGE_SCROLLBAR_PX, STAGE_GRID_HYSTERESIS_PX, fitStageGrid: (input: StageGridInput) => {
      calls.push({ ...input }); return fitStageGrid(input);
    } },
  };
  try {
    runInNewContext(ts.transpileModule(raw + '\nexport { useFitGrid };', { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
    } }).outputText, { module, exports: module.exports, window, document, console,
      ResizeObserver: FakeObserver,
      getComputedStyle: () => ({ paddingLeft: String(geometry.padding), paddingRight: String(geometry.padding),
        paddingTop: String(geometry.padding), paddingBottom: String(geometry.padding),
        borderLeftWidth: String(geometry.border), borderRightWidth: String(geometry.border),
        borderTopWidth: String(geometry.border), borderBottomWidth: String(geometry.border),
        columnGap: '12px', zoom: String(geometry.zoom) }),
      require: (id: string) => deps[id] ?? {},
    });
    function Probe(p: ProbeProps) {
      const { ref, layout, fits } = module.exports.useFitGrid(p.count, p.enabled);
      const attach = React.useCallback((el: HTMLDivElement | null) => {
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
        if (!el) return;
        Object.defineProperties(el, {
          clientWidth: { configurable: true, get: () => geometry.clientWidth },
          clientHeight: { configurable: true, get: () => geometry.height },
          offsetWidth: { configurable: true, get: () => geometry.width / geometry.zoom },
          offsetHeight: { configurable: true, get: () => geometry.height / geometry.zoom },
        });
        el.getBoundingClientRect = () => ({ width: geometry.width, height: geometry.height,
          x: 0, y: 0, top: 0, left: 0, right: geometry.width, bottom: geometry.height, toJSON: () => ({}) });
      }, [ref]);
      return React.createElement('div', { ref: attach, 'data-cols': layout?.cols ?? '',
        'data-tile-width': layout?.tileW ?? '', 'data-tile-height': layout?.tileH ?? '', 'data-fits': String(fits) });
    }
    const render = async (next: Partial<ProbeProps>) => {
      props = { ...props, ...next };
      await React.act(async () => { root.render(React.createElement(Probe, props)); });
    };
    const resize = async () => {
      await React.act(async () => { for (const observer of observers) if (!observer.disconnected) observer.callback(); });
    };
    await render({}); await check({ host, geometry, calls, resize, render, observers });
  } finally {
    await React.act(async () => root.unmount());
    assert.equal(observers.every(observer => observer.disconnected), true, 'размонтирование снимает все наблюдатели');
    host.remove(); await GlobalRegistrator.unregister();
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}

const last = (calls: StageGridInput[]) => calls[calls.length - 1]!;
async function scrollbar(raw = source) {
  await fixture(async ({ host, geometry, calls, resize }) => {
    const cols = host.firstElementChild!.getAttribute('data-cols');
    const tile = host.firstElementChild!.getAttribute('data-tile-width');
    assert.notEqual(cols, '');
    assert.equal(last(calls).width, 267, 'rect 280 минус постоянные 12 полосы и 1 округления');
    assert.equal(last(calls).height, 449);
    for (let frame = 0; frame < 20; frame++) {
      geometry.clientWidth = frame % 2 ? 280 : 268;
      await resize();
      assert.equal(host.firstElementChild!.getAttribute('data-cols'), cols);
      assert.equal(host.firstElementChild!.getAttribute('data-tile-width'), tile);
      assert.equal(last(calls).width, 267, 'измерение не зависит от собственной полосы');
    }
  }, raw);
}
it('R164 неподвижный внешний rect и двадцать колебаний clientWidth на 12px не меняют сетку', () => scrollbar());

it('R164 возврат clientWidth вместо внешнего rect обнаруживается реальным измерением', async () => {
  const anchor = 'rect.width / zoom';
  assert.equal(source.split(anchor).length - 1, 1);
  await scrollbar();
  await assert.rejects(() => scrollbar(source.replace(anchor, 'el.clientWidth / zoom')), assert.AssertionError);
});

it('R164 реальное увеличение внешнего контейнера меняет размер плитки и число колонок', () => fixture(async ({ host, geometry, resize }) => {
  const before = host.firstElementChild!.getAttribute('data-cols');
  geometry.width = 1200; geometry.clientWidth = 1200; geometry.height = 800;
  await resize();
  assert.notEqual(host.firstElementChild!.getAttribute('data-cols'), before);
  assert.ok(Number(host.firstElementChild!.getAttribute('data-tile-width')) > 112);
}));

it('R164 масштаб CSS, рамки и поля исключаются из внешнего rect до расчёта', () => fixture(async ({ geometry, calls, resize }) => {
  geometry.width = 625; geometry.height = 500; geometry.zoom = 1.25;
  geometry.padding = 10; geometry.border = 2; await resize();
  assert.equal(last(calls).width, 463); // 625 / 1.25 - 20 - 4 - 12 - 1
  assert.equal(last(calls).height, 375); // 500 / 1.25 - 20 - 4 - 1
  assert.equal(last(calls).gap, 12);
}));

it('R164 выключенный хук не измеряет сетку; включение наблюдает, выключение снимает observer', () => fixture(async ({ host, calls, observers, render, resize }) => {
  assert.equal(calls.length, 0); assert.equal(observers.length, 0);
  assert.equal(host.firstElementChild!.getAttribute('data-cols'), '');
  await render({ enabled: true });
  assert.ok(calls.length > 0); assert.equal(observers.length, 1);
  assert.equal(observers[0].targets.length, 1);
  await render({ enabled: false });
  assert.equal(observers[0].disconnected, true);
  const n = calls.length; await resize(); assert.equal(calls.length, n);
  assert.equal(host.firstElementChild!.getAttribute('data-cols'), '');
}, source, { enabled: false }));

it('R164 история колонок передаётся только прежнему числу плиток и сбрасывается при новом составе', () => fixture(async ({ host, geometry, calls, resize, render }) => {
  assert.equal(calls[0].prevCols, undefined);
  assert.equal(last(calls).hysteresisPx, 16);
  const oldCols = Number(host.firstElementChild!.getAttribute('data-cols'));
  geometry.width += 1; await resize();
  assert.equal(last(calls).prevCols, oldCols);
  await render({ count: 11 });
  assert.equal(last(calls).count, 11); assert.equal(last(calls).prevCols, undefined);
  const newCols = Number(host.firstElementChild!.getAttribute('data-cols'));
  geometry.width += 1; await resize();
  assert.equal(last(calls).prevCols, newCols);
  await render({ enabled: false }); await render({ enabled: true });
  assert.equal(last(calls).prevCols, undefined, 'повторное открытие сцены не наследует старые колонки');
}));

it('R164 fits меняется только при фактической нехватке высоты и возвращается после расширения', () => fixture(async ({ host, geometry, resize }) => {
  assert.equal(host.firstElementChild!.getAttribute('data-fits'), 'true');
  geometry.height = 80; await resize();
  assert.equal(host.firstElementChild!.getAttribute('data-fits'), 'false');
  geometry.height = 800; await resize();
  assert.equal(host.firstElementChild!.getAttribute('data-fits'), 'true');
}));
