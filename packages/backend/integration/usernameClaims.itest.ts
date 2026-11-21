import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { isUsernameConflict } from '../src/setupRules.js';

it('переход сохраняет старые ники и резервирует каждый до ухода последнего владельца', async () => {
  const pg = await PGlite.create();
  try {
    await pg.exec(`
      CREATE TABLE users (id text PRIMARY KEY, username text NOT NULL UNIQUE, display_name text NOT NULL);
      INSERT INTO users VALUES ('1', 'ExampleBot', 'Первый'), ('2', 'examplebot', 'Второй');
    `);
    const migration = await readFile(new URL('../drizzle/0168_username_ci.sql', import.meta.url), 'utf8');
    await pg.transaction(async (tx) => { await tx.exec(migration); });

    const { rows } = await pg.query('SELECT id, username, display_name FROM users ORDER BY id');
    assert.deepEqual(rows, [
      { id: '1', username: 'ExampleBot', display_name: 'Первый' },
      { id: '2', username: 'examplebot', display_name: 'Второй' },
    ]);
    await pg.query("UPDATE users SET username = 'ExampleBOT' WHERE id = '1'");
    const claim = () => pg.query("INSERT INTO users VALUES ('3', 'EXAMPLEBOT', 'Третий')");
    await assert.rejects(claim, isUsernameConflict);
    await pg.query("UPDATE users SET username = 'OtherBot' WHERE id = '1'");
    await assert.rejects(claim, isUsernameConflict);
    await pg.query("DELETE FROM users WHERE id = '2'");
    await claim();
    await assert.rejects(pg.query("UPDATE users SET username = 'exampleBot' WHERE id = '1'"), isUsernameConflict);
    const { rows: final } = await pg.query('SELECT id, username FROM users ORDER BY id');
    assert.deepEqual(final, [{ id: '1', username: 'OtherBot' }, { id: '3', username: 'EXAMPLEBOT' }]);
  } finally {
    await pg.close();
  }
});
