import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as shared from '@gusvoice/shared';
import Fastify from 'fastify';
import { z } from 'zod';
import ts from 'typescript';
import { BIGFILE_MAX_BYTES } from '../attachmentRules.js';
import * as linkThreatsRules from '../linkThreatsRules.js';

const authSource = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8');
const featuresSource = readFileSync(new URL('../instanceFeatures.ts', import.meta.url), 'utf8');
// Независимый список протокола: проверяем не один fedm1, а весь набор ЛС и звонков.
const federationFeatures = ['fedm1', 'fedm2', 'fedm3', 'fedm4', 'fedm5', 'fedcall1', 'fedm6'];
type Exports = Record<string, unknown>;

function execute(source: string, filename: string, deps: Record<string, unknown>, process: { env: object }): Exports {
  const module: { exports: Exports } = { exports: {} };
  // Исполняем целые модули; env/db/Redis/SMTP/auth не импортируются даже транзитивно.
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, process, require: (id: string) => {
    assert.ok(Object.hasOwn(deps, id), `неописанный импорт ${filename}: ${id}`);
    return deps[id];
  } }, { filename });
  return module.exports;
}

async function checkRuntimeFeatures(source = authSource): Promise<void> {
  const process = { env: Object.freeze({}) }; // Не читаем реальное окружение и тем более .env.
  const env = { federation: { dmEnabled: false } };
  const featuresModule = execute(featuresSource, 'instanceFeatures.ts', {
    '@gusvoice/shared': shared, './linkThreatsRules.js': linkThreatsRules,
  }, process);
  const permanent = Array.from(featuresModule.INSTANCE_FEATURES as readonly string[]);
  assert.ok(permanent.includes('conv1'), 'фикстура использует настоящий список постоянных возможностей');
  const row = { id: 'r290-local-user', username: 'r290-local', displayName: 'Свой человек' };
  const users = { id: Symbol('users.id') };
  let selects = 0;
  let authenticated = 0;
  let serialized = 0;
  // Только внешние границы: SQL заменён одной существующей локальной строкой; serializeUser —
  // стабильным DTO. Ни формат профиля, ни проверку JWT/пароля этот тест не обещает покрывать.
  const db = { select: () => {
    selects++;
    return { from: (table: unknown) => {
      assert.equal(table, users, '/auth/me читает таблицу пользователей');
      return { where: (condition: unknown) => {
        assert.deepEqual(condition, [users.id, row.id], '/auth/me ищет авторизованного человека');
        return { limit: async (limit: number) => {
          assert.equal(limit, 1);
          return [row];
        } };
      } };
    } };
  } };
  const dormant = (id: string): Exports => new Proxy({}, { get: (_target, key) => () => {
    throw new Error(`неожиданный вызов границы ${id}.${String(key)}`);
  } });
  const deps: Record<string, unknown> = Object.fromEntries([
    '../accountDelete.js', '../accountRules.js', 'qrcode', '../federation/guestRevocation.js',
    '../guestGuard.js', '../superAdminRules.js', '../authGuard.js', '../mailer.js',
    '../instanceSetup.js', '../inviteRules.js', '../settings.js', '../setupRules.js',
    '../realtime.js', '../totp.js', '../util.js',
  ].map(id => [id, dormant(id)]));
  Object.assign(deps, {
    '@gusvoice/shared': shared, zod: { z },
    'drizzle-orm': { eq: (left: unknown, right: unknown) => [left, right] },
    '../auth.js': { ...dormant('../auth.js'), requireAuth: async (req: { user?: unknown }) => {
      authenticated++;
      req.user = { sub: row.id };
    } },
    '../db/index.js': { db }, '../db/schema.js': { users }, '../env.js': { env },
    '../instanceFeatures.js': featuresModule, '../attachmentRules.js': { BIGFILE_MAX_BYTES },
    '../serialize.js': { serializeUser: (actual: unknown) => {
      assert.equal(actual, row, 'сериализуется найденная строка');
      serialized++;
      return { ...row };
    } },
  });
  const routeModule = execute(source, 'routes/auth.ts', deps, process);
  const app = Fastify();
  try {
    // Настоящая регистрация всех маршрутов auth.ts и настоящий Fastify.inject; сокета нет.
    await (routeModule.authRoutes as (app: unknown) => Promise<void>)(app);
    let requestNumber = 0;
    for (const enabled of [false, true, false]) {
      env.federation.dmEnabled = enabled;
      const reply = await app.inject({ method: 'GET', url: '/auth/me' });
      requestNumber++;
      assert.equal(reply.statusCode, 200, 'фикстура дошла до успешного ответа /auth/me');
      assert.equal(authenticated, requestNumber, 'preHandler запускается на каждом запросе');
      assert.equal(selects, requestNumber, 'каждый запрос действительно читает пользователя');
      assert.equal(serialized, requestNumber, 'каждый ответ действительно сериализует профиль');
      const data = reply.json() as typeof row & { features: string[]; dmFileMaxBytes: number };
      assert.equal(data.id, row.id);
      assert.equal(data.username, row.username);
      assert.equal(data.displayName, row.displayName);
      assert.equal(data.dmFileMaxBytes, BIGFILE_MAX_BYTES, 'остальное содержимое ответа не теряется');
      assert.deepEqual(data.features, enabled ? [...permanent, ...federationFeatures] : permanent,
        `R290-auth-features: запрос ${requestNumber}, runtime dmEnabled=${enabled}, process.env пуст`);
    }
  } finally { await app.close(); }
}

function replaceOnce(source: string, from: string, to: string): string {
  assert.equal(source.split(from).length - 1, 1, `один адресный якорь контрфакта: ${from}`);
  return source.replace(from, to);
}

function featureFailure(error: unknown): boolean {
  return error instanceof assert.AssertionError && error.operator === 'deepStrictEqual'
    && error.message.startsWith('R290-auth-features: запрос 2, runtime dmEnabled=true');
}

it('R290 /auth/me: без перезапуска добавляет все семь признаков ЛС и звонков и убирает их, сохраняя постоянные', async () => {
  await checkRuntimeFeatures();
});

it('R290 контрфакт: чтение пустого process.env вместо текущего тумблера ломает именно второй ответ /auth/me', async () => {
  await checkRuntimeFeatures(); // original-first: ошибка импорта/фикстуры не доказывает чувствительность.
  const mutant = `import { fedDmEnabledFromEnv } from '@gusvoice/shared';\n${replaceOnce(authSource,
    'instanceFeatures(env.federation.dmEnabled)', 'instanceFeatures(fedDmEnabledFromEnv(process.env))')}`;
  await assert.rejects(() => checkRuntimeFeatures(mutant), featureFailure);
});

it('R290 контрфакт: кеширование признаков при регистрации не замечает включение ЛС в следующем запросе', async () => {
  await checkRuntimeFeatures();
  const cached = replaceOnce(authSource,
    'export async function authRoutes(app: FastifyInstance): Promise<void> {',
    'export async function authRoutes(app: FastifyInstance): Promise<void> {\n'
      + '  const cachedFeatures = instanceFeatures(env.federation.dmEnabled);');
  const mutant = replaceOnce(cached,
    'features: instanceFeatures(env.federation.dmEnabled)', 'features: cachedFeatures');
  await assert.rejects(() => checkRuntimeFeatures(mutant), featureFailure);
});
