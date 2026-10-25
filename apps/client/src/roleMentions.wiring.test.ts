import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

// AST-стражи только проводки. Поведение правил и настоящего renderer покрыто соседними тестами;
// браузер/стор/сокеты не импортируем и не исполняем вырезанные фрагменты приложения.
const chat = readFileSync(new URL('./components/ChatView.tsx', import.meta.url), 'utf8');
const sockets = readFileSync(new URL('./sockets.ts', import.meta.url), 'utf8');
const pane = readFileSync(new URL('./components/MessagePane.tsx', import.meta.url), 'utf8');
const compact = (node: ts.Node) => node.getText().replace(/\s+/g, '');

function descendants<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  function visit(node: ts.Node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function parse(raw: string, name: string, kind: ts.ScriptKind) {
  const file = ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true, kind);
  assert.equal((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0);
  return file;
}

function variable(scope: ts.Node, name: string) {
  const found = descendants(scope, ts.isVariableDeclaration).filter(n => ts.isIdentifier(n.name) && n.name.text === name);
  assert.equal(found.length, 1, `одна переменная ${name}`);
  assert.ok(found[0].initializer);
  return found[0].initializer;
}

function sharedImport(file: ts.SourceFile, name: string) {
  const imports = file.statements.filter(ts.isImportDeclaration).filter(n =>
    ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === '@gusvoice/shared');
  assert.equal(imports.length, 1);
  const bindings = imports[0].importClause?.namedBindings;
  assert.ok(bindings && ts.isNamedImports(bindings));
  assert.ok(bindings.elements.some(n => n.name.text === name && !n.propertyName && !n.isTypeOnly), `настоящий импорт ${name}`);
}

function checkAutocomplete(raw: string) {
  const file = parse(raw, 'ChatView.tsx', ts.ScriptKind.TSX);
  sharedImport(file, 'canMentionRole');
  const component = file.statements.filter(ts.isFunctionDeclaration).find(n => n.name?.text === 'ChatView');
  assert.ok(component?.body);
  const memo = variable(component.body, 'autocomplete');
  assert.ok(ts.isCallExpression(memo) && compact(memo.expression) === 'useMemo');
  assert.ok(ts.isArrayLiteralExpression(memo.arguments[1]));
  assert.ok(memo.arguments[1].elements.some(n => compact(n) === 'permsBits'), 'изменение права обновляет подсказку');
  const callback = memo.arguments[0];
  assert.ok(ts.isArrowFunction(callback));
  const properties = descendants(callback, ts.isPropertyAssignment).filter(n => compact(n.name) === 'roles');
  assert.equal(properties.length, 1);
  const map = properties[0].initializer;
  assert.ok(ts.isCallExpression(map) && ts.isPropertyAccessExpression(map.expression) && map.expression.name.text === 'map');
  const filter = map.expression.expression;
  assert.ok(ts.isCallExpression(filter) && compact(filter.expression) === 'roles.filter');
  const predicate = filter.arguments[0];
  assert.ok(ts.isArrowFunction(predicate));
  assert.equal(compact(predicate.body), '!r.isEveryone&&canMentionRole(r,permsBits)', 'R266:подсказка-проверяет-допуск-роли');
}

function createMessage(raw: string) {
  const file = parse(raw, 'sockets.ts', ts.ScriptKind.TS);
  sharedImport(file, 'mentionsMyRole');
  const clauses = descendants(file, ts.isCaseClause).filter(n => ts.isStringLiteral(n.expression) && n.expression.text === 'message.create');
  assert.equal(clauses.length, 1);
  return clauses[0];
}

function checkRoleDecision(raw: string) {
  const branch = createMessage(raw);
  assert.equal(compact(variable(branch, 'myRoleIds')),
    'store.bootstrap?.server.id===msg.serverId?store.bootstrap.member.roleIds:undefined',
    'R266:роли-принадлежат-серверу-сообщения');
  const mentioned = variable(branch, 'mentioned');
  assert.ok(ts.isBinaryExpression(mentioned) && mentioned.operatorToken.kind === ts.SyntaxKind.BarBarToken);
  assert.ok(ts.isCallExpression(mentioned.left) && compact(mentioned.left.expression) === 'mentionsMe');
  assert.equal(compact(mentioned.right), 'mentionsMyRole(msg.message.mentionRoles,myRoleIds)', 'используем снимок id, не повторно текст роли');
}

function checkBroadcastAutocomplete(raw: string, paneRaw = pane) {
  const file = parse(raw, 'ChatView.tsx', ts.ScriptKind.TSX);
  sharedImport(file, 'canMentionEveryone');
  assert.equal(compact(variable(file, 'noBroadcast')), '!canMentionEveryone(permsBits)',
    'R279 подсказка учитывает право массового упоминания');
  const memo = variable(file, 'autocompleteWithRights');
  assert.ok(ts.isCallExpression(memo) && compact(memo.expression) === 'useMemo');
  assert.equal(compact(memo.arguments[1]), '[autocomplete,noBroadcast]', 'R279 смена права обновляет список подсказок');
  assert.equal(compact(memo.arguments[0]), '()=>({...autocomplete,noBroadcast})', 'R279 флаг права дополняет подсказки');
  const prop = descendants(file, ts.isJsxAttribute).filter(n => n.name.getText() === 'autocomplete');
  assert.equal(prop.length, 1);
  assert.equal(compact(prop[0].initializer!), '{autocompleteWithRights}', 'R279 в MessagePane уходит подсказка с правом');
  const list = compact(variable(parse(paneRaw, 'MessagePane.tsx', ts.ScriptKind.TSX), 'broadcast'));
  assert.ok(list.startsWith('(autocomplete.noBroadcast?[]:BROADCAST_MENTIONS).filter('),
    'R279 запрет права убирает everyone и here из кандидатов');
}

function broadcastRenderCall(raw: string) {
  const file = parse(raw, 'MessagePane.tsx', ts.ScriptKind.TSX);
  const imports = file.statements.filter(ts.isImportDeclaration).filter(n =>
    ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === '../messageText');
  assert.equal(imports.length, 1, 'R282 один импорт настоящего рендера текста');
  const clause = imports[0].importClause;
  const bindings = clause?.namedBindings;
  assert.ok(!clause?.isTypeOnly && bindings && ts.isNamedImports(bindings));
  assert.ok(bindings.elements.some(n => n.name.text === 'renderMessageText' && !n.propertyName && !n.isTypeOnly));
  const helpers = file.statements.filter(ts.isFunctionDeclaration).filter(n => n.name?.text === 'renderContent');
  assert.equal(helpers.length, 1);
  const helper = helpers[0];
  assert.ok(helper.body);
  assert.equal(helper.parameters[6]?.name.getText(), 'plainBroadcast', 'R282 флаг принадлежит вызванному renderContent');
  const returns = helper.body.statements.filter(ts.isReturnStatement);
  assert.equal(returns.length, 1);
  const call = returns[0].expression;
  assert.ok(call && ts.isCallExpression(call) && compact(call.expression) === 'renderMessageText');
  assert.equal(compact(call.arguments[0]), 'content');
  assert.equal(compact(call.arguments[2]), 'onEmoji');
  assert.equal(compact(call.arguments[3]), 'roleNames');
  return call;
}

function checkBroadcastRenderer(raw: string) {
  const call = broadcastRenderCall(raw);
  assert.equal(call.arguments[4] && compact(call.arguments[4]), 'plainBroadcast',
    'R282 renderContent передаёт plainBroadcast рендеру');
}

function broadcastRowSites(raw: string) {
  const file = parse(raw, 'MessagePane.tsx', ts.ScriptKind.TSX);
  const memo = variable(file, 'MessageRow');
  assert.ok(ts.isCallExpression(memo) && compact(memo.expression) === 'memo');
  const row = memo.arguments[0];
  assert.ok(row && ts.isFunctionExpression(row) && row.name?.text === 'MessageRow');
  const contentCalls = (scope: ts.Node) => descendants(scope, ts.isCallExpression).filter(n =>
    compact(n.expression) === 'renderContent' && n.arguments[0] && compact(n.arguments[0]) === 'm.content');
  const bubbleCalls = contentCalls(variable(row.body, 'body'));
  assert.equal(bubbleCalls.length, 1, 'R282 текст пузыря найден именно в body сохранённого сообщения');
  const returns = row.body.statements.filter(ts.isReturnStatement);
  assert.equal(returns.length, 1, 'R282 один прямой возврат канальной строки');
  const channelCalls = contentCalls(returns[0]);
  assert.equal(channelCalls.length, 1, 'R282 текст канала найден именно в возвращаемой строке');
  assert.equal(contentCalls(row).length, 2, 'R282 оба пути текста MessageRow учтены');
  return [
    { path: 'пузыри', call: bubbleCalls[0] },
    { path: 'лента канала', call: channelCalls[0] },
  ];
}

const broadcastDecisionMarker = (path: string) => `R282 ${path}: только явный false выключает плашку`;

function checkBroadcastRows(raw: string) {
  for (const { path, call } of broadcastRowSites(raw)) {
    assert.equal(call.arguments[6] && compact(call.arguments[6]), 'm.mentionEveryone===false', broadcastDecisionMarker(path));
  }
}

function replaceNode(raw: string, node: ts.Node, replacement: string) {
  return raw.slice(0, node.getStart()) + replacement + raw.slice(node.end);
}

function failsAt(marker: string) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.split('\n')[0] === marker;
}

