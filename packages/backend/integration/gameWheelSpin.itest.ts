import { counterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
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

// Настоящие HTTP, деньги и PostgreSQL; подменены только часы, авторизация и внешняя шина.
// Мутанты меняют целый модуль в памяти, не production-файл. Соседние игры здесь не регистрируются.
type Edit = { file: string; from: string; to: string };
type Wheel = typeof import('../src/gameWheel.js');
const NOW = Date.parse('2026-10-29T12:00:00Z');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let t: TestDb;
before(async () => {
  t = await createTestDb();
  await t.raw.exec("ALTER TABLE coin_ledger ALTER COLUMN created_at SET DEFAULT '2026-10-29T12:00:00Z'::timestamptz");
});
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

async function fixture(edit?: Edit) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['a', 'b', 'owner', 'outside'].map(id => ({
    id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true,
  })));
  await t.db.insert(schema.servers).values(['server', 'elsewhere'].map(id => ({ id, name: id, ownerId: 'owner' })));
  await t.db.insert(schema.serverMembers).values(['a', 'b', 'owner'].map(userId => ({ serverId: 'server', userId })));
  await t.db.insert(schema.channels).values({ id: 'voice', name: 'Голос', serverId: 'server', type: 'voice' });
  await t.db.insert(schema.serverEconomy).values(['server', 'elsewhere'].map(serverId => ({
    serverId, enabled: true, gamesEnabled: true, gamesBetMax: 300, gamesDailyLossMax: 0,
    closedSeasonId: seasonId(new Date(NOW)), gooseMinutes: 0,
  })));
  await t.db.insert(schema.coinBalances).values(['a', 'b', 'owner'].map(userId => ({
    serverId: 'server', userId, balance: 1000, day: dayKey(new Date(NOW)), seasonId: seasonId(new Date(NOW)),
  })));
  await t.db.insert(schema.coinLedger).values(['a', 'b', 'owner'].map(userId => ({
    id: `fund-${userId}`, serverId: 'server', userId, amount: 1000, reason: 'fixture', createdAt: new Date(NOW),
  })));
  let clock = NOW;
  const roster = new Map([['presence:ch:voice', JSON.stringify([{ userId: 'a' }, { userId: 'b' }])]]);
  const locks = new Map<string, string>();
  const wires: Array<{ target: string; message: Record<string, any> }> = [];
  const errors: string[] = [];
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? clock : value instanceof Date ? value.getTime() : value); }
    static override now() { return clock; }
  }
  const unexpected = () => { throw new Error('R354 spin setup: неожиданный внешний IO'); };
  const values: Record<string, unknown> = {
    'db/index': { db: t.db }, 'db/schema': schema,
    env: { env: { economyPreviewUsers: [], wheelForceJackpot: false } }, util: { id: crypto.randomUUID },
    auth: { requireAuth: async (req: { user: unknown; headers: Record<string, unknown> }) => {
      req.user = { sub: req.headers['x-user'] ?? 'a' };
    } },
    permissions: { getMemberContext: async (serverId: string, userId: string) => {
      const [member] = await t.db.select().from(schema.serverMembers)
        .where(orm.and(orm.eq(schema.serverMembers.serverId, serverId), orm.eq(schema.serverMembers.userId, userId))).limit(1);
      return member ? { serverPermissions: userId === 'owner' ? shared.Permission.MANAGE_ECONOMY : 0n } : null;
    } },
    audit: { writeAudit: async () => {} },
    'routes/gameDuel': { gameDuelRoutes: async () => {} },
    'routes/gamePredictions': { gamePredictionRoutes: async () => {} },
    'routes/gameBoard': { gameBoardRoutes: async () => {} },
    realtime: {
      publishToServer: async (target: string, message: Record<string, any>) => { wires.push({ target, message: normal(message) }); },
      publishToUser: async (target: string, message: Record<string, any>) => { wires.push({ target, message: normal(message) }); },
      redisPub: {
        get: async () => null,
        pipeline() {
          const keys: string[] = [];
          return { get(key: string) { keys.push(key); return this; }, async exec() { return keys.map(key => [null, roster.get(key) ?? null]); } };
        },
        async set(key: string, token: string) {
          if (locks.has(key)) return null;
          locks.set(key, token); return 'OK';
        },
        async eval(_script: string, _count: number, key: string, token: string) {
          if (locks.get(key) !== token) return 0;
          locks.delete(key); return 1;
        },
      },
    },
  };
  const files = new Set(['coins', 'coinRules', 'streakRules', 'seasons', 'economyDefaults',
    'gameMoney', 'gameMoneyRules', 'gameWheel', 'gameWheelRules', 'routes/gameWheel']);
  const modules = new Map<string, any>();
  function load(name: string): any {
    if (Object.hasOwn(values, name)) return values[name];
    if (modules.has(name)) return modules.get(name);
    assert.ok(files.has(name), `R354 spin setup: закрытый импорт ${name}`);
    let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    if (edit?.file === name) {
      assert.equal(source.split(edit.from).length, 2, 'R354 spin setup: уникальный якорь целого модуля');
      source = source.replace(edit.from, edit.to);
    }
    const module = { exports: {} };
    modules.set(name, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer, Error, Uint8Array,
      console: { log() {}, warn: (...args: unknown[]) => errors.push(args.join(' ')), error: (...args: unknown[]) => errors.push(args.join(' ')) },
      setInterval: unexpected,
      require(id: string) {
        if (id === '@gusvoice/shared') return shared;
        if (id === 'drizzle-orm') return orm;
        if (id === 'zod') return zod;
        if (id === 'node:crypto') return { ...crypto, randomBytes: (size: number) => Buffer.alloc(size, 3) };
        assert.ok(id.startsWith('.'), `R354 spin setup: внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
      },
    });
    return module.exports;
  }
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => {
    errors.push(String(error));
    return reply.code(500).send({ error: 'unexpected fixture error' });
  });
  try { await app.register(load('routes/gameWheel').gameWheelRoutes); await app.ready(); }
  catch (error) { await app.close(); throw error; }
  return { app, wires, errors, roster, wheel: load('gameWheel') as Wheel, at: (ms: number) => { clock = NOW + ms; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const MARK = 'R354/spin/';
const spin = (f: Fixture, user = 'a', server = 'server') => f.app.inject({
  method: 'POST', url: `/servers/${server}/wheel/spin`, headers: { 'x-user': user },
});
const bet = (f: Fixture, user = 'a', pick = 1) => f.app.inject({
  method: 'POST', url: '/servers/server/wheel/bets', payload: { pick, amount: 100 }, headers: { 'x-user': user },
});
const states = (f: Fixture) => f.wires.filter(w => w.message.t === 'wheel.state');
const results = (f: Fixture) => f.wires.filter(w => w.message.t === 'wheel.result');
async function round() {
  const [row] = await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.serverId, 'server'));
  assert.ok(row, `${MARK}fixture/round`);
  return row;
}
async function money() {
  return normal({
    wallets: await t.db.select().from(schema.coinBalances).orderBy(orm.asc(schema.coinBalances.userId)),
    ledger: await t.db.select().from(schema.coinLedger).orderBy(orm.asc(schema.coinLedger.id)),
    stakes: await t.db.select().from(schema.gameStakes).orderBy(orm.asc(schema.gameStakes.userId), orm.asc(schema.gameStakes.pick)),
    economy: await t.db.select().from(schema.serverEconomy).orderBy(orm.asc(schema.serverEconomy.serverId)),
  });
}
async function drift() {
  const rows = await t.raw.query(`SELECT b.user_id FROM coin_balances b LEFT JOIN coin_ledger l USING (server_id,user_id)
    GROUP BY b.server_id,b.user_id,b.balance HAVING b.balance <> COALESCE(SUM(l.amount),0)::int`);
  assert.deepEqual(rows.rows, [], `${MARK}drift`);
}
async function opened(f: Fixture) {
  assert.equal((await bet(f)).statusCode, 200, `${MARK}fixture/bet`);
  const row = await round();
  assert.equal(row.state, 'open', `${MARK}fixture/open`);
  f.wires.length = 0;
  return row;
}
async function refused(f: Fixture, status: number, reason: string, user = 'a', server = 'server') {
  const before = normal({ money: await money(), rounds: await t.db.select().from(schema.gameRounds) });
  const response = await spin(f, user, server);
  assert.equal(response.statusCode, status, `${MARK}refused/${reason}`);
  assert.equal(response.json().error, reason, `${MARK}refused/${reason}`);
  if (reason !== 'not a member') assert.equal(response.json().reason, reason, `${MARK}refused/${reason}`);
  assert.deepEqual(normal({ money: await money(), rounds: await t.db.select().from(schema.gameRounds) }), before,
    `${MARK}refused/${reason}/no-writes`);
  assert.equal(f.wires.length, 0, `${MARK}refused/${reason}/no-events`);
}
async function run(check: (f: Fixture) => Promise<void>, edit?: Edit) {
  const f = await fixture(edit);
  try { await check(f); await drift(); assert.deepEqual(f.errors, [], `${MARK}no-hidden-errors`); }
  finally { await f.app.close(); }
}
function paired(title: string, label: string, check: (f: Fixture) => Promise<void>, edit: () => Edit) {
  test(`R354 ${title}`, async () => {
    await run(check);
    await counterfact(async () => {
    await assert.rejects(run(check, edit()), error => error instanceof assert.AssertionError && error.message.startsWith(`${MARK}${label}`),
      'контрфакт падает на адресном HTTP/SQL-инварианте, не на импорте/сборке');
    });
    await run(check);
  });
}

// Пустое колесо не должно случайно создавать раунд без ставки и движения денег.
test('R354 досрочное вращение без раунда даёт no_round 409 без записей и событий', async () => {
  await run(async f => { await refused(f, 409, 'no_round'); });
});

// Наличие чужой ставки не даёт человеку без своей ставки закрыть общий приём.
paired('без своей ставки вращение запрещено, поставившему разрешено', 'refused/no_bet', async f => {
  await opened(f);
  await refused(f, 403, 'no_bet', 'b');
  assert.equal((await spin(f)).statusCode, 200, `${MARK}bettor/accepted`);
  assert.equal((await round()).state, 'locked', `${MARK}bettor/locked`);
}, () => ({ file: 'gameWheel', from: "if (!bet) return { ok: false as const, code: 'no_bet' as const };", to: '' }));

// Проверка членства должна предшествовать даже чтению/закрытию известного чужого раунда.
test('R354 вращение чужого сервера и запрос неучастника закрыты ответом 404', async () => {
  await run(async f => {
    await opened(f);
    await refused(f, 404, 'not a member', 'outside');
    await refused(f, 404, 'not a member', 'a', 'elsewhere');
  });
});

for (const field of ['enabled', 'gamesEnabled'] as const) {
  // Ни экономический выключатель, ни выключатель игр не обходятся отдельной ручкой spin.
  test(`R354 выключенное ${field} запрещает вращение без отмены или изменения денег`, async () => {
    await run(async f => {
      await opened(f);
      await t.db.update(schema.serverEconomy).set({ [field]: false }).where(orm.eq(schema.serverEconomy.serverId, 'server'));
      await refused(f, 403, 'games-off');
    });
  });
}

// Досрочное закрытие меняет только стадию/срок, не зерно, commit, деньги или проверяемый сектор.
test('R354 поставивший вне голоса закрывает приём с прежним commit и одним безопасным wheel.state', async () => {
  await run(async f => {
    const initial = await opened(f);
    const before = await money();
    const expected = shared.sectorFromHash(new Uint8Array(crypto.createHash('sha256')
      .update(shared.wheelSectorInput(initial.id, String(initial.data.seed)), 'utf8').digest()));
    f.at(1200);
    f.roster.clear(); // Голос нужен для ставки, но не для распоряжения уже сделанной ставкой.
    const response = await spin(f);
    assert.equal(response.statusCode, 200, `${MARK}early/accepted`);
    const locked = await round();
    assert.equal(locked.state, 'locked', `${MARK}early/locked`);
    assert.equal(locked.lockAt?.getTime(), NOW + 1200, `${MARK}early/lock-at`);
    assert.equal(locked.settleAt?.getTime(), NOW + 1200 + shared.WHEEL_SPIN_MS, `${MARK}early/settle-at`);
    assert.equal(locked.data.seed, initial.data.seed, `${MARK}early/seed`);
    assert.equal(locked.data.commit, initial.data.commit, `${MARK}early/commit`);
    assert.equal(locked.data.sector, expected, `${MARK}early/sector-from-seed`);
    assert.equal(locked.data.closedBy, 'a', `${MARK}early/audit`);
    assert.deepEqual(await money(), before, `${MARK}early/no-money-movement`);
    const body = response.json();
    assert.equal(body.round.sector, expected, `${MARK}early/dto-sector`);
    assert.equal(body.round.commit, initial.data.commit, `${MARK}early/dto-commit`);
    for (const dto of [body.round, states(f)[0]?.message.round]) {
      assert.ok(dto, `${MARK}early/public-round`);
      for (const field of ['seed', 'data', 'closedBy']) assert.equal(Object.hasOwn(dto, field), false, `${MARK}early/private-${field}`);
    }
    assert.equal(states(f).length, 1, `${MARK}early/one-event`);
    assert.equal(states(f)[0].target, 'server', `${MARK}early/event-target`);
    assert.equal(states(f)[0].message.round.state, 'locked', `${MARK}early/event-state`);
  });
});

// Даже другая допустимая цифра не должна попадать в уже закрытый раунд.
test('R354 ставка после досрочного закрытия получает round_locked без нового дебета', async () => {
  await run(async f => {
    await opened(f);
    f.at(1000);
    assert.equal((await spin(f)).statusCode, 200, `${MARK}late/setup`);
    const before = normal({ money: await money(), row: await round() });
    f.wires.length = 0;
    const response = await bet(f, 'b', 3);
    assert.equal(response.statusCode, 409, `${MARK}late/refused`);
    assert.equal(response.json().reason, 'round_locked', `${MARK}late/reason`);
    assert.deepEqual(normal({ money: await money(), row: await round() }), before, `${MARK}late/no-writes`);
    assert.equal(f.wires.length, 0, `${MARK}late/no-events`);
  });
});

// Повтор не является скрытым тактом расчёта: даже в settleAt расчёт принадлежит worker, не второй кнопке.
paired('повтор вращения до и ровно в settleAt не делает второй переход', 'repeat/', async f => {
  await opened(f);
  f.at(1000);
  assert.equal((await spin(f)).statusCode, 200, `${MARK}repeat/first`);
  const locked = await round();
  const before = normal({ money: await money(), row: locked });
  f.wires.length = 0;
  for (const at of [1000, 1000 + shared.WHEEL_SPIN_MS]) {
    f.at(at);
    assert.equal((await spin(f)).statusCode, 200, `${MARK}repeat/accepted`);
    assert.deepEqual(normal({ money: await money(), row: await round() }), before, `${MARK}repeat/unchanged`);
    assert.equal(f.wires.length, 0, `${MARK}repeat/no-events`);
  }
}, () => ({ file: 'gameWheel', from: "if (round.state !== 'open') return { ok: true as const, roundId: null };", to: '' }));

for (const first of ['request', 'tick'] as const) {
  // PGlite сериализует транзакции одного соединения; проверяем оба порядка одновременных претендентов, не многопроцессный PG.
  test(`R354 запрос и такт на границе окна дают ровно один locked, первым начат ${first}`, async () => {
    await run(async f => {
      const initial = await opened(f);
      const before = await money();
      f.at(shared.WHEEL_BET_WINDOW_MS);
      const tick = () => f.wheel.runWheelTick(new Date(NOW + shared.WHEEL_BET_WINDOW_MS));
      const requests = first === 'request' ? [spin(f), tick()] : [tick(), spin(f)];
      const both = await Promise.all(requests);
      const response = both[first === 'request' ? 0 : 1] as Awaited<ReturnType<typeof spin>>;
      assert.equal(response.statusCode, 200, `${MARK}race/accepted`);
      assert.equal((await round()).state, 'locked', `${MARK}race/locked`);
      assert.equal((await round()).data.commit, initial.data.commit, `${MARK}race/commit`);
      assert.deepEqual(await money(), before, `${MARK}race/no-money-movement`);
      assert.equal(states(f).length, 1, `${MARK}race/one-event`);
      assert.equal(results(f).length, 0, `${MARK}race/not-settled`);
      assert.deepEqual(normal(await tick()), { locked: 0, settled: 0, cancelled: 0 }, `${MARK}race/repeated-tick`);
      assert.equal(states(f).length, 1, `${MARK}race/still-one-event`);
    });
  });
}

// Человек не должен запускать глобальный такт других серверов: у них может быть более старый созревший раунд.
paired('раннее вращение переходит только свой раунд и не трогает созревшее чужое колесо', 'only/', async f => {
  const initial = await opened(f);
  await t.db.insert(schema.gameRounds).values({ id: 'foreign-due', serverId: 'elsewhere', kind: 'wheel', state: 'open',
    createdBy: 'owner', lockAt: new Date(NOW - 1000), data: { seed: 'synthetic-foreign-seed', commit: 'synthetic-foreign-commit' } });
  f.at(1000);
  assert.equal((await spin(f)).statusCode, 200, `${MARK}only/accepted`);
  assert.equal((await round()).state, 'locked', `${MARK}only/own-locked`);
  const [foreign] = await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, 'foreign-due'));
  assert.equal(foreign.state, 'open', `${MARK}only/foreign-open`);
  assert.equal(foreign.settleAt, null, `${MARK}only/foreign-untouched`);
  assert.equal(states(f).length, 1, `${MARK}only/one-event`);
  assert.equal(states(f)[0].target, 'server', `${MARK}only/target`);
  assert.equal(states(f)[0].message.round.id, initial.id, `${MARK}only/round`);
}, () => ({ file: 'gameWheel', from: 'only ? eq(gameRounds.id, only) : undefined,', to: 'undefined,' }));

// Итог обязан раскрыть тот самый исход, который уже анимировали клиенты, а не выбрать новый после кнопки.
test('R354 расчёт ровно в settleAt сохраняет сектор и закрывшего только в data, повтор не платит дважды', async () => {
  await run(async f => {
    await opened(f);
    f.at(1500);
    assert.equal((await spin(f)).statusCode, 200, `${MARK}settle/setup`);
    const locked = await round();
    const settleAt = locked.settleAt!.getTime();
    f.wires.length = 0;
    f.at(settleAt - NOW - 1);
    assert.deepEqual(normal(await f.wheel.runWheelTick(new Date(settleAt - 1))), { locked: 0, settled: 0, cancelled: 0 }, `${MARK}settle/not-early`);
    assert.equal((await round()).state, 'locked', `${MARK}settle/still-locked`);
    f.at(settleAt - NOW);
    assert.deepEqual(normal(await f.wheel.runWheelTick(new Date(settleAt))), { locked: 0, settled: 1, cancelled: 0 }, `${MARK}settle/exact`);
    const settled = await round();
    assert.equal(settled.state, 'settled', `${MARK}settle/state`);
    assert.equal(settled.data.sector, locked.data.sector, `${MARK}settle/same-sector`);
    assert.equal(settled.data.commit, locked.data.commit, `${MARK}settle/same-commit`);
    assert.equal(settled.data.closedBy, 'a', `${MARK}settle/audit-retained`);
    assert.equal(results(f).length, 1, `${MARK}settle/one-result`);
    const response = await f.app.inject({ method: 'GET', url: '/servers/server/wheel' });
    assert.equal(response.statusCode, 200, `${MARK}settle/snapshot`);
    for (const last of [response.json().last, results(f)[0].message.last]) {
      assert.equal(last.sector, locked.data.sector, `${MARK}settle/public-sector`);
      assert.equal(last.seed, locked.data.seed, `${MARK}settle/revealed-seed`);
      assert.equal(Object.hasOwn(last, 'closedBy'), false, `${MARK}settle/private-audit`);
      assert.equal(Object.hasOwn(last, 'data'), false, `${MARK}settle/private-data`);
    }
    const paid = await money();
    assert.deepEqual(normal(await f.wheel.runWheelTick(new Date(settleAt))), { locked: 0, settled: 0, cancelled: 0 }, `${MARK}settle/repeated-tick`);
    assert.deepEqual(await money(), paid, `${MARK}settle/no-double-payment`);
    assert.equal(results(f).length, 1, `${MARK}settle/still-one-result`);
  });
});
