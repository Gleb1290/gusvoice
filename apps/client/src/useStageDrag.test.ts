import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as rules from './stageOrderRules';
import { STAGE_DRAG_HINT_MS, STAGE_DRAG_HOLD_MS, STAGE_DRAG_SLOP_PX, type useStageDrag } from './useStageDrag';

const source = readFileSync(new URL('./useStageDrag.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
class Clock {
  now = 0; next = 1;
  pending = new Map<number, { at: number; fn: () => void }>();
  frames = new Set<number>();
  setTimeout = (fn: () => void, ms = 0) => { const id = this.next++; this.pending.set(id, { at: this.now + ms, fn }); return id; };
  clearTimeout = (id: number) => { this.pending.delete(id); };
  requestAnimationFrame = (fn: () => void) => {
    const id = this.setTimeout(() => { this.frames.delete(id); fn(); }, 1);
    this.frames.add(id); return id;
  };
  cancelAnimationFrame = (id: number) => { this.frames.delete(id); this.clearTimeout(id); };
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].at; this.pending.delete(next[0]); next[1].fn();
    }
    this.now = end;
  }
}
type Fixture = {
  grid: HTMLDivElement; clock: Clock; commits: string[][];
  tile(key?: string): HTMLElement; state(): ReturnType<typeof useStageDrag>;
  render(next?: { enabled?: boolean; keys?: string[] }): Promise<void>;
  down(options?: { key?: string; button?: number; pointerType?: string; control?: boolean; clientX?: number; clientY?: number }): Promise<void>;
  event(type: string, init?: Record<string, unknown>): Promise<Event>;
  scroll(left: number, top: number): Promise<void>;
  content(width: number, height: number): void;
  advance(ms: number): Promise<void>; click(): boolean; clicks(): number;
};
async function fixture(check: (f: Fixture) => Promise<void>, raw = source,
  options: { tileTag?: 'div' | 'button'; zoom?: number; gridHeight?: number; tileTop?: number; columns?: number;
    scrollWidth?: number; scrollHeight?: number } = {}) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const clock = new Clock();
  const module = { exports: {} as { useStageDrag: typeof useStageDrag } };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const fakeWindow = {
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    requestAnimationFrame: clock.requestAnimationFrame, cancelAnimationFrame: clock.cancelAnimationFrame,
    addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
    matchMedia: () => ({ matches: false }), getSelection: window.getSelection.bind(window), innerWidth: 1000, innerHeight: 800,
  };
  let enabled = true; let keys = ['a', 'b', 'c']; let state!: ReturnType<typeof useStageDrag>;
  const commits: string[][] = []; const gridRef = React.createRef<HTMLDivElement>(); let clickCount = 0;
  let scrollWidth = options.scrollWidth ?? 330; let scrollHeight = options.scrollHeight ?? options.gridHeight ?? 100;
  const deps: Record<string, unknown> = { react: React, './stageOrderRules': rules };
  function Tile({ id }: { id: string }) {
    return React.createElement(options.tileTag ?? 'div', { 'data-stage-key': id, onClick: () => { clickCount++; }, ref: (el: HTMLElement | null) => {
      if (!el) return;
      let lastIndex = 0;
      const index = (): number => {
        // Снятая React плитка ещё участвует в отмене/снимке FLIP. Сохраняем последнюю измеренную
        // ячейку: геометрия тестового DOM не должна бросать раньше проверки реальной отмены.
        // До первого измерения используется нулевая ячейка; detached-узел не становится drop-целью.
        const parent = el.parentElement;
        if (parent) {
          const current = Array.from(parent.querySelectorAll(':scope > [data-stage-key]')).indexOf(el);
          if (current >= 0) lastIndex = current;
        }
        return lastIndex;
      };
      const left = () => (options.columns ? index() % options.columns : index()) * 110;
      const top = () => (options.tileTop ?? 0) + (options.columns ? Math.floor(index() / options.columns) * 90 : 0);
      const geometry: Record<string, () => number> = { offsetLeft: left, offsetTop: top, offsetWidth: () => 100, offsetHeight: () => 80 };
      for (const [name, getter] of Object.entries(geometry))
        Object.defineProperty(el, name, { configurable: true, get: getter });
      const zoom = options.zoom ?? 1;
      el.getBoundingClientRect = () => {
        const x = (left() - (gridRef.current?.scrollLeft ?? 0)) * zoom;
        const y = (top() - (gridRef.current?.scrollTop ?? 0)) * zoom;
        return { x, y, left: x, top: y, right: x + 100 * zoom, bottom: y + 80 * zoom, width: 100 * zoom, height: 80 * zoom, toJSON() {} };
      };
    } }, React.createElement('video', { 'data-video': id }),
    options.tileTag === 'button' ? React.createElement('span', null, 'смотреть') : React.createElement('button', null, 'смотреть'));
  }
  function Probe() {
    state = module.exports.useStageDrag({ enabled, gridRef, order: keys, onCommit: order => commits.push(Array.from(order)) });
    return React.createElement('div', { ref: gridRef, onPointerDown: state.onPointerDown },
      ...(state.preview ?? keys).filter(k => keys.includes(k)).map(id => React.createElement(Tile, { key: id, id })),
      React.createElement('div', { ref: state.nestRef, 'data-nest': '1' }));
  }
  const render = async (next: { enabled?: boolean; keys?: string[] } = {}) => {
    if (next.enabled !== undefined) enabled = next.enabled; if (next.keys) keys = next.keys;
    await React.act(async () => root.render(React.createElement(Probe)));
  };
  try {
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, window: fakeWindow, getComputedStyle: window.getComputedStyle.bind(window),
        require: (id: string) => { if (!Object.hasOwn(deps, id)) throw Error(`Неизвестный импорт ${id}`); return deps[id]; } });
    await render(); const grid = gridRef.current!;
    for (const name of ['offsetWidth', 'clientWidth']) Object.defineProperty(grid, name, { configurable: true, get: () => 330 });
    Object.defineProperty(grid, 'clientHeight', { configurable: true, get: () => options.gridHeight ?? 100 });
    Object.defineProperty(grid, 'scrollWidth', { configurable: true, get: () => scrollWidth });
    Object.defineProperty(grid, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    const zoom = options.zoom ?? 1;
    const height = options.gridHeight ?? 100;
    grid.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 330 * zoom, bottom: height * zoom, width: 330 * zoom, height: height * zoom, toJSON() {} });
    const tile = (key = 'a') => grid.querySelector<HTMLElement>(`[data-stage-key="${key}"]`)!;
    const dispatch = async (target: EventTarget, type: string, init: Record<string, unknown> = {}) => {
      const event = type === 'keydown' ? new window.KeyboardEvent(type, { key: 'Escape', bubbles: true, cancelable: true, ...init })
        : new window.PointerEvent(type, { pointerId: 7, pointerType: 'mouse', button: 0, clientX: 50, clientY: 40, bubbles: true, cancelable: true, ...init });
      await React.act(async () => { target.dispatchEvent(event); }); return event;
    };
    await check({ grid, clock, commits, tile, state: () => state, render,
      down: async (o = {}) => { const el = tile(o.key); await dispatch(o.control ? el.querySelector('button')! : el, 'pointerdown', { clientX: 50 * zoom, clientY: 40 * zoom, ...o }); },
      event: (type, init) => dispatch(window, type, init),
      scroll: async (left, top) => {
        await React.act(async () => {
          grid.scrollLeft = left; grid.scrollTop = top;
          grid.dispatchEvent(new window.Event('scroll'));
        });
      },
      // Не ограничиваем scrollTop/Left тестовым setter: именно хук обязан соблюдать снятый предел.
      content: (width, height) => { scrollWidth = width; scrollHeight = height; },
      advance: async ms => { await React.act(async () => clock.advance(ms)); },
      click: () => tile().dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })),
      clicks: () => clickCount,
    });
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally {
      host.remove();
      try { await GlobalRegistrator.unregister(); }
      finally {
        if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      }
    }
  }
}
async function hold(raw = source) {
  assert.equal(STAGE_DRAG_HINT_MS, 150); assert.equal(STAGE_DRAG_HOLD_MS, 500);
  await fixture(async f => {
    await f.down(); await f.advance(STAGE_DRAG_HINT_MS - 1); assert.equal(f.tile().dataset.drag, undefined);
    await f.advance(1); assert.equal(f.tile().dataset.drag, 'pressing');
    await f.advance(STAGE_DRAG_HOLD_MS - STAGE_DRAG_HINT_MS - 1); assert.equal(f.state().dragging, false);
    await f.advance(1); assert.equal(f.state().dragging, true); assert.equal(f.tile().dataset.drag, 'lifted');
    assert.equal(f.grid.dataset.dragging, '1'); assert.match(f.tile().style.transform, /scale\(1\.06\)/);
  }, raw);
}
// Класс ошибки: мгновенный подъём или неверная граница таймеров.
it('R246 подсказка ровно через 150, подъём через 500, до 499 подъёма нет', () => hold());
// Класс ошибки: отмена допустимого дрожания или подъём после движения.
async function slop(raw = source) {
  assert.equal(STAGE_DRAG_SLOP_PX, 16);
  for (const [dx, dy, lifted] of [[16, 0, true], [0, -16, true], [16.01, 0, false], [0, -16.01, false], [12, 12, false]] as const) {
    await fixture(async f => {
      await f.down(); await f.advance(STAGE_DRAG_HINT_MS);
      await f.event('pointermove', { clientX: 50 + dx, clientY: 40 + dy });
      await f.advance(STAGE_DRAG_HOLD_MS - STAGE_DRAG_HINT_MS);
      assert.equal(f.state().dragging, lifted, `R246 slop: радиальный сдвиг (${dx},${dy})`);
      assert.equal(f.tile().dataset.drag, lifted ? 'lifted' : undefined);
      if (!lifted) { assert.equal(f.commits.length, 0); assert.equal(f.click(), true); }
    }, raw);
  }
}
it('R246 радиальный сдвиг ровно 16 разрешён, 16,01 и диагональ 12×12 отменяют удержание', () => slop());
async function types(raw = source) {
  for (const options of [{ button: 2 }, { pointerType: 'touch' }, { control: true }]) await fixture(async f => {
    await f.down(options); await f.advance(STAGE_DRAG_HOLD_MS); assert.equal(f.state().dragging, false); assert.equal(f.tile().dataset.drag, undefined);
  }, raw);
  await fixture(async f => { await f.down({ pointerType: 'pen' }); await f.advance(STAGE_DRAG_HOLD_MS); assert.equal(f.state().dragging, true); }, raw);
}
// Класс ошибки: перехват контекстного меню, касания или кнопки плитки.
it('R169 мышь и перо принимаются, правая кнопка касание и вложенная кнопка не запускают жест', () => types());
async function previewCommit(raw = source) {
  await fixture(async f => {
    const video = f.tile().querySelector('video'); await f.down(); await f.advance(STAGE_DRAG_HOLD_MS);
    await f.event('pointermove', { clientX: 160 }); await f.advance(1); await f.advance(99);
    assert.equal(f.state().preview, null); await f.advance(1);
    assert.equal(f.state().preview?.join(','), 'b,a,c');
    assert.equal(Array.from(f.grid.querySelectorAll('[data-stage-key]')).map(el => (el as HTMLElement).dataset.stageKey).join(','), 'b,a,c');
    assert.equal(f.tile().querySelector('video') === video, true, 'video не перемонтирован');
    await f.event('pointerup'); assert.equal(f.commits.length, 1); assert.equal(f.commits[0].join(','), 'b,a,c');
    assert.equal(f.state().dragging, false); assert.equal(f.state().preview, null);
    assert.equal(f.tile().querySelector('video') === video, true, 'посадка тоже не перемонтирует video');
    assert.equal(f.click(), false); await f.advance(240); assert.equal(f.click(), true);
    assert.equal(f.tile().dataset.drag, undefined);
  }, raw);
}
// Класс ошибки: ранняя перестановка, запись старого порядка или remount видео.
it('R169 наведение 99 ещё не меняет порядок, 100 меняет DOM, отпускание записывает DOM без remount видео', () => previewCommit());
async function escape(raw = source) {
  await fixture(async f => {
    await f.down(); await f.advance(STAGE_DRAG_HOLD_MS); const event = await f.event('keydown');
    assert.equal(event.defaultPrevented, true); assert.equal(f.state().dragging, false); assert.equal(f.commits.length, 0);
    assert.equal(f.click(), false); await f.event('pointerup'); await f.advance(0); assert.equal(f.click(), true);
  }, raw);
}
// Класс ошибки: Esc сохраняет вместо отката или пропускает клик под отменённой плиткой.
it('R169 Escape отменяет поднятую плитку без записи и глотает клик до отпускания', () => escape());
// Класс ошибки: внешняя отмена записывает несанкционированную перестановку.
it('R169 blur, pointercancel и выход за окно отменяют поднятую плитку без записи', async () => {
  for (const [type, init] of [['blur', {}], ['pointercancel', {}], ['pointermove', { clientX: -1 }], ['pointermove', { clientX: 1000 }], ['pointermove', { clientY: 800 }]] as const)
    await fixture(async f => { await f.down(); await f.advance(STAGE_DRAG_HOLD_MS); await f.event(type, init); assert.equal(f.state().dragging, false); assert.equal(f.commits.length, 0); await f.advance(3000); assert.equal(f.commits.length, 0); });
});
// Класс ошибки: отключённая сетка или ушедшая плитка оставляет активную сессию.
it('R169 отключение и исчезновение плитки отменяют hold и drag без записи', async () => {
  for (const ms of [STAGE_DRAG_HINT_MS, STAGE_DRAG_HOLD_MS]) for (const next of [{ enabled: false }, { keys: ['b', 'c'] }])
    await fixture(async f => { await f.down(); await f.advance(ms); await f.render(next); await f.advance(3000); assert.equal(f.state().dragging, false); assert.equal(f.commits.length, 0); });
});
// Класс ошибки: обычный короткий клик поглощается обработчиком перетаскивания.
it('R169 короткое отпускание и отмена до подъёма не глотают обычный клик', async () => {
  for (const type of ['pointerup', 'pointercancel', 'keydown', 'blur']) await fixture(async f => {
    await f.down(); await f.advance(STAGE_DRAG_HINT_MS); await f.event(type); await f.advance(3000);
    assert.equal(f.state().dragging, false); assert.equal(f.commits.length, 0); assert.equal(f.click(), true);
  });
});
// Класс ошибки: чужой pointer отменяет или завершает наш жест.
it('R169 события чужого указателя не меняют текущую сессию', () => fixture(async f => {
  await f.down(); await f.event('pointermove', { pointerId: 8, clientX: -1 }); await f.advance(STAGE_DRAG_HOLD_MS);
  await f.event('pointerup', { pointerId: 8 }); await f.event('pointercancel', { pointerId: 8 });
  assert.equal(f.state().dragging, true); assert.equal(f.commits.length, 0); await f.event('pointerup'); assert.equal(f.commits.length, 1);
}));
// Класс ошибки: случайный пролёт или смена цели завершает старый dwell.
it('R169 уход центра в зазор отменяет наведение, новая ячейка требует свои 100 миллисекунд', () => fixture(async f => {
  await f.down(); await f.advance(STAGE_DRAG_HOLD_MS); await f.event('pointermove', { clientX: 160 }); await f.advance(50);
  await f.event('pointermove', { clientX: 105 }); await f.advance(100); assert.equal(f.state().preview, null);
  await f.event('pointermove', { clientX: 270 }); await f.advance(1); await f.advance(99); assert.equal(f.state().preview, null);
  await f.advance(1); assert.equal(f.state().preview?.join(','), 'b,c,a');
}));
// Класс ошибки: отключённый режим принимает начало жеста.
it('R169 enabled false не запускает даже подсказку удержания', () => fixture(async f => {
  await f.render({ enabled: false }); await f.down(); await f.advance(3000); assert.equal(f.tile().dataset.drag, undefined); assert.equal(f.state().dragging, false);
}));
// Класс ошибки: делегирование ловит гнездо или вложенную чужую плитку.
it('R169 указатель на пустом месте сетки или вложенном чужом ключе не запускает drag', () => fixture(async f => {
  const nested = document.createElement('div'); nested.dataset.stageKey = 'nested'; f.tile().append(nested);
  for (const target of [f.grid, nested]) {
    await React.act(async () => { target.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, clientX: 50, clientY: 40 })); });
    await f.advance(STAGE_DRAG_HOLD_MS); assert.equal(f.state().dragging, false);
  }
}));
// Класс ошибки: второе pointerdown подменяет уже удерживаемую плитку.
it('R169 повторное начало не заменяет активную плитку, посторонняя клавиша не отменяет drag', () => fixture(async f => {
  await f.down(); await f.advance(STAGE_DRAG_HOLD_MS / 2); await f.down({ key: 'b' }); await f.advance(STAGE_DRAG_HOLD_MS / 2);
  assert.equal(f.tile('a').dataset.drag, 'lifted'); assert.equal(f.tile('b').dataset.drag, undefined);
  await f.event('keydown', { key: 'Enter' }); assert.equal(f.state().dragging, true);
}));
// Класс ошибки: браузерное выделение/перенос аватара конкурирует с жестом.
it('R169 родное выделение и dragstart блокируются только пока идёт сессия', () => fixture(async f => {
  await f.down();
  for (const type of ['dragstart', 'selectstart']) {
    const event = new window.Event(type, { bubbles: true, cancelable: true }); window.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  }
  await f.event('pointerup');
  const event = new window.Event('dragstart', { cancelable: true }); window.dispatchEvent(event); assert.equal(event.defaultPrevented, false);
}));
// Класс ошибки: движение по собственной ячейке запускает ненужную перестановку.
it('R169 собственная ячейка и повторное движение по той же цели не ускоряют dwell', () => fixture(async f => {
  await f.down(); await f.advance(STAGE_DRAG_HOLD_MS); await f.event('pointermove', { clientX: 51 }); await f.advance(150); assert.equal(f.state().preview, null);
  await f.event('pointermove', { clientX: 160 }); await f.advance(51);
  await f.event('pointermove', { clientX: 161 }); await f.advance(49); assert.equal(f.state().preview, null);
  await f.advance(1); assert.equal(f.state().preview?.join(','), 'b,a,c');
}));
// Класс ошибки: корневая кнопка карточки показа ошибочно считается вложенным управлением.
it('R169 корневой BUTTON карточки показа поднимается, вложенная кнопка плитки остаётся управлением', async () => {
  await fixture(async f => {
    assert.equal(f.tile().tagName, 'BUTTON'); await f.down(); await f.advance(STAGE_DRAG_HOLD_MS);
    assert.equal(f.state().dragging, true); assert.equal(f.tile().dataset.drag, 'lifted');
    await f.event('pointerup'); assert.equal(f.commits.length, 1);
  }, source, { tileTag: 'button' });
  await fixture(async f => { await f.down({ control: true }); await f.advance(STAGE_DRAG_HOLD_MS); assert.equal(f.state().dragging, false); });
});
// Класс ошибки: FLIP переезд теряет анимацию или оставляет settling навсегда.
it('R169 сосед едет за 200 миллисекунд, посадка очищается только после 200 плюс 40', () => fixture(async f => {
  await f.down(); await f.advance(STAGE_DRAG_HOLD_MS); await f.event('pointermove', { clientX: 160 }); await f.advance(101);
  assert.equal(f.state().preview?.join(','), 'b,a,c');
  assert.match(f.tile('b').style.transition, /transform 200ms/);
  await f.event('pointerup');
  assert.equal(f.tile().dataset.drag, 'settling'); assert.match(f.tile().style.transition, /transform 200ms/);
  await f.advance(239); assert.equal(f.tile().dataset.drag, 'settling');
  await f.advance(1); assert.equal(f.tile().dataset.drag, undefined); assert.equal(f.tile().style.transition, '');
}));
// Класс ошибки: экранные координаты при zoom принимаются за координаты раскладки.
it('R169 масштаб два переводит центр в координаты сетки, край ограничивает поднятую плитку', async () => {
  await fixture(async f => {
    await f.down(); await f.advance(STAGE_DRAG_HOLD_MS);
    await f.event('pointermove', { clientX: 210, clientY: 80 }); await f.advance(101);
    // Экранный центр 210/2=105 — зазор, а не ячейка с индексом 1.
    assert.equal(f.state().preview, null);
    await f.event('pointermove', { clientX: 320, clientY: 80 }); await f.advance(101);
    assert.equal(f.state().preview?.join(','), 'b,a,c');
    await f.event('pointermove', { clientX: 900, clientY: 700 }); await f.advance(1);
    // Центр зажат к (330-53,100-42.4), текущий offsetLeft=110.
    const transform = f.tile().style.transform;
    const coordinates = transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
    assert.equal(coordinates !== null, true);
    assert.equal(Number(coordinates![1]), 117); assert.ok(Math.abs(Number(coordinates![2]) - 17.6) < 0.001);
  }, source, { zoom: 2 });
  for (const width of [0, -330]) await fixture(async f => {
    f.grid.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: 100, width, height: 100, toJSON() {} });
    await f.down(); await f.advance(STAGE_DRAG_HOLD_MS); await f.event('pointermove', { clientX: 160 }); await f.advance(101);
    assert.equal(f.state().preview?.join(','), 'b,a,c');
  });
});
async function mutant(anchor: string, replacement: string, check: (raw?: string) => Promise<void>) {
  assert.equal(source.split(anchor).length - 1, 1, 'якорь уникален'); await check();
  await assert.rejects(() => check(source.replace(anchor, replacement)), assert.AssertionError);
}
// Класс ошибки: таймер удержания обнулён.
it('R246 мутант мгновенного подъёма убивается границами времени', () => mutant('export const STAGE_DRAG_HOLD_MS = 500;', 'export const STAGE_DRAG_HOLD_MS = 0;', hold));
// Класс ошибки: touch запускает desktop drag.
it('R169 мутант без ограничения типа указателя убивается настоящим pointerdown', () => mutant("if (e.button !== 0 || (e.pointerType !== 'mouse' && e.pointerType !== 'pen')) return;", 'if (e.button !== 0) return;', types));
// Класс ошибки: отмена по Esc записывает раскладку.
it('R169 мутант записи при Escape убивается отсутствием onCommit', () => mutant("ev.stopPropagation();\n        finish(false, true);", "ev.stopPropagation();\n        finish(true, true);", escape));
// Класс ошибки: клик после drag открывает просмотр.
it('R169 мутант без поглощения клика убивается отменённым DOM click', () => mutant('swallowNextClick(buttonStillDown);', '// клик не поглощается', previewCommit));

