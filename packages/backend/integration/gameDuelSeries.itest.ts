import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import { posix } from 'node:path';
import { after, before, mock, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify, { type InjectOptions } from 'fastify';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

// Whole production modules, real migrations, wallets, ledger, constraints and transactions.
// Only IO/auth boundaries are replaced. PGlite serializes transactions on one connection:
// concurrent API calls below cannot prove independent PostgreSQL-session lock ordering.
const T0 = Date.parse('2026-10-28T12:00:00Z');
const at = (ms: number) => new Date(T0 + ms);
const normal = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const requireExternal = createRequire(import.meta.url);
const compiled = new Map<string, string>();
const applications: Array<ReturnType<typeof Fastify>> = [];
let t: TestDb;
let unexpectedIO = 0;
const failIO = () => { unexpectedIO++; throw new Error('Unexpected network/timer IO in duel series fixture'); };

before(async () => {
  mock.method(globalThis, 'fetch', failIO);
  mock.method(net.Socket.prototype, 'connect', failIO);
  t = await createTestDb();
  await t.raw.exec("ALTER TABLE coin_ledger ALTER COLUMN created_at SET DEFAULT '2026-10-28T12:00:00Z'::timestamptz");
});
after(async () => {
  try {
    for (const app of applications) await app.close();
    await t?.close();
    const { pool } = await import('../src/db/index.js');
    await pool.end();
    assert.equal(unexpectedIO, 0, 'No unexpected IO was attempted, including caught errors');
  } finally { mock.restoreAll(); }
});

// Only random input is selected; actual moves, payout, SQL and settlement stay production.
function seed21(roundId: string, goal: [number, number]): Buffer {
  for (let n = 0; n < 10_000; n++) {
    const seed = crypto.createHash('sha256').update(`series-21-${roundId}-${n}`).digest(); const hex = seed.toString('hex');
    const hash = (i: number) => crypto.createHash('sha256').update(shared.duelRollInput(roundId, hex, i)).digest();
    const dice = shared.diceFromHash(hash(0)); const first = crypto.createHash('sha256').update(shared.greedyFirstInput(roundId, hex)).digest()[0] & 1;
    let s = shared.twentyOneStart(first ? 'challenger' : 'target', { challenger: [dice[0], dice[1]], target: [dice[2], dice[3]] });
    for (let step = 0; step < 50 && !s.finished; step++) s = shared.twentyOneStep(s, s.totals[s.turn] >= goal[s.turn === 'challenger' ? 0 : 1] ? 'stop' : 'roll', shared.diceFromHash(hash(s.rolls.length))[0])!;
    if (s.finished && s.totals.challenger === goal[0] && s.totals.target === goal[1]) return seed;
  }
  throw new Error('No bounded 21 seed for requested totals');
}
// Select only random IO; every roll, transition and journal write remains production code.
function seedDice(roundId: string, signs: number[]): Buffer {
  for (let n = 0; n < 10_000; n++) {
    const seed = crypto.createHash('sha256').update(`dice-two-${roundId}-${n}`).digest();
    if (signs.every((sign, i) => {
      const dice = shared.diceFromHash(crypto.createHash('sha256').update(shared.duelRollInput(roundId, seed.toString('hex'), i)).digest());
      return Math.sign(dice[0] + dice[1] - dice[2] - dice[3]) === sign;
    })) return seed;
  }
  throw new Error('No bounded dice seed for requested outcomes');
}
async function fixture(goal?: [number, number], diceSigns?: number[]) {
  await truncateAll(t.raw);
  const users = ['a', 'b', 'c', 'outside'];
  await t.db.insert(schema.users).values(users.map(id => ({ id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true })));
  await t.db.insert(schema.servers).values(['s', 'other'].map(id => ({ id, name: id, ownerId: 'a' })));
  await t.db.insert(schema.serverMembers).values([
    ...['a', 'b', 'c'].map(userId => ({ serverId: 's', userId })), { serverId: 'other', userId: 'a' },
  ]);
  await t.db.insert(schema.channels).values(['v', 'v2'].map(id => ({ id, serverId: 's', name: id, type: 'voice' as const })));
  await t.db.insert(schema.serverEconomy).values({ serverId: 's', enabled: true, gamesEnabled: true,
    gamesBetMax: 300, gamesDailyLossMax: 0, gamesPairDailyMax: 0, gamesFeePercent: 10 });
  await t.db.insert(schema.coinBalances).values(['a', 'b', 'c'].map(userId => ({ serverId: 's', userId, balance: 1000 })));
  await t.db.insert(schema.coinLedger).values(['a', 'b', 'c'].map(userId => ({ id: `fund-${userId}`, serverId: 's', userId, amount: 1000, reason: 'fixture', createdAt: at(0) })));

  let clock = T0;
  let sequence = 0;
  let lastRoundId = '';
  const presence = new Map([['v', ['a', 'b', 'c']], ['v2', ['a', 'b', 'c']]]);
  const redis = new Map<string, { value: string; expires: number }>();
  const wires: unknown[] = [];
  const warnings: string[] = [];
  const transactionScope = new AsyncLocalStorage<boolean>();
  // A root PGlite query inside its own transaction waits forever for that transaction.
  // Diagnose immediately; queries/transactions themselves remain the real Drizzle/PGlite.
  const db = new Proxy(t.db, { get(target, key) {
    if (key === 'transaction') return (fn: (tx: unknown) => Promise<unknown>) =>
      target.transaction(tx => transactionScope.run(true, () => fn(tx)));
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      if (transactionScope.getStore()) throw new Error(`Global db.${String(key)} used inside PGlite transaction; pass tx`);
      return value.apply(target, args);
    };
  } });
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? clock : value instanceof Date ? value.getTime() : value); }
    static override now() { return clock; }
  }
  const dependencies: Record<string, unknown> = {
    'db/index': { db }, 'db/schema': schema,
    env: { env: { economyPreviewUsers: [] } }, util: { id: () => (lastRoundId = `series-fixture-${++sequence}`) },
    auth: { isSuperAdmin: () => false, requireAuth: async (req: any, reply: any) => {
      const sub = req.headers['x-user'];
      if (!sub) return reply.code(401).send({ error: 'unauthorized' });
      req.user = { sub };
    } },
    permissions: { getMemberContext: async (serverId: string, userId: string) => {
      const [member] = await t.db.select().from(schema.serverMembers)
        .where(orm.and(orm.eq(schema.serverMembers.serverId, serverId), orm.eq(schema.serverMembers.userId, userId))).limit(1);
      return member ?? null;
    } },
    gateway: { isUserOnline: () => true, userHasCap: () => true },
    realtime: {
      redisPub: {
        set: async (key: string, value: string, _px: string, ms: number, nx?: string) => {
          if (nx && (redis.get(key)?.expires ?? 0) > clock) return null;
          redis.set(key, { value, expires: clock + ms }); return 'OK';
        },
        get: async (key: string) => key.startsWith('presence:ch:')
          ? JSON.stringify((presence.get(key.slice('presence:ch:'.length)) ?? []).map(userId => ({ userId })))
          : (redis.get(key)?.expires ?? 0) > clock ? redis.get(key)!.value : null,
        pttl: async (key: string) => Math.max(-2, (redis.get(key)?.expires ?? clock - 2) - clock),
        eval: async (_script: string, _count: number, key: string, token: string) => {
          if (redis.get(key)?.value !== token) return 0;
          redis.delete(key); return 1;
        },
      },
      publishToUser: async (...args: unknown[]) => { wires.push(normal(args)); },
      publishToServer: async (...args: unknown[]) => { wires.push(normal(args)); },
      publishToChannel: async (...args: unknown[]) => { wires.push(normal(args)); },
    },
  };
  const cache = new Map<string, any>();
  function load(name: string): any {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (cache.has(name)) return cache.get(name);
    assert.ok(!name.startsWith('../') && !posix.isAbsolute(name), 'Module stays under backend/src');
    if (!compiled.has(name)) compiled.set(name, ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText);
    const module = { exports: {} };
    cache.set(name, module.exports);
    runInNewContext(compiled.get(name)!, {
      module, exports: module.exports, Buffer, Date: TestDate, Error, Uint8Array,
      fetch: failIO, setTimeout: failIO, setInterval: failIO,
      console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
      require(id: string) {
        if (id === 'drizzle-orm') return orm;
        if (id === '@gusvoice/shared') return shared;
        if (id === 'node:crypto') return { ...crypto, randomBytes: (size: number) => size === 32 && diceSigns ? seedDice(lastRoundId, diceSigns) : size === 32 && goal ? seed21(lastRoundId, goal) : Buffer.alloc(size, ++sequence % 256) };
        if (!id.startsWith('.')) return requireExternal(id);
        return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
      },
    });
    return module.exports;
  }
  const app = Fastify();
  applications.push(app);
  await app.register(load('routes/gameDuel').gameDuelRoutes);
  await app.ready();
  return { app, duel: load('gameDuel') as typeof import('../src/gameDuel.js'), load, presence, redis, wires, warnings,
    clock(ms: number) { clock = T0 + ms; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function money() {
  return normal({ balances: await t.db.select().from(schema.coinBalances).orderBy(orm.asc(schema.coinBalances.userId)),
    stakes: await t.db.select().from(schema.gameStakes).orderBy(orm.asc(schema.gameStakes.roundId), orm.asc(schema.gameStakes.userId)),
    ledger: await t.db.select().from(schema.coinLedger).orderBy(orm.asc(schema.coinLedger.id)) });
}
async function drift() {
  const r = await t.raw.query(`SELECT b.user_id FROM coin_balances b LEFT JOIN coin_ledger l USING (server_id,user_id)
    GROUP BY b.server_id,b.user_id,b.balance HAVING b.balance <> COALESCE(SUM(l.amount),0)::int`);
  assert.deepEqual(r.rows, [], 'Every wallet equals its ledger');
}
const post = (f: Fixture, path: string, user?: string, payload?: InjectOptions['payload'], server = 's') => f.app.inject({
  method: 'POST', url: `/servers/${server}/duels${path}`, headers: user ? { 'x-user': user } : {}, payload,
});

const ok = (r: Awaited<ReturnType<typeof post>>) => { assert.equal(r.statusCode, 200, r.body); return r.json().duel as shared.DuelDto; };
async function start(f: Fixture, offer = true, consent = true, game: shared.DuelGame = 'rps', targetId = 'b') {
  const before = await money();
  const invited = ok(await post(f, '', 'a', { channelId: 'v', targetId, game, amount: 100, ...(offer ? { series: true } : {}) }));
  assert.equal(invited.state, 'invited');
  assert.deepEqual(await money(), before, 'Invite never stakes');
  f.clock(1);
  return ok(await post(f, `/${invited.id}/accept`, targetId, consent ? { series: true } : undefined));
}
async function snapshot(f: Fixture, viewer = 'a') {
  const r = await f.app.inject({ method: 'GET', url: '/servers/s/duel?channelId=v', headers: { 'x-user': viewer } });
  assert.equal(r.statusCode, 200, r.body); return r.json().duel as shared.DuelDto;
}
async function pulse(f: Fixture, d: shared.DuelDto, user = 'a', ready = true, roundId = d.id, clientId = `scene-${user}`) {
  return post(f, `/${d.id}/series/pulse`, user, { clientId, roundId, visible: ready, ready });
}
async function ready(f: Fixture, d: shared.DuelDto, ms: number) {
  f.clock(ms); ok(await pulse(f, d)); return ok(await pulse(f, d, d.targetId));
}
async function tick(f: Fixture, ms: number) { f.clock(ms); await f.duel.runDuelTick(at(ms)); }
async function finish(f: Fixture, d: shared.DuelDto, ms = 100, draw = false, winner: 'a' | 'b' = 'a') {
  for (let seq = 0; seq < (draw ? 7 : 2); seq++) {
    f.clock(ms + seq * 10);
    ok(await post(f, `/${d.id}/move`, 'a', { seq, move: winner === 'a' || draw ? 'rock' : 'scissors' }));
    ok(await post(f, `/${d.id}/move`, d.targetId, { seq, move: draw || winner === 'b' ? 'rock' : 'scissors' }));
    if (seq === 0 && !draw && d.series) assert.deepEqual((await snapshot(f)).series!.score, d.series.score, 'RPS subround is not a series point');
  }
  const end = ms + (draw ? 60 : 10) + 1500;
  await tick(f, end); return { d: await snapshot(f), ms: end };
}
async function advance(f: Fixture, d: shared.DuelDto, from: number, stake = true) {
  assert.ok(d.series?.nextAt, 'Countdown published before stake');
  const due = Date.parse(d.series.nextAt) - T0;
  for (let ms = from + 2000; ms < due; ms += 2000) { await ready(f, d, ms); await tick(f, ms); }
  await ready(f, d, due - 1); await tick(f, due - 1);
  assert.equal((await t.db.select().from(schema.gameStakes)).length, 2, 'No early child stake');
  if (stake) await tick(f, due); else f.clock(due);
  return { d: await snapshot(f), ms: due };
}
async function adjust(userId: string, amount: number) {
  await t.db.transaction(async tx => {
    await tx.update(schema.coinBalances).set({ balance: orm.sql`${schema.coinBalances.balance} + ${amount}` }).where(orm.eq(schema.coinBalances.userId, userId));
    await tx.insert(schema.coinLedger).values({ id: `adjust-${userId}`, serverId: 's', userId, amount, reason: 'fixture', createdAt: at(0) });
  });
}
const bounded = { timeout: 8_000 };

test('серия требует двух явных согласий; старое принятие оставляет одну партию', bounded, async () => {
  for (const [offer, consent] of [[true, false], [false, true], [true, true]]) {
    const f = await fixture(); const d = await start(f, offer, consent);
    assert.equal(!!d.series, offer && consent);
    if (d.series) { assert.equal(d.series.status, 'active'); assert.equal(d.series.round, 1); }
    assert.deepEqual((await money()).balances.map(b => b.balance), [900, 900, 1000]);
    if (!d.series) { await finish(f, d); await tick(f, 100_000); assert.equal((await t.db.select().from(schema.gameRounds)).length, 1); }
    await drift();
  }
  const f = await fixture(); const before = await money();
  const offer = ok(await post(f, '', 'a', { channelId: 'v', targetId: 'b', game: 'rps', amount: 100, series: true }));
  const stopped = ok(await post(f, `/${offer.id}/series/stop`, 'b'));
  const accepted = await post(f, `/${offer.id}/accept`, 'b', { series: true });
  assert.notEqual(accepted.statusCode, 200, `Accept after stop must not debit: ${JSON.stringify({ state: stopped.state, stakes: (await money()).stakes.length })}`);
  assert.equal(stopped.state, 'cancelled', 'Stopping an offered series cancels the unpaid invitation');
  assert.equal(stopped.series!.status, 'stopped');
  ok(await post(f, `/${offer.id}/series/stop`, 'a'));
  assert.deepEqual(await money(), before); await drift();
});

test('повтор такта даёт одного потомка, две ставки, одну выплату и одно очко за целую партию', bounded, async () => {
  const f = await fixture(); const first = await start(f); await ready(f, first, 10);
  const done = await finish(f, first); const d = done.d;
  assert.equal(d.state, 'settled'); assert.equal(d.payout, 180);
  assert.deepEqual(d.series!.score, { challenger: 1, target: 0, draws: 0 });
  assert.ok(d.series!.nextCommit); assert.ok(d.series!.nextRoundId);
  const settled = await money(); await tick(f, done.ms); assert.deepEqual(await money(), settled);
  const next = await advance(f, d, done.ms);
  assert.equal(next.d.id, d.series!.nextRoundId); assert.equal(next.d.commit, d.series!.nextCommit); assert.equal(next.d.seed, null);
  assert.equal(next.d.series!.round, 2); assert.deepEqual(next.d.series!.score, d.series!.score);
  await Promise.all([f.duel.runDuelTick(at(next.ms)), f.duel.runDuelTick(at(next.ms))]);
  const m = await money(); assert.equal(m.stakes.length, 4); assert.equal(m.ledger.filter(l => l.reason === 'duel.stake').length, 4);
  assert.equal(m.ledger.filter(l => l.reason === 'duel.win').length, 1); assert.deepEqual(m.balances.map(b => b.balance), [980, 800, 1000]);
  assert.equal((await t.db.select().from(schema.gameRounds)).length, 2); await drift();
});

test('пауза сохраняет счёт через полночь и старое окно снимка, возврат обоих начинает новые десять секунд', bounded, async () => {
  const f = await fixture(); const first = await start(f); await ready(f, first, 10);
  const done = await finish(f, first); ok(await post(f, `/${first.id}/series/pause`, 'a'));
  await tick(f, 86_400_000); const paused = await snapshot(f);
  assert.equal(paused.id, first.id); assert.equal(paused.series!.status, 'paused'); assert.deepEqual(paused.series!.score, { challenger: 1, target: 0, draws: 0 });
  f.clock(86_400_010); const one = ok(await pulse(f, first)); assert.equal(one.series!.nextAt, null);
  const both = await ready(f, first, 86_400_100);
  assert.equal(Date.parse(both.series!.nextAt!) - T0, 86_410_100);
  const next = await advance(f, both, 86_400_100);
  const second = await finish(f, next.d, next.ms + 10);
  assert.deepEqual(second.d.series!.score, { challenger: 2, target: 0, draws: 0 });
  assert.equal(second.d.game, 'rps'); assert.equal(second.d.challengerId, 'a'); assert.equal(second.d.targetId, 'b');
  ok(await post(f, `/${first.id}/series/stop`, 'a')); f.clock(second.ms + 10_001);
  for (const [game, targetId] of [['rps', 'b'], ['dice', 'b'], ['rps', 'c']]) {
    const invited = ok(await post(f, '', 'a', { channelId: 'v', targetId, game, amount: 100, series: true }));
    assert.deepEqual(invited.series!.score, { challenger: 0, target: 0, draws: 0 }, 'A new session never inherits historical pair/game wins');
    ok(await post(f, `/${invited.id}/withdraw`, 'a'));
  }
  await drift();
});

test('ничьи подраундов дают один ничейный итог серии и возвращают обе ставки без комиссии', bounded, async () => {
  const f = await fixture(); const first = await start(f); await ready(f, first, 10);
  const done = await finish(f, first, 100, true);
  assert.equal(done.d.winnerId, null); assert.deepEqual(done.d.series!.score, { challenger: 0, target: 0, draws: 1 });
  const m = await money(); assert.deepEqual(m.balances.map(b => b.balance), [1000, 1000, 1000]);
  assert.equal(m.ledger.filter(l => l.reason === 'duel.refund').length, 2);
  await tick(f, done.ms); assert.deepEqual(await money(), m); await drift();
});

test('просроченная аренда или скрытая сцена обнуляет обе готовности и запрещает следующую ставку', bounded, async () => {
  for (const hidden of [false, true]) {
    const f = await fixture(); const first = await start(f); await ready(f, first, 10);
    const done = await finish(f, first); const paid = await money();
    if (hidden) { f.clock(done.ms + 1); ok(await pulse(f, first, 'b', false)); }
    await tick(f, done.ms + 10_000);
    const paused = await snapshot(f); assert.equal(paused.series!.status, 'paused'); assert.equal(paused.series!.nextAt, null);
    f.clock(done.ms + 10_001); const alone = ok(await pulse(f, first)); assert.equal(alone.series!.nextAt, null);
    assert.deepEqual(await money(), paid); assert.equal((await t.db.select().from(schema.gameRounds)).length, 1);
    const resumed = await ready(f, first, done.ms + 10_010); assert.equal(Date.parse(resumed.series!.nextAt!) - T0, done.ms + 20_010);
    await drift();
  }
});

test('таймаут или отсутствие ручного действия любой стороны останавливает серию после расчёта', bounded, async () => {
  for (const game of ['dice', 'rps'] as const) for (const acted of [false, true]) {
    const f = await fixture(); const d = await start(f, true, true, game); await ready(f, d, 10);
    f.clock(100);
    if (acted) ok(await post(f, `/${d.id}/${game === 'dice' ? 'roll' : 'move'}`, 'a', game === 'rps' ? { seq: 0, move: 'rock' } : undefined));
    for (let n = 1; n <= 8; n++) {
      await tick(f, 20_001 * n);
      const [row] = await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, d.id));
      if (row.state === 'settled') break;
    }
    const done = await snapshot(f); assert.equal(done.series!.status, 'stopped'); assert.equal(done.series!.stopReason, 'idle');
    const paid = await money(); await tick(f, 200_000); assert.deepEqual(await money(), paid); assert.equal(paid.stakes.length, 2); await drift();
  }
});

