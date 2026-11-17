import assert from 'node:assert/strict';
import { counterfact } from '../../shared/test/counterfacts.js';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

// Настоящие миграции/PGlite, gameDuel, gameMoney, coins и правила. VM исполняет ЦЕЛЫЕ модули;
// заменены только Redis, шина, env, часы/random IO. Для победы/переброса подобрано детерминированное
// зерно; лишь шесть ничьих — test-only копия duelRolls, НЕ расчёта выплат. Денежных заглушек нет.
// PGlite имеет одно соединение: эти тесты НЕ доказывают гонку двух PostgreSQL-сессий.
// Для межсессионных гарантий дополнительно проверяется AST замков/порядка/границы транзакции.
type Edit = { file: string; from: string; to: string };
type Duel = typeof import('../src/gameDuel.js');
type Rolls = 'win' | 'reroll' | 'draws';
type Wire = { userId?: string; serverId?: string; channelId?: string; audience?: string[]; message: Record<string, any> };
const T0 = Date.parse('2026-10-28T12:00:00Z');
const at = (ms: number) => new Date(T0 + ms);
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const read = (file: string) => readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let t: TestDb;
before(async () => {
  t = await createTestDb();
  await t.raw.exec("ALTER TABLE coin_ledger ALTER COLUMN created_at SET DEFAULT '2026-10-28T12:00:00Z'::timestamptz");
});
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

function replaceOnce(source: string, edit: Pick<Edit, 'from' | 'to'>) {
  assert.equal(source.split(edit.from).length, 2, 'R332 setup: уникальный якорь whole-module мутанта');
  return source.replace(edit.from, edit.to);
}