async function jitter(raw = source) {
  await fixture(async f => {
    await f.down();
    for (let elapsed = 50; elapsed < STAGE_DRAG_HOLD_MS; elapsed += 50) {
      const d = elapsed % 100 === 0 ? -5 : 5;
      await f.event('pointermove', { clientX: 50 + d, clientY: 40 - d });
      await f.advance(50);
      assert.equal(f.state().dragging, false, 'R246 jitter-early: дрожь не ускоряет подъём');
    }
    await f.advance(50);
    assert.equal(f.state().dragging, true, 'R246 jitter-lift: дрожь ±5 px не отменяет полусекундное удержание');
    await f.event('pointerup');
    assert.equal(f.commits.length, 1);
    assert.equal(f.click(), false, 'R246 jitter-click: отпускание после подъёма не открывает показ');
    assert.equal(f.clicks(), 0, 'R246 jitter-action: обработчик карточки не получил проглоченный клик');
    await f.advance(0);
    assert.equal(f.click(), true); assert.equal(f.clicks(), 1, 'следующий обычный клик опять доходит до карточки');
  }, raw, { tileTag: 'button' });
}
// Класс ошибки: реальная дрожь руки срывает удержание и открывает показ вместо перестановки.
it('R246 дрожь ±5 px до 500 мс поднимает BUTTON показа, отпускание глотает клик, следующий клик обычный', () => jitter());

