import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as zod from 'zod';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as gatewayRules from '../src/gatewayRules.js';
import * as visibilityHub from '../src/userVisibilityHub.js';
import * as visibility from '../src/sessionVisibility.js';
import * as pushRules from '../src/pushRules.js';
import { dayKey, seasonId } from '../src/coinRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

// R333: настоящие HTTP/Zod/SQL/денежные модули. Шлюз тоже исполняется ЦЕЛИКОМ:
// возможность появляется через identify и исчезает через close, не через тестовый userHasCap.
const NOW = Date.parse('2026-10-28T12:00:00Z');
const read = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let t: TestDb;
before(async () => {
  t = await createTestDb();
  await t.raw.exec("ALTER TABLE coin_ledger ALTER COLUMN created_at SET DEFAULT '2026-10-28T12:00:00Z'::timestamptz");
});
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

class Socket {
  messages: Record<string, any>[] = [];
  closed = false;
  private listeners = new Map<string, (...args: any[]) => unknown>();
  on(event: string, fn: (...args: any[]) => unknown) { this.listeners.set(event, fn); }
  send(value: string) { this.messages.push(JSON.parse(value)); }
  close() { this.closed = true; this.listeners.get('close')?.(); }
  async frame(value: unknown) { await this.listeners.get('message')?.(Buffer.from(JSON.stringify(value))); }
}

function gateway() {
  const noop = () => {};
  const ioErrors: string[] = [];
  const fail = () => {
    ioErrors.push('неожиданный IO шлюза');
    throw new Error('R333 setup: неожиданный IO шлюза');
  };
  class Redis { psubscribe() {} on() {} }
  // SQL только IO шлюза (presence/lastSeen), не SQL игры. Реальный hub управляет соединениями.
  const deps: Record<string, unknown> = {
    ioredis: { default: Redis },
    './auth.js': { superAdminId: () => null, verifyToken: (id: string) => ({ sub: id, gen: 0 }), tokenGenValid: async () => true },
    './authGuard.js': { clientIp: () => 'synthetic-ip', rateHit: fail },
    './blocks.js': { isBlockedBy: fail, onBlockChange: noop },
    './db/index.js': { db: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ s: 'online' }] }) }) }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    } },
    './db/peerQueries.js': { loadPeers: async () => new Set<string>() },
    './db/schema.js': schema, 'drizzle-orm': orm,
    './env.js': { env: { redisUrl: 'synthetic-no-network' } },
    './gatewayRules.js': gatewayRules, './gatewayTyping.js': { relayTyping: fail },
    './permissions.js': { getChannelAudience: fail, getMemberContext: fail },
    './pushRules.js': pushRules, './realtime.js': { publishToChannel: fail, publishToUser: fail },
    './sessionVisibility.js': visibility, './userVisibilityHub.js': visibilityHub,
  };
  const source = read('gateway');
  const module = { exports: {} as Pick<typeof import('../src/gateway.js'), 'registerGateway' | 'userHasCap'> };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, Buffer,
    setTimeout: () => ({ unref: noop }), clearTimeout: noop,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `R333 setup: закрытый импорт gateway ${id}`); return deps[id]; },
  });
  let connect!: (socket: Socket, req: unknown) => void;
  module.exports.registerGateway({ get: (_url: string, _opts: unknown, fn: typeof connect) => { connect = fn; } } as any);
  const sockets: Socket[] = [];
  return { userHasCap: module.exports.userHasCap, ioErrors,
    async open(userId: string, caps: string[] = []) {
      const socket = new Socket(); sockets.push(socket); connect(socket, {});
      await socket.frame({ t: 'identify', token: userId, caps });
      assert.deepEqual(ioErrors, [], 'R333 setup: identify не вызвал неожиданный IO');
      assert.equal(socket.messages.some(m => m.t === 'error'), false, 'R333 setup: identify не вернул error-кадр');
      assert.equal(socket.closed, false, 'R333 setup: identify сохранил живой сокет');
      assert.ok(socket.messages.some(m => m.t === 'ready' && m.userId === userId), 'R333 setup: настоящий identify завершён');
      return socket;
    },
    close() { for (const socket of sockets) socket.close(); },
  };
}

