import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { FED_ERRORS, Permission } from '@gusvoice/shared';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
let preview: typeof import('../src/federation/invitePreview.js');
let quota: typeof import('../src/federation/guestQuota.js');
let revocation: typeof import('../src/federation/guestRevocation.js');
let profile: typeof import('../src/federation/guestProfile.js');
let bans: typeof import('../src/federation/instanceBan.js');
let permissions: typeof import('../src/permissions.js');
let avatars: typeof import('../src/federation/avatars.js');

before(async () => {
  t = await createTestDb();
  preview = await import('../src/federation/invitePreview.js');
  quota = await import('../src/federation/guestQuota.js');
  revocation = await import('../src/federation/guestRevocation.js');
  profile = await import('../src/federation/guestProfile.js');
  bans = await import('../src/federation/instanceBan.js');
  permissions = await import('../src/permissions.js');
  avatars = await import('../src/federation/avatars.js');
});
beforeEach(async () => truncateAll(t.raw));
after(async () => {
  (await import('../src/realtime.js')).redisPub.disconnect();
  await t.close();
});

async function seedServer(): Promise<void> {
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash)
    VALUES ('owner', 'owner', 'Owner', 'hash'), ('local', 'local', 'Local', 'hash');
    INSERT INTO servers (id, name, owner_id, federated_access)
    VALUES ('server', 'Стая', 'owner', true);
    INSERT INTO server_members (server_id, user_id) VALUES ('server', 'owner'), ('server', 'local')
  `);
}

async function seedLink(instanceId: string, usedBytes = 0, quotaBytes = 100): Promise<void> {
  await t.raw.exec(`
    INSERT INTO federation_links
      (instance_id, domain, api_base, client_origin, root_key, state, used_bytes, quota_bytes)
    VALUES
      ('${instanceId}', '${instanceId}.example', 'https://${instanceId}.example/api',
       'https://${instanceId}.example', 'root', 'active', ${usedBytes}, ${quotaBytes})
  `);
}

test('предпросмотр отдаёт полную карточку действующей ссылки, а отказ — только код без данных сервера', async () => {
  // Ловит превращение перебора шестизначных кодов в разведку имён закрытых серверов.
  await seedServer();
  await t.raw.exec(`
    INSERT INTO invites (code, server_id, inviter_id, expires_at)
    VALUES
      ('OPEN01', 'server', 'owner', '2030-01-01T00:00:00Z'),
      ('FOREVER', 'server', 'owner', NULL)
  `);
  const ok = await preview.previewForPeer({ code: 'OPEN01', peerInstanceId: 'peer', now: 1_800_000_000_000 });
  assert.deepEqual(ok, {
    ok: true,
    preview: {
      code: 'OPEN01', serverId: 'server', serverName: 'Стая', iconHash: null, members: 2,
      expiresAt: Date.parse('2030-01-01T00:00:00Z'),
    },
  });
  assert.deepEqual(
    await preview.previewForPeer({ code: 'FOREVER', peerInstanceId: 'peer', now: 1_800_000_000_000 }),
    { ok: false, problem: FED_ERRORS.inviteNoExpiry },
  );
});

test('исключение закрывает одну и ту же ссылку только для указанной связки', async () => {
  // Ловит применение посерверного исключения ко всем соседям вместо одного.
  await seedServer();
  await t.raw.exec(`
    INSERT INTO invites (code, server_id, inviter_id, expires_at)
    VALUES ('INVITE', 'server', 'owner', '2030-01-01T00:00:00Z');
    INSERT INTO server_federation_exclusions (server_id, instance_id) VALUES ('server', 'peer-a')
  `);
  assert.deepEqual(
    await preview.previewForPeer({ code: 'INVITE', peerInstanceId: 'peer-a', now: 1_800_000_000_000 }),
    { ok: false, problem: FED_ERRORS.serverClosed },
  );
  assert.equal((await preview.previewForPeer({ code: 'INVITE', peerInstanceId: 'peer-b', now: 1_800_000_000_000 })).ok, true);
});

test('квота гостя из одной связки не касается местного и гостя другой связки', async () => {
  // Ловит общий счётчик хранилища, из-за которого один сосед блокировал бы загрузки всех остальных.
  await seedServer();
  await seedLink('peer-a', 90, 100);
  await seedLink('peer-b', 0, 0);
  await t.raw.exec(`
    INSERT INTO users
      (id, username, display_name, password_hash, home_instance_id, home_user_id)
    VALUES
      ('guest-a', 'a@peer-a', 'A', 'hash', 'peer-a', 'a'),
      ('guest-b', 'b@peer-b', 'B', 'hash', 'peer-b', 'b')
  `);
  // Проверка и занятие места слились в одну операцию (`reserveQuota`) — см. FROM-CLAUDE.md 16.09:
  // раздельные «проверить» и «прибавить» обходились двумя одновременными загрузками.
  assert.equal(await quota.reserveQuota('local', 1_000_000), null);
  // Не влезло — и место при этом НЕ занято: следующий вызов ровно на предел обязан пройти.
  assert.equal(await quota.reserveQuota('guest-a', 11), FED_ERRORS.quotaExceeded);
  assert.equal(await quota.reserveQuota('guest-a', 10), null);
  assert.equal(await quota.reserveQuota('guest-b', 1_000_000), null);
  await quota.releaseQuota('guest-a', 3);
  const rows = await t.raw.query<{ instance_id: string; used_bytes: number }>(
    `SELECT instance_id, used_bytes FROM federation_links ORDER BY instance_id`,
  );
  assert.deepEqual(rows.rows, [
    { instance_id: 'peer-a', used_bytes: 97 },
    { instance_id: 'peer-b', used_bytes: 1_000_000 },
  ]);
});

test('закрытое членство не даёт контекст, а роль «Гости» заменяет права everyone', async () => {
  // Ловит доступ закрытого гостя через забытый маршрут и невозможность сузить гостевые права.
  await seedServer();
  await t.raw.exec(`
    INSERT INTO users
      (id, username, display_name, password_hash, home_instance_id, home_user_id)
    VALUES
      ('guest-open', 'open@peer', 'Open', 'hash', 'peer', 'open'),
      ('guest-closed', 'closed@peer', 'Closed', 'hash', 'peer', 'closed');
    INSERT INTO server_members (server_id, user_id, state)
    VALUES ('server', 'guest-open', 'active'), ('server', 'guest-closed', 'closed_by_host');
    INSERT INTO roles (id, server_id, name, permissions, is_everyone)
    VALUES ('everyone', 'server', 'everyone', '${Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES}', true);
    INSERT INTO roles (id, server_id, name, permissions, is_guests)
    VALUES ('guests', 'server', 'guests', '${Permission.VIEW_CHANNEL}', true)
  `);
  const local = await permissions.getMemberContext('server', 'local');
  const guest = await permissions.getMemberContext('server', 'guest-open');
  assert.equal(local?.serverPermissions, Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES);
  assert.equal(guest?.serverPermissions, Permission.VIEW_CHANNEL);
  assert.deepEqual(guest?.roleIds, ['guests']);
  assert.equal(await permissions.getMemberContext('server', 'guest-closed'), null);
});

test('журнал отзывов выдаёт только записи строго новее курсора и держит стабильный порядок', async () => {
  // Ловит повтор старого отзыва либо пропуск двух отзывов с одинаковыми часами.
  await t.raw.exec(`
    INSERT INTO federation_revocations (id, user_id, kind, gen, created_at) VALUES
      ('b', 'u', 'sessions', 2, 1000),
      ('a', 'u', 'sessions', 1, 1000),
      ('c', 'u', 'revoked', NULL, 1001)
  `);
  assert.deepEqual((await revocation.revocationsSince(1000)).map((row) => row.id), ['c']);
  assert.deepEqual((await revocation.revocationsSince(null, null, 2)).map((row) => row.id), ['a', 'b']);
});

test('скрытие в каталоге не трогает гостя, а переименование обновляет ту же теневую строку', async () => {
  // Ловит обезличивание законного гостя по административному скрытию из каталога.
  await t.raw.exec(`
    INSERT INTO users
      (id, username, display_name, password_hash, home_instance_id, home_user_id, home_username)
    VALUES ('shadow', 'old@peer', 'Старое имя', 'hash', 'peer', 'home-u', 'old')
  `);
  assert.equal(await profile.applyGuestProfile('peer', {
    userId: 'home-u', updatedAt: 10, removed: 'hidden',
  }), false);
  assert.equal(await profile.applyGuestProfile('peer', {
    userId: 'home-u', updatedAt: 11, username: 'new', displayName: 'Новое имя', avatarHash: null,
  }), true);
  const row = await t.raw.query<{ id: string; display_name: string; home_username: string; deleted_at: Date | null }>(
    `SELECT id, display_name, home_username, deleted_at FROM users WHERE id = 'shadow'`,
  );
  assert.deepEqual(row.rows[0], {
    id: 'shadow', display_name: 'Новое имя', home_username: 'new', deleted_at: null,
  });
});

test('устаревшее поколение и незнакомый отзыв ничего не меняют', async () => {
  // Ловит оживление старых сессий после отката дома и создание теневой строки из одного отзыва.
  await t.raw.exec(`
    INSERT INTO users
      (id, username, display_name, password_hash, home_instance_id, home_user_id, home_gen, token_generation)
    VALUES ('shadow', 'u@peer', 'Guest', 'hash', 'peer', 'u', 7, 3)
  `);
  assert.equal(await revocation.applyRevocation({ instanceId: 'peer', homeUserId: 'u', gen: 6, account: false }), false);
  assert.equal(await revocation.applyRevocation({ instanceId: 'peer', homeUserId: 'missing', gen: 8, account: false }), false);
  const row = await t.raw.query<{ home_gen: number; token_generation: number }>(
    `SELECT home_gen, token_generation FROM users WHERE id = 'shadow'`,
  );
  assert.deepEqual(row.rows[0], { home_gen: 7, token_generation: 3 });
});

test('аватар теневого гостя не выдаётся соседям через наш инстанс', async () => {
  // Ловит ретрансляцию лица человека третьего инстанса через хост, где он всего лишь гость.
  await t.raw.exec(`
    INSERT INTO users
      (id, username, display_name, password_hash, avatar_url, verified, approved_at,
       home_instance_id, home_user_id)
    VALUES
      ('shadow', 'u@peer', 'Guest', 'hash', '/media/secret.png', true, now(), 'peer', 'u')
  `);
  assert.equal(await avatars.ownAvatarFor('shadow'), null);
});

test('запрет можно поставить до первого входа, а снятие оставляет журнал и повторный запрет его переиспользует', async () => {
  // Ловит привязку запрета к существованию теневой строки, которую повторный вход мог бы обойти.
  await t.raw.exec(`INSERT INTO users (id, username, display_name, password_hash) VALUES ('mod', 'mod', 'Mod', 'hash')`);
  assert.deepEqual(await bans.banInstanceUser({
    homeInstanceId: 'peer', homeUserId: 'never-seen', reason: 'spam', expiresAt: null, createdBy: 'mod',
  }), { servers: [] });
  assert.equal(await bans.instanceBanFor('peer', 'never-seen'), true);
  assert.equal(await bans.unbanInstanceUser('peer', 'never-seen', 'mod'), true);
  assert.equal(await bans.instanceBanFor('peer', 'never-seen'), false);
  await bans.banInstanceUser({
    homeInstanceId: 'peer', homeUserId: 'never-seen', reason: 'again', expiresAt: null, createdBy: 'mod',
  });
  const rows = await t.raw.query<{ reason: string; removed_at: Date | null }>(
    `SELECT reason, removed_at FROM instance_bans WHERE home_instance_id = 'peer' AND home_user_id = 'never-seen'`,
  );
  assert.deepEqual(rows.rows, [{ reason: 'again', removed_at: null }]);
});

test('удаление дома обезличивает гостя и снимает членства, но сохраняет строку и происхождение', async () => {
  // Ловит каскадное удаление истории либо потерю значка домашнего инстанса у старых сообщений.
  await seedServer();
  await t.raw.exec(`
    INSERT INTO users
      (id, username, email, display_name, password_hash, avatar_url, verified, approved_at,
       home_instance_id, home_user_id, home_username, home_gen, token_generation)
    VALUES
      ('shadow', 'u@peer', 'guest@example.test', 'Guest', 'hash', '/old.png', true, now(),
       'peer', 'home-u', 'u', 9, 4);
    INSERT INTO server_members (server_id, user_id, state) VALUES ('server', 'shadow', 'active')
  `);
  // В этом процессе Redis — только внешняя best-effort рассылка. Закрываем соединение, чтобы тест
  // проверял состояние базы, не ожидая несуществующий интеграционный Redis.
  (await import('../src/realtime.js')).redisPub.disconnect();
  assert.equal(await profile.applyGuestProfile('peer', {
    userId: 'home-u', updatedAt: 12, removed: 'deleted',
  }), true);
  const row = await t.raw.query<{
    id: string; email: string | null; avatar_url: string | null; deleted_at: Date | null;
    home_instance_id: string | null; home_user_id: string | null; token_generation: number;
  }>(`
    SELECT id, email, avatar_url, deleted_at, home_instance_id, home_user_id, token_generation
    FROM users WHERE id = 'shadow'
  `);
  assert.equal(row.rows[0]?.id, 'shadow');
  assert.equal(row.rows[0]?.email, null);
  assert.equal(row.rows[0]?.avatar_url, null);
  assert.ok(row.rows[0]?.deleted_at);
  assert.equal(row.rows[0]?.home_instance_id, 'peer');
  assert.equal(row.rows[0]?.home_user_id, 'home-u');
  assert.equal(row.rows[0]?.token_generation, 5);
  const member = await t.raw.query<{ state: string }>(
    `SELECT state FROM server_members WHERE server_id = 'server' AND user_id = 'shadow'`,
  );
  assert.deepEqual(member.rows, [{ state: 'removed' }]);
});
