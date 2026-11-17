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

// R328: настоящие миграции/Drizzle/кошельки/журнал. Подменяются только внешние IO;
// мутанты живут в строках целых модулей или полной 0161, а не в production-файлах.
type Edit = { file: string; from: string; to: string };
type SqlEdit = Pick<Edit, 'from' | 'to'>;
const NOW = new Date('2026-10-28T21:30:00.000Z'); // уже 29 октября по Москве, ещё 28-е по UTC
const readSource = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const readMigration = (name: string) => readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

function editSource(source: string, edit?: SqlEdit) {
  if (!edit) return source;
  assert.equal(source.split(edit.from).length, 2, 'R328 уникальный якорь целого исходника');
  return source.replace(edit.from, edit.to);
}

async function fixture() {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['human', 'other'].map(id => ({
    id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true,
  })));
  await t.db.insert(schema.servers).values(['server', 'elsewhere', 'later'].map(id => ({ id, name: id, ownerId: 'human' })));
  await t.db.insert(schema.serverEconomy).values(['server', 'elsewhere'].map(serverId => ({
    serverId, enabled: true, gamesEnabled: true, gamesDailyLossMax: 0,
  })));
  const wallets = [
    { serverId: 'server', userId: 'human' }, { serverId: 'server', userId: 'other' },
    { serverId: 'elsewhere', userId: 'human' },
  ];
  await t.db.insert(schema.coinBalances).values(wallets.map(key => ({ ...key, balance: 1000 })));
  await t.db.insert(schema.coinLedger).values(wallets.map(key => ({
    ...key, id: crypto.randomUUID(), amount: 1000, reason: 'fixture', createdAt: NOW,
  })));
}

