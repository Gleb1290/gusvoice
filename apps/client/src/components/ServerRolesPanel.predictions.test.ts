import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./ServerRolesPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Edit = { from: string; to: string };
function nodes<T extends ts.Node>(root: ts.Node, is: (n: ts.Node) => n is T): T[] {
  const result: T[] = []; let visited = 0;
  function visit(n: ts.Node) {
    if (++visited > 30_000) throw new Error('R364/budget/AST');
    if (is(n)) result.push(n); ts.forEachChild(n, visit);
  }
  visit(root); return result;
}
function paired(title: string, check: (tree: ts.SourceFile) => void, edits: Edit[]) {
  const parse = (raw: string) => ts.createSourceFile('ServerRolesPanel.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  it(`R343 роли: ${title}`, () => {
    check(parse(source));
    for (const edit of edits) {
      counterfact(() => {
        assert.equal(source.split(edit.from).length, 2, 'R343 setup: один якорь панели');
        assert.throws(() => check(parse(source.replace(edit.from, edit.to))), e => e instanceof assert.AssertionError && e.message.startsWith('R343 право UI:'));
      });
      check(parse(source));
    }
  });
}
paired('новое отдельное право существует в настоящем PERMS с понятной подписью', file => {
  const declaration = nodes(file, ts.isVariableDeclaration).find(n => ts.isIdentifier(n.name) && n.name.text === 'PERMS');
  assert.ok(declaration?.initializer && ts.isArrayLiteralExpression(declaration.initializer), 'R343 право UI: настоящий массив PERMS');
  const entries = declaration.initializer.elements.filter(ts.isObjectLiteralExpression).filter(n => n.properties.some(p => ts.isPropertyAssignment(p)
    && p.name.getText(file) === 'key' && ts.isStringLiteral(p.initializer) && p.initializer.text === 'MANAGE_PREDICTIONS'));
  assert.equal(entries.length, 1, 'R343 право UI: отдельный бит предсказаний не потерян');
  const label = entries[0].properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(file) === 'label')?.initializer;
  assert.equal(label && ts.isStringLiteral(label) ? label.text : undefined, 'Проводить ставки', 'R343 право UI: точная подпись роли');
}, [{ from: "key: 'MANAGE_PREDICTIONS',", to: "key: 'MANAGE_SERVER'," }, { from: "label: 'Проводить ставки',", to: "label: 'Управлять монетами'," }]);
paired('общая карта чекбоксов читает и меняет бит выбранного ключа, не бит экономики', file => {
  // Фильтр скрывает только строку игр; проверяем настоящий map ПОСЛЕ него, не независимую копию чекбокса.
  const mapping = nodes(file, ts.isCallExpression).find(n => ts.isPropertyAccessExpression(n.expression)
    && n.expression.name.text === 'map' && ts.isCallExpression(n.expression.expression)
    && n.expression.expression.expression.getText(file) === 'PERMS.filter');
  assert.ok(mapping, 'R343 право UI: PERMS действительно отображается');
  const compact = mapping.getText(file).replace(/\s/g, '');
  assert.equal(compact.includes('checked={hasBit(perms,Permission[key])}'), true, 'R343 право UI: чекбокс читает собственное право');
  assert.equal(compact.includes('v?p|Permission[key]:p&~Permission[key]'), true, 'R343 право UI: оба направления изменяют свой бит');
}, [{ from: 'checked={hasBit(perms, Permission[key])}', to: 'checked={hasBit(perms, Permission.MANAGE_ECONOMY)}' },
  { from: 'v ? p | Permission[key] : p & ~Permission[key]', to: 'v ? p | Permission.MANAGE_ECONOMY : p & ~Permission.MANAGE_ECONOMY' }]);
