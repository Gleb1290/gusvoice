import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import type { DmChannel } from '@gusvoice/shared';
import * as convRules from '../convSyncRules';
import * as listRules from '../dmListRules';
import * as archiveRules from '../dmArchiveRules';
import * as callRules from '../callView';
import * as phoneLayout from '../phoneLayout';
import * as groupRules from '../groupChatRules';
import { lastSeenLabel } from '../lastSeenText';
import type { UserLastSeen } from '@gusvoice/shared';
import type * as Chat from './DmChatView';

const source = readFileSync(new URL('./DmChatView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const noView = () => null;
const unused = () => assert.fail('действие вне проверяемого контракта шапки');

// MessagePane — граница теста: рисует переданные JSX, но не копирует правил шапки/меню/закрепления.
function PaneBoundary({ headerActions, title, chatSearch, placeholder }: {
  headerActions: React.ReactNode; title: React.ReactNode; chatSearch?: { open: boolean }; placeholder?: string;
}) {
  return React.createElement('div', null,
    React.createElement('header', null, title, React.createElement('div', { className: 'topbar-actions' }, headerActions)),
    chatSearch?.open ? React.createElement('div', { 'data-search-open': true }) : null,
    React.createElement('textarea', { placeholder }));
}
function MenuBoundary({ children }: { children: React.ReactNode }) {
  return React.createElement('div', { role: 'menu' }, children);
}
function MenuItemBoundary({ label, onClick }: { label: string; onClick: () => void }) {
  return React.createElement('button', { role: 'menuitem', onClick }, label);
}

async function fixture(width: number, pinned: boolean, check: (f: {
  host: HTMLDivElement; pinCalls: Array<[string, boolean]>; callIds: string[];
  muteCalls: unknown[][]; savedMute: number[];
  render(): Promise<void>; currentDm(): DmChannel;
}) => Promise<void>, raw = source, presence?: { online: boolean; lastSeen: UserLastSeen | null },
options: { kind?: 'direct' | 'group' | 'saved'; muteMenu?: boolean } = {}) {
  GlobalRegistrator.register({ url: 'http://localhost/', width });
  const priorAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    let dm = { id: 'conversation', otherUser: { id: 'peer', username: 'peer', displayName: 'Собеседник', avatarUrl: null },
      pinnedAt: pinned ? '2026-10-08T00:00:00.000Z' : null, archived: false } as DmChannel;
    if (options.kind === 'group') dm = { ...dm, group: { title: 'Группа', avatarUrl: null, ownerId: 'me', members: [], limit: 5 } };
    if (options.kind === 'saved') dm = { ...dm, saved: true };
    const pinCalls: Array<[string, boolean]> = []; const callIds: string[] = [];
    const muteCalls: unknown[][] = []; const savedMute: number[] = [];
    const state = {
      user: { id: 'me', displayName: 'Я', avatarUrl: null, notifyDm: true }, dmMessages: { conversation: [] },
      pushMutedDmUsers: [], pushMuteUntil: {}, pushAlwaysTargets: [], convActive: true,
      serverFeatures: ['conv11', 'archive1', 'search1', 'calls1'],
      conv: { summaries: {}, windows: {}, gone: {} }, outbox: {}, drafts: {}, draftRev: {}, places: {},
      historyFailed: [], blockedUsers: [],
      setPushMuted: async (...args: unknown[]) => { muteCalls.push(args); },
      setConvPinned: async (id: string, next: boolean) => {
        pinCalls.push([id, next]);
        dm = { ...dm, pinnedAt: next ? '2026-10-08T12:00:00.000Z' : null };
      },
    };
    const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
    const useDmStickers = Object.assign((select: (s: { mine: never[]; recent: never[] }) => unknown) => select({ mine: [], recent: [] }),
      { getState: unused });
    const useCall = Object.assign((select: (s: { call: null }) => unknown) => select({ call: null }),
      { getState: () => ({ start: async (id: string) => { callIds.push(id); } }) });
    const dependencies: Record<string, unknown> = {
      react: React, 'react/jsx-runtime': jsx,
      '../dmStickerRules': { serverDmStickers: () => false }, '../dmStickers': { useDmStickers },
      './StickerCatalogPanel': { StickerCatalogPanel: noView },
      '../channelVisit': { useChannelVisit: () => ({ newSince: null, readKey: 0, visitKey: 'visit', started: true }) },
      '../api': { api: { convSearch: unused } }, '../effectsBus': { fireEffect: unused },
      '../chatSearchRules': { SEARCH_PAGE: 50 }, '../uploadProgress': {
        setUploadDone: unused, setUploadProgress: unused, uploadAborted: unused, uploadSignal: unused,
      },
      '../confirm': { confirmAction: unused }, '../strangerBarRules': { serverStranger: () => false, strangerBarShown: () => false },
      '../contactRules': { contactLabel: unused, isContact: () => false, serverContacts: () => false },
      '../contacts': { useContactList: () => [], useContacts: { getState: unused } },
      '../peerName': { usePeerName: () => (_id: string, fallback: string) => fallback,
        dmPeerLabel: (value: DmChannel) => value.otherUser.displayName, peerNameNow: (_id: string, fallback: string) => fallback },
      '../connState': { useConnState: () => null, connLabel: () => null }, '../sockets': { sendTyping: unused },
      '../notifications': { clearOsNotifications: () => {} }, '../store': { useStore },
      '../toast': { toast: unused, toastError: unused, useToasts: { getState: unused } },
      '../typing': { useTyping: () => [], useTypingAction: () => null, typingActionLabel: () => '' },
      './Avatar': { Avatar: noView }, '../callStore': { useCall, explainCallPrivacy: unused }, '../callView': callRules,
      './StrangerBar': { StrangerBar: noView, StrangerReportModal: noView }, './ContactEditModal': { removeContactAsk: unused },
      './ContextMenu': { ContextMenu: MenuBoundary, MenuItem: MenuItemBoundary, MenuDivider: noView },
      './dmClearActions': { clearHistory: unused, deleteChat: unused, deleteFormerGroup: unused },
      './DmSidebar': { useMuteClock: () => Date.now() }, './FeedLoadError': { FeedLoadError: noView }, './Icon': { Icon: noView },
      './DmArchive': { archiveDms: unused }, '../dmArchiveRules': archiveRules, './DesktopKeys': { CHAT_MENU_EVENT: 'test-chat-menu' },
      './UserContextMenu': { useUserMenu: () => ({ openAt: unused, menu: null }) }, './MessagePane': { MessagePane: PaneBoundary },
      './ScheduledView': { ScheduledView: noView }, './StatusDot': { StatusDot: noView }, '../useLastSeen': { useLastSeen: () => presence?.lastSeen ?? null },
      '../dmOnline': { dmPresent: () => presence?.online ?? false, dmDot: () => presence?.online ?? false, useLocalOnline: () => false },
      '../lastSeenText': { serverLastSeen: () => !!presence, lastSeenLabel },
      './SavedAvatar': { SavedAvatar: noView, SavedEmpty: noView },
      '../groupChatRules': groupRules,
      './GroupDialogs': { leaveGroup: unused, openGroupInfo: unused }, '../clientId': { newClientId: unused },
      '../convStore': { feedWindowSwitch: () => true, toOutboxRef: unused }, '../convSyncRules': convRules,
      '../notifyExceptionsRules': { notifyAlwaysAction: () => null }, '../dmListRules': listRules,
      '../muteRecent': { loadMuteRecent: () => options.muteMenu ? [900, 93 * 86400] : [],
        saveMuteRecent: (seconds: number) => { savedMute.push(seconds); } }, '../dmBubbles': { dmBubblesSwitch: () => false },
      '../phoneLayout': phoneLayout, '../historyPage': { hasMoreOlder: unused, olderCursor: unused },
    };
    const module = { exports: {} as typeof Chat };
    runInNewContext(ts.transpileModule(raw, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText, { module, exports: module.exports, window, document, DOMRect, requestAnimationFrame,
      require: (id: string) => {
        assert.ok(Object.hasOwn(dependencies, id), `неожиданная зависимость ${id}`);
        return dependencies[id];
      } });
    const render = async () => { await React.act(async () => root.render(options.muteMenu
      ? React.createElement(module.exports.DmMuteMenuItems, { peerId: 'peer', mute: null, now: 0, onDone: () => {} })
      : React.createElement(module.exports.DmChatView, { dm }))); };
    await render();
    await check({ host, pinCalls, callIds, muteCalls, savedMute, render, currentDm: () => dm });
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally {
      host.remove();
      try { await GlobalRegistrator.unregister(); }
      finally {
        if (priorAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', priorAct);
        else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      }
    }
  }
}

async function click(host: HTMLElement, selector: string) {
  const button = host.querySelector<HTMLButtonElement>(selector);
  assert.ok(button, `кнопка ${selector} существует`);
  await React.act(async () => button.click());
}
function labels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[role="menuitem"]')].map(el => el.textContent ?? '');
}

for (const kind of ['direct', 'group', 'saved'] as const) {
  it(`R125 поле ${kind === 'direct' ? 'ЛС 1:1' : kind === 'group' ? 'группы' : 'Избранного'} подписано просто «Сообщение»`, async () => {
    // Ловит возврат имени/назначения беседы в подсказку поля, особенно в ветках группы и saved.
    const check = async (raw: string) => fixture(390, false, async f => {
      assert.equal(f.host.querySelector('textarea')?.getAttribute('placeholder'), 'Сообщение');
    }, raw, undefined, { kind });
    await check(source);
    const mutant = source.replace('placeholder="Сообщение"', 'placeholder={`Сообщение для ${peerName}`}');
    assert.notEqual(mutant, source);
    await assert.rejects(() => check(mutant), assert.AssertionError);
  });
}

it('R125 подменю сохраняет старые сроки, а окно времени даёт ровно пять пресетов и передаёт выбранный срок', async () => {
  // Проверяет реальный JSX меню: сокращение правил бесполезно, если компонент продолжит рисовать полную шкалу.
  const check = async (raw: string) => fixture(390, false, async f => {
    assert.ok(labels(f.host).includes('Выключить на 15 минут'));
    assert.ok(labels(f.host).includes('Выключить на 3 месяца'));
    const open = [...f.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find(el => el.textContent === 'Выключить на время…');
    assert.ok(open); await React.act(async () => open.click());
    assert.deepEqual(labels(f.host), ['Выключить на время', '1 час', '8 часов', '1 день', '2 дня', '1 неделя', 'Свой срок…']);
    const day = [...f.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent === '1 день');
    assert.ok(day); await React.act(async () => day.click());
    assert.deepEqual(f.savedMute, [86400]);
    assert.deepEqual(f.muteCalls, [['dm_user', 'peer', true, 86400, undefined]]);
  }, raw, undefined, { muteMenu: true });
  await check(source);
  const mutant = source.replace('{DM_MUTE_PRESETS.map((p)', '{DM_MUTE_PERIODS.map((p)')
    .replace('import { DM_MUTE_PRESETS,', 'import { DM_MUTE_PRESETS, DM_MUTE_PERIODS,');
  assert.notEqual(mutant, source);
  await assert.rejects(() => check(mutant), assert.AssertionError);
});

async function phoneCheck(width: number, pinned: boolean, raw = source) {
  await fixture(width, pinned, async f => {
    const titles = [...f.host.querySelectorAll('.topbar-actions > button')].map(el => el.getAttribute('title'));
    assert.deepEqual(titles, ['Позвонить', 'Меню беседы'], 'телефонная шапка содержит только звонок и меню');
    await click(f.host, 'button[title="Меню беседы"]');
    const items = labels(f.host);
    assert.equal(items[0], 'Поиск', 'поиск первый в телефонном меню');
    assert.equal(items.filter(label => label === 'Поиск').length, 1, 'поиск ровно один в телефонном меню');
    const pinLabel = pinned ? 'Открепить' : 'Закрепить';
    assert.ok(items.includes(pinLabel), 'телефонное меню содержит действие закрепления');
    assert.equal(items.indexOf(pinLabel), items.indexOf('В архив') + 1, 'закрепление следует сразу после архива');
    const pin = [...f.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent === pinLabel)!;
    await React.act(async () => pin.click());
    assert.deepEqual(f.pinCalls, [['conversation', !pinned]], 'нажатие вызывает настоящий toggleDmPinned с обратным состоянием');
    assert.equal(!!f.currentDm().pinnedAt, !pinned, 'экшен изменяет состояние закрепления беседы');
    assert.equal(f.host.querySelector('[role="menu"]'), null, 'после закрепления меню закрыто');
    await f.render();
    await click(f.host, 'button[title="Меню беседы"]');
    assert.ok(labels(f.host).includes(pinned ? 'Закрепить' : 'Открепить'), 'после обновления предложено обратное действие');
    const search = [...f.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent === 'Поиск')!;
    await React.act(async () => search.click());
    assert.ok(f.host.querySelector('[data-search-open]'), 'поиск из меню открывает поиск беседы');
    assert.equal(f.host.querySelector('[role="menu"]'), null);
    await click(f.host, 'button[title="Позвонить"]');
    assert.deepEqual(f.callIds, ['conversation'], 'телефонная кнопка звонка сохранила действие');
  }, raw);
}

for (const width of [390, 760]) for (const pinned of [false, true]) {
  it(`телефон ${width}px: ${pinned ? 'закреплённая' : 'незакреплённая'} беседа меняет закреп через меню`, () => phoneCheck(width, pinned));
}

for (const pinned of [false, true]) {
  it(`ПК 761px: ${pinned ? 'открепление' : 'закрепление'} и Поиск · Ctrl+F остаются в шапке`, async () => {
    await fixture(761, pinned, async f => {
      assert.deepEqual([...f.host.querySelectorAll('.topbar-actions > button')].map(el => el.getAttribute('title')),
        [pinned ? 'Открепить беседу' : 'Закрепить беседу в списке', 'Поиск · Ctrl+F', 'Позвонить', 'Меню беседы']);
      assert.equal(f.host.querySelector('.topbar-actions > button')?.getAttribute('aria-pressed'), String(pinned));
      await click(f.host, '.topbar-actions > button');
      assert.deepEqual(f.pinCalls, [['conversation', !pinned]]);
      assert.equal(!!f.currentDm().pinnedAt, !pinned);
      await f.render();
      assert.equal(f.host.querySelector('.topbar-actions > button')?.getAttribute('title'),
        pinned ? 'Закрепить беседу в списке' : 'Открепить беседу');
      assert.equal(f.host.querySelector('.topbar-actions > button')?.getAttribute('aria-pressed'), String(!pinned));
      await click(f.host, 'button[title="Поиск · Ctrl+F"]');
      assert.ok(f.host.querySelector('[data-search-open]'), 'ПК-поиск открывает тот же поиск беседы');
      await click(f.host, 'button[title="Меню беседы"]');
      assert.equal(labels(f.host).filter(label => label === 'Поиск').length, 1, 'в ПК-меню поиск не дублируется');
      assert.equal(labels(f.host).some(label => label === 'Закрепить' || label === 'Открепить'), false);
    });
  });
}

const mutations = [
  ['возвращает закреп и поиск в телефонную шапку', (s: string) => s.replace('prefsOn && !former && !phone && (', 'prefsOn && !former && (')
    .replace('searchOn && !phone && (', 'searchOn && ('), 'телефонная шапка содержит только звонок и меню'],
  ['убирает закрепление из телефонного меню', (s: string) => s.replace('phone && prefsOn && !former && (', 'false && prefsOn && !former && ('),
    'телефонное меню содержит действие закрепления'],
  ['дублирует поиск в телефонном меню', (s: string) => s.replace(
    '{searchOn && !phone && (\n                <MenuItem', '{searchOn && (\n                <MenuItem'),
    'поиск ровно один в телефонном меню'],
] as const;

it('R117 шапка сразу заменяет устаревший online снимок на только что или недавно, живое присутствие главнее', async () => {
  const check = async (raw: string) => {
    const snapshot: UserLastSeen = { userId: 'peer', online: true, exact: true,
      at: '2026-01-01T12:34:00.000Z', approx: null, byMe: false };
    const cases: Array<{ online: boolean; lastSeen: UserLastSeen | null; expected: string }> = [
      { online: false, lastSeen: snapshot, expected: 'был(а) только что' },
      { online: false, lastSeen: { ...snapshot, exact: false }, expected: 'был(а) недавно' },
      { online: true, lastSeen: snapshot, expected: 'в сети' },
      { online: true, lastSeen: { ...snapshot, exact: false }, expected: 'в сети' },
      { online: false, lastSeen: { ...snapshot, online: false, exact: false, at: null, approx: 'recently' }, expected: 'был(а) недавно' },
      { online: false, lastSeen: null, expected: '' },
    ];
    for (const row of cases) await fixture(390, false, async f => {
      const status = f.host.querySelector('.dm-who-status'); assert.ok(status);
      assert.equal(status.textContent, row.expected, 'статус не исчезает при запаздывающем снимке и не раскрывает время');
      if (!row.online && row.lastSeen?.exact === false) assert.doesNotMatch(status.textContent ?? '', /\d/);
    }, raw, row);
  };
  await check(source);
  const old = "lastSeen.online ? (lastSeen.exact ? 'был(а) только что' : 'был(а) недавно')";
  const mutant = source.replace(old, "lastSeen.online ? ''"); assert.notEqual(mutant, source);
  await assert.rejects(() => check(mutant), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('статус не исчезает'));
});

for (const [name, mutate, expectedFailure] of mutations) {
  it(`контрфакт шапки: ${name}`, async () => {
    await phoneCheck(760, false);
    const changed = mutate(source);
    assert.notEqual(changed, source, 'изменён настоящий JSX-контракт');
    await assert.rejects(() => phoneCheck(760, false, changed), (error: unknown) => {
      assert.ok(error instanceof assert.AssertionError);
      assert.match(error.message, new RegExp(`^${expectedFailure}`));
      return true;
    });
  });
}
