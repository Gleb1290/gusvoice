import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';
import { fedPeerDown, fedPeerDownText } from './convSyncRules';

it('R217 сервер молчит только при буквальном fedPeerDown=true, без поля и с мусором плашки нет', () => {
  assert.equal(fedPeerDown({ fedPeerDown: true }), true);
  for (const value of [undefined, null, false, 0, 1, 'true', 'yes']) assert.equal(fedPeerDown({ fedPeerDown: value }), false);
  assert.equal(fedPeerDown(null), false); assert.equal(fedPeerDown(undefined), false); assert.equal(fedPeerDown({}), false);
});
it('R217 текст недоступного дома использует название, без него объясняет ожидание без пустых кавычек', () => {
  assert.equal(fedPeerDownText('Сосед'), 'Инстанс «Сосед» недоступен — сообщения доедут, когда он вернётся');
  for (const name of ['', null, undefined]) assert.equal(fedPeerDownText(name), 'Инстанс собеседника недоступен — сообщения доедут, когда он вернётся');
});

const source = readFileSync(new URL('./components/DmChatView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function paneProps(raw: string) {
  const tree = ts.createSourceFile('DmChatView.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: ts.JsxAttributes[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(tree) === 'MessagePane') matches.push(node.attributes);
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.equal(matches.length, 1, 'проверяется единственный реальный MessagePane, а не строка в комментарии');
  const prop = (name: string) => {
    const attrs = matches[0]!.properties.filter((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(tree) === name);
    assert.equal(attrs.length, 1, `один ${name} у ленты`);
    const value = attrs[0]!.initializer;
    assert.ok(value && ts.isJsxExpression(value) && value.expression);
    return value.expression;
  };
  return { tree, prop };
}
function notice(raw = source) {
  const { tree, prop } = paneProps(raw), expr = prop('composerNotice');
  assert.ok(ts.isConditionalExpression(expr));
  assert.equal(expr.condition.getText(tree), 'peerDown && !linkBroken', 'R217-notice-priority: архив важнее недоступности');
  const hasTextCall = (branch: ts.Node, name: string) => {
    let count = 0;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name
        && n.arguments.length === 1 && n.arguments[0]!.getText(tree) === 'peerHomeLabel') count++;
      ts.forEachChild(n, visit);
    };
    visit(branch); return count;
  };
  assert.equal(hasTextCall(expr.whenTrue, 'fedPeerDownText'), 1, 'R217-down-text: ветка вызывает настоящий текст, комментарий не считается');
  const tail = expr.whenFalse; assert.ok(ts.isConditionalExpression(tail));
  assert.equal(tail.condition.getText(tree), 'linkStale && !linkBroken', 'ожидание очереди идёт после недоступности');
  assert.equal(hasTextCall(tail.whenTrue, 'fedLinkStaleText'), 1, 'ожидание очереди вызывает свой настоящий текст');
}
function replacement(raw = source) {
  const { tree, prop } = paneProps(raw), expr = prop('composerReplacement');
  assert.ok(ts.isConditionalExpression(expr)); assert.equal(expr.condition.getText(tree), 'former');
  const archive = expr.whenFalse; assert.ok(ts.isConditionalExpression(archive));
  assert.equal(archive.condition.getText(tree), 'linkBroken', 'R217-composer-open: поле заменяет архив, но не временный down');
  const text = expr.getText(tree);
  assert.equal(/\b(peerDown|linkStale)\b/.test(text), false, 'плашки ожидания не подменяют ввод');
}
it('R217 AST плашек: архив важнее недоступности, недоступность важнее очереди', () => notice());
it('R217 AST поля ввода: недоступный сосед остаётся notice, архив становится replacement', () => replacement());
for (const [label, from, to, check, prefix, actual, expected] of [
  ['архив не скрывает down', 'peerDown && !linkBroken ? (', 'peerDown ? (', notice, 'R217-notice-priority:', 'peerDown', 'peerDown && !linkBroken'],
  ['down закрывает поле', ') : linkBroken ? (', ') : peerDown ? (', replacement, 'R217-composer-open:', 'peerDown', 'linkBroken'],
  ['текст заменён комментарием', '{fedPeerDownText(peerHomeLabel)}', '{/* fedPeerDownText(peerHomeLabel) */}', notice, 'R217-down-text:', 0, 1],
] as const) it(`R217 контрфакт проводки плашки: ${label}`, () => {
  check(source); assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => check(source.replace(from, to)), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});
