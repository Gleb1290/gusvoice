import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import * as orm from 'drizzle-orm';
import { z } from 'zod';
import ts from 'typescript';
import * as schema from '../src/db/schema.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type SwitchModule = typeof import('../src/federation/switch.js');
let t: TestDb;
let env: typeof import('../src/env.js').env;
let instance: typeof import('../src/federation/instance.js');
let auth: typeof import('../src/auth.js');
let audit: typeof import('../src/federation/auditLog.js');
let directory = '';
const apps: ReturnType<typeof Fastify>[] = [];
const readSource = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const switchSource = readSource('federation/switch.ts');
const routeSource = readSource('routes/federationSwitch.ts');
const url = '/admin/federation/switch';
const passphraseKey = 'federation_key_passphrase';
const switchKey = 'federation_switch';

before(async () => {
  // До импорта env отсекаем любые внешние настройки: используются только временные тестовые ключи.
  process.env.FEDERATION_ENABLED = 'false';
  process.env.FEDERATION_DM_ENABLED = 'false';
  process.env.FEDERATION_KEY_PASSPHRASE = '';
  process.env.FEDERATION_DATA_DIR = join(tmpdir(), 'gusvoice-r257-unused-until-switch');
  t = await createTestDb();
  ({ env } = await import('../src/env.js'));
  instance = await import('../src/federation/instance.js');
  auth = await import('../src/auth.js');
  audit = await import('../src/federation/auditLog.js');
});

beforeEach(async () => {
  instance.federation.stop();
  env.federation.enabled = false;
  env.federation.dmEnabled = false;
  env.federation.envEnabled = false;
  env.federation.envDmEnabled = false;
  env.federation.keyPassphrase = '';
  directory = await mkdtemp(join(tmpdir(), 'gusvoice-r257-switch-'));
  env.federation.dataDir = directory;
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    { id: 'r257-owner', username: 'r257-holder', displayName: 'Держатель', passwordHash: 'fixture', verified: true },
    { id: 'r257-ordinary', username: 'r257-owner', displayName: 'Участник', passwordHash: 'fixture', verified: true },
  ]);
  auth.setSuperAdminId('r257-owner');
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  instance.federation.stop();
  // directory получен непосредственно из mkdtemp, пользовательское хранилище сюда попасть не может.
  if (directory) await rm(directory, { recursive: true, force: true });
});
after(async () => { auth?.setSuperAdminId(null); await t?.close(); });

// ЦЕЛЫЕ модули, не извлечённые функции: SQL, env-геттеры, auth, state и keystore настоящие.
// VM нужен только для независимой очереди switch и точечных original-first контрфактов.
function load<T>(source: string, modules: Record<string, unknown>): T {
  const module = { exports: {} };
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  runInNewContext(output, { module, exports: module.exports, Buffer, Date, console,
    require(id: string) {
      assert.ok(Object.hasOwn(modules, id), `R257 закрытый перечень импортов: ${id}`);
      return modules[id];
    },
  });
  return module.exports as T;
}

function switchModule(source = switchSource): SwitchModule {
  return load<SwitchModule>(source, {
    'node:crypto': crypto, 'drizzle-orm': orm,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../env.js': { env }, './instance.js': instance,
  });
}

async function fixture(source = switchSource) {
  const sw = switchModule(source);
  const routes = load<typeof import('../src/routes/federationSwitch.js')>(routeSource, {
    zod: { z }, '../auth.js': auth, '../federation/auditLog.js': audit, '../federation/switch.js': sw,
  });
  const app = Fastify();
  apps.push(app);
  await app.register(routes.federationSwitchRoutes);
  await app.ready();
  return { sw, app };
}

const headers = (sub = 'r257-owner') => ({ authorization: `Bearer ${auth.signToken({
  sub, username: sub === 'r257-ordinary' ? 'r257-owner' : 'r257-holder', gen: 0,
})}` });

