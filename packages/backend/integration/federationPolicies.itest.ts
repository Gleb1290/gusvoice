import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
let fedAudit: typeof import('../src/federation/auditLog.js').fedAudit;
let recentAudit: typeof import('../src/federation/auditLog.js').recentAudit;
let pruneAudit: typeof import('../src/federation/auditLog.js').pruneAudit;
let AUDIT_KEEP_MS: typeof import('../src/federation/auditLog.js').AUDIT_KEEP_MS;
let markTrustLost: typeof import('../src/federation/trustLoss.js').markTrustLost;
let revocationsSince: typeof import('../src/federation/guestRevocation.js').revocationsSince;
let reconcileMemberships: typeof import('../src/federation/guestMembership.js').reconcileMemberships;
let createGuestHost: typeof import('../src/federation/guestHost.js').createGuestHost;
let issueIdentityToken: typeof import('../src/federation/identityToken.js').issueIdentityToken;
let getLink: typeof import('../src/federation/links.js').getLink;

before(async () => {
  t = await createTestDb();
  ({ fedAudit, recentAudit, pruneAudit, AUDIT_KEEP_MS } = await import('../src/federation/auditLog.js'));
  ({ markTrustLost } = await import('../src/federation/trustLoss.js'));
  ({ revocationsSince } = await import('../src/federation/guestRevocation.js'));
  ({ reconcileMemberships } = await import('../src/federation/guestMembership.js'));
  ({ createGuestHost } = await import('../src/federation/guestHost.js'));
  ({ issueIdentityToken } = await import('../src/federation/identityToken.js'));
  ({ getLink } = await import('../src/federation/links.js'));
});
beforeEach(async () => truncateAll(t.raw));
after(async () => {
  (await import('../src/realtime.js')).redisPub.disconnect();
  await t.close();
});

const linkSql = (id: string, state: string) => `
  INSERT INTO federation_links
    (instance_id, domain, api_base, client_origin, root_key, state, protocol_version, features)
  VALUES ('${id}', '${id}.example', 'https://${id}.example', 'https://${id}.example', 'root', '${state}', 1, '[]')
`;

const pair = generateKeyPairSync('ed25519');
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' });

function guestHost() {
  return createGuestHost({
    identity: () => ({ instanceId: 'host' }),
    getLink,
    readMeta: async () => ({ paused: false }),
    lookupKey: async () => publicKey,
    seenJti: async () => false,
    banned: async () => false,
    refreshAvatar: () => {},
  });
}

function identityToken(sub: string, now: number): string {
  return issueIdentityToken({
    claims: { iss: 'peer', sub, aud: 'host', gen: 0, username: sub, displayName: sub, avatarHash: null },
    kid: 'root', privateKeyDer: privateKey, now,
  }).token;
}

async function waitForAudit(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const row = await t.raw.query<{ n: number }>('SELECT count(*)::int AS n FROM federation_audit');
    if ((row.rows[0]?.n ?? 0) > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('асинхронная запись аудита не завершилась');
}

test('журнал федерации выделяет адресата и автора, сортируется и чистит только старое', async () => {
  // Ловит журнал, который формально пишется, но не позволяет восстановить кто и с какой связкой действовал.
  fedAudit('x'.repeat(80), { instanceId: 'peer-a', issuedBy: 'Маша', keep: 7 });
  await waitForAudit();
  const rows = await recentAudit();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.event, 'x'.repeat(64));
  assert.equal(rows[0]?.instanceId, 'peer-a');
  assert.equal(rows[0]?.actorId, 'Маша');
  assert.equal(rows[0]?.detail.keep, 7);
  const now = Date.now();
  await t.raw.exec(`
    UPDATE federation_audit SET at = '${new Date(now - AUDIT_KEEP_MS).toISOString()}' WHERE id = '${rows[0]?.id}';
    INSERT INTO federation_audit (id, event, at, detail) VALUES
      ('older', 'old', '${new Date(now - AUDIT_KEEP_MS - 1).toISOString()}', '{}'),
      ('newer', 'new', '${new Date(now).toISOString()}', '{}')
  `);
  assert.equal(await pruneAudit(now), 1);
  assert.deepEqual((await recentAudit()).map((x) => x.event), ['new', 'x'.repeat(64)]);
});

