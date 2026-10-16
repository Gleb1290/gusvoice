import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const original = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function all(node: ts.Node): ts.Node[] { const out = [node]; ts.forEachChild(node, child => { out.push(...all(child)); }); return out; }
function text(node: ts.Node | undefined): string {
  if (!node) return 'missing';
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${text(node.expression)}.${text(node.name)}`;
  if (ts.isStringLiteral(node)) return JSON.stringify(node.text);
  if (ts.isShorthandPropertyAssignment(node)) return text(node.name);
  if (ts.isPropertyAssignment(node)) return `${text(node.name)}:${text(node.initializer)}`;
  if (ts.isObjectLiteralExpression(node)) return `{${node.properties.map(text).join(',')}}`;
  if (ts.isCallExpression(node)) return `${text(node.expression)}(${node.arguments.map(text).join(',')})`;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return `${text(node.left)}&&${text(node.right)}`;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  return ts.SyntaxKind[node.kind];
}
function tree(raw: string) {
  const file = ts.createSourceFile('MessagePane.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const pane = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'MessagePane') as ts.FunctionDeclaration;
  assert.ok(pane?.body, 'исполняемая функция MessagePane найдена'); return { pane, nodes: all(pane.body) };
}
function attr(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): ts.Expression | undefined {
  const value = node.attributes.properties.find(n => ts.isJsxAttribute(n) && n.name.getText() === name) as ts.JsxAttribute;
  if (!value?.initializer) return undefined;
  return ts.isJsxExpression(value.initializer) ? value.initializer.expression : value.initializer;
}
function jsx(nodes: ts.Node[], tag: string) {
  return nodes.filter(n => (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && text(n.tagName) === tag) as Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement>;
}
function variable(nodes: ts.Node[], name: string): ts.VariableDeclaration {
  const found = nodes.filter(n => ts.isVariableDeclaration(n) && text(n.name) === name) as ts.VariableDeclaration[];
  assert.equal(found.length, 1, `единственная исполняемая переменная ${name}`); return found[0];
}
function changed(from: string, to: string) { assert.equal(original.split(from).length - 1, 1, 'R239-pane-anchor: единственный якорь'); return original.replace(from, to); }
function killed(prefix: string, actual: unknown, expected: unknown) {
  return (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(prefix) && e.operator === 'strictEqual' && Object.is(e.actual, actual) && Object.is(e.expected, expected);
}
const gate = 'readersConvId&&readersLineShown({mine,read,createdAt:m.createdAt,now:Date.now()})';
function menu(raw: string) {
  const { nodes } = tree(raw), declaration = variable(nodes, 'readers');
  assert.ok(declaration.initializer && ts.isConditionalExpression(declaration.initializer));
  const init = declaration.initializer;
  const lines = jsx(all(init.whenTrue), 'ReadersLine'); assert.equal(lines.length, 1);
  return { declaration, init, line: lines[0] };
}
for (const [name, from, to, actual] of [
  ['чужое сообщение не выдаётся за своё', 'readersLineShown({ mine, read, createdAt: m.createdAt, now: Date.now() })', 'readersLineShown({ mine: true, read, createdAt: m.createdAt, now: Date.now() })', 'readersConvId&&readersLineShown({mine:true,read,createdAt:m.createdAt,now:Date.now()})'],
  ['непрочитанное не выдаётся за прочитанное', 'readersLineShown({ mine, read, createdAt: m.createdAt, now: Date.now() })', 'readersLineShown({ mine, read: true, createdAt: m.createdAt, now: Date.now() })', 'readersConvId&&readersLineShown({mine,read:true,createdAt:m.createdAt,now:Date.now()})'],
] as const) test(`R239 MessagePane: ${name}, подмена входа чистого правила обнаруживается`, () => {
  const oracle = (raw: string) => assert.equal(text(menu(raw).init.condition), gate, 'R239-pane-gate: переданы настоящие mine/read/createdAt');
  oracle(original); assert.throws(() => oracle(changed(from, to)), killed('R239-pane-gate:', actual, gate));
});
test('R239 ReadersLine получает id беседы/сообщения и lookup ленты, результат действительно вставлен в return меню', () => {
  const { declaration, init, line } = menu(original);
  assert.equal(text(attr(line, 'convId')), 'readersConvId'); assert.equal(text(attr(line, 'messageId')), 'm.id'); assert.equal(text(attr(line, 'lookup')), 'reactorOf');
  assert.equal(init.whenFalse.kind, ts.SyntaxKind.NullKeyword);
  const block = declaration.parent.parent.parent; assert.equal(ts.isBlock(block), true);
  assert.equal(all(block).some(n => ts.isReturnStatement(n) && !!n.expression && all(n.expression).some(x => ts.isJsxExpression(x) && text(x.expression) === 'readers')), true);
});
function openContract(raw: string) {
  const handler = attr(menu(raw).line, 'onOpen'); assert.ok(handler && ts.isArrowFunction(handler));
  const nodes = all(handler.body), calls = nodes.filter(ts.isCallExpression);
  const close = calls.find(n => text(n.expression) === 'close');
  const set = calls.find(n => text(n.expression) === 'setSeen');
  return !!close && !!set && close.pos < set.pos && text(handler.parameters[0]?.name) === 'list' &&
    all(set).filter(ts.isObjectLiteralExpression).length === 2 &&
    all(set).filter(ts.isShorthandPropertyAssignment).filter(n => text(n.name) === 'list').length === 2 &&
    all(set).filter(ts.isPropertyAssignment).filter(n => text(n.name) === 'id' && text(n.initializer) === 'm.id').length === 2 &&
    all(set).some(n => ts.isPropertyAssignment(n) && text(n.name) === 'anchor' && text(n.initializer) === 'spot.anchor') &&
    all(set).some(n => ts.isPropertyAssignment(n) && text(n.name) === 'pos' && text(n.initializer) === 'msgMenu.pos');
}
test('R239 onOpen закрывает меню и переносит полный list в seen с якорем либо позицией; потеря списка ловится', () => {
  const oracle = (raw: string) => assert.equal(openContract(raw), true, 'R239-pane-open: сохранён список и положение окна');
  oracle(original); assert.throws(() => oracle(changed('setSeen(spot ? { id: m.id, list, anchor: spot.anchor } : { id: m.id, list, pos: msgMenu.pos });', 'setSeen(spot ? { id: m.id, list: [], anchor: spot.anchor } : { id: m.id, list: [], pos: msgMenu.pos });')), killed('R239-pane-open:', false, true));
});
function dialog(raw: string) {
  const { nodes } = tree(raw);
  const head = jsx(nodes, 'span').find(n => text(attr(n, 'className')) === '"who-count"' && all(n.parent).some(x => ts.isJsxExpression(x) && text(x.expression) === 'seen.list.length'));
  // Блок окна отличаем от другого who-count (реакции) по живому seen.list.length, не по комментарию.
  assert.ok(head, 'шапка окна читателей найдена');
  let arrow: ts.Node = head;
  while (arrow.parent && !ts.isArrowFunction(arrow)) arrow = arrow.parent;
  assert.ok(ts.isArrowFunction(arrow) && ts.isBlock(arrow.body));
  return { arrow, nodes: all(arrow.body), head };
}
test('R239 окно читателей реально содержит «прочитали N» и возвращает rows в ContextMenu обоими способами', () => {
  const { arrow, nodes, head } = dialog(original);
  assert.equal(all(head.parent).some(n => ts.isJsxText(n) && n.text.trim() === 'прочитали'), true);
  const bs = jsx(all(head.parent), 'b'); assert.equal(bs.length, 1);
  assert.equal(all(bs[0].parent).some(n => ts.isJsxExpression(n) && text(n.expression) === 'seen.list.length'), true);
  const returns = nodes.filter(ts.isReturnStatement).filter(n => n.expression && ts.isConditionalExpression(n.expression)); assert.equal(returns.length, 1);
  const returned = returns[0].expression!;
  assert.equal(jsx(all(returned), 'ContextMenu').length, 2);
  assert.equal(all(returned).filter(n => ts.isJsxExpression(n) && text(n.expression) === 'rows').length, 2);
  let parent: ts.Node = arrow;
  while (parent.parent && !ts.isBinaryExpression(parent)) parent = parent.parent;
  assert.ok(ts.isBinaryExpression(parent)); assert.equal(text(parent.left), 'seen');
});
function profileContract(raw: string) {
  const { nodes } = dialog(raw);
  const row = jsx(nodes, 'button').find(n => text(attr(n, 'className')) === '"ctx-item who-row"');
  if (!row) return false;
  const handler = attr(row, 'onClick'); if (!handler || !ts.isArrowFunction(handler)) return false;
  const calls = all(handler.body).filter(ts.isCallExpression);
  const close = calls.find(n => text(n.expression) === 'close'), open = calls.find(n => text(n.expression) === 'openUserMenu');
  return !!close && !!open && close.pos < open.pos && text(open) === 'openUserMenu(e,{userId:r.userId,name:look.name,avatarUrl:look.avatarUrl},"profile")';
}
test('R239 нажатие читателя закрывает окно и открывает его профиль с именем и аватаром, иной режим ловится', () => {
  const oracle = (raw: string) => assert.equal(profileContract(raw), true, 'R239-pane-profile: строка открывает профиль своего читателя');
  oracle(original); assert.throws(() => oracle(changed("openUserMenu(e, { userId: r.userId, name: look.name, avatarUrl: look.avatarUrl }, 'profile');", "openUserMenu(e, { userId: r.userId, name: look.name, avatarUrl: look.avatarUrl }, 'user');")), killed('R239-pane-profile:', false, true));
});
function reactionContract(raw: string) {
  const { nodes } = dialog(raw);
  const emoji = variable(nodes, 'emoji');
  const rendering = nodes.filter(ts.isConditionalExpression).find(n => text(n.condition) === 'emoji');
  return text(emoji.initializer) === 'reactionOf.get(r.userId)' && !!rendering &&
    all(rendering.whenTrue).some(n => ts.isCallExpression(n) && text(n) === 'renderReaction(emoji,emojiById)') &&
    nodes.some(n => ts.isCallExpression(n) && text(n) === 'reactionOf.set(p.userId,r.emoji)') &&
    nodes.some(n => ts.isForOfStatement(n) && all(n.expression).some(x => text(x) === 'm.reactions')) &&
    nodes.some(n => ts.isForOfStatement(n) && all(n.expression).some(x => text(x) === 'r.reactors'));
}
test('R239 реакция читателя берётся по его id из реакций сообщения и рисуется справа; потеря связи ловится', () => {
  const oracle = (raw: string) => assert.equal(reactionContract(raw), true, 'R239-pane-reaction: реакция принадлежит показанному читателю');
  oracle(original); assert.throws(() => oracle(changed('const emoji = reactionOf.get(r.userId);', 'const emoji = undefined;')), killed('R239-pane-reaction:', false, true));
});
