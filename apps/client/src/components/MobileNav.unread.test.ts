import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsx from 'react/jsx-runtime';
import type { ReactNode, ReactElement } from 'react';
import ts from 'typescript';
import * as archive from '../dmArchiveRules';

const source = readFileSync(new URL('./MobileNav.tsx', import.meta.url), 'utf8');
type Node = ReactElement<{ className?: string; children?: ReactNode }>;
function render(unreadDms: string[], archived: string[] = [], text = source) {
  const state = { view: 'server', settingsOpen: false, mobileProfileOpen: false,
    unreadDms, dms: [...new Set([...unreadDms, ...archived])].map(id => ({ id, archived: archived.includes(id) })),
    setView() {}, setMobilePane() {}, setMobileProfileOpen() {}, async loadDms() {} };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(text, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { module, exports: module.exports, require(id: string) {
    if (id === 'react/jsx-runtime') return jsx;
    if (id === '../store') return { useStore: (select: (s: typeof state) => unknown) => select(state) };
    if (id === '../dmArchiveRules') return archive;
    if (id === './Icon') return { Icon: () => null };
    assert.fail(`неожиданный импорт ${id}`);
  } });
  const tree = (module.exports as typeof import('./MobileNav')).MobileNav();
  const nodes: Node[] = [];
  const visit = (node: ReactNode) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object' || !('props' in node)) return;
    const element = node as Node; nodes.push(element); visit(element.props.children);
  };
  visit(tree);
  const textOf = (node: ReactNode): string => Array.isArray(node) ? node.map(textOf).join('') :
    node && typeof node === 'object' && 'props' in node ? textOf((node as Node).props.children) :
      node == null || typeof node === 'boolean' ? '' : String(node);
  return { badges: nodes.filter(n => n.props.className === 'mnav-badge').map(n => textOf(n)),
    labels: nodes.filter(n => n.props.className === 'mnav-label').map(n => textOf(n)) };
}
function replaceOnce(from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'мутация имеет единственный якорь'); return source.replace(from, to);
}
function count(text = source) {
  const rendered = render(['first', 'second', 'archived'], ['archived'], text);
  assert.deepEqual(rendered.badges, ['2'], 'пилюля содержит число бесед вне архива, не точку');
  assert.deepEqual(rendered.labels, ['Серверы', 'Сообщения', 'Профиль'], 'число не подменяет название вкладки');
}

it('R157 без непрочитанных и только с архивными пилюля отсутствует', () => {
  // Нулевой счётчик не должен оставлять пустую точку; архив не тревожит вкладку сообщений.
  for (const [ids, archived] of [[[], []], [[], ['archived']], [['archived'], ['archived']]] as [string[], string[]][])
    assert.deepEqual(render(ids, archived).badges, []);
});
it('R157 одна и несколько непрочитанных бесед показывают точное число', () => {
  for (const n of [1, 2, 12]) {
    const ids = Array.from({ length: n }, (_, i) => `chat-${i}`);
    assert.deepEqual(render(ids).badges, [String(n)]);
  }
});
it('R157 архивные исключаются из числовой пилюли, названия вкладок сохраняются', () => count());
it('R157 контрфакт точки вместо числа обнаруживается после успешного оригинала', () => {
  count();
  assert.throws(() => count(replaceOnce('{badge}</span>', "{''}</span>")), assert.AssertionError);
});
it('R157 контрфакт счёта вместе с архивом обнаруживается после успешного оригинала', () => {
  count();
  assert.throws(() => count(replaceOnce('unreadOutsideArchive(s.dms, s.unreadDms).length', 's.unreadDms.length')), assert.AssertionError);
});