test('кошелёк и суточные пределы перепроверяются до обеих новых ставок, отказ откатывает всё', bounded, async () => {
  for (const kind of ['wallet', 'daily', 'pair', 'boundary', 'rollback'] as const) {
    const f = await fixture(); if (kind === 'wallet') await adjust('a', -900);
    if (kind !== 'wallet' && kind !== 'rollback') await t.db.update(schema.serverEconomy).set(kind === 'pair' ? { gamesPairDailyMax: 159 } : { gamesDailyLossMax: kind === 'boundary' ? 200 : 199 });
    const d = await start(f); await ready(f, d, 10); const done = await finish(f, d, 100, false, 'b');
    const paid = await money();
    if (kind === 'rollback') {
      const due = await advance(f, done.d, done.ms, false);
      // Real SQL failure AFTER the target stake forces rollback of child + first debit + ledger.
      await t.raw.exec(`CREATE FUNCTION reject_series_stake() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.user_id = 'a' THEN RAISE EXCEPTION 'synthetic child stake failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_series_stake BEFORE INSERT ON game_stakes FOR EACH ROW EXECUTE FUNCTION reject_series_stake()`);
      try {
        await assert.rejects(() => tick(f, due.ms), (e: any) => String(e.cause ?? e).includes('synthetic child stake failure'));
        assert.deepEqual(await money(), paid); assert.equal((await t.db.select().from(schema.gameRounds)).length, 1);
      } finally { await t.raw.exec('DROP TRIGGER reject_series_stake ON game_stakes; DROP FUNCTION reject_series_stake()'); }
      await drift(); continue;
    }
    const next = await advance(f, done.d, done.ms);
    if (kind === 'boundary') { assert.equal(next.d.series!.round, 2); assert.equal((await money()).stakes.length, 4); }
    else { assert.equal(next.d.series!.status, 'stopped'); assert.equal(next.d.series!.stopReason, 'unavailable'); assert.deepEqual(await money(), paid); }
    await drift();
  }
});