function loadMoney(edit?: Edit) {
  const noop = async () => {};
  const values: Record<string, unknown> = {
    'db/index': { db: t.db }, 'db/schema': schema, util: { id: crypto.randomUUID },
    env: { env: { economyPreviewUsers: [] } }, realtime: { publishToUser: noop },
  };
  const allowed = new Set(['gameMoney', 'gameMoneyRules', 'coins', 'coinRules', 'streakRules']);
  const modules = new Map<string, any>();
  const sources = new Map<string, string>();
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? NOW.getTime() : value instanceof Date ? value.getTime() : value); }
    static override now() { return NOW.getTime(); }
  }
  function load<T>(name: string): T {
    if (Object.hasOwn(values, name)) return values[name] as T;
    if (modules.has(name)) return modules.get(name) as T;
    assert.ok(allowed.has(name), `R328 закрытый импорт ${name}`);
    const source = editSource(readSource(name), edit?.file === name ? edit : undefined);
    sources.set(name, source);
    const module = { exports: {} as Record<string, any> };
    modules.set(name, module.exports);
    runInNewContext(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer, Error, console,
      require(id: string) {
        if (id === 'drizzle-orm') return orm;
        if (id === '@gusvoice/shared') return shared;
        if (id === 'node:crypto') return crypto;
        assert.ok(id.startsWith('.'), `R328 внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
      },
    });
    return module.exports as T;
  }
  return {
    money: load<typeof import('../src/gameMoney.js')>('gameMoney'),
    coins: load<typeof import('../src/coins.js')>('coins'), sources,
  };
}

async function drift() {
  const rows = await t.raw.query(`
    SELECT b.server_id, b.user_id, b.balance - COALESCE(SUM(l.amount), 0)::int AS drift
    FROM coin_balances b LEFT JOIN coin_ledger l USING (server_id, user_id)
    GROUP BY b.server_id, b.user_id, b.balance
    HAVING b.balance <> COALESCE(SUM(l.amount), 0)::int
  `);
  assert.deepEqual(rows.rows, [], 'R328 drift: кошельки равны журналу, включая начальный баланс');
}

// Повтор с чистого исходника реально перечитывает файл и строит новый VM cache/новую SQL-схему.
// Не засчитываем падение загрузчика/синтаксиса/SQL за убийство мутанта: только адресная AssertionError.
const killed = (prefix: string) => (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(prefix);
async function mutationCheck<E>(scenario: (edit?: E) => Promise<void>, edits: () => readonly E[], editCount: number, prefix: string) {
  await scenario();
  for (let index = 0; index < editCount; index++) {
    await counterfact(async () => {
      await assert.rejects(scenario(edits()[index]), killed(prefix));
    });
    await scenario();
  }
}

/** Внешняя транзакция восстанавливает схему после любого мутанта и любой неудачной проверки. */
async function migrated(work: () => Promise<void>, edit?: SqlEdit) {
  await fixture();
  assert.ok(t.appliedMigrations.includes('0161_wheel.sql'));
  await t.raw.exec('BEGIN');
  try {
    // Точно предшествующее 0161 состояние, а не вручную изобретённый индекс: 0160 применяется целиком.
    await t.raw.exec(`
      DROP INDEX game_rounds_wheel_live_uq;
      DROP INDEX game_rounds_wheel_lock_idx;
      DROP INDEX game_rounds_wheel_settle_idx;
      DROP INDEX game_rounds_wheel_last_idx;
      DROP INDEX coin_ledger_game_once_uq;
      ALTER TABLE game_rounds DROP COLUMN lock_at;
      ALTER TABLE game_rounds DROP COLUMN settle_at;
      ALTER TABLE server_economy DROP COLUMN wheel_jackpot_cents;
    `);
    await t.raw.exec(readMigration('0160_games_money.sql'));
    await t.raw.exec(`INSERT INTO game_rounds (id, server_id, kind, state, created_by, data)
      VALUES ('legacy', 'server', 'duel', 'settled', 'human', '{"retained":true}')`);
    await t.raw.exec(editSource(readMigration('0161_wheel.sql'), edit));
    await work();
    await drift();
  } finally {
    await t.raw.exec('ROLLBACK');
  }
}

/** Ошибка UNIQUE внутри BEGIN не должна отравить разрешённые соседние случаи. */
async function sqlFailure(work: () => Promise<unknown>) {
  await t.raw.exec('SAVEPOINT r328_expected_failure');
  let failure: unknown;
  try { await work(); } catch (error) { failure = error; }
  await t.raw.exec('ROLLBACK TO SAVEPOINT r328_expected_failure; RELEASE SAVEPOINT r328_expected_failure');
  return failure as { code?: string; constraint?: string } | undefined;
}

async function columnsScenario(edit?: SqlEdit) {
  await migrated(async () => {
    const columns = await t.raw.query<{ column_name: string; data_type: string; is_nullable: string }>(`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='game_rounds' AND column_name IN ('lock_at','settle_at')
      ORDER BY column_name
    `);
    assert.deepEqual(columns.rows, [
      { column_name: 'lock_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'settle_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ], 'R328 таймеры: обе колонки nullable timestamptz, не локальное время');
    const [old] = await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, 'legacy'));
    assert.equal(old.lockAt, null); assert.equal(old.settleAt, null);
    assert.deepEqual(old.data, { retained: true });
    const lockAt = new Date('2026-10-29T00:00:00+03:00');
    const settleAt = new Date(lockAt.getTime() + 6000);
    await t.db.insert(schema.gameRounds).values({ id: 'new-wheel', serverId: 'server', kind: 'wheel', lockAt, settleAt });
    const [fresh] = await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, 'new-wheel'));
    assert.equal(fresh.lockAt?.toISOString(), '2026-10-28T21:00:00.000Z');
    assert.equal(fresh.settleAt?.toISOString(), '2026-10-28T21:00:06.000Z');
    // Повторная миграция не теряет уже накопленные сроки/данные.
    await t.raw.exec(readMigration('0161_wheel.sql'));
    assert.deepEqual((await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, 'new-wheel')))[0], fresh);
  }, edit);
}

test('R328 миграция добавляет московские сроки старым и новым раундам, повтор не стирает их', async () => {
  await mutationCheck(columnsScenario, () => (['lock_at', 'settle_at'].map(column => ({
    from: `ADD COLUMN IF NOT EXISTS ${column} timestamptz;`, to: `ADD COLUMN IF NOT EXISTS ${column} timestamp;`,
  }))), 2, 'R328 таймеры:');
});

async function defaultScenario(edit?: SqlEdit) {
  await migrated(async () => {
    const [old] = await t.db.select().from(schema.serverEconomy).where(orm.eq(schema.serverEconomy.serverId, 'server'));
    assert.equal(old.wheelJackpotCents, 0, 'R328 сундук: существующий сервер начинает с нуля');
    // Обход Drizzle values обязателен: ORM default не должен маскировать забытый DEFAULT в SQL.
    await t.raw.exec("INSERT INTO server_economy (server_id) VALUES ('later')");
    const [fresh] = await t.db.select().from(schema.serverEconomy).where(orm.eq(schema.serverEconomy.serverId, 'later'));
    assert.equal(fresh.wheelJackpotCents, 0, 'R328 сундук: новый сервер получает SQL DEFAULT 0');
    await t.raw.exec("UPDATE server_economy SET wheel_jackpot_cents=157 WHERE server_id='server'");
    const failure = await sqlFailure(() => t.raw.exec("UPDATE server_economy SET wheel_jackpot_cents=NULL WHERE server_id='server'"));
    assert.equal(failure?.code, '23502', 'R328 сундук: NULL запрещён, ноль разрешён');
    await t.raw.exec(readMigration('0161_wheel.sql'));
    assert.equal((await t.db.select().from(schema.serverEconomy).where(orm.eq(schema.serverEconomy.serverId, 'server')))[0].wheelJackpotCents, 157);
  }, edit);
}

test('R328 сундук равен нулю у старого и нового сервера, не допускает NULL и сохраняет сотые при повторе миграции', async () => {
  await mutationCheck(defaultScenario, () => ([
    { from: 'wheel_jackpot_cents bigint NOT NULL DEFAULT 0;', to: 'wheel_jackpot_cents bigint NOT NULL DEFAULT 1;' },
    { from: 'wheel_jackpot_cents bigint NOT NULL DEFAULT 0;', to: 'wheel_jackpot_cents bigint DEFAULT 0;' },
  ]), 2, 'R328 сундук:');
});

async function liveUniqueScenario(edit?: SqlEdit) {
  await migrated(async () => {
    const insert = (id: string, serverId: string, kind: string, state: string) => t.raw.query(
      'INSERT INTO game_rounds (id, server_id, kind, state) VALUES ($1,$2,$3,$4)', [id, serverId, kind, state]);
    await insert('first', 'server', 'wheel', 'open');
    for (const state of ['open', 'locked']) {
      const failure = await sqlFailure(() => insert(`second-${state}`, 'server', 'wheel', state));
      assert.equal(failure?.code, '23505', `R328 живое: второе ${state} колесо отвергается UNIQUE`);
      assert.equal(failure?.constraint, 'game_rounds_wheel_live_uq');
    }
    for (const [id, serverId, kind, state] of [
      ['other-server', 'elsewhere', 'wheel', 'open'], ['duel', 'server', 'duel', 'open'],
      ['settled', 'server', 'wheel', 'settled'], ['cancelled', 'server', 'wheel', 'cancelled'],
    ]) {
      let failure: unknown;
      await t.raw.exec('SAVEPOINT r328_allowed_round');
      try { await insert(id, serverId, kind, state); } catch (error) { failure = error; }
      if (failure) await t.raw.exec('ROLLBACK TO SAVEPOINT r328_allowed_round');
      await t.raw.exec('RELEASE SAVEPOINT r328_allowed_round');
      assert.equal(failure, undefined, `R328 живое: разрешён соседний случай ${id}`);
    }
    await t.raw.exec("UPDATE game_rounds SET state='locked' WHERE id='first'");
    assert.equal((await sqlFailure(() => insert('locked-vs-open', 'server', 'wheel', 'open')))?.code,
      '23505', 'R328 живое: locked тоже занимает единственное место');
    await t.raw.exec("UPDATE game_rounds SET state='settled' WHERE id='first'");
    await insert('after-settlement', 'server', 'wheel', 'open');
  }, edit);
}

test('R328 UNIQUE разрешает одно живое колесо на сервер, не запрещает другой сервер, дуэль и закрытые раунды', async () => {
  await mutationCheck(liveUniqueScenario, () => ([
    { from: 'CREATE UNIQUE INDEX IF NOT EXISTS game_rounds_wheel_live_uq', to: 'CREATE INDEX IF NOT EXISTS game_rounds_wheel_live_uq' },
    { from: "WHERE kind = 'wheel' AND state IN ('open', 'locked');", to: "WHERE kind = 'wheel' AND state IN ('open');" },
    { from: "WHERE kind = 'wheel' AND state IN ('open', 'locked');", to: "WHERE state IN ('open', 'locked');" },
    { from: "WHERE kind = 'wheel' AND state IN ('open', 'locked');", to: "WHERE kind = 'wheel';" },
  ]), 4, 'R328 живое:');
});

async function ledgerUniqueScenario(edit?: SqlEdit) {
  await migrated(async () => {
    const f = loadMoney();
    // SQL настоящий; различаются только типы результата адаптеров PGlite и production node-postgres.
    const move = (data: { roundId: string; pick: string }, userId = 'human', reason = 'wheel.jackpot') =>
      f.coins.applyCoins(t.db as unknown as Parameters<typeof f.coins.applyCoins>[0], { serverId: 'server', userId, reason, amount: 7, data });
    await move({ roundId: 'round', pick: 'jackpot' });
    const failure = await sqlFailure(() => move({ roundId: 'round', pick: 'jackpot' }));
    // Drizzle сохраняет SQLSTATE в cause, PGlite — непосредственно в ошибке.
    const sqlError = failure as typeof failure & { cause?: { code?: string; constraint?: string } };
    assert.equal(sqlError?.cause?.code ?? sqlError?.code, '23505', 'R328 журнал: wheel.jackpot защищён вторым UNIQUE');
    assert.equal(sqlError?.cause?.constraint ?? sqlError?.constraint, 'coin_ledger_game_once_uq');
    await move({ roundId: 'round', pick: 'other-pick' });
    await move({ roundId: 'other-round', pick: 'jackpot' });
    await move({ roundId: 'round', pick: 'jackpot' }, 'other');
    await move({ roundId: 'round', pick: 'jackpot' }, 'human', 'wheel.win');
    const rows = await t.db.select().from(schema.coinLedger).where(orm.eq(schema.coinLedger.reason, 'wheel.jackpot'));
    assert.equal(rows.length, 4, 'R328 журнал: иной pick/round/user не ложные дубли');
    assert.equal((await t.db.select().from(schema.coinBalances).where(orm.and(
      orm.eq(schema.coinBalances.serverId, 'server'), orm.eq(schema.coinBalances.userId, 'human'),
    )))[0].balance, 1028, 'R328 журнал: откат дубля не оставил изменение кошелька');
  }, edit);
}

test('R328 второй рубеж журнала знает wheel.jackpot, иной выбор, раунд, человек и причина принимаются', async () => {
  await mutationCheck(ledgerUniqueScenario, () => ([
    { from: "'wheel.refund', 'wheel.jackpot', 'duel.stake'", to: "'wheel.refund', 'duel.stake'" },
    { from: 'CREATE UNIQUE INDEX IF NOT EXISTS coin_ledger_game_once_uq', to: 'CREATE INDEX IF NOT EXISTS coin_ledger_game_once_uq' },
  ]), 2, 'R328 журнал:');
});

async function lossFixture(edit?: Edit) {
  await fixture();
  const f = loadMoney(edit);
  let serial = 0;
  async function move(amount: number, reason: string, at = NOW, serverId = 'server', userId = 'human') {
    const marker = `r328-loss-${++serial}`;
    await t.db.transaction(async tx => {
      // Та же реальная транзакция SQL, но PGlite и node-postgres имеют разные типы QueryResult.
      await f.coins.applyCoins(tx as unknown as Parameters<typeof f.coins.applyCoins>[0], { serverId, userId, amount, reason, data: { roundId: marker, pick: 'jackpot', marker } });
      await tx.update(schema.coinLedger).set({ createdAt: at }).where(orm.sql`${schema.coinLedger.data}->>'marker' = ${marker}`);
    });
  }
  return { ...f, move, loss: () => f.money.lossTodayOf(t.db, 'server', 'human', NOW) };
}

async function jackpotLossScenario(edit?: Edit) {
  const f = await lossFixture(edit);
  await f.move(-100, 'wheel.bet');
  assert.equal(await f.loss(), 100, 'R328 проигрыш: исходная ставка считается без неигрового стартового баланса');
  await f.move(40, 'wheel.jackpot');
  assert.equal(await f.loss(), 60, 'R328 проигрыш: джекпот снижает суточный проигрыш как положительная выплата');
  // Доход/покупка не могут расширить/съесть личный лимит игры; ни чужой кошелёк, ни сервер тоже.
  await f.move(200, 'tip.in'); await f.move(-17, 'shop.buy');
  await f.move(900, 'wheel.jackpot', NOW, 'server', 'other');
  await f.move(800, 'wheel.jackpot', NOW, 'elsewhere', 'human');
  assert.equal(await f.loss(), 60, 'R328 проигрыш: чужие пользователи/серверы и неигровые причины не входят в итог');
  await drift();
}

test('R328 lossTodayOf вычитает wheel.jackpot из проигрыша, исключает неигровые и чужие проводки', async () => {
  await mutationCheck(jackpotLossScenario, () => ([
    { file: 'gameMoneyRules', from: '[...GAME_LEDGER_REASONS, WHEEL_JACKPOT_REASON]', to: '[...GAME_LEDGER_REASONS]' },
    { file: 'gameMoney', from: 'inArray(coinLedger.reason, [...GAME_LOSS_REASONS]),', to: 'undefined,' },
    { file: 'gameMoney', from: 'eq(coinLedger.userId, userId),', to: 'undefined,' },
    { file: 'gameMoney', from: 'eq(coinLedger.serverId, serverId),', to: 'undefined,' },
  ]), 4, 'R328 проигрыш:');
});

async function moscowDayScenario(edit?: Edit) {
  const f = await lossFixture(edit);
  await f.move(-500, 'wheel.bet', new Date('2026-10-28T20:59:59.999Z'));
  await f.move(-100, 'wheel.bet', new Date('2026-10-28T21:00:00.000Z'));
  await f.move(30, 'wheel.jackpot', new Date('2026-10-28T21:00:00.001Z'));
  assert.equal(await f.loss(), 70, 'R328 сутки: -1 мс исключается, ровно 00:00 МСК и +1 мс включаются');
  await drift();
}

test('R328 сутки lossTodayOf начинаются ровно в 00:00 МСК, не в полночь UTC', async () => {
  await mutationCheck(moscowDayScenario, () => ([
    { file: 'gameMoney', from: 'gte(coinLedger.createdAt, dayStart(now)),', to: 'sql`${coinLedger.createdAt} > ${dayStart(now)}`,' },
    { file: 'gameMoney', from: 'gte(coinLedger.createdAt, dayStart(now)),', to: "gte(coinLedger.createdAt, new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z'))," },
  ]), 2, 'R328 сутки:');
});

async function positiveLossScenario(edit?: Edit) {
  const f = await lossFixture(edit);
  assert.equal(await f.loss(), 0);
  await f.move(-100, 'wheel.bet');
  assert.equal(await f.loss(), 100);
  await f.move(100, 'wheel.win');
  assert.equal(await f.loss(), 0, 'R328 ноль: точное покрытие ставки не проигрыш');
  await f.move(1, 'wheel.jackpot');
  assert.equal(await f.loss(), 0, 'R328 ноль: положительный итог игр ограничен нулём, не отрицательный проигрыш');
  await drift();
}

test('R328 пустой журнал, ровный возврат и чистый выигрыш дают проигрыш 0, а не отрицательное число', async () => {
  await mutationCheck(positiveLossScenario, () => ([{ file: 'gameMoneyRules',
    from: 'return sumOfGameRowsToday < 0 ? 0 - sumOfGameRowsToday : 0;', to: 'return sumOfGameRowsToday === 0 ? 0 : 0 - sumOfGameRowsToday;',
  }]), 1, 'R328 ноль:');
});
