import {
  checkEmojiName,
  checkEmojiUpload,
  checkPackImport,
  DEFAULT_EVERYONE_PERMISSIONS,
  has,
  mentionSqlPattern,
  parseStickerSetName,
  Permission,
  permsToString,
  type ServerBootstrap,
  STICKER_MIME,
} from '@gusvoice/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { isSuperAdmin, requireAuth } from '../auth.js';
import { heavyReadBlock, retryMessage } from '../authGuard.js';
import { publishToServer } from '../realtime.js';
import { db } from '../db/index.js';
import { bans, categories, channels, channelSounds, memberRoles, roles, serverEmojis, serverMembers, servers, serverSounds, stickerPacks, stickers, users } from '../db/schema.js';
import {
  getEveryoneViewableChannels,
  getMemberContext,
  getServerChannelPermissions,
  highestPosition,
} from '../permissions.js';
import { serializeCategory, serializeChannel, serializeRole, serializeServer, statusFieldsOf } from '../serialize.js';
import { animatedAvatarFor } from '../shopRules.js';
import { isSupportedImage, putMedia } from '../storage.js';
import { downloadSticker, getStickerSet, telegramConfigured, TelegramError } from '../telegram.js';
import { id } from '../util.js';

/** Потолок иконки сервера — как у аватара: 5 МБ. */
const MAX_ICON_BYTES = 5 * 1024 * 1024;

const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

