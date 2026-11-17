import { counterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { before, after, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import * as orm from 'drizzle-orm';
import * as zod from 'zod';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

// R335: lifecycle, HTTP и настоящее обезличивание в одном файле: общая БД и
// закрытый whole-module loader. Деньги, SQL, права состояния и presence не модели.
// PGlite односессионен: Promise.all не выдаём за доказательство PG-гонки;
// обязательный порядок awaited замков отдельно проверяется структурой AST.
type Edit = { file: string; from: string; to: string };
const T0 = Date.parse('2026-10-28T12:00:00Z');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const read = (file: string) => readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let t: TestDb;
before(async () => { t = await createTestDb(); await t.raw.exec("ALTER TABLE coin_ledger ALTER COLUMN created_at SET DEFAULT '2026-10-28T12:00:00Z'::timestamptz"); });
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });
async function fixture(edit?: Edit) {
  await truncateAll(t.raw);
  const people = ['creator', 'runner', 'a', 'b', 'c', 'owner', 'outsider'];
  await t.db.insert(schema.users).values(people.map(id => ({ id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true })));
  await t.db.insert(schema.servers).values({ id: 's', name: 'Синтетические события', ownerId: 'owner' });
  await t.db.insert(schema.serverMembers).values(people.filter(p => p !== 'outsider').map(userId => ({ serverId: 's', userId })));
  await t.db.insert(schema.channels).values({ id: 'v', serverId: 's', name: 'Голос', type: 'voice' });
  await t.db.insert(schema.serverEconomy).values({ serverId: 's', enabled: true, gamesEnabled: true, gamesBetMax: 1000, gamesDailyLossMax: 0, gamesFeePercent: 10, closedSeasonId: 'autumn-2026', gooseMinutes: 0 });
  await t.db.insert(schema.coinBalances).values(people.map(userId => ({ serverId: 's', userId, balance: 3000, earnedTotal: 0, seasonEarned: 0, seasonId: 'autumn-2026' })));
  await t.db.insert(schema.coinLedger).values(people.map(userId => ({ id: `fund-${userId}`, serverId: 's', userId, amount: 3000, reason: 'fixture' })));
  let clock = T0;
  let user = 'creator';
  const permissionOverrides = new Map<string, bigint>();
  let present = ['creator', 'a', 'b', 'c', 'owner'];
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const wires: any[] = [];
  const tasks: (() => void)[] = [];
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? clock : value instanceof Date ? value.getTime() : value); }
    static override now() { return clock; }
  }
  const noop = async () => {};
  const unexpected = () => { throw new Error('R335 setup: неожиданный внешний IO'); };
  const values: Record<string, any> = {
    'db/index': { db: t.db }, 'db/schema': schema, util: { id: crypto.randomUUID }, env: { env: { economyPreviewUsers: [] } },
    realtime: {
      publishToServer: async (serverId: string, message: unknown) => { wires.push({ serverId, message: normal(message) }); },
      publishToUser: noop,
      redisPub: { set: async () => 'OK', eval: async () => 1, pipeline() { const keys: string[] = []; return { get(key: string) { keys.push(key); return this; }, exec: async () => keys.map(() => [null, JSON.stringify(present.map(userId => ({ userId })))]) }; } },
    },
    auth: { requireAuth: async (req: { user: unknown }) => { req.user = { sub: user }; }, hashPassword: async () => 'synthetic-unusable', forgetTokenGeneration() {} },
    permissions: { getMemberContext: async (serverId: string, userId: string) => {
      const [member] = await t.db.select().from(schema.serverMembers).where(orm.and(orm.eq(schema.serverMembers.serverId, serverId), orm.eq(schema.serverMembers.userId, userId)));
      return member ? { serverPermissions: permissionOverrides.get(userId) ?? (userId === 'runner' ? shared.Permission.MANAGE_PREDICTIONS
        : userId === 'owner' ? shared.ALL_PERMISSIONS : userId === 'creator' ? shared.Permission.MANAGE_ECONOMY : 0n) } : null;
    } },
    audit: { writeAudit: noop }, shop: { shopFor: async () => [] }, purchase: { buyItem: unexpected },
    instanceSettings: { avatarPriceMinutes: unexpected, avatarRentalMaxDays: unexpected },
    storage: { putMedia: unexpected, storageConfigured: unexpected, removeUserAvatars: noop },
    activity: { clearActivity: noop }, attachments: { purgeDeletedOf: noop }, memberEvents: { memberChanged: noop },
    conversations: { deliverMany: noop, journalForwardedFrom: async () => [] }, 'bots/botLifecycle': { deleteBotsOwnedBy: noop },
    'federation/directoryEvents': { announceUser: noop }, 'federation/guestRevocation': { revokeAccountEverywhere: noop },
    gateway: { broadcastUserProfile: noop }, gifs: { savedGifKeysOf: async () => [], removeGifFiles: noop }, livekit: { removeFromOtherRooms: noop },
  };
  const files = new Set(['gamePredictions', 'gamePredictionRules', 'gameMoney', 'gameMoneyRules', 'coins', 'coinRules', 'streakRules', 'economyDefaults',
    'gameWheel', 'gameWheelRules', 'routes/gamePredictions', 'routes/economy', 'seasons', 'gooseRules', 'voiceActivityRules', 'levelRules', 'shopRules', 'accountDelete', 'accountRows', 'accountRules']);
  const cache = new Map<string, any>();
  const sources = new Map<string, string>();
  function load<T>(file: string): T {
    if (Object.hasOwn(values, file)) return values[file] as T;
    if (cache.has(file)) return cache.get(file) as T;
    assert.ok(files.has(file), `R335 setup: закрытый импорт ${file}`);
    let source = read(file);
    if (edit?.file === file) { assert.equal(source.split(edit.from).length, 2, 'R335 setup: уникальный якорь целого модуля'); source = source.replace(edit.from, edit.to); }
    sources.set(file, source);
    const module = { exports: {} }; cache.set(file, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer, Error, setTimeout: (fn: () => void) => { tasks.push(fn); return { unref() {} }; },
      setInterval: unexpected, console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')), error: (...args: unknown[]) => warnings.push(args.join(' ')) },
      require(id: string) {
        if (id === '@gusvoice/shared') return shared;
        if (id === 'drizzle-orm') return orm;
        if (id === 'node:crypto') return crypto;
        if (id === 'zod') return zod;
        assert.ok(id.startsWith('.'), `R335 setup: внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(file), id)).replace(/\.js$/, ''));
      },
    }); return module.exports as T;
  }
  const p = load<typeof import('../src/gamePredictions.js')>('gamePredictions');
  const m = load<typeof import('../src/gameMoney.js')>('gameMoney');
  const rules = load<typeof import('../src/gamePredictionRules.js')>('gamePredictionRules');
  async function app() {
    const instance = Fastify();
    instance.setErrorHandler((error, _req, reply) => { errors.push(error); void reply.status(500).send({ error: 'unexpected fixture error' }); });
    await instance.register(load<typeof import('../src/routes/gamePredictions.js')>('routes/gamePredictions').gamePredictionRoutes);
    await instance.register(load<typeof import('../src/routes/economy.js')>('routes/economy').economyRoutes);
    await instance.ready(); return instance;
  }
  return { p, m, rules, load, sources, warnings, errors, wires, tasks, app, permissions(id: string, perms: bigint) { permissionOverrides.set(id, perms); }, as(id: string) { user = id; }, present(ids: string[]) { present = ids; }, clock(ms: number) { clock = T0 + ms; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function event(f: Fixture, lockInSec: number | null = null, createdBy = 'creator', questions = 2) {
  const draft = f.rules.validatePredictionDraft({ title: 'Шоу', lockInSec, questions: Array.from({ length: questions }, (_, i) => ({ question: `Вопрос ${i}`, options: ['Да', 'Нет'] })) });
  assert.ok(draft.ok, 'R335 setup: валидный редактор');
  const result = await f.p.createPrediction('s', createdBy, draft.draft);
  assert.ok(result.ok && result.event, 'R335 setup: реальное событие создано'); return result.event;
}
const bet = (f: Fixture, ev: shared.PredictionEventDto, userId: string, index: number, optionId: string, amount: number) => f.p.placePredictionBet({ serverId: 's', eventId: ev.id, questionId: ev.questions[index].id, optionId, amount, userId });
const balances = async () => Object.fromEntries((await t.db.select().from(schema.coinBalances)).map(w => [w.userId, w.balance]));
async function money(prefix: string, escrow: number | null = 0) {
  const drift = await t.raw.query(`SELECT b.user_id FROM coin_balances b LEFT JOIN coin_ledger l USING(server_id,user_id) GROUP BY b.server_id,b.user_id,b.balance HAVING b.balance <> COALESCE(SUM(l.amount),0)::int`);
  assert.deepEqual(drift.rows, [], `${prefix} drift=0`);
  if (escrow !== null) { const result = await t.raw.query<{ n: number }>(`SELECT COALESCE(SUM(amount),0)::int n FROM game_stakes WHERE paid_at IS NULL AND refunded_at IS NULL`); assert.equal(result.rows[0].n, escrow, `${prefix} живой эскроу`); }
}
async function proof(prefix: string, run: (edit?: Edit) => Promise<void>, edits: Edit[]) {
  await run();
  for (const edit of edits) { await counterfact(async () => {
    const old = read(edit.file); await assert.rejects(run(edit), error => error instanceof assert.AssertionError && error.message.startsWith(prefix)); assert.equal(read(edit.file), old, 'R335 setup: production не записывался');
  }); await run(); }
}
const creatorEdit: Edit = { file: 'gamePredictions', from: "if (ev.createdBy === i.userId) throw new PredictionRefused('creator');", to: '' };
const outsiderEdit: Edit = { file: 'gamePredictions', from: "if (ev.createdBy !== userId) throw new PredictionRefused('not_creator');", to: '' };
test('событие: создатель не ставит, одна ставка на вопрос, после закрытия ставок нет', async () => proof('R335 запреты:', async edit => {
  const f = await fixture(edit); const ev = await event(f);
  assert.deepEqual(normal(await bet(f, ev, 'creator', 0, 'o1', 10)), { ok: false, code: 'creator' }, 'R335 запреты: создатель не ставит');
  assert.ok((await bet(f, ev, 'a', 0, 'o1', 100)).ok);
  assert.deepEqual(normal(await bet(f, ev, 'a', 0, 'o2', 100)), { ok: false, code: 'already_bet' });
  assert.deepEqual(normal(await bet(f, ev, 'a', 0, 'o1', 100)), { ok: false, code: 'duplicate' });
  assert.ok((await bet(f, ev, 'a', 1, 'o2', 50)).ok);
  assert.deepEqual(normal(await f.p.closePrediction('s', ev.id, 'b', false)), { ok: false, code: 'forbidden' });
  assert.ok((await f.p.closePrediction('s', ev.id, 'creator', false)).ok);
  assert.deepEqual(normal(await bet(f, ev, 'b', 0, 'o1', 10)), { ok: false, code: 'not_open' });
  await money('R335 запреты:', 150);
}, [creatorEdit]));
test('итог: только создатель; 950→995, не состоялся→возврат, повтор не меняет деньги', async () => proof('R335 расчёт:', async edit => {
  const f = await fixture(edit); const ev = await event(f);
  assert.ok((await bet(f, ev, 'a', 0, 'o1', 950)).ok); assert.ok((await bet(f, ev, 'b', 0, 'o2', 50)).ok);
  assert.ok((await bet(f, ev, 'a', 1, 'o1', 100)).ok); assert.ok((await bet(f, ev, 'c', 1, 'o2', 100)).ok);
  assert.deepEqual(normal(await f.p.settlePrediction('s', ev.id, 'creator', {})), { ok: false, code: 'not_locked' });
  await f.p.closePrediction('s', ev.id, 'creator', false);
  const winners = { [ev.questions[0].id]: 'o1', [ev.questions[1].id]: null };
  const before = await balances();
  assert.deepEqual(normal(await f.p.settlePrediction('s', ev.id, 'owner', winners)), { ok: false, code: 'not_creator' }, 'R335 расчёт: даже владелец не назначает исход');
  assert.deepEqual(normal(await f.p.settlePrediction('s', ev.id, 'creator', {})), { ok: false, code: 'bad_winners' });
  const result = await f.p.settlePrediction('s', ev.id, 'creator', winners);
  assert.ok(result.ok && result.event, 'R335 расчёт: итог принят');
  const after = await balances(); assert.equal(after.a - before.a, 1095, 'R335 расчёт: паримутюэль, не splitPot'); assert.equal(after.c - before.c, 100);
  assert.equal(result.event.questions[0].fee, 5); assert.equal(result.event.questions[1].void, true);
  const ledger = normal(await t.db.select().from(schema.coinLedger));
  assert.deepEqual(normal(await f.p.settlePrediction('s', ev.id, 'creator', winners)), { ok: false, code: 'finished' });
  assert.deepEqual(await balances(), after); assert.deepEqual(normal(await t.db.select().from(schema.coinLedger)), ledger);
  assert.ok((await t.db.select().from(schema.coinBalances)).every(w => w.earnedTotal === 0 && w.seasonEarned === 0));
  await money('R335 расчёт:');
}, [outsiderEdit, { file: 'gamePredictionRules', from: 'const split = splitParimutuel(', to: "const split = require('./gameMoneyRules.js').splitPot(" }]));
test('таймер закрывает ровно в срок, спустя семь суток автоотмена возвращает эскроу', async () => proof('R335 tick:', async edit => {
  const f = await fixture(edit); const ev = await event(f, 30);
  await bet(f, ev, 'a', 0, 'o1', 100);
  f.clock(29999); assert.equal((await f.p.runPredictionTick(new Date(T0 + 29999))).steps, 0);
  f.clock(30000); assert.deepEqual(normal(await bet(f, ev, 'b', 0, 'o1', 10)), { ok: false, code: 'not_open' });
  assert.equal((await f.p.runPredictionTick(new Date(T0 + 30000))).steps, 1, 'R335 tick: точный срок закрытия');
  const [locked] = await t.db.select().from(schema.predictionEvents); assert.equal(locked.state, 'locked');
  f.clock(30000 + 604800000 - 1); assert.equal((await f.p.runPredictionTick(new Date(T0 + 30000 + 604800000 - 1))).steps, 0);
  f.clock(30000 + 604800000); await f.p.runPredictionTick(new Date(T0 + 30000 + 604800000));
  const [cancelled] = await t.db.select().from(schema.predictionEvents); assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.cancelReason, 'expired'); assert.equal((await balances()).a, 3000); await money('R335 tick:');
}, [{ file: 'gamePredictions', from: "and(eq(predictionEvents.state, 'open'), lte(predictionEvents.lockAt, now))", to: "and(eq(predictionEvents.state, 'open'), lte(predictionEvents.lockAt, new Date(now.getTime() - 1)))" }]));
test('три живых разрешены, четвёртое запрещено; отмена создателем и модератором освобождает место', async () => proof('R335 предел:', async edit => {
  const f = await fixture(edit); const first = await event(f); const second = await event(f); await event(f);
  const d = f.rules.validatePredictionDraft({ title: 'x', questions: [{ question: 'q', options: ['a', 'b'] }] }); assert.ok(d.ok);
  assert.deepEqual(normal(await f.p.createPrediction('s', 'creator', d.draft)), { ok: false, code: 'too_many' }, 'R335 предел: четвёртое не проходит');
  await bet(f, first, 'a', 0, 'o1', 40);
  assert.deepEqual(normal(await f.p.cancelPrediction('s', first.id, 'b', false)), { ok: false, code: 'forbidden' });
  const cancelled = await f.p.cancelPrediction('s', first.id, 'owner', true); assert.ok(cancelled.ok && cancelled.event); assert.equal(cancelled.event.cancelReason, 'moderator');
  const own = await f.p.cancelPrediction('s', second.id, 'creator', false); assert.ok(own.ok && own.event); assert.equal(own.event.cancelReason, 'creator');
  assert.deepEqual(normal(await f.p.cancelPrediction('s', first.id, 'creator', false)), { ok: false, code: 'finished' });
  await event(f); assert.equal((await balances()).a, 3000); await money('R335 предел:');
}, [{ file: 'gamePredictions', from: '>= PREDICTION_MAX_LIVE', to: '> PREDICTION_MAX_LIVE' }]));
test('повтор выплаты нулевой проигравшей ставки не проходит условный UPDATE', async () => proof('R335 paidAt:', async edit => {
  const f = await fixture(edit); const ev = await event(f); await bet(f, ev, 'a', 0, 'o1', 10);
  const key = { roundId: ev.questions[0].id, userId: 'a', pick: 'o1', payout: 0 };
  const once = await f.m.withGameMoney(m => m.payStake(key)); assert.ok(once, 'R335 setup: первая реальная выплата');
  // payout=0 намеренно: UNIQUE журнала не должен маскировать удалённый guard SQL-ошибкой.
  const again = await f.m.withGameMoney(m => m.payStake(key)); assert.equal(again, null, 'R335 paidAt: повтор не затрагивает строку'); await money('R335 paidAt:');
}, [{ file: 'gameMoney', from: '.set({ paidAt: new Date(), payout: i.payout })\n    .where(and(stakeWhere(i), isNull(gameStakes.paidAt), isNull(gameStakes.refundedAt)))', to: '.set({ paidAt: new Date(), payout: i.payout })\n    .where(and(stakeWhere(i), isNull(gameStakes.refundedAt)))' }]));
test('PG-конкуренция: awaited кошелёк перед чтением моей ставки; событие и вопросы запираются раньше', async () => proof('R335 замки:', async edit => {
  const f = await fixture(edit); const source = f.sources.get('gamePredictions')!;
  const ast = ts.createSourceFile('gamePredictions.ts', source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'placePredictionBet'); assert.ok(fn?.body, 'R335 setup: целая функция ставки');
  const calls: ts.CallExpression[] = []; const visit = (n: ts.Node) => { if (ts.isCallExpression(n)) calls.push(n); ts.forEachChild(n, visit); }; visit(fn.body);
  const wallet = calls.find(n => n.expression.getText(ast) === 'm.lockWallets');
  const fromMine = calls.find(n => n.expression.getText(ast).endsWith('.from') && n.arguments[0]?.getText(ast) === 'gameStakes');
  const eventLock = calls.find(n => n.expression.getText(ast) === 'eventRow' && n.arguments[3]?.getText(ast) === "'share'");
  const share = calls.find(n => n.expression.getText(ast).endsWith('.for') && n.arguments[0]?.getText(ast) === "'share'");
  assert.ok(wallet && fromMine && eventLock && share && ts.isAwaitExpression(wallet.parent) && eventLock.pos < share.pos && share.pos < wallet.pos && wallet.pos < fromMine.pos, 'R335 замки: событие→вопрос→await кошелёк→моя ставка');
  const create = ast.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'createPrediction'); assert.ok(create?.body);
  assert.ok(create.body.getText(ast).indexOf('pg_advisory_xact_lock') < create.body.getText(ast).indexOf('count(*)'), 'R335 замки: серверный advisory lock перед пределом трёх');
}, [{ file: 'gamePredictions', from: 'await m.lockWallets(i.serverId, [i.userId]);', to: 'void 0;' }]));
for (const mode of ['patch', 'tick'] as const) test(`выключение игр через ${mode}: отменяет событие и вопросы с возвратом`, async () => proof(`R335 off ${mode}:`, async edit => {
  const f = await fixture(edit); const ev = await event(f); await bet(f, ev, 'a', 0, 'o1', 100);
  if (mode === 'patch') { const app = await f.app(); try { f.as('owner'); const response = await app.inject({ method: 'PATCH', url: '/servers/s/economy', payload: { gamesEnabled: false } }); assert.equal(response.statusCode, 200, 'R335 setup: PATCH не 500'); assert.deepEqual(f.errors, [], 'R335 setup: маршрут не спрятал исключение'); } finally { await app.close(); } }
  else { await t.db.update(schema.serverEconomy).set({ gamesEnabled: false }); await f.p.runPredictionTick(new Date(T0)); }
  const [row] = await t.db.select().from(schema.predictionEvents); assert.equal(row.state, 'cancelled', `R335 off ${mode}: событие не остаётся живым`); assert.equal(row.cancelReason, 'games-off');
  assert.ok((await t.db.select().from(schema.gameRounds)).every(r => r.state === 'cancelled')); assert.equal((await balances()).a, 3000); await money(`R335 off ${mode}:`);
}, [mode === 'patch' ? { file: 'gameMoney', from: 'if (eventIds.length > 0) {', to: 'if (false && eventIds.length > 0) {' } : { file: 'gamePredictions', from: 'eq(serverEconomy.gamesEnabled, false),', to: 'eq(serverEconomy.gamesEnabled, true),' }]));
for (const deleted of ['b', 'creator'] as const) test(`удаление ${deleted === 'b' ? 'поставившего' : 'создателя'}: реальные accountRows, возвраты и история`, async () => proof(`R335 удаление ${deleted}:`, async edit => {
  const f = await fixture(edit); const ev = await event(f); await bet(f, ev, 'a', 0, 'o1', 200); await bet(f, ev, 'b', 0, 'o2', 300); await bet(f, ev, 'c', 0, 'o2', 100);
  await f.load<typeof import('../src/accountDelete.js')>('accountDelete').anonymizeAccount(deleted);
  const [user] = await t.db.select().from(schema.users).where(orm.eq(schema.users.id, deleted)); assert.ok(user.deletedAt); assert.equal(user.tokenGeneration, 1);
  const [row] = await t.db.select().from(schema.predictionEvents); const stakes = await t.db.select().from(schema.gameStakes);
  if (deleted === 'creator') { assert.equal(row.state, 'cancelled', 'R335 удаление creator: событие отменено до стирания кошелька'); assert.equal(row.cancelReason, 'creator-deleted'); assert.ok(stakes.every(s => s.refundedAt !== null)); assert.equal((await balances()).a, 3000); }
  else { assert.equal(row.state, 'open'); assert.ok(stakes.find(s => s.userId === 'b')?.refundedAt, 'R335 удаление b: ставка возвращена'); await f.p.closePrediction('s', ev.id, 'creator', false); const before = await balances(); const result = await f.p.settlePrediction('s', ev.id, 'creator', { [ev.questions[0].id]: 'o1', [ev.questions[1].id]: null }); assert.ok(result.ok); assert.equal((await balances()).a - before.a, 290, 'R335 удаление b: банк только живых ставок'); }
  assert.equal((await balances())[deleted], undefined); assert.equal(stakes.length, 3); assert.deepEqual(f.warnings, [], 'R335 setup: уборка аккаунта не спрятала исключение'); await money(`R335 удаление ${deleted}:`);
}, [deleted === 'creator' ? { file: 'accountDelete', from: 'predictions = await cancelPredictionsOf(tx, userId);', to: 'predictions = [];' } : { file: 'accountDelete', from: 'await refundOpenStakesOf(tx, userId);', to: '' }]));
test('HTTP: права, голос, поля редактора, mine и итог проверяются настоящими маршрутами', async () => proof('R335 HTTP:', async edit => {
  const f = await fixture(edit); const app = await f.app();
  const call = async (as: string, method: 'GET' | 'POST', path: string, payload?: any) => { f.as(as); const response = await app.inject({ method, url: `/servers/s/predictions${path}`, payload }); assert.notEqual(response.statusCode, 500, 'R335 setup: 500 не является отказом'); assert.deepEqual(f.errors, [], 'R335 setup: handler errors'); return { status: response.statusCode, body: response.json() }; };
  try {
    const d = { title: 'Шоу', questions: [{ question: 'q', options: ['Да', 'Нет'] }] };
    assert.equal((await call('outsider', 'GET', '')).status, 404);
    const forbidden = await call('a', 'POST', '', d); assert.equal(forbidden.status, 403, 'R335 HTTP: создать может управляющий'); assert.equal(forbidden.body.reason, 'forbidden');
    const invalid = await call('creator', 'POST', '', { ...d, title: '' }); assert.equal(invalid.status, 400); assert.equal(invalid.body.field, 'title');
    const created = await call('creator', 'POST', '', d); assert.equal(created.status, 200); const ev = created.body.event;
    f.present([]); const absent = await call('a', 'POST', `/${ev.id}/bets`, { questionId: ev.questions[0].id, optionId: 'o1', amount: 10 }); assert.equal(absent.status, 403); assert.equal(absent.body.reason, 'not_in_voice');
    f.present(['a', 'b', 'creator']); const accepted = await call('a', 'POST', `/${ev.id}/bets`, { questionId: ev.questions[0].id, optionId: 'o1', amount: 10 }); assert.equal(accepted.status, 200); assert.equal(accepted.body.event.questions[0].mine.amount, 10);
    assert.equal((await call('b', 'POST', `/${ev.id}/close`)).status, 403); assert.equal((await call('creator', 'POST', `/${ev.id}/close`)).status, 200);
    assert.equal((await call('owner', 'POST', `/${ev.id}/settle`, { winners: { [ev.questions[0].id]: null } })).status, 403);
    assert.equal((await call('creator', 'POST', `/${ev.id}/settle`, { winners: { [ev.questions[0].id]: null } })).status, 200); await money('R335 HTTP:');
  } finally { await app.close(); }
}, [{ file: 'routes/gamePredictions', from: "if (!canRunPredictions(ctx.serverPermissions)) return answer(reply, { ok: false, code: 'forbidden' });", to: '' }]));

const httpDraft = { title: 'Шоу нового ведущего', questions: [{ question: 'Кто?', options: ['Гусь', 'Пират'] }] };
async function http(f: Fixture, check: (call: (as: string, method: 'GET' | 'POST', path: string, payload?: any) => Promise<{ status: number; body: any }>) => Promise<void>, escrow = 0) {
  const app = await f.app();
  try {
    await check(async (as, method, path, payload) => {
      f.as(as);
      const response = await app.inject({ method, url: `/servers/s/predictions${path}`, payload });
      assert.notEqual(response.statusCode, 500, 'R343 setup predictions: 500 не является отказом');
      assert.deepEqual(f.errors, [], 'R343 setup predictions: маршрут не спрятал исключение');
      return { status: response.statusCode, body: response.json() };
    });
    assert.deepEqual(f.warnings, [], 'R343 setup predictions: внешний IO не падал');
    await money('R343 setup predictions:', escrow);
  } finally { await app.close(); }
}

test('R343 HTTP: только «Проводить ставки» разрешает создание; участник без права получает 403', async () => proof('R343 создание:', async edit => {
  const f = await fixture(edit);
  await http(f, async call => {
    const denied = await call('a', 'POST', '', httpDraft);
    assert.equal(denied.status, 403, 'R343 создание: без права запрещено');
    assert.equal(denied.body.reason, 'forbidden', 'R343 создание: причина отказа');
    assert.equal((await t.db.select().from(schema.predictionEvents)).length, 0, 'R343 создание: отказ не пишет событие');
    const made = await call('runner', 'POST', '', httpDraft);
    assert.equal(made.status, 200, 'R343 создание: MANAGE_PREDICTIONS достаточно без MANAGE_ECONOMY');
    const [row] = await t.db.select().from(schema.predictionEvents);
    assert.equal(row.createdBy, 'runner', 'R343 создание: создатель записан настоящим маршрутом');
  });
}, [
  { file: 'routes/gamePredictions', from: "if (!canRunPredictions(ctx.serverPermissions)) return answer(reply, { ok: false, code: 'forbidden' });", to: '' },
  { file: 'routes/gamePredictions', from: "if (!canRunPredictions(ctx.serverPermissions)) return answer(reply, { ok: false, code: 'forbidden' });",
    to: `if (!(ctx.serverPermissions & ${shared.Permission.MANAGE_ECONOMY}n)) return answer(reply, { ok: false, code: 'forbidden' });` },
]));

test('R343 HTTP: canManage виден ведущему с одним MANAGE_PREDICTIONS, но не обычному участнику', async () => proof('R343 canManage:', async edit => {
  const f = await fixture(edit);
  await http(f, async call => {
    const runner = await call('runner', 'GET', ''); const member = await call('a', 'GET', '');
    assert.equal(runner.status, 200, 'R343 canManage: снимок ведущего доступен');
    assert.equal(runner.body.canManage, true, 'R343 canManage: новое право приходит в снимке');
    assert.equal(member.body.canManage, false, 'R343 canManage: участник не получает управление');
  });
}, [{ file: 'routes/gamePredictions', from: 'predictionSnapshot(serverId, req.user!.sub, canRunPredictions(ctx.serverPermissions))',
  to: 'predictionSnapshot(serverId, req.user!.sub, false)' }]));

// Ручное закрытие — авторство, а не право управления; проверяем реальный HTTP → транзакция → SQL.
async function closeState(f: Fixture) {
  return normal({ events: await t.db.select().from(schema.predictionEvents), rounds: await t.db.select().from(schema.gameRounds),
    stakes: await t.db.select().from(schema.gameStakes), wallets: await t.db.select().from(schema.coinBalances),
    ledger: await t.db.select().from(schema.coinLedger), wires: f.wires, scheduledPushes: f.tasks.length });
}

test('HTTP: чужой приём защищён от участника, обоих управляющих и владельца без изменения ставок, денег и рассылок', async () => {
  const f = await fixture(); const ev = await event(f);
  assert.ok((await bet(f, ev, 'a', 0, 'o1', 100)).ok);
  f.permissions('b', shared.Permission.MANAGE_ECONOMY);
  const before = await closeState(f);
  await http(f, async call => {
    for (const actor of ['a', 'runner', 'b', 'owner']) {
      const denied = await call(actor, 'POST', `/${ev.id}/close`);
      assert.equal(denied.status, 403, actor);
      assert.equal(denied.body.reason, 'forbidden', actor);
      assert.equal(denied.body.error, 'forbidden', actor);
      assert.equal(denied.body.message, 'Закрыть приём может только создатель события', actor);
      assert.deepEqual(await closeState(f), before, actor);
    }
  }, 100);
  // Прямой внутренний вызов тоже не получает обхода от legacy canManage=true.
  assert.deepEqual(normal(await f.p.closePrediction('s', ev.id, 'owner', true)), { ok: false, code: 'forbidden' });
  assert.deepEqual(await closeState(f), before);
});

test('HTTP: создатель закрывает приём после потери всех прав управления', async () => {
  const f = await fixture();
  await http(f, async call => {
    const made = await call('creator', 'POST', '', httpDraft);
    assert.equal(made.status, 200);
    const ev = made.body.event;
    assert.ok((await bet(f, ev, 'a', 0, 'o1', 100)).ok);
    f.permissions('creator', 0n);
    assert.equal((await call('creator', 'GET', '')).body.canManage, false);
    const before = await closeState(f);
    const accepted = await call('creator', 'POST', `/${ev.id}/close`);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.event.state, 'locked');
    const after = await closeState(f);
    assert.ok(after.events.every(e => e.state === 'locked' && e.lockedAt !== null));
    assert.ok(after.rounds.every(r => r.state === 'locked'));
    assert.deepEqual(after.stakes, before.stakes);
    assert.deepEqual(after.wallets, before.wallets);
    assert.deepEqual(after.ledger, before.ledger);
    const repeated = await call('creator', 'POST', `/${ev.id}/close`);
    assert.equal(repeated.status, 409);
    assert.equal(repeated.body.reason, 'not_open');
  }, 100);
});

test('HTTP: без автора никто не закрывает вручную, но таймер закрывает событие и вопросы точно в срок', async () => {
  const f = await fixture(); const ev = await event(f, 30);
  assert.ok((await bet(f, ev, 'a', 0, 'o1', 100)).ok);
  await t.db.update(schema.predictionEvents).set({ createdBy: null }).where(orm.eq(schema.predictionEvents.id, ev.id));
  const before = await closeState(f);
  await http(f, async call => {
    for (const actor of ['creator', 'a', 'runner', 'owner']) {
      const denied = await call(actor, 'POST', `/${ev.id}/close`);
      assert.equal(denied.status, 403, actor);
      assert.equal(denied.body.reason, 'forbidden', actor);
      assert.deepEqual(await closeState(f), before, actor);
    }
  }, 100);
  assert.equal((await f.p.runPredictionTick(new Date(T0 + 29999))).steps, 0);
  assert.equal((await f.p.runPredictionTick(new Date(T0 + 30000))).steps, 1);
  const after = await closeState(f);
  assert.ok(after.events.every(e => e.state === 'locked'));
  assert.ok(after.rounds.every(r => r.state === 'locked'));
  assert.deepEqual(after.stakes, before.stakes);
  assert.deepEqual(after.wallets, before.wallets);
  assert.deepEqual(after.ledger, before.ledger);
});

test('HTTP: модератор по-прежнему отменяет чужое событие с возвратом всех ставок', async () => {
  const f = await fixture(); const ev = await event(f);
  assert.ok((await bet(f, ev, 'a', 0, 'o1', 100)).ok);
  assert.equal((await balances()).a, 2900);
  await http(f, async call => {
    const denied = await call('a', 'POST', `/${ev.id}/cancel`);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, 'forbidden');
    const accepted = await call('runner', 'POST', `/${ev.id}/cancel`);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.event.state, 'cancelled');
    assert.equal(accepted.body.event.cancelReason, 'moderator');
    assert.equal((await balances()).a, 3000);
    const [stake] = await t.db.select().from(schema.gameStakes);
    assert.ok(stake.refundedAt);
    assert.equal(stake.paidAt, null);
  });
});

test('R343 HTTP: право ведущего не даёт подвести чужой итог; собственный итог создателя принят', async () => proof('R343 not_creator:', async edit => {
  const f = await fixture(edit);
  await http(f, async call => {
    const made = await call('creator', 'POST', '', httpDraft);
    assert.equal(made.status, 200, 'R343 setup predictions: событие создано HTTP');
    const ev = made.body.event;
    assert.equal((await call('creator', 'POST', `/${ev.id}/close`)).status, 200, 'R343 setup predictions: создатель закрыл приём');
    const payload = { winners: { [ev.questions[0].id]: null } };
    const before = await closeState(f);
    for (const actor of ['runner', 'owner']) {
      const denied = await call(actor, 'POST', `/${ev.id}/settle`, payload);
      assert.equal(denied.status, 403, 'R343 not_creator: управление и владение не назначают чужой исход');
      assert.equal(denied.body.reason, 'not_creator', 'R343 not_creator: точная причина отказа');
      assert.deepEqual(await closeState(f), before);
    }
    assert.equal((await call('creator', 'POST', `/${ev.id}/settle`, payload)).status, 200, 'R343 not_creator: создатель назначает исход');
    const [row] = await t.db.select().from(schema.predictionEvents);
    assert.equal(row.state, 'settled', 'R343 not_creator: собственный итог записан');
  });
}, [outsiderEdit]));
