import { counterfact } from '../../../../packages/shared/test/counterfacts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { createContext, Script } from 'node:vm';
import ts from 'typescript';
import { testVmImports } from '../testVmImports';
import type { ConvSummary, DmChannel } from '@gusvoice/shared';
import * as channelRules from '../channelRules';
import * as convRules from '../convSyncRules';
import * as dmRules from '../dmRules';
import * as listRules from '../dmListRules';
import * as rowRules from '../dmRowRules';
import * as archiveRules from '../dmArchiveRules';
import * as folderRules from '../dmFolderView';
import * as searchRules from '../dmListSearchRules';
import * as groupRules from '../groupChatRules';
import * as cornerRules from '../cornerButtonsRules';
import { React, environment, icon } from './R171.phoneHarness';
import * as jsx from 'react/jsx-runtime';

const source = readFileSync(new URL('./DmSidebar.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const P = 'R369/sidebar/check/';
const stamp = (ms: number) => new Date(Date.parse('2026-10-30T12:00:00Z') + ms).toISOString();
const labels = { a: 'Беседа А', b: 'Беседа Б' };
type Id = keyof typeof labels;
const dm = (id: Id, at: number): DmChannel => ({
  id, createdAt: stamp(0), lastMessageAt: stamp(at), unread: 0,
  otherUser: { id: `peer-${id}`, displayName: labels[id], username: `peer_${id}`, avatarUrl: null },
});
const summary = (d: DmChannel, at: number): ConvSummary => ({
  ...d, kind: 'direct', unread: 0, lastReadKey: 0,
  lastMessage: { id: `message-${d.id}`, authorId: d.otherUser.id, sortKey: 1, text: `Последнее ${d.id}`, attachments: 0, createdAt: d.lastMessageAt! },
  draft: { text: `черновик ${d.id}`, replyToId: null, at: stamp(at), device: 'synthetic-device' },
});
type Options = { phone?: boolean; pane?: 'list' | 'content'; view?: 'dm' | 'server' };

async function fixture(raw: string, options: Options, check: (scene: {
  order(): string[]; hasDraft(id: Id): boolean; preview(id: Id): string;
  draftAt(id: Id, at: number): Promise<void>; open(id: Id): Promise<void>;
}) => Promise<void>) {
  const counts = new Map<string, number>();
  let exhausted: Error | undefined;
  const step = (kind: string) => {
    const count = (counts.get(kind) ?? 0) + 1; counts.set(kind, count);
    if (count > 200) { exhausted ??= new Error(`R369/sidebar/budget/${kind}`); throw exhausted; }
  };
  const checkBudget = () => { if (exhausted) throw exhausted; };
  await environment(async (host, render) => {
    const noop = () => {}, nil = () => null;
    const a = dm('a', 100), b = dm('b', 200);
    const state = {
      dms: [b, a], currentDmId: 'a' as string | null, mobilePane: options.pane ?? 'content', view: options.view ?? 'dm',
      unreadDms: [] as string[], voice: null, user: { id: 'self' },
      convActive: true, conv: { ...convRules.emptyConvState(), phase: 'live' as const, pts: 1,
        summaries: { a: summary(a, 150), b: summary(b, 250) } as Record<string, ConvSummary> },
      serverFeatures: ['conv1', 'conv2', 'conv3'],
      drafts: { a: { text: 'черновик a', replyToId: null }, b: { text: 'черновик b', replyToId: null } },
      outbox: {}, pushMutedDmUsers: [], pushMuteUntil: {}, blockedUsers: [], userStatuses: {},
      loadDms: async () => { step('load-list'); }, selectDm: async () => { step('select'); },
    };
    const useStore = Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state });
    const online = new Set<string>(), voices = new Map<string, string>();
    const nameOf = (_id: string, fallback: string) => fallback;
    const recent = { recents: [], push: noop, remove: noop, clear: noop };
    const hidden = { hidden: {}, hide: noop };
    const folder = { on: false, home: true, ownPins: null, pinFolder: null, bar: null, strip: false, pages: [] };
    const context = createContext({ window, document, navigator, Date, performance, console, setTimeout, clearTimeout });
    const invokeScript = new Script('__result = __callback(...__args)');
    function invoke<T>(callback: (...args: never[]) => T, ...args: unknown[]): T {
      step('invoke'); context.__callback = callback; context.__args = args;
      try {
        invokeScript.runInContext(context, { timeout: 500 });
        return context.__result as T;
      } finally {
        delete context.__callback; delete context.__args; delete context.__result;
        checkBudget();
      }
    }
    const effect = (callback: React.EffectCallback) => {
      step('effect');
      const cleanup = invoke(callback);
      return typeof cleanup === 'function' ? () => { step('cleanup'); invoke(cleanup); } : undefined;
    };
    const react = { ...React,
      useState<T>(initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
        step('state-hook');
        const [value, dispatch] = React.useState(initial);
        const stable = React.useCallback((next: React.SetStateAction<T>) => { step('state-update'); dispatch(next); }, [dispatch]);
        return [value, stable];
      },
      useRef<T>(value: T) { step('ref-hook'); return React.useRef(value); },
      useMemo<T>(compute: () => T, deps: React.DependencyList) {
        step('memo-hook'); return React.useMemo(() => { step('compute'); return compute(); }, deps);
      },
      useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: React.DependencyList) {
        step('callback-hook'); return React.useCallback(callback, deps);
      },
      useEffect(callback: React.EffectCallback, deps?: React.DependencyList) {
        step('effect-hook'); React.useEffect(() => effect(callback), deps);
      },
      useLayoutEffect(callback: React.EffectCallback, deps?: React.DependencyList) {
        step('layout-hook'); React.useLayoutEffect(() => effect(callback), deps);
      },
      // Сохраняем настоящий memo и настоящий DmRow, добавляя лишь бюджет/VM-timeout для его полного рендера.
      memo(component: (props: Record<string, unknown>) => React.ReactNode) {
        return React.memo(function BoundedRow(props: Record<string, unknown>) {
          step('row-render'); return invoke(component, props);
        });
      },
    };
    const dependencies: Record<string, unknown> = {
      react, 'react/jsx-runtime': jsx,
      '../store': { useStore }, '../channelRules': channelRules, '../convSyncRules': convRules,
      '../dmRules': dmRules, '../dmListRules': listRules, '../dmRowRules': rowRules,
      '../dmArchiveRules': archiveRules, '../dmFolderView': folderRules, '../dmListSearchRules': searchRules,
      '../groupChatRules': groupRules, '../cornerButtonsRules': cornerRules,
      '../hotkeys': { isMobile: () => false, isTauri: () => false },
      '../phoneLayout': { usePhoneLayout: () => options.phone === true },
      '../peerName': { usePeerName: () => nameOf, dmPeerLabel: (d: DmChannel) => d.otherUser.displayName },
      '../dmOnline': { useVisibleOnline: () => online }, '../voiceDrafts': { useVoiceDraftKeys: () => voices },
      '../typing': { useTyping: () => [], useTypingAction: () => null, typingActionLabel: () => '' },
      '../connState': { useConnState: () => 'online', connLabel: () => null, CONN_TEXT: { updating: 'Обновление…' } },
      '../dmCompose': { useDmCompose: () => ({ open: false }), closeDmCompose: noop, openDmCompose: noop },
      '../dmFolders': { useDmFolders: (select: (value: { activeId: null }) => unknown) => select({ activeId: null }) },
      './DmFolderBar': { useDmFolderUi: () => folder },
      './DmRowMenu': { useDmRowMenu: () => ({ openDmMenu: noop, menu: null }), useDmListMenu: () => ({ openListMenu: noop, menu: null }) },
      './DmListSearch': { useRecentSearches: () => recent, useFrequentHidden: () => hidden, useFrequent: () => [] },
      './DmArchive': { useArchiveCollapsed: () => [false, noop] },
      './DmListSwipe': { useSwipeCaps: () => ({}), useSwipeSetting: () => ['auto'], useDmListSwipe: () => ({ bind: {}, overlay: null }) },
      './DmPinDrag': { useDmPinDrag: noop }, '../chatSwipe': { effectiveSwipe: () => null },
      '../dmListView': { useListLines: () => 'two', DM_ROW_AVA: 36 },
      '../uiPrefs': { useSidebarNarrow: () => false, setNarrowAllowed: noop },
      '../androidBack': { pushBackHandler: () => noop },
      './SettingsShell': { SettingsSearch: (props: { inputRef: React.Ref<HTMLInputElement> } & React.InputHTMLAttributes<HTMLInputElement>) => {
        const { inputRef, ...rest } = props; return React.createElement('input', { ...rest, ref: inputRef });
      } },
      './Avatar': { Avatar: nil }, './Icon': { Icon: icon },
      './GroupDialogs': { GroupDialogHost: nil }, './SharedMedia': { SharedMediaHost: nil }, './SelfVoiceBar': { SelfVoiceBar: nil },
    };
    const module = { exports: {} as { DmSidebar: () => React.ReactNode } };
    context.module = module; context.exports = module.exports;
    const imports = testVmImports(new URL('./DmSidebar.tsx', import.meta.url), dependencies);
    context.require = (name: string) => {
      step('import');
      return imports(name);
    };
    // Целый production-модуль. Ни shownDmId, ни openDraft, ни сортировка не скопированы в тест.
    new Script(ts.transpileModule(raw, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText).runInContext(context, { timeout: 500 });
    function Sidebar() { step('sidebar-render'); return invoke(module.exports.DmSidebar, {}); }
    async function refresh() { step('render-request'); await render(React.createElement(Sidebar)); checkBudget(); }
    const rows = () => {
      const found = [...host.querySelectorAll<HTMLButtonElement>('.dm-list > .dm-row')];
      if (found.length > 200) throw new Error('R369/sidebar/budget/rows');
      assert.equal(found.length, 2, 'R369/sidebar/setup/two-real-rows');
      return found;
    };
    const row = (id: Id) => {
      const found = rows().find(element => element.querySelector('.dm-name-text')?.textContent === labels[id]);
      assert.equal(Boolean(found), true, 'R369/sidebar/setup/named-real-row'); return found!;
    };
    try {
      await refresh();
      await check({
        order: () => rows().map(element => element.querySelector('.dm-name-text')?.textContent ?? ''),
        hasDraft: id => row(id).querySelectorAll('.dm-draft').length > 0,
        preview: id => row(id).querySelector('.dm-preview')?.textContent ?? '',
        async draftAt(id, at) {
          step('summary-change');
          const previous = state.conv.summaries[id];
          state.conv = { ...state.conv, summaries: { ...state.conv.summaries, [id]: {
            ...previous, draft: { text: state.drafts[id].text, replyToId: null, at: stamp(at), device: 'synthetic-device' },
          } } };
          await refresh();
        },
        async open(id) { step('open-change'); state.currentDmId = id; await refresh(); },
      });
      checkBudget();
    } finally { checkBudget(); }
  });
}

