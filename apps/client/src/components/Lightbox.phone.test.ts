import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { ReactElement, ReactNode } from 'react';

const source = readFileSync(new URL('./Lightbox.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
type Node = ReactElement<Record<string, unknown>>;
// Полный настоящий модуль и JSX. Подменяются внешние границы и хуки без запуска эффектов:
// это проверка синхронного дерева компонентов, не DOM/layout и не исполнение жестов.
function tree(phone: boolean, count = 3, index = 1, text = source) {
  const react = require('react');
  const module = { exports: {} as { Lightbox?: (props: unknown) => ReactNode } };
  const deps: Record<string, unknown> = {
    react: { ...react, useState: (v: unknown) => [v, () => {}], useRef: (v: unknown) => ({ current: v }), useEffect: () => {}, useCallback: (v: unknown) => v, useSyncExternalStore: () => null },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-dom': { createPortal: (node: unknown) => node },
    '../fileActions': {}, '../pcDownloads': {}, './FileCard': { ProgressRing: () => null },
    '../lightboxGestures': { stripWindow: (n: number) => [0, n] }, '../lightboxZoom': {},
    '../mediaViewerRules': { orderViewerMenu: (items: unknown) => items, viewerDate: () => 'сегодня в 14:05' },
    '../nativeMedia': { nativeMediaAvailable: () => false }, '../phoneLayout': { usePhoneLayout: () => phone },
    '../toast': {}, '../videoPip': {}, './ContextMenu': {}, './Icon': { Icon: () => null },
    './VideoAttachment': {}, './VoiceSpeedButton': {},
  };
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loader = (specifier: string) => { assert.ok(specifier in deps, `неожиданная зависимость ${specifier}`); return deps[specifier]; };
  runInNewContext(js, { require: loader, exports: module.exports, module, document: { body: {} } }, { timeout: 1000 });
  const close = () => {};
  const root = module.exports.Lightbox!({ images: Array.from({ length: count }, (_, n) => ({ url: `/${n}.jpg`, name: `photo${n}`, from: 'Друг', at: '2026-10-10T11:05:00Z', size: 2048 })), index, onClose: close, onIndex: () => {} });
  const nodes: Node[] = [];
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object' || !('props' in node)) return;
    const el = node as Node; nodes.push(el); walk(el.props.children as ReactNode);
  };
  walk(root);
  const cls = (name: string) => nodes.filter(n => String(n.props.className ?? '').split(/\s+/).includes(name));
  const content = (node: ReactNode): string => Array.isArray(node) ? node.map(content).join('') : node && typeof node === 'object' && 'props' in node ? content((node as Node).props.children as ReactNode) : node == null || typeof node === 'boolean' ? '' : String(node);
  return { nodes, cls, content, close };
}
function phoneChrome(text = source) {
  const t = tree(true, 3, 1, text);
  assert.equal(t.cls('lb-back').length, 1);
  assert.equal(t.cls('lb-back')[0].props.onClick, t.close);
  assert.equal(t.nodes.some(n => n.props.title === 'Закрыть'), false);
  assert.equal(t.cls('lb-strip').length, 0); assert.equal(t.cls('lb-zoom').length, 0);
  assert.equal(t.content(t.cls('lb-count')[0]), '2 из 3');
  assert.equal(t.content(t.cls('lb-sub')[0]), 'сегодня в 14:05');
}
it('телефон: стрелка закрывает просмотр, крестик/миниатюры/масштаб отсутствуют, дата без веса и номера', () => phoneChrome());
it('телефон: номер отдельной пилюлей начинается с единицы и меняется вместе с индексом', () => {
  for (const index of [0, 1, 2]) { const t = tree(true, 3, index); assert.equal(t.content(t.cls('lb-count')[0]), `${index + 1} из 3`); }
});
it('одиночное фото на телефоне не получает шумную пилюлю «1 из 1»', () => assert.equal(tree(true, 1, 0).cls('lb-count').length, 0));
it('ПК: крестик закрывает просмотр, миниатюры и масштаб сохранены, вес и номер в подписи', () => {
  const t = tree(false);
  assert.equal(t.cls('lb-back').length, 0); assert.equal(t.cls('lb-count').length, 0);
  assert.equal(t.nodes.find(n => n.props.title === 'Закрыть')?.props.onClick, t.close);
  assert.equal(t.cls('lb-strip').length, 1); assert.equal(t.cls('lb-zoom').length, 1);
  assert.equal(t.content(t.cls('lb-sub')[0]), 'сегодня в 14:05 · 2 КБ · 2 из 3');
});
it('ПК: одиночное фото сохраняет масштаб и вес, но без полосы и номера', () => {
  const t = tree(false, 1, 0); assert.equal(t.cls('lb-strip').length, 0); assert.equal(t.cls('lb-zoom').length, 1);
  assert.equal(t.content(t.cls('lb-sub')[0]), 'сегодня в 14:05 · 2 КБ');
});
function mutate(from: string, to: string, check: (text: string) => void) {
  assert.equal(source.split(from).length - 1, 1); check(source);
  assert.throws(() => check(source.replace(from, to)), assert.AssertionError);
}
it('контрфакт перевёрнутого phone у крестика ломает телефонное дерево', () => mutate('{!phone && (\n          <button type="button" className="lb-btn" title="Закрыть"', '{phone && (\n          <button type="button" className="lb-btn" title="Закрыть"', phoneChrome));
it('контрфакт счётчика при одном фото обнаруживается настоящим деревом JSX', () => mutate('{phone && images.length > 1 && (', '{phone && images.length >= 1 && (', text => assert.equal(tree(true, 1, 0, text).cls('lb-count').length, 0)));
it('контрфакт без телефонной границы полосы обнаруживается деревом', () => mutate('{images.length > 1 && !phone && (', '{images.length > 1 && (', phoneChrome));
it('контрфакт без телефонной границы масштаба обнаруживается деревом', () => mutate('{!isVideo && !phone && (', '{!isVideo && (', phoneChrome));

function pinchGuard(text: string) {
  const sf = ts.createSourceFile('Lightbox.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const checks: ts.IfStatement[] = [];
  function visit(n: ts.Node) { if (ts.isIfStatement(n) && /resetZoom\(\)/.test(n.thenStatement.getText(sf))) checks.push(n); ts.forEachChild(n, visit); }
  visit(sf);
  const reset = checks.find(n => n.expression.getText(sf).includes('baseZoom.current - 0.001')); assert.ok(reset);
  assert.equal(reset.expression.getText(sf), 'phone && fingers.current.size === 0 && zoomRef.current < baseZoom.current - 0.001');
  assert.ok(text.indexOf('fingers.current.delete(e.pointerId)') < reset.pos, 'палец убирается до проверки последнего');
}
it('AST: возврат ниже fit только на телефоне после удаления последнего пальца', () => pinchGuard(source));
it('AST-контрфакт без fingers.size === 0 не проходит страж последнего пальца', () => mutate('phone && fingers.current.size === 0 && zoomRef.current <', 'phone && zoomRef.current <', pinchGuard));
it('AST-контрфакт без phone не проходит границу сброса щипка', () => mutate('phone && fingers.current.size === 0 && zoomRef.current <', 'fingers.current.size === 0 && zoomRef.current <', pinchGuard));
