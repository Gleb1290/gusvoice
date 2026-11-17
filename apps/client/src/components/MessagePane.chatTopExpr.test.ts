import { mutantsEnabled } from '../../../../packages/shared/test/counterfacts.js';
import { it } from 'node:test';

import assert from 'node:assert/strict';

import { act, createElement } from 'react';
import { Simulate } from 'react-dom/test-utils';
import { renderToStaticMarkup } from 'react-dom/server';
import { setupHarness, type Props } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url, { tinyEmojiFixture: true });
const watchdogSet = globalThis.setTimeout;
const watchdogClear = globalThis.clearTimeout;
async function bounded<T>(label: string, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = watchdogSet(() => reject(new Error(`R146: таймаут ${label}`)), 10000);
    })]);
  } finally { if (timer !== undefined) watchdogClear(timer); }
}
type Pane = typeof h.Pane;
type Runtime = typeof h.server;
async function fixture(phone: boolean, check: (pane: Pane, runtime: Runtime) => Promise<void>, change?: (s: string) => string) {
  const restore = h.pointerLayout(phone, phone ? 390 : 1000);
  const previousKeyboard = document.documentElement.getAttribute('data-kb');
  const runtime = change ? await bounded('создание Vite', () => h.paneServer(change, 'MessagePane', true)) : h.server;
  try {
    const { MessagePane } = await bounded('импорт MessagePane', () => runtime.ssrLoadModule('/src/components/MessagePane.tsx'));
    await bounded('сценарий', () => check(MessagePane, runtime));
  } finally {
    try { h.unmount(); }
    finally {
      if (previousKeyboard === null) document.documentElement.removeAttribute('data-kb');
      else document.documentElement.setAttribute('data-kb', previousKeyboard);
      restore();
      if (change) await bounded('закрытие Vite', () => runtime.close());
    }
  }
}
function emoji() {
  const button = h.host.querySelector<HTMLButtonElement>('.att-btn.emoji');
  assert.ok(button, 'кнопка эмодзи существует');
  return button;
}
function field() {
  const input = h.host.querySelector<HTMLTextAreaElement>('textarea');
  assert.ok(input, 'поле ввода существует');
  return input;
}
async function open(pane: Pane, props: Partial<Props> = {}) {
  await h.mount(props, pane);
  await act(async () => { field().focus(); });
  await act(async () => { emoji().click(); });
}
function panel() { return h.host.querySelector('.expr-under'); }

it('телефон: шапка и капсула полос находятся в одном верхнем слое', async () => fixture(true, async pane => {
  await h.mount({ topBar: createElement('div', { className: 'stranger-fixture' }, 'Незнакомец') }, pane);
  const top = h.host.querySelector('.chat-top');
  assert.ok(top);
  assert.ok(top.querySelector(':scope > .channel-topbar'));
  assert.ok(top.querySelector(':scope > .top-capsule > .stranger-fixture'));
  assert.equal(!!h.host.querySelector('.messages')?.closest('.chat-top'), false);
}));

async function measure(pane: Pane, phone: boolean, pending = false) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const original = globalThis.ResizeObserver;
  let height = 86;
  const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
  class Observer {
    targets = new Set<Element>();
    constructor(public callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() {
    return (this as HTMLElement).classList.contains('chat-top') ? height : descriptor?.get?.call(this) ?? 0;
  } });
  globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
  try {
    const feedWindow: Props['feedWindow'] = pending ? { hasOlder: false, hasNewer: false, loadNewer: async () => false, jumpLatest: async () => {}, jumpTo: async () => false, unreadBelow: 0, place: { messageId: 'not-loaded-yet', offset: 0 }, onPlace: () => {}, readKey: null } : undefined;
    await h.mount({ feedWindow, scrollKey: 'top-measure' }, pane);
    const chat = h.host.querySelector<HTMLElement>('.chat')!;
    assert.equal(chat.style.getPropertyValue('--chat-top-h'), phone ? '86px' : '');
    if (!phone) return;
    const top = h.host.querySelector('.chat-top')!;
    const list = h.host.querySelector<HTMLElement>('.messages')!;
    list.scrollTop = 120;
    const fire = async () => act(async () => {
      for (const observer of observers) if (observer.targets.has(top)) observer.callback([], observer as unknown as ResizeObserver);
    });
    height = 116; await fire();
    assert.equal(list.scrollTop, pending ? 120 : 150, 'рост капсулы сохраняет позицию строк');
    await fire(); assert.equal(list.scrollTop, pending ? 120 : 150, 'повтор той же высоты не сдвигает строки');
    height = 70; await fire();
    assert.equal(list.scrollTop, pending ? 120 : 104, 'сжатие капсулы сдвигает строки обратно');
  } finally {
    h.unmount();
    globalThis.ResizeObserver = original;
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
  }
}
it('телефон: измеренная высота верха и обе дельты сохраняют прокрутку', async () => fixture(true, pane => measure(pane, true)));
it('ПК: высота верхнего слоя не попадает в переменную телефона', async () => fixture(false, pane => measure(pane, false)));

