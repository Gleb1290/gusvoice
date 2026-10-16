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
import { Icon } from './Icon';

const source = readFileSync(new URL('./ServerMembersPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const phoneSource = readFileSync(new URL('../phoneLayout.ts', import.meta.url), 'utf8');
const empty = () => null;
type Options = { mobile?: boolean; width?: number; tauri?: boolean; self?: boolean; guest?: boolean };
async function fixture(check: (f: { host: HTMLElement; calls: string[]; click(): Promise<void>; context(): Promise<void> }) => Promise<void>,
  options: Options = {}, raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); const calls: string[] = [];
  const member = { user: { id: options.self ? 'self' : 'peer', displayName: 'Гусь', username: 'goose', avatarUrl: '/avatar.png', animatedAvatarUrl: null,
    homeInstance: options.guest ? { id: 'home' } : null, status: 'online', customStatus: null }, nickname: 'Дружок', roleIds: [] };
  const state = { bootstrap: { server: { id: 'server' } }, onlineUsers: [member.user.id], userStatuses: {}, userActivities: {},
    user: { id: 'self' }, members: [member], openDmWith: async (id: string) => { calls.push(`dm:${id}`); }, setMobileMembersOpen() {} };
  window.matchMedia = ((query: string) => ({ matches: query === '(max-width: 760px)' && (options.width ?? 760) <= 760,
    media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true })) as typeof window.matchMedia;
  const hotkeys = { isMobile: () => !!options.mobile, isTauri: () => !!options.tauri };
  function load<T>(text: string, deps: Record<string, unknown>): T {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { module, exports: module.exports, window, document,
        // Контрфакт старого открытия листа имеет явную границу, а не падает по ReferenceError.
        setSheetMember: (m: typeof member) => calls.push(`sheet:${m.user.id}`),
        require: (id: string) => { if (!Object.hasOwn(deps, id)) throw Error(`Неописанная граница ${id}`); return deps[id]; } });
    return module.exports as T;
  }
  try {
    const phone = load<typeof import('../phoneLayout')>(phoneSource, { react: React, './hotkeys': hotkeys });
    const panel = load<typeof import('./ServerMembersPanel')>(raw, { react: React, 'react/jsx-runtime': jsx,
      '../hotkeys': hotkeys, '../phoneLayout': phone, '../status': status, '../dmRules': dmRules,
      '../store': { useStore: (select: (s: typeof state) => unknown) => select(state) },
      '../toast': { toast: () => calls.push('blocked'), toastError(e: unknown) { throw e; } },
      './Avatar': { Avatar: empty }, './Crown': { CrownMark: empty, crownGlow: () => '', useCrownId: () => null },
      '../avatarAnimation': { useAnimatedAvatarsEnabled: () => false }, './GuestMark': { GuestMark: empty }, './Icon': { Icon }, './StatusDot': { StatusDot: empty },
      './UserContextMenu': { useUserMenu: () => {
        const [opened, setOpened] = React.useState(false);
        return { open: (_event: unknown, target: { userId: string; name: string; username?: string }, view?: string) => {
          calls.push(`menu:${target.userId}:${target.name}:${target.username ?? ''}:${view ?? 'menu'}`); setOpened(true);
        }, menu: opened ? React.createElement('div', { className: 'opened-profile' }) : null };
      } },
    });
    await React.act(async () => root.render(React.createElement(panel.ServerMembersPanel)));
    await check({ host, calls, click: async () => { const row = host.querySelector<HTMLElement>('.mp-row'); assert.equal(!!row, true); await React.act(async () => row!.click()); },
      context: async () => { const row = host.querySelector<HTMLElement>('.mp-row'); assert.equal(!!row, true); await React.act(async () => { row!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true })); }); } });
  } finally {
    try { await React.act(async () => root.unmount()); } finally { host.remove(); try { await GlobalRegistrator.unregister(); }
      finally { if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); } }
  }
}
async function phone(raw = source) {
  for (const options of [{ mobile: true, width: 1280 }, { width: 760 }, { width: 400 }]) await fixture(async f => {
    await f.click(); assert.equal(f.calls.join(','), 'menu:peer:Дружок:goose:profile');
    assert.equal(f.host.querySelectorAll('.opened-profile').length, 1); assert.equal(f.host.querySelectorAll('.mps').length, 0);
  }, options, raw);
}
// Класс ошибки: участник телефона открывается старым листом или прямой личкой.
it('R176 приложение телефона и браузер до 760 направляют клик участника в openMenu profile', () => phone());
// Класс ошибки: телефон не разрешает профиль себе или гостю из-за старого ограничения лички.
it('R176 телефонный профиль открывается и для себя и для гостя без попытки завести ЛС', async () => {
  for (const options of [{ self: true }, { guest: true }]) await fixture(async f => {
    await f.click(); assert.equal(f.calls[0], `menu:${options.self ? 'self' : 'peer'}:Дружок:goose:profile`); assert.equal(f.calls.length, 1);
  }, options);
});
// Класс ошибки: ПК или узкое Tauri-окно меняет прежнее действие строки участника.
it('R176 ПК 1280 и узкое Tauri-окно сохраняют ЛС, клик на себя ничего не делает', async () => {
  for (const options of [{ width: 1280 }, { width: 760, tauri: true }]) await fixture(async f => {
    await f.click(); assert.equal(f.calls.join(','), 'dm:peer');
  }, options);
  await fixture(async f => { await f.click(); assert.equal(f.calls.length, 0); }, { width: 1280, self: true });
});
// Класс ошибки: правое меню поменялось вместе с новым телефонным профилем.
it('R176 правый клик на ПК сохраняет обычное меню, гостю ЛС не открываются', async () => {
  await fixture(async f => { await f.context(); assert.equal(f.calls.join(','), 'menu:peer:Дружок::menu'); }, { width: 1280 });
  await fixture(async f => { await f.click(); assert.equal(f.calls.join(','), 'blocked'); }, { width: 1280, guest: true });
});
// Класс ошибки: возвращён setSheetMember вместо полноэкранного профиля.
it('R176 мутант возврата прежнего листа участника обнаруживается контрактом openMenu profile', async () => {
  const anchor = "? (e) => openMenu(e, { userId: m.user.id, name, avatarUrl: m.user.avatarUrl, username: m.user.username }, 'profile')";
  assert.equal(source.split(anchor).length - 1, 1); await phone();
  await assert.rejects(() => phone(source.replace(anchor, '? () => setSheetMember(m)')), assert.AssertionError);
});
// Класс ошибки: usePhoneUi потерян, телефонный браузер стал ПК.
it('R176 мутант только isMobile обнаруживается браузером шириной 760', async () => {
  const anchor = 'mobile || phoneUi\n            ?'; assert.equal(source.split(anchor).length - 1, 1); await phone();
  await assert.rejects(() => phone(source.replace(anchor, 'mobile\n            ?')), assert.AssertionError);
});
// Класс ошибки: старый MemberProfileSheet импортирован или вновь вставлен в панель.
it('R176 в исходной панели нет MemberProfileSheet, профиль идёт через существующую карту меню', () => {
  const ast = ts.createSourceFile('ServerMembersPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = ast.statements.filter(ts.isImportDeclaration);
  assert.equal(imports.some(n => ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text.includes('MemberProfileSheet')), false);
  assert.equal(imports.filter(n => ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === './UserContextMenu').length, 1);
});
