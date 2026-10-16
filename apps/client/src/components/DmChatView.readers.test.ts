import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const original = readFileSync(new URL('./DmChatView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function descendants(node: ts.Node): ts.Node[] {
  const out = [node]; ts.forEachChild(node, child => { out.push(...descendants(child)); }); return out;
}
function sourceTree(raw: string) {
  const file = ts.createSourceFile('DmChatView.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'DmChatView') as ts.FunctionDeclaration;
  assert.ok(fn?.body, 'настоящая функция DmChatView найдена'); return { file, fn };
}
function expr(node: ts.Node | undefined): string {
  if (!node) return 'missing';
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${expr(node.expression)}.${expr(node.name)}`;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return `!${expr(node.operand)}`;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return `${expr(node.left)}&&${expr(node.right)}`;
  if (ts.isConditionalExpression(node)) return `${expr(node.condition)}?${expr(node.whenTrue)}:${expr(node.whenFalse)}`;
  if (node.kind === ts.SyntaxKind.NullKeyword) return 'null';
  return ts.SyntaxKind[node.kind];
}
function prop(raw: string, name: string) {
  const { fn } = sourceTree(raw);
  const returns = fn.body!.statements.filter(ts.isReturnStatement);
  const panes = returns.flatMap(n => n.expression ? descendants(n.expression) : [])
    .filter(n => (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && ts.isIdentifier(n.tagName) && n.tagName.text === 'MessagePane') as Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement>;
  assert.equal(panes.length, 1, 'один MessagePane в настоящем return DmChatView');
  const attr = panes[0].attributes.properties.find(n => ts.isJsxAttribute(n) && n.name.getText() === name) as ts.JsxAttribute;
  assert.ok(attr && attr.initializer && ts.isJsxExpression(attr.initializer), `исполняемый JSX prop ${name}`);
  return expr((attr.initializer as ts.JsxExpression).expression);
}
function changed(anchor: string, to: string) {
  assert.equal(original.split(anchor).length - 1, 1, 'R239-dm-anchor: единственный якорь'); return original.replace(anchor, to);
}
function killed(prefix: string, actual: string, expected: string) {
  return (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(prefix) && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected;
}
const readAt = 'lastSeenOn&&!saved&&!group?dm.id:null';
const readers = 'readersOn&&group&&!saved?dm.id:null';
test('R239 JSX 1:1 read-at исключает группу и Избранное, readers включён только у поддержанной группы', () => {
  assert.equal(prop(original, 'readAtConvId'), readAt); assert.equal(prop(original, 'readersConvId'), readers);
});
for (const [name, attribute, anchor, replacement, actual, expected] of [
  ['группа не вызывает ручку read-at', 'readAtConvId', 'lastSeenOn && !saved && !group ? dm.id : null', 'lastSeenOn && !saved ? dm.id : null', 'lastSeenOn&&!saved?dm.id:null', readAt],
  ['readers не попадает в 1:1', 'readersConvId', 'readersOn && group && !saved ? dm.id : null', 'readersOn && !saved ? dm.id : null', 'readersOn&&!saved?dm.id:null', readers],
  ['readers не попадает в Избранное', 'readersConvId', 'readersOn && group && !saved ? dm.id : null', 'readersOn && group ? dm.id : null', 'readersOn&&group?dm.id:null', readers],
  ['без readers1 prop отсутствует', 'readersConvId', 'readersOn && group && !saved ? dm.id : null', 'group && !saved ? dm.id : null', 'group&&!saved?dm.id:null', readers],
] as const) test(`R239 проводка DmChatView: ${name}, соответствующий мутант обнаруживается AST`, () => {
  const oracle = (raw: string) => assert.equal(prop(raw, attribute), expected, 'R239-dm-gate: реальный JSX gate');
  oracle(original); assert.throws(() => oracle(changed(anchor, replacement)), killed('R239-dm-gate:', actual, expected));
});
function featureBinding(raw: string) {
  const { fn } = sourceTree(raw);
  const decl = descendants(fn.body!).find(n => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'readersOn') as ts.VariableDeclaration;
  const init = decl.initializer;
  if (!init || !ts.isCallExpression(init) || expr(init.expression) !== 'useStore') return false;
  const select = init.arguments[0];
  if (!select || !ts.isArrowFunction(select) || !ts.isCallExpression(select.body)) return false;
  return expr(select.body.expression) === 'serverReaders' && expr(select.body.arguments[0]) === 's.serverFeatures';
}
test('R239 readersOn получает текущие serverFeatures через useStore, постоянное true обнаруживается', () => {
  const oracle = (raw: string) => assert.equal(featureBinding(raw), true, 'R239-dm-feature: признак берётся с текущего сервера');
  oracle(original);
  assert.throws(() => oracle(changed('const readersOn = useStore((s) => serverReaders(s.serverFeatures));', 'const readersOn = true;')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith('R239-dm-feature:') && e.operator === 'strictEqual' && e.actual === false && e.expected === true);
});
