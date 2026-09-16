import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env.js';
import * as schema from './schema.js';

const { Pool } = pg;

export const pool = new Pool({ connectionString: env.databaseUrl });
export const db = drizzle(pool, { schema });

// In the bundled runtime image the source tree is gone, so the relative path below no longer
// resolves — the Dockerfile sets MIGRATIONS_DIR to where it COPYs the drizzle/ SQL. Under tsx
// (dev + current image) MIGRATIONS_DIR is unset and we fall back to ../../drizzle next to src.
const migrationsDir = process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

/**
 * Minimal forward-only migrator: applies every *.sql file in drizzle/ exactly once,
 * tracked in the _migrations table. Keeps the runtime image free of drizzle-kit.
 */
export async function runMigrations(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[db] applied migration ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export { schema };
