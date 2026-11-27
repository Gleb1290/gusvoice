import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { Permission as P } from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import { serverFixture } from './botsServers.harness.js';
import { createTestDb, type TestDb } from './harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t?.close(); });

test('маршрут проверяет права проверяющего и возвращает действующие исключения участника', async () => {
  const fixture = await serverFixture(t, undefined, {
    real: ['routes/channels'],
    values: { authGuard: { heavyReadBlock: async () => 0 } },
  });
  const app = Fastify();
  try {
    await app.register(fixture.load('routes/channels').channelRoutes);
    const inspect = (actor: string, member: string, channel = 'channel') => app.inject({
      method: 'GET', url: `/channels/${channel}/access-check/${member}`, headers: { 'x-user': actor },
    });

    assert.equal((await inspect('manager', 'person')).statusCode, 403);
    assert.equal((await inspect('outsider', 'person')).statusCode, 404);
    assert.equal((await inspect('owner', 'outsider')).statusCode, 404);

    await t.db.update(schema.roles).set({ permissions: String(P.VIEW_CHANNEL | P.MANAGE_ROLES) })
      .where(eq(schema.roles.id, 'manager-role'));
    await t.db.update(schema.roles).set({ permissions: String(P.VIEW_CHANNEL | P.SEND_MESSAGES) })
      .where(eq(schema.roles.id, 'everyone'));
    await t.db.insert(schema.categories).values({ id: 'category', serverId: 'server', name: 'Категория' });
    await t.db.update(schema.channels).set({ categoryId: 'category' }).where(eq(schema.channels.id, 'channel'));
    await t.db.insert(schema.categoryOverwrites).values({
      categoryId: 'category', targetType: 'role', targetId: 'everyone', deny: String(P.SEND_MESSAGES),
    });
    await t.db.insert(schema.channelOverwrites).values([
      { channelId: 'channel', targetType: 'member', targetId: 'person', allow: String(P.SEND_MESSAGES) },
      { channelId: 'other-channel', targetType: 'role', targetId: 'everyone', deny: String(P.VIEW_CHANNEL) },
    ]);

    const hidden = await inspect('manager', 'person', 'other-channel');
    assert.equal(hidden.statusCode, 404);
    assert.deepEqual(hidden.json(), (await inspect('manager', 'person', 'missing')).json());

    const response = await inspect('manager', 'person');
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json().find((item: { action: string }) => item.action === 'write'), {
      action: 'write', allowed: true, checks: [
        { permission: 'VIEW_CHANNEL', allowed: true, source: 'roles', roleIds: ['everyone'] },
        { permission: 'SEND_MESSAGES', allowed: true, source: 'channel', rule: 'member' },
      ],
    });
    const [stored] = await t.db.select().from(schema.channelOverwrites)
      .where(eq(schema.channelOverwrites.targetId, 'person'));
    assert.equal(stored.allow, String(P.SEND_MESSAGES));
    await t.db.delete(schema.channelOverwrites).where(eq(schema.channelOverwrites.targetId, 'person'));
    const inherited = (await inspect('manager', 'person')).json().find((item: { action: string }) => item.action === 'write');
    assert.equal(inherited.allowed, false);
    assert.equal(inherited.checks[1].source, 'category');
  } finally {
    await app.close();
    await fixture.clean();
  }
});