async function phonePanel(pane: Pane) {
  await open(pane);
  assert.ok(panel(), 'телефон открывает панель под полем');
  assert.equal(!!h.host.querySelector('.emoji-backdrop'), false);
  assert.equal(document.activeElement === field(), false, 'открытие панели убирает фокус клавиатуры');
  assert.equal(emoji().title, 'Клавиатура');
}
async function pcPanel(pane: Pane) {
  await open(pane);
  assert.equal(!!panel(), false, 'ПК не получает телефонную панель');
  assert.ok(document.querySelector('.emoji-backdrop'), 'ПК открывает прежнее окно');
  assert.notEqual(emoji().title, 'Клавиатура');
}
it('телефон: смайлик становится клавиатурой, панель без оконной подложки', async () => fixture(true, phonePanel));
it('ПК: смайлик сохраняет прежнее всплывающее окно', async () => fixture(false, pcPanel));

async function focusDelay(pane: Pane, byButton = false) {
  await open(pane);
  assert.ok(panel());
  const originalSet = window.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let fallback: (() => void) | undefined;
  const id = 123456789;
  window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (ms === 600) { assert.equal(typeof callback, 'function'); fallback = () => (callback as Function)(...args); return id; }
    return (originalSet as Function).call(window, callback, ms, ...args);
  }) as typeof window.setTimeout;
  globalThis.clearTimeout = ((timer: unknown) => { if (timer !== id) originalClear(timer as never); }) as typeof clearTimeout;
  try {
    await act(async () => { if (byButton) emoji().click(); else field().focus(); });
    assert.ok(panel(), 'фокус не закрывает панель немедленно');
    assert.equal(document.activeElement === field(), true);
    assert.ok(fallback, 'ожидание клавиатуры ограничено 600 мс');
    await act(async () => { fallback!(); });
    assert.equal(!!panel(), false, '600 мс без клавиатуры закрывают панель');
    assert.notEqual(emoji().title, 'Клавиатура');
  } finally { h.unmount(); window.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
}
it('фокус поля ждёт клавиатуру и закрывает панель запасным таймером 600 мс', async () => fixture(true, pane => focusDelay(pane)));
it('кнопка клавиатуры фокусирует поле, но не закрывает панель раньше времени', async () => fixture(true, pane => focusDelay(pane, true)));
it('признак data-kb закрывает панель после фокуса, не дожидаясь запаса', async () => fixture(true, async pane => {
  await open(pane);
  await act(async () => { field().focus(); });
  assert.ok(panel());
  await act(async () => { document.documentElement.setAttribute('data-kb', ''); await h.delay(); });
  assert.equal(!!panel(), false);
}));

