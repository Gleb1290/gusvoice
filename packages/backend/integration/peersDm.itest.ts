import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { dmChannels } from '../src/db/schema.js';
import { openDm, type OpenDmIo } from '../src/dmRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
let loadPeers: typeof import('../src/db/peerQueries.js').loadPeers;
let shareServer: typeof import('../src/db/peerQueries.js').shareServer;

before(async () => {
  t = await createTestDb();
  ({ loadPeers, shareServer } = await import('../src/db/peerQueries.js'));
});
beforeEach(async () => truncateAll(t.raw));
after(async () => t.close());

async function seedPeople(): Promise<void> {
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES
      ('a', 'Alpha', 'Alpha', 'hash'),
      ('b', 'Bravo', 'Bravo', 'hash'),
      ('c', 'Charlie', 'Charlie', 'hash'),
      ('d', 'Delta', 'Delta', 'hash');
    INSERT INTO servers (id, name, owner_id) VALUES
      ('shared', 'Shared', 'a'),
      ('foreign', 'Foreign', 'd');
  `);
}

test('loadPeers объединяет общий сервер и обе стороны ЛС без дублей и посторонних', async () => {
  // Ловит UNION ALL, одностороннюю ЛС и утечку пользователя с чужого сервера.
  await seedPeople();
  await t.raw.exec(`
    INSERT INTO server_members (server_id, user_id) VALUES ('shared', 'a'), ('shared', 'b'), ('foreign', 'd');
    INSERT INTO conversations (id, kind, direct_key, created_by) VALUES
      ('dm-ab', 'direct', 'a:b', 'a'), ('dm-ac', 'direct', 'a:c', 'a');
    INSERT INTO conversation_members (conversation_id, user_id) VALUES
      ('dm-ab', 'a'), ('dm-ab', 'b'), ('dm-ac', 'a'), ('dm-ac', 'c');
  `);
  assert.deepEqual([...await loadPeers('a')].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...await loadPeers('c')].sort(), ['a']);
  assert.equal((await loadPeers('a')).has('d'), false);
});

test('shareServer симметричен и не принимает просто соседние чужие серверы', async () => {
  // Ловит запрос, который проверяет членство только одного участника или зависит от порядка аргументов.
  await seedPeople();
  await t.raw.exec(`
    INSERT INTO server_members (server_id, user_id) VALUES
      ('shared', 'a'), ('shared', 'b'), ('foreign', 'c'), ('foreign', 'd');
  `);
  assert.equal(await shareServer('a', 'b'), true);
  assert.equal(await shareServer('b', 'a'), true);
  assert.equal(await shareServer('a', 'c'), false);
});

test('закрытое и снятое членство не создаёт связь между людьми', async () => {
  // Ловит утечку онлайна и возможность открыть ЛС через сохранённую, но уже недействующую строку членства.
  await seedPeople();
  await t.raw.exec(`
    INSERT INTO server_members (server_id, user_id, state) VALUES
      ('shared', 'a', 'active'),
      ('shared', 'b', 'closed_by_host'),
      ('shared', 'c', 'removed'),
      ('shared', 'd', 'active')
  `);
  assert.deepEqual([...await loadPeers('a')].sort(), ['a', 'd']);
  assert.deepEqual([...await loadPeers('b')], []);
  assert.equal(await shareServer('a', 'b'), false);
  assert.equal(await shareServer('a', 'c'), false);
  assert.equal(await shareServer('a', 'd'), true);
});

test('два одновременных openDm получают одну строку с упорядоченной уникальной парой', async () => {
  // Ловит гонку двух POST /dm: проигравшая вставка должна перечитать победившую, а не создать дубль или упасть.
  await seedPeople();
  await t.raw.exec(`INSERT INTO server_members (server_id, user_id) VALUES ('shared', 'a'), ('shared', 'b')`);

  let finds = 0;
  let initialFinds = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => { release = resolve; });
  let ids = 0;
  type Row = typeof dmChannels.$inferSelect;
  const io: OpenDmIo<Row> = {
    findExisting: async (a, b) => {
      finds += 1;
      if (finds <= 2) {
        initialFinds += 1;
        if (initialFinds === 2) release();
        await bothStarted;
      }
      const [row] = await t.db
        .select()
        .from(dmChannels)
        .where(and(eq(dmChannels.userA, a), eq(dmChannels.userB, b)))
        .limit(1);
      return row ?? null;
    },
    shareServer,
    initiatorIsSuperAdmin: () => false,
    create: async (a, b) => {
      const [row] = await t.db
        .insert(dmChannels)
        .values({ id: `race-${++ids}`, userA: a, userB: b })
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    },
  };

  const [one, two] = await Promise.all([openDm(io, 'b', 'a'), openDm(io, 'a', 'b')]);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  if (!one.ok || !two.ok) assert.fail('обе операции должны открыть беседу');
  assert.equal(one.row.id, two.row.id);
  assert.equal(finds, 3);
  const rows = await t.db.select().from(dmChannels);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]?.userA, rows[0]?.userB], ['a', 'b']);
});
