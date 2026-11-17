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

// R333: настоящие миграции, SQL, денежные транзакции и ЦЕЛЫЕ production-модули.
// Только внешние IO (Redis/presence/шина/random/часы) заменены. Зерно подбирается на
// границе randomBytes: броски, выбор первого и расчёт выплат остаются настоящими.
// Односессионный PGlite проверяет повтор ходов и отказ по лимиту с реальными деньгами,
// но НЕ доказывает PostgreSQL-гонку, порядок замков или межсессионную идемпотентность.
type Duel = typeof import('../src/gameDuel.js');
type Profile = 'burn' | 'win' | 'dice';
type Wire = { userId?: string; audience?: string[]; message: Record<string, any> };
const T0 = Date.parse('2026-10-28T12:00:00Z');
const at = (ms: number) => new Date(T0 + ms);
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const read = (file: string) => readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const hash = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest();
const die = (roundId: string, seed: string, n: number) => shared.diceFromHash(hash(`gv-duel-roll:${roundId}:${seed}:${n}`))[0];
let t: TestDb;
before(async () => {
  t = await createTestDb();
  await t.raw.exec("ALTER TABLE coin_ledger ALTER COLUMN created_at SET DEFAULT '2026-10-28T12:00:00Z'::timestamptz");
});
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

