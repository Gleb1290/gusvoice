import { counterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import * as orm from 'drizzle-orm';
import * as zod from 'zod';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

// R339 остаток: настоящие migration/PGlite, выборки gameTitlesData, заморозка,
// seasons hooks и HTTP inject. Общие сценарии и маршруты намеренно в одном файле.
type Edit = { file: string; from: string; to: string };
const NOW = new Date('2026-11-02T12:00:00Z');
const OCT = { from: new Date('2026-09-30T21:00:00Z'), to: new Date('2026-10-31T21:00:00Z') };
const FIRST = new Date('2026-10-10T12:00:00Z');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const read = (file: string) => readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let t: TestDb;
before(async () => {
  t = await createTestDb();
  // SQL DEFAULT now() живёт вне VM-часов. Корону ниже проверяем в сезоне
  // выдачи (декабрь), поэтому фиксируем и её реальный DB timestamp.
  await t.raw.exec("ALTER TABLE season_results ALTER COLUMN frozen_at SET DEFAULT '2026-12-01T12:00:00Z'::timestamptz");
});
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });
async function fixture(edit?: Edit, seed = true) {
  await truncateAll(t.raw);
  const people = ['owner', 'a', 'b', 'games-out', 'economy-out', 'bot', 'outsider'];
  await t.db.insert(schema.users).values(people.map(id => ({ id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true, bot: id === 'bot' })));
  await t.db.insert(schema.servers).values({ id: 's', name: 'Синтетический месяц', ownerId: 'owner' });
  await t.db.insert(schema.serverMembers).values(people.filter(id => id !== 'outsider').map(userId => ({ serverId: 's', userId })));
  await t.db.insert(schema.serverEconomy).values({ serverId: 's', enabled: true, gamesEnabled: true, closedGameMonthId: 'm2026-10', closedSeasonId: 'autumn-2026' });
  await t.db.insert(schema.coinBalances).values(people.map(userId => ({ serverId: 's', userId, balance: 1000, optedOut: userId === 'economy-out', gamesOptOut: userId === 'games-out', seasonId: 'autumn-2026' })));
  await t.db.insert(schema.coinLedger).values(people.map(userId => ({ id: `fund-${userId}`, serverId: 's', userId, amount: 1000, reason: 'fixture', createdAt: new Date('2026-09-25T12:00:00Z') })));
  if (seed) {
    await t.db.insert(schema.gameRounds).values({ id: 'wheel-oct', serverId: 's', kind: 'wheel', state: 'settled', createdBy: 'owner', createdAt: FIRST, lockAt: new Date(FIRST.getTime() + 30000), settledAt: new Date(FIRST.getTime() + 36000), data: { fee: 1 } });
    for (const [userId, amount, payout] of [['a', 10, 20], ['b', 10, 0], ['games-out', 50, 100], ['economy-out', 50, 100], ['bot', 50, 100]] as const) {
      await t.db.insert(schema.gameStakes).values({ serverId: 's', roundId: 'wheel-oct', userId, pick: '20', amount, payout, paidAt: new Date(FIRST.getTime() + 36000), createdAt: new Date(FIRST.getTime() + 1000) });
      await t.db.insert(schema.coinLedger).values({ id: `bet-${userId}`, serverId: 's', userId, amount: -amount, reason: 'wheel.bet', createdAt: FIRST, data: { roundId: 'wheel-oct', pick: '20' } });
      if (payout) await t.db.insert(schema.coinLedger).values({ id: `win-${userId}`, serverId: 's', userId, amount: payout, reason: 'wheel.win', createdAt: new Date(FIRST.getTime() + 36000), data: { roundId: 'wheel-oct', pick: '20' } });
    }
    for (const userId of ['a', 'b']) await t.db.insert(schema.coinLedger).values({ id: `jackpot-${userId}`, serverId: 's', userId, amount: 100, reason: 'wheel.jackpot', createdAt: new Date(FIRST.getTime() + 36000), data: { roundId: 'wheel-oct', pick: 'jackpot' } });
    for (const [userId, amount] of [['a', 500], ['b', 100]] as const) await t.db.insert(schema.coinLedger).values({ id: `voice-${userId}`, serverId: 's', userId, amount, reason: 'voice', createdAt: new Date('2026-10-15T12:00:00Z') });
    await t.raw.exec(`UPDATE coin_balances b SET balance=(SELECT SUM(l.amount)::int FROM coin_ledger l WHERE l.server_id=b.server_id AND l.user_id=b.user_id)`);
  }
  const warnings: string[] = []; const errors: unknown[] = []; const sources = new Map<string, string>(); let user = 'a';
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? NOW.getTime() : value instanceof Date ? value.getTime() : value); }
    static override now() { return NOW.getTime(); }
  }
  const values: Record<string, any> = {
    'db/index': { db: t.db }, 'db/schema': schema, util: { id: crypto.randomUUID }, env: { env: { economyPreviewUsers: [] } },
    realtime: { publishToUser: async () => {} },
    auth: { requireAuth: async (req: { user: unknown }) => { req.user = { sub: user }; } },
    permissions: { getMemberContext: async (serverId: string, userId: string) => {
      const [member] = await t.db.select().from(schema.serverMembers).where(orm.and(orm.eq(schema.serverMembers.serverId, serverId), orm.eq(schema.serverMembers.userId, userId)));
      return member ? { serverPermissions: userId === 'owner' ? shared.Permission.MANAGE_ECONOMY : 0n } : null;
    } },
  };
  const files = new Set(['gameMonths', 'gameTitlesRules', 'gameTitlesData', 'gameMoneyRules', 'coinRules', 'coins', 'streakRules', 'seasons', 'routes/gameBoard']);
  const cache = new Map<string, any>();
  function load<T>(file: string): T {
    if (Object.hasOwn(values, file)) return values[file] as T;
    if (cache.has(file)) return cache.get(file) as T;
    assert.ok(files.has(file), `R339 setup: закрытый импорт ${file}`);
    let source = read(file);
    if (edit?.file === file) { assert.equal(source.split(edit.from).length, 2, 'R339 setup: уникальный якорь целого модуля'); source = source.replace(edit.from, edit.to); }
    sources.set(file, source); const module = { exports: {} }; cache.set(file, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer, Error,
      console: { error: (...args: unknown[]) => warnings.push(args.map(String).join(' ')), warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')) },
      require(id: string) { if (id === '@gusvoice/shared') return shared; if (id === 'drizzle-orm') return orm; if (id === 'zod') return zod; assert.ok(id.startsWith('.'), `R339 setup: внешний импорт ${id}`); return load(posix.normalize(posix.join(posix.dirname(file), id)).replace(/\.js$/, '')); },
    }); return module.exports as T;
  }
  const months = load<typeof import('../src/gameMonths.js')>('gameMonths'); const seasons = load<typeof import('../src/seasons.js')>('seasons');
  async function app() {
    const a = Fastify(); a.setErrorHandler((err, _req, reply) => { errors.push(err); void reply.status(500).send({ error: 'unexpected fixture exception' }); });
    await a.register(load<typeof import('../src/routes/gameBoard.js')>('routes/gameBoard').gameBoardRoutes); await a.ready(); return a;
  }
  return { months, seasons, load, sources, warnings, errors, app, as(id: string) { user = id; } };
}
async function proof(prefix: string, run: (edit?: Edit) => Promise<void>, edits: Edit[]) {
  await run();
  for (const edit of edits) { await counterfact(async () => {
    const old = read(edit.file); await assert.rejects(run(edit), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)); assert.equal(read(edit.file), old, 'R339 setup: production не записывался');
  }); await run(); }
}
async function frozenSnapshot() {
  return normal({
    board: (await t.raw.query(`SELECT month_id,user_id,net,place,stats FROM game_month_results ORDER BY 1,2`)).rows,
    titles: (await t.raw.query(`SELECT month_id,title_key,user_id,value FROM game_titles_awarded ORDER BY 1,2,3`)).rows,
    recaps: (await t.raw.query(`SELECT kind,period_id,user_id,data FROM season_recaps ORDER BY 1,2,3`)).rows,
  });
}
async function writeSnapshot() {
  return normal({ frozen: await frozenSnapshot(), settings: await t.db.select().from(schema.serverEconomy), names: await t.db.select().from(schema.serverGameTitles), seasons: await t.db.select().from(schema.seasonResults), wallets: await t.db.select().from(schema.coinBalances), ledger: await t.db.select().from(schema.coinLedger) });
}
test('месяц: замороженные таблица/звания/recap совпадают при повторе и после восстановления маркера', async () => proof('R339 freeze:', async edit => {
  const f = await fixture(edit); assert.equal(await f.months.closeGameMonthIfNeeded('s', NOW), 'm2026-10');
  const before = await frozenSnapshot(); assert.ok(before.board.length > 0); assert.ok(before.titles.length > 0); assert.ok(before.recaps.length > 0);
  assert.equal(await f.months.closeGameMonthIfNeeded('s', NOW), null, 'R339 freeze: повтор не закрывает тот же месяц');
  assert.deepEqual(await frozenSnapshot(), before);
  await t.db.update(schema.serverEconomy).set({ closedGameMonthId: 'm2026-10' });
  assert.equal(await f.months.closeGameMonthIfNeeded('s', NOW), 'm2026-10'); assert.deepEqual(await frozenSnapshot(), before, 'R339 freeze: данные повторной заморозки совпали');
  const board = await f.months.gameLeaderboard('s', OCT, 'm2026-10'); assert.deepEqual(normal(board.people.map(p => p.userId)), ['a', 'b']); assert.deepEqual(normal(board.people.map(p => p.net)), [110, 90]); assert.equal(board.frozen, true);
  const titles = await f.months.gameTitles('s', false); assert.equal(titles.titles.length, 27); assert.equal(titles.month?.partialFrom, FIRST.toISOString()); assert.deepEqual(normal(titles.titles.find(x => x.key === 'fortune')?.holders.map(x => x.userId).sort()), ['a', 'b']);
}, [{ file: 'gameMonths', from: 'set({ closedGameMonthId: current }).where(eq(serverEconomy.serverId, serverId));\n    return frozen ? finished : null;', to: 'set({ closedGameMonthId: finished }).where(eq(serverEconomy.serverId, serverId));\n    return frozen ? finished : null;' }]));
test('месяц без раундов не морозится; первое наблюдение только ставит маркер', async () => proof('R339 пусто:', async edit => {
  const f = await fixture(edit, false); assert.equal(await f.months.closeGameMonthIfNeeded('s', NOW), null, 'R339 пусто: нет раундов — нет итога');
  assert.deepEqual(await frozenSnapshot(), { board: [], titles: [], recaps: [] });
  await t.db.update(schema.serverEconomy).set({ closedGameMonthId: null }); assert.equal(await f.months.closeGameMonthIfNeeded('s', NOW), null);
  const [settings] = await t.db.select().from(schema.serverEconomy); assert.equal(settings.closedGameMonthId, 'm2026-11');
}, [{ file: 'gameMonths', from: 'if (!totals.any) return null;', to: '' }]));
test('хуки закрытия сезона реально морозят экономику и месяц; корона читается из season_results', async () => proof('R339 hooks:', async edit => {
  const f = await fixture(edit); f.seasons.configureSeasonHooks({ afterClose: f.months.closeGameMonthIfNeeded, freezeRecap: f.months.freezeEconomyRecap });
  const december = new Date('2026-12-01T12:00:00Z'); assert.equal(await f.seasons.closeSeasonIfNeeded('s', december), 'autumn-2026');
  const eco = await f.months.frozenRecap('s', 'economy', 'autumn-2026', 'a'); assert.ok(eco?.server && eco.me, 'R339 hooks: настоящие итоги экономики заморожены'); assert.equal((eco.me as shared.EconomyRecapPersonalDto).place, 1);
  assert.equal((await f.seasons.crownHolder('s', december, 'quarter'))?.userId, 'a'); assert.equal(await f.seasons.closeSeasonIfNeeded('s', december), null);
  assert.ok(await f.months.hasFrozenMonth('s', 'm2026-10')); assert.deepEqual(f.warnings, [], 'R339 setup: успешные хуки не спрятали ошибок');
}, [{ file: 'seasons', from: 'await tx.transaction(async (sp) => freezeRecap(sp, serverId, finished, w));', to: 'void 0;' }]));
test('ошибка подсчёта званий после коммита не откатывает сезон и корону', async () => proof('R339 titleerror:', async edit => {
  const f = await fixture(edit); let calls = 0;
  f.seasons.configureSeasonHooks({ freezeRecap: f.months.freezeEconomyRecap, afterClose: async () => { calls++; throw new Error('synthetic title calculation unavailable'); } });
  const december = new Date('2026-12-01T12:00:00Z'); assert.equal(await f.seasons.closeSeasonIfNeeded('s', december), 'autumn-2026');
  assert.equal(calls, 1, 'R339 titleerror: хук действительно вызывался и упал'); assert.equal((await f.seasons.crownHolder('s', december, 'quarter'))?.userId, 'a');
  assert.ok(f.warnings.some(w => w.includes('game month close failed'))); const [settings] = await t.db.select().from(schema.serverEconomy); assert.equal(settings.closedSeasonId, 'winter-2027');
  assert.ok(await f.months.frozenRecap('s', 'economy', 'autumn-2026', 'a'));
}, [{ file: 'seasons', from: 'await hooks.afterClose?.(serverId, now);', to: 'void 0;' }]));
test('ошибка recap в savepoint откатывает только его записи, не корону сезона', async () => proof('R339 savepoint:', async edit => {
  const f = await fixture(edit);
  f.seasons.configureSeasonHooks({ freezeRecap: async (tx, serverId, periodId) => {
    await tx.insert(schema.seasonRecaps).values({ serverId, periodId, kind: 'economy', userId: '', data: { synthetic: true } });
    throw new Error('synthetic recap unavailable after write');
  } });
  const december = new Date('2026-12-01T12:00:00Z'); assert.equal(await f.seasons.closeSeasonIfNeeded('s', december), 'autumn-2026');
  assert.equal((await t.db.select().from(schema.seasonRecaps)).length, 0, 'R339 savepoint: частичные записи не пережили отказ');
  assert.equal((await f.seasons.crownHolder('s', december, 'quarter'))?.userId, 'a'); assert.ok(f.warnings.some(w => w.includes('economy recap freeze failed')));
}, [{ file: 'seasons', from: 'await tx.transaction(async (sp) => freezeRecap(sp, serverId, finished, w));', to: 'await freezeRecap(tx, serverId, finished, w);' }]));
test('отказ после заморозки прячет таблицу, носителя и личный recap; безымянная сумма остаётся', async () => proof('R339 privacy:', async edit => {
  const f = await fixture(edit); await f.months.closeGameMonthIfNeeded('s', NOW);
  const before = await f.months.frozenRecap('s', 'games', 'm2026-10', 'a'); assert.ok(before?.me);
  await t.db.update(schema.coinBalances).set({ gamesOptOut: true }).where(orm.eq(schema.coinBalances.userId, 'a'));
  const board = await f.months.gameLeaderboard('s', OCT, 'm2026-10'); assert.deepEqual(normal(board.people.map(p => p.userId)), ['b'], 'R339 privacy: заморозка фильтруется при чтении'); assert.equal(board.people[0].place, 1);
  const titles = await f.months.gameTitles('s', false); assert.ok(titles.titles.every(title => title.holders.every(holder => !['a', 'games-out', 'economy-out', 'bot'].includes(holder.userId))));
  const after = await f.months.frozenRecap('s', 'games', 'm2026-10', 'a'); assert.equal(after?.me, null); assert.deepEqual(normal(after?.server), normal(before.server));
}, [{ file: 'gameMonths', from: '.filter((r) => !excluded.has(r.userId))', to: '.filter((r) => true)' }]));
test('HTTP: 400/403/404 и включённый/выключенный лидерборд; чужой участник не получает доступ', async () => proof('R339 HTTP:', async edit => {
  const f = await fixture(edit); const app = await f.app();
  const call = async (as: string, path: string) => { f.as(as); const res = await app.inject({ method: 'GET', url: `/servers/s/${path}` }); assert.notEqual(res.statusCode, 500, 'R339 setup: 500 не считается отказом'); assert.deepEqual(f.errors, [], 'R339 setup: handler exceptions'); return { status: res.statusCode, body: res.json() }; };
  try {
    assert.equal((await call('a', 'games/leaderboard?period=year')).status, 400);
    assert.equal((await call('a', 'games/leaderboard?month=m2020-01')).status, 404);
    assert.equal((await call('outsider', 'games/titles')).status, 404);
    const forbidden = await call('a', 'economy/recap/preview?kind=economy'); assert.equal(forbidden.status, 403, 'R339 HTTP: preview требует право');
    assert.equal((await call('owner', 'economy/recap/preview?kind=games&period=autumn-2026')).status, 400);
    assert.equal((await call('owner', 'economy/recap/preview?kind=games&period=m2027-01')).status, 400);
    assert.equal((await call('a', 'economy/recap?kind=bad')).status, 400);
    const board = await call('a', 'games/leaderboard?month=m2026-10'); assert.equal(board.status, 200); assert.equal(board.body.frozen, true); assert.deepEqual(board.body.people.map((p: any) => p.userId), ['a', 'b']);
    await t.db.update(schema.serverEconomy).set({ gamesEnabled: false }); const disabled = await call('a', 'games/leaderboard'); assert.equal(disabled.status, 200); assert.equal(disabled.body.enabled, false); assert.deepEqual(disabled.body.people, []);
  } finally { await app.close(); }
}, [{ file: 'routes/gameBoard', from: "if (!has(ctx.serverPermissions, Permission.MANAGE_ECONOMY)) return reply.code(403).send({ error: 'forbidden' });\n    const economy = await economySeenBy", to: 'const economy = await economySeenBy' }]));
test('HTTP: переименование 60/61 символ, bad_name, право, неизвестный ключ и возврат по умолчанию', async () => proof('R339 rename:', async edit => {
  const f = await fixture(edit); const app = await f.app();
  const call = async (as: string, title: string, payload: any) => { f.as(as); const res = await app.inject({ method: 'PATCH', url: `/servers/s/games/titles/${title}`, payload }); assert.notEqual(res.statusCode, 500, 'R339 setup: rename без 500'); assert.deepEqual(f.errors, [], 'R339 setup: rename handler errors'); return { status: res.statusCode, body: res.json() }; };
  try {
    assert.equal((await call('a', 'twenty', { name: 'x' })).status, 403); assert.equal((await call('owner', 'unknown', { name: 'x' })).status, 404);
    const bad = await call('owner', 'twenty', { name: 'x'.repeat(61) }); assert.equal(bad.status, 400, 'R339 rename: 61 не проходит'); assert.equal(bad.body.reason, 'bad_name');
    assert.equal((await call('owner', 'twenty', { name: 1 })).body.reason, 'bad_name');
    const good = await call('owner', 'twenty', { name: 'x'.repeat(60) }); assert.equal(good.status, 200); assert.equal(good.body.titles.find((x: any) => x.key === 'twenty').renamed, true);
    const normalized = await call('owner', 'twenty', { name: '  Синтетическое   звание ' }); assert.equal(normalized.body.titles.find((x: any) => x.key === 'twenty').name, 'Синтетическое звание');
    for (const name of [null, '', '   ', shared.DEFAULT_GAME_TITLE_NAMES.twenty]) { const result = await call('owner', 'twenty', { name }); assert.equal(result.status, 200); assert.equal(result.body.titles.find((x: any) => x.key === 'twenty').renamed, false); assert.equal((await t.db.select().from(schema.serverGameTitles)).length, 0); }
  } finally { await app.close(); }
}, [{ file: 'routes/gameBoard', from: 'name.length > GAME_TITLE_NAME_MAX', to: 'name.length > GAME_TITLE_NAME_MAX + 1' }]));
test('HTTP preview экономики и игр только читает: все таблицы, маркеры, деньги неизменны', async () => proof('R339 preview:', async edit => {
  const f = await fixture(edit); const app = await f.app(); const before = await writeSnapshot();
  try {
    f.as('owner');
    for (const query of ['kind=economy&period=autumn-2026', 'kind=games&period=m2026-10']) {
      const res = await app.inject({ method: 'GET', url: `/servers/s/economy/recap/preview?${query}` });
      assert.equal(res.statusCode, 200, 'R339 setup: preview не 500'); assert.deepEqual(f.errors, [], 'R339 setup: preview handler errors'); assert.equal(res.json().recap.preview, true);
      assert.deepEqual(await writeSnapshot(), before, 'R339 preview: dry-run ничего не записал');
    }
  } finally { await app.close(); }
}, [{ file: 'routes/gameBoard', from: 'const { kind } = query.data;', to: 'const { kind } = query.data; await closeSeasonIfNeeded(serverId, now);' }]));
