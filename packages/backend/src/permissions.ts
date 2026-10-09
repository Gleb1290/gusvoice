import {
  ALL_PERMISSIONS,
  basePermissions,
  has,
  isAdmin,
  type Overwrite,
  Permission,
  permsFromString,
  resolveChannelPermissions,
} from '@gusvoice/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { isSuperAdmin, superAdminId } from './auth.js';
import { asUserId } from './superAdminRules.js';
import { db } from './db/index.js';
import {
  categoryOverwrites,
  channelOverwrites,
  channels,
  memberRoles,
  roles,
  serverMembers,
  servers,
  users,
} from './db/schema.js';

import {
  channelAudience,
  resolveLayered as resolveLayeredPure,
  toOverwrite,
  type AudienceMember,
  type OverwriteRow,
} from './audienceRules.js';

export type { OverwriteRow };

interface RoleRow {
  id: string;
  isEveryone: boolean;
  permissions: string;
  position: number;
}

export interface MemberContext {
  isOwner: boolean;
  roleIds: string[];
  roles: RoleRow[];
  everyoneRoleId: string | null;
  serverPermissions: bigint;
}

/** Load a member's server-level context, or null if they are not a member. */
export async function getMemberContext(serverId: string, userId: string): Promise<MemberContext | null> {
  // Super-admin is a virtual full-permission member of every server. По id, без похода в базу (#140).
  if (isSuperAdmin(asUserId(userId))) {
    return { isOwner: true, roleIds: [], roles: [], everyoneRoleId: null, serverPermissions: ALL_PERMISSIONS };
  }

  const [member] = await db
    .select({ state: serverMembers.state, homeInstanceId: users.homeInstanceId })
    .from(serverMembers)
    .innerJoin(users, eq(serverMembers.userId, users.id))
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);
  if (!member) return null;
  /**
   * Членство есть, но закрыто держателем (#139, F3, §5.3.1) — прав у человека нет НИГДЕ.
   *
   * 🔴 Проверка стоит здесь, в одном месте, а не в маршрутах: «любой запрос гостя к серверу
   * получает отказ» (план §5.3.1) — это десятки маршрутов, и достаточно забыть один, чтобы
   * закрытый гость продолжал, например, писать в канал. Там, где человеку нужен ТЕКСТ с
   * контактами держателя, а не голое «не участник», стоит `guestAccessRefusal`.
   */
  if (member.state !== 'active') return null;

  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  const isOwner = server?.ownerId === userId;

  const serverRoles = await db.select().from(roles).where(eq(roles.serverId, serverId));
  const everyone = serverRoles.find((r) => r.isEveryone) ?? null;
  /**
   * Базовые права гостя даёт системная роль «Гости» (#139, F3, §5.9) — она ЗАМЕНЯЕТ `@everyone`.
   *
   * 🔴 Именно заменяет, а не добавляется: роли только прибавляют права, и ограничить всех гостей
   * разом, оставив им `@everyone`, было бы нечем. При создании роль — копия прав `@everyone`, то
   * есть по умолчанию гость равен своему, а сузить может владелец сервера.
   * ⚠️ `everyoneRoleId` при этом остаётся `@everyone`: канальные переопределения на `@everyone` —
   * это «для всех участников канала», и гость участник не меньше прочих. Переопределения на саму
   * роль «Гости» работают поверх — через `roleIds` ниже.
   */
  const isGuest = member.homeInstanceId !== null;
  const guestsRole = serverRoles.find((r) => r.isGuests) ?? null;
  const baseRole = isGuest && guestsRole ? guestsRole : everyone;

  const mr = await db
    .select({ roleId: memberRoles.roleId })
    .from(memberRoles)
    .where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, userId)));
  const assigned = new Set(mr.map((r) => r.roleId));

  const effectiveRoles: RoleRow[] = serverRoles
    .filter((r) => r.id === baseRole?.id || assigned.has(r.id))
    .map((r) => ({ id: r.id, isEveryone: r.isEveryone, permissions: r.permissions, position: r.position }));
  // ⚠️ `roleIds` отдаём только по СУЩЕСТВУЮЩИМ ролям: он уходит в `applyOverwrites`, а оверрайды на
  // роль хранятся без FK, поэтому висячая связь дотянулась бы до чужого `allow`. Сейчас `member_roles`
  // каскадно чистится при удалении роли, так что вход и так чистый, — но инвариант не должен зависеть
  // от каскада в соседней таблице.
  for (const id of assigned) if (!serverRoles.some((r) => r.id === id)) assigned.delete(id);

  let serverPermissions = basePermissions(effectiveRoles.map((r) => ({ permissions: permsFromString(r.permissions) })));
  if (isOwner) serverPermissions = ALL_PERMISSIONS;

  // Роль «Гости» едет в `roleIds`, чтобы работали её канальные переопределения (скрыть «Админку»,
  // запретить показ экрана) — ради них она и заведена.
  if (isGuest && guestsRole) assigned.add(guestsRole.id);

  return {
    isOwner,
    roleIds: [...assigned],
    roles: effectiveRoles,
    everyoneRoleId: everyone?.id ?? null,
    serverPermissions,
  };
}