async function fullscreen(raw = source) {
  await fixture(async f => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: f.tile() });
    await f.down(); await f.advance(STAGE_DRAG_HOLD_MS);
    assert.equal(f.state().dragging, false, 'R246 fullscreen: полноэкранный узел нельзя поднимать');
    assert.equal(f.tile().dataset.drag, undefined); assert.equal(f.clock.pending.size, 0);
    assert.equal(f.commits.length, 0); assert.equal(f.click(), true);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    await f.down(); await f.advance(STAGE_DRAG_HOLD_MS);
    assert.equal(f.state().dragging, true, 'после выхода из fullscreen тот же узел снова поднимается');
  }, raw);
}
// Класс ошибки: fullscreen запускает hold/drag или навсегда блокирует жест после выхода.
it('R246 полноэкранный документ не запускает даже подсказку, после выхода перетаскивание разрешено', () => fullscreen());

function translation(el: HTMLElement) {
  const match = el.style.transform.match(/^translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(1\.06\)$/);
  assert.ok(match, 'R246 lifted-transform: поднятый узел имеет явное смещение и масштаб');
  return { x: Number(match[1]), y: Number(match[2]) };
}

async function scrolling(raw = source) {
  for (const zoom of [1, 2]) await fixture(async f => {
    await f.scroll(41, 17); await f.down({ key: 'b' }); await f.advance(STAGE_DRAG_HOLD_MS);
    const before = translation(f.tile('b'));
    assert.equal(before.x, 0, 'R246 scroll-origin-x: начальная прокрутка не прибавляется к смещению');
    assert.equal(before.y, 0, 'R246 scroll-origin-y: начальная прокрутка не прибавляется к смещению');
    // Указатель не двигался: именно scroll, а не pointermove, должен запланировать новый кадр.
    await f.scroll(71, 37); await f.advance(1);
    const after = translation(f.tile('b'));
    assert.equal(after.x - before.x, 30, 'R246 scroll-x: прокрутка по X компенсирована в координатах раскладки');
    assert.equal(after.y - before.y, 20, 'R246 scroll-y: прокрутка по Y компенсирована в координатах раскладки');
    assert.equal(f.state().dragging, true); assert.equal(f.commits.length, 0);
    const nest = f.grid.querySelector<HTMLElement>('[data-nest]');
    assert.equal(nest?.style.left, '110px'); assert.equal(nest?.style.top, '100px');
    await f.event('pointerup');
    const timers = f.clock.pending.size;
    await f.scroll(90, 50);
    assert.equal(f.clock.pending.size, timers, 'R246 scroll-cleanup: после завершения scroll не планирует кадры');
  }, raw, { zoom, gridHeight: 250, tileTop: 100 });
}
// Класс ошибки: при колесе поднятая плитка уезжает от указателя, особенно при начальном scroll и zoom.
it('R246 scroll без движения мыши компенсирует обе оси от ненулевой начальной прокрутки при zoom 1 и 2', () => scrolling());