async function setting(key: string) {
  const rows = await t.db.select().from(schema.instanceSettings).where(orm.eq(schema.instanceSettings.key, key));
  return rows[0] ?? null;
}

async function storedPassphrase(): Promise<string> {
  const row = await setting(passphraseKey);
  const value = row?.value.passphrase;
  assert.equal(typeof value, 'string', 'в базе есть пароль тестового ключа');
  assert.match(value as string, /^[0-9a-f]{64}$/, '32 случайных байта, не пустая заглушка');
  return value as string;
}

function noSecret(value: unknown, secret: string) {
  const json = JSON.stringify(value);
  assert.ok(!json.includes(secret), 'R257-no-secret: пароль тестового ключа не уходит клиенту');
  assert.deepEqual(Object.keys(value as object).sort(), ['enabled', 'source', 'dmEnabled', 'dmSource', 'status', 'problem'].sort());
}

test('R257 миграция заводит выключенные флаги без пароля и не затирает уже сохранённый выбор', async () => {
  // Повторное применение добавляющей миграции не должно сбрасывать тумблер или создавать лишний секрет.
  const migration = readFileSync(new URL('../drizzle/0148_federation_switch.sql', import.meta.url), 'utf8');
  assert.ok(t.appliedMigrations.includes('0148_federation_switch.sql'));
  await t.raw.exec(migration);
  assert.deepEqual((await setting(switchKey))?.value, { enabled: false, dmEnabled: false });
  assert.equal(await setting(passphraseKey), null);
  await t.db.update(schema.instanceSettings).set({ value: { enabled: true, dmEnabled: true } })
    .where(orm.eq(schema.instanceSettings.key, switchKey));
  await t.raw.exec(migration);
  assert.deepEqual((await setting(switchKey))?.value, { enabled: true, dmEnabled: true });
  assert.equal(await setting(passphraseKey), null);
});

test('R257 запуск читает сохранённые флаги, но отсутствие строки оставляет федерацию выключенной', async () => {
  // Иначе рестарт либо самовольно заводит личность, либо теряет выбор держателя.
  const sw = switchModule();
  await sw.startFederationSwitch();
  assert.equal(sw.federationSwitchView().enabled, false);
  assert.equal(instance.federation.status(), 'off');
  assert.equal(await setting(passphraseKey), null);
  await t.db.insert(schema.instanceSettings).values({ key: switchKey, value: { enabled: true, dmEnabled: true } });
  await sw.startFederationSwitch();
  assert.equal(instance.federation.status(), 'ready');
  assert.equal(sw.federationSwitchView().source, 'panel');
  assert.equal(sw.federationSwitchView().dmEnabled, true);
  assert.equal(sw.federationSwitchView().dmSource, 'panel');
  await storedPassphrase();
});

async function envLock(source = switchSource) {
  env.federation.envEnabled = true;
  env.federation.keyPassphrase = 'r257-only-test-env-passphrase';
  const { sw, app } = await fixture(source);
  await sw.startFederationSwitch();
  const before = await setting(switchKey);
  const refused = await app.inject({ method: 'PATCH', url, headers: headers(), payload: { enabled: false } });
  assert.equal(refused.statusCode, 409, 'R257-env-lock: панель не выключает .env');
  assert.equal(refused.json().error, 'env_locked');
  assert.deepEqual(await setting(switchKey), before);
  assert.equal(instance.federation.status(), 'ready');
  assert.equal(sw.federationSwitchView().source, 'env');
  const accepted = await app.inject({ method: 'PATCH', url, headers: headers(), payload: { dmEnabled: true } });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().dmEnabled, true);
  assert.equal(await setting(passphraseKey), null);
}

test('R257 федерация из .env защищена 409 env_locked, но ЛС можно включить отдельно', async () => {
  // Защита должна относиться только к принудительному флагу, а не блокировать всю панель.
  await envLock();
});