/**
 * A member's authority level for the role hierarchy: the highest `position` among their roles
 * (owner / ADMINISTRATOR rank above everyone). You may only manage roles/members strictly below this.
 */
export function highestPosition(ctx: MemberContext): number {
  if (ctx.isOwner || isAdmin(ctx.serverPermissions)) return Number.POSITIVE_INFINITY;
  return ctx.roles.reduce((max, r) => Math.max(max, r.position), 0);
}

/** Effective permissions for a member within a specific channel (applies overwrites). */
export async function getChannelPermissions(
  channelId: string,
  userId: string,
): Promise<{ serverId: string; permissions: bigint } | null> {
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!channel) return null;

  const ctx = await getMemberContext(channel.serverId, userId);
  if (!ctx) return null;

  if (ctx.isOwner || isAdmin(ctx.serverPermissions)) {
    return { serverId: channel.serverId, permissions: ALL_PERMISSIONS };
  }

  // Layered: CATEGORY overwrites are the inherited base for every channel in the category; the channel's
  // own overwrites then override them (e.g. a channel marked private wins over a category-wide grant).
  const [catOws, chanOws] = await Promise.all([
    channel.categoryId
      ? db.select().from(categoryOverwrites).where(eq(categoryOverwrites.categoryId, channel.categoryId))
      : Promise.resolve([] as OverwriteRow[]),
    db.select().from(channelOverwrites).where(eq(channelOverwrites.channelId, channelId)),
  ]);

  const permissions = resolveLayered(ctx, userId, catOws, chanOws);
  return { serverId: channel.serverId, permissions };
}

/** Формула наложения — в `audienceRules.ts`; здесь только переупаковка контекста в subject. */
function resolveLayered(ctx: MemberContext, userId: string, catOws: OverwriteRow[], chanOws: OverwriteRow[]): bigint {
  const subject = { userId, roleIds: ctx.roleIds, everyoneRoleId: ctx.everyoneRoleId };
  return resolveLayeredPure(ctx.serverPermissions, subject, catOws, chanOws);
}

/**
 * Каналы, по которым можно искать сообщения: человек их видит И может читать историю. ОДНА проверка для поиска по серверу
 * (`GET /servers/:id/search`) и по всем серверам (`GET /search/servers`, `srvsearch1`) — свои упрощённые права в поиске запрещены.
 */
export function searchableChannelIds(perms: ReadonlyMap<string, bigint>): string[] {
  return [...perms.entries()]
    .filter(([, p]) => has(p, Permission.VIEW_CHANNEL) && has(p, Permission.READ_HISTORY))
    .map(([cid]) => cid);
}

