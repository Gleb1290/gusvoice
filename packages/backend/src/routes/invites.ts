import { has, Permission } from '@gusvoice/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { db } from '../db/index.js';
import { bans, invites, serverMembers, servers } from '../db/schema.js';
import { getMemberContext } from '../permissions.js';
import { publishToServer } from '../realtime.js';
import { serializeInvite } from '../serialize.js';
import { inviteCode } from '../util.js';
import { buildBootstrap } from './servers.js';
import { clearInviteFailures, inviteLockRemaining, recordInviteFailure } from '../inviteGuard.js';
import { clientIp } from '../authGuard.js';
import { isInviteSpent } from '../inviteRules.js';

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Create an invite for a server, with optional expiry (minutes) and max-uses.
  app.post('/servers/:id/invites', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        expiresInMinutes: z.number().int().min(1).max(525_600).nullable().optional(),
        maxUses: z.number().int().min(1).max(1000).nullable().optional(),
      })
      .parse(req.body ?? {});

    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.CREATE_INVITE)) return reply.code(403).send({ error: 'forbidden' });

    const expiresAt = body.expiresInMinutes ? new Date(Date.now() + body.expiresInMinutes * 60_000) : null;
    const [row] = await db
      .insert(invites)
      .values({ code: inviteCode(), serverId, inviterId: req.user!.sub, expiresAt, maxUses: body.maxUses ?? null })
      .returning();
    return reply.code(201).send(serializeInvite(row));
  });

  // List a server's active (non-expired, non-exhausted) invites. CREATE_INVITE.
  app.get('/servers/:id/invites', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.CREATE_INVITE)) return reply.code(403).send({ error: 'forbidden' });

    const rows = await db.select().from(invites).where(eq(invites.serverId, serverId)).orderBy(desc(invites.createdAt));
    return rows.filter((r) => !isInviteSpent(r, Date.now())).map(serializeInvite);
  });

  // Inspect an invite (server name/id).
  app.get('/invites/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const [invite] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
    if (!invite || isInviteSpent(invite, Date.now())) return reply.code(invite ? 410 : 404).send({ error: invite ? 'invite expired' : 'invalid invite' });
    const [server] = await db.select().from(servers).where(eq(servers.id, invite.serverId)).limit(1);
    return { code, server: { id: server.id, name: server.name, iconUrl: server.iconUrl } };
  });

  // Revoke an invite — the inviter, or anyone with CREATE_INVITE on its server.
  app.delete('/invites/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const [invite] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
    if (!invite) return reply.code(404).send({ error: 'invalid invite' });
    if (invite.inviterId !== req.user!.sub) {
      const ctx = await getMemberContext(invite.serverId, req.user!.sub);
      if (!ctx || !has(ctx.serverPermissions, Permission.CREATE_INVITE)) return reply.code(403).send({ error: 'forbidden' });
    }
    await db.delete(invites).where(eq(invites.code, code));
    return reply.code(204).send();
  });

  // Accept an invite — join the server. Increments the use counter on a real join.
  app.post('/invites/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const userId = req.user!.sub;

    // Brute-force guard: refuse to even look up a code while the user is locked out.
    const lockedFor = await inviteLockRemaining(userId);
    if (lockedFor > 0) {
      return reply
        .code(429)
        .send({ error: `Слишком много неверных кодов. Попробуйте через ${Math.ceil(lockedFor / 60)} мин.` });
    }
    const ip = clientIp(req);

    const [invite] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
    if (!invite) {
      // Wrong code — count it. If this tripped a lockout, answer 429; otherwise a plain 404.
      const lock = await recordInviteFailure(userId, ip);
      if (lock > 0) {
        return reply
          .code(429)
          .send({ error: `Слишком много неверных кодов. Попробуйте через ${Math.ceil(lock / 60)} мин.` });
      }
      return reply.code(404).send({ error: 'invalid invite' });
    }
    // A real code was entered (even if spent) — not brute-forcing; wipe the failure streak.
    await clearInviteFailures(userId);
    if (isInviteSpent(invite, Date.now())) return reply.code(410).send({ error: 'invite expired' });

    const [banned] = await db
      .select()
      .from(bans)
      .where(and(eq(bans.serverId, invite.serverId), eq(bans.userId, userId)))
      .limit(1);
    if (banned) return reply.code(403).send({ error: 'вы забанены на этом сервере' });

    const [existing] = await db
      .select()
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, invite.serverId), eq(serverMembers.userId, userId)))
      .limit(1);
    if (!existing) {
      await db.insert(serverMembers).values({ serverId: invite.serverId, userId }).onConflictDoNothing();
      await db.update(invites).set({ uses: sql`${invites.uses} + 1` }).where(eq(invites.code, code));
      // Новичок получает bootstrap прямо в ответе, а вот у ОСТАЛЬНЫХ ростер без этого события
      // обновится только при перезаходе.
      await publishToServer(invite.serverId, { t: 'server.invalidate', serverId: invite.serverId });
    }

    return buildBootstrap(invite.serverId, userId);
  });
}
