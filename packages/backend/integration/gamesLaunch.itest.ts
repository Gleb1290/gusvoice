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

// R343: реальные миграции, Fastify-маршруты, games.launch, applyCoins и SQL.
// Подменены только auth/context, конфиг, часы, Redis/шина/аудит и посторонние
// плагины дуэлей/событий/таблицы (их ручки здесь не вызываются).
// PGlite односессионен: перекрытие inject ниже НЕ доказывает PG interleaving.
type Edit = { file: string; from: string; to: string };
type Wire = { serverId?: string; userId?: string; message: Record<string, any>; committed?: boolean };
const T0 = Date.parse('2026-10-29T12:00:00.000Z');
const ISO = new Date(T0).toISOString();
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const read = (file: string) => readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

async function fixture(edit?: Edit) {
  await truncateAll(t.raw);
  const people = ['owner', 'manager', 'member', 'newcomer', 'bot', 'out-economy', 'out-games', 'absent', 'guest'];
  await t.db.insert(schema.users).values(people.map(id => ({ id, username: id, displayName: id,
    bot: id === 'bot', passwordHash: 'synthetic-unused', verified: true })));
  await t.db.insert(schema.servers).values([{ id: 's', name: 'Запуск игр', ownerId: 'owner' },
    { id: 'other', name: 'Чужой голос', ownerId: 'owner' }]);
  await t.db.insert(schema.serverMembers).values(people.filter(id => id !== 'guest').map(userId => ({ serverId: 's', userId })));
  await t.db.insert(schema.channels).values([
    { id: 'v1', serverId: 's', name: 'Первый голос', type: 'voice' },
    { id: 'v2', serverId: 's', name: 'Второй голос', type: 'voice' },
    { id: 'text', serverId: 's', name: 'Не голос', type: 'text' },
    { id: 'foreign', serverId: 'other', name: 'Чужой голос', type: 'voice' },
  ]);
  await t.db.insert(schema.serverEconomy).values({ serverId: 's', enabled: true, gamesEnabled: false,
    closedSeasonId: 'autumn-2026', gooseMinutes: 0, wheelJackpotCents: 12345 });
  const funded = people.filter(id => !['bot', 'newcomer', 'guest'].includes(id));
  await t.db.insert(schema.coinBalances).values(funded.map(userId => ({ serverId: 's', userId, balance: 1000,
    earnedTotal: 17, seasonEarned: 23, seasonId: 'autumn-2026', optedOut: userId === 'out-economy', gamesOptOut: userId === 'out-games' })));
  await t.db.insert(schema.coinLedger).values(funded.map(userId => ({ id: `fund-${userId}`, serverId: 's', userId, amount: 1000, reason: 'fixture' })));

  let user = 'manager'; let superAdmin = false;
  const instance = { economyPreviewUsers: [] as string[], gamesOpen: true };
  const presence: Record<string, string[]> = {
    'presence:ch:v1': ['member', 'newcomer', 'bot', 'out-economy', 'out-games', 'guest', 'member'],
    'presence:ch:v2': ['member'], 'presence:ch:text': ['absent'], 'presence:ch:foreign': ['absent'],
  };
  const wires: Wire[] = []; const audits: any[] = []; const errors: unknown[] = []; const warnings: string[] = [];
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? T0 : value instanceof Date ? value.getTime() : value); }
    static override now() { return T0; }
  }
  const unexpected = () => { throw new Error('R343 launch setup: неожиданный внешний IO'); };
  const noop = async () => {};
  const values: Record<string, any> = {
    'db/index': { db: t.db }, 'db/schema': schema, util: { id: crypto.randomUUID }, env: { env: instance },
    auth: { requireAuth: async (req: { user: unknown }) => { req.user = { sub: user }; } },
    permissions: { getMemberContext: async (serverId: string, userId: string) => {
      const [row] = await t.db.select().from(schema.serverMembers).where(orm.and(orm.eq(schema.serverMembers.serverId, serverId), orm.eq(schema.serverMembers.userId, userId)));
      return row ? { serverPermissions: ['owner', 'manager'].includes(userId) ? shared.Permission.MANAGE_ECONOMY : 0n, superAdmin } : null;
    } },
    realtime: {
      publishToUser: async (userId: string, message: Wire['message']) => { wires.push({ userId, message: normal(message) }); },
      publishToServer: async (serverId: string, message: Wire['message']) => {
        const [row] = await t.db.select().from(schema.serverEconomy).where(orm.eq(schema.serverEconomy.serverId, serverId));
        wires.push({ serverId, message: normal(message), committed: row.gamesLaunchedAt !== null && row.gamesEnabled });
      },
      redisPub: { get: async () => null, pipeline() {
        const keys: string[] = [];
        return { get(key: string) { keys.push(key); return this; },
          exec: async () => keys.map(key => [null, JSON.stringify((presence[key] ?? []).map(userId => ({ userId })))]) };
      } },
    },
    audit: { writeAudit: async (...args: unknown[]) => { audits.push(normal(args)); } },
    'routes/gameDuel': { gameDuelRoutes: noop }, 'routes/gamePredictions': { gamePredictionRoutes: noop },
    'routes/gameBoard': { gameBoardRoutes: noop },
    shop: { shopFor: async () => [] }, purchase: { buyItem: unexpected },
    instanceSettings: { avatarPriceMinutes: unexpected, avatarRentalMaxDays: unexpected },
    storage: { putMedia: unexpected, storageConfigured: unexpected },
  };
  const files = new Set(['routes/gameWheel', 'routes/economy', 'gameWheel', 'gameWheelRules', 'gameMoney', 'gameMoneyRules',
    'coins', 'coinRules', 'streakRules', 'economyDefaults', 'seasons', 'gooseRules', 'voiceActivityRules', 'levelRules', 'shopRules']);
  const cache = new Map<string, any>();
  function load<T>(file: string): T {
    if (Object.hasOwn(values, file)) return values[file] as T;
    if (cache.has(file)) return cache.get(file) as T;
    assert.ok(files.has(file), `R343 launch setup: закрытый импорт ${file}`);
    let source = read(file);
    if (edit?.file === file) {
      assert.equal(source.split(edit.from).length, 2, 'R343 launch setup: уникальный якорь целого модуля');
      source = source.replace(edit.from, edit.to);
    }
    const module = { exports: {} }; cache.set(file, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer, Error, Uint8Array, setInterval: unexpected,
      console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')), error: (...args: unknown[]) => warnings.push(args.join(' ')) },
      require(id: string) {
        if (id === '@gusvoice/shared') return shared;
        if (id === 'drizzle-orm') return orm;
        if (id === 'node:crypto') return crypto;
        if (id === 'zod') return zod;
        assert.ok(id.startsWith('.'), `R343 launch setup: внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(file), id)).replace(/\.js$/, ''));
      },
    });
    return module.exports as T;
  }
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => { errors.push(error); void reply.status(500).send({ error: 'unexpected fixture error' }); });
  try {
    await app.register(load<typeof import('../src/routes/gameWheel.js')>('routes/gameWheel').gameWheelRoutes);
    await app.register(load<typeof import('../src/routes/economy.js')>('routes/economy').economyRoutes);
    await app.ready();
  } catch (error) { await app.close(); throw error; }
  async function call(method: 'GET' | 'POST', path: string, payload?: any) {
    const response = await app.inject({ method, url: `/servers/s/${path}`, payload });
    assert.notEqual(response.statusCode, 500, 'R343 launch setup: 500 не считается отказом');
    assert.deepEqual(errors, [], 'R343 launch setup: маршрут не спрятал исключение');
    return { status: response.statusCode, body: response.json() };
  }
  return { app, wires, audits, errors, warnings, call, instance,
    as(id: string) { user = id; }, super(value: boolean) { superAdmin = value; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const launch = (f: Fixture, gift: unknown = 500) => f.call('POST', 'games/launch', { gift });
const settings = async () => normal(await t.db.select().from(schema.serverEconomy));
const wallets = async () => normal(await t.db.select().from(schema.coinBalances).orderBy(orm.asc(schema.coinBalances.userId)));
const ledger = async () => normal(await t.db.select().from(schema.coinLedger).orderBy(orm.asc(schema.coinLedger.userId), orm.asc(schema.coinLedger.id)));
async function drift() {
  const result = await t.raw.query(`SELECT b.user_id FROM coin_balances b LEFT JOIN coin_ledger l USING(server_id,user_id)
    GROUP BY b.server_id,b.user_id,b.balance HAVING b.balance <> COALESCE(SUM(l.amount),0)::int`);
  assert.deepEqual(result.rows, [], 'R343 launch setup: drift равен нулю');
}
async function proof(prefix: string, check: (f: Fixture) => Promise<void>, edits: Edit[]) {
  const run = async (edit?: Edit) => {
    const f = await fixture(edit);
    try { await check(f); await drift(); assert.deepEqual(f.errors, [], 'R343 launch setup: ошибок HTTP нет'); assert.deepEqual(f.warnings, [], 'R343 launch setup: ошибок шины нет'); }
    finally { await f.app.close(); }
  };
  await run();
  for (const edit of edits) {
    await counterfact(async () => {
      const original = read(edit.file);
      await assert.rejects(run(edit), error => error instanceof assert.AssertionError && error.message.startsWith(prefix),
        'мутант должен провалить адресное утверждение, не SQL/500/загрузчик');
      assert.equal(read(edit.file), original, 'R343 launch setup: продукт на диске не менялся');
    });
    await run(); // Независимая загрузка исходных модулей + чистая БД, не продолжение мутанта.
  }
}
async function rejected(f: Fixture, status: number, reason: string, prefix: string, gift: unknown = 500) {
  const before = { settings: await settings(), wallets: await wallets(), ledger: await ledger() };
  const response = await launch(f, gift);
  assert.equal(response.status, status, `${prefix} HTTP ${status}`);
  assert.equal(response.body.reason, reason, `${prefix} точная причина ${reason}`);
  assert.equal(typeof response.body.error, 'string', `${prefix} есть текст ошибки`);
  assert.equal(response.body.message, response.body.error, `${prefix} текст согласован`);
  assert.deepEqual({ settings: await settings(), wallets: await wallets(), ledger: await ledger() }, before, `${prefix} отказ ничего не пишет`);
  assert.deepEqual(f.wires, [], `${prefix} отказ не рассылается`);
  assert.deepEqual(f.audits, [], `${prefix} отказ не аудируется как запуск`);
}

test('R343 запуск: закрытый флаг даёт управляющему 403 games-locked, супер-админ запускает', async () => proof('R343 launch lock:', async f => {
  f.instance.gamesOpen = false;
  await rejected(f, 403, 'games-locked', 'R343 launch lock:');
  f.super(true);
  assert.equal((await launch(f)).status, 200, 'R343 launch lock: супер-админу разрешено');
  assert.equal((await settings())[0].gamesEnabled, true, 'R343 launch lock: игры действительно включены');
}, [
  { file: 'routes/gameWheel', from: 'locked: gamesLockedFor(gamesOpenOnInstance(), ctx.superAdmin === true),', to: 'locked: false,' },
  { file: 'routes/gameWheel', from: 'locked: gamesLockedFor(gamesOpenOnInstance(), ctx.superAdmin === true),', to: 'locked: gamesLockedFor(gamesOpenOnInstance(), false),' },
]));

test('R343 запуск: открытый флаг не даёт права участнику, управляющий принят', async () => proof('R343 launch permission:', async f => {
  f.as('member'); await rejected(f, 403, 'forbidden', 'R343 launch permission:');
  f.as('manager'); assert.equal((await launch(f)).status, 200, 'R343 launch permission: управляющий принят');
}, [{ file: 'routes/gameWheel', from: 'canManage: has(ctx.serverPermissions, Permission.MANAGE_ECONOMY),', to: 'canManage: true,' }]));

test('R343 запуск: выключенные монеты дают 409 economy-off, включённые допускают запуск', async () => proof('R343 launch economy:', async f => {
  await t.db.update(schema.serverEconomy).set({ enabled: false });
  await rejected(f, 409, 'economy-off', 'R343 launch economy:');
  await t.db.update(schema.serverEconomy).set({ enabled: true });
  assert.equal((await launch(f)).status, 200, 'R343 launch economy: после включения монет запуск принят');
}, [{ file: 'routes/gameWheel', from: 'economyEnabled: !!economy?.enabled,', to: 'economyEnabled: true,' }]));

test('R343 запуск: неверный подарок даёт 400 без записи, верхняя граница 2000 принимается', async () => proof('R343 launch gift:', async f => {
  for (const gift of [-50, 25, 2050, 50.5, '500', null]) await rejected(f, 400, 'bad-gift', 'R343 launch gift:', gift);
  const response = await launch(f, 2000);
  assert.equal(response.status, 200, 'R343 launch gift: ровно 2000 принято');
  assert.equal(response.body.gift, 2000, 'R343 launch gift: верхняя граница не обрезана');
}, [{ file: 'routes/gameWheel', from: 'if (!isGamesLaunchGift(gift)) {', to: 'if (false) {' }]));

test('R343 запуск: подарок только живым участникам голоса этого сервера, без ботов и отказавшихся', async () => proof('R343 launch recipients:', async f => {
  const response = await launch(f);
  assert.equal(response.status, 200, 'R343 launch recipients: запуск принят');
  assert.equal(response.body.people, 2, 'R343 launch recipients: только два адресата, повторы presence не считаются');
  const gifts = (await ledger()).filter(r => r.reason === 'games.launch');
  assert.deepEqual(gifts.map(r => r.userId), ['member', 'newcomer'], 'R343 launch recipients: точный список журнала');
  const all = await wallets();
  assert.equal(all.find(w => w.userId === 'member')?.balance, 1500, 'R343 launch recipients: присутствующий участник получил');
  assert.equal(all.find(w => w.userId === 'newcomer')?.balance, 500, 'R343 launch recipients: первый кошелёк создан');
  for (const id of ['manager', 'owner', 'out-economy', 'out-games', 'absent']) assert.equal(all.find(w => w.userId === id)?.balance, 1000, `R343 launch recipients: ${id} не получил`);
  for (const id of ['bot', 'guest']) assert.ok(!all.some(w => w.userId === id), `R343 launch recipients: ${id} не получает даже кошелёк`);
}, [
  { file: 'gameWheel', from: 'eq(users.bot, false)', to: 'sql`true`' },
  { file: 'gameWheel', from: 'memberSet.has(u) && !declinedSet.has(u)', to: '!declinedSet.has(u)' },
  { file: 'gameWheel', from: 'd.optedOut || d.gamesOptOut', to: 'd.gamesOptOut' },
  { file: 'gameWheel', from: 'd.optedOut || d.gamesOptOut', to: 'd.optedOut' },
  { file: 'gameWheel', from: "eq(channels.type, 'voice'), eq(channels.serverId, serverId)", to: 'eq(channels.serverId, serverId)' },
  { file: 'gameWheel', from: "eq(channels.type, 'voice'), eq(channels.serverId, serverId)", to: "eq(channels.type, 'voice')" },
]));

test('R343 запуск: эмиссия games.launch не растит заработок и не расходует сундук, drift=0', async () => proof('R343 launch money:', async f => {
  assert.equal((await launch(f)).status, 200, 'R343 launch money: запуск принят');
  const all = await wallets();
  assert.deepEqual(all.filter(w => w.userId !== 'newcomer').map(w => [w.userId, w.earnedTotal, w.seasonEarned]),
    ['absent', 'manager', 'member', 'out-economy', 'out-games', 'owner'].map(id => [id, 17, 23]), 'R343 launch money: старый заработок не изменён');
  const fresh = all.find(w => w.userId === 'newcomer');
  assert.deepEqual([fresh?.earnedTotal, fresh?.seasonEarned], [0, 0], 'R343 launch money: подарок новичка не заработок');
  const gifts = (await ledger()).filter(r => r.reason === 'games.launch');
  assert.equal(gifts.length, 2, 'R343 launch money: два настоящих начисления с правильной причиной');
  for (const row of gifts) assert.deepEqual([row.amount, row.refUserId, row.data], [500, 'manager', { launchedAt: ISO }], 'R343 launch money: сумма, автор и отметка в журнале');
  assert.equal(Number((await settings())[0].wheelJackpotCents), 12345, 'R343 launch money: сундук не источник подарка');
  await drift();
}, [
  { file: 'gameWheel', from: 'countsAsEarned: false,', to: 'countsAsEarned: true,' },
  { file: 'gameWheel', from: 'reason: GAMES_LAUNCH_REASON,', to: "reason: 'fixture-wrong-launch'," },
]));

const unguardLaunch: Edit = { file: 'gameWheel',
  from: '.where(and(eq(serverEconomy.serverId, serverId), isNull(serverEconomy.gamesLaunchedAt)))',
  to: '.where(eq(serverEconomy.serverId, serverId))' };
test('R343 запуск: повтор даёт 409 already-launched и не меняет отметку, деньги, шину или аудит', async () => proof('R343 launch repeat:', async f => {
  assert.equal((await launch(f)).status, 200, 'R343 launch repeat: первый запуск принят');
  const before = { settings: await settings(), wallets: await wallets(), ledger: await ledger(), wires: normal(f.wires), audits: normal(f.audits) };
  // Второй gift=0: убранный guard не прячется за UNIQUE журнала/500.
  const again = await launch(f, 0);
  assert.equal(again.status, 409, 'R343 launch repeat: повтор отклонён условным UPDATE');
  assert.equal(again.body.reason, 'already-launched', 'R343 launch repeat: точная причина');
  assert.deepEqual({ settings: await settings(), wallets: await wallets(), ledger: await ledger(), wires: normal(f.wires), audits: normal(f.audits) }, before, 'R343 launch repeat: повтор ничего не меняет');
}, [unguardLaunch]));

test('R343 запуск: два перекрытых HTTP-запроса дают один 200 и один 409 в односессионном PGlite', async () => proof('R343 launch overlap:', async f => {
  // Только idempotency в очереди PGlite; отдельные PG-сессии и ожидание row lock здесь не доказаны.
  // gift=0 позволяет мутанту дойти до HTTP-утверждения без ложной победы UNIQUE/SQL-ошибкой.
  const both = await Promise.all([launch(f, 0), launch(f, 0)]);
  assert.deepEqual(both.map(r => r.status).sort(), [200, 409], 'R343 launch overlap: принята одна заявка');
  assert.equal(both.find(r => r.status === 409)?.body.reason, 'already-launched', 'R343 launch overlap: повтор получил точный отказ');
  assert.equal(f.audits.length, 1, 'R343 launch overlap: один аудит');
  assert.equal(f.wires.filter(w => w.message.t === 'games.launched').length, 1, 'R343 launch overlap: одно извещение');
}, [unguardLaunch]));

test('R343 запуск: gift=0 включает игры без кошельков и нулевых строк журнала', async () => proof('R343 launch zero:', async f => {
  const before = { wallets: await wallets(), ledger: await ledger() };
  const response = await launch(f, 0);
  assert.deepEqual(response, { status: 200, body: { at: ISO, gift: 0, people: 0 } }, 'R343 launch zero: нулевой подарок корректен');
  assert.deepEqual({ wallets: await wallets(), ledger: await ledger() }, before, 'R343 launch zero: денежного IO нет');
  const [row] = await settings();
  assert.deepEqual([row.gamesEnabled, row.gamesLaunchedAt, row.gamesLaunchedBy, row.gamesLaunchGift], [true, ISO, 'manager', 0], 'R343 launch zero: запуск отмечен');
}, [{ file: 'gameWheel', from: 'if (gift <= 0 || ids.length === 0)', to: 'if (ids.length === 0)' }]));

test('R343 запуск: после коммита приходят кошельки, games.launched, invalidate и аудит', async () => proof('R343 launch events:', async f => {
  const response = await launch(f);
  assert.deepEqual(response, { status: 200, body: { at: ISO, gift: 500, people: 2 } }, 'R343 launch events: ответ запуска');
  assert.deepEqual(f.wires.filter(w => w.serverId).map(w => w.message), [
    { t: 'games.launched', serverId: 's', at: ISO, gift: 500, giftedUserIds: ['member', 'newcomer'] },
    { t: 'server.invalidate', serverId: 's' },
  ], 'R343 launch events: точные серверные события и порядок');
  assert.ok(f.wires.filter(w => w.serverId).every(w => w.committed), 'R343 launch events: шина видит сохранённую отметку');
  assert.deepEqual(f.wires.filter(w => w.userId).map(w => [w.userId, w.message.t, w.message.balance]),
    [['member', 'economy.wallet', 1500], ['newcomer', 'economy.wallet', 500]], 'R343 launch events: только получателям кошелёк из БД');
  assert.deepEqual(f.audits, [['s', 'manager', 'economy.games-launch', { targetType: 'server', targetId: 's', data: { gift: 500, people: 2, minted: 1000 } }]], 'R343 launch events: точный аудит эмиссии');
}, [
  { file: 'gameWheel', from: "t: 'games.launched',", to: "t: 'fixture-wrong-event'," },
  { file: 'gameWheel', from: "await publishToServer(serverId, { t: 'server.invalidate', serverId });", to: 'void 0;' },
  { file: 'routes/gameWheel', from: "await writeAudit(serverId, userId, 'economy.games-launch', {", to: "await writeAudit(serverId, userId, 'fixture-wrong-audit', {" },
]));

test('R343 снимок: gamesLocked учитывает открытый флаг и супер-админа, не право управления', async () => proof('R343 launch GET lock:', async f => {
  const view = async () => { const r = await f.call('GET', 'economy'); assert.equal(r.status, 200, 'R343 launch GET lock: снимок доступен'); return r.body; };
  f.instance.gamesOpen = false;
  assert.equal((await view()).gamesLocked, true, 'R343 launch GET lock: управляющий заперт');
  f.super(true); assert.equal((await view()).gamesLocked, false, 'R343 launch GET lock: супер-админ не заперт');
  f.super(false); f.as('member'); f.instance.gamesOpen = true;
  assert.equal((await view()).gamesLocked, false, 'R343 launch GET lock: открытый флаг снимает замок даже участнику');
}, [{ file: 'routes/economy', from: 'gamesLocked: gamesLockedFor(gamesOpenOnInstance(), ctx.superAdmin === true),', to: 'gamesLocked: false,' }]));

test('R343 снимок: gamesLaunch сначала null, затем at/gift и только личный mine из журнала', async () => proof('R343 launch GET mine:', async f => {
  const view = async (who: string) => { f.as(who); const r = await f.call('GET', 'economy'); assert.equal(r.status, 200, 'R343 launch GET mine: снимок доступен'); return r.body; };
  assert.equal((await view('member')).gamesLaunch, null, 'R343 launch GET mine: до запуска нет карточки');
  f.as('manager'); assert.equal((await launch(f)).status, 200, 'R343 launch GET mine: запуск принят');
  const before = { settings: await settings(), wallets: await wallets(), ledger: await ledger() };
  for (const who of ['member', 'newcomer', 'manager', 'out-games', 'absent']) {
    const snapshot = await view(who);
    assert.deepEqual(snapshot.gamesLaunch, { at: ISO, gift: 500, mine: ['member', 'newcomer'].includes(who) ? 500 : 0 }, `R343 launch GET mine: личная карточка ${who}`);
    assert.equal(snapshot.gamesEnabled, true, 'R343 launch GET mine: старый клиент видит включённые игры');
  }
  assert.deepEqual({ settings: await settings(), wallets: await wallets(), ledger: await ledger() }, before, 'R343 launch GET mine: чтение ничего не начисляет');
}, [
  { file: 'gameMoney', from: 'mine: mine?.amount ?? 0', to: 'mine: 0' },
  { file: 'gameMoney', from: 'eq(coinLedger.serverId, server), eq(coinLedger.userId, who)', to: 'eq(coinLedger.serverId, server)' },
]));
