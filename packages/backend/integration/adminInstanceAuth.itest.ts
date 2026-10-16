import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Fastify from 'fastify';
import { z } from 'zod';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as authRules from '../src/authRules.js';
import * as superAdminRules from '../src/superAdminRules.js';
import * as setupRules from '../src/setupRules.js';
import * as dmRules from '../src/dmRules.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as updateRules from '../src/instanceUpdateRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.close(); });
const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const adminSource = read('routes/admin.ts');
const initialName = 'Исходное имя';

// Реальны auth/JWT, super-admin rules, SQL и все маршруты admin. Подменяются только env и непредметные IO.
async function fixture(raw = adminSource) {
  await truncateAll(t.raw);
  const unexpected: string[] = [];
  const unused = (id: string) => () => { unexpected.push(id); throw new Error(`непредметная граница ${id}`); };
  const modules: Record<string, unknown> = {
    'db/index.js': { db: t.db }, 'db/schema.js': schema,
    'env.js': { env: { jwtSecret: 'not-a-secret-used-only-by-route-tests', federation: { dmEnabled: false } } },
    'authRules.js': authRules, 'superAdminRules.js': superAdminRules, 'setupRules.js': setupRules, 'dmRules.js': dmRules,
    'federation/linkRules.js': linkRules, 'instanceUpdateRules.js': updateRules,
    'settings.js': { isSmtpConfigured: async () => false, getSmtpConfig: unused('getSmtpConfig'), setSmtpConfig: unused('setSmtpConfig'), smtpSource: unused('smtpSource') },
  };
  const boundaryNames = new Set(['accountDelete.js', 'economyStats.js', 'instanceSettings.js', 'federation/guestAccess.js',
    'federation/directoryEvents.js', 'federation/links.js', 'federation/instanceMeta.js', 'mailer.js', 'serialize.js',
    'instanceUpdate.js', 'dmReports.js', 'storage.js']);
  const external: Record<string, unknown> = { 'drizzle-orm': orm, '@gusvoice/shared': shared, zod: { z },
    bcryptjs: { __esModule: true, default: bcrypt }, jsonwebtoken: { __esModule: true, default: jwt } };
  function load<T>(path: string, source = read(path)): T {
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const deps: Record<string, unknown> = {};
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const id = node.moduleSpecifier.text;
      if (Object.hasOwn(external, id)) { deps[id] = external[id]; continue; }
      const key = id.replace(/^\.\.\//, '').replace(/^\.\//, '');
      if (Object.hasOwn(modules, key)) { deps[id] = modules[key]; continue; }
      assert.equal(boundaryNames.has(key), true, `закрытый перечень зависимостей ${path}: ${id}`);
      const bindings = node.importClause?.namedBindings;
      assert.ok(bindings && ts.isNamedImports(bindings), `только именованные IO импорты ${id}`);
      deps[id] = Object.fromEntries(bindings.elements.filter(e => !e.isTypeOnly).map(e => [e.propertyName?.text ?? e.name.text, unused(`${id}:${e.name.text}`)]));
    }
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
      { module, exports: module.exports, Date, Buffer, URL, require(id: string) { assert.equal(Object.hasOwn(deps, id), true, `известный require ${id}`); return deps[id]; } });
    return module.exports as T;
  }
  const auth = load<typeof import('../src/auth.js')>('auth.ts');
  auth.setSuperAdminId('owner'); modules['auth.js'] = auth;
  const setup = load<typeof import('../src/instanceSetup.js')>('instanceSetup.ts'); modules['instanceSetup.js'] = setup;
  const admin = load<typeof import('../src/routes/admin.js')>('routes/admin.ts', raw);
  await t.db.insert(schema.users).values([
    { id: 'owner', username: 'owner-account', displayName: 'Держатель', passwordHash: 'fixture', verified: true },
    { id: 'ordinary', username: 'owner', displayName: 'Участник', passwordHash: 'fixture', verified: true },
  ]);
  await setup.setInstanceMeta({ name: initialName, iconUrl: null });
  const app = Fastify(); await app.register(admin.adminRoutes); await app.ready();
  return { app, auth, setup, unexpected, headers: (sub: 'owner' | 'ordinary') => ({ authorization: `Bearer ${auth.signToken({ sub, username: sub === 'ordinary' ? 'owner' : 'owner-account', gen: 0 })}` }) };
}
async function denied(method: 'GET' | 'PUT', raw = adminSource) {
  const f = await fixture(raw);
  try {
    const before = await t.db.select().from(schema.instanceSettings);
    const response = await f.app.inject({ method, url: '/admin/instance', headers: f.headers('ordinary'),
      ...(method === 'PUT' ? { payload: { name: 'Чужое новое имя', registration: 'invite', dmPolicy: 'anyone' } } : {}) });
    assert.equal(response.statusCode, 403, `R230-admin-${method}: обычный участник не управляет инстансом`);
    assert.deepEqual(response.json(), { error: 'forbidden' });
    assert.deepEqual(await t.db.select().from(schema.instanceSettings), before, 'отказ не меняет ни одного сохранённого значения или updatedAt');
    assert.equal((await f.setup.instanceMeta()).name, initialName);
  } finally { await f.app.close(); assert.deepEqual(f.unexpected, [], 'IO не маскирует результат'); }
}
for (const method of ['GET', 'PUT'] as const) test(`R230 ${method} настроек инстанса запрещён обычному участнику даже с логином как id держателя`, async () => {
  // Ошибка в области admin preHandler раскрывает настройки или позволяет переименовать чужой инстанс.
  await denied(method);
});
test('R230 держатель читает и меняет имя через те же JWT и SQL маршруты', async () => {
  // Парный успех доказывает исправность настоящей авторизации, а не фикстуру с постоянным 403.
  const f = await fixture(); try {
    const get = await f.app.inject({ method: 'GET', url: '/admin/instance', headers: f.headers('owner') });
    assert.equal(get.statusCode, 200); assert.equal(get.json().name, initialName);
    const put = await f.app.inject({ method: 'PUT', url: '/admin/instance', headers: f.headers('owner'), payload: { name: '  Новое имя  ' } });
    assert.equal(put.statusCode, 200); assert.deepEqual(put.json(), { ok: true });
    assert.equal((await f.setup.instanceMeta()).name, 'Новое имя');
    const rows = await t.db.select().from(schema.instanceSettings).where(orm.eq(schema.instanceSettings.key, setupRules.INSTANCE_KEY));
    assert.equal(rows.length, 1); assert.equal((rows[0]!.value as { name: string }).name, 'Новое имя');
  } finally { await f.app.close(); assert.deepEqual(f.unexpected, []); }
});
test('R230 отсутствие токена даёт 401 на чтение и запись без изменения имени', async () => {
  // Отказ анонимному запросу не следует смешивать с проверкой прав уже вошедшего человека.
  const f = await fixture(); try {
    for (const method of ['GET', 'PUT'] as const) {
      const r = await f.app.inject({ method, url: '/admin/instance', ...(method === 'PUT' ? { payload: { name: 'Чужое имя' } } : {}) });
      assert.equal(r.statusCode, 401); assert.equal((await f.setup.instanceMeta()).name, initialName);
    }
  } finally { await f.app.close(); assert.deepEqual(f.unexpected, []); }
});
for (const method of ['GET', 'PUT'] as const) test(`R230 контрфакт обычной сессии вместо super-admin ловится в ${method}`, async () => {
  // Ошибочный hook всё ещё проверяет JWT, но больше не отличает участника от держателя.
  await denied(method);
  const anchor = "app.addHook('preHandler', requireSuperAdmin);";
  const importAnchor = "import { requireSuperAdmin } from '../auth.js';";
  assert.equal(adminSource.split(anchor).length - 1, 1);
  assert.equal(adminSource.split(importAnchor).length - 1, 1);
  const changed = adminSource.replace(importAnchor, "import { requireAuth, requireSuperAdmin } from '../auth.js';").replace(anchor, "app.addHook('preHandler', requireAuth);");
  await assert.rejects(denied(method, changed), e => e instanceof assert.AssertionError && e.message.startsWith(`R230-admin-${method}:`)
    && e.operator === 'strictEqual' && e.actual === 200 && e.expected === 403);
});