async function shortContainer(raw = source) {
  for (const height of [80, 82]) await fixture(async f => {
    await f.scroll(0, 31); await f.down(); await f.advance(STAGE_DRAG_HOLD_MS);
    for (const y of [1, 760]) {
      await f.event('pointermove', { clientY: y }); await f.advance(1);
      const top = f.tile().offsetTop + translation(f.tile()).y;
      assert.equal(top >= 31 && top + 80 <= 31 + height, true,
        'R246 short-container: обычная высота плитки остаётся в видимой полосе, если увеличенная не влезает');
      assert.equal(top, y === 1 ? 31 : 31 + height - 80);
    }
  }, raw, { gridHeight: height });
}
// Класс ошибки: масштабированная плитка выше полосы получает перевёрнутые границы и скачет за срез.
it('R246 полоса высотой 80 и 82 удерживает обычные 80 px плитки внутри обеих вертикальных границ', () => shortContainer());

const dragFailure = (prefix: string) => (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(prefix);
async function regression(anchor: string, replacement: string, check: (raw?: string) => Promise<void>, prefix: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'R246 якорь мутанта уникален');
  await check();
  await assert.rejects(() => check(source.replace(anchor, replacement)), dragFailure(prefix));
}
// Класс ошибки: квадрат/одна ось вместо радиуса пропускают диагональ, прежний порог срывает допустимое удержание.
it('R246 контрфакты порога 6 и осевых расстояний вместо hypot отвергаются граничными движениями', async () => {
  await regression('export const STAGE_DRAG_SLOP_PX = 16;', 'export const STAGE_DRAG_SLOP_PX = 6;', slop, 'R246 slop:');
  const radial = 'Math.hypot(ev.clientX - s.startX, ev.clientY - s.startY)';
  for (const replacement of ['Math.abs(ev.clientX - s.startX)', 'Math.abs(ev.clientY - s.startY)', 'Math.max(Math.abs(ev.clientX - s.startX), Math.abs(ev.clientY - s.startY))'])
    await regression(radial, replacement, slop, 'R246 slop:');
});
// Класс ошибки: ветка fullscreen, компенсация scroll или fallback короткой полосы удалены, но обычный drag всё ещё работает.
it('R246 контрфакты fullscreen, потери scroll и зажима короткой полосы отвергаются по реальному хуку', async () => {
  await regression('if (grid.ownerDocument.fullscreenElement) return;', '// fullscreen пропущен', fullscreen, 'R246 fullscreen:');
  await regression("grid.addEventListener('scroll', onScroll, { passive: true });", '// scroll не слушается', scrolling, 'R246 scroll-x:');
  await regression('(grid.scrollLeft - s.scroll0.x)', '0', scrolling, 'R246 scroll-x:');
  await regression('(grid.scrollTop - s.scroll0.y)', '0', scrolling, 'R246 scroll-y:');
  await regression('s.scroll0 = { x: grid.scrollLeft, y: grid.scrollTop };', 's.scroll0 = { x: 0, y: 0 };', scrolling, 'R246 scroll-origin-x:');
  await regression('size >= full ? full / 2 : null', 'null', shortContainer, 'R246 short-container:');
});

