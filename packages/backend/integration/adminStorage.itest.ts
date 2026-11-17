import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import Fastify from 'fastify';
import type { BucketItem } from 'minio';
import { createStorageReportReader, type StorageReport } from '../src/adminStorageReport.js';
import { createTestDb, type TestDb } from './harness.js';

const serverId = '10000000-0000-4000-8000-000000000001';
const otherServerId = '10000000-0000-4000-8000-000000000002';
const channelId = '20000000-0000-4000-8000-000000000001';
const clipId = '30000000-0000-4000-8000-000000000001';
const otherClipId = '30000000-0000-4000-8000-000000000002';
const publicOrigin = 'https://media.invalid/prefix';
const publicBucket = 'report-public';
const privateBucket = 'report-private';
const media = (key: string) => `${publicOrigin}/${publicBucket}/${key}`;
const clipKey = `sounds/${serverId}-sb-${clipId}-1.ogg`;
const orphanClipKey = `sounds/${serverId}-sb-${otherClipId}-1.ogg`;
const object = (name: string, size: number): BucketItem => ({ name, size, etag: 'fixture', lastModified: new Date(0) });
const bucketMissing = () => Object.assign(new Error('missing bucket'), { code: 'NoSuchBucket' });

let db: TestDb;
let auth: typeof import('../src/auth.js');
let env: typeof import('../src/env.js').env;
let minio: NonNullable<typeof import('../src/storage.js').minio>;
let routes: typeof import('../src/routes/adminStorage.js');
let storage: typeof import('../src/storage.js');