test('R257 ЛС из .env защищены 409 dm_env_locked, повторное включение принимается', async () => {
  // Отдельный флаг обязан иметь отдельную защиту и отдельный код отказа.
  env.federation.envEnabled = true;
  env.federation.envDmEnabled = true;
  env.federation.keyPassphrase = 'r257-only-test-env-passphrase';
  const { sw, app } = await fixture();
  await sw.startFederationSwitch();
  const refused = await app.inject({ method: 'PATCH', url, headers: headers(), payload: { dmEnabled: false } });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, 'dm_env_locked');
  assert.equal(await setting(switchKey), null);
  const accepted = await app.inject({ method: 'PATCH', url, headers: headers(), payload: { dmEnabled: true } });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().dmSource, 'env');
});

test('R257 ЛС без федерации дают federation_off, совместное включение обоих принимается', async () => {
  // Важно проверить и положительный путь одного запроса: нельзя требовать два нажатия вместо одного.
  const { app } = await fixture();
  const refused = await app.inject({ method: 'PATCH', url, headers: headers(), payload: { dmEnabled: true } });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, 'federation_off');
  assert.equal(await setting(switchKey), null);
  assert.equal(await setting(passphraseKey), null);
  const accepted = await app.inject({ method: 'PATCH', url, headers: headers(), payload: { enabled: true, dmEnabled: true } });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().enabled, true);
  assert.equal(accepted.json().dmEnabled, true);
});

test('R257 неверное тело даёт bad-switch, а частичные boolean-патчи сохраняют второе поле', async () => {
  // Пустой объект, строка и null не должны молча менять сохранённые флаги.
  const { app } = await fixture();
  for (const payload of [{}, { enabled: 'true' }, { dmEnabled: 0 }, { enabled: null }, [], { irrelevant: true }]) {
    const response = await app.inject({ method: 'PATCH', url, headers: headers(), payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error, 'bad-switch');
    assert.equal(await setting(switchKey), null);
  }
  for (const [payload, enabled, dmEnabled] of [
    [{ enabled: true }, true, false], [{ dmEnabled: true }, true, true],
    [{ enabled: false }, false, false], [{ enabled: true }, true, true],
    [{ dmEnabled: false }, true, false],
  ] as const) {
    const response = await app.inject({ method: 'PATCH', url, headers: headers(), payload });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().enabled, enabled);
    assert.equal(response.json().dmEnabled, dmEnabled);
  }
  assert.equal((await setting(switchKey))?.value.enabled, true);
  assert.equal((await setting(switchKey))?.value.dmEnabled, false);
});

async function identityCycle(source = switchSource) {
  const sw = switchModule(source);
  assert.equal(await sw.setFederationSwitch({ enabled: true }), null);
  assert.equal(instance.federation.status(), 'ready');
  const before = instance.federation.identity();
  assert.ok(before);
  const publicKey = Buffer.from(before.rootPublicKeyDer);
  const signingKid = instance.federation.signingKey()?.kid;
  assert.ok(signingKid);
  const envelope = await readFile(join(directory, 'fed-root.key'));
  const passphrase = await storedPassphrase();
  const row = await setting(passphraseKey);
  assert.equal(await sw.setFederationSwitch({ enabled: false }), null);
  assert.equal(instance.federation.status(), 'off');
  assert.equal(instance.federation.identity(), null);
  assert.ok(await setting(passphraseKey), 'R257-passphrase-kept: выключение не стирает пароль');
  assert.equal((await setting(passphraseKey))?.value.passphrase, passphrase);
  assert.equal(await sw.setFederationSwitch({ enabled: true }), null);
  assert.equal(instance.federation.status(), 'ready');
  assert.equal(instance.federation.identity()?.instanceId, before.instanceId);
  assert.ok(instance.federation.identity()?.rootPublicKeyDer.equals(publicKey));
  assert.equal(instance.federation.signingKey()?.kid, signingKid);
  assert.ok((await readFile(join(directory, 'fed-root.key'))).equals(envelope), 'ключ не перешифрован и не пересоздан');
  assert.deepEqual(await setting(passphraseKey), row, 'пароль и updatedAt не меняются при повторном включении');
}