const edgeGeometry = { columns: 1, gridHeight: 200, scrollWidth: 330, scrollHeight: 260 };

async function edgeLimit(raw = source) {
  await fixture(async f => {
    await f.down(); await f.advance(STAGE_DRAG_HOLD_MS);
    assert.equal(f.clock.frames.size, 0, 'R247 edge-start: подъём сам не включает автопрокрутку');
    f.content(330, 860); // transform поднятого узла расширил scrollHeight после снятия исходного max=60.
    await f.event('pointermove', { clientY: 199 });
    for (let frame = 1; frame <= 5; frame++) {
      await f.advance(1);
      assert.equal(f.grid.scrollTop, frame * 12, 'R247 edge-step: каждый кадр едет на один шаг');
      assert.equal(f.grid.scrollLeft, 0, 'R247 edge-step-x: ось без прокрутки неподвижна');
    }
    await f.advance(1);
    assert.equal(f.grid.scrollTop, 60, 'R247 edge-limit: предел снят при подъёме, не из выросшего scrollHeight');
    assert.equal(f.clock.frames.size, 0, 'R247 edge-limit-frame: у предела цикл больше не планирует кадров');
    await f.advance(250);
    assert.equal(f.grid.scrollTop, 60); assert.equal(f.clock.frames.size, 0);
  }, raw, edgeGeometry);
}
// Класс ошибки: бесконечная прокрутка вслед за transform либо пропуск повторных кадров без движения мыши.
it('R247 автопрокрутка делает по 12 px за кадр и останавливается на исходных 60 даже при росте scrollHeight', () => edgeLimit());

