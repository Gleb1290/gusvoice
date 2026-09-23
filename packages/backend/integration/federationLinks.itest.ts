import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
let activePeerHosts: typeof import('../src/federation/links.js').activePeerHosts;
let listLinks: typeof import('../src/federation/links.js').listLinks;
let purgeStaleCodes: typeof import('../src/federation/links.js').purgeStaleCodes;
let rebindLink: typeof import('../src/federation/revocation.js').rebindLink;
let receiveRevocation: typeof import('../src/federation/revocation.js').receiveRevocation;

before(async () => {
  t = await createTestDb();
  ({ activePeerHosts, listLinks, purgeStaleCodes } = await import('../src/federation/links.js'));
  ({ rebindLink, receiveRevocation } = await import('../src/federation/revocation.js'));
});
beforeEach(async () => truncateAll(t.raw));
after(async () => {
  // `revocation.ts` тянет адресную рассылку гостям; живой Redis интеграционному тесту не нужен.
  (await import('../src/realtime.js')).redisPub.disconnect();
  await t.close();
});

const linkSql = (id: string, state = 'active', domain = `${id}.example`) => `
  INSERT INTO federation_links
    (instance_id, domain, api_base, client_origin, root_key, state, protocol_version, features)
  VALUES
    ('${id}', '${domain}', 'https://${domain}', 'https://${domain}', 'root-${id}', '${state}', 1, '[]')
`;

test('миграции F1 держат личность первичным ключом, секрет уникальным, а домен не уникальным', async () => {
  // Ловит перенос уникальности с личности на адрес и повторное использование одного секрета.
  for (const name of ['0063_federation_links.sql', '0064_federation_revoked_keys.sql', '0065_federation_outbox.sql']) {
    assert.equal(t.appliedMigrations.includes(name), true, name);
  }
  await t.raw.exec(`${linkSql('peer-a', 'active', 'same.example')}; ${linkSql('peer-b', 'paused', 'same.example')}`);
  await assert.rejects(t.raw.exec(linkSql('peer-a', 'active', 'other.example')), /duplicate key|unique/i);
  await t.raw.exec(`
    INSERT INTO federation_link_codes (id, secret_hash, expires_at) VALUES ('c1', 'same-secret', now() + interval '1 day')
  `);
  await assert.rejects(
    t.raw.exec(`INSERT INTO federation_link_codes (id, secret_hash, expires_at) VALUES ('c2', 'same-secret', now() + interval '1 day')`),
    /duplicate key|unique/i,
  );
});

test('наружу разрешены только активные хосты, а уборка не трогает действующий код', async () => {
  // Ловит оставшуюся сетевую дверь после паузы и off-by-one в уборке одноразовых кодов.
  await t.raw.exec(`${linkSql('active', 'active')}; ${linkSql('paused', 'paused')}; ${linkSql('blocked', 'blocked')}`);
  assert.deepEqual([...await activePeerHosts()], ['active.example']);
  await t.raw.exec(`
    INSERT INTO federation_link_codes (id, secret_hash, expires_at) VALUES
      ('old', 'old-hash', '2026-01-01T00:00:00Z'),
      ('live', 'live-hash', '2027-01-01T00:00:00Z')
  `);
  assert.equal(await purgeStaleCodes(new Date('2026-09-16T00:00:00Z')), 1);
  const codes = await t.raw.query<{ id: string }>('SELECT id FROM federation_link_codes ORDER BY id');
  assert.deepEqual(codes.rows.map((row) => row.id), ['live']);
});

test('перепривязка атомарно переносит имя, обнуляет номера и удаляет старую личность', async () => {
  // Ловит вторую строку вместо переноса и отбрасывание первых событий соседа новым старым счётчиком.
  await t.raw.exec(`
    ${linkSql('old', 'trust-lost')};
    UPDATE federation_links SET local_name = 'Мои друзья', last_event_seq = 9, out_event_seq = 12 WHERE instance_id = 'old'
  `);
  assert.equal(await rebindLink('old', {
    instanceId: 'new', domain: 'new.example', apiBase: 'https://new.example', clientOrigin: 'https://new.example',
    rootKey: 'root-new', theirName: 'Новое имя', protocolVersion: 1, features: ['events'],
  }), true);
  const rows = await t.raw.query<{ instance_id: string; local_name: string | null; last_event_seq: bigint; out_event_seq: bigint; state: string }>(
    'SELECT instance_id, local_name, last_event_seq, out_event_seq, state FROM federation_links',
  );
  assert.deepEqual(rows.rows.map((row) => ({ ...row, last_event_seq: Number(row.last_event_seq), out_event_seq: Number(row.out_event_seq) })), [{
    instance_id: 'new', local_name: 'Мои друзья', last_event_seq: 0, out_event_seq: 0, state: 'active',
  }]);
});

test('повтор подписанного отзыва ключа идемпотентен, а listLinks считает очередь', async () => {
  // Ловит падение повторной доставки на PK и вкладку, которая скрывает реально застрявшие события.
  const old = generateKeyPairSync('ed25519');
  const privateKey = old.privateKey.export({ type: 'pkcs8', format: 'der' });
  const publicKey = old.publicKey.export({ type: 'spki', format: 'der' });
  await t.raw.exec(`
    INSERT INTO federation_links
      (instance_id, domain, api_base, client_origin, root_key, state, protocol_version, features)
    VALUES
      ('old', 'old.example', 'https://old.example', 'https://old.example', '${Buffer.from(publicKey).toString('base64url')}', 'active', 1, '[]');
    INSERT INTO federation_outbox (id, instance_id, seq, event_id, kind, payload) VALUES
      ('o1', 'old', 1, 'e1', 'user.updated', '{}'),
      ('o2', 'old', 2, 'e2', 'user.updated', '{}')
  `);
  const { signRevocation } = await import('../src/federation/keyRevocation.js');
  const notice = signRevocation(privateKey, {
    oldInstanceId: 'old', newInstanceId: 'new', newRootKey: 'new-root', revokedAt: Date.now(),
  });
  assert.equal((await receiveRevocation(notice)).ok, true);
  assert.equal((await receiveRevocation(notice)).ok, true);
  const revoked = await t.raw.query('SELECT 1 FROM federation_revoked_keys');
  assert.equal(revoked.rows.length, 1);
  assert.equal((await listLinks())[0]?.queued, 2);
});
