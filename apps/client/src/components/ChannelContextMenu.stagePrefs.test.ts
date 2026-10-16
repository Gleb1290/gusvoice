import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { has, Permission, permsFromString, type Channel } from '@gusvoice/shared';
import * as stageOrderRules from '../stageOrderRules';
import type { useChannelContextMenu } from './ChannelContextMenu';

const source = readFileSync(new URL('./ChannelContextMenu.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const prefsSource = readFileSync(new URL('../stageViewPrefs.ts', import.meta.url), 'utf8');
const menuSource = readFileSync(new URL('./ContextMenu.tsx', import.meta.url), 'utf8');
const label = 'Скрыть участников без видео';
const noop = () => {};
const channel = (type: Channel['type'], id: string = type): Channel => ({
  id, type, serverId: 'server', categoryId: null, name: 'Канал', position: 0, topic: null,
  syncedToCategory: true, icon: null, isPrivate: false, generalUserId: null, sounds: {}, voiceBitrate: null,
});

function load<T>(raw: string, deps: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  // Целые производственные модули; никаких вырезанных и исполняемых тел функций.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, console, ...globals,
    require: (id: string) => deps[id] ?? new Proxy({}, { get: (_target, key) => {
      throw new Error(`Неописанная граница ${id}.${String(key)}`);
    } }),
  });
  return module.exports as T;
}

async function fixture(check: (f: {
  host: HTMLDivElement; writes: boolean[]; storage: Map<string, string>; resets: string[];
  orders(): stageOrderRules.StageOrders;
  open(type: Channel['type'], id?: string): Promise<void>; category(): Promise<void>;
  click(): Promise<void>; external(hide: boolean): Promise<void>; item(): HTMLButtonElement | undefined;
  resetItem(): HTMLButtonElement | undefined;
}) => Promise<void>, raw = source, hide = false, savedChannels: string[] = [],
  savedOrders: stageOrderRules.StageOrders = {}) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const storage = new Map<string, string>(hide ? [['gv_stage_hide_novideo', '1']] : []);
  const writes: boolean[] = [];
  const saved = new Set(savedChannels); const resets: string[] = [];
  let orders = savedOrders;
  const forbidden = () => { throw new Error('Локальная настройка не вызывает API, вход в канал или подтверждение'); };
  const state = { bootstrap: { permissions: '0', channels: [], categories: [] }, user: { id: 'self' }, voice: null,
    openChannel: forbidden, joinVoice: forbidden };
  const deps = { react: React, 'react/jsx-runtime': jsx };
  const prefs = load<typeof import('../stageViewPrefs')>(prefsSource, deps, { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } });
  const icon = ({ name }: { name: string }) => React.createElement('i', { 'data-icon': name });
  const menu = load<typeof import('./ContextMenu')>(menuSource, { ...deps, './Icon': { Icon: icon } });
  let actions: ReturnType<typeof useChannelContextMenu>;
  try {
    const module = load<{ useChannelContextMenu: typeof useChannelContextMenu }>(raw, {
      ...deps, '@gusvoice/shared': { has, Permission, permsFromString },
      '../stageViewPrefs': { ...prefs, setHideNoVideo: (next: boolean) => { writes.push(next); prefs.setHideNoVideo(next); } },
      '../stageOrderRules': stageOrderRules,
      '../stageOrderPrefs': { useStageOrder: () => null, saveStageOrder: noop,
        useHasStageOrder: (id: string | null) => !!id && (saved.has(id) || !!orders[id]),
        resetStageOrder: (id: string) => { resets.push(id); saved.delete(id); orders = stageOrderRules.dropStageOrders(orders, id); } },
      '../useStageDrag': { useStageDrag: () => ({ preview: null, dragging: false,
        nestRef: { current: null }, onPointerDown: noop }) },
      '../store': { useStore: Object.assign((select: (s: typeof state) => unknown) => select(state),
        { getState: () => state, setState: forbidden }) },
      '../channelPrefs': { useChannelPrefsVersion: noop, notifyLevel: () => 'all', setNotifyLevel: forbidden,
        isCategoryCollapsed: () => false, toggleCategoryCollapse: forbidden },
      '../api': { api: new Proxy({}, { get: () => forbidden }) }, '../confirm': { confirmAction: forbidden },
      '../toast': { toast: forbidden, toastError: forbidden }, './Icon': { Icon: icon },
      './ContextMenu': { ...menu,
        // Подменена только оболочка позиционирования/портала. MenuItem и хук меню настоящие.
        ContextMenu: ({ children, fit }: { children: React.ReactNode; fit?: boolean }) => React.createElement('div',
          { className: 'ctx-menu', 'data-fit': String(!!fit) }, children),
      },
    }, { location: window.location });
    function Probe() {
      actions = module.useChannelContextMenu();
      const current = prefs.useHideNoVideo();
      return React.createElement(React.Fragment, null, actions.menus,
        React.createElement('output', { 'data-preference': String(current) }));
    }
    await React.act(async () => { root.render(React.createElement(Probe)); });
    const event = () => ({ preventDefault: noop, stopPropagation: noop, clientX: 100, clientY: 100 }) as React.MouseEvent;
    const item = () => [...host.querySelectorAll<HTMLButtonElement>('.ctx-item')]
      .find(button => button.querySelector('.ctx-label-main')?.textContent === label);
    const resetItem = () => [...host.querySelectorAll<HTMLButtonElement>('.ctx-item')]
      .find(button => button.querySelector('.ctx-label-main')?.textContent === 'Сбросить раскладку плиток');
    await check({ host, writes, storage, item, resetItem, resets, orders: () => orders,
      open: async (type, id) => { await React.act(async () => { actions.openChannelMenu(event(), channel(type, id)); }); },
      category: async () => { await React.act(async () => { actions.openCategoryMenu(event(),
        { id: 'category', serverId: 'server', name: 'Категория', position: 0 }); }); },
      click: async () => { const button = item(); assert.ok(!!button, 'пункт существует до нажатия');
        await React.act(async () => { button!.click(); }); },
      external: async next => { await React.act(async () => { prefs.setHideNoVideo(next); }); },
    });
  } finally {
    await React.act(async () => { root.unmount(); });
    host.remove(); await GlobalRegistrator.unregister();
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}

