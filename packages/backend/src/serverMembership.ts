/**
 * Кик, выход, бан и снятие бана (#231) — вынесено из `routes/servers.ts` без смены поведения людей: маршрут человека и Bot API
 * (`bots/botChannel.ts`, `kickChatMember`/`banChatMember`/`unbanChatMember`/`leaveChat`) зовут одно и то же — права, стражи
 * (не владелец, не себя, иерархия), журнал аудита, дом гостя (`announceMembership`), `server.invalidate`, `memberChanged`.
 *
 * Отказ — `{kind:'error', code, error}` с теми же кодами и текстами, что отдавал маршрут.
 */
import { has, Permission } from '@gusvoice/shared';
import { and, eq } from 'drizzle-orm';
import { writeAudit } from './audit.js';
import { db } from './db/index.js';
import { bans, memberRoles, serverMembers, servers, users } from './db/schema.js';
import { announceMembership } from './federation/guestMembership.js';
import { FED_MEMBERSHIP_STATES } from '@gusvoice/shared';
import { memberChanged } from './memberEvents.js';
import { getMemberContext, highestPosition } from './permissions.js';
import { publishToServer } from './realtime.js';

type Fail = { kind: 'error'; code: number; error: string };
const fail = (code: number, error: string): Fail => ({ kind: 'error', code, error });

/** Kick a member (KICK_MEMBERS). Cannot kick the owner or yourself. */
export async function kickMember(serverId: string, actorId: string, userId: string): Promise<{ kind: 'ok' } | Fail> {
  const ctx = await getMemberContext(serverId, actorId);
  if (!ctx) return fail(404, 'not a member');
  if (!has(ctx.serverPermissions, Permission.KICK_MEMBERS)) return fail(403, 'forbidden');

  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (server?.ownerId === userId) return fail(400, 'cannot kick the owner');
  if (userId === actorId) return fail(400, 'cannot kick yourself');

  // Hierarchy: you can only kick members whose highest role is strictly below yours.
  const targetCtx = await getMemberContext(serverId, userId);
  if (targetCtx && highestPosition(targetCtx) >= highestPosition(ctx)) {
    return fail(403, 'нельзя кикнуть того, чья роль выше или равна твоей');
  }

  const [kicked] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const gone = await db
    .delete(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .returning({ userId: serverMembers.userId });
  await db.delete(memberRoles).where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, userId)));
  await writeAudit(serverId, actorId, 'member.kick', {
    targetType: 'member',
    targetId: userId,
    data: { username: kicked?.username, displayName: kicked?.displayName },
  });
  // Гостя выкинули — его дом обязан узнать СРАЗУ (§5.5, индекс членств). Иначе у человека в
  // «Где я гость» и в рейле остаётся сервер, откуда его уже убрали, — до суточной сверки.
  if (kicked) await announceMembership({ guest: kicked, serverId, state: FED_MEMBERSHIP_STATES.removed });
  // 🔴 Раньше здесь не публиковалось НИЧЕГО (#91): ростер у остальных не обновлялся, а у
  // исключённого оставалась живая подписка на сервер, по которой он продолжал получать поток до
  // переподключения. Гейтвей на этом событии снимает подписки тех, кто больше не участник.
  await publishToServer(serverId, { t: 'server.invalidate', serverId });
  if (gone.length > 0) memberChanged({ serverId, userId, actorId, from: 'member', to: 'left' });
  return { kind: 'ok' };
}

/** Покинуть сервер по своей воле (#92). Прав не требует — уйти вправе любой участник. */
export async function leaveServer(serverId: string, userId: string): Promise<{ kind: 'ok' } | Fail> {
  // ⚠️ Проверяем ЧЛЕНСТВО НАПРЯМУЮ, а не через getMemberContext: тот отдаёт супер-админу
  // виртуальный контекст на любом сервере, и «выход» превратился бы в no-op с кодом 204.
  const [member] = await db
    .select()
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);
  if (!member) return fail(404, 'not a member');

  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  // Владельцу уходить некуда: сервер остался бы без хозяина. Тот же гард, что у кика и у
  // удаления аккаунта.
  if (server?.ownerId === userId) return fail(400, 'владелец не может выйти — передайте владение или удалите сервер');

  const [leaving] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  await db.delete(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  await db.delete(memberRoles).where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, userId)));
  await writeAudit(serverId, userId, 'member.leave', { targetType: 'member', targetId: userId });
  // Гость ушёл сам — дому это тем более надо знать: «Где я гость» у него открыт на том же экране,
  // и список, не меняющийся после выхода, читается как «выход не сработал».
  if (leaving) await announceMembership({ guest: leaving, serverId, state: FED_MEMBERSHIP_STATES.removed });
  // Ростер у остальных обновится, а гейтвей на этом событии снимет подписку у ушедшего (#91) —
  // иначе он продолжал бы получать поток сервера до переподключения.
  await publishToServer(serverId, { t: 'server.invalidate', serverId });
  memberChanged({ serverId, userId, actorId: userId, from: 'member', to: 'left' });
  return { kind: 'ok' };
}

