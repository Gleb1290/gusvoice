import { counterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as zod from 'zod';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import { dayKey, seasonId } from '../src/coinRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

// Настоящие миграции, route, coins, Zod, Fastify.inject и Postgres в памяти.
// Закрытый загрузчик подменяет только внешние IO/авторизацию, а не расчёт/SQL.
type Edit = { file: string; from: string; to: string };
const NOW = Date.parse('2026-10-28T12:00:00Z');
const TODAY = dayKey(new Date(NOW));
const SEASON = seasonId(new Date(NOW));
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => {
  await t?.close();
  const { pool } = await import('../src/db/index.js');
  await pool.end();
});

const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function edited(source: string, edit?: Pick<Edit, 'from' | 'to'>): string {
  if (!edit) return source;
  assert.equal(source.split(edit.from).length, 2, 'уникальный якорь мутанта');
  return source.replace(edit.from, edit.to);
}

async function seed() {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['human', 'other'].map(id => ({
    id, username: id, displayName: id, passwordHash: 'fixture', verified: true,
  })));
  await t.db.insert(schema.servers).values(['server', 'fresh'].map(id => ({ id, name: id, ownerId: 'human' })));
  await t.db.insert(schema.serverMembers).values({ serverId: 'server', userId: 'human' });
  await t.db.insert(schema.serverEconomy).values({
    serverId: 'server', enabled: true, currencyName: 'Старые монеты', aloneCap: 37, closedSeasonId: SEASON,
  });
}