async function escapePanel(pane: Pane) {
  let closed = 0;
  await open(pane, { onEscapeClose: () => { closed++; } });
  // Глобальный shortcut проходит window capture → document → window bubble,
  // но не React input-polyfill на textarea, уже размонтируемой обработчиком Esc.
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.equal(!!panel(), false);
  assert.equal(closed, 0, 'Esc панели не закрывает беседу');
}
it('Esc закрывает только панель и не доходит до выхода из беседы', async () => fixture(true, escapePanel));
async function reopenedPanel(pane: Pane) {
  await open(pane);
  assert.equal(document.documentElement.hasAttribute('data-kb'), false, 'проверяем запасной таймер без экранной клавиатуры');
  const savedSet = window.setTimeout;
  const savedClear = globalThis.clearTimeout;
  const savedWindowClear = window.clearTimeout;
  let now = 0;
  let next = -147000;
  let scheduled = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (ms !== 600) return (savedSet as Function).call(window, callback, ms, ...args);
    assert.equal(typeof callback, 'function');
    const id = next--; scheduled++;
    timers.set(id, { at: now + 600, run: () => (callback as Function)(...args) });
    return id;
  }) as typeof window.setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    if (typeof id === 'number' && id <= -147000) { timers.delete(id); return; }
    savedClear(id as never);
  }) as typeof clearTimeout;
  window.clearTimeout = ((id: unknown) => {
    if (typeof id === 'number' && id <= -147000) { timers.delete(id); return; }
    savedWindowClear.call(window, id as never);
  }) as typeof window.clearTimeout;
  const advance = async (ms: number) => {
    now += ms;
    await act(async () => {
      for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.run();
    });
  };
  try {
    await act(async () => { field().focus(); });
    assert.equal(scheduled, 1, 'фокус действительно запустил ожидание 600 мс');
    assert.equal(!!panel(), true, 'ожидание клавиатуры не закрывает панель сразу');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(!!panel(), false, 'Esc закрыл первую панель');
    await act(async () => { emoji().click(); });
    assert.equal(!!panel(), true, 'до истечения старого таймера открыта новая панель');
    await advance(599);
    assert.equal(!!panel(), true, 'новая панель остаётся открытой до старого срока');
    await advance(1);
    assert.equal(!!panel(), true, 'старый таймер не закрывает заново открытую панель');
  } finally {
    h.unmount();
    window.setTimeout = savedSet;
    globalThis.clearTimeout = savedClear;
    window.clearTimeout = savedWindowClear;
  }
}
it('R147 Esc отменяет ожидание клавиатуры: новая панель переживает старые 600 мс', async () => fixture(true, reopenedPanel));
it('назад зарегистрирована для панели и снимается после её закрытия', async () => fixture(true, async (pane, runtime) => {
  await open(pane);
  const back = await runtime.ssrLoadModule('/src/androidBack.ts') as typeof import('../androidBack');
  const store = await runtime.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const previous = store.useStore.getState().mobilePane;
  store.useStore.setState({ mobilePane: 'content' });
  try {
    assert.equal(back.backLeavesPane(), false);
    await act(async () => { assert.equal(back.stepBack(), true); });
    assert.equal(!!panel(), false);
    assert.equal(store.useStore.getState().mobilePane, 'content');
    assert.equal(back.backLeavesPane(), true, 'закрытая панель больше не удерживает назад');
  } finally { store.useStore.setState({ mobilePane: previous }); }
}));