/**
 * Ban a user (BAN_MEMBERS): record the ban, remove their membership, block re-join via invite.
 * Same owner/self/hierarchy guards as kick. The target need not currently be a member.
 */
export async function banMember(
  serverId: string,
  actorId: string,
  userId: string,
  reasonRaw: string | undefined,
): Promise<{ kind: 'ok'; banned: typeof users.$inferSelect; server: typeof servers.$inferSelect | undefined; reason: string | null } | Fail> {
  const ctx = await getMemberContext(serverId, actorId);
  if (!ctx) return fail(404, 'not a member');
  if (!has(ctx.serverPermissions, Permission.BAN_MEMBERS)) return fail(403, 'forbidden');

  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (server?.ownerId === userId) return fail(400, 'нельзя забанить владельца');
  if (userId === actorId) return fail(400, 'нельзя забанить себя');

  const targetCtx = await getMemberContext(serverId, userId);
  if (targetCtx && highestPosition(targetCtx) >= highestPosition(ctx)) {
    return fail(403, 'нельзя забанить того, чья роль выше или равна твоей');
  }

  const [banned] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!banned) return fail(404, 'пользователь не найден');
  const reason = reasonRaw?.trim() || null;
  await db
    .insert(bans)
    .values({ serverId, userId, reason, bannedBy: actorId })
    .onConflictDoUpdate({ target: [bans.serverId, bans.userId], set: { reason, bannedBy: actorId, createdAt: new Date() } });
  const gone = await db
    .delete(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .returning({ userId: serverMembers.userId });
  await db.delete(memberRoles).where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, userId)));
  await writeAudit(serverId, actorId, 'member.ban', {
    targetType: 'member',
    targetId: userId,
    data: { username: banned.username, displayName: banned.displayName, reason },
  });
  // ⚠️ Причину бана дому НЕ пересказываем: она написана для журнала своего сервера и вполне может
  // содержать то, чего человеку знать не следует. Дому достаточно, что членства больше нет.
  await announceMembership({ guest: banned, serverId, state: FED_MEMBERSHIP_STATES.removed });
  // См. комментарий в кике: без этого забаненный оставался подписанным на поток сервера.
  await publishToServer(serverId, { t: 'server.invalidate', serverId });
  memberChanged({ serverId, userId, actorId, from: gone.length > 0 ? 'member' : 'left', to: 'kicked' });
  return { kind: 'ok', banned, server, reason };
}

/** Lift a ban (BAN_MEMBERS). */
export async function unbanMember(serverId: string, actorId: string, userId: string): Promise<{ kind: 'ok' } | Fail> {
  const ctx = await getMemberContext(serverId, actorId);
  if (!ctx) return fail(404, 'not a member');
  if (!has(ctx.serverPermissions, Permission.BAN_MEMBERS)) return fail(403, 'forbidden');

  const [unbanned] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const lifted = await db
    .delete(bans)
    .where(and(eq(bans.serverId, serverId), eq(bans.userId, userId)))
    .returning({ userId: bans.userId });
  await writeAudit(serverId, actorId, 'member.unban', {
    targetType: 'member',
    targetId: userId,
    data: { username: unbanned?.username, displayName: unbanned?.displayName },
  });
  // Живую подписку не трогает (человека и так нет на сервере) — но открытый список банов
  // у модератора иначе остаётся устаревшим до переоткрытия.
  await publishToServer(serverId, { t: 'server.invalidate', serverId });
  if (lifted.length > 0) memberChanged({ serverId, userId, actorId, from: 'kicked', to: 'left' });
  return { kind: 'ok' };
}
