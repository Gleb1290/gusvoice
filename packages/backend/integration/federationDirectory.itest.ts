import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
let cache: typeof import('../src/federation/directoryCache.js');
let feed: typeof import('../src/federation/directoryFeed.js');
let avatars: typeof import('../src/federation/avatars.js');

before(async () => {
  t = await createTestDb();
  cache = await import('../src/federation/directoryCache.js');
  feed = await import('../src/federation/directoryFeed.js');
  avatars = await import('../src/federation/avatars.js');
});
beforeEach(async () => truncateAll(t.raw));
after(async () => {
  // `avatars.ts` тянет rate-limit с общим Redis-клиентом; в тесте сети нет, поэтому не оставляем его ретраи держать процесс.
  const { redisPub } = await import('../src/realtime.js');
  redisPub.disconnect();
  await t.close();
});

test('кеш отвергает опоздавший профиль и сохраняет уже скачанный аватар', async () => {
  // Ловит откат имени старым событием и повторную загрузку картинки после несвязанной смены профиля.
  assert.deepEqual(await cache.applyDirectoryEntries('peer', [{
    userId: 'u', updatedAt: 5_000, username: 'fresh', displayName: 'Свежий', avatarHash: 'h1',
  }]), { upserted: 1, removed: 0, stale: 0 });
  await t.raw.exec(`
    UPDATE federation_peer_users SET avatar_local_url = '/cached.png', avatar_cached_hash = 'h1'
    WHERE instance_id = 'peer' AND user_id = 'u'
  `);
  assert.deepEqual(await cache.applyDirectoryEntries('peer', [{
    userId: 'u', updatedAt: 1_000, username: 'stale', displayName: 'Старый', avatarHash: 'old',
  }]), { upserted: 0, removed: 0, stale: 1 });
  assert.deepEqual(await cache.applyDirectoryEntries('peer', [{
    userId: 'u', updatedAt: 6_000, username: 'renamed', displayName: 'Новое имя', avatarHash: 'h2',
  }]), { upserted: 1, removed: 0, stale: 0 });
  const row = await t.raw.query<{ username: string; avatar_local_url: string; avatar_cached_hash: string; avatar_hash: string }>(
    `SELECT username, avatar_local_url, avatar_cached_hash, avatar_hash FROM federation_peer_users WHERE instance_id = 'peer'`,
  );
  assert.deepEqual(row.rows[0], {
    username: 'renamed', avatar_local_url: '/cached.png', avatar_cached_hash: 'h1', avatar_hash: 'h2',
  });
});

test('CAS аватара не перезаписывает изменившийся хеш или URL и не очищает чужую копию', async () => {
  // Ловит удаление или замену победившего файла медленной загрузкой по устаревшему чтению строки.
  await t.raw.exec(`
    INSERT INTO federation_peer_users
      (instance_id, user_id, username, display_name, avatar_hash, avatar_local_url, avatar_cached_hash, updated_at)
    VALUES ('peer', 'u', 'masha', 'Маша', 'h1', '/old.png', 'h1', 1)
  `);
  await t.raw.exec(`UPDATE federation_peer_users SET avatar_hash = 'h2' WHERE instance_id = 'peer' AND user_id = 'u'`);
  assert.equal(await avatars.peerCopyStore.swap('peer', 'u', { url: '/late.png', hash: 'h1' }, { hash: 'h1', url: '/old.png' }), false);
  await t.raw.exec(`UPDATE federation_peer_users SET avatar_hash = 'h1', avatar_local_url = '/winner.png' WHERE instance_id = 'peer' AND user_id = 'u'`);
  assert.equal(await avatars.peerCopyStore.swap('peer', 'u', { url: '/late.png', hash: 'h1' }, { hash: 'h1', url: '/old.png' }), false);
  assert.equal(await avatars.peerCopyStore.clear('peer', 'u', '/old.png'), false);
  const row = await avatars.peerCopyStore.read('peer', 'u');
  assert.equal(row?.avatarLocalUrl, '/winner.png');
});

test('CAS гостевого аватара не заменяет и не очищает ссылку, сменившуюся за время загрузки', async () => {
  // Ловит возврат старого домашнего лица поверх более свежей копии гостя.
  await t.raw.exec(`
    INSERT INTO users
      (id, username, display_name, password_hash, avatar_url, home_avatar_hash, home_instance_id, home_user_id)
    VALUES ('shadow', 'masha@peer', 'Маша', 'hash', '/old.png', 'old-hash', 'peer', 'home-user')
  `);
  await t.raw.exec(`UPDATE users SET avatar_url = '/winner.png', home_avatar_hash = 'winner-hash' WHERE id = 'shadow'`);
  assert.equal(await avatars.guestCopyStore.swap('shadow', { url: '/late.png', hash: 'late-hash' }, '/old.png'), false);
  assert.equal(await avatars.guestCopyStore.clear('shadow', '/old.png'), false);
  assert.equal(await avatars.guestCopyStore.current('shadow'), '/winner.png');
});

