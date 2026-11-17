import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as progress from '../uploadProgress';

let createRoot: typeof import('react-dom/client')['createRoot'];
before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  createRoot = (await import('react-dom/client')).createRoot;
});
after(() => GlobalRegistrator.unregister());

async function scene(check: (s: {
  host: HTMLDivElement;
  render: (extra?: Record<string, unknown>) => Promise<void>;
  files: File[];
  renderInline: () => Promise<void>;
  cancelled: string[];
  created: string[];
  revoked: string[];
}) => Promise<void>) {
  const created: string[] = [], revoked: string[] = [], cancelled: string[] = [];
  const files = [new File([new Uint8Array(2 * 1024 * 1024)], 'a.png', { type: 'image/png' }),
    new File([new Uint8Array(1024)], 'b.mp4', { type: 'video/mp4' })];
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, '../uploadProgress': progress,
    '../fileActions': { progressRatio: (a: number, b: number) => b ? a / b : 0, progressText: () => '' },
    '../imageSize': { measureMediaFile: async () => null, attachmentBox: () => null },
    './AttachmentView': { isImage: (s: string) => s.startsWith('image/'), isVideo: (s: string) => s.startsWith('video/'), kb: () => '1 КБ', ATT_IMG_MAX_W: 500, ATT_IMG_MAX_H: 500 },
    './FileCard': { ProgressRing: () => React.createElement('span') },
    './Icon': { Icon: () => null }, './SpoilerCover': { SpoilerParticles: () => React.createElement('i') },
  };
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('./OutgoingAttachments.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const url = { createObjectURL: () => { const v = 'blob:' + created.length; created.push(v); return v; },
    revokeObjectURL: (v: string) => revoked.push(v) };
  runInNewContext(code, { module, exports: module.exports, URL: url, require: (id: string) => {
    assert.ok(id in deps, id); return deps[id];
  } });
  const Component = (module.exports as typeof import('./OutgoingAttachments')).OutgoingAttachments;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = async (extra: Record<string, unknown> = {}) => {
    await React.act(async () => root.render(React.createElement(Component, {
      rowKey: 'row', files, sending: true, fill: false, onCancel: (key: string) => cancelled.push(key), ...extra,
    })));
  };
  const renderInline = async () => {
    const Counter = (module.exports as typeof import('./OutgoingAttachments')).MediaUploadStatus;
    await React.act(async () => root.render(React.createElement(Counter, { rowKey: 'row', index: 0, size: 1024, inline: true })));
  };
  try { await render(); await check({ host, render, renderInline, files, cancelled, created, revoked }); }
  finally { await React.act(async () => root.unmount()); host.remove(); progress.clearUploadProgress('row'); }
}
const labels = (host: HTMLElement) => [...host.querySelectorAll('.att-up-status')].map(el => el.getAttribute('aria-label'));
const update = async (fn: () => void) => { await React.act(async () => fn()); };

it('очередь показывает ноль и локальный размер, события меняют только нужное медиа', async () => {
  await scene(async ({ host }) => {
    assert.deepEqual(labels(host), ['0,0 / 2,0 МБ', '0,0 / 1,0 КБ']);
    await update(() => progress.setUploadProgress('row', 1, 512, 1024));
    assert.deepEqual(labels(host), ['0,0 / 2,0 МБ', '0,5 / 1,0 КБ']);
    assert.equal(host.querySelectorAll('.att-up-status-narrow')[1].textContent, '50%');
    await update(() => progress.setUploadProgress('row', 0, 1048576, 4194304));
    assert.equal(labels(host)[0], '1,0 / 4,0 МБ');
  });
});
it('полный сетевой прогресс и завершённый файл ждут подтверждения сообщения', async () => {
  await scene(async ({ host, render }) => {
    await update(() => progress.setUploadProgress('row', 0, 1000, 1000));
    assert.equal(labels(host)[0], 'Отправляется…');
    await update(() => progress.setUploadDone('row', 0));
    assert.equal(labels(host)[0], 'Отправляется…');
    await render({ uploaded: [undefined, { id: 1 }] });
    assert.equal(labels(host)[1], 'Отправляется…');
  });
});
it('неизвестный и нулевой размеры не выдумывают процент и не дают NaN', async () => {
  await scene(async ({ host, files, render }) => {
    await update(() => progress.setUploadProgress('row', 0, 300, 0));
    assert.equal(labels(host)[0], '300 Б');
    assert.equal(host.querySelector('.att-up-status-narrow')?.textContent, '300 Б');
    await update(() => progress.setUploadProgress('row', 0, 2 * 1024 * 1024, 0));
    assert.equal(labels(host)[0], '2,0 МБ');
    assert.equal(host.querySelector('.att-up-status')?.getAttribute('aria-valuenow'), null);
    files[1] = new File([], 'empty.png', { type: 'image/png' });
    await render({ files: [...files] });
    assert.equal(labels(host)[1], '0 Б');
    await update(() => progress.setUploadProgress('row', 1, NaN, NaN));
    assert.equal(labels(host)[1], '0 Б');
  });
});
it('ошибка скрывает статус, повтор начинает очередь заново', async () => {
  await scene(async ({ host, render }) => {
    await update(() => progress.setUploadProgress('row', 0, 500, 1000));
    await render({ sending: false });
    assert.equal(labels(host).length, 0);
    await update(() => progress.clearUploadProgress('row'));
    await render();
    assert.equal(labels(host)[0], '0,0 / 2,0 МБ');
  });
});
it('отмена передаёт ключ, обновления не пересоздают ссылки, спойлер сохраняется', async () => {
  await scene(async ({ host, render, cancelled, created, revoked }) => {
    await render({ spoilers: [0], fill: true });
    assert.ok(host.querySelector('.att-img-wrap.spoiled img'));
    assert.ok(host.querySelector('.spoiled .att-up-status'));
    assert.equal(host.querySelector('img')?.getAttribute('src'), 'blob:0');
    await update(() => progress.setUploadProgress('row', 0, 1, 10));
    assert.deepEqual(created, ['blob:0', 'blob:1']);
    assert.deepEqual(revoked, []);
    await update(() => host.querySelector<HTMLButtonElement>('button')!.click());
    assert.deepEqual(cancelled, ['row']);
  });
});

it('самостоятельный inline-счётчик подписывается на прогресс и ожидает подтверждения', async () => {
  await scene(async ({ host, renderInline }) => {
    await renderInline();
    assert.ok(host.querySelector('.att-up-status-container.inline'));
    assert.deepEqual(labels(host), ['0,0 / 1,0 КБ']);
    await update(() => progress.setUploadProgress('row', 0, 512, 1024));
    assert.equal(host.querySelector('.att-up-status-narrow')?.textContent, '50%');
    await update(() => progress.setUploadDone('row', 0));
    assert.deepEqual(labels(host), ['Отправляется…']);
  });
});