/** Effective permissions for EVERY channel of a server for one member (single batched pass). */
export async function getServerChannelPermissions(serverId: string, userId: string): Promise<Map<string, bigint> | null> {
  const ctx = await getMemberContext(serverId, userId);
  if (!ctx) return null;

  const chans = await db.select().from(channels).where(eq(channels.serverId, serverId));
  if (ctx.isOwner || isAdmin(ctx.serverPermissions)) {
    return new Map(chans.map((c) => [c.id, ALL_PERMISSIONS]));
  }

  const chanIds = chans.map((c) => c.id);
  const catIds = [...new Set(chans.map((c) => c.categoryId).filter((x): x is string => !!x))];
  const [chanOws, catOws] = await Promise.all([
    chanIds.length
      ? db.select().from(channelOverwrites).where(inArray(channelOverwrites.channelId, chanIds))
      : Promise.resolve([] as (typeof channelOverwrites.$inferSelect)[]),
    catIds.length
      ? db.select().from(categoryOverwrites).where(inArray(categoryOverwrites.categoryId, catIds))
      : Promise.resolve([] as (typeof categoryOverwrites.$inferSelect)[]),
  ]);

  const byChan = new Map<string, OverwriteRow[]>();
  for (const o of chanOws) {
    const arr = byChan.get(o.channelId);
    if (arr) arr.push(o);
    else byChan.set(o.channelId, [o]);
  }
  const byCat = new Map<string, OverwriteRow[]>();
  for (const o of catOws) {
    const arr = byCat.get(o.categoryId);
    if (arr) arr.push(o);
    else byCat.set(o.categoryId, [o]);
  }

  // Layered per channel: category overwrites (inherited base) then channel overwrites (override).
  const out = new Map<string, bigint>();
  for (const c of chans) {
    const catRows = c.categoryId ? byCat.get(c.categoryId) ?? [] : [];
    const chanRows = byChan.get(c.id) ?? [];
    out.set(c.id, resolveLayered(ctx, userId, catRows, chanRows));
  }
  return out;
}

/**
 * The set of channel ids that the @everyone role can VIEW — i.e. the PUBLIC channels. A channel not in
 * this set is "private" (restricted access) and the client shows a lock badge. Layered like everything
 * else: @everyone base perms → category's @everyone overwrite (inherited) → channel's @everyone overwrite
 * (override) — so a channel marked private (channel-level deny VIEW) reads as private even if its category
 * grants VIEW, and a channel can re-open VIEW that its category denied.
 */
export async function getEveryoneViewableChannels(serverId: string): Promise<Set<string>> {
  const serverRoles = await db.select().from(roles).where(eq(roles.serverId, serverId));
  const chans = await db.select().from(channels).where(eq(channels.serverId, serverId));
  const everyone = serverRoles.find((r) => r.isEveryone);
  if (!everyone) return new Set(chans.map((c) => c.id)); // no @everyone role — treat all as public

  const everyoneBase = basePermissions([{ permissions: permsFromString(everyone.permissions) }]);
  const chanIds = chans.map((c) => c.id);
  const catIds = [...new Set(chans.map((c) => c.categoryId).filter((x): x is string => !!x))];
  const [chanOws, catOws] = await Promise.all([
    chanIds.length
      ? db.select().from(channelOverwrites).where(inArray(channelOverwrites.channelId, chanIds))
      : Promise.resolve([] as (typeof channelOverwrites.$inferSelect)[]),
    catIds.length
      ? db.select().from(categoryOverwrites).where(inArray(categoryOverwrites.categoryId, catIds))
      : Promise.resolve([] as (typeof categoryOverwrites.$inferSelect)[]),
  ]);

  const everyoneOw = (rows: { targetType: string; targetId: string; allow: string; deny: string }[]) =>
    rows.find((o) => o.targetType === 'role' && o.targetId === everyone.id);

  const view = new Set<string>();
  for (const c of chans) {
    const catOw = c.categoryId ? everyoneOw(catOws.filter((o) => o.categoryId === c.categoryId)) : undefined;
    const chanOw = everyoneOw(chanOws.filter((o) => o.channelId === c.id));
    let perms = resolveChannelPermissions(everyoneBase, { everyone: catOw ? toOverwrite(catOw) : undefined });
    perms = resolveChannelPermissions(perms, { everyone: chanOw ? toOverwrite(chanOw) : undefined });
    if (has(perms, Permission.VIEW_CHANNEL)) view.add(c.id);
  }
  return view;
}

/**
 * Кому МОЖНО отдавать события этого канала: id участников с правом `VIEW_CHANNEL` (#91).
 *
 * Считается по факту, одним батчем на событие — не по кэшу у соединения. Запросы мелкие и все по
 * индексам; на фоне записи самого сообщения в базу это незаметно, зато нет ни кэша, который надо
 * инвалидировать, ни окна между сменой прав и рассылкой.
 *
 * ⚠️ Супер-админ включается всегда: он виртуальный участник любого сервера (см. `getMemberContext`),
 * и без этого он молча перестал бы получать события там, где формально не состоит.
 * ⚠️ Для `channel.delete` аудиторию надо взять ДО удаления строки — после неё считать уже не по чему.
 */