for (const options of [
  { phone: false, pane: 'content', view: 'dm', shown: true, title: 'ПК, открытая лента ЛС' },
  { phone: true, pane: 'content', view: 'dm', shown: true, title: 'телефон, открытая лента ЛС' },
  { phone: true, pane: 'list', view: 'dm', shown: false, title: 'телефон, список вместо ленты' },
  { phone: false, pane: 'content', view: 'server', shown: false, title: 'ПК, раздел сервера вместо ЛС' },
] as const) {
  it(`R369 ${options.title}: Черновик скрыт лишь у показанной беседы, закрытый остаётся виден`, async () => {
    await fixture(source, options, async scene => {
      assert.equal(scene.hasDraft('a'), !options.shown, P + 'shownDmId-not-current-only');
      assert.equal(scene.hasDraft('b'), true, P + 'closed-draft-visible');
      assert.ok(scene.preview('a').includes(options.shown ? 'Последнее a' : 'черновик a'), P + 'shown-row-keeps-last-message');
      assert.ok(scene.preview('b').includes('черновик b'), P + 'closed-preview-keeps-text');
    });
  });
}

async function frozenOrder(raw: string) {
  await fixture(raw, {}, async scene => {
    assert.deepEqual(scene.order(), [labels.b, labels.a], P + 'initial-cloud-order');
    await scene.draftAt('a', 400);
    assert.deepEqual(scene.order(), [labels.b, labels.a], P + 'open-row-does-not-jump');
    await scene.draftAt('a', 700);
    assert.deepEqual(scene.order(), [labels.b, labels.a], P + 'open-row-stays-at-opening-snapshot');
    assert.equal(scene.hasDraft('a'), false, P + 'typing-does-not-reveal-open-draft');
  });
}
it('R369 запись черновика не двигает открытую строку; без openDraftAt контрфакт падает на порядке имён', async () => {
  await frozenOrder(source);
  await counterfact(async () => {
    const from = 'const draftAt = d.id === shownDmId ? openDraftAt : draftAtOf(d.id);';
    assert.equal(source.split(from).length - 1, 1, 'R369/sidebar/setup/unique-open-snapshot');
    await assert.rejects(frozenOrder(source.replace(from, 'const draftAt = draftAtOf(d.id);')), error => error instanceof assert.AssertionError
      && error.message.startsWith(P + 'open-row-does-not-jump'), 'мутант убивается массивом строк, не подготовкой, бюджетом или DOM-diff');
  });
  await frozenOrder(source);
});

