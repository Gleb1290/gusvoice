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

// Настоящие миграции, SQL и ВСЕ денежные модули. Подменены только время, транспорт,
// presence и внешняя уборка аккаунта. Мутанты — целые модули в памяти, не записи на диск.
type Edit = { file: string; from: string; to: string };
type DbTx = Parameters<Parameters<TestDb['db']['transaction']>[0]>[0];
type Event = { audience: string[]; message: Record<string, any>; inTransaction: boolean };
const NOW = Date.parse('2026-10-28T12:00:00Z');
const PLAYERS = ['challenger', 'target'] as const;
const INITIAL = 100;
const AMOUNT = 20;
const read = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const killed = (prefix: string) => (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(prefix);
let t: TestDb;
before(async () => {
  t = await createTestDb();
  await t.raw.exec("ALTER TABLE coin_ledger ALTER COLUMN created_at SET DEFAULT '2026-10-28T12:00:00Z'::timestamptz");
});
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

async function drift(q: Pick<TestDb['db'], 'execute'> = t.db) {
  const result = await q.execute(orm.sql`
    SELECT b.user_id, b.balance - COALESCE(SUM(l.amount), 0)::int AS drift
      FROM coin_balances b LEFT JOIN coin_ledger l USING (server_id, user_id)
     GROUP BY b.server_id, b.user_id, b.balance
    HAVING b.balance <> COALESCE(SUM(l.amount), 0)::int
  `);
  assert.deepEqual(result.rows, [], 'R332 удаление: каждый существующий кошелёк равен журналу');
}

async function fixture(edit?: Edit, observe?: (tx: DbTx, boundary: 'refund' | 'anonymize') => Promise<void>) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([...PLAYERS, 'owner', 'spectator'].map(id => ({
    id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true,
  })));
  await t.db.insert(schema.servers).values({ id: 'server', name: 'Дуэли', ownerId: 'owner' });
  await t.db.insert(schema.channels).values({ id: 'voice', serverId: 'server', name: 'Кубики', type: 'voice' });
  await t.db.insert(schema.serverMembers).values([...PLAYERS, 'owner', 'spectator'].map(userId => ({ serverId: 'server', userId })));
  await t.db.insert(schema.serverEconomy).values({
    serverId: 'server', enabled: true, gamesEnabled: true, gamesBetMax: 300, gamesDailyLossMax: 0, gamesFeePercent: 10,
  });
  await t.db.insert(schema.coinBalances).values(PLAYERS.map(userId => ({ serverId: 'server', userId, balance: INITIAL })));
  await t.db.insert(schema.coinLedger).values(PLAYERS.map(userId => ({
    id: crypto.randomUUID(), serverId: 'server', userId, amount: INITIAL, reason: 'fixture',
  })));
  let transactionDepth = 0;
  const events: Event[] = [];
  const warnings: string[] = [];
  // Это наблюдение факта коммита, а не подмена SQL: реальная транзакция остаётся PGlite.
  const db = new Proxy(t.db, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return async (work: (tx: DbTx) => Promise<unknown>) => {
        transactionDepth++;
        try { return await target.transaction(work); } finally { transactionDepth--; }
      };
    },
  });
  const emit = async (audience: string[], message: Record<string, any>) => {
    events.push({ audience: [...audience], message: normal(message), inTransaction: transactionDepth > 0 });
  };
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? NOW : value instanceof Date ? value.getTime() : value); }
    static override now() { return NOW; }
  }
  const noop = async () => {};
  const values: Record<string, unknown> = {
    'db/index': { db }, 'db/schema': schema, util: { id: crypto.randomUUID },
    env: { env: { economyPreviewUsers: [] } },
    realtime: {
      publishToUser: (id: string, message: Record<string, any>) => emit([id], message), publishToServer: noop,
      publishToChannel: (_server: string, _channel: string, message: Record<string, any>, audience: string[]) => emit(audience, message),
      redisPub: { set: async () => 'OK', eval: async () => 1, pttl: async () => -2 },
    },
    voicePresence: { inVoiceChannel: async () => true, voiceParticipantIds: async () => ['spectator'] },
    auth: { hashPassword: async () => 'synthetic-unusable-password', forgetTokenGeneration() {} },
    activity: { clearActivity: noop }, attachments: { purgeDeletedOf: noop },
    memberEvents: { memberChanged: noop }, conversations: { deliverMany: noop, journalForwardedFrom: async () => [] },
    'bots/botLifecycle': { deleteBotsOwnedBy: noop },
    'federation/directoryEvents': { announceUser: noop }, 'federation/guestRevocation': { revokeAccountEverywhere: noop },
    gateway: { broadcastUserProfile: noop }, gifs: { savedGifKeysOf: async () => [], removeGifFiles: noop },
    storage: { removeUserAvatars: noop }, livekit: { removeFromOtherRooms: noop },
  };
  const files = new Set(['coins', 'coinRules', 'streakRules', 'economyDefaults', 'gameMoney', 'gameMoneyRules',
    'gameDuel', 'gameDuelRules', 'accountDelete', 'accountRows', 'accountRules']);
  const modules = new Map<string, Record<string, any>>();
  function load<T>(name: string): T {
    if (Object.hasOwn(values, name)) return values[name] as T;
    if (modules.has(name)) return modules.get(name) as T;
    assert.ok(files.has(name), `R332 setup: закрытый импорт ${name}`);
    let source = read(name);
    if (edit?.file === name) {
      assert.equal(source.split(edit.from).length, 2, 'R332 setup: уникальный якорь whole-module мутанта');
      source = source.replace(edit.from, edit.to);
    }
    const module = { exports: {} as Record<string, any> };
    modules.set(name, module.exports);
    runInNewContext(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer, Error,
      console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
      require(id: string) {
        if (id === 'drizzle-orm') return orm;
        if (id === '@gusvoice/shared') return shared;
        if (id === 'node:crypto') return crypto;
        assert.ok(id.startsWith('.'), `R332 setup: внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
      },
    });
    // Наблюдатели сохраняют настоящие реализации и вызывают их после проверки границы.
    if (observe && (name === 'gameMoney' || name === 'accountRows')) {
      const fn = name === 'gameMoney' ? 'refundOpenStakesOf' : 'anonymizeAccountRows';
      const original = module.exports[fn];
      module.exports[fn] = async (tx: DbTx, ...args: unknown[]) => {
        await observe(tx, name === 'gameMoney' ? 'refund' : 'anonymize');
        return original(tx, ...args);
      };
    }
    return module.exports as T;
  }
  // Настоящий gameDuel подключает announcer; подставной callback скрыл бы проблемы DTO/адресатов.
  const duel = load<typeof import('../src/gameDuel.js')>('gameDuel');
  return { duel, load, events, warnings };
}

async function deletionScenario(state: 'open' | 'locked', deleted: typeof PLAYERS[number], edit?: Edit) {
  const survivor = deleted === 'challenger' ? 'target' : 'challenger';
  let roundId = '';
  const observed: string[] = [];
  const f = await fixture(edit, async (tx, boundary) => {
    observed.push(boundary);
    const prefix = boundary === 'refund' ? 'R332 удаление до refundOpenStakesOf:' : 'R332 удаление до обезличивания:';
    const [row] = await tx.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, roundId));
    assert.equal(row.state, 'cancelled', `${prefix} живая дуэль уже отменена`);
    assert.equal(row.data.reason, 'player-deleted', `${prefix} причина удаления уже записана`);
    const stakes = await tx.select().from(schema.gameStakes);
    const refunds = await tx.select().from(schema.coinLedger).where(orm.eq(schema.coinLedger.reason, 'duel.refund'));
    assert.equal(stakes.length, state === 'locked' ? 2 : 0, `${prefix} обе настоящие ставки сохранены`);
    assert.equal(refunds.length, state === 'locked' ? 2 : 0, `${prefix} возврат записан ОБОИМ, не только удаляемому`);
    for (const userId of PLAYERS) {
      const [wallet] = await tx.select().from(schema.coinBalances).where(orm.eq(schema.coinBalances.userId, userId));
      assert.equal(wallet.balance, INITIAL, `${prefix} кошелёк ${userId} восстановлен`);
      if (state === 'locked') {
        const stake = stakes.find(s => s.userId === userId)!;
        assert.ok(stake.refundedAt, `${prefix} refunded_at ${userId} записан`);
        assert.equal(stake.paidAt, null);
        assert.equal(refunds.find(r => r.userId === userId)?.amount, AMOUNT);
      }
    }
    const [user] = await tx.select().from(schema.users).where(orm.eq(schema.users.id, deleted));
    assert.equal(user.deletedAt, null, `${prefix} аккаунт пока жив`);
    assert.equal(user.displayName, deleted);
    await drift(tx);
  });
  const invited = await f.duel.challengeDuel({
    serverId: 'server', channelId: 'voice', challengerId: 'challenger', targetId: 'target', game: 'dice', amount: AMOUNT,
  });
  assert.ok(invited.ok && invited.duel, 'R332 setup: настоящий вызов создан');
  roundId = invited.duel.id;
  assert.equal(invited.duel.seed, null, 'R332 удаление: зерно приглашения скрыто');
  if (state === 'locked') {
    const accepted = await f.duel.acceptDuel('server', roundId, 'target');
    assert.ok(accepted.ok && accepted.duel?.state === 'playing', 'R332 setup: обе ставки приняты');
    const stakes = await t.db.select().from(schema.gameStakes);
    assert.equal(stakes.length, 2);
    const debits = await t.db.select().from(schema.coinLedger).where(orm.eq(schema.coinLedger.reason, 'duel.stake'));
    assert.equal(debits.length, 2, 'R332 setup: две реальные проводки эскроу, а не выдуманная одна ставка');
    for (const userId of PLAYERS) {
      assert.equal(stakes.find(s => s.userId === userId)?.amount, AMOUNT);
      assert.equal(debits.find(s => s.userId === userId)?.amount, -AMOUNT);
      assert.equal(debits.find(s => s.userId === userId)?.refUserId, userId === 'target' ? 'challenger' : 'target');
    }
  } else {
    assert.equal((await t.db.select().from(schema.gameStakes)).length, 0, 'R332 setup: непринятый вызов без эскроу');
  }
  await drift();
  const [privateRound] = await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, roundId));
  const seed = privateRound.data.seed;
  assert.equal(typeof seed, 'string');
  f.events.length = 0;
  await f.load<typeof import('../src/accountDelete.js')>('accountDelete').anonymizeAccount(deleted);
  assert.deepEqual(observed, ['refund', 'anonymize'], 'R332 удаление: проверены обе границы настоящего удаления');
  const [user] = await t.db.select().from(schema.users).where(orm.eq(schema.users.id, deleted));
  assert.ok(user.deletedAt); assert.equal(user.displayName, 'Удалённый пользователь'); assert.equal(user.tokenGeneration, 1);
  const wallets = await t.db.select().from(schema.coinBalances);
  assert.equal(wallets.some(w => w.userId === deleted), false, 'R332 удаление: accountRows действительно удалил личный кошелёк');
  assert.equal(wallets.find(w => w.userId === survivor)?.balance, INITIAL);
  const [cancelled] = await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, roundId));
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.data.reason, 'player-deleted');
  assert.equal(cancelled.createdBy, 'challenger', 'R332 удаление: автор раунда остаётся историей');
  const retainedStakes = await t.db.select().from(schema.gameStakes);
  const retainedRefunds = await t.db.select().from(schema.coinLedger).where(orm.eq(schema.coinLedger.reason, 'duel.refund'));
  assert.equal(retainedStakes.length, state === 'locked' ? 2 : 0, 'R332 удаление: обе ставки остаются историей после accountRows');
  assert.equal(retainedRefunds.length, state === 'locked' ? 2 : 0, 'R332 удаление: обе проводки возврата пережили accountRows');
  for (const userId of PLAYERS) if (state === 'locked') {
    const stake = retainedStakes.find(s => s.userId === userId)!;
    assert.ok(stake.refundedAt); assert.equal(stake.paidAt, null);
    assert.equal(retainedRefunds.find(r => r.userId === userId)?.amount, AMOUNT);
  }
  const walletEvents = f.events.filter(e => e.message.t === 'economy.wallet');
  assert.equal(walletEvents.length, state === 'locked' ? 1 : 0, 'R332 удаление: обновление только живому возвращённому кошельку');
  if (state === 'locked') {
    assert.deepEqual(walletEvents[0].audience, [survivor]);
    assert.equal(walletEvents[0].message.balance, INITIAL);
  }
  const states = f.events.filter(e => e.message.t === 'duel.state');
  assert.equal(states.filter(e => e.audience.includes(survivor)).length, 1, 'R332 удаление: живой соперник получил отмену');
  for (const event of states) {
    assert.equal(event.message.duel.id, roundId);
    assert.equal(event.message.duel.state, 'cancelled');
    assert.equal(event.message.duel.reason, 'player-deleted');
    assert.equal(event.message.duel.seed, null, 'R332 удаление: отмена не раскрывает зерно');
    assert.equal('data' in event.message.duel, false);
    assert.equal(JSON.stringify(event.message).includes(String(seed)), false, 'R332 удаление: секрет не утёк в событие');
    assert.deepEqual(event.message.duel.rolls, state === 'locked' ? [{ challenger: null, target: null }] : []);
    if (state === 'open') assert.equal(event.audience.includes('spectator'), false, 'R332 удаление: личный вызов не видят зрители');
    else assert.ok(event.audience.includes('spectator'), 'R332 удаление: отмену партии видит голосовой канал');
  }
  assert.ok(f.events.every(e => !e.inTransaction), 'R332 удаление: кошелёк и состояние опубликованы только после коммита');
  assert.deepEqual(f.warnings, [], 'R332 удаление: внешняя уборка не спрятала ошибку');
  const beforeTick = normal(await t.db.select().from(schema.coinLedger));
  await f.duel.runDuelTick(new Date(NOW + 120_000));
  assert.deepEqual(normal(await t.db.select().from(schema.coinLedger)), beforeTick, 'R332 удаление: поздний такт не платит отменённую дуэль');
  await drift();
}

const CANCEL = '    duels = await cancelDuelsOf(tx, userId);';
const REFUND = '    await refundOpenStakesOf(tx, userId);';
// Этап 5 вставил отмену событий между этими вызовами. Переставляем только дуэли,
// сохраняя настоящую отмену предсказаний и её положение до общего возврата.
const PREDICTIONS = `    // Ставки на события (этап 5): его живые события — отмена с возвратом ВСЕМ (итог подводит только он, без него эскроу
    // висел бы до автоотмены). Тоже до \`refundOpenStakesOf\`.
    predictions = await cancelPredictionsOf(tx, userId);`;
const DELETION_MUTANTS: readonly Edit[] = [
  { file: 'accountDelete', from: CANCEL, to: '' },
  { file: 'accountDelete', from: `${CANCEL}\n${PREDICTIONS}\n${REFUND}`, to: `${PREDICTIONS}\n${REFUND}\n${CANCEL}` },
];
for (const state of ['locked', 'open'] as const) for (const deleted of PLAYERS) {
  test(`R332 удаление ${deleted}: ${state === 'locked' ? 'обе ставки возвращены' : 'вызов без ставок отменён'}, живой соперник уведомлён; два контрфакта`, async () => {
    // Финальный SQL при перестановке мог бы совпасть. Поэтому проверяем честный вызов
    // real refundOpenStakesOf: обе ставки и отмена УЖЕ должны существовать перед ним.
    await deletionScenario(state, deleted);
    for (const edit of DELETION_MUTANTS) {
      await counterfact(async () => {
      const original = read('accountDelete');
      await assert.rejects(deletionScenario(state, deleted, edit), killed('R332 удаление до refundOpenStakesOf:'));
      assert.equal(read('accountDelete'), original, 'R332 мутант не записывался на диск');
      });
      await deletionScenario(state, deleted);
    }
  });
}
