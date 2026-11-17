import assert from 'node:assert/strict';
import { counterfact } from '../../shared/test/counterfacts.js';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as zod from 'zod';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import { dayKey, seasonId } from '../src/coinRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

// Настоящие HTTP-маршруты, Zod, деньги, транзакции и миграции. Подменены только
// авторизация/права и внешние IO; изменяется целый модуль в памяти, не приложение на диске.
type Edit = { file: string; from: string; to: string };
type Wheel = typeof import('../src/gameWheel.js');
const NOW = Date.parse('2026-10-28T12:00:00Z');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let t: TestDb;
before(async () => {
  t = await createTestDb();
  await t.raw.exec("ALTER TABLE coin_ledger ALTER COLUMN created_at SET DEFAULT '2026-10-28T12:00:00Z'::timestamptz");
});
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

async function fixture(edit?: Edit) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['a', 'b', 'owner', 'outside'].map(id => ({
    id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true,
  })));
  await t.db.insert(schema.servers).values(['server', 'elsewhere'].map(id => ({ id, name: id, ownerId: 'owner' })));
  await t.db.insert(schema.serverMembers).values(['a', 'b', 'owner'].map(userId => ({ serverId: 'server', userId })));
  await t.db.insert(schema.channels).values([
    { id: 'voice', name: 'Голос', serverId: 'server', type: 'voice' },
    { id: 'text', name: 'Текст', serverId: 'server', type: 'text' },
    { id: 'foreign', name: 'Другой голос', serverId: 'elsewhere', type: 'voice' },
  ]);
  await t.db.insert(schema.serverEconomy).values({ serverId: 'server', enabled: true, gamesEnabled: true,
    gamesBetMax: 300, gamesDailyLossMax: 0, closedSeasonId: seasonId(new Date(NOW)), gooseMinutes: 0 });
  await t.db.insert(schema.coinBalances).values(['a', 'b', 'owner'].map(userId => ({
    serverId: 'server', userId, balance: 1000, day: dayKey(new Date(NOW)), seasonId: seasonId(new Date(NOW)),
  })));
  await t.db.insert(schema.coinLedger).values(['a', 'b', 'owner'].map(userId => ({
    id: `fund-${userId}`, serverId: 'server', userId, amount: 1000, reason: 'fixture', createdAt: new Date(NOW),
  })));
  let clock = NOW;
  let user = 'a';
  let presenceFailure = false;
  let busy = false;
  const roster = new Map<string, string>([['presence:ch:voice', JSON.stringify([{ userId: 'a' }, { userId: 'b' }])]]);
  const env = { economyPreviewUsers: [] as string[] };
  const wires: Array<{ target: string; message: Record<string, any> }> = [];
  const errors: string[] = [];
  const lockCalls: unknown[][] = [];
  const locks = new Map<string, string>();
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? clock : value instanceof Date ? value.getTime() : value); }
    static override now() { return clock; }
  }
  const fail = () => { throw new Error('R328 setup: неожиданный внешний IO'); };
  const values: Record<string, unknown> = {
    'db/index': { db: t.db }, 'db/schema': schema, env: { env }, util: { id: crypto.randomUUID },
    auth: { requireAuth: async (req: { user: unknown; headers: Record<string, unknown> }) => {
      req.user = { sub: req.headers['x-user'] ?? user };
    } },
    permissions: { getMemberContext: async (serverId: string, userId: string) => {
      const [member] = await t.db.select().from(schema.serverMembers)
        .where(orm.and(orm.eq(schema.serverMembers.serverId, serverId), orm.eq(schema.serverMembers.userId, userId))).limit(1);
      return member ? { serverPermissions: userId === 'owner' ? shared.Permission.MANAGE_ECONOMY : 0n } : null;
    } },
    audit: { writeAudit: async () => {} },
    // Шлюз — внешняя IO-граница; новые игры с выбором здесь не разыгрываются.
    gateway: { userHasCap: () => true },
    realtime: {
      publishToServer: async (target: string, message: Record<string, any>) => { wires.push({ target, message: normal(message) }); },
      publishToUser: async (target: string, message: Record<string, any>) => { wires.push({ target, message: normal(message) }); },
      redisPub: {
        get: async () => null,
        pipeline() {
          const keys: string[] = [];
          return { get(key: string) { keys.push(key); return this; }, async exec() {
            if (presenceFailure) throw new Error('synthetic Redis outage');
            return keys.map(key => [null, roster.get(key) ?? null]);
          } };
        },
        async set(key: string, token: string, ...args: unknown[]) {
          lockCalls.push([key, token, ...args]);
          if (busy || locks.has(key)) return null;
          locks.set(key, token);
          return 'OK';
        },
        async eval(_script: string, _count: number, key: string, token: string) {
          if (locks.get(key) !== token) return 0;
          locks.delete(key); return 1;
        },
      },
    },
    shop: { shopFor: async () => [] }, purchase: { buyItem: fail },
    instanceSettings: { avatarPriceMinutes: fail, avatarRentalMaxDays: fail },
    storage: { putMedia: fail, storageConfigured: fail },
  };
  const files = new Set(['coins', 'coinRules', 'streakRules', 'seasons', 'economyDefaults',
    'gooseRules', 'voiceActivityRules', 'levelRules', 'shopRules', 'gameMoney', 'gameMoneyRules',
    'gameWheel', 'gameWheelRules', 'routes/gameWheel', 'routes/economy',
    'routes/gameDuel', 'gameDuel', 'gameDuelRules', 'voicePresence',
    'routes/gamePredictions', 'gamePredictions', 'gamePredictionRules',
    'routes/gameBoard', 'gameMonths', 'gameTitlesData', 'gameTitlesRules']);
  const modules = new Map<string, any>();
  function load(name: string): any {
    if (Object.hasOwn(values, name)) return values[name];
    if (modules.has(name)) return modules.get(name);
    assert.ok(files.has(name), `R328 setup: закрытый импорт ${name}`);
    let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    if (edit?.file === name) {
      assert.equal(source.split(edit.from).length, 2, 'R328 setup: уникальный якорь целого модуля');
      source = source.replace(edit.from, edit.to);
    }
    const module = { exports: {} };
    modules.set(name, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer, Error, Uint8Array,
      console: { log() {}, warn: (...args: unknown[]) => errors.push(args.join(' ')),
        error: (...args: unknown[]) => errors.push(args.join(' ')) },
      setInterval: fail, // inject не вызывает onListen и не должен заводить worker.
      require(id: string) {
        if (id === '@gusvoice/shared') return shared;
        if (id === 'drizzle-orm') return orm;
        if (id === 'zod') return zod;
        if (id === 'node:crypto') return { ...crypto, randomBytes: (size: number) => Buffer.alloc(size, 3) };
        assert.ok(id.startsWith('.'), `R328 setup: внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
      },
    });
    return module.exports;
  }
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof zod.ZodError) return reply.code(400).send({ error: 'validation', details: error.issues });
    errors.push(String(error));
    return reply.code(500).send({ error: 'unexpected fixture error' });
  });
  try {
    await app.register(load('routes/gameWheel').gameWheelRoutes);
    await app.register(load('routes/economy').economyRoutes);
    await app.ready();
  } catch (error) { await app.close(); throw error; }
  return { app, errors, wires, lockCalls, roster, env, wheel: load('gameWheel') as Wheel,
    at: (ms: number) => { clock = NOW + ms; }, manage: () => { user = 'owner'; },
    outage: () => { presenceFailure = true; }, busy: () => { busy = true; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function moneyState() {
  return normal({ wallets: await t.db.select().from(schema.coinBalances).orderBy(orm.asc(schema.coinBalances.userId)),
    ledger: await t.db.select().from(schema.coinLedger).orderBy(orm.asc(schema.coinLedger.id)),
    rounds: await t.db.select().from(schema.gameRounds), stakes: await t.db.select().from(schema.gameStakes),
    economy: await t.db.select().from(schema.serverEconomy) });
}
async function drift() {
  const rows = await t.raw.query(`SELECT b.user_id FROM coin_balances b LEFT JOIN coin_ledger l USING (server_id,user_id)
    GROUP BY b.server_id,b.user_id,b.balance HAVING b.balance <> COALESCE(SUM(l.amount),0)::int`);
  assert.deepEqual(rows.rows, [], 'R328 HTTP: drift равен нулю');
}
const post = (f: Fixture, payload: unknown = { pick: 1, amount: 100 }, user = 'a') =>
  f.app.inject({ method: 'POST', url: '/servers/server/wheel/bets', payload: payload as any, headers: { 'x-user': user } });
async function view(f: Fixture, user = 'a') {
  const response = await f.app.inject({ method: 'GET', url: '/servers/server/wheel', headers: { 'x-user': user } });
  assert.equal(response.statusCode, 200, 'R328 HTTP: снимок доступен участнику');
  return response.json();
}
async function refused(f: Fixture, status: number, code: string, payload?: unknown, user = 'a') {
  const before = await moneyState();
  const response = await post(f, payload, user);
  assert.equal(response.statusCode, status, `R328 HTTP: отказ ${code} имеет статус ${status}`);
  assert.equal(response.json().error, code, `R328 HTTP: адресная причина ${code}`);
  if (code !== 'not a member' && code !== 'validation') {
    assert.equal(response.json().reason, code, `R328 HTTP: машинная причина ${code} сохранена рядом с error`);
  }
  assert.deepEqual(await moneyState(), before, `R328 HTTP: отказ ${code} не пишет деньги/раунд/сундук`);
  return response.json();
}
function paired(title: string, check: (f: Fixture) => Promise<void>, edit: Edit) {
  test(`R328 ${title}`, async () => {
    const run = async (mutation?: Edit) => {
      const f = await fixture(mutation);
      try { await check(f); await drift(); assert.deepEqual(f.errors, [], 'R328 HTTP: нет скрытого падения маршрута'); }
      finally { await f.app.close(); }
    };
    await run();
    await counterfact(() => assert.rejects(run(edit), error => error instanceof assert.AssertionError && error.message.startsWith('R328 HTTP:'),
      'мутант проваливает HTTP/SQL-инвариант, а не сборку/импорт'));
    await run(); // Независимые исходные модули + чистая БД после мутанта, без записи production.
  });
}

// Возвращённый после ставки снимок должен быть пригоден клиенту, но не раскрывать исход раунда.
paired('HTTP ставка отдаёт свежий безопасный снимок и настоящий дебет', async f => {
  const empty = await view(f);
  assert.equal(empty.enabled, true, 'R328 HTTP: участник видит включённое колесо');
  assert.equal(empty.round, null);
  const response = await post(f);
  assert.equal(response.statusCode, 200, 'R328 HTTP: корректная ставка принимается');
  const body = response.json();
  assert.equal(body.round?.state, 'open', 'R328 HTTP: POST возвращает открытый раунд');
  assert.equal(body.round.lockAt, new Date(NOW + shared.WHEEL_BET_WINDOW_MS).toISOString());
  assert.equal(body.round.sector, null);
  assert.equal(body.round.seed, undefined);
  assert.equal(body.round.data, undefined);
  assert.deepEqual(body.round.bets, [{ userId: 'a', pick: 1, amount: 100 }]);
  assert.deepEqual(await view(f), body, 'R328 HTTP: POST совпадает со свежим GET');
  const [wallet] = await t.db.select().from(schema.coinBalances).where(orm.eq(schema.coinBalances.userId, 'a'));
  assert.equal(wallet.balance, 900, 'R328 HTTP: списаны ровно 100 монет');
  assert.equal(body.jackpot, 1, 'R328 HTTP: 150 сотых отображаются как одна монета');
}, { file: 'routes/gameWheel', from: 'return reply.send(await wheelSnapshot(serverId, userId));', to: 'return reply.send({ enabled: true });' });

for (const method of ['GET', 'POST'] as const) {
  // Неучастнику не показывается даже снимок и не даётся создать раунд чужого сервера.
  paired(`${method} колеса скрыт от неучастника без побочных записей`, async f => {
    if (method === 'POST') { await refused(f, 404, 'not a member', undefined, 'outside'); return; }
    const before = await moneyState();
    const response = await f.app.inject({ method, url: '/servers/server/wheel', headers: { 'x-user': 'outside' } });
    assert.equal(response.statusCode, 404, 'R328 HTTP: чужой снимок закрыт');
    assert.deepEqual(await moneyState(), before);
  }, { file: 'routes/gameWheel',
    from: method === 'GET'
      ? "if (!ctx) return reply.code(404).send({ error: 'not a member' });\n    return reply.send(await wheelSnapshot(serverId, req.user!.sub));"
      : "if (!ctx) return reply.code(404).send({ error: 'not a member' });\n    const { pick, amount }",
    to: method === 'GET' ? 'return reply.send(await wheelSnapshot(serverId, req.user!.sub));' : 'const { pick, amount }' });
}

// Выключатель проверяется до голоса и не должен превращаться в «не в голосе».
paired('выключенные игры дают games-off раньше проверки голоса', async f => {
  await t.db.update(schema.serverEconomy).set({ gamesEnabled: false });
  f.roster.clear();
  await refused(f, 403, 'games-off');
  assert.equal((await view(f)).enabled, false);
}, { file: 'routes/gameWheel', from: 'if (!economy?.enabled || !economy.gamesEnabled)', to: 'if (!economy?.enabled)' });

// Закрытый показ экономики не обходится прямым запросом на отдельный игровой маршрут.
paired('закрытый показ экономики скрывает GET и запрещает ставку', async f => {
  f.env.economyPreviewUsers.push('owner');
  await refused(f, 403, 'games-off');
  const body = await view(f);
  assert.equal(body.enabled, false, 'R328 HTTP: скрытое колесо выключено');
  assert.equal(body.round, null);
}, { file: 'coins', from: 'if (!previewAllows(env.economyPreviewUsers, userId)) return null;', to: '' });

// Парный позитив — настоящая ставка выше; пустой Redis не должен становиться разрешением играть.
paired('пустой presence даёт not_in_voice и не создаёт раунд', async f => {
  f.roster.clear();
  await refused(f, 403, 'not_in_voice');
}, { file: 'routes/gameWheel', from: 'if (!(await inVoiceOfServer(serverId, userId)))', to: 'if (false)' });

// Сбой Redis обязан закрывать доступ, а не разрешать его по умолчанию.
paired('ошибка Redis даёт not_in_voice без денежной записи', async f => {
  f.outage();
  await refused(f, 403, 'not_in_voice');
}, { file: 'gameWheel', from: '  } catch {\n    return false;\n  }\n}', to: '  } catch {\n    return true;\n  }\n}' });

for (const [channel, predicate] of [
  ['foreign', 'eq(channels.serverId, serverId)'], ['text', "eq(channels.type, 'voice')"],
] as const) {
  // Нахождение в голосе другого сервера или одноимённом текстовом ключе не является присутствием здесь.
  paired(`presence только в ${channel === 'foreign' ? 'чужом голосе' : 'текстовом канале'} не разрешает ставку`, async f => {
    f.roster.clear();
    f.roster.set(`presence:ch:${channel}`, JSON.stringify([{ userId: 'a' }]));
    await refused(f, 403, 'not_in_voice');
  }, { file: 'gameWheel',
    from: ".where(and(eq(channels.serverId, serverId), eq(channels.type, 'voice')))",
    to: `.where(${predicate === 'eq(channels.serverId, serverId)' ? "eq(channels.type, 'voice')" : 'eq(channels.serverId, serverId)'})` });
}

// Замок от двойного нажатия — отказ 429, не списание второй ставки и не вечный Redis-ключ.
paired('занятый замок возвращает busy 429 с NX и ограниченным TTL', async f => {
  f.busy();
  await refused(f, 429, 'busy');
  assert.equal(f.lockCalls.length, 1, 'R328 HTTP: замок взят один раз');
  const [key, token, ...args] = f.lockCalls[0];
  assert.equal(key, 'wheel:bet:server:a');
  assert.match(String(token), /^[0-9a-f]{16}$/);
  assert.deepEqual(args, ['PX', 3000, 'NX'], 'R328 HTTP: замок атомарный и временный');
}, { file: 'gameWheel', from: "if ((await redisPub.set(lockKey, token, 'PX', WHEEL_BET_LOCK_MS, 'NX')) !== 'OK') return { ok: false, code: 'busy' };",
  to: "await redisPub.set(lockKey, token, 'PX', WHEEL_BET_LOCK_MS, 'NX');" });

// Повтор той же цифры не должен повторно списывать деньги или добавлять взнос в сундук.
paired('повтор числа получает duplicate_pick 409, другая цифра принимается', async f => {
  assert.equal((await post(f)).statusCode, 200, 'R328 HTTP: первая ставка принимается');
  await refused(f, 409, 'duplicate_pick');
  assert.equal((await post(f, { pick: 3, amount: 7 })).statusCode, 200, 'R328 HTTP: другая цифра принимается');
  assert.equal((await view(f)).round.bets.length, 2, 'R328 HTTP: две разные ставки в одном раунде');
}, { file: 'gameWheelRules', from: "if (block === 'duplicate') return 'duplicate_pick';", to: "if (block === 'duplicate') return 'duplicate';" });

// Проверяется именно отказ схемы HTTP: нижний денежный слой тоже может отклонить неверную ставку.
paired('HTTP принимает все пять цифр и отвергает постороннюю цифру или строку', async f => {
  for (const pick of [1, 3, 5, 10, 20]) {
    assert.equal((await post(f, { pick, amount: 1 })).statusCode, 200, 'R328 HTTP: допустимая цифра принимается');
  }
  for (const pick of [-1, 0, 2, 21, '1']) {
    const body = await refused(f, 400, 'validation', { pick, amount: 1 });
    assert.ok(body.details?.some((issue: { path: string[] }) => issue.path.join('.') === 'pick'), 'R328 HTTP: Zod отвергает неверную цифру');
  }
}, { file: 'routes/gameWheel', from: "pick: z.number().refine(isWheelPick, 'pick'),", to: 'pick: z.number(),' });

for (const [label, wrong, replacement] of [
  ['минимум одна монета', 0, 'amount: z.number().int(),'],
  ['только целые монеты', 1.5, 'amount: z.number().min(1),'],
] as const) {
  paired(`HTTP сумма: ${label}, корректная единица принимается`, async f => {
    assert.equal((await post(f, { pick: 1, amount: 1 })).statusCode, 200, 'R328 HTTP: одна монета принимается');
    const body = await refused(f, 400, 'validation', { pick: 3, amount: wrong });
    assert.ok(body.details?.some((issue: { path: string[] }) => issue.path.join('.') === 'amount'), 'R328 HTTP: ошибочная сумма отвергнута схемой');
  }, { file: 'routes/gameWheel', from: 'amount: z.number().int().min(1),', to: replacement });
}

// Клиенту нужен точный retryAt, иначе после расчёта он не знает, когда снова можно ставить.
paired('HTTP cooldown содержит retryAt и отпускает ровно в срок', async f => {
  assert.equal((await post(f)).statusCode, 200, 'R328 HTTP: есть ставка для полного цикла');
  const locked = shared.WHEEL_BET_WINDOW_MS;
  const settled = locked + shared.WHEEL_SPIN_MS;
  f.at(locked);
  await f.wheel.runWheelTick(new Date(NOW + locked));
  f.at(settled);
  await f.wheel.runWheelTick(new Date(NOW + settled));
  f.at(settled + shared.WHEEL_COOLDOWN_MS - 1);
  const body = await refused(f, 409, 'cooldown');
  assert.equal(body.retryAt, new Date(NOW + settled + shared.WHEEL_COOLDOWN_MS).toISOString(), 'R328 HTTP: точный retryAt в отказе');
  f.at(settled + shared.WHEEL_COOLDOWN_MS);
  assert.equal((await post(f, { pick: 3, amount: 1 })).statusCode, 200, 'R328 HTTP: ровно в retryAt разрешён новый раунд');
}, { file: 'routes/gameWheel', from: 'result.retryAt ? { retryAt: result.retryAt } : {}', to: '{}' });

// Владелец выключает игру посреди любого живого состояния: деньги вернуть сразу, взнос оставить.
for (const [state, field] of [['open', 'gamesEnabled'], ['locked', 'gamesEnabled'], ['open', 'enabled'], ['locked', 'enabled']] as const) {
  paired(`PATCH ${field}=false отменяет ${state}, возвращает ставку ровно один раз и рассылает round:null`, async f => {
    assert.equal((await post(f, { pick: 1, amount: 40 })).statusCode, 200, 'R328 HTTP: есть настоящая ставка');
    if (state === 'locked') {
      f.at(shared.WHEEL_BET_WINDOW_MS);
      await f.wheel.runWheelTick(new Date(NOW + shared.WHEEL_BET_WINDOW_MS));
    }
    const [before] = await t.db.select().from(schema.gameRounds);
    assert.equal(before.state, state, 'R328 HTTP: отменяется нужная стадия');
    f.manage();
    f.wires.length = 0;
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy', payload: { [field]: false } });
      assert.equal(response.statusCode, 200, 'R328 HTTP: выключение принято');
      const [round] = await t.db.select().from(schema.gameRounds);
      const [stake] = await t.db.select().from(schema.gameStakes);
      const [economy] = await t.db.select().from(schema.serverEconomy);
      const [wallet] = await t.db.select().from(schema.coinBalances).where(orm.eq(schema.coinBalances.userId, 'a'));
      const refunds = await t.db.select().from(schema.coinLedger).where(orm.eq(schema.coinLedger.reason, 'wheel.refund'));
      assert.equal(economy[field], false, 'R328 HTTP: выключатель сохранён');
      assert.equal(round.state, 'cancelled', 'R328 HTTP: PATCH отменяет живое колесо');
      assert.ok(stake.refundedAt, 'R328 HTTP: возврат помечен refunded_at');
      assert.equal(wallet.balance, 1000, 'R328 HTTP: ставка полностью возвращена');
      assert.equal(refunds.length, 1, 'R328 HTTP: возврат записан ровно один раз');
      assert.equal(Number(economy.wheelJackpotCents), 60, 'R328 HTTP: взнос 60 сотых остался в сундуке');
      assert.equal((await view(f)).enabled, false, 'R328 HTTP: выключение видно в снимке');
      await drift();
    }
    const states = f.wires.filter(w => w.message.t === 'wheel.state');
    assert.equal(states.length, 1, 'R328 HTTP: повтор выключения не шлёт вторую отмену');
    assert.equal(states[0].target, 'server');
    assert.equal(states[0].message.round, null, 'R328 HTTP: клиенты получили пустой раунд');
  }, { file: 'routes/economy', from: "const cancelled = await withGameMoney((m) => cancelLiveRounds(m, serverId, undefined, 'games-off'));",
    to: 'const cancelled: { id: string; kind: string; eventId?: string }[] = [];' });
}
