import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';

const read = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const messageSource = read('routes/messages.ts');
const serializeSource = read('serialize.ts');
const compact = (node: ts.Node) => node.getText().replace(/\s+/g, '');
function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(root); return result;
}
function route(file: ts.SourceFile, method: string, path: string) {
  const matches = nodes(file, ts.isCallExpression).filter(n =>
    ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText() === 'app'
    && n.expression.name.text === method && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === path);
  assert.equal(matches.length, 1);
  const callback = matches[0].arguments.at(-1); assert.ok(callback && ts.isArrowFunction(callback));
  return callback;
}
function post(raw = messageSource) {
  // AST всего файла: не импортируем маршрут с базой/хранилищем и не исполняем вырезанное тело.
  const file = ts.createSourceFile('messages.ts', raw, ts.ScriptTarget.Latest, true);
  const handler = route(file, 'post', '/channels/:id/messages');
  const calls = nodes(handler, ts.isCallExpression);
  const resolves = calls.filter(n => n.expression.getText() === 'resolveRoleMentions'); assert.equal(resolves.length, 1);
  assert.deepEqual(resolves[0].arguments.map(compact), ['content', 'channel.serverId', 'perms.permissions'],
    'сервер решает ролевое упоминание по действующему канальному праву автора');
  const declarations = nodes(handler, ts.isVariableDeclaration).filter(n => n.name.getText() === 'mentionRoleIds');
  assert.equal(declarations.length, 1);
  assert.ok(declarations[0].initializer && ts.isAwaitExpression(declarations[0].initializer));
  assert.equal(declarations[0].initializer.expression, resolves[0], 'сохраняется именно результат разрешения');
  const inserts = calls.filter(n => compact(n.expression) === 'db.insert(messages).values'); assert.equal(inserts.length, 1);
  const fields = inserts[0].arguments[0]; assert.ok(fields && ts.isObjectLiteralExpression(fields));
  const roleFields = fields.properties.filter(ts.isPropertyAssignment).filter(n => n.name.getText() === 'mentionRoles');
  assert.equal(roleFields.length, 1, 'R266 POST: разрешённые роли сохраняются в messages.mentionRoles');
  assert.equal(compact(roleFields[0].initializer), 'mentionRoleIds', 'R266 POST: сохраняются id, а не исходный текст');
  const recipients = calls.filter(n => n.expression.getText() === 'resolveMentionedMembers'); assert.equal(recipients.length, 1);
  assert.deepEqual(recipients[0].arguments.map(compact), ['content', 'channel.serverId', 'author.id', 'channelId', 'mentionRoleIds', 'mentionEveryone!==false'],
    'R279 POST: пуш получает те же id и канал и запрет массового упоминания');
}
function patch(raw = messageSource) {
  const file = ts.createSourceFile('messages.ts', raw, ts.ScriptTarget.Latest, true);
  const handler = route(file, 'patch', '/channels/:id/messages/:messageId');
  const calls = nodes(handler, ts.isCallExpression);
  assert.equal(calls.filter(n => ['resolveRoleMentions', 'resolveMentionedMembers', 'sendPushToUsers'].includes(n.expression.getText())).length, 0,
    'R266 PATCH: правка не пересчитывает роли и не будит адресатов');
  const updates = calls.filter(n => compact(n.expression) === 'db.update(messages).set'); assert.equal(updates.length, 1);
  const fields = updates[0].arguments[0]; assert.ok(fields && ts.isObjectLiteralExpression(fields));
  assert.equal(fields.properties.some(n => n.name?.getText() === 'mentionRoles' || ts.isSpreadAssignment(n)), false,
    'R266 PATCH: сохранённые упоминания не меняются даже через spread');
  assert.ok(fields.properties.some(n => n.name?.getText() === 'content'), 'обычный текст действительно редактируется');
}

