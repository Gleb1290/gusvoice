import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as conv from '../convSyncRules';
import * as lists from '../dmListRules';
import * as notify from '../notifyExceptionsRules';
import * as archive from '../dmArchiveRules';
import { escapeMenu, loadMenu, withMenuDom } from './ContextMenu.back.harness';

const source = readFileSync(new URL('./DmRowMenu.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
async function scenario(raw = source) {
  await withMenuDom(620, async (host, root) => {
    const real = loadMenu(); let back: (() => void) | undefined;
    function BoundMenu(props: import('./ContextMenu').ContextMenuProps) { back = props.onBack; return React.createElement(real.ContextMenu, props); }
    const dm = { id: 'dm', createdAt: '2026-10-12T00:00:00Z', lastMessageAt: null, otherUser: { id: 'peer', username: 'peer', displayName: 'Друг', avatarUrl: null } };
    const state = { convActive: true, serverFeatures: ['conv11'], blockedUsers: [], pushMutedDmUsers: [], pushMuteUntil: {},
      user: { id: 'me' }, pushAlwaysTargets: [], dms: [dm], conv: { summaries: {} } };
    const store = Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state });
    const fail = (label: string) => () => assert.fail(`навигация не выполняет ${label}`);
    const deps: Record<string, unknown> = {
      react: React, 'react/jsx-runtime': jsx, '../store': { useStore: store }, '../convSyncRules': conv, '../dmListRules': lists,
      '../notifyExceptionsRules': notify, '../dmArchiveRules': archive,
      './ContextMenu': { ...real, ContextMenu: BoundMenu },
      './DmChatView': { DmMuteMenuItems: () => React.createElement('div', { className: 'mute-level' }, 'Уровень уведомлений'),
        switchDmBlock: fail('block'), toggleDmPinned: fail('pin') },
      './DmFolderBar': { useFoldersOn: () => true, DmFolderMenuItems: () => React.createElement('div', { className: 'folders-level' }, 'Уровень папок'),
        FolderRemoveItem: () => null, toggleFolderPinned: fail('folder pin'),
        DmFolderPickEntries: fail('folder pick entries'), DmFolderPickItems: fail('folder pick items') },
      '../confirm': { confirmAction: fail('confirm') }, './DmPinDrag': { reorderDmPins: fail('reorder') },
      '../peerName': { peerNameNow: fail('name action') }, '../toast': { toastError: fail('toast') },
      './Icon': { Icon: () => null },
    };
    for (const id of ['./dmClearActions', '../dmRowRules', './DmArchive']) deps[id] = new Proxy({}, { get(_target, key) { assert.fail(`неожиданное действие ${id}.${String(key)}`); } });
    const module = { exports: {} as typeof import('./DmRowMenu') };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { module, exports: module.exports, require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `неописанный импорт ${id}`); return deps[id]; } });
    function Probe() {
      const menu = module.exports.useDmRowMenu();
      return React.createElement(React.Fragment, null,
        React.createElement('button', { className: 'open-row-menu', onClick: () => menu.openDmMenu(dm, { x: 10, y: 10 }) }, 'Открыть'), menu.menu);
    }
    await React.act(async () => root.render(React.createElement(Probe)));
    const open = async () => React.act(async () => host.querySelector<HTMLButtonElement>('.open-row-menu')!.click());
    await open(); assert.equal(typeof back, 'undefined', 'main не имеет onBack');
    for (const [label, level] of [['Выключить уведомления', '.mute-level'], ['Добавить в папку', '.folders-level']]) {
      const item = [...document.querySelectorAll<HTMLButtonElement>('.ctx-item')].find(b => b.textContent?.includes(label));
      assert.equal(item !== undefined, true, `пункт ${label} существует`);
      await React.act(async () => item!.click()); assert.equal(document.querySelector(level) !== null, true, 'подуровень открыт');
      assert.equal(typeof back, 'function', 'подуровень имеет onBack'); await escapeMenu();
      assert.equal(document.querySelector('.ctx-menu') !== null, true, 'возврат на main сохраняет меню');
      assert.equal(document.querySelector(level) === null, true, 'возврат уходит с подуровня');
      assert.equal(typeof back, 'undefined', 'после возврата снова main без onBack');
    }
    await escapeMenu(); assert.equal(document.querySelector('.ctx-menu') === null, true, 'из main Esc закрывает меню');
  });
}
it('R179 меню строки имеет onBack только в уведомлениях и папках, возврат ведёт на main без закрытия', async () => {
  // Исполняются настоящий hook DmRowMenu и ContextMenu: замоканы только содержимое подуровней и внешние операции.
  await scenario();
});
it('R179 контрфакт onBack на основном уровне отвергается поведением меню строки', async () => {
  // Без отключения callback основной уровень съедал бы системную Назад и оставлял меню висеть.
  await scenario(); const anchor = "target.level === 'main' ? undefined : () => setTarget({ ...target, level: 'main' })";
  assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(scenario(source.replace(anchor, "() => setTarget({ ...target, level: 'main' })")), e => e instanceof assert.AssertionError && e.message.includes('main не имеет'));
});
it('R179 контрфакт возврата не на main обнаруживается реальным Esc из подуровня', async () => {
  // Уникальный JSX-проп мутирует возврат, не кнопку входа на уровень уведомлений.
  await scenario(); const anchor = "onBack={target.level === 'main' ? undefined : () => setTarget({ ...target, level: 'main' })}";
  assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(scenario(source.replace(anchor, "onBack={target.level === 'main' ? undefined : () => setTarget({ ...target, level: 'mute' })}")), e => e instanceof assert.AssertionError && e.message.includes('возврат уходит'));
});
