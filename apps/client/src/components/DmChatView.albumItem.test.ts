import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
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
import * as groupRules from '../groupChatRules';
import * as contactRules from '../contactRules';

type Pane = Parameters<typeof import('./MessagePane').MessagePane>[0];
type Chat = typeof import('./DmChatView');
type Options = { features?: string[]; former?: boolean; removed?: 'item' | 'message'; failForward?: number; failDelete?: boolean };
const source = readFileSync(new URL('./DmChatView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const unused = () => assert.fail('граница вне действий над элементом альбома');
const noView = () => null;
const data = (value: unknown) => JSON.parse(JSON.stringify(value));

async function fixture(options: Options, work: (f: {
  pane: Pane; forwards: Array<{ to: string; body: Record<string, unknown> }>;
  deletes: unknown[][]; localDeletes: unknown[][]; delivered: unknown[][]; newIds(): number;
}) => Promise<void>, raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/', width: 1200 });
  const priorAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let pane: Pane | undefined, ids = 0, failures = options.failForward ?? 0;
  const forwards: Array<{ to: string; body: Record<string, unknown> }> = [];
  const deletes: unknown[][] = [], localDeletes: unknown[][] = [], delivered: unknown[][] = [];
  const dm = { id: 'source-conversation', otherUser: { id: 'peer', username: 'peer', displayName: 'Собеседник', avatarUrl: null } } as DmChannel;
  const state = {
    user: { id: 'me', displayName: 'Я', avatarUrl: null, notifyDm: true }, dmMessages: { 'source-conversation': [] },
    pushMutedDmUsers: [], pushMuteUntil: {}, pushAlwaysTargets: [], convActive: true,
    serverFeatures: options.features ?? ['conv5', 'album1'],
    conv: { summaries: options.former ? { 'source-conversation': { former: { removed: false } } } : {}, windows: {}, gone: {} },
    outbox: {}, drafts: {}, draftRev: {}, places: {}, dms: [dm], historyFailed: [], blockedUsers: [],
    convAfterForward: (...args: unknown[]) => delivered.push(args),
    convAfterDelete: (...args: unknown[]) => localDeletes.push(args),
  };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  const useDmStickers = Object.assign((select: (s: { mine: never[]; recent: never[] }) => unknown) => select({ mine: [], recent: [] }), { getState: unused });
  const useCall = Object.assign((select: (s: { call: null }) => unknown) => select({ call: null }), { getState: unused });
  const api = {
    convForward: async (to: string, body: Record<string, unknown>) => {
      forwards.push({ to, body: data(body) });
      if (failures-- > 0) throw new Error('forward-failed');
      return { messages: [{ id: 'forwarded-item' }] };
    },
    convDeleteAlbumItem: async (...args: unknown[]) => {
      deletes.push(args);
      if (options.failDelete) throw new Error('album_item_peer_old');
      return { removed: options.removed ?? 'item' };
    },
  };
  const dependencies: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    '../dmStickerRules': { serverDmStickers: () => false }, '../dmStickers': { useDmStickers },
    './StickerCatalogPanel': { StickerCatalogPanel: noView },
    '../channelVisit': { useChannelVisit: () => ({ newSince: null, readKey: 0, visitKey: 'visit', started: true }) },
    '../api': { api }, '../effectsBus': { fireEffect: unused }, '../chatSearchRules': { SEARCH_PAGE: 50 },
    '../confirm': { confirmAction: unused }, '../strangerBarRules': { serverStranger: () => false, strangerBarShown: () => false },
    '../contactRules': contactRules, '../contacts': { useContactList: () => [], useContacts: { getState: unused } },
    '../peerName': { usePeerName: () => (_id: string, fallback: string) => fallback,
      dmPeerLabel: (value: DmChannel) => value.otherUser.displayName, peerNameNow: (_id: string, fallback: string) => fallback },
    '../connState': { useConnState: () => null, connLabel: () => null }, '../sockets': { sendTyping: unused },
    '../notifications': { clearOsNotifications: () => {} }, '../store': { useStore },
    '../toast': { toast: unused, toastError: unused, useToasts: { getState: unused } },
    '../typing': { useTyping: () => [], useTypingAction: () => null, typingActionLabel: () => '' },
    './Avatar': { Avatar: noView }, '../callStore': { useCall, explainCallPrivacy: unused }, '../callView': callRules,
    './StrangerBar': { StrangerBar: noView, StrangerReportModal: noView }, './ContactEditModal': { removeContactAsk: unused },
    './ContextMenu': { ContextMenu: noView, MenuItem: noView, MenuDivider: noView },
    './dmClearActions': { clearHistory: unused, deleteChat: unused, deleteFormerGroup: unused },
    './DmSidebar': { useMuteClock: () => Date.now() }, './FeedLoadError': { FeedLoadError: noView }, './Icon': { Icon: noView },
    './DmArchive': { archiveDms: unused }, '../dmArchiveRules': archiveRules, './DesktopKeys': { CHAT_MENU_EVENT: 'album-test-menu' },
    './UserContextMenu': { useUserMenu: () => ({ openAt: unused, menu: null }) },
    './MessagePane': { MessagePane: (props: Pane) => { pane = props; return React.createElement('div', { 'data-album-pane': true }); } },
    './ScheduledView': { ScheduledView: noView }, './StatusDot': { StatusDot: noView }, '../useLastSeen': { useLastSeen: () => null },
    '../dmOnline': { dmPresent: () => false, dmDot: () => false, useLocalOnline: () => false },
    '../lastSeenText': { serverLastSeen: () => false }, '../statusFit': { lastSeenForms: unused, useStatusFit: () => {} },
    './SavedAvatar': { SavedAvatar: noView, SavedEmpty: noView }, '../groupChatRules': groupRules,
    './GroupDialogs': { leaveGroup: unused, openGroupInfo: unused }, '../clientId': { newClientId: () => `client-${++ids}` },
    '../convStore': { toOutboxRef: unused }, '../convSyncRules': convRules,
    '../notifyExceptionsRules': { notifyAlwaysAction: () => null }, '../dmListRules': listRules,
    '../muteRecent': { loadMuteRecent: () => [], saveMuteRecent: unused }, '../phoneLayout': { usePhoneLayout: () => false },
  };
  try {
    const module = { exports: {} as Chat };
    // Исполняется весь DmChatView и его useMemo/обработчики. MessagePane — только граница для чтения переданных callback.
    runInNewContext(ts.transpileModule(raw, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText, { module, exports: module.exports, window, document, DOMRect, requestAnimationFrame, Error,
      require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `объявленная зависимость DmChatView: ${id}`); return dependencies[id]; },
    });
    await React.act(async () => { root.render(React.createElement(module.exports.DmChatView, { dm })); });
    assert.ok(pane, 'полный DmChatView смонтировал границу MessagePane');
    await work({ pane, forwards, deletes, localDeletes, delivered, newIds: () => ids });
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

async function oldServer(raw = source) {
  await fixture({ features: ['conv5'] }, async f => {
    assert.equal(typeof f.pane.batch?.forward, 'function', 'прежняя пересылка сообщения остаётся у старого сервера');
    assert.equal(typeof f.pane.batch?.forwardItem, 'undefined', 'G56-feature: сервер без album1 не получает callback одного элемента');
    assert.equal(typeof f.pane.batch?.deleteItem, 'undefined', 'сервер без album1 не получает удаление одной ячейки');
  }, raw);
}
it('R213 DmChatView без album1 сохраняет batch, но не выдаёт новые callback', () => oldServer());
it('R213 DmChatView с album1 и conv5 выдаёт оба callback, но album1 без conv5 не выдаёт batch', async () => {
  await fixture({}, async f => {
    assert.equal(typeof f.pane.batch?.forwardItem, 'function'); assert.equal(typeof f.pane.batch?.deleteItem, 'function');
  });
  await fixture({ features: ['album1'] }, async f => { assert.equal(f.pane.batch, undefined); });
});
it('R213 бывшая группа не получает batch и новые действия над её альбомом', async () => {
  await fixture({ former: true }, async f => { assert.equal(f.pane.batch, undefined); });
});

async function forward(raw = source, enabledFlags = false) {
  await fixture({ features: ['conv5', 'album1', ...(enabledFlags ? ['conv8', 'fwd2'] : [])] }, async f => {
    await f.pane.batch!.forwardItem!('album-message', 'selected-item', 'target-conversation', true, { hideSender: true });
    const expected = {
      clientId: 'client-1', fromConversationId: 'source-conversation', messageIds: ['album-message'], attachmentId: 'selected-item',
      ...(enabledFlags ? { silent: true, hideSender: true } : {}),
    };
    assert.equal(JSON.stringify(f.forwards), JSON.stringify([{ to: 'target-conversation', body: expected }]),
      'G56-dm-forward: настоящий callback сохраняет источник, единственное сообщение и выбранный attachmentId');
    assert.equal(JSON.stringify(f.delivered), '[["target-conversation",[{"id":"forwarded-item"}]]]',
      'ответ пересылки обновляет только выбранную беседу');
  }, raw);
}
it('R213 callback пересылки одного элемента сохраняет attachmentId и не шлёт неподдержанные опции', () => forward());
it('R213 callback пересылки одного элемента передаёт silent и hideSender только при признаках', () => forward(source, true));
it('R213 повтор после отказа использует прежний clientId, успех снимает ключ, другой элемент имеет другой ключ', async () => {
  await fixture({ failForward: 1 }, async f => {
    const run = f.pane.batch!.forwardItem!;
    await assert.rejects(run('album-message', 'item-a', 'target'), /forward-failed/);
    await run('album-message', 'item-a', 'target');
    await run('album-message', 'item-a', 'target');
    await run('album-message', 'item-b', 'target');
    assert.deepEqual(f.forwards.map(call => call.body.clientId), ['client-1', 'client-1', 'client-2', 'client-3']);
    assert.deepEqual(f.forwards.map(call => call.body.attachmentId), ['item-a', 'item-a', 'item-a', 'item-b']);
    assert.equal(f.newIds(), 3); assert.equal(f.delivered.length, 3, 'отказ не обновляет получателя, каждый успех обновляет');
  });
});

async function deletion(raw = source, removed: 'item' | 'message' = 'message') {
  await fixture({ removed }, async f => {
    await f.pane.batch!.deleteItem!('album-message', 'selected-item', 'both');
    assert.equal(JSON.stringify(f.deletes), '[["source-conversation","album-message","selected-item","both"]]',
      'G56-dm-delete: настоящий callback сохраняет беседу, messageId, attachmentId и область');
    assert.equal(JSON.stringify(f.localDeletes), removed === 'message' ? '[["source-conversation","album-message"]]' : '[]',
      'G56-dm-whole: удаление последнего элемента снимает сообщение, остальные ждут conv.change');
  }, raw);
}
it('R213 callback удаления последнего элемента сразу снимает всё сообщение', () => deletion());
it('R213 callback удаления одного из нескольких не выдумывает удаление всего сообщения до conv.change', () => deletion(source, 'item'));
it('R213 отказ удаления старого соседа передаётся ленте и не меняет сообщение оптимистично', async () => {
  await fixture({ failDelete: true }, async f => {
    await assert.rejects(f.pane.batch!.deleteItem!('album-message', 'selected-item', 'me'), /album_item_peer_old/);
    assert.deepEqual(f.localDeletes, []);
    assert.equal(JSON.stringify(f.deletes), '[["source-conversation","album-message","selected-item","me"]]');
  });
});

for (const [name, from, to, scenario, prefix, actual, expected] of [
  ['album1 принудительно включён старому серверу', 'serverAlbumItemsOn(s.serverFeatures)', 'true', oldServer,
    'G56-feature:', 'function', 'undefined'],
  ['потерян attachmentId при пересылке', '                      attachmentId,\n', '', forward,
    'G56-dm-forward:',
    '[{"to":"target-conversation","body":{"clientId":"client-1","fromConversationId":"source-conversation","messageIds":["album-message"]}}]',
    '[{"to":"target-conversation","body":{"clientId":"client-1","fromConversationId":"source-conversation","messageIds":["album-message"],"attachmentId":"selected-item"}}]'],
  ['ответ последнего элемента не снимает сообщение', "if (res.removed === 'message') useStore.getState().convAfterDelete(dm.id, messageId);", 'if (false) useStore.getState().convAfterDelete(dm.id, messageId);', deletion,
    'G56-dm-whole:', '[]', '[["source-conversation","album-message"]]'],
] as const) it(`R213 DmChatView контрфакт: ${name}`, async () => {
  await scenario(); assert.equal(source.split(from).length - 1, 1, 'мутант меняет одно место полного DmChatView');
  await assert.rejects(scenario(source.replace(from, to)), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith(prefix) && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected);
});
