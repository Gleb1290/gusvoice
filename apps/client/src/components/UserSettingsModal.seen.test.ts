import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import * as anchorRules from '../settingsAnchor';
import { marksLabel, sectionMark, sameMarks, samePrints, changedDotOn } from '../settingsChanged';
import * as nav from '../settingsNav';
import * as seen from '../settingsSeen';
import { testVmImports } from '../testVmImports';
import * as shell from './SettingsShell';

const source = new URL('./UserSettingsModal.tsx', import.meta.url);
const compiled = ts.transpileModule(readFileSync(source, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

const el = React.createElement;
const noop = () => {};
const botsId = 'set-g-bots';
const storageId = 'set-g-storage';
const autoDownloadId = 'set-g-autodl';
type VisibilityEntry = Pick<IntersectionObserverEntry, 'target' | 'isIntersecting' | 'intersectionRatio'>;

async function settings(t: TestContext, unread: string[]) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const actFlag = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let tabVisibility: DocumentVisibilityState = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => tabVisibility });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(async () => {
    await React.act(async () => root.unmount());
    t.mock.timers.reset();
    await GlobalRegistrator.unregister();
    if (actFlag) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actFlag);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });

  localStorage.setItem('gv_settings_seen', JSON.stringify({
    seeded: true,
    ids: nav.SECTIONS.flatMap((s) => s.groups.map((g) => g.id)).filter((id) => !unread.includes(id)),
  }));

  // Happy DOM не считает геометрию. События видимости получает только подписанный узел.
  const observers = new Map<Element, (entries: VisibilityEntry[]) => void>();
  class TestIntersectionObserver {
    private targets = new Set<Element>();
    constructor(private emit: (entries: VisibilityEntry[]) => void) {}
    observe(target: Element) { this.targets.add(target); observers.set(target, this.emit); }
    unobserve(target: Element) { this.targets.delete(target); observers.delete(target); }
    disconnect() { for (const target of this.targets) this.unobserve(target); }
    takeRecords() { return []; }
  }

  const group = (id: string, name: string) => el('div', { id, className: 'settings-group-label' }, name);
  type BotChunk = { MyBotsSettings: () => React.ReactElement };
  let resolveBots: (chunk: BotChunk) => void = noop;
  const botChunk = new Promise<BotChunk>((resolve) => { resolveBots = resolve; });
  let setStorageReady: (ready: boolean) => void = noop;
  function DataStorage() {
    const [ready, setReady] = React.useState(false);
    setStorageReady = setReady;
    return el('div', null, group(autoDownloadId, 'Автозагрузка медиа'),
      ready ? group(storageId, 'Использование памяти') : el('div', null, 'Загрузка данных…'));
  }

  const imports = testVmImports(source, {
    react: React, 'react/jsx-runtime': jsx, '@gusvoice/shared': {},
    './DmFolderBar': { hasFolderEditRequest: () => true, useFoldersOn: () => true },
    './DmFolderSettings': { DmFolderSettings: () => group('set-g-folders', 'Мои папки') },
    './DataStorageSettings': { DataStorageSettings: DataStorage },
    '../settingsAnchor': anchorRules, '../settingsNav': nav, '../settingsSeen': seen,
    '../settingsSnapshot': { readSettings: () => ({}), factorySettings: () => ({}) },
    '../settingsChanged': { markChanged: () => ({}), groupPrints: () => ({}), marksLabel, sectionMark, sameMarks, samePrints, changedDotOn },
    '../hotkeys': { isDesktop: () => false, isTauri: () => false, isAndroid: () => false },
    '../phoneLayout': { usePhoneUi: () => false },
    '../federationClient': { useFederationEnabled: () => false },
    '../config': { multiInstanceEnabled: () => false },
    '../store': { useStore: (select: (state: object) => unknown) => select({}) },
    '../dialogChrome': { useDialogChrome: () => React.useRef(null) },
    '../androidBack': { pushBackHandler: () => noop },
    '../toast': { toastError: (error: unknown) => { throw error; } },
    './SettingsShell': shell,
  });
  const module = { exports: {} as { UserSettingsModal: React.ComponentType<{ onClose: () => void }> } };
  runInNewContext(compiled, {
    module, exports: module.exports, document, window, IntersectionObserver: TestIntersectionObserver, MutationObserver,
    setTimeout, clearTimeout,
    require: (id: string) => id === './MyBotsSettings' ? botChunk : imports(id),
  });

  function button(id: string) {
    const tab = host.querySelector<HTMLButtonElement>('#set-tab-' + id);
    assert.ok(tab, 'Раздел доступен в настройках');
    return tab;
  }
  async function advance(ms: number) {
    await React.act(async () => { t.mock.timers.tick(ms); });
  }
  async function open() {
    await React.act(async () => root.render(el(module.exports.UserSettingsModal, { onClose: noop })));
    await advance(0);
  }
  await open();

  return {
    advance, open,
    close: () => React.act(async () => root.render(null)),
    async pick(id: string) {
      await React.act(async () => button(id).click());
      await advance(0);
    },
    dot: (id: string) => !!button(id).querySelector('[aria-label="есть непросмотренное"]'),
    content: () => host.querySelector('[role="tabpanel"]')?.textContent,
    async loadBots() {
      await React.act(async () => {
        resolveBots({ MyBotsSettings: () => group(botsId, 'Мои боты') });
      });
    },
    async showStorage(ready: boolean) {
      await React.act(async () => setStorageReady(ready));
    },
    async setTabVisibility(state: DocumentVisibilityState) {
      await React.act(async () => {
        tabVisibility = state;
        document.dispatchEvent(new Event('visibilitychange'));
      });
    },
    async visible(id: string, intersectionRatio: number) {
      const target = host.querySelector('#' + id);
      assert.ok(target, 'Группа появилась в открытом разделе');
      const emit = observers.get(target);
      assert.ok(emit, 'Появившаяся группа получает события видимости');
      await React.act(async () => emit([{ target, isIntersecting: intersectionRatio > 0, intersectionRatio }]));
    },
    anchor: (name: string) => [...host.querySelectorAll('.set-rail-anchor')].find((button) => button.textContent === name),
  };
}

