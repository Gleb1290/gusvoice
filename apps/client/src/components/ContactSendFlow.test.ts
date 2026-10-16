import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import type { ConvMediaInput } from '@gusvoice/shared';
import * as dmRules from '../dmRules';
import * as convRules from '../convSyncRules';
import * as contactRules from '../contactRules';
import * as listRules from '../dmListRules';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const raw = read('./ContactSendFlow.tsx');
const unused = () => assert.fail('IO вне выбора и подтверждения контакта');
function load<T>(source: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, window, document, HTMLElement, Element, Node, Event, KeyboardEvent, MouseEvent,
    requestAnimationFrame, cancelAnimationFrame, localStorage, performance, Error,
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `импорт целого ContactSendFlow/списка/оболочки: ${id}`); return deps[id]; },
  }); return module.exports as T;
}
type Scene = {
  sent: ConvMediaInput[]; errors: Error[]; closed(): number; select(): Promise<void>; click(label: string): Promise<void>;
  closePicker(): Promise<void>; finish(): Promise<void>; buttons(): HTMLButtonElement[]; root: HTMLElement;
};
async function fixture(phone: boolean, work: (f: Scene) => Promise<void>, source = raw, mode: 'success' | 'error-once' | 'pending' = 'success') {
  GlobalRegistrator.register({ url: 'http://localhost/', width: phone ? 360 : 1200 });
  const priorAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const sent: ConvMediaInput[] = [], errors: Error[] = []; let closed = 0;
  let resolve!: () => void;
  const pending = new Promise<void>(done => { resolve = done; });
  const onSend = async (media: ConvMediaInput) => {
    sent.push(media);
    if (mode === 'error-once' && sent.length === 1) throw new Error('send-failed');
    if (mode === 'pending') await pending;
  };
  const peer = { id: 'contact-user', username: 'contact', displayName: 'Имя1', avatarUrl: null };
  const state = { members: [{ user: peer }], dms: [], user: { id: 'me' }, serverFeatures: [], convActive: true,
    openDmWith: unused, openDmRemote: unused, openSaved: unused };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  const common = { react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': jsx };
  const platform = { isMobile: () => phone, isTauri: () => false, isAndroid: () => phone };
  const icon = load<typeof import('./Icon')>(read('./Icon.tsx'), common);
  const phoneLayout = load<typeof import('../phoneLayout')>(read('../phoneLayout.ts'), { ...common, './hotkeys': platform });
  const androidBack = load<typeof import('../androidBack')>(read('../androidBack.ts'), { './hotkeys': platform, './store': { useStore } });
  const chrome = load<typeof import('../dialogChrome')>(read('../dialogChrome.ts'), { ...common, './androidBack': androidBack });
  const lite = load<typeof import('../liteMode')>(read('../liteMode.ts'), common);
  const avatar = load<typeof import('./Avatar')>(read('./Avatar.tsx'), { ...common, '../liteMode': lite,
    '../windowCovered': { useWindowMotion: () => ({ covered: false, gameFg: false }) },
    '../firstFrame': { useFirstFrame: (url: string | null) => { assert.equal(url, null, 'у тестового контакта нет анимированного изображения'); return null; } } });
  const bottom = load<typeof import('./BottomSheet')>(read('./BottomSheet.tsx'), { ...common, './Icon': icon });
  const deps: Record<string, unknown> = { ...common, '../store': { useStore }, '../dmRules': dmRules,
    '../convSyncRules': convRules, '../contactRules': contactRules, '../dmListRules': listRules,
    '../api': { api: { searchUsers: unused } }, '../dmOnline': { useVisibleOnline: () => new Set() },
    '../useContactSeen': { useContactSeen: () => new Map() }, '../phoneLayout': phoneLayout, '../hotkeys': platform,
    '../dialogChrome': chrome, '../toast': { toast: unused, toastError: (error: Error) => errors.push(error) },
    '../dmCompose': { closeDmCompose: unused }, '../contacts': { useContactList: () => [] },
    '../peerName': { usePeerName: () => (_id: string, fallback: string) => fallback },
    './Avatar': avatar, './Icon': icon, './BottomSheet': bottom };
  // Эти импорты относятся к другим экспортам DmSidebar. Их поведения здесь нет и не подменяется.
  for (const id of ['../channelRules', '../chatKeysRules', '../dmArchiveRules', '../dmRowRules', '../typing', '../androidBack', '../connState',
    './SavedAvatar', './GroupDialogs', '../groupChatRules', './DmRowMenu', './DmFolderBar', '../dmFolderView', '../dmFolders',
    '../cornerButtonsRules', '../dmListSearchRules', './DmServerSearch', './DmAllSearch', './DmListSearch', './DmArchive',
    '../dragOut', '../dmListView', '../uiPrefs', '../filesDrop', './DmListSwipe', './DmPinDrag', '../chatSwipe', './Goose',
    './SelfVoiceBar', './SettingsShell', './SharedMedia', './StatusDot', './VoicePanel', '../voiceDrafts']) deps[id] = {};
  try {
    const sidebar = load<typeof import('./DmSidebar')>(read('./DmSidebar.tsx'), deps);
    const Flow = load<typeof import('./ContactSendFlow')>(source, { ...common, '../dialogChrome': chrome, '../phoneLayout': phoneLayout,
      '../toast': deps['../toast'], './Avatar': avatar, './BottomSheet': bottom, './DmSidebar': sidebar, './Icon': icon }).ContactSendFlow;
    function Parent() {
      const [visible, show] = React.useState(true);
      return visible ? React.createElement(Flow, { onSend, onClose: () => { closed++; show(false); } }) : null;
    }
    await React.act(async () => { root.render(React.createElement(Parent)); });
    await work({ root: document.body, sent, errors, closed: () => closed,
      async select() {
        const row = [...document.querySelectorAll<HTMLButtonElement>('.dm-compose-list .sheet-row')].find(node => node.textContent?.includes('Имя1'));
        assert.ok(row, 'настоящий ContactPickSheet показывает человека из настоящих dmComposeCandidates');
        await React.act(async () => { row.click(); });
      },
      async click(label) {
        const button = [...document.querySelectorAll<HTMLButtonElement>('.contact-send button')].find(node => node.textContent === label);
        assert.ok(button, `настоящее подтверждение имеет кнопку ${label}`);
        await React.act(async () => { button.click(); });
      },
      async closePicker() {
        await React.act(async () => {
          if (phone) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          else document.querySelector<HTMLElement>('.modal-overlay')!.click();
        });
      },
      async finish() { await React.act(async () => { resolve(); }); },
      buttons: () => [...document.querySelectorAll<HTMLButtonElement>('.contact-send button')],
    });
  } finally {
    resolve(); await React.act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister();
    if (priorAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', priorAct); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}
async function selection(phone = false, source = raw) {
  await fixture(phone, async f => {
    assert.equal(f.sent.length, 0);
    await f.select();
    assert.equal(f.sent.length, 0, 'R220-select: выбор строки не отправляет контакт до подтверждения');
    assert.equal(f.closed(), 0, 'закрытие списка после выбора не закрывает весь поток');
    assert.equal(f.root.querySelector('.contact-send-name')?.textContent, 'Имя1');
    assert.equal(f.root.querySelector('.contact-send-sub')?.textContent, '@contact');
    assert.equal(!!f.root.querySelector('.sheet .contact-send'), phone, 'на телефоне подтверждение в настоящем BottomSheet, на ПК в модальном окне');
    await f.click('Отправить');
    assert.equal(JSON.stringify(f.sent), '[{"kind":"contact","userId":"contact-user"}]');
    assert.equal(f.closed(), 1, 'успешная отправка закрывает поток ровно один раз');
    assert.equal(f.root.querySelector('.contact-send'), null);
  }, source);
}
async function cancellation(phone = false, source = raw) {
  await fixture(phone, async f => {
    await f.select(); await f.click('Отмена');
    assert.equal(f.sent.length, 0, 'R220-cancel: Отмена не отправляет контакт');
    assert.equal(f.closed(), 1); assert.equal(f.root.querySelector('.contact-send'), null);
  }, source);
}
for (const phone of [false, true]) {
  const platform = phone ? 'телефон' : 'ПК';
  it(`R220 ${platform}: выбор только открывает подтверждение, Отправить посылает выбранный контакт`, () => selection(phone));
  it(`R220 ${platform}: Отмена только закрывает подтверждение без отправки`, () => cancellation(phone));
  it(`R220 ${platform}: закрытие списка без выбора зовёт только onClose`, async () => {
    await fixture(phone, async f => { await f.closePicker(); assert.equal(f.sent.length, 0); assert.equal(f.closed(), 1); assert.equal(f.root.querySelector('.dm-compose-list'), null); });
  });
  it(`R220 ${platform}: ошибка оставляет подтверждение открытым и разрешает успешный повтор`, async () => {
    await fixture(phone, async f => {
      await f.select(); await f.click('Отправить');
      assert.equal(f.closed(), 0); assert.equal(f.errors.length, 1); assert.equal(f.errors[0].message, 'send-failed');
      assert.equal(!!f.root.querySelector('.contact-send'), true); assert.equal(f.buttons().every(button => !button.disabled), true);
      await f.click('Отправить'); assert.equal(f.sent.length, 2); assert.equal(f.closed(), 1);
    }, raw, 'error-once');
  });
  it(`R220 ${platform}: повторный клик во время отправки игнорируется`, async () => {
    await fixture(phone, async f => {
      await f.select(); await f.click('Отправить'); assert.equal(f.sent.length, 1);
      assert.equal(f.buttons().every(button => button.disabled), true, 'на время обещания отключены обе кнопки');
      await f.click('Отправить'); assert.equal(f.sent.length, 1, 'повторное пользовательское нажатие не создаёт вторую отправку');
      assert.equal(f.closed(), 0); await f.finish(); assert.equal(f.closed(), 1);
    }, raw, 'pending');
  });
}
it('R220 контрфакт: отправка по выбору ловится настоящим списком и потоком', async () => {
  await selection(false, raw);
  const from = 'onPick={(userId, info) => setWho({ userId, info })}';
  assert.equal(raw.split(from).length - 1, 1, 'однозначный якорь выбора в целом ContactSendFlow');
  const changed = raw.replace(from, "onPick={(userId, info) => { void onSend({ kind: 'contact', userId }); setWho({ userId, info }); }}");
  await assert.rejects(selection(false, changed), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith('R220-select:') && error.operator === 'strictEqual' && error.actual === 1 && error.expected === 0);
});
it('R220 контрфакт: Отмена отправляет вместо закрытия', async () => {
  await cancellation(false, raw);
  const from = 'className="link" disabled={busy} onClick={onClose}';
  assert.equal(raw.split(from).length - 1, 1, 'однозначная кнопка Отмена в целом ContactSendFlow');
  await assert.rejects(cancellation(false, raw.replace(from, 'className="link" disabled={busy} onClick={send}')),
    (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith('R220-cancel:')
      && error.operator === 'strictEqual' && error.actual === 1 && error.expected === 0);
});
