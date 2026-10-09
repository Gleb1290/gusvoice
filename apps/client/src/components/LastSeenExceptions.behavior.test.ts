import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, before, after } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement, Fragment, act, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import * as rules from '../lastSeenExceptionsRules.js';

type Block = ComponentType<{ privacy: 'everyone' | 'peers' | 'nobody' }>;
let registered = false;
before(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  registered = true;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(() => { if (registered) GlobalRegistrator.unregister(); });

function component(change?: (source: string) => string, state: { resets: number; saves: unknown[] } = { resets: 0, saves: [] }): Block {
  let source = readFileSync(new URL('./LastSeenExceptions.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (change) {
    const changed = change(source);
    assert.notEqual(changed, source, 'мутант удалил реальный вызов сброса кэша');
    source = changed;
  }
  const module = { exports: {} as Record<string, unknown> };
  const api = {
    lastSeenExceptions: async () => ({ always: [], never: [] }),
    setLastSeenExceptions: async (body: unknown) => { state.saves.push(body); return { always: [], never: [] }; },
  };
  const dependencies: Record<string, unknown> = {
    react: awaitableReact(),
    'react-dom': { createPortal: (child: unknown) => child },
    '../api': { api },
    '../dmOnline': { resetExactCache: () => { state.resets++; } },
    '../dialogChrome': { useDialogChrome: () => null },
    '../lastSeenExceptionsRules': rules,
    '../phoneLayout': { usePhoneLayout: () => false },
    '../store': { useStore: (selector: (s: unknown) => unknown) => selector({ serverFeatures: ['lastseen3'] }) },
    '../toast': { toastError: () => {} },
    './BottomSheet': { BottomSheet: ({ children }: { children: ReactNode }) => createElement('div', null, children) },
    './GroupDialogs': { PeoplePicker: ({ picked, setPicked }: { picked: unknown[]; setPicked: (value: unknown[]) => void }) =>
      createElement('button', { type: 'button', onClick: () => setPicked([...picked, { id: 'peer' }]) }, 'добавить человека') },
  };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const sandbox = {
    module, exports: module.exports, document, window,
    require: (id: string) => {
      if (id === 'react/jsx-runtime') return requireReactJsxRuntime();
      assert.ok(id in dependencies, `неожиданная зависимость ${id}`);
      return dependencies[id];
    },
  };
  runInNewContext(js, sandbox);
  return module.exports.LastSeenExceptionsBlock as Block;
}

function awaitableReact() {
  return { useEffect, useState };
}
function requireReact(): typeof import('react') {
  // Importing React through the static binding keeps this helper free of browser-specific module state.
  return { createElement, Fragment, act } as unknown as typeof import('react');
}
function requireReactJsxRuntime() {
  return { jsx, jsxs, Fragment };
}

async function saveThroughDialog(BlockComponent: Block, state: { resets: number; saves: unknown[] }) {
  const host = document.createElement('div'); document.body.append(host);
  const root: Root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(BlockComponent, { privacy: 'peers' })); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const open = host.querySelector<HTMLButtonElement>('.settings-action');
    assert.ok(open, 'загруженные исключения показывают настоящее действие списка');
    await act(async () => { open!.click(); });
    const add = document.querySelector<HTMLButtonElement>('.group-dialog button');
    assert.ok(add, 'диалог выбора участников доступен');
    await act(async () => { add!.click(); });
    const save = document.querySelector<HTMLButtonElement>('.group-dialog .modal-actions button:last-child');
    assert.ok(save, 'сохранение доступно после изменения списка');
    await act(async () => { save!.click(); await Promise.resolve(); await Promise.resolve(); });
    assert.deepEqual(state.saves, [{ always: ['peer'], never: [] }], 'клиент отправил именно выбранное исключение');
  } finally {
    await act(async () => { root.unmount(); });
    host.remove(); document.querySelector('.modal-overlay')?.remove();
  }
}

it('сохранение исключений «Времени захода» сбрасывает кэш точной видимости', async () => {
  const state = { resets: 0, saves: [] as unknown[] };
  await saveThroughDialog(component(undefined, state), state);
  assert.equal(state.resets, 1, 'после успешного PUT список ЛС должен запросить видимость заново');

  const mutantState = { resets: 0, saves: [] as unknown[] };
  const mutant = component((source) => source.replace('            resetExactCache();', '            // мутант: кэш не сброшен'), mutantState);
  await saveThroughDialog(mutant, mutantState);
  assert.equal(mutantState.resets, 0, 'исполняемый мутант воспроизводит устаревший кэш после сохранения');
});
