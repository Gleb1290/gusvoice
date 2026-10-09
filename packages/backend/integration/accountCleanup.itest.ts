import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { anonymizeAccountRows } from '../src/accountRows.js';
import { dmMessages, messages, users } from '../src/db/schema.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;

before(async () => {
  process.env.UNVERIFIED_TTL_DAYS = '7';
  t = await createTestDb();
});
beforeEach(async () => truncateAll(t.raw));
after(async () => t.close());

test('транзакционное обезличивание сохраняет переписку и убивает старое поколение токена', async () => {
  // Ловит каскадное удаление истории, неосвобождённые login/email и живой JWT после удаления аккаунта.
  const deletedAt = new Date('2026-09-16T12:00:00Z');
  await t.raw.exec(`
    INSERT INTO users (id, username, email, verified, display_name, password_hash, token_generation, approved_at)
    VALUES
      ('keeper', 'Keeper', 'keeper@example.invalid', true, 'Keeper', 'hash', 0, now()),
      ('victim', 'WantedLogin', 'wanted@example.invalid', true, 'Victim', 'old-hash', 5, now());
    INSERT INTO servers (id, name, owner_id) VALUES ('s', 'Server', 'keeper');
    INSERT INTO categories (id, server_id, name) VALUES ('cat', 's', 'Category');
    INSERT INTO channels (id, server_id, category_id, name, type) VALUES ('ch', 's', 'cat', 'chat', 'text');
    INSERT INTO server_members (server_id, user_id) VALUES ('s', 'victim');
    INSERT INTO messages (id, channel_id, author_id, content) VALUES ('m', 'ch', 'victim', 'kept channel history');
    INSERT INTO dm_channels (id, user_a, user_b) VALUES ('dm', 'keeper', 'victim');
    INSERT INTO dm_messages (id, dm_channel_id, author_id, content) VALUES ('dm-m', 'dm', 'victim', 'kept dm history');
    INSERT INTO conversations (id, kind, direct_key, created_by) VALUES ('conv', 'direct', 'keeper:victim', 'victim');
    INSERT INTO conversation_members (conversation_id, user_id) VALUES ('conv', 'keeper'), ('conv', 'victim');
    INSERT INTO conversation_messages (id, conversation_id, author_id, sort_key, content)
      VALUES ('conv-m', 'conv', 'victim', 1, 'kept conversation history');
    INSERT INTO user_sync (user_id, pts) VALUES ('victim', 1);
    INSERT INTO dm_folders (id,user_id,title,flags) VALUES ('victim-folder','victim','Папка',1);
    INSERT INTO user_changes (user_id, pts, conversation_id, kind, message_id)
      VALUES ('victim', 1, 'conv', 'msg', 'conv-m');
    INSERT INTO sticker_packs (id,server_id,name,title,created_by) VALUES ('keep-pack',NULL,'KeepBirds','Птицы','keeper');
    INSERT INTO stickers (id,pack_id,emoji,url,format,position) VALUES ('keep-sticker','keep-pack','🪶','https://media.test/keep','webp',0);
    INSERT INTO user_faved_stickers (user_id,sticker_id) VALUES ('victim','keep-sticker'),('keeper','keep-sticker');
    INSERT INTO user_recent_stickers (user_id,sticker_id) VALUES ('victim','keep-sticker'),('keeper','keep-sticker');
    INSERT INTO privacy_exceptions (owner_id,target_id,key,kind) VALUES
      ('victim','keeper','calls','always'),('keeper','victim','calls','never');
    INSERT INTO user_contacts (owner_id,contact_id,name) VALUES
      ('victim','keeper','Мой контакт'),('keeper','victim','Удаляемый человек');
  `);

  const memberOf = await t.db.transaction(async (tx) => {
    const servers = await anonymizeAccountRows(tx, 'victim', 'unusable-hash', deletedAt);
    await tx.update(users).set({ tokenGeneration: sql`${users.tokenGeneration} + 1` }).where(eq(users.id, 'victim'));
    return servers;
  });

  const [victim] = await t.db.select().from(users).where(eq(users.id, 'victim'));
  assert.deepEqual(memberOf, ['s']);
  assert.equal(victim?.username, 'deleted-victim');
  assert.equal(victim?.email, null);
  assert.equal(victim?.verified, false);
  assert.equal(victim?.tokenGeneration, 6);
  assert.equal(victim?.deletedAt?.toISOString(), deletedAt.toISOString());
  assert.equal(victim?.approvedAt, null);
  assert.equal((await t.raw.query(`SELECT 1 FROM privacy_exceptions WHERE owner_id='victim' OR target_id='victim'`)).rows.length, 0,
    'удаление аккаунта убирает право звонить и запрет звонить ему — в обе стороны');
  assert.equal((await t.raw.query(`SELECT 1 FROM user_contacts WHERE owner_id='victim' OR contact_id='victim'`)).rows.length, 0,
    'удаление аккаунта стирает и его личный список, и чужие подписи на него');
  assert.equal((await t.db.select().from(messages)).length, 1);
  assert.equal((await t.db.select().from(dmMessages)).length, 1);
  assert.deepEqual((await t.raw.query(`SELECT id FROM conversation_messages`)).rows, [{ id: 'conv-m' }]);
  assert.deepEqual((await t.raw.query(`SELECT user_id FROM conversation_members WHERE user_id = 'victim'`)).rows,
    [{ user_id: 'victim' }]);
  assert.equal((await t.raw.query(`SELECT 1 FROM user_sync WHERE user_id = 'victim'`)).rows.length, 0);
  assert.equal((await t.raw.query(`SELECT 1 FROM user_changes WHERE user_id = 'victim'`)).rows.length, 0);
  assert.equal((await t.raw.query(`SELECT 1 FROM dm_folders WHERE user_id = 'victim'`)).rows.length, 0);
  // Личные предпочтения удалённого исчезают, но общий каталог и чужие списки сохраняются.
  for (const table of ['user_faved_stickers','user_recent_stickers']) {
    assert.deepEqual((await t.raw.query(`SELECT user_id FROM ${table}`)).rows,[{user_id:'keeper'}]);
  }
  assert.equal((await t.raw.query(`SELECT 1 FROM stickers WHERE id='keep-sticker'`)).rows.length,1);
  assert.equal(await (await import('../src/auth.js')).tokenGenValid('victim', 5), false);
  await t.raw.exec(`
    INSERT INTO users (id, username, email, display_name, password_hash)
    VALUES ('replacement', 'WantedLogin', 'wanted@example.invalid', 'Replacement', 'hash')
  `);
});

