import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement, Fragment, useEffect, useRef, useState } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { SERVER_SEARCH_MIN_CHARS } from '@gusvoice/shared';
import * as searchRules from '../dmListSearchRules';
import type * as Search from './DmServerSearch';

before(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(() => GlobalRegistrator.unregister());

function loadSearch(error: unknown, change?: (source: string) => string) {
  let source = readFileSync(new URL('./DmServerSearch.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (change) {
    const changed = change(source);
    assert.notEqual(changed, source, 'контрфакт изменил настоящий исходник поиска');
    source = changed;
  }
  const queries: unknown[] = [];
  const dependencies: Record<string, unknown> = {
    react: { useEffect, useRef, useState },
    'react/jsx-runtime': { jsx, jsxs, Fragment },
    '@gusvoice/shared': { SERVER_SEARCH_MIN_CHARS },
    '../api': { api: { searchServers: async (query: unknown) => { queries.push(query); throw error; } } },
    '../dmRowRules': { dmRowTime: () => null },
    '../dmListSearchRules': searchRules,
    '../feedJump': { requestFeedJump: () => assert.fail('ошибка поиска не запускает переход в канал') },
    '../sockets': { subscribeToServer: () => assert.fail('ошибка поиска не открывает сервер') },
    '../store': { useStore: { getState: () => assert.fail('отрисовка ошибки не читает живой стор') } },
    '../toast': { toast: () => {}, toastError: () => {} },
    './Avatar': { Avatar: () => null },
  };
  const module = { exports: {} as typeof Search };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, Error, window,
    require: (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `неожиданная зависимость ${id}`);
      return dependencies[id];
    },
  });
  return { ...module.exports, queries };
}

async function checkError(error: unknown, expected: string, change?: (source: string) => string) {
  const loaded = loadSearch(error, change);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(loaded.ServerMessageHits, {
        q: '  запрос  ', full: true, onOpen() {}, onShowAll() {},
      }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, searchRules.MESSAGE_SEARCH_DELAY_MS + 40)); });
    assert.deepEqual(loaded.queries.map((q) => ({ ...(q as object) })), [{ q: 'запрос', limit: searchRules.MESSAGE_SEARCH_PAGE }],
      'ошибка действительно пришла из одного выполненного запроса');
    assert.equal(host.querySelector('.dm-nores')?.textContent, expected, 'поиск показывает ожидаемый текст сбоя');
  } finally {
    await act(async () => root.unmount()); host.remove();
  }
}

it('частый поиск распознаётся по числовому 429, а другие ошибки не становятся ограничением', () => {
  // Иначе обычная ошибка сервера скрывается под предложением просто подождать минуту.
  const { isTooManyRequests } = loadSearch(null);
  assert.equal(isTooManyRequests({ status: 429 }), true);
  assert.equal(isTooManyRequests(Object.assign(new Error('Лимит'), { status: 429 })), true);
  for (const error of [{ status: 500 }, { status: '429' }, new Error('HTTP 429'), null, undefined]) {
    assert.equal(isTooManyRequests(error), false);
  }
});

it('текст лимита сохраняет слова сервера, а пустой или технический HTTP получает понятную подсказку', () => {
  // Техническое HTTP 429 не объясняет человеку, когда можно повторить поиск.
  const { limitedText } = loadSearch(null);
  assert.equal(limitedText(new Error('  Повторите через две минуты  ')), 'Повторите через две минуты');
  for (const error of [new Error('HTTP 429'), new Error(''), new Error('   '), null, undefined]) {
    assert.equal(limitedText(error), 'Слишком часто — попробуйте через минуту');
  }
});

it('полная вкладка при 429 показывает сообщение сервера, а обычный сбой объясняет неудачный поиск', async () => {
  const custom = Object.assign(new Error('Повторите через две минуты'), { status: 429 });
  await checkError(custom, 'Повторите через две минуты');
  await checkError(Object.assign(new Error('HTTP 429'), { status: 429 }), 'Слишком часто — попробуйте через минуту');
  await checkError(new Error('Соединение разорвано'), 'Не удалось поискать по серверам');
  await checkError(Object.assign(new Error('Сбой сервера'), { status: 500 }), 'Не удалось поискать по серверам');
});

const mutations: Record<string, (source: string) => string> = {
  'ошибочно считает 500 лимитом вместо 429': (s) => s.replace('?.status === 429', '?.status === 500'),
  'рисует обычную ошибку вместо сообщения лимита': (s) => s.replace('{st.note}', "{'Не удалось поискать по серверам'}"),
  'теряет пояснение сервера': (s) => s.replace("return m && !/^HTTP \\d+$/.test(m) ? m : 'Слишком часто — попробуйте через минуту';",
    "return 'Слишком часто — попробуйте через минуту';"),
};
for (const [name, change] of Object.entries(mutations)) {
  it(`контрфакт поиска: ${name}`, async () => {
    const error = Object.assign(new Error('Повторите через две минуты'), { status: 429 });
    await checkError(error, 'Повторите через две минуты');
    await assert.rejects(() => checkError(error, 'Повторите через две минуты', change), (caught: unknown) => {
      assert.ok(caught instanceof assert.AssertionError);
      assert.match(caught.message, /^поиск показывает ожидаемый текст сбоя/);
      return true;
    });
  });
}
