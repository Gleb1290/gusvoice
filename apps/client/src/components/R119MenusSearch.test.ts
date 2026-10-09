import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createElement, act, useState } from 'react';
import { setupHarness } from './MessagePane.behavior.harness';
import { DM_ROW_HOLD_MS } from '../dmListRules';

const h = setupHarness(import.meta.url);
const dm = { id: 'friend', otherUser: { id: 'peer', username: 'peer', displayName: 'Друг', avatarUrl: null }, createdAt: '2026-10-01T00:00:00Z', lastMessageAt: '2026-10-09T00:00:00Z', unread: 0 };

async function home(server = h.server, frequent = true, hold = false) {
  h.desktop();
  const { DmSearchHome } = await server.ssrLoadModule('/src/components/DmListSearch.tsx') as typeof import('./DmListSearch');
  const hidden: string[] = [], opened: string[] = [];
  const Component = () => createElement(DmSearchHome, {
    dms: [dm], recents: [{ kind: 'query', text: 'запрос' }],
    onPerson: (d: { id: string }) => { opened.push(d.id); }, onQuery() {}, onRemove() {}, onClear() {},
    ...(frequent ? { frequent: { items: [{ conversationId: 'friend', lastAt: '2026-10-09T00:00:00Z', score: 1 }], hidden: {}, blockedIds: new Set<string>(), onHide: (id: string) => { hidden.push(id); } } } : {}),
  });
  try {
    await h.mount({}, Component as never); await h.flush();
    assert.deepEqual([...document.querySelectorAll('.dms-home section')].map(x => x.getAttribute('aria-label')), [frequent ? 'Частые' : 'Люди', 'Недавние'], 'полоса людей/частых перед недавними');
    const person = document.querySelector<HTMLElement>('.dms-person'); assert.ok(person);
    if (!frequent) {
      await act(async () => { person.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); person.click(); });
      assert.equal(document.querySelector('.ctx-menu'), null, 'без freq1 удаления из частых нет');
      assert.deepEqual(opened, ['friend']); return;
    }
    if (hold) {
      const oldSet = window.setTimeout, oldClear = window.clearTimeout;
      let fire: (() => void) | undefined;
      window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (ms === DM_ROW_HOLD_MS && typeof fn === 'function') { fire = () => fn(...args); return -123; }
        return (oldSet.bind(window) as unknown as (handler: TimerHandler, delay?: number, ...rest: unknown[]) => number)(fn, ms, ...args);
      }) as typeof window.setTimeout;
      window.clearTimeout = ((id: number) => { if (id !== -123) oldClear.call(window, id); }) as typeof window.clearTimeout;
      try {
        await act(async () => {
          const event = new Event('touchstart', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'touches', { value: [{ clientX: 50, clientY: 60 }] }); person.dispatchEvent(event);
          assert.ok(fire, 'удержание ставит таймер'); fire();
        });
      } finally { window.setTimeout = oldSet; window.clearTimeout = oldClear; }
      await act(async () => person.click());
      assert.equal(opened.length, 0, 'удержание не открывает беседу');
    } else await act(async () => person.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 60 })));
    const remove = [...document.querySelectorAll<HTMLElement>('.ctx-menu button')].find(e => e.textContent?.includes('Убрать из частых'));
    assert.ok(remove, 'меню предлагает убрать из частых');
    await act(async () => remove.click());
    assert.deepEqual(hidden, ['friend'], 'удаляется именно выбранная беседа');
    assert.equal(document.querySelector('.ctx-menu'), null);
  } finally { h.unmount(); }
}
it('R119 Частые перед Недавними; ПКМ убирает выбранную беседу', async () => home());
it('R119 без freq1 показаны Люди и обычный клик открывает беседу', async () => home(h.server, false));
it('R119 удержание открывает удаление из Частых и подавляет клик', async () => home(h.server, true, true));

async function frequentScene(server = h.server) {
  const { useFrequent } = await server.ssrLoadModule('/src/components/DmListSearch.tsx');
  const { api } = await server.ssrLoadModule('/src/api.ts');
  const old = api.convFrequent; let requests = 0;
  const item = { conversationId: 'friend', lastAt: '2026-10-09T00:00:00Z', score: 1 };
  api.convFrequent = async () => { if (++requests > 1) throw Object.assign(new Error('429'), { status: 429 }); return { items: [item] }; };
  let setActive: (active: boolean) => void = () => {};
  const Probe = () => { const [active, update] = useState(true); setActive = update; return createElement('output', null, JSON.stringify(useFrequent(true, active))); };
  try {
    await h.mount({}, Probe as never); await h.flush();
    assert.equal(document.querySelector('output')?.textContent, JSON.stringify([item]));
    await act(async () => { setActive(false); await h.flush(); });
    await act(async () => { setActive(true); await h.flush(); });
    assert.equal(requests, 2, 'повторная активация делает новый запрос');
    assert.equal(document.querySelector('output')?.textContent, JSON.stringify([item]), '429 оставляет прежнюю полосу');
  } finally { h.unmount(); api.convFrequent = old; }
}
it('R119 повтор Частых с 429 сохраняет прежнюю полосу', async () => {
  await frequentScene();
  const server = await h.paneServer(s => s.replace('setItems((prev) => (prev && prev.length > 0 ? prev : undefined))', 'setItems(undefined)'), 'DmListSearch');
  try { await assert.rejects(() => frequentScene(server), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('429 оставляет прежнюю полосу')); }
  finally { await server.close(); }
});

