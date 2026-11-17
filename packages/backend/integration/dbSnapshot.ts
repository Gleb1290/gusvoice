import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const snapshotRequire = createRequire(import.meta.url);
export function snapshotKey(parts: readonly (string | Uint8Array)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.from(part);
    hash.update(String(bytes.length)).update(':').update(bytes);
  }
  return hash.digest('hex');
}

/** Hash bytes, not timestamps: renames, edits, order and engine/harness changes invalidate. */
export async function databaseSnapshotKey(migrations: readonly { name: string; sql: string }[], engineVersion?: string): Promise<string> {
  const engine = JSON.parse(await readFile(join(dirname(snapshotRequire.resolve('@electric-sql/pglite')), '..', 'package.json'), 'utf8'));
  return snapshotKey([
    'gv-pglite-snapshot-v1', engineVersion ?? engine.version,
    await readFile(new URL('./harness.ts', import.meta.url)),
    await readFile(new URL('./dbSnapshot.ts', import.meta.url)),
    await readFile(new URL('../src/db/index.ts', import.meta.url)),
    ...migrations.flatMap(({ name, sql }) => [name, sql]),
  ]);
}

/** Manifest published last; readers never consume a half-written archive. Single runner owns directory. */
export async function writeSnapshot(dir: string, key: string, raw: PGlite): Promise<void> {
  const bytes = Buffer.from(await (await raw.dumpDataDir('none')).arrayBuffer());
  await writeFile(join(dir, 'database.tar.tmp'), bytes);
  await rename(join(dir, 'database.tar.tmp'), join(dir, 'database.tar'));
  await writeFile(join(dir, 'manifest.json.tmp'), JSON.stringify({ key, checksum: snapshotKey([bytes]) }));
  await rename(join(dir, 'manifest.json.tmp'), join(dir, 'manifest.json'));
}

export async function readSnapshot(dir: string, key: string): Promise<Blob> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  if (manifest.key !== key) throw new Error('PGlite snapshot is stale: migrations, harness or engine changed; rerun integration runner');
  const bytes = await readFile(join(dir, 'database.tar'));
  if (manifest.checksum !== snapshotKey([bytes])) throw new Error('PGlite snapshot checksum mismatch');
  return new Blob([new Uint8Array(bytes)]);
}