/** Build the full bootstrap payload for a member (channel tree, roles, permissions). */
export async function buildBootstrap(serverId: string, userId: string): Promise<ServerBootstrap | null> {
  const ctx = await getMemberContext(serverId, userId);
  if (!ctx) return null;

  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server) return null;

  const [cats, chans, serverRoles, member, mrRows] = await Promise.all([
    db.select().from(categories).where(eq(categories.serverId, serverId)),
    db.select().from(channels).where(eq(channels.serverId, serverId)),
    db.select().from(roles).where(eq(roles.serverId, serverId)),
    db
      .select()
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
      .limit(1),
    db
      .select({ roleId: memberRoles.roleId })
      .from(memberRoles)
      .where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, userId))),
  ]);

  // A server admin/manager sees EVERYTHING — all channels and all categories, including private ones —
  // so they can administer the server (private channels still get the lock badge). "Manager" = owner,
  // ADMINISTRATOR (has all perms, so MANAGE_CHANNELS is set), MANAGE_CHANNELS, or MANAGE_SERVER. A regular
  // member instead gets VIEW-filtered visibility: a category shows iff they can see ≥1 of its channels.
  const chanPerms = await getServerChannelPermissions(serverId, userId);
  const canManageChannels = has(ctx.serverPermissions, Permission.MANAGE_CHANNELS);
  const seesEverything = ctx.isOwner || canManageChannels || has(ctx.serverPermissions, Permission.MANAGE_SERVER);
  const visibleChans = seesEverything
    ? chans
    : chans.filter((c) => has(chanPerms?.get(c.id) ?? 0n, Permission.VIEW_CHANNEL));
  const visibleCatIds = new Set(visibleChans.map((c) => c.categoryId).filter((x): x is string => !!x));
  const catVisible = (id: string) => seesEverything || visibleCatIds.has(id);

  const soundRows = await db.select().from(serverSounds).where(eq(serverSounds.serverId, serverId));
  const sounds: Record<string, string> = {};
  for (const s of soundRows) sounds[s.event] = s.url;

  // Per-channel sound overrides for this server's channels (channelId → {event: url}).
  const chSounds = new Map<string, Record<string, string>>();
  if (chans.length) {
    const rows = await db
      .select()
      .from(channelSounds)
      .where(inArray(channelSounds.channelId, chans.map((c) => c.id)));
    for (const s of rows) {
      const m = chSounds.get(s.channelId) ?? {};
      m[s.event] = s.url;
      chSounds.set(s.channelId, m);
    }
  }

  // Channels @everyone can't VIEW are "private" — the client renders a lock badge.
  const everyoneView = await getEveryoneViewableChannels(serverId);

  // Кастомные эмодзи (#18) — в bootstrap, а не отдельным запросом: `:имя:` в первом же сообщении
  // нечем заменить, пока список не приехал, и текст мигнул бы сырым кодом.
  const emojiRows = await db
    .select()
    .from(serverEmojis)
    .where(eq(serverEmojis.serverId, serverId))
    .orderBy(serverEmojis.name);

  // Наборы стикеров (#68) — по той же причине в bootstrap: пикер обязан открываться сразу.
  // Один запрос с join вместо N+1: наборов до 12, стикеров в каждом до 120.
  const packRows = await db
    .select()
    .from(stickerPacks)
    .where(eq(stickerPacks.serverId, serverId))
    .orderBy(stickerPacks.createdAt);
  const stickerRows = packRows.length
    ? await db
        .select()
        .from(stickers)
        .where(inArray(stickers.packId, packRows.map((p) => p.id)))
        .orderBy(stickers.position)
    : [];

  // Persisted unread + mention counts per visible text channel (migration 0018): messages newer
  // than my channel_reads mark, capped to a 14-day window so a never-opened channel doesn't count
  // its whole history.
  //
  // ⚠️ Шаблон упоминания строит ОБЩЕЕ правило (`shared/mentions.ts`) — то же, по которому клиент
  // звенит звуком, а бэкенд шлёт пуш. Своя регулярка здесь расходилась с ними: чужая почта в
  // тексте засчитывалась как упоминание и оставляла бейдж, который нечем было снять. Считаем
  // одним запросом по истории, а не в Node, поэтому правило и отдаётся регуляркой.
  const reads: Record<string, { unread: number; mentions: number }> = {};
  const textChanIds = visibleChans.filter((c) => c.type === 'text').map((c) => c.id);
  if (textChanIds.length) {
    const [me] = await db.select({ username: users.username }).from(users).where(eq(users.id, userId)).limit(1);
    const mentionRe = mentionSqlPattern(me?.username);
    const res = await db.execute(sql`
      SELECT m.channel_id AS id,
             COUNT(*)::int AS unread,
             (COUNT(*) FILTER (WHERE m.content ~* ${mentionRe}))::int AS mentions
      FROM messages m
      LEFT JOIN channel_reads r ON r.channel_id = m.channel_id AND r.user_id = ${userId}
      WHERE m.channel_id IN (${sql.join(textChanIds.map((i) => sql`${i}`), sql`, `)})
        AND m.author_id <> ${userId}
        AND m.created_at > GREATEST(COALESCE(r.last_read_at, to_timestamp(0)), now() - interval '14 days')
      GROUP BY m.channel_id
    `);
    for (const row of res.rows as { id: string; unread: number; mentions: number }[]) {
      reads[row.id] = { unread: row.unread, mentions: row.mentions };
    }
  }

  return {
    server: serializeServer(server),
    categories: cats.filter((c) => catVisible(c.id)).map(serializeCategory).sort(byPosition),
    channels: visibleChans
      .map((c) => serializeChannel({ ...c, isPrivate: !everyoneView.has(c.id), sounds: chSounds.get(c.id) ?? {} }))
      .sort(byPosition),
    roles: serverRoles.map(serializeRole).sort(byPosition),
    member: {
      userId,
      serverId,
      nickname: member[0]?.nickname ?? null,
      roleIds: mrRows.map((r) => r.roleId),
      joinedAt: (member[0]?.joinedAt ?? new Date()).toISOString(),
    },
    permissions: permsToString(ctx.serverPermissions),
    sounds,
    emojis: emojiRows.map((e) => ({ id: e.id, name: e.name, url: e.url })),
    stickerPacks: packRows.map((p) => ({
      id: p.id,
      name: p.name,
      title: p.title,
      stickers: stickerRows
        .filter((s) => s.packId === p.id)
        .map((s) => ({ id: s.id, emoji: s.emoji, url: s.url, format: s.format })),
    })),
    // Инстанс-настройка, а не серверная: без токена бота импорт невозможен нигде. Едет сюда,
    // чтобы вкладка настроек сразу сказала «не настроено», а не после отказа на кнопку.
    stickersEnabled: telegramConfigured(),
    reads,
  };
}

