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

// R356: целые настоящие модули, миграции, schema, SQL и денежные транзакции.
// Подмена только IO/clock/RNG; не HTTP/auth/perms. Односессионный PGlite не
// доказывает гонки PostgreSQL и доставку настоящего Redis/gateway.
type Duel = typeof import('../src/gameDuel.js');
type Rules = typeof import('../src/gameDuelRules.js');
type Wire = { userId?: string; audience?: string[]; message: Record<string, any> };
const T0 = Date.parse('2026-10-29T12:00:00Z');
const at = (ms: number) => new Date(T0 + ms);
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const read = (file: string) => readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const hash = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest();
let t: TestDb;
before(async () => {
  t = await createTestDb();
  await t.raw.exec("ALTER TABLE coin_ledger ALTER COLUMN created_at SET DEFAULT '2026-10-29T12:00:00Z'::timestamptz");
});
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

function runtime() {
  let clock = T0; let sequence = 0; let lastId = '';
  const wires: Wire[] = []; const warnings: unknown[][] = [];
  const redis = new Map<string, { value: string; expires: number }>();
  class Clock extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? clock : value instanceof Date ? value.getTime() : value); }
    static override now() { return clock; }
  }
  const values: Record<string, unknown> = {
    'db/index': { db: t.db }, 'db/schema': schema,
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
        get: async (key: string) => key === 'presence:ch:v'
          ? JSON.stringify(['a', 'b', 'c'].map(userId => ({ userId }))) : redis.get(key)?.value ?? null,
      },
      publishToUser: async (userId: string, message: Wire['message']) => { wires.push({ userId, message: normal(message) }); },
      publishToChannel: async (_server: string, _channel: string, message: Wire['message'], audience: string[]) => {
        wires.push({ message: normal(message), audience: [...audience] });
      },
    },
  };
  const allowed = new Set(['gameDuel', 'gameDuelRules', 'gameMoney', 'gameMoneyRules', 'coins', 'coinRules', 'streakRules', 'economyDefaults', 'voicePresence', 'util']);
  const cache = new Map<string, Record<string, any>>();
  function load<T>(file: string): T {
    if (Object.hasOwn(values, file)) return values[file] as T;
    if (cache.has(file)) return cache.get(file) as T;
    assert.ok(allowed.has(file), `R356 setup: неизвестный импорт ${file}`);
    const source = read(file);
    const module = { exports: {} as Record<string, any> }; cache.set(file, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText, {
      module, exports: module.exports, Date: Clock, Buffer, Error, Uint8Array,
      console: { warn: (...args: unknown[]) => warnings.push(args) },
      setInterval() { throw new Error('R356 setup: worker запрещён'); },
      require(id: string) {
        if (id === 'drizzle-orm') return orm;
        if (id === '@gusvoice/shared') return shared;
        if (id === 'node:crypto') return { ...crypto,
          randomUUID: () => (lastId = `hidden-fixture-${++sequence}`),
          randomBytes: (size: number) => {
            if (size !== 32) return Buffer.alloc(size, ++sequence % 256);
            // Подбирается лишь RNG: greedyAct/greedyTimeout сами считают кости.
            for (let n = 0; n < 300000; n++) {
              const seed = hash(`R356 synthetic ${lastId} ${n}`); const hex = seed.toString('hex');
              if (shared.greedyFirstSide(hash(shared.greedyFirstInput(lastId, hex))) !== 'challenger') continue;
              if ([4, 3, 1, 6, 5].every((v, i) => shared.diceFromHash(hash(shared.duelRollInput(lastId, hex, i)))[0] === v)) return seed;
            }
            throw new Error('R356 setup: синтетическое зерно не найдено');
          },
        };
        assert.ok(id.startsWith('.'), `R356 setup: неизвестный внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(file), id)).replace(/\.js$/, ''));
      },
    });
    return module.exports as T;
  }
  return { duel: load<Duel>('gameDuel'), rules: load<Rules>('gameDuelRules'), wires, warnings,
    clock(ms: number) { clock = T0 + ms; } };
}
type Fixture = ReturnType<typeof runtime>;
async function fixture() {
  await truncateAll(t.raw);
  const users = ['a', 'b', 'c'];
  await t.db.insert(schema.users).values(users.map(id => ({ id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true })));
  await t.db.insert(schema.servers).values({ id: 's', name: 'Синтетическая скрытая партия', ownerId: 'a' });
  await t.db.insert(schema.serverMembers).values(users.map(userId => ({ serverId: 's', userId })));
  await t.db.insert(schema.channels).values({ id: 'v', serverId: 's', name: 'Синтетический голос', type: 'voice' });
  await t.db.insert(schema.serverEconomy).values({ serverId: 's', enabled: true, gamesEnabled: true, gamesBetMax: 300, gamesDailyLossMax: 0, gamesFeePercent: 10 });
  await t.db.insert(schema.coinBalances).values(users.map(userId => ({ serverId: 's', userId, balance: 1000, earnedTotal: 17, seasonEarned: 23, seasonId: 'autumn-2026' })));
  await t.db.insert(schema.coinLedger).values(users.map(userId => ({ id: `fund-${userId}`, serverId: 's', userId, amount: 1000, reason: 'fixture' })));
  return runtime();
}
async function row(id: string) { return (await t.db.select().from(schema.gameRounds).where(orm.eq(schema.gameRounds.id, id)))[0]!; }
async function moves(id: string) { return normal(await t.db.select().from(schema.gameMoves).where(orm.eq(schema.gameMoves.roundId, id)).orderBy(orm.asc(schema.gameMoves.seq))); }
const events = (f: Fixture) => f.wires.filter(w => w.message.t === 'duel.state');
async function start(f: Fixture) {
  const invite = await f.duel.challengeDuel({ serverId: 's', channelId: 'v', challengerId: 'a', targetId: 'b', game: 'greedy', amount: 100 }, at(0));
  assert.ok(invite.ok && invite.duel, 'R356 setup: вызов принят');
  f.clock(1); const accept = await f.duel.acceptDuel('s', invite.duel.id, 'b', at(1));
  assert.ok(accept.ok && accept.duel?.greedy, 'R356 setup: принятие прошло');
  assert.equal(accept.duel.greedy.first, 'challenger', 'R356 setup: первым ходит a');
  return invite.duel.id;
}
async function move(f: Fixture, id: string, userId: string, seq: number, kind: string, ms: number) {
  f.clock(ms); return normal(await f.duel.moveDuel('s', id, userId, seq, kind, at(ms)));
}
async function tick(f: Fixture, ms: number) { f.clock(ms); return normal(await f.duel.runDuelTick(at(ms))); }

// Независимый oracle: не вызывает greedyHide или duelDtoFor.
function shown(full: shared.DuelDto, viewer: string) {
  const g = full.greedy!; const side = viewer === 'a' ? 'challenger' : viewer === 'b' ? 'target' : null;
  const ownLast = !!g.lastRoll && g.lastRoll.by === side;
  return { ...full, greedy: {
    scores: { challenger: side === 'challenger' ? g.scores.challenger : 0, target: side === 'target' ? g.scores.target : 0 },
    turn: g.turn, turnPoints: g.turn === side ? g.turnPoints : 0,
    lastRoll: g.lastRoll && (ownLast || g.lastRoll.die === 1) ? g.lastRoll : null,
    burned: ownLast ? g.burned : 0, timeouts: g.timeouts, seq: g.seq, first: g.first,
    rolls: g.rolls.map(v => v === 1 ? 1 : 0), hidden: { challenger: side !== 'challenger', target: side !== 'target' },
  } };
}
async function observe(f: Fixture, id: string, ms: number, prefix: string, response?: { viewer: string; duel: shared.DuelDto | null }) {
  const r = await row(id); const full = normal(f.rules.duelDto(r))!;
  assert.equal(r.data.phase, 'moving', 'R356 setup: наблюдение только в ходу');
  const before = normal(r);
  for (const viewer of ['a', 'b', 'c']) {
    const snap = normal(await f.duel.duelSnapshot('s', 'v', viewer, at(ms)));
    assert.deepEqual(snap.duel, shown(full, viewer), `${prefix} снимок ${viewer}: своё открыто, чужое маскировано`);
  }
  if (response) assert.deepEqual(response.duel, shown(full, response.viewer), `${prefix} ответ на ход: собственное открыто, чужое скрыто`);
  const batch = events(f).slice(-3);
  assert.equal(batch.length, 3, `${prefix} три события реального перехода`);
  for (const viewer of ['a', 'b']) {
    const personal = batch.filter(w => w.userId === viewer);
    assert.equal(personal.length, 1, `${prefix} один личный пакет ${viewer}`);
    assert.deepEqual(personal[0].message.duel, shown(full, viewer), `${prefix} личный пакет ${viewer} маскирован независимо`);
  }
  const channel = batch.filter(w => w.audience);
  assert.equal(channel.length, 1, `${prefix} один зрительский пакет`);
  assert.deepEqual(channel[0].audience, ['c'], `${prefix} в канале нет игроков`);
  assert.deepEqual(channel[0].message.duel, shown(full, 'c'), `${prefix} зрителю скрыты обе стороны`);
  assert.deepEqual(normal(await row(id)), before, `${prefix} снимки не портят полное состояние базы`);
  assert.deepEqual(f.warnings, [], `${prefix} никакие ошибки публикации не проглочены`);
}

// Клиентская проверка — тоже целый production-модуль, без React и browser IO.
// digest передан через предусмотренный API verifyGreedy, не заменяет алгоритм.
function verifier() {
  const cache = new Map<string, Record<string, any>>();
  function load(file: string): Record<string, any> {
    if (cache.has(file)) return cache.get(file)!;
    assert.ok(['duelRules', 'wheelRules'].includes(file), `R356 setup: неизвестный клиентский импорт ${file}`);
    const source = readFileSync(new URL(`../../../apps/client/src/${file}.ts`, import.meta.url), 'utf8');
    const module = { exports: {} as Record<string, any> }; cache.set(file, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, Uint8Array, require(id: string) {
        if (id === '@gusvoice/shared') return shared;
        assert.equal(id, './wheelRules', 'R356 setup: только чистый клиентский wheelRules'); return load('wheelRules');
      } });
    return module.exports;
  }
  return load('duelRules').verifyGreedy as (duel: shared.DuelDto, digest: (s: string) => Promise<Uint8Array>) => Promise<{ ok: boolean }>;
}
async function revealed(f: Fixture, id: string, ms: number, prefix: string) {
  const r = await row(id); const full = normal(f.rules.duelDto(r))!;
  assert.ok(full.greedy!.rolls.some(v => v > 1), `${prefix} в полном раскрытии есть ненулевая кость, не тривиальные нули`);
  for (const viewer of ['a', 'b', 'c']) {
    const snap = normal(await f.duel.duelSnapshot('s', 'v', viewer, at(ms)));
    assert.deepEqual(snap.duel, full, `${prefix} после решения полный снимок у ${viewer}`);
    assert.ok(!Object.hasOwn(snap.duel!.greedy!, 'hidden'), `${prefix} признак маски снят`);
  }
  const last = events(f).at(-1)!;
  assert.deepEqual(last.audience!.slice().sort(), ['a', 'b', 'c'], `${prefix} после решения снова общая аудитория`);
  assert.deepEqual(last.message.duel, full, `${prefix} итоговый event полностью раскрыт`);
  if (r.state === 'settled') {
    const verdict = await verifier()(full, async s => new Uint8Array(hash(s)));
    assert.equal(verdict.ok, true, `${prefix} реальный verifyGreedy проверяет seed/commit/first/каждую кость`);
  }
}
async function drift(prefix: string) {
  const got = await t.raw.query(`SELECT b.user_id FROM coin_balances b LEFT JOIN coin_ledger l USING (server_id,user_id)
    GROUP BY b.server_id,b.user_id,b.balance HAVING b.balance <> COALESCE(SUM(l.amount),0)::int`);
  assert.deepEqual(got.rows, [], `${prefix} drift кошельков относительно реального журнала равен нулю`);
}

async function human() {
  const p = 'R356 ручная партия:'; const f = await fixture(); const id = await start(f);
  const script = [['a', 'roll'], ['a', 'stop'], ['b', 'roll'], ['b', 'roll'], ['a', 'roll'], ['a', 'stop'], ['b', 'roll'], ['b', 'stop']] as const;
  for (const [seq, [user, kind]] of script.entries()) {
    const ms = 2 + seq; const result = await move(f, id, user, seq, kind, ms);
    assert.ok(result.ok && result.duel, `${p} корректный ручной ход принят`);
    await observe(f, id, ms, p, { viewer: user, duel: result.duel });
  }
  const banks = (await row(id)).data.greedy as shared.DuelGreedyDto;
  assert.deepEqual(banks.scores, { challenger: 10, target: 5 }, `${p} обе стороны действительно накопили ненулевой счёт`);
  assert.deepEqual((await moves(id)).slice(0, 4).map(m => m.move), [
    { kind: 'roll', n: 0, die: 4 }, { kind: 'stop', bank: 4 }, { kind: 'roll', n: 1, die: 3 }, { kind: 'roll', n: 2, die: 1, burned: 3 },
  ], `${p} исходные скрытые числа и сгорание действительно записаны SQL, а не потеряны`);
  let ms = 10;
  for (let count = 0; count < 200 && (await row(id)).data.phase === 'moving'; count++) {
    const g = (await row(id)).data.greedy as shared.DuelGreedyDto;
    const user = g.turn === 'challenger' ? 'a' : 'b';
    const kind = g.turnPoints >= 8 ? 'stop' : 'roll';
    const result = await move(f, id, user, g.seq, kind, ++ms);
    assert.ok(result.ok && result.duel, `${p} партия продолжается настоящими ходами`);
    if ((await row(id)).data.phase === 'moving') await observe(f, id, ms, p, { viewer: user, duel: result.duel });
    else assert.deepEqual(result.duel, normal(f.rules.duelDto(await row(id))), `${p} решающий ход сразу раскрывает всё`);
  }
  assert.equal((await row(id)).data.phase, 'done', `${p} до лимита достигнут настоящий итог`);
  await revealed(f, id, ms, p);
  const due = (await row(id)).settleAt!.getTime() - T0; await tick(f, due);
  assert.equal((await row(id)).state, 'settled', `${p} денежная транзакция завершилась`);
  await revealed(f, id, due, p); await drift(p);
}
test('R356 PGlite: ручные roll/stop/burn, ответ/снимок/event скрывают чужие числа; done и settlement раскрывают всё для verifyGreedy', () => human());

async function automatic() {
  const p = 'R356 судья:'; const f = await fixture(); const id = await start(f);
  assert.deepEqual(await tick(f, 20000), { steps: 0 }, `${p} за миллисекунду до срока нет перехода`);
  assert.deepEqual(await tick(f, 20001), { steps: 1 }, `${p} ровно в срок настоящий автобросок`);
  await observe(f, id, 20001, p);
  let records = await moves(id);
  assert.deepEqual(records[0].move, { kind: 'roll', n: 0, die: 4, auto: true }, `${p} реальный скрытый автобросок — 4`);
  assert.equal(records[0].thinkMs, null, `${p} автоход не становится человеческим размышлением`);
  assert.deepEqual(await tick(f, 40001), { steps: 1 }, `${p} следующая просрочка — автостоп`);
  await observe(f, id, 40001, p);
  records = await moves(id);
  assert.deepEqual(records[1].move, { kind: 'stop', bank: 4, auto: true }, `${p} скрытый банк действительно записан`);
  for (const [seq, ms] of [[2, 40002], [3, 40003]]) {
    const result = await move(f, id, 'b', seq, 'roll', ms);
    assert.ok(result.ok && result.duel, `${p} соперник возвращает ход броском и сгоранием`);
    await observe(f, id, ms, p, { viewer: 'b', duel: result.duel });
  }
  assert.deepEqual(await tick(f, 60002), { steps: 0 }, `${p} третья просрочка не раньше своего срока`);
  assert.deepEqual(await tick(f, 60003), { steps: 1 }, `${p} третья просрочка решает партию`);
  assert.deepEqual([(await row(id)).data.phase, (await row(id)).data.reason], ['done', 'timeout'], `${p} итог именно по сроку`);
  await revealed(f, id, 60003, p);
  await tick(f, 60003);
  assert.equal((await row(id)).state, 'settled', `${p} следующее поднятие такта считает завершённый банк`);
  await revealed(f, id, 60003, p); await drift(p);
}
test('R356 PGlite: автоход судьи не раскрывает бросок/банк/сгорание; третья просрочка раскрывает итог, settlement проверяется клиентом', () => automatic());
