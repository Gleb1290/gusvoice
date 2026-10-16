import assert from 'node:assert/strict';
import { before, after, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { act } from 'react';
import * as jsx from 'react/jsx-runtime';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as rules from '../strangerBarRules';

const raw = readFileSync(new URL('./StrangerBar.tsx', import.meta.url), 'utf8');
let createRoot: typeof import('react-dom/client')['createRoot'];
before(async () => { GlobalRegistrator.register(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); createRoot = (await import('react-dom/client')).createRoot; });
after(() => GlobalRegistrator.unregister());
async function scene(holder: string | null | undefined, report: boolean, fail = false) {
  const calls: unknown[][] = [], toasts: unknown[][] = [], errors: unknown[] = [];
  let blocks = 0, closes = 0;
  const api = { convReport: async (...args: unknown[]) => { calls.push(args); if (fail) throw new Error('fixture report failure'); } };
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, '../strangerBarRules': rules,
    '../store': { useStore: { getState: () => ({ reportStranger: (...args: unknown[]) => api.convReport(...args) }) } },
    '../toast': { toast: (...args: unknown[]) => toasts.push(args), toastError: (e: unknown) => errors.push(e) }, './Icon': { Icon: () => null },
  };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { module, exports: module.exports, window, document,
        require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `явный импорт ${id}`); return deps[id]; } });
    const components = module.exports as typeof import('./StrangerBar');
    if (!report) {
      await act(async () => root.render(React.createElement(components.StrangerBar, { peerName: 'Утка', peerHome: holder,
        onBlock: () => { blocks++; }, onHide: () => { closes++; }, onReport: () => {} })));
      const text = document.querySelector('.stranger-bar-text')?.textContent;
      assert.equal(text, holder ? `Утка с инстанса «${holder}» — вы не состоите на одном сервере` : 'Вы с Утка не состоите на одном сервере');
      assert.equal(document.querySelector('[role="region"]')?.getAttribute('aria-label'), 'Утка — незнакомый собеседник');
      return;
    }
    await act(async () => root.render(React.createElement(components.StrangerReportModal, { convId: 'conversation',
      peer: { id: 'peer', displayName: 'Утка' }, holder, blocked: false,
      onBlock: async () => { blocks++; }, onClose: () => { closes++; } })));
    const hint = document.querySelector('.reg-policy-note')?.textContent;
    assert.equal(hint?.includes('К жалобе приложатся последние сообщения'), true);
    assert.equal(hint?.includes('Остальную переписку администратор не увидит.'), true);
    assert.equal(hint?.includes('Жалоба уйдёт администратору инстанса «Северный дом», где живёт Утка.'), !!holder);
    const input = document.querySelector<HTMLTextAreaElement>('textarea'); assert.equal(!!input, true);
    // Как в существующих VM DOM-сценах: настоящий React обработчик на настоящем узле, без копирования submit/trim.
    const key = Object.keys(input!).find(k => k.startsWith('__reactProps$')); assert.equal(!!key, true);
    const props = (input as unknown as Record<string, { onChange: (e: { target: { value: string } }) => void }>)[key!];
    await act(async () => props.onChange({ target: { value: '  Проверить сообщения  ' } }));
    assert.equal(input?.value, '  Проверить сообщения  ');
    const button = document.querySelector<HTMLButtonElement>('.modal-actions .danger'); assert.equal(!!button, true);
    await act(async () => { button!.click(); await Promise.resolve(); await Promise.resolve(); });
    assert.equal(calls.length, 1); assert.equal(JSON.stringify(calls[0]), JSON.stringify(['conversation', 'spam', 'Проверить сообщения']));
    if (fail) {
      assert.equal(errors.length, 1); assert.equal(toasts.length, 0); assert.equal(blocks, 0); assert.equal(closes, 0);
      assert.equal(button?.disabled, false, 'ошибка оставляет возможность повторить'); return;
    }
    assert.equal(toasts.length, 1); assert.equal(toasts[0][0], 'success'); assert.equal(toasts[0][1], 'Жалоба отправлена');
    assert.equal(toasts[0][2], holder ? `Её увидит администратор инстанса «${holder}».` : 'Её увидит администратор инстанса.');
    assert.equal(blocks, 1); assert.equal(closes, 1); assert.equal(errors.length, 0);
  } finally { await act(async () => root.unmount()); host.remove(); }
}
for (const [holder, label] of [[undefined, 'без peerHome'], [null, 'с пустым peerHome'], ['Северный дом', 'с домом собеседника']] as const) {
  it(`R192 плашка ${label} показывает правильное происхождение человека`, async () => {
    // Класс ошибки: локальный человек объявлен удалённым или потеряно имя инстанса.
    await scene(holder, false);
  });
  it(`R192 жалоба ${label} называет адресата в подсказке и тосте после настоящего submit`, async () => {
    // Класс ошибки: человек не знает, какому держателю раскрыты сообщения.
    await scene(holder, true);
  });
}
it('R192 ошибка жалобы человеку соседа не выдаётся за успех и не блокирует до отправки', async () => {
  // Класс ошибки: отклонённая жалоба обещает доставку или преждевременно блокирует.
  await scene('Северный дом', true, true);
});
