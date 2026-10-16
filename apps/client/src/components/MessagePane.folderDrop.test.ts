import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function all<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  function visit(node: ts.Node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(root); return found;
}
function ref(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) { const base = ref(node.expression); return base ? `${base}.${node.name.text}` : null; }
  return null;
}
function call(node: ts.Node | undefined, name: string, args?: string[]): node is ts.CallExpression {
  return !!node && ts.isCallExpression(node) && ref(node.expression) === name && (!args || node.arguments.length === args.length && args.every((arg, i) => ref(node.arguments[i]) === arg));
}
function binary(node: ts.Node | undefined, operator: ts.SyntaxKind, left: string, right: string) {
  return !!node && ts.isBinaryExpression(node) && node.operatorToken.kind === operator && ref(node.left) === left && ref(node.right) === right;
}
function one(statements: readonly ts.Statement[], predicate: (node: ts.Statement) => boolean, label: string) {
  const found = statements.filter(predicate); assert.equal(found.length, 1, label); return found[0]!;
}
function single(statement: ts.Statement | undefined) {
  if (statement && ts.isBlock(statement)) return statement.statements.length === 1 ? statement.statements[0] : undefined;
  return statement;
}
function effect(statement: ts.Statement | undefined) { const node = single(statement); return node && ts.isExpressionStatement(node) ? node.expression : undefined; }
function parse(raw: string) {
  const file = ts.createSourceFile('MessagePane.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const pane = file.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'MessagePane');
  assert.equal(!!pane?.body, true, 'компонент MessagePane найден целиком');
  const drops = all(pane!.body!, ts.isJsxAttribute).filter(attribute => attribute.name.getText(file) === 'onDrop' && ts.isJsxOpeningElement(attribute.parent.parent)
    && attribute.parent.properties.some(property => ts.isJsxAttribute(property) && property.name.getText(file) === 'className'
      && !!property.initializer && ts.isJsxExpression(property.initializer) && !!property.initializer.expression
      && ts.isTemplateExpression(property.initializer.expression) && property.initializer.expression.head.text.startsWith('chat')));
  assert.equal(drops.length, 1, 'единственный onDrop корневой ленты .chat');
  const initializer = drops[0]!.initializer;
  assert.equal(!!initializer && ts.isJsxExpression(initializer) && !!initializer.expression && ts.isArrowFunction(initializer.expression), true, 'onDrop является настоящей JSX-стрелкой');
  const handler = (initializer as ts.JsxExpression).expression as ts.ArrowFunction;
  assert.equal(ts.isBlock(handler.body), true, 'onDrop содержит блок обработчика');
  const statements = (handler.body as ts.Block).statements;
  const declarations = (name: string) => statements.flatMap(statement => ts.isVariableStatement(statement) ? Array.from(statement.declarationList.declarations).filter(d => ref(d.name) === name) : []);
  const got = declarations('got'); assert.equal(got.length, 1, 'один результат получения брошенных файлов');
  const sync = one(statements, statement => ts.isIfStatement(statement) && call(statement.expression, 'Array.isArray', ['got']), 'одна синхронная ветка списка файлов') as ts.IfStatement;
  return { file, pane: pane!, handler, declarations, got: got[0]!, sync };
}
function synchronous(raw: string) {
  const { handler, got, sync } = parse(raw);
  assert.equal(!handler.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword), true, 'drop обычных файлов не превращается в async handler');
  assert.equal(!!got.initializer && ts.isConditionalExpression(got.initializer) && call(got.initializer.whenFalse, 'collectDrop', ['e.dataTransfer']), true,
    'обычный drop получает список из настоящего collectDrop сразу');
  const direct = effect(sync.thenStatement);
  assert.equal(call(direct, 'addFiles') && ref(direct.arguments[0]) === 'got', true, 'список файлов добавляется прямым синхронным вызовом');
  assert.equal(all(sync.thenStatement, ts.isAwaitExpression).length, 0);
  assert.equal(all(sync.thenStatement, ts.isArrowFunction).length, 0, 'в синхронной ветке нет отложенного callback');
}
function blocked(raw: string) {
  const { got } = parse(raw), initializer = got.initializer;
  assert.equal(!!initializer && ts.isConditionalExpression(initializer), true, 'выбор drop-коллектора сделан до его вызова');
  const branch = initializer as ts.ConditionalExpression;
  assert.equal(binary(branch.condition, ts.SyntaxKind.BarBarToken, 'filesBlocked', 'composerEdit'), true, 'запрет файлов и правка обходят упаковку вместе');
  assert.equal(call(branch.whenTrue, 'Array.from', ['e.dataTransfer.files']), true, 'запрет или правка берут обычные DataTransfer.files');
  assert.equal(all(branch.whenTrue, ts.isCallExpression).filter(c => ref(c.expression) === 'collectDrop').length, 0, 'запрет или правка не запускают collectDrop');
  assert.equal(call(branch.whenFalse, 'collectDrop', ['e.dataTransfer']), true);
}
function currentFeed(raw: string) {
  const { pane } = parse(raw), statements = pane.body!.statements;
  const refs = statements.flatMap(statement => ts.isVariableStatement(statement) ? Array.from(statement.declarationList.declarations).filter(d => ref(d.name) === 'feedNow') : []);
  assert.equal(refs.length, 1); assert.equal(call(refs[0]!.initializer, 'useRef', ['feedId']), true, 'feed ref начинается с текущей беседы');
  const assignments = statements.filter(statement => ts.isExpressionStatement(statement) && binary(statement.expression, ts.SyntaxKind.EqualsToken, 'feedNow.current', 'feedId'));
  assert.equal(assignments.length, 1, 'feed ref обновляется безусловно в каждом рендере');
  assert.equal(assignments[0]!.pos > refs[0]!.pos, true);
}
function asynchronous(raw: string) {
  const { sync, declarations } = parse(raw), captures = declarations('dropFeed');
  assert.equal(captures.length, 1); assert.equal(ref(captures[0]!.initializer), 'feedId', 'drop сохраняет беседу до ожидания ZIP');
  assert.equal(captures[0]!.pos < sync.pos, true);
  const delayed = effect(sync.elseStatement);
  assert.equal(!!delayed && ts.isVoidExpression(delayed) && call(delayed.expression, 'got.then'), true, 'только обещание архива обрабатывается через then');
  const then = (delayed as ts.VoidExpression).expression as ts.CallExpression;
  assert.equal(then.arguments.length, 1); const callback = then.arguments[0]!;
  assert.equal(ts.isArrowFunction(callback) && ts.isBlock(callback.body), true);
  const arrow = callback as ts.ArrowFunction;
  assert.equal(arrow.parameters.length, 1); assert.equal(ref(arrow.parameters[0]!.name), 'zip');
  const gate = single((arrow.body as ts.Block).statements[0]);
  assert.equal((arrow.body as ts.Block).statements.length, 1); assert.equal(!!gate && ts.isIfStatement(gate), true);
  const condition = gate as ts.IfStatement;
  assert.equal(binary(condition.expression, ts.SyntaxKind.EqualsEqualsEqualsToken, 'feedNow.current', 'dropFeed'), true, 'готовый ZIP проверяет ту же беседу до addFiles');
  const accept = effect(condition.thenStatement);
  assert.equal(call(accept, 'addFiles') && ref(accept.arguments[0]) === 'zip', true);
  const rejected = single(condition.elseStatement);
  assert.equal(!!rejected && ts.isIfStatement(rejected), true);
  const other = rejected as ts.IfStatement;
  assert.equal(ts.isBinaryExpression(other.expression) && ref(other.expression.left) === 'zip.length' && other.expression.operatorToken.kind === ts.SyntaxKind.GreaterThanToken
    && ts.isNumericLiteral(other.expression.right) && other.expression.right.text === '0', true, 'отказ сменившейся беседы молчит при пустом результате');
  const notice = effect(other.thenStatement);
  assert.equal(call(notice, 'toast') && notice.arguments.length === 2 && ts.isStringLiteral(notice.arguments[0]!) && notice.arguments[0]!.text === 'info'
    && ts.isStringLiteral(notice.arguments[1]!) && notice.arguments[1]!.text === 'Архив собран, но беседа уже другая — бросьте папку заново', true,
    'сменившаяся беседа объясняется тостом без добавления файла');
  assert.equal(all(other, ts.isCallExpression).filter(c => ref(c.expression) === 'addFiles').length, 0);
}
// Это структурный страж всего TSX, не исполнение вырезанного handler. Он не претендует на DOM/layout-приёмку.
it('R211 AST целой MessagePane сохраняет синхронное addFiles обычного drop', () => synchronous(source));
it('R211 AST запрета вложений и правки не запускает collectDrop, сохраняя штатный addFiles с тостом', () => blocked(source));
it('R211 AST обновляет feedNow в теле компонента, не в устаревающем эффекте', () => currentFeed(source));
it('R211 AST готового ZIP не добавляет его после смены беседы и объясняет отказ тостом', () => asynchronous(source));