test('R257 выкл→вкл сохраняет instance_id, ключи и единственную строку пароля', async () => {
  // Смена личности при простом выключении оборвала бы доверие всех соседей.
  await identityCycle();
});

async function envPassphrase(source = switchSource) {
  env.federation.keyPassphrase = 'r257-only-test-env-passphrase';
  const sw = switchModule(source);
  await sw.setFederationSwitch({ enabled: true });
  assert.equal(instance.federation.status(), 'ready');
  assert.equal(await setting(passphraseKey), null, 'R257-env-no-base: при пароле .env база не заводится');
  const first = instance.federation.identity()?.instanceId;
  await sw.setFederationSwitch({ enabled: false });
  await t.db.insert(schema.instanceSettings).values({ key: passphraseKey, value: { passphrase: 'r257-wrong-test-base-passphrase' } });
  await sw.setFederationSwitch({ enabled: true });
  assert.equal(instance.federation.status(), 'ready', 'неверный пароль базы не мешает открыть ключ паролем .env');
  assert.equal(instance.federation.identity()?.instanceId, first);
  assert.equal((await setting(passphraseKey))?.value.passphrase, 'r257-wrong-test-base-passphrase');
}

test('R257 непустой пароль .env не создаёт строку базы и имеет приоритет над уже записанной', async () => {
  // Проверяем не только отсутствие записи, но и реальное открытие существующего зашифрованного ключа.
  await envPassphrase();
});

test('R257 проигравший INSERT пароля перечитывает победившую строку через ON CONFLICT DO NOTHING', async () => {
  // BEFORE INSERT моделирует другого победителя между SELECT и INSERT, сам конфликт решает настоящий Postgres.
  await t.raw.exec(`
    CREATE FUNCTION r257_passphrase_winner() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.key = 'federation_key_passphrase' AND pg_trigger_depth() = 1 THEN
        INSERT INTO instance_settings(key, value)
          VALUES ('federation_key_passphrase', '{"passphrase":"r257-winning-test-base-passphrase"}'::jsonb);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER r257_passphrase_winner BEFORE INSERT ON instance_settings
      FOR EACH ROW EXECUTE FUNCTION r257_passphrase_winner();
  `);
  try {
    const sw = switchModule();
    assert.equal(await sw.setFederationSwitch({ enabled: true }), null);
    assert.equal(instance.federation.status(), 'ready');
    const row = await setting(passphraseKey);
    assert.equal(row?.value.passphrase, 'r257-winning-test-base-passphrase');
    const id = instance.federation.identity()?.instanceId;
    await sw.setFederationSwitch({ enabled: false });
    await sw.setFederationSwitch({ enabled: true });
    assert.equal(instance.federation.status(), 'ready');
    assert.equal(instance.federation.identity()?.instanceId, id);
    assert.deepEqual(await setting(passphraseKey), row);
  } finally {
    await t.raw.exec('DROP TRIGGER r257_passphrase_winner ON instance_settings; DROP FUNCTION r257_passphrase_winner()');
  }
});

async function secretResponses(source = switchSource) {
  const { sw, app } = await fixture(source);
  const patched = await app.inject({ method: 'PATCH', url, headers: headers(), payload: { enabled: true } });
  assert.equal(patched.statusCode, 200);
  const passphrase = await storedPassphrase();
  noSecret(sw.federationSwitchView(), passphrase);
  noSecret(patched.json(), passphrase);
  const got = await app.inject({ method: 'GET', url, headers: headers() });
  assert.equal(got.statusCode, 200);
  noSecret(got.json(), passphrase);
  const off = await app.inject({ method: 'PATCH', url, headers: headers(), payload: { enabled: false } });
  assert.equal(off.statusCode, 200);
  noSecret(off.json(), passphrase);
}

