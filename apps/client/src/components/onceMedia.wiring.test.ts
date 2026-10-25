import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const compact = (n: ts.Node) => n.getText().replace(/\s+/g, '');

// Лента слишком велика для изолированного импорта без её стора. Здесь сознательно AST-страж проводки,
// не исполнение вырезанного тела useMemo и не обещание end-to-end поведения MessagePane.
function descendants<T extends ts.Node>(node: ts.Node, guard: (n: ts.Node) => n is T): T[] {
  const result: T[] = [];
  function walk(n: ts.Node) { if (guard(n)) result.push(n); ts.forEachChild(n, walk); }
  walk(node); return result;
}
function parse(text: string): ts.SourceFile {
  const file = ts.createSourceFile('MessagePane.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0);
  return file;
}
function variable(file: ts.Node, name: string): ts.Expression {
  const vars = descendants(file, ts.isVariableDeclaration).filter(n => ts.isIdentifier(n.name) && n.name.text === name);
  assert.equal(vars.length, 1, `одна переменная ${name}`);
  assert.ok(vars[0].initializer); return vars[0].initializer;
}
function fn(file: ts.Node, name: string): ts.Block {
  const funcs = descendants(file, ts.isFunctionDeclaration).filter(n => n.name?.text === name);
  assert.equal(funcs.length, 1, `одна функция ${name}`); assert.ok(funcs[0].body); return funcs[0].body;
}

function albumGuard(text: string): void {
  const file = parse(text), init = variable(file, 'allImages');
  assert.ok(ts.isCallExpression(init) && compact(init.expression) === 'useMemo');
  const callback = init.arguments[0]; assert.ok(ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  const loops = descendants(callback.body, ts.isForOfStatement).filter(n => compact(n.expression) === 'm.attachments??[]');
  assert.equal(loops.length, 1); assert.ok(ts.isBlock(loops[0].statement));
  const body = loops[0].statement;
  const skip = body.statements.filter(ts.isIfStatement).filter(n => compact(n.expression) === 'isOnceMedia(a)'
    && ts.isContinueStatement(n.thenStatement));
  assert.equal(skip.length, 1, 'R262:общий-альбом-исключает-одноразовые');
  const pushes = descendants(body, ts.isCallExpression).filter(n => compact(n.expression) === 'list.push');
  assert.equal(pushes.length, 1);
  assert.ok(skip[0].end < pushes[0].getStart(), 'once исключается до добавления url/downloadUrl в общий альбом');
  assert.equal(compact(loops[0].initializer), 'consta');
  const outer = descendants(callback.body, ts.isForOfStatement).find(n => compact(n.expression) === '[...extraOlder,...messages,...extraNewer]');
  assert.equal(!!outer, true, 'фильтр применяется и к текущей ленте, и к обеим догруженным страницам');
  assert.equal(outer?.statement === loops[0], true);
}

it('R262 AST: once-фото и видео отсекаются до push общего альбома во всех загруженных порциях', () => albumGuard(source));

it('R262 AST: клик once уходит в отдельное открытие до поиска в обычном альбоме', () => {
  const body = fn(parse(source), 'openImage');
  const first = body.statements[0]; assert.ok(ts.isIfStatement(first));
  assert.equal(compact(first.expression), 'isOnceMedia(a)');
  assert.ok(ts.isReturnStatement(first.thenStatement));
  assert.equal(compact(first.thenStatement.expression!), 'voidopenOnce(a)');
  assert.equal(compact(variable(body, 'i')), 'allImages.findIndex((x)=>x.att===a)');
});

it('R262/R269 AST: после once-open срок считается по локальному получению и серверному остатку, close сжигает открытое', () => {
  const file = parse(source), body = fn(file, 'openOnce');
  const opened = variable(body, 'r');
  assert.equal(compact(opened), 'awaitapi.convOnceOpen(m.channelId,m.id)');
  const received = variable(body, 'receivedAt');
  assert.equal(compact(received), 'Date.now()');
  assert.ok(opened.end < received.getStart(), 'R269:локальное-время-снято-после-ответа');
  const set = descendants(body, ts.isCallExpression).filter(n => compact(n.expression) === 'setOnceView');
  assert.equal(set.length, 1);
  assert.ok(opened.end < set[0].getStart(), 'API открывает доступ к файлу до рендера просмотрщика');
  assert.ok(received.end < set[0].getStart(), 'время получения снято до показа');
  assert.equal(compact(set[0].arguments[0]),
    "{att:a,msg:m,deadline:onceDeadlineLocal(a,Date.parse(r.openedAt),Date.parse(r.serverNow??''),receivedAt)}",
    'R269:серверные-часы-дают-только-остаток');
  const guards = body.statements.filter(ts.isIfStatement);
  assert.equal(compact(guards[0].expression), '!m||onceView');
  const close = fn(file, 'closeOnce');
  assert.equal(compact(variable(close, 'v')), 'onceView');
  assert.ok(descendants(close, ts.isCallExpression).some(n => compact(n) === 'setOnceView(null)'));
  assert.ok(descendants(close, ts.isCallExpression).some(n => compact(n) === 'api.convOnceSpent(v.msg.channelId,v.msg.id)'));
});

it('R262 AST: отдельный Lightbox получает один файл без downloadUrl/actions и защиту с deadline', () => {
  const file = parse(source);
  const viewers = descendants(file, ts.isJsxSelfClosingElement).filter(n => compact(n.tagName) === 'Lightbox'
    && n.attributes.properties.some(p => ts.isJsxAttribute(p) && (compact(p.name) === 'once'
      || (compact(p.name) === 'images' && p.initializer && ts.isJsxExpression(p.initializer)
        && p.initializer.expression && compact(p.initializer.expression) === 'allImages'))));
  assert.equal(viewers.length, 2, 'обычный и одноразовый просмотр разделены');
  const ordinary = viewers.find(n => !n.attributes.properties.some(p => ts.isJsxAttribute(p) && compact(p.name) === 'once'));
  assert.ok(ordinary);
  assert.ok(ordinary.attributes.properties.some(p => ts.isJsxAttribute(p) && compact(p.name) === 'actions'
    && p.initializer && ts.isJsxExpression(p.initializer) && p.initializer.expression
    && compact(p.initializer.expression) === 'lightboxActions'), 'общий альбом сохраняет прежнее меню');
  const viewer = viewers.find(n => n.attributes.properties.some(p => ts.isJsxAttribute(p) && compact(p.name) === 'once'));
  assert.ok(viewer);
  const attrs = new Map(viewer.attributes.properties.filter(ts.isJsxAttribute).map(n => [compact(n.name), n]));
  for (const name of ['actions', 'onAuthor', 'onNearEdge']) assert.equal(attrs.has(name), false, `once не получает ${name}`);
  assert.equal(viewer.attributes.properties.some(ts.isJsxSpreadAttribute), false, 'скрытого spread с действиями нет');
  const expr = (name: string): ts.Expression => {
    const init = attrs.get(name)?.initializer;
    assert.ok(init && ts.isJsxExpression(init) && init.expression); return init.expression;
  };
  assert.equal(compact(expr('once')), '{deadline:onceView.deadline,protect:protectScreen}');
  assert.equal(compact(expr('onClose')), 'closeOnce');
  assert.equal(compact(expr('index')), '0');
  assert.equal(compact(expr('onIndex')), '()=>{}');
  const images = expr('images'); assert.ok(ts.isArrayLiteralExpression(images));
  assert.equal(images.elements.length, 1);
  const image = images.elements[0]; assert.ok(ts.isObjectLiteralExpression(image));
  assert.equal(image.properties.some(ts.isSpreadAssignment), false);
  const fields = new Map(image.properties.filter(ts.isPropertyAssignment).map(n => [compact(n.name), n.initializer]));
  for (const field of ['downloadUrl', 'jobKey']) assert.equal(fields.has(field), false, `одноразовый файл без ${field}`);
  assert.equal(compact(fields.get('url')!), 'onceView.att.url');
  assert.equal(compact(fields.get('video')!), 'isVideo(onceView.att.contentType)');
});

it('R262 контрфакт: удалённый фильтр once из общего альбома обнаруживается адресным AST-стражем', () => {
  albumGuard(source);
  const anchor = 'if (isOnceMedia(a)) continue;';
  assert.equal(source.split(anchor).length - 1, 1, 'один реальный фильтр альбома');
  assert.throws(() => albumGuard(source.replace(anchor, '')), error => error instanceof assert.AssertionError
    && error.message.includes('R262:общий-альбом-исключает-одноразовые'));
});