function runtime(edit?: Edit, forced?: Rolls) {
  let clock = T0;
  let sequence = 0;
  let lastRoundId = '';
  const wires: Wire[] = [];
  const warnings: string[] = [];
  const presence = new Map([['v1', ['a', 'b', 'c', 'd']], ['v2', ['a', 'b', 'c', 'd']]]);
  const redis = new Map<string, { value: string; expires: number }>();
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? clock : value instanceof Date ? value.getTime() : value); }
    static override now() { return clock; }
  }
  const values: Record<string, unknown> = {
    'db/index': { db: t.db }, 'db/schema': schema,
    util: { id: () => (lastRoundId = `duel-fixture-${++sequence}`) },
    env: { env: { economyPreviewUsers: [] } },
    realtime: {
      redisPub: {
        set: async (key: string, value: string, _px: string, ms: number, nx?: string) => {
          if (nx && (redis.get(key)?.expires ?? 0) > clock) return null;
          redis.set(key, { value, expires: clock + ms });
          return 'OK';
        },
        pttl: async (key: string) => Math.max(-2, (redis.get(key)?.expires ?? clock - 2) - clock),
        eval: async (_script: string, _count: number, key: string, token: string) => {
          if (redis.get(key)?.value === token) redis.delete(key);
          return 1;
        },
        get: async (key: string) => key.startsWith('presence:ch:')
          ? JSON.stringify((presence.get(key.slice('presence:ch:'.length)) ?? []).map(userId => ({ userId })))
          : redis.get(key)?.value ?? null,
      },
      publishToUser: async (userId: string, message: Wire['message']) => { wires.push({ userId, message: normal(message) }); },
      publishToServer: async (serverId: string, message: Wire['message']) => { wires.push({ serverId, message: normal(message) }); },
      publishToChannel: async (serverId: string, channelId: string, message: Wire['message'], audience: string[]) => {
        wires.push({ serverId, channelId, message: normal(message), audience: [...audience] });
      },
    },
  };
  const files = new Set(['gameDuel', 'gameDuelRules', 'gameMoney', 'gameMoneyRules', 'coins', 'coinRules', 'streakRules', 'economyDefaults', 'voicePresence']);
  const cache = new Map<string, Record<string, any>>();
  const sources = new Map<string, string>();
  function load<T>(file: string): T {
    if (Object.hasOwn(values, file)) return values[file] as T;
    if (cache.has(file)) return cache.get(file) as T;
    assert.ok(files.has(file), `R332 setup: закрытый импорт ${file}`);
    let source = read(file);
    if (file === 'gameDuelRules' && forced === 'draws') {
      const rolls = Array.from({ length: 6 }, () => [3, 3, 2, 4]);
      source = replaceOnce(source, {
        from: 'export function duelRolls(roundId: string, seedHex: string): DuelRoll[] {',
        to: `export function duelRolls(roundId: string, seedHex: string): DuelRoll[] { return ${JSON.stringify(rolls)};`,
      });
    }
    if (edit?.file === file) source = replaceOnce(source, edit);
    sources.set(file, source);
    const module = { exports: {} as Record<string, any> };
    cache.set(file, module.exports);
    runInNewContext(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer, Error, Uint8Array,
      setInterval() { throw new Error('R332 setup: фоновые worker в денежных сценариях запрещены'); },
      console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
      require(id: string) {
        if (id === 'drizzle-orm') return orm;
        if (id === '@gusvoice/shared') return shared;
        if (id === 'node:crypto') return { ...crypto, randomBytes: (size: number) => {
          ++sequence;
          if (size !== 32 || (forced !== 'win' && forced !== 'reroll')) return Buffer.alloc(size, sequence);
          // Подбирается только random IO. Сам duelRolls и его связь seed→кости остаются production.
          for (let n = 0; n < 10000; n++) {
            const seed = crypto.createHash('sha256').update(`R332 deterministic ${lastRoundId} ${forced} ${n}`).digest();
            const dice = (rollNo: number) => shared.diceFromHash(crypto.createHash('sha256').update(shared.duelRollInput(lastRoundId, seed.toString('hex'), rollNo)).digest());
            const first = dice(0);
            if (forced === 'win' && first[0] + first[1] > first[2] + first[3]) return seed;
            const second = dice(1);
            if (forced === 'reroll' && shared.duelRollIsDraw(first) && second[0] + second[1] < second[2] + second[3]) return seed;
          }
          throw new Error('R332 setup: не найдено детерминированное зерно');
        } };
        assert.ok(id.startsWith('.'), `R332 setup: внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(file), id)).replace(/\.js$/, ''));
      },
    });
    return module.exports as T;
  }
  return { duel: load<Duel>('gameDuel'), load, sources, wires, warnings, presence, clock(ms: number) { clock = T0 + ms; } };
}
type Fixture = ReturnType<typeof runtime>;

async function fixture(edit?: Edit, forced?: Rolls) {
  await truncateAll(t.raw);
  const users = ['a', 'b', 'c', 'd'];
  await t.db.insert(schema.users).values(users.map(id => ({ id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true })));
  await t.db.insert(schema.servers).values({ id: 's', name: 'Дуэли', ownerId: 'a' });
  await t.db.insert(schema.serverMembers).values(users.map(userId => ({ serverId: 's', userId })));
  await t.db.insert(schema.channels).values(['v1', 'v2'].map(id => ({ id, serverId: 's', name: id, type: 'voice' as const })));
  await t.db.insert(schema.serverEconomy).values({ serverId: 's', enabled: true, gamesEnabled: true, gamesBetMax: 300, gamesDailyLossMax: 0, gamesFeePercent: 10 });
  await t.db.insert(schema.coinBalances).values(users.map(userId => ({ serverId: 's', userId, balance: 1000, earnedTotal: 17, seasonEarned: 23, seasonId: 'autumn-2026' })));
  await t.db.insert(schema.coinLedger).values(users.map(userId => ({ id: `fund-${userId}`, serverId: 's', userId, amount: 1000, reason: 'fixture' })));
  return runtime(edit, forced);
}
async function balances() { return Object.fromEntries((await t.db.select().from(schema.coinBalances)).map(w => [w.userId, w.balance])); }
async function rounds() { return t.db.select().from(schema.gameRounds); }
async function round(id: string) { return (await rounds()).find(r => r.id === id)!; }
async function stakes() { return t.db.select().from(schema.gameStakes).orderBy(orm.asc(schema.gameStakes.userId)); }
async function ledger(reason?: string) {
  const rows = await t.db.select().from(schema.coinLedger).orderBy(orm.asc(schema.coinLedger.userId), orm.asc(schema.coinLedger.id));
  return reason ? rows.filter(r => r.reason === reason) : rows;
}
async function drift() {
  const result = await t.raw.query(`SELECT b.user_id FROM coin_balances b LEFT JOIN coin_ledger l USING (server_id,user_id)
    GROUP BY b.server_id,b.user_id,b.balance HAVING b.balance <> COALESCE(SUM(l.amount),0)::int`);
  assert.deepEqual(result.rows, [], 'R332 drift: кошельки равны сумме настоящего журнала');
}
async function adjust(userId: string, amount: number) {
  await t.db.transaction(async tx => {
    await tx.update(schema.coinBalances).set({ balance: orm.sql`${schema.coinBalances.balance} + ${amount}` }).where(orm.eq(schema.coinBalances.userId, userId));
    await tx.insert(schema.coinLedger).values({ id: `adjust-${userId}`, serverId: 's', userId, amount, reason: 'fixture' });
  });
}
async function challenge(f: Fixture, ms = 0, challengerId = 'a', targetId = 'b', channelId = 'v1') {
  f.clock(ms);
  return normal(await f.duel.challengeDuel({ serverId: 's', channelId, challengerId, targetId, game: 'dice', amount: 100 }, at(ms)));
}
async function invite(f: Fixture, ms = 0) {
  const result = await challenge(f, ms);
  assert.ok(result.ok && result.duel, 'R332 setup: корректный вызов принимается');
  return result.duel.id;
}
async function accept(f: Fixture, id: string, ms = 1) {
  // R332 retains its pre-upgrade invitation fixtures (one win). New two-win games and their real
  // ledger transitions are covered in gameDuelSeries.itest.ts; do not weaken those assertions.
  await t.db.update(schema.gameRounds).set({ data: orm.sql`${schema.gameRounds.data} - 'diceTarget'` })
    .where(orm.eq(schema.gameRounds.id, id));
  f.clock(ms);
  const result = await f.duel.acceptDuel('s', id, 'b', at(ms));
  assert.ok(result.ok && result.duel, 'R332 setup: корректное принятие проходит');
  return result.duel;
}
async function roll(f: Fixture, id: string, userId: string, ms: number) { f.clock(ms); return normal(await f.duel.rollDuel('s', id, userId, at(ms))); }
async function tick(f: Fixture, ms: number) { f.clock(ms); return normal(await f.duel.runDuelTick(at(ms))); }
const events = (f: Fixture) => f.wires.filter(w => w.message.t === 'duel.state');
async function completed(f: Fixture, id: string, ms = 2) {
  await roll(f, id, 'a', ms);
  await roll(f, id, 'b', ms + 1);
  return ms + 1 + 1500;
}

// Ни ошибка SQL/fixture, ни ошибка VM/импорта не принимаются за убийство: нужен именно адресный
// HOST AssertionError. После каждого мутанта снова строится БД и новый кэш оригинальных модулей.
async function proof(prefix: string, scenario: (edit?: Edit) => Promise<void>, edits: Edit[]) {
  await scenario();
  for (const edit of edits) {
    await counterfact(async () => {
    const source = read(edit.file);
    await assert.rejects(scenario(edit), error => error instanceof assert.AssertionError && error.message.startsWith(prefix));
    assert.equal(read(edit.file), source, 'R332 setup: prod-исходник не менялся');
    });
    await scenario();
  }
}
function bodyOf(source: string, name: string) {
  const ast = ts.createSourceFile('gameDuel.ts', source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(fn?.body, `R332 setup: функция ${name} найдена`);
  return fn.body;
}
function callsIn(node: ts.Node) {
  const calls: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => { if (ts.isCallExpression(n)) calls.push(n); ts.forEachChild(n, visit); };
  visit(node);
  return calls;
}
const method = (c: ts.CallExpression, name: string) => ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === name;
async function escrow(edit?: Edit) {
  const f = await fixture(edit);
  const id = await invite(f);
  assert.deepEqual(await balances(), { a: 1000, b: 1000, c: 1000, d: 1000 });
  assert.equal((await stakes()).length, 0);
  assert.deepEqual(events(f).map(w => w.userId).sort(), ['a', 'b']);
  const dto = await accept(f, id);
  assert.equal(dto.state, 'playing');
  assert.deepEqual(await balances(), { a: 900, b: 900, c: 1000, d: 1000 }, 'R332 эскроу: ровно одинаковые ставки списаны обоим');
  assert.deepEqual((await stakes()).map(s => [s.userId, s.amount, s.pick, s.paidAt, s.refundedAt]), [['a', 100, 'duel', null, null], ['b', 100, 'duel', null, null]]);
  assert.deepEqual((await ledger('duel.stake')).map(s => [s.userId, s.amount, s.refUserId]), [['a', -100, 'b'], ['b', -100, 'a']]);
  assert.deepEqual(normal(await f.duel.acceptDuel('s', id, 'b', at(2))), { ok: false, code: 'expired' });
  assert.equal((await stakes()).length, 2);
  assert.deepEqual(events(f).at(-1)!.audience?.sort(), ['a', 'b', 'c', 'd']);
  await drift();
}
test('R332 вызов денег не трогает; принятие создаёт два равных эскроу с ref соперников ровно однажды', () => escrow());

async function poorAfterInvite(edit?: Edit) {
  for (const poor of ['a', 'b']) {
    const f = await fixture(edit);
    const id = await invite(f);
    await adjust(poor, -950);
    f.clock(1);
    const result = await f.duel.acceptDuel('s', id, 'b', at(1));
    assert.deepEqual(normal(result), { ok: false, code: poor === 'a' ? 'target_unavailable' : 'poor' }, 'R332 бедность: отказ после приглашения без раскрытия чужих денег');
    assert.deepEqual(await balances(), { a: poor === 'a' ? 50 : 1000, b: poor === 'b' ? 50 : 1000, c: 1000, d: 1000 }, 'R332 бедность: при любой неудаче никто из пары не платит');
    assert.equal((await stakes()).length, 0, 'R332 бедность: даже первая успешная ставка откатывается при провале второй');
    assert.equal((await ledger('duel.stake')).length, 0);
    assert.equal((await round(id)).state, 'open');
    await drift();
  }
}
test('R332 после приглашения обеднел любой игрок: принятие откатывает обе ставки и весь журнал', () => poorAfterInvite());

async function atomicity(edit?: Edit) {
  const f = await fixture(edit);
  const id = await invite(f);
  await adjust('a', -950); // Вторая ставка падает ПОСЛЕ успешной ставки цели; это реальная транзакция.
  const result = await f.duel.acceptDuel('s', id, 'b', at(1));
  assert.equal(result.ok, false, 'R332 атомарность: отказ второй ставки возвращается наружу');
  assert.equal((await balances()).b, 1000, 'R332 атомарность: первая ставка цели не пережила откат');
  assert.equal((await stakes()).length, 0);
  await drift();
}
test('провал второй ставки откатывает первую ставку и не оставляет эскроу', () => atomicity());

async function clickAndDeadline(edit?: Edit) {
  const f = await fixture(edit, 'win');
  const id = await invite(f);
  await accept(f, id);
  const dice = (await round(id)).data.rolls as number[][];
  const clicked = await roll(f, id, 'a', 2);
  assert.ok(clicked.ok && clicked.duel);
  assert.deepEqual(clicked.duel.rolls, [{ challenger: dice[0].slice(0, 2), target: null }]);
  assert.deepEqual(await tick(f, 15000), { steps: 0 });
  assert.deepEqual(await tick(f, 15001), { steps: 1 }, 'R332 срок броска: ровно turnUntil сервер раскрывает молчавшего');
  const row = await round(id);
  assert.equal(row.data.phase, 'done');
  assert.equal(row.settleAt?.getTime(), T0 + 16501);
  assert.deepEqual(events(f).at(-1)!.message.duel.rolls[0].target, dice[0].slice(2));
  assert.equal((await ledger('duel.win')).length, 0);
  await drift();
}
test('R332 нажатие раскрывает только свою пару; молчавший бросает ровно в дедлайн, перед выплатой остаётся анимация', () => proof('R332 срок броска:', clickAndDeadline, [{
  file: 'gameDuel', from: "and(eq(gameRounds.state, 'locked'), lte(gameRounds.settleAt, now)),", to: "and(eq(gameRounds.state, 'locked'), sql`${gameRounds.settleAt} < ${now}`),",
}]));

async function idempotentRoll(edit?: Edit) {
  const f = await fixture(edit, 'win');
  const id = await invite(f);
  await accept(f, id);
  await roll(f, id, 'a', 2);
  const before = normal({ row: await round(id), events: events(f), balances: await balances() });
  await roll(f, id, 'a', 3);
  assert.deepEqual(normal({ row: await round(id), events: events(f), balances: await balances() }), before,
    'R332 повтор броска: не изменяются ни строка, ни срок, ни события, ни деньги');
  await drift();
}
test('R332 повторное нажатие своего броска полностью идемпотентно, в том числе без повторного события', () => proof('R332 повтор броска:', idempotentRoll, [{
  file: 'gameDuelRules', from: 'if (!cur[side]) {', to: 'if (true) {',
}]));

async function reroll(edit?: Edit) {
  const f = await fixture(edit, 'reroll');
  const id = await invite(f);
  await accept(f, id);
  const dice = (await round(id)).data.rolls as number[][];
  await roll(f, id, 'a', 2);
  const result = await roll(f, id, 'b', 3);
  assert.ok(result.ok && result.duel);
  assert.equal(result.duel.rollNo, 1, 'R332 переброс: ничья переходит к следующему броску');
  assert.equal(result.duel.turnUntil, at(15003).toISOString());
  assert.deepEqual(result.duel.rolls, [{ challenger: dice[0].slice(0, 2), target: dice[0].slice(2) }, { challenger: null, target: null }]);
  assert.deepEqual(await tick(f, 15002), { steps: 0 });
  assert.deepEqual(await tick(f, 15003), { steps: 1 });
  await tick(f, 16503);
  assert.equal((await round(id)).data.winnerId, 'b');
  await drift();
}
test('R332 ничья даёт новый скрытый бросок и новый полный срок; следующая победа рассчитывается обычными деньгами', () => proof('R332 переброс:', reroll, [{
  file: 'gameDuelRules', from: 'data: { ...data, rollNo: rollNo + 1, revealed },', to: 'data: { ...data, rollNo, revealed },',
}]));

async function settlement(edit?: Edit) {
  const f = await fixture(edit, 'win');
  const id = await invite(f);
  await t.db.update(schema.serverEconomy).set({ gamesFeePercent: 50 }); // Комиссия уже заморожена вызовом, не принятием.
  await accept(f, id);
  const deadline = await completed(f, id);
  assert.deepEqual(await tick(f, deadline - 1), { steps: 0 });
  assert.deepEqual(await tick(f, deadline), { steps: 1 });
  const row = await round(id);
  const wins = await ledger('duel.win');
  assert.equal(row.state, 'settled');
  assert.equal(wins.length, 1);
  assert.deepEqual([wins[0].userId, wins[0].refUserId, wins[0].amount, wins[0].data.net], ['a', 'b', 180, 80],
    'R332 выплата: duel.win привязан к проигравшему, net чистый, комиссия из приглашения');
  assert.deepEqual([row.data.pool, row.data.fee, row.data.payout, row.data.feePercent], [200, 20, 180, 10], 'R332 выплата: замороженный банк и комиссия');
  assert.deepEqual(await balances(), { a: 1080, b: 900, c: 1000, d: 1000 });
  assert.ok((await stakes()).every(s => s.paidAt !== null && s.refundedAt === null));
  assert.deepEqual((await stakes()).map(s => s.payout), [180, 0]);
  assert.equal(events(f).at(-1)!.message.duel.seed, row.data.seed);
  for (const wallet of await t.db.select().from(schema.coinBalances)) assert.deepEqual([wallet.earnedTotal, wallet.seasonEarned], [17, 23]);
  const unchanged = normal({ rounds: await rounds(), ledger: await ledger(), balances: await balances(), events: events(f) });
  assert.deepEqual(await tick(f, deadline + 100000), { steps: 0 }, 'R332 выплата: повтор такта не начинает второй расчёт');
  assert.deepEqual(normal({ rounds: await rounds(), ledger: await ledger(), balances: await balances(), events: events(f) }), unchanged,
    'R332 выплата: итог, деньги, журнал и события не повторяются');
  await drift();
}
test('R332 победа платит один раз: duel.win/ref проигравшего/net, замороженная комиссия, проигрыш закрыт без строки выигрыша', () => proof('R332 выплата:', settlement, [
  { file: 'gameDuel', from: 'refUserId: win ? plan.loserId : plan.winnerId,', to: 'refUserId: undefined,' },
  { file: 'gameDuelRules', from: '    data.feePercent,', to: '    50,' },
]));

async function draws(edit?: Edit) {
  const f = await fixture(edit, 'draws');
  const id = await invite(f);
  await accept(f, id);
  for (let n = 0; n < 6; n++) {
    await roll(f, id, 'a', 2 + n * 2);
    await roll(f, id, 'b', 3 + n * 2);
    assert.equal((await round(id)).data.phase, n === 5 ? 'done' : 'playing');
    assert.equal((await ledger('duel.refund')).length, 0);
  }
  await tick(f, 1513);
  const row = await round(id);
  assert.deepEqual([row.state, row.data.reason, row.data.winnerId, row.data.payout, row.data.fee], ['settled', 'draw-limit', null, null, 0]);
  assert.deepEqual((await ledger('duel.refund')).map(s => [s.userId, s.amount]), [['a', 100], ['b', 100]],
    'R332 шесть ничьих: обе полные ставки вернулись, комиссия не взята');
  assert.equal((await ledger('duel.win')).length, 0);
  assert.ok((await stakes()).every(s => s.refundedAt !== null && s.paidAt === null));
  assert.deepEqual(await balances(), { a: 1000, b: 1000, c: 1000, d: 1000 });
  const before = normal(await ledger());
  await tick(f, 100000);
  assert.deepEqual(normal(await ledger()), before);
  await drift();
}
test('R332 первая ничья и пять перебросов возвращают обе ставки с duel.refund без комиссии и без повторного возврата', () => proof('R332 шесть ничьих:', draws, [{
  file: 'gameDuel', from: 'for (const s of stakes) await m.refundStake({ roundId: cur.id, userId: s.userId, pick: s.pick });',
  to: 'for (const s of stakes) await m.payStake({ roundId: cur.id, userId: s.userId, pick: s.pick, payout: 0 });',
}]));

async function safety(edit?: Edit) {
  const f = await fixture(edit, 'win');
  const id = await invite(f);
  await accept(f, id);
  await f.load<typeof import('../src/gameMoney.js')>('gameMoney').withGameMoney(m => m.refundStake({ roundId: id, userId: 'b', pick: 'duel' }));
  await tick(f, await completed(f, id));
  const row = await round(id);
  assert.deepEqual([row.state, row.data.reason], ['cancelled', 'player-deleted'], 'R332 предохранитель: неполный банк отменяется, а не выплачивается');
  assert.equal((await ledger('duel.win')).length, 0);
  assert.deepEqual((await ledger('duel.refund')).map(s => [s.userId, s.amount]), [['a', 100], ['b', 100]]);
  assert.ok((await stakes()).every(s => s.refundedAt !== null && s.paidAt === null));
  assert.deepEqual(await balances(), { a: 1000, b: 1000, c: 1000, d: 1000 });
  const before = normal(await ledger());
  await tick(f, 100000);
  assert.deepEqual(normal(await ledger()), before);
  await drift();
}
test('R332 ставка уже вернулась мимо дуэли: предохранитель возвращает другую и отменяет вместо выплаты неполного банка', () => proof('R332 предохранитель:', safety, [{
  file: 'gameDuel', from: 'if (!intact) {', to: 'if (false) {',
}]));

async function expiry(edit?: Edit) {
  const f = await fixture(edit);
  const id = await invite(f);
  assert.deepEqual(await tick(f, 29999), { steps: 0 });
  assert.deepEqual(normal(await f.duel.acceptDuel('s', id, 'b', at(30000))), { ok: false, code: 'expired' });
  assert.deepEqual(await tick(f, 30000), { steps: 1 }, 'R332 истечение: ровно inviteUntil вызов отменяется');
  assert.deepEqual([(await round(id)).state, (await round(id)).data.reason], ['cancelled', 'expired']);
  assert.equal((await stakes()).length, 0);
  assert.equal((await ledger()).length, 4);
  await drift();
}
test('R332 приглашение живо за миллисекунду до срока, в срок не принимается и отменяется тактом без денег', () => proof('R332 истечение:', expiry, [{
  file: 'gameDuel', from: "and(eq(gameRounds.state, 'open'), lte(gameRounds.lockAt, now)),", to: "and(eq(gameRounds.state, 'open'), sql`${gameRounds.lockAt} < ${now}`),",
}]));

async function endInvites(edit?: Edit) {
  for (const how of ['declined', 'withdrawn'] as const) {
    const f = await fixture(edit);
    const id = await invite(f);
    const owner = how === 'declined' ? 'b' : 'a';
    const stranger = owner === 'a' ? 'b' : 'a';
    assert.deepEqual(normal(await f.duel.endInvite('s', id, stranger, how, at(1))), { ok: false, code: 'not_player' });
    f.clock(1);
    const result = await f.duel.endInvite('s', id, owner, how, at(1));
    assert.ok(result.ok);
    assert.deepEqual([(await round(id)).state, (await round(id)).data.reason], ['cancelled', how], 'R332 закрыть вызов: отказ цели и отзыв автора переводят open в cancelled');
    assert.deepEqual(normal(await f.duel.acceptDuel('s', id, 'b', at(2))), { ok: false, code: 'expired' });
    assert.deepEqual(normal(await f.duel.endInvite('s', id, owner, how, at(2))), { ok: false, code: 'expired' });
    assert.equal((await ledger()).length, 4);
    if (how === 'withdrawn') assert.ok((await challenge(f, 3)).ok, 'R332 закрыть вызов: отзыв не навязывает паузу отказа');
    await drift();
  }
}
test('R332 отказ принадлежит цели, отзыв автору: закрытый вызов не принять и не закрыть повторно', () => proof('R332 закрыть вызов:', endInvites, [{
  file: 'gameDuel',
  from: ".set({ state: 'cancelled', settledAt: now, data: sql`${gameRounds.data} || jsonb_build_object('reason', ${how}::text)` })",
  to: ".set({ state: 'open', settledAt: now, data: sql`${gameRounds.data} || jsonb_build_object('reason', ${how}::text)` })",
}]));

async function cooldown(edit?: Edit) {
  for (const how of ['declined', 'expired', 'settled'] as const) {
    const f = await fixture(edit, 'win');
    const id = await invite(f);
    let ended: number;
    if (how === 'settled') { await accept(f, id); ended = await completed(f, id); await tick(f, ended); }
    else if (how === 'expired') { ended = 30000; await tick(f, ended); }
    else { ended = 1; f.clock(ended); await f.duel.endInvite('s', id, 'b', 'declined', at(ended)); }
    const pause = how === 'settled' ? 10000 : 60000;
    assert.deepEqual(await challenge(f, ended + pause - 1), { ok: false, code: 'cooldown', retryAt: at(ended + pause).toISOString() },
      'R332 пауза: за миллисекунду до срока вызов отклонён с точным retryAt');
    if (how === 'settled') assert.deepEqual(await challenge(f, ended + pause - 1, 'b', 'a'),
      { ok: false, code: 'cooldown', retryAt: at(ended + pause).toISOString() }, 'R332 пауза: реванш ограничен в обе стороны');
    const accepted = await challenge(f, ended + pause);
    assert.ok(accepted.ok, 'R332 пауза: ровно в срок вызов уже разрешён');
    assert.equal((await stakes()).length, how === 'settled' ? 2 : 0);
    await drift();
  }
}
test('R332 отказ и молчание дают 60 с, итог 10 с в обе стороны: −1 мс нельзя, ровно retryAt можно', () => proof('R332 пауза:', cooldown, [
  { file: 'gameDuelRules', from: 'export const DUEL_PAIR_COOLDOWN_MS = 60_000;', to: 'export const DUEL_PAIR_COOLDOWN_MS = 59_999;' },
  { file: 'gameDuel', from: 'ms: DUEL_REMATCH_PAUSE_MS,', to: 'ms: DUEL_REMATCH_PAUSE_MS - 1,' },
]));

async function exclusivity(edit?: Edit) {
  const f = await fixture(edit);
  const id = await invite(f);
  assert.deepEqual(await challenge(f, 1, 'c', 'a', 'v2'), { ok: false, code: 'in_duel' }, 'R332 занятость: участник живого вызова занят и в другом канале');
  await accept(f, id);
  assert.deepEqual(await challenge(f, 2, 'b', 'c', 'v2'), { ok: false, code: 'in_duel' }, 'R332 занятость: участник принятой партии тоже занят в другом канале');
  assert.equal((await rounds()).length, 1);
  assert.equal((await stakes()).length, 2);
  await drift();
}
test('R332 in_duel запрещает пересечение участников и для приглашения, и для партии, даже в разных каналах', () => proof('R332 занятость:', exclusivity, [{
  file: 'gameDuel', from: "if (busy) throw new DuelRefused('in_duel');", to: "if (false) throw new DuelRefused('in_duel');",
}]));

async function channelBusy(edit?: Edit) {
  const f = await fixture(edit);
  const id = await invite(f);
  for (const playing of [false, true]) {
    if (playing) await accept(f, id);
    assert.deepEqual(await challenge(f, 2, 'c', 'd'), { ok: false, code: 'channel_busy' }, 'R332 канал: другая пара не создаёт второй живой раунд');
    const base = await round(id);
    const duplicate = await t.db.insert(schema.gameRounds).values({ ...base, id: `duplicate-${playing}` }).onConflictDoNothing().returning();
    assert.deepEqual(duplicate, [], 'R332 канал: настоящий UNIQUE 0162 защищает open и locked даже мимо API');
  }
  await t.db.update(schema.serverEconomy).set({ gamesEnabled: false });
  await tick(f, 3); // Настоящая отмена возвращает escrow; тест индекса не оставляет висящие ставки.
  const base = await round(id);
  const closed = await t.db.insert(schema.gameRounds).values({ ...base, id: 'closed-same-channel' }).returning();
  assert.equal(closed.length, 1, 'R332 канал: закрытые раунды того же канала не конфликтуют');
  assert.equal((await ledger('duel.stake')).length, 2);
  await drift();
}
test('R332 channel_busy приходит другой паре; миграция 0162 независимо отклоняет open/locked, но разрешает закрытые', () => proof('R332 канал:', channelBusy, [{
  file: 'gameDuel', from: "if (!row) throw new DuelRefused('channel_busy');", to: "if (!row) throw new DuelRefused('in_duel');",
}]));

async function gamesOff(edit?: Edit) {
  for (const playing of [false, true]) for (const economyOff of [false, true]) {
    const f = await fixture(edit);
    const id = await invite(f);
    if (playing) await accept(f, id);
    await t.db.update(schema.serverEconomy).set(economyOff ? { enabled: false } : { gamesEnabled: false });
    assert.deepEqual(await tick(f, 2), { steps: 1 }, 'R332 выключение: такт сразу отменяет даже ещё не созревший раунд');
    const row = await round(id);
    assert.deepEqual([row.state, row.data.reason], ['cancelled', 'games-off'], 'R332 выключение: причина выключения, не истечение');
    assert.deepEqual(await balances(), { a: 1000, b: 1000, c: 1000, d: 1000 });
    assert.equal((await ledger('duel.refund')).length, playing ? 2 : 0);
    assert.ok((await stakes()).every(s => s.refundedAt !== null && s.paidAt === null));
    assert.equal(events(f).at(-1)!.message.duel.reason, 'games-off');
    const before = normal(await ledger());
    assert.deepEqual(await tick(f, 100000), { steps: 0 });
    assert.deepEqual(normal(await ledger()), before);
    await drift();
  }
}
test('R332 выключение игр или экономики тактом отменяет приглашение/партию, возвращает escrow, публикует причину и не повторяется', () => proof('R332 выключение:', gamesOff, [{
  file: 'gameDuel', from: "await cancelLiveRounds(m, cur.serverId, [cur.id], 'games-off');", to: "await cancelLiveRounds(m, cur.serverId, [cur.id], 'player-deleted');",
}]));

async function lockGuards(edit?: Edit) {
  const f = await fixture(edit, 'win');
  const source = f.sources.get('gameDuel')!;
  const calls = callsIn(bodyOf(source, 'duelStep'));
  const lock = calls.find(c => method(c, 'for') && /\.from\(gameRounds\)/.test(c.expression.getText()));
  assert.ok(lock?.arguments[0]?.getText() === "'update'" && lock.arguments[1] && ts.isObjectLiteralExpression(lock.arguments[1]),
    'R332 замки: такт использует FOR UPDATE с явными параметрами');
  const options = lock.arguments[1] as ts.ObjectLiteralExpression;
  assert.ok(options.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText() === 'of' && p.initializer.getText() === 'gameRounds'),
    'R332 замки: блокируется раунд, не nullable LEFT JOIN экономики');
  assert.ok(options.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText() === 'skipLocked' && p.initializer.kind === ts.SyntaxKind.TrueKeyword),
    'R332 замки: такт не ждёт чужой раунд — SKIP LOCKED обязателен');
  const where = calls.find(c => method(c, 'where') && /\.from\(gameRounds\)/.test(c.expression.getText()));
  assert.ok(where && /inArray\(gameRounds\.state, \[\.\.\.LIVE\]\)/.test(where.getText()), 'R332 замки: live state ограничен ещё в SQL');
  const challengeBody = bodyOf(source, 'challengeDuel');
  const challengeCalls = callsIn(challengeBody);
  const wallets = challengeCalls.find(c => method(c, 'lockWallets'));
  const busy = challengeCalls.find(c => method(c, 'where') && /inArray\(gameRounds\.state/.test(c.getText()));
  assert.ok(wallets && busy && wallets.pos < busy.pos, 'R332 замки: кошельки обоих блокируются до проверки in_duel');
  const money = f.sources.get('gameMoney')!;
  const lockBody = bodyOf(money, 'lockWallets');
  assert.ok(/\.sort\(\)/.test(lockBody.getText()) && /orderBy\(asc\(coinBalances\.userId\)\)/.test(lockBody.getText()) && /\.for\('update'\)/.test(lockBody.getText()),
    'R332 замки: оба кошелька действительно FOR UPDATE в общем порядке user_id');
  const id = await invite(f);
  await accept(f, id);
  await tick(f, await completed(f, id));
  const before = normal({ rounds: await rounds(), ledger: await ledger() });
  await t.db.update(schema.serverEconomy).set({ gamesEnabled: false });
  assert.deepEqual(await tick(f, 100000), { steps: 0 });
  assert.deepEqual(normal({ rounds: await rounds(), ledger: await ledger() }), before);
  await drift();
}
test('R332 межсессионные стражи: FOR UPDATE раунда, SKIP LOCKED, live state, кошельки до in_duel в порядке user_id', () => proof('R332 замки:', lockGuards, [
  { file: 'gameDuel', from: ".for('update', { of: gameRounds, skipLocked: true });", to: ".for('update', { of: gameRounds });" },
  { file: 'gameDuel', from: "          inArray(gameRounds.state, [...LIVE]),\n          // ⚠️", to: '          // ⚠️' },
]));
