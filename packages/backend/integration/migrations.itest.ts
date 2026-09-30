import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createTestDb, type TestDb } from './harness.js';

let t: TestDb;

before(async () => {
  t = await createTestDb();
});

after(async () => t.close());

test('чистая база применяет каждый SQL-файл ровно один раз', async () => {
  // Ловит забытый файл, неверный порядок и расхождение таблицы учёта с реально применёнными миграциями.
  const { migrationsDir, migrationOrder } = await import('../src/db/index.js');
  const expected = migrationOrder(await readdir(migrationsDir));
  const recorded = await t.raw.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
  assert.deepEqual(t.appliedMigrations, expected);
  assert.deepEqual(recorded.rows.map((r) => r.name), expected);
  assert.equal(new Set(recorded.rows.map((r) => r.name)).size, expected.length);
});

test('0075 с ключами пуша применяется после всей схемы 0074', () => {
  // Ловит неверную сортировку миграций, при которой ALTER пуш-таблицы идёт раньше её актуальной базы.
  const before = t.appliedMigrations.indexOf('0074_federation_links_confirm_pending.sql');
  const crypto = t.appliedMigrations.indexOf('0075_push_devices_webpush_keys.sql');
  assert.ok(before >= 0, 'не найдена миграция 0074');
  assert.equal(crypto, before + 1);
});

test('0077 добавляет непустой по умолчанию массив скрывших без новой ссылки на users', async () => {
  // Ловит миграцию, которая ломает старые строки ЛС или неожиданно меняет политику удаления аккаунта.
  const before = t.appliedMigrations.indexOf('0076_user_blocks.sql');
  const hidden = t.appliedMigrations.indexOf('0077_dm_hidden_for.sql');
  assert.equal(hidden, before + 1);
  const column = await t.raw.query<{ is_nullable: string; column_default: string }>(`
    SELECT is_nullable, column_default FROM information_schema.columns
    WHERE table_name = 'dm_messages' AND column_name = 'hidden_for'
  `);
  assert.equal(column.rows[0]?.is_nullable, 'NO');
  assert.match(column.rows[0]?.column_default ?? '', /\{\}/);
  const fks = await t.raw.query(`
    SELECT 1 FROM information_schema.key_column_usage
    WHERE table_name = 'dm_messages' AND column_name = 'hidden_for'
  `);
  assert.equal(fks.rows.length, 0);
});

test('0062 одобряет всех пользователей, существовавших до миграции', async () => {
  // Ловит выкладку, после которой старые аккаунты внезапно оказываются ожидающими ручного одобрения.
  const raw = new PGlite();
  try {
    const { migrationsDir, migrationOrder } = await import('../src/db/index.js');
    const files = migrationOrder(await readdir(migrationsDir));
    for (const file of files) {
      if (file === '0062_registration_approval.sql') break;
      await raw.exec(await readFile(join(migrationsDir, file), 'utf8'));
    }
    await raw.exec(`
      INSERT INTO users (id, username, display_name, password_hash, created_at)
      VALUES ('before-0062', 'BeforeApproval', 'Before Approval', 'hash', '2025-05-06T07:08:09Z')
    `);
    await raw.exec(await readFile(join(migrationsDir, '0062_registration_approval.sql'), 'utf8'));
    const result = await raw.query<{ created_at: Date; approved_at: Date | null }>(
      `SELECT created_at, approved_at FROM users WHERE id = 'before-0062'`,
    );
    assert.equal(result.rows[0]?.approved_at?.toISOString(), result.rows[0]?.created_at.toISOString());
  } finally {
    await raw.close();
  }
});

async function beforeDmMove(): Promise<{ raw: PGlite; migration: string }> {
  const raw = new PGlite();
  const { migrationsDir, migrationOrder } = await import('../src/db/index.js');
  const files = migrationOrder(await readdir(migrationsDir));
  const migration = await readFile(join(migrationsDir, '0079_dm_to_conversations.sql'), 'utf8');
  for (const file of files) {
    if (file === '0079_dm_to_conversations.sql') break;
    await raw.exec(await readFile(join(migrationsDir, file), 'utf8'));
  }
  await raw.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY)');
  return { raw, migration };
}

