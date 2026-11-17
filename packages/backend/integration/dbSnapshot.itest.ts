import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTestDb } from './harness.js';
import { databaseSnapshotKey, readSnapshot, snapshotKey, writeSnapshot } from './dbSnapshot.js';
import { readdir } from 'node:fs/promises';

after(async () => { await (await import('../src/db/index.js')).pool.end(); });

test('снимок: изоляция, четыре читателя, инвалидирование и отказы', { timeout: 120_000 }, async t => {
  const dir = await mkdtemp(resolve('node_modules/.snapshot-check-'));
  const saved = { snapshot: process.env.GV_PGLITE_SNAPSHOT, mutants: process.env.GV_MUTANTS, migrations: process.env.MIGRATIONS_DIR };
  let key: string;
  let migrations: { name: string; sql: string }[];
  try {
    delete process.env.GV_PGLITE_SNAPSHOT;
    delete process.env.GV_MUTANTS;
    const cold = await createTestDb({ cold: true });
    try {
      const source = await import('../src/db/index.js');
      migrations = await Promise.all(source.migrationOrder(await readdir(source.migrationsDir)).map(async name => ({
        name, sql: await readFile(join(source.migrationsDir, name), 'utf8'),
      })));
      key = await databaseSnapshotKey(migrations);
      await writeSnapshot(dir, key, cold.raw);
    } finally { await cold.close(); }
    process.env.GV_PGLITE_SNAPSHOT = dir;

    await t.test('данные, DDL и sequence одной фикстуры не попадают в следующую', async () => {
      for (let i = 0; i < 2; i++) {
        const fixture = await createTestDb();
        try {
          assert.equal(fixture.appliedMigrations.length, migrations.length);
          assert.equal((await fixture.raw.query('SELECT * FROM _migrations')).rows.length, migrations.length);
          await fixture.raw.exec('CREATE TABLE snapshot_probe (id serial PRIMARY KEY, value text)');
          assert.deepEqual((await fixture.raw.query("INSERT INTO snapshot_probe(value) VALUES ('local') RETURNING id")).rows, [{ id: 1 }]);
          await fixture.raw.exec('ALTER TABLE snapshot_probe ADD COLUMN extra text');
        } finally { await fixture.close(); }
      }
    });

    await t.test('четыре процесса читают один неизменный снимок параллельно', async () => {
      const before = snapshotKey([await readFile(join(dir, 'database.tar'))]);
      const results = await Promise.all(Array.from({ length: 4 }, () => new Promise<string>((resolveChild, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'integration/dbSnapshotProbe.ts'], {
          env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        const timer = setTimeout(() => { child.kill(); reject(new Error('snapshot reader timeout')); }, 30_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolveChild(output) : reject(new Error(output)); });
      })));
      assert.equal(results.length, 4);
      assert.equal(snapshotKey([await readFile(join(dir, 'database.tar'))]), before);
    });

    await t.test('байты, имена и порядок миграций инвалидируют снимок', async () => {
      const changed = [
        [{ ...migrations[0], sql: migrations[0].sql + '\n-- changed' }, ...migrations.slice(1)],
        [{ ...migrations[0], name: 'renamed.sql' }, ...migrations.slice(1)],
        [...migrations].reverse(),
        migrations.slice(1),
      ];
      assert.equal(await databaseSnapshotKey(migrations), key);
      for (const variant of changed) {
        const next = await databaseSnapshotKey(variant);
        assert.notEqual(next, key);
        await assert.rejects(readSnapshot(dir, next), /stale/);
      }
      const otherEngine = await databaseSnapshotKey(migrations, 'test-engine-version');
      assert.notEqual(otherEngine, key);
      await assert.rejects(readSnapshot(dir, otherEngine), /stale/);
      assert.notEqual(snapshotKey(['ab', 'c']), snapshotKey(['a', 'bc']));
    });

    await t.test('нет манифеста: частичный снимок не принимается', async () => {
      const empty = await mkdtemp(join(dir, 'partial-'));
      await assert.rejects(readSnapshot(empty, key), /ENOENT/);
      await writeFile(join(empty, 'manifest.json'), '{');
      await assert.rejects(readSnapshot(empty, key), SyntaxError);
    });

    await t.test('повреждённый архив отклоняется до запуска базы', async () => {
      const archive = await readFile(join(dir, 'database.tar'));
      try {
        await writeFile(join(dir, 'database.tar'), archive.subarray(0, 100));
        await assert.rejects(createTestDb(), /checksum mismatch/);
      } finally { await writeFile(join(dir, 'database.tar'), archive); }
    });

    await t.test('cold и режим мутантов выполняют миграции даже при недоступном снимке', async () => {
      process.env.GV_PGLITE_SNAPSHOT = join(dir, 'missing');
      for (const mutants of ['0', '1']) {
        process.env.GV_MUTANTS = mutants;
        const fixture = await createTestDb({ cold: mutants === '0' });
        try { assert.equal((await fixture.raw.query('SELECT * FROM _migrations')).rows.length, migrations.length); }
        finally { await fixture.close(); }
      }
      process.env.GV_PGLITE_SNAPSHOT = dir;
      delete process.env.GV_MUTANTS;
    });

    await t.test('восстановление не повторяет неидемпотентную миграцию и её данные', async () => {
      const custom = await mkdtemp(join(dir, 'once-'));
      await writeFile(join(custom, '0000_once.sql'), 'CREATE TABLE migration_effect(value int); INSERT INTO migration_effect VALUES (1);');
      await new Promise<void>((done, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'integration/dbSnapshotProbe.ts', 'roundtrip', custom], {
          env: { ...process.env, MIGRATIONS_DIR: custom, NODE_OPTIONS: '--max-old-space-size=512' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        const timer = setTimeout(() => { child.kill(); reject(new Error('snapshot roundtrip timeout')); }, 30_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); code === 0 ? done() : reject(new Error(output)); });
      });
    });

    await t.test('ошибка миграции не публикует пригодный снимок', async () => {
      // migration directory is resolved on import; run a fresh process with its own environment.
      const bad = await mkdtemp(join(dir, 'bad-'));
      await writeFile(join(bad, '0000_bad.sql'), 'THIS IS NOT VALID SQL;');
      const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'integration/prepareDbSnapshot.ts', bad], {
          env: { ...process.env, MIGRATIONS_DIR: bad, NODE_OPTIONS: '--max-old-space-size=512' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        const timer = setTimeout(() => { child.kill(); reject(new Error('migration failure timeout')); }, 30_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); done({ code, output }); });
      });
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /syntax error/);
      await assert.rejects(readFile(join(bad, 'manifest.json')), /ENOENT/);
    });
  } finally {
    for (const [name, value] of Object.entries({ GV_PGLITE_SNAPSHOT: saved.snapshot, GV_MUTANTS: saved.mutants, MIGRATIONS_DIR: saved.migrations })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
