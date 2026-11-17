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

// Настоящие HTTP-маршруты, Zod, деньги, транзакции и миграции. Подменены только
// авторизация/права и внешние IO.
type Duel = typeof import('../src/gameDuel.js');
const NOW = Date.parse('2026-10-28T12:00:00Z');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let t: TestDb;
before(async () => {
  t = await createTestDb();
  await t.raw.exec("ALTER TABLE coin_ledger ALTER COLUMN created_at SET DEFAULT '2026-10-28T12:00:00Z'::timestamptz");
});
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

async function fixture() {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['a', 'b', 'c', 'd', 'owner', 'outside'].map(id => ({
    id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true,
  })));
  await t.db.insert(schema.servers).values(['server', 'elsewhere'].map(id => ({ id, name: id, ownerId: 'owner' })));
  await t.db.insert(schema.serverMembers).values(['a', 'b', 'c', 'd', 'owner'].map(userId => ({ serverId: 'server', userId })));
  await t.db.insert(schema.channels).values([
    { id: 'voice', name: 'Голос', serverId: 'server', type: 'voice' },
    { id: 'text', name: 'Текст', serverId: 'server', type: 'text' },
    { id: 'foreign', name: 'Другой голос', serverId: 'elsewhere', type: 'voice' },
  ]);
  await t.db.insert(schema.serverEconomy).values({ serverId: 'server', enabled: true, gamesEnabled: true,
    gamesBetMax: 300, gamesDailyLossMax: 0, gamesFeePercent: 10, closedSeasonId: seasonId(new Date(NOW)), gooseMinutes: 0 });
  await t.db.insert(schema.coinBalances).values(['a', 'b', 'c', 'd', 'owner'].map(userId => ({
    serverId: 'server', userId, balance: 1000, day: dayKey(new Date(NOW)), seasonId: seasonId(new Date(NOW)),
  })));
  await t.db.insert(schema.coinLedger).values(['a', 'b', 'c', 'd', 'owner'].map(userId => ({
    id: `fund-${userId}`, serverId: 'server', userId, amount: 1000, reason: 'fixture', createdAt: new Date(NOW),
  })));
  let clock = NOW;
  let user = 'a';
  let presenceFailure = false;
  let busy = false;
  const roster = new Map<string, string>([['presence:ch:voice', JSON.stringify([{ userId: 'a' }, { userId: 'b' }])]]);
  const env = { economyPreviewUsers: [] as string[] };
  const wires: Array<{ target: string; message: Record<string, any>; channelId?: string; audience?: string[] }> = [];
  const errors: string[] = [];
  const lockCalls: unknown[][] = [];
  const locks = new Map<string, { value: string; until: number }>();
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? clock : value instanceof Date ? value.getTime() : value); }
    static override now() { return clock; }
  }
  const fail = () => { throw new Error('R332 setup: неожиданный внешний IO'); };
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
    // Только IO-граница шлюза: эти R332-сценарии играют в dice, не проверяют caps этапа 4.
    gateway: { userHasCap: () => true },
    realtime: {
      publishToChannel: async (target: string, channelId: string, message: Record<string, any>, audience: string[]) => {
        wires.push({ target, channelId, message: normal(message), audience: [...audience] });
      },
      publishToServer: async (target: string, message: Record<string, any>) => { wires.push({ target, message: normal(message) }); },
      publishToUser: async (target: string, message: Record<string, any>) => { wires.push({ target, message: normal(message) }); },
      redisPub: {
        get: async (key: string) => {
          if (presenceFailure) throw new Error('synthetic Redis outage');
          const value = locks.get(key);
          return roster.get(key) ?? (value && value.until > clock ? value.value : null);
        },
        pttl: async (key: string) => { const value = locks.get(key); return value && value.until > clock ? value.until - clock : -2; },
        pipeline() {
          const keys: string[] = [];
          return { get(key: string) { keys.push(key); return this; }, async exec() {
            if (presenceFailure) throw new Error('synthetic Redis outage');
            return keys.map(key => [null, roster.get(key) ?? null]);
          } };
        },
        async set(key: string, token: string, ...args: unknown[]) {
          lockCalls.push([key, token, ...args]);
          const value = locks.get(key);
          if (args[2] === 'NX' && (busy || (value && value.until > clock))) return null;
          locks.set(key, { value: token, until: clock + Number(args[1]) });
          return 'OK';
        },
        async eval(_script: string, _count: number, key: string, token: string) {
          if (locks.get(key)?.value !== token) return 0;
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
    assert.ok(files.has(name), `R332 setup: закрытый импорт ${name}`);
    const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
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
        assert.ok(id.startsWith('.'), `R332 setup: внешний импорт ${id}`);
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
  return { app, errors, wires, lockCalls, roster, env, duel: load('gameDuel') as Duel,
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
  assert.deepEqual(rows.rows, [], 'R332 HTTP: drift равен нулю');
}

const request = (f: Fixture, path: string, user = 'a', payload?: unknown) => f.app.inject({
  method: 'POST', url: `/servers/server/${path}`, payload: payload as any, headers: { 'x-user': user },
});
const challenge = (f: Fixture, payload: unknown = { channelId: 'voice', targetId: 'b', game: 'dice', amount: 100 }, user = 'a') =>
  request(f, 'duels', user, payload);
async function invite(f: Fixture) {
  const r = await challenge(f);
  assert.equal(r.statusCode, 200, 'R332 setup: корректный вызов принят');
  assert.ok(r.json().duel?.id, 'R332 setup: приглашение имеет id');
  return r.json().duel.id as string;
}
async function accepted(f: Fixture, id: string) {
  const r = await request(f, `duels/${id}/accept`, 'b');
  assert.equal(r.statusCode, 200, 'R332 setup: правильный соперник принимает');
  assert.equal(r.json().duel?.state, 'playing', 'R332 setup: есть настоящая партия');
}
async function snapshot(f: Fixture, user: string) {
  const r = await f.app.inject({ method: 'GET', url: '/servers/server/duel?channelId=voice', headers: { 'x-user': user } });
  assert.equal(r.statusCode, 200, 'R332 HTTP: снимок участника доступен');
  return r.json();
}
async function rejection(f: Fixture, response: () => ReturnType<typeof challenge>, status: number, code: string) {
  const before = await moneyState();
  const r = await response();
  assert.equal(r.statusCode, status, `R332 HTTP: ${code} имеет статус ${status}`);
  assert.equal(r.json().error, code, `R332 HTTP: адресная причина ${code}`);
  if (code !== 'not a member' && code !== 'validation') {
    assert.equal(r.json().reason, code, `R332 HTTP: машинная причина ${code} сохранена рядом с error`);
  }
  assert.deepEqual(await moneyState(), before, 'R332 HTTP: отказ не меняет деньги и раунды');
  return r.json();
}
function scenario(title: string, check: (f: Fixture) => Promise<void>) {
  test(`R332 ${title}`, async () => {
    const f = await fixture();
    try { await check(f); await drift(); assert.deepEqual(f.errors, [], 'R332 HTTP: нет скрытых ошибок'); }
      finally { await f.app.close(); }
  });
}

// Дуэль регистрируется настоящим соседним плагином колеса, а не отдельной тестовой ручкой.
scenario('маршруты дуэли работают из регистрации игр: приглашение без списания, принятие с двумя эскроу', async f => {
  const response = await challenge(f);
  assert.equal(response.statusCode, 200, 'R332 HTTP: дочерний маршрут зарегистрирован');
  const d = response.json().duel;
  assert.equal(d?.state, 'invited', 'R332 HTTP: вызов отдаёт invited');
  assert.equal(d.seed, null);
  assert.deepEqual(d.rolls, []);
  assert.match(d.commit, /^[0-9a-f]{64}$/);
  assert.equal(d.inviteUntil, new Date(NOW + shared.DUEL_INVITE_MS).toISOString());
  assert.equal((await t.db.select().from(schema.gameStakes)).length, 0);
  assert.ok((await t.db.select().from(schema.coinBalances)).every(w => w.balance === 1000));
  const privateEvents = f.wires.filter(w => w.message.t === 'duel.state');
  assert.deepEqual(privateEvents.map(w => w.target).sort(), ['a', 'b']);
  const invitedSnapshot = await snapshot(f, 'b');
  assert.equal(invitedSnapshot.myInvite?.id, d.id);
  assert.equal(invitedSnapshot.betMax, 300, 'R332 HTTP: снимок содержит серверный потолок ставки');
  assert.equal(invitedSnapshot.feePercent, 10, 'R332 HTTP: снимок содержит серверную комиссию');
  await accepted(f, d.id);
  const stakes = await t.db.select().from(schema.gameStakes).orderBy(orm.asc(schema.gameStakes.userId));
  assert.deepEqual(stakes.map(s => [s.userId, s.amount, s.pick]), [['a', 100, 'duel'], ['b', 100, 'duel']]);
  assert.equal((await snapshot(f, 'a')).duel.seed, null);
});

// Отсутствие членства не должно подтверждать существование чужой дуэли или создавать приглашение.
scenario('неучастник не создаёт вызов', async f => {
  await rejection(f, () => challenge(f, undefined, 'outside'), 404, 'not a member');
});

// Выключатель должен выигрывать у частного отказа presence, не раскрывая состояние соперника.
scenario('выключенные игры отвечают games-off до проверки голоса', async f => {
  await t.db.update(schema.serverEconomy).set({ gamesEnabled: false });
  f.roster.clear();
  await rejection(f, () => challenge(f), 403, 'games-off');
});

// Чужой личный отказ и баланс — приватны: разные причины дают один код.
for (const flag of ['optedOut', 'gamesOptOut'] as const) {
  scenario(`вызов не раскрывает личный ${flag} соперника`, async f => {
    await t.db.update(schema.coinBalances).set({ [flag]: true }).where(orm.eq(schema.coinBalances.userId, 'b'));
    await rejection(f, () => challenge(f), 409, 'target_unavailable');
  });
}

// После приглашения вызывающий может потратить монеты: принимающий не должен узнать его новый баланс.
scenario('принятие при обедневшем вызывающем обезличено и откатывает уже поставленную ставку цели', async f => {
  const id = await invite(f);
  await t.db.update(schema.coinBalances).set({ balance: 0 }).where(orm.eq(schema.coinBalances.userId, 'a'));
  await t.db.insert(schema.coinLedger).values({ id: 'synthetic-expense', serverId: 'server', userId: 'a', amount: -1000, reason: 'fixture' });
  await rejection(f, () => request(f, `duels/${id}/accept`, 'b'), 409, 'target_unavailable');
  assert.equal((await t.db.select().from(schema.gameStakes)).length, 0, 'R332 HTTP: ставка принимающего тоже откатилась');
});

// Пустой, испорченный или недоступный presence закрывает вызов; валидный парный случай выше принят.
scenario('inVoiceChannel fail-closed при пустом presence, не-JSON и ошибке Redis', async f => {
  for (const raw of [null, 'broken JSON']) {
    f.roster.clear();
    if (raw !== null) f.roster.set('presence:ch:voice', raw);
    await rejection(f, () => challenge(f), 403, 'not_in_voice');
  }
  f.outage();
  await rejection(f, () => challenge(f), 403, 'not_in_voice');
});

// Принятие повторно проверяет обе стороны, а не полагается на снимок при приглашении.
for (const [missing, error] of [
  ['a', 'target_unavailable'], ['b', 'not_in_voice'],
] as const) {
  scenario(`принятие запрещено, если ${missing === 'a' ? 'вызывающий' : 'принимающий'} вышел из канала`, async f => {
    const id = await invite(f);
    f.roster.set('presence:ch:voice', JSON.stringify([{ userId: missing === 'a' ? 'b' : 'a' }]));
    await rejection(f, () => request(f, `duels/${id}/accept`, 'b'), error === 'not_in_voice' ? 403 : 409, error);
  });
}

// Зрители не должны подсматривать чужое приглашение или партию вне голосового канала.
scenario('снимок скрывает чужой вызов и партию от ушедшего зрителя, но сохраняет доступ игроку', async f => {
  f.roster.set('presence:ch:voice', JSON.stringify(['a', 'b', 'c'].map(userId => ({ userId }))));
  const id = await invite(f);
  assert.equal((await snapshot(f, 'c')).duel, null, 'R332 HTTP: чужое приглашение не видно зрителю');
  await accepted(f, id);
  assert.equal((await snapshot(f, 'c')).duel?.id, id, 'R332 HTTP: сидящий зритель видит партию');
  f.roster.set('presence:ch:voice', JSON.stringify([{ userId: 'b' }]));
  assert.equal((await snapshot(f, 'c')).duel, null, 'R332 HTTP: ушедший зритель не подглядывает');
  assert.equal((await snapshot(f, 'a')).duel?.id, id, 'R332 HTTP: игрок видит свою партию вне голоса');
});

// Повторное нажатие не создаёт второй вызов и возвращает правильный код ограничения частоты.
scenario('занятый Redis-замок даёт busy 429 без раунда и списания', async f => {
  f.busy();
  await rejection(f, () => challenge(f), 429, 'busy');
  assert.deepEqual(f.lockCalls[0].slice(2), ['PX', 3000, 'NX'], 'R332 HTTP: замок ограничен TTL и атомарен');
});

// Иначе мягкая денежная проверка может замаскировать забытый фильтр HTTP-схемы тем же статусом400.
for (const [payload, field] of [
  [{ channelId: 'voice', targetId: 'b', game: 'other', amount: 1 }, 'game'],
  [{ channelId: 'voice', targetId: 'b', game: 'dice', amount: 0 }, 'amount'],
] as const) {
  scenario(`HTTP отвергает неверное ${field} именно схемой и принимает корректный вызов`, async f => {
    const body = await rejection(f, () => challenge(f, payload), 400, 'validation');
    assert.ok(body.details?.some((issue: { path: string[] }) => issue.path.join('.') === field), 'R332 HTTP: ошибка Zod привязана к полю');
    assert.equal((await challenge(f)).statusCode, 200, 'R332 HTTP: валидный вызов принимается');
  });
}

// Общая отмена обязана не только вернуть монеты, но и закрыть сцену обоим без раскрытия зерна.
for (const [state, flag] of [['open', 'gamesEnabled'], ['locked', 'gamesEnabled'], ['open', 'enabled'], ['locked', 'enabled']] as const) {
  scenario(`PATCH ${flag}=false отменяет ${state} и возвращает эскроу обоим один раз`, async f => {
    const id = await invite(f);
    if (state === 'locked') await accepted(f, id);
    f.manage();
    f.wires.length = 0;
    for (let repeat = 0; repeat < 2; repeat++) {
      const r = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy', payload: { [flag]: false } });
      assert.equal(r.statusCode, 200, 'R332 HTTP: выключение принято');
      const [row] = await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, id));
      assert.equal(row.state, 'cancelled', 'R332 HTTP: партия немедленно отменена');
      assert.equal(row.data.reason, 'games-off', 'R332 HTTP: причина выключения сохранена');
      const stakes = await t.db.select().from(schema.gameStakes);
      assert.equal(stakes.length, state === 'locked' ? 2 : 0);
      assert.ok(stakes.every(s => s.refundedAt && !s.paidAt), 'R332 HTTP: возвращены обе незакрытые ставки');
      assert.ok((await t.db.select().from(schema.coinBalances)).every(w => w.balance === 1000), 'R332 HTTP: оба кошелька восстановлены');
      const ledger = await t.db.select().from(schema.coinLedger).where(orm.eq(schema.coinLedger.reason, 'duel.refund'));
      assert.equal(ledger.length, state === 'locked' ? 2 : 0, 'R332 HTTP: повтор выключения не дублирует возврат');
      await drift();
    }
    const events = f.wires.filter(w => w.message.t === 'duel.state');
    assert.equal(events.length, state === 'locked' ? 1 : 2, 'R332 HTTP: событие отмены пришло один раз каждому адресату');
    assert.ok(events.every(w => w.message.duel.state === 'cancelled' && w.message.duel.reason === 'games-off'), 'R332 HTTP: сцена получает причину');
    assert.ok(events.every(w => w.message.duel.seed === null), 'R332 HTTP: отмена не раскрывает seed');
    if (state === 'locked') assert.deepEqual(events[0].audience?.sort(), ['a', 'b'], 'R332 HTTP: событие партии обоим игрокам');
    else assert.deepEqual(events.map(w => w.target).sort(), ['a', 'b'], 'R332 HTTP: отмена приглашения только игрокам');
  });
}