function replaceOnce(source: string, from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'мутация имеет одну точную цель');
  return source.replace(from, to);
}
// Настоящие пикеры и обработчики MessagePane; layout задаёт фикстура, HappyDOM его не вычисляет.
const sampleSticker = { id: 'st', packId: 'pack', emoji: '😀', format: 'webp' as const, url: 'data:image/webp;base64,' };
const expressionProps: Partial<Props> = {
  onSendSticker: async () => {}, onSendGif: async () => {},
  stickerCatalog: createElement('span', null, 'Каталог'),
  stickerPacks: [{ id: 'pack', name: 'fixture', title: 'Набор', stickers: [sampleSticker] }],
};
async function expressions(pane: Pane, runtime: Runtime, work: (s: {
  props: Partial<Props>; now: number; height: number; zoom: number;
  start(target?: Element, fingers?: number): Promise<void>;
  move(y: number, x?: number, fingers?: number): Promise<void>;
  end(y: number, cancel?: boolean): Promise<void>;
}) => Promise<void>) {
  const saved: Array<() => void> = [];
  try {
    const patch = (target: object, key: string, descriptor: PropertyDescriptor) => {
      const old = Object.getOwnPropertyDescriptor(target, key);
      saved.push(() => { if (old) Object.defineProperty(target, key, old); else Reflect.deleteProperty(target, key); });
      Object.defineProperty(target, key, { configurable: true, ...descriptor });
    };
    const keys = ['gv_expr_tab', 'gv_kbd_height', 'gv_kbd_height_land'];
    for (const key of keys) {
      const old = localStorage.getItem(key);
      saved.push(() => { if (old === null) localStorage.removeItem(key); else localStorage.setItem(key, old); });
      localStorage.setItem(key, key === 'gv_expr_tab' ? 'stickers' : '400');
    }
    const oldZoom = document.documentElement.style.zoom;
    saved.push(() => { document.documentElement.style.zoom = oldZoom; });
    const { api } = await runtime.ssrLoadModule('/src/api.ts') as typeof import('../api');
    const oldGifs = api.gifs;
    const gifs = await runtime.ssrLoadModule('/src/savedGifs.ts') as typeof import('../savedGifs');
    const oldSaved = gifs.savedGifsNow();
    saved.push(() => gifs.setSavedGifs(oldSaved!)); // После unmount восстанавливаем в том числе исходный null кеша.
    api.gifs = async () => ({ gifs: [], search: true, limit: 10 }); saved.push(() => { api.gifs = oldGifs; });
    const { useDmStickers } = await runtime.ssrLoadModule('/src/dmStickers.ts') as typeof import('../dmStickers');
    const oldStickers = useDmStickers.getState();
    saved.push(() => useDmStickers.setState(oldStickers, true));
    useDmStickers.setState({ faved: [] });
    let now = 1000, height = 900, zoom = 2;
    patch(performance, 'now', { value: () => now });
    for (const key of ['offsetHeight', 'offsetTop', 'clientHeight'] as const) {
      const old = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
      patch(HTMLElement.prototype, key, { get() {
        const el = this as HTMLElement;
        if (key === 'clientHeight' && el.classList.contains('chat')) return height;
        if (key === 'offsetTop' && el.classList.contains('chat-top')) return 10;
        if (key === 'offsetTop' && el.classList.contains('channel-topbar')) return 5;
        if (key === 'offsetHeight') {
          if (el.classList.contains('channel-topbar')) return 45;
          if (el.classList.contains('composer')) return 50;
          if (el.classList.contains('reply-strip')) return 30;
        }
        return old?.get?.call(this) ?? 0;
      } });
    }
    const sendTouch = async (target: Element, type: string, y: number, x: number, fingers: number) => act(async () => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const point = { clientX: x, clientY: y };
      Object.defineProperties(event, {
        touches: { value: type === 'touchend' || type === 'touchcancel' ? [] : Array.from({ length: fingers }, () => point) },
        changedTouches: { value: [point] },
      });
      target.dispatchEvent(event);
    });
    const s = {
      props: { ...expressionProps },
      get now() { return now; }, set now(value: number) { now = value; },
      get height() { return height; }, set height(value: number) { height = value; },
      get zoom() { return zoom; }, set zoom(value: number) { zoom = value; document.documentElement.style.zoom = String(value); },
      start: (target = document.querySelector('.emoji-search')!, fingers = 1) => sendTouch(target, 'touchstart', 600, 100, fingers),
      move: (y: number, x = 100, fingers = 1) => sendTouch(panel()!, 'touchmove', y, x, fingers),
      end: (y: number, cancel = false) => sendTouch(panel()!, cancel ? 'touchcancel' : 'touchend', y, 100, 0),
    };
    s.zoom = zoom;
    await work(s);
  } finally { try { h.unmount(); } finally { for (const restore of saved.reverse()) restore(); } }
}
function chat() { return h.host.querySelector<HTMLElement>('.chat')!; }
function lift() { return Number.parseFloat(chat().style.getPropertyValue('--expr-lift')) || 0; }
async function tab(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent === label);
  assert.ok(button, 'вкладка доступна человеку');
  await act(async () => { button.click(); });
}
async function escape() {
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
}
it('ПК: наведение удерживает каждую настоящую вкладку и кнопку композера, чужая кнопка закрывает панель', async () => fixture(false, async (pane, runtime) => expressions(pane, runtime, async s => {
  const oldMedia = window.matchMedia;
  window.matchMedia = query => {
    const result = oldMedia(query);
    if (query === '(hover: hover) and (pointer: fine)') Object.defineProperty(result, 'matches', { value: true });
    return result;
  };
  const originalSet = window.setTimeout, originalClear = window.clearTimeout;
  const timers = new Map<number, { ms: number; run: () => void }>(); let id = -500;
  window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (typeof callback !== 'function' || (ms !== 200 && ms !== 300)) return originalSet(callback, ms, ...args);
    const key = id--; timers.set(key, { ms, run: () => callback(...args) }); return key;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((key: number) => { if (!timers.delete(key)) originalClear(key); }) as typeof window.clearTimeout;
  const tick = async (ms: number) => act(async () => {
    for (const [key, timer] of [...timers]) if (timer.ms === ms && timers.delete(key)) timer.run();
  });
  const mouse = async (target: Element) => act(async () => { target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); });
  const outside = document.createElement('button'); outside.className = 'att-btn emoji'; document.body.append(outside);
  try {
    for (const [name, selector] of [['emoji', '.emoji-pop'], ['stickers', '.sticker-pop'], ['gifs', '.gif-pop']]) {
      localStorage.setItem('gv_expr_tab', name); await h.mount(s.props, pane);
      await act(async () => { Simulate.mouseEnter(emoji()); }); await tick(200);
      const picker = document.querySelector(selector); assert.ok(picker, 'открылась последняя настоящая вкладка');
      assert.ok(document.body.classList.contains('expr-hover'));
      await mouse(outside); await mouse(picker.querySelector('input, button')!); await tick(300);
      assert.ok(picker.isConnected, 'переход с кнопки внутрь пикера отменяет закрытие');
      await mouse(outside); await mouse(emoji()); await tick(300);
      assert.ok(picker.isConnected, 'кнопка своего композера тоже удерживает панель');
      await mouse(outside); await tick(300);
      assert.equal(picker.isConnected, false, 'та же кнопка вне композера не удерживает панель');
      h.unmount();
    }
  } finally {
    h.unmount(); outside.remove(); timers.clear(); window.setTimeout = originalSet; window.clearTimeout = originalClear; window.matchMedia = oldMedia;
  }
})));
it('телефон: наборы, недавние и избранные разрешают подъём; пустой каталог и неподходящие касания его не начинают', async () => fixture(true, async (pane, runtime) => expressions(pane, runtime, async s => {
  const { useDmStickers } = await runtime.ssrLoadModule('/src/dmStickers.ts') as typeof import('../dmStickers');
  for (const source of ['empty', 'pack', 'recent', 'faved']) {
    s.props = { ...expressionProps, stickerPacks: source === 'pack' ? expressionProps.stickerPacks : [], stickerRecent: source === 'recent' ? [sampleSticker] : [] };
    useDmStickers.setState({ faved: source === 'faved' ? [sampleSticker] : [] });
    await open(pane, s.props);
    const grip = document.querySelector('.emoji-tabs, .emoji-search')!;
    if (source !== 'empty') {
      await s.start(document.querySelector('.sticker-grid .sticker-media')!); await s.move(400);
      assert.equal(chat().classList.contains('expr-dragging'), false, 'плитка не служит ручкой');
      await s.start(grip, 2); await s.move(400); assert.equal(lift(), 0, 'два пальца не начинают протяжку');
      await s.start(grip); await s.move(586); assert.equal(chat().classList.contains('expr-dragging'), false, '7 вёрсточных px ещё не захват');
      await s.move(584); assert.ok(chat().classList.contains('expr-dragging'), '8 px захватывают вертикаль'); assert.equal(lift(), 0, 'путь начинается с захвата');
      await s.move(384, 100, 2); assert.equal(lift(), 0, 'второй палец не двигает панель'); await s.end(384, true);
      await s.start(grip); await s.move(596, 120); await s.move(350); assert.equal(lift(), 0, 'горизонталь передаётся наборам до конца жеста');
    }
    await s.start(grip); await s.move(584); await s.move(384);
    assert.equal(lift(), source === 'empty' ? 0 : 100, 'каждый из трёх источников отдельно включает протяжку');
    await s.end(384, true); assert.equal(lift(), 0, 'отмена возвращает свёрнутое состояние');
    h.unmount();
  }
})));
it('телефон: геометрия подъёма учитывает zoom, шапку, margin и ответ; без места или шапки захвата нет', async () => fixture(true, async (pane, runtime) => expressions(pane, runtime, async s => {
  const { Icon } = await runtime.ssrLoadModule('/src/components/Icon.tsx') as typeof import('./Icon');
  const icon = () => emoji().querySelector('svg')!.innerHTML;
  const expected = (name: 'keyboard' | 'reaction') => {
    const box = document.createElement('div'); box.innerHTML = renderToStaticMarkup(createElement(Icon, { name, size: 19 })); return box.firstElementChild!.innerHTML;
  };
  await h.mount(s.props, pane); assert.equal(icon(), expected('reaction'));
  h.unmount(); await open(pane, { ...s.props, messages: [h.msg('reply')], draft: { text: '', replyToId: 'reply' } });
  assert.equal(icon(), expected('keyboard')); assert.equal((panel() as HTMLElement).style.height, '200px');
  h.host.querySelector<HTMLElement>('form.composer')!.style.marginBottom = '10px';
  assert.ok(h.host.querySelector('.reply-strip'), 'строка ответа реально участвует в геометрии');
  await s.start(); await s.move(584); await s.move(384);
  assert.equal(lift(), 100); assert.equal((panel() as HTMLElement).style.marginTop, '-100px');
  assert.equal(Number(h.host.querySelector<HTMLElement>('.expr-scrim')!.style.opacity), 100 / 544);
  await s.move(-2000);
  assert.equal(lift(), 544, '900 − (10+5+45) − (50+10+30) − 6 − 200');
  assert.equal((panel() as HTMLElement).style.height, '744px'); assert.equal((panel() as HTMLElement).style.marginTop, '-544px');
  assert.equal(h.host.querySelector<HTMLElement>('.expr-scrim')!.style.opacity, '1');
  assert.ok(chat().classList.contains('expr-up')); await s.end(-2000, true);
  s.height = 300; await s.start(); await s.move(584); assert.equal(chat().classList.contains('expr-dragging'), false);
  s.height = 900; const head = h.host.querySelector('.channel-topbar')!; const parent = head.parentNode!; const next = head.nextSibling;
  head.remove();
  try { await s.start(); await s.move(584); assert.equal(lift(), 0); assert.equal(chat().classList.contains('expr-dragging'), false); }
  finally { parent.insertBefore(head, next); }
  await escape(); assert.equal(icon(), expected('reaction'));
})));
it('телефон: эмодзи и закрытие сбрасывают раскрытие, GIF использует тот же подъём; текст блокирует только свёрнутую панель', async () => fixture(true, async (pane, runtime) => expressions(pane, runtime, async s => {
  await open(pane, s.props);
  const expand = async () => { await s.start(); await s.move(584); await s.move(0); s.now += 150; await s.end(0); assert.ok(lift() > 0); };
  await expand(); assert.equal(chat().classList.contains('expr-dragging'), false);
  await tab('Эмодзи'); assert.equal(lift(), 0); assert.equal(chat().classList.contains('expr-up'), false);
  await s.start(); await s.move(0); assert.equal(lift(), 0, 'эмодзи не раскрываются');
  await tab('GIF'); assert.ok(panel()!.querySelector('.gif-pop'));
  // Stub ответа включает поставщика: раскрытие идёт за настоящий поиск GIF.
  const grip = document.querySelector('.emoji-search, .emoji-tabs');
  assert.ok(grip, 'реальный GIF предоставляет ручку');
  await expand(); await escape(); assert.equal(panel(), null);
  await act(async () => { emoji().click(); }); assert.equal(lift(), 0); assert.equal(chat().classList.contains('expr-up'), false);
  await tab('Стикеры');
  await act(async () => { Simulate.change(field(), { target: { value: 'текст' } } as never); });
  await s.start(); await s.move(0); assert.equal(lift(), 0, 'текст запрещает захват свёрнутой панели');
  await act(async () => { Simulate.change(field(), { target: { value: '' } } as never); });
  await expand(); await act(async () => { Simulate.change(field(), { target: { value: 'текст' } } as never); });
  await s.start(); await s.move(616); await s.move(800); assert.ok(chat().classList.contains('expr-dragging'), 'раскрытую можно свернуть при тексте');
  await s.end(800, true); assert.ok(lift() > 0, 'отмена сохраняет исходное раскрытие');
})));
it('телефон: отпускание участвует в скорости, пауза старше 100 мс убирает бросок и старую историю', async () => fixture(true, async (pane, runtime) => expressions(pane, runtime, async s => {
  await open(pane, s.props);
  await s.start(); await s.move(584); s.now += 20; await s.end(578);
  assert.equal(lift(), 0, 'скорость отпускания делится на zoom: 150 px/с ещё не бросок');
  await s.start(); await s.move(584); s.now += 20; await s.end(564);
  assert.ok(lift() > 0, 'бросок при отпускании раскрывает даже без второго move');
  await tab('Эмодзи'); await tab('Стикеры');
  await s.start(); await s.move(584); s.now += 20; await s.move(464); s.now += 101; await s.end(464);
  assert.equal(lift(), 0, 'удержание гасит прежний быстрый ход');
  await s.start(); await s.move(584); s.now += 500; await s.move(584); s.now += 10; await s.move(580); s.now += 10; await s.end(576);
  assert.ok(lift() > 0, 'последние 100 мс дают бросок несмотря на старую неподвижную историю');
  await s.start(); await s.move(616); s.now += 20; await s.end(636);
  assert.equal(lift(), 0, 'скорость отпускания вниз сворачивает раскрытую панель');
})));
it('ПК: касания настоящего всплывающего пикера не дают телефонного подъёма', async () => fixture(false, async (pane, runtime) => expressions(pane, runtime, async s => {
  await open(pane, s.props);
  const search = document.querySelector('.emoji-search')!;
  await s.start(search); await act(async () => { h.touch(search, 'touchmove', 100, 0); h.touch(search, 'touchend', 100, 0); });
  assert.equal(panel(), null); assert.equal(chat().style.getPropertyValue('--expr-lift'), ''); assert.equal(chat().classList.contains('expr-up'), false);
})));


