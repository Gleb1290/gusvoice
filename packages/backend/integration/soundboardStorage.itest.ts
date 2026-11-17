import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { serverSoundboard, servers, soundboardCleanup, users } from '../src/db/schema.js';
import { projectSoundboard } from '../src/soundboardQuotaRules.js';
import { createTestDb, type TestDb } from './harness.js';

let database: TestDb;
let cleanup: typeof import('../src/soundboardCleanup.js');

before(async () => {
  process.env.MINIO_PUBLIC_URL = 'https://media.invalid';
  process.env.MINIO_BUCKET = 'test-media';
  database = await createTestDb();
  cleanup = await import('../src/soundboardCleanup.js');
  await database.db.insert(users).values({
    id: 'owner', username: 'owner', displayName: 'Владелец', passwordHash: 'fixture',
  });
  await database.db.insert(servers).values({ id: 'server', ownerId: 'owner', name: 'Сервер' });
});

after(async () => {
  await database?.close();
});

test('откат публикации сохраняет задание, после временного отказа файл удаляется повтором', async () => {
  const stamp = Date.now();
  const clipId = 'failed-upload';
  const url = `https://media.invalid/test-media/sounds/server-sb-${clipId}-${stamp}.wav`;
  await cleanup.scheduleSoundboardUploadCleanup('server', clipId, 'audio/wav', stamp);

  const uploadError = new Error('запись клипа откатилась');
  await assert.rejects(database.db.transaction(async (tx) => {
    await cleanup.lockSoundboardUpload(tx as unknown as Parameters<typeof cleanup.lockSoundboardUpload>[0], clipId);
    await tx.insert(serverSoundboard).values({ id: clipId, serverId: 'server', name: 'Звук', url, createdBy: 'owner' });
    throw uploadError;
  }), uploadError);
  assert.deepEqual(await database.db.select().from(serverSoundboard), []);

  const due = new Date(stamp + 300_000);
  const temporaryFailure = new Error('хранилище временно недоступно');
  const errors: unknown[] = [];
  const calls: string[][] = [];
  const remove = async (...args: [string, string, string]) => {
    calls.push(args);
    if (calls.length === 1) throw temporaryFailure;
  };
  const pass = (now: Date) => cleanup.runSoundboardCleanupJob(remove, (error) => errors.push(error), now);

  assert.equal(await pass(new Date(stamp)), false);
  assert.equal(await pass(due), true);
  assert.deepEqual(errors, [temporaryFailure]);
  assert.equal(await pass(due), false);
  assert.equal(await pass(new Date(due.getTime() + 5_000)), true);
  assert.deepEqual(calls, [['server', clipId, url], ['server', clipId, url]]);
  assert.deepEqual(await database.db.select().from(soundboardCleanup), []);
});

test('успешная публикация снимает уборку, а откат удаления сохраняет клип', async () => {
  const stamp = Date.now();
  const clipId = 'published';
  const url = `https://media.invalid/test-media/sounds/server-sb-${clipId}-${stamp}.wav`;
  await cleanup.scheduleSoundboardUploadCleanup('server', clipId, 'audio/wav', stamp);

  await database.db.transaction(async (tx) => {
    const uploadTx = tx as unknown as Parameters<typeof cleanup.lockSoundboardUpload>[0];
    await cleanup.lockSoundboardUpload(uploadTx, clipId);
    await tx.insert(serverSoundboard).values({ id: clipId, serverId: 'server', name: 'Звук', url, createdBy: 'owner' });
    await cleanup.finishSoundboardUpload(uploadTx, clipId);
  });

  const rollback = new Error('удаление отменено');
  await assert.rejects(database.db.transaction(async (tx) => {
    await tx.delete(serverSoundboard).where(eq(serverSoundboard.id, clipId));
    throw rollback;
  }), rollback);

  assert.deepEqual(await database.db.select({ id: serverSoundboard.id }).from(serverSoundboard), [{ id: clipId }]);
  const processed = await cleanup.runSoundboardCleanupJob(async () => assert.fail('файл опубликованного клипа нельзя удалять'),
    (error) => { throw error; }, new Date(stamp + 300_000));
  assert.equal(processed, false);
  await database.db.delete(serverSoundboard).where(eq(serverSoundboard.id, clipId));
  assert.deepEqual(await database.db.select({ url: soundboardCleanup.url }).from(soundboardCleanup), [{ url }]);
  await cleanup.runSoundboardCleanupJob(async () => {}, (error) => { throw error; });
});

test('квота считает все звуки в старом режиме и только свои в личном', async () => {
  const quota = await import('../src/soundboardQuota.js');
  const { db } = await import('../src/db/index.js');

  await db.insert(serverSoundboard).values([
    { id: 'mine', serverId: 'server', name: 'Свой', url: 'https://media.invalid/one', createdBy: 'owner' },
    { id: 'no-author', serverId: 'server', name: 'Без автора', url: 'https://media.invalid/two' },
  ]);
  await db.transaction(async (tx) => {
    assert.equal(await quota.lockSoundboardServer(tx, 'server'), true);
    const settings = await quota.readSoundboardSettings(tx, true);
    assert.deepEqual(await quota.readSoundboardQuota(tx, 'server', settings), { mode: 'legacy', limit: 24 });
    assert.equal(await quota.soundboardUsage(tx, 'server'), 2);

    const selected = { ...settings, mode: 'selected' as const, serverIds: ['server'] };
    assert.deepEqual(await quota.readSoundboardQuota(tx, 'server', selected), { mode: 'per-user', limit: 5 });
    assert.equal(await quota.soundboardUsage(tx, 'server', 'owner'), 1);
    assert.equal(await quota.soundboardUsage(tx, 'server', 'another-editor'), 0);
  });
  await db.delete(serverSoundboard);
  await db.delete(soundboardCleanup);
});

test('прогноз сохраняет старые звуки и добавляет только свободные места управляющих', () => {
  assert.deepEqual(
    projectSoundboard(5, new Set(['over-limit', 'partly-used', 'new-editor']), new Map([
      ['over-limit', 7],
      ['partly-used', 2],
      ['former-editor', 3],
      [null, 4],
    ])),
    { eligibleEditors: 3, clipCount: 16, projectedClipCount: 24 },
  );
});

test('каскад при удалении сервера оставляет задания на удаление всех файлов', async () => {
  const urls = ['https://media.invalid/test-media/sounds/first.wav', 'https://media.invalid/test-media/sounds/second.wav'];
  await database.db.insert(serverSoundboard).values([
    { id: 'first', serverId: 'server', name: 'Первый', url: urls[0] },
    { id: 'second', serverId: 'server', name: 'Второй', url: urls[1], createdBy: 'owner' },
  ]);

  await database.db.delete(servers).where(eq(servers.id, 'server'));
  assert.deepEqual(await database.db.select().from(serverSoundboard), []);
  const jobs = await database.db.select({ serverId: soundboardCleanup.serverId, url: soundboardCleanup.url })
    .from(soundboardCleanup).orderBy(soundboardCleanup.clipId);
  assert.deepEqual(jobs, urls.map((url) => ({ serverId: 'server', url })));
});
