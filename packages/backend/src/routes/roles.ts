import { has, isAdmin, Permission, permsFromString, permsToString } from '@gusvoice/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { db } from '../db/index.js';
import { memberRoles, roles, serverMembers, servers, users } from '../db/schema.js';
import { getMemberContext, highestPosition } from '../permissions.js';
import { publishToServer } from '../realtime.js';
import { assignRoleBlock, BOT_ADMIN_FORBIDDEN, botAdminRequested, botRoleAssignmentBlocked, clampGrant, planReorder, selfAssignBlocked } from '../roleRules.js';
import { serializeRole } from '../serialize.js';
import { id } from '../util.js';

const permString = z.string().regex(/^\d+$/, 'permissions must be a decimal bitfield string');

function roleWriteError(code: 400 | 403 | 404, error: string) {
  return { ok: false as const, code, error };
}

// Добавление/удаление бота берёт тот же замок строки сервера.
async function lockRoleOrder(tx: Pick<typeof db, 'select'>, serverId: string) {
  const [server] = await tx.select({ id: servers.id }).from(servers).where(eq(servers.id, serverId)).for('no key update');
  return server;
}

export async function roleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/servers/:id/roles', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    const rows = await db.select().from(roles).where(eq(roles.serverId, serverId));
    return rows.map(serializeRole).sort((a, b) => a.position - b.position);
  });

  app.post('/servers/:id/roles', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(80),
        color: z.number().int().optional(),
        permissions: permString.optional(),
        mentionable: z.boolean().optional(),
      })
      .parse(req.body);

    const result = await db.transaction(async (tx) => {
      if (!(await lockRoleOrder(tx, serverId))) return roleWriteError(404, 'not a member');
      const ctx = await getMemberContext(serverId, req.user!.sub, tx);
      if (!ctx) return roleWriteError(404, 'not a member');
      if (!has(ctx.serverPermissions, Permission.MANAGE_ROLES)) return roleWriteError(403, 'forbidden');

      const all = await tx.select().from(roles).where(eq(roles.serverId, serverId));
      const highest = highestPosition(ctx);
      const position = Number.isFinite(highest) ? highest : all.length;
      if (Number.isFinite(highest)) {
        const everyone = all.find((role) => role.isEveryone);
        if (highest <= Math.max(0, everyone?.position ?? 0)) {
          return roleWriteError(403, 'нет места для новой роли ниже своей и выше @everyone');
        }
        // Освобождаем позицию для новой роли, сохраняя порядок и равенство существующих ролей.
        await tx.update(roles).set({ position: sql`${roles.position} + 1` })
          .where(and(eq(roles.serverId, serverId), eq(roles.isEveryone, false), gte(roles.position, position)));
      }

      const granted = clampGrant(permsFromString(body.permissions ?? '0'), ctx.serverPermissions, ctx.isOwner);
      const [row] = await tx.insert(roles).values({
        id: id(),
        serverId,
        name: body.name,
        color: body.color ?? 0,
        permissions: permsToString(granted),
        position,
        mentionable: body.mentionable ?? false,
      }).returning();
      return { ok: true as const, row };
    });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    const { row } = result;
    await writeAudit(serverId, req.user!.sub, 'role.create', {
      targetType: 'role',
      targetId: row.id,
      data: { name: row.name },
    });
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.code(201).send(serializeRole(row));
  });

  // Reorder roles (MANAGE_ROLES). `order` lists every non-@everyone role id, TOP (highest) → BOTTOM.
  // Positions are reassigned densely (@everyone stays 0). Non-privileged actors can't move roles at
  // or above their own highest position.
  app.put('/servers/:id/roles/reorder', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ order: z.array(z.string()).min(1) }).parse(req.body);
    const result = await db.transaction(async (tx) => {
      if (!(await lockRoleOrder(tx, serverId))) return roleWriteError(404, 'not a member');
      const ctx = await getMemberContext(serverId, req.user!.sub, tx);
      if (!ctx) return roleWriteError(404, 'not a member');
      if (!has(ctx.serverPermissions, Permission.MANAGE_ROLES)) return roleWriteError(403, 'forbidden');

      const all = await tx.select().from(roles).where(eq(roles.serverId, serverId));
      const plan = planReorder(body.order, all, {
        privileged: isAdmin(ctx.serverPermissions) || ctx.isOwner,
        highest: highestPosition(ctx),
      });
      if (!plan.ok) return plan;

      for (const u of plan.updates) await tx.update(roles).set({ position: u.position }).where(eq(roles.id, u.id));
      return { ok: true as const };
    });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    await writeAudit(serverId, req.user!.sub, 'role.reorder', { data: { count: body.order.length } });
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.code(204).send();
  });

  app.patch('/roles/:id', async (req, reply) => {
    const { id: roleId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        color: z.number().int().optional(),
        permissions: permString.optional(),
        hoist: z.boolean().optional(),
        position: z.number().int().optional(),
        mentionable: z.boolean().optional(),
        membersCanAssign: z.boolean().optional(),
      })
      .parse(req.body);

    const [found] = await db.select({ serverId: roles.serverId }).from(roles).where(eq(roles.id, roleId)).limit(1);
    if (!found) return reply.code(404).send({ error: 'not found' });
    const { serverId } = found;

    const result = await db.transaction(async (tx) => {
      if (!(await lockRoleOrder(tx, serverId))) return roleWriteError(404, 'not found');
      const ctx = await getMemberContext(serverId, req.user!.sub, tx);
      if (!ctx) return roleWriteError(404, 'not a member');
      if (!has(ctx.serverPermissions, Permission.MANAGE_ROLES)) return roleWriteError(403, 'forbidden');

      // Назначение роли берёт ту же блокировку, поэтому проверка владельцев роли и запись атомарны.
      const [role] = await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1).for('update');
      if (!role) return roleWriteError(404, 'not found');

      const actorHigh = highestPosition(ctx);
      if (role.position >= actorHigh) return roleWriteError(403, 'эта роль выше или равна твоей');
      if (body.position !== undefined && body.position >= actorHigh) {
        return roleWriteError(403, 'нельзя поднять роль до своего уровня или выше');
      }

      const patch: Partial<typeof role> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.color !== undefined) patch.color = body.color;
      if (body.hoist !== undefined) patch.hoist = body.hoist;
      if (body.position !== undefined) patch.position = body.position;
      if (body.mentionable !== undefined) patch.mentionable = body.mentionable;
      if (body.membersCanAssign !== undefined) patch.membersCanAssign = body.membersCanAssign;
      if (body.permissions !== undefined) {
        const requested = permsFromString(body.permissions);
        if (botAdminRequested(requested)) {
          if (role.managedBotId) return roleWriteError(400, BOT_ADMIN_FORBIDDEN);
          const [botHolder] = await tx
            .select({ userId: memberRoles.userId })
            .from(memberRoles)
            .innerJoin(users, eq(users.id, memberRoles.userId))
            .where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.roleId, roleId), eq(users.bot, true)))
            .limit(1);
          if (botHolder) return roleWriteError(400, BOT_ADMIN_FORBIDDEN);
        }
        // Защищённые биты сохраняются при правке роли любым участником, кроме владельца.
        patch.permissions = permsToString(
          clampGrant(requested, ctx.serverPermissions, ctx.isOwner, permsFromString(role.permissions)),
        );
      }

      const willSelfAssign = body.membersCanAssign ?? role.membersCanAssign;
      if (selfAssignBlocked(willSelfAssign, permsFromString(patch.permissions ?? role.permissions))) {
        return roleWriteError(400, 'нельзя разрешить самовыдачу роли с админ-правами (управление ролями/сервером)');
      }

      const [row] = await tx.update(roles).set(patch).where(eq(roles.id, roleId)).returning();
      return { ok: true as const, row, changed: Object.keys(patch) };
    });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    const { row, changed } = result;
    await writeAudit(serverId, req.user!.sub, 'role.update', {
      targetType: 'role',
      targetId: roleId,
      data: { name: row.name, changed },
    });
    // Permissions/visibility may have changed for many members — clients re-fetch bootstrap
    // (and, if in voice, refresh their LiveKit token so new publish grants take effect).
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return serializeRole(row);
  });

  app.delete('/roles/:id', async (req, reply) => {
    const { id: roleId } = z.object({ id: z.string() }).parse(req.params);
    const [found] = await db.select({ serverId: roles.serverId }).from(roles).where(eq(roles.id, roleId)).limit(1);
    if (!found) return reply.code(404).send({ error: 'not found' });

    const result = await db.transaction(async (tx) => {
      if (!(await lockRoleOrder(tx, found.serverId))) return roleWriteError(404, 'not found');
      const [role] = await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1).for('update');
      if (!role) return roleWriteError(404, 'not found');
      if (role.isEveryone) return roleWriteError(400, 'cannot delete @everyone');
      // Удаление системной роли оставило бы гостей без их базовых ограничений.
      if (role.isGuests) return roleWriteError(400, 'роль «Гости» удалить нельзя');
      if (role.managedBotId) return roleWriteError(400, 'Роль бота удаляется вместе с ботом');
      const ctx = await getMemberContext(role.serverId, req.user!.sub, tx);
      if (!ctx) return roleWriteError(404, 'not a member');
      if (!has(ctx.serverPermissions, Permission.MANAGE_ROLES)) return roleWriteError(403, 'forbidden');
      if (role.position >= highestPosition(ctx)) return roleWriteError(403, 'эта роль выше или равна твоей');

      await tx.delete(roles).where(eq(roles.id, roleId));
      return { ok: true as const, role };
    });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    const { role } = result;
    await writeAudit(role.serverId, req.user!.sub, 'role.delete', {
      targetType: 'role',
      targetId: roleId,
      data: { name: role.name },
    });
    await publishToServer(role.serverId, { t: 'server.invalidate', serverId: role.serverId });
    return reply.code(204).send();
  });

  // Assign / unassign a role to a member.
  app.put('/servers/:id/members/:userId/roles/:roleId', async (req, reply) => {
    const { id: serverId, userId, roleId } = z
      .object({ id: z.string(), userId: z.string(), roleId: z.string() })
      .parse(req.params);

    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });

    const result = await db.transaction(async (tx) => {
      const [role] = await tx.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.serverId, serverId))).limit(1).for('update');
      if (!role) return roleWriteError(404, 'role not found');
      /**
       * 🔴 «Гости» руками не выдаётся (§5.9): она действует ПО ПРИЗНАКУ гостя (`baseRoleFor`), а не по
       * строке в `member_roles`. Выданная местному, она не ограничила бы его, а наоборот добавила бы
       * прав поверх `@everyone` — владелец сервера, сужая гостям права, расширил бы их своим.
       * Гостю же эта строка не даёт ничего: роль у него и так базовая.
       */
      if (role.isGuests) return roleWriteError(400, 'роль «Гости» выдаётся гостям сама');
      // Роль бота (#231) — только у него, выдаётся при добавлении бота.
      if (role.managedBotId) return roleWriteError(400, 'Роль бота выдаётся только ему');

      const block = assignRoleBlock({
        isManager: has(ctx.serverPermissions, Permission.MANAGE_ROLES),
        membersCanAssign: role.membersCanAssign,
        actorHasRole: ctx.roleIds.includes(roleId),
        rolePosition: role.position,
        actorHighest: highestPosition(ctx),
      });
      if (block) return roleWriteError(403, block);
      const [target] = await tx
        .select({ isBot: users.bot })
        .from(serverMembers)
        .innerJoin(users, eq(users.id, serverMembers.userId))
        .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
        .limit(1);
      if (!target) return roleWriteError(404, 'member not found');
      if (botRoleAssignmentBlocked(permsFromString(role.permissions), ctx.isBot === true, target.isBot)) {
        return roleWriteError(400, BOT_ADMIN_FORBIDDEN);
      }

      await tx.insert(memberRoles).values({ serverId, userId, roleId }).onConflictDoNothing();
      return { ok: true as const, role };
    });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    const { role } = result;
    await writeAudit(serverId, req.user!.sub, 'role.assign', {
      targetType: 'member',
      targetId: userId,
      data: { roleId, roleName: role.name },
    });
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.code(204).send();
  });

  app.delete('/servers/:id/members/:userId/roles/:roleId', async (req, reply) => {
    const { id: serverId, userId, roleId } = z
      .object({ id: z.string(), userId: z.string(), roleId: z.string() })
      .parse(req.params);

    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_ROLES)) return reply.code(403).send({ error: 'forbidden' });

    const [role] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    // Снять «Гостей» тоже нельзя, и по той же причине: у гостя она не строкой, а правилом — снятие
    // выглядело бы как действие, а не меняло бы ничего.
    if (role?.isGuests) return reply.code(400).send({ error: 'роль «Гости» снять нельзя' });
    if (role?.managedBotId) return reply.code(400).send({ error: 'Роль бота выдаётся только ему' });
    if (role && role.position >= highestPosition(ctx)) {
      return reply.code(403).send({ error: 'нельзя снять роль своего уровня или выше' });
    }

    await db
      .delete(memberRoles)
      .where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, userId), eq(memberRoles.roleId, roleId)));
    await writeAudit(serverId, req.user!.sub, 'role.unassign', {
      targetType: 'member',
      targetId: userId,
      data: { roleId, roleName: role?.name },
    });
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.code(204).send();
  });
}
