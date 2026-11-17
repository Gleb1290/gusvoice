import assert from 'node:assert/strict';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const P = 'R362/main/check/';
function check(raw: string) {
  const ast = ts.createSourceFile('main.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let visited = 0;
  const imported = ast.statements.filter(ts.isImportDeclaration).some(node => ts.isStringLiteral(node.moduleSpecifier)
    && node.moduleSpecifier.text === './externalLinks' && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(binding => binding.name.text === 'installExternalLinks'
      && (!binding.propertyName || binding.propertyName.text === 'installExternalLinks')));
  assert.equal(imported, true, P + 'настоящий-импорт');
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (++visited > 30_000) throw new Error('R362/main/budget/AST');
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'installExternalLinks') calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(calls.length, 1, P + 'одна-установка');
  assert.equal(calls[0].arguments.length, 0, P + 'без-параметров');
  assert.equal(ts.isExpressionStatement(calls[0].parent) && calls[0].parent.parent === ast, true, P + 'bootstrap-а-не-мёртвая-функция');
}

it('R362 main устанавливает общий перехватчик один раз при запуске приложения', () => {
  // Наличие модуля в репозитории не помогает десктопу, если bootstrap его не вызывает.
  check(source);
  for (const [from, to] of [
    ["import { installExternalLinks } from './externalLinks';", "import { installExternalLinks } from './missing-externalLinks';"],
    ['installExternalLinks();', '/* установка потеряна */'],
    ['installExternalLinks();', 'function unusedExternalLinks() { installExternalLinks(); }'],
  ]) {
    counterfact(() => {
    assert.equal(source.split(from).length - 1, 1, 'R362/main/setup/единственный-якорь');
    assert.throws(() => check(source.replace(from, to)), e => e instanceof assert.AssertionError && e.message.startsWith(P));
    });
    check(source);
  }
});
