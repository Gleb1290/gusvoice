import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, before, after } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement, act, useState, type ComponentType, type ReactNode } from 'react';
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import * as sendRules from '../sendFilesRules';
import * as photoRules from '../photoEditRules';
let dialogChrome: typeof import('../dialogChrome');
let server: ViteDevServer | undefined;

type FileBox = ComponentType<any>;
let registered = false;
before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' }); registered = true;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // layerAbove теперь тянет браузерный граф: DOM нужен до загрузки хука.
  server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false,
    optimizeDeps: { noDiscovery: true, include: [] }, esbuild: { jsx: 'automatic' }, define: { 'import.meta.env': '{}' },
    plugins: [{ name: 'send-files-empty-env', enforce: 'pre', transform(source, id) {
      if (id.replaceAll('\\', '/').endsWith('/src/config.ts')) return source.replaceAll('import.meta.env.', '({}).');
    } }],
    resolve: { alias: { '@gusvoice/shared': fileURLToPath(new URL('../../../../packages/shared/src/index.ts', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, watch: null, ws: false }, appType: 'custom', logLevel: 'error',
  });
  dialogChrome = await server.ssrLoadModule('/src/dialogChrome.ts') as typeof import('../dialogChrome');
});
after(async () => { await server?.close(); if (registered) GlobalRegistrator.unregister(); });

function loadBox(change?: (source: string) => string) {
  let source = readFileSync(new URL('./SendFilesBox.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (change) {
    const changed = change(source);
    assert.notEqual(changed, source, 'мутант изменяет перенос спойлера при замене исходного фото');
    source = changed;
  }
  const module = { exports: {} as Record<string, unknown> };
  const dependencies: Record<string, unknown> = {
    react: { useEffect: ReactHooks.useEffect, useMemo: ReactHooks.useMemo, useRef: ReactHooks.useRef, useState: ReactHooks.useState },
    'react/jsx-runtime': { jsx, jsxs, Fragment },
    '../dialogChrome': dialogChrome,
    './AttachmentView': { kb: (size: number) => `${size} Б` },
    './ContextMenu': {
      ContextMenu: ({ children }: { children: ReactNode }) => createElement('div', { className: 'ctx-menu' }, children),
      MenuItem: ({ label, onClick }: { label: string; onClick: () => void }) => createElement('button', { type: 'button', onClick }, label),
    },
    './Icon': { Icon: () => null },
    './Lightbox': { Lightbox: ({ onClose }: { onClose: () => void }) => {
      ReactHooks.useEffect(() => {
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onClose]);
      // Без TOP_LAYERS-маркера проверяем собственный overlayOpen SendFilesBox,
      // а не вторую, независимую защиту layerAbove в реальном dialogChrome.
      return createElement('div', { className: 'test-image-preview' });
    } },
    './PhotoEditor': { PhotoEditor: ({ file, onDone }: { file: File; onDone: (file: File, edit: unknown) => void }) => createElement('div', { className: 'photo-editor' },
      createElement('button', { type: 'button', onClick: () => onDone(new File([file], file.name, { type: file.type }), { angle: 90, flipped: false, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'free' }) }, 'Готово')) },
    './SpoilerCover': { SpoilerParticles: () => null },
    '../sendFilesRules': sendRules,
    '../photoEditRules': photoRules,
  };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, {
    module, exports: module.exports, document, window, URL, File, Image, setTimeout, clearTimeout,
    require: (id: string) => {
      assert.ok(id in dependencies, `неожиданный импорт ${id}`);
      return dependencies[id];
    },
  });
  return module.exports.SendFilesBox as FileBox;
}
import * as ReactHooks from 'react';

function photo(name = 'photo.jpg') { return new File(['pixels'], name, { type: 'image/jpeg', lastModified: 1 }); }
function fileRow(files: File[], way = { group: true, asFile: false }) {
  const Box = loadBox();
  const Harness: ComponentType = () => {
    return createElement(Box, {
      files, caption: '', way, saved: { group: true, asFile: false }, menu: { silent: false, later: false }, media2: true,
      onFiles: () => {}, onAdd: () => {}, onCancel: () => {}, onSend: () => {},
    });
  };
  return Harness;
}

