import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as status from '../status';
import * as dmRules from '../dmRules';

const sources = Object.fromEntries(['ServerBotsPanel', 'ServerRolesPanel', 'ServerMembersPanel', 'Toggle'].map(name =>
  [name, readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')]));
const role = (id: string, name: string, managedBotId?: string) => ({ id, serverId: 'server', name, managedBotId,
  permissions: '0', position: 1, color: 0, isEveryone: false, mentionable: false, membersCanAssign: false });
const botRole = role('bot-role', 'Погодный бот', 'weather');
const normalRole = role('human-role', 'Друзья');
const member = (id: string, bot = false, roleIds: string[] = [], botReadsAll = false) => ({ user: {
  id, username: `${id}bot`, displayName: id, avatarUrl: null, status: 'online', bot, customStatus: null }, roleIds, nickname: null, botReadsAll });
const bot = { id: 'weather', username: 'weatherbot', displayName: 'Погодный бот', avatarUrl: null,
  description: 'Синтетический тестовый бот', readAll: false, working: true, roleId: 'bot-role',
  addedAt: '2026-10-01T10:00:00Z', addedBy: { id: 'owner', displayName: 'Владелец' } };

async function fixture(check: (f: {
  host: HTMLElement; calls: Array<{ method: string; args: any[] }>; confirms: any[];
  mount(name: string, props?: Record<string, unknown>): Promise<void>;
  click(text: string, scope?: ParentNode): Promise<void>;
  input(value: string): Promise<void>; tick(ms: number): Promise<void>;
  answer(value: unknown, error?: boolean): Promise<void>;
  confirm(value: boolean): void; failList(): void;
}) => Promise<void>, options: { perms?: bigint; owner?: boolean; roles?: unknown[]; members?: unknown[]; raw?: string; target?: string } = {}) {
  GlobalRegistrator.register({ url: 'https://client.example.test/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  let cleanupRoot: { unmount(): void } | undefined;
  let cleanupHost: HTMLElement | undefined;
  try {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // Инициализируем react-dom после DOM: React выбирает современное input-событие, а не IE-полифилл.
  const dom = await import('react-dom');
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div'); cleanupHost = host; document.body.append(host);
  const root = createRoot(host); cleanupRoot = root;
  let clock = 0; let timerId = 0; let confirmation = false; let listFails = false;
  const timers = new Map<number, { at: number; fn: () => void }>();
  window.setTimeout = ((fn: () => void, ms = 0) => { const id = ++timerId; timers.set(id, { at: clock + ms, fn }); return id; }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof window.clearTimeout;
  const calls: Array<{ method: string; args: any[] }> = []; const confirms: any[] = [];
  let pending: { resolve(value: unknown): void; reject(error: unknown): void } | undefined;
  const members = options.members ?? [member('weather', true, ['bot-role']), member('friend', false, ['human-role'])];
  const state = { bootstrap: { server: { id: 'server' }, permissions: (options.perms ?? shared.Permission.MANAGE_SERVER).toString() },
    user: { id: options.owner ? 'owner' : 'me', superAdmin: false }, members,
    onlineUsers: ['weather', 'friend'], userStatuses: {}, userActivities: {}, serverFeatures: [],
    openDmWith: async () => {}, setMobileMembersOpen() {}, openServer: async () => {} };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  const api = {
    serverBots: async (...args: any[]) => { calls.push({ method: 'list', args }); if (listFails) throw { status: 404 }; return [bot]; },
    serverBotLookup: (...args: any[]) => { calls.push({ method: 'lookup', args }); return new Promise((resolve, reject) => { pending = { resolve, reject }; }); },
    addServerBot: async (...args: any[]) => { calls.push({ method: 'add', args }); },
    removeServerBot: async (...args: any[]) => { calls.push({ method: 'remove', args }); },
    updateServerBot: async (...args: any[]) => { calls.push({ method: 'update', args }); },
    listRoles: async () => options.roles ?? [botRole, normalRole], listMembers: async () => members,
  };
  function load<T>(name: string, extra: Record<string, unknown> = {}): T {
    const empty = () => null;
    const deps: Record<string, unknown> = {
      react: React, 'react/jsx-runtime': jsx, 'react-dom': dom, '@gusvoice/shared': shared,
      '../api': { api }, '../store': { useStore }, '../confirm': { confirmAction: async (value: unknown) => { confirms.push(value); return confirmation; } },
      '../androidBack': { pushBackHandler: () => () => {} }, '../dialogChrome': { useDialogChrome: () => React.useRef(null) },
      '../toast': { toast: empty, toastError: empty }, './Avatar': { Avatar: empty }, './Icon': { Icon: empty }, './HelpDot': { HelpDot: empty },
      './Select': { Select: ({ options: items, ariaLabel }: { options: Array<{ value: string; label: string }>; ariaLabel?: string }) =>
        React.createElement('select', { 'aria-label': ariaLabel }, items.map(o => React.createElement('option', { key: o.value, value: o.value }, o.label))) },
      '../hotkeys': { isMobile: () => false }, '../phoneLayout': { usePhoneUi: () => false }, '../status': status, '../dmRules': dmRules,
      './Crown': { CrownMark: empty, crownGlow: () => '', useCrownId: () => null }, '../avatarAnimation': { useAnimatedAvatarsEnabled: () => false },
      './GuestMark': { GuestMark: empty }, './StatusDot': { StatusDot: () => React.createElement('i', { className: 'test-status-dot' }) },
      './UserContextMenu': { useUserMenu: () => ({ open: empty, menu: null }) }, ...extra,
    };
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(options.target === name ? options.raw! : sources[name], { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText, { module, exports: module.exports, window, document, require(id: string) {
      assert.ok(Object.hasOwn(deps, id), `R303 закрытая граница панелей: ${id}`); return deps[id];
    } });
    return module.exports as T;
  }
  const toggle = load<typeof import('./Toggle')>('Toggle');
  const roles = load<typeof import('./ServerRolesPanel')>('ServerRolesPanel', { './Toggle': toggle });
  const bots = load<typeof import('./ServerBotsPanel')>('ServerBotsPanel', { './Toggle': toggle, './ServerRolesPanel': roles });
  const roster = load<typeof import('./ServerMembersPanel')>('ServerMembersPanel');
  const components: Record<string, React.ElementType> = { ServerRolesPanel: roles.ServerRolesPanel,
    ServerBotsPanel: bots.ServerBotsPanel, ServerMembersPanel: roster.ServerMembersPanel };
  const props = { serverId: 'server', ownerId: 'owner', selfId: 'me', canManageRoles: true, canKick: false, view: 'roles', initialRoleId: 'bot-role' };
    await check({ host, calls, confirms, mount: async (name, extra = {}) => {
      await React.act(async () => root.render(React.createElement(components[name], { ...props, ...extra })));
    }, click: async (text, scope = document) => {
      const button = Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.trim() === text);
      assert.ok(button, `R303 кнопка «${text}» существует`); await React.act(async () => button.click());
    }, input: async value => {
      const input = document.querySelector<HTMLInputElement>('.add-bot-modal input'); assert.ok(input);
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    }, tick: async ms => { clock += ms; await React.act(async () => {
      for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
    }); }, answer: async (value, error = false) => {
      assert.ok(pending, 'R303 lookup уже отправлен'); const request = pending; pending = undefined;
      await React.act(async () => { if (error) request.reject(value); else request.resolve(value); });
    }, confirm(value) { confirmation = value; }, failList() { listFails = true; } });
  } finally {
    try {
      if (cleanupRoot) await React.act(async () => cleanupRoot!.unmount());
    } finally {
      cleanupHost?.remove();
      try { await GlobalRegistrator.unregister(); }
      finally {
        if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
        else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      }
    }
  }
}

it('R303 lookup ждёт 300 мс, новая буква отменяет предыдущий таймер, @ и внешние пробелы снимаются', async () => {
  await fixture(async f => {
    await f.mount('ServerBotsPanel'); await f.click('Добавить бота');
    await f.input('oldbot'); await f.tick(299); assert.equal(f.calls.filter(c => c.method === 'lookup').length, 0);
    await f.input(' @weatherbot '); await f.tick(299); assert.equal(f.calls.filter(c => c.method === 'lookup').length, 0);
    await f.tick(1); assert.deepEqual(f.calls.filter(c => c.method === 'lookup'), [{ method: 'lookup', args: ['server', 'weatherbot'] }]);
    await f.answer({ ...bot, canAdd: true }); assert.ok(document.querySelector('.add-bot-card')?.textContent?.includes('@weatherbot'));
  });
});
it('R303 404 lookup показывает Бот не найден, отказ canAdd показывает reason и не даёт добавить', async () => {
  await fixture(async f => {
    await f.mount('ServerBotsPanel'); await f.click('Добавить бота'); await f.input('missingbot'); await f.tick(300);
    await f.answer({ status: 404 }, true); assert.ok(document.querySelector('.add-bot-modal')?.textContent?.includes('Бот не найден'));
    await f.input('privatebot'); await f.tick(300); await f.answer({ ...bot, canAdd: false, reason: 'Приватный бот другого владельца' });
    assert.equal(document.querySelector('.add-bot-card .bot-state')?.textContent, 'Приватный бот другого владельца');
    const add = Array.from(document.querySelectorAll<HTMLButtonElement>('.add-bot-modal button')).find(b => b.textContent === 'Добавить');
    assert.ok(add?.disabled); await f.click('Добавить'); assert.equal(f.calls.some(c => c.method === 'add'), false);
  });
});
it('R303 ADMINISTRATOR отсутствует даже у владельца, чужие права неактивны, своё обычное право активно', async () => {
  await fixture(async f => {
    await f.mount('ServerBotsPanel'); await f.click('Добавить бота');
    assert.equal(document.querySelector('[role="switch"][aria-label="Администратор — все права"]'), null);
    const own = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Управление сервером"]');
    const foreign = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Управление вебхуками"]');
    assert.equal(own?.disabled, false); assert.equal(foreign?.disabled, true);
    await f.input('weatherbot'); await f.tick(300); await f.answer({ ...bot, canAdd: true }); await f.click('Добавить');
    const add = f.calls.find(c => c.method === 'add'); assert.ok(add);
    const granted = BigInt(add.args[1].permissions);
    assert.equal(granted & shared.Permission.ADMINISTRATOR, 0n); assert.equal(granted & shared.Permission.MANAGE_WEBHOOKS, 0n);
    assert.equal(add.args[1].readAll, false);
  }, { owner: true });
});
it('R303 снятие бота требует danger-подтверждения: отказ сохраняет, согласие удаляет точного бота', async () => {
  await fixture(async f => {
    await f.mount('ServerBotsPanel'); const row = f.host.querySelector<HTMLButtonElement>('.webhook-row'); assert.ok(row);
    await React.act(async () => row.click()); await f.click('Убрать с сервера');
    assert.equal(f.calls.some(c => c.method === 'remove'), false); assert.equal(f.host.querySelectorAll('.webhook-item').length, 1);
    assert.equal(f.confirms[0].tone, 'danger'); assert.match(f.confirms[0].title, /Погодный бот/);
    f.confirm(true); await f.click('Убрать с сервера');
    assert.deepEqual(f.calls.filter(c => c.method === 'remove'), [{ method: 'remove', args: ['server', 'weather'] }]);
    assert.equal(f.host.querySelectorAll('.webhook-item').length, 0);
  });
});
it('R303 404 списка ботов сообщает о старом сервере и убирает кнопку добавления', async () => {
  await fixture(async f => {
    f.failList(); await f.mount('ServerBotsPanel');
    assert.ok(f.host.textContent?.includes('Этот сервер не поддерживает ботов на серверах'));
    assert.equal(Array.from(f.host.querySelectorAll('button')).some(b => b.textContent?.includes('Добавить бота')), false);
  });
});

async function managedRole(raw = sources.ServerRolesPanel) {
  await fixture(async f => {
    await f.mount('ServerRolesPanel');
    assert.equal(f.host.querySelectorAll('.danger-text').length, 0, 'R303 роль бота нельзя удалить');
    assert.equal(f.host.querySelectorAll('.role-mchip button').length, 0, 'у бота нет крестика снятия роли');
    assert.equal(f.host.querySelector('[aria-label="Добавить участника в роль"]'), null);
    assert.equal(f.host.querySelector<HTMLButtonElement>('[aria-label="Администратор — все права"]')?.disabled, true);
    await f.click('Друзья');
    assert.ok(f.host.querySelector('.danger-text'), 'обычную роль удалить можно');
    assert.equal(f.host.querySelectorAll('.role-mchip button').length, 1);
    assert.ok(f.host.querySelector('[aria-label="Добавить участника в роль"]'), 'обычная роль выдаётся участникам');
  }, { target: 'ServerRolesPanel', raw, owner: true });
}
it('R303 управляемая роль без удаления, выдачи и крестика, обычная роль сохраняет все три действия', () => managedRole());
it('R303 участникам нельзя выдать роль бота или снять её крестиком, обычные роли остаются в выдаче', async () => {
  await fixture(async f => {
    await f.mount('ServerRolesPanel', { view: 'members' });
    const rows = f.host.querySelectorAll('.member-row'); assert.equal(rows.length, 2);
    const botChip = rows[0].querySelector('.role-chip'); assert.ok(botChip?.textContent?.includes('Погодный бот'));
    assert.equal(botChip?.querySelector('button'), null);
    assert.equal(rows[1].querySelectorAll('.role-chip button').length, 1);
    assert.deepEqual(Array.from(f.host.querySelectorAll<HTMLOptionElement>('option'), o => o.value), ['human-role']);
  });
});

async function rosterProbe(raw = sources.ServerMembersPanel) {
  await fixture(async f => {
    await f.mount('ServerMembersPanel');
    assert.deepEqual(Array.from(f.host.querySelectorAll('.mp-head'), n => n.textContent), ['Боты — 2', 'В сети — 1', 'Не в сети — 1']);
    const lists = f.host.querySelectorAll('.mp-list'); assert.equal(lists[0].querySelectorAll('.bot-tag').length, 2);
    assert.equal(lists[0].querySelectorAll('.test-status-dot').length, 0, 'R303 у ботов нет точки статуса');
    assert.equal(lists[1].querySelectorAll('.test-status-dot').length, 1, 'у человека точка остаётся');
    assert.deepEqual(Array.from(lists[0].querySelectorAll('.mp-custom'), n => n.textContent), ['видит только обращения', 'видит все сообщения']);
    assert.equal(f.host.querySelectorAll('.mp-row').length, 4, 'ни один бот не продублирован среди людей');
  }, { target: 'ServerMembersPanel', raw, members: [member('z-all', true, [], true), member('friend'), member('offline'), member('a-private', true)] });
}
it('R303 ростер показывает Боты первой отдельной группой с режимами чтения, без точек online и без дублей среди людей', () => rosterProbe());

for (const [name, target, anchor, replacement, probe, message, actual, expected] of [
  ['роль бота удаляется', 'ServerRolesPanel', '!systemRole && !botRole && (', '!systemRole && (', managedRole, 'R303 роль бота нельзя удалить', 1, 0],
  ['бот получает online-точку', 'ServerMembersPanel', '!bot && (', 'true && (', rosterProbe, 'R303 у ботов нет точки статуса', 2, 0],
] as const) it(`R303 контрфакт: ${name} ловится поведением настоящего компонента`, async () => {
  await probe();
  const raw = sources[target]; assert.equal(raw.split(anchor).length - 1, 1);
  await assert.rejects(() => probe(raw.replace(anchor, replacement)), (e: unknown) => e instanceof assert.AssertionError &&
    e.operator === 'strictEqual' && e.message.split('\n')[0] === message && e.actual === actual && e.expected === expected);
});