test('HTTP-контроль ограничен участником и сервером; старый раунд и чужая сцена не продлевают аренду', bounded, async () => {
  const f = await fixture(); const d = await start(f); await ready(f, d, 10); const before = await money();
  for (const action of ['pulse', 'pause', 'stop']) {
    const body = action === 'pulse' ? { clientId: 'scene-c', roundId: d.id, visible: true, ready: true } : undefined;
    assert.equal((await post(f, `/${d.id}/series/${action}`, undefined, body)).statusCode, 401);
    assert.equal((await post(f, `/${d.id}/series/${action}`, 'outside', body)).statusCode, 403);
    assert.equal((await post(f, `/${d.id}/series/${action}`, 'c', body)).statusCode, 403);
    assert.equal((await post(f, `/${d.id}/series/${action}`, 'a', body, 'other')).statusCode, 404);
  }
  assert.equal((await pulse(f, d, 'a', true, d.id, 'other-scene')).statusCode, 429);
  assert.equal((await pulse(f, d, 'a', true, 'stale-round')).statusCode, 409);
  assert.deepEqual(await money(), before);
  const done = await finish(f, d); const next = await advance(f, done.d, done.ms);
  assert.equal((await pulse(f, d)).statusCode, 409);
  const stopped = ok(await post(f, `/${d.id}/series/stop`, 'a')); assert.equal(stopped.id, next.d.id); assert.equal(stopped.series!.status, 'stopped');
  await drift();
});