test('R257 view и ответы GET/PATCH не содержат реально записанный пароль ни при включении, ни при выключении', async () => {
  // Сверка с паролем из SQL ловит утечку под любым именем свойства.
  await secretResponses();
});

for (const method of ['GET', 'PATCH'] as const) test(`R257 ${method} доступен супер-админу, но не анониму и не обычному участнику`, async () => {
  // Настоящие JWT/id проверяют отказ обычному участнику и отсутствие забытых hooks на одной из ручек.
  const { app } = await fixture();
  for (const [who, code] of [['anonymous', 401], ['r257-ordinary', 403], ['r257-owner', 200]] as const) {
    const response = await app.inject({ method, url, ...(who === 'anonymous' ? {} : { headers: headers(who) }),
      ...(method === 'PATCH' ? { payload: { enabled: false } } : {}),
    });
    assert.equal(response.statusCode, code, who);
    if (code !== 200) assert.equal(await setting(switchKey), null, 'отказ не пишет флаги');
    else assert.equal(response.json().enabled, false);
  }
});

function replaceOnce(source: string, anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, `ровно один якорь контрфакта ${anchor}`);
  return source.replace(anchor, replacement);
}

test('R257 контрфакт без envEnabled-защиты ловится реальным 409, после принятого оригинала', async () => {
  // Мутант оставляет runtime включённым: только проверка ответа заметит незаконное принятие патча.
  await envLock();
  const changed = replaceOnce(switchSource,
    "if (patch.enabled === false && env.federation.envEnabled) return 'env_locked';", '');
  await assert.rejects(envLock(changed), e => e instanceof assert.AssertionError && e.message.startsWith('R257-env-lock:'));
});

test('R257 контрфакт генерации пароля при непустом .env ловится отсутствием строки базы', async () => {
  // Лишний секрет в дампе — регрессия даже тогда, когда федерация всё ещё успешно запускается.
  await envPassphrase();
  await t.db.delete(schema.instanceSettings).where(orm.eq(schema.instanceSettings.key, passphraseKey));
  instance.federation.stop();
  env.federation.enabled = false;
  const changed = replaceOnce(switchSource,
    "if (env.federation.keyPassphrase) useFederationPassphrase(env.federation.keyPassphrase, 'env');",
    "if (env.federation.keyPassphrase) { await passphraseFromBase(); useFederationPassphrase(env.federation.keyPassphrase, 'env'); }");
  await assert.rejects(envPassphrase(changed), e => e instanceof assert.AssertionError && e.message.startsWith('R257-env-no-base:'));
});

test('R257 контрфакт удаления пароля при выключении ловится до повторного запуска', async () => {
  // Иначе тест мог бы лишь увидеть key-error и не доказать причину потери личности.
  await identityCycle();
  const changed = replaceOnce(switchSource, 'federation.stop();',
    'federation.stop(); await db.delete(instanceSettings).where(eq(instanceSettings.key, FED_PASSPHRASE_KEY));');
  await assert.rejects(identityCycle(changed), e => e instanceof assert.AssertionError && e.message.startsWith('R257-passphrase-kept:'));
});

test('R257 контрфакт пароля в view ловится сравнением с реальным значением базы', async () => {
  // Вредная добавка сохраняет все легальные поля: нельзя ловить её лишь поломанной формой ответа.
  await secretResponses();
  const passphrase = await storedPassphrase();
  const changed = replaceOnce(switchSource, 'problem: federation.problem(),',
    `problem: federation.problem(), passphrase: ${JSON.stringify(passphrase)},`);
  await assert.rejects(secretResponses(changed), e => e instanceof assert.AssertionError && e.message.startsWith('R257-no-secret:'));
});
