import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as shared from '@gusvoice/shared';
import * as searchRules from './dmListSearchRules';
import * as sync from './convSyncRules';
import * as listRules from './dmListRules';
import * as viewRules from './dmFolderView';
import { create } from 'zustand';
import type { useDmFolders as FoldersHook } from './dmFolders';
import type { useFrequentHidden as HiddenHook } from './components/DmListSearch';
import type { useDmRowMenu as MenuHook } from './components/DmRowMenu';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const frequentSource = source('./components/DmListSearch.tsx');
const foldersSource = source('./dmFolders.ts');
const dragSource = source('./components/DmPinDrag.tsx');
const rowSource = source('./components/DmRowMenu.tsx');
function whole<T>(raw: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  // Исполняется полный модуль, не вырезанная функция: внутренние состояния и замыкания настоящие.
  const module = { exports: {} };
  const tree = ts.createSourceFile('module.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Set(tree.statements.filter(ts.isImportDeclaration).map(n => (n.moduleSpecifier as ts.StringLiteral).text));
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, localStorage, window, document, Date, ...globals,
    require: (id: string) => {
      if (id === 'react/jsx-runtime') return jsx;
      assert.ok(imports.has(id), `зависимость ${id} есть у полного модуля`);
      return dependencies[id] ?? {};
    },
  });
  return module.exports as T;
}
function changed(raw: string, from: string, to: string) { assert.ok(raw.includes(from), `якорь: ${from}`); return raw.replace(from, to); }
function pending<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function mounted<T>(hook: () => T, run: (get: () => T) => Promise<void>) {
  let value!: T;
  function Harness() { value = hook(); return null; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try { await React.act(async () => root.render(React.createElement(Harness))); await run(() => value); }
  finally { await React.act(async () => root.unmount()); host.remove(); }
}
before(() => { GlobalRegistrator.register(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(() => GlobalRegistrator.unregister());

async function hiddenCase(server: boolean, fail: boolean, raw = frequentSource) {
  localStorage.clear(); const requests: unknown[] = [], errors: unknown[] = [], job = pending<{ hidden: number }>();
  const hook = whole<{ useFrequentHidden: typeof HiddenHook }>(raw, {
    react: React, '../dmListSearchRules': searchRules,
    '../api': { api: { convFrequentHide: (items: unknown) => { requests.push(items); return job.promise; } } },
    '../toast': { toastError: (error: unknown) => errors.push(error) },
  }).useFrequentHidden;
  await mounted(() => hook(server), async get => {
    await React.act(async () => get().hide('chat'));
    assert.ok(get().hidden.chat, 'скрыто до ответа');
    assert.equal(requests.length, server ? 1 : 0, 'freq2 выбирает сервер, а не localStorage');
    assert.equal(localStorage.getItem(searchRules.FREQUENT_HIDDEN_KEY) !== null, !server, 'серверный путь не пишет локальный кеш');
    if (server) {
      assert.deepEqual(JSON.parse(JSON.stringify(requests)), [[{ conversationId: 'chat' }]]);
      await React.act(async () => fail ? job.reject(new Error('отказ')) : job.resolve({ hidden: 1 }));
      assert.equal(!!get().hidden.chat, !fail, 'отказ возвращает беседу');
      assert.equal(errors.length, fail ? 1 : 0, 'отказ показан человеку один раз');
    }
  });
}

it('R126 без freq2 скрытые частые пишутся локально без запроса', async () => {
  // Старый сервер не должен получать несуществующую ручку и терять локальную настройку.
  await hiddenCase(false, false);
});
it('R126 freq2 скрывает сразу, сохраняет успех и откатывает отказ с тостом', async () => {
  // Оптимистическая отметка без отката навсегда прятала бы чат только на одном устройстве.
  await hiddenCase(true, false); await hiddenCase(true, true);
  const mutant = changed(frequentSource, 'delete next[convId];', '// потерян откат');
  await assert.rejects(hiddenCase(true, true, mutant), /отказ возвращает беседу/);
});

async function lateRejectCase(raw = frequentSource) {
  localStorage.clear(); const jobs: ReturnType<typeof pending<{ hidden: number }>>[] = [], errors: unknown[] = [];
  const dates = ['2026-10-09T12:00:00.000Z', '2026-10-09T12:00:00.001Z'];
  const hook = whole<{ useFrequentHidden: typeof HiddenHook }>(raw, {
    react: React, '../dmListSearchRules': searchRules,
    '../api': { api: { convFrequentHide: () => { const job = pending<{ hidden: number }>(); jobs.push(job); return job.promise; } } },
    '../toast': { toastError: (error: unknown) => errors.push(error) },
  }, { Date: class { private at = dates.shift(); toISOString() { return this.at; } } }).useFrequentHidden;
  await mounted(() => hook(true), async get => {
    await React.act(async () => get().hide('chat'));
    await React.act(async () => get().hide('chat'));
    const latest = get().hidden.chat;
    await React.act(async () => jobs[1]!.resolve({ hidden: 1 }));
    await React.act(async () => jobs[0]!.reject(new Error('старый отказ')));
    assert.equal(get().hidden.chat, latest, 'старый отказ не стирает новую отметку');
    assert.equal(errors.length, 1);
  });
}
it('R126 запоздавший отказ hide не стирает более новое успешное скрытие того же чата', async () => {
  // Два действия на одну беседу должны откатываться по своей отметке, не по одному id.
  await lateRejectCase();
  await assert.rejects(lateRejectCase(changed(frequentSource, '            if (prev[convId] !== at) return prev;', '')), /новую отметку/);
});

async function migrationCase(fail: boolean, raw = frequentSource) {
  localStorage.clear(); const at = '2026-10-01T00:00:00.000Z';
  localStorage.setItem(searchRules.FREQUENT_HIDDEN_KEY, JSON.stringify({ a: at, b: at }));
  const jobs: ReturnType<typeof pending<{ hidden: number }>>[] = [], requests: unknown[] = [];
  const hook = whole<{ useFrequentHidden: typeof HiddenHook }>(raw, {
    react: React, '../dmListSearchRules': searchRules,
    '../api': { api: { convFrequentHide: (items: unknown) => { requests.push(items); const job = pending<{ hidden: number }>(); jobs.push(job); return job.promise; } } },
  }).useFrequentHidden;
  await mounted(() => { hook(true); return hook(true); }, async () => {
    assert.equal(requests.length, 1, 'два потребителя переносят кеш только раз');
    assert.deepEqual(JSON.parse(JSON.stringify(requests[0])), [{ conversationId: 'a', at }, { conversationId: 'b', at }]);
    assert.ok(localStorage.getItem(searchRules.FREQUENT_HIDDEN_KEY), 'до ответа локальные даты сохранены');
    await React.act(async () => fail ? jobs[0]!.reject(new Error('нет сети')) : jobs[0]!.resolve({ hidden: 2 }));
    assert.equal(localStorage.getItem(searchRules.FREQUENT_HIDDEN_KEY) === null, !fail, 'ключ стирается только после успеха');
  });
  await mounted(() => hook(true), async () => {
    assert.equal(requests.length, fail ? 2 : 1, 'после отказа новый вход повторяет перенос, после успеха нет');
    if (fail) await React.act(async () => jobs[1]!.resolve({ hidden: 2 }));
  });
}
it('R126 перенос локальных частых однократный, со старыми датами, ключ стирается после успеха', async () => {
  // Раннее стирание кеша теряло бы настройку на отказе сети.
  await migrationCase(false);
  await assert.rejects(migrationCase(false, changed(frequentSource,
    '    if (!server || frequentMoving) return;', '    if (!server) return;')), /только раз/);
  await assert.rejects(migrationCase(false, changed(frequentSource, '    frequentMoving = true;',
    '    frequentMoving = true; localStorage.removeItem(FREQUENT_HIDDEN_KEY);')), /локальные даты сохранены/);
});
it('R126 отказ переноса частых сохраняет ключ и разрешает повтор при новом входе', async () => {
  // Флаг переноса не должен блокировать повтор навсегда после первого сетевого отказа.
  await migrationCase(true);
  await assert.rejects(migrationCase(true, changed(frequentSource,
    '        frequentMoving = false;', '        frequentMoving = true;')), /повторяет перенос/);
});

async function folderCase(fail: boolean, raw = foldersSource) {
  const job = pending<{ folders: shared.DmFolder[] }>(); const requests: unknown[] = [];
  const hook = whole<{ useDmFolders: typeof FoldersHook }>(raw, {
    zustand: { create }, '@gusvoice/shared': shared, './config': { activeInstanceId: () => 'instance' },
    './api': { api: { dmFolderPinOrder: (id: string, ids: string[]) => { requests.push([id, [...ids]]); return job.promise; } } },
  }).useDmFolders;
  const folder = (id: string, pinned: string[]): shared.DmFolder => ({ id, title: id, flags: 0, emoticon: null, include: [], exclude: [], pinned });
  const before = [folder('one', ['a', 'b']), folder('two', ['b', 'a'])]; hook.getState().apply(before);
  const work = hook.getState().reorderPins('one', ['b', 'a']);
  assert.deepEqual(Array.from(hook.getState().folders![0]!.pinned!), ['b', 'a'], 'своя папка меняется до ответа');
  assert.equal(hook.getState().folders![1], before[1], 'другая папка не переписывается');
  assert.deepEqual(requests, [['one', ['b', 'a']]]);
  if (fail) { job.reject(new Error('отказ порядка')); await assert.rejects(work, /отказ порядка/);
    assert.equal(hook.getState().folders, before, 'отказ возвращает исходный снимок'); }
  else { const accepted = [folder('one', ['c', 'b', 'a']), before[1]!]; job.resolve({ folders: accepted }); await work;
    assert.equal(hook.getState().folders, accepted, 'ответ сервера авторитетен'); }
}
it('R126 перестановка папки оптимистична, серверный ответ заменяет порядок и отказ откатывает', async () => {
  // Свой порядок не должен менять соседнюю папку или остаться после отказа записи.
  await folderCase(false); await folderCase(true);
  await assert.rejects(folderCase(true, changed(foldersSource,
    'set({ folders: (await api.dmFolderPinOrder(folderId, ids)).folders });\n    } catch (e) {\n      set({ folders: was });',
    'set({ folders: (await api.dmFolderPinOrder(folderId, ids)).folders });\n    } catch (e) {')), /исходный снимок/);
});

async function reorderCase(raw = dragSource) {
  const calls: unknown[] = [], errors: string[] = [];
  const hook = whole<{ reorderDmPins: (ids: string[], id?: string | null) => void }>(raw, {
    react: React, '../dmListRules': listRules, '../dmFolderView': viewRules,
    '../dmFolders': { useDmFolders: { getState: () => ({ reorderPins: (id: string, ids: string[]) => { calls.push(['folder', id, [...ids]]); return Promise.reject(new Error('отказ')); } }) } },
    '../store': { useStore: { getState: () => ({ reorderConvPins: (ids: string[]) => { calls.push(['global', [...ids]]); return Promise.reject(new Error('отказ')); } }) } },
    '../toast': { toast: (_kind: string, message: string) => errors.push(message) },
  });
  hook.reorderDmPins(['b', 'a'], 'one'); hook.reorderDmPins(['a', 'b'], null); hook.reorderDmPins(['c', 'b']);
  await Promise.resolve();
  assert.deepEqual(calls, [['folder', 'one', ['b', 'a']], ['global', ['a', 'b']], ['global', ['c', 'b']]], 'выбрана нужная область');
  assert.deepEqual(errors, Array(3).fill('Не удалось изменить порядок закреплённых бесед'));
}
it('R126 reorderDmPins выбирает папку либо общий порядок и показывает отказ каждого пути', async () => {
  // Меню и drag папки не должны менять глобальный порядок вместо своего.
  await reorderCase();
  await assert.rejects(reorderCase(changed(dragSource, 'const job = folderId ?', 'const job = false ?')), /нужная область/);
});

async function menuCase(raw = rowSource) {
  const dms = ['a', 'b', 'c', 'outside'].map(id => ({ id, pinnedAt: '2026-10-09T00:00:00Z', archived: false,
    createdAt: '2026-10-09T00:00:00Z', lastMessageAt: null, otherUser: { id: `peer-${id}`, username: id, displayName: id, avatarUrl: null } } as shared.DmChannel));
  const state = { convActive: true, serverFeatures: ['conv11', 'pinorder1', 'pinorder2'], dms, conv: { summaries: {} },
    blockedUsers: [], pushMutedDmUsers: [], pushMuteUntil: {}, pushAlwaysTargets: [], user: null };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  const moves: unknown[] = [];
  const hook = whole<{ useDmRowMenu: typeof MenuHook }>(raw, {
    react: React, '../store': { useStore }, '../convSyncRules': sync, '../dmListRules': listRules,
    '../notifyExceptionsRules': { notifyAlwaysAction: () => null }, './DmFolderBar': { useFoldersOn: () => false },
    './DmPinDrag': { reorderDmPins: (ids: string[], id: string) => moves.push([[...ids], id]) },
    './ContextMenu': { ContextMenu: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
      MenuDivider: () => null, MenuItem: ({ label, onClick }: { label: string; onClick?: () => void }) => React.createElement('button', { onClick }, label) },
  }).useDmRowMenu;
  let view!: ReturnType<typeof hook>;
  function Harness() { view = hook({ current: { folderId: 'one', ids: ['c', 'a', 'b'] } }); return view.menu; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    for (const [id, caption, next] of [['a', 'Поднять выше', ['a', 'c', 'b']], ['a', 'Опустить ниже', ['c', 'b', 'a']]] as const) {
      await React.act(async () => view.openDmMenu(dms.find(d => d.id === id)!, { x: 10, y: 10 }));
      const button = [...host.querySelectorAll('button')].find(b => b.textContent === caption); assert.ok(button, 'шаг по ids папки доступен');
      await React.act(async () => button.click());
      assert.deepEqual(moves.at(-1), [[...next], 'one'], 'шаг по ids папки и запись в неё');
    }
    await React.act(async () => view.openDmMenu(dms[3]!, { x: 10, y: 10 }));
    assert.equal([...host.querySelectorAll('button')].filter(b => /Поднять выше|Опустить ниже/.test(b.textContent ?? '')).length, 0, 'внешнего закрепа нет в области папки');
  } finally { await React.act(async () => root.unmount()); host.remove(); }
}
it('R126 меню шагает по PinReorderScope папки, а не по глобальным ids', async () => {
  // Сосед в глобальном списке может отсутствовать в папке; перестановка должна знать область.
  await menuCase();
  await assert.rejects(menuCase(changed(rowSource, 'reorderDmPins(pinUp, pinFolder)', 'reorderDmPins(pinUp, null)')), /шаг по ids папки/);
  await assert.rejects(menuCase(changed(rowSource, "typeof scope === 'object' ? scope.ids : pinnedGroupIds", "typeof scope === 'object' ? pinnedGroupIds(useStore.getState().dms, live.archived === true) : pinnedGroupIds")), /шаг по ids папки/);
});
