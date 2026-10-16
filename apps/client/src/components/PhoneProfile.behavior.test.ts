import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as shared from '@gusvoice/shared';
import * as status from '../status';
import * as audioRules from '../userAudioRules';
import * as dmRules from '../dmRules';
import * as callView from '../callView';
import * as contactRules from '../contactRules';
import * as rosterRules from '../rosterResolvers';
import { Icon } from './Icon';
import type { UserMenuTarget } from './UserContextMenu';

const source = readFileSync(new URL('./PhoneProfile.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const menuSource = readFileSync(new URL('./UserContextMenu.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const phoneSource = readFileSync(new URL('../phoneLayout.ts', import.meta.url), 'utf8');
const backSource = readFileSync(new URL('../androidBack.ts', import.meta.url), 'utf8');
const guestSource = readFileSync(new URL('./GuestMark.tsx', import.meta.url), 'utf8');
const empty = () => null;
const wrap = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);
type Options = { width?: number; mobile?: boolean; tauri?: boolean; target?: Partial<UserMenuTarget>; self?: boolean;
  view?: string; currentDmId?: string; guest?: boolean; blocked?: boolean; confirm?: boolean;
  dms?: { id: string; group?: unknown; saved?: boolean; otherUser: { id: string; homeInstance?: shared.User['homeInstance'] } }[]; menu?: boolean; fromProfile?: boolean;
  animatedUrl?: string | null; audio?: { volume: number; muted: boolean }; inPresence?: boolean;
  features?: string[]; lastSeen?: shared.UserLastSeen; realGuestLine?: boolean; rosterHome?: shared.User['homeInstance']; online?: boolean };
type Fixture = { click(label: string): Promise<void>; render(): Promise<void>; back(): Promise<boolean>;
  touch(type: string, y: number): Promise<void>; scroll(top: number): Promise<void>; media(): string;
  state: Record<string, any>; calls: string[]; host: HTMLElement; seenIds(): Array<string | null> };
function load<T>(raw: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, document, window, KeyboardEvent: window.KeyboardEvent,
      require: (id: string) => { if (!Object.hasOwn(deps, id)) throw Error(`Неописанная граница ${id}`); return deps[id]; } });
  return module.exports as T;
}
async function fixture(check: (f: Fixture) => Promise<void>, options: Options = {}, raw = source, menuRaw = menuSource) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); const calls: string[] = [];
  const seenIds: Array<string | null> = [];
  const target: UserMenuTarget = { userId: options.self ? 'self' : 'peer', name: 'Гусь', avatarUrl: '/avatar.png', ...options.target };
  const state: Record<string, any> = { user: { id: 'self', username: 'self' }, bootstrap: null,
    members: options.rosterHome ? [{ user: { id: target.userId, homeInstance: options.rosterHome }, roleIds: [] }] : [],
    onlineUsers: options.online ? [target.userId] : [], userStatuses: {},
    presence: options.inPresence ? { voice: [{ userId: target.userId }] } : {}, serverFeatures: options.features ?? [], convActive: false, blockedUsers: options.blocked ? [{ id: 'peer' }] : [], view: options.view ?? 'dm',
    currentDmId: options.currentDmId ?? 'chat', dmOnlineUsers: [], dmAwayUsers: [], pushMutedDmUsers: [], economy: {}, userActivities: {},
    dms: options.dms ?? [], mobilePane: 'list', loadMembers() {}, applyMemberNickname() {}, requestMention() {}, setSettingsOpen() {},
    openDmWith: (id: string) => { calls.push(`dm:${id}`); },
    setPushMuted: async (kind: string, id: string, muted: boolean) => { calls.push(`push:${kind}:${id}:${muted}`); state.pushMutedDmUsers = muted ? [id] : []; },
    setBlocked: async (user: { id: string }, blocked: boolean) => { calls.push(`block:${user.id}:${blocked}`); state.blockedUsers = blocked ? [user] : []; },
  };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  window.matchMedia = ((query: string) => ({ matches: query === '(max-width: 760px)' && (options.width ?? 760) <= 760 })) as typeof window.matchMedia;
  let mediaConv = '';
  let menu!: typeof import('./UserContextMenu'); let back!: typeof import('../androidBack');
  let openAt!: ReturnType<typeof import('./UserContextMenu')['useUserMenu']>['openAt'];
  function ContextMenu({ children, onClose }: { children?: React.ReactNode; onClose(): void }) {
    React.useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [onClose]);
    return React.createElement('div', { className: 'ctx-menu' }, children);
  }
  const base: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM, '../store': { useStore },
    '../hotkeys': { isMobile: () => !!options.mobile, isTauri: () => !!options.tauri, isAndroid: () => !!options.mobile },
    '../avatarAnimation': { useAnimatedAvatarUrl: () => () => options.animatedUrl ?? null }, '../dmRules': dmRules,
    '../localUserAudio': { MAX_VOLUME: 2, useUserAudio: () => ({ volume: 1, muted: false, ...options.audio,
      setVolume() {}, setMuted() {}, toggleMuted() {}, reset() {} }) },
    '../userAudioRules': audioRules, '../lastSeenText': { lastSeenLabel: (seen: shared.UserLastSeen) => seen.online ? 'в сети' : 'был(а) недавно' },
    './Avatar': { Avatar: ({ size, url, animatedUrl }: { size: number; url?: string; animatedUrl?: string }) => React.createElement('span', {
      'data-avatar': size, 'data-url': url ?? '', 'data-animated': animatedUrl ?? '',
    }) },
    './AvatarZoom': { AvatarZoom: wrap }, './GuestMark': { GuestLine: empty, guestHomeLabel: () => '', useGuestHome: () => () => options.guest ? { id: 'home' } : null },
    './Icon': { Icon }, './ProfileEconomy': { ProfileEconomy: empty },
    './SharedMedia': { SharedMediaRows: empty, SharedMediaPanel: (props: { convId: string; scroller: HTMLElement | null; onLeave(): void }) => {
      mediaConv = props.convId; return React.createElement('button', { 'data-media': props.convId,
        'data-scroller': props.scroller !== null && props.scroller === document.querySelector('.tgp-scroll'), onClick: props.onLeave }, 'Медиа');
    } },
  };
  function Probe() {
    const userMenu = menu.useUserMenu(); openAt = userMenu.openAt;
    return options.menu ? React.createElement(menu.UserContextMenu, { target, pos: { x: 20, y: 20 }, fromProfile: options.fromProfile,
      onClose: () => calls.push('menuclose') }) : userMenu.menu;
  }
  const render = async () => { await React.act(async () => root.render(React.createElement(Probe))); };
  try {
    // Эти два модуля живут уровнем выше компонентов: их относительные импорты отличаются.
    const ruleDeps = { ...base, './hotkeys': base['../hotkeys'], './store': base['../store'] };
    back = load(backSource, ruleDeps);
    const phone = load<typeof import('../phoneLayout')>(phoneSource, ruleDeps);
    if (options.realGuestLine) base['./GuestMark'] = load<typeof import('./GuestMark')>(guestSource, {
      react: React, 'react/jsx-runtime': jsx, '../store': { useStore }, '../rosterResolvers': rosterRules, './Icon': { Icon },
    });
    menu = load(menuRaw, { ...base, '@gusvoice/shared': shared, '../callStore': { explainCallPrivacy() {}, useCall: { getState: () => ({ start() {} }) } },
      '../callView': callView, 'livekit-client': { ConnectionQuality: { Excellent: 'excellent', Good: 'good', Poor: 'poor', Lost: 'lost' } },
      '../api': { api: {} }, '../toast': { toast() {}, toastError(e: unknown) { throw e; } }, '../reportEvidence': { clearEvidence() {}, useEvidence: () => [] },
      '../status': status, './ContextMenu': { ContextMenu, MenuDivider: empty, MenuHeader: empty, MenuSection: wrap,
        MenuItem: ({ label, onClick }: { label: string; onClick(): void }) => React.createElement('button', { onClick }, label) },
      './PokeModal': { PokeComposer: empty }, '../confirm': { confirmAction: async () => { calls.push('confirm'); return options.confirm ?? true; } },
      './StatusDot': { StatusDot: empty }, '../useLastSeen': { useLastSeen: (id: string | null) => { seenIds.push(id); return id ? options.lastSeen ?? null : null; } },
      '../dmOnline': { dotShown: (online: boolean) => online, serverHidesOnline: () => false, serverPresence4: () => false, useLocalOnline: () => false },
      '../contactRules': contactRules, '../contacts': { useContactList: () => null, useContacts: { getState: () => ({}) } }, './ContactEditModal': { removeContactAsk() {} },
    });
    load(raw, { ...base, '../androidBack': back, '../phoneLayout': phone, './UserContextMenu': menu });
    await render();
    if (!options.menu) await React.act(async () => openAt({ x: 20, y: 20 }, target, 'profile'));
    const scrollEl = document.querySelector<HTMLElement>('.tgp-scroll');
    if (scrollEl) Object.defineProperty(scrollEl, 'clientWidth', { configurable: true, get: () => 396 });
    const name = document.querySelector<HTMLElement>('.tgp-head-main .tgp-name');
    if (name) { Object.defineProperty(name, 'offsetTop', { configurable: true, get: () => 100 }); Object.defineProperty(name, 'offsetHeight', { configurable: true, get: () => 20 }); }
    await check({ host, state, calls, render, media: () => mediaConv, seenIds: () => [...seenIds],
      click: async label => { const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(el => el.textContent === label || el.getAttribute('aria-label') === label);
        assert.equal(!!btn, true, `кнопка ${label}`); await React.act(async () => btn!.click()); await render(); },
      back: async () => { let handled = false; await React.act(async () => { handled = back.stepBack(); }); return handled; },
      scroll: async top => { scrollEl!.scrollTop = top; await React.act(async () => { scrollEl!.dispatchEvent(new window.Event('scroll')); }); },
      touch: async (type, y) => { const event = new window.Event(type, { cancelable: true }); Object.defineProperty(event, 'touches', { value: [{ clientY: y }] });
        await React.act(async () => { scrollEl!.dispatchEvent(event); }); },
    });
  } finally {
    try { await React.act(async () => root.unmount()); } finally { host.remove(); try { await GlobalRegistrator.unregister(); }
      finally { if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); } }
  }
}
const hasMessage = () => Array.from(document.querySelectorAll('.tgp-action-label')).some(el => el.textContent === 'Сообщение');
async function phoneRouting(raw = source) {
  for (const [options, expected] of [[{ mobile: true, width: 1280 }, true], [{ width: 760 }, true], [{ width: 761 }, false], [{ width: 1280 }, false], [{ width: 760, tauri: true }, false]] as const)
    await fixture(async () => { assert.equal(!!document.querySelector('.tgp'), expected); assert.equal(!!document.querySelector('.pcard'), !expected); }, options, raw);
}
// Класс ошибки: телефон получает карточку ПК или ПК получает полноэкранный профиль.
it('R173 openAt profile использует телефон при isMobile или ширине 760 вне Tauri, ПК 1280 сохраняет карточку', () => phoneRouting());
async function message(raw = source) {
  for (const [options, expected] of [[{ target: { convId: 'chat' } }, false], [{ target: { convId: 'other' } }, true], [{}, true], [{ target: { convId: 'chat' }, view: 'server' }, true], [{ guest: true }, false]] as const)
    await fixture(async f => {
      assert.equal(hasMessage(), expected);
      if (expected) { await f.click('Сообщение'); assert.equal(f.calls.includes('dm:peer'), true); assert.equal(!!document.querySelector('.tgp'), false); }
    }, options, raw);
}
// Класс ошибки: сообщение самому открытому чату или запрещённая личка гостю.
it('R173 Сообщение скрыто в этой беседе и при dmBlockText, но есть без convId или для другой беседы', () => message());
async function mute(menuRaw = menuSource) {
  await fixture(async f => {
    await f.click('Выкл. звук'); assert.equal(f.calls.join(','), 'push:dm_user:peer:true');
    assert.equal(document.querySelector('.tgp-action-label')?.textContent, 'Сообщение');
    await f.click('Вкл. звук'); assert.equal(f.calls.join(','), 'push:dm_user:peer:true,push:dm_user:peer:false');
    assert.equal(!!Array.from(document.querySelectorAll('.tgp-action-label')).find(el => el.textContent === 'Выкл. звук'), true);
  }, {}, source, menuRaw);
}
// Класс ошибки: инверсия push mute или устаревшая подпись действия.
it('R173 кнопка звука пишет dm_user true затем false и меняет подпись', () => mute());
async function menus(menuRaw = menuSource) {
  await fixture(async f => {
    const labels = document.body.textContent!;
    for (const label of ['Профиль', 'Написать в ЛС', 'Отключить пуши от него']) assert.equal(labels.includes(label), false);
    assert.equal(labels.includes('Заблокировать'), true); await f.click('Заблокировать');
    assert.equal(f.calls.includes('confirm'), true); assert.equal(f.calls.includes('block:peer:true'), true);
  }, { menu: true, fromProfile: true }, source, menuRaw);
  await fixture(async () => { const labels = document.body.textContent!; for (const text of ['Профиль', 'Написать в ЛС', 'Отключить пуши от него']) assert.equal(labels.includes(text), true); }, { menu: true });
}
// Класс ошибки: fromProfile дублирует действия профиля или теряет блокировку.
it('R173 меню профиля без Профиль ЛС и пушей, обычное меню сохраняет прежние пункты', () => menus());
async function blockConfirm(menuRaw = menuSource) {
  await fixture(async f => { await f.click('Заблокировать'); assert.equal(f.calls.includes('confirm'), true); assert.equal(f.calls.some(x => x.startsWith('block:')), false); },
    { menu: true, fromProfile: true, confirm: false }, source, menuRaw);
  await fixture(async f => { await f.click('Разблокировать'); assert.equal(f.calls.includes('confirm'), false); assert.equal(f.calls.includes('block:peer:false'), true); },
    { menu: true, fromProfile: true, blocked: true }, source, menuRaw);
}
// Класс ошибки: блокировка без согласия или лишнее подтверждение разблокировки.
it('R173 отказ подтверждения не блокирует, разблокировка выполняется без подтверждения', () => blockConfirm());
async function backBehavior(raw = source) {
  await fixture(async f => { assert.equal(await f.back(), true); assert.equal(!!document.querySelector('.tgp'), false); }, {}, raw);
  await fixture(async f => {
    await f.click('Ещё'); assert.equal(!!document.querySelector('.ctx-menu'), true); assert.equal(await f.back(), true);
    assert.equal(!!document.querySelector('.ctx-menu'), false); assert.equal(!!document.querySelector('.tgp'), true);
    assert.equal(await f.back(), true); assert.equal(!!document.querySelector('.tgp'), false);
  }, {}, raw);
}
// Класс ошибки: системная Назад закрывает сразу экран и меню или пропускает профиль.
it('R173 системная Назад сначала закрывает меню, затем сам экран профиля', () => backBehavior());
async function viewerEscape(raw = source) {
  await fixture(async () => {
    const viewer = document.createElement('div'); viewer.className = 'lightbox'; document.body.append(viewer);
    await React.act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(!!document.querySelector('.tgp'), true); viewer.remove();
    await React.act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(!!document.querySelector('.tgp'), false);
  }, {}, raw);
}
// Класс ошибки: Escape просмотрщика закрывает лежащий под ним экран.
it('R173 Escape при lightbox не закрывает профиль, без верхнего слоя закрывает', () => viewerEscape());
async function media(raw = source) {
  for (const [options, expected] of [[{ target: { convId: 'explicit' }, dms: [{ id: 'other', otherUser: { id: 'peer' } }] }, 'explicit'],
    [{ dms: [{ id: 'group', group: { name: 'Группа' }, otherUser: { id: 'peer' } }, { id: 'direct', otherUser: { id: 'peer' } }] }, 'direct'],
    [{ self: true, target: { convId: 'explicit' } }, ''], [{}, '']] as const)
    await fixture(async f => {
      assert.equal(f.media(), expected);
      if (expected) { assert.equal(document.querySelector('[data-media]')?.getAttribute('data-scroller'), 'true'); await f.click('Медиа'); assert.equal(!!document.querySelector('.tgp'), false); }
    }, { ...options, dms: 'dms' in options ? [...options.dms] : undefined }, raw);
}
// Класс ошибки: для общих медиа берётся группа или собственная беседа, теряется scroller/onLeave.
it('R173 медиа используют target convId или найденную 1:1, не группу и не себя, уход закрывает профиль', () => media());
async function expand(raw = source) {
  await fixture(async f => {
    await f.touch('touchstart', 0); await f.touch('touchmove', 98.9); assert.equal(!!document.querySelector('.tgp.expanded'), false);
    await f.touch('touchmove', 99); assert.equal(!!document.querySelector('.tgp.expanded'), true);
    await f.touch('touchend', 99); await f.touch('touchstart', 100); await f.touch('touchmove', 76); assert.equal(!!document.querySelector('.tgp.expanded'), true);
    await f.touch('touchmove', 75.9); assert.equal(!!document.querySelector('.tgp.expanded'), false);
  }, {}, raw);
  await fixture(async f => {
    await f.scroll(1); await f.touch('touchstart', 0); await f.touch('touchmove', 300);
    assert.equal(!!document.querySelector('.tgp.expanded'), false, 'жест раскрытия начинается только у верха ленты');
  }, {}, raw);
}
// Класс ошибки: неверный порог протяжки и off-by-one сворачивания.
it('R173 фото раскрывается при 0.33 от ширины минус 96, вверх ровно 24 ещё не сворачивает', () => expand());
async function noPhoto(raw = source) {
  await fixture(async f => { await f.touch('touchstart', 0); await f.touch('touchmove', 396); assert.equal(!!document.querySelector('.tgp.expanded'), false); }, { target: { avatarUrl: null } }, raw);
}
// Класс ошибки: раскрытие пустого аватара в полноэкранный квадрат.
it('R173 без фото даже длинная протяжка не раскрывает шапку', () => noPhoto());
// Класс ошибки: скролл не проявляет компактную шапку при уходе имени под полоску.
it('R173 прокрутка до 120 показывает компактную шапку, до 119 ещё сохраняет основную', () => fixture(async f => {
  await f.scroll(119); assert.equal(!!document.querySelector('.tgp.collapsed'), false); await f.scroll(120);
  assert.equal(!!document.querySelector('.tgp.collapsed'), true); assert.equal(document.querySelector('.tgp')?.getAttribute('style')?.includes('--tgp-p: 1.000'), true);
}));
function replace(raw: string, anchor: string, replacement: string) { assert.equal(raw.split(anchor).length - 1, 1, 'уникальный якорь'); return raw.replace(anchor, replacement); }
// Класс ошибки: регистрация экрана не учитывает реальную телефонную раскладку.
it('R173 мутанты isPhone всегда false и всегда true обнаруживаются парой телефон ПК', async () => {
  await phoneRouting(); for (const value of ['false', 'true']) await assert.rejects(() => phoneRouting(replace(source, 'isPhone: isPhoneUiNow', `isPhone: () => ${value}`)), assert.AssertionError);
});
// Класс ошибки: действие сообщения дублирует открытую беседу.
it('R173 мутант без fromThisChat обнаруживается скрытой кнопкой той же беседы', async () => {
  await message(); await assert.rejects(() => message(replace(source, '!fromThisChat && !dmBlocked', '!dmBlocked')), assert.AssertionError);
});
// Класс ошибки: профиль посылает противоположное состояние push mute.
it('R173 мутант инверсии push mute обнаруживается true false вызовами', async () => {
  await mute(); await assert.rejects(() => mute(replace(menuSource, "onMute: () => setPushMuted('dm_user', target.userId, !pushMuted)", "onMute: () => setPushMuted('dm_user', target.userId, pushMuted)")), assert.AssertionError);
});
// Класс ошибки: блокировка обходит подтверждение пользователя.
it('R173 мутант блокировки без подтверждения обнаруживается отказом подтверждения', async () => {
  await blockConfirm(); await assert.rejects(() => blockConfirm(replace(menuSource, 'if (!peerBlocked) {\n      const ok = await confirmAction', 'if (false) {\n      const ok = await confirmAction')), assert.AssertionError);
});
// Класс ошибки: пункт Профиль остаётся в собственном меню профиля.
it('R173 мутант лишнего пункта Профиль обнаруживается в fromProfile', async () => {
  const anchor = "{!fromProfile && <MenuItem icon=\"user\" label=\"Профиль\" onClick={() => setView('profile')} />}\n          {/* Гостю";
  await menus(); await assert.rejects(() => menus(replace(menuSource, anchor, anchor.replace('!fromProfile && ', ''))), assert.AssertionError);
});
// Класс ошибки: обработчик Назад сообщает что профиль не закрывался.
it('R173 мутант false от обработчика Назад обнаруживается handled', async () => {
  await backBehavior(); await assert.rejects(() => backBehavior(replace(source, 'closeRef.current();\n      return true;', 'closeRef.current();\n      return false;')), assert.AssertionError);
});
// Класс ошибки: Escape проходит сквозь верхний lightbox.
it('R173 мутант без layerAbove обнаруживается сохранившимся экраном под lightbox', async () => {
  await viewerEscape(); await assert.rejects(() => viewerEscape(replace(source, "e.key !== 'Escape' || layerAbove(rootRef.current)", "e.key !== 'Escape'")), assert.AssertionError);
});
// Класс ошибки: выбирается группа вместо беседы 1:1.
it('R173 мутант поиска медиа в группе обнаруживается выбранным direct convId', async () => {
  await media(); await assert.rejects(() => media(replace(source, '!d.group && d.otherUser.id === target.userId', 'd.otherUser.id === target.userId')), assert.AssertionError);
});
// Класс ошибки: порог раскрытия вырос с 0.33 до 0.5.
it('R173 мутант порога 0.5 обнаруживается раскрытием ровно при 99 пикселях', async () => {
  await expand(); await assert.rejects(() => expand(replace(source, 'const EXPAND_AT = 0.33;', 'const EXPAND_AT = 0.5;')), assert.AssertionError);
});
// Класс ошибки: жест раскрывает шапку без фотографии.
it('R173 мутант раскрытия без фото обнаруживается пустым аватаром', async () => {
  await noPhoto(); await assert.rejects(() => noPhoto(replace(source, 'if (canExpand && dy /', 'if (dy /')), assert.AssertionError);
});
// Класс ошибки: экран не зарегистрирован или импортом меню создано кольцо модулей.
it('R173 PhoneProfile подставляется загрузкой модуля и импортируется в main, карта импортов меню неизменна', () => {
  const main = ts.createSourceFile('main.tsx', readFileSync(new URL('../main.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  assert.equal(main.statements.filter(ts.isImportDeclaration).filter(n => ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === './components/PhoneProfile').length, 1);
  const menu = ts.createSourceFile('UserContextMenu.tsx', menuSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(menu.statements.filter(ts.isImportDeclaration).some(n => ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text.includes('PhoneProfile')), false);
});
async function staticBackground(raw = source) {
  await fixture(async () => {
    assert.equal(!!document.querySelector('.tgp.has-bg'), true);
    const layers = document.querySelectorAll<HTMLImageElement>('img.tgp-bgimg'); assert.equal(layers.length, 2);
    for (const layer of layers) assert.equal(layer.getAttribute('src'), '/static.png');
    assert.equal(document.querySelector('.tgp-ava [data-avatar]')?.getAttribute('data-url'), '/static.png');
    assert.equal(document.querySelector('.tgp-ava [data-avatar]')?.getAttribute('data-animated'), '/animated.gif');
    assert.equal(document.querySelector('.tgp-bar-ava [data-avatar]')?.getAttribute('data-animated'), '/animated.gif');
    assert.equal(document.querySelector('.tgp-bar-ava [data-avatar]')?.getAttribute('data-avatar'), '42');
    assert.equal(document.querySelector('.tgp-ava [data-avatar]')?.getAttribute('data-avatar'), '96');
  }, { target: { avatarUrl: '/static.png' }, animatedUrl: '/animated.gif' }, raw);
}
// Класс ошибки: анимация запускается в тяжёлом размытии вместо статичного кадра профиля.
it('R176 фон обеих шапок статичный, видимые аватары получают отдельную анимацию', () => staticBackground());
async function absentBackground(raw = source) {
  for (const animatedUrl of [null, '/animated.gif']) await fixture(async () => {
    assert.equal(!!document.querySelector('.tgp.has-bg'), false);
    assert.equal(document.querySelectorAll('.tgp-bgimg').length, 0);
    assert.equal(document.querySelectorAll('.tgp-bar-bg').length, 0);
    assert.equal(document.querySelector('.tgp-ava [data-avatar]')?.getAttribute('data-animated'), animatedUrl ?? '');
  }, { target: { avatarUrl: null }, animatedUrl }, raw);
}
// Класс ошибки: пустой или только анимированный аватар создаёт слой размытия.
it('R176 без статичного фото нет слоя фона и has-bg, даже если существует отдельная анимация', () => absentBackground());
// Класс ошибки: подмена статичного источника фона анимированным.
it('R176 мутант анимированного фона обнаруживается разными URL статичного и живого аватара', async () => {
  await staticBackground(); await assert.rejects(() => staticBackground(replace(source, 'const bgUrl = target.avatarUrl ?? null;', 'const bgUrl = animatedUrl ?? target.avatarUrl ?? null;')), assert.AssertionError);
});
// Класс ошибки: фоновый слой рисуется всегда, включая пустой профиль.
it('R176 мутант постоянного фона обнаруживается отсутствием фото', async () => {
  await absentBackground(); await assert.rejects(() => absentBackground(replace(source, 'const bgUrl = target.avatarUrl ?? null;', "const bgUrl = target.avatarUrl ?? '/forced.png';")), assert.AssertionError);
});
async function profileVolume(raw = source) {
  for (const options of [{ target: { voiceChannelId: 'voice' } }, { inPresence: true },
    { target: { participant: { isMicrophoneEnabled: true, attributes: {} } as UserMenuTarget['participant'] } }]) await fixture(async () => {
    assert.equal(document.querySelectorAll('.tgp-vol').length, 1);
    assert.equal(document.querySelector('.mps-vol-pct')?.textContent, '100%');
    assert.equal(document.querySelector('.mps-vol-spk svg path') !== null, true);
  }, options, raw);
  for (const options of [{}, { self: true, target: { voiceChannelId: 'voice' }, inPresence: true }]) await fixture(async () => {
    assert.equal(document.querySelectorAll('.tgp-vol').length, 0);
  }, options, raw);
}
// Класс ошибки: громкость предлагается текстовому собеседнику или самому себе.
it('R176 строка громкости только голосовому собеседнику по каналу или presence, себе и вне голоса отсутствует', () => profileVolume());
async function volumeIcon(raw = source) {
  for (const [volume, muted, expected] of [[0, false, 'volume-off'], [0.0049, false, 'volume-off'], [0.0051, false, 'volume'], [1, false, 'volume'], [1, true, 'volume-off']] as const)
    await fixture(async () => {
      // Реальный Icon — эталон тех же SVG path, без подмены имени внутри самого профиля.
      const expectedIcon = Icon({ name: expected });
      const children = React.Children.toArray(expectedIcon.props.children) as React.ReactElement<{ d: string }>[];
      const expectedPaths = children.map(path => path.props.d).join('|');
      const paths = Array.from(document.querySelectorAll('.mps-vol-spk svg path')).map(path => path.getAttribute('d')).join('|');
      assert.equal(paths, expectedPaths); assert.equal(paths.length > 0, true);
      assert.equal(document.querySelector('.mps-vol-pct')?.textContent, muted ? 'выкл' : `${Math.round(volume * 100)}%`);
    }, { target: { voiceChannelId: 'voice' }, audio: { volume, muted } }, raw);
}
// Класс ошибки: значок звука не отражает заглушение или округление громкости в ноль.
it('R176 значок volume-off при mute и нуле процентов, volume при ненулевом уровне', () => volumeIcon());
// Класс ошибки: нулевой процент звучит визуально как включённый звук.
it('R176 мутант без проверки нуля громкости обнаруживается строкой профиля', async () => {
  await volumeIcon(); await assert.rejects(() => volumeIcon(replace(source, "audio.muted || volPct === 0 ? 'volume-off' : 'volume'", "audio.muted ? 'volume-off' : 'volume'")), assert.AssertionError);
});
async function menuVolume(menuRaw = menuSource) {
  for (const [options, expected] of [[{ fromProfile: true }, false], [{ fromProfile: false }, true], [{ fromProfile: true, width: 1280 }, true]] as const)
    await fixture(async () => { assert.equal(document.querySelectorAll('.ctx-vol2').length, expected ? 1 : 0); },
      { menu: true, target: { voiceChannelId: 'voice' }, ...options }, source, menuRaw);
}
// Класс ошибки: второй регулятор дублирует строку телефонного профиля или пропал на ПК.
it('R176 меню fromProfile скрывает ctx-vol2 только на телефоне, обычное меню и ПК сохраняют регулятор', () => menuVolume());
// Класс ошибки: fromProfile игнорируется и голосовая строка дублируется в меню.
it('R176 мутант без телефонного ограничения ctx-vol2 обнаруживается меню профиля', async () => {
  await menuVolume(); await assert.rejects(() => menuVolume(replace(menuSource, '!(fromProfile && phoneProfile?.isPhone()) &&', 'true &&')), assert.AssertionError);
});

const fedHome = { instanceId: 'neighbor', name: 'Сосед', domain: 'neighbor.example' };
const fedSeen = { userId: 'peer', online: false, exact: false, at: null, approx: 'recently' } as shared.UserLastSeen;
async function profilePresence(remote: boolean, enabled: boolean, view = 'dm', menuRaw = menuSource) {
  const shown = view !== 'dm' || !remote || enabled;
  for (const width of [390, 1280]) for (const online of [false, true]) await fixture(async f => {
    const profile = width === 390 ? document : f.host;
    const selector = width === 390 ? '.tgp-seen' : '.pcard-seen';
    assert.equal(profile.querySelectorAll(selector).length > 0, shown, 'строка статуса только при доступном presence');
    if (shown) assert.equal(profile.querySelector(selector)?.textContent, online ? 'в сети' : 'был(а) недавно');
    assert.equal(f.seenIds().length > 0, true);
    // R200 сохраняет исходный запрос для совместимости presenceClient, но скрывает его результат через shownSeen.
    assert.equal(f.seenIds().every(id => id === 'peer'), true, 'прежний источник времени сохраняется, гейт лежит на результате');
  }, { width, view, online, features: enabled ? ['fedm4'] : [], lastSeen: fedSeen,
    dms: [{ id: 'chat', otherUser: { id: 'peer', homeInstance: remote ? fedHome : null } }] }, source, menuRaw);
}
it('R197 PhoneProfile и ПК-карточка UserContextMenu скрывают статус соседа без fedm4 только в ЛС', async () => {
  // Данные времени приходят с границы всегда, но неподдержанный статус обязано убрать именно приложение.
  for (const remote of [false, true]) for (const enabled of [false, true]) for (const view of ['dm', 'server']) await profilePresence(remote, enabled, view);
});
for (const [name, anchor, replacement, target] of [
  ['запрет только в ЛС потерян', 'const presenceOff = inDm && !peerShown;', 'const presenceOff = false;', 'строка статуса только'],
  ['результат времени показан без fedm4', 'const shownSeen = presenceOff ? null : profileSeen;', 'const shownSeen = profileSeen;', 'строка статуса только'],
] as const) it(`R197 UserContextMenu мутант «${name}» обнаруживается настоящими телефонным и ПК-профилями`, async () => {
  await profilePresence(true, false);
  await assert.rejects(profilePresence(true, false, 'dm', replace(menuSource, anchor, replacement)),
    e => e instanceof assert.AssertionError && e.message.includes(target));
});
async function guestLine(width: number, rosterHome: shared.User['homeInstance'], dmHome: shared.User['homeInstance'], raw = source, menuRaw = menuSource) {
  const home = rosterHome ?? dmHome;
  await fixture(async f => {
    const profile = width === 390 ? document : f.host;
    const line = profile.querySelector('.guest-line');
    assert.equal(!!line, !!home, 'инстанс человека виден и без ростера');
    if (home) {
      assert.equal(line?.textContent?.includes(`с инстанса «${home.name?.trim() || home.domain || 'другой инстанс'}»`), true, 'GuestLine показывает выбранный дом');
      const extraDomain = !!home.domain && home.domain !== (home.name?.trim() || home.domain);
      assert.equal(!!line?.querySelector('.muted'), extraDomain);
      if (extraDomain) assert.equal(line?.querySelector('.muted')?.textContent, ` · ${home.domain}`);
    }
  }, { width, realGuestLine: true, rosterHome, dms: [{ id: 'chat', otherUser: { id: 'peer', homeInstance: dmHome } }] }, raw, menuRaw);
}
it('R197 настоящий GuestLine получает дом из dms без ростера и сохраняет приоритет серверной карточки', async () => {
  const rosterHome = { instanceId: 'roster', name: 'Серверный дом', domain: 'roster.example' };
  for (const width of [390, 1280]) {
    await guestLine(width, null, fedHome);
    await guestLine(width, rosterHome, fedHome);
    await guestLine(width, null, { ...fedHome, name: null });
    await guestLine(width, null, { ...fedHome, name: null, domain: '' });
    await guestLine(width, null, null);
  }
});
for (const [name, width, owner] of [['PhoneProfile', 390, 'phone'], ['UserContextMenu', 1280, 'menu']] as const)
  it(`R197 мутант потерянного dmHome в ${name} обнаруживается настоящим GuestLine`, async () => {
    await guestLine(width, null, fedHome);
    const anchor = 'const lineHome = guestHome ?? dmHome;';
    const changed = replace(owner === 'phone' ? source : menuSource, anchor, 'const lineHome = guestHome;');
    await assert.rejects(guestLine(width, null, fedHome, owner === 'phone' ? changed : source, owner === 'menu' ? changed : menuSource),
      e => e instanceof assert.AssertionError && e.message.includes('инстанс человека виден и без ростера'));
  });
