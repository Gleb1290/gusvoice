import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { MessageBubbleProps } from './MessageBubble';

const source = readFileSync(new URL('./MessageBubble.tsx', import.meta.url), 'utf8');
const iconSource = readFileSync(new URL('./Icon.tsx', import.meta.url), 'utf8');

// Проверяем полную настоящую реализацию Bubble. Слот kb — обычный DOM-узел: его содержимое проверяется отдельно.
async function withBubble(props: Omit<MessageBubbleProps, 'children'> & { 'data-mid'?: string },
  check: (host: HTMLDivElement) => void | Promise<void>) {
  GlobalRegistrator.register({ url: 'https://client.example.test/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  function load(raw: string, dependencies: Record<string, unknown>) {
    const module = { exports: {} as Record<string, React.ComponentType<any>> };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, require: (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `R302 неописанный импорт пузыря: ${id}`);
      return dependencies[id];
    } });
    return module.exports;
  }
  try {
    const Component = load(source, { react: React, 'react/jsx-runtime': jsx,
      './Icon': load(iconSource, { 'react/jsx-runtime': jsx }) }).MessageBubble;
    await React.act(async () => root.render(React.createElement(Component, props,
      React.createElement('span', { className: 'message-text' }, 'Текст бота'))));
    await check(host);
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally {
      host.remove(); await GlobalRegistrator.unregister();
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  }
}

for (const side of ['in', 'out'] as const) it(`R302 ${side}: без kb пузырь остаётся прямым ребёнком строки, без bub-stack`, async () => {
  await withBubble({ side, 'data-mid': 'mid', className: 'picked', avatar: null,
    actions: React.createElement('div', { className: 'msg-actions' }, 'Действия') }, host => {
    const row = host.querySelector('.message.bub'); assert.ok(row);
    assert.equal(row.classList.contains(side === 'out' ? 'mine' : 'theirs'), true);
    assert.equal(row.getAttribute('data-mid'), 'mid'); assert.equal(row.classList.contains('picked'), true);
    assert.equal(row.querySelector('.bub-stack'), null);
    assert.deepEqual(Array.from(row.children, x => x.className), ['bub-ava', 'message-main bubble', 'msg-actions']);
    assert.equal(row.querySelector(':scope > .bubble > .message-text')?.textContent, 'Текст бота');
  });
});

for (const side of ['in', 'out'] as const) it(`R302 ${side}: kb располагается сразу после пузыря внутри одной bub-stack, аватар и действия снаружи`, async () => {
  await withBubble({ side, avatar: React.createElement('span', null, 'Аватар'),
    kb: React.createElement('div', { className: 'bot-kb' }, React.createElement('button', null, 'Нажать')),
    actions: React.createElement('div', { className: 'msg-actions' }, 'Действия') }, host => {
    const row = host.querySelector('.message.bub'); assert.ok(row);
    assert.deepEqual(Array.from(row.children, x => x.className), ['bub-ava', 'bub-stack', 'msg-actions']);
    const stack = row.querySelector(':scope > .bub-stack'); assert.ok(stack);
    assert.deepEqual(Array.from(stack.children, x => x.className), ['message-main bubble', 'bot-kb']);
    assert.equal(stack.querySelector(':scope > .bubble + .bot-kb button')?.textContent, 'Нажать');
    assert.equal(stack.querySelector('.bubble .bot-kb'), null);
    assert.equal(row.querySelector(':scope > .bubble'), null);
  });
});

it('R302 null kb не добавляет обёртку, а media-пузырь в стеке сохраняет собственную ширину и содержимое', async () => {
  await withBubble({ side: 'in', kb: null, kind: 'media', mediaWidth: 240, mediaEnd: true }, host => {
    assert.equal(host.querySelector('.bub-stack'), null);
    const bubble = host.querySelector<HTMLElement>('.message > .bubble.media.media-end'); assert.ok(bubble);
    assert.equal(bubble.style.width, '240px');
  });
  await withBubble({ side: 'in', kind: 'media', mediaWidth: 240, mediaEnd: true,
    kb: React.createElement('div', { className: 'bot-kb' }, 'Кнопки') }, host => {
    const bubble = host.querySelector<HTMLElement>('.bub-stack > .bubble.media.media-end'); assert.ok(bubble);
    assert.equal(bubble.style.width, '240px');
    assert.equal(bubble.querySelector('.message-text')?.textContent, 'Текст бота');
    assert.equal(bubble.nextElementSibling?.className, 'bot-kb');
  });
});
