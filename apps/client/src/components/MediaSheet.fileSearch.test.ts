import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsx from 'react/jsx-runtime';
import { Simulate } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as rules from '../attachRules';
import * as longText from '../longTextRules';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const raw = read('./MediaSheet.tsx');
const unused = () => assert.fail('действие вне поиска недавних файлов');
function load<T>(source: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  class QuietIntersection { observe() {} unobserve() {} disconnect() {} }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, window, document, URL, File, DOMException, Element, HTMLElement, navigator,
    IntersectionObserver: QuietIntersection, requestAnimationFrame, cancelAnimationFrame, performance,
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `импорт полного MediaSheet или оболочки: ${id}`); return deps[id]; },
  }); return module.exports as T;
}
type Scene = { root: HTMLElement; titles(): string[]; query(value: string): Promise<void> };
async function fixture(count: number, work: (f: Scene) => Promise<void>, source = raw) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const dmMessages = { conversation: Array.from({ length: count }, (_, index) => ({
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    attachments: [{ id: `file-${index}`, url: `/file-${index}`, name: index === 50 ? 'Документ ёжик 050.txt' : `Документ ${String(index).padStart(3, '0')}.txt`,
      contentType: 'text/plain', size: index + 1 }],
  })) };
  const common = { react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': jsx };
  const icon = load<typeof import('./Icon')>(read('./Icon.tsx'), common);
  const bottom = load<typeof import('./BottomSheet')>(read('./BottomSheet.tsx'), { ...common, './Icon': icon });
  const deps = { ...common, '../attachRules': rules, '../longTextRules': longText,
    '../api': { api: { attachmentDownloadUrl: unused } }, '../store': { useStore: (select: (s: { dmMessages: typeof dmMessages }) => unknown) => select({ dmMessages }) },
    '../cameraCapture': { cameraSupported: () => false, cameraAllowedQuietly: async () => false, cameraCount: unused, openCamera: unused, stopStream: () => {} },
    '../nativeMedia': { nativeMediaInfo: async () => ({ perm: 'granted', asked: true, camera: false, mic: false, capture: false }),
      galleryAlbums: async () => [], galleryPage: async () => ({ items: [], end: true }), galleryThumb: unused,
      cancelNativeFiles: () => {}, galleryFiles: unused, galleryPermission: unused, pickDocumentsNative: unused,
      captureNative: unused, captureErrorCode: unused, cameraPermissionNative: unused },
    '../toast': { toast: unused }, '../confirm': { confirmAction: unused }, './BottomSheet': bottom,
    './CameraScreen': { CameraCell: unused, CameraScreen: unused }, './ContextMenu': { MenuItem: unused },
    './MediaPickViewer': { MediaPickViewer: unused }, './SchedPick': { SchedPick: unused }, './Icon': icon };
  try {
    // Исполняется целый MediaSheet с реальными recentFilesOf/filterFilesByName, React и BottomSheet.
    const { MediaSheet } = load<typeof import('./MediaSheet')>(source, deps);
    await React.act(async () => { root.render(React.createElement(MediaSheet, { native: true, room: 10, caption: '',
      onSend: unused, onAttach: unused, onClose: unused, onSystemPick: unused })); });
    const tab = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Файл');
    assert.ok(tab, 'полный лист имеет настоящую вкладку Файл');
    await React.act(async () => { tab.click(); });
    const sheet = document.querySelector<HTMLElement>('.gal-files'); assert.ok(sheet, 'вкладка Файл действительно открыта');
    await work({ root: sheet,
      titles() { const card = sheet.querySelector('.gal-card-head')?.parentElement; return [...card?.querySelectorAll('.gal-row-title') ?? []].map(node => node.textContent ?? ''); },
      async query(value) {
        const input = sheet.querySelector<HTMLInputElement>('.gal-file-search'); assert.ok(input, 'непустые recentAll дают настоящее поле поиска');
        await React.act(async () => { input.value = value; Simulate.change(input); });
      },
    });
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally {
      host.remove(); await GlobalRegistrator.unregister();
      if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  }
}
const hasSourceCards = (root: HTMLElement) => [...root.querySelectorAll('.gal-row-title')].some(node => node.textContent === 'Внутреннее хранилище' || node.textContent === 'Галерея');
async function limits(source = raw) {
  await fixture(220, async f => {
    assert.equal(f.titles().length, 20, 'R218-file-default: без запроса видны только 20 самых новых файлов');
    assert.equal(f.titles()[0], 'Документ 219.txt'); assert.equal(f.titles().at(-1), 'Документ 200.txt');
    await f.query('Документ');
    assert.equal(f.titles().length, 200, 'R218-file-cap: поиск охватывает до 200 недавних, не прежние 20 и не все 220');
    assert.equal(f.titles()[0], 'Документ 219.txt'); assert.equal(f.titles().at(-1), 'Документ 020.txt');
  }, source);
}
it('R218 вкладка Файл показывает поиск только при непустом recentAll', async () => {
  await fixture(0, async f => {
    assert.equal(!!f.root.querySelector('.gal-file-search'), false); assert.equal(hasSourceCards(f.root), true);
  });
  await fixture(1, async f => { assert.equal(!!f.root.querySelector('input[type="search"][aria-label="Поиск файлов по названию"]'), true); });
});
it('R218 без запроса показаны 20 файлов, с запросом до 200 в порядке новизны', () => limits());
async function queryCards(source = raw) {
  await fixture(220, async f => {
    assert.equal(hasSourceCards(f.root), true, 'без запроса источники доступны');
    await f.query('  ЕЖИК  ');
    assert.equal(JSON.stringify(f.titles()), '["Документ ёжик 050.txt"]', 'поиск находит файл за первыми 20 с нормализацией ё/е');
    assert.equal(hasSourceCards(f.root), false, 'R218-file-cards: непустой запрос скрывает хранилище и галерею');
    assert.equal(f.root.querySelector('.gal-card-head')?.textContent, 'Найденные файлы');
    await f.query(' \t ');
    assert.equal(hasSourceCards(f.root), true, 'пробельный запрос возвращает карточки источников');
    assert.equal(f.titles().length, 20, 'очистка возвращает компактный исходный список');
  }, source);
}
it('R218 запрос скрывает источники и находит старый файл, очистка возвращает обычный лист', () => queryCards());
it('R218 отсутствие совпадений показывает Ничего не найдено без карточек источников', async () => {
  await fixture(2, async f => {
    await f.query('несуществующий');
    assert.deepEqual(f.titles(), []); assert.equal(f.root.querySelector('.gal-empty')?.textContent, 'Ничего не найдено');
    assert.equal(hasSourceCards(f.root), false);
    await f.query('Документ 001'); assert.equal(f.root.querySelector('.gal-empty'), null);
    assert.deepEqual(f.titles(), ['Документ 001.txt']);
  });
});
for (const [label, from, to, scenario, prefix, actual, expected] of [
  ['без запроса рисуются все 200', 'recentAll.slice(0, 20)', 'recentAll.slice(0, 200)', limits, 'R218-file-default:', 200, 20],
  ['поиск ограничен прежними 20', 'recentFilesOf<Attachment>(dmMessages, 200)', 'recentFilesOf<Attachment>(dmMessages, 20)', limits,
    'R218-file-cap:', 20, 200],
  ['карточки источников не скрываются при поиске', '{!fileQuery.trim() && (', '{true && (', queryCards, 'R218-file-cards:', true, false],
] as const) it(`R218 поиск контрфакт: ${label}`, async () => {
  await scenario(raw); assert.equal(raw.split(from).length - 1, 1, 'у мутации поиска один якорь в полном MediaSheet');
  await assert.rejects(scenario(raw.replace(from, to)), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith(prefix) && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected);
});