// Класс ошибки: ось/знак перепутаны или прокрутка пролетает через остаток меньший скорости.
it('R247 обе оси едут к обоим краям, остаток меньше 12 зажимается точно к пределу и нулю', async () => {
  for (const axis of ['x', 'y'] as const) await fixture(async f => {
    const pos = () => axis === 'x' ? f.grid.scrollLeft : f.grid.scrollTop;
    const move = (nearEnd: boolean) => f.event('pointermove', axis === 'x'
      ? { clientX: nearEnd ? 329 : 0, clientY: 100 }
      : { clientX: 100, clientY: nearEnd ? 199 : 0 });
    await f.down({ clientX: 100, clientY: 100 }); await f.advance(STAGE_DRAG_HOLD_MS);
    await move(true);
    await f.advance(1); assert.equal(pos(), 12);
    await f.advance(1); assert.equal(pos(), 17, 'R247 edge-remainder: конец не перескакивается на полный шаг');
    await f.advance(1); assert.equal(f.clock.frames.size, 0);
    await move(false);
    await f.advance(1); assert.equal(pos(), 5);
    await f.advance(1); assert.equal(pos(), 0, 'R247 edge-zero: начало не перескакивается в минус');
    await f.advance(1); assert.equal(f.clock.frames.size, 0);
  }, source, { ...edgeGeometry, scrollWidth: axis === 'x' ? 347 : 330, scrollHeight: axis === 'y' ? 217 : 200 });
});