test('повтор stop и состязание stop с тактом запрещают будущие ставки, уже начатая партия рассчитывается', bounded, async () => {
  for (const stopFirst of [true, false]) {
    const f = await fixture(); const d = await start(f); await ready(f, d, 10); const done = await finish(f, d);
    const due = await advance(f, done.d, done.ms, false);
    const stop = () => post(f, `/${d.id}/series/stop`, 'a'); const step = () => f.duel.runDuelTick(at(due.ms));
    await Promise.all(stopFirst ? [stop(), step()] : [step(), stop()]);
    const current = ok(await post(f, `/${d.id}/series/stop`, 'b')); assert.equal(current.series!.status, 'stopped');
    const committed = await money(); assert.ok(committed.stakes.length === 2 || committed.stakes.length === 4);
    await post(f, `/${current.id}/series/stop`, 'a'); assert.deepEqual(await money(), committed);
    if (current.id !== d.id) {
      const finished = await finish(f, current, due.ms + 100); assert.equal(finished.d.state, 'settled'); assert.equal(finished.d.series!.status, 'stopped');
    }
    const paid = await money(); await tick(f, due.ms + 60_000); assert.deepEqual(await money(), paid); await drift();
  }
});

test('потеря голоса ставит паузу, выход из сервера и новая комиссия прекращают будущие ставки', bounded, async () => {
  for (const kind of ['voice', 'member', 'fee'] as const) {
    const f = await fixture(); const d = await start(f); await ready(f, d, 10); const done = await finish(f, d); const paid = await money();
    if (kind === 'voice') f.presence.set('v', ['a', 'c']);
    else if (kind === 'member') await t.db.delete(schema.serverMembers).where(orm.eq(schema.serverMembers.userId, 'b'));
    else await t.db.update(schema.serverEconomy).set({ gamesFeePercent: 11 });
    for (let ms = done.ms + 2000; ms <= done.ms + 12_000; ms += 2000) {
      f.clock(ms); await pulse(f, d); if (kind === 'fee') await pulse(f, d, 'b'); await tick(f, ms);
    }
    const stopped = await snapshot(f); assert.equal(stopped.series!.status, kind === 'voice' ? 'paused' : 'stopped');
    if (kind !== 'voice') assert.equal(stopped.series!.stopReason, kind === 'fee' ? 'settings_changed' : 'unavailable');
    assert.deepEqual(stopped.series!.score, { challenger: 1, target: 0, draws: 0 }); assert.deepEqual(await money(), paid); await drift();
  }
});

