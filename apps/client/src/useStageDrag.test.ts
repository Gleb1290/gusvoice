import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as rules from './stageOrderRules';
import type { useStageDrag } from './useStageDrag';

const source = readFileSync(new URL('./useStageDrag.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
class Clock {
  now = 0; next = 1;
  pending = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms = 0) => { const id = this.next++; this.pending.set(id, { at: this.now + ms, fn }); return id; };
  clearTimeout = (id: number) => { this.pending.delete(id); };
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
  down(options?: { key?: string; button?: number; pointerType?: string; control?: boolean }): Promise<void>;
  event(type: string, init?: Record<string, unknown>): Promise<Event>;
  advance(ms: number): Promise<void>; click(): boolean;
};
async function fixture(check: (f: Fixture) => Promise<void>, raw = source,
  options: { tileTag?: 'div' | 'button'; zoom?: number } = {}) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const clock = new Clock();
  const module = { exports: {} as { useStageDrag: typeof useStageDrag } };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const fakeWindow = {
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    requestAnimationFrame: (fn: () => void) => clock.setTimeout(fn, 1), cancelAnimationFrame: clock.clearTimeout,
    addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
    matchMedia: () => ({ matches: false }), getSelection: window.getSelection.bind(window), innerWidth: 1000, innerHeight: 800,
  };
  let enabled = true; let keys = ['a', 'b', 'c']; let state!: ReturnType<typeof useStageDrag>;
  const commits: string[][] = []; const gridRef = React.createRef<HTMLDivElement>();
  const deps: Record<string, unknown> = { react: React, './stageOrderRules': rules };
  function Tile({ id }: { id: string }) {
    return React.createElement(options.tileTag ?? 'div', { 'data-stage-key': id, ref: (el: HTMLElement | null) => {
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
      const geometry: Record<string, () => number> = { offsetLeft: () => index() * 110, offsetTop: () => 0, offsetWidth: () => 100, offsetHeight: () => 80 };
      for (const [name, getter] of Object.entries(geometry))
        Object.defineProperty(el, name, { configurable: true, get: getter });
      const zoom = options.zoom ?? 1;
      el.getBoundingClientRect = () => ({ x: index() * 110 * zoom, y: 0, left: index() * 110 * zoom, top: 0, right: (index() * 110 + 100) * zoom, bottom: 80 * zoom, width: 100 * zoom, height: 80 * zoom, toJSON() {} });
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
    Object.defineProperty(grid, 'clientHeight', { configurable: true, get: () => 100 });
    const zoom = options.zoom ?? 1;
    grid.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 330 * zoom, bottom: 100 * zoom, width: 330 * zoom, height: 100 * zoom, toJSON() {} });
    const tile = (key = 'a') => grid.querySelector<HTMLElement>(`[data-stage-key="${key}"]`)!;
    const dispatch = async (target: EventTarget, type: string, init: Record<string, unknown> = {}) => {
      const event = type === 'keydown' ? new window.KeyboardEvent(type, { key: 'Escape', bubbles: true, cancelable: true, ...init })
        : new window.PointerEvent(type, { pointerId: 7, pointerType: 'mouse', button: 0, clientX: 50, clientY: 40, bubbles: true, cancelable: true, ...init });
      await React.act(async () => { target.dispatchEvent(event); }); return event;
    };
    await check({ grid, clock, commits, tile, state: () => state, render,
      down: async (o = {}) => { const el = tile(o.key); await dispatch(o.control ? el.querySelector('button')! : el, 'pointerdown', { clientX: 50 * zoom, clientY: 40 * zoom, ...o }); },
      event: (type, init) => dispatch(window, type, init),
      advance: async ms => { await React.act(async () => clock.advance(ms)); },
      click: () => tile().dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })),
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
  await fixture(async f => {
    await f.down(); await f.advance(299); assert.equal(f.tile().dataset.drag, undefined);
    await f.advance(1); assert.equal(f.tile().dataset.drag, 'pressing');
    await f.advance(1699); assert.equal(f.state().dragging, false);
    await f.advance(1); assert.equal(f.state().dragging, true); assert.equal(f.tile().dataset.drag, 'lifted');
    assert.equal(f.grid.dataset.dragging, '1'); assert.match(f.tile().style.transform, /scale\(1\.06\)/);
  }, raw);
}
// Класс ошибки: мгновенный подъём или неверная граница таймеров.
it('R169 подсказка ровно через 300, подъём через 2000, до 1999 подъёма нет', () => hold());
// Класс ошибки: отмена допустимого дрожания или подъём после движения.
it('R169 сдвиг ровно шесть пикселей разрешён, больше шести отменяет удержание', async () => {
  await fixture(async f => { await f.down(); await f.event('pointermove', { clientX: 56 }); await f.advance(2000); assert.equal(f.state().dragging, true); });
  await fixture(async f => { await f.down(); await f.advance(300); await f.event('pointermove', { clientX: 56.01 }); await f.advance(2000); assert.equal(f.state().dragging, false); assert.equal(f.tile().dataset.drag, undefined); assert.equal(f.click(), true); });
});
async function types(raw = source) {
  for (const options of [{ button: 2 }, { pointerType: 'touch' }, { control: true }]) await fixture(async f => {
    await f.down(options); await f.advance(2000); assert.equal(f.state().dragging, false); assert.equal(f.tile().dataset.drag, undefined);
  }, raw);
  await fixture(async f => { await f.down({ pointerType: 'pen' }); await f.advance(2000); assert.equal(f.state().dragging, true); }, raw);
}
// Класс ошибки: перехват контекстного меню, касания или кнопки плитки.
it('R169 мышь и перо принимаются, правая кнопка касание и вложенная кнопка не запускают жест', () => types());
async function previewCommit(raw = source) {
  await fixture(async f => {
    const video = f.tile().querySelector('video'); await f.down(); await f.advance(2000);
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
    await f.down(); await f.advance(2000); const event = await f.event('keydown');
    assert.equal(event.defaultPrevented, true); assert.equal(f.state().dragging, false); assert.equal(f.commits.length, 0);
    assert.equal(f.click(), false); await f.event('pointerup'); await f.advance(0); assert.equal(f.click(), true);
  }, raw);
}
// Класс ошибки: Esc сохраняет вместо отката или пропускает клик под отменённой плиткой.
it('R169 Escape отменяет поднятую плитку без записи и глотает клик до отпускания', () => escape());
// Класс ошибки: внешняя отмена записывает несанкционированную перестановку.
it('R169 blur, pointercancel и выход за окно отменяют поднятую плитку без записи', async () => {
  for (const [type, init] of [['blur', {}], ['pointercancel', {}], ['pointermove', { clientX: -1 }], ['pointermove', { clientX: 1000 }], ['pointermove', { clientY: 800 }]] as const)
    await fixture(async f => { await f.down(); await f.advance(2000); await f.event(type, init); assert.equal(f.state().dragging, false); assert.equal(f.commits.length, 0); await f.advance(3000); assert.equal(f.commits.length, 0); });
});
// Класс ошибки: отключённая сетка или ушедшая плитка оставляет активную сессию.
it('R169 отключение и исчезновение плитки отменяют hold и drag без записи', async () => {
  for (const ms of [300, 2000]) for (const next of [{ enabled: false }, { keys: ['b', 'c'] }])
    await fixture(async f => { await f.down(); await f.advance(ms); await f.render(next); await f.advance(3000); assert.equal(f.state().dragging, false); assert.equal(f.commits.length, 0); });
});
// Класс ошибки: обычный короткий клик поглощается обработчиком перетаскивания.
it('R169 короткое отпускание и отмена до подъёма не глотают обычный клик', async () => {
  for (const type of ['pointerup', 'pointercancel', 'keydown', 'blur']) await fixture(async f => {
    await f.down(); await f.advance(300); await f.event(type); await f.advance(3000);
    assert.equal(f.state().dragging, false); assert.equal(f.commits.length, 0); assert.equal(f.click(), true);
  });
});
// Класс ошибки: чужой pointer отменяет или завершает наш жест.
it('R169 события чужого указателя не меняют текущую сессию', () => fixture(async f => {
  await f.down(); await f.event('pointermove', { pointerId: 8, clientX: -1 }); await f.advance(2000);
  await f.event('pointerup', { pointerId: 8 }); await f.event('pointercancel', { pointerId: 8 });
  assert.equal(f.state().dragging, true); assert.equal(f.commits.length, 0); await f.event('pointerup'); assert.equal(f.commits.length, 1);
}));
// Класс ошибки: случайный пролёт или смена цели завершает старый dwell.
it('R169 уход центра в зазор отменяет наведение, новая ячейка требует свои 100 миллисекунд', () => fixture(async f => {
  await f.down(); await f.advance(2000); await f.event('pointermove', { clientX: 160 }); await f.advance(50);
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
    await f.advance(2000); assert.equal(f.state().dragging, false);
  }
}));
// Класс ошибки: второе pointerdown подменяет уже удерживаемую плитку.
it('R169 повторное начало не заменяет активную плитку, посторонняя клавиша не отменяет drag', () => fixture(async f => {
  await f.down(); await f.advance(1000); await f.down({ key: 'b' }); await f.advance(1000);
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
  await f.down(); await f.advance(2000); await f.event('pointermove', { clientX: 51 }); await f.advance(150); assert.equal(f.state().preview, null);
  await f.event('pointermove', { clientX: 160 }); await f.advance(51);
  await f.event('pointermove', { clientX: 161 }); await f.advance(49); assert.equal(f.state().preview, null);
  await f.advance(1); assert.equal(f.state().preview?.join(','), 'b,a,c');
}));
// Класс ошибки: корневая кнопка карточки показа ошибочно считается вложенным управлением.
it('R169 корневой BUTTON карточки показа поднимается, вложенная кнопка плитки остаётся управлением', async () => {
  await fixture(async f => {
    assert.equal(f.tile().tagName, 'BUTTON'); await f.down(); await f.advance(2000);
    assert.equal(f.state().dragging, true); assert.equal(f.tile().dataset.drag, 'lifted');
    await f.event('pointerup'); assert.equal(f.commits.length, 1);
  }, source, { tileTag: 'button' });
  await fixture(async f => { await f.down({ control: true }); await f.advance(2000); assert.equal(f.state().dragging, false); });
});
// Класс ошибки: FLIP переезд теряет анимацию или оставляет settling навсегда.
it('R169 сосед едет за 200 миллисекунд, посадка очищается только после 200 плюс 40', () => fixture(async f => {
  await f.down(); await f.advance(2000); await f.event('pointermove', { clientX: 160 }); await f.advance(101);
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
    await f.down(); await f.advance(2000);
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
    await f.down(); await f.advance(2000); await f.event('pointermove', { clientX: 160 }); await f.advance(101);
    assert.equal(f.state().preview?.join(','), 'b,a,c');
  });
});
async function mutant(anchor: string, replacement: string, check: (raw?: string) => Promise<void>) {
  assert.equal(source.split(anchor).length - 1, 1, 'якорь уникален'); await check();
  await assert.rejects(() => check(source.replace(anchor, replacement)), assert.AssertionError);
}
// Класс ошибки: таймер удержания обнулён.
it('R169 мутант мгновенного подъёма убивается границами времени', () => mutant('export const STAGE_DRAG_HOLD_MS = 2000;', 'export const STAGE_DRAG_HOLD_MS = 0;', hold));
// Класс ошибки: touch запускает desktop drag.
it('R169 мутант без ограничения типа указателя убивается настоящим pointerdown', () => mutant("if (e.button !== 0 || (e.pointerType !== 'mouse' && e.pointerType !== 'pen')) return;", 'if (e.button !== 0) return;', types));
// Класс ошибки: отмена по Esc записывает раскладку.
it('R169 мутант записи при Escape убивается отсутствием onCommit', () => mutant("ev.stopPropagation();\n        finish(false, true);", "ev.stopPropagation();\n        finish(true, true);", escape));
// Класс ошибки: клик после drag открывает просмотр.
it('R169 мутант без поглощения клика убивается отменённым DOM click', () => mutant('swallowNextClick(buttonStillDown);', '// клик не поглощается', previewCommit));
