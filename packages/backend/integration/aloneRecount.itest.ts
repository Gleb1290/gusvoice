import { counterfact, mutantTest } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import * as orm from 'drizzle-orm';
import * as zod from 'zod';
import * as shared from '@gusvoice/shared';
import ts from 'typescript';
import * as schema from '../src/db/schema.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

// Целые production-модули и настоящий Postgres: не копируем денежные правила или SQL.
type Edit = { file: string; from: string; to: string };
const CUTOFF = new Date('2026-10-20T12:00:00Z');
const NOW = new Date('2026-10-21T12:00:00Z');
const KIND = 'alone-2026-10';
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => {
  await t?.close();
  const { pool } = await import('../src/db/index.js');
  await pool.end();
});
const normal = <T>(v: T): T => JSON.parse(JSON.stringify(v));

async function fixture(edits: Edit[] = []) {
  await truncateAll(t.raw);
  await t.raw.query('UPDATE _migrations SET applied_at = $1 WHERE name = $2',
    [CUTOFF.toISOString(), '0158_alone_cap.sql']);
  const ids = ['human', 'other', 'bot', 'deleted', 'opted', 'left', 'arrived', 'deaf'];
  await t.db.insert(schema.users).values(ids.map(id => ({
    id, username: id, displayName: id, passwordHash: 'fixture', bot: id === 'bot',
    deletedAt: id === 'deleted' ? new Date('2026-10-19T12:00:00Z') : null,
  })));
  await t.db.insert(schema.servers).values(['server', 'off', 'never'].map(id => ({
    id, name: id, ownerId: 'human',
  })));
  await t.db.insert(schema.serverMembers).values(['server', 'off', 'never'].flatMap(serverId =>
    ids.filter(id => id !== 'left').map(userId => ({ serverId, userId }))));
  await t.db.insert(schema.serverEconomy).values(['server', 'off', 'never'].map(serverId => ({
    serverId, enabled: serverId !== 'off',
    accrualSince: serverId === 'never' ? null : new Date('2026-10-02T00:00:00Z'),
    seasonLength: 'month' as const, closedSeasonId: 'm2026-10',
    ratePer5min: 50, alonePercent: 100, companyPercent: 100, dailyCap: 0, aloneCap: 0,
    decayAfterMinutes: 1, decayPercent: 50, payoutMinutes: 1,
    mutedPercent: 100, deafenedPercent: 25, awayPercent: 100, gooseBonus: 0,
  })));
  const live = {
    balance: 101, earnedTotal: 307, seasonEarned: 211, seasonId: 'm2026-10',
    day: '2026-10-21', secondsToday: 421, earnedToday: 29, aloneEarnedMilli: 8137,
    pendingMilli: 1337, pendingSeconds: 17, baseMilli: 3000, deltaPresenceMilli: -1000,
    deltaCompanyMilli: -500, deltaDecayMilli: -163, secondsTotal: 42000,
    givenToday: 7, receivedToday: 11, recognitionToday: 2, recognitionTippers: 19,
    streakDay: '2026-10-21', streakDays: 3, bonusClaims: 5,
  };
  await t.db.insert(schema.coinBalances).values(ids.map(userId => ({
    serverId: 'server', userId, ...live, optedOut: userId === 'opted',
  })));
  const activity: (typeof schema.voiceActivity.$inferInsert)[] = [];
  const sample = (serverId: string, userId: string, offset: number, peers: number, deafened = false) => {
    activity.push({ id: randomUUID(), serverId, userId, channelId: 'voice', seconds: 60,
      peers, deafened, muted: false, away: false, createdAt: new Date(CUTOFF.getTime() + offset) });
  };
  for (const serverId of ['server', 'off', 'never']) {
    for (const userId of ids.filter(id => !['arrived', 'deaf'].includes(id))) {
      // 10 + 10 новым правилом против 10 + 5 старым: доплата ровно 5, без oracle из recountDiffs.
      sample(serverId, userId, -120000, 0);
      sample(serverId, userId, -60000, 1);
    }
    sample(serverId, 'arrived', -60000, 1); // Сразу пришёл в компанию: разницы нет.
    sample(serverId, 'deaf', -120000, 0, true); // Отрицательную разницу не отбираем.
    // Ровно cutoff и следующий срез должны быть исключены ОБА: иначе доплата станет больше пяти.
    sample(serverId, 'human', 0, 1);
    sample(serverId, 'human', 60000, 1);
    // ВНУТРИ сезона, но до accrualSince: нижняя граница не должна случайно защищаться сезоном.
    const beforeEnabled = Date.parse('2026-10-01T12:00:00Z') - CUTOFF.getTime();
    sample(serverId, 'human', beforeEnabled, 0);
    sample(serverId, 'human', beforeEnabled + 60000, 1);
  }
  await t.db.insert(schema.voiceActivity).values(activity);

  let clock = NOW.getTime();
  class FixedDate extends Date {
    constructor(value?: string | number | Date) {
      super(value === undefined ? clock : value instanceof Date ? value.getTime() : value);
    }
    static override now() { return clock; }
  }
  let transactionActive = false;
  const statements: { sql: string; params: unknown[] }[] = [];
  // Только наблюдение: все builder-методы и then выполняются на настоящем drizzle/PGlite.
  function observeQuery(q: any): any {
    return new Proxy(q, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'then') {
        statements.push(target.toSQL());
        return value.bind(target);
      }
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = value.apply(target, args);
        return result && typeof result.toSQL === 'function' ? observeQuery(result) : result;
      };
    } });
  }
  const observedDb = new Proxy(t.db, { get(target, key) {
    if (key === 'select') return (...args: unknown[]) => observeQuery((target.select as any)(...args));
    if (key === 'transaction') return async (callback: (tx: any) => Promise<unknown>) => {
      transactionActive = true;
      try { return await target.transaction(callback); }
      finally { transactionActive = false; }
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const pushes: { userId: string; message: any; transactionActive: boolean; committedRows: number }[] = [];
  const fail = () => { throw new Error('неожиданный внешний IO'); };
  const noop = async () => {};
  const boundaries: Record<string, unknown> = {
    'db/index': { db: observedDb }, 'db/schema': schema, util: { id: randomUUID },
    env: { env: { economyPreviewUsers: [] } },
    auth: { requireAuth: async (req: any) => { req.user = { sub: req.headers['x-fixture-user'] ?? 'human' }; } },
    permissions: { getMemberContext: async (serverId: string, userId: string) => {
      const [row] = await t.db.select().from(schema.serverMembers)
        .where(orm.and(orm.eq(schema.serverMembers.serverId, serverId), orm.eq(schema.serverMembers.userId, userId)));
      return row ? { serverPermissions: 0n } : null;
    } },
    realtime: { publishToUser: async (userId: string, message: any) => {
      // При ошибочном пуше из транзакции не делаем вложенное чтение: PGlite сериализует запросы.
      const rows = transactionActive ? [] : await t.db.select().from(schema.coinRecounts)
        .where(orm.and(orm.eq(schema.coinRecounts.serverId, message.serverId), orm.eq(schema.coinRecounts.userId, userId)));
      pushes.push({ userId, message: normal(message), transactionActive, committedRows: rows.length });
    }, publishToServer: noop, redisPub: { get: async () => null } },
    audit: { writeAudit: fail }, purchase: { buyItem: fail },
    storage: { putMedia: fail, storageConfigured: () => false },
    instanceSettings: { avatarPriceMinutes: async () => 60, avatarRentalMaxDays: async () => 30 },
  };
  const allowed = new Set(['aloneRecount', 'aloneRecountRules', 'coinRules', 'coins', 'streakRules',
    'routes/economy', 'economyDefaults', 'gooseRules', 'voiceActivityRules', 'levelRules',
    'seasons', 'shop', 'shopRules', 'gameMoney', 'gameMoneyRules']);
  const cache = new Map<string, any>();
  function load(name: string): any {
    if (Object.hasOwn(boundaries, name)) return boundaries[name];
    if (cache.has(name)) return cache.get(name);
    assert.ok(allowed.has(name), `R318 закрытый импорт ${name}`);
    let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    for (const edit of edits.filter(e => e.file === name)) {
      assert.equal(source.split(edit.from).length, 2, `R318 уникальный якорь ${name}: ${edit.from}`);
      source = source.replace(edit.from, edit.to);
    }
    const module = { exports: {} };
    cache.set(name, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, { module, exports: module.exports, Date: FixedDate, Buffer,
      require(id: string) {
        if (id === 'drizzle-orm') return orm;
        if (id === '@gusvoice/shared') return shared;
        if (id === 'zod') return zod;
        assert.ok(id.startsWith('.'), `R318 внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
      } });
    return module.exports;
  }
  return { live, pushes, statements, load, advance: () => { clock += 60000; },
    recount: load('aloneRecount') as typeof import('../src/aloneRecount.js'),
    coins: load('coins') as typeof import('../src/coins.js') };
}

async function paidScenario(edits: Edit[] = [], inspectSql = true) {
  const f = await fixture(edits);
  const logs: string[] = [];
  const stale = (await f.coins.economyOf('server'))!;
  const result = await f.recount.runAloneRecount(s => logs.push(s));
  const paid = result.find(r => r.serverId === 'server');
  assert.ok(paid, `R318 сервер пересчитан: ${logs.join('; ')}`);
  assert.equal(paid.sum, 10, 'R318 cutoff даёт только две доплаты по пять');
  assert.equal(paid.people, 2, 'R318 положительные контроли: оба действующих человека получают');
  assert.equal(paid.skipped, 4, 'R318 бот, удалённый, optedOut и ушедший пропущены');
  assert.equal(result.find(r => r.serverId === 'never')?.sum, 0, 'R318 без первого включения доплаты нет');
  const ledger = await t.db.select().from(schema.coinLedger).orderBy(schema.coinLedger.userId);
  assert.deepEqual(ledger.map(r => [r.serverId, r.userId, r.amount, r.reason]),
    [['server', 'human', 5, 'recount'], ['server', 'other', 5, 'recount']], 'R318 журнал только допустимых получателей');
  for (const row of ledger) assert.deepEqual(normal(row.data), {
    kind: KIND, seasonId: 'm2026-10', from: '2026-10-02T00:00:00.000Z',
    until: CUTOFF.toISOString(), coinsNew: 20, coinsOld: 15,
  }, 'R318 журнал объясняет доплату, а не повторную оплату времени');
  const cards = await t.db.select().from(schema.coinRecounts).orderBy(schema.coinRecounts.userId);
  assert.deepEqual(cards.map(r => [r.serverId, r.userId, r.kind, r.amount, r.seasonId, r.seenAt]),
    [['server', 'human', KIND, 5, 'm2026-10', null], ['server', 'other', KIND, 5, 'm2026-10', null]]);
  const balances = await t.db.select().from(schema.coinBalances);
  for (const row of balances) {
    const amount = ['human', 'other'].includes(row.userId) ? 5 : 0;
    assert.equal(row.balance, f.live.balance + amount, 'R318 баланс растёт ровно на доплату');
    assert.equal(row.earnedTotal, f.live.earnedTotal + amount, 'R318 countsAsEarned увеличивает заработок за всё время');
    assert.equal(row.seasonEarned, f.live.seasonEarned + amount, 'R318 countsAsEarned увеличивает сезонный заработок');
    for (const [key, value] of Object.entries(f.live)) {
      if (!['balance', 'earnedTotal', 'seasonEarned'].includes(key)) {
        assert.equal((row as any)[key], value, `R318 живой ${key} не трогается перерасчётом`);
      }
    }
  }
  const settings = await t.db.select().from(schema.serverEconomy);
  assert.equal(settings.find(r => r.serverId === 'off')?.aloneRecountAt, null, 'R318 выключенный сервер не отмечается');
  assert.ok(settings.find(r => r.serverId === 'never')?.aloneRecountAt, 'R318 пустое окно отмечается один раз');
  assert.equal(f.pushes.length, 2, 'R318 ровно один пуш каждому получателю');
  for (const push of f.pushes) {
    assert.equal(push.transactionActive, false, 'R318 pushWallet только после commit');
    assert.equal(push.committedRows, 1, 'R318 карточка уже доступна в БД в момент пуша');
    assert.deepEqual(push.message, { t: 'economy.wallet', serverId: 'server', balance: 106, earnedTotal: 312, seasonEarned: 216 });
  }
  if (inspectSql) {
    const query = f.statements.find(q => q.sql.includes('from "voice_activity"'));
    assert.ok(query, 'R318 выполняется настоящий SQL срезов');
    assert.match(query.sql, /"created_at" < \$/, 'R318 верхняя граница есть в SQL');
    assert.ok(query.params.some(p => String(p) === CUTOFF.toISOString()), 'R318 SQL использует applied_at 0158, не now');
  }
  assert.deepEqual(normal(await f.recount.runAloneRecount(() => {})), [], 'R318 второй запуск не начисляет');
  assert.equal(await f.recount.recountServer(stale, CUTOFF), null, 'R318 stale economy не обходит IS NULL замок');
  assert.equal((await t.db.select().from(schema.coinLedger)).length, 2, 'R318 stale объект не дублирует журнал');
  assert.equal(f.pushes.length, 2, 'R318 повтор не порождает уведомлений');
  return f;
}

test('R318 перерасчёт один раз: допустимые люди, заработок, нетронутые живые счётчики и пуш после коммита', async () => { await paidScenario(); });

const noSqlCutoff: Edit = { file: 'aloneRecount',
  from: 'lt(voiceActivity.createdAt, window.to),', to: '' };
mutantTest('R318 beforeCutoff независимо защищает деньги, даже когда SQL вернул ровно cutoff и более поздние срезы',
  async () => { await paidScenario([noSqlCutoff], false); });

const mutations: [string, Edit[], RegExp][] = [
  ['удалён IS NULL замок', [{ file: 'aloneRecount',
    from: 'and(eq(serverEconomy.serverId, serverId), isNull(serverEconomy.aloneRecountAt))',
    to: 'eq(serverEconomy.serverId, serverId)' }], /stale economy/],
  ['cutoff подменён текущим временем', [{ file: 'aloneRecount',
    from: 'return row ? new Date(row.applied_at) : null;', to: 'return row ? new Date() : null;' }], /cutoff даёт/],
  ['доплата перестала считаться заработком', [{ file: 'aloneRecount',
    from: 'countsAsEarned: true,', to: 'countsAsEarned: false,' }], /countsAsEarned/],
  ['потеряны обе защиты cutoff', [noSqlCutoff, { file: 'aloneRecount',
    from: 'recountDiffs(beforeCutoff(rows as ReplaySample[], window.to), economy)',
    to: 'recountDiffs(rows as ReplaySample[], economy)' }], /cutoff даёт/],
  ['пропала нижняя граница первого включения', [{ file: 'aloneRecount',
    from: 'gte(voiceActivity.createdAt, window.from),', to: '' }], /cutoff даёт/],
];
for (const [name, edits, message] of mutations) test(`R318 контрфакт: ${name}`, async () => {
  await paidScenario();
  await counterfact(async () => {
  await assert.rejects(paidScenario(edits, false), e => e instanceof assert.AssertionError && message.test(e.message));
  });
});

test('R318 ошибка после начисления откатывает кошелёк, журнал, карточку и замок; следующий запуск успешно повторяется', async () => {
  const f = await fixture();
  const before = normal(await t.db.select().from(schema.coinBalances));
  await t.raw.exec('ALTER TABLE coin_recounts ADD CONSTRAINT fixture_recount_failure CHECK (amount <> 5)');
  try {
    const logs: string[] = [];
    const result = await f.recount.runAloneRecount(s => logs.push(s));
    assert.equal(result.some(r => r.serverId === 'server'), false, 'R318 неуспешный сервер не выдаётся за успешный');
    assert.ok(logs.some(s => s.includes('перерасчёт не удался')), 'R318 ошибка зарегистрирована');
    assert.deepEqual(normal(await t.db.select().from(schema.coinBalances)), before, 'R318 транзакция откатила уже начисленные монеты');
    assert.equal((await t.db.select().from(schema.coinLedger)).length, 0);
    assert.equal((await t.db.select().from(schema.coinRecounts)).length, 0);
    const [server] = await t.db.select().from(schema.serverEconomy).where(orm.eq(schema.serverEconomy.serverId, 'server'));
    assert.equal(server.aloneRecountAt, null, 'R318 замок тоже откатился');
    assert.equal(f.pushes.length, 0, 'R318 откат не утекает человеку пушем');
  } finally {
    await t.raw.exec('ALTER TABLE coin_recounts DROP CONSTRAINT fixture_recount_failure');
  }
  const retry = await f.recount.runAloneRecount(() => {});
  assert.equal(retry.find(r => r.serverId === 'server')?.sum, 10, 'R318 после устранения ошибки повтор разрешён');
});

async function httpScenario(edits: Edit[] = []) {
  const f = await paidScenario(edits);
  await t.db.update(schema.coinRecounts).set({ amount: 17 }).where(orm.eq(schema.coinRecounts.userId, 'other'));
  await t.db.insert(schema.coinRecounts).values({ serverId: 'off', userId: 'human', kind: KIND, amount: 23, seasonId: 'm2026-10' });
  const beforeBalances = normal(await t.db.select().from(schema.coinBalances));
  const beforeLedger = normal(await t.db.select().from(schema.coinLedger));
  const app = Fastify();
  await app.register(f.load('routes/economy').economyRoutes);
  await app.ready();
  const request = (method: 'GET' | 'PATCH', userId = 'human', serverId = 'server', payload?: unknown) =>
    app.inject({ method, url: `/servers/${serverId}/economy${method === 'PATCH' ? '/me' : ''}`,
      headers: { 'x-fixture-user': userId }, ...(payload === undefined ? {} : { payload: payload as any }) });
  try {
    for (const [user, server, amount] of [['human', 'server', 5], ['other', 'server', 17], ['human', 'off', 23]] as const) {
      const response = await request('GET', user, server);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().recount, { amount, seasonId: 'm2026-10' }, 'R318 только своя карточка своего сервера');
    }
    assert.equal((await request('GET', 'arrived')).json().recount, undefined, 'R318 без доплаты карточки нет');
    assert.equal((await request('PATCH', 'left', 'server', { recountSeen: true })).statusCode, 404, 'R318 ушедший не отмечает чужую карточку');
    const first = await request('PATCH', 'human', 'server', { recountSeen: true });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json(), { recountSeen: true });
    const [seen] = await t.db.select().from(schema.coinRecounts).where(orm.and(
      orm.eq(schema.coinRecounts.serverId, 'server'), orm.eq(schema.coinRecounts.userId, 'human')));
    assert.ok(seen.seenAt, 'R318 просмотр сохранён в БД');
    assert.equal((await request('GET')).json().recount, undefined, 'R318 просмотренное поле отсутствует, а не null');
    assert.equal((await request('GET', 'other')).json().recount.amount, 17, 'R318 чужую карточку просмотр не гасит');
    assert.equal((await request('GET', 'human', 'off')).json().recount.amount, 23, 'R318 другой сервер просмотр не гасит');
    f.advance(); // Повтор приходит позже: без IS NULL первая отметка действительно перепишется.
    assert.equal((await request('PATCH', 'human', 'server', { recountSeen: true })).statusCode, 200);
    const [again] = await t.db.select().from(schema.coinRecounts).where(orm.and(
      orm.eq(schema.coinRecounts.serverId, 'server'), orm.eq(schema.coinRecounts.userId, 'human')));
    assert.equal(again.seenAt?.getTime(), seen.seenAt?.getTime(), 'R318 повтор не переписывает первую отметку');
    assert.deepEqual(normal(await t.db.select().from(schema.coinBalances)), beforeBalances, 'R318 отметка и GET не меняют деньги');
    assert.deepEqual(normal(await t.db.select().from(schema.coinLedger)), beforeLedger, 'R318 просмотр не пишет денежный журнал');
  } finally { await app.close(); }
}

test('R318 HTTP: снимок и recountSeen изолированы по человеку и серверу, повтор PATCH безвреден', async () => {
  await httpScenario();
});

test('R318 HTTP контрфакт: повтор просмотра переписывает первую отметку после удаления IS NULL', async () => {
  await httpScenario();
  await counterfact(async () => {
  await assert.rejects(httpScenario([{ file: 'routes/economy',
    from: 'eq(coinRecounts.userId, req.user!.sub), isNull(coinRecounts.seenAt)',
    to: 'eq(coinRecounts.userId, req.user!.sub)' }]),
  e => e instanceof assert.AssertionError && e.message.includes('повтор не переписывает первую отметку'));
  });
});
