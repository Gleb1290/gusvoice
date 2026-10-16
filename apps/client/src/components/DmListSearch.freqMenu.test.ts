import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import type { DmChannel } from '@gusvoice/shared';
import * as bigReaction from '../bigReaction';
import * as listRules from '../dmListRules';
import * as searchRules from '../dmListSearchRules';
import * as rowRules from '../dmRowRules';
import * as popover from '../popover';
import * as sharedMedia from '../sharedMediaRules';
import type * as Search from './DmListSearch';
import type * as Menu from './ContextMenu';

before(() => {
  GlobalRegistrator.register({ url: 'http://localhost/', width: 390, height: 844 });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(() => GlobalRegistrator.unregister());

type Change = (source: string) => string;

// Исполняются целые модули, а не вынутые обработчики. Реальное ContextMenu важно:
// мобильный лист останавливает mousedown раньше предка поиска и рендерится порталом.
function loadModule<T>(file: string, dependencies: Record<string, unknown>, change?: Change): T {
  let source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (change) {
    const changed = change(source);
    assert.notEqual(changed, source, 'мутант действительно изменяет исходник DmListSearch');
    source = changed;
  }
  const module = { exports: {} as T };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, window, document, navigator, Element, Node, Event,
    ResizeObserver, getComputedStyle,
    require: (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `неожиданная зависимость ${file}: ${id}`);
      return dependencies[id];
    },
  });
  return module.exports;
}

function loadSearch(change?: Change) {
  const menu = loadModule<typeof Menu>('./ContextMenu.tsx', {
    react: React,
    'react/jsx-runtime': jsxRuntime,
    'react-dom': { createPortal },
    '../bigReaction': bigReaction,
    '../popover': popover,
    '../imageViewer': { useImageViewerOpen: () => false },
    './Icon': { Icon: () => null },
    './StatusDot': { StatusDot: () => null },
  });
  const unexpected = () => assert.fail('пустой поиск не вызывает API, переход или живой стор');
  return loadModule<typeof Search>('./DmListSearch.tsx', {
    react: React,
    'react/jsx-runtime': jsxRuntime,
    '../api': { api: { convFrequent: unexpected, convFrequentHide: unexpected, convSearchAll: unexpected } },
    '../dmListRules': listRules,
    '../dmRowRules': rowRules,
    '../dmListSearchRules': searchRules,
    '../feedJump': { requestFeedJump: unexpected },
    '../sharedMediaRules': sharedMedia,
    '../peerName': {
      usePeerName: () => (_id: string, name: string) => name,
      dmPeerLabel: (dm: DmChannel) => dm.otherUser.displayName,
    },
    '../store': { useStore: { getState: unexpected } },
    '../toast': { toastError: unexpected },
    './Avatar': { Avatar: () => null },
    './ContextMenu': menu,
    './Icon': { Icon: () => null },
  }, change);
}

const dm: DmChannel = {
  id: 'friend',
  otherUser: { id: 'peer', username: 'peer', displayName: 'Друг', avatarUrl: null },
  createdAt: '2026-10-01T00:00:00Z',
  lastMessageAt: '2026-10-09T00:00:00Z',
  unread: 0,
};

async function mount(change?: Change, frequent = true) {
  const { DmSearchHome } = loadSearch(change);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const menuStates: boolean[] = [], hidden: string[] = [], opened: string[] = [];
  let unmounted = false;
  const dispose = async () => {
    if (!unmounted) {
      await React.act(async () => root.unmount());
      unmounted = true;
    }
    host.remove();
  };
  try {
    await React.act(async () => root.render(React.createElement(DmSearchHome, {
      dms: [dm], recents: [],
      onPerson: (item) => { opened.push(item.id); }, onQuery() {}, onRemove() {}, onClear() {},
      onMenuOpen: (open) => { menuStates.push(open); },
      ...(frequent ? { frequent: {
        items: [{ conversationId: dm.id, score: 1, lastAt: '2026-10-09T00:00:00Z' }],
        hidden: {}, blockedIds: new Set<string>(), onHide: (id: string) => { hidden.push(id); },
      } } : {}),
    })));
  } catch (error) {
    await dispose();
    throw error;
  }
  const person = host.querySelector<HTMLButtonElement>('.dms-person');
  assert.ok(person, 'частый собеседник отрисован');
  return { person, menuStates, hidden, opened, dispose };
}

type Scene = Awaited<ReturnType<typeof mount>>;

