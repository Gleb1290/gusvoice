import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const ast = (path: string) => ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
it('R224 основные модули не затягивают MapLibre, стиль и GeoMapLive статическим импортом', () => {
  for (const path of ['./components/ConvMediaCard.tsx', './components/GeoLiveCard.tsx', './components/GeoPickDialog.tsx', './components/GeoPickMap.tsx', './components/MapView.tsx', './geoSystem.ts', './mapSource.ts', './mapRules.ts']) {
    const file = ast(path);
    for (const node of file.statements) {
      if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
      const id = (node.moduleSpecifier as ts.StringLiteral).text;
      assert.equal(/^(?:maplibre-gl(?:\/|$)|(?:\.\.?\/)+mapStyle$|\.\/GeoMapLive$)/.test(id), false, `${path}: тяжёлый ${id} не статический`);
    }
  }
});
it('R231 именно GeoPickMapLazy экспортирует ленивую динамическую загрузку карты окна', () => {
  const file = ast('./geoSystem.ts');
  const exported = file.statements.filter(ts.isVariableStatement).filter(node => node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
  const declarations = exported.flatMap(node => [...node.declarationList.declarations]).filter(node => node.name.getText(file) === 'GeoPickMapLazy');
  assert.equal(declarations.length, 1);
  const value = declarations[0]!.initializer;
  assert.ok(value && ts.isCallExpression(value)); assert.equal(value.expression.getText(file), 'lazy');
  const factory = value.arguments[0]; assert.ok(factory && ts.isArrowFunction(factory) && ts.isCallExpression(factory.body));
  assert.equal(factory.body.expression.kind, ts.SyntaxKind.ImportKeyword);
  assert.equal(factory.body.arguments[0]?.getText(file), "'./components/GeoPickMap'");
});
it('R224 MapView действительно содержит динамические импорты библиотеки и стиля, GeoCard — ленивую карту', () => {
  for (const [path, expected] of [['./components/MapView.tsx', ['maplibre-gl', '../mapStyle']], ['./components/ConvMediaCard.tsx', ['./GeoMapLive']], ['./geoSystem.ts', ['./components/GeoPickMap']]] as const) {
    const file = ast(path), imports: string[] = [];
    function walk(n: ts.Node) { if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) imports.push(n.arguments[0].text); ts.forEachChild(n, walk); }
    walk(file); for (const id of expected) assert.ok(imports.includes(id), `${path}: import(${id})`);
  }
});
it('R224 стиль не содержит внешних URL: плитки и шрифты строятся шаблонами своего API', () => {
  const file = ast('./mapStyle.ts'), strings: string[] = [], calls: string[] = [];
  function walk(n: ts.Node) { if (ts.isStringLiteralLike(n)) strings.push(n.text); if (ts.isCallExpression(n)) calls.push(n.expression.getText(file)); ts.forEachChild(n, walk); }
  walk(file); assert.equal(strings.some(value => /https?:\/\//i.test(value)), false);
  for (const name of ['mapTilesUrlTemplate', 'mapGlyphsUrlTemplate', 'dropSpriteLayers']) assert.ok(calls.includes(name));
});
