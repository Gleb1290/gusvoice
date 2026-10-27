import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
function sources(dir = root): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) for (const entry of sources(path)) out.set(...entry);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.set(relative(root, path).replace(/\\/g, '/'), readFileSync(path, 'utf8'));
  }
  return out;
}
const originals = sources();
function nodes<T extends ts.Node>(root: ts.Node, predicate: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const walk = (n: ts.Node) => { if (predicate(n)) out.push(n); ts.forEachChild(n, walk); };
  walk(root); return out;
}
const parse = (name: string, raw: string) => ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true);
const messageTypes = new Set(['message.create', 'message.update', 'message.delete', 'message.reaction']);
function channelGuard(all = originals) {
  const bad: string[] = [];
  for (const [name, raw] of all) {
    if (name === 'channelEvents.ts') continue;
    const file = parse(name, raw);
    const names = new Set(['publishToChannel']);
    for (const spec of nodes(file, ts.isImportSpecifier)) if ((spec.propertyName?.text ?? spec.name.text) === 'publishToChannel') names.add(spec.name.text);
    const declarations = new Map(nodes(file, ts.isVariableDeclaration).filter(n => ts.isIdentifier(n.name) && n.initializer)
      .map(n => [n.name.getText(file), n.initializer!]));
    const hasMessage = (n: ts.Node, seen = new Set<string>()): boolean => {
      if (ts.isIdentifier(n) && !seen.has(n.text) && declarations.has(n.text)) return hasMessage(declarations.get(n.text)!, new Set([...seen, n.text]));
      return nodes(n, ts.isStringLiteral).some(x => messageTypes.has(x.text));
    };
    for (const call of nodes(file, ts.isCallExpression)) {
      const expression = call.expression;
      const called = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : '';
      if (names.has(called) && call.arguments.some(arg => hasMessage(arg))) bad.push(name);
    }
  }
  assert.deepEqual(bad, [], 'R303 сообщения каналов проходят только общий вход');
}
const whitelist = new Map([
  ['routes/servers.ts', 'создание сервера: владелец не событие; правка nickname не меняет членство'],
  ['routes/economy.ts', 'монеты и настройки экономики не меняют членство'],
  ['accountRows.ts', 'низкоуровневое удаление; accountDelete вызывает memberChanged после фиксации'],
]);
function memberGuard(all = originals) {
  const offenders: string[] = [], exempt = new Set<string>(), mutations = new Set<string>();
  for (const [name, raw] of all) {
    const file = parse(name, raw);
    const calls = nodes(file, ts.isCallExpression);
    const changes = calls.filter(n => ts.isPropertyAccessExpression(n.expression)
      && ['insert', 'delete', 'update'].includes(n.expression.name.text) && n.arguments[0]?.getText(file) === 'serverMembers');
    const rawSql = nodes(file, ts.isTaggedTemplateExpression).some(n => /\b(?:insert\s+into|delete\s+from|update)\s+["`]?server_members\b/i.test(n.template.getText(file)));
    if (!changes.length && !rawSql) continue;
    mutations.add(name);
    if (whitelist.has(name)) { assert.ok(whitelist.get(name)!.length > 20); exempt.add(name); continue; }
    if (!calls.some(n => ts.isIdentifier(n.expression) && n.expression.text === 'memberChanged')) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'R303 мутация членства не обходит memberChanged');
  assert.deepEqual([...exempt].sort(), [...whitelist.keys()].sort(), 'белый список не скрывает устаревшие исключения');
  for (const path of ['routes/invites.ts', 'serverMembership.ts', 'routes/serverBots.ts', 'federation/guestAccess.ts', 'federation/guestRevocation.ts', 'federation/instanceBan.ts']) {
    assert.ok(mutations.has(path), `просканирован настоящий вход ${path}`);
  }
  const account = parse('accountDelete.ts', all.get('accountDelete.ts')!);
  assert.ok(nodes(account, ts.isCallExpression).some(n => n.expression.getText(account) === 'memberChanged'), 'исключение accountRows обеспечено вызовом accountDelete');
}
it('R303 AST всех прод-файлов запрещает обход входа событий сообщений каналов', () => channelGuard());
it('R303 AST всех мутаций serverMembers требует memberChanged либо обоснованное исключение', () => memberGuard());
it('R303 контрфакт прямой публикации из webhooks ловится после original-first', () => {
  channelGuard();
  const changed = new Map(originals);
  changed.set('routes/webhooks.ts', originals.get('routes/webhooks.ts')! + "\npublishToChannel('s', 'c', { t: 'message.create', message: synthetic });\n");
  assert.throws(() => channelGuard(changed), e => e instanceof assert.AssertionError && e.operator === 'deepStrictEqual'
    && e.message.startsWith('R303 сообщения каналов проходят только общий вход') && JSON.stringify(e.actual) === '["routes/webhooks.ts"]');
});
it('R303 контрфакт исчезнувшего memberChanged из invites ловится после original-first', () => {
  memberGuard();
  const raw = originals.get('routes/invites.ts')!;
  const file = parse('invites.ts', raw);
  const calls = nodes(file, ts.isCallExpression).filter(n => n.expression.getText(file) === 'memberChanged');
  assert.ok(calls.length > 0);
  let changedRaw = raw;
  for (const call of calls.sort((a, b) => b.pos - a.pos)) changedRaw = changedRaw.slice(0, call.expression.getStart(file)) + 'lostMemberChanged' + changedRaw.slice(call.expression.end);
  const changed = new Map(originals); changed.set('routes/invites.ts', changedRaw);
  assert.throws(() => memberGuard(changed), e => e instanceof assert.AssertionError && e.operator === 'deepStrictEqual'
    && e.message.startsWith('R303 мутация членства не обходит memberChanged') && JSON.stringify(e.actual) === '["routes/invites.ts"]');
});
