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

// Миграции/SQL/кошельки/проводки настоящие. VM исполняет целые модули, включая мутанты:
// ни вырезанных функций, ни временного редактирования production-файлов.
type Edit = { file: string; from: string; to: string };
const NOW = Date.parse('2026-10-28T12:00:00Z');
const normal = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const read = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let t: TestDb;
before(async () => {
  t = await createTestDb();
  // У SQL DEFAULT и часов VM один день: fixture не зависит от даты запуска CI.
  await t.raw.exec("ALTER TABLE coin_ledger ALTER COLUMN created_at SET DEFAULT '2026-10-28T12:00:00Z'::timestamptz");
});
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

function edited(source: string, edit?: Pick<Edit, 'from' | 'to'>) {
  if (!edit) return source;
  assert.equal(source.split(edit.from).length, 2, 'R326 уникальный якорь whole-module мутанта');
  return source.replace(edit.from, edit.to);
}

async function fixture(edit?: Edit, balance = 100, beforeAnonymize?: (tx: TestDb['db']) => Promise<void>) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['human', 'other', 'third'].map(id => ({
    id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true,
  })));
  await t.db.insert(schema.servers).values({ id: 'server', name: 'Игры', ownerId: 'other' });
  await t.db.insert(schema.serverMembers).values({ serverId: 'server', userId: 'human' });
  await t.db.insert(schema.serverEconomy).values({
    serverId: 'server', enabled: true, gamesEnabled: true, gamesBetMax: 300, gamesDailyLossMax: 0,
  });
  await t.db.insert(schema.coinBalances).values(['human', 'other', 'third'].map(userId => ({
    serverId: 'server', userId, balance: userId === 'human' ? balance : 100,
    earnedTotal: 17, seasonEarned: 23, seasonId: 'autumn-2026',
  })));
  await t.db.insert(schema.coinLedger).values(['human', 'other', 'third'].map(userId => ({
    id: crypto.randomUUID(), serverId: 'server', userId, amount: userId === 'human' ? balance : 100, reason: 'fixture',
  })));
  await t.db.insert(schema.gameRounds).values(['wheel', 'duel', 'prediction'].map(kind => ({
    id: kind, serverId: 'server', kind: kind as 'wheel' | 'duel' | 'prediction', createdBy: 'human',
  })));
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? NOW : value instanceof Date ? value.getTime() : value); }
    static override now() { return NOW; }
  }
  const noop = async () => {};
  const warnings: string[] = [];
  const values: Record<string, unknown> = {
    'db/index': { db: t.db }, 'db/schema': schema, util: { id: crypto.randomUUID },
    env: { env: { economyPreviewUsers: [] } },
    realtime: { publishToUser: noop, publishToServer: noop },
    auth: { hashPassword: async () => 'synthetic-unusable-password', forgetTokenGeneration() {} },
    activity: { clearActivity: noop }, attachments: { purgeDeletedOf: noop },
    memberEvents: { memberChanged: noop }, conversations: { deliverMany: noop, journalForwardedFrom: async () => [] },
    'bots/botLifecycle': { deleteBotsOwnedBy: noop },
    'federation/directoryEvents': { announceUser: noop }, 'federation/guestRevocation': { revokeAccountEverywhere: noop },
    gateway: { broadcastUserProfile: noop }, gifs: { savedGifKeysOf: async () => [], removeGifFiles: noop },
    storage: { removeUserAvatars: noop }, livekit: { removeFromOtherRooms: noop },
  };
  const files = new Set(['coins', 'coinRules', 'streakRules', 'gameMoney', 'gameMoneyRules',
    'transferCoins', 'accountDelete', 'accountRows', 'accountRules']);
  const modules = new Map<string, any>();
  const sources = new Map<string, string>();
  function load<T>(name: string): T {
    if (Object.hasOwn(values, name)) return values[name] as T;
    if (modules.has(name)) return modules.get(name) as T;
    assert.ok(files.has(name), `R326 закрытый импорт ${name}`);
    const source = edited(read(name), edit?.file === name ? edit : undefined);
    sources.set(name, source);
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
        assert.ok(id.startsWith('.'), `R326 внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
      },
    });
    if (name === 'accountRows' && beforeAnonymize) {
      // Наблюдатель только проверяет состояние на границе; сам SQL обезличивания НЕ заменён.
      const original = module.exports.anonymizeAccountRows;
      module.exports.anonymizeAccountRows = async (tx: TestDb['db'], ...args: unknown[]) => {
        await beforeAnonymize(tx);
        return original(tx, ...args);
      };
    }
    return module.exports as T;
  }
  return { money: load<typeof import('../src/gameMoney.js')>('gameMoney'), load, sources, warnings };
}

async function drift(q: Pick<TestDb['db'], 'execute'> = t.db) {
  const rows = await q.execute(orm.sql`
    SELECT b.user_id, b.balance - COALESCE(SUM(l.amount), 0)::int AS drift
      FROM coin_balances b LEFT JOIN coin_ledger l USING (server_id, user_id)
     GROUP BY b.server_id, b.user_id, b.balance
    HAVING b.balance <> COALESCE(SUM(l.amount), 0)::int
  `);
  assert.deepEqual(rows.rows, [], 'R326 drift: каждый существующий кошелёк равен журналу');
}
async function wallet(userId = 'human') {
  const [row] = await t.db.select().from(schema.coinBalances).where(orm.eq(schema.coinBalances.userId, userId));
  assert.ok(row, 'R326 кошелёк существует');
  return row;
}
async function ledger(reason: string) {
  return t.db.select().from(schema.coinLedger).where(orm.eq(schema.coinLedger.reason, reason));
}
const key = { roundId: 'wheel', userId: 'human', pick: '7' };
const input = { ...key, serverId: 'server', amount: 10 };
// Второй рубеж UNIQUE вправе превратить плохой мутант в SQL-ошибку вместо двойного баланса.
// Этот помощник доказывает и отсутствие SQL-ошибки, и контрактный ответ (не просто rejects любого происхождения).
async function completed<T>(work: () => Promise<T>, message: string): Promise<T> {
  let result!: T;
  let failure: unknown;
  try { result = await work(); } catch (error) { failure = error; }
  assert.equal(failure, undefined, message);
  return result;
}
const killed = (prefix: string) => (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(prefix);

async function duplicateScenario(edit?: Edit) {
  const f = await fixture(edit);
  assert.deepEqual(normal(await f.money.withGameMoney(m => m.placeStake(input))), { ok: true, balance: 90 });
  const second = await completed(() => f.money.withGameMoney(m => m.placeStake(input)), 'R326 duplicate: повтор не падает на UNIQUE после списания');
  assert.deepEqual(normal(second), { ok: false, block: 'duplicate' }, 'R326 duplicate: явный отказ повтору');
  assert.equal((await wallet()).balance, 90, 'R326 duplicate: баланс списан однажды');
  assert.equal((await ledger('wheel.bet')).length, 1, 'R326 duplicate: в журнале одна ставка');
  assert.equal((await t.db.select().from(schema.gameStakes)).length, 1);
  // Другой pick того же раунда — корректная отдельная ставка, ключ не запрещает колесо.
  assert.deepEqual(normal(await f.money.withGameMoney(m => m.placeStake({ ...input, pick: '8' }))), { ok: true, balance: 80 });
  await drift();
}

// Важны и идемпотентный отказ, и разрешённая соседняя ставка: нельзя «исправить» дубль запретом всех повторных pick.
test('R326 повтор ставки не списывает второй раз, иной выбор принимается', () => duplicateScenario());

const INSERT_STAKE = `  const inserted = await tx
    .insert(gameStakes)
    .values({ roundId: i.roundId, userId: i.userId, serverId: i.serverId, pick: i.pick, amount: i.amount })
    .onConflictDoNothing()
    .returning({ roundId: gameStakes.roundId });
  if (inserted.length === 0) return { ok: false, block: 'duplicate' };
`;
// Контрфакт из задания: debit перед ON CONFLICT проигрывает даже при достаточном остатке для второй ставки.
test('R326 контрфакт: вставка ставки после списания обнаруживается на повторе', async () => {
  await duplicateScenario();
  await counterfact(async () => {
  const original = read('gameMoney');
  const start = original.indexOf(INSERT_STAKE);
  const end = original.indexOf('  return { ok: true, balance };', start);
  assert.ok(start >= 0 && end > start, 'R326 якоря перестановки');
  const block = original.slice(start, end);
  await assert.rejects(duplicateScenario({ file: 'gameMoney', from: block, to: block.slice(INSERT_STAKE.length) + INSERT_STAKE }), killed('R326 duplicate:'));
  assert.equal(read('gameMoney'), original, 'мутант не записывался на диск');
  });
  await duplicateScenario();
});

function lockGuard(sources: Map<string, string>) {
  const declaration = (file: string, name: string) => {
    const source = ts.createSourceFile(file, sources.get(file)!, ts.ScriptTarget.Latest, true);
    const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(fn?.body, `R326 lock: функция ${name} существует`);
    return fn.body;
  };
  const calls: ts.CallExpression[] = [];
  const walk = (node: ts.Node) => { if (ts.isCallExpression(node)) calls.push(node); ts.forEachChild(node, walk); };
  walk(declaration('gameMoney', 'placeStake'));
  const lock = calls.find(node => ts.isIdentifier(node.expression) && node.expression.text === 'lockWallet');
  const check = calls.find(node => ts.isIdentifier(node.expression) && node.expression.text === 'stakeBlock');
  assert.ok(lock && check && ts.isAwaitExpression(lock.parent) && lock.getStart() < check.getStart(),
    'R326 lock: await lockWallet предшествует stakeBlock');
  calls.length = 0;
  walk(declaration('coins', 'lockWallet'));
  assert.ok(calls.some(node => ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'for'
    && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'update'
    && /\.from\(coinBalances\)/.test(node.expression.expression.getText())),
  'R326 lock: lockWallet действительно берёт FOR UPDATE кошелька');
}

async function lastCoinsScenario(edit?: Edit) {
  const f = await fixture(edit, 10);
  // PGlite имеет одно соединение: Promise.all транзакций здесь НЕ доказательство отсутствия гонки.
  // Поэтому проверяем последовательный результат + AST-страж настоящей блокировки ДО чтения правил.
  lockGuard(f.sources);
  const results = [];
  for (const pick of ['7', '8']) results.push(normal(await f.money.withGameMoney(m => m.placeStake({ ...input, pick }))));
  assert.deepEqual(results, [{ ok: true, balance: 0 }, { ok: false, block: 'poor' }], 'R326 последние монеты: только одна ставка');
  assert.equal((await wallet()).balance, 0);
  assert.equal((await ledger('wheel.bet')).length, 1);
  await drift();
}
// Контракт последних монет нужен независимо от того, сериализует ли соединения локальный движок теста.
test('R326 две ставки на последние монеты дают ok/poor и нулевой баланс; блокировка раньше правил', () => lastCoinsScenario());
for (const [name, edit] of [
  ['кошелёк читается без блокировки', { file: 'gameMoney', from: 'await lockWallet(tx, i.serverId, i.userId)', to: '(await tx.select().from(coinBalances).where(and(eq(coinBalances.serverId, i.serverId), eq(coinBalances.userId, i.userId))).limit(1))[0]' }],
  ['FOR UPDATE заменён на SHARE', { file: 'coins', from: ".for('update');", to: ".for('share');" }],
] as const) {
  // Снятый lock не краснеет на очереди PGlite: адресно проверяется исходниковым стражем, не ложной «конкуренцией».
  test(`R326 контрфакт: ${name}`, async () => {
    await lastCoinsScenario();
    await counterfact(async () => {
  await assert.rejects(lastCoinsScenario(edit), killed('R326 lock:'));
  });
    await lastCoinsScenario();
  });
}

async function paymentScenario(edit?: Edit) {
  const f = await fixture(edit);
  await f.money.withGameMoney(m => m.placeStake(input));
  const pay = () => f.money.withGameMoney(async m => { await m.lockWallets('server', ['human']); return m.payStake({ ...key, payout: 25 }); });
  assert.deepEqual(normal(await pay()), { serverId: 'server', amount: 25 });
  const second = await completed(pay, 'R326 выплата: повтор не доходит до UNIQUE журнала');
  assert.equal(second, null, 'R326 выплата: повтор не платит');
  assert.equal((await wallet()).balance, 115, 'R326 выплата: баланс пополнился один раз');
  const wins = await ledger('wheel.win');
  assert.equal(wins.length, 1);
  assert.deepEqual(wins[0].data, { roundId: 'wheel', pick: '7', net: 15 });
  const [stake] = await t.db.select().from(schema.gameStakes);
  assert.ok(stake.paidAt); assert.equal(stake.payout, 25); assert.equal(stake.refundedAt, null);
  const w = await wallet();
  assert.equal(w.earnedTotal, 17, 'R326 выплата: выигрыш не заработок');
  assert.equal(w.seasonEarned, 23, 'R326 выплата: выигрыш не сезон');
  await drift();
}
// UNIQUE — только второй рубеж: корректный повтор должен дать null, а не ошибку БД после UPDATE.
test('R326 двойная выплата платит один раз, сохраняет отметку и не растит заработок/сезон', () => paymentScenario());
const SETTLE_WHERE = '.where(and(stakeWhere(i), isNull(gameStakes.paidAt), isNull(gameStakes.refundedAt)))';
// Мутируем только payStake: такой же guard у refundStake обязан остаться настоящим.
test('R326 контрфакт: payStake без IS NULL доходит до второго платежа', async () => {
  await paymentScenario();
  await counterfact(async () => {
  await assert.rejects(paymentScenario({ file: 'gameMoney',
    from: `.set({ paidAt: new Date(), payout: i.payout })\n    ${SETTLE_WHERE}`,
    to: '.set({ paidAt: new Date(), payout: i.payout })\n    .where(stakeWhere(i))' }), killed('R326 выплата:'));
  });
  await paymentScenario();
});

async function refundAfterPaidScenario(edit?: Edit) {
  const f = await fixture(edit);
  await f.money.withGameMoney(m => m.placeStake(input));
  await f.money.withGameMoney(m => m.payStake({ ...key, payout: 25 }));
  assert.equal(await f.money.withGameMoney(m => m.refundStake(key)), null, 'R326 возврат: оплаченную ставку не вернуть');
  assert.equal((await wallet()).balance, 115);
  assert.equal((await ledger('wheel.refund')).length, 0);
  // Парное принятие: ещё не оплаченная ставка действительно возвращается и второй раз уже нет.
  await f.money.withGameMoney(m => m.placeStake({ ...input, pick: '8' }));
  assert.deepEqual(normal(await f.money.withGameMoney(m => m.refundStake({ ...key, pick: '8' }))), { serverId: 'server', amount: 10 });
  assert.equal(await f.money.withGameMoney(m => m.refundStake({ ...key, pick: '8' })), null);
  assert.equal((await wallet()).balance, 115);
  await drift();
}
// Возврат после выплаты иначе превращается в удвоение выигрыша; открытая ставка должна оставаться возвратной.
test('R326 возврат после выплаты ничего не делает, открытая ставка возвращается ровно раз', () => refundAfterPaidScenario());
test('R326 контрфакт: возврат игнорирует paid_at', async () => {
  await refundAfterPaidScenario();
  await counterfact(async () => {
  await assert.rejects(refundAfterPaidScenario({ file: 'gameMoney',
    from: `.set({ refundedAt: new Date() })\n    ${SETTLE_WHERE}`,
    to: '.set({ refundedAt: new Date() })\n    .where(and(stakeWhere(i), isNull(gameStakes.refundedAt)))' }), killed('R326 возврат:'));
  });
  await refundAfterPaidScenario();
});

async function uniqueScenario(nonUnique = false) {
  await fixture();
  assert.ok(t.appliedMigrations.includes('0160_games_money.sql'));
  // Вся миграция выполняется на той же схеме; ROLLBACK восстанавливает и индекс, и записи даже у мутанта.
  await t.raw.exec('BEGIN');
  try {
    if (nonUnique) {
      await t.raw.exec('DROP INDEX coin_ledger_game_once_uq');
      const migration = readFileSync(new URL('../drizzle/0160_games_money.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      await t.raw.exec(edited(migration, { from: 'CREATE UNIQUE INDEX IF NOT EXISTS coin_ledger_game_once_uq', to: 'CREATE INDEX IF NOT EXISTS coin_ledger_game_once_uq' }));
    }
    const insert = (id: string, pick = '7', reason = 'wheel.win', user = 'human') => t.raw.query(
      `INSERT INTO coin_ledger(id, server_id, user_id, amount, reason, data)
       VALUES ($1, 'server', $2, 0, $3, jsonb_build_object('roundId', 'wheel', 'pick', $4::text))`, [id, user, reason, pick]);
    await insert('first');
    await t.raw.exec('SAVEPOINT duplicate_ledger');
    let code: unknown;
    try { await insert('duplicate'); } catch (error) { code = (error as { code?: string }).code; }
    finally { await t.raw.exec('ROLLBACK TO SAVEPOINT duplicate_ledger'); }
    assert.equal(code, '23505', 'R326 UNIQUE: повтор ключа игры запрещён самой базой');
    // Все четыре части ключа важны: нельзя заменить защиту слишком широким UNIQUE.
    await insert('other-pick', '8'); await insert('other-reason', '7', 'wheel.refund');
    await insert('other-user', '7', 'wheel.win', 'other');
    await t.raw.query(`INSERT INTO coin_ledger(id,server_id,user_id,amount,reason,data)
      VALUES ('other-round','server','human',0,'wheel.win','{"roundId":"another","pick":"7"}')`);
    await drift();
  } finally { await t.raw.exec('ROLLBACK'); await drift(); }
}
// Отдельно от условного UPDATE доказываем второй рубеж; нулевые строки не подменяют баланс фикстуры.
test('R326 UNIQUE журнала запрещает дубль игры, но допускает другие раунд/выбор/человека/причину', () => uniqueScenario());
test('R326 контрфакт: неуникальный игровой индекс пропускает дубль журнала', async () => {
  await uniqueScenario();
  await counterfact(async () => {
  await assert.rejects(uniqueScenario(true), killed('R326 UNIQUE:'));
  });
  await uniqueScenario();
});

async function deletionScenario(edit?: Edit) {
  let observed = 0;
  const f = await fixture(edit, 100, async tx => {
    observed++;
    const [u] = await tx.select().from(schema.users).where(orm.eq(schema.users.id, 'human'));
    const [stake] = await tx.select().from(schema.gameStakes);
    const [w] = await tx.select().from(schema.coinBalances).where(orm.eq(schema.coinBalances.userId, 'human'));
    const refunds = await tx.select().from(schema.coinLedger).where(orm.eq(schema.coinLedger.reason, 'wheel.refund'));
    assert.ok(stake.refundedAt && refunds.length === 1, 'R326 удаление: refund и refunded_at уже записаны ДО accountRows');
    assert.equal(u.deletedAt, null, 'R326 удаление: refund предшествует обезличиванию');
    assert.equal(w.balance, 100, 'R326 удаление: refund восстановил кошелёк до его удаления');
    await drift(tx);
  });
  await f.money.withGameMoney(m => m.placeStake(input));
  await drift();
  const account = f.load<typeof import('../src/accountDelete.js')>('accountDelete');
  await account.anonymizeAccount('human');
  assert.equal(observed, 1);
  const [u] = await t.db.select().from(schema.users).where(orm.eq(schema.users.id, 'human'));
  assert.ok(u.deletedAt); assert.equal(u.tokenGeneration, 1);
  assert.equal(u.displayName, 'Удалённый пользователь');
  assert.equal((await t.db.select().from(schema.coinBalances).where(orm.eq(schema.coinBalances.userId, 'human'))).length, 0,
    'R326 удаление: кошелёк удалён настоящим accountRows');
  const [stake] = await t.db.select().from(schema.gameStakes);
  assert.equal(stake.userId, 'human'); assert.ok(stake.refundedAt); assert.equal(stake.paidAt, null);
  assert.equal((await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, 'wheel')))[0].createdBy, 'human');
  const refunds = await ledger('wheel.refund');
  assert.equal(refunds.length, 1); assert.equal(refunds[0].amount, 10); assert.equal(refunds[0].userId, 'human');
  assert.deepEqual(f.warnings, [], 'внешние заглушки удаления завершились без скрытых ошибок');
  // Удалённый кошелёк не участвует в drift, его журнал остаётся историей. Сверка ДО удаления проверена наблюдателем.
  await drift();
}
// Вызов настоящего accountDelete обязателен: отдельный refundOpenStakesOf не проверяет порядок интеграции.
test('R326 настоящее удаление аккаунта возвращает эскроу до обезличивания и сохраняет историю ставок', () => deletionScenario());
for (const [name, from, to] of [
  ['возврат забыли', '    await refundOpenStakesOf(tx, userId);', ''],
  ['возврат перенесли после обезличивания',
    '    await refundOpenStakesOf(tx, userId);\n    const servers = await anonymizeAccountRows(tx, userId, unusable, new Date());',
    '    const servers = await anonymizeAccountRows(tx, userId, unusable, new Date());\n    await refundOpenStakesOf(tx, userId);'],
] as const) {
  // Даже если поздний refund восстановил бы удалённый кошелёк, наблюдатель ловит неверный порядок внутри той же tx.
  test(`R326 контрфакт удаления: ${name}`, async () => {
    await deletionScenario();
    await counterfact(async () => {
  await assert.rejects(deletionScenario({ file: 'accountDelete', from, to }), killed('R326 удаление:'));
  });
    await deletionScenario();
  });
}

async function pairScenario(edit?: Edit) {
  const f = await fixture(edit);
  const transfer = f.load<typeof import('../src/transferCoins.js')>('transferCoins').transferCoins;
  const duelKey = { roundId: 'duel', userId: 'human', pick: 'duel' };
  await f.money.withGameMoney(m => m.placeStake({ ...duelKey, serverId: 'server', amount: 20, refUserId: 'other' }));
  await f.money.withGameMoney(m => m.payStake({ ...duelKey, payout: 35, refUserId: 'other' }));
  const [win] = await ledger('duel.win');
  assert.equal(win.refUserId, 'other'); assert.equal((win.data as { net: number }).net, 15);
  const tip = (credit: number, dailyPair: number) => transfer({ serverId: 'server', fromUserId: 'other', toUserId: 'human',
    debit: credit, credit, burned: 0, dailyOut: 0, dailyIn: 0, dailyPair,
    maxTippersPerDay: 10, seasonLength: 'quarter', now: new Date(NOW) });
  assert.equal((await tip(10, 30)).block, null, 'R326 пара: чистые 15 + tip 10 ещё ниже предела');
  assert.equal((await tip(5, 30)).block, null, 'R326 пара: ровно 30 принимается, своя ставка не считается переводом');
  const before = normal(await t.db.select().from(schema.coinBalances));
  assert.equal((await tip(1, 30)).block, 'pair-limit', 'R326 пара: чистый duel.win + tip.in того же отправителя исчерпали предел');
  assert.deepEqual(normal(await t.db.select().from(schema.coinBalances)), before, 'R326 пара: отказ не двигает деньги');
  assert.equal((await ledger('tip.in')).length, 2);
  assert.equal((await wallet()).recognitionTippers, 1, 'R326 пара: дуэль не благодарность, повторные типы не новое признание');
  await drift();
}
// Два успешных типа отличают data.net от всей выплаты; следующий +1 отличает сумму дуэли и типов от одних типов.
test('R326 чистый выигрыш дуэли и типы того же соперника делят суточный предел пары: ровно проходит, +1 нет', () => pairScenario());
for (const [name, from, to] of [
  ['дуэль исключена из пары', "AND reason IN ('tip.in', 'duel.win')", "AND reason IN ('tip.in')"],
  ['считается вся выплата вместо net', "GREATEST(COALESCE((data->>'net')::int, amount), 0)", 'amount'],
] as const) {
  // Контрфакты дают разные поломки: обход потолка и ложный отказ ещё до потолка.
  test(`R326 контрфакт пары: ${name}`, async () => {
    await pairScenario();
    await counterfact(async () => {
  await assert.rejects(pairScenario({ file: 'transferCoins', from, to }), killed('R326 пара:'));
  });
    await pairScenario();
  });
}

// NET-loss, а не сумма ставок: последняя разрешённая ставка может полностью отыграть день.
for (const kind of ['wheel', 'duel', 'prediction'] as const) {
  test(`${kind}: выигрыш и возврат освобождают суточный предел для следующей ставки`, async () => {
    for (const payout of [15000, 6000, 20000, 'refund'] as const) {
      const f = await fixture(undefined, 50000);
      await t.db.update(schema.serverEconomy).set({ gamesDailyLossMax: 15000, gamesBetMax: 15000 });
      const coins = f.load<typeof import('../src/coins.js')>('coins');
      const rules = f.load<typeof import('../src/gameMoneyRules.js')>('gameMoneyRules');
      const reason = rules.gameReasons(kind).stake;
      // Историческая потеря сегодняшнего дня: баланс и журнал остаются согласованы.
      await f.money.withGameMoney(m => coins.applyCoins(m.tx, { serverId: 'server', userId: 'human',
        amount: -13500, reason, data: { roundId: 'past', pick: 'past' } }));
      const loss = () => f.money.lossTodayOf(t.db, 'server', 'human', new Date(NOW));
      assert.equal(await loss(), 13500);
      const stake = { roundId: kind, userId: 'human', pick: 'last', serverId: 'server', amount: 1500 };
      assert.equal((await f.money.withGameMoney(m => m.placeStake(stake))).ok, true);
      assert.equal(await loss(), 15000, 'последняя ставка ровно исчерпала предел');
      const blocked = await f.money.withGameMoney(m => m.placeStake({ ...stake, pick: 'blocked', amount: 1 }));
      assert.deepEqual(normal(blocked), { ok: false, block: 'loss-limit' });
      if (payout === 'refund') await f.money.withGameMoney(m => m.refundStake(stake));
      else await f.money.withGameMoney(m => m.payStake({ ...stake, payout, refUserId: kind === 'duel' ? 'other' : undefined }));
      const expected = payout === 'refund' ? 13500 : Math.max(0, 15000 - payout);
      assert.equal(await loss(), expected, 'частичный выигрыш уменьшает NET-loss, прибыль не делает его отрицательным');
      const [raw] = await t.db.select().from(schema.coinBalances).where(orm.eq(schema.coinBalances.userId, 'human'));
      const games = await f.money.gamesViewOf('server', raw, 15000, new Date(NOW));
      assert.equal(games.lossToday, expected);
      assert.equal(games.effectiveLimit, 15000, 'потолок фиксирован, меняется только израсходованная часть');
      assert.equal(15000 - games.lossToday, 15000 - expected);
      assert.equal((await f.money.withGameMoney(m => m.placeStake({ ...stake, pick: 'again', amount: 1500 }))).ok, true,
        'после выплаты/возврата следующая ставка снова принимается');
      assert.equal(await f.money.lossTodayOf(t.db, 'server', 'other', new Date(NOW)), 0, 'чужой кошелёк не изменён');
      await drift();
    }
  });
}
