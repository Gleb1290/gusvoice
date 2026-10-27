import assert from 'node:assert/strict';
import { it } from 'node:test';
import ts from 'typescript';
import { mutate, sourceOf } from './R171.phoneHarness';

const source = sourceOf('VoiceControls');
function nodes(root: ts.Node, predicate: (n: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = [];
  function visit(n: ts.Node) { if (predicate(n)) result.push(n); ts.forEachChild(n, visit); }
  visit(root); return result;
}
function functionOf(raw: string, name: string) {
  const file = ts.createSourceFile('VoiceControls.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = nodes(file, n => ts.isFunctionDeclaration(n) && n.name?.text === name) as ts.FunctionDeclaration[];
  assert.equal(found.length, 1, `одна функция ${name}`); return { file, fn: found[0] };
}
function shellGuard(raw: string) {
  const { file, fn } = functionOf(raw, 'showFocusedWindow');
  const guards = nodes(fn, n => ts.isIfStatement(n) && n.expression.getText(file) === 'fg.isShell') as ts.IfStatement[];
  assert.equal(guards.length, 1, 'окно оболочки получает отдельный запрет');
  const guard = guards[0]; assert.equal(ts.isBlock(guard.thenStatement), true);
  const statements = (guard.thenStatement as ts.Block).statements;
  assert.equal(statements.some(n => ts.isReturnStatement(n)), true, 'запрет безусловно выходит до смены');
  assert.equal(nodes(guard.thenStatement, n => ts.isCallExpression(n) && n.expression.getText(file) === 'toast').length, 1);
  const switches = nodes(fn, n => ts.isCallExpression(n) && n.expression.getText(file) === 'switchNativeSource');
  assert.equal(switches.length, 1, 'обычное окно по-прежнему переключается');
  assert.equal(guard.end < switches[0].pos, true, 'оболочка отсеивается до смены');
  assert.equal(nodes(guard.thenStatement, n => ts.isCallExpression(n) && n.expression.getText(file) === 'switchNativeSource').length, 0);
}
function browserStart(raw: string) {
  const { file, fn } = functionOf(raw, 'startShare');
  const calls = nodes(fn, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === 'setScreenShareEnabled') as ts.CallExpression[];
  const start = calls.filter(n => n.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword);
  assert.equal(start.length, 1, 'один путь включения браузерного захвата');
  const options = start[0].arguments[1];
  assert.equal(ts.isCallExpression(options) && options.expression.getText(file) === 'webCaptureOptions', true,
    'браузерный старт получает webCaptureOptions');
}
it('R304 хоткей окна в фокусе отказывает оболочке до вызова смены', () => { shellGuard(source); });
it('R304 браузерный старт использует webCaptureOptions, а не нативную форму', () => { browserStart(source); });
for (const [title, anchor, replacement, check] of [
  ['пропуск fg.isShell', 'if (fg.isShell)', 'if (false)', shellGuard],
  ['нативные опции браузеру', 'webCaptureOptions({ ...s, audio })', 'captureOptions({ ...s, audio })', browserStart],
] as const) it(`R304 контрфакт VoiceControls: ${title} отвергается AST-стражем`, () => {
  check(source); assert.throws(() => check(mutate(source, anchor, replacement)), assert.AssertionError);
});
