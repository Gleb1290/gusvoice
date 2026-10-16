import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';

it('FileCard в старом WebView: стрелка сохраняет, нажатие по карточке открывает', async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const calls: Array<{ url: string; name: string; mime: string; then: string }> = [];
  const source = readFileSync(new URL('./FileCard.tsx', import.meta.url), 'utf8');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports,
    require: (id: string) => {
      if (id === 'react') return React;
      if (id === 'react/jsx-runtime') return jsx;
      if (id === '../fileActions') return {
        attachmentKey: (a: { id?: string; url?: string }) => a.id || a.url,
        fileJobOf: () => null, filesViaNative: () => false, openAttachmentFile() {}, progressRatio: () => 0,
        progressText: () => '', saveAttachmentFile() {}, subscribeFileJobs: () => () => {},
      };
      if (id === '../fileLaunch') return { confirmLaunch: async () => true };
      if (id === '../pcDownloads') return {
        attachmentTarget: () => ({ url: '/api/download/file', name: 'document.txt', type: 'text/plain' }),
        legacyDownloadWithToast: (url: string, name: string, mime: string, then: string) => calls.push({ url, name, mime, then }),
        legacyDownloadsAvailable: () => true, ringDownloads: () => true, toggleDownload() {},
      };
      if (id === './Icon') return { Icon: () => null };
      throw new Error(`неожиданный импорт ${id}`);
    },
  });
  const FileCard = module.exports.FileCard as React.ComponentType<{ a: { id: string; url: string; name: string; contentType: string }; href: string; sizeLabel: string }>;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(FileCard, {
      a: { id: 'att-1', url: '/att/1', name: 'document.txt', contentType: 'text/plain' }, href: '/api/download/file', sizeLabel: '1 КБ',
    })));
    const arrow = host.querySelector<HTMLElement>('.att-file-dl'); assert.ok(arrow, 'стрелка скачивания присутствует');
    const save = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await React.act(async () => { arrow.dispatchEvent(save); });
    assert.equal(save.defaultPrevented, true, 'стрелка не переходит по ссылке браузером');
    assert.deepEqual(calls, [{ url: '/api/download/file', name: 'document.txt', mime: 'text/plain', then: 'save' }]);

    const card = host.querySelector<HTMLAnchorElement>('.att-file'); assert.ok(card);
    const open = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await React.act(async () => { card.dispatchEvent(open); await Promise.resolve(); });
    assert.equal(open.defaultPrevented, true, 'карточка не оставляет переход на blob-ссылку');
    assert.deepEqual(calls, [
      { url: '/api/download/file', name: 'document.txt', mime: 'text/plain', then: 'save' },
      { url: '/api/download/file', name: 'document.txt', mime: 'text/plain', then: 'open' },
    ], 'стрелка сохраняет, карточка открывает после подтверждения');
  } finally {
    await React.act(async () => root.unmount()); host.remove(); GlobalRegistrator.unregister();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
