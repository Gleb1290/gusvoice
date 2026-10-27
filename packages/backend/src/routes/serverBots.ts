/**
 * Боты на серверах (#231) — маршруты ЧЕЛОВЕКА («Настройки сервера → Интеграции → Боты»): список, поиск по нику, добавление,
 * галочка «читать всё», снятие. Контракт — `shared/bots.ts` (`ServerBotInfo`, `ServerBotLookup`, `AddServerBotBody`).
 *
 * Добавление — одна транзакция: `server_members` → управляемая роль (`roles.managed_bot_id`) → `member_roles` → `server_bots`.
 * Роль и строка `server_bots` висят на членстве бота (каскад, `0157_server_bots.sql`): любой выход бота их уносит.
 * Права роли — не больше прав добавляющего, без `ADMINISTRATOR` даже у владельца (`roleRules.botGrant`, решение 26.10).
 */
import {
  has,
  Permission,
  permsFromString,
  permsToString,
  SERVER_BOTS_MAX,
  type ServerBotInfo,
  type ServerBotLookup,
} from '@gusvoice/shared';
import { and, count, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { botById, readBotSettings } from '../bots/botStore.js';
import { db } from '../db/index.js';
import { bans, bots, memberRoles, roles, serverBots, serverMembers, users } from '../db/schema.js';
import { requireLocalUser } from '../guestGuard.js';
import { memberChanged } from '../memberEvents.js';
import { getMemberContext, highestPosition } from '../permissions.js';
import { publishToServer } from '../realtime.js';
import { BOT_ADMIN_FORBIDDEN, botAdminRequested, botGrant } from '../roleRules.js';
import { kickMember } from '../serverMembership.js';
import { id as newId } from '../util.js';

const permString = z.string().regex(/^\d{1,40}$/);

async function manager(serverId: string, me: string) {
  const ctx = await getMemberContext(serverId, me);
  if (!ctx) return null;
  return { ctx, canManage: ctx.isOwner || has(ctx.serverPermissions, Permission.MANAGE_SERVER) };
}

/** Почему бота нельзя добавить (или `null`). Приватный чужой — `hidden` (наружу 404 «не найден»). */
async function addBlock(serverId: string, botId: string, me: string): Promise<{ code: number; error: string; hidden?: true } | null> {
  const found = await botById(botId);
  if (!found || found.user.deletedAt || found.bot.disabledAt) return { code: 404, error: 'Бот не найден' };
  if (!found.bot.public && found.bot.ownerId !== me) return { code: 403, error: 'Бот приватный: добавить его может только владелец', hidden: true };
  const [banned] = await db.select({ u: bans.userId }).from(bans).where(and(eq(bans.serverId, serverId), eq(bans.userId, botId))).limit(1);
  if (banned) return { code: 409, error: 'Бот забанен на сервере' };
  const [member] = await db
    .select({ u: serverMembers.userId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, botId)))
    .limit(1);
  if (member) return { code: 409, error: 'Бот уже на сервере' };
  const [n] = await db.select({ n: count() }).from(serverBots).where(eq(serverBots.serverId, serverId));
  if (Number(n?.n ?? 0) >= SERVER_BOTS_MAX) return { code: 409, error: `На сервере уже ${SERVER_BOTS_MAX} ботов — больше нельзя` };
  return null;
}

