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
import * as shared from '@gusvoice/shared';
import * as rules from '../lastSeenExceptionsRules';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const raw = read('./MessagePrivacySetting.tsx');
const unused = () => assert.fail('граница вне настройки сообщений и видимости исключений');
function load<T>(source: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, { module, exports: module.exports,
    window, document, HTMLElement, Element, Node, Event, KeyboardEvent, localStorage,
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `объявленный импорт целой настройки: ${id}`); return deps[id]; } });
  return module.exports as T;
}
type Options = { feature?: boolean; user?: boolean; value?: shared.MessagePrivacy; updateFailure?: boolean; exceptionsFailure?: boolean };
type Scene = { host: HTMLElement; updates: unknown[]; errors: Error[]; loads(): number; click(text: string): Promise<void> };
async function fixture(options: Options, work: (f: Scene) => Promise<void>, source = raw) {
  GlobalRegistrator.register({ url: 'http://localhost/', width: 1200 });
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let loads = 0;
  const updates: unknown[] = [], errors: Error[] = [], subs = new Set<() => void>();
  const user = options.user === false ? null : { id: 'me', displayName: 'Имя1', ...(options.value ? { messagePrivacy: options.value } : {}) };
  let state = { user, serverFeatures: options.feature === false ? [] : [shared.FEATURE_MSGPRIV1],
    setAuth: (next: typeof user) => { state = { ...state, user: next }; for (const notify of subs) notify(); } };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => React.useSyncExternalStore(
    notify => { subs.add(notify); return () => subs.delete(notify); }, () => select(state)), { getState: () => state });
  const common = { react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': jsx };
  const platform = { isMobile: () => false, isAndroid: () => false, isTauri: () => false };
  const phone = load<typeof import('../phoneLayout')>(read('../phoneLayout.ts'), { ...common, './hotkeys': platform });
  const back = load<typeof import('../androidBack')>(read('../androidBack.ts'), { './hotkeys': platform, './store': { useStore } });
  const chrome = load<typeof import('../dialogChrome')>(read('../dialogChrome.ts'), { ...common, './androidBack': back });
  const icon = load<typeof import('./Icon')>(read('./Icon.tsx'), common);
  const bottom = load<typeof import('./BottomSheet')>(read('./BottomSheet.tsx'), { ...common, './Icon': icon });
  const api = {
    updateProfile: async (patch: { messagePrivacy: shared.MessagePrivacy }) => {
      updates.push(patch); if (options.updateFailure) throw new Error('update-failed'); return { ...state.user!, ...patch };
    },
    messageExceptions: async () => {
      loads++; if (options.exceptionsFailure) throw new Error('exceptions-failed');
      return { always: [{ id: 'contact-a', displayName: 'Имя2' }, { id: 'contact-b', displayName: 'Имя3' }], never: [] };
    },
    setMessageExceptions: unused,
  };
  const toast = { toastError: (error: Error) => errors.push(error) };
  const exceptions = load<typeof import('./LastSeenExceptions')>(read('./LastSeenExceptions.tsx'), { ...common, '../api': { api },
    '../dmOnline': { resetExactCache: unused }, '../dialogChrome': chrome, '../lastSeenExceptionsRules': rules,
    '../phoneLayout': phone, '../store': { useStore }, '../toast': toast, './BottomSheet': bottom,
    './GroupDialogs': { PeoplePicker: unused } });
  try {
    const component = load<typeof import('./MessagePrivacySetting')>(source, { ...common, '@gusvoice/shared': shared,
      '../api': { api }, '../lastSeenExceptionsRules': rules, '../store': { useStore }, '../toast': toast, './LastSeenExceptions': exceptions });
    await React.act(async () => { root.render(React.createElement(component.MessagePrivacySetting)); });
    await work({ host, updates, errors, loads: () => loads,
      async click(text) {
        const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text);
        assert.ok(button, `настоящая настройка имеет кнопку ${text}`);
        await React.act(async () => { button.click(); });
      } });
  } finally {
    await React.act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister();
    if (prior) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', prior); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}
async function featureOff(source = raw) {
  await fixture({ feature: false }, async f => {
    assert.equal(f.host.querySelectorAll('.seg button').length, 0, 'R212-setting-feature: без msgpriv1 настройка скрыта');
    assert.equal(f.loads(), 0); assert.equal(f.updates.length, 0);
  }, source);
}
async function everyone(source = raw, value: shared.MessagePrivacy = 'everyone', missing = false) {
  await fixture({ value: missing ? undefined : value }, async f => {
    assert.equal(f.host.querySelectorAll('.seg button').length, 2);
    assert.equal(f.host.querySelector('[aria-pressed="true"]')?.textContent, 'Все');
    assert.equal(f.host.querySelectorAll('#set-g-messages-exceptions').length, 0, 'R212-setting-exceptions: исключения не нужны при Все');
    assert.equal(f.loads(), 0, 'скрытые исключения не запрашиваются');
  }, source);
}
async function change(source = raw) {
  await fixture({ value: 'everyone' }, async f => {
    await f.click('Мои контакты');
    assert.equal(JSON.stringify(f.updates), '[{"messagePrivacy":"contacts"}]', 'R212-setting-update: переключатель передаёт именно contacts');
    assert.equal(f.host.querySelector('[aria-pressed="true"]')?.textContent, 'Мои контакты');
    assert.equal(f.loads(), 1); assert.equal(f.host.querySelector('.settings-action')?.textContent, '2 человека');
    await f.click('Все');
    assert.equal(JSON.stringify(f.updates), '[{"messagePrivacy":"contacts"},{"messagePrivacy":"everyone"}]');
    assert.equal(f.host.querySelector('#set-g-messages-exceptions'), null); assert.equal(f.loads(), 1);
  }, source);
}
it('R212 настройка без msgpriv1 скрыта и не обращается к API', () => featureOff());
it('R212 настройка с msgpriv1, но без пользователя скрыта', async () => {
  await fixture({ user: false }, async f => { assert.equal(f.host.childElementCount, 0); assert.equal(f.loads(), 0); });
});
it('R212 msgpriv1 показывает оба выбора, Все не показывает исключения', () => everyone());
it('R212 отсутствующая сохранённая настройка безопасно означает Все без исключений', () => everyone(raw, 'everyone', true));
it('R212 Мои контакты показывает только Всегда разрешать и настоящее число исключений', async () => {
  await fixture({ value: 'contacts' }, async f => {
    assert.equal(f.host.querySelector('[aria-pressed="true"]')?.textContent, 'Мои контакты');
    assert.equal(f.host.querySelectorAll('#set-g-messages-exceptions').length, 1);
    assert.equal(f.host.querySelector('.settings-action')?.textContent, '2 человека'); assert.equal(f.loads(), 1);
    assert.equal(f.host.textContent?.includes('Никогда разрешать'), false);
  });
});
it('R212 переключение на контакты сохраняет правило и открывает исключения, возврат на Все скрывает их', () => change());
it('R212 нажатие уже выбранного значения не сохраняет заново и не запрашивает скрытые списки', async () => {
  await fixture({ value: 'everyone' }, async f => { await f.click('Все'); assert.equal(f.updates.length, 0); assert.equal(f.loads(), 0); });
  await fixture({ value: 'contacts' }, async f => { await f.click('Мои контакты'); assert.equal(f.updates.length, 0); assert.equal(f.loads(), 1); });
});
it('R212 ошибка сохранения не меняет выбранное правило и передаётся в toastError', async () => {
  await fixture({ value: 'everyone', updateFailure: true }, async f => {
    await f.click('Мои контакты'); assert.equal(f.errors[0]?.message, 'update-failed');
    assert.equal(f.host.querySelector('[aria-pressed="true"]')?.textContent, 'Все'); assert.equal(f.loads(), 0);
  });
});
it('R212 ошибка чтения исключений сохраняет блок с Добавить, не скрывает разрешённый выбор', async () => {
  await fixture({ value: 'contacts', exceptionsFailure: true }, async f => {
    assert.equal(f.host.querySelector('.settings-action')?.textContent, 'Добавить');
    assert.equal(f.host.querySelector('[aria-pressed="true"]')?.textContent, 'Мои контакты'); assert.equal(f.errors.length, 0);
  });
});
for (const [label, from, to, scenario, prefix, actual, expected] of [
  ['признак msgpriv1 принудительно включён', 'const on = useStore((s) => !!s.serverFeatures?.includes(FEATURE_MSGPRIV1));', 'const on = true;', featureOff,
    'R212-setting-feature:', 2, 0],
  ['исключения открылись при Все', "{value === 'contacts' && <MessageExceptionsBlock />}", "{value === 'everyone' && <MessageExceptionsBlock />}", everyone,
    'R212-setting-exceptions:', 1, 0],
  ['Мои контакты отправляет Все', 'api.updateProfile({ messagePrivacy: o.value })', "api.updateProfile({ messagePrivacy: 'everyone' })", change,
    'R212-setting-update:', '[{"messagePrivacy":"everyone"}]', '[{"messagePrivacy":"contacts"}]'],
] as const) it(`R212 контрфакт настройки: ${label}`, async () => {
  await scenario(raw); assert.equal(raw.split(from).length - 1, 1, 'однозначный якорь целой настройки');
  await assert.rejects(scenario(raw.replace(from, to)), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith(prefix) && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected);
});