it('точка у ботов переживает загрузку раздела и исчезает после полусекунды просмотра', async (t) => {
  const view = await settings(t, [botsId, storageId]);
  await view.pick('bots');
  assert.match(view.content() ?? '', /Загрузка…/);
  await view.advance(1_000);
  assert.equal(view.dot('bots'), true);

  await view.loadBots();
  assert.match(view.content() ?? '', /Мои боты/);
  await view.visible(botsId, 1);
  await view.advance(499);
  assert.equal(view.dot('bots'), true);
  await view.advance(1);
  assert.equal(view.dot('bots'), false);
  assert.equal(view.dot('data'), true);

  await view.close();
  await view.open();
  assert.equal(view.dot('bots'), false);
  assert.equal(view.dot('data'), true);
  await view.pick('bots');
  assert.match(view.content() ?? '', /Мои боты/);
});

it('поздняя группа получает точку и якорь, а выход из видимой области прерывает отсчёт', async (t) => {
  const view = await settings(t, [autoDownloadId, storageId]);
  await view.pick('data');
  await view.visible(autoDownloadId, 1);
  await view.advance(250);
  assert.equal(!!view.anchor('Использование памяти'), false);

  await view.showStorage(true);
  assert.ok(view.anchor('Использование памяти')?.querySelector('[aria-label="не просмотрено"]'));
  await view.advance(250);
  assert.equal(seen.seenGroups().has(autoDownloadId), true, 'загрузка соседней группы не сбрасывает отсчёт');
  assert.equal(view.dot('data'), true);

  await view.visible(storageId, 1);
  await view.advance(499);
  await view.visible(storageId, 0);
  await view.advance(1_000);
  assert.equal(view.dot('data'), true);
  await view.visible(storageId, 1);
  await view.advance(500);
  assert.equal(view.dot('data'), false);
});

it('удалённый заголовок и закрытое окно не засчитывают незавершённый просмотр', async (t) => {
  const view = await settings(t, [storageId]);
  await view.pick('data');
  await view.showStorage(true);
  await view.visible(storageId, 1);
  await view.advance(250);
  await view.showStorage(false);
  await view.showStorage(true);
  await view.advance(250);
  assert.equal(view.dot('data'), true);

  await view.visible(storageId, 1);
  await view.advance(250);
  await view.close();
  await view.advance(250);
  await view.open();
  assert.equal(view.dot('data'), true);
});

it('видимый край группы не гасит точку, а падение ниже 60% сбрасывает отсчёт', async (t) => {
  const view = await settings(t, [botsId]);
  await view.pick('bots');
  await view.loadBots();

  await view.visible(botsId, 0.01);
  await view.advance(1_000);
  assert.equal(view.dot('bots'), true);

  await view.visible(botsId, 0.6);
  await view.advance(499);
  await view.visible(botsId, 0.59);
  await view.advance(1_000);
  assert.equal(view.dot('bots'), true);

  await view.visible(botsId, 0.6);
  await view.advance(499);
  assert.equal(view.dot('bots'), true);
  await view.advance(1);
  assert.equal(view.dot('bots'), false);
});

it('загрузка и ожидание в скрытой вкладке не гасят точку, после возврата нужен полный просмотр', async (t) => {
  const view = await settings(t, [botsId]);
  await view.pick('bots');
  await view.setTabVisibility('hidden');
  await view.loadBots();
  await view.advance(1_000);
  assert.equal(view.dot('bots'), true);

  await view.setTabVisibility('visible');
  await view.visible(botsId, 1);
  await view.advance(499);
  await view.setTabVisibility('hidden');
  await view.advance(1_000);
  assert.equal(view.dot('bots'), true);

  await view.setTabVisibility('visible');
  await view.advance(1_000);
  assert.equal(view.dot('bots'), true);
  await view.visible(botsId, 1);
  await view.advance(499);
  assert.equal(view.dot('bots'), true);
  await view.advance(1);
  assert.equal(view.dot('bots'), false);
});
