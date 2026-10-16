import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// Структурные стражи полного AST. Не выдаём их за касания на живом компоненте:
// измерения DOM, переходы React и hit-testing требуют отдельного браузерного прогона.
function ast(text: string) {
  const sf = ts.createSourceFile('MessagePane.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes: ts.Node[] = []; const visit = (n: ts.Node) => { nodes.push(n); ts.forEachChild(n, visit); }; visit(sf);
  const variable = (name: string) => { const n = nodes.find(n => ts.isVariableDeclaration(n) && n.name.getText(sf) === name) as ts.VariableDeclaration | undefined; assert.ok(n, name); assert.ok(n.initializer, name); return n.initializer.getText(sf); };
  return { sf, nodes, variable };
}
function pair(from: string, to: string, check: (s: string) => void) {
  assert.equal(source.split(from).length - 1, 1, 'мутация однозначна'); check(source);
  assert.throws(() => check(source.replace(from, to)), assert.AssertionError);
}
function phoneBoundary(text: string) {
  const a = ast(text);
  assert.equal(a.variable('exprUnder'), "dockPhone && picker?.kind === 'composer'");
  assert.equal(a.variable('liftExtra'), 'exprUnder ? (exprLift.drag ?? (exprLift.open ? exprLift.max : 0)) : 0');
  assert.equal(a.variable('liftUp'), 'exprUnder && (exprLift.open || exprLift.drag !== null)');
  const styles = a.nodes.filter(ts.isJsxAttribute).filter(n => n.name.getText(a.sf) === 'style').map(n => n.getText(a.sf));
  assert.ok(styles.some(s => s === "style={exprUnder ? ({ '--expr-lift': `${liftExtra}px` } as CSSProperties) : undefined}"));
}
it('AST: телефонная composer-панель единственная получает подъём, expr-up и переменную', () => phoneBoundary(source));
it('AST-контрфакт без проверки телефонной раскладки ловится', () => pair("dockPhone && picker?.kind === 'composer'", "picker?.kind === 'composer'", phoneBoundary));
it('AST: закрытие панели и переход на эмодзи сбрасывают раскрытие одним эффектом', () => {
  const a = ast(source);
  const effects = a.nodes.filter(ts.isCallExpression).filter(n => n.expression.getText(a.sf) === 'useEffect');
  const effect = effects.find(n => n.arguments[1]?.getText(a.sf) === '[exprUnder, exprTab]' && n.arguments[0].getText(a.sf).includes('setExprLift'));
  assert.ok(effect); assert.match(effect.arguments[0].getText(a.sf), /if \(!exprUnder \|\| exprTab === 'emoji'\) setExprLift\(\(l\) => \(l === LIFT_NONE \? l : LIFT_NONE\)\)/);
  assert.match(source, /exprLift\.drag !== null \? ' expr-dragging' : ''/);
  // expr-dragging напрямую не gated exprUnder: гарантия здесь — сброс состояния эффектом.
});
it('AST: протяжка начинается только одним пальцем за поиск или вкладки, стикеры берутся из трёх источников', () => {
  const body = ast(source).variable('onLiftStart');
  assert.match(body, /e\.touches\.length !== 1/); assert.match(body, /e\.target instanceof Element/);
  assert.match(body, /closest\('\.emoji-search, \.emoji-tabs'\)/);
  assert.match(body, /stickerPacks\?\.some\(\(p\) => p\.stickers\.length > 0\) \|\| stickerRecent\?\.length \|\| dmFaved\?\.length/);
  assert.match(body, /if \(!canDragExpand\(exprTab, exprLift\.open, text, hasStickers\)\) return/);
});
it('AST: горизонталь отдаётся наборам, вертикаль стартует от 8 и путь считается с точки захвата с учётом zoom', () => {
  const a = ast(source); const body = a.variable('onLiftMove');
  assert.match(body, /dx >= EXPAND_SLOP && dx > dy/); assert.match(body, /if \(dy < EXPAND_SLOP\) return/);
  assert.match(body, /if \(max <= 0\)/); assert.match(body, /y: t\.clientY, max, start: g\.wasOpen \? max : 0/);
  assert.match(body, /dragExtra\(g\.start, \(t\.clientY - g\.y\) \/ z, g\.max\)/);
});
function velocity(text: string) {
  const a = ast(text); const move = a.variable('onLiftMove'); const end = a.variable('onLiftEnd');
  assert.match(move, /while \(g\.pts\.length > 2 && now - g\.pts\[0\]\.t > 100\) g\.pts\.shift\(\)/);
  assert.match(end, /if \(up\) g\.pts\.push\(\{ t: now, y: up\.clientY \/ rootZoom\(\) \}\)/);
  assert.match(end, /g\.pts\.filter\(\(p\) => now - p\.t <= 100\)/);
  assert.match(end, /b\.t > a\.t \? \(\(b\.y - a\.y\) \/ \(b\.t - a\.t\)\) \* 1000 : 0/);
  assert.match(end, /expandAfterDrag\(g\.wasOpen, v, g\.max > 0 \? extra \/ g\.max : 0\)/);
  assert.match(end, /e\.type === 'touchcancel'[\s\S]*open: g\.wasOpen, max: g\.max, drag: null/);
}
it('AST: скорость по последним 100 мс включает отпускание, отмена сохраняет исходное состояние', () => velocity(source));
it('AST-контрфакт скорости за всю историю вместо последних 100 мс ловится', () => pair('g.pts.filter((p) => now - p.t <= 100)', 'g.pts', velocity));
it('AST: геометрия включает низ шапки, margin поля и строку ответа, пустые ref дают ноль', () => {
  const body = ast(source).variable('measureLiftMax');
  assert.match(body, /if \(!top \|\| !chat \|\| !head \|\| !comp\) return 0/);
  for (const expression of ['top.offsetTop + head.offsetTop + head.offsetHeight', 'chat.clientHeight', 'comp.offsetHeight + mb + (strip?.offsetHeight ?? 0)', 'panelHeight: exprUnderH']) assert.ok(body.includes(expression), expression);
});
function geometry(text: string) {
  const a = ast(text);
  const panel = a.nodes.filter(ts.isJsxElement).find(n => n.openingElement.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(a.sf) === 'className' && p.initializer?.getText(a.sf) === '"expr-under"'));
  assert.ok(panel);
  const attrs = panel.openingElement.attributes.getText(a.sf);
  assert.match(attrs, /height: exprUnderH \+ liftExtra, marginTop: -liftExtra/);
  for (const [event, handler] of [['onTouchStart', 'onLiftStart'], ['onTouchMove', 'onLiftMove'], ['onTouchEnd', 'onLiftEnd'], ['onTouchCancel', 'onLiftEnd']]) assert.ok(attrs.includes(`${event}={${handler}}`));
  assert.match(text, /\{exprUnder && picker && \(/);
  assert.match(text, /className="expr-scrim" style=\{\{ opacity: exprLift\.max > 0 \? liftExtra \/ exprLift\.max : 0 \}\}/);
}
it('AST: высота растёт с отрицательным верхним отступом без перестройки ленты, scrim получает долю', () => geometry(source));
it('AST-контрфакт без отрицательного отступа панели ловится', () => pair('marginTop: -liftExtra', 'marginTop: 0', geometry));
