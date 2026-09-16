import { has, Permission } from '@gusvoice/shared';
import { and, desc, eq, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { db } from '../db/index.js';
import { auditLog, users } from '../db/schema.js';
import { getMemberContext } from '../permissions.js';

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Recent audit entries for a server (newest first), gated by VIEW_AUDIT_LOG.
  app.get('/servers/:id/audit', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.string().optional() })
      .parse(req.query);

    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.VIEW_AUDIT_LOG)) return reply.code(403).send({ error: 'forbidden' });

    const conds = [eq(auditLog.serverId, serverId)];
    if (q.before) conds.push(lt(auditLog.createdAt, new Date(q.before)));

    // Второй join — по ЦЕЛИ действия. Без него голосовые действия остаются без имени: они кладут в
    // `data` только канал, и журнал читался как «замьютил участника» — видно кто, не видно кого.
    // Join, а не имя в `data`, потому что так чинятся и УЖЕ НАКОПЛЕННЫЕ записи (их сотни).
    const targetUser = alias(users, 'target_user');
    const rows = await db
      .select({ a: auditLog, u: users, t: targetUser })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.actorId, users.id))
      // Только для действий над участником: `target_id` у остальных — это канал, роль, категория,
      // и совпадений там быть не должно (идентификаторы из общего пространства).
      .leftJoin(targetUser, and(eq(auditLog.targetType, 'member'), eq(auditLog.targetId, targetUser.id)))
      .where(and(...conds))
      .orderBy(desc(auditLog.createdAt))
      .limit(q.limit);

    return rows.map(({ a, u, t }) => ({
      id: a.id,
      serverId: a.serverId,
      actor: u ? { id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl } : null,
      action: a.action,
      targetType: a.targetType,
      targetId: a.targetId,
      target: t ? { id: t.id, username: t.username, displayName: t.displayName, avatarUrl: t.avatarUrl } : null,
      data: a.data,
      createdAt: a.createdAt.toISOString(),
    }));
  });
}
