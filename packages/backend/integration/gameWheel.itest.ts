import { counterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
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

// Реальны все миграции, транзакции, деньги и правила. VM загружает ЦЕЛЫЕ модули; подменены только
// Redis/шина, env и часы/случайность. Мутанты существуют только в строке исходника, не на диске.
// В PGlite одно соединение: очередь первых ставок НЕ доказывает PostgreSQL interleaving/race.
// Поэтому рядом с денежным сценарием стоят AST-стражи FOR UPDATE + ON CONFLICT + повторного чтения.
type Edit = { file: string; from: string; to: string };
type Wheel = typeof import('../src/gameWheel.js');
type Wire = { serverId?: string; userId?: string; message: Record<string, any> };
const T0 = Date.parse('2026-10-28T12:00:00Z');
const at = (ms: number) => new Date(T0 + ms);
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const read = (file: string) => readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let t: TestDb;
before(async () => {
  t = await createTestDb();
  // SQL DEFAULT не должен зависеть от сегодняшней даты CI: суточный лимит считает настоящий журнал.
  await t.raw.exec("ALTER TABLE coin_ledger ALTER COLUMN created_at SET DEFAULT '2026-10-28T12:00:00Z'::timestamptz");
});
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

function replaceOnce(source: string, edit: Pick<Edit, 'from' | 'to'>) {
  assert.equal(source.split(edit.from).length, 2, 'R328 уникальный якорь мутанта целого модуля');
  return source.replace(edit.from, edit.to);
}

function runtime(edit?: Edit, forcedJackpot = false, devForceJackpot = false, naturalMiss = false) {
  let clock = T0;
  let sequence = 0;
  const wires: Wire[] = [];
  const warnings: string[] = [];
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? clock : value instanceof Date ? value.getTime() : value); }
    static override now() { return clock; }
  }
  const values: Record<string, unknown> = {
    'db/index': { db: t.db }, 'db/schema': schema,
    util: { id: () => `wheel-fixture-${++sequence}` },
    env: { env: { economyPreviewUsers: [], wheelForceJackpot: devForceJackpot } },
    realtime: {
      redisPub: { set: async () => 'OK', eval: async () => 1 },
      publishToServer: async (serverId: string, message: Wire['message']) => { wires.push({ serverId, message: normal(message) }); },
      publishToUser: async (userId: string, message: Wire['message']) => { wires.push({ userId, message: normal(message) }); },
    },
  };
  const files = new Set(['gameWheel', 'gameWheelRules', 'gameMoney', 'gameMoneyRules', 'coins', 'coinRules', 'streakRules', 'economyDefaults']);
  const cache = new Map<string, Record<string, any>>();
  const sources = new Map<string, string>();
  function load<T>(file: string): T {
    if (Object.hasOwn(values, file)) return values[file] as T;
    if (cache.has(file)) return cache.get(file) as T;
    assert.ok(files.has(file), `R328 закрытый импорт ${file}`);
    let source = read(file);
    // Единственная принудительная развилка результата — test-only копия функции, как разрешено R328.
    // Ставки, payStake, splitJackpot, SQL и расчёт всех выплат по-прежнему настоящие.
    if ((forcedJackpot || naturalMiss) && file === 'gameWheelRules') source = replaceOnce(source, {
      from: 'export function wheelOutcome(roundId: string, seedHex: string): { sector: number; jackpotHit: boolean } {',
      to: `export function wheelOutcome(roundId: string, seedHex: string): { sector: number; jackpotHit: boolean } { return { sector: 1, jackpotHit: ${forcedJackpot} };`,
    });
    if (edit?.file === file) source = replaceOnce(source, edit);
    sources.set(file, source);
    const module = { exports: {} as Record<string, any> };
    cache.set(file, module.exports);
    runInNewContext(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer, Error, Uint8Array,
      // Worker в этих тестах не запускается; запуск и первый tick защищены отдельным AST-стражем.
      setInterval() { throw new Error('R328 worker не должен заводить фон в PGlite-сценариях'); },
      console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
      require(id: string) {
        if (id === 'drizzle-orm') return orm;
        if (id === '@gusvoice/shared') return shared;
        if (id === 'node:crypto') return { ...crypto, randomBytes: (size: number) => Buffer.alloc(size, ++sequence) };
        assert.ok(id.startsWith('.'), `R328 внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(file), id)).replace(/\.js$/, ''));
      },
    });
    return module.exports as T;
  }
  const wheel = load<Wheel>('gameWheel');
  return { wheel, load, sources, wires, warnings, clock(ms: number) { clock = T0 + ms; } };
}

async function fixture(edit?: Edit, forcedJackpot = false, devForceJackpot = false, naturalMiss = false) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['a', 'b', 'c', 'poor'].map(id => ({
    id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true,
  })));
  await t.db.insert(schema.servers).values({ id: 's', name: 'Колесо', ownerId: 'a' });
  await t.db.insert(schema.serverMembers).values(['a', 'b', 'c', 'poor'].map(userId => ({ serverId: 's', userId })));
  await t.db.insert(schema.serverEconomy).values({ serverId: 's', enabled: true, gamesEnabled: true, gamesBetMax: 300, gamesDailyLossMax: 0 });
  await t.db.insert(schema.coinBalances).values(['a', 'b', 'c', 'poor'].map(userId => ({
    serverId: 's', userId, balance: userId === 'poor' ? 5 : 1000,
    earnedTotal: 17, seasonEarned: 23, seasonId: 'autumn-2026',
  })));
  await t.db.insert(schema.coinLedger).values(['a', 'b', 'c', 'poor'].map(userId => ({
    id: `fund-${userId}`, serverId: 's', userId, amount: userId === 'poor' ? 5 : 1000, reason: 'fixture',
  })));
  return runtime(edit, forcedJackpot, devForceJackpot, naturalMiss);
}
type Fixture = ReturnType<typeof runtime>;

async function balances() {
  return Object.fromEntries((await t.db.select().from(schema.coinBalances)).map(w => [w.userId, w.balance]));
}
async function cents() {
  const [row] = await t.db.select({ cents: schema.serverEconomy.wheelJackpotCents }).from(schema.serverEconomy);
  return Number(row.cents);
}
async function rounds() { return t.db.select().from(schema.gameRounds); }
async function stakes() { return t.db.select().from(schema.gameStakes).orderBy(orm.asc(schema.gameStakes.userId), orm.asc(schema.gameStakes.pick)); }
async function ledger(reason?: string) {
  const all = await t.db.select().from(schema.coinLedger).orderBy(orm.asc(schema.coinLedger.userId), orm.asc(schema.coinLedger.id));
  return reason ? all.filter(r => r.reason === reason) : all;
}
async function drift() {
  const rows = await t.raw.query(`SELECT b.user_id, b.balance, COALESCE(SUM(l.amount),0)::int AS ledger
    FROM coin_balances b LEFT JOIN coin_ledger l USING (server_id,user_id)
    GROUP BY b.server_id,b.user_id,b.balance HAVING b.balance <> COALESCE(SUM(l.amount),0)::int`);
  assert.deepEqual(rows.rows, [], 'R328 drift: каждый кошелёк равен сумме настоящего журнала');
}
async function success(f: Fixture, user: string, pick: shared.WheelPick, amount: number, ms = 0) {
  f.clock(ms);
  const result = await f.wheel.placeWheelBet('s', user, pick, amount, at(ms));
  assert.ok(result.ok, `R328 setup: корректная ставка ${user}/${pick} принимается`);
  return result.roundId;
}
async function tick(f: Fixture, ms: number) { f.clock(ms); return normal(await f.wheel.runWheelTick(at(ms))); }
const stateEvents = (f: Fixture) => f.wires.filter(w => w.message.t === 'wheel.state');
const resultEvents = (f: Fixture) => f.wires.filter(w => w.message.t === 'wheel.result');

// Доказательство локально повторяемо: оригинал → мутант падает на своём инварианте → оригинал снова.
// SQL-ошибка, ошибка fixture/импорта или неуникальный якорь НЕ считаются убийством мутанта.
async function proof(prefix: string, scenario: (edit?: Edit) => Promise<void>, edits: () => readonly Edit[], editCount: number) {
  await scenario();
  for (let index = 0; index < editCount; index++) {
    await counterfact(async () => {
    const edit = edits()[index];
    const original = read(edit.file);
    await assert.rejects(scenario(edit), error => error instanceof assert.AssertionError && error.message.startsWith(prefix));
    assert.equal(read(edit.file), original, 'R328 исходник production не менялся');
    });
    await scenario();
  }
}

function bodyOf(source: string, name: string) {
  const ast = ts.createSourceFile('gameWheel.ts', source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(fn?.body, `R328 AST: функция ${name} существует`);
  return fn.body;
}
function callsIn(node: ts.Node) {
  const calls: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => { if (ts.isCallExpression(n)) calls.push(n); ts.forEachChild(n, visit); };
  visit(node);
  return calls;
}
function method(call: ts.CallExpression, name: string) {
  return ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === name;
}
function firstBetGuard(source: string) {
  const live = bodyOf(source, 'liveRound');
  assert.ok(callsIn(live).some(c => method(c, 'for') && c.arguments[0]?.getText() === "'update'"),
    'R328 первые ставки: живой раунд действительно блокируется FOR UPDATE');
  const place = bodyOf(source, 'placeWheelBet');
  const calls = callsIn(place);
  assert.ok(calls.some(c => method(c, 'onConflictDoNothing') && /\.insert\(gameRounds\)/.test(c.expression.getText())),
    'R328 первые ставки: вставка раунда переносит конфликт частичного UNIQUE');
  assert.ok(/inserted\[0\]\s*\?\?\s*\(await liveRound\(m\.tx, serverId, true\)\)/.test(place.getText()),
    'R328 первые ставки: проигравший вставку повторно читает и блокирует раунд');
}
function workerGuard(source: string) {
  const body = bodyOf(source, 'startWheelWorker');
  const statements = body.statements;
  const initial = statements.findIndex(s => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)
    && ts.isIdentifier(s.expression.expression) && s.expression.expression.text === 'tick');
  const interval = statements.findIndex(s => callsIn(s).some(c => ts.isIdentifier(c.expression) && c.expression.text === 'setInterval'));
  assert.ok(initial >= 0 && interval > initial, 'R328 рестарт: worker вызывает tick непосредственно до setInterval');
}
function tickGuard(source: string) {
  const calls = callsIn(bodyOf(source, 'wheelStep'));
  const lock = calls.find(c => method(c, 'for') && /\.from\(gameRounds\)/.test(c.expression.getText()));
  assert.ok(lock && lock.arguments[0]?.getText() === "'update'" && lock.arguments[1] && ts.isObjectLiteralExpression(lock.arguments[1]),
    'R328 такт-страж: выбор раунда имеет FOR UPDATE');
  const options = lock.arguments[1] as ts.ObjectLiteralExpression;
  assert.ok(options.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText() === 'of' && p.initializer.getText() === 'gameRounds'),
    'R328 такт-страж: блокируется именно gameRounds, не nullable сторона LEFT JOIN');
  assert.ok(options.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText() === 'skipLocked' && p.initializer.kind === ts.SyntaxKind.TrueKeyword),
    'R328 такт-страж: SKIP LOCKED обязателен, односоединённый PGlite не моделирует ожидание чужого замка');
  const where = calls.find(c => method(c, 'where') && /\.from\(gameRounds\)/.test(c.expression.getText()));
  assert.ok(where && /inArray\(gameRounds\.state, \[\.\.\.LIVE\]\)/.test(where.getText()),
    'R328 такт-страж: кандидат ограничен живыми состояниями ещё в SQL');
}

async function firstBets(edit?: Edit) {
  const f = await fixture(edit);
  firstBetGuard(f.sources.get('gameWheel')!);
  // Это очередь одного PGlite-соединения, НЕ две независимые PostgreSQL-сессии.
  const [a, b] = await Promise.all([
    f.wheel.placeWheelBet('s', 'a', 1, 100, at(0)),
    f.wheel.placeWheelBet('s', 'b', 3, 50, at(10)),
  ]);
  assert.ok(a.ok && b.ok, 'R328 первые ставки: два разных человека приняты');
  assert.equal(a.roundId, b.roundId, 'R328 первые ставки: оба запроса относятся к одному раунду');
  const all = await rounds();
  assert.equal(all.length, 1, 'R328 первые ставки: в БД один живой раунд');
  assert.equal(all[0].lockAt?.getTime(), T0 + 30_000);
  assert.equal((await stakes()).length, 2);
  assert.deepEqual(await balances(), { a: 900, b: 950, c: 1000, poor: 5 });
  assert.equal((await ledger('wheel.bet')).length, 2);
  await drift();
}
test('R328 первые ставки разных людей попадают в один раунд; SQL-защита гонки не заменена очередью PGlite', () => proof(
  'R328 первые ставки:', firstBets, () => ([
    { file: 'gameWheel', from: "const [row] = lock ? await base.for('update') : await base;", to: 'const [row] = await base;' },
    { file: 'gameWheel', from: 'round = inserted[0] ?? (await liveRound(m.tx, serverId, true));', to: 'round = inserted[0];' },
  ]), 2,
));

async function contributions(edit?: Edit) {
  const f = await fixture(edit);
  await success(f, 'a', 1, 100);
  await success(f, 'b', 3, 7, 1);
  await success(f, 'c', 20, 1, 2);
  assert.equal(await cents(), 161, 'R328 взносы: 150 + 10 + 1 сотых, округление отдельно на каждую ставку');
  assert.equal((await balances()).a, 900, 'R328 взносы: вклад из доли дома, не дополнительное списание');
  assert.equal((await f.wheel.wheelSnapshot('s', 'a', at(3))).jackpot, 1);
  await drift();
}
test('R328 сундук пополняется сотыми каждой принятой ставки, без дополнительного списания с человека', () => proof(
  'R328 взносы:', contributions, () => ([{ file: 'gameWheel', from: '${jackpotCentsOf(amount)}', to: '${0}' }]), 1,
));

const COMMIT_REFUSAL: Edit = {
  file: 'gameWheel', from: 'if (!r.ok) throw new BetRefused(wheelRefusalOf(r.block as StakeBlock));',
  // Именно commit вместо rollback: слой денег отказал, но внешняя транзакция закоммитила сундук/пустой раунд.
  to: 'if (!r.ok) return round.id;',
};
async function poorRollback(edit?: Edit) {
  const f = await fixture(edit);
  const before = normal(await balances());
  const result = await f.wheel.placeWheelBet('s', 'poor', 1, 10, at(0));
  assert.equal(await cents(), 0, 'R328 poor rollback: отказ откатывает вклад в сундук');
  assert.deepEqual(normal(result), { ok: false, code: 'poor' }, 'R328 poor rollback: причина отказа сохранена');
  assert.equal((await rounds()).length, 0, 'R328 poor rollback: первый отказ не оставляет пустой раунд');
  assert.deepEqual(await balances(), before);
  assert.equal((await stakes()).length, 0);
  assert.equal((await ledger('wheel.bet')).length, 0);
  assert.equal(f.wires.length, 0, 'R328 poor rollback: откат не публикует wallet/state');
  await success(f, 'a', 1, 10); // Парное принятие после отказа: игра не заблокирована целиком.
  await drift();
}
test('R328 нехватка монет откатывает первый раунд, сундук и события; следующий достаточный кошелёк принимается', () => proof(
  'R328 poor rollback:', poorRollback, () => ([COMMIT_REFUSAL]), 1,
));

async function duplicateRollback(edit?: Edit) {
  const f = await fixture(edit);
  await success(f, 'a', 1, 100);
  const before = normal(await balances());
  const wires = f.wires.length;
  const duplicate = await f.wheel.placeWheelBet('s', 'a', 1, 100, at(1));
  assert.equal(await cents(), 150, 'R328 duplicate rollback: непринятая повторная ставка не пополняет сундук');
  assert.deepEqual(normal(duplicate), { ok: false, code: 'duplicate_pick' }, 'R328 duplicate rollback: повтор числа имеет свой отказ');
  assert.deepEqual(await balances(), before);
  assert.equal((await ledger('wheel.bet')).length, 1);
  assert.equal((await stakes()).length, 1);
  assert.equal(f.wires.length, wires, 'R328 duplicate rollback: откат не делает ложного пуша');
  await success(f, 'a', 3, 10, 2);
  assert.equal((await stakes()).length, 2, 'R328 duplicate rollback: другое число того же человека разрешено');
  await drift();
}
test('R328 duplicate_pick не списывает и не пополняет сундук повторно, иной pick принимается', () => proof(
  'R328 duplicate rollback:', duplicateRollback, () => ([COMMIT_REFUSAL, {
    file: 'gameWheelRules', from: "if (block === 'duplicate') return 'duplicate_pick';", to: "if (block === 'duplicate') return 'round_locked';",
  }]), 2,
));

async function deadline(edit?: Edit) {
  const f = await fixture(edit);
  const id = await success(f, 'a', 1, 10);
  const justBefore = await f.wheel.placeWheelBet('s', 'b', 3, 10, at(29_999));
  assert.ok(justBefore.ok, 'R328 lock_at: за миллисекунду до границы ставка ещё принимается');
  const before = normal(await balances());
  assert.deepEqual(normal(await f.wheel.placeWheelBet('s', 'c', 5, 10, at(30_000))), { ok: false, code: 'round_locked' },
    'R328 lock_at: ровно lock_at уже нельзя, даже если такт ещё не запер строку');
  assert.deepEqual(await balances(), before);
  assert.equal((await rounds())[0].id, id);
  assert.equal((await rounds())[0].state, 'open');
  assert.equal(await cents(), 30);
  await drift();
}
test('R328 lock_at−1 принимает ставку, ровно lock_at отклоняет без ожидания такта', () => proof(
  'R328 lock_at:', deadline, () => ([{ file: 'gameWheel', from: 'round.lockAt.getTime() <= now.getTime()', to: 'round.lockAt.getTime() < now.getTime()' }]), 1,
));

async function lifecycle(edit?: Edit) {
  const f = await fixture(edit);
  const id = await success(f, 'a', 1, 100);
  for (const [user, pick, amount] of [['b', 3, 50], ['c', 5, 20], ['b', 10, 10], ['c', 20, 7]] as const) await success(f, user, pick, amount, 1);
  assert.deepEqual(await tick(f, 29_999), { locked: 0, settled: 0, cancelled: 0 }, 'R328 цикл: преждевременный такт ничего не меняет');
  assert.deepEqual(await tick(f, 30_000), { locked: 1, settled: 0, cancelled: 0 }, 'R328 цикл: в границу только open → locked');
  const [locked] = await rounds();
  assert.equal(locked.state, 'locked');
  assert.equal(locked.settleAt?.getTime(), T0 + 36_000, 'R328 цикл: вращение длится ровно шесть секунд');
  const before = await balances();
  const oldStakes = await stakes();
  const originalRules = f.load<typeof import('../src/gameWheelRules.js')>('gameWheelRules');
  const outcome = originalRules.wheelOutcome(id, String(locked.data.seed));
  assert.equal(locked.data.sector, outcome.sector, 'R328 цикл: locked сектор вычислен из сохранённого зерна');
  assert.equal(locked.data.jackpotHit, outcome.jackpotHit);
  const split = outcome.jackpotHit ? shared.splitJackpot(await cents(), ['a', 'b', 'c'].map(userId => ({
    userId, total: oldStakes.filter(s => s.userId === userId).reduce((sum, s) => sum + s.amount, 0),
  }))) : { shares: [], leftCents: await cents() };
  assert.deepEqual(await tick(f, 35_999), { locked: 0, settled: 0, cancelled: 0 });
  assert.deepEqual(await tick(f, 36_000), { locked: 0, settled: 1, cancelled: 0 }, 'R328 цикл: ровно settle_at платит');
  const after = await balances();
  for (const user of ['a', 'b', 'c']) {
    const payout = oldStakes.filter(s => s.userId === user).reduce((sum, s) => sum + shared.wheelPayout(Number(s.pick) as shared.WheelPick, s.amount, outcome.sector), 0);
    assert.equal(after[user] - before[user], payout + (split.shares.find(s => s.userId === user)?.coins ?? 0), 'R328 цикл: баланс вырос ровно на выплату этого человека');
  }
  const settled = (await rounds())[0];
  assert.equal(settled.state, 'settled');
  assert.equal(settled.settledAt?.getTime(), T0 + 36_000);
  assert.equal(settled.data.pool, 187);
  assert.equal(settled.data.jackpotCents, 280);
  const paid = (await stakes()).reduce((sum, s) => sum + (s.payout ?? 0), 0);
  assert.equal(settled.data.fee, (18700 - paid * 100 - 280) / 100);
  for (const s of await stakes()) {
    assert.ok(s.paidAt, 'R328 цикл: даже проигрыш помечен paid_at');
    assert.equal(s.refundedAt, null);
    const wins = (await ledger('wheel.win')).filter(l => l.userId === s.userId && l.data.pick === s.pick);
    assert.equal(wins.length, s.payout! > 0 ? 1 : 0, 'R328 цикл: нулевая выплата не засоряет журнал');
  }
  const beforeRepeat = normal({ balances: after, ledger: await ledger(), rounds: await rounds(), cents: await cents() });
  assert.deepEqual(await tick(f, 100_000), { locked: 0, settled: 0, cancelled: 0 }, 'R328 цикл: повтор такта не повторяет итог');
  assert.deepEqual(normal({ balances: await balances(), ledger: await ledger(), rounds: await rounds(), cents: await cents() }), beforeRepeat,
    'R328 цикл: повтор не меняет деньги, журнал или раунд');
  assert.equal(resultEvents(f).length, 1);
  assert.equal(f.warnings.length, 0);
  await drift();
}
test('R328 open → locked → settled соблюдает обе границы, платит по ставкам однажды и сохраняет drift 0', () => proof(
  'R328 цикл:', lifecycle, () => ([{ file: 'gameWheel', from: 'payout: plan.payouts[i]', to: 'payout: plan.payouts[i] + 1' }]), 1,
));

async function livePrivacy(edit?: Edit) {
  const f = await fixture(edit);
  await success(f, 'a', 1, 100);
  const [row] = await rounds();
  const seed = String(row.data.seed);
  assert.equal(row.data.commit, crypto.createHash('sha256').update(shared.wheelCommitInput(row.id, seed)).digest('hex'),
    'R328 privacy: commit привязан к id и сохранённому зерну');
  for (const ms of [1, 30_000]) {
    if (ms === 30_000) await tick(f, ms);
    const snap = await f.wheel.wheelSnapshot('s', 'a', at(ms));
    assert.equal(snap.round?.state, ms === 1 ? 'open' : 'locked');
    assert.equal(snap.round?.bets.length, 1);
    assert.equal(snap.round?.commit, row.data.commit);
    assert.equal(snap.round?.sector === null, ms === 1);
    const payloads = [snap, ...stateEvents(f).map(w => w.message)];
    for (const payload of payloads) {
      assert.ok(!JSON.stringify(payload).includes(seed), 'R328 privacy: seed не раскрывается до итога');
      assert.ok(!/"(?:seed|data)"\s*:/.test(JSON.stringify(payload)), 'R328 privacy: живой DTO не содержит ни seed-поля, ни всего data');
    }
  }
  const state = stateEvents(f);
  assert.equal(state.length, 2, 'R328 privacy: на ставку и блокировку приходят реальные wheel.state');
  assert.equal(state[0].serverId, 's');
  assert.equal(state[0].message.round.state, 'open');
  assert.equal(state[1].message.round.state, 'locked');
}
test('R328 снимок и wheel.state раскрывают commit/locked-сектор, но не seed и не data целиком', () => proof(
  'R328 privacy:', livePrivacy, () => ([{ file: 'gameWheelRules', from: 'bets: wheelBets(stakes),', to: 'bets: wheelBets(stakes), data,' }]), 1,
));

async function resultSeed(edit?: Edit) {
  const f = await fixture(edit);
  await success(f, 'a', 1, 100);
  const [row] = await rounds();
  await tick(f, 30_000);
  await tick(f, 36_000);
  const events = resultEvents(f);
  assert.equal(events.length, 1, 'R328 result: ровно один итог');
  assert.equal(events[0].message.last.seed, row.data.seed, 'R328 result: wheel.result несёт исходное зерно');
  assert.equal(events[0].message.last.commit, row.data.commit);
  assert.equal(events[0].message.last.id, row.id);
  assert.equal(events[0].message.cooldownUntil, at(46_000).toISOString());
  const snapshot = await f.wheel.wheelSnapshot('s', 'a', at(36_000));
  assert.equal(snapshot.round, null);
  assert.deepEqual(normal(snapshot.last), events[0].message.last, 'R328 result: восстановление GET совпадает с push');
}
test('R328 wheel.result и last снимка раскрывают то же зерно, которому соответствовал commit', () => proof(
  'R328 result:', resultSeed, () => ([{ file: 'gameWheelRules', from: 'seed: data.seed,', to: "seed: ''," }]), 1,
));

async function cooldown(edit?: Edit) {
  const f = await fixture(edit);
  await success(f, 'a', 1, 100);
  await tick(f, 30_000);
  await tick(f, 36_000);
  const before = normal({ balance: await balances(), cents: await cents(), rounds: await rounds() });
  assert.deepEqual(normal(await f.wheel.placeWheelBet('s', 'b', 3, 10, at(45_999))), { ok: false, code: 'cooldown', retryAt: at(46_000).toISOString() },
    'R328 cooldown: за миллисекунду до retryAt возвращается точный срок');
  const snap = await f.wheel.wheelSnapshot('s', 'b', at(45_999));
  assert.equal(snap.cooldownUntil, at(46_000).toISOString());
  assert.deepEqual(normal({ balance: await balances(), cents: await cents(), rounds: await rounds() }), before);
  const allowed = await f.wheel.placeWheelBet('s', 'b', 3, 10, at(46_000));
  assert.ok(allowed.ok, 'R328 cooldown: ровно retryAt новый раунд уже принимается');
  assert.equal((await f.wheel.wheelSnapshot('s', 'b', at(46_000))).cooldownUntil, null);
  assert.equal((await rounds()).length, 2);
  await drift();
}
test('R328 cooldown сообщает retryAt: −1 мс нельзя, ровно в срок новый раунд можно', () => proof(
  'R328 cooldown:', cooldown, () => ([{ file: 'gameWheelRules', from: 'until > now.getTime()', to: 'until >= now.getTime()' }]), 1,
));

async function jackpot(edit?: Edit) {
  const f = await fixture(edit, true);
  await t.db.update(schema.serverEconomy).set({ wheelJackpotCents: 100003 }).where(orm.eq(schema.serverEconomy.serverId, 's'));
  await success(f, 'a', 1, 100); // Угадал сектор 1.
  await success(f, 'a', 3, 100, 1); // Тот же человек: доля по сумме ДВУХ ставок.
  await success(f, 'b', 20, 300, 2); // Не угадал, но имеет право на сундук.
  await success(f, 'c', 5, 100, 3); // Ещё один проигравший с иной долей.
  assert.equal(await cents(), 100903);
  await tick(f, 30_000);
  const [locked] = await rounds();
  assert.equal(locked.data.jackpotHit, true);
  assert.equal(locked.data.sector, 1);
  const before = await balances();
  await tick(f, 36_000);
  const payouts = (await ledger('wheel.jackpot')).map(l => [l.userId, l.amount]);
  // Независимые числа: floor(100903 / 100 * [200,300,100] / 600) = [336,504,168].
  assert.deepEqual(payouts, [['a', 336], ['b', 504], ['c', 168]], 'R328 jackpot: доли по сумме ставок всех, не только угадавших');
  assert.equal(await cents(), 103, 'R328 jackpot: остаток дробей остаётся в сотых');
  const after = await balances();
  assert.deepEqual({ a: after.a - before.a, b: after.b - before.b, c: after.c - before.c }, { a: 526, b: 504, c: 168 },
    'R328 jackpot: обычная выплата отдельно, не подменяет доли сундука');
  for (const row of await ledger('wheel.jackpot')) assert.deepEqual(normal(row.data), { roundId: locked.id, pick: 'jackpot' });
  const wallets = await t.db.select().from(schema.coinBalances);
  for (const wallet of wallets) {
    assert.equal(wallet.earnedTotal, 17, 'R328 jackpot: выигрыш не заработок');
    assert.equal(wallet.seasonEarned, 23, 'R328 jackpot: выигрыш не сезон');
  }
  const event = resultEvents(f)[0].message.last;
  assert.equal(event.jackpotPaid, 1008);
  assert.equal(event.winners.filter((w: any) => w.pick === 'jackpot').length, 3);
  const immutable = normal({ ledger: await ledger(), balances: await balances(), cents: await cents() });
  assert.deepEqual(await tick(f, 50_000), { locked: 0, settled: 0, cancelled: 0 }, 'R328 jackpot: повтор не запускает итог');
  assert.deepEqual(normal({ ledger: await ledger(), balances: await balances(), cents: await cents() }), immutable, 'R328 jackpot: повтор не выдаёт сундук ещё раз');
  assert.equal(resultEvents(f).length, 1);
  await drift();
}
test('R328 принудительный срыв делит сундук по сумме ставок всех людей, включая проигравших, и не платит повторно', () => proof(
  'R328 jackpot:', jackpot, () => ([{
    file: 'gameWheelRules',
    from: 'for (const s of stakes) totals.set(s.userId, (totals.get(s.userId) ?? 0) + s.amount);',
    to: 'for (const s of stakes.filter((s, i) => payouts[i] > 0)) totals.set(s.userId, (totals.get(s.userId) ?? 0) + s.amount);',
  }]), 1,
));

async function cancellation(edit?: Edit) {
  // Тестируем обе причины выключения и обе живые фазы: нельзя отменять только ещё открытое колесо.
  for (const [locked, economyOff] of [[false, false], [true, false], [false, true], [true, true]]) {
    const f = await fixture(edit);
    const id = await success(f, 'a', 1, 100);
    await success(f, 'b', 3, 50, 1);
    if (locked) await tick(f, 30_000);
    const contribution = await cents();
    await t.db.update(schema.serverEconomy).set(economyOff ? { enabled: false } : { gamesEnabled: false });
    assert.deepEqual(await tick(f, locked ? 30_001 : 2), { locked: 0, settled: 0, cancelled: 1 }, 'R328 cancel: выключение отменяет живое колесо первым тактом');
    const closed = await stakes();
    assert.ok(closed.every(s => s.refundedAt !== null && s.paidAt === null), 'R328 cancel: возврат отмечен refunded_at, а не только записью журнала');
    assert.equal(await cents(), contribution, 'R328 cancel: взнос из доли дома остаётся в сундуке');
    assert.deepEqual(await balances(), { a: 1000, b: 1000, c: 1000, poor: 5 }, 'R328 cancel: все ставки вернулись полностью');
    assert.equal((await ledger('wheel.refund')).length, 2);
    assert.equal((await ledger('wheel.win')).length, 0);
    const row = (await rounds())[0];
    assert.equal(row.id, id);
    assert.equal(row.state, 'cancelled');
    const last = stateEvents(f).at(-1)!;
    assert.equal(last.message.round, null, 'R328 cancel: отмена публикует round:null');
    const snapshot = await f.wheel.wheelSnapshot('s', 'a', at(30_002));
    assert.equal(snapshot.enabled, false);
    assert.equal(snapshot.round, null);
    const beforeRepeat = normal(await ledger());
    assert.deepEqual(await tick(f, 100_000), { locked: 0, settled: 0, cancelled: 0 });
    assert.deepEqual(normal(await ledger()), beforeRepeat, 'R328 cancel: повтор отмены не возвращает ставку дважды');
    await drift();
  }
}
test('R328 выключение игр или экономики отменяет open/locked: возврат помечен, вклад сохранён, клиент получает round:null', () => proof(
  'R328 cancel:', cancellation, () => ([
    { file: 'gameMoney', from: '.set({ refundedAt: new Date() })', to: '.set({ payout: 0 })' },
    { file: 'gameMoney', from: '.where(inArray(gameRounds.id, ids));\n  const eventIds =',
      to: '.where(inArray(gameRounds.id, ids));\n  await m.tx.update(serverEconomy).set({ wheelJackpotCents: 0 }).where(eq(serverEconomy.serverId, serverId));\n  const eventIds =' },
  ]), 2,
));

async function restartOpen(edit?: Edit) {
  const old = await fixture();
  const id = await success(old, 'a', 1, 10);
  // Новый кэш целых модулей, без старого worker/таймеров/локального round id. Состояние только в БД.
  const fresh = runtime(edit);
  workerGuard(fresh.sources.get('gameWheel')!);
  assert.deepEqual(await tick(fresh, 90_000), { locked: 1, settled: 0, cancelled: 0 }, 'R328 рестарт: первый такт подхватывает просроченный open');
  const [row] = await rounds();
  assert.equal(row.id, id);
  assert.equal(row.state, 'locked');
  assert.equal(row.settleAt?.getTime(), T0 + 96_000, 'R328 рестарт: время вращения отсчитано от восстановления, не от старого lock_at');
  assert.equal(resultEvents(fresh).length, 0);
  assert.equal(stateEvents(fresh).length, 1);
  await drift();
}
test('R328 после нового экземпляра модуля первый такт запирает просроченный open; worker не ждёт интервала', () => proof(
  'R328 рестарт:', restartOpen, () => ([
    { file: 'gameWheel', from: "and(eq(gameRounds.state, 'open'), lte(gameRounds.lockAt, now)),", to: "and(eq(gameRounds.state, 'open'), sql`false`)," },
    { file: 'gameWheel', from: '  tick();\n  const timer = setInterval(tick, WHEEL_TICK_MS);', to: '  const timer = setInterval(tick, WHEEL_TICK_MS);' },
  ]), 2,
));

async function restartLocked(edit?: Edit) {
  const old = await fixture();
  const id = await success(old, 'a', 1, 100);
  await success(old, 'b', 3, 50, 1);
  await tick(old, 30_000);
  const [locked] = await rounds();
  const fresh = runtime(edit);
  workerGuard(fresh.sources.get('gameWheel')!);
  assert.deepEqual(await tick(fresh, 100_000), { locked: 0, settled: 1, cancelled: 0 }, 'R328 восстановление locked: первый такт рассчитывает просроченное вращение');
  const [settled] = await rounds();
  assert.equal(settled.id, id);
  assert.equal(settled.state, 'settled');
  assert.equal(settled.data.sector, locked.data.sector, 'R328 восстановление locked: показанный до рестарта сектор сохраняется');
  assert.equal(settled.data.seed, locked.data.seed);
  assert.equal(resultEvents(fresh).length, 1);
  assert.ok((await stakes()).every(s => s.paidAt));
  const before = normal(await ledger());
  await tick(fresh, 200_000);
  assert.deepEqual(normal(await ledger()), before);
  await drift();
}
test('R328 первый такт нового экземпляра завершает просроченный locked из БД и сохраняет объявленный сектор', () => proof(
  'R328 восстановление locked:', restartLocked, () => ([{
    file: 'gameWheel', from: "and(eq(gameRounds.state, 'locked'), lte(gameRounds.settleAt, now)),", to: "and(eq(gameRounds.state, 'locked'), sql`false`),",
  }]), 1,
));

async function tickSelection(edit?: Edit) {
  const f = await fixture(edit);
  tickGuard(f.sources.get('gameWheel')!);
  await success(f, 'a', 1, 10);
  await tick(f, 30_000);
  await tick(f, 36_000);
  await t.db.update(schema.serverEconomy).set({ gamesEnabled: false });
  const before = normal({ rounds: await rounds(), ledger: await ledger() });
  assert.deepEqual(await tick(f, 100_000), { locked: 0, settled: 0, cancelled: 0 }, 'R328 такт-страж: выключение не превращает settled в отмену');
  assert.deepEqual(normal({ rounds: await rounds(), ledger: await ledger() }), before);
  await drift();
}
test('R328 SQL такта ограничен live state и FOR UPDATE SKIP LOCKED; закрытое колесо не отменяется повторно', () => proof(
  'R328 такт-страж:', tickSelection, () => ([
    { file: 'gameWheel', from: ".for('update', { of: gameRounds, skipLocked: true });", to: ".for('update', { of: gameRounds });" },
    { file: 'gameWheel', from: "          inArray(gameRounds.state, [...LIVE]),\n          // ⚠️", to: '          // ⚠️' },
  ]), 2,
));

const forceCall = 'wheelForcedJackpot(natural, env.wheelForceJackpot, Number(eco?.cents ?? 0))';
test('R343 dev-флаг навязывает два последовательных срыва, помечает SQL/push/GET и не покупает уровни', () => proof(
  'R343 dev:', async edit => {
    // Natural-мисс задаётся только на границе случайного исхода; настоящий флаг/правила/SQL/выплаты не подменены.
    const f = await fixture(edit, false, true, true);
    await t.db.update(schema.serverEconomy).set({ wheelJackpotCents: 10003 });
    for (const start of [0, 46000]) {
      const id = await success(f, 'a', 1, 100, start);
      await tick(f, start + 30000); await tick(f, start + 36000);
      const row = (await rounds()).find(r => r.id === id)!;
      assert.equal(row.state, 'settled', 'R343 dev: раунд рассчитан');
      assert.equal(row.data.jackpotHit, true, 'R343 dev: флаг реально изменяет случайный промах');
      assert.equal(row.data.forced, true, 'R343 dev: навязанный срыв не прячется в SQL');
      assert.equal(resultEvents(f).at(-1)?.message.last.forced, true, 'R343 dev: push несёт предупреждение');
      assert.equal((await f.wheel.wheelSnapshot('s', 'a', at(start + 36000))).last?.forced, true, 'R343 dev: GET сохраняет предупреждение после восстановления');
      await drift();
    }
    assert.equal((await ledger('wheel.jackpot')).length, 2, 'R343 dev: режим не одноразовый');
    assert.equal((await t.db.select().from(schema.coinBalances)).every(w => w.earnedTotal === 17 && w.seasonEarned === 23), true,
      'R343 dev: джекпот не считается заработком');
  }, () => ([{ file: 'gameWheel', from: forceCall, to: forceCall.replace('env.wheelForceJackpot', 'false') },
    { file: 'gameWheel', from: '...(forced ? { forced: true } : {}),', to: '' }]), 2,
));
test('R343 без dev-флага естественный промах не срывает даже полный сундук', () => proof(
  'R343 no-dev:', async edit => {
    const f = await fixture(edit, false, false, true);
    await t.db.update(schema.serverEconomy).set({ wheelJackpotCents: 10003 });
    await success(f, 'a', 1, 100); await tick(f, 30000); await tick(f, 36000);
    const row = (await rounds())[0];
    assert.equal(row.data.jackpotHit, false, 'R343 no-dev: выключенный флаг не меняет исход');
    assert.equal(Object.hasOwn(row.data, 'forced'), false, 'R343 no-dev: обычный SQL без optional forced');
    assert.equal(Object.hasOwn(resultEvents(f)[0].message.last, 'forced'), false, 'R343 no-dev: старый DTO не получает false-поле');
    assert.equal((await ledger('wheel.jackpot')).length, 0, 'R343 no-dev: нет скрытой выплаты'); await drift();
  }, () => ([{ file: 'gameWheel', from: forceCall, to: forceCall.replace('env.wheelForceJackpot', 'true') }]), 1,
));
test('R343 естественный джекпот при включённом dev-флаге всё равно честный, без forced', () => proof(
  'R343 natural:', async edit => {
    const f = await fixture(edit, true, true);
    await t.db.update(schema.serverEconomy).set({ wheelJackpotCents: 10003 });
    await success(f, 'a', 1, 100); await tick(f, 30000); await tick(f, 36000);
    const row = (await rounds())[0];
    assert.equal(row.data.jackpotHit, true, 'R343 natural: естественный срыв выплачен');
    assert.equal(Object.hasOwn(row.data, 'forced'), false, 'R343 natural: естественный срыв не объявлен навязанным');
    assert.equal(Object.hasOwn(resultEvents(f)[0].message.last, 'forced'), false, 'R343 natural: push остаётся честным');
    assert.equal((await ledger('wheel.jackpot')).length, 1, 'R343 natural: деньги дошли'); await drift();
  }, () => ([{ file: 'gameWheel', from: forceCall, to: forceCall.replace('(natural,', '(false,') }]), 1,
));
test('R343 dev смотрит на настоящий сундук после взноса: 99 сотых мало, ровно100 достаточно', () => proof(
  'R343 cents:', async edit => {
    for (const centsAtSettlement of [99, 100]) {
      const f = await fixture(edit, false, true, true);
      // Ставка1 добавляет1 сотую: проверяется сумма, прочитанная под замком, не исходное значение до ставки.
      await t.db.update(schema.serverEconomy).set({ wheelJackpotCents: centsAtSettlement - 1 });
      await success(f, 'a', 1, 1); await tick(f, 30000); await tick(f, 36000);
      const data = (await rounds())[0].data;
      assert.equal(data.jackpotHit, centsAtSettlement === 100, 'R343 cents: обе стороны границы реального пула');
      assert.equal(Object.hasOwn(data, 'forced'), centsAtSettlement === 100, 'R343 cents: пометка только при навязанном срыве');
      assert.equal((await ledger('wheel.jackpot')).length, centsAtSettlement === 100 ? 1 : 0, 'R343 cents: монета не выдана из неполного сундука');
      await drift();
    }
  }, () => ([{ file: 'gameWheel', from: forceCall, to: forceCall.replace('Number(eco?.cents ?? 0)', 'Number(eco?.cents ?? 0) + 1') }]), 1,
));
