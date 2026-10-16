import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { adminTarget } from '../configRules';
import { STATUS_LABEL, STATUS_OPTIONS, STATUS_SUBTITLE } from '../status';

const source = readFileSync(new URL('./MobileProfile.tsx', import.meta.url), 'utf8');
async function check(superAdmin: boolean, activation?: 'click' | 'Enter' | ' ', raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const settings: boolean[] = [];
  const user = { id: 'my-user-id', displayName: 'Гусь', username: 'goose', status: 'online', superAdmin };
  const menus: any[] = [];
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    '../config': { instances: () => [], activeInstanceId: () => null }, '../configRules': { adminTarget },
    '../status': { STATUS_LABEL, STATUS_OPTIONS, STATUS_SUBTITLE },
    '../avatarAnimation': { useAnimatedAvatarsEnabled: () => false },
    '../store': { useStore: (select: (s: any) => unknown) => select({ user, setSettingsOpen: (v: boolean) => settings.push(v) }) },
    './Avatar': { Avatar: () => React.createElement('i', { 'data-avatar': true }) },
    './StatusDot': { StatusDot: () => React.createElement('i') },
    './Icon': { Icon: ({ name }: { name: string }) => React.createElement('i', { 'data-icon': name }) },
    '../api': { api: {} }, '../instanceSwitch': {}, '../toast': {}, './BottomSheet': {},
    './UserContextMenu': { UserContextMenu: (props: any) => {
      menus.push(props);
      return React.createElement('button', { 'data-self-menu': true, onClick: props.onClose }, 'Закрыть профиль');
    } },
  };
  try {
    const module = { exports: {} as { MobileProfile: React.ComponentType } };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => {
      assert.ok(Object.hasOwn(deps, id), `Неописанный импорт ${id}`); return deps[id];
    } });
    await React.act(async () => root.render(React.createElement(module.exports.MobileProfile)));
    assert.equal(host.querySelectorAll('.prof-group').length, 3);
    assert.equal(!!host.querySelector('.prof-banner, .prof-card'), false);
    assert.equal(!!host.querySelector('.prof-row [data-icon^="chevron"]'), false);
    assert.equal(host.querySelector('.prof-name')?.textContent, 'Гусь');
    assert.equal(host.querySelector('.prof-handle')?.textContent, '@goose');
    assert.equal(host.textContent?.includes('Админ-панель'), superAdmin);
    const exit = [...host.querySelectorAll<HTMLButtonElement>('.prof-row')].find(el => el.textContent === 'Выйти');
    assert.equal(exit?.classList.contains('danger'), true);
    const button = [...host.querySelectorAll<HTMLButtonElement>('.prof-row')].find(el => el.textContent === 'Настройки');
    assert.ok(!!button); await React.act(async () => button!.click()); assert.deepEqual(settings, [true]);
    if (activation !== undefined) {
      assert.equal(menus.length, 0, 'R230 меню собственного профиля не открыто заранее');
      const head = host.querySelector<HTMLElement>('.prof-head')!;
      assert.equal(head.getAttribute('role'), 'button'); assert.equal(head.tabIndex, 0);
      await React.act(async () => head.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
      assert.equal(menus.length, 0, 'R230 посторонняя клавиша не открывает профиль');
      await React.act(async () => {
        if (activation === 'click') head.click();
        else {
          const event = new KeyboardEvent('keydown', { key: activation, bubbles: true, cancelable: true });
          head.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
        }
      });
      assert.equal(host.querySelectorAll('[data-self-menu]').length, 1, 'R230 нажатие шапки открывает собственный профиль');
      assert.equal(menus.at(-1).initialView, 'profile');
      assert.equal(menus.at(-1).target.userId, user.id);
      await React.act(async () => host.querySelector<HTMLButtonElement>('[data-self-menu]')!.click());
      assert.equal(host.querySelector('[data-self-menu]'), null);
    }
  } finally {
    await React.act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister();
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}
it('R169 обычный профиль имеет три плоские группы без карточки и шевронов, опасный выход и рабочие настройки', () => {
  // Обычный пользователь не должен получить административный вход после визуальной переделки.
  return check(false);
});
it('R169 супер-админ сохраняет вход в админ-панель среди тех же трёх плоских групп', () => {
  // На телефоне это единственный административный вход — нельзя скрыть его у всех.
  return check(true);
});
for (const [action, label] of [['click', 'клик'], ['Enter', 'Enter'], [' ', 'пробел']] as const)
  it(`R230 ${label} по шапке открывает свой профиль с правильным userId и начальным экраном`, () => {
    // Для role=button нужны обе клавиатурные активации; исходное меню не должно монтироваться до жеста.
    return check(false, action);
  });
it('R230 потеря клика шапки обнаруживается отсутствием меню собственного профиля', async () => {
  // Контрфакт проходит тот же whole-module загрузчик и те же DOM-действия, что оригинал.
  await check(false, 'click');
  const anchor = 'onClick={() => setSelfProfile(true)}';
  assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(check(false, 'click', source.replace(anchor, '')), (e: unknown) => e instanceof assert.AssertionError &&
    e.message.startsWith('R230 нажатие шапки открывает собственный профиль') &&
    e.operator === 'strictEqual' && e.actual === 0 && e.expected === 1);
});
