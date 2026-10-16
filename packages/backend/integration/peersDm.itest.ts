import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { and, eq } from 'drizzle-orm';
import { conversations } from '../src/db/schema.js';
import { openDm, type OpenDmIo } from '../src/dmRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
let loadPeers: typeof import('../src/db/peerQueries.js').loadPeers;
let shareServer: typeof import('../src/db/peerQueries.js').shareServer;
let isAcceptedPeer: typeof import('../src/db/peerQueries.js').isAcceptedPeer;

before(async () => {
  t = await createTestDb();
  ({ loadPeers, shareServer, isAcceptedPeer } = await import('../src/db/peerQueries.js'));
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

test('звонят только принятые собеседники: общий active, контакт или ответ хозяина, без блоков', async () => {
  // Пустая беседа или сообщение только звонящего — незнакомец; старый direct-peer тест не должен расширять право на звонок.
  await seedPeople();
  await t.raw.exec(`
    INSERT INTO server_members(server_id,user_id,state) VALUES
      ('shared','a','active'),('shared','b','active'),('shared','c','closed_by_host');
    INSERT INTO user_contacts(owner_id,contact_id) VALUES ('a','d');
    INSERT INTO conversations(id,kind,direct_key,created_by) VALUES
      ('stranger-ac','direct','a:c','c'),('empty-bd','direct','b:d','d');
    INSERT INTO conversation_members(conversation_id,user_id) VALUES
      ('stranger-ac','a'),('stranger-ac','c'),('empty-bd','b'),('empty-bd','d');
    INSERT INTO conversation_messages(id,conversation_id,author_id,sort_key,content) VALUES
      ('incoming-only','stranger-ac','c',1,'Привет');
  `);
  assert.equal(await isAcceptedPeer('a','b'), true, 'оба состоят в общем активном сервере');
  assert.equal(await isAcceptedPeer('a','c'), false, 'закрытое членство и сообщение только другой стороны не принимают собеседника');
  assert.equal(await isAcceptedPeer('a','d'), true, 'контакт хозяина принят');
  assert.equal(await isAcceptedPeer('b','d'), false, 'пустая беседа, которую завёл звонящий, не является принятием');

  await t.raw.exec(`INSERT INTO conversation_messages(id,conversation_id,author_id,sort_key,content)
    VALUES ('owner-reply','stranger-ac','a',2,'Ответ');`);
  assert.equal(await isAcceptedPeer('a','c'), true, 'ответ хозяина принимает собеседника');
  await t.raw.exec("UPDATE conversation_messages SET deleted_at=now(),service=NULL WHERE id='owner-reply'");
  assert.equal(await isAcceptedPeer('a','c'), false, 'удалённый ответ хозяина не принимается');

  const dbModule = await import('../src/db/index.js');
  const { sql } = await import('drizzle-orm');
  const unchangedControl = runInNewContext(`(${isAcceptedPeer.toString()})`, { db: dbModule.db, sql }) as typeof isAcceptedPeer;
  assert.equal(await unchangedControl('a','c'), false, 'исполняемый контроль с тем же источником сохраняет правильный результат');
  const mutant = (from: string, to: string) => {
    const source = isAcceptedPeer.toString();
    const changed = source.replace(from, to);
    assert.notEqual(changed, source, `якорь контрфакта найден: ${from}`);
    return runInNewContext(`(${changed})`, { db: dbModule.db, sql }) as typeof isAcceptedPeer;
  };
  const noDeleted = mutant('AND sx.deleted_at IS NULL', '');
  await assert.rejects(async () => assert.equal(await noDeleted('a','c'), false), assert.AssertionError,
    'мутант принимает удалённый ответ хозяина');
  await t.raw.exec(`UPDATE conversation_messages SET deleted_at=NULL,service='{"kind":"call"}'::jsonb WHERE id='owner-reply'`);
  assert.equal(await isAcceptedPeer('a','c'), false, 'служебная строка не является ответом');
  const noService = mutant('AND sx.service IS NULL', '');
  await assert.rejects(async () => assert.equal(await noService('a','c'), false), assert.AssertionError,
    'мутант принимает служебную строку как ответ');

  await t.raw.exec("INSERT INTO user_blocks(blocker_id,blocked_id) VALUES ('a','d')");
  assert.equal(await isAcceptedPeer('a','d'), false, 'блокировка хозяина сильнее контакта');
  const noBlocks = mutant('SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM user_blocks ub', 'SELECT 1 WHERE TRUE OR EXISTS (SELECT 1 FROM user_blocks ub');
  await assert.rejects(async () => assert.equal(await noBlocks('a','d'), false), assert.AssertionError,
    'мутант пропускает контакт при блокировке');
  await t.raw.exec("DELETE FROM user_blocks WHERE blocker_id='a' AND blocked_id='d'; INSERT INTO user_blocks(blocker_id,blocked_id) VALUES ('d','a')");
  assert.equal(await isAcceptedPeer('a','d'), false, 'обратная блокировка тоже закрывает звонок');
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

test('ЛС перестаёт делать собеседников онлайн-пирами сразу после block change в TTL-кэше', async () => {
  // Причина: без refreshPeers оба снимка могли бы сохранить взаимную видимость до истечения минутного кэша.
  await seedPeople();
  await t.raw.exec(`INSERT INTO conversations (id, kind, direct_key, created_by) VALUES ('dm-ab', 'direct', 'a:b', 'a');
    INSERT INTO conversation_members (conversation_id,user_id) VALUES ('dm-ab','a'),('dm-ab','b');`);
  const { createUserVisibilityHub } = await import('../src/userVisibilityHub.js');
  const { blockUser, unblockUser, onBlockChange, resetBlockCacheForTests } = await import('../src/blocks.js');
  const sent: { userId: string; payload: { t: string; users?: string[] } }[] = [];
  const conns = [{ userId: 'a' }, { userId: 'b' }];
  const hub = createUserVisibilityHub({
    loadPeers,
    now: () => 0,
    superAdminId: () => null,
    send: (conn, text) => sent.push({ userId: conn.userId!, payload: JSON.parse(text) }),
  });
  // Исполненная цепочка ниже не доказывает, что её подписал настоящий gateway: этот страж ловит забытый провод.
  const gatewaySource = readFileSync(new URL('../src/gateway.ts', import.meta.url), 'utf8');
  assert.match(gatewaySource, /onBlockChange\(\(blockerId, blockedId\) => void hub\.refreshPeers\(\[blockerId, blockedId\]\)/);
  const unsub = onBlockChange((blockerId, blockedId) => void hub.refreshPeers([blockerId, blockedId]));
  try {
    for (const conn of conns) { hub.attach(conn, conn.userId); hub.goOnline(conn.userId); }
    await Promise.all(conns.map((c) => hub.sendOnlineSnapshot(c)));
    assert.deepEqual(sent.map((x) => x.payload.users), [['a', 'b'], ['a', 'b']]);
    sent.length = 0;
    await blockUser('a', 'b');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map((x) => x.payload.users), [['a'], ['b']], 'оба снимка должны обновиться до TTL');
    assert.equal((await loadPeers('a')).has('b'), false, 'блокировщик исключает собеседника');
    sent.length = 0;
    await unblockUser('a', 'b');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map((x) => x.payload.users), [['a', 'b'], ['a', 'b']], 'разблокировка возвращает оба peer-снимка');
    sent.length = 0;
    await blockUser('b', 'a');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map((x) => x.payload.users), [['b'], ['a']]);
    assert.equal((await loadPeers('a')).has('b'), false, 'обратное направление блокировки также исключает пару');
  } finally {
    unsub();
    resetBlockCacheForTests();
    for (const conn of conns) hub.detach(conn);
  }
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
  type Row = typeof conversations.$inferSelect;
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
        .from(conversations)
        .where(and(eq(conversations.kind, 'direct'), eq(conversations.directKey, `${a}:${b}`)))
        .limit(1);
      return row ?? null;
    },
    shareServer,
    initiatorIsSuperAdmin: () => false,
    create: async (a, b) => {
      const [row] = await t.db
        .insert(conversations)
        .values({ id: `race-${++ids}`, kind: 'direct', directKey: `${a}:${b}` })
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
  const rows = await t.db.select().from(conversations);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.directKey, 'a:b');
});