function runtime(profile: Profile = 'burn') {
  let clock = T0;
  let sequence = 0;
  let lastRoundId = '';
  const wires: Wire[] = [];
  const redis = new Map<string, { value: string; expires: number }>();
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? clock : value instanceof Date ? value.getTime() : value); }
    static override now() { return clock; }
  }
  const values: Record<string, unknown> = {
    'db/index': { db: t.db }, 'db/schema': schema,
    util: { id: () => (lastRoundId = `choice-fixture-${++sequence}`) },
    env: { env: { economyPreviewUsers: [] } },
    realtime: {
      redisPub: {
        set: async (key: string, value: string, _px: string, ms: number, nx?: string) => {
          if (nx && (redis.get(key)?.expires ?? 0) > clock) return null;
          redis.set(key, { value, expires: clock + ms }); return 'OK';
        },
        pttl: async (key: string) => Math.max(-2, (redis.get(key)?.expires ?? clock - 2) - clock),
        eval: async (_script: string, _count: number, key: string, token: string) => {
          if (redis.get(key)?.value === token) redis.delete(key); return 1;
        },
        get: async (key: string) => key.startsWith('presence:ch:')
          ? JSON.stringify(['a', 'b', 'c'].map(userId => ({ userId }))) : redis.get(key)?.value ?? null,
      },
      publishToUser: async (userId: string, message: Wire['message']) => { wires.push({ userId, message: normal(message) }); },
      publishToServer: async (_serverId: string, message: Wire['message']) => { wires.push({ message: normal(message) }); },
      publishToChannel: async (_serverId: string, _channelId: string, message: Wire['message'], audience: string[]) => {
        wires.push({ message: normal(message), audience: [...audience] });
      },
    },
  };
  const files = new Set(['gameDuel', 'gameDuelRules', 'gameMoney', 'gameMoneyRules', 'coins', 'coinRules', 'streakRules', 'economyDefaults', 'voicePresence']);
  const cache = new Map<string, Record<string, any>>();
  function load<T>(file: string): T {
    if (Object.hasOwn(values, file)) return values[file] as T;
    if (cache.has(file)) return cache.get(file) as T;
    assert.ok(files.has(file), `R333 setup: неописанный импорт ${file}`);
    const source = read(file);
    const module = { exports: {} as Record<string, any> };
    cache.set(file, module.exports);
    runInNewContext(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer, Error, Uint8Array,
      setInterval() { throw new Error('R333 setup: фоновые worker запрещены'); },
      console: { warn() {} },
      require(id: string) {
        if (id === 'drizzle-orm') return orm;
        if (id === '@gusvoice/shared') return shared;
        if (id === 'node:crypto') return { ...crypto, randomBytes: (size: number) => {
          ++sequence;
          if (size !== 32) return Buffer.alloc(size, sequence % 256);
          for (let n = 0; n < 100000; n++) {
            const seed = hash(`R333 synthetic ${lastRoundId} ${profile} ${n}`);
            const hex = seed.toString('hex');
            if (profile === 'dice') {
              // Select random input for two actual wins; production generation and settlement stay intact.
              if ([0, 1].every(n => {
                const rolled = shared.diceFromHash(hash(`gv-duel-roll:${lastRoundId}:${hex}:${n}`));
                return rolled[0] + rolled[1] > rolled[2] + rolled[3];
              })) return seed;
              continue;
            }
            if ((hash(`gv-duel-first:${lastRoundId}:${hex}`)[0] & 1) !== 1) continue;
            if (profile === 'burn' && die(lastRoundId, hex, 0) === 4 && die(lastRoundId, hex, 1) === 1) return seed;
            if (profile === 'win' && [0, 1, 2, 3].every(i => die(lastRoundId, hex, i) === 5) && die(lastRoundId, hex, 4) !== 5) return seed;
          }
          throw new Error('R333 setup: не найдено синтетическое зерно');
        } };
        assert.ok(id.startsWith('.'), `R333 setup: неописанный внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(file), id)).replace(/\.js$/, ''));
      },
    });
    return module.exports as T;
  }
  return { duel: load<Duel>('gameDuel'), wires, clock(ms: number) { clock = T0 + ms; } };
}
type Fixture = ReturnType<typeof runtime>;
async function fixture(profile?: Profile) {
  await truncateAll(t.raw);
  const users = ['a', 'b', 'c'];
  await t.db.insert(schema.users).values(users.map(id => ({ id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true })));
  await t.db.insert(schema.servers).values({ id: 's', name: 'Синтетические выборные игры', ownerId: 'a' });
  await t.db.insert(schema.serverMembers).values(users.map(userId => ({ serverId: 's', userId })));
  await t.db.insert(schema.channels).values({ id: 'v', serverId: 's', name: 'Синтетический голос', type: 'voice' });
  await t.db.insert(schema.serverEconomy).values({ serverId: 's', enabled: true, gamesEnabled: true, gamesBetMax: 300, gamesDailyLossMax: 0, gamesFeePercent: 10 });
  await t.db.insert(schema.coinBalances).values(users.map(userId => ({ serverId: 's', userId, balance: 1000, earnedTotal: 17, seasonEarned: 23, seasonId: 'autumn-2026' })));
  await t.db.insert(schema.coinLedger).values(users.map(userId => ({ id: `fund-${userId}`, serverId: 's', userId, amount: 1000, reason: 'fixture' })));
  return runtime(profile);
}
async function row(id: string) { return (await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, id)))[0]!; }
async function moves(id: string) { return normal(await t.db.select().from(schema.gameMoves).where(orm.eq(schema.gameMoves.roundId, id)).orderBy(orm.asc(schema.gameMoves.seq), orm.asc(schema.gameMoves.userId))); }
async function balances() { return Object.fromEntries((await t.db.select().from(schema.coinBalances)).map(w => [w.userId, w.balance])); }
async function ledger(reason?: string) {
  const all = await t.db.select().from(schema.coinLedger).orderBy(orm.asc(schema.coinLedger.id));
  return normal(reason ? all.filter(l => l.reason === reason) : all);
}
async function drift() {
  const result = await t.raw.query(`SELECT b.user_id FROM coin_balances b LEFT JOIN coin_ledger l USING (server_id,user_id)
    GROUP BY b.server_id,b.user_id,b.balance HAVING b.balance <> COALESCE(SUM(l.amount),0)::int`);
  assert.deepEqual(result.rows, [], 'R333 drift: каждый кошелёк равен сумме настоящего журнала');
}
async function challenge(f: Fixture, game: shared.DuelGame, ms = 0, reverse = false) {
  f.clock(ms);
  return normal(await f.duel.challengeDuel({ serverId: 's', channelId: 'v', challengerId: reverse ? 'b' : 'a', targetId: reverse ? 'a' : 'b', game, amount: 100 }, at(ms)));
}
async function invite(f: Fixture, game: shared.DuelGame) {
  const result = await challenge(f, game);
  assert.ok(result.ok && result.duel, 'R333 setup: корректный вызов принят'); return result.duel.id;
}
async function accept(f: Fixture, id: string) {
  f.clock(1); const result = await f.duel.acceptDuel('s', id, 'b', at(1));
  assert.ok(result.ok && result.duel, 'R333 setup: корректное принятие прошло'); return normal(result.duel);
}
async function move(f: Fixture, id: string, userId: string, seq: number, value: string, ms: number) {
  f.clock(ms); return normal(await f.duel.moveDuel('s', id, userId, seq, value, at(ms)));
}
async function tick(f: Fixture, ms: number) { f.clock(ms); return normal(await f.duel.runDuelTick(at(ms))); }
const events = (f: Fixture) => f.wires.filter(w => w.message.t === 'duel.state');
async function state(id: string) { return normal({ row: await row(id), moves: await moves(id), ledger: await ledger(), balances: await balances() }); }

async function rpsPrivacy() {
  const p = 'R333 руки:';
  const f = await fixture(); const id = await invite(f, 'rps');
  const start = await accept(f, id);
  assert.equal(start.seed, null, `${p} зерно скрыто после принятия`);
  assert.equal(start.moveUntil, at(20001).toISOString(), `${p} общий срок хода 20 секунд`);
  const first = await move(f, id, 'a', 0, 'rock', 1251);
  assert.ok(first.ok && first.duel, `${p} первая корректная рука принята`);
  assert.equal(first.myHand, 'rock', `${p} ответ самому подтверждает свою руку`);
  const expected = { rounds: [], ready: { challenger: true, target: false }, wins: { challenger: 0, target: 0 } };
  assert.deepEqual((await row(id)).data.rps, expected, `${p} в data нет скрытой руки, лишь готовность`);
  assert.ok(!JSON.stringify((await row(id)).data).includes('"rock"'), `${p} руку нельзя спрятать и в другом поле data`);
  assert.deepEqual(first.duel.rps, { ...expected, seq: 0 }, `${p} общий DTO не несёт руку`);
  for (const viewer of ['a', 'b', 'c']) {
    const snap = normal(await f.duel.duelSnapshot('s', 'v', viewer, at(1251)));
    assert.deepEqual(snap.duel, first.duel, `${p} общий снимок одинаков у игрока, соперника и зрителя`);
    assert.equal(snap.myHand, viewer === 'a' ? 'rock' : viewer === 'b' ? null : undefined, `${p} myHand только владельцу хода`);
    if (viewer === 'c') assert.ok(!Object.hasOwn(snap, 'myHand'), `${p} у зрителя нет даже поля myHand`);
  }
  assert.ok(events(f).every(w => !JSON.stringify(w.message).includes('rock') && !Object.hasOwn(w.message.duel, 'myHand')),
    `${p} ни личное уведомление, ни общий пуш не раскрывает руку`);
  assert.deepEqual(events(f).at(-1)!.audience!.sort(), ['a', 'b', 'c'], `${p} отсутствие утечки проверено на реальной аудитории зрителя`);
  const before = await state(id); const count = events(f).length;
  const retry = await move(f, id, 'a', 0, 'paper', 1252);
  assert.ok(retry.ok && retry.myHand === 'rock', `${p} передумать повтором нельзя`);
  assert.deepEqual(await state(id), before, `${p} повтор не меняет строку, think_ms и журнал`);
  assert.equal(events(f).length, count, `${p} повтор не создаёт новый пуш`);
  const second = await move(f, id, 'b', 0, 'scissors', 2501);
  assert.ok(second.ok && second.duel, `${p} вторая корректная рука принята`);
  assert.equal(second.myHand, null, `${p} после раскрытия текущей скрытой руки нет`);
  assert.deepEqual(second.duel.rps, { rounds: [{ challenger: 'rock', target: 'scissors', winner: 'challenger' }],
    ready: { challenger: false, target: false }, wins: { challenger: 1, target: 0 }, seq: 1 }, `${p} обе руки раскрылись одной транзакцией`);
  assert.deepEqual((await moves(id)).map(m => [m.userId, m.seq, m.move, m.thinkMs]),
    [['a', 0, { hand: 'rock' }, 1250], ['b', 0, { hand: 'scissors' }, 2500]], `${p} руки и отдельное время размышления только в game_moves`);
  assert.equal((await row(id)).settleAt!.toISOString(), at(22501).toISOString(), `${p} следующий раунд получает новый полный срок`);
  const revealed = await state(id);
  assert.ok((await move(f, id, 'a', 0, 'scissors', 2502)).ok, `${p} повтор раскрытого seq идемпотентен`);
  assert.deepEqual(await state(id), revealed, `${p} раскрытый раунд нельзя переписать`);
  await drift();
}
test('R333 КНБ скрывает руку в data/DTO/пуше; myHand личный, повтор неизменен, обе руки раскрываются разом с think_ms', () => rpsPrivacy());

async function rpsRefusals() {
  const p = 'R333 ввод КНБ:';
  const f = await fixture(); const id = await invite(f, 'rps'); await accept(f, id);
  const before = await state(id);
  for (const [user, seq, hand, code] of [['a', 1, 'rock', 'stale_seq'], ['a', 0, 'roll', 'bad_move'], ['c', 0, 'rock', 'not_player']] as const) {
    assert.deepEqual(await move(f, id, user, seq, hand, 2), { ok: false, code }, `${p} ${code} без записи`);
    assert.deepEqual(await state(id), before, `${p} отклонённый ввод не меняет состояние`);
  }
  assert.ok((await move(f, id, 'a', 0, 'paper', 3)).ok, `${p} корректный seq и рука проходят`);
  assert.ok((await move(f, id, 'b', 0, 'rock', 4)).ok, `${p} корректный ход второго игрока проходит`);
  assert.equal((await moves(id)).length, 2, `${p} записаны только два принятых хода`); await drift();
}
test('R333 КНБ отклоняет чужого игрока, неверную руку и чужой seq, но принимает парные корректные ходы', () => rpsRefusals());

async function rpsSettlement() {
  const p = 'R333 итог КНБ:';
  const f = await fixture(); const id = await invite(f, 'rps'); await accept(f, id);
  // Комиссия замораживается при вызове, изменение настроек не меняет уже принятый банк.
  await t.db.update(schema.serverEconomy).set({ gamesFeePercent: 50 });
  for (let seq = 0; seq < 2; seq++) {
    await move(f, id, 'a', seq, 'rock', 10 + seq * 2); await move(f, id, 'b', seq, 'scissors', 11 + seq * 2);
  }
  assert.equal((await row(id)).data.phase, 'done', `${p} две победы завершают партию`);
  assert.deepEqual(await tick(f, 1512), { steps: 0 }, `${p} до конца анимации выплаты нет`);
  assert.deepEqual(await tick(f, 1513), { steps: 1 }, `${p} ровно после анимации расчёт`);
  const done = await row(id);
  assert.deepEqual([done.state, done.data.winnerId, done.data.payout, done.data.fee], ['settled', 'a', 180, 20], `${p} победитель и замороженная комиссия 10 процентов`);
  assert.deepEqual(await balances(), { a: 1080, b: 900, c: 1000 }, `${p} выигрыш — перевод из двух эскроу, не выпуск монет`);
  const wins = await ledger('duel.win');
  assert.deepEqual(wins.map(w => [w.userId, w.amount, w.refUserId, w.data.net]), [['a', 180, 'b', 80]], `${p} журнал содержит чистый поток и проигравшего`);
  assert.ok((await t.db.select().from(schema.gameStakes)).every(s => s.paidAt !== null && s.refundedAt === null), `${p} обе ставки закрыты выплатой`);
  const dto = events(f).at(-1)!.message.duel;
  assert.equal(hash(`gv-duel-commit:${id}:${dto.seed}`).toString('hex'), dto.commit, `${p} раскрытое зерно подтверждает исходный commit`);
  assert.ok((await t.db.select().from(schema.coinBalances)).every(w => w.earnedTotal === 17 && w.seasonEarned === 23), `${p} игра не становится заработком сезона`);
  const before = await state(id); const count = events(f).length;
  assert.ok((await move(f, id, 'a', 0, 'paper', 2000)).ok, `${p} повтор своего хода после итога безопасен`);
  assert.deepEqual(await tick(f, 100000), { steps: 0 }, `${p} закрытый раунд не рассчитывается повторно`);
  assert.deepEqual(await state(id), before, `${p} replay не создаёт денег или ходов`);
  assert.equal(events(f).length, count, `${p} replay не публикует второй итог`); await drift();
}
test('R333 две победы КНБ рассчитывают настоящий escrow единожды с замороженной комиссией, net и drift 0', () => rpsSettlement());

async function rpsDraws() {
  const p = 'R333 ничьи:';
  const f = await fixture(); const id = await invite(f, 'rps'); await accept(f, id);
  for (let seq = 0; seq < 7; seq++) {
    await move(f, id, 'a', seq, 'paper', 10 + seq * 2); await move(f, id, 'b', seq, 'paper', 11 + seq * 2);
    assert.equal((await row(id)).data.phase, seq === 6 ? 'done' : 'moving', `${p} шестая ничья ещё игра, седьмая уже предел`);
  }
  await tick(f, 1523);
  const done = await row(id);
  assert.deepEqual([done.state, done.data.reason, done.data.winnerId, done.data.payout], ['settled', 'draw-limit', null, null], `${p} лимит ничьих возвращает обе ставки`);
  assert.deepEqual(await balances(), { a: 1000, b: 1000, c: 1000 }, `${p} полный возврат без комиссии`);
  assert.equal((await ledger('duel.refund')).length, 2, `${p} по одному возврату обоим`);
  assert.equal((await ledger('duel.win')).length, 0, `${p} победителя не выдумали`);
  assert.equal((await moves(id)).length, 14, `${p} семь пар настоящих ходов`); await drift();
}
test('R333 шестая ничья КНБ переигрывается, седьмая возвращает обе ставки без комиссии', () => rpsDraws());

async function rpsTimeouts() {
  const p = 'R333 срок КНБ:';
  for (const picked of [null, 'a', 'b'] as const) {
    const f = await fixture(); const id = await invite(f, 'rps'); await accept(f, id);
    if (picked) await move(f, id, picked, 0, 'rock', 2);
    assert.deepEqual(await tick(f, 20000), { steps: 0 }, `${p} за миллисекунду до срока ничего не решено`);
    assert.deepEqual(await tick(f, 20001), { steps: 1 }, `${p} ровно в срок один переход`);
    assert.deepEqual([(await row(id)).state, (await row(id)).data.phase], ['locked', 'done'], `${p} сначала решён исход, деньги отдельным тактом`);
    await tick(f, 20001);
    const done = await row(id);
    assert.deepEqual([done.state, done.data.reason, done.data.winnerId], ['settled', 'timeout', picked], `${p} сходивший побеждает, два молчащих получают возврат`);
    assert.deepEqual(await balances(), { a: picked === 'a' ? 1080 : picked ? 900 : 1000, b: picked === 'b' ? 1080 : picked ? 900 : 1000, c: 1000 }, `${p} деньги соответствуют таймауту каждого из вариантов`);
    assert.equal((await ledger('duel.refund')).length, picked ? 0 : 2, `${p} возврат только если оба молчали`);
    assert.equal((await moves(id)).length, picked ? 1 : 0, `${p} сервер не выдумывает руку за молчащего`);
    assert.equal((await row(id)).data.auto, undefined, `${p} КНБ не записывает фиктивный автоход`);
    const before = await state(id); await tick(f, 99999);
    assert.deepEqual(await state(id), before, `${p} повтор такта не удваивает расчёт`); await drift();
  }
}
test('R333 таймаут КНБ одного игрока проигрывает ему партию, обоих возвращает ставки; граница −1/ровно и replay', () => rpsTimeouts());

async function conflictScenario() {
  const f = await fixture();
  const id = await invite(f, 'rps'); await accept(f, id); await move(f, id, 'a', 0, 'rock', 2);
  const before = await state(id); await move(f, id, 'a', 0, 'paper', 3);
  assert.deepEqual(await state(id), before, 'R333 конфликт: настоящий PK и INSERT сохраняют единственную первую руку'); await drift();
}
test('повтор руки сохраняет первый ход, раунд, журнал и балансы', () => conflictScenario());

async function greedyRefusals() {
  const p = 'R333 ввод гуся:';
  const f = await fixture(); const id = await invite(f, 'greedy'); const start = await accept(f, id);
  assert.equal(start.greedy!.turn, 'challenger', `${p} первый выбран настоящим хешем зерна`);
  const before = await state(id);
  for (const [user, seq, value, code] of [['a', 0, 'stop', 'bad_move'], ['b', 0, 'roll', 'not_your_turn'], ['a', 1, 'roll', 'stale_seq'], ['a', 0, 'rock', 'bad_move']] as const) {
    assert.deepEqual(await move(f, id, user, seq, value, 2), { ok: false, code }, `${p} ${code} без записи`);
    assert.deepEqual(await state(id), before, `${p} отказ не расходует seq и деньги`);
  }
  const roll = await move(f, id, 'a', 0, 'roll', 12);
  assert.ok(roll.ok && roll.duel?.greedy?.turnPoints === 4, `${p} бросок с пустой копилкой разрешён`);
  const stop = await move(f, id, 'a', 1, 'stop', 33);
  assert.ok(stop.ok && stop.duel?.greedy?.scores.challenger === 4 && stop.duel.greedy.turn === 'target', `${p} стоп с непустой копилкой сохраняет очки и передаёт ход`);
  assert.deepEqual((await moves(id)).map(m => [m.seq, m.move, m.thinkMs]), [[0, { kind: 'roll', n: 0, die: 4 }, 11], [1, { kind: 'stop', bank: 4 }, 21]], `${p} каждый принятый ход получает собственное think_ms`);
  await drift();
}
test('R333 гусь запрещает стоп с нуля/чужой ход/неверный seq/руку КНБ; корректные roll и stop принимаются с think_ms', () => greedyRefusals());

async function greedyBurn() {
  const p = 'R333 сгорело:';
  const f = await fixture(); const id = await invite(f, 'greedy'); await accept(f, id);
  await move(f, id, 'a', 0, 'roll', 2);
  const burned = await move(f, id, 'a', 1, 'roll', 3);
  assert.ok(burned.ok && burned.duel?.greedy, `${p} второй бросок принят`);
  assert.deepEqual([burned.duel.greedy.turn, burned.duel.greedy.turnPoints, burned.duel.greedy.burned, burned.duel.greedy.scores], ['target', 0, 4, { challenger: 0, target: 0 }], `${p} единица сжигает только копилку и передаёт ход`);
  assert.deepEqual((await moves(id))[1].move, { kind: 'roll', n: 1, die: 1, burned: 4 }, `${p} журнал хранит величину сгорания, а не только кость`);
  assert.deepEqual((await row(id)).data.auto, undefined, `${p} ручной ход не становится автоходом`);
  const before = await state(id);
  assert.ok((await move(f, id, 'a', 1, 'stop', 4)).ok, `${p} повтор старого хода после передачи хода допустим`);
  assert.deepEqual(await state(id), before, `${p} повтор не превращает сгорание в стоп`); await drift();
}
test('R333 единица гуся сжигает очки хода, пишет burned и передаёт ход; повтор не меняет решение', () => greedyBurn());

async function greedyWin() {
  const p = 'R333 двадцать:';
  const f = await fixture('win'); const id = await invite(f, 'greedy'); await accept(f, id);
  for (let seq = 0; seq < 4; seq++) {
    const result = await move(f, id, 'a', seq, 'roll', 10 + seq);
    assert.ok(result.ok && result.duel?.greedy, `${p} очередной бросок принят`);
    assert.deepEqual([result.duel.greedy.scores.challenger, result.duel.greedy.turnPoints, (await row(id)).data.phase],
      seq === 3 ? [20, 0, 'done'] : [0, (seq + 1) * 5, 'moving'], `${p} до цели копится, ровно 20 засчитывается автоматически`);
  }
  assert.deepEqual(await move(f, id, 'a', 4, 'roll', 14), { ok: false, code: 'not_playing' }, `${p} после цели рисковать дальше нельзя`);
  await tick(f, 1513);
  const done = await row(id); const dto = events(f).at(-1)!.message.duel;
  assert.deepEqual([done.state, dto.winnerId, dto.payout], ['settled', 'a', 180], `${p} цель рассчитывает настоящий денежный банк`);
  assert.equal(hash(`gv-duel-commit:${id}:${dto.seed}`).toString('hex'), dto.commit, `${p} seed подтверждает commit`);
  assert.equal(dto.greedy.first, (hash(`gv-duel-first:${id}:${dto.seed}`)[0] & 1) === 1 ? 'challenger' : 'target', `${p} из seed проверяется и первый игрок`);
  assert.deepEqual(dto.greedy.rolls, [0, 1, 2, 3].map(n => die(id, dto.seed, n)), `${p} проверены все броски по сквозному n`);
  assert.deepEqual(await balances(), { a: 1080, b: 900, c: 1000 }, `${p} перевод с комиссией, не эмиссия`);
  const before = await state(id); await tick(f, 100000);
  assert.ok((await move(f, id, 'a', 3, 'stop', 100001)).ok, `${p} свой записанный ход после итога повторяем`);
  assert.deepEqual(await state(id), before, `${p} итог и escrow не повторяются`); await drift();
}
test('R333 гусь автоматически заканчивается ровно на 20; settlement/replay и проверка первого и всех бросков из seed', () => greedyWin());

async function greedyTimeouts() {
  const p = 'R333 срок гуся:';
  const f = await fixture(); const id = await invite(f, 'greedy'); await accept(f, id);
  assert.deepEqual(await tick(f, 20000), { steps: 0 }, `${p} до срока автоброска нет`);
  await tick(f, 20001);
  let g = (await row(id)).data.greedy as shared.DuelGreedyDto;
  assert.deepEqual([g.turn, g.turnPoints, g.timeouts], ['challenger', 4, { challenger: 1, target: 0 }], `${p} первая просрочка с нулём — бросок за игрока`);
  assert.deepEqual((await row(id)).data.auto, { challenger: 1, target: 0 }, `${p} data.auto считает настоящий автоход`);
  assert.deepEqual((await moves(id))[0], { roundId: id, userId: 'a', seq: 0, move: { kind: 'roll', n: 0, die: 4, auto: true }, thinkMs: null,
    createdAt: (await moves(id))[0].createdAt }, `${p} автоматический бросок записан с auto и без выдуманного think_ms`);
  const before = await state(id); const count = events(f).length;
  assert.ok((await move(f, id, 'a', 0, 'stop', 20002)).ok, `${p} поздний запрос после автоброска идемпотентен`);
  assert.deepEqual(await state(id), before, `${p} поздний стоп не переписывает автобросок`);
  assert.equal(events(f).length, count, `${p} поздний запрос не публикуется заново`);
  await tick(f, 40001);
  g = (await row(id)).data.greedy as shared.DuelGreedyDto;
  assert.deepEqual([g.turn, g.turnPoints, g.scores, g.timeouts], ['target', 0, { challenger: 4, target: 0 }, { challenger: 2, target: 0 }], `${p} вторая просрочка с копилкой — автостоп, а не бросок`);
  assert.deepEqual((await moves(id))[1].move, { kind: 'stop', bank: 4, auto: true }, `${p} автостоп тоже помечен auto`);
  assert.equal((await moves(id))[1].thinkMs, null, `${p} автостоп не становится размышлением человека`);
  await move(f, id, 'b', 2, 'roll', 40002); // Вторая кость seed = 1: ход возвращается молчащему a.
  assert.deepEqual(await tick(f, 60001), { steps: 0 }, `${p} третья просрочка не раньше нового срока`);
  await tick(f, 60002);
  assert.deepEqual([(await row(id)).data.phase, (await row(id)).data.outcome, (await row(id)).data.reason], ['done', 'target', 'timeout'], `${p} третья подряд просрочка проигрывает партию`);
  assert.equal((await moves(id)).length, 3, `${p} поражение по третьей просрочке не выдумывает ещё один бросок`);
  assert.deepEqual((await row(id)).data.auto, { challenger: 2, target: 0 }, `${p} поражение не считается третьим автоходом`);
  await tick(f, 60002);
  assert.deepEqual(await balances(), { a: 900, b: 1080, c: 1000 }, `${p} проигравший по сроку теряет ставку, соперник получает банк`);
  assert.deepEqual((await row(id)).data.greedy && ((await row(id)).data.greedy as shared.DuelGreedyDto).timeouts, { challenger: 3, target: 0 }, `${p} последовательные просрочки не перепутаны с автоходами`);
  const done = await state(id); await tick(f, 100000);
  assert.ok((await move(f, id, 'a', 1, 'roll', 100001)).ok, `${p} повтор автостопа после итога безопасен`);
  assert.deepEqual(await state(id), done, `${p} replay не удваивает выплату`); await drift();
}
test('R333 просрочка гуся: автобросок с нуля, автостоп с очками, поздний повтор, move.auto/think_ms и поражение на третьей', () => greedyTimeouts());

async function diceThinkAuto() {
  const p = 'R333 время кубиков:';
  const f = await fixture('dice'); const id = await invite(f, 'dice'); await accept(f, id);
  f.clock(3001);
  const rolled = normal(await f.duel.rollDuel('s', id, 'a', at(3001)));
  assert.ok(rolled.ok && rolled.duel, `${p} настоящий бросок первого игрока принимается`);
  assert.deepEqual((await row(id)).data.think, { challenger: [3000], target: [] }, `${p} withThink подключён к ручному rollDuel: ровно 3000 мс от принятия`);
  assert.equal((await row(id)).data.auto, undefined, `${p} ручной бросок не считается автоматическим`);
  const before = await state(id); const count = events(f).length;
  f.clock(3002);
  assert.ok((await f.duel.rollDuel('s', id, 'a', at(3002))).ok, `${p} повтор уже раскрытого броска допустим`);
  assert.deepEqual(await state(id), before, `${p} повтор не дописывает второе время размышления`);
  assert.equal(events(f).length, count, `${p} повтор не создаёт второй пуш`);
  assert.deepEqual(await tick(f, 15000), { steps: 0 }, `${p} за миллисекунду до срока автохода нет`);
  assert.deepEqual(await tick(f, 15001), { steps: 1 }, `${p} ровно в срок сервер раскрывает молчавшего`);
  const automatic = await row(id);
  assert.deepEqual(automatic.data.auto, { challenger: 0, target: 1 }, `${p} withAuto подключён именно к такту кубиков и только молчавшей стороне`);
  assert.deepEqual(automatic.data.think, { challenger: [3000], target: [] }, `${p} автоход не становится размышлением человека`);
  assert.equal(automatic.data.phase, 'playing', `${p} первая победа не завершает партию до двух`);
  assert.equal(automatic.data.rollNo, 1, `${p} вторая пара ещё не раскрыта`);
  assert.deepEqual(await balances(), { a: 900, b: 900, c: 1000 }, `${p} после первой победы банк остаётся в escrow`);
  assert.equal((await ledger('duel.win')).length, 0, `${p} за отдельный бросок выплаты нет`);
  assert.equal((await moves(id)).length, 0, `${p} у кубиков think/auto живут в data, а не фиктивных game_moves`);
  f.clock(16001);
  const second = normal(await f.duel.rollDuel('s', id, 'a', at(16001), 1));
  assert.ok(second.ok && second.duel, `${p} ручной бросок второй пары принимается`);
  assert.deepEqual((await row(id)).data.think, { challenger: [3000, 1000], target: [] }, `${p} время второго броска считается от нового срока`);
  const secondBefore = await state(id); const secondCount = events(f).length;
  f.clock(16002);
  assert.ok((await f.duel.rollDuel('s', id, 'a', at(16002), 1)).ok, `${p} повтор второго броска безопасен`);
  assert.deepEqual(await state(id), secondBefore, `${p} повтор второй пары не меняет think и деньги`);
  assert.equal(events(f).length, secondCount, `${p} повтор второй пары не дублирует пуш`);
  assert.deepEqual(await tick(f, 30000), { steps: 0 }, `${p} второй автоход не раньше нового дедлайна`);
  assert.deepEqual(await tick(f, 30001), { steps: 1 }, `${p} второй автоход ровно в новый дедлайн`);
  const finished = await row(id);
  assert.deepEqual(finished.data.auto, { challenger: 0, target: 2 }, `${p} автоходы учитываются для каждого броска только молчавшей стороне`);
  assert.deepEqual(finished.data.think, { challenger: [3000, 1000], target: [] }, `${p} второй автоход не добавляет время человека`);
  assert.equal(finished.data.phase, 'done', `${p} вторая настоящая победа завершает раскрытие`);
  assert.equal((await moves(id)).length, 0, `${p} второй бросок не создаёт фиктивных game_moves`);
  assert.equal((await ledger('duel.stake')).length, 2, `${p} за партию удержаны только две исходные ставки`);
  assert.equal((await ledger('duel.win')).length, 0, `${p} до окончания анимации банк ещё не выплачен`);
  assert.deepEqual(await tick(f, 31500), { steps: 0 }, `${p} банк ждёт конца анимации`);
  await tick(f, 31501);
  assert.deepEqual([(await row(id)).state, (await row(id)).data.winnerId, await balances()],
    ['settled', 'a', { a: 1080, b: 900, c: 1000 }], `${p} настоящий расчёт кубиков платит один банк`);
  const done = await state(id); await tick(f, 100000);
  assert.deepEqual(await state(id), done, `${p} повтор такта не дописывает auto/think или деньги`); await drift();
}
test('R333 кубики реально записывают data.think ручного броска и data.auto только молчавшего; settlement/replay и drift 0', () => diceThinkAuto());

type History = { game: shared.DuelGame; winner: string; loser: string; net: number; amount: number; when: number; reason?: string };
async function history(entries: History[]) {
  // Это синтетический уже закрытый журнал для SQL-предела, не имитация payStake.
  // Баланс растёт на реальную amount той же строки: drift проверяется и здесь.
  for (const [n, e] of entries.entries()) {
    const id = `history-${n}`;
    await t.db.insert(schema.gameRounds).values({ id, serverId: 's', kind: 'duel', state: 'settled', createdBy: 'a', settledAt: at(e.when), data: { game: e.game } });
    await t.db.insert(schema.coinLedger).values({ id: `history-ledger-${n}`, serverId: 's', userId: e.winner, refUserId: e.loser,
      reason: e.reason ?? 'duel.win', amount: e.amount, createdAt: at(e.when), data: { roundId: id, pick: 'duel', net: e.net } });
    await t.db.update(schema.coinBalances).set({ balance: orm.sql`${schema.coinBalances.balance} + ${e.amount}` }).where(orm.eq(schema.coinBalances.userId, e.winner));
  }
}
async function pairSql() {
  const p = 'R333 поток:';
  const startMsk = Date.parse('2026-10-27T21:00:00Z') - T0;
  const midnight = Date.parse('2026-10-28T21:00:00Z') - T0;
  const entries: History[] = [
    { game: 'rps', winner: 'a', loser: 'b', net: 80, amount: 180, when: startMsk },
    { game: 'greedy', winner: 'b', loser: 'a', net: 30, amount: 130, when: startMsk + 1 },
    { game: 'greedy', winner: 'a', loser: 'b', net: 40, amount: 140, when: startMsk + 2 },
    { game: 'rps', winner: 'a', loser: 'b', net: 800, amount: 900, when: startMsk - 1 },
    { game: 'dice', winner: 'a', loser: 'b', net: 700, amount: 800, when: startMsk + 1 },
    { game: 'rps', winner: 'a', loser: 'c', net: 600, amount: 700, when: startMsk + 1 },
    { game: 'rps', winner: 'a', loser: 'b', net: 500, amount: 600, when: startMsk + 1, reason: 'fixture' },
  ];
  // 80 - 30 + 40 = 90; чистая новая выплата 180 - собственная ставка 100 = 80.
  for (const reverse of [false, true]) for (const max of [170, 169]) {
    const f = await fixture(); await history(entries);
    await t.db.update(schema.serverEconomy).set({ gamesPairDailyMax: max });
    const before = normal({ balances: await balances(), ledger: await ledger() });
    const result = await challenge(f, 'rps', 0, reverse);
    assert.equal(result.ok, max === 170, `${p} обе ориентации пары: ровно |90|+80 проходит, предел−1 нет`);
    if (!result.ok) assert.equal(result.code, 'pair_limit', `${p} мягкий отказ назван как предел пары`);
    assert.deepEqual(normal({ balances: await balances(), ledger: await ledger() }), before, `${p} мягкая проверка денег не трогает`);
    assert.equal((await t.db.select().from(schema.gameStakes)).length, 0, `${p} вызов не замораживает деньги`); await drift();
  }
  for (const ms of [midnight - 1, midnight]) {
    const f = await fixture(); await history(entries); await t.db.update(schema.serverEconomy).set({ gamesPairDailyMax: 80 });
    const result = await challenge(f, 'greedy', ms);
    assert.equal(result.ok, ms === midnight, `${p} поток сбрасывается ровно в полночь МСК, а не UTC`); await drift();
  }
  // Даже исчерпанная пара вправе играть в dice: ограничение не должно протечь на случайную игру.
  for (const game of ['dice', 'rps'] as const) {
    const f = await fixture(); await history(entries); await t.db.update(schema.serverEconomy).set({ gamesPairDailyMax: game === 'dice' ? 1 : 0 });
    const result = await challenge(f, game);
    assert.ok(result.ok, `${p} dice не ограничены, а нулевой предел отключён для rps`); await drift();
  }
}
test('R333 настоящий SQL считает net в обе стороны и сутки МСК, исключает dice/другую пару/не-win; граница и отключение', () => pairSql());

async function hardPair() {
  const p = 'R333 принятие пары:';
  for (const game of ['rps', 'greedy'] as const) {
    const f = await fixture();
    await t.db.update(schema.serverEconomy).set({ gamesPairDailyMax: 80 });
    const id = await invite(f, game);
    await t.db.update(schema.serverEconomy).set({ gamesPairDailyMax: 79 });
    const before = await state(id); const count = events(f).length;
    const denied = normal(await f.duel.acceptDuel('s', id, 'b', at(1)));
    assert.deepEqual(denied, { ok: false, code: 'pair_limit' }, `${p} изменившийся после вызова предел перепроверяется жёстко`);
    assert.deepEqual(await state(id), before, `${p} отказ до обеих ставок: деньги, ledger, round и moves нетронуты`);
    assert.equal(events(f).length, count, `${p} неуспешное принятие не публикует playing`);
    await t.db.update(schema.serverEconomy).set({ gamesPairDailyMax: 80 });
    const started = await accept(f, id);
    assert.equal(started.state, 'playing', `${p} ровно предел разрешает принятие`);
    assert.deepEqual(await balances(), { a: 900, b: 900, c: 1000 }, `${p} разрешённое принятие создаёт две равные ставки`);
    assert.equal((await ledger('duel.stake')).length, 2, `${p} только успешное принятие списало обоих`); await drift();
  }
  const f = await fixture();
  await t.db.update(schema.serverEconomy).set({ gamesPairDailyMax: 1 });
  const id = await invite(f, 'dice');
  const dice = await accept(f, id);
  assert.equal(dice.state, 'playing', `${p} dice принимаются даже при пределе пары меньше чистой выплаты`);
  assert.deepEqual(await balances(), { a: 900, b: 900, c: 1000 }, `${p} dice не получают случайный pair_limit в accept`);
  await drift();
}
test('принятие перепроверяет изменившийся предел пары: отказ без денег и успешная граница', () => hardPair());
