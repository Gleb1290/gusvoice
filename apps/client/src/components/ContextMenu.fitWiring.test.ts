import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

function nodes<T extends ts.Node>(root: ts.Node, is: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  function visit(node: ts.Node) {
    if (is(node)) result.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return result;
}

type Site = { file: string; owner: string; position: string; label: string };

function menuAt(source: string, site: Site) {
  const ast = ts.createSourceFile(site.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = nodes(ast, ts.isImportDeclaration).filter(node =>
    ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === './ContextMenu');
  const bindings = imports.flatMap(node => {
    const named = node.importClause?.namedBindings;
    return named && ts.isNamedImports(named) ? [...named.elements] : [];
  }).filter(node => (node.propertyName?.text ?? node.name.text) === 'ContextMenu' && !node.isTypeOnly);
  assert.equal(bindings.length, 1, 'страж ищет настоящий импорт ContextMenu, не одноимённую заглушку');
  const owners = nodes(ast, ts.isFunctionDeclaration).filter(node => node.name?.text === site.owner);
  assert.equal(owners.length, 1, `найден именно вход меню ${site.owner}`);
  const menus = nodes(owners[0]!, ts.isJsxOpeningElement).filter(node =>
    ts.isIdentifier(node.tagName) && node.tagName.text === bindings[0]!.name.text &&
    node.attributes.properties.some(attr => {
      if (!ts.isJsxAttribute(attr) || attr.name.getText(ast) !== 'pos') return false;
      const initializer = attr.initializer;
      return initializer && ts.isJsxExpression(initializer) && initializer.expression &&
        nodes(initializer.expression, ts.isIdentifier).some(id => id.text === site.position);
    }));
  assert.equal(menus.length, 1, `проверяется меню ${site.label}, а не соседнее меню уведомлений`);
  const fit = menus[0]!.attributes.properties.filter(attr =>
    ts.isJsxAttribute(attr) && attr.name.getText(ast) === 'fit') as ts.JsxAttribute[];
  return { ast, fit };
}

function checkFit(source: string, site: Site) {
  const { fit } = menuAt(source, site);
  assert.equal(fit.length, 1, `${site.label}: размер меню подстраивается под крупный шрифт`);
  const initializer = fit[0]!.initializer;
  assert.ok(!initializer || (ts.isJsxExpression(initializer) &&
    initializer.expression?.kind === ts.SyntaxKind.TrueKeyword), `${site.label}: fit включён, не false`);
}

const sites: Site[] = [
  { file: 'DmChatView.tsx', owner: 'DmChatView', position: 'moreAt', label: 'меню ⋮ шапки беседы' },
  { file: 'DmRowMenu.tsx', owner: 'useDmListMenu', position: 'pos', label: 'меню списка бесед' },
  { file: 'DmRowMenu.tsx', owner: 'useDmRowMenu', position: 'pos', label: 'меню строки беседы' },
  { file: 'DmRowMenu.tsx', owner: 'DmPickHead', position: 'moreAt', label: 'меню ⋯ выбранных бесед' },
];

for (const site of sites) {
  it(`R124 ${site.label} включает fit — длинные пункты не обрезаются фиксированной шириной`, () => {
    // Один исправленный вход не спасает остальные: каждый вызов ContextMenu обязан включать подгонку.
    const raw = readFileSync(new URL(`./${site.file}`, import.meta.url), 'utf8');
    checkFit(raw, site);
    const { ast, fit } = menuAt(raw, site);
    const attr = fit[0]!;
    const start = attr.getStart(ast);
    const end = attr.getEnd();
    for (const replacement of ['', 'fit={false}']) {
      const mutant = raw.slice(0, start) + replacement + raw.slice(end);
      assert.notEqual(mutant, raw, 'контрфакт действительно меняет выбранный JSX-вызов');
      assert.throws(() => checkFit(mutant, site), assert.AssertionError,
        `${site.label}: снятие или выключение fit замечено стражем`);
    }
  });
}