export async function getChannelAudience(channelId: string): Promise<{ serverId: string; userIds: string[] } | null> {
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!channel) return null;
  // ⚠️ `serverId` берём ИЗ КАНАЛА, а не от вызывающего: иначе, назвав чужой канал вместе со своим
  // сервером, можно было бы посчитать аудиторию не тем составом.
  const serverId = channel.serverId;

  const [server, memberRows, serverRoles, memberRoleRows, chanOws] = await Promise.all([
    db.select({ ownerId: servers.ownerId }).from(servers).where(eq(servers.id, serverId)).limit(1),
    /**
     * 🔴 Только ДЕЙСТВУЮЩИЕ членства и с признаком гостя (аудит 19.09, F-03). Строка членства гостя
     * переживает закрытие сервера для федерации (`closed_by_host`) и запрет (`removed`) — так
     * задумано, чтобы возврат был без потерь, — но в аудиторию такой человек входить не должен:
     * `getMemberContext` отвечает про него «не участник», и рассылка обязана отвечать так же.
     */
    db
      .select({ userId: serverMembers.userId, homeInstanceId: users.homeInstanceId })
      .from(serverMembers)
      .innerJoin(users, eq(serverMembers.userId, users.id))
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.state, 'active'))),
    db.select().from(roles).where(eq(roles.serverId, serverId)),
    db
      .select({ userId: memberRoles.userId, roleId: memberRoles.roleId })
      .from(memberRoles)
      .where(eq(memberRoles.serverId, serverId)),
    db.select().from(channelOverwrites).where(eq(channelOverwrites.channelId, channelId)),
  ]);
  const catOws = channel.categoryId
    ? await db.select().from(categoryOverwrites).where(eq(categoryOverwrites.categoryId, channel.categoryId))
    : [];

  const ownerId = server[0]?.ownerId ?? null;
  const rolesByUser = new Map<string, string[]>();
  for (const r of memberRoleRows) {
    const arr = rolesByUser.get(r.userId);
    if (arr) arr.push(r.roleId);
    else rolesByUser.set(r.userId, [r.roleId]);
  }

  // Супер-админ — ровно один человек, id привязан при старте (#140); логин из env не спрашиваем.
  const superId = superAdminId();

  const members: AudienceMember[] = memberRows.map((m) => ({
    userId: m.userId,
    roleIds: rolesByUser.get(m.userId) ?? [],
    privileged: m.userId === ownerId || m.userId === superId,
    isGuest: m.homeInstanceId !== null,
  }));

  // Супер-админ, НЕ состоящий в сервере, участником не числится, но подписаться на него может —
  // добавляем отдельно, иначе он молча перестанет получать события.
  if (superId && !memberRows.some((m) => m.userId === superId)) {
    members.push({ userId: superId, roleIds: [], privileged: true });
  }

  const userIds = channelAudience({
    members,
    roles: serverRoles.map((r) => ({ id: r.id, isEveryone: r.isEveryone, permissions: r.permissions })),
    everyoneRoleId: serverRoles.find((r) => r.isEveryone)?.id ?? null,
    guestsRoleId: serverRoles.find((r) => r.isGuests)?.id ?? null,
    categoryOverwrites: catOws,
    channelOverwrites: chanOws,
  });
  return { serverId, userIds };
}

/** Voice channel ids (across all the user's servers) the user can VIEW — used to filter presence. */
export async function getVisibleVoiceChannelIds(userId: string): Promise<string[]> {
  // Super-admin oversees every server (mirrors getMemberContext's bypass): return ALL voice
  // channels so presence (who-is-in-voice) shows up even in servers they aren't a member of.
  // Without this, voice-visibility is built only from serverMembers, so an un-joined super-admin
  // sees the channel but never who's sitting in it.
  if (isSuperAdmin(asUserId(userId))) {
    const all = await db.select({ id: channels.id }).from(channels).where(eq(channels.type, 'voice'));
    return all.map((c) => c.id);
  }

  const memberships = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, userId));

  const visible: string[] = [];
  for (const { serverId } of memberships) {
    const perms = await getServerChannelPermissions(serverId, userId);
    if (!perms) continue;
    const voice = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.serverId, serverId), eq(channels.type, 'voice')));
    for (const c of voice) {
      if (has(perms.get(c.id) ?? 0n, Permission.VIEW_CHANNEL)) visible.push(c.id);
    }
  }
  return visible;
}
