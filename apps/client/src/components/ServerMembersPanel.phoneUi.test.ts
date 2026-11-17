import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as status from '../status';
import * as dmRules from '../dmRules';

const panelSource = readFileSync(new URL('./ServerMembersPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const phoneSource = readFileSync(new URL('../phoneLayout.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const P = 'R345 участники: ';
type Sources = { panel: string; phone: string };
type Edit = { target: keyof Sources; from: string; to: string };
type Point = { width: number; mobile?: boolean; tauri?: boolean };
type Fixture = { host: HTMLElement; closed: boolean[]; state: Record<string, unknown>; resize(width: number): Promise<void> };
const original: Sources = { panel: panelSource, phone: phoneSource };
const empty = () => null;

async function fixture(point: Point, source: Sources, check: (f: Fixture) => Promise<void> | void): Promise<number> {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const actMode = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let width = point.width;
  const queries = new Map<string, { media: string; readonly matches: boolean; addEventListener(type: string, fn: () => void): void;
    removeEventListener(type: string, fn: () => void): void; listeners: Set<() => void> }>();
  window.matchMedia = ((query: string) => {
    let media = queries.get(query);
    if (!media) {
      const listeners = new Set<() => void>();
      media = { media: query, get matches() { const limit = /^\(max-width:\s*(\d+)px\)$/.exec(query); return !!limit && width <= Number(limit[1]); },
        listeners, addEventListener(type, fn) { if (type === 'change') listeners.add(fn); }, removeEventListener(type, fn) { if (type === 'change') listeners.delete(fn); } };
      queries.set(query, media);
    }
    return media as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  const closed: boolean[] = [];
  const member = (id: string, bot = false) => ({ user: { id, bot, username: id, displayName: id, status: 'online', avatarUrl: null }, nickname: null, roleIds: [] });
  const state: Record<string, unknown> = { bootstrap: { server: { id: 'server' } }, onlineUsers: ['peer'], userStatuses: {}, userActivities: {}, user: { id: 'me' },
    members: [member('peer'), member('offline'), member('helper', true)], mobileMembersOpen: true, mobilePane: 'content', mobileProfileOpen: true,
    settingsOpen: true, currentChannelId: 'channel', openDmWith: async () => {}, setMobileMembersOpen: (open: boolean) => { closed.push(open); state.mobileMembersOpen = open; } };
  function load<T>(text: string, fileName: string, deps: Record<string, unknown>): T {
    const module = { exports: {} };
    const compiled = ts.transpileModule(text, { fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    runInNewContext(compiled, { module, exports: module.exports, window, document,
      require(id: string) { if (!Object.hasOwn(deps, id)) throw Error(`R345 setup: неописанный импорт ${id}`); return deps[id]; } }, { filename: fileName });
    return module.exports as T;
  }
  try {
    const hotkeys = { isMobile: () => !!point.mobile, isTauri: () => !!point.tauri };
    // Настоящий модуль и настоящие React hooks: ширину не превращаем в заранее вычисленный phoneUi.
    const phone = load<typeof import('../phoneLayout')>(source.phone, 'phoneLayout.ts', { react: React, './hotkeys': hotkeys });
    const panel = load<typeof import('./ServerMembersPanel')>(source.panel, 'ServerMembersPanel.tsx', {
      'react/jsx-runtime': jsx, '../hotkeys': hotkeys, '../phoneLayout': phone, '../status': status, '../dmRules': dmRules,
      '../store': { useStore: (select: (s: typeof state) => unknown) => select(state) }, '../toast': { toast: empty, toastError: empty },
      './Avatar': { Avatar: empty }, './Crown': { CrownMark: empty, crownGlow: () => '', useCrownId: () => null },
      '../avatarAnimation': { useAnimatedAvatarsEnabled: () => false }, './GuestMark': { GuestMark: empty }, './Icon': { Icon: empty },
      './StatusDot': { StatusDot: empty }, './UserContextMenu': { useUserMenu: () => ({ open: empty, menu: null }) },
    });
    await React.act(async () => { root.render(React.createElement(panel.ServerMembersPanel)); });
    await check({ host, closed, state, resize: async next => {
      width = next;
      await React.act(async () => { for (const media of queries.values()) for (const fn of [...media.listeners]) fn(); });
    } });
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally {
      host.remove();
      try { await GlobalRegistrator.unregister(); }
      finally { if (actMode) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actMode); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); }
    }
  }
  return [...queries.values()].reduce((sum, media) => sum + media.listeners.size, 0);
}

function paired(title: string, check: (source: Sources) => Promise<void>, edits: Edit[]) {
  it(`R345 ${title}`, async () => {
    await check(original);
    for (const edit of edits) {
      await counterfact(async () => {
        assert.equal(original[edit.target].split(edit.from).length, 2, 'R345 setup: ровно один адресный якорь');
        const changed = { ...original, [edit.target]: original[edit.target].replace(edit.from, edit.to) };
        await assert.rejects(() => check(changed), error => error instanceof assert.AssertionError && error.message.startsWith(P));
      });
      await check(original); // Новый DOM, экземпляр phoneLayout и React root после каждого контрфакта.
    }
  });
}

// Класс ошибки: вкладка телефона остаётся без выхода из списка, либо узкий Tauri ошибочно становится телефоном.
paired('шапка участников есть у браузера 384/760 и Android, но не у 761/1200 и узкого desktop Tauri', async source => {
  for (const point of [{ width: 384 }, { width: 760 }, { width: 761 }, { width: 1200 }, { width: 1200, mobile: true, tauri: true }, { width: 384, tauri: true }]) {
    await fixture(point, source, f => {
      const expected = !!point.mobile || (!point.tauri && point.width <= 760);
      assert.equal(f.host.querySelectorAll('.mp-mobile-head').length, expected ? 1 : 0, P + `шапка ${point.width}, mobile=${!!point.mobile}, tauri=${!!point.tauri}`);
      assert.equal(f.host.querySelectorAll('.mp-row').length, 3, P + 'заголовок не скрывает участников');
    });
  }
}, [{ target: 'panel', from: '{phoneUi && (', to: '{mobile && (' }, { target: 'panel', from: '{phoneUi && (', to: '{true && (' },
  { target: 'phone', from: 'return isMobile() || (!isTauri() && phone);', to: 'return isMobile() || phone;' },
  { target: 'phone', from: "export const PHONE_LAYOUT_QUERY = '(max-width: 760px)';", to: "export const PHONE_LAYOUT_QUERY = '(max-width: 759px)';" }]);

// Класс ошибки: счётчик шапки показывает только онлайн, а офлайн-люди и боты пропадают из общего количества.
paired('телефонная шапка называет список и считает всех людей и ботов, не только онлайн', async source => {
  await fixture({ width: 384 }, source, f => {
    assert.equal(f.host.querySelector('.mp-mobile-title')?.textContent, 'Участники', P + 'понятное название экрана');
    assert.equal(f.host.querySelector('.mp-mobile-count')?.textContent, '3', P + 'полное количество участников');
    assert.equal(f.host.querySelector('.mp-back')?.getAttribute('title'), 'Назад', P + 'кнопка назад подписана');
  });
}, [{ target: 'panel', from: '<span className="mp-mobile-count">{members.length}</span>', to: '<span className="mp-mobile-count">{online.length}</span>' }]);

// Класс ошибки: «Назад» не закрывает список либо дублирует действие; чат, профиль и настройки не должны меняться.
paired('назад участников закрывает только этот экран ровно одним действием', async source => {
  for (const point of [{ width: 760 }, { width: 1200, mobile: true, tauri: true }]) await fixture(point, source, async f => {
    const back = f.host.querySelector<HTMLButtonElement>('.mp-mobile-head .mp-back');
    assert.equal(!!back, true, P + 'выход из списка доступен');
    await React.act(async () => { back!.click(); });
    assert.deepEqual(f.closed, [false], P + 'ровно один вызов закрытия участников');
    assert.deepEqual({ members: f.state.mobileMembersOpen, pane: f.state.mobilePane, profile: f.state.mobileProfileOpen,
      settings: f.state.settingsOpen, channel: f.state.currentChannelId },
    { members: false, pane: 'content', profile: true, settings: true, channel: 'channel' }, P + 'остальные экраны и выбранный канал сохранены');
  });
}, [{ target: 'panel', from: 'onClick={() => setMobileMembersOpen(false)}', to: 'onClick={() => setMobileMembersOpen(true)}' },
  { target: 'panel', from: 'onClick={() => setMobileMembersOpen(false)}', to: 'onClick={() => { setMobileMembersOpen(false); setMobileMembersOpen(false); }}' }]);

// Класс ошибки: usePhoneUi проверили один раз или забыли снять подписку — после изменения ширины шапка застревает.
paired('настоящий usePhoneUi переключает шапку при 761→760→761 и снимает подписку после закрытия', async source => {
  const remaining = await fixture({ width: 761 }, source, async f => {
    assert.equal(f.host.querySelectorAll('.mp-mobile-head').length, 0, P + 'исходно широкий браузер');
    await f.resize(760);
    assert.equal(f.host.querySelectorAll('.mp-mobile-head').length, 1, P + 'переход через 760 добавляет выход');
    await f.resize(761);
    assert.equal(f.host.querySelectorAll('.mp-mobile-head').length, 0, P + 'возврат к 761 снимает телефонную шапку');
  });
  assert.equal(remaining, 0, P + 'размонтирование снимает слушатель matchMedia');
}, [{ target: 'phone', from: "mq.addEventListener('change', on);", to: '/* контрфакт: изменение ширины больше не слушается */' },
  { target: 'phone', from: "mq.removeEventListener('change', on);", to: '/* контрфакт: слушатель пережил панель */' }]);
