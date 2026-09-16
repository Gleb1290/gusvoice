import { has, isAdmin, Permission, permsFromString, permsToString } from '@gusvoice/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { db } from '../db/index.js';
import { memberRoles, roles, serverMembers } from '../db/schema.js';
import { getMemberContext, highestPosition } from '../permissions.js';
import { publishToServer } from '../realtime.js';
import { assignRoleBlock, clampGrant, planReorder, selfAssignBlocked } from '../roleRules.js';
import { serializeRole } from '../serialize.js';
import { id } from '../util.js';

const permString = z.string().regex(/^\d+$/, 'permissions must be a decimal bitfield string');

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

    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_ROLES)) return reply.code(403).send({ error: 'forbidden' });

    const count = (await db.select().from(roles).where(eq(roles.serverId, serverId))).length;
    // Новая роль: защищённых битов ещё нет (`current = 0n`), выдать их может только владелец.
    const granted = clampGrant(permsFromString(body.permissions ?? '0'), ctx.serverPermissions, ctx.isOwner);
    const [row] = await db
      .insert(roles)
      .values({
        id: id(),
        serverId,
        name: body.name,
        color: body.color ?? 0,
        permissions: permsToString(granted),
        position: count,
        mentionable: body.mentionable ?? false,
      })
      .returning();
    await writeAudit(serverId, req.user!.sub, 'role.create', {
      targetType: 'role',
      targetId: row.id,
      data: { name: row.name },
    });
    return reply.code(201).send(serializeRole(row));
  });

  // Reorder roles (MANAGE_ROLES). `order` lists every non-@everyone role id, TOP (highest) → BOTTOM.
  // Positions are reassigned densely (@everyone stays 0). Non-privileged actors can't move roles at
  // or above their own highest position.
  app.put('/servers/:id/roles/reorder', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ order: z.array(z.string()).min(1) }).parse(req.body);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_ROLES)) return reply.code(403).send({ error: 'forbidden' });

    const all = await db.select().from(roles).where(eq(roles.serverId, serverId));
    const plan = planReorder(body.order, all, {
      privileged: isAdmin(ctx.serverPermissions) || ctx.isOwner,
      highest: highestPosition(ctx),
    });
    if (!plan.ok) return reply.code(plan.code).send({ error: plan.error });

    for (const u of plan.updates) await db.update(roles).set({ position: u.position }).where(eq(roles.id, u.id));
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

    const [role] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    if (!role) return reply.code(404).send({ error: 'not found' });
    const ctx = await getMemberContext(role.serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_ROLES)) return reply.code(403).send({ error: 'forbidden' });

    const actorHigh = highestPosition(ctx);
    if (role.position >= actorHigh) return reply.code(403).send({ error: 'эта роль выше или равна твоей' });
    if (body.position !== undefined && body.position >= actorHigh) {
      return reply.code(403).send({ error: 'нельзя поднять роль до своего уровня или выше' });
    }

    const patch: Partial<typeof role> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.color !== undefined) patch.color = body.color;
    if (body.hoist !== undefined) patch.hoist = body.hoist;
    if (body.position !== undefined) patch.position = body.position;
    if (body.mentionable !== undefined) patch.mentionable = body.mentionable;
    if (body.membersCanAssign !== undefined) patch.membersCanAssign = body.membersCanAssign;
    if (body.permissions !== undefined) {
      // ⚠️ Передаём ТЕКУЩУЮ маску роли: защищённые биты обязаны сохраниться как есть, если правит не
      // владелец. Иначе админ, тронувший соседний тумблер, снял бы выданный владельцем MOVE_ANYONE.
      patch.permissions = permsToString(
        clampGrant(permsFromString(body.permissions), ctx.serverPermissions, ctx.isOwner, permsFromString(role.permissions)),
      );
    }

    // Guard: a self-service role (members_can_assign) must NOT carry admin-level perms, else the
    // grant would spread privilege virally. Check the FINAL state (this patch's perms + flag).
    const willSelfAssign = body.membersCanAssign ?? role.membersCanAssign;
    if (selfAssignBlocked(willSelfAssign, permsFromString(patch.permissions ?? role.permissions))) {
      return reply
        .code(400)
        .send({ error: 'нельзя разрешить самовыдачу роли с админ-правами (управление ролями/сервером)' });
    }

    const [row] = await db.update(roles).set(patch).where(eq(roles.id, roleId)).returning();
    await writeAudit(role.serverId, req.user!.sub, 'role.update', {
      targetType: 'role',
      targetId: roleId,
      data: { name: row.name, changed: Object.keys(patch) },
    });
    // Permissions/visibility may have changed for many members — clients re-fetch bootstrap
    // (and, if in voice, refresh their LiveKit token so new publish grants take effect).
    await publishToServer(role.serverId, { t: 'server.invalidate', serverId: role.serverId });
    return serializeRole(row);
  });

  app.delete('/roles/:id', async (req, reply) => {
    const { id: roleId } = z.object({ id: z.string() }).parse(req.params);
    const [role] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    if (!role) return reply.code(404).send({ error: 'not found' });
    if (role.isEveryone) return reply.code(400).send({ error: 'cannot delete @everyone' });
    const ctx = await getMemberContext(role.serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_ROLES)) return reply.code(403).send({ error: 'forbidden' });
    if (role.position >= highestPosition(ctx)) return reply.code(403).send({ error: 'эта роль выше или равна твоей' });

    await db.delete(roles).where(eq(roles.id, roleId));
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

    const [role] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    if (!role || role.serverId !== serverId) return reply.code(404).send({ error: 'role not found' });

    const block = assignRoleBlock({
      isManager: has(ctx.serverPermissions, Permission.MANAGE_ROLES),
      membersCanAssign: role.membersCanAssign,
      actorHasRole: ctx.roleIds.includes(roleId),
      rolePosition: role.position,
      actorHighest: highestPosition(ctx),
    });
    if (block) return reply.code(403).send({ error: block });
    const [target] = await db
      .select()
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
      .limit(1);
    if (!target) return reply.code(404).send({ error: 'member not found' });

    await db.insert(memberRoles).values({ serverId, userId, roleId }).onConflictDoNothing();
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