async function heldEdge(raw = source) {
  await fixture(async f => {
    await f.down({ key: 'b', clientY: 169 }); await f.advance(STAGE_DRAG_HOLD_MS);
    await f.event('pointermove', { clientY: 180 }); await f.advance(20);
    assert.equal(f.grid.scrollTop, 0, 'R247 edge-held: край, где взяли плитку, не едет до выхода из зоны');
    assert.equal(f.clock.frames.size, 0);
    await f.event('pointermove', { clientY: 150 }); await f.advance(1);
    assert.equal(f.grid.scrollTop, 0);
    await f.event('pointermove', { clientY: 199 }); await f.advance(1);
    assert.equal(f.grid.scrollTop, 12, 'R247 edge-reenter: выход и возврат снова разрешают этот край');
  }, raw, edgeGeometry);
}
// Класс ошибки: взятая за нижнюю подпись плитка тут же запускает прокрутку или край блокируется навсегда.
it('R247 удержанный при подъёме нижний край не едет до выхода из зоны и работает после возвращения', () => heldEdge());

async function stopEdge(raw = source) {
  for (const type of ['pointerup', 'keydown', 'blur', 'pointercancel', 'pointermove']) await fixture(async f => {
    await f.down(); await f.advance(STAGE_DRAG_HOLD_MS);
    await f.event('pointermove', { clientY: 199 }); await f.advance(1);
    assert.equal(f.grid.scrollTop, 12); assert.equal(f.clock.frames.size, 1);
    await f.event(type, type === 'pointermove' ? { clientY: 100 } : {});
    if (type !== 'pointermove') assert.equal(f.clock.frames.size, 0, 'R247 edge-stop: завершение отменяет уже запланированный кадр');
    await f.advance(1);
    assert.equal(f.clock.frames.size, 0, 'R247 edge-exit: выход из зоны гасит последний кадр без нового');
    await f.advance(250);
    assert.equal(f.grid.scrollTop, 12, 'R247 edge-stop-position: после остановки прокрутка не продолжается');
    assert.equal(f.state().dragging, type === 'pointermove');
    assert.equal(f.commits.length, type === 'pointerup' ? 1 : 0);
  }, raw, edgeGeometry);
  let clock!: Clock;
  await fixture(async f => {
    clock = f.clock; await f.down(); await f.advance(STAGE_DRAG_HOLD_MS);
    await f.event('pointermove', { clientY: 199 }); await f.advance(1);
    assert.equal(clock.frames.size, 1);
  }, raw, edgeGeometry);
  assert.equal(clock.frames.size, 0, 'R247 edge-unmount: размонтирование отменяет кадр автопрокрутки');
}
// Класс ошибки: rAF переживает отпускание/Esc/blur/cancel/unmount или не гаснет при выходе из зоны.
it('R247 выход из зоны, отпускание, Escape, blur, pointercancel и unmount останавливают цикл кадров', () => stopEdge());

