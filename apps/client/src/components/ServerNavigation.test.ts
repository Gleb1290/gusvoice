import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const layout = read('./MainLayout.tsx'), sidebar = read('./ChannelSidebar.tsx'), settings = read('./SettingsShell.tsx');
function layoutContract(raw = layout) {
  assert.match(raw, /const serverListShown = phone && !isDm && \(serverListOpen \|\| !currentServerId\);/, 'нет текущего сервера → телефонный список');
  assert.match(raw, /\) : serverListShown \? \(\s*<PhoneServerList/, 'телефонный список подключён как sidebar');
  assert.match(raw, /if \(!isDm && !profileShown\) appClass.push\('m-srvlist'\)/, 'класс серверов вне профиля и ЛС');
}
function sidebarContract(raw = sidebar) {
  const tree = ts.createSourceFile('ChannelSidebar.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes: ts.Node[] = [];
  function visit(n: ts.Node) { nodes.push(n); ts.forEachChild(n, visit); } visit(tree);
  const mobile = nodes.find((n): n is ts.ConditionalExpression => ts.isConditionalExpression(n) && n.condition.getText(tree) === 'isMobile() || phoneLayout');
  assert.ok(mobile, 'телефонная ветка шапки'); const text = mobile.whenTrue.getText(tree);
  assert.match(text, /\{canManage && \(\s*<button className="head-icon" title="Новый канал"/, 'создание только при праве и без primary');
  assert.equal(text.includes('primary'), false, 'primary не возвращается в мобильную шапку');
  assert.match(raw, /\{phoneLayout && \(\s*<button[^>]*className="head-icon srv-back"[^>]*onClick=\{\(\) => setServerListOpen\(true\)\}/, 'стрелка телефона открывает список');
}
it('R174 MainLayout показывает список серверов телефона при пустом выборе и сохраняет разделение ЛС и профиля', () => {
  // AST/text wiring не выдаётся за визуальный прогон большого layout с живым стором.
  layoutContract();
});
it('R174 телефонная шапка каналов возвращает к серверам и показывает обычный плюс только управляющему', () => {
  // Проверяем настоящий JSX ветки телефона: другой плюс на ПК не может удовлетворить контракт.
  sidebarContract();
});
it('R174 контрфакты пустого выбора сервера и primary-плюса отвергаются адресными стражами', () => {
  // Оригиналы проверяются до мутантов; уникальные якоря не меняют соседние ветки шапки.
  layoutContract(); const fallback = 'serverListOpen || !currentServerId'; assert.equal(layout.split(fallback).length - 1, 1);
  assert.throws(() => layoutContract(layout.replace(fallback, 'serverListOpen')), e => e instanceof assert.AssertionError && e.message.includes('нет текущего'));
  sidebarContract(); const plus = 'className="head-icon" title="Новый канал" aria-label="Новый канал"'; assert.equal(sidebar.split(plus).length - 1, 1);
  assert.throws(() => sidebarContract(sidebar.replace(plus, 'className="head-icon primary" title="Новый канал" aria-label="Новый канал"')), e => e instanceof assert.AssertionError && e.message.includes('создание только'));
});
async function rail(phone: boolean, raw = settings) {
  GlobalRegistrator.register(); const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client'); const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let closed = 0;
  const deps: Record<string, unknown> = { 'react/jsx-runtime': jsx, '../phoneLayout': { usePhoneLayout: () => phone }, './Icon': { Icon: () => null } };
  const module = { exports: {} as typeof import('./SettingsShell') };
  try {
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `неописанная граница ${id}`); return deps[id]; } });
    await React.act(async () => root.render(React.createElement(module.exports.SettingsRail, { title: 'Настройки', label: 'Разделы', onClose: () => { closed++; }, children: null })));
    const head = host.querySelector('.set-rail-title')!;
    assert.equal(head.querySelectorAll('button').length, 1, 'в шапке одна кнопка закрытия');
    assert.equal(head.querySelector('.icon-back') !== null, phone, 'стрелка только на телефоне');
    if (phone) assert.equal(head.firstElementChild?.classList.contains('icon-back'), true, 'стрелка первый ребёнок шапки');
    await React.act(async () => head.querySelector<HTMLButtonElement>('button')!.click()); assert.equal(closed, 1);
  } finally {
    try { await React.act(async () => root.unmount()); } finally {
      host.remove(); GlobalRegistrator.unregister();
      if (descriptor) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', descriptor); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  }
}
it('R174 SettingsRail телефона ставит стрелку первой без правого крестика, ПК сохраняет крестик', async () => {
  // Настоящий React DOM целого SettingsShell: onClose один и тот же, но место и вид отличаются.
  await rail(true); await rail(false);
});
it('R174 контрфакт правого крестика телефона отвергается по числу кнопок', async () => {
  // Якорь ограничен SettingsRail перед его кнопкой, не другим крестиком в SettingsShell.
  await rail(true); const anchor = '{!phone && (\n          <button type="button" className="icon-close"'; assert.equal(settings.split(anchor).length - 1, 1);
  await assert.rejects(rail(true, settings.replace(anchor, '{true && (\n          <button type="button" className="icon-close"')), e => e instanceof assert.AssertionError && e.message.includes('одна кнопка'));
});
