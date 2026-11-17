import assert from 'node:assert/strict';
import { createTestDb } from './harness.js';
import { writeSnapshot } from './dbSnapshot.js';

// Non-idempotent migration: replay must fail; its data must survive exactly once.
if (process.argv[2] === 'roundtrip') {
  const dir = process.argv[3];
  const cold = await createTestDb({ cold: true });
  try { await writeSnapshot(dir, cold.snapshotKey, cold.raw); }
  finally { await cold.close(); }
  process.env.GV_PGLITE_SNAPSHOT = dir;
  delete process.env.GV_MUTANTS;
}
const fixture = await createTestDb();
try {
  if (process.argv[2] === 'roundtrip') {
    assert.deepEqual((await fixture.raw.query('SELECT value FROM migration_effect')).rows, [{ value: 1 }]);
    assert.equal((await fixture.raw.query('SELECT * FROM _migrations')).rows.length, 1);
  }
  await fixture.raw.exec('CREATE TABLE snapshot_probe(id serial PRIMARY KEY)');
  assert.deepEqual((await fixture.raw.query('INSERT INTO snapshot_probe DEFAULT VALUES RETURNING id')).rows, [{ id: 1 }]);
} finally {
  await fixture.close();
  await (await import('../src/db/index.js')).pool.end();
}
