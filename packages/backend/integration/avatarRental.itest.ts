import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { after, before, beforeEach, test } from 'node:test';
import { createTestDb, truncateAll, type TestDb } from './harness.js';
import { users } from '../src/db/schema.js';
import { BUY_BLOCK_TEXT, SHOP_CATALOG } from '../src/shopRules.js';

let t: TestDb;
let app: ReturnType<typeof Fastify>;
let tokenFor: (id: string) => string;
let redisPub: typeof import('../src/realtime.js').redisPub;
let buyItem: typeof import('../src/purchase.js').buyItem;
let claims = 0;
const day = 24 * 60 * 60 * 1000;
const balance = 100_000;

before(async () => {
  t = await createTestDb();
  const { signToken } = await import('../src/auth.js');
  const { economyRoutes } = await import('../src/routes/economy.js');
  ({ buyItem } = await import('../src/purchase.js'));
  ({ redisPub } = await import('../src/realtime.js'));
  redisPub.set = (async () => { claims++; return claims === 1 ? 'OK' : null; }) as typeof redisPub.set;
  redisPub.publish = (async () => 1) as typeof redisPub.publish;
  tokenFor = (id) => signToken({ sub: id, username: id, gen: 0 });
  app = Fastify();
  await app.register(economyRoutes);
  await app.ready();
});

beforeEach(async () => {
  await truncateAll(t.raw);
  claims = 0;
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash)
      VALUES ('buyer', 'buyer', 'Buyer', 'hash');
    INSERT INTO servers (id, name, owner_id) VALUES ('s', 'Server', 'buyer');
    INSERT INTO server_members (server_id, user_id) VALUES ('s', 'buyer');
    INSERT INTO server_economy (server_id, enabled) VALUES ('s', true);
    INSERT INTO coin_balances (server_id, user_id, balance) VALUES ('s', 'buyer', ${balance});
  `);
});

after(async () => {
  await app.close();
  redisPub.disconnect();
  await t.close();
});

async function buy() {
  return app.inject({
    method: 'POST', url: '/servers/s/shop/animated-avatar/buy',
    headers: { authorization: `Bearer ${tokenFor('buyer')}` },
  });
}

async function setUntil(days: number): Promise<Date> {
  const until = new Date(Date.now() + days * day);
  await t.raw.query(`UPDATE users SET animated_avatar_until = $1 WHERE id = 'buyer'`, [until.toISOString()]);
  return until;
}

async function money() {
  const wallets = await t.raw.query<{ balance: number }>(`SELECT balance FROM coin_balances WHERE server_id = 's' AND user_id = 'buyer'`);
  const checks = await t.raw.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM coin_purchases WHERE server_id = 's'`);
  return { balance: wallets.rows[0]!.balance, checks: checks.rows[0]!.n };
}

async function ledgerCount(): Promise<number> {
  const rows = await t.raw.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM coin_ledger WHERE server_id = 's'`);
  return rows.rows[0]!.n;
}

const purchaseInput = () => ({
  serverId: 's', userId: 'buyer', item: SHOP_CATALOG['animated-avatar'], targetUserId: null,
  price: 100, priceMinutes: 50, ratePer5min: 10, now: new Date(),
});

test('при остатке 45 дней маршрут запрещает покупку без списания', async () => {
  // Ловит обход потолка в HTTP-маршруте, даже если чистое правило само по себе верно.
  await setUntil(45);
  const response = await buy();
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), { error: BUY_BLOCK_TEXT['rental-full'] });
  assert.deepEqual(await money(), { balance, checks: 0 });
  assert.equal(claims, 0);
});

test('при остатке 20 дней срок продлевается на 30 от прежнего конца', async () => {
  // Ловит обнуление уже оплаченного остатка или ответ без фактического списания.
  const oldUntil = await setUntil(20);
  const response = await buy();
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(new Date(body.until).getTime(), oldUntil.getTime() + 30 * day);
  const stored = await t.raw.query<{ animated_avatar_until: Date }>(`SELECT animated_avatar_until FROM users WHERE id = 'buyer'`);
  assert.equal(new Date(stored.rows[0]!.animated_avatar_until).getTime(), oldUntil.getTime() + 30 * day);
  assert.deepEqual(await money(), { balance: balance - body.spent, checks: 1 });
});

test('два параллельных запроса покупают только одно продление', async () => {
  // Ловит двойное списание и выход аренды за потолок при гонке двух нажатий.
  await setUntil(20);
  const responses = await Promise.all([buy(), buy()]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 429]);
  assert.equal((await money()).checks, 1);
  assert.equal(claims, 2);
});

test('effect может отказать в полной аренде без списания, чека и строки журнала', async () => {
  // Ловит списание после отказа, если транзакционный эффект прервёт покупку.
  const result = await buyItem({ ...purchaseInput(), effect: async () => 'rental-full' });
  assert.equal(result.block, 'rental-full');
  assert.deepEqual(await money(), { balance, checks: 0 });
  assert.equal(await ledgerCount(), 0);
});

test('ошибка effect откатывает даже уже записанное действие награды', async () => {
  // Ловит разрешение на аватар без оплаты, если действие упадёт после записи в users.
  const until = new Date(Date.now() + day);
  await assert.rejects(() => buyItem({
    ...purchaseInput(),
    effect: async (tx) => {
      await tx.update(users).set({ animatedAvatarUntil: until }).where(eq(users.id, 'buyer'));
      throw new Error('effect interrupted');
    },
  }), /effect interrupted/);
  const row = await t.raw.query<{ animated_avatar_until: Date | null }>(`SELECT animated_avatar_until FROM users WHERE id = 'buyer'`);
  assert.equal(row.rows[0]!.animated_avatar_until, null);
  assert.deepEqual(await money(), { balance, checks: 0 });
  assert.equal(await ledgerCount(), 0);
});

test('просроченный Redis-захват не позволяет двум запросам оплатить одно продление', async () => {
  // Ловит гонку: первый прошёл раннюю проверку и завис, второй успел купить после истечения lease.
  const oldUntil = await setUntil(20);
  const originalSet = redisPub.set;
  let reachedLock!: () => void;
  let releaseFirst!: () => void;
  const firstAtLock = new Promise<void>((resolve) => { reachedLock = resolve; });
  const firstPaused = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  redisPub.set = (async () => {
    calls++;
    if (calls === 1) { reachedLock(); await firstPaused; }
    return 'OK'; // Вторая выдача моделирует истёкший TTL первого захвата.
  }) as typeof redisPub.set;
  try {
    const first = buy();
    await firstAtLock;
    const second = await buy();
    assert.equal(second.statusCode, 200);
    releaseFirst();
    const stale = await first;
    assert.equal(stale.statusCode, 403);
    assert.deepEqual(stale.json(), { error: BUY_BLOCK_TEXT['rental-full'] });
    assert.deepEqual(await money(), { balance: balance - second.json().spent, checks: 1 });
    const stored = await t.raw.query<{ animated_avatar_until: Date }>(`SELECT animated_avatar_until FROM users WHERE id = 'buyer'`);
    assert.equal(new Date(stored.rows[0]!.animated_avatar_until).getTime(), oldUntil.getTime() + 30 * day);
    assert.equal(calls, 2);
  } finally {
    releaseFirst();
    redisPub.set = originalSet;
  }
});
