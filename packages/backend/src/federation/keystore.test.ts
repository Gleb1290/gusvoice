import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { KeyPassphraseError } from './keyEnvelope.js';
import { createKeystore, issueAndStore } from './keystore.js';

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'gusvoice-fed-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('файловое хранилище федеративных ключей', () => {
  it('первый старт создаёт личность, второй читает ту же', async () => withTemp(async (dir) => {
    const store = createKeystore(dir, 'password');
    const first = await store.loadOrCreateRoot();
    const second = await store.loadOrCreateRoot();
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.identity.instanceId, first.identity.instanceId);
    assert.deepEqual(second.identity.rootPrivateKeyDer, first.identity.rootPrivateKeyDer);
  }));

  it('чужой пароль не создаёт новую личность поверх существующей', async () => withTemp(async (dir) => {
    const original = await createKeystore(dir, 'right').loadOrCreateRoot();
    await assert.rejects(createKeystore(dir, 'wrong').loadOrCreateRoot(), KeyPassphraseError);
    const reread = await createKeystore(dir, 'right').loadOrCreateRoot();
    assert.equal(reread.identity.instanceId, original.identity.instanceId);
  }));

  it('битый файл сменного ключа пропускается, а годный рядом остаётся', async () => withTemp(async (dir) => {
    const store = createKeystore(dir, 'password');
    const root = await store.loadOrCreateRoot();
    const good = await issueAndStore(store, root.identity.rootPrivateKeyDer, 100);
    await writeFile(join(dir, 'fed-signing-corrupt.key'), '{not-json', 'utf8');
    const loaded = await store.loadSigningKeys(root.identity.rootPrivateKeyDer);
    assert.deepEqual(loaded.map((key) => key.kid), [good.kid]);
  }));
});
