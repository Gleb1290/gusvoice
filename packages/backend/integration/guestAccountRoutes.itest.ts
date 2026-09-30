import assert from 'node:assert/strict';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { after, before, beforeEach, test } from 'node:test';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
let app: ReturnType<typeof Fastify>;
let tokenFor: (id: string) => string;
let redisPub: typeof import('../src/realtime.js').redisPub;

before(async () => {
  t = await createTestDb();
  const auth = await import('../src/auth.js');
  const { authRoutes } = await import('../src/routes/auth.js');
  const { userRoutes } = await import('../src/routes/users.js');
  ({ redisPub } = await import('../src/realtime.js'));
  // Маршрут профиля рассылает self.status в фоне; интеграции guard сеть Redis не нужна.
  redisPub.publish = (async () => 0) as typeof redisPub.publish;
  tokenFor = (id) => auth.signToken({ sub: id, username: id === 'guest' ? 'masha@peer' : 'petya', gen: 0 });
  app = Fastify();
  await app.register(multipart, { limits: { fileSize: 1024, files: 1 } });
  await app.register(userRoutes);
  await app.register(authRoutes);
  await app.ready();
});

beforeEach(async () => {
  await truncateAll(t.raw);
  await t.raw.exec(`
    INSERT INTO users
      (id, username, display_name, password_hash, verified, show_game_activity, animated_avatar_url,
       home_instance_id, home_user_id)
    VALUES
      ('local', 'petya', 'Петя', 'hash', true, true, '/media/local.gif', null, null),
      ('guest', 'masha@peer', 'Маша', 'hash', true, true, '/media/guest.gif', 'peer', 'home-user')
  `);
});

after(async () => {
  await app.close();
  redisPub.disconnect();
  await t.close();
});

const authHeader = (id: string) => ({ authorization: `Bearer ${tokenFor(id)}` });

test('гость не меняет имя, но может выключить показ своей игры', async () => {
  // Ловит как захват домашнего имени на хосте, так и чрезмерный запрет гостю управлять приватностью.
  const rename = await app.inject({
    method: 'PATCH', url: '/users/me', headers: authHeader('guest'), payload: { displayName: 'Петя' },
  });
  assert.equal(rename.statusCode, 403);
  assert.deepEqual(rename.json(), { error: 'federation.guest_forbidden' });

  const privacy = await app.inject({
    method: 'PATCH', url: '/users/me', headers: authHeader('guest'), payload: { showGameActivity: false },
  });
  assert.equal(privacy.statusCode, 200);
  const row = await t.raw.query<{ show_game_activity: boolean }>(`SELECT show_game_activity FROM users WHERE id = 'guest'`);
  assert.equal(row.rows[0]?.show_game_activity, false);
});

test('все маршруты пароля, почты, удаления и 2FA отсекают гостя до разбора тела', async () => {
  // Ловит забытый preHandler на одной из ручек теневого аккаунта без настоящего пароля и почты.
  const paths = [
    '/auth/password',
    '/auth/email',
    '/auth/delete',
    '/auth/2fa/setup',
    '/auth/2fa/enable',
    '/auth/2fa/disable',
    '/auth/2fa/backup/regenerate',
  ];
  for (const url of paths) {
    const response = await app.inject({ method: 'POST', url, headers: authHeader('guest'), payload: {} });
    assert.equal(response.statusCode, 403, url);
    assert.deepEqual(response.json(), { error: 'federation.guest_forbidden' }, url);
  }

  // Парный принимаемый случай доказывает, что реальная DB-проверка отличает местную строку.
  const local = await app.inject({ method: 'POST', url: '/auth/2fa/setup', headers: authHeader('local'), payload: {} });
  assert.equal(local.statusCode, 200);
});

test('оба маршрута загрузки аватара отсекают гостя до multipart и хранилища', async () => {
  // Ловит запись гостевого файла мимо квоты связки через обычный пользовательский upload.
  for (const url of ['/users/me/avatar', '/users/me/avatar/animated']) {
    const response = await app.inject({ method: 'POST', url, headers: authHeader('guest') });
    assert.equal(response.statusCode, 403, url);
    assert.deepEqual(response.json(), { error: 'federation.guest_forbidden' }, url);
  }
});

test('снять анимированный аватар может местный, но не гость', async () => {
  // Ловит единственную аватарную ручку без requireLocalUser: гость менял домашний профиль на хосте.
  const guest = await app.inject({
    method: 'DELETE', url: '/users/me/avatar/animated', headers: authHeader('guest'),
  });
  assert.equal(guest.statusCode, 403);
  assert.deepEqual(guest.json(), { error: 'federation.guest_forbidden' });
  let rows = await t.raw.query<{ id: string; animated_avatar_url: string | null }>(
    `SELECT id, animated_avatar_url FROM users ORDER BY id`,
  );
  assert.deepEqual(rows.rows, [
    { id: 'guest', animated_avatar_url: '/media/guest.gif' },
    { id: 'local', animated_avatar_url: '/media/local.gif' },
  ]);

  const local = await app.inject({
    method: 'DELETE', url: '/users/me/avatar/animated', headers: authHeader('local'),
  });
  assert.equal(local.statusCode, 200);
  rows = await t.raw.query<{ id: string; animated_avatar_url: string | null }>(
    `SELECT id, animated_avatar_url FROM users ORDER BY id`,
  );
  assert.deepEqual(rows.rows, [
    { id: 'guest', animated_avatar_url: '/media/guest.gif' },
    { id: 'local', animated_avatar_url: null },
  ]);
});