async function openMenu(scene: Scene) {
  assert.deepEqual(scene.menuStates, [], 'закрытый поиск не сообщает об открытии меню');
  const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 80 });
  await React.act(async () => { scene.person.dispatchEvent(context); });
  assert.equal(context.defaultPrevented, true, 'ПКМ отменяет браузерное меню');
  assert.deepEqual(scene.menuStates, [true], 'открытие меню удерживает поиск ровно один раз');
  const sheet = document.querySelector('.ctx-menu.sheet');
  assert.ok(sheet, 'на телефоне открыт настоящий нижний лист ContextMenu');
  const item = sheet.querySelector<HTMLButtonElement>('[role="menuitem"]');
  assert.ok(item, 'лист содержит пункт меню');
  assert.equal(item.textContent, 'Убрать из частых');
  assert.deepEqual(scene.opened, [], 'ПКМ не открывает беседу');
  return item;
}

async function checkClose(mode: 'hide' | 'backdrop' | 'escape' | 'unmount', change?: Change) {
  const scene = await mount(change);
  try {
    const item = await openMenu(scene);
    if (mode === 'unmount') await scene.dispose();
    else await React.act(async () => {
      if (mode === 'hide') item.click();
      else if (mode === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else {
        const backdrop = document.querySelector('.ctx-sheet-backdrop');
        assert.ok(backdrop);
        backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      }
    });
    assert.equal(document.querySelector('.ctx-menu') === null, true, 'меню действительно закрыто');
    assert.deepEqual(scene.menuStates, [true, false], 'закрытие или размонтирование отпускает поиск ровно один раз');
    assert.deepEqual(scene.hidden, mode === 'hide' ? [dm.id] : [], 'только пункт Убрать скрывает выбранную беседу');
    await scene.dispose();
    assert.deepEqual(scene.menuStates, [true, false], 'после закрытия размонтирование не дублирует false');
  } finally { await scene.dispose(); }
}

async function checkMouseDown(change?: Change) {
  const scene = await mount(change);
  try {
    const item = await openMenu(scene);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await React.act(async () => { item.dispatchEvent(down); });
    assert.equal(down.defaultPrevented, true, 'mousedown пункта листа отменяет перевод фокуса');
    assert.deepEqual(scene.menuStates, [true], 'mousedown сам не закрывает лист');
    assert.deepEqual(scene.hidden, [], 'mousedown сам не выполняет действие пункта');
    await React.act(async () => item.click());
    assert.deepEqual(scene.hidden, [dm.id], 'после mousedown click выполняет действие');
    assert.deepEqual(scene.menuStates, [true, false]);
  } finally { await scene.dispose(); }
}

it('R133 пункт Убрать из частых сообщает открытие и закрытие меню', async () => checkClose('hide'));
it('R133 нажатие подложки закрывает меню и отпускает поиск без удаления', async () => checkClose('backdrop'));
it('R133 Escape закрывает меню и отпускает поиск без удаления', async () => checkClose('escape'));
it('R133 размонтирование открытого меню отпускает удержание поиска', async () => checkClose('unmount'));
it('R133 mousedown пункта нижнего листа отменён, следующий click удаляет беседу', async () => checkMouseDown());
it('R133 без частых обычный клик открывает беседу, ПКМ не создаёт удержание меню', async () => {
  const scene = await mount(undefined, false);
  try {
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await React.act(async () => { scene.person.dispatchEvent(context); scene.person.click(); });
    assert.equal(context.defaultPrevented, false);
    assert.deepEqual(scene.opened, [dm.id]);
    assert.equal(document.querySelector('.ctx-menu') === null, true);
    await scene.dispose();
    assert.deepEqual(scene.menuStates, [], 'без меню ни true, ни false не отправляются');
  } finally { await scene.dispose(); }
});

it('R133 мутант без обёртки onMouseDown теряет отмену фокуса в листе', async () => {
  await checkMouseDown();
  const change: Change = (source) => source
    .replace('<div onMouseDown={(e) => e.preventDefault()}>', '<>')
    .replace('          </div>\n        </ContextMenu>', '          </>\n        </ContextMenu>');
  await assert.rejects(() => checkMouseDown(change), (error: unknown) => {
    assert.ok(error instanceof assert.AssertionError);
    assert.match(error.message, /^mousedown пункта листа отменяет перевод фокуса/);
    return true;
  });
});

it('R133 мутант без false в cleanup оставляет поиск удержанным после close и unmount', async () => {
  const change: Change = (source) => source.replace('return () => onMenuOpenRef.current?.(false);', 'return () => {};');
  for (const mode of ['hide', 'unmount'] as const) {
    await checkClose(mode);
    await assert.rejects(() => checkClose(mode, change), (error: unknown) => {
      assert.ok(error instanceof assert.AssertionError);
      assert.match(error.message, /^закрытие или размонтирование отпускает поиск ровно один раз/);
      return true;
    });
  }
});
