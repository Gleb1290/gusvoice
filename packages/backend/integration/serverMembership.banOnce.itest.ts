import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema.js';
import { serverFixture, type Phase3Edit } from './botsServers.harness.js';
import { createTestDb, type TestDb } from './harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });
async function scenario(edit?: Phase3Edit) {
  const sent: { user: string; server: string; state: string }[] = [];
  const f = await serverFixture(t, edit, { values: {
    'federation/guestMembership': { announceMembership: async (input: { guest: { id: string }; serverId: string; state: string }) => {
      sent.push({ user: input.guest.id, server: input.serverId, state: input.state });
    } },
  } });
  try {
    await t.db.update(s.users).set({ homeInstanceId: 'peer', homeUserId: 'remote-person' }).where(eq(s.users.id, 'person'));
    assert.equal((await f.members.banMember('server', 'owner', 'person', 'fixture reason')).kind, 'ok');
    assert.equal(sent.length, 1, 'R306 один бан гостя анонсируется один раз');
    assert.deepEqual(sent, [{ user: 'person', server: 'server', state: 'removed' }]);
    assert.equal((await t.db.select().from(s.bans)).length, 1);
    assert.equal((await t.db.select().from(s.serverMembers).where(eq(s.serverMembers.userId, 'person'))).length, 0);
  } finally { await f.clean(); }
}
test('R306 бан гостя сохраняет запрет и анонсирует удаление соседу ровно один раз', () => scenario());
test('R306 контрфакт слияния: второй анонс после server.invalidate обнаруживается числом вызовов', async () => {
  await scenario();
  await assert.rejects(scenario({ file: 'serverMembership',
    from: "  memberChanged({ serverId, userId, actorId, from: gone.length > 0 ? 'member' : 'left', to: 'kicked' });",
    to: "  await announceMembership({ guest: banned, serverId, state: FED_MEMBERSHIP_STATES.removed });\n  memberChanged({ serverId, userId, actorId, from: gone.length > 0 ? 'member' : 'left', to: 'kicked' });" }),
  e => e instanceof assert.AssertionError && e.message.startsWith('R306 один бан гостя анонсируется один раз') && e.actual === 2 && e.expected === 1);
});
