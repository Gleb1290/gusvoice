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

// R333: настоящий deleteAccount/anonymizeAccountRows и деньги на миграциях PGlite.
// Важно проверить границы ДО generic refund/обезличивания: одинаковое финальное SQL
// при неверном порядке не доказывает, что обе ставки уже были возвращены вовремя.
type Edit = { file: string; changes: Array<{ from: string; to: string }> };
type DbTx = Parameters<Parameters<TestDb['db']['transaction']>[0]>[0];
type Event = { audience: string[]; message: Record<string, any>; inTransaction: boolean };
const NOW = Date.parse('2026-10-28T12:00:00Z');
const PLAYERS = ['challenger', 'target'] as const;
const INITIAL = 100;
const AMOUNT = 20;
const read = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let t: TestDb;
before(async () => {
  t = await createTestDb();
  await t.raw.exec("ALTER TABLE coin_ledger ALTER COLUMN created_at SET DEFAULT '2026-10-28T12:00:00Z'::timestamptz");
});
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

async function drift(q: Pick<TestDb['db'], 'execute'> = t.db) {
  const result = await q.execute(orm.sql`
    SELECT b.user_id FROM coin_balances b LEFT JOIN coin_ledger l USING (server_id, user_id)
    GROUP BY b.server_id,b.user_id,b.balance HAVING b.balance <> COALESCE(SUM(l.amount),0)::int
  `);
  assert.deepEqual(result.rows, [], 'R333 удаление: drift 0 у всех существующих кошельков');
}