// Класс ошибки: автокадры крутятся без переполнения, хотя контейнеру некуда прокручиваться.
it('R247 контейнер без прокрутки не заводит цикл даже при указателе у двух краёв', () => fixture(async f => {
  await f.down(); await f.advance(STAGE_DRAG_HOLD_MS);
  await f.event('pointermove', { clientX: 329, clientY: 199 }); await f.advance(1);
  assert.equal(f.clock.frames.size, 0, 'обычный pointermove-кадр кончился, автокадра нет');
  await f.advance(500);
  assert.equal(f.grid.scrollLeft, 0); assert.equal(f.grid.scrollTop, 0); assert.equal(f.clock.frames.size, 0);
}, source, { ...edgeGeometry, scrollHeight: 200 }));

async function edgeNewRow(raw = source) {
  await fixture(async f => {
    const video = f.tile().querySelector('video');
    await f.down(); await f.advance(STAGE_DRAG_HOLD_MS);
    await f.event('pointermove', { clientY: 199 });
    for (let frame = 1; frame <= 5; frame++) {
      await f.advance(1);
      const viewportCenter = f.tile().offsetTop + translation(f.tile()).y + 40 - f.grid.scrollTop;
      assert.ok(Math.abs(viewportCenter - 157.6) < 1e-6,
        'R247 edge-follow: экранное положение плитки не уезжает от неподвижного указателя при прокрутке');
      // Центр зажат, не обязан равняться указателю; указатель остаётся внутри увеличенного прямоугольника.
      assert.equal(199 >= viewportCenter - 42.4 && 199 <= viewportCenter + 42.4 + 1e-6, true);
    }
    assert.equal(f.grid.scrollTop, 60); assert.equal(f.state().preview, null);
    await f.advance(96);
    assert.equal(f.state().preview, null, 'R247 edge-preview-early: 99 мс над ячейкой нового ряда ещё недостаточно');
    await f.advance(1);
    assert.equal(f.state().preview?.join(','), 'b,c,a', 'R247 edge-preview: автокадры пересчитывают цель до нового ряда');
    assert.equal(f.tile().querySelector('video'), video);
    await f.event('pointerup');
    assert.deepEqual(f.commits, [['b', 'c', 'a']], 'R247 edge-commit: сохраняется новый, прежде невидимый ряд');
    assert.equal(f.tile().querySelector('video'), video); assert.equal(f.click(), false);
  }, raw, edgeGeometry);
}
// Класс ошибки: колесо едет, но плитка/цель остаются на старом месте либо записывается старый порядок.
it('R247 автопрокрутка держит плитку под указателем, после 100 мс над новым рядом переставляет и сохраняет без remount', () => edgeNewRow());

// Класс ошибки: живой scrollHeight снова создаёт бесконечный предел, edgeHeld или отмена кадров удалены.
it('R247 контрфакты живого предела, проигнорированного края и неотменённого кадра ловятся настоящим жестом', async () => {
  const snapshot = 's.scrollMax = { x: Math.max(0, grid.scrollWidth - grid.clientWidth), y: Math.max(0, grid.scrollHeight - grid.clientHeight) };';
  await regression(snapshot,
    "Object.defineProperty(s, 'scrollMax', { get: () => ({ x: Math.max(0, grid.scrollWidth - grid.clientWidth), y: Math.max(0, grid.scrollHeight - grid.clientHeight) }) });",
    edgeLimit, 'R247 edge-limit:');
  await regression('if (dir === 0 || dir === nextHeld)', 'if (dir === 0)', heldEdge, 'R247 edge-held:');
  await regression('if (s.edgeRaf !== null) window.cancelAnimationFrame(s.edgeRaf);', '// edgeRaf не отменён', stopEdge, 'R247 edge-stop:');
});

// Класс ошибки: обычный pointermove маскирует потерю обновления плитки/цели именно в повторных автокадрах.
it('R247 контрфакты потери placeLifted и trackTarget в автокадре ловятся движением к новому ряду', async () => {
  const frame = 'const c = placeLifted();\n      if (c) trackTarget(c);\n      now.edgeRaf = window.requestAnimationFrame(step);';
  await regression(frame, frame.replace('const c = placeLifted();', 'const c = undefined;'), edgeNewRow, 'R247 edge-follow:');
  await regression(frame, frame.replace('if (c) trackTarget(c);', '// цель не пересчитывается'), edgeNewRow, 'R247 edge-preview-early:');
});
