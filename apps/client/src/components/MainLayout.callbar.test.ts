import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';

const source = readFileSync(new URL('./MainLayout.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
it('на телефоне единственная полоса принадлежит app, а на ПК content в ЛС и сервере', async () => {
  GlobalRegistrator.register(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  try {
    const check = async (raw: string) => {
      for (const phone of [true, false]) for (const view of ['dm', 'server']) {
        const module = { exports: {} as { MainLayout: React.FC } };
        const state = { view, dms: [], convActive: false, conv: { pts: null }, mobilePane: 'list', economy: {}, unreadDms: {} };
        const stubs: Record<string, unknown> = { useStore: (selector: (s: typeof state) => unknown) => selector(state), usePhoneLayout: () => phone, isMobile: () => false, useSwipeBack: () => {}, useCheatSheetOpen: () => false, useSelectionOpen: () => false, useSchedViewOpen: () => false,
          CallBar: ({ top }: { top?: boolean }) => React.createElement('div', { className: `call-bar${top ? ' call-bar-top' : ''}` }) };
        const ast = ts.createSourceFile('MainLayout.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        for (const node of ast.statements) if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const entry of node.importClause.namedBindings.elements) if (!(entry.name.text in stubs)) stubs[entry.name.text] = () => null;
        }
        runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
          module, exports: module.exports, document, window,
          require: (id: string) => id === 'react' ? React : id === 'react/jsx-runtime' ? jsx : stubs,
        });
        const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
        try {
          await React.act(async () => root.render(React.createElement(module.exports.MainLayout)));
          const bars = host.querySelectorAll('.call-bar'); assert.equal(bars.length, 1, 'полоса единственная');
          assert.ok(bars[0].parentElement?.classList.contains(phone ? 'app' : 'content'), 'правильный родитель полосы');
          assert.equal(bars[0].classList.contains('call-bar-top'), phone);
        } finally { await React.act(async () => root.unmount()); host.remove(); }
      }
    };
    await check(source);
    for (const occurrence of [0, 1]) {
      const needle = '!phone && <CallBar />';
      const first = source.indexOf(needle); const at = occurrence ? source.indexOf(needle, first + needle.length) : first;
      assert.ok(at >= 0, 'найдена отдельная ветка ленты');
      const changed = source.slice(0, at) + '<CallBar />' + source.slice(at + needle.length); assert.notEqual(changed, source);
      await assert.rejects(check(changed), /полоса единственная/);
    }
  } finally { GlobalRegistrator.unregister(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; }
});