test('purgeUnverifiedUsers удаляет только старый пустой аккаунт, проверяя каждый защитный след', async () => {
  // Ловит случайное расширение уборки на подтверждённых, свежих, удалённых или хоть как-то связанных людей.
  await t.raw.exec(`
    INSERT INTO users (id, username, verified, display_name, password_hash, created_at, deleted_at) VALUES
      ('keeper', 'Keeper', true, 'Keeper', 'hash', now() - interval '20 days', null),
      ('eligible', 'Eligible', false, 'Eligible', 'hash', now() - interval '8 days', null),
      ('recent', 'Recent', false, 'Recent', 'hash', now() - interval '1 day', null),
      ('verified-old', 'VerifiedOld', true, 'Verified Old', 'hash', now() - interval '20 days', null),
      ('anonymized', 'deleted_anonymized', false, 'Deleted', 'hash', now() - interval '20 days', now() - interval '10 days'),
      ('owner-footprint', 'OwnerFootprint', false, 'Owner', 'hash', now() - interval '20 days', null),
      ('message-footprint', 'MessageFootprint', false, 'Message', 'hash', now() - interval '20 days', null),
      ('dm-message-footprint', 'DmMessageFootprint', false, 'DM Message', 'hash', now() - interval '20 days', null),
      ('dm-pair-footprint', 'DmPairFootprint', false, 'DM Pair', 'hash', now() - interval '20 days', null),
      ('conv-member-footprint', 'ConvMemberFootprint', false, 'Conv Member', 'hash', now() - interval '20 days', null),
      ('member-footprint', 'MemberFootprint', false, 'Member', 'hash', now() - interval '20 days', null),
      ('role-footprint', 'RoleFootprint', false, 'Role', 'hash', now() - interval '20 days', null);
    INSERT INTO email_verifications (user_id, code, expires_at) VALUES ('eligible', 'code', now() + interval '1 day');
    INSERT INTO servers (id, name, owner_id) VALUES
      ('main', 'Main', 'keeper'),
      ('owned', 'Owned', 'owner-footprint');
    INSERT INTO categories (id, server_id, name) VALUES ('cat', 'main', 'Category');
    INSERT INTO channels (id, server_id, category_id, name, type) VALUES ('ch', 'main', 'cat', 'chat', 'text');
    INSERT INTO messages (id, channel_id, author_id, content) VALUES ('m', 'ch', 'message-footprint', 'history');
    INSERT INTO dm_channels (id, user_a, user_b) VALUES
      ('dm-author', 'dm-pair-footprint', 'keeper'),
      ('dm-third', 'keeper', 'verified-old');
    INSERT INTO dm_messages (id, dm_channel_id, author_id, content)
      VALUES ('dm-m', 'dm-third', 'dm-message-footprint', 'history');
    INSERT INTO conversations (id, kind, direct_key) VALUES ('empty-conv', 'direct', 'conv-member-footprint:keeper');
    INSERT INTO conversation_members (conversation_id, user_id) VALUES
      ('empty-conv', 'conv-member-footprint'), ('empty-conv', 'keeper');
    INSERT INTO server_members (server_id, user_id) VALUES ('main', 'member-footprint');
    INSERT INTO roles (id, server_id, name) VALUES ('role', 'main', 'Role');
    INSERT INTO member_roles (server_id, user_id, role_id) VALUES ('main', 'role-footprint', 'role');
  `);

  const { purgeUnverifiedUsers } = await import('../src/cleanup.js');
  assert.equal(await purgeUnverifiedUsers(), 1);
  const remaining = await t.raw.query<{ id: string }>('SELECT id FROM users ORDER BY id');
  assert.equal(remaining.rows.some((r) => r.id === 'eligible'), false);
  for (const id of [
    'recent',
    'verified-old',
    'anonymized',
    'owner-footprint',
    'message-footprint',
    'dm-message-footprint',
    'dm-pair-footprint',
    'conv-member-footprint',
    'member-footprint',
    'role-footprint',
  ]) assert.equal(remaining.rows.some((r) => r.id === id), true, id);
  const verification = await t.raw.query(`SELECT 1 FROM email_verifications WHERE user_id = 'eligible'`);
  assert.equal(verification.rows.length, 0);
});