it('R369 закрытая строка пересортировывается по свежему черновику, а не замораживается вместе с открытой', async () => {
  await fixture(source, {}, async scene => {
    await scene.open('b'); // A закрыта, первоначально её черновик старее B.
    assert.deepEqual(scene.order(), [labels.b, labels.a], P + 'closed-initial-place');
    await scene.draftAt('a', 400);
    assert.deepEqual(scene.order(), [labels.a, labels.b], P + 'closed-row-moves-on-cloud-save');
    assert.equal(scene.hasDraft('a'), true, P + 'closed-shows-new-draft');
    assert.equal(scene.hasDraft('b'), false, P + 'other-open-stays-hidden');
  });
});

it('R369 уход отпускает старое место строки, повторное открытие запоминает новый снимок черновика', async () => {
  await fixture(source, {}, async scene => {
    await scene.draftAt('a', 400);
    await scene.open('b');
    assert.deepEqual(scene.order(), [labels.a, labels.b], P + 'leave-releases-frozen-position');
    assert.equal(scene.hasDraft('a'), true, P + 'leave-reveals-draft');
    await scene.open('a');
    assert.deepEqual(scene.order(), [labels.a, labels.b], P + 'reopen-uses-new-snapshot');
    await scene.draftAt('b', 500);
    assert.deepEqual(scene.order(), [labels.b, labels.a], P + 'closed-can-pass-reopened-row');
    await scene.draftAt('a', 700);
    assert.deepEqual(scene.order(), [labels.b, labels.a], P + 'reopened-snapshot-is-frozen-again');
    assert.equal(scene.hasDraft('a'), false, P + 'reopened-stays-hidden');
  });
});
