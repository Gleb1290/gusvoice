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
