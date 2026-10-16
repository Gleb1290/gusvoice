import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, beforeEach, test } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as binding from '../src/superAdminRules.js';
import * as authRules from '../src/authRules.js';
import { loginGate } from '../src/setupRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

const source = readFileSync(new URL('../src/seed.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const authSource = readFileSync(new URL('../src/auth.ts', import.meta.url), 'utf8');
const now = Date.parse('2026-10-12T12:00:00Z');
const old = Date.parse('2020-01-01T00:00:00Z');
let t: TestDb;
before(async () => { t = await createTestDb(); });
beforeEach(async () => { await truncateAll(t.raw); });
after(async () => { await t.close(); });
function fixture(raw = source) {
  class Clock extends Date { constructor(value?: string | number) { super(value ?? now); } static override now() { return now; } }
  const forbidden = (what: string) => () => { throw new Error(`нежелательный IO: ${what}`); };
  const hashes: string[] = [];
  const deps: Record<string, unknown> = {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './superAdminRules.js': binding, './authRules.js': authRules,
    './env.js': { env: { superAdmin: { username: 'FixtureAdmin', email: 'fixture@example.invalid', password: 'synthetic-fixture-password' }, superAdminUsername: 'FixtureAdmin' } },
    './util.js': { id: () => 'admin' },
    // Хеширование — граница алгоритма пароля, не привязки/SQL; никаких JWT, сети или настоящей конфигурации.
    bcryptjs: { hash: async (plain: string, rounds: number) => { assert.equal(rounds, 10); hashes.push(plain); return 'synthetic-password-hash'; }, compare: forbidden('bcrypt.compare') },
    jsonwebtoken: { sign: forbidden('jwt.sign'), verify: forbidden('jwt.verify') },
  };
  function load<T>(text: string): T {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
      { module, exports: module.exports, Date: Clock, console: { log: () => {}, warn: () => {} },
        fetch: forbidden('fetch'), setTimeout: forbidden('setTimeout'),
        require: (id: string) => { if (!Object.hasOwn(deps, id)) throw new Error(`неописанный импорт ${id}`); return deps[id]; } });
    return module.exports as T;
  }
  const auth = load<typeof import('../src/auth.js')>(authSource); deps['./auth.js'] = auth;
  return { seed: load<typeof import('../src/seed.js')>(raw), auth, hashes };
}
async function user(id: string) {
  return (await t.db.select().from(schema.users).where(orm.eq(schema.users.id, id)))[0];
}
async function existing(approved: boolean, regular = false) {
  await t.db.insert(schema.users).values({ id: 'bound', username: 'BoundOwner', displayName: 'Bound Owner', passwordHash: 'fixture-hash', verified: true,
    approvedAt: approved ? new Date(old) : null, directoryUpdatedAt: new Date(old) });
  await t.db.insert(schema.instanceSettings).values({ key: binding.SUPERADMIN_ID_KEY, value: { userId: 'bound' } });
  if (regular) await t.db.insert(schema.users).values({ id: 'regular', username: 'Regular', displayName: 'Regular User', passwordHash: 'fixture-hash', verified: true,
    approvedAt: null, directoryUpdatedAt: new Date(old) });
}
async function fresh(raw = source) {
  await truncateAll(t.raw); const f = fixture(raw); await f.seed.seedSuperAdmin();
  const seeded = await user('admin'); assert.equal(!!seeded.approvedAt, true, 'INSERT сразу одобряет супер-админа');
  assert.equal(seeded.approvedAt!.getTime(), now); assert.equal(loginGate(seeded), 'ok');
  await f.seed.bindSuperAdmin(); assert.equal(f.auth.superAdminId(), 'admin'); assert.equal(loginGate(await user('admin')), 'ok');
  assert.equal(f.hashes.length, 1); assert.equal((await t.db.select().from(schema.users)).length, 1);
  const stored = (await t.db.select().from(schema.instanceSettings).where(orm.eq(schema.instanceSettings.key, binding.SUPERADMIN_ID_KEY)))[0];
  assert.equal((stored.value as { userId: string }).userId, 'admin');
}
test('R188 пустая база получает сразу одобренного супер-админа, seed затем bind открывают loginGate', async () => {
  // Класс ошибки: владелец свежей установки ждёт одобрения, которое некому дать.
  await fresh();
});
test('R188 уже привязанный id с NULL approval ремонтируется и сдвигает время каталога', async () => {
  // Класс ошибки: новая логика работает только при первой привязке, пропуская прежний id.
  await existing(false); const f = fixture(); assert.equal(loginGate(await user('bound')), 'pending_approval');
  await f.seed.bindSuperAdmin(); const repaired = await user('bound');
  assert.equal(repaired.approvedAt?.getTime(), now); assert.equal(repaired.directoryUpdatedAt.getTime(), now);
  assert.equal(repaired.directoryUpdatedAt.getTime() > old, true); assert.equal(loginGate(repaired), 'ok');
  assert.equal(f.auth.superAdminId(), 'bound'); assert.equal(f.hashes.length, 0);
});
async function preserved(raw = source) {
  await truncateAll(t.raw); await existing(true); const f = fixture(raw); await f.seed.bindSuperAdmin();
  const approved = await user('bound'); assert.equal(approved.approvedAt?.getTime(), old, 'прежнее одобрение не перезаписывается');
  assert.equal(approved.directoryUpdatedAt.getTime(), old, 'каталог одобренного не перезаписывается');
  assert.equal(f.auth.superAdminId(), 'bound');
}
test('R188 прежнее одобрение и directory_updated_at остаются побайтно прежними при повторном bind', async () => {
  // Класс ошибки: запуск сервера перезаписывает дату одобрения и создаёт ложную дельту каталога.
  await preserved();
});
async function scoped(raw = source) {
  await truncateAll(t.raw); await existing(false, true); const f = fixture(raw); await f.seed.bindSuperAdmin();
  assert.equal(!!(await user('bound')).approvedAt, true);
  const regular = await user('regular'); assert.equal(regular.approvedAt, null, 'обычный пользователь остаётся неодобренным');
  assert.equal(regular.directoryUpdatedAt.getTime(), old); assert.equal(loginGate(regular), 'pending_approval');
}
test('R188 ремонт привязанного супер-админа не одобряет обычного пользователя с NULL', async () => {
  // Класс ошибки: bootstrap обходит модерацию регистрации остальных людей.
  await scoped();
});
function mutant(anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'уникальный якорь полного seed-модуля'); return source.replace(anchor, replacement);
}
test('R188 отсутствие approvedAt в INSERT ловится до того, как bind сможет скрыть регрессию', async () => {
  // Класс ошибки: insert снова создаёт владельца с pending_approval.
  await fresh(); await assert.rejects(fresh(mutant('    approvedAt: new Date(),', '')),
    e => e instanceof assert.AssertionError && e.message.includes('INSERT сразу одобряет'));
});
test('R188 отсутствие IS NULL ловится сохранённой датой старого одобрения', async () => {
  // Класс ошибки: повторный bind уничтожает исходную дату approval.
  await preserved(); await assert.rejects(preserved(mutant('and(eq(users.id, userId), isNull(users.approvedAt))', 'eq(users.id, userId)')),
    e => e instanceof assert.AssertionError && e.message.includes('прежнее одобрение'));
});
test('R188 UPDATE без ограничения id ловится неодобренным обычным пользователем', async () => {
  // Класс ошибки: одобрение супер-админа расширено на все аккаунты.
  await scoped(); await assert.rejects(scoped(mutant('.where(and(eq(users.id, userId), isNull(users.approvedAt)))', '.where(sql`true`)')),
    e => e instanceof assert.AssertionError && e.message.includes('обычный пользователь остаётся'));
});
