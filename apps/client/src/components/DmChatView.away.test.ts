import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import type { DmChannel, PresenceStatus, UserLastSeen } from '@gusvoice/shared';
import * as archiveRules from '../dmArchiveRules';
import * as listRules from '../dmListRules';
import * as convRules from '../convSyncRules';
import * as groupRules from '../groupChatRules';
import * as contactRules from '../contactRules';
import * as callRules from '../callView';
import * as lastSeenText from '../lastSeenText';
import { lastSeenForms } from '../statusFit';
import { STATUS_LABEL } from '../status';
import { StatusDot } from './StatusDot';

const source = readFileSync(new URL('./DmChatView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const onlineSource = readFileSync(new URL('../dmOnline.ts', import.meta.url), 'utf8');
type ChatModule = typeof import('./DmChatView');
type OnlineModule = typeof import('../dmOnline');
type PaneProps = Parameters<typeof import('./MessagePane').MessagePane>[0];
type Statuses = Record<string, { status: PresenceStatus }>;
type Presence = 'voice' | 'call' | 'offline';
type Scene = { presence: Presence; statuses?: Statuses; phone?: boolean };

const unused = () => { throw new Error('R284: вызвано действие за границей проверки шапки'); };
const noView = () => null;

function loadModule<T>(raw: string, fileName: string, dependencies: Record<string, unknown>): T {
  const module = { exports: {} as T };
  // Только целые настоящие модули; неожиданный импорт — ошибка харнесса, не «пойманный мутант».
  runInNewContext(ts.transpileModule(raw, {
    fileName,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports,
    require: (id: string) => {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`R284: неописанный импорт ${fileName}: ${id}`);
      return dependencies[id];
    },
  });
  return module.exports;
}

function renderHeader(scene: Scene, raw = source): string {
  const dm = {
    id: 'conversation', otherUser: { id: 'peer', username: 'peer', displayName: 'Собеседник', avatarUrl: null },
    pinnedAt: null, archived: false,
  } as DmChannel;
  const state = {
    user: { id: 'me', displayName: 'Я', avatarUrl: null, notifyDm: true },
    dmMessages: { conversation: [] },
    serverFeatures: ['presence4', 'presence5', 'lastseen1'],
    // «Здесь» уже решено шлюзом. Проверяем оба его источника без обращения к настоящему стору/звонкам.
    onlineUsers: scene.presence === 'voice' ? ['peer'] : [],
    dmOnlineUsers: scene.presence === 'call' ? ['peer'] : [],
    dmAwayUsers: [],
    userStatuses: scene.statuses,
    conv: { summaries: {}, windows: {}, gone: {} },
    pushMutedDmUsers: [], pushMuteUntil: {}, pushAlwaysTargets: [], convActive: true,
    outbox: {}, drafts: {}, draftRev: {}, places: {}, historyFailed: [], blockedUsers: [], dms: [dm],
  };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  const useDmStickers = Object.assign((select: (s: { mine: never[]; recent: never[] }) => unknown) => select({ mine: [], recent: [] }),
    { getState: unused });
  const useCall = Object.assign((select: (s: { call: null | { conversationId: string } }) => unknown) =>
    select({ call: scene.presence === 'call' ? { conversationId: dm.id } : null }), { getState: unused });
  const online = loadModule<OnlineModule>(onlineSource, 'dmOnline.ts', {
    react: React, '@gusvoice/shared': shared, './api': { api: {} }, './store': { useStore },
  });
  const seen: UserLastSeen = {
    userId: 'peer', online: false, exact: false, at: null, approx: 'recently', byMe: false,
  };
  const dependencies: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    '../dmStickerRules': { serverDmStickers: () => false }, '../dmStickers': { useDmStickers },
    './StickerCatalogPanel': { StickerCatalogPanel: noView },
    '../channelVisit': { useChannelVisit: () => ({ newSince: null, readKey: 0, visitKey: 'visit', started: true }) },
    '../api': { api: {} }, '../effectsBus': { fireEffect: unused }, '../chatSearchRules': { SEARCH_PAGE: 50 },
    '../confirm': { confirmAction: unused },
    '../strangerBarRules': { serverStranger: () => false, strangerBarShown: () => false },
    '../contactRules': contactRules, '../contacts': { useContactList: () => [], useContacts: { getState: unused } },
    '../peerName': {
      usePeerName: () => (_id: string, fallback: string) => fallback,
      dmPeerLabel: (value: DmChannel) => value.otherUser.displayName,
      peerNameNow: (_id: string, fallback: string) => fallback,
    },
    '../connState': { useConnState: () => null, connLabel: () => null }, '../sockets': { sendTyping: unused },
    '../notifications': { clearOsNotifications: unused }, '../store': { useStore },
    '../toast': { toast: unused, toastError: unused, useToasts: { getState: unused } },
    '../typing': { useTyping: () => [], useTypingAction: () => null, typingActionLabel: () => '' },
    './Avatar': { Avatar: noView }, '../callStore': { useCall, explainCallPrivacy: unused }, '../callView': callRules,
    './StrangerBar': { StrangerBar: noView, StrangerReportModal: noView }, './ContactEditModal': { removeContactAsk: unused },
    './ContextMenu': { ContextMenu: noView, MenuDivider: noView, MenuItem: noView },
    './dmClearActions': { clearHistory: unused, deleteChat: unused, deleteFormerGroup: unused },
    './DmSidebar': { useMuteClock: () => 0 }, './FeedLoadError': { FeedLoadError: noView }, './Icon': { Icon: noView },
    './DmArchive': { archiveDms: unused }, '../dmArchiveRules': archiveRules,
    './DesktopKeys': { CHAT_MENU_EVENT: 'r284-chat-menu' },
    './UserContextMenu': { useUserMenu: () => ({ openAt: unused, menu: null }) },
    './MessagePane': { MessagePane: (props: PaneProps) => React.createElement('header', { 'data-r284-pane': true }, props.title) },
    './ScheduledView': { ScheduledView: noView }, './StatusDot': { StatusDot },
    '../useLastSeen': { useLastSeen: (id: string | null) => id ? seen : null },
    // Реальные dmPresent/dmDot считают online; отключён только таймерный hook локального действия.
    '../dmOnline': { ...online, useLocalOnline: () => false }, '../lastSeenText': lastSeenText,
    '../statusFit': { lastSeenForms, useStatusFit: () => {} },
    './SavedAvatar': { SavedAvatar: noView, SavedEmpty: noView }, '../groupChatRules': groupRules,
    './GroupDialogs': { leaveGroup: unused, openGroupInfo: unused }, '../clientId': { newClientId: unused },
    '../convStore': { toOutboxRef: unused }, '../convSyncRules': convRules,
    '../notifyExceptionsRules': { notifyAlwaysAction: () => null }, '../dmListRules': listRules,
    '../muteRecent': { loadMuteRecent: () => [], saveMuteRecent: unused },
    '../phoneLayout': { usePhoneLayout: () => !!scene.phone },
  };
  const chat = loadModule<ChatModule>(raw, 'DmChatView.tsx', dependencies);
  return renderToStaticMarkup(React.createElement(chat.DmChatView, { dm }));
}

const address = (scene: string, target: string) => `R284 / DmChatView / ${scene} / ${target}`;
const away = STATUS_LABEL.away.toLocaleLowerCase('ru-RU');

function checkHeader(scene: Scene, expectedDot: 'away' | 'online' | null, expectedText: string, name: string, raw = source,
  textFirst = false): void {
  const html = renderHeader(scene, raw);
  assert.equal(html.includes('data-r284-pane="true"'), true, address(name, 'настоящий компонент дошёл до MessagePane'));
  const text = /<span\b[^>]*class="dm-who-status"[^>]*>(.*?)<\/span>/s.exec(html)?.[1] ?? null;
  const dots = [...html.matchAll(/class="stdot stdot-([^"]+)"/g)].map(match => match[1]);
  const checkText = () => assert.equal(text, expectedText, address(name, '.dm-who-status / текст'));
  const checkDot = () => assert.deepEqual(dots, expectedDot ? [expectedDot] : [], address(name, '.dm-ava / настоящий StatusDot'));
  if (textFirst) { checkText(); checkDot(); } else { checkDot(); checkText(); }
}

// Класс ошибки: выбранный away теряется, когда присутствие собеседника приходит из голоса или отдельного online для ЛС.
it('R284 присутствующий собеседник away получает настоящую луну и подпись «нет на месте»', () => {
  for (const presence of ['voice', 'call'] as const)
    checkHeader({ presence, statuses: { peer: { status: 'away' } } }, 'away', away, `${presence} + away`);
});

// Класс ошибки: необязательный снимок статусов или отсутствие записи ошибочно скрывает обычное присутствие.
it('R284 присутствующий без снимка статусов или своей записи остаётся «в сети» с зелёной точкой', () => {
  for (const presence of ['voice', 'call'] as const) for (const statuses of [undefined, {}])
    checkHeader({ presence, statuses }, 'online', 'в сети', `${presence} + без статуса`);
});

// Класс ошибки: запоздалый away заменяет «был(а)» и рисует луну человеку, которого уже нет здесь.
it('R284 offline с away и без него сохраняет last-seen без точки присутствия', () => {
  for (const statuses of [{ peer: { status: 'away' as const } }, undefined])
    checkHeader({ presence: 'offline', statuses }, null, 'был(а) недавно', 'offline + снимок away или пусто');
});

// Класс ошибки: селектор читает статус не собеседника и переносит чужую луну в открытую личку.
it('R284 away другого пользователя и свой away не превращают собеседника в «отошёл»', () => {
  checkHeader({ presence: 'voice', statuses: { stranger: { status: 'away' }, me: { status: 'away' } } },
    'online', 'в сети', 'away другого id');
});

// Класс ошибки: любое истинное значение status принимается за away вместо точного сравнения статуса.
it('R284 dnd, invisible и online в снимке не получают подпись и луну away', () => {
  for (const status of ['dnd', 'invisible', 'online'] as const)
    checkHeader({ presence: 'voice', statuses: { peer: { status } } }, 'online', 'в сети', `здесь + ${status}`);
});

// Класс ошибки: телефонная ветка забывает новую подпись или возвращает точку поверх аватара.
it('R284 на телефоне away остаётся словами, а обычный online сохраняется без точки', () => {
  for (const status of ['away', 'online'] as const)
    checkHeader({ presence: 'voice', statuses: { peer: { status } }, phone: true }, null,
      status === 'away' ? away : 'в сети', `телефон + ${status}`);
});

const anchor = "const peerAway = useStore((s) => s.userStatuses?.[dm.otherUser.id]?.status === 'away');";
for (const textFirst of [false, true]) {
  // Класс ошибки: исходник игнорирует userStatuses; отдельно доказываем чувствительность точки и текста настоящего JSX.
  it(`R284 мутант игнора userStatuses обнаруживается ${textFirst ? 'подписью' : 'настоящим StatusDot'}, не ошибкой загрузки`, () => {
    const scene: Scene = { presence: 'voice', statuses: { peer: { status: 'away' } } };
    const name = 'voice + away';
    checkHeader(scene, 'away', away, name, source, textFirst);
    assert.equal(source.split(anchor).length - 1, 1, 'R284 / DmChatView / мутация / один актуальный селектор peerAway');
    const mutant = source.replace(anchor, 'const peerAway = false;');
    const expectedAddress = address(name, textFirst ? '.dm-who-status / текст' : '.dm-ava / настоящий StatusDot');
    assert.throws(() => checkHeader(scene, 'away', away, name, mutant, textFirst),
      (error: unknown) => error instanceof assert.AssertionError && error.message.split('\n')[0] === expectedAddress);
  });
}
