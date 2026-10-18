import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createKeystore } from './keystore.js';
import { createFederation, type Federation, type FederationDeps } from './state.js';

async function withTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'gusvoice-fed-switch-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function deps(dir: string): FederationDeps {
  return {
    enabled: true,
    keystore: createKeystore(dir, 'r257-synthetic-password'),
    now: () => Date.UTC(2026, 9, 18),
    loadInstanceMeta: async () => ({ name: 'Тест', iconHash: null }),
    domain: 'local.example',
    clientOrigin: 'https://local.example',
    apiBase: 'https://local.example/api',
    appVersion: null,
    log: () => {},
  };
}

async function assertStopped(federation: Federation): Promise<void> {
  assert.equal(federation.status(), 'off');
  assert.equal(federation.problem(), null);
  assert.equal(federation.identity(), null);
  assert.equal(federation.signingKey(), null);
  assert.equal(federation.keyExpiry(), null);
  assert.equal(await federation.document(), null);
}

describe('выключение федерации забывает ключи в памяти, но не личность на диске (#224)', () => {
  it('stop закрывает документ и подпись; повторный start возвращает те же instanceId и ключи', async () => withTemp(async (dir) => {
    const federation = createFederation(deps(dir));
    await federation.start();
    assert.equal(federation.status(), 'ready');
    const identity = federation.identity();
    const signing = federation.signingKey();
    assert.ok(identity);
    assert.ok(signing);
    assert.equal((await federation.document())?.instanceId, identity.instanceId);
    const files = (await readdir(dir)).sort();

    federation.stop();
    await assertStopped(federation);
    federation.stop();
    await assertStopped(federation);
    await federation.ensureSigningKey();
    assert.equal(federation.signingKey(), null, 'плановый такт после выключения не возвращает ключ в память');
    assert.deepEqual((await readdir(dir)).sort(), files, 'stop не удаляет зашифрованные ключи');

    await federation.start();
    assert.equal(federation.status(), 'ready');
    assert.equal(federation.identity()?.instanceId, identity.instanceId);
    assert.deepEqual(federation.identity()?.rootPublicKeyDer, identity.rootPublicKeyDer);
    assert.deepEqual(federation.identity()?.rootPrivateKeyDer, identity.rootPrivateKeyDer);
    assert.equal(federation.signingKey()?.kid, signing.kid);
    assert.equal((await federation.document())?.instanceId, identity.instanceId);
  }));

  it('выключенный runtime не создаёт личность, включённый поднимает её без нового объекта федерации', async () => withTemp(async (dir) => {
    let enabled = false;
    let dmEnabled = false;
    const federation = createFederation({
      ...deps(dir),
      get enabled() { return enabled; },
      get dmEnabled() { return dmEnabled; },
    });
    await federation.start();
    await assertStopped(federation);
    assert.deepEqual(await readdir(dir), []);
    enabled = true;
    dmEnabled = true;
    await federation.start();
    assert.equal(federation.status(), 'ready');
    assert.ok((await federation.document())?.features.includes('dm1'));
    const instanceId = federation.identity()!.instanceId;
    federation.stop();
    enabled = false;
    await federation.start();
    await assertStopped(federation);
    enabled = true;
    dmEnabled = false;
    await federation.start();
    assert.equal(federation.identity()?.instanceId, instanceId);
    assert.equal((await federation.document())?.features.includes('dm1'), false);
  }));

  it('stop убирает ошибку чужого пароля, а правильный пароль затем открывает прежнюю личность', async () => withTemp(async (dir) => {
    const correct = createKeystore(dir, 'r257-right');
    const original = await correct.loadOrCreateRoot();
    let keystore = createKeystore(dir, 'r257-wrong');
    const federation = createFederation({
      ...deps(dir),
      get keystore() { return keystore; },
      passphraseSource: () => 'base',
    });
    await federation.start();
    assert.equal(federation.status(), 'key-error');
    assert.match(federation.problem()!, /пароль из базы/);
    assert.equal(federation.identity(), null);
    federation.stop();
    await assertStopped(federation);
    keystore = correct;
    await federation.start();
    assert.equal(federation.status(), 'ready');
    assert.equal(federation.problem(), null);
    assert.equal(federation.identity()?.instanceId, original.identity.instanceId);
  }));
});