async function fixture() {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['a', 'b', 'viewer', 'owner', 'outside'].map(id => ({
    id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true,
  })));
  await t.db.insert(schema.servers).values(['server', 'elsewhere'].map(id => ({ id, name: id, ownerId: 'owner' })));
  await t.db.insert(schema.serverMembers).values([
    ...['a', 'b', 'viewer', 'owner'].map(userId => ({ serverId: 'server', userId })),
    { serverId: 'elsewhere', userId: 'a' },
  ]);
  await t.db.insert(schema.channels).values({ id: 'voice', name: 'Выбор', serverId: 'server', type: 'voice' });
  await t.db.insert(schema.serverEconomy).values({ serverId: 'server', enabled: true, gamesEnabled: true,
    gamesBetMax: 300, gamesDailyLossMax: 0, gamesFeePercent: 10, gamesPairDailyMax: 1000,
    closedSeasonId: seasonId(new Date(NOW)), gooseMinutes: 0 });
  await t.db.insert(schema.coinBalances).values(['a', 'b', 'viewer', 'owner'].map(userId => ({
    serverId: 'server', userId, balance: 1000, day: dayKey(new Date(NOW)), seasonId: seasonId(new Date(NOW)),
  })));
  await t.db.insert(schema.coinLedger).values(['a', 'b', 'viewer', 'owner'].map(userId => ({
    id: `fund-${userId}`, serverId: 'server', userId, amount: 1000, reason: 'fixture', createdAt: new Date(NOW),
  })));
  const gate = gateway();
  const wires: Array<{ audience: string[]; message: Record<string, any> }> = [];
  const errors: string[] = [];
  const fail = () => { throw new Error('R333 setup: неожиданный внешний IO'); };
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? NOW : value instanceof Date ? value.getTime() : value); }
    static override now() { return NOW; }
  }
  const values: Record<string, unknown> = {
    'db/index': { db: t.db }, 'db/schema': schema, env: { env: { economyPreviewUsers: [] } }, util: { id: crypto.randomUUID },
    gateway: gate,
    auth: { requireAuth: async (req: { user: unknown; headers: Record<string, unknown> }) => { req.user = { sub: req.headers['x-user'] ?? 'a' }; } },
    permissions: { getMemberContext: async (serverId: string, userId: string) => {
      const [member] = await t.db.select().from(schema.serverMembers)
        .where(orm.and(orm.eq(schema.serverMembers.serverId, serverId), orm.eq(schema.serverMembers.userId, userId))).limit(1);
      return member ? { serverPermissions: userId === 'owner' ? shared.Permission.MANAGE_ECONOMY : 0n } : null;
    } },
    audit: { writeAudit: async () => {} },
    voicePresence: { inVoiceChannel: async () => true, voiceParticipantIds: async () => ['a', 'b', 'viewer'] },
    realtime: {
      publishToChannel: async (_server: string, _channel: string, message: Record<string, any>, audience: string[]) => { wires.push({ audience, message: normal(message) }); },
      publishToServer: async (_server: string, message: Record<string, any>) => { wires.push({ audience: [], message: normal(message) }); },
      publishToUser: async (user: string, message: Record<string, any>) => { wires.push({ audience: [user], message: normal(message) }); },
      redisPub: { get: async () => null, set: async () => 'OK', eval: async () => 1, pttl: async () => -2 },
    },
    shop: { shopFor: async () => [] }, purchase: { buyItem: fail },
    instanceSettings: { avatarPriceMinutes: fail, avatarRentalMaxDays: fail }, storage: { putMedia: fail, storageConfigured: fail },
  };
  // Только нужные реальные плагины: регистрация sibling-плагинов колеса уже проверяется R332/R339.
  const files = new Set(['routes/gameDuel', 'routes/economy', 'gameDuel', 'gameDuelRules', 'gameMoney', 'gameMoneyRules',
    'coins', 'coinRules', 'streakRules', 'seasons', 'economyDefaults', 'gooseRules', 'voiceActivityRules', 'levelRules', 'shopRules']);
  const modules = new Map<string, any>();
  function load(name: string): any {
    if (Object.hasOwn(values, name)) return values[name];
    if (modules.has(name)) return modules.get(name);
    assert.ok(files.has(name), `R333 setup: закрытый импорт ${name}`);
    const source = read(name);
    const module = { exports: {} }; modules.set(name, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer, Error, Uint8Array, setInterval: fail,
      console: { warn: (...args: unknown[]) => errors.push(args.join(' ')), error: (...args: unknown[]) => errors.push(args.join(' ')) },
      require(id: string) {
        if (id === '@gusvoice/shared') return shared;
        if (id === 'drizzle-orm') return orm;
        if (id === 'zod') return zod;
        if (id === 'node:crypto') return { ...crypto, randomBytes: (size: number) => Buffer.alloc(size, 3) };
        assert.ok(id.startsWith('.'), `R333 setup: внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
      },
    });
    return module.exports;
  }
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof zod.ZodError) return reply.code(400).send({ error: 'validation', details: error.issues });
    errors.push(String(error)); return reply.code(500).send({ error: 'unexpected fixture error' });
  });
  try {
    await app.register(load('routes/gameDuel').gameDuelRoutes);
    await app.register(load('routes/economy').economyRoutes);
    await app.ready();
  } catch (error) { await app.close(); gate.close(); throw error; }
  return { app, gate, wires, errors };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (f: Fixture, path: string, user = 'a', payload?: unknown, server = 'server') => f.app.inject({
  method: 'POST', url: `/servers/${server}/${path}`, headers: { 'x-user': user }, payload: payload as any,
});
const challenge = (f: Fixture, game: shared.DuelGame) => post(f, 'duels', 'a', { channelId: 'voice', targetId: 'b', game, amount: 100 });
const move = (f: Fixture, id: string, payload: unknown, user = 'a', server = 'server') => post(f, `duels/${id}/move`, user, payload, server);
const patch = (f: Fixture, value: unknown, user = 'owner') => f.app.inject({
  method: 'PATCH', url: '/servers/server/economy', headers: { 'x-user': user }, payload: { gamesPairDailyMax: value } as any,
});
async function playing(f: Fixture) {
  await f.gate.open('b', ['duel2']);
  const invite = await challenge(f, 'rps'); assert.equal(invite.statusCode, 200, 'R333 setup: вызов КНБ создан');
  const id = invite.json().duel.id as string;
  const accept = await post(f, `duels/${id}/accept`, 'b');
  assert.equal(accept.statusCode, 200, 'R333 setup: КНБ принят');
  return id;
}
async function snapshot(f: Fixture, user: string) {
  const r = await f.app.inject({ method: 'GET', url: '/servers/server/duel?channelId=voice', headers: { 'x-user': user } });
  assert.equal(r.statusCode, 200, 'R333 HTTP: снимок участника доступен'); return r.json();
}
async function state() {
  return normal({ rounds: await t.db.select().from(schema.gameRounds), moves: await t.db.select().from(schema.gameMoves),
    stakes: await t.db.select().from(schema.gameStakes), balances: await t.db.select().from(schema.coinBalances),
    ledger: await t.db.select().from(schema.coinLedger), economy: await t.db.select().from(schema.serverEconomy) });
}
async function denied(f: Fixture, request: () => ReturnType<typeof post>, status: number, code: string) {
  const before = await state(); const r = await request();
  assert.equal(r.statusCode, status, `R333 HTTP: ${code} статус`);
  assert.equal(r.json().error, code, `R333 HTTP: ${code} причина`);
  if (code !== 'validation' && code !== 'not a member' && code !== 'forbidden') assert.equal(r.json().reason, code, 'R333 HTTP: reason совпадает с кодом');
  assert.deepEqual(await state(), before, 'R333 HTTP: отказ ничего не записывает');
}
function scenario(title: string, check: (f: Fixture) => Promise<void>) {
  test(`R333 HTTP ${title}`, async () => {
    const f = await fixture();
    try {
        await check(f);
        const result = await t.raw.query(`SELECT b.user_id FROM coin_balances b LEFT JOIN coin_ledger l USING (server_id,user_id)
          GROUP BY b.server_id,b.user_id,b.balance HAVING b.balance <> COALESCE(SUM(l.amount),0)::int`);
        assert.deepEqual(result.rows, [], 'R333 HTTP: drift 0');
        assert.deepEqual(f.errors, [], 'R333 HTTP: нет спрятанных ошибок');
    } catch (error) {
        // HTTP 500 из неожиданного IO/SQL/VM-сбоя — поломка harness.
        // Проверка статуса могла упасть раньше завершающей проверки errors.
        if (f.errors.length > 0 || f.gate.ioErrors.length > 0) {
          throw new Error(`R333 setup: неожиданные ошибки HTTP/gateway: ${[...f.errors, ...f.gate.ioErrors].join('; ')}`);
        }
        throw error;
    } finally { await f.app.close(); f.gate.close(); }
  });
}
for (const game of ['rps', 'greedy'] as const) scenario(`${game}: старый/вышедший клиент скрыт, хотя бы один живой duel2 разрешает вызов`, async f => {
  await denied(f, () => challenge(f, game), 409, 'target_unavailable');
  const old = await f.gate.open('b');
  const other = await f.gate.open('a', ['duel2']);
  await denied(f, () => challenge(f, game), 409, 'target_unavailable');
  const unrelated = await f.gate.open('b', ['unrelated-cap']);
  await denied(f, () => challenge(f, game), 409, 'target_unavailable');
  const capable = await f.gate.open('b', ['duel2']);
  capable.close();
  await denied(f, () => challenge(f, game), 409, 'target_unavailable');
  await f.gate.open('b', ['duel2']);
  const response = await challenge(f, game);
  assert.equal(response.statusCode, 200, 'R333 HTTP: живой duel2 принимает игру с выбором');
  assert.equal(response.json().duel.game, game, 'R333 HTTP: игра не заменена кубиками');
  assert.equal((await t.db.select().from(schema.gameStakes)).length, 0, 'R333 HTTP: вызов не списывает деньги');
  old.close(); other.close(); unrelated.close();
});

scenario('кубики работают без duel2 — старый клиент не лишён существующей игры', async f => {
  const r = await challenge(f, 'dice');
  assert.equal(r.statusCode, 200, 'R333 HTTP: кубики не требуют duel2');
  assert.equal(r.json().duel.game, 'dice');
});

scenario('seq проверяется Zod: обе границы проходят разбор, отрицательное/дробь/переполнение/строка не пишутся', async f => {
  const id = await playing(f);
  for (const seq of [-1, 0.5, 100_001, '0', null]) await denied(f, () => move(f, id, { seq, move: 'rock' }), 400, 'validation');
  await denied(f, () => move(f, id, { seq: 100_000, move: 'rock' }), 409, 'stale_seq');
  const valid = await move(f, id, { seq: 0, move: 'rock' });
  assert.equal(valid.statusCode, 200, 'R333 HTTP: нулевой seq принимается');
});

scenario('move обязателен, строковый и длиной 1..16; корректная рука проходит, неизвестная не превращается в ход', async f => {
  const id = await playing(f);
  for (const payload of [{}, { seq: 0 }, { seq: 0, move: '' }, { seq: 0, move: 1 }, { seq: 0, move: 'x'.repeat(17) }]) {
    await denied(f, () => move(f, id, payload), 400, 'validation');
  }
  await denied(f, () => move(f, id, { seq: 0, move: 'x'.repeat(16) }), 400, 'bad_move');
  const valid = await move(f, id, { seq: 0, move: 'paper' });
  assert.equal(valid.statusCode, 200, 'R333 HTTP: правильная рука принимается');
});

scenario('личная рука есть в ответе и GET игрока, но её нет у соперника/зрителя, в data и в событиях', async f => {
  const id = await playing(f); f.wires.length = 0;
  const response = await move(f, id, { seq: 0, move: 'rock' });
  assert.equal(response.statusCode, 200, 'R333 HTTP: ход принят');
  assert.equal(response.json().myHand, 'rock', 'R333 HTTP: ответ возвращает свою руку');
  assert.equal((await snapshot(f, 'a')).myHand, 'rock', 'R333 HTTP: reconnect возвращает свою руку');
  assert.equal((await snapshot(f, 'b')).myHand, null, 'R333 HTTP: соперник не видит чужую руку');
  assert.equal(Object.hasOwn(await snapshot(f, 'viewer'), 'myHand'), false, 'R333 HTTP: зрителю не добавляется myHand');
  for (const dto of [response.json().duel, (await snapshot(f, 'a')).duel, (await snapshot(f, 'b')).duel, (await snapshot(f, 'viewer')).duel]) {
    assert.deepEqual(dto.rps, { rounds: [], ready: { challenger: true, target: false }, wins: { challenger: 0, target: 0 }, seq: 0 }, 'R333 HTTP: общий DTO — только готовность и прошлые раунды');
    assert.equal(dto.seed, null, 'R333 HTTP: зерно до итога скрыто');
    assert.equal(JSON.stringify(dto).includes('rock'), false, 'R333 HTTP: рука не утекла в общий DTO');
  }
  const [row] = await t.db.select().from(schema.gameRounds);
  assert.equal(JSON.stringify(row.data).includes('rock'), false, 'R333 HTTP: скрытая рука не хранится в общем data');
  const events = f.wires.filter(w => w.message.t === 'duel.state');
  assert.equal(events.length, 1, 'R333 HTTP: одно событие готовности');
  assert.ok(events[0].audience.includes('viewer'), 'R333 HTTP: проверено событие зрителя');
  assert.equal(JSON.stringify(events).includes('rock'), false, 'R333 HTTP: рука не утекла в событие');
});

scenario('нечлен не совершает ход и не узнаёт состояние дуэли', async f => {
  const id = await playing(f);
  await denied(f, () => move(f, id, { seq: 0, move: 'rock' }, 'outside'), 404, 'not a member');
  const r = await move(f, id, { seq: 0, move: 'rock' });
  assert.equal(r.statusCode, 200, 'R333 HTTP: член-игрок после отказа может ходить');
});

scenario('член другого сервера не адресует его URL к настоящей партии здесь', async f => {
  const id = await playing(f);
  await denied(f, () => move(f, id, { seq: 0, move: 'rock' }, 'a', 'elsewhere'), 404, 'not_found');
  const r = await move(f, id, { seq: 0, move: 'rock' });
  assert.equal(r.statusCode, 200, 'R333 HTTP: правильный сервер принимает ход');
});

scenario('зритель-член видит готовность, но не может положить руку вместо игрока', async f => {
  const id = await playing(f);
  await denied(f, () => move(f, id, { seq: 0, move: 'rock' }, 'viewer'), 403, 'not_player');
  const response = await move(f, id, { seq: 0, move: 'rock' });
  assert.equal(response.statusCode, 200, 'R333 HTTP: настоящий игрок после отказа зрителю может ходить');
});
scenario('предел пары 0 и 1 000 000 сохраняется и возвращается в DTO настроек управляющего', async f => {
  for (const value of [0, 1_000_000]) {
    const r = await patch(f, value);
    assert.equal(r.statusCode, 200, 'R333 HTTP: точная граница предела принимается');
    assert.equal(r.json().gamesPairDailyMax, value, 'R333 HTTP: PATCH отдаёт предел в toEconomy');
    const [eco] = await t.db.select().from(schema.serverEconomy);
    assert.equal(eco.gamesPairDailyMax, value, 'R333 HTTP: предел сохранён в SQL');
    const manager = await f.app.inject({ method: 'GET', url: '/servers/server/economy', headers: { 'x-user': 'owner' } });
    assert.equal(manager.json().settings.gamesPairDailyMax, value, 'R333 HTTP: GET управляющего отдаёт сохранённый предел');
  }
  const member = await f.app.inject({ method: 'GET', url: '/servers/server/economy', headers: { 'x-user': 'a' } });
  assert.equal(member.statusCode, 200, 'R333 HTTP: обычный член читает экономику');
  assert.equal(member.json().settings, null, 'R333 HTTP: общая ручка не раскрывает управляющие настройки');
  assert.equal(member.json().gamesEnabled, true, 'R333 HTTP: видимость игр не потеряна');
});

for (const [label, value] of [
  ['−1', -1],
  ['1 000 001', 1_000_001],
  ['дробь', 0.5],
] as const) scenario(`предел пары ${label} отклоняется до SQL, корректное значение остаётся допустимым`, async f => {
  await denied(f, () => patch(f, value), 400, 'validation');
  const accepted = await patch(f, 999);
  assert.equal(accepted.statusCode, 200, 'R333 HTTP: допустимый предел принимается');
  assert.equal(accepted.json().gamesPairDailyMax, 999, 'R333 HTTP: принят настоящий предел');
});

scenario('предел пары меняет только MANAGE_ECONOMY, не обычный член', async f => {
  await denied(f, () => patch(f, 2000, 'a'), 403, 'forbidden');
  const r = await patch(f, 2000);
  assert.equal(r.statusCode, 200, 'R333 HTTP: MANAGE_ECONOMY разрешён');
  assert.equal(r.json().gamesPairDailyMax, 2000, 'R333 HTTP: управляющий изменил предел');
});