before(async () => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://127.0.0.1:1/unused',
    JWT_SECRET: 'not-a-secret-used-only-by-integration-tests',
    LIVEKIT_API_KEY: 'integration-test-key',
    LIVEKIT_API_SECRET: 'not-a-secret-used-only-by-integration-tests',
    LIVEKIT_URL_EXTERNAL: 'wss://livekit.invalid',
    MINIO_ENDPOINT: 'media.invalid',
    MINIO_ACCESS_KEY: 'fixture-storage-user',
    MINIO_SECRET_KEY: 'fixture-storage-password',
    MINIO_BUCKET: publicBucket,
    MINIO_PRIVATE_BUCKET: privateBucket,
    MINIO_PUBLIC_URL: publicOrigin,
    PUBLIC_API_URL: 'https://api.invalid',
  });
  db = await createTestDb({ cold: true });
  auth = await import('../src/auth.js');
  ({ env } = await import('../src/env.js'));
  storage = await import('../src/storage.js');
  assert.ok(storage.minio);
  minio = storage.minio;
  routes = await import('../src/routes/adminStorage.js');

  await db.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES
      ('admin', 'holder', 'Автор', 'fixture'), ('ordinary', 'admin', 'Участник', 'fixture');
    INSERT INTO servers (id, name, owner_id) VALUES
      ('${serverId}', 'Первый', 'admin'), ('${otherServerId}', 'Второй', 'ordinary');
    INSERT INTO channels (id, server_id, name, type) VALUES
      ('${channelId}', '${serverId}', 'Общий', 'text'), ('second-channel', '${otherServerId}', 'Общий', 'text');
    INSERT INTO server_soundboard (id, server_id, name, url, created_by) VALUES
      ('${clipId}', '${serverId}', 'Звук', '${media(clipKey)}', 'admin'),
      ('duplicate-reference', '${serverId}', 'Тот же объект', '${media(clipKey)}?v=2', NULL),
      ('missing-clip', '${otherServerId}', 'Пропавший файл', '${media('legacy/absent.ogg')}', 'ordinary');
    INSERT INTO server_sounds (server_id, event, url) VALUES
      ('${serverId}', 'join', '${media('legacy/join.ogg')}');
    INSERT INTO channel_sounds (channel_id, event, url) VALUES
      ('${channelId}', 'join', '${media('legacy/join.ogg')}');
    INSERT INTO server_economy (server_id, icon_url) VALUES
      ('${serverId}', '${media('legacy/coin.png')}');
    INSERT INTO sticker_packs (id, server_id, name, title) VALUES
      ('server-pack', '${serverId}', 'server', 'Сервер'), ('instance-pack', NULL, 'global', 'Инстанс');
    INSERT INTO stickers (id, pack_id, url, format) VALUES
      ('server-sticker', 'server-pack', '${media('stickers/server.webp')}', 'webp'),
      ('global-sticker', 'instance-pack', '${media('stickers/global.webp')}', 'webp');
    INSERT INTO messages (id, channel_id, author_id, content, attachments, sticker) VALUES
      ('first', '${channelId}', 'admin', '', '[
        {"url":"${media('attachments/channel.png')}","size":9000},
        {"url":"${media('attachments/channel.png')}?v=1","size":9000},
        {"url":"${media('attachments/shared.png')}"}
      ]', '{"url":"${media('stickers/server.webp')}"}'),
      ('second', 'second-channel', 'ordinary', '', '[{"url":"${media('attachments/shared.png')}"}]', NULL);
    INSERT INTO conversations (id, kind) VALUES ('conversation', 'group');
    INSERT INTO conversation_members (conversation_id, user_id) VALUES ('conversation', 'admin');
    INSERT INTO attachments (id, conversation_id, owner_id, storage_key, name, content_type, size)
      VALUES ('legacy-private', 'conversation', 'admin', 'old/files/1', 'file', 'text/plain', 9000);
    INSERT INTO conversation_messages (id, conversation_id, author_id, sort_key, attachments) VALUES
      ('dm', 'conversation', 'admin', 1, '[{"url":"${media('attachments/dm.png')}","size":9000}]');
  `);
  auth.setSuperAdminId('admin');
});
after(async () => { await db?.close(); });

function appForTest(t: { after: (fn: () => Promise<void>) => void }) {
  const app = Fastify();
  app.register(routes.adminStorageRoutes);
  t.after(() => app.close());
  return app;
}

const bearer = (sub = 'admin') => ({ authorization: `Bearer ${auth.signToken({ sub, username: 'admin', gen: 0 })}` });

it('только супер-админ может начать замер', async t => {
  const listing = t.mock.method(minio, 'listObjectsV2Query', async () => {
    throw new Error('замер не должен запускаться');
  });
  const app = appForTest(t);
  assert.equal((await app.inject('/admin/storage')).statusCode, 401);
  assert.equal((await app.inject({ url: '/admin/storage', headers: bearer('ordinary') })).statusCode, 403);
  assert.equal(listing.mock.callCount(), 0);
});

it('маршрут на мигрированной базе считает фактические байты обоих бакетов и берёт все страницы', async t => {
  const pages = t.mock.method(minio, 'listObjectsV2Query', async (bucket: string, _prefix: string, token: string) => {
    if (bucket === privateBucket) return { objects: [
      object('dm/orphan', 23), object('old/files/1', 29), object('attachments/channel.png', 31),
    ], isTruncated: false };
    assert.equal(bucket, publicBucket);
    if (!token) return { objects: [
      object(clipKey, 10), object(orphanClipKey, 11), object('legacy/join.ogg', 12),
      object(`sounds/ch-${channelId}-leave-1.wav`, 13), object('legacy/coin.png', 14),
    ], isTruncated: true, nextContinuationToken: 'page-2' };
    assert.equal(token, 'page-2');
    return { objects: [
      object('stickers/server.webp', 15), object('stickers/global.webp', 16),
      object('attachments/channel.png', 17), object('attachments/shared.png', 18),
      object('attachments/deleted.png', 19), object('attachments/dm.png', 20), object('avatars/old.png', 21),
      object(`server-icons/${serverId}-1.png`, 22), object(clipKey, 10),
    ], isTruncated: false };
  });
  const app = appForTest(t);
  const request = { url: '/admin/storage', headers: bearer() };
  const response = await app.inject(request);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  const report = response.json<StorageReport>();
  assert.ok(Number.isFinite(Date.parse(report.measuredAt)));
  assert.deepEqual(report.servers, [
    { id: serverId, name: 'Первый', totalBytes: 114, soundboardBytes: 21, eventSoundsBytes: 25,
      channelAttachmentsBytes: 17, appearanceBytes: 51, soundboardClips: 2, soundboardAuthors: [
        { userId: 'admin', name: 'Автор', clips: 1, bytes: 10 },
        { userId: null, name: null, clips: 1, bytes: 11 },
      ] },
    { id: otherServerId, name: 'Второй', totalBytes: 0, soundboardBytes: 0, eventSoundsBytes: 0,
      channelAttachmentsBytes: 0, appearanceBytes: 0, soundboardClips: 1, soundboardAuthors: [
        { userId: 'ordinary', name: 'Участник', clips: 1, bytes: 0 },
      ] },
  ]);
  assert.deepEqual(report.instance, { directMessagesBytes: 72, avatarsBytes: 21, unassignedBytes: 84, totalBytes: 177 });
  assert.equal(report.totalBytes, 291);
  assert.deepEqual((await app.inject(request)).json(), report);
  assert.equal(pages.mock.callCount(), 3);
});

it('ошибка поздней страницы закрытого бакета даёт 503 без частичных цифр', async t => {
  t.mock.method(minio, 'listObjectsV2Query', async (bucket: string, _prefix: string, token: string) => {
    if (bucket === publicBucket) return { objects: [object(clipKey, 2)], isTruncated: false };
    if (!token) return { objects: [object('dm/one', 3)], isTruncated: true, nextContinuationToken: 'next' };
    throw new Error('late storage failure');
  });
  const app = appForTest(t);
  const response = await app.inject({ url: '/admin/storage', headers: bearer() });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().measuredAt, null);
  assert.ok(response.json().error);
});

it('отсутствующий private-бакет пропускается только без публичного API и при точном NoSuchBucket', async t => {
  const original = env.publicApiUrl;
  t.after(() => { env.publicApiUrl = original; });
  let failure = bucketMissing();
  t.mock.method(minio, 'listObjectsV2Query', async (bucket: string) => {
    if (bucket === privateBucket) throw failure;
    return { objects: [object('avatars/first.png', 2)], isTruncated: false };
  });
  const request = { url: '/admin/storage', headers: bearer() };
  assert.equal((await appForTest(t).inject(request)).statusCode, 503);
  env.publicApiUrl = '';
  const disabled = await appForTest(t).inject(request);
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json<StorageReport>().totalBytes, 2);
  failure = Object.assign(new Error('denied'), { code: 'AccessDenied' });
  assert.equal((await appForTest(t).inject(request)).statusCode, 503);
});

it('удаление пропускает чужие ключи и пробрасывает сбой удаления своего клипа', async t => {
  const failure = new Error('storage unavailable');
  const removed = t.mock.method(minio, 'removeObject', async () => { throw failure; });
  for (const url of [
    media(orphanClipKey), media(clipKey.replace(serverId, otherServerId)),
    media(`sounds/${serverId}-join-1.ogg`), media(clipKey).replace(publicBucket, privateBucket),
    media(clipKey).replace('media.invalid', 'other.invalid'), media(clipKey + '/extra'),
    media('sounds/%C0%AF'),
  ]) {
    await storage.removeSoundboardObject(serverId, clipId, url);
  }
  assert.equal(removed.mock.callCount(), 0);
  await assert.rejects(storage.removeSoundboardObject(serverId, clipId, media(clipKey)), error => error === failure);
  assert.deepEqual(removed.mock.calls.map(call => call.arguments), [[publicBucket, clipKey]]);
  const success = t.mock.method(minio, 'removeObject', async () => {});
  await storage.removeSoundboardObject(serverId, clipId, media(clipKey));
  assert.equal(success.mock.callCount(), 1);
});

it('одновременные запросы ждут общий снимок, а после ошибки возможен повтор', async () => {
  let now = 0;
  let calls = 0;
  const failure = new Error('first measurement failed');
  const sample: StorageReport = {
    measuredAt: new Date(5_001).toISOString(), servers: [],
    instance: { avatarsBytes: 0, directMessagesBytes: 0, unassignedBytes: 0, totalBytes: 0 }, totalBytes: 0,
  };
  const read = createStorageReportReader(async () => {
    if (++calls === 1) throw failure;
    return sample;
  }, () => now);
  const first = read();
  assert.equal(read(), first);
  await assert.rejects(first, failure);
  now = 4_999;
  await assert.rejects(read(), failure);
  assert.equal(calls, 1);
  now = 5_000;
  assert.equal(await read(), sample);
  now = 64_999;
  assert.equal(await read(), sample);
  assert.equal(calls, 2);
  now = 65_000;
  await read();
  assert.equal(calls, 3);
});