async function stateShown(hide: boolean, raw = source) {
  await fixture(async ({ open, item }) => {
    await open('voice'); const button = item();
    assert.ok(!!button, 'голосовое меню содержит локальный видовой пункт без прав управления');
    assert.equal(button!.classList.contains('active'), hide);
    assert.equal(button!.querySelector('[data-icon]')?.getAttribute('data-icon'), hide ? 'check' : 'camera-off');
    assert.equal(button!.querySelector('.ctx-sublabel')?.textContent, 'только для вас');
    assert.equal(button!.classList.contains('danger'), false);
  }, raw, hide);
}
async function resetVisibility(raw = source) {
  // Сброс доступен лишь там, где есть раскладка голосовой сцены; чужой канал не считается своим.
  await fixture(async ({ open, category, resetItem }) => {
    await open('voice', 'saved-voice'); assert.equal(!!resetItem(), true);
    await open('voice', 'plain-voice'); assert.equal(!!resetItem(), false);
    await open('text', 'saved-text'); assert.equal(!!resetItem(), false);
    await category(); assert.equal(!!resetItem(), false);
  }, raw, false, ['saved-voice', 'saved-text']);
}
it('R169 сброс раскладки есть только у голосового канала с сохранённым порядком', () => resetVisibility());
async function resetClick(raw = source) {
  // Замыкание меню должно сохранять id выбранного канала, не текущий голосовой канал или соседний пункт.
  await fixture(async ({ open, host, resetItem, resets }) => {
    await open('voice', 'voice-b');
    assert.equal(resetItem()?.querySelector('.ctx-sublabel')?.textContent, 'при всех ширинах окна');
    assert.equal(resetItem()?.querySelector('[data-icon]')?.getAttribute('data-icon'), 'reset');
    await React.act(async () => { resetItem()!.click(); });
    assert.deepEqual(resets, ['voice-b']); assert.equal(!!host.querySelector('.ctx-menu'), false);
    await open('voice', 'voice-b'); assert.equal(!!resetItem(), false);
    await open('voice', 'voice-a'); assert.equal(!!resetItem(), true, 'соседняя раскладка не сброшена');
  }, raw, false, ['voice-a', 'voice-b']);
}
it('R169 сброс передаёт id меню, закрывает его и не сбрасывает другой канал', () => resetClick());
it('R246 запись только режимов даёт пункт сброса, который удаляет все раскладки лишь выбранного канала', () => fixture(async ({ open, resetItem, resets, orders }) => {
  await open('voice', 'mode-only');
  assert.ok(resetItem(), 'режимы просмотра сами по себе являются сохранённой раскладкой');
  await React.act(async () => { resetItem()!.click(); });
  assert.deepEqual(resets, ['mode-only']);
  assert.deepEqual(orders(), { other: { at: 2, cols: { 3: ['p:other'] }, modes: { 'watch-people': ['p:other'] } } },
    'сброс убирает modes и cols текущего канала, соседний канал остаётся целиком');
}, source, false, [], {
  'mode-only': { at: 1, cols: {}, modes: { 'watch-streams': ['s:one'] } },
  other: { at: 2, cols: { 3: ['p:other'] }, modes: { 'watch-people': ['p:other'] } },
}));
it('R169 мутант безусловного пункта сброса обнаруживается на несохранённом канале', async () => {
  const anchor = "c.type === 'voice' && hasStageOrder &&";
  assert.equal(source.split(anchor).length - 1, 1); await resetVisibility();
  await assert.rejects(() => resetVisibility(source.replace(anchor, "c.type === 'voice' &&")), assert.AssertionError);
});
it('R169 мутант сброса чужого id обнаруживается нажатием настоящего пункта', async () => {
  const anchor = 'resetStageOrder(c.id)';
  assert.equal(source.split(anchor).length - 1, 1); await resetClick();
  await assert.rejects(() => resetClick(source.replace(anchor, "resetStageOrder('voice-a')")), assert.AssertionError);
});
it('R167 выключенная настройка доступна в голосовом меню без прав управления', () => stateShown(false));
it('R167 включённая настройка отмечена тем же active и галочкой в меню', () => stateShown(true));