async function fitScene(server = h.server) {
  h.desktop(); const { ContextMenu } = await server.ssrLoadModule('/src/components/ContextMenu.tsx');
  try {
    for (const fit of [false, true]) {
      const Component = () => createElement(ContextMenu, { pos: { x: 40, y: 50 }, width: 232, fit, onClose() {} }, 'Длинный пункт меню');
      await h.mount({}, Component as never); await h.flush();
      const menu = document.querySelector<HTMLElement>('.ctx-menu'); assert.ok(menu);
      assert.equal(menu.style.width, fit ? 'max-content' : '232px', 'fit не фиксирует ширину в px');
      assert.equal(menu.style.minWidth, fit ? '232px' : '');
      assert.equal(menu.style.maxWidth, fit ? 'calc(var(--vw-px, 100vw) - 16px)' : '');
      h.unmount();
    }
  } finally { h.unmount(); }
}
it('R119 ContextMenu fit растёт по содержимому, без fit сохраняет заданную ширину', async () => {
  await fitScene();
  const server = await h.paneServer(s => s.replace('const menuWidth: CSSProperties = fit', 'const menuWidth: CSSProperties = false'), 'ContextMenu');
  try { await assert.rejects(() => fitScene(server), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('fit не фиксирует ширину в px')); }
  finally { await server.close(); }
});

async function emojiScene(server = h.server) {
  h.desktop();
  const { EmojiPicker } = await server.ssrLoadModule('/src/components/EmojiPicker.tsx') as typeof import('./EmojiPicker');
  const composer = document.createElement('div'); composer.className = 'composer';
  const anchorEl = document.createElement('button'); composer.append(anchorEl); document.body.append(composer);
  let top = 600;
  composer.getBoundingClientRect = () => new DOMRect(30, top, 400, 700 - top);
  anchorEl.getBoundingClientRect = () => new DOMRect(50, 660, 32, 32);
  const oldRo = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const oldWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const oldHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const oldClientWidth = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
  const oldClientHeight = Object.getOwnPropertyDescriptor(document.documentElement, 'clientHeight');
  const oldViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  const observers: Array<{ target?: Element; callback: () => void; disconnected: boolean }> = [];
  class Observer {
    target?: Element; disconnected = false;
    constructor(readonly callback: () => void) { observers.push(this); }
    observe(target: Element) { this.target = target; }
    disconnect() { this.disconnected = true; }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: Observer });
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1000 });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: null });
  // HappyDOM не рассчитывает layout: только размеры браузерной границы подменены;
  // живой компонент и placeByAnchor исполняются целиком.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return this.classList.contains('emoji-pop') ? 200 : 0; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('emoji-pop') ? 120 : 0; } });
  const Component = () => createElement(EmojiPicker, { anchor: new DOMRect(50, 660, 32, 32), anchorEl, onPick() {}, onClose() {} });
  try {
    await h.mount({}, Component as never); await h.flush();
    const panel = document.querySelector<HTMLElement>('.emoji-pop'); assert.ok(panel);
    assert.equal(parseFloat(panel.style.top), 472, 'панель стоит над живым composer, а не снимком кнопки');
    top = 520;
    await act(async () => { for (const o of observers) if (o.target === composer) o.callback(); });
    assert.equal(parseFloat(panel.style.top), 392, 'ResizeObserver сдвигает панель после роста composer');
  } finally {
    h.unmount(); composer.remove();
    for (const [target, key, old] of [[globalThis, 'ResizeObserver', oldRo], [HTMLElement.prototype, 'offsetWidth', oldWidth], [HTMLElement.prototype, 'offsetHeight', oldHeight], [document.documentElement, 'clientWidth', oldClientWidth], [document.documentElement, 'clientHeight', oldClientHeight], [window, 'visualViewport', oldViewport]] as const) {
      if (old) Object.defineProperty(target, key, old); else Reflect.deleteProperty(target, key);
    }
  }
  assert.ok(observers.every(o => o.disconnected), 'наблюдатель отключён после размонтирования');
}
it('R119 EmojiPicker следует за ростом живого composer и отключает ResizeObserver', async () => {
  await emojiScene();
  for (const [change, failure] of [
    [(s: string) => s.replace('if (field) ro?.observe(field);', 'void field;'), 'ResizeObserver сдвигает панель после роста composer'],
    [(s: string) => s.replace('toLayoutRect(liveAnchor(anchor, anchorEl))', 'toLayoutRect(anchor)'), 'панель стоит над живым composer, а не снимком кнопки'],
  ] as const) {
    const server = await h.paneServer(change, 'EmojiPicker', true);
    try { await assert.rejects(() => emojiScene(server), (e: unknown) => e instanceof assert.AssertionError && e.message.includes(failure)); }
    finally { await server.close(); }
  }
});