// Critical-money exception: reuse one migrated fixture; 13 tests, <=450 lines instead of duplicating it.
async function state21(id: string) { return (await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, id)))[0].data.twentyOne as shared.DuelTwentyOneDto; }
async function act21(f: Fixture, d: shared.DuelDto, move: 'roll' | 'stop', ms: number) {
  const s = await state21(d.id); f.clock(ms); return ok(await post(f, `/${d.id}/move`, s.turn === 'challenger' ? 'a' : 'b', { seq: s.seq, move }));
}
test('21 скрывает чужие суммы до конца обеих попыток; повтор seq не меняет ход и деньги', bounded, async () => {
  const f = await fixture([21, 20]); const d = await start(f, true, true, 'twentyone'); const before = await money();
  const initial = await state21(d.id); const user = initial.turn === 'challenger' ? 'a' : 'b';
  for (const viewer of ['a', 'b', 'c']) {
    const x = (await snapshot(f, viewer)).twentyOne!;
    for (const side of ['challenger', 'target'] as const) if (viewer !== (side === 'challenger' ? 'a' : 'b')) {
      assert.equal(x.totals[side], 0); assert.ok(x.rolls.filter(r => r.by === side).every(r => r.die === 0));
    }
  }
  assert.deepEqual(initial.totals, { challenger: 0, target: 0 }); assert.deepEqual(initial.rolls, []);
  const rejected = await post(f, `/${d.id}/move`, user, { seq: initial.seq, move: 'stop' });
  assert.equal(rejected.statusCode, 400); assert.equal(rejected.json().error, 'bad_move');
  assert.deepEqual(normal(await state21(d.id)), normal(initial)); assert.deepEqual(await money(), before);
  const moved = await act21(f, d, 'roll', 100); assert.equal(moved.twentyOne!.finished, false); assert.equal(moved.winnerId, null);
  assert.equal((await state21(d.id)).rolls.length, 2);
  const saved = normal(await state21(d.id)); ok(await post(f, `/${d.id}/move`, user, { seq: initial.seq, move: 'roll' }));
  assert.deepEqual(normal(await state21(d.id)), saved); assert.deepEqual(await money(), before);
  for (const args of f.wires as any[][]) {
    const live = args.find(x => x?.t === 'duel.state')?.duel; if (!live?.twentyOne) continue;
    for (const side of ['challenger', 'target'] as const) if ((args.length === 2 ? args[0] : null) !== (side === 'challenger' ? 'a' : 'b')) {
      assert.equal(live.twentyOne.totals[side], 0); assert.ok(live.twentyOne.rolls.filter((r: any) => r.by === side).every((r: any) => r.die === 0));
    }
  }
  assert.equal((await t.db.select().from(schema.gameMoves)).length, 1); await drift();
});
test('21 платит только после обеих попыток: 20/21/22, равные суммы и двойной перебор', bounded, async () => {
  for (const [a, b, winner] of [[20, 21, 'b'], [21, 20, 'a'], [22, 20, 'b'], [22, 22, null], [20, 20, null]] as const) {
    const f = await fixture([a, b]); const d = await start(f, true, true, 'twentyone'); const escrow = await money(); let ms = 100;
    for (let n = 0; n < 50 && !(await state21(d.id)).finished; n++, ms += 10) {
      const s = await state21(d.id); await act21(f, d, s.totals[s.turn] >= (s.turn === 'challenger' ? a : b) ? 'stop' : 'roll', ms);
      assert.deepEqual(await money(), escrow, 'No payout before settlement, even after one stands/busts');
    }
    const end = await state21(d.id); assert.ok(end.finished); assert.deepEqual(end.totals, { challenger: a, target: b });
    await tick(f, ms + 1500); const result = await snapshot(f); assert.equal(result.winnerId, winner);
    assert.deepEqual(result.twentyOne!.totals, end.totals); const paid = await money();
    assert.deepEqual(paid.balances.map(w => w.balance), winner === 'a' ? [1080, 900, 1000] : winner === 'b' ? [900, 1080, 1000] : [1000, 1000, 1000]);
    assert.equal(paid.ledger.filter(l => l.reason === (winner ? 'duel.win' : 'duel.refund')).length, winner ? 1 : 2);
    assert.deepEqual(result.series!.score, { challenger: winner === 'a' ? 1 : 0, target: winner === 'b' ? 1 : 0, draws: winner ? 0 : 1 });
    const moves = await t.db.select().from(schema.gameMoves); const first = moves.find(m => m.seq === 0)!;
    ok(await post(f, `/${d.id}/move`, first.userId, { seq: 0, move: 'roll' })); assert.deepEqual(await money(), paid);
    assert.equal((await t.db.select().from(schema.gameMoves)).length, moves.length);
    await tick(f, ms + 1500); assert.deepEqual(await money(), paid); await drift();
  }
});
test('таймаут 21 до старта раскрывает пару; соперник играет, новых ставок серии нет', bounded, async () => {
  const f = await fixture([20, 21]); const d = await start(f, true, true, 'twentyone'); await ready(f, d, 10); const before = await money(); const initial = await state21(d.id);
  await tick(f, 20_000); assert.deepEqual(normal(await state21(d.id)), normal(initial));
  await tick(f, 20_001); const timed = await state21(d.id); assert.equal(timed.standing[initial.turn], false); assert.equal(timed.finished, false);
  assert.equal(timed.started![initial.turn], true); assert.equal(timed.rolls.length, 2);
  assert.notEqual(timed.turn, initial.turn); assert.deepEqual(await money(), before); let ms = 20_010;
  for (let n = 0; n < 20 && !(await state21(d.id)).finished; n++, ms += 10) { const s = await state21(d.id); await act21(f, d, s.totals[s.turn] < 20 ? 'roll' : 'stop', ms); }
  await tick(f, ms + 1500); const result = await snapshot(f); assert.equal(result.state, 'settled'); assert.equal(result.reason, 'timeout');
  assert.equal(result.series!.status, 'stopped'); assert.equal(result.series!.stopReason, 'idle'); const paid = await money();
  await tick(f, ms + 60_000); assert.deepEqual(await money(), paid); assert.equal(paid.stakes.length, 2); await drift();
});


