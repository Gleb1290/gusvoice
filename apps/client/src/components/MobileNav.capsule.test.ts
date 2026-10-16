import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { DmChannel } from '@gusvoice/shared';
import * as archive from '../dmArchiveRules';
import { Icon } from './Icon';

const source = readFileSync(new URL('./MobileNav.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type State = { view: string; settingsOpen: boolean; mobileProfileOpen: boolean; unreadDms: string[]; dms: DmChannel[];
  setView(view: string): void; setMobilePane(pane: string): void; setMobileProfileOpen(open: boolean): void; openServersTab(wasActive: boolean): void; loadDms(): Promise<void> };
async function fixture(check: (host: HTMLElement, calls: string[]) => Promise<void> | void, raw = source,
  initial: Partial<Pick<State, 'view' | 'settingsOpen' | 'mobileProfileOpen' | 'unreadDms' | 'dms'>> = {}) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const calls: string[] = [];
  const state: State = { view: 'dm', settingsOpen: false, mobileProfileOpen: false,
    unreadDms: ['a', 'b', 'archived'], dms: ['a', 'b', 'archived'].map(id => ({ id, archived: id === 'archived' } as DmChannel)),
    setView: view => calls.push(`view:${view}`), setMobilePane: pane => calls.push(`pane:${pane}`),
    setMobileProfileOpen: open => calls.push(`profile:${open}`), openServersTab: wasActive => calls.push(`servers:${wasActive}`),
    loadDms: async () => { calls.push('load'); }, ...initial };
  const module = { exports: {} as { MobileNav: React.FC } };
  const deps: Record<string, unknown> = { 'react/jsx-runtime': jsx, '../store': { useStore: (select: (s: State) => unknown) => select(state) },
    '../dmArchiveRules': archive, './Icon': { Icon } };
  try {
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { module, exports: module.exports, require: (id: string) => {
        if (!Object.hasOwn(deps, id)) throw Error(`Неописанный импорт ${id}`); return deps[id];
      } });
    await React.act(async () => root.render(React.createElement(module.exports.MobileNav)));
    await check(host, calls);
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally { host.remove(); try { await GlobalRegistrator.unregister(); }
      finally { if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); } }
  }
}
async function capsule(raw = source) {
  await fixture(host => {
    assert.equal(host.querySelectorAll('nav.mobile-nav').length, 1);
    assert.equal(host.querySelector('nav')?.getAttribute('aria-label'), 'Разделы');
    assert.equal(host.querySelectorAll('nav.mobile-nav > .mnav-capsule').length, 1);
    assert.equal(host.querySelector('nav.mobile-nav')?.children.length, 1);
    const tabs = host.querySelectorAll<HTMLButtonElement>('nav.mobile-nav > .mnav-capsule > button.mnav-tab');
    assert.equal(tabs.length, 3);
    assert.equal(Array.from(tabs).map(tab => tab.querySelector('.mnav-label')?.textContent).join(','), 'Серверы,Сообщения,Профиль');
    for (const tab of tabs) {
      assert.equal(tab.type, 'button'); const icon = tab.querySelector('.mnav-ico > svg');
      assert.equal(icon?.getAttribute('width'), '24'); assert.equal(icon?.getAttribute('height'), '24');
    }
    assert.equal(host.querySelectorAll('.mnav-badge').length, 1);
    assert.equal(tabs[1].querySelector('.mnav-badge')?.textContent, '2');
    assert.equal(tabs[0].querySelector('.mnav-badge'), null); assert.equal(tabs[2].querySelector('.mnav-badge'), null);
  }, raw);
}
// Класс ошибки: капсула отсутствует, вкладки выпали из неё, значок или badge стали прежними.
it('R170 навигация содержит одну капсулу с тремя кнопками, реальные значки 24 и числовой badge', () => capsule());
// Класс ошибки: нулевой счётчик оставляет точку или пустую пилюлю.
it('R170 ноль непрочитанных и только архивные не рисуют badge в капсуле', async () => {
  for (const unreadDms of [[], ['archived']]) await fixture(host => {
    assert.equal(host.querySelectorAll('.mnav-capsule > .mnav-tab').length, 3); assert.equal(host.querySelector('.mnav-badge'), null);
  }, source, { unreadDms });
});
// Класс ошибки: обёртка капсулы перехватила клики или сломала переход к списку.
it('R170 вкладки внутри капсулы сохраняют переходы и загрузку сообщений', async () => {
  // R174: серверный переход делегирован стору; активность учитывает также профиль и настройки поверх вкладки.
  for (const [initial, wasActive] of [
    [{ view: 'dm' }, false], [{ view: 'server' }, true],
    [{ view: 'server', settingsOpen: true }, false], [{ view: 'server', mobileProfileOpen: true }, false],
  ] as const) await fixture(async (host, calls) => {
    const tabs = host.querySelectorAll<HTMLButtonElement>('.mnav-capsule > .mnav-tab');
    await React.act(async () => tabs[0].click()); assert.equal(calls.join(','), `servers:${wasActive}`); calls.length = 0;
    await React.act(async () => tabs[1].click()); assert.equal(calls.join(','), 'view:dm,load,profile:false,pane:list'); calls.length = 0;
    await React.act(async () => tabs[2].click()); assert.equal(calls.join(','), 'profile:true');
  }, source, initial);
});
// Класс ошибки: вкладка сообщений остаётся активной поверх настроек или профиля.
it('R170 активная вкладка соответствует серверу сообщениям и профилю, настройки снимают активность', async () => {
  for (const [initial, expected] of [
    [{ view: 'server' }, 'Серверы'], [{ view: 'dm' }, 'Сообщения'], [{ mobileProfileOpen: true }, 'Профиль'], [{ settingsOpen: true }, ''],
  ] as const) await fixture(host => {
    const active = host.querySelectorAll('.mnav-tab.active'); assert.equal(active.length, expected ? 1 : 0);
    assert.equal(active[0]?.querySelector('.mnav-label')?.textContent ?? '', expected);
    if (expected) assert.equal(active[0].getAttribute('aria-current'), 'page');
  }, source, initial);
});
function mutate(anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'якорь мутации уникален'); return source.replace(anchor, replacement);
}
// Класс ошибки: капсула потеряна в разметке.
it('R170 мутант без класса капсулы обнаруживается настоящим DOM', async () => {
  await capsule(); await assert.rejects(() => capsule(mutate('className="mnav-capsule"', 'className="mnav-old"')), assert.AssertionError);
});
// Класс ошибки: старый размер значка или точка вместо числа.
it('R170 мутанты значка 20 и точки вместо badge обнаруживаются после успешного оригинала', async () => {
  await capsule();
  await assert.rejects(() => capsule(mutate('<Icon name={icon} size={24} />', '<Icon name={icon} size={20} />')), assert.AssertionError);
  await assert.rejects(() => capsule(mutate('{badge}</span>', '{""}</span>')), assert.AssertionError);
});
