import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as zod from 'zod';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import { seasonId } from '../src/coinRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

// Целые production-модули + настоящий SQL. Заглушены только авторизация и внешние IO.
type Edit = { file: string; from: string; to: string };
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });
const normal = <T>(v: T): T => JSON.parse(JSON.stringify(v));
async function fixture(edit?: Edit) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    { id: 'human', username: 'human', displayName: 'Человек', passwordHash: 'fixture', verified: true },
    { id: 'other', username: 'other', displayName: 'Другой', passwordHash: 'fixture', verified: false },
    { id: 'bot', username: 'fixturebot', displayName: 'Бот', passwordHash: 'fixture', verified: false, bot: true },
    { id: 'verified-bot', username: 'verifiedbot', displayName: 'Проверенный бот', passwordHash: 'fixture', verified: true, bot: true },
  ]);
  await t.db.insert(schema.servers).values({ id: 'server', name: 'Сервер', ownerId: 'human' });
  await t.db.insert(schema.channels).values({ id: 'voice', serverId: 'server', name: 'Голос', type: 'voice' });
  await t.db.insert(schema.serverMembers).values(['human', 'other', 'bot', 'verified-bot'].map(userId => ({ serverId: 'server', userId })));
  await t.db.insert(schema.serverEconomy).values({ serverId: 'server', enabled: true, payoutMinutes: 1,
    ratePer5min: 100, alonePercent: 100, companyPercent: 100, streakBonus: 0,
    closedSeasonId: seasonId(new Date()) });
  const cooldowns = new Map<string, string>(); const cooldownWrites: string[] = [];
  let clock = Date.now();
  class TestDate extends Date { static override now() { return clock; } }
  const events: unknown[] = []; const errors: string[] = [];
  const noop = async () => {};
  const fail = () => { throw new Error('неожиданный внешний IO'); };
  const values: Record<string, unknown> = {
    'db/index': { db: t.db }, 'db/schema': schema,
    env: { env: { economyPreviewUsers: [] } }, util: { id: randomUUID },
    auth: { requireAuth: async (req: { user: unknown }) => { req.user = { sub: 'human' }; } },
    permissions: { getMemberContext: async () => ({ serverPermissions: shared.Permission.MANAGE_ECONOMY }),
      getChannelPermissions: async () => ({ permissions: shared.Permission.CONNECT, serverId: 'server' }) },
    audit: { writeAudit: noop },
    realtime: { publishToUser: async (...args: unknown[]) => { events.push(args); }, publishToServer: noop,
      publishToChannel: noop, redisPub: { exists: async (key: string) => Number(cooldowns.has(key)),
        smembers: async () => ['voice'], pipeline: () => ({ get() {}, exec: async () => [[null,
          JSON.stringify(['human', 'other', 'bot'].map(userId => ({ userId, displayName: userId, avatarUrl: null,
            muted: false, serverMuted: false, deafened: false, speaking: false, screensharing: false, camera: false })))]] }),
        set: async (key: string, value: string) => { cooldownWrites.push(key); cooldowns.set(key, value); return 'OK'; },
        del: async (key: string) => Number(cooldowns.delete(key)) } },
    voicePresence: { inVoiceChannel: async () => true, voiceParticipantIds: async () => ['human', 'other', 'bot'] }, livekit: {},
    shop: { shopFor: async () => [], receivedToday: async () => 0 }, purchase: { buyItem: fail },
    instanceSettings: { avatarPriceMinutes: async () => 1, avatarRentalMaxDays: async () => 1 },
    storage: { putMedia: fail, storageConfigured: () => false },
  };
  const files = new Set(['coins', 'coinRules', 'streakRules', 'seasons', 'economyDefaults', 'gooseRules',
    'voiceActivityRules', 'levelRules', 'shopRules', 'tipRules', 'pokeRules', 'voiceRules', 'transferCoins',
    'routes/economy', 'routes/voice', 'voiceActivity']);
  const modules = new Map<string, any>();
  function load(name: string): any {
    if (Object.hasOwn(values, name)) return values[name];
    if (modules.has(name)) return modules.get(name);
    assert.ok(files.has(name), `закрытый импорт ${name}`);
    let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    if (edit?.file === name) { assert.equal(source.split(edit.from).length, 2, 'уникальный якорь'); source = source.replace(edit.from, edit.to); }
    if (name === 'voiceActivity') source += '\nexport { tick as __tick };\n';
    const module = { exports: {} }; modules.set(name, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, Date: TestDate, Buffer, setTimeout, clearTimeout,
        console: { log() {}, error: (...args: unknown[]) => { errors.push(args.join(' ')); } },
        require(id: string) {
          if (id === '@gusvoice/shared') return shared;
          if (id === 'drizzle-orm') return orm;
          if (id === 'zod') return zod;
          assert.ok(id.startsWith('.'), `внешний импорт ${id}`);
          return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
        } });
    return module.exports;
  }
  const coins = load('coins') as typeof import('../src/coins.js');
  const seasons = load('seasons') as typeof import('../src/seasons.js');
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => { errors.push(String(error)); reply.code(500).send({ error: String(error) }); });
  await app.register(load('routes/economy').economyRoutes);
  await app.register(load('routes/voice').voiceRoutes); await app.ready();
  return { coins, seasons, app, cooldowns, cooldownWrites, events, errors, load,
    advance: () => { clock += 60_000; } };
}