async function finishDice(f: Fixture, d: shared.DuelDto, from: number, throws: number) {
  const held = await money();
  for (let n = 0; n < throws; n++) {
    f.clock(from + n * 10);
    const first = ok(await post(f, `/${d.id}/roll`, 'a'));
    const repeated = ok(await post(f, `/${d.id}/roll`, 'a'));
    assert.deepEqual(repeated, first);
    const next = ok(await post(f, `/${d.id}/roll`, 'b'));
    // Backend API for an optional rollNo request field; a retry AFTER the transition cannot
    // accidentally reveal the caller's dice in the newly opened throw.
    const stale = await f.duel.rollDuel('s', d.id, 'b', at(from + n * 10 + 1), n);
    assert.ok(stale.ok && stale.duel);
    assert.deepEqual(normal(stale.duel), next);
    assert.equal(next.rollNo, n === throws - 1 ? n : n + 1);
    assert.equal(next.turnUntil === null, n === throws - 1);
    assert.deepEqual(await money(), held, 'No stakes, payout or refund per throw');
    if (n < throws - 1) assert.deepEqual(next.rolls.at(-1), { challenger: null, target: null });
  }
  const end = from + (throws - 1) * 10 + 1500;
  await tick(f, end - 1); assert.deepEqual(await money(), held);
  await tick(f, end);
  return { d: await snapshot(f), ms: end };
}