function change(anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь TSX-мутанта папки'); return source.replace(anchor, replacement);
}
function killed(anchor: string, replacement: string, scenario: (raw: string) => void, prefix: string, actual: unknown, expected: unknown) {
  scenario(source);
  assert.throws(() => scenario(change(anchor, replacement)), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
}
it('R211 контрфакт отправляет обычные файлы через очередь вместо синхронного вызова', () => killed(
  'if (Array.isArray(got)) addFiles(got, way ? { way } : undefined);', 'if (Array.isArray(got)) queueMicrotask(() => addFiles(got, way ? { way } : undefined));', synchronous,
  'список файлов добавляется прямым синхронным вызовом', false, true));
it('R211 контрфакт убирает filesBlocked перед упаковкой папки', () => killed(
  'const got = filesBlocked || composerEdit ?', 'const got = composerEdit ?', blocked, 'запрет файлов и правка обходят упаковку вместе', false, true));
it('R211 контрфакт убирает composerEdit перед упаковкой папки', () => killed(
  'const got = filesBlocked || composerEdit ?', 'const got = filesBlocked ?', blocked, 'запрет файлов и правка обходят упаковку вместе', false, true));
it('R211 контрфакт вызывает collectDrop даже при запрете файлов или правке', () => killed(
  'filesBlocked || composerEdit ? Array.from(e.dataTransfer.files) : collectDrop(e.dataTransfer)', 'filesBlocked || composerEdit ? collectDrop(e.dataTransfer) : collectDrop(e.dataTransfer)', blocked,
  'запрет или правка берут обычные DataTransfer.files', false, true));
it('R211 контрфакт теряет обновление feed ref между рендерами', () => killed('feedNow.current = feedId;', '', currentFeed,
  'feed ref обновляется безусловно в каждом рендере', 0, 1));
it('R211 контрфакт убирает сравнение feed после готовности ZIP', () => killed('if (feedNow.current === dropFeed) addFiles(zip,', 'if (true) addFiles(zip,', asynchronous,
  'готовый ZIP проверяет ту же беседу до addFiles', false, true));
it('R211 контрфакт показывает тост и для пустого результата после переключения беседы', () => killed("else if (zip.length > 0) toast('info', 'Архив собран", "else if (true) toast('info', 'Архив собран", asynchronous,
  'отказ сменившейся беседы молчит при пустом результате', false, true));