export async function serverBotRoutes(app: FastifyInstance) {
  app.register(async (api) => {
    api.addHook('preHandler', requireAuth);
    api.addHook('preHandler', requireLocalUser);

    api.get<{ Params: { id: string } }>('/servers/:id/bots', async (req, reply) => {
      const m = await manager(req.params.id, req.user!.sub);
      if (!m) return reply.code(404).send({ error: 'not a member' });
      if (!m.canManage) return reply.code(403).send({ error: 'forbidden' });
      const enabled = (await readBotSettings()).enabled;
      const rows = await db
        .select({ sb: serverBots, u: users, b: bots })
        .from(serverBots)
        .innerJoin(users, eq(users.id, serverBots.botId))
        .innerJoin(bots, eq(bots.userId, serverBots.botId))
        .where(eq(serverBots.serverId, req.params.id));
      const roleRows = await db
        .select({ id: roles.id, botId: roles.managedBotId })
        .from(roles)
        .where(and(eq(roles.serverId, req.params.id), sql`${roles.managedBotId} IS NOT NULL`));
      const roleOf = new Map(roleRows.map((r) => [r.botId!, r.id]));
      const adderIds = [...new Set(rows.map((r) => r.sb.addedBy).filter((x): x is string => !!x))];
      const adders = new Map<string, string>();
      for (const aid of adderIds) {
        const [a] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, aid)).limit(1);
        if (a) adders.set(aid, a.displayName);
      }
      const out: ServerBotInfo[] = rows.map(({ sb, u, b }) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        description: b.description,
        readAll: sb.readAll,
        roleId: roleOf.get(u.id) ?? null,
        addedBy: sb.addedBy && adders.has(sb.addedBy) ? { id: sb.addedBy, displayName: adders.get(sb.addedBy)! } : null,
        addedAt: sb.addedAt.toISOString(),
        working: enabled && !b.disabledAt && !u.deletedAt,
      }));
      return out;
    });

    api.get<{ Params: { id: string }; Querystring: { username?: string } }>('/servers/:id/bots/lookup', async (req, reply) => {
      const me = req.user!.sub;
      const m = await manager(req.params.id, me);
      if (!m) return reply.code(404).send({ error: 'not a member' });
      if (!m.canManage) return reply.code(403).send({ error: 'forbidden' });
      const name = String(req.query.username ?? '').trim().replace(/^@/, '');
      if (!name || name.length > 64) return reply.code(404).send({ error: 'Бот не найден' });
      const [row] = await db
        .select({ u: users, b: bots })
        .from(users)
        .innerJoin(bots, eq(bots.userId, users.id))
        .where(sql`lower(${users.username}) = lower(${name})`)
        .limit(1);
      if (!row || row.u.deletedAt || row.b.disabledAt) return reply.code(404).send({ error: 'Бот не найден' });
      const block = await addBlock(req.params.id, row.u.id, me);
      // Приватный чужой бот — как «нет такого»: его существование не раскрываем.
      if (block?.hidden) return reply.code(404).send({ error: 'Бот не найден' });
      const out: ServerBotLookup = {
        id: row.u.id,
        username: row.u.username,
        displayName: row.u.displayName,
        avatarUrl: row.u.avatarUrl,
        description: row.b.description,
        canAdd: !block,
        ...(block ? { reason: block.error } : {}),
      };
      return out;
    });

    api.post<{ Params: { id: string } }>('/servers/:id/bots', async (req, reply) => {
      const me = req.user!.sub;
      const serverId = req.params.id;
      const body = z.object({ botId: z.string().min(1).max(64), permissions: permString, readAll: z.boolean() }).parse(req.body);
      const m = await manager(serverId, me);
      if (!m) return reply.code(404).send({ error: 'not a member' });
      if (!m.canManage) return reply.code(403).send({ error: 'forbidden' });
      if (!(await readBotSettings()).enabled) return reply.code(403).send({ error: 'Боты выключены на этом сервере' });
      const block = await addBlock(serverId, body.botId, me);
      if (block) return reply.code(block.code).send({ error: block.error });
      const requested = permsFromString(body.permissions);
      if (botAdminRequested(requested)) return reply.code(400).send({ error: BOT_ADMIN_FORBIDDEN });
      const granted = botGrant(requested, m.ctx.serverPermissions, m.ctx.isOwner);
      const found = (await botById(body.botId))!;
      const high = highestPosition(m.ctx);
      const roleId = newId();
      await db.transaction(async (tx) => {
        await tx.insert(serverMembers).values({ serverId, userId: body.botId });
        const [n] = await tx.select({ n: count() }).from(roles).where(eq(roles.serverId, serverId));
        let position = Number(n?.n ?? 0);
        // Роль бота — наверх, но строго НИЖЕ высшей роли добавляющего (чтобы он мог её править).
        if (Number.isFinite(high) && position >= high) {
          position = high;
          await tx
            .update(roles)
            .set({ position: sql`${roles.position} + 1` })
            .where(and(eq(roles.serverId, serverId), gte(roles.position, high), eq(roles.isEveryone, false)));
        }
        await tx.insert(roles).values({
          id: roleId,
          serverId,
          name: (found.user.displayName || found.user.username).slice(0, 80),
          color: 0,
          permissions: permsToString(granted),
          position,
          mentionable: false,
          membersCanAssign: false,
          managedBotId: body.botId,
        });
        await tx.insert(memberRoles).values({ serverId, userId: body.botId, roleId });
        await tx.insert(serverBots).values({ serverId, botId: body.botId, readAll: body.readAll, addedBy: me });
      });
      await writeAudit(serverId, me, 'bot.add', {
        targetType: 'member',
        targetId: body.botId,
        data: { username: found.user.username, permissions: permsToString(granted), readAll: body.readAll },
      });
      await publishToServer(serverId, { t: 'server.invalidate', serverId });
      memberChanged({ serverId, userId: body.botId, actorId: me, from: 'left', to: 'member' });
      return reply.code(201).send({ ok: true, roleId });
    });

    api.patch<{ Params: { id: string; botId: string } }>('/servers/:id/bots/:botId', async (req, reply) => {
      const me = req.user!.sub;
      const { id: serverId, botId } = req.params;
      const body = z.object({ readAll: z.boolean().optional() }).parse(req.body ?? {});
      const m = await manager(serverId, me);
      if (!m) return reply.code(404).send({ error: 'not a member' });
      if (!m.canManage) return reply.code(403).send({ error: 'forbidden' });
      const [row] = await db
        .select()
        .from(serverBots)
        .where(and(eq(serverBots.serverId, serverId), eq(serverBots.botId, botId)))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'Бота нет на сервере' });
      if (body.readAll !== undefined && body.readAll !== row.readAll) {
        await db.update(serverBots).set({ readAll: body.readAll }).where(and(eq(serverBots.serverId, serverId), eq(serverBots.botId, botId)));
        const [u] = await db.select({ username: users.username }).from(users).where(eq(users.id, botId)).limit(1);
        await writeAudit(serverId, me, 'bot.update', { targetType: 'member', targetId: botId, data: { username: u?.username, readAll: body.readAll } });
        await publishToServer(serverId, { t: 'server.invalidate', serverId });
      }
      return reply.code(204).send();
    });

    // Убрать бота = кик (`MANAGE_SERVER` или `KICK_MEMBERS` + иерархия). Роль и `server_bots` уходят каскадом.
    api.delete<{ Params: { id: string; botId: string } }>('/servers/:id/bots/:botId', async (req, reply) => {
      const me = req.user!.sub;
      const { id: serverId, botId } = req.params;
      const m = await manager(serverId, me);
      if (!m) return reply.code(404).send({ error: 'not a member' });
      const [row] = await db
        .select({ botId: serverBots.botId })
        .from(serverBots)
        .where(and(eq(serverBots.serverId, serverId), eq(serverBots.botId, botId)))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'Бота нет на сервере' });
      if (m.canManage) {
        const res = await removeBotFromServer(serverId, botId, me);
        if (!res) return reply.code(404).send({ error: 'Бота нет на сервере' });
        return reply.code(204).send();
      }
      const res = await kickMember(serverId, me, botId);
      if (res.kind === 'error') return reply.code(res.code).send({ error: res.error });
      const [u] = await db.select({ username: users.username }).from(users).where(eq(users.id, botId)).limit(1);
      await writeAudit(serverId, me, 'bot.remove', { targetType: 'member', targetId: botId, data: { username: u?.username } });
      return reply.code(204).send();
    });
  });
}

/**
 * Снять бота с сервера от имени `actorId` (админ с `MANAGE_SERVER` или владелец бота из «Моих ботов»): без иерархии ролей —
 * роль бота ставится ниже добавившего, но владелец бота может и не быть админом сервера. Роль и `server_bots` — каскадом.
 */
export async function removeBotFromServer(serverId: string, botId: string, actorId: string): Promise<boolean> {
  const gone = await db
    .delete(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, botId)))
    .returning({ userId: serverMembers.userId });
  if (gone.length === 0) return false;
  await db.delete(memberRoles).where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, botId)));
  const [u] = await db.select({ username: users.username }).from(users).where(eq(users.id, botId)).limit(1);
  await writeAudit(serverId, actorId, 'bot.remove', { targetType: 'member', targetId: botId, data: { username: u?.username } });
  await publishToServer(serverId, { t: 'server.invalidate', serverId });
  memberChanged({ serverId, userId: botId, actorId, from: 'member', to: 'left' });
  return true;
}
