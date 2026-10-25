import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// Читаем AST целых модулей: React, store и браузер не импортируются; проверки привязаны
// к исполняемым JSX/условиям, а не к комментариям с обещаниями безопасности.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pane = read('./components/MessagePane.tsx');
const links = read('./linkGuard.tsx');
const cards = read('./components/MessageEmbeds.tsx');
function ast(source: string) {
  const file = ts.createSourceFile('webhook.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0, 'корректный полный TSX');
  return file;
}
function nodes<T extends ts.Node>(file: ts.Node, guard: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => { if (guard(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(file);
  return found;
}
const compact = (node: ts.Node) => node.getText().replace(/\s+/g, '');
function messageBodies(file: ts.SourceFile) {
  return nodes(file, ts.isConditionalExpression).filter(n => {
    // У исходящей очереди есть свой o.content/bodyNode: embedsFallback относится только к сохранённому m.
    if (!nodes(n.condition, ts.isPropertyAccessExpression).some(p => compact(p) === 'm.content')) return false;
    let branch = n.whenTrue;
    while (ts.isParenthesizedExpression(branch)) branch = branch.expression;
    return ts.isJsxElement(branch) && branch.openingElement.attributes.properties.some(a =>
      ts.isJsxAttribute(a) && a.name.getText() === 'className' && a.initializer?.getText() === '"message-body"');
  });
}
function isBubbleBody(node: ts.ConditionalExpression) {
  return ts.isVariableDeclaration(node.parent) && node.parent.name.getText() === 'body';
}
function fallbackContract(source: string) {
  const file = ast(source);
  const marker = 'R279 свёртка не рисуется и не превьюится';
  const previews = nodes(file, ts.isVariableDeclaration).find(n => n.name.getText() === 'previews');
  assert.ok(previews?.initializer && ts.isConditionalExpression(previews.initializer), marker);
  assert.ok(compact(previews.initializer.condition).includes('m.content&&!m.embedsFallback'), marker);
  const rendered = messageBodies(file);
  assert.equal(rendered.length, 2, 'R280 найдены отдельные пути текста пузыря и строки канала');
  assert.equal(rendered.filter(isBubbleBody).length, 1, 'R280 body пузыря найден отдельно от JSX строки канала');
  for (const body of rendered) assert.equal(compact(body.condition), 'm.content&&!m.embedsFallback',
    isBubbleBody(body) ? 'R280 свёртка не рисуется в пузыре' : 'R280 свёртка не рисуется в строке канала');
  assert.ok(nodes(file, ts.isJsxSelfClosingElement).some(n => n.tagName.getText() === 'MessageEmbeds'), marker);
}
function signedLinkContract(source: string) {
  const file = ast(source);
  const marker = 'R279 подписанная чужая ссылка требует подтверждения';
  const fn = nodes(file, ts.isFunctionDeclaration).find(n => n.name?.text === 'MessageLink');
  assert.ok(fn?.body, marker);
  const condition = nodes(fn.body, ts.isIfStatement).find(n => compact(n.thenStatement) === 'setAsk(true);');
  assert.ok(condition, marker);
  assert.equal(compact(condition.expression), 'text!==undefined?!isOwnLink(url):shouldWarnAboutLink(url)', marker);
  assert.ok(condition.elseStatement && compact(condition.elseStatement) === 'openLink(url);', marker);
  const modal = nodes(fn.body, ts.isJsxSelfClosingElement).find(n => n.tagName.getText() === 'LinkConfirmModal');
  assert.ok(modal, marker);
  assert.ok(nodes(fn.body, ts.isBinaryExpression).some(n => n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    n.left.getText() === 'ask' && nodes(n.right, ts.isJsxSelfClosingElement).includes(modal)), marker);
  const confirmation = nodes(file, ts.isFunctionDeclaration).find(n => n.name?.text === 'LinkConfirmModal');
  assert.ok(confirmation && nodes(confirmation, ts.isJsxText).some(n => n.getText().includes('Открыть ссылку?')), marker);
}
function attachmentsContract(source: string) {
  const file = ast(source);
  const imports = file.statements.filter(ts.isImportDeclaration).filter(n =>
    ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === './MessageEmbeds');
  assert.equal(imports.length, 1, 'R281 правило отсева импортируется из настоящего модуля карточек');
  const bindings = imports[0].importClause?.namedBindings;
  assert.ok(bindings && ts.isNamedImports(bindings)
    && bindings.elements.some(e => e.name.text === 'attachmentsBesideEmbeds' && !e.propertyName && !e.isTypeOnly),
  'R281 отбор вложений не подменён локальным правилом');
  // В исходящей очереди и пузырях свои блоки вложений. Регрессия приёмки — сохранённая строка канала MessageRow.
  const rows = nodes(file, ts.isFunctionExpression).filter(n => n.name?.text === 'MessageRow');
  assert.equal(rows.length, 1);
  const variables = nodes(rows[0].body, ts.isVariableDeclaration);
  const shown = variables.filter(n => n.name.getText() === 'shownAttachments');
  assert.equal(shown.length, 1);
  assert.ok(shown[0].initializer);
  assert.equal(compact(shown[0].initializer), 'attachmentsBesideEmbeds(m.attachments,m.embeds)',
    'R281 отдельные вложения отфильтрованы по карточкам того же сообщения');
  const views = variables.filter(n => n.name.getText() === 'attachmentViews');
  assert.equal(views.length, 1);
  const map = views[0].initializer;
  assert.ok(map && ts.isCallExpression(map) && ts.isPropertyAccessExpression(map.expression)
    && compact(map.expression) === 'shownAttachments.map', 'R281 AttachmentView создаётся только для отфильтрованных файлов');
  const callback = map.arguments[0];
  assert.ok(callback && ts.isArrowFunction(callback) && ts.isJsxSelfClosingElement(callback.body));
  assert.equal(callback.body.tagName.getText(), 'AttachmentView');
  const blocks = nodes(rows[0].body, ts.isJsxElement).filter(n => n.openingElement.attributes.properties.some(a =>
    ts.isJsxAttribute(a) && a.name.getText() === 'className' && a.initializer?.getText() === '"attachments"'));
  assert.equal(blocks.length, 1, 'R281 найден отдельный блок вложений строки канала');
  const gate = blocks[0].parent;
  assert.ok(ts.isConditionalExpression(gate) && gate.whenTrue === blocks[0], 'R281 блок вложений строки канала условный');
  assert.equal(compact(gate.condition), 'shownAttachments.length', 'R281 пустой блок вложений не создаётся после отсева карточек');
  assert.equal(gate.whenFalse.kind, ts.SyntaxKind.NullKeyword);
  assert.ok(blocks[0].children.some(n => ts.isJsxExpression(n) && n.expression && compact(n.expression) === 'attachmentViews'),
    'R281 в блок попадают именно отфильтрованные AttachmentView');
}
function rejectMutation(source: string, from: string, to: string, count: number, marker: string, check: (source: string) => void) {
  check(source);
  assert.equal(source.split(from).length - 1, count, 'ровно ожидаемые якоря мутации');
  const changed = source.split(from).join(to);
  ast(changed); // Синтаксический сбой не считается доказательством обнаруженной регрессии.
  assert.throws(() => check(changed), (error: unknown) => error instanceof assert.AssertionError && error.message.split('\n')[0] === marker);
}

test('R279 новый клиент не дублирует карточки старым fallback-текстом и не создаёт из него превью', () => {
  // Класс ошибки: compatibility-текст попадает в ленту второй карточкой и запускает нежелательное превью ссылки.
  fallbackContract(pane);
});

test('R279 подписанная ссылка в карточке проходит MessageLink, а чужая картинка не используется как img', () => {
  // Класс ошибки: ложная подпись обходит подтверждение адреса, а imageLink превращается в пиксель слежения.
  const file = ast(cards);
  const elements = nodes(file, ts.isJsxSelfClosingElement);
  const labeled = elements.filter(n => n.tagName.getText() === 'MessageLink' && n.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText() === 'text'));
  assert.equal(labeled.length, 2);
  assert.ok(labeled.some(n => compact(n).includes('url={e.url}text={e.title}')));
  assert.ok(labeled.some(n => compact(n).includes('url={e.author.url}text={e.author.name}')));
  const imageSources = elements.filter(n => n.tagName.getText() === 'img').map(n => {
    const attr = n.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText() === 'src') as ts.JsxAttribute;
    return attr.initializer?.getText();
  });
  assert.deepEqual(imageSources.sort(), ['{e.author.iconUrl}', '{e.footer.iconUrl}', '{e.image.url}', '{e.thumbnail.url}'].sort());
  signedLinkContract(links);
});

test('R279 контрфакт без !m.embedsFallback пойман адресным AssertionError после проверки оригинала', () => {
  // Класс ошибки: двойной показ карточки и сетевой preview из текста, оставленного только для старых клиентов.
  rejectMutation(pane, ' && !m.embedsFallback', '', 3, 'R279 свёртка не рисуется и не превьюится', fallbackContract);
});

for (const bubble of [true, false]) test(`R280 потеря защиты только ${bubble ? 'пузыря' : 'строки канала'} обнаруживается при исправных соседних путях`, () => {
  // Общее удаление трёх стражей ловит preview раньше JSX: эти контрфакты доказывают защиту каждого рендера отдельно.
  fallbackContract(pane);
  const bodies = messageBodies(ast(pane)).filter(n => isBubbleBody(n) === bubble);
  assert.equal(bodies.length, 1);
  const condition = bodies[0].condition;
  assert.equal(compact(condition), 'm.content&&!m.embedsFallback');
  const changed = pane.slice(0, condition.getStart()) + 'm.content' + pane.slice(condition.end);
  ast(changed);
  const marker = bubble ? 'R280 свёртка не рисуется в пузыре' : 'R280 свёртка не рисуется в строке канала';
  assert.throws(() => fallbackContract(changed),
    (e: unknown) => e instanceof assert.AssertionError && e.message.split('\n')[0] === marker);
});

test('R279 контрфакт открытия подписанной ссылки без вопроса пойман после проверки оригинала', () => {
  // Класс ошибки: обычный безопасный URL под ложной подписью обходит антифишинговое подтверждение.
  rejectMutation(links, 'text !== undefined ? !isOwnLink(url) : shouldWarnAboutLink(url)', 'shouldWarnAboutLink(url)', 1,
    'R279 подписанная чужая ссылка требует подтверждения', signedLinkContract);
});

test('R281 строка канала рисует только вложения вне карточек и не создаёт пустой блок attachments', () => {
  // Верный helper бесполезен, если карта элементов или условие контейнера продолжают читать исходные вложения.
  attachmentsContract(pane);
});

test('R281 условие контейнера по исходным вложениям отвергается после проверки оригинала', () => {
  // Все файлы уже в карточках: attachmentViews пуст, но старое условие оставило бы пустой блок с отступами.
  rejectMutation(pane, 'shownAttachments.length ? <div className="attachments">',
    'm.attachments?.length ? <div className="attachments">', 1,
    'R281 пустой блок вложений не создаётся после отсева карточек', attachmentsContract);
});
