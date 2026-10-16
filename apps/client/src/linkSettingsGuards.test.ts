import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const settings = readFileSync(new URL('./components/UserSettingsModal.tsx', import.meta.url), 'utf8');
const guard = readFileSync(new URL('./linkGuard.tsx', import.meta.url), 'utf8');

function visibleText(source: string): string {
  const tree = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const text: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) text.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return text.join('\n');
}

it('R143 настройки оставляют предпросмотр, но не возвращают тумблер предупреждения и доверенные хосты', () => {
  // Проверяем JSX/строки AST, чтобы упоминание снятой настройки в комментарии не дало ложный отказ.
  const check = (source: string) => {
    const text = visibleText(source);
    assert.match(text, /Показывать предпросмотр ссылок/);
    assert.doesNotMatch(text, /Предупреждать при переходе|Забыть доверенных|не спрашивать/i);
  };
  check(settings);
  for (const label of ['Предупреждать при переходе по ссылкам', 'Забыть доверенных']) {
    assert.throws(() => check(`${settings}\nconst returned = <button>${label}</button>;`), assert.AssertionError);
  }
});

it('R143 старый ключ доверия не читается и не пишется ни окном, ни настройками', () => {
  // Даже невидимый старый переключатель не должен отключать новое предупреждение через localStorage.
  const check = (source: string) => assert.doesNotMatch(visibleText(source), /gv_link_warn/);
  for (const source of [settings, guard]) {
    check(source);
    assert.throws(() => check(`${source}\nlocalStorage.getItem('gv_link_warn');`), assert.AssertionError);
    assert.throws(() => check(`${source}\nlocalStorage.setItem('gv_link_warn', '{}');`), assert.AssertionError);
  }
});