async function runMarkedPhotoScenario(Box: FileBox, shouldRemainMarked: boolean, updates: File[][]) {
  const original = photo();
  const host = document.createElement('div'); document.body.append(host);
  let root: Root | null = createRoot(host);
  const Harness = () => {
    const [files, setFiles] = useState([original]);
    return createElement(Box, {
      files, caption: '', way: { group: true, asFile: false }, saved: { group: true, asFile: false }, menu: { silent: false, later: false }, media2: true,
      onFiles: (next: File[]) => { updates.push(next); setFiles(next); }, onAdd: () => {}, onCancel: () => {}, onSend: () => {},
    });
  };
  try {
    await act(async () => { root!.render(createElement(Harness)); });
    const tile = () => host.querySelector<HTMLElement>('.sfb-item')!;
    await act(async () => { tile().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((button) => button.textContent === 'Скрыть под спойлером')!.click(); });
    assert.ok(tile().classList.contains('spoiled'), 'выбранная фотография действительно помечена спойлером');
    await act(async () => { tile().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    const edit = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((button) => button.textContent === 'Изменить фото');
    assert.ok(edit, 'правый клик по изображению открывает реальный пункт «Изменить фото»');
    await act(async () => { edit!.click(); });
    assert.ok(document.querySelector('.photo-editor'), 'пункт открывает редактор, а не подменяет файл напрямую');
    await act(async () => { document.querySelector<HTMLButtonElement>('.photo-editor button')!.click(); });
    assert.equal(updates.at(-1)?.length, 1, 'редактор заменил фото на своей позиции');
    assert.notEqual(updates.at(-1)?.[0], original, 'отредактированное изображение — новая File');
    assert.equal(tile().classList.contains('spoiled'), shouldRemainMarked, 'метка скрытого медиа переезжает на отредактированный файл');
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    root = null; host.remove(); document.querySelector('.ctx-menu')?.remove(); document.querySelector('.photo-editor')?.remove();
  }
}

it('меню плитки редактирует фото и переносит его спойлер на созданный файл', async () => {
  await runMarkedPhotoScenario(loadBox(), true, []);
  const mutant = loadBox((source) => source.replace('n.add(next);', 'n.add(old);'));
  await assert.rejects(() => runMarkedPhotoScenario(mutant, true, []), assert.AssertionError,
    'исполняемый мутант оставляет спойлер у старого объекта File');
});

it('у строки «как файл» можно переименовать, но нельзя запустить редактор фото', async () => {
  const file = photo(); const host = document.createElement('div'); document.body.append(host);
  let root: Root | null = createRoot(host);
  try {
    const Harness = fileRow([file], { group: true, asFile: true });
    await act(async () => { root!.render(createElement(Harness)); });
    const row = host.querySelector<HTMLElement>('.sfb-item.row'); assert.ok(row);
    await act(async () => { row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    const labels = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].map((button) => button.textContent);
    assert.ok(labels.includes('Переименовать'), 'строка остаётся редактируемой по имени');
    assert.ok(!labels.includes('Изменить фото'), 'байтовый режим не кадрирует изображение и не пережимает его');
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    root = null; host.remove(); document.querySelector('.ctx-menu')?.remove();
  }
});

it('Escape в просмотре закрывает просмотр, а не всё окно отправки', async () => {
  async function scenario(Box: FileBox, expectCancel: boolean, state: { cancels: number }) {
    const file = photo(); const host = document.createElement('div'); document.body.append(host);
    let root: Root | null = createRoot(host);
    try {
      const Harness: ComponentType = () => createElement(Box, {
        files: [file], caption: '', way: { group: true, asFile: false }, saved: { group: true, asFile: false }, menu: { silent: false, later: false }, media2: true,
        onFiles: () => {}, onAdd: () => {}, onCancel: () => { state.cancels++; }, onSend: () => {},
      });
      await act(async () => { root!.render(createElement(Harness)); });
      await act(async () => { host.querySelector<HTMLElement>('.sfb-item')!.click(); });
      assert.ok(host.querySelector('.test-image-preview'), 'нажатие по плитке открывает просмотр');
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
      assert.equal(state.cancels > 0, expectCancel, 'диалог не должен интерпретировать Escape, уже принадлежащий окну просмотра');
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      root = null; host.remove();
    }
  }
  const state = { cancels: 0 };
  await scenario(loadBox(), false, state);
  const mutantState = { cancels: 0 };
  const mutant = loadBox((source) => source.replace('if (!overlayOpen.current) onCancel(captionNow.current);', 'onCancel(captionNow.current);'));
  await assert.rejects(() => scenario(mutant, false, mutantState), assert.AssertionError,
    'исполняемый мутант закрывает окно отправки на чужой клавише Escape');
});