async function walletScenario(kind: 'voice' | 'retro' | 'goose', edit?: Edit) {
  const f = await fixture(edit);
  try {
    const economy = (await f.coins.economyOf('server'))!;
    const pay = (userId: string) => kind === 'voice' ? f.coins.creditVoice({ serverId: 'server', userId, economy,
      now: new Date(), sample: { seconds: 300, peers: 1, muted: false, deafened: false, away: false } })
      : kind === 'goose' ? f.coins.claimGooseBonus('server', userId, 50)
        : t.db.transaction(tx => f.coins.applyCoins(tx as never, { serverId: 'server', userId, amount: 50, reason: 'retro', countsAsEarned: true }));
    for (const userId of ['bot', 'verified-bot']) {
      const amount = await pay(userId);
      const wallets = await t.db.select().from(schema.coinBalances).where(orm.eq(schema.coinBalances.userId, userId));
      const ledger = await t.db.select().from(schema.coinLedger).where(orm.eq(schema.coinLedger.userId, userId));
      assert.equal(amount, 0, 'боту не начисляют'); assert.equal(wallets.length, 0, 'боту даже пустой кошелёк не заводят');
      assert.equal(ledger.length, 0, 'боту не пишут журнал');
    }
    for (const userId of ['human', 'other']) {
      assert.ok(await pay(userId) > 0, 'человеку начисляют независимо от verified');
      assert.equal((await t.db.select().from(schema.coinBalances).where(orm.eq(schema.coinBalances.userId, userId))).length, 1);
      assert.equal((await t.db.select().from(schema.coinLedger).where(orm.eq(schema.coinLedger.userId, userId))).length, 1);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.app.close(); }
}
const walletEdits: [string, Edit][] = [
  ['убрана проверка', { file: 'coins', from: 'if (await isBotUser(tx, userId)) return undefined;', to: '' }],
  ['verified вместо bot', { file: 'coins', from: 'select({ bot: users.bot })', to: 'select({ bot: users.verified })' }],
  ['проверка после вставки', { file: 'coins',
    from: 'if (await isBotUser(tx, userId)) return undefined;\n  await tx.insert(coinBalances).values({ serverId, userId }).onConflictDoNothing();',
    to: 'await tx.insert(coinBalances).values({ serverId, userId }).onConflictDoNothing();\n  if (await isBotUser(tx, userId)) return undefined;' }],
];
for (const kind of ['voice', 'retro', 'goose'] as const) {
  test(`R304 ${kind}: бот без кошелька и журнала, человек получает монеты`, () => walletScenario(kind));
  for (const [name, edit] of walletEdits) test(`R304 ${kind}: контрфакт ${name}`, async () => {
    await walletScenario(kind);
    await assert.rejects(walletScenario(kind, edit), e => e instanceof assert.AssertionError && /боту|человеку/.test(e.message));
  });
}

async function selectionScenario(kind: 'leaderboard' | 'crown' | 'retro' | 'raise', edit?: Edit) {
  const f = await fixture(edit);
  try {
    await t.db.insert(schema.coinBalances).values(['human', 'bot'].map(userId => ({ serverId: 'server', userId,
      balance: userId === 'bot' ? 1000 : 100, seasonEarned: userId === 'bot' ? 1000 : 100,
      earnedTotal: userId === 'bot' ? 1000 : 100, seasonId: seasonId(new Date()) })));
    if (kind === 'leaderboard') {
      const response = await f.app.inject({ method: 'GET', url: '/servers/server/economy/leaderboard' });
      assert.equal(response.statusCode, 200); assert.deepEqual(response.json().people.map((p: any) => p.userId), ['human'], 'лидерборд без бота');
    } else if (kind === 'crown') {
      await t.db.update(schema.serverEconomy).set({ seasonLength: 'month', closedSeasonId: 'm2026-09' });
      await t.db.insert(schema.coinLedger).values(['human', 'bot'].map(userId => ({ id: randomUUID(), serverId: 'server', userId,
        amount: userId === 'bot' ? 1000 : 100, reason: 'voice', createdAt: new Date('2026-09-15T12:00:00Z') })));
      assert.equal(await f.seasons.closeSeasonIfNeeded('server', new Date('2026-10-01T12:00:00Z')), 'm2026-09');
      const rows = await t.db.select().from(schema.seasonResults);
      assert.deepEqual(rows.map(r => [r.userId, r.place, r.earned]), [['human', 1, 100]], 'замороженные места без бота');
      const holder = await f.seasons.crownHolder('server', rows[0].frozenAt, 'month');
      assert.equal(holder?.userId, 'human');
    } else if (kind === 'retro') {
      await t.db.insert(schema.voiceActivity).values(['human', 'bot'].map(userId => ({ id: randomUUID(), serverId: 'server', userId,
        channelId: 'voice', seconds: 300, peers: 1, createdAt: new Date(Date.now() - 60_000) })));
      const response = await f.app.inject({ method: 'POST', url: '/servers/server/economy/retro/preview', payload: {} });
      assert.equal(response.statusCode, 200); assert.deepEqual(response.json().people.map((p: any) => p.userId), ['human'], 'ретро без бота');
      assert.ok(response.json().granted > 0);
    } else {
      const response = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy', payload: { ratePer5min: 200, compensateOnRaise: true } });
      assert.equal(response.statusCode, 200);
      const ledger = await t.db.select().from(schema.coinLedger);
      assert.deepEqual(ledger.map(r => [r.userId, r.amount, r.reason]), [['human', 100, 'rescale']]);
      // Даже lockWallet не спасает сумму/список уведомлений ошибочной выборки: проверяем ответ тоже.
      assert.equal(response.json().compensated, 100, 'компенсация считает только человека');
      assert.equal((await f.coins.walletOf('server', 'bot')).balance, 1000);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.app.close(); }
}
const selectionEdits: Record<'leaderboard' | 'crown' | 'retro' | 'raise', Edit> = {
  leaderboard: { file: 'routes/economy', from: 'eq(coinBalances.optedOut, false),\n          // Боты и строки вебхуков (`users.bot`) — не люди, в таблице их нет (gitea #231).\n          eq(users.bot, false),', to: 'eq(coinBalances.optedOut, false),' },
  crown: { file: 'seasons', from: 'eq(users.bot, false),', to: '' },
  retro: { file: 'routes/economy', from: 'and(eq(serverMembers.serverId, serverId), eq(users.bot, false))', to: 'eq(serverMembers.serverId, serverId)' },
  raise: { file: 'routes/economy', from: 'and(eq(coinBalances.serverId, serverId), gt(coinBalances.balance, 0), eq(users.bot, false))', to: 'and(eq(coinBalances.serverId, serverId), gt(coinBalances.balance, 0))' },
};
for (const kind of ['leaderboard', 'crown', 'retro', 'raise'] as const) {
  test(`R304 ${kind}: выборка исключает бота с большей суммой и сохраняет человека`, () => selectionScenario(kind));
  test(`R304 ${kind}: контрфакт убран фильтр users.bot`, async () => {
    await selectionScenario(kind);
    await assert.rejects(selectionScenario(kind, selectionEdits[kind]), e => e instanceof assert.AssertionError && /бота|только человека/.test(e.message));
  });
}

async function tipScenario(edit?: Edit) {
  const f = await fixture(edit);
  try {
    await t.db.insert(schema.coinBalances).values({ serverId: 'server', userId: 'human', balance: 100 });
    const before = normal(await t.db.select().from(schema.coinBalances));
    const response = await f.app.inject({ method: 'POST', url: '/channels/voice/voice/bot/tip', payload: {} });
    assert.equal(response.statusCode, 403, 'тип боту запрещён');
    assert.deepEqual(normal(await t.db.select().from(schema.coinBalances)), before, 'балансы не тронуты');
    assert.equal((await t.db.select().from(schema.coinLedger)).length, 0);
    assert.deepEqual(f.cooldownWrites, [], 'кулдаун не расходуется');
    const accepted = await f.app.inject({ method: 'POST', url: '/channels/voice/voice/other/tip', payload: {} });
    assert.equal(accepted.statusCode, 200, 'человеку тип разрешён');
    assert.ok((await f.coins.walletOf('server', 'human')).balance < 100);
    assert.ok((await f.coins.walletOf('server', 'other')).balance > 0);
    assert.equal(f.cooldownWrites.length, 1); assert.deepEqual(f.errors, []);
  } finally { await f.app.close(); }
}
test('R304 HTTP тип боту: 403 без баланса, журнала и кулдауна; человеку проходит', () => tipScenario());
test('R304 HTTP тип: контрфакт бот не входит в targetOptedOut', async () => {
  await tipScenario();
  await assert.rejects(tipScenario({ file: 'routes/voice', from: 'theirs.optedOut || theirs.tipsOptOut || targetIsBot',
    to: 'theirs.optedOut || theirs.tipsOptOut' }), e => e instanceof assert.AssertionError && e.message.includes('тип боту запрещён'));
});

async function collectorScenario(edit?: Edit) {
  const f = await fixture(edit);
  try {
    const collector = f.load('voiceActivity') as { __tick(): Promise<void> };
    await collector.__tick(); f.advance(); await collector.__tick();
    const rows = await t.db.select().from(schema.voiceActivity).orderBy(schema.voiceActivity.userId);
    assert.deepEqual(rows.map(r => [r.userId, r.peers]), [['human', 1], ['other', 1]], 'фильтр до planSamples не увеличивает компанию людям');
    assert.deepEqual(f.errors, []);
  } finally { await f.app.close(); }
}
test('R304 настоящий сборщик пишет двух людей с peers=1 и ни одной строки бота', () => collectorScenario());
test('R304 контрфакт: фильтр ботов после planSamples уже завысил peers людям', async () => {
  await collectorScenario();
  await assert.rejects(collectorScenario({ file: 'voiceActivity',
    from: 'const { samples, cursors: nextCursors, duplicates } = planSamples(channelSnapshots, cursors, now, away);',
    to: 'const planned = planSamples(rawSnapshots, cursors, now, away);\n  const { cursors: nextCursors, duplicates } = planned;\n  const samples = planned.samples.filter(s => !bots.has(s.userId));' }),
    e => e instanceof assert.AssertionError && e.message.includes('фильтр до planSamples'));
});