it('телефон: ожидание сохранённого места исключает обе компенсации высоты верха', async () => fixture(true, pane => measure(pane, true, true)));
it('телефон: обычная, поисковая и выбранная шапки остаются над капсулой незнакомца, плеера и закрепа', async () => fixture(true, async (pane, runtime) => {
  const voice = await runtime.ssrLoadModule('/src/voicePlayer.ts') as typeof import('../voicePlayer');
  const state = voice.getVoicePlayerState(), old = { ...state };
  state.track = { key: 'top-fixture', url: '', durationMs: 1000, source: { conversationId: 'c', messageId: 'top-row', mine: true, listened: true } };
  const props: Partial<Props> = { messages: [h.msg('top-row')], topBar: createElement('span', { className: 'top-fixture' }, 'Незнакомец'),
    pins: { list: [h.pin('top-row')], pin: async () => {}, unpin: async () => {} },
    batch: { forward: async () => {}, deleteMany: async () => {}, peerName: () => '', open: () => {} } };
  const capsule = () => {
    const top = h.host.querySelector('.chat-top')!; assert.ok(top.querySelector(':scope > .channel-topbar'));
    for (const selector of ['.top-fixture', '.voice-topbar', '.pin-bar']) assert.ok(top.querySelector('.top-capsule')!.querySelector(selector), `полоса ${selector} находится внутри общей капсулы`);
  };
  try {
    await h.mount(props, pane); capsule();
    await h.rerender({ ...props, chatSearch: { open: true, setOpen: () => {}, search: async () => ({ hits: [], total: 0, next: null }), jumpToDate: async () => null } }, pane);
    assert.ok(h.host.querySelector('.chat-top > .chat-search-head')); capsule();
    await h.rerender(props, pane);
    await act(async () => { h.host.querySelector('[data-mid="top-row"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    const select = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(b => b.textContent?.trim() === 'Выделить');
    assert.ok(select); await act(async () => { select.click(); });
    assert.ok(h.host.querySelector('.chat-top > .sel-head')); capsule();
  } finally { try { h.unmount(); } finally { Object.assign(state, old); } }
}));
it('телефон: реакции сообщения остаются всплывающими эмодзи без подъёма composer-панели', async () => fixture(true, async (pane, runtime) => expressions(pane, runtime, async s => {
  await h.mount({ ...s.props, messages: [h.msg('react-row')], onReact: () => {} }, pane);
  const more = h.host.querySelector<HTMLButtonElement>('[data-mid="react-row"] .react-bar-more'); assert.ok(more);
  await act(async () => { more.click(); }); assert.ok(document.querySelector('.emoji-pop')); assert.equal(panel(), null);
  const search = document.querySelector('.emoji-search')!;
  await s.start(search); await act(async () => { h.touch(search, 'touchmove', 100, 0); h.touch(search, 'touchend', 100, 0); });
  assert.equal(chat().style.getPropertyValue('--expr-lift'), ''); assert.equal(chat().classList.contains('expr-up'), false);
})));

const mutants = [
  { name: 'без stopPropagation Esc панели закрывает также беседу', phone: true, from: "if (e.key !== 'Escape' || document.querySelector(TOP_LAYERS)) return;\n      e.stopPropagation();\n      close();", to: "if (e.key !== 'Escape' || document.querySelector(TOP_LAYERS)) return;\n      close();", check: escapePanel },
  { name: 'немедленное закрытие панели на фокусе ловится до клавиатуры', phone: true, from: 'if (root.hasAttribute(\'data-kb\')) done();\n  }', to: 'done();\n  }', check: (pane: Pane) => focusDelay(pane) },
  { name: 'панель без проверки телефона ломает прежнее окно ПК', phone: false, from: "const exprUnder = dockPhone && picker?.kind === 'composer';", to: "const exprUnder = picker?.kind === 'composer';", check: pcPanel },
  { name: 'без сдвига прокрутки изменение высоты капсулы двигает строки', phone: true, from: 'list.scrollTop += d;', to: 'list.scrollTop += 0;', check: (pane: Pane) => measure(pane, true) },
  { name: 'R147 без отмены ожидания при закрытии старый таймер закрывает новую панель', phone: true,
    from: "// Панель закрылась (чем угодно) — ожидание её закрытия больше не нужно.\n      kbFromPanelRef.current?.cancel();",
    to: '// mutant: не отменяем ожидание первой панели', check: reopenedPanel },
];
for (const mutant of mutants) h.mutantTest(mutant.name, async () => {
  const active = mutantsEnabled() && process.env.GUSVOICE_PANE_MUTANT === mutant.name;
  const run = () => fixture(mutant.phone, pane => mutant.check(pane), active ? source => replaceOnce(source, mutant.from, mutant.to) : undefined);
  const expected = mutant.check === escapePanel ? 'Esc панели не закрывает беседу'
    : mutant.check === pcPanel ? 'ПК не получает телефонную панель'
    : mutant.check === reopenedPanel ? 'старый таймер не закрывает заново открытую панель'
    : mutant.name.includes('немедленное') ? 'фокус не закрывает панель немедленно'
    : 'рост капсулы сохраняет позицию строк';
  if (active) await assert.rejects(run, error => error instanceof assert.AssertionError && error.message.includes(expected));
  else await run();
});