test('уборка журнала поднимает min_pts до последней удалённой строки', async () => {
  // Ловит дырку в догонке: старый клиент должен перечитать снимок, а не считать потерянные события прочитанными.
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES ('a','a','A','hash'),('b','b','B','hash');
    INSERT INTO conversations (id, kind, direct_key) VALUES ('conv','direct','a:b');
    INSERT INTO conversation_members (conversation_id, user_id) VALUES ('conv','a'),('conv','b');
    INSERT INTO user_sync (user_id, pts, min_pts) VALUES ('a',3,0);
    INSERT INTO user_changes (user_id, pts, conversation_id, kind, at) VALUES
      ('a',1,'conv','conv',now() - interval '32 days'),
      ('a',2,'conv','conv',now() - interval '31 days'),
      ('a',3,'conv','conv',now());
  `);
  const { pruneJournal } = await import('../src/convJournal.js');
  assert.equal(await pruneJournal(), 2);
  assert.deepEqual((await t.raw.query<{ pts: number; min_pts: number }>(
    `SELECT pts, min_pts FROM user_sync WHERE user_id = 'a'`,
  )).rows.map((r) => [Number(r.pts), Number(r.min_pts)]), [[3, 2]]);
  assert.deepEqual((await t.raw.query<{ pts: number }>(`SELECT pts FROM user_changes WHERE user_id = 'a'`)).rows.map((r) => Number(r.pts)), [3]);
  assert.equal(await pruneJournal(), 0);
});
