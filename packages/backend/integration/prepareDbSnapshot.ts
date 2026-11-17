import { createTestDb } from './harness.js';
import { writeSnapshot } from './dbSnapshot.js';

const dir = process.argv[2];
if (!dir) throw new Error('snapshot destination required');
const fixture = await createTestDb({ cold: true });
try {
  // Use the fingerprint of the bytes actually migrated, not a second read after migration.
  await writeSnapshot(dir, fixture.snapshotKey, fixture.raw);
} finally {
  await fixture.close();
  await (await import('../src/db/index.js')).pool.end();
}