export async function serverRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // List servers the user belongs to. The super-admin sees every server.
  app.get('/servers', async (req) => {
    if (isSuperAdmin(req.user!.sub)) {
      const all = await db.select().from(servers);
      return all.map(serializeServer);
    }
    const rows = await db
      .select({ server: servers })
      .from(serverMembers)
      .innerJoin(servers, eq(serverMembers.serverId, servers.id))
      .where(eq(serverMembers.userId, req.user!.sub));
    return rows.map((r) => serializeServer(r.server));
  });

  // Create a server with default @everyone role, a category and starter channels.
  // Gated: only the super-admin or users granted can_create_servers may create.
  app.post('/servers', async (req, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    const userId = req.user!.sub;

    const [me] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!isSuperAdmin(userId) && !me?.canCreateServers) {
      return reply.code(403).send({ error: 'you are not allowed to create servers' });
    }
    const serverId = id();
    const categoryId = id();

    await db.transaction(async (tx) => {
      await tx.insert(servers).values({ id: serverId, name, ownerId: userId });
      await tx.insert(roles).values({
        id: id(),
        serverId,
        name: 'everyone',
        permissions: permsToString(DEFAULT_EVERYONE_PERMISSIONS),
        position: 0,
        isEveryone: true,
      });
      await tx.insert(serverMembers).values({ serverId, userId });
      await tx.insert(categories).values({ id: categoryId, serverId, name: 'General', position: 0 });
      await tx.insert(channels).values([
        { id: id(), serverId, categoryId, name: 'general', type: 'text', position: 0 },
        { id: id(), serverId, categoryId, name: 'General', type: 'voice', position: 1 },
      ]);
    });

    return reply.code(201).send(await buildBootstrap(serverId, userId));
  });

  // Full bootstrap for one server.
  app.get('/servers/:id', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const data = await buildBootstrap(serverId, req.user!.sub);
    if (!data) return reply.code(404).send({ error: 'not found or not a member' });
    return data;
  });

  // Rename / re-icon a server (MANAGE_SERVER).
  app.patch('/servers/:id', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ name: z.string().min(1).max(80).optional(), iconUrl: z.string().url().nullable().optional() })
      .parse(req.body);

    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_SERVER)) return reply.code(403).send({ error: 'forbidden' });

    const patch: Partial<{ name: string; iconUrl: string | null }> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.iconUrl !== undefined) patch.iconUrl = body.iconUrl;
    const [row] = await db.update(servers).set(patch).where(eq(servers.id, serverId)).returning();
    await writeAudit(serverId, req.user!.sub, 'server.update', {
      targetType: 'server',
      targetId: serverId,
      data: { changed: Object.keys(patch) },
    });
    // Оповещаем участников: имя и иконка видны в РЕЙЛЕ, а он живёт отдельно от bootstrap.
    // Без этого переименование сервера доезжало до остальных только после перезагрузки страницы.
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return serializeServer(row);
  });

  // List a server's members (any member can view).
  app.get('/servers/:id/members', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    // Expensive-read rate-limit (P2-2): a full member+roles dump — don't let it be looped to hammer PG.
    const rl = await heavyReadBlock(req.user!.sub);
    if (rl) return reply.code(429).header('Retry-After', String(rl)).send({ error: retryMessage(rl) });

    const rows = await db
      .select({ m: serverMembers, u: users })
      .from(serverMembers)
      .innerJoin(users, eq(serverMembers.userId, users.id))
      .where(eq(serverMembers.serverId, serverId));
    const mr = await db.select().from(memberRoles).where(eq(memberRoles.serverId, serverId));

    const rolesByUser = new Map<string, string[]>();
    for (const r of mr) {
      const arr = rolesByUser.get(r.userId) ?? [];
      arr.push(r.roleId);
      rolesByUser.set(r.userId, arr);
    }

    // Один момент времени на весь список: иначе две строки могли бы разойтись на границе секунды.
    const now = new Date();
    return rows.map(({ m, u }) => ({
      user: {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        // 🔴 Аренда проверяется И ЗДЕСЬ. Это ростер, и именно он кормит все аватарки на экране —
        // без проверки анимация не гасла ни у кого, кроме самого покупателя (разбор в `animatedAvatarFor`).
        animatedAvatarUrl: animatedAvatarFor(u.animatedAvatarUrl, u.animatedAvatarUntil, now),
        ...statusFieldsOf(u, Date.now()),
      },
      nickname: m.nickname,
      roleIds: rolesByUser.get(u.id) ?? [],
      joinedAt: m.joinedAt.toISOString(),
    }));
  });

  // Kick a member (KICK_MEMBERS). Cannot kick the owner or yourself.
  app.delete('/servers/:id/members/:userId', async (req, reply) => {
    const { id: serverId, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.KICK_MEMBERS)) return reply.code(403).send({ error: 'forbidden' });

    const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (server?.ownerId === userId) return reply.code(400).send({ error: 'cannot kick the owner' });
    if (userId === req.user!.sub) return reply.code(400).send({ error: 'cannot kick yourself' });

    // Hierarchy: you can only kick members whose highest role is strictly below yours.
    const targetCtx = await getMemberContext(serverId, userId);
    if (targetCtx && highestPosition(targetCtx) >= highestPosition(ctx)) {
      return reply.code(403).send({ error: 'нельзя кикнуть того, чья роль выше или равна твоей' });
    }

    const [kicked] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    await db.delete(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
    await db.delete(memberRoles).where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, userId)));
    await writeAudit(serverId, req.user!.sub, 'member.kick', {
      targetType: 'member',
      targetId: userId,
      data: { username: kicked?.username, displayName: kicked?.displayName },
    });
    // 🔴 Раньше здесь не публиковалось НИЧЕГО (#91): ростер у остальных не обновлялся, а у
    // исключённого оставалась живая подписка на сервер, по которой он продолжал получать поток до
    // переподключения. Гейтвей на этом событии снимает подписки тех, кто больше не участник.
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.code(204).send();
  });

  // Покинуть сервер по своей воле (#92). Прав не требует — уйти вправе любой участник.
  app.post('/servers/:id/leave', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.user!.sub;

    // ⚠️ Проверяем ЧЛЕНСТВО НАПРЯМУЮ, а не через getMemberContext: тот отдаёт супер-админу
    // виртуальный контекст на любом сервере, и «выход» превратился бы в no-op с кодом 204.
    const [member] = await db
      .select()
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
      .limit(1);
    if (!member) return reply.code(404).send({ error: 'not a member' });

    const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    // Владельцу уходить некуда: сервер остался бы без хозяина. Тот же гард, что у кика и у
    // удаления аккаунта.
    if (server?.ownerId === userId) {
      return reply.code(400).send({ error: 'владелец не может выйти — передайте владение или удалите сервер' });
    }

    await db.delete(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
    await db.delete(memberRoles).where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, userId)));
    await writeAudit(serverId, userId, 'member.leave', { targetType: 'member', targetId: userId });
    // Ростер у остальных обновится, а гейтвей на этом событии снимет подписку у ушедшего (#91) —
    // иначе он продолжал бы получать поток сервера до переподключения.
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.code(204).send();
  });

  // Ban a user (BAN_MEMBERS): record the ban, remove their membership, block re-join via invite.
  // Same owner/self/hierarchy guards as kick. The target need not currently be a member.
  app.post('/servers/:id/members/:userId/ban', async (req, reply) => {
    const { id: serverId, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params);
    const body = z.object({ reason: z.string().max(512).optional() }).parse(req.body ?? {});
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.BAN_MEMBERS)) return reply.code(403).send({ error: 'forbidden' });

    const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (server?.ownerId === userId) return reply.code(400).send({ error: 'нельзя забанить владельца' });
    if (userId === req.user!.sub) return reply.code(400).send({ error: 'нельзя забанить себя' });

    const targetCtx = await getMemberContext(serverId, userId);
    if (targetCtx && highestPosition(targetCtx) >= highestPosition(ctx)) {
      return reply.code(403).send({ error: 'нельзя забанить того, чья роль выше или равна твоей' });
    }

    const [banned] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!banned) return reply.code(404).send({ error: 'пользователь не найден' });
    const reason = body.reason?.trim() || null;
    await db
      .insert(bans)
      .values({ serverId, userId, reason, bannedBy: req.user!.sub })
      .onConflictDoUpdate({ target: [bans.serverId, bans.userId], set: { reason, bannedBy: req.user!.sub, createdAt: new Date() } });
    await db.delete(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
    await db.delete(memberRoles).where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, userId)));
    await writeAudit(serverId, req.user!.sub, 'member.ban', {
      targetType: 'member',
      targetId: userId,
      data: { username: banned.username, displayName: banned.displayName, reason },
    });
    // См. комментарий в кике: без этого забаненный оставался подписанным на поток сервера.
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.code(204).send();
  });

  // List a server's bans (BAN_MEMBERS).
  app.get('/servers/:id/bans', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.BAN_MEMBERS)) return reply.code(403).send({ error: 'forbidden' });

    const rows = await db
      .select({ b: bans, u: users })
      .from(bans)
      .innerJoin(users, eq(bans.userId, users.id))
      .where(eq(bans.serverId, serverId));
    return rows.map(({ b, u }) => ({
      user: { id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl },
      reason: b.reason,
      bannedBy: b.bannedBy,
      createdAt: b.createdAt.toISOString(),
    }));
  });

  // Lift a ban (BAN_MEMBERS).
  app.delete('/servers/:id/bans/:userId', async (req, reply) => {
    const { id: serverId, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.BAN_MEMBERS)) return reply.code(403).send({ error: 'forbidden' });

    const [unbanned] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    await db.delete(bans).where(and(eq(bans.serverId, serverId), eq(bans.userId, userId)));
    await writeAudit(serverId, req.user!.sub, 'member.unban', {
      targetType: 'member',
      targetId: userId,
      data: { username: unbanned?.username, displayName: unbanned?.displayName },
    });
    // Живую подписку не трогает (человека и так нет на сервере) — но открытый список банов
    // у модератора иначе остаётся устаревшим до переоткрытия.
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.code(204).send();
  });

  // Delete a server (owner or super-admin only). FK cascades remove its data.
  app.delete('/servers/:id', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!ctx.isOwner) return reply.code(403).send({ error: 'only the owner can delete the server' });
    await db.delete(servers).where(eq(servers.id, serverId));
    // ⚠️ ПОСЛЕ удаления: клиенты перезапрашивают и видят, что сервера больше нет, а гейтвей на этом
    // же событии снимает подписки (членства уже нет — каскад его убрал). Опубликуй мы ДО, клиенты
    // успели бы перечитать ещё живой сервер и остались бы с фантомом в рейле до перезагрузки.
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.code(204).send();
  });

  // Transfer ownership to another member (current owner / super-admin only).
  app.post('/servers/:id/transfer', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ newOwnerId: z.string() }).parse(req.body);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!ctx.isOwner) return reply.code(403).send({ error: 'передавать владение может только владелец' });

    const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!server) return reply.code(404).send({ error: 'not found' });
    if (body.newOwnerId === server.ownerId) return reply.code(400).send({ error: 'этот участник уже владелец' });
    const targetCtx = await getMemberContext(serverId, body.newOwnerId);
    if (!targetCtx) return reply.code(400).send({ error: 'новый владелец должен быть участником сервера' });

    const [target] = await db.select().from(users).where(eq(users.id, body.newOwnerId)).limit(1);
    await db.update(servers).set({ ownerId: body.newOwnerId }).where(eq(servers.id, serverId));
    await writeAudit(serverId, req.user!.sub, 'server.transfer', {
      targetType: 'member',
      targetId: body.newOwnerId,
      data: { username: target?.username, displayName: target?.displayName },
    });
    // Both the old and new owner re-evaluate their server permissions/owner status.
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.code(204).send();
  });

  /**
   * Свой ник в пределах сервера (#19).
   *
   * Только СВОЙ и намеренно: менять ник другому человеку — это переименовать его без спроса, и
   * ради такого не стоит заводить ни право, ни модерацию. Не настроен — везде показывается обычное
   * имя, как и было.
   *
   * Пустая строка снимает ник. Строка сначала обрезается: ник из одних пробелов дал бы человека
   * без имени в списке участников и в чате.
   */
  app.patch('/servers/:id/nickname', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ nickname: z.string().max(32).nullable() }).parse(req.body);
    const me = req.user!.sub;

    const ctx = await getMemberContext(serverId, me);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });

    const trimmed = body.nickname?.trim() ?? '';
    const nickname = trimmed === '' ? null : trimmed;

    await db
      .update(serverMembers)
      .set({ nickname })
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, me)));

    // В журнал не пишем: человек переименовал сам себя, модерации тут нет.
    await publishToServer(serverId, { t: 'member.update', serverId, userId: me, nickname });
    return { nickname };
  });

  /**
   * Иконка сервера (#74). Кладём в MinIO, в базе — только ссылка, как у аватаров.
   *
   * Ключ по `serverId` + метка времени: старый файл остаётся в бакете намеренно. Он мог попасть
   * в чей-то кэш и в открытые вкладки, а битая картинка вместо иконки выглядит как поломка.
   */
  app.post('/servers/:id/icon', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_SERVER))
      return reply.code(403).send({ error: 'forbidden' });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'нет файла' });
    // isSupportedImage — только картинки; SVG сюда не проходит (исполняемый документ).
    if (!isSupportedImage(file.mimetype))
      return reply.code(400).send({ error: 'нужен PNG, JPEG, WebP или GIF' });

    const buffer = await file.toBuffer();
    if (buffer.length > MAX_ICON_BYTES)
      return reply.code(413).send({ error: `файл больше ${Math.round(MAX_ICON_BYTES / 1024 / 1024)} МБ` });

    let iconUrl: string;
    try {
      iconUrl = await putMedia('server-icons', serverId, buffer, file.mimetype, Date.now());
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'не удалось загрузить' });
    }

    const [row] = await db.update(servers).set({ iconUrl }).where(eq(servers.id, serverId)).returning();
    await writeAudit(serverId, req.user!.sub, 'server.update', { data: { iconUrl } });
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return serializeServer(row);
  });

  // ---- кастомные эмодзи сервера (#18) --------------------------------------------------------

  /**
   * Загрузить эмодзи (multipart-файл + имя в query).
   *
   * Имя едет параметром запроса, а НЕ полем формы: `file.fields` содержит только те поля, что
   * пришли ДО файла, и запись становится молча зависимой от порядка `fd.append()` на клиенте.
   * Query от порядка не зависит вовсе.
   *
   * Все проверки — из `shared/emojiRules`, тех же, что использует клиент. Клиентская проверка
   * нужна, чтобы не отправлять заведомо отказной запрос; защита — вот эта.
   */
  app.post('/servers/:id/emojis', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const { name: rawName } = z.object({ name: z.string().default('') }).parse(req.query);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_EMOJIS))
      return reply.code(403).send({ error: 'forbidden' });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'нет файла' });

    const nameCheck = checkEmojiName(rawName);
    if (!nameCheck.ok) return reply.code(400).send({ error: nameCheck.error });

    const buffer = await file.toBuffer();
    const existing = await db.select().from(serverEmojis).where(eq(serverEmojis.serverId, serverId));
    const upCheck = checkEmojiUpload(file.mimetype, buffer.length, existing.length);
    if (!upCheck.ok) return reply.code(400).send({ error: upCheck.error });

    if (existing.some((e) => e.name === nameCheck.name))
      return reply.code(409).send({ error: `эмодзи :${nameCheck.name}: уже есть` });

    const emojiId = id();
    let url: string;
    try {
      url = await putMedia('emoji', emojiId, buffer, file.mimetype, Date.now());
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'не удалось загрузить' });
    }

    const [row] = await db
      .insert(serverEmojis)
      .values({ id: emojiId, serverId, name: nameCheck.name, url, createdBy: req.user!.sub })
      .returning();

    // Переиспользуем `server.invalidate` вместо своего события: эмодзи меняются редко, а лишний
    // тип в протоколе пришлось бы поддерживать вечно.
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return { id: row.id, name: row.name, url: row.url };
  });

  // ---- наборы стикеров из Telegram (#68) -----------------------------------------------------

  /**
   * Импортировать набор по ссылке или имени.
   *
   * Файлы копируются К НАМ в MinIO, а не отдаются ссылками на серверы Telegram. Причины две:
   * ссылки Bot API живут ограниченное время и протухли бы прямо в истории чата, а каждая такая
   * картинка в чужом чате — это ещё и обращение участника к Telegram, то есть утечка того, кто и
   * когда открыл наш чат.
   *
   * Импорт последовательный, а не `Promise.all`: 120 одновременных скачиваний — верный способ
   * получить 429 от Bot API и половину набора битой.
   */
  app.post('/servers/:id/sticker-packs', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const { name: rawName } = z.object({ name: z.string() }).parse(req.body);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_STICKERS))
      return reply.code(403).send({ error: 'forbidden' });
    if (!telegramConfigured())
      return reply.code(503).send({ error: 'импорт стикеров не настроен на этом сервере' });

    const parsed = parseStickerSetName(rawName);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    const existing = await db.select().from(stickerPacks).where(eq(stickerPacks.serverId, serverId));
    if (existing.some((p) => p.name === parsed.name))
      return reply.code(409).send({ error: 'этот набор уже импортирован' });

    let set;
    try {
      set = await getStickerSet(parsed.name);
    } catch (err) {
      const e = err as TelegramError;
      return reply.code(e.statusCode ?? 502).send({ error: e.message });
    }

    const sizeCheck = checkPackImport(set.stickers.length, existing.length);
    if (!sizeCheck.ok) return reply.code(400).send({ error: sizeCheck.error });

    const packId = id();
    const rows: (typeof stickers.$inferInsert)[] = [];
    let skipped = 0;
    for (const [i, tg] of set.stickers.entries()) {
      let got;
      try {
        got = await downloadSticker(tg.file_id);
      } catch (err) {
        const e = err as TelegramError;
        return reply.code(e.statusCode ?? 502).send({ error: e.message });
      }
      // Незнакомый формат или слишком крупный файл — пропускаем ОДИН стикер, а не весь набор:
      // из-за одной странной записи терять сто нормальных незачем.
      if (!got) {
        skipped++;
        continue;
      }
      const stickerId = id();
      let url: string;
      try {
        url = await putMedia('stickers', stickerId, got.buffer, STICKER_MIME[got.format], Date.now());
      } catch (err) {
        const e = err as { statusCode?: number; message?: string };
        return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'не удалось сохранить стикер' });
      }
      rows.push({ id: stickerId, packId, emoji: tg.emoji ?? '', url, format: got.format, position: i });
    }

    if (!rows.length) return reply.code(400).send({ error: 'ни один стикер набора не удалось загрузить' });

    await db.insert(stickerPacks).values({
      id: packId,
      serverId,
      name: parsed.name,
      title: set.title,
      createdBy: req.user!.sub,
    });
    await db.insert(stickers).values(rows);

    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return { id: packId, name: parsed.name, title: set.title, count: rows.length, skipped };
  });

  /**
   * Удалить набор. Стикеры уходят каскадом, но уже ОТПРАВЛЕННЫЕ сообщения не трогаем:
   * стикер лежит в них копией (миграция 0028), поэтому история остаётся целой.
   */
  app.delete('/servers/:id/sticker-packs/:packId', async (req, reply) => {
    const { id: serverId, packId } = z.object({ id: z.string(), packId: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_STICKERS))
      return reply.code(403).send({ error: 'forbidden' });

    const [row] = await db
      .delete(stickerPacks)
      .where(and(eq(stickerPacks.id, packId), eq(stickerPacks.serverId, serverId)))
      .returning();
    if (!row) return reply.code(404).send({ error: 'not found' });

    // Файлы в MinIO намеренно НЕ удаляем — на них ссылаются отправленные сообщения.
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.code(204).send();
  });

  /** Удалить эмодзи. Уже проставленные реакции остаются — они ключуются id и просто осиротеют. */
  app.delete('/servers/:id/emojis/:emojiId', async (req, reply) => {
    const { id: serverId, emojiId } = z.object({ id: z.string(), emojiId: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_EMOJIS))
      return reply.code(403).send({ error: 'forbidden' });

    const [row] = await db
      .delete(serverEmojis)
      .where(and(eq(serverEmojis.id, emojiId), eq(serverEmojis.serverId, serverId)))
      .returning();
    if (!row) return reply.code(404).send({ error: 'not found' });

    // Файл в MinIO намеренно НЕ удаляем: на него ссылаются уже отправленные сообщения, и битая
    // картинка в старой переписке хуже, чем несколько килобайт в бакете.
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.code(204).send();
  });
}
