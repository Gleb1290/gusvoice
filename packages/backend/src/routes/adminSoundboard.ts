import { has, Permission } from '@gusvoice/shared';
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSuperAdmin, superAdminId } from '../auth.js';
import { db } from '../db/index.js';
import { instanceSettings, memberRoles, roles, serverMembers, serverSoundboard, serverSoundboardQuotas, servers, users } from '../db/schema.js';
import { memberContextFrom } from '../permissions.js';
import { readSoundboardSettings, SOUNDBOARD_SETTINGS_KEY } from '../soundboardQuota.js';
import {
  DEFAULT_SOUNDBOARD_PER_USER_LIMIT,
  projectSoundboard,
  soundboardSettingsSchema,
} from '../soundboardQuotaRules.js';

export { startSoundboardCleanup } from '../soundboardCleanup.js';

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

export async function adminSoundboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSuperAdmin);

  app.get('/admin/soundboard', async () => {
    // Все данные прогноза читаем из одного снимка. Число запросов не зависит от числа серверов и участников.
    const superId = superAdminId();
    return db.transaction(async (tx) => {
      const settings = await readSoundboardSettings(tx);
      const serverRows = await tx.select({
        id: servers.id,
        name: servers.name,
        ownerId: servers.ownerId,
        limit: serverSoundboardQuotas.perUserLimit,
      }).from(servers).leftJoin(serverSoundboardQuotas, eq(serverSoundboardQuotas.serverId, servers.id))
        .orderBy(asc(servers.name), asc(servers.id));
      const roleRows = await tx.select({
        serverId: roles.serverId,
        id: roles.id,
        permissions: roles.permissions,
        position: roles.position,
        isEveryone: roles.isEveryone,
        isGuests: roles.isGuests,
      }).from(roles);
      const memberRows = await tx.select({
        serverId: serverMembers.serverId,
        userId: serverMembers.userId,
        homeInstanceId: users.homeInstanceId,
        roleId: memberRoles.roleId,
      }).from(serverMembers)
        .innerJoin(users, eq(users.id, serverMembers.userId))
        .leftJoin(memberRoles, and(eq(memberRoles.serverId, serverMembers.serverId), eq(memberRoles.userId, serverMembers.userId)))
        .where(and(eq(serverMembers.state, 'active'), eq(users.bot, false), isNull(users.deletedAt)));
      const clipCounts = await tx.select({
        serverId: serverSoundboard.serverId,
        authorId: serverSoundboard.createdBy,
        count: count(),
      }).from(serverSoundboard).groupBy(serverSoundboard.serverId, serverSoundboard.createdBy);

      const rolesByServer = groupBy(roleRows, (row) => row.serverId);
      const membersByServer = groupBy(memberRows, (row) => row.serverId);
      const clipsByServer = groupBy(clipCounts, (row) => row.serverId);
      const serverStats = serverRows.map((server) => {
        const editors = new Set<string>();
        if (superId !== null) editors.add(superId);
        const members = groupBy(membersByServer.get(server.id) ?? [], (row) => row.userId);
        for (const [userId, rows] of members) {
          if (editors.has(userId)) continue;
          const ctx = memberContextFrom({
            userId,
            ownerId: server.ownerId,
            isGuest: rows[0].homeInstanceId !== null,
            serverRoles: rolesByServer.get(server.id) ?? [],
            assignedRoleIds: rows.flatMap(({ roleId }) => roleId === null ? [] : [roleId]),
          });
          if (has(ctx.serverPermissions, Permission.MANAGE_SOUNDBOARD)) editors.add(userId);
        }

        const perUserLimit = server.limit ?? DEFAULT_SOUNDBOARD_PER_USER_LIMIT;
        const countByAuthor = new Map(clipsByServer.get(server.id)?.map((row) => [row.authorId, row.count]));
        return { id: server.id, name: server.name, perUserLimit, ...projectSoundboard(perUserLimit, editors, countByAuthor) };
      });

      return { ...settings, servers: serverStats };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  });

  app.put('/admin/soundboard', async (req, reply) => {
    const body = soundboardSettingsSchema.parse(req.body);
    const settings = { ...body, serverIds: [...new Set(body.serverIds)] };
    const saved = await db.transaction(async (tx) => {
      if (settings.mode === 'selected' && settings.serverIds.length > 0) {
        const found = await tx.select({ id: servers.id }).from(servers)
          .where(inArray(servers.id, settings.serverIds)).for('key share');
        if (found.length !== settings.serverIds.length) return false;
      }

      const values = { value: settings, updatedAt: new Date() };
      // UPDATE при конфликте ждёт SHARE у загрузок и PUT квоты.
      await tx.insert(instanceSettings).values({ key: SOUNDBOARD_SETTINGS_KEY, ...values })
        .onConflictDoUpdate({ target: instanceSettings.key, set: values });
      return true;
    });
    if (!saved) return reply.code(400).send({ error: 'выбран несуществующий сервер' });
    return { ok: true };
  });
}
