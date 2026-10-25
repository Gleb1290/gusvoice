import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';
import { ALL_PERMISSIONS, has, Permission } from '@gusvoice/shared';

// Стражи проводки, не рендер всего приложения и не eval отдельных функций MessagePane.
const read = (name: string) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pane = read('MessagePane');
const settings = read('ChannelSettingsModal');
const compact = (n: ts.Node) => n.getText().replace(/\s+/g, '');
function nodes<T extends ts.Node>(root: ts.Node, predicate: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  function walk(n: ts.Node) { if (predicate(n)) out.push(n); ts.forEachChild(n, walk); }
  walk(root); return out;
}
function parse(raw: string) {
  const file = ts.createSourceFile('webhook-ui.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0);
  return file;
}
function initializer(file: ts.Node, name: string) {
  const list = nodes(file, ts.isVariableDeclaration).filter(n => ts.isIdentifier(n.name) && n.name.text === name);
  assert.equal(list.length, 1, `одна переменная ${name}`); assert.ok(list[0].initializer);
  return list[0].initializer;
}
function badge(raw = pane) {
  const tags = nodes(parse(raw), ts.isJsxElement).filter(n => n.openingElement.attributes.properties.some(p =>
    ts.isJsxAttribute(p) && p.name.getText() === 'className' && p.initializer
      && ts.isStringLiteral(p.initializer) && p.initializer.text === 'msg-webhook-tag'));
  assert.equal(tags.length, 1);
  assert.equal(tags[0].children.filter(ts.isJsxText).map(n => n.text.trim()).join(''), 'ВЕБХУК');
  let parent: ts.Node | undefined = tags[0].parent;
  while (parent && !ts.isBinaryExpression(parent)) parent = parent.parent;
  assert.ok(parent && ts.isBinaryExpression(parent));
  assert.equal(parent.operatorToken.kind, ts.SyntaxKind.AmpersandAmpersandToken);
  assert.equal(compact(parent.left), 'm.webhookId', 'R274:пометка-только-на-сообщении-вебхука');
}
function snapshotIdentity(raw = pane) {
  const functions = nodes(parse(raw), ts.isFunctionDeclaration).filter(n => n.name?.text === 'rowAuthor');
  assert.equal(functions.length, 1); assert.ok(functions[0].body);
  const statements = functions[0].body.statements;
  assert.ok(ts.isIfStatement(statements[0]), 'служебные сообщения не склеиваются с обычными');
  const last = statements.at(-1); assert.ok(last && ts.isReturnStatement(last) && last.expression);
  assert.equal(compact(last.expression),
    "m.webhookId?`webhook:${m.webhookId}:${m.author.displayName}:${m.author.avatarUrl??''}`:m.author.id",
    'R274:склейка-по-снимку-имени-и-аватара');
}
function permissionDoor(raw = settings) {
  assert.equal(compact(initializer(parse(raw), 'canManageWebhooks')),
    "channel.type==='text'&&has(serverPerms,Permission.MANAGE_WEBHOOKS)",
    'R274:дверь-только-текст-и-своё-право');
}

it('R274 сообщение вебхука получает явную пометку, обычное сообщение не выдаётся за интеграцию', () => {
  // Иначе внешний автоматический автор визуально не отличается от участника сервера.
  badge();
});
it('R274 склейка вебхуков учитывает id, снимки имени и аватара, обычная — id человека', () => {
  // Один вебхук с username CI и Мониторинг не должен сливаться под единственным чужим именем.
  snapshotIdentity();
});
it('R274 оба края серии сообщений используют webhook-aware автора, а не общий author.id', () => {
  // Исправленный helper бесполезен, если соседняя строка всё ещё сравнивается по старому ключу.
  const fields = nodes(parse(pane), ts.isPropertyAssignment).filter(n => compact(n.name) === 'authorId');
  for (const message of ['m', 'prev', 'next']) assert.ok(fields.some(n => compact(n.initializer) === `rowAuthor(${message})`),
    `ключ серии для ${message} проходит через rowAuthor`);
});
it('R274 у имени и аватара вебхука нет профиля и меню участника, у человека действия остаются', () => {
  // Бот не член сервера: меню участника здесь предложило бы неприменимые действия.
  const attrs = nodes(parse(pane), ts.isJsxAttribute).filter(n =>
    ['onClick', 'onContextMenu'].includes(n.name.getText()) && n.initializer && ts.isJsxExpression(n.initializer)
      && n.initializer.expression && ts.isConditionalExpression(n.initializer.expression)
      && compact(n.initializer.expression.condition) === 'm.webhookId');
  assert.equal(attrs.length, 4, 'две цели × два действия');
  for (const attr of attrs) {
    assert.ok(attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression
      && ts.isConditionalExpression(attr.initializer.expression));
    const choice = attr.initializer.expression;
    assert.equal(compact(choice.whenTrue), 'undefined');
    assert.match(compact(choice.whenFalse), /^\(e\)=>act\.userMenu\(e,who(?:,'profile')?\)$/);
  }
});
it('R274 настройки требуют своё право и текстовый канал, обе точки входа и редактор ролей знают новое право', () => {
  // MANAGE_CHANNELS не должен автоматически открывать доступ к адресам-ключам вебхуков.
  assert.equal(Permission.MANAGE_WEBHOOKS, 1n << 28n);
  assert.equal(ALL_PERMISSIONS & Permission.MANAGE_WEBHOOKS, Permission.MANAGE_WEBHOOKS);
  assert.equal(has(Permission.MANAGE_CHANNELS, Permission.MANAGE_WEBHOOKS), false);
  assert.equal(has(Permission.MANAGE_WEBHOOKS, Permission.MANAGE_WEBHOOKS), true);
  assert.equal(has(Permission.ADMINISTRATOR, Permission.MANAGE_WEBHOOKS), true);
  permissionDoor();
  for (const name of ['ChannelContextMenu', 'ChannelSidebar'])
    assert.equal(compact(initializer(parse(read(name)), 'canManageWebhooks')), 'has(perms,Permission.MANAGE_WEBHOOKS)');
  assert.ok(nodes(parse(read('ChannelSidebar')), ts.isBinaryExpression).some(n => compact(n) === '!isVoice&&canManageWebhooks'),
    'вход в настройки текста использует вычисленное право');
  assert.ok(nodes(parse(read('ChannelContextMenu')), ts.isBinaryExpression).some(n =>
    compact(n.left) === "!canManage&&c.type==='text'&&canManageWebhooks"), 'пункт меню текста использует вычисленное право');
  assert.ok(nodes(initializer(parse(settings), 'sections'), ts.isConditionalExpression).some(n =>
    compact(n.condition) === 'canManageWebhooks' && nodes(n.whenTrue, ts.isPropertyAssignment).some(p =>
      compact(p.name) === 'key' && compact(p.initializer) === "'webhooks'asconst")), 'вкладка условно добавлена по праву');
  assert.ok(nodes(parse(read('ServerRolesPanel')), ts.isPropertyAssignment).some(n =>
    compact(n.name) === 'key' && compact(n.initializer) === "'MANAGE_WEBHOOKS'"));
  const viewers = nodes(parse(settings), ts.isJsxSelfClosingElement).filter(n => compact(n.tagName) === 'ChannelWebhooksPanel');
  assert.equal(viewers.length, 1, 'раздел действительно монтирует панель вебхуков');
});

for (const [label, raw, from, to, check, marker] of [
  ['пометка стала безусловной', pane, '{m.webhookId && (', '{true && (', badge, 'R274:пометка-только-на-сообщении-вебхука'],
  ['из ключа исчезло имя отправки', pane, '${m.author.displayName}:${m.author.avatarUrl', '${m.author.avatarUrl', snapshotIdentity, 'R274:склейка-по-снимку-имени-и-аватара'],
  ['адреса открыло управление каналами', settings,
    "const canManageWebhooks = channel.type === 'text' && has(serverPerms, Permission.MANAGE_WEBHOOKS);",
    "const canManageWebhooks = channel.type === 'text' && has(serverPerms, Permission.MANAGE_CHANNELS);",
    permissionDoor, 'R274:дверь-только-текст-и-своё-право'],
] as const) it(`R274 контрфакт: ${label} ловится адресным AST-стражем после оригинала`, () => {
  check(raw);
  assert.equal(raw.split(from).length - 1, 1, 'одна точка мутации');
  assert.throws(() => check(raw.replace(from, to)), error => error instanceof assert.AssertionError && error.message.includes(marker));
});
