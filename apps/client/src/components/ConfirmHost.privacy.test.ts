import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as rules from '../confirmRules';
import * as deleteChoice from '../deleteChoiceRules';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const hostSource = read('./ConfirmHost.tsx'), confirmSource = read('../confirm.ts');
type ConfirmApi = typeof import('../confirm');
function load<T>(raw: string, deps: Record<string, unknown>, unexpected: string[]): T {
  const module = { exports: {} as T };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, window, document, setTimeout, clearTimeout,
      require(id: string) {
        if (!Object.hasOwn(deps, id)) { unexpected.push(`require:${id}`); assert.fail(`Неописанный импорт ${id}`); }
        return deps[id];
      } });
  return module.exports;
}
async function withDialog(check: (api: ConfirmApi, host: HTMLDivElement) => Promise<void>, rawHost = hostSource, rawConfirm = confirmSource) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const unexpected: string[] = [], host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let api: ConfirmApi | undefined;
  try {
    api = load<ConfirmApi>(rawConfirm, { zustand: { create } }, unexpected);
    const component = load<typeof import('./ConfirmHost')>(rawHost, {
      react: React, 'react/jsx-runtime': jsx, '../confirm': api, '../confirmRules': rules, '../deleteChoiceRules': deleteChoice,
      // Проверяем разметку окна и контракт значка, не геометрию SVG или раскладку happy-dom.
      '../focusTrap': { useFocusTrap() {} },
      './Icon': { Icon: ({ name }: { name: string }) => React.createElement('i', { 'data-icon': name }) },
    }, unexpected);
    await React.act(async () => { root.render(React.createElement(component.ConfirmHost)); });
    await check(api, host);
  } finally {
    try { await React.act(async () => { api?.useConfirmDialog.getState().answer(false); root.unmount(); }); }
    finally {
      host.remove(); await GlobalRegistrator.unregister();
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      assert.deepEqual(unexpected, [], 'R238 границы ConfirmHost не проглочены обработчиком ошибки');
    }
  }
}
async function checkKeys(raw = hostSource) {
  await withDialog(async (api, host) => {
    for (const tone of ['info', undefined, 'danger'] as const) {
      let result!: Promise<boolean>;
      await React.act(async () => {
        result = tone === 'info' ? api.alertDialog('Справка', 'Текст') : api.confirmAction({ title: 'Решение', tone });
      });
      assert.equal(host.querySelectorAll('[role="alertdialog"]').length, 1);
      assert.equal(host.querySelectorAll('.confirm-keys').length, tone === 'info' ? 0 : 1,
        `R238 keys-${tone ?? 'default'}: подсказка только у окна с выбором`);
      assert.equal(host.querySelectorAll('.confirm-actions button').length, tone === 'info' ? 1 : 2);
      if (tone !== 'info') {
        const hints = [...host.querySelectorAll('.confirm-keys > span')];
        assert.equal(hints[0]?.textContent, 'Esc отмена');
        assert.equal(hints[1]?.textContent, tone === 'danger' ? 'Enter здесь не подтверждает' : 'Enter подтвердить');
        assert.equal(hints[1]?.classList.contains('off'), tone === 'danger');
      }
      await React.act(async () => { api.useConfirmDialog.getState().answer(true); });
      assert.equal(await result, true);
      assert.equal(host.querySelector('[role="alertdialog"]'), null);
    }
  }, raw);
}
it('R238 alertDialog без подсказки клавиш, обычное и опасное подтверждения сохраняют Esc и верный смысл Enter', () => checkKeys());
it('R238 удаление или инверсия hasCancel у подсказки ловятся по появлению ложных клавиш в справке', async () => {
  const anchor = '{hasCancel(pending) && (\n          <div className="confirm-keys">';
  assert.equal(hostSource.split(anchor).length - 1, 1);
  for (const condition of ['true', '!hasCancel(pending)']) {
    await checkKeys();
    await assert.rejects(() => checkKeys(hostSource.replace(anchor, anchor.replace('hasCancel(pending)', condition))),
      e => e instanceof assert.AssertionError && e.message.startsWith('R238 keys-info:') &&
        e.operator === 'strictEqual' && e.actual === 1 && e.expected === 0);
  }
});
async function checkIcon(raw = confirmSource) {
  await withDialog(async (api, host) => {
    for (const icon of ['ban', undefined] as const) {
      let result!: Promise<boolean>;
      await React.act(async () => {
        result = icon ? api.alertDialog('Позвонить нельзя', 'Алиса не принимает звонки.', { icon }) : api.alertDialog('Информация');
      });
      assert.equal(api.useConfirmDialog.getState().pending?.tone, 'info');
      assert.equal(host.querySelector('.confirm-ic [data-icon]')?.getAttribute('data-icon'), icon ?? 'signal',
        'R238 alert-icon: свой запрет и прежний сигнал доходят до отрисованного окна');
      assert.equal(host.querySelector('.confirm-primary')?.textContent, 'Понятно');
      await React.act(async () => { (host.querySelector('.confirm-primary') as HTMLButtonElement).click(); });
      assert.equal(await result, true);
    }
  }, hostSource, raw);
}
it('R238 alertDialog передаёт ban, а без опций оставляет прежний signal и кнопку Понятно', () => checkIcon());
it('R238 проигнорированные opts alertDialog обнаруживаются по значку реально отрисованного окна', async () => {
  await checkIcon();
  const anchor = ", ...(opts?.icon ? { icon: opts.icon } : {})";
  assert.equal(confirmSource.split(anchor).length - 1, 1);
  await assert.rejects(() => checkIcon(confirmSource.replace(anchor, '')), e => e instanceof assert.AssertionError &&
    e.message.startsWith('R238 alert-icon:') && e.operator === 'strictEqual' && e.actual === 'signal' && e.expected === 'ban');
});