test('кубики 2:1, ничья между очками и 0:2 держат один эскроу до второй победы', bounded, async () => {
  for (const signs of [[1, -1, 1], [1, 0, -1, 1], [-1, -1]]) {
    const f = await fixture(undefined, signs); const d = await start(f, false, false, 'dice');
    assert.equal(Reflect.get(d, 'diceTarget'), 2);
    const done = await finishDice(f, d, 10, signs.length);
    assert.equal(done.d.state, 'settled');
    assert.equal(done.d.winnerId, signs.at(-1) === 1 ? 'a' : 'b');
    assert.equal(done.d.payout, 180);
    const paid = await money();
    assert.equal(paid.stakes.length, 2);
    assert.equal(paid.ledger.filter(l => l.reason === 'duel.stake').length, 2);
    assert.equal(paid.ledger.filter(l => l.reason === 'duel.win').length, 1);
    assert.equal(paid.ledger.filter(l => l.reason === 'duel.refund').length, 0);
    assert.ok(paid.stakes.every(s => s.paidAt && !s.refundedAt));
    await tick(f, done.ms + 20_000); assert.deepEqual(await money(), paid); await drift();
  }
});

test('в автосерии только вторая победа даёт одно очко партии; потомок снова играет до двух с новым единым эскроу', bounded, async () => {
  const f = await fixture(undefined, [1, -1, 1]); const d = await start(f, true, true, 'dice');
  await ready(f, d, 10);
  const done = await finishDice(f, d, 100, 3);
  assert.deepEqual(done.d.series!.score, { challenger: 1, target: 0, draws: 0 });
  const next = await advance(f, done.d, done.ms);
  assert.equal(next.d.series!.round, 2);
  assert.equal(Reflect.get(next.d, 'diceTarget'), 2);
  assert.equal((await money()).stakes.length, 4);
  const second = await finishDice(f, next.d, next.ms + 10, 3);
  assert.deepEqual(second.d.series!.score, { challenger: 2, target: 0, draws: 0 });
  const paid = await money();
  assert.equal(paid.ledger.filter(l => l.reason === 'duel.stake').length, 4);
  assert.equal(paid.ledger.filter(l => l.reason === 'duel.win').length, 2);
  await tick(f, second.ms); assert.deepEqual(await money(), paid); await drift();
});

test('таймаут раскрывает недостающие стороны каждого броска, платит только после второй победы и останавливает серию', bounded, async () => {
  const f = await fixture(undefined, [1, 0, -1, 1]); const d = await start(f, true, true, 'dice');
  const held = await money();
  for (let n = 0; n < 4; n++) {
    const live = await snapshot(f);
    const due = Date.parse(live.turnUntil!) - T0;
    f.clock(due - 1);
    ok(await post(f, `/${d.id}/roll`, 'a'));
    await tick(f, due - 1); assert.deepEqual(await money(), held);
    await tick(f, due); assert.deepEqual(await money(), held);
    const next = await snapshot(f);
    assert.ok(next.rolls[n].challenger && next.rolls[n].target);
    if (n < 3) assert.equal(next.rollNo, n + 1);
    else {
      await tick(f, due + 1499); assert.deepEqual(await money(), held);
      await tick(f, due + 1500);
    }
  }
  const done = await snapshot(f);
  assert.equal(done.state, 'settled'); assert.equal(done.winnerId, 'a');
  assert.equal(done.series!.stopReason, 'idle');
  const paid = await money();
  assert.equal(paid.stakes.length, 2); assert.equal(paid.ledger.filter(l => l.reason === 'duel.win').length, 1);
  await tick(f, 200_000); assert.deepEqual(await money(), paid); await drift();
});

