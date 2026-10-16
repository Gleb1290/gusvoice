import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./MainLayout.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function check(raw = source) {
  // MainLayout — большая интеграционная оболочка. Адресный AST-страж проверяет именно guard записи
  // m-dmlist и доставку того же appClass на корневой div; тела компонентов не извлекаются и не eval.
  const ast = ts.createSourceFile('MainLayout.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fns = ast.statements.filter(ts.isFunctionDeclaration).filter(fn => fn.name?.text === 'MainLayout');
  assert.equal(fns.length, 1); const fn = fns[0]; assert.equal(fn.body !== undefined, true);
  const pushes: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments.some(arg => ts.isStringLiteral(arg) && arg.text === 'm-dmlist')) pushes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(fn); assert.equal(pushes.length, 1, 'ровно одна запись класса списка ЛС');
  const push = pushes[0]; assert.equal(push.expression.getText(ast), 'appClass.push');
  assert.equal(ts.isExpressionStatement(push.parent), true);
  const guard = push.parent.parent; assert.equal(ts.isIfStatement(guard), true);
  if (!ts.isIfStatement(guard)) return;
  assert.equal(ts.isBinaryExpression(guard.expression), true);
  if (!ts.isBinaryExpression(guard.expression)) return;
  assert.equal(guard.expression.operatorToken.kind, ts.SyntaxKind.AmpersandAmpersandToken);
  assert.equal(guard.expression.left.getText(ast), 'isDm');
  const pane = guard.expression.right; assert.equal(ts.isBinaryExpression(pane), true);
  if (!ts.isBinaryExpression(pane)) return;
  assert.equal(pane.operatorToken.kind, ts.SyntaxKind.EqualsEqualsEqualsToken);
  assert.equal(pane.left.getText(ast), 'mobilePane'); assert.equal(pane.right.getText(ast), "'list'");
  const variables = fn.body!.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
  const app = variables.filter(node => ts.isIdentifier(node.name) && node.name.text === 'appClass');
  assert.equal(app.length, 1); assert.equal(ts.isArrayLiteralExpression(app[0].initializer!), true);
  if (ts.isArrayLiteralExpression(app[0].initializer!)) assert.equal(app[0].initializer!.elements[0].getText(ast), "'app'");
  const returns = fn.body!.statements.filter(ts.isReturnStatement); assert.equal(returns.length, 1);
  let expression = returns[0].expression!;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  assert.equal(ts.isJsxElement(expression), true);
  if (!ts.isJsxElement(expression)) return;
  assert.equal(expression.openingElement.tagName.getText(ast), 'div');
  const classNames = expression.openingElement.attributes.properties.filter(ts.isJsxAttribute).filter(a => a.name.getText(ast) === 'className');
  assert.equal(classNames.length, 1); const init = classNames[0].initializer;
  assert.equal(init !== undefined && ts.isJsxExpression(init), true);
  if (init && ts.isJsxExpression(init)) assert.equal(init.expression!.getText(ast), "appClass.join(' ')");
}
// Класс ошибки: режим списка ЛС ошибочно влияет на открытый диалог или сервер.
it('R170 класс m-dmlist добавляется корню app только при isDm и list', () => check());
// Класс ошибки: класс m-dmlist действует и на content, ломая отступ открытой беседы.
it('R170 мутант класса списка в content обнаруживается адресным guard корня app', () => {
  const anchor = "if (isDm && mobilePane === 'list') appClass.push('m-dmlist');";
  assert.equal(source.split(anchor).length - 1, 1); check();
  assert.throws(() => check(source.replace(anchor, "if (isDm) appClass.push('m-dmlist');")), assert.AssertionError);
});