test('надгробие, полная сверка и забывание действуют только внутри своей связки', async () => {
  // Ловит падение на неизвестном надгробии и очистку одноимённых строк другого соседа.
  for (const peer of ['a', 'b']) {
    await cache.applyDirectoryEntries(peer, [
      { userId: 'same', updatedAt: 1, username: `${peer}-same`, displayName: 'Same', avatarHash: null },
      { userId: 'extra', updatedAt: 1, username: `${peer}-extra`, displayName: 'Extra', avatarHash: null },
    ]);
  }
  assert.deepEqual(await cache.applyDirectoryEntries('a', [
    { userId: 'missing', updatedAt: 2, removed: 'deleted' },
    { userId: 'same', updatedAt: 2, removed: 'hidden' },
  ]), { upserted: 0, removed: 2, stale: 0 });
  assert.equal(await cache.reconcileDirectory('a', []), 1);
  assert.deepEqual((await cache.peerUsers('b')).map((row) => row.userId), ['extra', 'same']);
  await cache.forgetPeerCache('a');
  assert.equal((await cache.peerUsers('b')).length, 2);
});

test('одинаковое время правки не теряет и не дублирует людей на границе страниц, а гости не утекают', async () => {
  // Ловит курсор только по времени и повторную передачу людей третьего инстанса через нас.
  await t.raw.exec(`
    INSERT INTO users
      (id, username, display_name, password_hash, verified, approved_at, directory_updated_at, home_instance_id, home_user_id)
    VALUES
      ('a', 'alpha', 'Alpha', 'hash', true, now(), '2026-09-16T12:00:00Z', null, null),
      ('b', 'bravo', 'Bravo', 'hash', true, now(), '2026-09-16T12:00:00Z', null, null),
      ('c', 'charlie', 'Charlie', 'hash', true, now(), '2026-09-16T12:00:00Z', null, null),
      ('guest', 'u@third', 'Guest', 'hash', true, now(), '2026-09-16T12:00:00Z', 'third', 'u')
  `);
  const first = await feed.directoryPageFor('self', { since: null, after: null, limit: 2 }, 1);
  assert.deepEqual(first.entries.map((entry) => entry.userId), ['a', 'b']);
  assert.ok(first.nextCursor);
  const { decodeCursor } = await import('../src/federation/directoryRules.js');
  const second = await feed.directoryPageFor('self', { since: null, after: decodeCursor(first.nextCursor), limit: 2 }, 1);
  assert.deepEqual(second.entries.map((entry) => entry.userId), ['c']);
  assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.entries, ...second.entries].map((entry) => entry.userId), ['a', 'b', 'c']);
});

test('полная выдача серверов показывает только открытые, а дельта несёт закрытия и исключения по связке', async () => {
  // Ловит вечный «открытый» сервер после снятия галочки и применение исключения ко всем соседям.
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES
      ('owner', 'owner', 'Owner', 'hash'), ('member', 'member', 'Member', 'hash');
    INSERT INTO servers (id, name, owner_id, federated_access, directory_updated_at) VALUES
      ('open', 'Open', 'owner', true, '2026-09-16T12:00:00Z'),
      ('closed', 'Closed', 'owner', false, '2026-09-16T12:00:01Z'),
      ('excepted', 'Excepted', 'owner', true, '2026-09-16T12:00:02Z');
    INSERT INTO server_members (server_id, user_id) VALUES ('open', 'owner'), ('open', 'member');
    INSERT INTO server_federation_exclusions (server_id, instance_id) VALUES ('excepted', 'peer-a')
  `);
  const fullA = await feed.serverPageFor('self', 'peer-a', { since: null, after: null, limit: 10 }, 1);
  assert.deepEqual(fullA.servers.map((server) => [server.serverId, server.members]), [['open', 2]]);
  const fullB = await feed.serverPageFor('self', 'peer-b', { since: null, after: null, limit: 10 }, 1);
  assert.deepEqual(fullB.servers.map((server) => server.serverId), ['open', 'excepted']);
  const deltaA = await feed.serverPageFor('self', 'peer-a', { since: 0, after: null, limit: 10 }, 1);
  assert.deepEqual(deltaA.servers.map((server) => [server.serverId, server.removed ?? false]), [
    ['open', false], ['closed', true], ['excepted', true],
  ]);
});
