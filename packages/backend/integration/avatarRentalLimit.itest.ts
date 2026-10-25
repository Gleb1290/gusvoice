import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import * as orm from 'drizzle-orm';
import { z } from 'zod';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as shopRules from '../src/shopRules.js';
import * as coinRules from '../src/coinRules.js';
import * as streakRules from '../src/streakRules.js';
import * as util from '../src/util.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

const read = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const adminSource = read('routes/admin.ts');
const settingsSource = read('instanceSettings.ts');
const shopSource = read('shop.ts');
const day = 86_400_000;
let t: TestDb;
let auth: typeof import('../src/auth.js');
let economy: typeof import('../src/routes/economy.js');

before(async () => {
  t = await createTestDb();
  auth = await import('../src/auth.js');
  auth.setSuperAdminId('buyer');
  economy = await purchaseModules();
});
beforeEach(async () => {
  await truncateAll(t.raw);
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES ('buyer', 'buyer', 'Buyer', 'fixture');
    INSERT INTO servers (id, name, owner_id) VALUES ('s', 'Server', 'buyer');
    INSERT INTO server_members (server_id, user_id) VALUES ('s', 'buyer');
    INSERT INTO server_economy (server_id, enabled) VALUES ('s', true);
    INSERT INTO coin_balances (server_id, user_id, balance) VALUES ('s', 'buyer', 100000);
  `);
});
after(async () => { await t?.close(); });

function load<T>(file: string, raw: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Buffer, URL, require(id: string) {
      assert.equal(Object.hasOwn(deps, id), true, `описанная граница ${file}: ${id}`); return deps[id];
    } });
  return module.exports as T;
}
function settings(raw = settingsSource) {
  return load<typeof import('../src/instanceSettings.js')>('instanceSettings.ts', raw, {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
    '@gusvoice/shared': shared, './shopRules.js': shopRules,
  });
}
function shop(raw = shopSource) {
  return load<typeof import('../src/shop.js')>('shop.ts', raw, {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
    '@gusvoice/shared': shared, './shopRules.js': shopRules, './coinRules.js': coinRules,
    './instanceSettings.js': settings(),
  });
}

async function purchaseModules() {
  // Никакого actual import coins/economy/realtime: оба потребителя шины получают явную подмену.
  // Авторизация и права не импортируют Redis; JWT, SQL и доменная транзакция остаются настоящими.
  const permissions = await import('../src/permissions.js');
  const realtime = {
    redisPub: { set: async () => 'OK' },
    publishToUser: async () => {},
    publishToServer: () => { throw new Error('непредметный publishToServer'); },
  };
  const coins = load<typeof import('../src/coins.js')>('coins.ts', read('coins.ts'), {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './streakRules.js': streakRules,
    './coinRules.js': coinRules, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './env.js': { env: { economyPreviewUsers: [] } }, './realtime.js': realtime, './util.js': util,
  });
  const purchase = load<typeof import('../src/purchase.js')>('purchase.ts', read('purchase.ts'), {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema, './util.js': util,
  });
  const raw = read('routes/economy.ts');
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z }, '../auth.js': auth,
    '../coins.js': coins, '../coinRules.js': coinRules,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../permissions.js': permissions,
    '../shop.js': shop(), '../shopRules.js': shopRules, '../instanceSettings.js': settings(),
    '../purchase.js': purchase, '../realtime.js': realtime,
  };
  const dormant = new Set(['../audit.js', '../economyDefaults.js', '../gooseRules.js', '../voiceActivityRules.js',
    '../levelRules.js', '../streakRules.js', '../seasons.js', '../storage.js']);
  const ast = ts.createSourceFile('routes/economy.ts', raw, ts.ScriptTarget.Latest, true);
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const id = node.moduleSpecifier.text;
    if (Object.hasOwn(deps, id)) continue;
    assert.equal(dormant.has(id), true, `закрытый перечень economy: ${id}`);
    const bindings = node.importClause?.namedBindings;
    assert.ok(bindings && ts.isNamedImports(bindings));
    deps[id] = Object.fromEntries(bindings.elements.filter(e => !e.isTypeOnly).map(e => [e.propertyName?.text ?? e.name.text,
      () => { throw new Error(`непредметная граница economy ${id}:${e.name.text}`); }]));
  }
  return load<typeof import('../src/routes/economy.js')>('routes/economy.ts', raw, deps);
}

async function admin(raw = adminSource, settingsRaw = settingsSource) {
  // Исполняется весь реальный модуль маршрутов. Авторизация, Zod и SQL настоящие;
  // статистика и не относящиеся к экономике IO — явно закрытые границы.
  const unused = (id: string) => () => { throw new Error(`непредметный IO ${id}`); };
  const dormant = new Set(['../accountDelete.js', '../federation/guestAccess.js', '../federation/directoryEvents.js',
    '../federation/links.js', '../federation/linkRules.js', '../federation/instanceMeta.js', '../mailer.js', '../serialize.js',
    '../settings.js', '../dmRules.js', '../env.js', '../instanceSetup.js', '../instanceUpdate.js', '../dmReports.js',
    '../instanceUpdateRules.js', '../setupRules.js', '../storage.js']);
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z }, '../auth.js': auth,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../instanceSettings.js': settings(settingsRaw), '../economyStats.js': { economyStats: async () => ({}) },
  };
  const ast = ts.createSourceFile('admin.ts', raw, ts.ScriptTarget.Latest, true);
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const id = node.moduleSpecifier.text;
    if (Object.hasOwn(deps, id)) continue;
    assert.equal(dormant.has(id), true, `закрытый перечень admin: ${id}`);
    const bindings = node.importClause?.namedBindings;
    assert.ok(bindings && ts.isNamedImports(bindings));
    deps[id] = Object.fromEntries(bindings.elements.filter(e => !e.isTypeOnly).map(e => [e.propertyName?.text ?? e.name.text, unused(`${id}:${e.name.text}`)]));
  }
  const routes = load<typeof import('../src/routes/admin.js')>('admin.ts', raw, deps);
  const app = Fastify();
  // Тот же контракт ошибок валидации, что у общего HTTP-стенда приложения.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'validation failed' });
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  });
  await app.register(routes.adminRoutes);
  await app.ready();
  return app;
}
const headers = () => ({ authorization: `Bearer ${auth.signToken({ sub: 'buyer', username: 'buyer', gen: 0 })}` });

test('R279 GET экономики возвращает умолчание 60 и разрешённые границы 30…365', async () => {
  // Класс ошибки: свежий инстанс отдаёт неопределённый потолок, клиент не может правильно ограничить покупку.
  const app = await admin();
  try {
    const response = await app.inject({ method: 'GET', url: '/admin/economy', headers: headers() });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.avatarRentalMaxDays, 60);
    assert.equal(body.rentalMaxDaysMin, 30);
    assert.equal(body.rentalMaxDaysLimit, 365);
    assert.equal(body.avatarPriceMinutes, shopRules.SHOP_CATALOG['animated-avatar'].defaultMinutes);
  } finally { await app.close(); }
});

async function partialScenario(raw = settingsSource) {
  const app = await admin(adminSource, raw);
  try {
    for (const [payload, expected] of [
      [{ avatarPriceMinutes: 1234 }, { avatarPriceMinutes: 1234, avatarRentalMaxDays: 60 }],
      [{ avatarRentalMaxDays: 90 }, { avatarPriceMinutes: 1234, avatarRentalMaxDays: 90 }],
      [{ avatarPriceMinutes: 2345 }, { avatarPriceMinutes: 2345, avatarRentalMaxDays: 90 }],
      [{ avatarRentalMaxDays: 30 }, { avatarPriceMinutes: 2345, avatarRentalMaxDays: 30 }],
      [{ avatarRentalMaxDays: 365 }, { avatarPriceMinutes: 2345, avatarRentalMaxDays: 365 }],
    ] as const) {
      const response = await app.inject({ method: 'PUT', url: '/admin/economy', headers: headers(), payload });
      assert.equal(response.statusCode, 200, 'обработчик частичного PUT завершился успешно, а не упал на стенде');
      assert.deepEqual(response.json(), { ok: true, ...expected }, 'R279-partial: PUT не затирает соседнюю настройку');
      const get = await app.inject({ method: 'GET', url: '/admin/economy', headers: headers() });
      assert.equal(get.json().avatarPriceMinutes, expected.avatarPriceMinutes, 'R279-partial: цена сохранена в SQL');
      assert.equal(get.json().avatarRentalMaxDays, expected.avatarRentalMaxDays, 'R279-partial: потолок сохранён в SQL');
    }
  } finally { await app.close(); }
}
test('R279 отдельные PUT цены и потолка сохраняют соседа, обе границы разрешены', async () => {
  // Класс ошибки: старая панель, отправляющая одну цену, сбрасывает новый потолок или наоборот.
  await partialScenario();
});

test('R279 пустой PUT, 29, 366 и дробный потолок отклоняются без изменения настроек', async () => {
  // Класс ошибки: сервер молча подгоняет опечатку либо принимает нулевой/безграничный срок.
  await settings().setAvatarRentalMaxDays(90);
  await settings().setAvatarPriceMinutes(1234);
  const app = await admin();
  try {
    for (const payload of [{}, { avatarRentalMaxDays: 29 }, { avatarRentalMaxDays: 366 }, { avatarRentalMaxDays: 90.5 }]) {
      const response = await app.inject({ method: 'PUT', url: '/admin/economy', headers: headers(), payload });
      assert.equal(response.statusCode, 400);
      assert.equal(await settings().avatarRentalMaxDays(), 90);
      assert.equal(await settings().avatarPriceMinutes(), 1234);
    }
  } finally { await app.close(); }
});

test('R279 чтение из SQL ограничивает старое и повреждённое значение потолка', async () => {
  // Класс ошибки: защита есть только в чистой функции, но хранилище её обходит.
  for (const [input, expected] of [['90', 60], [null, 60], [10, 30], [999, 365], [90.9, 90]] as const) {
    await t.db.insert(schema.instanceSettings).values({ key: 'economy', value: { avatarRentalMaxDays: input } })
      .onConflictDoUpdate({ target: schema.instanceSettings.key, set: { value: { avatarRentalMaxDays: input } } });
    assert.equal(await settings().avatarRentalMaxDays(), expected);
  }
});

async function shopScenario(raw = shopSource) {
  await settings().setAvatarRentalMaxDays(90);
  const items = await shop(raw).shopFor(null);
  assert.equal(items.find(e => e.item === 'animated-avatar')?.rentalMaxDays, 90, 'R279-shop: реальный каталог доставляет потолок клиенту');
  assert.match(items.find(e => e.item === 'animated-avatar')!.hint, /90 дней/);
  assert.equal(items.find(e => e.item === 'soundboard')?.rentalMaxDays, undefined);
  assert.equal(items.find(e => e.item === 'mega-poke')?.rentalMaxDays, undefined);
}
test('R279 shopFor отдаёт настоящий потолок 90 только записи аватара', async () => {
  // Класс ошибки: сервер верно ограничивает покупку, но клиент получает устаревшее умолчание 60.
  await shopScenario();
});

for (const [label, from, to] of [
  ['запись цены без соседнего потолка', '{ ...(await read()), avatarPriceMinutes:', '{ avatarPriceMinutes:'],
  ['запись потолка без соседней цены', '{ ...(await read()), avatarRentalMaxDays:', '{ avatarRentalMaxDays:'],
] as const) test(`R279 контрфакт «${label}» ломает частичный PUT после успешного оригинала`, async () => {
  // Класс ошибки: мутант засчитывается только по host AssertionError с адресным маркером предметного сценария.
  await partialScenario();
  await t.db.delete(schema.instanceSettings);
  assert.equal(settingsSource.split(from).length, 2);
  await assert.rejects(() => partialScenario(settingsSource.replace(from, to)),
    (error: unknown) => error instanceof assert.AssertionError && error.message.split('\n', 1)[0] === 'R279-partial: PUT не затирает соседнюю настройку');
});

test('R279 контрфакт каталога без rentalMaxDays ломает доставку настройки после успешного оригинала', async () => {
  // Класс ошибки: поле DTO не должно потеряться при формировании реального ответа магазина.
  await shopScenario();
  const from = '            rentalMaxDays,';
  assert.equal(shopSource.split(from).length, 2);
  await assert.rejects(() => shopScenario(shopSource.replace(from, '')),
    (error: unknown) => error instanceof assert.AssertionError && error.message.split('\n', 1)[0] === 'R279-shop: реальный каталог доставляет потолок клиенту');
});

test('R279 при потолке 90 остаток 55 продлевается, а 65 запрещён с числами 90 и 60', async () => {
  // Класс ошибки: маршрут забывает передать настройку в раннюю или транзакционную проверку и текст отказа.
  await settings().setAvatarRentalMaxDays(90);
  const app = Fastify();
  await app.register(economy.economyRoutes);
  await app.ready();
  const buy = () => app.inject({ method: 'POST', url: '/servers/s/shop/animated-avatar/buy', headers: headers() });
  try {
    const paid = new Date(Date.now() + 55 * day);
    await t.db.update(schema.users).set({ animatedAvatarUntil: paid }).where(orm.eq(schema.users.id, 'buyer'));
    const yes = await buy();
    assert.equal(yes.statusCode, 200);
    assert.equal(new Date(yes.json().until).getTime(), paid.getTime() + 30 * day);
    const before = await t.db.select().from(schema.coinBalances);
    const until = new Date(Date.now() + 65 * day);
    await t.db.update(schema.users).set({ animatedAvatarUntil: until }).where(orm.eq(schema.users.id, 'buyer'));
    const no = await buy();
    assert.equal(no.statusCode, 403);
    assert.equal(no.json().error, shared.avatarRentalFullText(90));
    assert.match(no.json().error, /90 дней/); assert.match(no.json().error, /60 дней/);
    assert.deepEqual(await t.db.select().from(schema.coinBalances), before);
    await settings().setAvatarRentalMaxDays(30);
    const rows = await t.db.select().from(schema.users).where(orm.eq(schema.users.id, 'buyer'));
    assert.equal(rows[0]!.animatedAvatarUntil!.getTime(), until.getTime(), 'понижение потолка не отнимает уже оплаченный срок');
    assert.equal((await buy()).statusCode, 403);
    assert.equal((await t.db.select().from(schema.users).where(orm.eq(schema.users.id, 'buyer')))[0]!.animatedAvatarUntil!.getTime(), until.getTime());
    // Парный отказ именно по деньгам: аренда снова допустима, но кошелёк пуст.
    await t.db.update(schema.users).set({ animatedAvatarUntil: null }).where(orm.eq(schema.users.id, 'buyer'));
    await t.db.update(schema.coinBalances).set({ balance: 0 }).where(orm.eq(schema.coinBalances.userId, 'buyer'));
    const purchases = await t.db.select().from(schema.coinPurchases);
    const poor = await buy();
    assert.equal(poor.statusCode, 403);
    assert.equal(poor.json().error, shopRules.BUY_BLOCK_TEXT.poor);
    assert.deepEqual(await t.db.select().from(schema.coinPurchases), purchases);
    assert.equal((await t.db.select().from(schema.coinBalances))[0]!.balance, 0);
    assert.equal((await t.db.select().from(schema.users).where(orm.eq(schema.users.id, 'buyer')))[0]!.animatedAvatarUntil, null);
  } finally { await app.close(); }
});
