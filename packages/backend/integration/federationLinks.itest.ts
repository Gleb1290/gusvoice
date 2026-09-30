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
let instanceBanFor: typeof import('../src/federation/instanceBan.js').instanceBanFor;

before(async () => {
  t = await createTestDb();
  ({ activePeerHosts, listLinks, purgeStaleCodes } = await import('../src/federation/links.js'));
  ({ rebindLink, receiveRevocation } = await import('../src/federation/revocation.js'));
  ({ instanceBanFor } = await import('../src/federation/instanceBan.js'));
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

test('перепривязка базы отвергает заявки и административную блокировку без изменений', async () => {
  // Ловит обход карточечных проверок прямым вызовом необратимого переноса в базе.
  for (const state of ['requested', 'pending', 'blocked']) {
    await t.raw.exec(linkSql('old', state));
    assert.equal(await rebindLink('old', {
      instanceId: 'new', domain: 'new.example', apiBase: 'https://new.example', clientOrigin: 'https://new.example',
      rootKey: 'root-new', theirName: 'New', protocolVersion: 1, features: [],
    }), false, state);
    const rows = await t.raw.query<{ instance_id: string; state: string }>(
      `SELECT instance_id, state FROM federation_links ORDER BY instance_id`,
    );
    assert.deepEqual(rows.rows, [{ instance_id: 'old', state }]);
    await t.raw.exec(`DELETE FROM federation_links`);
  }
});

test('перепривязка переносит все хвосты личности и размораживает только разрешённые серверы', async () => {
  // Ловит повторный вход забаненного и оживление гостя на сервере, закрытом именно для этой связки.
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES
      ('owner', 'owner', 'Owner', 'hash'),
      ('local', 'local', 'Local', 'hash');
    INSERT INTO users (id, username, display_name, password_hash, home_instance_id, home_user_id)
    VALUES ('guest', 'guest@old', 'Guest', 'hash', 'old', 'home-u');
    INSERT INTO servers (id, name, owner_id, federated_access) VALUES
      ('excluded', 'Excluded', 'owner', true),
      ('open', 'Open', 'owner', true),
      ('removed', 'Removed', 'owner', true);
    INSERT INTO server_members (server_id, user_id, state) VALUES
      ('excluded', 'guest', 'closed_by_host'),
      ('open', 'guest', 'closed_by_host'),
      ('removed', 'guest', 'removed');
    ${linkSql('old', 'trust-lost')};
    ${linkSql('new', 'requested')};
    INSERT INTO server_federation_exclusions (server_id, instance_id) VALUES
      ('excluded', 'old'), ('excluded', 'new');
    INSERT INTO instance_bans (home_instance_id, home_user_id, reason)
    VALUES ('old', 'home-u', 'spam');
    INSERT INTO federation_guest_grants (user_id, instance_id) VALUES ('local', 'old');
    INSERT INTO federation_memberships
      (instance_id, user_id, server_id, server_name, state, updated_at)
    VALUES ('old', 'local', 'remote-server', 'Remote', 'active', 10);
    INSERT INTO federation_revocations (id, user_id, kind, created_at, instance_id)
    VALUES ('rev', 'local', 'sessions', 10, 'old');
    INSERT INTO federation_reports
      (id, direction, instance_id, report_id, reported_user_id, action)
    VALUES ('report', 'out', 'old', 'r1', 'home-u', 'instance_ban');
    INSERT INTO federation_alerts (kind, instance_id, detail) VALUES
      ('open-alert', 'old', ''),
      ('closed-alert', 'old', 'done');
    UPDATE federation_alerts SET resolved_at = now() WHERE kind = 'closed-alert';
    INSERT INTO federation_outbox (id, instance_id, seq, event_id, kind, payload)
    VALUES ('out', 'old', 1, 'event', 'user.updated', '{}');
    INSERT INTO federation_sync_state (instance_id, kind) VALUES ('old', 'directory')
  `);
  // Разморозка рассылает best-effort событие; состояние базы не должно ждать отсутствующий Redis.
  (await import('../src/realtime.js')).redisPub.disconnect();

  assert.equal(await rebindLink('old', {
    instanceId: 'new', domain: 'new.example', apiBase: 'https://new.example', clientOrigin: 'https://new.example',
    rootKey: 'root-new', theirName: 'New', protocolVersion: 1, features: [],
  }), true);

  assert.equal(await instanceBanFor('new', 'home-u'), true);
  assert.equal(await instanceBanFor('old', 'home-u'), false);
  const refs = await t.raw.query<{ source: string; instance_id: string }>(`
    SELECT 'grant' AS source, instance_id FROM federation_guest_grants
    UNION ALL SELECT 'membership', instance_id FROM federation_memberships
    UNION ALL SELECT 'revocation', instance_id FROM federation_revocations
    UNION ALL SELECT 'report', instance_id FROM federation_reports
    ORDER BY source
  `);
  assert.deepEqual(refs.rows, [
    { source: 'grant', instance_id: 'new' },
    { source: 'membership', instance_id: 'new' },
    { source: 'report', instance_id: 'new' },
    { source: 'revocation', instance_id: 'new' },
  ]);
  const exclusions = await t.raw.query<{ instance_id: string }>(
    `SELECT instance_id FROM server_federation_exclusions WHERE server_id = 'excluded'`,
  );
  assert.deepEqual(exclusions.rows, [{ instance_id: 'new' }]);
  const states = await t.raw.query<{ server_id: string; state: string }>(
    `SELECT server_id, state FROM server_members WHERE user_id = 'guest' ORDER BY server_id`,
  );
  assert.deepEqual(states.rows, [
    { server_id: 'excluded', state: 'closed_by_host' },
    { server_id: 'open', state: 'active' },
    { server_id: 'removed', state: 'removed' },
  ]);
  const guest = await t.raw.query<{ home_instance_id: string; token_generation: number }>(
    `SELECT home_instance_id, token_generation FROM users WHERE id = 'guest'`,
  );
  assert.deepEqual(guest.rows, [{ home_instance_id: 'new', token_generation: 1 }]);
  const openAlert = await t.raw.query<{ resolved_at: Date | null }>(
    `SELECT resolved_at FROM federation_alerts WHERE kind = 'open-alert'`,
  );
  assert.ok(openAlert.rows[0]?.resolved_at);
  const stale = await t.raw.query<{ source: string }>(`
    SELECT 'outbox' AS source FROM federation_outbox WHERE instance_id = 'old'
    UNION ALL SELECT 'sync' AS source FROM federation_sync_state WHERE instance_id = 'old'
  `);
  assert.deepEqual(stale.rows, []);
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

test('подписанный отзыв ключа немедленно замораживает активных гостей соседа', async () => {
  // Ловит действующий гостевой пропуск после того, как поручившийся за него ключ объявлен украденным.
  const old = generateKeyPairSync('ed25519');
  const privateKey = old.privateKey.export({ type: 'pkcs8', format: 'der' });
  const publicKey = old.publicKey.export({ type: 'spki', format: 'der' });
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash)
    VALUES ('owner', 'owner', 'Owner', 'hash');
    INSERT INTO users (id, username, display_name, password_hash, home_instance_id, home_user_id)
    VALUES ('guest', 'guest@old', 'Guest', 'hash', 'old', 'home-u');
    INSERT INTO servers (id, name, owner_id, federated_access)
    VALUES ('server', 'Server', 'owner', true);
    INSERT INTO server_members (server_id, user_id, state)
    VALUES ('server', 'guest', 'active');
    INSERT INTO federation_links
      (instance_id, domain, api_base, client_origin, root_key, state, protocol_version, features)
    VALUES
      ('old', 'old.example', 'https://old.example', 'https://old.example',
       '${Buffer.from(publicKey).toString('base64url')}', 'active', 1, '[]')
  `);
  (await import('../src/realtime.js')).redisPub.disconnect();
  const { signRevocation } = await import('../src/federation/keyRevocation.js');
  const notice = signRevocation(privateKey, {
    oldInstanceId: 'old', newInstanceId: 'new', newRootKey: 'new-root', revokedAt: Date.now(),
  });

  assert.equal((await receiveRevocation(notice)).ok, true);
  const member = await t.raw.query<{ state: string }>(
    `SELECT state FROM server_members WHERE server_id = 'server' AND user_id = 'guest'`,
  );
  assert.deepEqual(member.rows, [{ state: 'closed_by_host' }]);
  const guest = await t.raw.query<{ token_generation: number }>(
    `SELECT token_generation FROM users WHERE id = 'guest'`,
  );
  assert.deepEqual(guest.rows, [{ token_generation: 1 }]);
});
