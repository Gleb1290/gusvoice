import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';

const menu = readFileSync(new URL('./ContextMenu.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const chat = readFileSync(new URL('./DmChatView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const row = readFileSync(new URL('./DmRowMenu.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function evaluate(raw: string, context: Record<string, unknown>) {
  const module = { exports: {} as { MenuItem: React.FC<Record<string, unknown>>; item: React.ReactElement } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, require: () => jsx, ...context,
  });
  return module.exports;
}
function itemSource(raw: string, caller: 'header' | 'mute' | 'row') {
  const ast = ts.createSourceFile('caller.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: ts.JsxSelfClosingElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'MenuItem' && node.attributes.getText(ast).includes('muteLeftLabel(')) matches.push(node);
    ts.forEachChild(node, visit);
  }; visit(ast);
  const selected = caller === 'header' ? matches.find(n => n.getText(ast).includes('muteNow')) : matches.find(n => !n.getText(ast).includes('muteNow'));
  assert.ok(selected, `настоящий JSX пункта ${caller} найден`);
  return `export const item = (${selected.getText(ast)});`;
}

it('остаток мьюта в трёх настоящих пунктах помечен ctx-note, клавиша остаётся обычной подсказкой', async () => {
  GlobalRegistrator.register(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  try {
    const check = async (header: string, menuRaw = menu) => {
      const ast = ts.createSourceFile('ContextMenu.tsx', menuRaw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'MenuItem'); assert.ok(declaration);
      const MenuItem = evaluate(declaration.getText(ast), { Icon: () => null }).MenuItem;
      const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
      try {
        for (const [caller, raw] of [['header', header], ['mute', chat], ['row', row]] as const) {
          // Исполняем именно JSX реального call-site; тяжёлый родитель со стором/сокетами здесь не запускается.
          const { item } = evaluate(itemSource(raw, caller), { MenuItem, pushMuted: true, prefsOn: true, mute: {}, muteNow: 0, now: 0, muteLeftLabel: () => '3 ч', set: () => {}, act: () => () => {} });
          await React.act(async () => root.render(item));
          assert.equal(host.querySelector('.ctx-shortcut.ctx-note')?.textContent, '3 ч', `${caller}: остаток мьюта виден как справка`);
        }
        await React.act(async () => root.render(React.createElement(MenuItem, { label: 'Ответить', shortcut: 'R' })));
        assert.equal(host.querySelector('.ctx-shortcut')?.textContent, 'R'); assert.equal(host.querySelector('.ctx-note') === null, true);
      } finally { await React.act(async () => root.unmount()); host.remove(); }
    };
    await check(chat);
    const headerItem = itemSource(chat, 'header'); assert.ok(headerItem.includes('\n                note\n'));
    const changed = chat.replace('                note\n', ''); assert.notEqual(changed, chat);
    await assert.rejects(check(changed), /header: остаток мьюта виден как справка/);
    const noClass = menu.replace("note ? 'ctx-shortcut ctx-note' : 'ctx-shortcut'", "'ctx-shortcut'"); assert.notEqual(noClass, menu);
    await assert.rejects(check(chat, noClass), /header: остаток мьюта виден как справка/);
  } finally { GlobalRegistrator.unregister(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; }
});

it('в телефонном листе справка о сроке видна, а обычная клавиатурная подсказка скрыта', () => {
  GlobalRegistrator.register();
  try {
    const check = (raw: string) => {
      const style = document.createElement('style');
      // Берём реальные правила целиком, без воспроизведения свойств вручную.
      style.textContent = [...raw.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].trim().startsWith('.ctx-shortcut') || m[1].trim().startsWith('.ctx-menu.sheet .ctx-shortcut')).map(m => m[0]).join('\n');
      document.head.append(style);
      const sheet = document.createElement('div'); sheet.className = 'ctx-menu sheet'; sheet.innerHTML = '<span class="ctx-shortcut ctx-note">3 ч</span><span class="ctx-shortcut">R</span>'; document.body.append(sheet);
      try {
        assert.equal(getComputedStyle(sheet.children[0]).display, 'inline', 'справка в листе видна');
        assert.equal(getComputedStyle(sheet.children[1]).display, 'none', 'клавиша в листе скрыта');
      } finally { style.remove(); sheet.remove(); }
    };
    check(css);
    const noNote = css.replace(/\.ctx-menu\.sheet \.ctx-shortcut\.ctx-note\s*\{[^}]*\}/, ''); assert.notEqual(noNote, css);
    assert.throws(() => check(noNote), /справка в листе видна/);
    const noHide = css.replace(/\.ctx-menu\.sheet \.ctx-shortcut\s*\{[^}]*\}/, ''); assert.notEqual(noHide, css);
    assert.throws(() => check(noHide), /клавиша в листе скрыта/);
  } finally { GlobalRegistrator.unregister(); }
});