test('потеря доверия замораживает гостей, но не переписывает ручную блокировку', async () => {
  // Ловит продолжение гостевой сессии по скомпрометированному ключу и стирание решения держателя.
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES ('owner', 'owner', 'Owner', 'hash');
    INSERT INTO users (id, username, display_name, password_hash, home_instance_id, home_user_id)
      VALUES ('guest', 'guest@peer', 'Guest', 'hash', 'peer', 'home-user');
    INSERT INTO servers (id, name, owner_id, federated_access) VALUES ('server', 'Server', 'owner', true);
    INSERT INTO server_members (server_id, user_id, state) VALUES ('server', 'guest', 'active');
    ${linkSql('peer', 'active')};
    ${linkSql('blocked', 'blocked')}
  `);
  (await import('../src/realtime.js')).redisPub.disconnect();
  assert.equal(await markTrustLost('peer', 'другая личность'), true);
  assert.equal(await markTrustLost('blocked', 'не должно менять'), false);
  const links = await t.raw.query<{ instance_id: string; state: string }>('SELECT instance_id, state FROM federation_links ORDER BY instance_id');
  assert.deepEqual(links.rows, [{ instance_id: 'blocked', state: 'blocked' }, { instance_id: 'peer', state: 'trust-lost' }]);
  const member = await t.raw.query<{ state: string }>("SELECT state FROM server_members WHERE user_id = 'guest'");
  assert.equal(member.rows[0]?.state, 'closed_by_host');
  await waitForAudit();
});

test('выгрузка отзывов отдаёт только записи адресованного хоста', async () => {
  // Ловит утечку чужих отзывов и применение удаления сессий не тем соседом.
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES ('local', 'local', 'Local', 'hash');
    INSERT INTO federation_revocations (id, user_id, kind, created_at, instance_id) VALUES
      ('a1', 'local', 'sessions', 100, 'peer-a'),
      ('a2', 'local', 'account', 101, 'peer-a'),
      ('b1', 'local', 'sessions', 99, 'peer-b')
  `);
  const rows = await revocationsSince(null, null, 500, 'peer-a');
  assert.deepEqual(rows.map((x) => x.id), ['a1', 'a2']);
});

test('полная сверка не стирает надгробие запрета, но убирает обычное исчезнувшее членство', async () => {
  // Ловит исчезновение единственного объяснения «почему сервер пропал» после фоновой сверки.
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES ('local', 'local', 'Local', 'hash');
    INSERT INTO federation_memberships
      (instance_id, user_id, server_id, server_name, state, reason, updated_at)
    VALUES
      ('peer', 'local', 'active-gone', 'Gone', 'active', null, 10),
      ('peer', 'local', 'ban-tombstone', 'Closed', 'removed', 'banned_by_instance', 11)
  `);
  assert.deepEqual(await reconcileMemberships('peer', [], 20), { added: 0, removed: 1 });
  const rows = await t.raw.query<{ server_id: string; state: string; reason: string | null }>(
    'SELECT server_id, state, reason FROM federation_memberships ORDER BY server_id',
  );
  assert.deepEqual(rows.rows, [{ server_id: 'ban-tombstone', state: 'removed', reason: 'banned_by_instance' }]);
});

test('ровно до 2000 живых теневых строк вход разрешён, следующая отклоняется, удалённая не считается', async () => {
  // Ловит off-by-one и пожизненное заполнение квоты обезличенными аккаунтами прошлых лет.
  await t.raw.exec(`
    ${linkSql('peer', 'active')};
    INSERT INTO users (id, username, display_name, password_hash, home_instance_id, home_user_id, created_at)
    SELECT 'guest-' || i, 'guest-' || i, 'Guest', 'hash', 'peer', 'home-' || i, now() - interval '2 days'
    FROM generate_series(1, 1999) AS i;
    INSERT INTO users (id, username, display_name, password_hash, home_instance_id, home_user_id, created_at, deleted_at)
    VALUES ('old-deleted', 'old-deleted', 'Deleted', 'hash', 'peer', 'old-deleted', now() - interval '2 days', now())
  `);
  const now = Date.now();
  const accepted = await guestHost().acceptIdentity({ token: identityToken('edge', now), now });
  assert.equal(accepted.ok, true);
  const refused = await guestHost().acceptIdentity({ token: identityToken('over', now + 1), now: now + 1 });
  assert.deepEqual(refused, { ok: false, status: 403, error: 'federation.quota_exceeded', detail: 'shadow-limit' });
});

test('500 новых теневых строк за сутки закрывают следующую, даже если все уже обезличены', async () => {
  // Ловит обход суточного предела циклом «создать → удалить → создать».
  await t.raw.exec(`
    ${linkSql('peer', 'active')};
    INSERT INTO users (id, username, display_name, password_hash, home_instance_id, home_user_id, created_at, deleted_at)
    SELECT 'fresh-' || i, 'fresh-' || i, 'Fresh', 'hash', 'peer', 'fresh-home-' || i, now(), now()
    FROM generate_series(1, 500) AS i
  `);
  const now = Date.now();
  const refused = await guestHost().acceptIdentity({ token: identityToken('daily-over', now), now });
  assert.deepEqual(refused, { ok: false, status: 403, error: 'federation.quota_exceeded', detail: 'shadow-limit-day' });
});
