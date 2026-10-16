import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

it('R134 DmChatView всегда передаёт настоящее окно ленты, отключённый feedWindow отвергается', () => {
  // Структурный страж, не исполнение вырезанного куска TSX и не замер layout в happy-dom.
  const source = readFileSync(new URL('./DmChatView.tsx', import.meta.url), 'utf8');
  function check(code: string) {
    const ast = ts.createSourceFile('DmChatView.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const views = ast.statements.filter(ts.isFunctionDeclaration).filter(n => n.name?.text === 'DmChatView');
    assert.equal(views.length, 1, 'проверяется тело настоящего DmChatView');
    const declarations: ts.VariableDeclaration[] = [];
    const panes: (ts.JsxSelfClosingElement | ts.JsxOpeningElement)[] = [];
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'feedWindow') declarations.push(node);
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === 'MessagePane') panes.push(node);
      ts.forEachChild(node, visit);
    }
    visit(views[0]!);
    assert.equal(declarations.length, 1);
    const value = declarations[0]!.initializer;
    assert.ok(value && ts.isObjectLiteralExpression(value), 'окно безусловно создаётся объектом, без feedWin=false');
    assert.equal(panes.length, 1);
    const props = panes[0]!.attributes.properties.filter(ts.isJsxAttribute).filter(a => a.name.getText(ast) === 'feedWindow');
    assert.equal(props.length, 1, 'MessagePane получает окно ленты');
    const prop = props[0]!.initializer;
    assert.ok(prop && ts.isJsxExpression(prop) && prop.expression && ts.isIdentifier(prop.expression)
      && prop.expression.text === 'feedWindow', 'окно ленты передано без отключающего гейта');
  }
  check(source);
  const anchor = 'feedWindow={feedWindow}';
  assert.equal(source.split(anchor).length - 1, 1, 'однозначная проводка окна');
  const mutant = source.replace(anchor, 'feedWindow={false ? feedWindow : undefined}');
  assert.throws(() => check(mutant), (error: unknown) => error instanceof assert.AssertionError && error.message.includes('без отключающего гейта'));
  const init = 'const feedWindow: FeedWindowProps = {';
  assert.equal(source.split(init).length - 1, 1, 'однозначное создание окна');
  const disabled = source.replace(init, 'const feedWin = false; const feedWindow: FeedWindowProps = feedWin && {');
  assert.throws(() => check(disabled), (error: unknown) => error instanceof assert.AssertionError && error.message.includes('без feedWin=false'));
});