test('сохранённая игра без цели после обновления завершается первой победой с одной выплатой', bounded, async () => {
  const f = await fixture(undefined, [1, -1, -1]); const d = await start(f, false, false, 'dice');
  // Recreate persisted pre-upgrade data, never rewrite or mutate production source.
  const [row] = await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, d.id));
  const { diceTarget: _target, ...old } = row.data;
  const rules = f.load('gameDuelRules') as typeof import('../src/gameDuelRules.js');
  await t.db.update(schema.gameRounds).set({ data: { ...old, rolls: rules.duelRolls(d.id, String(old.seed)) } })
    .where(orm.eq(schema.gameRounds.id, d.id));
  const done = await finishDice(f, d, 10, 1);
  assert.equal(done.d.winnerId, 'a'); assert.equal(done.d.payout, 180);
  assert.equal(Reflect.get(done.d, 'diceTarget'), undefined);
  assert.equal((await money()).ledger.filter(l => l.reason === 'duel.win').length, 1); await drift();
});


test('исчерпанные восемь бросков до двух побед возвращают обе ставки без комиссии и повторного возврата', bounded, async () => {
  const f = await fixture(); const d = await start(f, false, false, 'dice');
  // Valid persisted draw state isolates the budget/refund transition from seed selection.
  // Only fixture data is set; production code, escrow and payout rules are not mocked.
  const [row] = await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, d.id));
  await t.db.update(schema.gameRounds).set({ data: { ...row.data, rolls: Array.from({ length: 8 }, () => [3, 3, 2, 4]) } })
    .where(orm.eq(schema.gameRounds.id, d.id));
  const done = await finishDice(f, d, 10, 8);
  assert.equal(done.d.state, 'settled'); assert.equal(done.d.reason, 'draw-limit');
  assert.equal(done.d.winnerId, null); assert.equal(done.d.payout, null);
  const paid = await money();
  assert.deepEqual(paid.balances.map(b => b.balance), [1000, 1000, 1000]);
  assert.equal(paid.stakes.length, 2);
  assert.ok(paid.stakes.every(s => s.refundedAt && !s.paidAt));
  assert.equal(paid.ledger.filter(l => l.reason === 'duel.refund').length, 2);
  assert.equal(paid.ledger.filter(l => l.reason === 'duel.win').length, 0);
  await tick(f, done.ms + 20_000); assert.deepEqual(await money(), paid); await drift();
});


test('HTTP rollNo не позволяет запоздалому броску ноль раскрыть кости первого, текущий номер и старый запрос принимаются', bounded, async () => {
  const f = await fixture(undefined, [1, -1, 1]); const d = await start(f, false, false, 'dice');
  const held = await money(); const initial = await snapshot(f);
  for (const rollNo of [-1, 0.5, '0', null]) {
    const invalid = await post(f, `/${d.id}/roll`, 'a', { rollNo });
    assert.ok(invalid.statusCode >= 400, invalid.body);
    assert.deepEqual(await snapshot(f), initial);
    assert.deepEqual(await money(), held);
  }
  f.clock(10);
  const first = ok(await post(f, `/${d.id}/roll`, 'a', { rollNo: 0 }));
  assert.ok(first.rolls[0].challenger);
  const next = ok(await post(f, `/${d.id}/roll`, 'b', { rollNo: 0 }));
  assert.equal(next.rollNo, 1); assert.deepEqual(next.rolls[1], { challenger: null, target: null });
  const rows = normal(await t.db.select().from(schema.gameRounds)); const events = f.wires.length;
  f.clock(1000);
  for (const user of ['a', 'b']) assert.deepEqual(ok(await post(f, `/${d.id}/roll`, user, { rollNo: 0 })), next);
  assert.deepEqual(normal(await t.db.select().from(schema.gameRounds)), rows);
  assert.equal(f.wires.length, events); assert.deepEqual(await money(), held);
  const current = ok(await post(f, `/${d.id}/roll`, 'a', { rollNo: 1 }));
  assert.ok(current.rolls[1].challenger); assert.equal(current.rolls[1].target, null);
  const legacy = ok(await post(f, `/${d.id}/roll`, 'b'));
  assert.equal(legacy.rollNo, 2); assert.deepEqual(await money(), held); await drift();
});

test('HTTP withdraw без тела по-прежнему отзывает приглашение без ставок и не даёт принять его позднее', bounded, async () => {
  const f = await fixture(); const held = await money();
  const invited = ok(await post(f, '', 'a', { channelId: 'v', targetId: 'b', game: 'dice', amount: 100 }));
  const withdrawn = ok(await post(f, `/${invited.id}/withdraw`, 'a'));
  assert.equal(withdrawn.state, 'cancelled'); assert.equal(withdrawn.reason, 'withdrawn');
  const late = await post(f, `/${invited.id}/accept`, 'b');
  assert.notEqual(late.statusCode, 200);
  assert.deepEqual(await money(), held); await drift();
});