test('0079 сохраняет старый порядок, связи и непрочитанное при переносе живых ЛС', async () => {
  // Ловит перестановку сообщений внутри миллисекунды и вспышку старого unread после миграции.
  const { raw, migration } = await beforeDmMove();
  try {
    await raw.exec(`
      INSERT INTO users (id, username, display_name, password_hash) VALUES
        ('a','a','A','hash'),('b','b','B','hash'),('c','c','C','hash'),('d','d','D','hash');
      INSERT INTO dm_channels (id, user_a, user_b) VALUES
        ('ab','a','b'),('ac','a','c'),('empty','b','d');
      INSERT INTO dm_messages (id, dm_channel_id, author_id, content, created_at) VALUES
        ('z','ab','b','first','2026-09-20 12:00:00.000100+00'),
        ('a','ab','b','second','2026-09-20 12:00:00.000900+00'),
        ('same-b','ab','b','same','2026-09-20 12:00:00.001000+00'),
        ('same-a','ab','b','same','2026-09-20 12:00:00.001000+00'),
        ('same-c','ab','b','same','2026-09-20 12:00:00.001000+00'),
        ('next-us','ab','b','next','2026-09-20 12:00:00.001001+00');
      INSERT INTO dm_messages (id, dm_channel_id, author_id, content, created_at) VALUES
        ('old','ac','c','old', now() - interval '15 days'),
        ('young','ac','c','young', now() - interval '13 days');
      INSERT INTO dm_reads (dm_channel_id, user_id, last_read_at) VALUES
        ('ab','a','2026-09-20 12:00:00.001000+00'),
        ('ab','b','2030-01-01T00:00:00Z');
      UPDATE dm_messages SET hidden_for = ARRAY['a'] WHERE id = 'same-c';
      UPDATE dm_messages SET withheld = true WHERE id = 'next-us';
      UPDATE dm_messages SET reply_to_id = 'a' WHERE id = 'same-a';
      INSERT INTO dm_message_reactions (message_id, user_id, emoji) VALUES ('a','a','👍');
    `);
    const oldOrder = (await raw.query<{ id: string }>(
      `SELECT id FROM dm_messages WHERE dm_channel_id = 'ab' ORDER BY created_at, id`,
    )).rows.map((r) => r.id);
    const oldUnread = (await raw.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM dm_messages m WHERE m.dm_channel_id = 'ac' AND m.author_id <> 'a'
        AND m.created_at > now() - interval '14 days' AND NOT m.withheld AND NOT ('a' = ANY(m.hidden_for))
    `)).rows[0]?.n;

    await raw.exec(`BEGIN; ${migration} INSERT INTO _migrations (name) VALUES ('0079_dm_to_conversations.sql'); COMMIT;`);
    const moved = (await raw.query<{ id: string; sort_key: number }>(
      `SELECT id, sort_key FROM conversation_messages WHERE conversation_id = 'ab' ORDER BY sort_key`,
    )).rows;
    assert.deepEqual(moved.map((r) => r.id), oldOrder);
    assert.equal(new Set(moved.map((r) => String(r.sort_key))).size, moved.length);
    for (let i = 1; i < moved.length; i++) assert.ok(Number(moved[i]!.sort_key) > Number(moved[i - 1]!.sort_key));
    const members = await raw.query<{ user_id: string; last_read_key: number }>(
      `SELECT user_id, last_read_key FROM conversation_members WHERE conversation_id = 'ab' ORDER BY user_id`,
    );
    const keyOf = (id: string) => Number(moved.find((r) => r.id === id)?.sort_key);
    // Старая отметка была временем: включает ВСЕ строки с тем же timestamp, в том числе соседний id.
    assert.equal(Number(members.rows[0]?.last_read_key), keyOf('same-c'));
    assert.equal(Number(members.rows[1]?.last_read_key), keyOf('next-us'));
    const newUnread = (await raw.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM conversation_messages m JOIN conversation_members cm
        ON cm.conversation_id = m.conversation_id AND cm.user_id = 'a'
      WHERE m.conversation_id = 'ac' AND m.author_id <> 'a' AND m.sort_key > cm.last_read_key
        AND NOT m.withheld AND m.deleted_at IS NULL AND NOT ('a' = ANY(m.hidden_for))
    `)).rows[0]?.n;
    assert.equal(newUnread, oldUnread);
    assert.equal(newUnread, 1);
    const links = await raw.query<{ reply_to_id: string; hidden_for: string[] }>(
      `SELECT reply_to_id, hidden_for FROM conversation_messages WHERE id = 'same-a'`,
    );
    assert.equal(links.rows[0]?.reply_to_id, 'a');
    assert.deepEqual((await raw.query(`SELECT emoji FROM conversation_message_reactions WHERE message_id = 'a'`)).rows,
      [{ emoji: '👍' }]);
    assert.deepEqual((await raw.query<{ hidden_for: string[] }>(`SELECT hidden_for FROM conversation_messages WHERE id = 'same-c'`)).rows[0]?.hidden_for, ['a']);
    assert.equal((await raw.query<{ withheld: boolean }>(`SELECT withheld FROM conversation_messages WHERE id = 'next-us'`)).rows[0]?.withheld, true);
    assert.equal(Number((await raw.query<{ last_sort_key: number }>(`SELECT last_sort_key FROM conversations WHERE id = 'empty'`)).rows[0]?.last_sort_key), 0);
    assert.equal((await raw.query(`SELECT id FROM dm_messages`)).rows.length, 8);
  } finally {
    await raw.close();
  }
});