async function fixture(edit?: Edit) {
  await seed();
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? NOW : value instanceof Date ? value.getTime() : value); }
    static override now() { return NOW; }
  }
  const errors: string[] = [];
  const writes: unknown[] = [];
  const fail = () => { throw new Error('неожиданный внешний IO'); };
  const values: Record<string, unknown> = {
    'db/index': { db: t.db }, 'db/schema': schema,
    env: { env: { economyPreviewUsers: [] } }, util: { id: randomUUID },
    auth: { requireAuth: async (req: { user: unknown }) => { req.user = { sub: 'human' }; } },
    permissions: { getMemberContext: async () => ({ serverPermissions: shared.Permission.MANAGE_ECONOMY }) },
    audit: { writeAudit: async (...args: unknown[]) => { writes.push(['audit', ...args]); } },
    realtime: {
      publishToUser: fail,
      publishToServer: async (...args: unknown[]) => { writes.push(['server', ...args]); },
      redisPub: { get: async () => null },
    },
    shop: { shopFor: async () => [] }, purchase: { buyItem: fail },
    instanceSettings: { avatarPriceMinutes: fail, avatarRentalMaxDays: fail },
    storage: { putMedia: fail, storageConfigured: fail },
  };
  const files = new Set(['coins', 'coinRules', 'streakRules', 'seasons', 'economyDefaults',
    'gooseRules', 'voiceActivityRules', 'levelRules', 'shopRules', 'gameMoney', 'gameMoneyRules', 'routes/economy']);
  const modules = new Map<string, any>();
  function load(name: string): any {
    if (Object.hasOwn(values, name)) return values[name];
    if (modules.has(name)) return modules.get(name);
    assert.ok(files.has(name), `закрытый импорт ${name}`);
    const source = edited(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'),
      edit?.file === name ? edit : undefined);
    const module = { exports: {} };
    modules.set(name, module.exports);
    runInNewContext(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer,
      console: { log() {}, error: (...args: unknown[]) => { errors.push(args.join(' ')); } },
      require(id: string) {
        if (id === '@gusvoice/shared') return shared;
        if (id === 'drizzle-orm') return orm;
        if (id === 'zod') return zod;
        assert.ok(id.startsWith('.'), `внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
      },
    });
    return module.exports;
  }
  const app = Fastify();
  // Сам index.ts не импортируем: он запускает сервер/фоновые задачи. Здесь только
  // адаптер той же границы ZodError -> HTTP 400; production error-handler им не покрыт.
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof zod.ZodError) return reply.code(400).send({ error: 'validation', details: error.issues });
    errors.push(String(error));
    return reply.code(500).send({ error: 'unexpected fixture error' });
  });
  try {
    await app.register(load('routes/economy').economyRoutes);
    await app.ready();
  } catch (error) { await app.close(); throw error; }
  return { app, errors, writes };
}

async function migrationScenario(edit?: Pick<Edit, 'from' | 'to'>) {
  await seed();
  await t.db.insert(schema.coinBalances).values({ serverId: 'server', userId: 'human', balance: 71, earnedTotal: 89 });
  assert.ok(t.appliedMigrations.includes('0158_alone_cap.sql'), 'harness действительно применил 0158');
  const source = readFileSync(new URL('../drizzle/0158_alone_cap.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // Полная production-схема, но без двух новых колонок: строки существуют ДО
  // применения 0158. Транзакция откатит DDL даже после пойманного мутанта.
  await t.raw.exec('BEGIN');
  try {
    await t.raw.exec('ALTER TABLE server_economy DROP COLUMN alone_cap; ALTER TABLE coin_balances DROP COLUMN alone_earned_milli;');
    await t.raw.exec(edited(source, edit));
    const economy = await t.raw.query<{ alone_cap: number; currency_name: string }>(
      "SELECT alone_cap, currency_name FROM server_economy WHERE server_id = 'server'",
    );
    const wallet = await t.raw.query<{ alone_earned_milli: number; balance: number; earned_total: number }>(
      "SELECT alone_earned_milli, balance, earned_total FROM coin_balances WHERE server_id = 'server' AND user_id = 'human'",
    );
    assert.deepEqual(economy.rows, [{ alone_cap: 90, currency_name: 'Старые монеты' }], 'R317 миграция: старые настройки получают 90');
    assert.deepEqual(wallet.rows, [{ alone_earned_milli: 0, balance: 71, earned_total: 89 }], 'R317 миграция: старый кошелёк получает 0 без изменения денег');
    await t.raw.exec("INSERT INTO server_economy(server_id) VALUES ('fresh'); INSERT INTO coin_balances(server_id, user_id) VALUES ('server', 'other');");
    assert.equal((await t.raw.query<{ alone_cap: number }>("SELECT alone_cap FROM server_economy WHERE server_id = 'fresh'")).rows[0].alone_cap,
      90, 'R317 миграция: новые настройки получают 90');
    assert.equal((await t.raw.query<{ alone_earned_milli: number }>("SELECT alone_earned_milli FROM coin_balances WHERE user_id = 'other'")).rows[0].alone_earned_milli,
      0, 'R317 миграция: новый кошелёк получает 0');
  } finally { await t.raw.exec('ROLLBACK'); }
}

test('R317 миграция 0158 добавляет 90/0 существующим и новым строкам, не меняя деньги', () => migrationScenario());
for (const [name, from, to] of [
  ['порог старым строкам обнулён', 'alone_cap integer NOT NULL DEFAULT 90', 'alone_cap integer NOT NULL DEFAULT 0'],
  ['кошелёк начинает с одной тысячной', 'alone_earned_milli integer NOT NULL DEFAULT 0', 'alone_earned_milli integer NOT NULL DEFAULT 1'],
] as const) test(`R317 миграция: контрфакт ${name}`, async () => {
  await migrationScenario();
  await counterfact(async () => {
  await assert.rejects(migrationScenario({ from, to }), e => e instanceof assert.AssertionError && e.message.startsWith('R317 миграция:'));
  });
});

async function patchScenario(edit?: Edit) {
  const f = await fixture(edit);
  try {
    for (const aloneCap of [0, 90, 1_000_000]) {
      const response = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy', payload: { aloneCap } });
      assert.equal(response.statusCode, 200, `R317 PATCH: порог ${aloneCap} принимается`);
      assert.equal(response.json().aloneCap, aloneCap, 'R317 PATCH: ответ не теряет настройку');
      const [saved] = await t.db.select().from(schema.serverEconomy).where(orm.eq(schema.serverEconomy.serverId, 'server'));
      assert.equal(saved.aloneCap, aloneCap, 'R317 PATCH: настройка действительно сохранена в SQL');
    }
    for (const aloneCap of [-1, 1_000_001, 90.5]) {
      const before = normal(await t.db.select().from(schema.serverEconomy));
      const writesBefore = normal(f.writes);
      const response = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy', payload: { aloneCap } });
      assert.equal(response.statusCode, 400, `R317 PATCH: порог ${aloneCap} отклоняется`);
      assert.ok(response.json().details.some((issue: { path: string[] }) => issue.path.join('.') === 'aloneCap'), 'отказ именно из-за aloneCap');
      assert.deepEqual(normal(await t.db.select().from(schema.serverEconomy)), before, 'невалидный PATCH не пишет настройки');
      assert.deepEqual(normal(f.writes), writesBefore, 'невалидный PATCH не пишет аудит и не рассылает invalidate');
    }
    // Старый клиент не знает поля: иной PATCH сохраняет прежний порог.
    const response = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy', payload: { currencyName: 'Новое имя' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().aloneCap, 1_000_000, 'R317 PATCH: отсутствие поля не сбрасывает порог');
    assert.deepEqual(f.errors, []);
  } finally { await f.app.close(); }
}

const SETTINGS_LINE = 'aloneCap: z.number().int().min(0).max(1_000_000).optional(),';
test('R317 PATCH принимает 0/90/миллион, отклоняет -1/миллион+1/дробь и сохраняет поле старому клиенту', () => patchScenario());
for (const [name, to] of [
  ['снята нижняя граница', 'aloneCap: z.number().int().max(1_000_000).optional(),'],
  ['снята верхняя граница', 'aloneCap: z.number().int().min(0).optional(),'],
  ['разрешена дробь', 'aloneCap: z.number().min(0).max(1_000_000).optional(),'],
  ['поле исчезло из схемы', ''],
] as const) test(`R317 PATCH: контрфакт ${name}`, async () => {
  await patchScenario();
  await counterfact(async () => {
  await assert.rejects(patchScenario({ file: 'routes/economy', from: SETTINGS_LINE, to }),
    e => e instanceof assert.AssertionError && e.message.startsWith('R317 PATCH:'));
  });
});

async function snapshotScenario(edit?: Edit) {
  const f = await fixture(edit);
  try {
    const get = async (expectedAlone: number, expectedCap: number) => {
      const before = normal(await t.db.select().from(schema.coinBalances));
      const response = await f.app.inject({ method: 'GET', url: '/servers/server/economy' });
      assert.equal(response.statusCode, 200, 'R317 GET: снимок доступен');
      assert.equal(response.json().settings.aloneCap, expectedCap, 'R317 GET: настройки не теряют aloneCap');
      assert.equal(response.json().wallet.aloneEarnedToday, expectedAlone, 'R317 GET: целые монеты одному из тысячных текущих суток');
      assert.deepEqual(normal(await t.db.select().from(schema.coinBalances)), before, 'GET не пишет даже виртуальный перекат в кошелёк');
    };
    await get(0, 37); // Нет кошелька, но ноль должен присутствовать в JSON явно.
    await t.db.delete(schema.serverEconomy).where(orm.eq(schema.serverEconomy.serverId, 'server'));
    await get(0, 90); // Даже ещё не настроенная экономика показывает новый ползунок с умолчанием.
    await t.db.insert(schema.serverEconomy).values({ serverId: 'server', enabled: true, aloneCap: 37, closedSeasonId: SEASON });
    await t.db.insert(schema.coinBalances).values({ serverId: 'server', userId: 'human', day: TODAY, seasonId: SEASON,
      balance: 71, earnedTotal: 89, earnedToday: 321, aloneEarnedMilli: 0 });
    for (const [milli, coins] of [[0, 0], [999, 0], [1000, 1], [12_567, 12], [90_001, 90]]) {
      await t.db.update(schema.coinBalances).set({ aloneEarnedMilli: milli });
      await get(coins, 37);
    }
    // В БД вчерашнее значение остаётся; в ответе уже новые сутки МСК.
    await t.db.update(schema.coinBalances).set({ day: dayKey(new Date(NOW - 86_400_000)), aloneEarnedMilli: 90_001 });
    await get(0, 37);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.writes, [], 'GET не пишет аудит/события');
  } finally { await f.app.close(); }
}

test('R317 GET отдаёт aloneCap и aloneEarnedToday: пусто=0, тысячные округлены вниз, вчера виртуально сброшено', () => snapshotScenario());
const SNAPSHOT_LINE = 'aloneEarnedToday: Math.floor(wallet.aloneEarnedMilli / MILLI),';
const snapshotEdits: [string, Edit][] = [
  ['поле кошелька потеряно', { file: 'routes/economy', from: SNAPSHOT_LINE, to: '' }],
  ['тысячные выданы как монеты', { file: 'routes/economy', from: SNAPSHOT_LINE, to: 'aloneEarnedToday: wallet.aloneEarnedMilli,' }],
  ['дробь округлена вверх', { file: 'routes/economy', from: SNAPSHOT_LINE, to: 'aloneEarnedToday: Math.ceil(wallet.aloneEarnedMilli / MILLI),' }],
  ['настройка потеряна в toEconomy', { file: 'coins', from: 'aloneCap: row.aloneCap,', to: '' }],
  ['вчерашнее показано без переката', { file: 'routes/economy', from: 'const wallet = { ...raw, ...rollPeriods(raw, now, length) };', to: 'const wallet = raw;' }],
];
for (const [name, edit] of snapshotEdits) test(`R317 GET: контрфакт ${name}`, async () => {
  await snapshotScenario();
  await counterfact(async () => {
  await assert.rejects(snapshotScenario(edit), e => e instanceof assert.AssertionError && e.message.startsWith('R317 GET:'));
  });
});
