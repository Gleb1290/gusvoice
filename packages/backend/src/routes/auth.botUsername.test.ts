import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import * as zod from 'zod';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../db/schema.js';

const authSource = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8');
const setupSource = readFileSync(new URL('./setup.ts', import.meta.url), 'utf8');
const seedSource = readFileSync(new URL('../seed.ts', import.meta.url), 'utf8');
const human = { username: 'robotics', email: 'reader@example.test', password: 'synthetic-password' };
type Auth = Pick<typeof import('./auth.js'), 'authRoutes' | 'registerBody'>;
type Setup = Pick<typeof import('./setup.js'), 'setupRoutes'> & { __adminBody: zod.ZodType };
function execute<T>(raw: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, console: { log() {}, warn() {} }, require(id: string) {
      assert.ok(Object.hasOwn(deps, id), `R303 закрытый импорт регистрации: ${id}`); return deps[id];
    } });
  return module.exports as T;
}
function fixture(raw = authSource) {
  const io: string[] = [];
  const unused = (name: string) => new Proxy({}, { get: (_obj, key) => (..._args: unknown[]) => {
    io.push(`${name}.${String(key)}`); throw new Error(`R303 неиспользуемая граница ${name}.${String(key)}`);
  } });
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, zod, 'drizzle-orm': orm, 'node:crypto': crypto,
    '../db/index.js': { db: unused('db') }, '../db/schema.js': schema,
    '../env.js': { env: { setupToken: '', federation: { dmEnabled: false } } },
    '../authGuard.js': { rateHit: async () => 0, clientIp: () => '192.0.2.1' },
  };
  for (const name of ['../accountDelete.js', '../accountRules.js', 'qrcode', '../federation/guestRevocation.js', '../auth.js',
    '../guestGuard.js', '../superAdminRules.js', '../mailer.js', '../instanceSetup.js', '../inviteRules.js', '../settings.js',
    '../setupRules.js', '../realtime.js', '../totp.js', '../util.js', '../instanceFeatures.js', '../attachmentRules.js',
    '../serialize.js', '../federation/instance.js', '../federation/links.js', '../federation/linkRules.js',
    '../federation/instanceMeta.js', '../livekit.js']) deps[name] = unused(name);
  const auth = execute<Auth>(raw, deps);
  // Только ссылка на приватную СХЕМУ целого модуля — ни функция, ни regex из исходника не извлекаются.
  const setup = execute<Setup>(setupSource + '\nexport { adminBody as __adminBody };', { ...deps, './auth.js': auth });
  return { auth, setup, io };
}
it('R303 суффикс bot запрещён человеку без учёта регистра, но не подстрока внутри имени', () => {
  for (const username of ['alicebot', 'AliceBOT', 'x_bot', ' adminbot ']) assert.equal(shared.humanUsernameLooksBot(username), true);
  for (const username of ['robotics', 'bot_reader', 'bot.any', 'reader', '']) assert.equal(shared.humanUsernameLooksBot(username), false);
});
it('R303 обе реальные схемы принимают robotics и сохраняют ошибку именно поля username для bot-ника', () => {
  const f = fixture();
  for (const rule of [f.auth.registerBody, f.setup.__adminBody]) {
    assert.equal(rule.safeParse({ ...human, token: 'synthetic-setup-token' }).success, true);
    for (const username of ['alicebot', 'AliceBOT', 'x_bot']) {
      const parsed = rule.safeParse({ ...human, username, token: 'synthetic-setup-token' });
      assert.equal(parsed.success, false);
      if (parsed.success) assert.fail('бот-ник принят');
      assert.ok(parsed.error.issues.some(issue => issue.path.join('.') === 'username' && issue.message === shared.HUMAN_BOT_USERNAME_ERROR));
    }
  }
  assert.deepEqual(f.io, []);
});
for (const target of ['регистрация', 'мастер установки'] as const) it(`R303 ${target}: bot-ники получают400 до SQL/создания аккаунта`, async () => {
  const f = fixture(), app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    assert.ok(err instanceof zod.ZodError, 'ожидается отказ схемы, не сломанная обвязка');
    return reply.code(400).send({ error: err.issues[0].message });
  });
  try {
    if (target === 'регистрация') await f.auth.authRoutes(app); else await f.setup.setupRoutes(app);
    for (const username of ['alicebot', 'AliceBOT', 'x_bot']) {
      const response = await app.inject({ method: 'POST', url: target === 'регистрация' ? '/auth/register' : '/setup/admin',
        payload: { ...human, username, token: 'synthetic-setup-token' } });
      assert.equal(response.statusCode, 400); assert.equal(response.json().error, shared.HUMAN_BOT_USERNAME_ERROR);
    }
    assert.deepEqual(f.io, [], 'отказ раньше всех внешних границ');
  } finally { await app.close(); }
});
function seed(username: string, existing = false, raw = seedSource) {
  const inserted: unknown[] = [];
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => existing ? [{ id: 'old-admin' }] : [] }) }) }),
    insert: () => ({ values: async (value: unknown) => { inserted.push(value); } }) };
  const module = execute<typeof import('../seed.js')>(raw, {
    'drizzle-orm': orm, '@gusvoice/shared': shared, './db/index.js': { db }, './db/schema.js': schema,
    './env.js': { env: { superAdmin: { username, email: human.email, password: human.password } } },
    './auth.js': { hashPassword: async () => 'synthetic-hash', setSuperAdminId() {} },
    './superAdminRules.js': { bindSuperAdminWith() {}, SUPERADMIN_ID_KEY: 'superadmin-id' },
    './util.js': { id: () => 'new-admin' },
  });
  return { module, inserted };
}
it('R303 новый сид adminbot запрещён, robotics создаётся, существующий adminbot не переименовывается', async () => {
  const rejected = seed('adminbot');
  await assert.rejects(rejected.module.seedSuperAdmin(), (error: unknown) => /такие ники только у ботов/.test(String((error as Error).message)));
  assert.deepEqual(rejected.inserted, []);
  const accepted = seed('robotics'); await accepted.module.seedSuperAdmin(); assert.equal(accepted.inserted.length, 1);
  const old = seed('adminbot', true); await old.module.seedSuperAdmin(); assert.deepEqual(old.inserted, []);
});
it('R303 контрфакт снятой проверки схемы принимает запрещённый ник, оригинал проходит первым', () => {
  function check(raw: string) {
    assert.equal(fixture(raw).auth.registerBody.safeParse({ ...human, username: 'AliceBOT' }).success, false, 'R303 поле регистрации отвергает bot');
  }
  check(authSource);
  const needle = '.refine((u) => !humanUsernameLooksBot(u), HUMAN_BOT_USERNAME_ERROR)';
  assert.equal(authSource.split(needle).length - 1, 1);
  assert.throws(() => check(authSource.replace(needle, '')), (error: unknown) => error instanceof assert.AssertionError
    && error.code === 'ERR_ASSERTION' && error.operator === 'strictEqual' && error.actual === true && error.expected === false
    && error.message.split(/\r?\n/, 1)[0] === 'R303 поле регистрации отвергает bot');
});
