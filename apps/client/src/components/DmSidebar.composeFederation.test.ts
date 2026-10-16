import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import type { RemoteUserHit } from '@gusvoice/shared';
import * as dmRules from '../dmRules';
import * as convRules from '../convSyncRules';
import * as contactRules from '../contactRules';
import * as listRules from '../dmListRules';

const source = readFileSync(new URL('./DmSidebar.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const localPeer = { id: 'local-peer', username: 'peer', displayName: 'Местный собеседник', avatarUrl: null };
const remotePeer: RemoteUserHit = { instanceId: 'neighbor', homeUserId: 'home-peer', username: 'peer',
  displayName: 'Человек соседа', avatarUrl: null, instance: { name: 'Сосед', domain: 'neighbor.example' } };
type Scene = 'remote' | 'local' | 'mixed' | 'empty';
async function compose(scene: Scene, phone = false, raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const priorAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const searches: string[] = []; const opened: Array<{ instanceId: string; homeUserId: string }> = [];
  let closed = 0;
  const timers = new Map<number, () => void>(); let nextTimer = 0;
  const remote = scene === 'remote' || scene === 'mixed' ? [remotePeer] : [];
  const local = scene === 'local' || scene === 'mixed' ? [localPeer] : [];
  const query = scene === 'remote' || scene === 'empty' ? '@peer@neighbor.example' : 'peer';
  const contacts: never[] = []; const onlineSet = new Set<string>(); const seen = new Map<string, string>();
  const nameOf = (_id: string, fallback: string) => fallback;
  const state = { members: local.map(user => ({ user })), dms: [], user: { id: 'me' }, serverFeatures: ['users1', 'fedm1'], convActive: true,
    openDmWith: async () => {}, openSaved: async () => {},
    openDmRemote: async (person: { instanceId: string; homeUserId: string }) => { opened.push(person); },
  };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  try {
    // Управляем лишь дебаунсом API: DOM нужен для JSX/клика, не для layout, env или реального стора.
    window.setTimeout = ((callback: () => void, ms: number) => {
      assert.equal(ms, dmRules.USER_SEARCH_DELAY_MS); const id = ++nextTimer; timers.set(id, callback); return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof window.clearTimeout;
    const deps: Record<string, unknown> = {
      react: React, 'react/jsx-runtime': jsx, '../store': { useStore }, '../dmRules': dmRules,
      '../convSyncRules': convRules, '../contactRules': contactRules, '../dmListRules': listRules,
      '../api': { api: { searchUsers: async (q: string) => { searches.push(q); return { users: [], remote }; } } },
      '../dmOnline': { useVisibleOnline: () => onlineSet }, '../useContactSeen': { useContactSeen: () => seen },
      '../phoneLayout': { usePhoneLayout: () => phone }, '../hotkeys': { isMobile: () => phone, isTauri: () => false },
      '../dialogChrome': { useDialogChrome: () => React.useRef(null) },
      '../toast': { toast: () => assert.fail('неожиданный отказ compose'), toastError: (e: Error) => { throw e; } },
      '../dmCompose': { closeDmCompose: () => { closed++; } }, '../contacts': { useContactList: () => contacts },
      '../peerName': { usePeerName: () => nameOf },
      './Avatar': { Avatar: () => null }, './Icon': { Icon: () => null },
      './BottomSheet': { BottomSheet: ({ children }: { children: React.ReactNode }) => React.createElement('div', { 'data-compose-sheet': true }, children) },
    };
    // Белый список остальных импортов целого DmSidebar. Их функции не выполняются в сцене NewDmSheet.
    for (const id of ['../channelRules', '../chatKeysRules', '../dmArchiveRules', '../dmRowRules', '../typing', '../androidBack', '../connState',
      './SavedAvatar', './GroupDialogs', '../groupChatRules', './DmRowMenu', './DmFolderBar', '../dmFolderView', '../dmFolders',
      '../cornerButtonsRules', '../dmListSearchRules', './DmServerSearch', './DmAllSearch', './DmListSearch', './DmArchive',
      '../dragOut', '../dmListView', '../uiPrefs', '../filesDrop', './DmListSwipe', './DmPinDrag', '../chatSwipe', './Goose',
      './SelfVoiceBar', './SettingsShell', './SharedMedia', './StatusDot', './VoicePanel', '../voiceDrafts']) deps[id] = {};
    const module = { exports: {} as { NewDmSheet: React.ComponentType<{ initialQuery: string }> } };
    // Экспорт приватного компонента добавлен ТОЛЬКО в тестовый модуль, вся исходная реализация исполняется целиком.
    runInNewContext(ts.transpileModule(`${raw}\nexport { NewDmSheet };`, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, window, document, require: (id: string) => {
        assert.equal(Object.hasOwn(deps, id), true, `неописанная граница compose ${id}`); return deps[id];
      } });
    await React.act(async () => root.render(React.createElement(module.exports.NewDmSheet, { initialQuery: query })));
    await React.act(async () => { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); });
    assert.equal(searches.length, 1); assert.equal(searches[0], query, 'поиск передаёт домашний адрес без потери инстанса');
    assert.equal(!!host.querySelector('.dm-compose-list'), scene !== 'empty', 'одни remote тоже открывают список compose');
    assert.equal(host.querySelectorAll('.dm-compose-list .sheet-row').length, local.length + remote.length, 'видны все местные и удалённые результаты');
    assert.equal(!!host.querySelector('[data-compose-sheet]'), phone);
    assert.equal(!!host.querySelector('.modal.dm-compose'), !phone);
    assert.equal(!!host.querySelector('.sheet-empty'), scene === 'empty');
    if (remote.length) {
      const row = [...host.querySelectorAll<HTMLButtonElement>('.dm-compose-list .sheet-row')].find(el => el.textContent?.includes(remotePeer.displayName));
      assert.equal(!!row, true, 'найденный человек соседа виден в picker');
      assert.equal(row?.querySelector('.dm-sub')?.textContent?.trim(), '@peer@neighbor.example');
      assert.equal(host.textContent?.includes('Другие инстансы'), true);
      await React.act(async () => row!.click());
      assert.equal(closed, 1); assert.equal(opened.length, 1);
      assert.equal(opened[0].instanceId, remotePeer.instanceId); assert.equal(opened[0].homeUserId, remotePeer.homeUserId);
    }
  } finally {
    try { await React.act(async () => root.unmount()); } finally {
      host.remove(); try { await GlobalRegistrator.unregister(); } finally {
        if (priorAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', priorAct);
        else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      }
    }
  }
}
it('R197 окно Написать показывает одни remote без местных совпадений, клик открывает домашнюю пару', async () => {
  for (const phone of [false, true]) await compose('remote', phone);
});
it('R197 окно Написать сохраняет местный и смешанный списки, действительно пустая выдача остаётся подсказкой', async () => {
  for (const phone of [false, true]) for (const scene of ['local', 'mixed', 'empty'] as const) await compose(scene, phone);
});
it('R197 мутант без remote в условии обёртки обнаруживается удалённой выдачей ПК', async () => {
  await compose('remote');
  const anchor = '(contactRows.length > 0 || candidates.length > 0 || found.length > 0 || remote.length > 0)';
  assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь списка Написать');
  await assert.rejects(compose('remote', false, source.replace(anchor, '(contactRows.length > 0 || candidates.length > 0 || found.length > 0)')),
    e => e instanceof assert.AssertionError && e.message.includes('одни remote тоже открывают список compose'));
});