async function noText(raw = source) {
  await fixture(async ({ open, item, host }) => {
    await open('text'); assert.equal(!!host.querySelector('.ctx-menu'), true);
    assert.equal(!!item(), false, 'у текстового канала нет настройки голосовой сцены');
  }, raw);
}
it('R167 текстовое меню не получает переключатель голосовой сцены', () => noText());
it('R167 меню категории не получает переключатель голосовой сцены', () => fixture(async ({ category, item, host }) => {
  await category(); assert.equal(!!host.querySelector('.ctx-menu'), true); assert.equal(!!item(), false);
}));

async function toggle(raw = source) {
  for (const hide of [false, true]) await fixture(async ({ open, click, writes, host, storage }) => {
    await open('voice'); await click();
    assert.deepEqual(writes, [!hide], 'нажатие передаёт противоположный текущему выбор');
    assert.equal(host.querySelector('output')?.getAttribute('data-preference'), String(!hide), 'вторая подписка меняется сразу');
    assert.equal(storage.get('gv_stage_hide_novideo') ?? null, hide ? null : '1');
    assert.equal(!!host.querySelector('.ctx-menu'), false, 'после переключения меню закрыто');
  }, raw, hide);
}
it('R167 нажатие в обе стороны меняет общую настройку и закрывает меню без API', () => toggle());
it('R167 смена общей настройки извне обновляет уже открытое меню сразу', () => fixture(async ({ open, external, item, writes }) => {
  await open('voice'); await external(true);
  assert.equal(item()!.classList.contains('active'), true);
  assert.equal(item()!.querySelector('[data-icon]')?.getAttribute('data-icon'), 'check');
  await external(false); assert.equal(item()!.classList.contains('active'), false); assert.deepEqual(writes, []);
}));
it('R167 повторное открытие после внешней смены использует новый выбор, а не снимок прошлого меню', () => fixture(async ({ open, click, external, item }) => {
  await open('voice'); await click(); await external(false); await open('voice');
  assert.equal(item()!.classList.contains('active'), false);
}));
it('R167 настройка общая для голосовых каналов, а не привязана к нажатой строке', () => fixture(async ({ open, click, item, storage }) => {
  await open('voice', 'voice-first'); await click(); await open('voice', 'voice-second');
  assert.equal(item()!.classList.contains('active'), true); assert.deepEqual([...storage.keys()], ['gv_stage_hide_novideo']);
}));
it('R167 пункт вида стоит сразу после входа в канал, перед уведомлениями и опасными действиями', () => fixture(async ({ open, host }) => {
  await open('voice'); const labels = [...host.querySelectorAll('.ctx-item .ctx-label-main')].map(el => el.textContent);
  assert.deepEqual(labels.slice(0, 3), ['Войти в канал', label, 'Все сообщения']);
}));
it('R167 голосовое меню подстраивается под длинную подпись, текстовое сохраняет прежнюю ширину', () => fixture(async ({ open, host }) => {
  // ctx-label-main использует nowrap/ellipsis: без fit новая длинная подпись режется при крупном шрифте.
  await open('voice'); assert.equal(host.querySelector('.ctx-menu')?.getAttribute('data-fit'), 'true');
  await open('text'); assert.equal(host.querySelector('.ctx-menu')?.getAttribute('data-fit'), 'false');
}));

function mutate(before: string, after: string) {
  assert.equal(source.split(before).length - 1, 1, 'один точный якорь мутации');
  return source.replace(before, after);
}
it('R167 мутант пункта у текстовых каналов обнаруживается парной проверкой', async () => {
  await noText();
  await assert.rejects(() => noText(mutate("{c.type === 'voice' && (\n        <MenuItem\n          icon={hideNoVideo", "{c && (\n        <MenuItem\n          icon={hideNoVideo")), assert.AssertionError);
});
it('R167 мутант инверсии состояния отметки обнаруживается обеими сторонами выбора', async () => {
  await stateShown(false); await stateShown(true);
  await assert.rejects(() => stateShown(false, mutate('active={hideNoVideo}', 'active={!hideNoVideo}')), assert.AssertionError);
});
it('R167 мутант повторной записи того же выбора вместо переключения обнаруживается', async () => {
  await toggle();
  await assert.rejects(() => toggle(mutate('setHideNoVideo(!hideNoVideo);', 'setHideNoVideo(hideNoVideo);')), assert.AssertionError);
});