async function fixture(edit: Edit | undefined, observe: (tx: DbTx, boundary: 'refund' | 'anonymize') => Promise<void>) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([...PLAYERS, 'owner', 'spectator'].map(id => ({
    id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true,
  })));
  await t.db.insert(schema.servers).values({ id: 'server', name: 'Выбор', ownerId: 'owner' });
  await t.db.insert(schema.channels).values({ id: 'voice', serverId: 'server', name: 'Игра', type: 'voice' });
  await t.db.insert(schema.serverMembers).values([...PLAYERS, 'owner', 'spectator'].map(userId => ({ serverId: 'server', userId })));
  await t.db.insert(schema.serverEconomy).values({ serverId: 'server', enabled: true, gamesEnabled: true,
    gamesBetMax: 300, gamesDailyLossMax: 0, gamesFeePercent: 10, gamesPairDailyMax: 1000 });
  await t.db.insert(schema.coinBalances).values(PLAYERS.map(userId => ({ serverId: 'server', userId, balance: INITIAL })));
  await t.db.insert(schema.coinLedger).values(PLAYERS.map(userId => ({
    id: crypto.randomUUID(), serverId: 'server', userId, amount: INITIAL, reason: 'fixture',
  })));
  let depth = 0;
  const events: Event[] = [];
  const warnings: string[] = [];
  const db = new Proxy(t.db, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return async (work: (tx: DbTx) => Promise<unknown>) => {
        depth++; try { return await target.transaction(work); } finally { depth--; }
      };
    },
  });
  const emit = async (audience: string[], message: Record<string, any>) => {
    events.push({ audience: [...audience], message: normal(message), inTransaction: depth > 0 });
  };
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? NOW : value instanceof Date ? value.getTime() : value); }
    static override now() { return NOW; }
  }
  const noop = async () => {};
  const values: Record<string, unknown> = {
    'db/index': { db }, 'db/schema': schema, util: { id: crypto.randomUUID }, env: { env: { economyPreviewUsers: [] } },
    realtime: {
      publishToUser: (id: string, message: Record<string, any>) => emit([id], message), publishToServer: noop,
      publishToChannel: (_server: string, _channel: string, message: Record<string, any>, audience: string[]) => emit(audience, message),
      redisPub: { get: async () => null, set: async () => 'OK', eval: async () => 1, pttl: async () => -2 },
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
    assert.ok(files.has(name), `R333 setup: закрытый импорт ${name}`);
    let source = read(name);
    if (edit?.file === name) for (const change of edit.changes) {
      assert.equal(source.split(change.from).length, 2, 'R333 setup: уникальный якорь whole-module мутанта');
      source = source.replace(change.from, change.to);
    }
    const module = { exports: {} as Record<string, any> }; modules.set(name, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer, Error,
      console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
      require(id: string) {
        if (id === 'drizzle-orm') return orm;
        if (id === '@gusvoice/shared') return shared;
        if (id === 'node:crypto') return { ...crypto, randomBytes: (size: number) => Buffer.alloc(size, 3) };
        assert.ok(id.startsWith('.'), `R333 setup: внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
      },
    });
    // Наблюдение перед настоящей функцией, не замена её поведения.
    if (name === 'gameMoney' || name === 'accountRows') {
      const fn = name === 'gameMoney' ? 'refundOpenStakesOf' : 'anonymizeAccountRows';
      const original = module.exports[fn];
      module.exports[fn] = async (tx: DbTx, ...args: unknown[]) => {
        await observe(tx, name === 'gameMoney' ? 'refund' : 'anonymize'); return original(tx, ...args);
      };
    }
    return module.exports as T;
  }
  // Именно настоящий модуль подключает announcer и формирует безопасный DTO отмены.
  return { duel: load<typeof import('../src/gameDuel.js')>('gameDuel'), load, events, warnings };
}

async function scenario(game: 'rps' | 'greedy', deleted: typeof PLAYERS[number], edit?: Edit) {
  const survivor = deleted === 'challenger' ? 'target' : 'challenger';
  let roundId = '';
  let savedMoves: unknown;
  const observed: string[] = [];
  const f = await fixture(edit, async (tx, boundary) => {
    observed.push(boundary);
    const prefix = boundary === 'refund' ? 'R333 удаление до refundOpenStakesOf:' : 'R333 удаление до обезличивания:';
    const [round] = await tx.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, roundId));
    assert.equal(round.state, 'cancelled', `${prefix} партия уже отменена`);
    assert.equal(round.data.reason, 'player-deleted', `${prefix} причина удаления уже записана`);
    const stakes = await tx.select().from(schema.gameStakes);
    const refunds = await tx.select().from(schema.coinLedger).where(orm.eq(schema.coinLedger.reason, 'duel.refund'));
    assert.equal(stakes.length, 2, `${prefix} обе ставки на месте`);
    assert.equal(refunds.length, 2, `${prefix} ОБА возврата уже записаны`);
    for (const id of PLAYERS) {
      const [wallet] = await tx.select().from(schema.coinBalances).where(orm.eq(schema.coinBalances.userId, id));
      assert.equal(wallet.balance, INITIAL, `${prefix} кошелёк ${id} восстановлен`);
      assert.equal(refunds.find(r => r.userId === id)?.amount, AMOUNT, `${prefix} ${id} получил свою ставку`);
      assert.ok(stakes.find(s => s.userId === id)?.refundedAt, `${prefix} ${id} отмечен refunded`);
      assert.equal(stakes.find(s => s.userId === id)?.paidAt, null);
    }
    assert.deepEqual(normal(await tx.select().from(schema.gameMoves)), savedMoves, `${prefix} ходы сохранены историей`);
    const [user] = await tx.select().from(schema.users).where(orm.eq(schema.users.id, deleted));
    assert.equal(user.deletedAt, null, `${prefix} аккаунт пока не обезличен`);
    assert.equal(user.displayName, deleted, `${prefix} исходное имя ещё на месте`);
    await drift(tx);
  });
  const invited = await f.duel.challengeDuel({ serverId: 'server', channelId: 'voice',
    challengerId: 'challenger', targetId: 'target', game, amount: AMOUNT });
  assert.ok(invited.ok && invited.duel, 'R333 setup: настоящий выборный вызов создан');
  roundId = invited.duel.id;
  const accepted = await f.duel.acceptDuel('server', roundId, 'target');
  assert.ok(accepted.ok && accepted.duel?.state === 'playing', 'R333 setup: обе ставки приняты');
  // Удаление посреди именно партии С ХОДАМИ, а не варианта dice без единого game_moves.
  const actor = game === 'rps' ? 'challenger' : accepted.duel.greedy!.turn === 'challenger' ? 'challenger' : 'target';
  const moved = await f.duel.moveDuel('server', roundId, actor, 0, game === 'rps' ? 'rock' : 'roll');
  assert.ok(moved.ok && moved.duel?.state === 'playing', 'R333 setup: настоящий выборный ход записан');
  savedMoves = normal(await t.db.select().from(schema.gameMoves));
  assert.equal((savedMoves as unknown[]).length, 1, 'R333 setup: до удаления есть один настоящий ход');
  const stakes = await t.db.select().from(schema.gameStakes);
  assert.equal(stakes.length, 2, 'R333 setup: есть два эскроу');
  const debits = await t.db.select().from(schema.coinLedger).where(orm.eq(schema.coinLedger.reason, 'duel.stake'));
  assert.equal(debits.length, 2, 'R333 setup: есть две настоящие проводки');
  const [privateRound] = await t.db.select().from(schema.gameRounds);
  const seed = privateRound.data.seed;
  assert.equal(typeof seed, 'string', 'R333 setup: зерно существует только на сервере');
  await drift(); f.events.length = 0;
  await f.load<typeof import('../src/accountDelete.js')>('accountDelete').anonymizeAccount(deleted);
  assert.deepEqual(observed, ['refund', 'anonymize'], 'R333 удаление: проверены обе границы');
  const [user] = await t.db.select().from(schema.users).where(orm.eq(schema.users.id, deleted));
  assert.ok(user.deletedAt, 'R333 удаление: настоящее обезличивание выполнено');
  assert.equal(user.displayName, 'Удалённый пользователь'); assert.equal(user.tokenGeneration, 1);
  const wallets = await t.db.select().from(schema.coinBalances);
  assert.equal(wallets.some(w => w.userId === deleted), false, 'R333 удаление: личный кошелёк удалён настоящим accountRows');
  assert.equal(wallets.find(w => w.userId === survivor)?.balance, INITIAL, 'R333 удаление: кошелёк оставшегося восстановлен');
  const [round] = await t.db.select().from(schema.gameRounds);
  assert.equal(round.state, 'cancelled', 'R333 удаление: отмена пережила транзакцию');
  assert.equal(round.data.reason, 'player-deleted'); assert.equal(round.createdBy, 'challenger');
  assert.deepEqual(normal(await t.db.select().from(schema.gameMoves)), savedMoves, 'R333 удаление: game_moves не стёрты accountRows');
  const refunds = await t.db.select().from(schema.coinLedger).where(orm.eq(schema.coinLedger.reason, 'duel.refund'));
  assert.deepEqual(refunds.map(r => [r.userId, r.amount]).sort(), [['challenger', AMOUNT], ['target', AMOUNT]], 'R333 удаление: проводки ОБОИХ сохранены');
  const walletEvents = f.events.filter(e => e.message.t === 'economy.wallet');
  assert.equal(walletEvents.length, 1, 'R333 удаление: один живой кошелёк уведомлён');
  assert.deepEqual(walletEvents[0].audience, [survivor]); assert.equal(walletEvents[0].message.balance, INITIAL);
  const states = f.events.filter(e => e.message.t === 'duel.state');
  assert.equal(states.filter(e => e.audience.includes(survivor)).length, 1, 'R333 удаление: оставшемуся пришла отмена');
  for (const event of states) {
    const dto = event.message.duel;
    assert.equal(dto.id, roundId); assert.equal(dto.state, 'cancelled'); assert.equal(dto.game, game);
    assert.equal(dto.reason, 'player-deleted'); assert.equal(dto.seed, null, 'R333 удаление: отмена не раскрывает зерно');
    assert.equal(JSON.stringify(event.message).includes(String(seed)), false, 'R333 удаление: зерно не ушло в событие');
    assert.equal(Object.hasOwn(event.message, 'myHand'), false, 'R333 удаление: событие не содержит личную руку');
    assert.equal(Object.hasOwn(dto, 'data'), false);
    if (game === 'rps') {
      assert.deepEqual(dto.rps.rounds, [], 'R333 удаление: одиночная рука не раскрылась при отмене');
      assert.equal(JSON.stringify(event.message).includes('rock'), false, 'R333 удаление: скрытый ход не утёк при отмене');
    }
    assert.ok(event.audience.includes('spectator'), 'R333 удаление: отмену партии видит зритель голосового канала');
  }
  assert.ok(f.events.every(e => !e.inTransaction), 'R333 удаление: события опубликованы только после коммита');
  assert.deepEqual(f.warnings, [], 'R333 удаление: уборка не спрятала исключение');
  const beforeTick = normal(await t.db.select().from(schema.coinLedger));
  await f.duel.runDuelTick(new Date(NOW + 120_000));
  assert.deepEqual(normal(await t.db.select().from(schema.coinLedger)), beforeTick, 'R333 удаление: поздний такт не платит отменённую игру');
  await drift();
}

const CANCEL = '    duels = await cancelDuelsOf(tx, userId);';
const REFUND = '    await refundOpenStakesOf(tx, userId);';
const MUTANTS: Edit[] = [
  { file: 'accountDelete', changes: [{ from: CANCEL, to: '' }] },
  { file: 'accountDelete', changes: [{ from: CANCEL, to: '' }, { from: REFUND, to: `${REFUND}\n${CANCEL}` }] },
];
// Greedy тоже нужен: имеет другую ветку move/DTO и хранит действие/seq, а не секретную руку.
for (const game of ['rps', 'greedy'] as const) for (const deleted of PLAYERS) {
  test(`R333 удаление ${deleted} посреди ${game}: оба возврата ДО refund/обезличивания, ходы удержаны, живой уведомлён`, async () => {
    await scenario(game, deleted);
    for (const edit of MUTANTS) {
      await counterfact(async () => {
      const original = read(edit.file);
      await assert.rejects(scenario(game, deleted, edit), e => e instanceof assert.AssertionError
        && e.message.startsWith('R333 удаление до refundOpenStakesOf:'),
      'мутант обязан нарушить границу возврата, не import/setup/синтаксис');
      assert.equal(read(edit.file), original, 'R333 setup: whole-module мутант не записан на диск');
      });
      await scenario(game, deleted);
    }
  });
}