it('R266 подсказки ChatView применяют общий допуск роли и обновляются после изменения права', () => {
  checkAutocomplete(chat);
});

it('R266 сокет объединяет личный пинг со снимком ролей именно сервера сообщения', () => {
  checkRoleDecision(sockets);
});

it('R266 единое решение упоминания доходит до режима mentions, бейджа и звука с DND', () => {
  const branch = createMessage(sockets);
  assert.equal(compact(variable(branch, 'notify')), "channelLevel==='all'||(channelLevel==='mentions'&&mentioned)");
  const guards = descendants(branch, ts.isIfStatement);
  assert.ok(guards.some(n => compact(n.expression) === 'notify&&!chanOnScreen'
    && compact(n.thenStatement) === 'store.markUnread(msg.channelId,mentioned,msg.serverId);'));
  assert.ok(guards.some(n => compact(n.expression) === 'notify&&mentioned&&!dnd'
    && compact(n.thenStatement) === "playSound('mention');"));
});

it('R266 контрфакты проводки: удаление проверки права или серверного ограничения ловится AST-стражем', () => {
  checkAutocomplete(chat);
  const filter = '!r.isEveryone && canMentionRole(r, permsBits)';
  assert.equal(chat.split(filter).length, 2);
  assert.throws(() => checkAutocomplete(chat.replace(filter, '!r.isEveryone')),
    (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith('R266:подсказка-проверяет-допуск-роли'));
  checkRoleDecision(sockets);
  const roles = 'store.bootstrap?.server.id === msg.serverId ? store.bootstrap.member.roleIds : undefined';
  assert.equal(sockets.split(roles).length, 2);
  assert.throws(() => checkRoleDecision(sockets.replace(roles, 'store.bootstrap?.member.roleIds')),
    (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith('R266:роли-принадлежат-серверу-сообщения'));
});

it('R279 ChatView не предлагает everyone и here без права, а смена права обновляет MessagePane', () => {
  // Запрещённый сервером пинг не должен выглядеть доступным действием в подсказке.
  checkBroadcastAutocomplete(chat);
});

it('R279 потеря проверки права или её передачи в MessagePane отвергается после оригинала', () => {
  // Проверяем обе границы: вычисленный, но не переданный флаг так же бесполезен, как отсутствие проверки.
  checkBroadcastAutocomplete(chat);
  for (const [from, to, marker] of [
    ['!canMentionEveryone(permsBits)', 'false', 'R279 подсказка учитывает право'],
    ['autocomplete={autocompleteWithRights}', 'autocomplete={autocomplete}', 'R279 в MessagePane уходит'],
  ]) {
    assert.equal(chat.split(from).length - 1, 1);
    assert.throws(() => checkBroadcastAutocomplete(chat.replace(from, to)),
      (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(marker));
  }
});

it('R279 MessagePane не может проигнорировать запрет everyone и here от ChatView', () => {
  // Даже правильный флаг в ChatView не защищает список, если MessagePane снова берёт все массовые пинги.
  checkBroadcastAutocomplete(chat);
  const from = '(autocomplete.noBroadcast ? [] : BROADCAST_MENTIONS)';
  assert.equal(pane.split(from).length - 1, 1);
  assert.throws(() => checkBroadcastAutocomplete(chat, pane.replace(from, 'BROADCAST_MENTIONS')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith('R279 запрет права убирает'));
});

it('R282 renderContent передаёт флаг обычного текста настоящему рендеру вместе с ролями', () => {
  // Вычисленный строкой флаг бесполезен, если промежуточный помощник его теряет.
  checkBroadcastRenderer(pane);
});

it('R282 пузыри и канальная лента убирают плашку только при явном mentionEveryone false', () => {
  // Отсутствующее поле старых сообщений нельзя приравнивать к серверному запрету пинга.
  checkBroadcastRows(pane);
});

it('R282 возврат отрицания mentionEveryone в любом пути ленты отвергается после оригинала', () => {
  // Мутируем пути по одному: исправленный пузырь не должен маскировать регрессию канальной строки и наоборот.
  checkBroadcastRows(pane);
  for (const { path, call } of broadcastRowSites(pane)) {
    const mutant = replaceNode(pane, call.arguments[6], '!m.mentionEveryone');
    assert.notEqual(mutant, pane);
    assert.throws(() => checkBroadcastRows(mutant), failsAt(broadcastDecisionMarker(path)));
  }
});

it('R282 потеря флага между renderContent и рендером отвергается после оригинала', () => {
  // Проверка call-site не спасает, если помощник снова оставит аргумент рендера по умолчанию.
  checkBroadcastRenderer(pane);
  const call = broadcastRenderCall(pane);
  const mutant = replaceNode(pane, call.arguments[4], 'undefined');
  assert.throws(() => checkBroadcastRenderer(mutant), failsAt('R282 renderContent передаёт plainBroadcast рендеру'));
});
