import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

// AST-стражи без загрузки маршрутов: не подключаем БД/секреты и не исполняем вырезки исходника.
function bufferedFiles(source: string) {
  const tree = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Array<{ receiver: string; guard: ts.Statement | undefined; tree: ts.SourceFile }> = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'toBuffer') {
      assert.ok(ts.isAwaitExpression(node.parent), 'буфер читается до проверки truncated');
      const declaration = node.parent.parent;
      assert.ok(ts.isVariableDeclaration(declaration));
      assert.ok(ts.isVariableDeclarationList(declaration.parent));
      const statement = declaration.parent.parent;
      assert.ok(ts.isVariableStatement(statement));
      assert.ok(ts.isBlock(statement.parent));
      const siblings = statement.parent.statements;
      const index = siblings.indexOf(statement);
      assert.ok(index >= 0);
      found.push({ receiver: node.expression.expression.getText(tree), guard: siblings[index + 1], tree });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

function assertGuard(source: string, expectedCount: number, index: number) {
  const files = bufferedFiles(source);
  assert.equal(files.length, expectedCount, 'не потерян ни один путь чтения multipart');
  const { receiver, guard, tree } = files[index]!;
  assert.ok(guard && ts.isIfStatement(guard), 'сразу после toBuffer стоит отказ по truncated');
  assert.equal(guard.expression.getText(tree), `${receiver}.file.truncated`, 'проверяется реальный флаг без инверсии');
  const branch = ts.isBlock(guard.thenStatement) ? guard.thenStatement.statements : [guard.thenStatement];
  assert.equal(branch.length, 1, 'обрезанный файл только отвергается, не сохраняется');
  const returned = branch[0]!;
  assert.ok(ts.isReturnStatement(returned), '413 возвращается до дальнейшей обработки');
  assert.ok(returned.expression && ts.isCallExpression(returned.expression));
  const send = returned.expression.expression;
  assert.ok(ts.isPropertyAccessExpression(send) && send.name.text === 'send');
  assert.ok(ts.isCallExpression(send.expression));
  const code = send.expression.expression;
  assert.ok(ts.isPropertyAccessExpression(code) && code.name.text === 'code');
  assert.equal(code.expression.getText(tree), 'reply');
  assert.equal(send.expression.arguments.length, 1);
  const status = send.expression.arguments[0]!;
  assert.ok(ts.isNumericLiteral(status));
  assert.equal(Number(status.text), 413, 'обрезка не выдаётся за корректный файл или ошибку другого класса');
}

for (const [route, count] of [
  ['messages', 1], ['convGroups', 1], ['admin', 1], ['channels', 1], ['economy', 1],
  ['servers', 2], ['soundboard', 1], ['sounds', 2], ['users', 2],
] as const) {
  for (let index = 0; index < count; index++) {
    it(`R127 ${route}, загрузка ${index + 1}: обрезанный multipart сразу отвергается с 413`, () => {
      // Ловит молчаливую отправку/сохранение первых байтов слишком большого файла как полного вложения.
      const source = readFileSync(new URL(`./routes/${route}.ts`, import.meta.url), 'utf8');
      assertGuard(source, count, index);
      const original = bufferedFiles(source)[index]!;
      const guard = original.guard!;
      const start = guard.getStart(original.tree);
      const end = guard.end;
      const removed = source.slice(0, start) + source.slice(end);
      assert.notEqual(removed, source, 'удалён настоящий отказ именно этого пути загрузки');
      assert.throws(() => assertGuard(removed, count, index), assert.AssertionError);
      const changedStatus = source.slice(start, end).replace(/\.code\(413\)/, '.code(200)');
      assert.notEqual(changedStatus, source.slice(start, end));
      const accepted = source.slice(0, start) + changedStatus + source.slice(end);
      assert.throws(() => assertGuard(accepted, count, index), assert.AssertionError);
    });
  }
}
