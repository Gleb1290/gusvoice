import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import type { ConvReader, ConvReaders } from '@gusvoice/shared';
import * as text from '../lastSeenText';

type Component = typeof import('./ReadersLine').ReadersLine;
type Mutation = readonly [string, string];
const original = readFileSync(new URL('./ReadersLine.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const readers: ConvReader[] = Array.from({ length: 4 }, (_, n) => ({ userId: `u${n}`, username: `user${n}`, displayName: `Имя${n}`, avatarUrl: null }));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function scene(work: (f: {
  host: HTMLElement; replies: ReturnType<typeof deferred<ConvReaders>>[]; calls: string[][]; opened: ConvReader[][];
  render(id: string): Promise<void>; answer(value: ConvReaders, index?: number): Promise<void>;
}) => Promise<void>, mutation?: Mutation) {
  GlobalRegistrator.register();
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const io: string[] = [], calls: string[][] = [], opened: ConvReader[][] = [], replies: ReturnType<typeof deferred<ConvReaders>>[] = [];
  const deny = (name: string) => () => { io.push(name); throw new Error(`запрещённый IO ${name}`); };
  const api = new Proxy({ convReaders: (cid: string, mid: string) => {
    calls.push([cid, mid]); const reply = deferred<ConvReaders>(); replies.push(reply); return reply.promise;
  } }, { get: (target, key) => key === 'convReaders' ? target.convReaders : deny(`api.${String(key)}`)() });
  let source = original;
  if (mutation) { assert.equal(source.split(mutation[0]).length - 1, 1, 'R239-line-anchor: единственный якорь'); source = source.replace(...mutation); }
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, '../lastSeenText': text,
    '../api': { api },
    './Avatar': { Avatar: (p: { name: string; url: string | null }) => React.createElement('span', { 'data-reader-avatar': p.name, 'data-url': p.url }) },
    './Icon': { Icon: (p: { name: string }) => React.createElement('i', { 'data-icon': p.name }) },
  };
  const module = { exports: {} as { ReadersLine: Component } };
  try {
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { module, exports: module.exports, fetch: deny('fetch'), setTimeout: deny('таймер'),
        require: (id: string) => { if (!Object.hasOwn(deps, id)) return deny(`import ${id}`)(); return deps[id]; } });
    const render = async (messageId: string) => React.act(async () => root.render(React.createElement(module.exports.ReadersLine, {
      convId: 'group', messageId, onOpen: (list: ConvReader[]) => opened.push(list),
      lookup: (id: string) => id === 'u0' ? { name: 'Мой контакт', avatarUrl: '/contact.png' } : null,
    })));
    await render('first');
    await work({ host, replies, calls, opened, render, answer: async (value, index = replies.length - 1) => React.act(async () => replies[index].resolve(value)) });
  } finally {
    await React.act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister();
    if (prior) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', prior); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    assert.equal(io.join(','), '', 'R239-line-IO: запрет не проглочен обработчиком Promise');
  }
}
function killed(prefix: string, actual: unknown, expected: unknown) {
  return (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(prefix) && e.operator === 'strictEqual' && Object.is(e.actual, actual) && Object.is(e.expected, expected);
}
test('R239 строка сразу показывает Загрузка… без клика, запрос использует id группы и сообщения', async () => {
  await scene(async f => {
    assert.equal(f.host.textContent, 'Загрузка…'); assert.equal(f.host.querySelector('button')?.disabled, true);
    assert.equal(JSON.stringify(f.calls), '[["group","first"]]'); assert.equal(f.host.querySelector('[data-icon="checks"]') !== null, true);
    f.host.querySelector('button')!.click(); assert.equal(f.opened.length, 0);
  });
});
for (const error of [false, true]) test(`R239 ${error ? 'ошибка запроса' : 'expired'} убирает пункт без сообщения об ошибке`, async () => {
  await scene(async f => {
    if (error) await React.act(async () => f.replies[0].reject(new Error('fixture unavailable')));
    else await f.answer({ expired: true, items: readers });
    assert.equal(f.host.querySelector('button'), null); assert.equal(f.host.textContent, '');
  });
});
async function empty(mutation?: Mutation) {
  await scene(async f => {
    await f.answer({ items: [] });
    assert.equal(f.host.textContent, 'Никто не прочитал');
    assert.equal(f.host.querySelector('button')?.disabled, true, 'R239-empty: пустой список неактивен');
    f.host.querySelector('button')!.click(); assert.equal(f.opened.length, 0);
  }, mutation);
}
test('R239 пустой список неактивен, снятие empty guard обнаруживается', async () => {
  await empty(); await assert.rejects(empty(['disabled={loading || looks.length === 0}', 'disabled={loading}']), killed('R239-empty:', false, true));
});
async function faces(mutation?: Mutation) {
  await scene(async f => {
    await f.answer({ items: readers });
    assert.equal(f.host.querySelectorAll('[data-reader-avatar]').length, 3, 'R239-faces: максимум три аватарки');
    assert.equal(f.host.querySelector('[data-reader-avatar]')?.getAttribute('data-reader-avatar'), 'Мой контакт');
    assert.equal(f.host.querySelector('[data-reader-avatar]')?.getAttribute('data-url'), '/contact.png');
    assert.equal(f.host.querySelector('button')?.disabled, false);
    f.host.querySelector('button')!.click(); assert.equal(f.opened.length, 1); assert.equal(f.opened[0], readers);
  }, mutation);
}
test('R239 четыре читателя дают три аватара, нажатие возвращает весь исходный список; лимит мутанта ловится', async () => {
  await faces(); await assert.rejects(faces(['const FACES_MAX = 3;', 'const FACES_MAX = 4;']), killed('R239-faces:', 4, 3));
});
test('R239 один читатель показывает имя контакта вместо серверного и отдаёт его в окно', async () => {
  await scene(async f => { await f.answer({ items: [readers[0]] }); assert.equal(f.host.textContent, 'Мой контакт'); f.host.querySelector('button')!.click(); assert.equal(f.opened[0][0], readers[0]); });
});
test('R239 ровно три читателя показывают все три аватара и сохраняют порядок серверного списка', async () => {
  await scene(async f => {
    const list = readers.slice(0, 3); await f.answer({ items: list });
    assert.equal(f.host.querySelectorAll('[data-reader-avatar]').length, 3);
    assert.equal([...f.host.querySelectorAll('[data-reader-avatar]')].map(n => n.getAttribute('data-reader-avatar')).join(','), 'Мой контакт,Имя1,Имя2');
    f.host.querySelector('button')!.click(); assert.equal(f.opened[0], list);
  });
});
async function opens(mutation?: Mutation) {
  await scene(async f => {
    await f.answer({ items: readers }); f.host.querySelector('button')!.click();
    assert.equal(f.opened.length, 1, 'R239-open: нажатие передаёт список родителю');
    assert.equal(f.opened[0], readers);
  }, mutation);
}
test('R239 удаление вызова onOpen обнаруживается нажатием на настоящую кнопку', async () => {
  await opens(); await assert.rejects(opens(['if (items.length > 0) onOpen(items);', '// onOpen удалён']), killed('R239-open:', 0, 1));
});
async function stale(mutation?: Mutation) {
  await scene(async f => {
    await f.render('second'); await f.answer({ items: [readers[1]] }, 1);
    assert.equal(f.host.textContent, 'Имя1');
    await f.answer({ expired: true, items: [] }, 0);
    assert.equal(f.host.textContent, 'Имя1', 'R239-stale: закрытый запрос старого сообщения не стирает новый пункт');
    assert.equal(JSON.stringify(f.calls), '[["group","first"],["group","second"]]');
  }, mutation);
}
test('R239 ответ закрытого эффекта после смены сообщения игнорируется, снятие alive guard ловится', async () => {
  await stale(); await assert.rejects(stale(["if (alive) setList(v.expired ? 'none' : v.items);", "setList(v.expired ? 'none' : v.items);"]), killed('R239-stale:', '', 'Имя1'));
});
