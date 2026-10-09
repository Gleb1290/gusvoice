import assert from 'node:assert/strict';
import { before, after, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { act } from 'react';
import * as jsx from 'react/jsx-runtime';
import { createPortal } from 'react-dom';
import type { Root } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { DmChannel } from '@gusvoice/shared';
import type { ShareChannel } from '../shareInbox';
import { DM_ROW_HOLD_MS } from '../dmListRules';
import * as rowRules from '../dmRowRules';
import * as sync from '../convSyncRules';
import * as listRules from '../dmListRules';
import type { ForwardPickerProps } from './ForwardPicker';

const raw = readFileSync(new URL('./ForwardPicker.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rowRaw = readFileSync(new URL('./ShareChannelRow.tsx', import.meta.url), 'utf8');
let createRoot: typeof import('react-dom/client')['createRoot'];
before(async () => { GlobalRegistrator.register(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // ChangeEventPlugin читает возможности DOM при импорте; импорт до регистрации окна выключает input в Node.
  createRoot = (await import('react-dom/client')).createRoot;
});
after(() => GlobalRegistrator.unregister());
function whole<T>(source: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
  { module, exports: module.exports, window, document, navigator, require: (id: string) => { assert.ok(id in deps, id); return deps[id]; } });
  return module.exports as T;
}
let root: Root | undefined, host: HTMLDivElement | undefined;
const h = {
  flush: async () => { await Promise.resolve(); },
  mount: async (props: ForwardPickerProps, Component: React.ComponentType<ForwardPickerProps>) => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(React.createElement(Component, props)));
  },
  unmount: async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); host = undefined; },
  touch: (target: Element, type: string, x: number, y: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] }); target.dispatchEvent(e);
  },
};
const channels: ShareChannel[] = [
  { id: 'ch-one', name: 'новости', serverId: 'sv', serverName: 'Северный сервер', serverIconUrl: null },
  { id: 'ch-two', name: 'обсуждение', serverId: 'sv2', serverName: 'Южный сервер', serverIconUrl: null },
];
async function scene(mode: 'channel' | 'saved' | 'multi' | 'hold' | 'search' | 'sections', source = raw) {
  const drafts: string[] = [], sends: string[][] = []; let closed = 0;
  const dm = (id: string, saved = false): DmChannel => ({ id, saved, createdAt: '2026-10-09T00:00:00Z', lastMessageAt: null,
    otherUser: { id: `peer-${id}`, username: id, displayName: `Беседа ${id}`, avatarUrl: null } } as DmChannel);
  const state = { dms: [dm('a'), dm('saved', true), dm('b')], currentDmId: 'a', convActive: false, serverFeatures: [],
    user: null, unreadDms: [], conv: sync.emptyConvState(), drafts: {}, outbox: {}, convOpenSaved: async () => {} };
  const { ShareChannelRow } = whole<{ ShareChannelRow: React.ComponentType }>(rowRaw, {
    react: React, 'react/jsx-runtime': jsx, '../dmListRules': listRules, '../dmListView': { DM_ROW_AVA: 40 },
    './Avatar': { Avatar: () => null }, './Icon': { Icon: () => null },
  });
  const { ForwardPicker } = whole<{ ForwardPicker: React.ComponentType<ForwardPickerProps> }>(source, {
    react: React, 'react/jsx-runtime': jsx, 'react-dom': { createPortal },
    '../store': { useStore: (select: (s: typeof state) => unknown) => select(state) },
    '../convSyncRules': sync, '../dmRowRules': rowRules, '../phoneLayout': { usePhoneLayout: () => false },
    '../peerName': { usePeerName: () => (id: string) => id, dmPeerLabel: (d: DmChannel) => d.otherUser.displayName },
    '../dmOnline': { useVisibleOnline: () => new Set<string>() }, '../dialogChrome': { useDialogChrome: () => React.useRef(null) },
    './BottomSheet': {}, './SchedPick': {}, './ContextMenu': {}, './Icon': { Icon: () => null }, './ShareChannelRow': { ShareChannelRow },
    // Внешняя строка беседы — адаптер тех же публичных onOpen/onPick; выбор и сортировку считает настоящий picker.
    './DmSidebar': { DmRow: (p: { dm: DmChannel; selecting: boolean; picked: boolean; onOpen: (id: string) => void; onPick: (id: string) => void; onMenu?: (dm: DmChannel) => void }) =>
      React.createElement('button', { className: 'dm-row', 'aria-checked': p.selecting ? p.picked : undefined,
        onClick: () => (p.selecting ? p.onPick : p.onOpen)(p.dm.id), onContextMenu: () => p.onMenu?.(p.dm) }, p.dm.saved ? 'Избранное' : p.dm.otherUser.displayName) },
  });
  try {
    await h.mount({ count: 1, share: { title: 'Поделиться в…', head: 'текст', channels },
      onDraft: (id: string) => drafts.push(id), onSend: (ids: string[]) => sends.push([...ids]), onClose: () => { closed++; } } as never, ForwardPicker);
    const row = (id: string) => {
      if (id.startsWith('ch-')) return document.querySelector<HTMLButtonElement>(`.share-ch[aria-label^="#${channels.find(c=>c.id===id)!.name}"]`)!;
      return [...document.querySelectorAll<HTMLButtonElement>('.fwd-modal .dm-row:not(.share-ch)')].find(r => id === 'saved' ? r.textContent?.includes('Избранное') : r.textContent?.includes(`Беседа ${id}`))!;
    };
    if (mode === 'channel' || mode === 'saved') {
      const id = mode === 'channel' ? 'ch-one' : 'saved'; assert.ok(row(id));
      await act(async () => { row(id).click(); await h.flush(); });
      assert.deepEqual(drafts, [id], 'share первым нажатием отдаёт черновик даже в Избранное');
      assert.deepEqual(sends, [], 'share не отправляется мгновенно'); assert.equal(closed, 1); return;
    }
    if (mode === 'multi') {
      await act(async () => { row('ch-two').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
      assert.equal(row('ch-two').getAttribute('aria-checked'), 'true');
      for (const id of ['b', 'ch-one', 'a']) await act(async () => { row(id).click(); await h.flush(); });
      await act(async () => { row('ch-one').click(); await h.flush(); });
      assert.equal(row('ch-one').getAttribute('aria-checked'), 'false', 'дальше нажатие снимает выбор');
      await act(async () => { row('ch-one').click(); await h.flush(); });
      assert.deepEqual(drafts, []);
      const send = document.querySelector<HTMLButtonElement>('.fwd-send'); assert.equal(send?.textContent, 'Отправить (4)');
      await act(async () => { send!.click(); send!.click(); await h.flush(); });
      assert.deepEqual(sends, [['a', 'b', 'ch-one', 'ch-two']], 'беседы по списку, затем каналы по списку, не по кликам');
      assert.equal(closed, 1); return;
    }
    if (mode === 'hold') {
      const originalSet = window.setTimeout, originalClear = window.clearTimeout;
      let hold: (() => void) | undefined;
      window.setTimeout = ((fn: () => void, ms?: number) => {
        if (ms === DM_ROW_HOLD_MS) { hold = fn; return -123; }
        return originalSet.call(window, fn, ms);
      }) as typeof window.setTimeout;
      window.clearTimeout = ((id: number) => { if (id === -123) return; originalClear.call(window, id); }) as typeof window.clearTimeout;
      try {
        await act(async () => { h.touch(row('ch-one'), 'touchstart', 10, 10); assert.ok(hold, 'таймер удержания установлен'); hold!(); await h.flush(); });
        assert.equal(row('ch-one').getAttribute('aria-checked'), 'true', 'удержание отмечает канал');
        await act(async () => { h.touch(row('ch-one'), 'touchend', 10, 10); row('ch-one').click(); await h.flush(); });
        assert.equal(row('ch-one').getAttribute('aria-checked'), 'true', 'щелчок после удержания не снимает отметку');
        assert.deepEqual(drafts, []); assert.deepEqual(sends, []); return;
      } finally { window.setTimeout = originalSet; window.clearTimeout = originalClear; }
    }
    const search = async (value: string) => {
      const input = document.querySelector<HTMLInputElement>('.fwd-pick > input')!;
      // VM-компонент и Node React не разделяют браузерный ChangeEventPlugin: вызываем настоящий обработчик
      // на DOM-узле, не подменяя фильтрацию и не извлекая функцию из исходника.
      const key = Object.keys(input).find(k => k.startsWith('__reactProps$')); assert.ok(key);
      const props = (input as unknown as Record<string, { onChange: (e: { target: { value: string } }) => void }>)[key]!;
      await act(async () => { props.onChange({ target: { value } }); await h.flush(); });
      assert.equal(input.value, value, 'настоящее состояние поля обновилось');
    };
    const shown = () => [...document.querySelectorAll('.share-ch')].map(e => e.getAttribute('aria-label'));
    if (mode === 'search') {
      await search('нов'); assert.deepEqual(shown(), ['#новости, Северный сервер'], 'каналы фильтруются по имени');
      await search('юж'); assert.deepEqual(shown(), ['#обсуждение, Южный сервер'], 'каналы фильтруются по серверу');
      await search('не найдено'); assert.deepEqual(shown(), []); return;
    }
    assert.deepEqual([...document.querySelectorAll('.mp-head')].map(e => e.textContent), ['Беседы', 'Каналы']);
    await search('нов'); assert.equal(document.querySelectorAll('.mp-head').length, 0, 'только каналы — разделители не нужны');
    await search('Беседа'); assert.equal(document.querySelectorAll('.mp-head').length, 0, 'только беседы — разделители не нужны');
  } finally { await h.unmount(); }
}

for (const mode of ['channel', 'saved', 'multi', 'hold', 'search', 'sections'] as const) {
  it(`R128 share picker: ${ { channel: 'канал сначала открывает черновик', saved: 'Избранное не отправляет сразу', multi: 'выбор переключается и отправляется по списку', hold: 'удержание отмечает без черновика', search: 'поиск по каналу и серверу', sections: 'заголовки только при обоих видах' }[mode] }`, async () => scene(mode));
}
for (const [name, mode, change, message] of [
  ['без режима share у Избранного', 'saved', (s: string) => s.replace('shareRef.current ? undefined : dmsRef.current.find', 'dmsRef.current.find'), 'отдаёт черновик'],
  ['без порядка каналов', 'multi', (s: string) => s.replace('order.set(c.id, dmsRef.current.length + i);', 'void c;'), 'каналы по списку'],
  ['без фильтра каналов', 'search', (s: string) => s.replace('!q || matchDmName(c.name, q) || matchDmName(c.serverName, q)', 'true'), 'фильтруются'],
] as const) {
  it(`R128 мутант picker ${name} отвергается поведением`, async () => {
    await scene(mode); const mutant = change(raw); assert.notEqual(mutant, raw);
    await assert.rejects(scene(mode, mutant), (e: unknown) => e instanceof assert.AssertionError && e.message.includes(message));
  });
}