test('0079 отказывается от непустой таблицы бесед и не переносит ничего частично', async () => {
  // Ловит смешение старых и новых ЛС после неудачного старта миграции.
  const { raw, migration } = await beforeDmMove();
  try {
    await raw.exec(`
      INSERT INTO users (id, username, display_name, password_hash) VALUES ('a','a','A','hash'),('b','b','B','hash');
      INSERT INTO dm_channels (id, user_a, user_b) VALUES ('old','a','b');
      INSERT INTO dm_messages (id, dm_channel_id, author_id, content) VALUES ('old-msg','old','a','old');
      INSERT INTO conversations (id, kind, direct_key) VALUES ('existing','direct','a:b');
    `);
    await assert.rejects(raw.exec(`BEGIN; ${migration} INSERT INTO _migrations (name) VALUES ('0079_dm_to_conversations.sql'); COMMIT;`),
      /не пуста/);
    await raw.exec('ROLLBACK');
    assert.deepEqual((await raw.query(`SELECT id FROM conversations`)).rows, [{ id: 'existing' }]);
    assert.equal((await raw.query(`SELECT id FROM conversation_messages`)).rows.length, 0);
    assert.deepEqual((await raw.query(`SELECT id FROM dm_messages`)).rows, [{ id: 'old-msg' }]);
    assert.equal((await raw.query(`SELECT name FROM _migrations`)).rows.length, 0);
  } finally {
    await raw.close();
  }
});

test('0070 переносит существующие пары членства в поручительства без дублей', async () => {
  // Ловит выкладку, после которой старые гости перестают получать обновления и пуши до повторного входа.
  const raw = new PGlite();
  try {
    const { migrationsDir, migrationOrder } = await import('../src/db/index.js');
    const files = migrationOrder(await readdir(migrationsDir));
    for (const file of files) {
      if (file === '0070_federation_guest_grants.sql') break;
      await raw.exec(await readFile(join(migrationsDir, file), 'utf8'));
    }
    await raw.exec(`
      INSERT INTO users (id, username, display_name, password_hash)
      VALUES ('local', 'local', 'Local', 'hash');
      INSERT INTO federation_memberships
        (instance_id, user_id, server_id, server_name, state, updated_at)
      VALUES
        ('peer', 'local', 'one', 'One', 'active', 1),
        ('peer', 'local', 'two', 'Two', 'active', 2)
    `);
    await raw.exec(await readFile(join(migrationsDir, '0070_federation_guest_grants.sql'), 'utf8'));
    const result = await raw.query<{ user_id: string; instance_id: string }>(
      `SELECT user_id, instance_id FROM federation_guest_grants`,
    );
    assert.deepEqual(result.rows, [{ user_id: 'local', instance_id: 'peer' }]);
  } finally {
    await raw.close();
  }
});
