import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/db/schema.js';

/**
 * Настоящий Postgres для тестов — без Docker, прода и сети (#143).
 *
 * `@electric-sql/pglite` — это сам Postgres, собранный в wasm: работают транзакции, индексы,
 * ограничения и `ON CONFLICT`, то есть ровно то, что нельзя проверить подделкой базы. Каждый тестовый
 * файл поднимает свою базу в памяти, прогоняет ВСЕ миграции и подменяет соединение приложения — после
 * этого прод-код (`loadPeers`, `shareServer`, `openDm`, обезличивание, уборка) работает как в бою.
 *
 * ⚠️ Порядок миграций берётся из `migrationOrder` приложения, а не повторяется здесь: разойдись они —
 * и тесты проверяли бы базу, которой не бывает в бою.
 * ⚠️ Модули приложения читают `env` на импорте и падают без обязательных переменных, поэтому
 * `createTestDb` выставляет заглушки ДО динамического импорта `src/db/index.js`. Значение `JWT_SECRET`
 * намеренно не из `.env.example`: иначе сработает отказ старта на заглушке (`secretRules`).
 * ⚠️ И не похоже на настоящий ключ (никаких hex-строк): иначе краснеет поиск секретов в гейте — эта грабля
 * уже кусала на выдуманном секрете в тесте Codex 16.09.
 */

const TEST_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://gusvoice:integration@127.0.0.1:1/ignored-by-pglite',
  JWT_SECRET: 'not-a-secret-used-only-by-integration-tests',
  LIVEKIT_API_KEY: 'integration-test-key',
  LIVEKIT_API_SECRET: 'not-a-secret-used-only-by-integration-tests',
  LIVEKIT_URL_EXTERNAL: 'wss://livekit.invalid',
  REDIS_URL: 'redis://127.0.0.1:1',
};

export interface TestDb {
  /** Соединение drizzle поверх временной базы — то же самое, что видит прод-код. */
  db: ReturnType<typeof drizzle<typeof schema>>;
  /** Сырой доступ, когда нужен SQL мимо схемы (проверить индекс, наполнить таблицу). */
  raw: PGlite;
  /** Сколько миграций применилось — чтобы тест мог утверждать, что прошли все. */
  appliedMigrations: string[];
  close(): Promise<void>;
}

/**
 * Поднять пустую базу, применить все миграции и подставить её приложению.
 *
 * Зовётся один раз на тестовый файл (`before`), закрывается в `after`. Между тестами одного файла
 * база общая — так же, как в бою: если тест зависит от чистоты, он убирает за собой сам.
 */
export async function createTestDb(): Promise<TestDb> {
  for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] ??= value;

  const raw = new PGlite();
  const db = drizzle(raw, { schema });

  const { migrationsDir, migrationOrder, migrationPlan, setDbForTests } = await import('../src/db/index.js');
  const files = migrationOrder(await readdir(migrationsDir));
  await raw.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const plan = migrationPlan(sql);
    if (!plan.transaction) {
      // `-- gv:no-transaction` (`CONCURRENTLY`): по шагам вне транзакции — как в `runMigrations`.
      for (const step of plan.steps) {
        try {
          await raw.exec(step.sql);
        } catch (err) {
          if (!step.optional) throw err;
        }
      }
      await raw.exec(`INSERT INTO _migrations (name) VALUES ('${file}')`);
      continue;
    }
    // Файл целиком в одной транзакции — как в `runMigrations`: половина применённой миграции хуже, чем ни одной.
    await raw.exec(`BEGIN;\n${sql}\nINSERT INTO _migrations (name) VALUES ('${file}');\nCOMMIT;`);
  }

  setDbForTests(db as unknown as Parameters<typeof setDbForTests>[0]);

  return {
    db,
    raw,
    appliedMigrations: files,
    close: () => raw.close(),
  };
}

/** Удобное «очистить всё, кроме служебного» между тестами одного файла. */
export async function truncateAll(raw: PGlite): Promise<void> {
  const res = await raw.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_migrations'`,
  );
  const names = res.rows.map((r) => `"${r.tablename}"`);
  if (names.length === 0) return;
  await raw.exec(`TRUNCATE ${names.join(', ')} RESTART IDENTITY CASCADE`);
}