// Класс ошибки: проверенные id доходят до пуша, но теряются при записи; после перезагрузки исчезает бейдж.
it('R266 POST сохраняет разрешённые id ролей и передаёт ровно их в разрешение адресатов', () => post());
// Класс ошибки: редактирование сообщения повторно будит людей или снимает уже сохранённое обращение.
it('R266 PATCH меняет текст, но не пересчитывает mentionRoles и не отправляет повторный пуш', () => patch());
it('R266 контрфакты потери записи POST и пересчёта PATCH ловятся маркерным AssertionError после original-first', () => {
  const anchor = 'mentionRoles: mentionRoleIds,';
  assert.equal(messageSource.split(anchor).length - 1, 1); post();
  assert.throws(() => post(messageSource.replace(anchor, '')),
    e => e instanceof assert.AssertionError && e.message.startsWith('R266 POST: разрешённые роли сохраняются'));
  const update = 'db.update(messages).set({ content, editedAt: new Date() })';
  assert.equal(messageSource.split(update).length - 1, 1); patch();
  assert.throws(() => patch(messageSource.replace(update, 'db.update(messages).set({ content, mentionRoles: [], editedAt: new Date() })')),
    e => e instanceof assert.AssertionError && e.message.startsWith('R266 PATCH: сохранённые упоминания не меняются'));
});

function serialization(raw = serializeSource) {
  const blocked = (id: string) => new Proxy({}, { get: (_target, key) => {
    if (key === '__esModule') return true;
    return () => assert.fail(`неожиданная граница serialize ${id}.${String(key)}`);
  } });
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, './auth.js': blocked('auth'), './superAdminRules.js': blocked('superAdminRules'),
    './env.js': { env: {} }, './linkThreats.js': { dangerousLinksOf: () => [] },
  };
  for (const id of ['./federation/instanceLabels.js', './statusRules.js', './shopRules.js', './callRules.js', './lastSeenRules.js']) deps[id] = blocked(id);
  const module = { exports: {} as typeof import('./serialize.js') };
  // Полный serialize с закрытым перечнем импортов; ни env, ни другие подсистемы не загружаются.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `описана граница serialize ${id}`); return deps[id]; },
  });
  return module.exports;
}
const at = new Date('2026-10-19T10:00:00Z');
const message = { id: 'message', channelId: 'channel', content: '@Роль', createdAt: at, editedAt: null,
  author: { id: 'author', username: 'author', displayName: 'Автор', avatarUrl: null, createdAt: at } };
function dto(raw = serializeSource) {
  const serialize = serialization(raw);
  for (const mentionRoles of [undefined, null, []]) {
    const result = serialize.serializeMessage({ ...message, mentionRoles });
    assert.equal(Object.hasOwn(result, 'mentionRoles'), false, 'R266 DTO: пустое ролевое поле отсутствует, прежняя форма сохранена');
    assert.equal(result.content, '@Роль'); assert.equal(result.author.id, 'author');
  }
  const result = serialize.serializeMessage({ ...message, mentionRoles: ['role-a', 'role-b'] });
  assert.deepEqual([...(result.mentionRoles ?? [])], ['role-a', 'role-b'], 'R266 DTO: непустые сохранённые id доходят без потери');
  assert.equal(result.createdAt, at.toISOString());
}
// Класс ошибки: необязательное поле превращается в обязательный пустой массив либо теряется на выдаче.
it('R266 настоящий serializeMessage выдаёт mentionRoles только для непустого сохранённого списка', () => dto());
it('R266 мутанты лишнего пустого поля и потери непустого поля пойманы на настоящем DTO после original-first', () => {
  const anchor = '...(m.mentionRoles?.length ? { mentionRoles: m.mentionRoles } : {}),';
  assert.equal(serializeSource.split(anchor).length - 1, 1);
  for (const [replacement, marker] of [
    ['mentionRoles: m.mentionRoles ?? [],', 'R266 DTO: пустое ролевое поле отсутствует'],
    ['', 'R266 DTO: непустые сохранённые id доходят без потери'],
  ]) {
    dto();
    assert.throws(() => dto(serializeSource.replace(anchor, replacement)),
      e => e instanceof assert.AssertionError && e.message.startsWith(marker));
  }
});
