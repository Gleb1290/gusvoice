import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import ts from 'typescript';

const full = readFileSync(new URL('./CallLayer.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const parsed = ts.createSourceFile('CallLayer.tsx', full, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const source = parsed.statements.filter(n => (ts.isFunctionDeclaration(n) && n.name?.text === 'CallBar') || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(parsed) === 'CALLBAR_ROOT_CLASS'))).map(n => n.getText(parsed)).join('\n');

it('верхняя полоса резервирует место только для свёрнутого звонка и очищает html при смене состояния и размонтировании', async () => {
  GlobalRegistrator.register(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  try {
    const check = async (raw: string) => {
      document.documentElement.className = '';
      const useCall = create<{ call: object | null; peer: { name: string } | null; expanded: boolean; muted: boolean; connected: boolean; setExpanded(v: boolean): void }>(set => ({ call: {}, peer: { name: 'Друг' }, expanded: false, muted: false, connected: false, setExpanded: expanded => set({ expanded }) }));
      const module = { exports: {} as { CallBar: React.FC<{ top?: boolean }>; CALLBAR_ROOT_CLASS: string } };
      runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
        module, exports: module.exports, require: () => jsx, document,
        useEffect: React.useEffect, useCall, useCallView: () => useCall(s => s.call ? 'outgoing' : 'none'), useElapsed: () => 0,
        callStatusText: () => 'Вызов', Icon: () => null,
      });
      const { CallBar, CALLBAR_ROOT_CLASS } = module.exports;
      const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
      try {
        await React.act(async () => root.render(React.createElement(CallBar, { top: true })));
        assert.ok(host.querySelector('.call-bar.call-bar-top')); assert.ok(document.documentElement.classList.contains(CALLBAR_ROOT_CLASS));
        await React.act(async () => useCall.getState().setExpanded(true));
        assert.equal(host.querySelector('.call-bar') === null, true); assert.equal(document.documentElement.classList.contains(CALLBAR_ROOT_CLASS), false, 'разворот снимает резерв места');
        await React.act(async () => useCall.getState().setExpanded(false));
        assert.ok(document.documentElement.classList.contains(CALLBAR_ROOT_CLASS));
        await React.act(async () => useCall.setState({ call: null, peer: null }));
        assert.equal(document.documentElement.classList.contains(CALLBAR_ROOT_CLASS), false, 'конец звонка снимает резерв места');
        await React.act(async () => useCall.setState({ call: {}, peer: { name: 'Друг' } }));
        await React.act(async () => root.render(React.createElement(CallBar, { top: false })));
        assert.ok(host.querySelector('.call-bar')); assert.equal(host.querySelector('.call-bar-top') === null, true);
        assert.equal(document.documentElement.classList.contains(CALLBAR_ROOT_CLASS), false, 'ПК не ставит класс');
        await React.act(async () => root.render(React.createElement(CallBar, { top: true })));
        await React.act(async () => root.unmount());
        assert.equal(document.documentElement.classList.contains(CALLBAR_ROOT_CLASS), false, 'размонтирование снимает резерв места');
      } finally { await React.act(async () => root.unmount()); host.remove(); document.documentElement.className = ''; }
    };
    assert.ok(source.includes('export function CallBar'));
    await check(source);
    const changed = source.replace('return () => root.classList.remove(CALLBAR_ROOT_CLASS);', ''); assert.notEqual(changed, source);
    await assert.rejects(check(changed), /разворот снимает резерв места/);
  } finally { GlobalRegistrator.unregister(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; }
});
