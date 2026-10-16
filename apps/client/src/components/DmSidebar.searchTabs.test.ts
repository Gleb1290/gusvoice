import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as rules from '../dmListSearchRules';
import * as lists from '../dmListRules';
import * as sync from '../convSyncRules';
import * as folders from '../dmFolderView';
import * as dmRules from '../dmRules';
import * as rowRules from '../dmRowRules';
import * as archives from '../dmArchiveRules';
import * as media from '../sharedMediaRules';
import { withMenuDom, loadMenu } from './ContextMenu.back.harness';

const source = readFileSync(new URL('./DmSidebar.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const kindSource = readFileSync(new URL('./DmSearchKinds.tsx', import.meta.url), 'utf8');
const chipSource = readFileSync(new URL('./DmListSearch.tsx', import.meta.url), 'utf8');
const scopeSource = readFileSync(new URL('./DmServerSearch.tsx', import.meta.url), 'utf8');
type Query = Parameters<typeof import('../api').api.convSearchAll>[0];
function unused(name: string) { return new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : () => assert.fail(`неожиданная граница ${name}.${String(key)}`) }); }
function whole<T>(raw: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, window, document, Date, Element, IntersectionObserver: undefined,
      setTimeout: (fn: () => void, ms?: number) => window.setTimeout(fn, ms), clearTimeout: (id: number) => window.clearTimeout(id),
      require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `явный импорт ${id}`); return deps[id]; } });
  return module.exports as T;
}
interface Scene {
  host: HTMLDivElement; calls: Query[]; focus: () => Promise<void>; blur: () => Promise<void>;
  text: (value: string) => Promise<void>; tab: (kind: string) => Promise<void>; timers: () => Promise<void>;
  phone: (phone: boolean) => Promise<void>; scope: (scope: string) => Promise<void>;
}
function inputProps(field: HTMLInputElement) {
  const keys = Object.keys(field).filter(key => key.startsWith('__reactProps$'));
  assert.equal(keys.length, 1, 'поле смонтировано React и имеет единственный набор props');
  const props = (field as unknown as Record<string, React.InputHTMLAttributes<HTMLInputElement>>)[keys[0]];
  assert.equal(typeof props.onChange, 'function', 'у настоящего поля есть обработчик ввода');
  return props;
}
async function scene(check: (s: Scene) => Promise<void>, raw = source, phone = true) {
  await withMenuDom(620, async (host, root) => {
    const nil = () => null, noop = () => {};
    const nameOf = (_id: string, name: string) => name;
    const dms = [{ id: 'dm', createdAt: '2026-10-12T00:00:00Z', lastMessageAt: null, otherUser: { id: 'peer', username: 'peer', displayName: 'Беседа', avatarUrl: null } },
      { id: 'archived', createdAt: '2026-10-12T00:00:00Z', lastMessageAt: null, archived: true, otherUser: { id: 'archive-peer', username: 'archive', displayName: 'Архив', avatarUrl: null } }];
    const state = { dms, currentDmId: null, mobilePane: 'list', view: 'dm', unreadDms: [], voice: null,
      members: [{ user: { id: 'local', username: 'local', displayName: 'Беседа местная', avatarUrl: null } }],
      user: { id: 'self', homeInstance: null }, convActive: true, conv: { ...sync.emptyConvState(), phase: 'live', pts: 1 },
      serverFeatures: ['conv1', 'conv2', 'gsearch1', 'srvsearch1', 'archive1'], drafts: {}, outbox: {}, pushMutedDmUsers: [], pushMuteUntil: {},
      blockedUsers: [], loadDms: async () => {}, selectDm: async () => {} };
    const useStore = Object.assign((pick: (s: typeof state) => unknown) => pick(state), { getState: () => state });
    const calls: Query[] = [];
    const api = { convSearchAll: async (query: Query) => { calls.push(query); return { hits: [], next: null }; }, attachmentDownloadUrl: () => assert.fail('пустая выдача не скачивает') };
    const peer = { usePeerName: () => nameOf, dmPeerLabel: (d: typeof dms[number]) => d.otherUser.displayName };
    const common: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsx, '../api': { api }, '../peerName': peer,
      '../dmListSearchRules': rules, '../dmListRules': lists, '../dmRowRules': rowRules, '../sharedMediaRules': media,
      '../store': { useStore }, '../toast': { toast: noop, toastError: () => assert.fail('поиск не должен падать') },
      './Avatar': { Avatar: nil }, './Icon': { Icon: nil } };
    const list = whole<typeof import('./DmListSearch')>(chipSource, { ...common, '../feedJump': unused('feedJump'), './ContextMenu': loadMenu() });
    const kinds = whole<typeof import('./DmSearchKinds')>(kindSource, { ...common, './DmListSearch': list,
      './SharedMedia': unused('SharedMedia rows'), './Lightbox': unused('Lightbox') });
    const scopes = whole<typeof import('./DmServerSearch')>(scopeSource, { ...common,
      '@gusvoice/shared': { SERVER_SEARCH_MIN_CHARS: 2 }, '../feedJump': unused('feedJump'), '../sockets': unused('sockets') });
    const deps: Record<string, unknown> = { ...common,
      react: { ...React, memo: () => (p: { dm: { id: string } }) => React.createElement('div', { className: 'dm-row', 'data-conversation': p.dm.id }) },
      '../hotkeys': { isMobile: () => phone, isTauri: () => false }, '../phoneLayout': { usePhoneLayout: () => phone },
      '../convSyncRules': sync, '../dmFolderView': folders, '../dmRules': dmRules, '../dmArchiveRules': archives,
      '../dmCompose': { useDmCompose: () => ({ open: false }), closeDmCompose: noop },
      '../dmFolders': { useDmFolders: (pick: (s: { activeId: null }) => unknown) => pick({ activeId: null }) },
      '../dmOnline': { useVisibleOnline: () => new Set() }, '../voiceDrafts': { useVoiceDraftKeys: () => new Map() },
      '../connState': { useConnState: () => 'online', connLabel: () => null }, '../uiPrefs': { useSidebarNarrow: () => false, setNarrowAllowed: noop },
      '../dmListView': { useListLines: () => 'two' }, '../androidBack': { pushBackHandler: () => noop }, './DmPinDrag': { useDmPinDrag: noop },
      './DmArchive': { useArchiveCollapsed: () => [false, noop], DmArchiveRow: () => React.createElement('div', { 'data-archive-row': true }) },
      './DmRowMenu': { useDmRowMenu: () => ({ openDmMenu: noop, menu: null }), useDmListMenu: () => ({ openListMenu: noop, menu: null }) },
      './DmFolderBar': { useDmFolderUi: () => ({ on: false, home: true, ownPins: null, bar: null }) },
      './DmListSwipe': { useSwipeCaps: () => ({}), useSwipeSetting: () => ['auto'], useDmListSwipe: () => ({ bind: {}, overlay: null }) }, '../chatSwipe': { effectiveSwipe: () => null },
      './DmListSearch': { ...list, useRecentSearches: () => ({ recents: [], push: noop, remove: noop, clear: noop }), useFrequentHidden: () => ({ hidden: {}, hide: noop }), useFrequent: () => [],
        DmSearchHome: () => React.createElement('div', { 'data-search-home': true }), DmMessageHits: () => React.createElement('div', { 'data-dm-hits': true }) },
      './DmAllSearch': { ...kinds, AllMessageHits: () => React.createElement('div', { 'data-all-hits': true }) },
      './DmServerSearch': { ...scopes, ServerMessageHits: () => React.createElement('div', { 'data-server-hits': true }) },
      './SettingsShell': { SettingsSearch: (p: { inputRef: React.Ref<HTMLInputElement> } & React.InputHTMLAttributes<HTMLInputElement>) => {
        const { inputRef, ...rest } = p; return React.createElement('input', { ...rest, ref: inputRef }); } },
      './GroupDialogs': { GroupDialogHost: nil }, './SharedMedia': { SharedMediaHost: nil }, './SelfVoiceBar': { SelfVoiceBar: nil } };
    for (const id of ['../useContactSeen', '../dialogChrome', '../channelRules', '../chatKeysRules', '../typing', '../contactRules', '../contacts',
      './SavedAvatar', '../groupChatRules', '../cornerButtonsRules', '../dragOut', '../filesDrop', './Goose', './StatusDot', './VoicePanel', './BottomSheet']) deps[id] = unused(id);
    const timers = new Map<number, () => void>(); let timerId = 0;
    const set = window.setTimeout, clear = window.clearTimeout;
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    // HappyDOM не знает layout; прокрутка вкладки — явная граница, не визуальное утверждение.
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value() {} });
    window.setTimeout = ((fn: () => void) => { const id = ++timerId; timers.set(id, fn); return id; }) as typeof window.setTimeout;
    window.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof window.clearTimeout;
    try {
      const sidebar = whole<typeof import('./DmSidebar')>(raw, deps);
      const render = async () => React.act(async () => root.render(React.createElement(sidebar.DmSidebar)));
      const input = () => host.querySelector<HTMLInputElement>('.dm-find input')!;
      const click = async (selector: string) => { const button = host.querySelector<HTMLButtonElement>(selector);
        assert.equal(!!button, true, `кнопка ${selector}`); await React.act(async () => button!.click()); };
      const s: Scene = { host, calls, focus: async () => React.act(async () => input().focus()), blur: async () => React.act(async () => input().blur()),
        text: async value => {
          await React.act(async () => input().focus());
          // HappyDOM + кешированный ReactDOM не гарантируют доставку native input в onChange.
          // Вызываем реальный обработчик текущего поля: не подменяем setQuery, hook или поисковый API.
          await React.act(async () => {
            const field = input(); field.value = value;
            inputProps(field).onChange!({ target: field, currentTarget: field } as React.ChangeEvent<HTMLInputElement>);
          });
          // DOM value сам по себе недостаточен: контролируемые props и класс подтверждают новый рендер/query.
          assert.equal(inputProps(input()).value, value, 'React принял новый запрос в контролируемое поле');
          assert.equal(input().value, value, 'контролируемое поле показывает новый запрос');
          assert.equal(host.querySelector('.dm-find')!.classList.contains('has-q'), value !== '', 'класс поиска обновлён по query');
        }, tab: kind => click(`[data-tab="${kind}"]`), scope: scope => click(`[data-scope="${scope}"]`),
        timers: async () => React.act(async () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } }),
        phone: async value => { phone = value; await render(); } };
      await render(); await check(s);
    } finally { window.setTimeout = set; window.clearTimeout = clear;
      if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scroll); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo'); }
  });
}
const has = (s: Scene, selector: string) => s.host.querySelector(selector) !== null;
const selected = (s: Scene) => s.host.querySelector('.dms-kinds [aria-selected="true"]')?.getAttribute('data-tab');
async function lifecycle(raw = source) {
  await scene(async s => {
    assert.equal(has(s, '.dms-kinds'), false); assert.equal(has(s, '[data-archive-row]'), true);
    await s.focus(); assert.equal(has(s, '.dms-kinds'), true); assert.equal(selected(s), 'chats'); assert.equal(has(s, '[data-search-home]'), true);
    await s.tab('media'); assert.equal(selected(s), 'media'); assert.equal(has(s, '[data-search-home]'), false, 'медиа не показывает SearchHome');
    assert.equal(has(s, '[data-archive-row]'), false, 'медиа не показывает архив'); assert.equal(has(s, '[data-testid="kind-search-hits"]'), true);
    assert.equal(has(s, '.dm-row[data-conversation]'), false); await s.timers();
    assert.equal(s.calls[0].q, ''); assert.equal(s.calls[0].kind, 'media'); assert.equal(s.calls[0].full, true);
    await s.text('Бес'); assert.equal(selected(s), 'media', 'ввод сохраняет вкладку'); await s.timers();
    await s.text(''); assert.equal(selected(s), 'media', 'стирание сохраняет вкладку'); await s.timers();
    await s.blur(); assert.equal(has(s, '.dms-kinds'), false); await s.focus(); assert.equal(selected(s), 'chats', 'новый поиск после пустого blur начинается с Чатов');
  }, raw);
}
it('R185 пустое поле в фокусе показывает вкладки; Медиа ищет full без текста, ввод/стирание сохраняют её, пустой blur сбрасывает', async () => {
  // Класс ошибки: старый reset-on-empty лишает доступа к свежим вложениям без запроса.
  await lifecycle();
});
async function hits(raw = source) {
  await scene(async s => {
    await s.text('Бес'); assert.equal(has(s, '.dms-kinds'), true); assert.equal(has(s, '.dms-scopes:not(.dms-kinds)'), false);
    assert.equal(has(s, '[data-all-hits]'), true); assert.equal(has(s, '.dm-row[data-conversation]'), true);
    assert.equal(has(s, '[data-testid="dm-local-people"]'), true, 'в Чатах есть подходящие люди без беседы');
    await s.tab('file'); assert.equal(has(s, '[data-all-hits]'), false, 'вкладка вида не дублирует AllMessageHits');
    assert.equal(has(s, '[data-dm-hits]'), false); assert.equal(has(s, '[data-server-hits]'), false); assert.equal(has(s, '.dm-row[data-conversation]'), false);
    assert.equal(has(s, '[data-testid="dm-local-people"]'), false); assert.equal(has(s, '[data-testid="kind-search-hits"]'), true);
    await s.tab('chats'); assert.equal(has(s, '[data-all-hits]'), true); assert.equal(has(s, '[data-testid="kind-search-hits"]'), false);
  }, raw);
}
it('R183 телефонные Чаты показывают общий поиск сообщений, вкладка вида заменяет беседы, людей и все текстовые выдачи', async () => {
  // Класс ошибки: медиа и текстовые результаты оказываются одновременно в одной ленте.
  await hits();
});
async function scopeCarry(raw = source) {
  await scene(async s => { await s.focus(); assert.equal(has(s, '.dms-kinds'), false); assert.equal(s.host.querySelectorAll('.dms-chip[data-kind]').length, 5);
    await s.text('Бес'); assert.equal(has(s, '.dms-scopes:not(.dms-kinds)'), true); await s.scope('servers'); assert.equal(has(s, '[data-server-hits]'), true);
    await s.phone(true); assert.equal(has(s, '.dms-kinds'), true); assert.equal(has(s, '.dms-scopes:not(.dms-kinds)'), false);
    assert.equal(has(s, '[data-all-hits]'), true, 'телефон игнорирует прежнюю серверную область ПК');
    assert.equal(has(s, '[data-server-hits]'), false); }, raw, false);
}
it('R183 ПК сохраняет чипы и области, телефон после ПК всегда использует общую область Чатов', async () => {
  // Состояние scope живёт дольше смены ширины: скрытая вкладка Серверы не должна ограничивать телефон.
  await scopeCarry();
});
it('R185 чипы человека и даты сохраняют выбранный вид при пустом поле и доходят до его API', async () => {
  // Чип очищает поле сам: это не закрытие поиска и не повод вернуть Чаты вместо выбранного Медиа.
  await scene(async s => {
    await s.focus(); await s.tab('media'); await s.text('Бес');
    const person = [...s.host.querySelectorAll<HTMLButtonElement>('.dms-chip')].find(x => x.textContent === 'Беседа');
    assert.equal(!!person, true, 'предложен человек'); await React.act(async () => person!.click()); await s.timers();
    assert.equal(selected(s), 'media'); assert.equal(s.calls.at(-1)?.q, ''); assert.equal(s.calls.at(-1)?.conversationId, 'dm');
    await s.text('05.03.2025');
    const date = [...s.host.querySelectorAll<HTMLButtonElement>('.dms-chip')].find(x => x.textContent === '5 марта 2025');
    assert.equal(!!date, true, 'предложена дата'); await React.act(async () => date!.click()); await s.timers();
    assert.equal(selected(s), 'media'); assert.equal(s.calls.at(-1)?.q, ''); assert.equal(s.calls.at(-1)?.conversationId, 'dm');
    assert.equal(s.calls.at(-1)?.since, new Date(2025, 2, 5).toISOString()); assert.equal(s.calls.at(-1)?.until, new Date(2025, 2, 6).toISOString());
    assert.equal(s.host.querySelectorAll('.dms-chip[data-kind]').length, 0);
  });
});
function replace(anchor: string, replacement: string) { assert.equal(source.split(anchor).length - 1, 1, `уникальный якорь ${anchor}`); return source.replace(anchor, replacement); }
const targeted = (text: string) => (error: unknown) => error instanceof assert.AssertionError && error.message.includes(text);
for (const [name, anchor, replacement, check, message] of [
  ['SearchHome на медиа', 'const searchHome = gsearch && findFocused && !q && !hasChips(chips) && !kindHits;', 'const searchHome = gsearch && findFocused && !q && !hasChips(chips);', lifecycle, 'медиа не показывает SearchHome'],
  ['Архив на медиа', 'archiveRowShown && !q && !searchHome && !kindHits', 'archiveRowShown && !q && !searchHome', lifecycle, 'медиа не показывает архив'],
  ['сброс при пустом query', "if (searchIdle) setKindTab('chats');\n  }, [searchIdle]);", "if (!query) setKindTab('chats');\n  }, [query]);", lifecycle, 'стирание сохраняет вкладку'],
  ['нет сброса после пустого blur', "if (searchIdle) setKindTab('chats');", 'if (searchIdle) {}', lifecycle, 'новый поиск после пустого blur начинается с Чатов'],
  ['AllMessageHits на вкладке вида', 'gsearch && !searchHome && !kindHits && sv.tabs && sv.dm && sv.servers', 'gsearch && !searchHome && sv.tabs && sv.dm && sv.servers', hits, 'вкладка вида не дублирует AllMessageHits'],
  ['область ПК на телефоне', "scopeView(phone ? 'all' : scope, q, chips, !!srvSearch)", 'scopeView(scope, q, chips, !!srvSearch)', scopeCarry, 'телефон игнорирует прежнюю серверную область ПК'],
] as const) it(`R183/185 контрфакт «${name}» обнаруживается реальным Sidebar`, async () => {
  // Оригинал и мутант проходят один сценарий; ошибка загрузки VM не считается убийством мутанта.
  await check(); const mutant = replace(anchor, replacement); await assert.rejects(check(mutant), targeted(message));
});
