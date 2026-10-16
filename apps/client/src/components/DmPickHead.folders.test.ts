import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as shared from '@gusvoice/shared';
import * as conv from '../convSyncRules';
import * as lists from '../dmListRules';
import * as view from '../dmFolderView';
import * as notify from '../notifyExceptionsRules';
import * as archive from '../dmArchiveRules';
import { loadMenu, withMenuDom } from './ContextMenu.back.harness';

const rowSource = readFileSync(new URL('./DmRowMenu.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const folderSource = readFileSync(new URL('./DmFolderBar.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const features = ['conv11', 'conv12', 'conv13', 'archive1', 'folders1'];
const folder = (id: string, include: string[] = [], system = false): shared.DmFolder => ({
  id, title: system ? '' : `Папка ${id}`, emoticon: null, flags: 0, include, exclude: [], ...(system ? { system: 'dms' as const } : {}),
});
function dm(id: string): shared.DmChannel {
  return { id, createdAt: '2026-10-12T00:00:00Z', lastMessageAt: null,
    otherUser: { id: `peer-${id}`, username: id, displayName: id, avatarUrl: null } } as shared.DmChannel;
}
function wholeModule<T>(source: string, deps: Record<string, unknown>): T {
  const parsed = ts.createSourceFile('module.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const node of parsed.statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
    const binding = node.importClause?.namedBindings;
    if (binding && ts.isNamedImports(binding) && binding.elements.every(e => e.isTypeOnly)) continue;
    assert.equal(Object.hasOwn(deps, (node.moduleSpecifier as ts.StringLiteral).text), true, `явный импорт ${node.moduleSpecifier.getText(parsed)}`);
  }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
  { module, exports: module.exports, window, document, navigator, Date, Promise,
    require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `неописанная граница ${id}`); return deps[id]; } });
  return module.exports as T;
}
const fail = (name: string) => () => { throw new Error(`неожиданная операция ${name}`); };
function unused(name: string) {
  return new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : fail(`${name}.${String(key)}`) });
}
type Call = { folderId: string; chat: shared.DmFolderChat; add: boolean };
interface Options { folders?: shared.DmFolder[]; activeId?: string | null; features?: string[]; convActive?: boolean; ids?: string[]; row?: string; bar?: string }
interface Fixture {
  host: HTMLDivElement;
  calls: Call[];
  open: () => Promise<void>;
  folders: () => Promise<void>;
  pick: (label: string) => Promise<void>;
  item: (label: string) => HTMLButtonElement;
  releaseOne: () => Promise<void>;
  closeCount: () => number;
}
async function fixture(options: Options, check: (f: Fixture) => Promise<void>) {
  await withMenuDom(620, async (host, root) => {
    const ids = options.ids ?? ['a', 'b', 'c'];
    const state = { convActive: options.convActive ?? true, serverFeatures: options.features ?? features,
      dms: ids.map(dm), blockedUsers: [] };
    const store = Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state });
    const calls: Call[] = []; const pending: Array<() => void> = []; const errors: unknown[] = [];
    let closeCount = 0;
    const folderState = { folders: options.folders ?? [folder('home', [], true), folder('work', ['a']), folder('other', ['spare'])],
      activeId: options.activeId ?? 'home', toggleChat: (folderId: string, chat: shared.DmFolderChat, add: boolean) => {
        calls.push({ folderId, chat, add }); return new Promise<void>(resolve => pending.push(resolve));
      } };
    const useDmFolders = Object.assign((selector: (s: typeof folderState) => unknown) => selector(folderState), { getState: () => folderState });
    const realMenu = loadMenu();
    // Значок — наблюдаемая граница: настоящий MenuItem остаётся кнопкой, Icon у общего harness не рисует SVG.
    const menu = { ...realMenu, MenuItem: (props: Parameters<typeof realMenu.MenuItem>[0]) => React.createElement('div',
      { 'data-menu-icon': props.icon ?? '' }, React.createElement(realMenu.MenuItem, props)) };
    const common: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsx, '@gusvoice/shared': shared,
      '../store': { useStore: store }, '../convSyncRules': conv, '../dmListRules': lists,
      '../confirm': { confirmAction: fail('confirm') }, '../peerName': { peerNameNow: fail('peerName') },
      '../toast': { toast: () => {}, toastError: (error: unknown) => errors.push(error) }, './ContextMenu': menu,
      './Icon': { Icon: ({ name }: { name: string }) => React.createElement('span', { 'data-icon': name }) } };
    const bar = wholeModule<typeof import('./DmFolderBar')>(options.bar ?? folderSource, { ...common,
      '../hotkeys': { isTauri: () => false }, '../dmFolderView': view,
      '../dmFolders': { useDmFolders, serverFolders: (fs: readonly string[] | undefined) => !!fs?.includes(shared.FEATURE_FOLDERS1) },
      './DmRowMenu': { readAllDms: fail('readAllDms') } });
    const row = wholeModule<typeof import('./DmRowMenu')>(options.row ?? rowSource, { ...common,
      '../notifyExceptionsRules': notify, '../dmArchiveRules': archive, './DmFolderBar': bar,
      './DmPinDrag': { reorderDmPins: fail('reorder') }, './DmChatView': { DmMuteMenuItems: fail('mute submenu'), switchDmBlock: fail('block'), toggleDmPinned: fail('pin') },
      './dmClearActions': unused('clear'), '../dmRowRules': unused('plural'), './DmArchive': { archiveDms: fail('archive') } });
    const item = (label: string) => {
      const matches = [...document.querySelectorAll<HTMLButtonElement>('.ctx-item')].filter(b => b.querySelector('.ctx-label-main')?.textContent === label);
      assert.equal(matches.length, 1, `единственный пункт ${label}`); return matches[0];
    };
    const pick = async (label: string) => { const button = item(label); await React.act(async () => button.click()); };
    const f: Fixture = { host, calls, item, pick, closeCount: () => closeCount,
      open: async () => React.act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Ещё"]')!.click()),
      folders: async () => { await f.open(); await f.pick('В папку'); },
      releaseOne: async () => { assert.equal(pending.length > 0, true, 'запрос ожидает ответа'); await React.act(async () => pending.shift()!()); } };
    await React.act(async () => root.render(React.createElement(row.DmPickHead, { ids, isMuted: () => false, onClose: () => { closeCount++; } })));
    try { await check(f); }
    finally {
      // Даже параллельный мутант не оставляет зависших callback после unregister DOM.
      for (let i = 0; i < ids.length + 2 && pending.length; i++) await React.act(async () => { for (const resolve of pending.splice(0)) resolve(); });
      assert.equal(errors.length, 0, 'навигация и toggleChat не упали на внешней границе');
    }
  });
}
const labels = (f: Fixture) => [...f.host.querySelectorAll('.dm-pick-acts > button')].map(b => b.getAttribute('aria-label')).join('|');
const menuLabels = () => [...document.querySelectorAll('.ctx-item .ctx-label-main')].map(b => b.textContent).join('|');
async function order(source = rowSource) {
  await fixture({ row: source }, async f => { assert.equal(labels(f), 'Закрепить|Выключить уведомления|В архив|Удалить|Ещё', 'порядок пяти действий'); });
}
it('R181 телефонная панель выбора идёт Закрепить, уведомления, архив, удалить, ещё', async () => {
  // Класс ошибки: перенос архива вперёд сдвигает привычные места остальных действий.
  await order();
});
it('R181 на главной вкладке В папку стоит первым, второй уровень содержит только свои папки; без capability или своей папки входа нет', async () => {
  // Класс ошибки: папочная операция видна старому серверу либо системная Все чаты становится целью переноса.
  await fixture({}, async f => { await f.open(); assert.equal(menuLabels().split('|')[0], 'В папку');
    assert.equal(f.item('В папку').querySelector('.ctx-arrow') !== null, true, 'В папку ведёт на второй уровень');
    await f.pick('В папку'); assert.equal(menuLabels(), 'Папка work|Папка other'); assert.equal(f.closeCount(), 0); });
  for (const options of [{ features: features.filter(x => x !== 'folders1') }, { convActive: false }, { folders: [folder('home', [], true)] }]) {
    await fixture(options, async f => {
      if (f.host.querySelector('[aria-label="Ещё"]')) await f.open();
      assert.equal(menuLabels().split('|').includes('В папку'), false, 'нет папочной capability/своих папок — нет входа');
    });
  }
});
async function missing(source = folderSource) {
  await fixture({ bar: source }, async f => {
    await f.folders(); assert.equal(f.item('Папка work').parentElement?.getAttribute('data-menu-icon'), '', 'частичное включение без галочки');
    await f.pick('Папка work'); assert.equal(f.calls.map(c => c.chat.id).join('|'), 'b', 'добавляется только первый недостающий');
    assert.equal(f.calls[0].add, true); assert.equal(f.calls[0].folderId, 'work');
    await f.releaseOne(); assert.equal(f.calls.map(c => c.chat.id).join('|'), 'b|c', 'второй запрос только после ответа первого');
    assert.equal(f.calls[1].add, true); await f.releaseOne();
    assert.equal(f.closeCount(), 1); assert.equal(document.querySelector('.ctx-menu') === null, true, 'выбор папки закрывает меню');
  });
}
it('R181 частично включённый выбор добавляет только недостающие беседы и ждёт каждый ответ', async () => {
  // Каждый ответ toggleChat заменяет список папок целиком: параллельность теряла бы изменения.
  await missing();
});
it('R181 все выбранные внутри обозначаются галочкой и последовательно удаляются, а не добавляются заново', async () => {
  // Класс ошибки: all=true перепутан с частичным выбором или направление операции всегда add.
  await fixture({ folders: [folder('home', [], true), folder('work', ['a', 'b', 'c', 'spare'])] }, async f => {
    await f.folders(); assert.equal(f.item('Папка work').parentElement?.getAttribute('data-menu-icon'), 'check', 'все внутри — галочка');
    await f.pick('Папка work');
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      assert.equal(f.calls.length, index + 1, 'удаление не параллельно'); assert.equal(f.calls[index].chat.id, id); assert.equal(f.calls[index].add, false);
      await f.releaseOne();
    }
    assert.equal(f.closeCount(), 1);
  });
});
it('R181 ровно сто явно включённых принимается, сто один блокируется без toggleChat', async () => {
  // Класс ошибки: > вместо >= у лимита или проверка лимита по всем выбранным вместо недостающих.
  for (const size of [99, 100]) {
    const include = ['a', ...Array.from({ length: size - 1 }, (_, i) => `spare-${i}`)];
    await fixture({ ids: ['a', 'b'], folders: [folder('home', [], true), folder('work', include)] }, async f => {
      await f.folders(); assert.equal(f.item('Папка work').disabled, size === 100, 'граница 100 включённых');
      await f.pick('Папка work'); assert.equal(f.calls.length, size === 99 ? 1 : 0);
      if (size === 99) { assert.equal(f.calls[0].chat.id, 'b'); await f.releaseOne(); }
    });
  }
});
it('R181 в своей папке вместо В папку предлагается убрать из неё только допустимые выбранные беседы', async () => {
  // Класс ошибки: операция направлена в другую папку или удаляет выбранный чат, которого в папке нет.
  await fixture({ activeId: 'work', folders: [folder('home', [], true), folder('work', ['a', 'b', 'spare'])] }, async f => {
    await f.open(); assert.equal(menuLabels().split('|')[0], 'Убрать из папки «Папка work»');
    assert.equal(menuLabels().split('|').includes('В папку'), false);
    await f.pick('Убрать из папки «Папка work»'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].chat.id, 'a');
    await f.releaseOne(); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].chat.id, 'b');
    assert.equal(f.calls.every(c => c.folderId === 'work' && !c.add), true); await f.releaseOne(); assert.equal(f.closeCount(), 1);
  });
});
it('R181 единственный явно включённый чат нельзя убрать до пустой папки ни с главной, ни из самой папки', async () => {
  // Класс ошибки: обход dmFolderCanRemove создаёт запрещённую пустую папку через массовый выбор.
  for (const activeId of ['home', 'work']) {
    await fixture({ ids: ['a'], activeId, folders: [folder('home', [], true), folder('work', ['a'])] }, async f => {
      if (activeId === 'home') { await f.folders(); assert.equal(f.item('Папка work').disabled, true); await f.pick('Папка work'); }
      else { await f.open(); assert.equal(menuLabels().includes('Убрать из папки'), false); }
      assert.equal(f.calls.length, 0); assert.equal(f.closeCount(), 0);
    });
  }
});
function replaceUnique(source: string, anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'уникальный якорь мутанта'); return source.replace(anchor, replacement);
}
function archiveFirst() {
  const parsed = ts.createSourceFile('DmRowMenu.tsx', rowSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const containers: ts.JsxElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(p => ts.isJsxAttribute(p)
      && p.name.getText(parsed) === 'className' && p.initializer && ts.isStringLiteral(p.initializer) && p.initializer.text === 'dm-pick-acts')) containers.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed); assert.equal(containers.length, 1, 'панель выбора одна');
  const expressions = containers[0].children.filter(ts.isJsxExpression);
  const block = (prefix: string) => {
    const nodes = expressions.filter(n => n.expression?.getText(parsed).startsWith(prefix)); assert.equal(nodes.length, 1, `блок ${prefix}`);
    return rowSource.slice(nodes[0].getStart(parsed), nodes[0].end);
  };
  const pin = block('prefsOn &&'); const archive = block('archiveOn &&');
  return replaceUnique(replaceUnique(rowSource, archive, ''), pin, `${archive}\n${pin}`);
}
const assertionAt = (text: string) => (error: unknown) => error instanceof assert.AssertionError && error.message.includes(text);
it('R181 контрфакт архива первой кнопкой обнаруживается по реальному DOM панели', async () => {
  // Переставляются JSX-узлы только нужной панели; исполняется весь модуль, не фрагмент исходника.
  await order(); await assert.rejects(order(archiveFirst()), assertionAt('порядок пяти действий'));
});
it('R181 контрфакт добавления всех вместо недостающих обнаруживается по первому toggleChat', async () => {
  // Уже включённый a не должен повторно уйти в API: это не просто проверка общего числа запросов.
  await missing(); const mutant = replaceUnique(folderSource, 'all ? chats : missing, !all', 'chats, !all');
  await assert.rejects(missing(mutant), assertionAt('добавляется только первый недостающий'));
});
it('R181 контрфакт параллельных toggleChat обнаруживается до ответа первого запроса', async () => {
  // Отложенные Promise моделируют независимые полные ответы сервера без таймеров и сети.
  await missing(); const mutant = replaceUnique(folderSource,
    'return chats.reduce<Promise<void>>((p, c) => p.then(() => useDmFolders.getState().toggleChat(folderId, c, add)), Promise.resolve());',
    'return Promise.all(chats.map(c => useDmFolders.getState().toggleChat(folderId, c, add))).then(() => undefined);');
  await assert.rejects(missing(mutant), assertionAt('добавляется только первый недостающий'));
});
