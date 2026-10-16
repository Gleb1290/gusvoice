import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, after, it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as lists from '../dmListRules';
import * as sync from '../convSyncRules';
import * as search from '../dmListSearchRules';
import * as folders from '../dmFolderView';
import * as dmRules from '../dmRules';
import * as rows from '../dmRowRules';
import * as archives from '../dmArchiveRules';

const source = readFileSync(new URL('./DmSidebar.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let createRoot: typeof import('react-dom/client')['createRoot'];
const actDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
before(async () => {
  GlobalRegistrator.register();
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
  createRoot = (await import('react-dom/client')).createRoot;
});
after(async () => {
  await GlobalRegistrator.unregister();
  if (actDescriptor) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actDescriptor);
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});
function replaceOnce(anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, `уникальный якорь ${anchor}`);
  return source.replace(anchor, replacement);
}

type SceneOptions = { users?: boolean; guest?: boolean; archive?: boolean; people?: boolean;
  calls?: string[]; opened?: string[]; timers?: Map<number, () => void> };
async function scene(phone: boolean, check: (host: HTMLDivElement, unmount: () => Promise<void>) => Promise<void>, raw = source, opts: SceneOptions = {}) {
  const nil = () => null, noop = () => {};
  const dms = [{ id: 'dm', createdAt: '2026-10-12T00:00:00Z', lastMessageAt: null,
    archived: !!opts.archive, otherUser: { id: 'peer', username: 'peer', displayName: 'Беседа', avatarUrl: null } }];
  const state = { dms, currentDmId: null, mobilePane: 'list', view: 'dm', unreadDms: [], voice: null,
    user: { id: 'self', homeInstance: opts.guest ? 'guest.invalid' : null }, convActive: true, conv: { ...sync.emptyConvState(), phase: 'live', pts: 1 },
    members: opts.people ? [{ user: { id: 'local', username: 'dmtest_local', displayName: 'Беседа местная', avatarUrl: null } }, { user: dms[0].otherUser }] : [],
    openDmWith: async (id: string) => { opts.opened?.push(id); },
    serverFeatures: ['conv1', 'conv2', ...(opts.users ? ['users1'] : []), ...(opts.archive ? ['archive1'] : [])], drafts: {}, outbox: {}, pushMutedDmUsers: [], pushMuteUntil: {},
    blockedUsers: [], loadDms: async () => {}, selectDm: async () => {} };
  const useStore = Object.assign((pick: (s: typeof state) => unknown) => pick(state), { getState: () => state });
  const deps: Record<string, unknown> = {
    // Изолируем только строку на границе memo: её кнопка вызывает настоящий togglePick родителя.
    react: { ...React, memo: () => (p: { dm: { id: string }; onPick?: (id: string) => void }) =>
      React.createElement('button', { className: 'dm-row', onClick: () => p.onPick?.(p.dm.id) }, 'Выбрать беседу') },
    'react/jsx-runtime': jsx, '../store': { useStore },
    '../hotkeys': { isMobile: () => phone, isTauri: () => false }, '../phoneLayout': { usePhoneLayout: () => phone },
    '../peerName': { usePeerName: () => (_id: string, name: string) => name, dmPeerLabel: (d: typeof dms[number]) => d.otherUser.displayName },
    '../dmListRules': lists, '../convSyncRules': sync, '../dmListSearchRules': search, '../dmFolderView': folders,
    '../dmRules': dmRules, '../dmRowRules': rows,
    '../api': { api: { searchUsers: async (query: string) => { opts.calls?.push(query); return { users: [
      { id: 'global', username: 'dmtest_global', displayName: 'Глобальная беседа', avatarUrl: null },
    ] }; } } }, '../toast': { toast: noop, toastError: noop }, './Avatar': { Avatar: nil },
    '../dmArchiveRules': archives,
    '../dmCompose': { useDmCompose: () => ({ open: false }), closeDmCompose: noop },
    '../dmFolders': { useDmFolders: (pick: (s: { activeId: null }) => unknown) => pick({ activeId: null }) },
    '../dmOnline': { useVisibleOnline: () => new Set() }, '../voiceDrafts': { useVoiceDraftKeys: () => new Map() },
    '../connState': { useConnState: () => 'online', connLabel: () => null },
    '../uiPrefs': { useSidebarNarrow: () => false, setNarrowAllowed: noop }, '../dmListView': { useListLines: () => 'two' },
    '../androidBack': { pushBackHandler: () => noop }, './DmPinDrag': { useDmPinDrag: noop },
    './DmArchive': { useArchiveCollapsed: () => [false, noop],
      DmArchiveRow: (p: { onOpen: () => void }) => React.createElement('button', { className: 'archive-open', onClick: p.onOpen }, 'Архив'),
      DmArchiveHead: (p: { onBack: () => void }) => React.createElement('button', { className: 'archive-back', onClick: p.onBack }, 'Назад') },
    './DmRowMenu': { useDmRowMenu: () => ({ openDmMenu: noop, menu: null }), useDmListMenu: () => ({ openListMenu: noop, menu: null }),
      DmPickHead: (p: { onClose: () => void }) => React.createElement('button', { className: 'pick-close', onClick: p.onClose }, 'Закрыть выбор') },
    './DmFolderBar': { useDmFolderUi: () => ({ on: false, home: true, ownPins: null, bar: null }) },
    './DmListSwipe': { useSwipeCaps: () => ({}), useSwipeSetting: () => ['auto'], useDmListSwipe: () => ({ bind: {}, overlay: null }) },
    '../chatSwipe': { effectiveSwipe: () => null },
    './DmListSearch': { useRecentSearches: () => ({ recents: [], remove: noop, clear: noop, push: noop }),
      useFrequentHidden: () => ({ hidden: {}, hide: noop }), useFrequent: () => [] },
    './DmAllSearch': { DmSearchTabs: nil, DmKindHits: nil, AllMessageHits: nil },
    './SettingsShell': { SettingsSearch: (p: { inputRef: React.Ref<HTMLInputElement> } & React.InputHTMLAttributes<HTMLInputElement>) => {
      const { inputRef, ...rest } = p; return React.createElement('input', { ...rest, ref: inputRef });
    } },
    './Icon': { Icon: nil }, './GroupDialogs': { GroupDialogHost: nil }, './SharedMedia': { SharedMediaHost: nil }, './SelfVoiceBar': { SelfVoiceBar: nil },
  };
  const unused = ['../useContactSeen', '../dialogChrome', '../channelRules', '../chatKeysRules', '../typing',
    '../contactRules', '../contacts', './SavedAvatar', '../groupChatRules', '../cornerButtonsRules', './DmServerSearch',
    '../dragOut', '../filesDrop', './Goose', './StatusDot', './VoicePanel', './BottomSheet'];
  for (const id of unused) deps[id] = new Proxy({}, { get(_t, key) { assert.fail(`неожиданная граница ${id}.${String(key)}`); } });
  const module = { exports: {} as { DmSidebar: React.ComponentType } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, window, document, Date, Element,
      require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `неописанный импорт ${id}`); return deps[id]; } });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let mounted = true;
  const unmount = async () => { if (mounted) { await React.act(async () => root.unmount()); mounted = false; } };
  const hadClass = document.documentElement.classList.contains('gv-listsearch');
  const hadArchive = document.documentElement.classList.contains('gv-listarchive');
  const originalSetTimeout = window.setTimeout, originalClearTimeout = window.clearTimeout;
  let nextTimer = 0;
  if (opts.timers) {
    window.setTimeout = ((fn: () => void) => { const id = ++nextTimer; opts.timers!.set(id, fn); return id; }) as typeof window.setTimeout;
    window.clearTimeout = ((id: number) => { opts.timers!.delete(id); }) as typeof window.clearTimeout;
  }
  document.documentElement.classList.remove('gv-listsearch');
  document.documentElement.classList.remove('gv-listarchive');
  try { await React.act(async () => root.render(React.createElement(module.exports.DmSidebar))); await check(host, unmount); }
  finally {
    try { await unmount(); } finally { host.remove(); document.documentElement.classList.toggle('gv-listsearch', hadClass);
      document.documentElement.classList.toggle('gv-listarchive', hadArchive);
      window.setTimeout = originalSetTimeout; window.clearTimeout = originalClearTimeout; }
  }
}
const field = (host: HTMLDivElement) => host.querySelector<HTMLInputElement>('.dm-find input')!;
const zone = (host: HTMLDivElement) => host.querySelector<HTMLElement>('.dm-find-zone')!;
const rootSearch = () => document.documentElement.classList.contains('gv-listsearch');
async function scroll(host: HTMLDivElement, top: number) {
  // HappyDOM не считает layout: scrollTop задаётся явно; проверяем реакцию на событие, не физическую прокрутку.
  await React.act(async () => { const list = host.querySelector<HTMLElement>('.dm-list')!; list.scrollTop = top; list.dispatchEvent(new Event('scroll', { bubbles: true })); });
}
async function lifecycle(host: HTMLDivElement, unmount: () => Promise<void>) {
  assert.equal(rootSearch(), false);
  await React.act(async () => field(host).focus());
  assert.equal(rootSearch(), true, 'поиск добавляет корневой класс'); assert.equal(zone(host).classList.contains('on'), true);
  await React.act(async () => field(host).blur());
  assert.equal(rootSearch(), false, 'закрытие снимает корневой класс'); assert.equal(zone(host).classList.contains('on'), false);
  await React.act(async () => field(host).focus()); await unmount();
  assert.equal(rootSearch(), false, 'размонтирование снимает корневой класс');
}
it('R170 телефонный поиск помечает корень только пока открыт и очищает его при выходе и размонтировании', async () => {
  // Без cleanup капсула навигации исчезла бы на следующем экране.
  await scene(true, lifecycle);
});
it('R170 поле находится внутри ленты телефона, но над лентой ПК', async () => {
  // Положение в DOM определяет, уедет ли поле с прокруткой; HappyDOM не выдаётся за layout-проверку.
  for (const phone of [true, false]) await scene(phone, async host => {
    assert.equal(field(host).closest('.dm-list') !== null, phone, 'вложенность поля соответствует платформе');
    if (!phone) { await React.act(async () => field(host).focus()); assert.equal(rootSearch(), false); }
  });
});
it('R170 запрос сохраняет открытое поле после потери фокуса, очистка и уход закрывают поиск', async () => {
  // Проверяется реальный onChange React, а не подмена внутреннего useState.
  await scene(true, async host => {
    await React.act(async () => {
      const input = field(host); input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Бес');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(field(host).value, 'Бес');
    await React.act(async () => field(host).blur()); assert.equal(rootSearch(), true); assert.equal(zone(host).classList.contains('on'), true);
    await React.act(async () => host.querySelector<HTMLButtonElement>('.dm-find-clear')!.click());
    await React.act(async () => field(host).blur()); assert.equal(rootSearch(), false);
  });
});
async function selection(host: HTMLDivElement) {
  assert.equal(host.querySelector('.dm-find-btn') === null, true, 'видимое поле не дублируется значком');
  await scroll(host, 48); assert.equal(host.querySelector('.dm-find-btn') !== null, true, 'погасшее поле имеет значок');
  await React.act(async () => host.querySelector<HTMLButtonElement>('.dm-find-btn')!.click());
  assert.equal(zone(host).classList.contains('on'), true); assert.equal(host.querySelector('.dm-find-btn') === null, true);
  await React.act(async () => field(host).blur());
  await React.act(async () => host.querySelector<HTMLButtonElement>('.dm-row')!.click());
  assert.equal(zone(host).classList.contains('pick'), true, 'выбор прячет поле своим классом');
  assert.equal(host.querySelector('.dm-find-btn') === null, true, 'выбор не показывает значок поиска');
  await React.act(async () => host.querySelector<HTMLButtonElement>('.pick-close')!.click());
  assert.equal(zone(host).classList.contains('pick'), false); assert.equal(host.querySelector('.dm-find-btn') !== null, true);
}
it('R170 свёрнутое поле открывается значком, а выбор бесед скрывает поле и значок', async () => {
  // Контрфакты состояния выбора ловятся настоящими callback родителя; жест строки изолирован.
  await scene(true, async host => selection(host));
});
it('R170 контрфакт забытой очистки корневого класса отвергается при закрытии поиска', async () => {
  // Мутация целого модуля, с исходным сценарием перед ней, а не eval отдельного effect.
  await scene(true, lifecycle);
  const mutant = replaceOnce("return () => root.classList.remove('gv-listsearch');", 'return () => {};');
  await assert.rejects(scene(true, lifecycle, mutant), e => e instanceof assert.AssertionError && e.message.includes('закрытие снимает'));
});
it('R170 контрфакт поля вне телефонной ленты отвергается по реальной вложенности', async () => {
  // Возвращение старого внешнего поля оставило бы поиск неподвижным при прокрутке списка.
  const check = async (host: HTMLDivElement) => { assert.equal(field(host).closest('.dm-list') !== null, true, 'поле внутри телефонной ленты'); };
  await scene(true, check);
  const moved = replaceOnce('{!phone && findZone}', '{findZone}').replace('{findZone}\n          </div>', '{null}\n          </div>');
  assert.equal(source.split('{findZone}\n          </div>').length - 1, 1);
  await assert.rejects(scene(true, check, moved), e => e instanceof assert.AssertionError && e.message.includes('поле внутри'));
});
it('R170 контрфакт значка в режиме выбора отвергается после выбора настоящей беседы', async () => {
  // Возвращение кнопки поиска в режим выбора добавляет чужое действие поверх панели выбранных бесед.
  await scene(true, async host => selection(host));
  const anchor = '{!selecting && !(inArchive && phone) && folderUi.bar}';
  const mutant = replaceOnce(anchor, `${anchor}\n      {phone && selecting && <button className="dm-find-btn" />}`);
  await assert.rejects(scene(true, async host => selection(host), mutant), e => e instanceof assert.AssertionError && e.message.includes('выбор не показывает'));
});

async function enterQuery(host: HTMLDivElement, value: string) {
  await React.act(async () => {
    const input = field(host); input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function searchScene(phone: boolean, users = false, guest = false, raw = source, query = 'dmtest') {
  const calls: string[] = [], opened: string[] = [], timers = new Map<number, () => void>();
  await scene(phone, async host => {
    await enterQuery(host, query);
    await React.act(async () => {
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    assert.equal(!!host.querySelector('.dm-nores'), !phone && query === 'dmtest', 'пустые результаты только на ПК');
    const local = host.querySelector('section[data-testid="dm-local-people"]');
    assert.equal(!!local, phone, 'люди ростера только на телефоне');
    if (phone) assert.equal(local!.querySelectorAll('.dm-people-hit').length, 1, 'существующий собеседник исключён');
    assert.equal(calls.length, phone && users && !guest ? 1 : 0, 'API только с users1 и не для гостя');
    const global = host.querySelector('section[data-testid="dm-global-people"]');
    assert.equal(!!global, phone && users && !guest, 'глобальные результаты только при разрешённом поиске');
    if (global) {
      assert.equal(global.querySelector('.dms-head')?.textContent, 'Глобальный поиск');
      await React.act(async () => global.querySelector<HTMLButtonElement>('button')!.click());
      assert.deepEqual(opened, ['global'], 'тап открывает найденного пользователя');
    }
    if (phone && !guest) {
      await React.act(async () => local!.querySelector<HTMLButtonElement>('button')!.click());
      assert.equal(opened.at(-1), 'local', 'тап открывает человека ростера');
    }
  }, raw, { users, guest, people: true, calls, opened, timers });
}
it('R181 поиск телефона без бесед показывает людей ростера, а ПК сохраняет прежнюю строку отсутствия результатов', async () => {
  // Телефон не должен показывать служебное «бесед нет» над подходящими людьми.
  await searchScene(true); await searchScene(false);
});
it('R181 поиск с users1 показывает Глобальный поиск и тап открывает найденного человека', async () => {
  // Заголовок без рабочей кнопки дал бы видимость результатов, не возможность начать беседу.
  await searchScene(true, true);
});
it('R181 старый сервер и гость не вызывают поиск пользователей, современный локальный аккаунт вызывает', async () => {
  // Запрещённый запрос не должен маскироваться пустым ответом или сетевой ошибкой.
  await searchScene(true, false); await searchScene(true, true, true); await searchScene(true, true);
});
it('R181 человек с существующей беседой один на один не дублируется в локальных людях', async () => {
  // Ростер и список личек пересекаются: отсутствие дедупликации создаёт две кнопки одного человека.
  await searchScene(true, false, false, source, 'Бес');
});
for (const [name, anchor, replacement, phone, users, query, target] of [
  ['телефонный блок и на ПК', '{phone && q && !chipsOn && sv.dm && !kindHits && dms.length > 0 && <DmGlobalPeople', '{q && !chipsOn && sv.dm && !kindHits && dms.length > 0 && <DmGlobalPeople', false, false, 'dmtest', 'люди ростера только'],
  ['дублирование существующего собеседника', '.filter((u) => !peers.has(u.id))', '.filter(() => true)', true, false, 'Бес', 'существующий собеседник'],
  ['поиск без users1', 'const searchQuery = searchOn ? userSearchQuery(q) : null;', 'const searchQuery = userSearchQuery(q);', true, false, 'dmtest', 'API только'],
] as const) it(`R181 мутант «${name}» отвергается настоящим поиском`, async () => {
  // Целый модуль, original-first и целевая проверка отделяют регрессию от сбоя VM.
  await searchScene(phone, users, false, source, query);
  // В этом модуле два поисковых компонента имеют одну строку: уникален полный контекст глобального блока.
  const unique = anchor.startsWith('const searchQuery')
    ? '  const searchQuery = searchOn ? userSearchQuery(q) : null;\n  useEffect(() => {\n    const mine = ++round.current;'
    : anchor;
  const change = anchor.startsWith('const searchQuery')
    ? '  const searchQuery = userSearchQuery(q);\n  useEffect(() => {\n    const mine = ++round.current;'
    : replacement;
  await assert.rejects(searchScene(phone, users, false, replaceOnce(unique, change), query),
    e => e instanceof assert.AssertionError && e.message.includes(target));
});

async function archiveScene(phone: boolean, raw = source, onlyUnmount = false) {
  await scene(phone, async (host, unmount) => {
    const active = () => document.documentElement.classList.contains('gv-listarchive');
    assert.equal(active(), false);
    assert.equal(!!host.querySelector('.dm-fab'), phone);
    await React.act(async () => host.querySelector<HTMLButtonElement>('.archive-open')!.click());
    assert.equal(active(), phone, 'архив помечает корень только на телефоне');
    assert.equal(!!host.querySelector('.dm-fab'), false, 'в архиве нет FAB');
    if (!onlyUnmount) {
      await React.act(async () => host.querySelector<HTMLButtonElement>('.archive-back')!.click());
      assert.equal(active(), false, 'выход снимает класс архива');
      assert.equal(!!host.querySelector('.dm-fab'), phone);
      await React.act(async () => host.querySelector<HTMLButtonElement>('.archive-open')!.click());
    }
    await unmount(); assert.equal(active(), false, 'unmount снимает класс архива');
  }, raw, { archive: true });
}
it('R181 архив телефона скрывает FAB и помечает корень до выхода или unmount, ПК корень не помечает', async () => {
  // Забытый класс скрывает навигацию уже после ухода с экрана архива.
  await archiveScene(true); await archiveScene(false);
});
it('R181 потеря cleanup архива обнаруживается размонтированием открытого архива', async () => {
  // Не ограничиваемся выходом: приложение может снять список без смены локального состояния.
  await archiveScene(true, source, true);
  await assert.rejects(archiveScene(true, replaceOnce("return () => root.classList.remove('gv-listarchive');", 'return () => {};'), true),
    e => e instanceof assert.AssertionError && e.message.includes('unmount снимает'));
});
it('R181 потеря запрета FAB в архиве обнаруживается входом в архив', async () => {
  // Карандаш не относится к отдельному экрану архива и не должен появляться под его шапкой.
  await archiveScene(true);
  await assert.rejects(archiveScene(true, replaceOnce('phone && !dmOff && !selecting && !inArchive &&', 'phone && !dmOff && !selecting &&')),
    e => e instanceof assert.AssertionError && e.message.includes('в архиве нет FAB'));
});
