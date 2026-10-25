import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as shared from '@gusvoice/shared';
import * as linkRules from '../src/federation/linkRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.close(); });
const source = readFileSync(new URL('../src/routes/admin.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

async function fixture(raw = source, locals = true) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    ...(locals ? [{ id: 'owner', username: 'local_owner', displayName: 'Держатель', passwordHash: 'fixture' },
      { id: 'local', username: 'local_member', displayName: 'Участник', passwordHash: 'fixture' }] : []),
    { id: 'guest', username: 'guest_member', displayName: 'Гость', passwordHash: 'fixture', homeInstanceId: 'b'.repeat(32), homeUserId: 'peer-user' },
    { id: 'other-guest', username: 'other_guest', displayName: 'Другой гость', passwordHash: 'fixture', homeInstanceId: 'c'.repeat(32), homeUserId: 'peer-user' },
    { id: 'deleted', username: 'deleted_local', displayName: 'Удалённый', passwordHash: 'fixture', deletedAt: new Date() },
  ]);
  const dependencies: Record<string, unknown> = {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z }, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../auth.js': { requireSuperAdmin: async (req: FastifyRequest) => { req.user = { sub: 'owner' } as FastifyRequest['user']; } },
    // Здесь проверяется SQL-аудитория admin, не общий формат профиля/проверка JWT.
    '../serialize.js': { serializeUser: (row: typeof schema.users.$inferSelect) => ({ id: row.id, username: row.username, displayName: row.displayName }) },
    '../federation/links.js': { listLinks: async () => [] }, '../federation/linkRules.js': linkRules,
    '../federation/instanceMeta.js': { readInstanceMeta: async () => ({ name: 'Тестовый инстанс' }) },
  };
  const dormant = new Set(`../accountDelete.js ../economyStats.js ../instanceSettings.js ../federation/guestAccess.js
../federation/directoryEvents.js ../mailer.js ../settings.js ../dmRules.js ../env.js ../instanceSetup.js
../instanceUpdate.js ../dmReports.js ../instanceUpdateRules.js ../setupRules.js ../storage.js`.split(/\s+/));
  const file = ts.createSourceFile('admin.ts', raw, ts.ScriptTarget.Latest, true);
  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
    const id = (node.moduleSpecifier as ts.StringLiteral).text;
    if (Object.hasOwn(dependencies, id)) continue;
    assert.equal(dormant.has(id), true, `закрытая граница admin/users: ${id}`);
    dependencies[id] = new Proxy({}, { get: (_object, key) => key === '__esModule' ? true : () => {
      throw new Error(`непредметная граница admin/users: ${id}.${String(key)}`);
    } });
  }
  const module = { exports: {} as typeof import('../src/routes/admin.js') };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, Date, Map, Set,
    require(id: string) { assert.equal(Object.hasOwn(dependencies, id), true); return dependencies[id]; },
  });
  const app = Fastify();
  await app.register(module.exports.adminRoutes); await app.ready();
  return app;
}

async function localOnly(raw = source) {
  const app = await fixture(raw);
  try {
    const response = await app.inject({ method: 'GET', url: '/admin/users' });
    assert.equal(response.statusCode, 200, response.body);
    const ids = (response.json() as { id: string }[]).map(u => u.id).sort();
    assert.deepEqual(ids, ['local', 'owner'], 'R263:этот-инстанс-содержит-только-своих');
    assert.equal((await t.db.select().from(schema.users)).length, 5, 'гости отфильтрованы выдачей, не удалены из базы');
  } finally { await app.close(); }
}

test('R263 свой пользователь есть в admin/users, гости двух домов и удалённый местный отсутствуют', async () => {
  // Теневая строка гостя не должна получить кнопки управления как своим аккаунтом.
  await localOnly();
});

test('R263 база только с гостями не превращает их в местных из-за пустого списка своих', async () => {
  // Пустота — допустимая выдача, а не повод ослаблять фильтр home_instance_id.
  const app = await fixture(source, false);
  try {
    const response = await app.inject({ method: 'GET', url: '/admin/users' });
    assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), []);
  } finally { await app.close(); }
});

test('R263 потеря фильтра homeInstanceId ловится настоящей SQL-выдачей после проверки оригинала', async () => {
  await localOnly();
  const anchor = '.where(and(isNull(users.deletedAt), isNull(users.homeInstanceId), eq(users.bot, false)));';
  assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(() => localOnly(source.replace(anchor, '.where(and(isNull(users.deletedAt), eq(users.bot, false)));')),
    (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith('R263:этот-инстанс-содержит-только-своих'));
});
