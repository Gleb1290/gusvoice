import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function tree(raw: string) { return ts.createSourceFile('MessagePane.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
function nodes(ast: ts.Node, predicate: (node: ts.Node) => boolean) {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) out.push(node); ts.forEachChild(node, visit); };
  visit(ast); return out;
}
function classOf(node: ts.Node): string | undefined {
  const attrs = ts.isJsxElement(node) ? node.openingElement.attributes : ts.isJsxSelfClosingElement(node) ? node.attributes : null;
  const attr = attrs?.properties.find(p => ts.isJsxAttribute(p) && p.name.getText() === 'className');
  return attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isStringLiteral(attr.initializer) ? attr.initializer.text : undefined;
}
function circleGuard(raw: string) {
  const ast = tree(raw); const circles = nodes(ast, n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(ast) === 'RecordCircle');
  assert.equal(circles.length, 1, 'один круг, не два перекрывающихся слоя');
  const circle = circles[0] as ts.JsxSelfClosingElement;
  // R176: компонент остаётся смонтированным, чтобы доиграть уход; hold управляет самим холстом.
  assert.equal(classOf(circle.parent), 'mic-btn', 'круг не снимается условием holdUi раньше окончания ухода');
  const props = new Map(circle.attributes.properties.filter(ts.isJsxAttribute).map(attr => [
    attr.name.getText(ast), attr.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression?.getText(ast) : undefined,
  ]));
  assert.equal(props.get('hold'), '!!holdUi', 'удержание передано настоящему компоненту');
  assert.equal(props.get('level'), 'Math.min(1, recLevel * 1.6)', 'громкость ограничена единицей до передачи холсту');
  assert.equal(props.get('slide'), 'holdUi ? voiceHoldProgress(holdUi.dx, holdUi.dy, voiceCancelPath(window.innerWidth)).cancel : 0');
  assert.equal(props.get('recording'), 'recording', 'продолжение записи отличает замок от отмены');
  assert.equal(props.get('recBusy'), 'recBusy', 'начавшаяся отправка отличает уход send от cancel');
  let button: ts.Node | undefined = circle.parent;
  while (button && classOf(button) !== 'mic-btn') button = button.parent;
  assert.equal(!!button && ts.isJsxElement(button) && button.openingElement.tagName.getText(ast) === 'button', true,
    'круг следует за той же кнопкой микрофона, не лежит отдельно в форме');
}
it('R176 круг внутри микрофона получает удержание громкость и вид ухода, не снимается раньше анимации', () => {
  // Отдельный круг отстаёт от пальца; условный mount по holdUi срывает окончание отправки/отмены.
  circleGuard(source);
  for (const [from, to] of [
    ['hold={!!holdUi}', 'hold={true}'],
    ['level={Math.min(1, recLevel * 1.6)}', 'level={recLevel * 1.6}'],
    ['recording={recording}\n              recBusy={recBusy}', 'recording={false}\n              recBusy={false}'],
  ]) {
    assert.equal(source.split(from).length - 1, 1);
    assert.throws(() => circleGuard(source.replace(from, to)), assert.AssertionError);
  }
});
function labelGuard(raw: string) {
  const ast = tree(raw);
  const text = nodes(ast, ts.isJsxText).map(n => (n as ts.JsxText).text).join(' ');
  assert.doesNotMatch(text, /Вверх — продолжать запись/);
  assert.match(text, /Влево — отмена/);
  assert.equal(nodes(ast, n => classOf(n) === 'rec-lock-hint').length, 0);
  assert.equal(nodes(ast, n => classOf(n) === 'rec-lock').length, 1, 'сам замок не исчез при удалении подписи');
}
it('R169 замок остаётся без лишней подписи вверх, подсказка отмены влево сохранена', () => {
  // Проверяем только пользовательский JSX-текст: комментарий с названием удалённой подписи не считается интерфейсом.
  labelGuard(source);
  const from = 'Влево — отмена'; assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => labelGuard(source.replace(from, 'Вверх — продолжать запись')), assert.AssertionError);
  const anchor = 'className="rec-lock"'; assert.equal(source.split(anchor).length - 1, 1);
  assert.throws(() => labelGuard(source.replace(anchor, 'className="rec-lock-hint"')), assert.AssertionError);
});
it('R169 вынесенный за пределы кнопки круг обнаруживается структурой JSX', () => {
  // Наличие правильного класса где-то в исходнике не доказывает, что круг движется вместе с кнопкой.
  circleGuard(source);
  const ast = tree(source);
  const circle = nodes(ast, n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(ast) === 'RecordCircle')[0];
  const anchor = circle.getText(ast);
  assert.equal(source.split(anchor).length - 1, 1);
  const end = '      </form>'; assert.equal(source.split(end).length - 1, 1);
  const moved = source.replace(anchor, '').replace(end, `${anchor}\n${end}`);
  assert.throws(() => circleGuard(moved), assert.AssertionError);
});
