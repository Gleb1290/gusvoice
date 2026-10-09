import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env.js';
import * as schema from './schema.js';

const { Pool } = pg;

export const pool = new Pool({ connectionString: env.databaseUrl });
/* 🔴 Простаивающее соединение умерло (Postgres перезапустился, оборвалась сеть) — пул шлёт `error`, и без слушателя
   Node роняет ВЕСЬ процесс: API лежит, пока Docker его не поднимет (поймано 01.10 на стенде, `57P01`). Пул сам
   выбрасывает такое соединение, следующий запрос откроет новое — нужно лишь не падать. */
pool.on('error', (err) => {
  console.error('[db] соединение в пуле оборвалось:', err.message);
});

/**
 * Соединение с базой. `let`, а не `const`, ровно ради одного: интеграционные тесты подменяют его на
 * временную базу в памяти (`integration/harness.ts`, #143) — иначе проверить SQL можно только живым
 * Postgres. В проде подменять некому: `setDbForTests` никто, кроме харнесса, не зовёт.
 */
export let db = drizzle(pool, { schema });

/** Только для интеграционных тестов: подменить соединение (см. `integration/harness.ts`). */
export function setDbForTests(next: typeof db): void {
  db = next;
}

// In the bundled runtime image the source tree is gone, so the relative path below no longer
// resolves — the Dockerfile sets MIGRATIONS_DIR to where it COPYs the drizzle/ SQL. Under tsx
// (dev + current image) MIGRATIONS_DIR is unset and we fall back to ../../drizzle next to src.
export const migrationsDir =
  process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

/**
 * Порядок применения миграций — по имени файла, только `.sql`.
 *
 * Отдельной функцией, потому что тот же порядок нужен харнессу интеграционных тестов: разойдись они —
 * и тесты проверяли бы базу, которой не бывает в бою.
 */
export function migrationOrder(files: string[]): string[] {
  return files.filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Миграция без транзакции (08.10, #211, решение владельца 16): первая строка файла — `-- gv:no-transaction`.
 *
 * Нужна для `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY`: индекс по большой таблице строится, не запирая запись в
 * неё (обычный `CREATE INDEX` держит блокировку записи всё время сборки), а такие команды Postgres внутри транзакции не
 * выполняет — ни в `BEGIN … COMMIT`, ни в строке из нескольких команд (неявный блок). Поэтому файл делится на шаги строками
 * `-- gv:step` и каждый шаг уходит отдельным запросом; `-- gv:step optional` — шаг, чья ошибка не валит миграцию (например,
 * нет расширения `pg_trgm`). Отметка в `_migrations` — после всех шагов: упала посередине — при следующем запуске файл идёт
 * заново, поэтому шаги обязаны быть повторяемыми (`IF NOT EXISTS`, а недостроенный `CONCURRENTLY` индекс, `indisvalid =
 * false`, — снести перед повтором: `IF NOT EXISTS` его иначе молча оставит невалидным навсегда).
 */
export const NO_TRANSACTION_MARK = '-- gv:no-transaction';

export interface MigrationStep {
  sql: string;
  optional: boolean;
}

/** План применения файла: одной транзакцией (обычный случай) или по шагам без транзакции. Тот же разбор у харнесса тестов. */
export function migrationPlan(sql: string): { transaction: true; sql: string } | { transaction: false; steps: MigrationStep[] } {
  const lines = sql.replace(/^\uFEFF/, '').split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== NO_TRANSACTION_MARK) return { transaction: true, sql };
  const steps: MigrationStep[] = [];
  let cur: MigrationStep | null = null;
  for (const line of lines) {
    const m = /^--\s*gv:step(\s+optional)?\s*$/.exec(line.trim());
    if (m) {
      if (cur) steps.push(cur);
      cur = { sql: '', optional: !!m[1] };
      continue;
    }
    if (cur) cur.sql += `${line}\n`;
  }
  if (cur) steps.push(cur);
  // Шаг из одних комментариев — не запрос.
  return { transaction: false, steps: steps.filter((st) => st.sql.replace(/--.*$/gm, '').trim() !== '') };
}

/**
 * Minimal forward-only migrator: applies every *.sql file in drizzle/ exactly once,
 * tracked in the _migrations table (by NAME only — no checksums). Keeps the runtime image free of drizzle-kit.
 */
export async function runMigrations(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const files = migrationOrder(await readdir(migrationsDir));
  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const plan = migrationPlan(sql);
    const client = await pool.connect();
    try {
      if (!plan.transaction) {
        // По шагам, каждый — своим запросом вне транзакции (`CONCURRENTLY`). Отметка — в самом конце.
        for (const step of plan.steps) {
          try {
            await client.query(step.sql);
          } catch (err) {
            if (!step.optional) throw err;
            console.warn(`[db] ${file}: необязательный шаг пропущен: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        console.log(`[db] applied migration ${file} (без транзакции)`);
        continue;
      }
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[db] applied migration ${file}`);
    } catch (err) {
      if (plan.transaction) await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export { schema };
