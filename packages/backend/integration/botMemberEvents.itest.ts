import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import * as s from '../src/db/schema.js';
import * as accountRules from '../src/accountRules.js';
import * as inviteRules from '../src/inviteRules.js';
import * as inviteLookup from '../src/inviteLookup.js';
import * as guestRules from '../src/federation/guestRules.js';
import * as linkRules from '../src/federation/linkRules.js';
import { createTestDb, type TestDb } from './harness.js';
import { serverFixture, type Phase3Edit } from './botsServers.harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });
const normal = <T>(v: T): T => JSON.parse(JSON.stringify(v));
async function fixture(edit?: Phase3Edit) {
  const noop = async () => {};
  const fail = (name: string) => () => assert.fail(`неожиданная граница ${name}`);
  const f = await serverFixture(t, edit, {
    real: ['routes/invites', 'accountDelete', 'accountRows'],
    values: {
      accountRules, inviteRules, inviteLookup, 'federation/guestRules': guestRules, 'federation/linkRules': linkRules,
      // Сессия — IO. Решения о членстве, приглашении и удалении — настоящие модули выше.
      auth: { isSuperAdmin: () => false, superAdminId: () => null,
        requireAuth: async (req: FastifyRequest) => { req.user = { sub: String(req.headers['x-user'] ?? 'owner') } as NonNullable<FastifyRequest['user']>; },
        hashPassword: async () => 'synthetic-unusable-password', forgetTokenGeneration: () => {} },
      authGuard: { clientIp: () => '192.0.2.1' }, inviteGuard: { inviteLockRemaining: async () => 0, recordInviteFailure: async () => 0 },
      // Bootstrap после фиксации проверен отдельно; здесь ответ не подменяет ни SQL вступления, ни событие.
      'routes/servers': { buildBootstrap: async () => ({ ok: true }) },
      'federation/instanceBan': { instanceBanFor: async () => null }, 'federation/links': { listLinks: fail('listLinks') },
      'federation/instanceMeta': { readInstanceMeta: fail('readInstanceMeta') },
      'federation/directoryEvents': { announceUser: noop }, 'federation/guestRevocation': { revokeAccountEverywhere: noop },
      activity: { clearActivity: noop }, attachments: { purgeDeletedOf: noop },
      // В этой фикстуре нет ЛС/владения ботами: чистка их удалённых записей не относится к проверке членства.
      conversations: { journalForwardedFrom: async () => [], deliverMany: noop },
      'bots/botLifecycle': { deleteBotsOwnedBy: noop }, gateway: { broadcastUserProfile: noop },
      gifs: { savedGifKeysOf: async () => [], removeGifFiles: noop }, livekit: { removeFromOtherRooms: noop }, storage: { removeUserAvatars: noop },
    },
  });
  await f.bot('observer'); assert.equal((await f.add('observer')).statusCode, 201);
  const pending: Promise<void>[] = [], changes: { c: import('../src/memberEvents.js').MemberChange; memberCount: number; deleted: boolean }[] = [];
  f.memberEvents.configureMemberBots({ changed(c) {
    const work = (async () => {
      const rows = await t.db.select().from(s.serverMembers).where(eq(s.serverMembers.userId, c.userId));
      const [u] = await t.db.select().from(s.users).where(eq(s.users.id, c.userId));
      changes.push({ c, memberCount: rows.length, deleted: !!u?.deletedAt });
      await f.channel.memberBotUpdates(c);
    })(); pending.push(work); return work;
  } });
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  const updates = async () => (await t.db.select().from(s.botUpdates).where(eq(s.botUpdates.botId, 'observer')).orderBy(asc(s.botUpdates.updateId)))
    .map(r => { const p = r.payload as any; return [r.type, p.user.id, p.from.id, p.old_status, p.new_status]; });
  const app = Fastify();
  await app.register(f.load('routes/invites').inviteRoutes); await app.ready();
  const close = async () => { await drain(); await app.close(); await f.clean(); };
  return { ...f, inviteApp: app, drain, changes, updates, close };
}
test('R303 настоящее принятие приглашения пишет chat_member после INSERT, повтор не создаёт событие', async () => {
  const f = await fixture();
  try {
    await t.db.insert(s.invites).values({ code: 'member-event', serverId: 'server', inviterId: 'owner' });
    const join = () => f.inviteApp.inject({ method: 'POST', url: '/invites/member-event', headers: { 'x-user': 'outsider' } });
    assert.equal((await join()).statusCode, 200); await f.drain();
    assert.deepEqual(await f.updates(), [['chat_member', 'outsider', 'outsider', 'left', 'member']]);
    assert.deepEqual(normal(f.changes), [{ c: { serverId: 'server', userId: 'outsider', actorId: 'outsider', from: 'left', to: 'member' }, memberCount: 1, deleted: false }]);
    assert.equal((await join()).statusCode, 200); await f.drain(); assert.equal((await f.updates()).length, 1);
    assert.equal((await t.db.select().from(s.invites))[0].uses, 1);
  } finally { await f.close(); }
});
test('R303 настоящие кик, бан, снятие бана и выход сохраняют автора и переходы после SQL', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.members.kickMember('server', 'owner', 'person')).kind, 'ok'); await f.drain();
    await t.db.insert(s.serverMembers).values({ serverId: 'server', userId: 'person' });
    assert.equal((await f.members.banMember('server', 'owner', 'person', 'причина')).kind, 'ok'); await f.drain();
    assert.equal((await f.members.unbanMember('server', 'owner', 'person')).kind, 'ok'); await f.drain();
    await t.db.insert(s.serverMembers).values({ serverId: 'server', userId: 'person' });
    assert.equal((await f.members.leaveServer('server', 'person')).kind, 'ok'); await f.drain();
    assert.deepEqual(await f.updates(), [
      ['chat_member', 'person', 'owner', 'member', 'left'],
      ['chat_member', 'person', 'owner', 'member', 'kicked'],
      ['chat_member', 'person', 'owner', 'kicked', 'left'],
      ['chat_member', 'person', 'person', 'member', 'left'],
    ]);
    assert.deepEqual(f.changes.map(x => x.memberCount), [0, 0, 0, 0]);
  } finally { await f.close(); }
});
test('R303 настоящий accountDelete с accountRows пишет chat_member после обезличивания и снятия членства', async () => {
  const f = await fixture();
  try {
    const account: typeof import('../src/accountDelete.js') = f.load('accountDelete');
    await account.anonymizeAccount('person'); await f.drain();
    assert.deepEqual(await f.updates(), [['chat_member', 'person', 'person', 'member', 'left']]);
    assert.deepEqual(f.changes.map(x => [x.memberCount, x.deleted]), [[0, true]]);
    const [user] = await t.db.select().from(s.users).where(eq(s.users.id, 'person'));
    assert.ok(user.deletedAt); assert.equal(user.tokenGeneration, 1);
  } finally { await f.close(); }
});
test('R303 original-first контрфакт неверного статуса кика ловится по настоящему журналу', async () => {
  const check = async (edit?: Phase3Edit) => {
    const f = await fixture(edit);
    try {
      await f.members.kickMember('server', 'owner', 'person'); await f.drain();
      const rows = await f.updates();
      assert.equal(rows[0]?.[4], 'left', 'R303 кик сообщает left, а не бан');
    } finally { await f.close(); }
  };
  await check();
  await assert.rejects(check({ file: 'serverMembership', from: "if (gone.length > 0) memberChanged({ serverId, userId, actorId, from: 'member', to: 'left' });",
    to: "if (gone.length > 0) memberChanged({ serverId, userId, actorId, from: 'member', to: 'kicked' });" }),
    e => e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION' && e.operator === 'strictEqual'
      && e.message.startsWith('R303 кик сообщает left, а не бан') && e.actual === 'kicked' && e.expected === 'left');
});
