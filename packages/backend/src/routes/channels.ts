import { CHANNEL_ICONS, has, isVoiceBitrate, Permission, permsFromString, permsToString } from '@gusvoice/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { db } from '../db/index.js';
import { categories, categoryOverwrites, channelOverwrites, channels } from '../db/schema.js';
import { getChannelAudience, getChannelPermissions, getMemberContext } from '../permissions.js';
import { publishToChannel, publishToServer } from '../realtime.js';
import { serializeCategory, serializeChannel } from '../serialize.js';
import { isSupportedImage, putMedia, storageConfigured } from '../storage.js';
import { id } from '../util.js';

const permString = z.string().regex(/^\d+$/);
const overwriteBody = z.object({ allow: permString.default('0'), deny: permString.default('0') });
const targetParams = z.object({
  id: z.string(),
  targetType: z.enum(['role', 'member']),
  targetId: z.string(),
});

export async function channelRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Appoint (or clear) the channel's "general" — owner / MANAGE_SERVER only. One user per channel.
  app.put('/channels/:id/general', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
    const { userId } = z.object({ userId: z.string().nullable() }).parse(req.body);
    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
    if (!channel) return reply.code(404).send({ error: 'not found' });
    // A "general" only exists to manage voice sounds — text channels can't have one.
    if (channel.type !== 'voice') return reply.code(400).send({ error: 'только для голосовых каналов' });
    const ctx = await getMemberContext(channel.serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!ctx.isOwner && !has(ctx.serverPermissions, Permission.MANAGE_SERVER)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (userId) {
      const target = await getMemberContext(channel.serverId, userId);
      if (!target) return reply.code(400).send({ error: 'пользователь не состоит на сервере' });
    }
    await db.update(channels).set({ generalUserId: userId }).where(eq(channels.id, channelId));
    await writeAudit(channel.serverId, req.user!.sub, userId ? 'channel.general.set' : 'channel.general.clear', {
      targetType: 'channel',
      targetId: channelId,
      data: { userId },
    });
    await publishToServer(channel.serverId, { t: 'server.invalidate', serverId: channel.serverId });
    return reply.send({ ok: true });
  });

  // Create a category.
  app.post('/servers/:id/categories', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const { name } = z.object({ name: z.string().min(1).max(80) }).parse(req.body);

    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_CHANNELS)) return reply.code(403).send({ error: 'forbidden' });

    const count = (await db.select().from(categories).where(eq(categories.serverId, serverId))).length;
    const [row] = await db.insert(categories).values({ id: id(), serverId, name, position: count }).returning();
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    await writeAudit(serverId, req.user!.sub, 'category.create', {
      targetType: 'category',
      targetId: row.id,
      data: { name: row.name },
    });
    return reply.code(201).send(serializeCategory(row));
  });

  // Rename a category. MANAGE_CHANNELS on the server.
  app.patch('/categories/:id', async (req, reply) => {
    const { id: categoryId } = z.object({ id: z.string() }).parse(req.params);
    const { name } = z.object({ name: z.string().min(1).max(80) }).parse(req.body);

    const [cat] = await db.select().from(categories).where(eq(categories.id, categoryId)).limit(1);
    if (!cat) return reply.code(404).send({ error: 'not found' });
    const ctx = await getMemberContext(cat.serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_CHANNELS)) return reply.code(403).send({ error: 'forbidden' });

    const [row] = await db.update(categories).set({ name }).where(eq(categories.id, categoryId)).returning();
    await publishToServer(cat.serverId, { t: 'server.invalidate', serverId: cat.serverId });
    await writeAudit(cat.serverId, req.user!.sub, 'category.update', {
      targetType: 'category',
      targetId: categoryId,
      data: { name },
    });
    return reply.send(serializeCategory(row));
  });

  // Reorder categories (the client sends the full desired position for every category). MANAGE_CHANNELS.
  app.put('/servers/:id/categories/reorder', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const { items } = z
      .object({
        items: z
          .array(z.object({ categoryId: z.string(), position: z.number().int().min(0) }))
          .min(1)
          .max(200),
      })
      .parse(req.body);

    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_CHANNELS)) return reply.code(403).send({ error: 'forbidden' });

    const own = new Set((await db.select().from(categories).where(eq(categories.serverId, serverId))).map((c) => c.id));
    for (const it of items) {
      if (!own.has(it.categoryId)) return reply.code(400).send({ error: 'category not in server' });
    }

    await db.transaction(async (tx) => {
      for (const it of items) {
        await tx
          .update(categories)
          .set({ position: it.position })
          .where(and(eq(categories.id, it.categoryId), eq(categories.serverId, serverId)));
      }
    });
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    await writeAudit(serverId, req.user!.sub, 'category.reorder', {
      targetType: 'server',
      targetId: serverId,
      data: { count: items.length },
    });
    return reply.code(204).send();
  });

  // Create a channel (text or voice).
  app.post('/servers/:id/channels', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(80),
        type: z.enum(['text', 'voice']),
        categoryId: z.string().nullable().optional(),
        topic: z.string().max(1024).optional(),
      })
      .parse(req.body);

    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_CHANNELS)) return reply.code(403).send({ error: 'forbidden' });

    const count = (await db.select().from(channels).where(eq(channels.serverId, serverId))).length;
    const [row] = await db
      .insert(channels)
      .values({
        id: id(),
        serverId,
        categoryId: body.categoryId ?? null,
        name: body.name,
        type: body.type,
        topic: body.topic ?? null,
        position: count,
      })
      .returning();

    const channel = serializeChannel(row);
    await publishToChannel(serverId, channel.id, { t: 'channel.create', channel });
    await writeAudit(serverId, req.user!.sub, 'channel.create', {
      targetType: 'channel',
      targetId: row.id,
      data: { name: row.name, type: row.type },
    });
    return reply.code(201).send(channel);
  });

  // Update a channel.
  app.patch('/channels/:id', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        topic: z.string().max(1024).nullable().optional(),
        position: z.number().int().optional(),
        categoryId: z.string().nullable().optional(),
        syncedToCategory: z.boolean().optional(),
        icon: z
          .string()
          .refine(
            (v) => (CHANNEL_ICONS as readonly string[]).includes(v) || /^https?:\/\/[^\s]+\/channel-icons\//.test(v),
            'unknown icon',
          )
          .nullable()
          .optional(),
        // Качество звука канала (#101). null = «как у всех», значение — только из списка пресетов:
        // произвольное число здесь означало бы, что кто-то может выставить каналу 510 кбит/с и
        // положить входящий канал всем слушателям сразу.
        voiceBitrate: z
          .number()
          .int()
          .refine(isVoiceBitrate, 'unknown bitrate')
          .nullable()
          .optional(),
      })
      .parse(req.body);

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.MANAGE_CHANNELS)) return reply.code(403).send({ error: 'forbidden' });

    // The target category must belong to THIS server (P3-3) — a cross-server categoryId contaminates the
    // channel tree / overwrites. (null clears the category; undefined leaves it unchanged.)
    if (body.categoryId) {
      const [cat] = await db
        .select({ serverId: categories.serverId })
        .from(categories)
        .where(eq(categories.id, body.categoryId))
        .limit(1);
      if (!cat || cat.serverId !== perms.serverId) return reply.code(400).send({ error: 'категория другого сервера' });
    }

    // Битрейт есть только у голосового канала: у текстового он ничего не значит, а молча принятое
    // поле потом читается как «настройка есть, просто не работает».
    if (body.voiceBitrate !== undefined) {
      const [ch] = await db.select({ type: channels.type }).from(channels).where(eq(channels.id, channelId)).limit(1);
      if (ch?.type !== 'voice') return reply.code(400).send({ error: 'качество звука есть только у голосового канала' });
    }

    const [row] = await db.update(channels).set(body).where(eq(channels.id, channelId)).returning();
    const channel = serializeChannel(row);
    await publishToChannel(perms.serverId, channel.id, { t: 'channel.update', channel });
    // Re-parenting or (un)syncing to a category can change which members may see the channel.
    if (body.syncedToCategory !== undefined || body.categoryId !== undefined) {
      await publishToServer(perms.serverId, { t: 'server.invalidate', serverId: perms.serverId });
    }
    await writeAudit(perms.serverId, req.user!.sub, 'channel.update', {
      targetType: 'channel',
      targetId: channelId,
      data: { name: row.name, changed: Object.keys(body) },
    });
    return channel;
  });

  // Bulk reorder / re-parent channels (drag-and-drop). MANAGE_CHANNELS on the server.
  // The client sends the full desired (categoryId, position) for every channel it moved;
  // positions are applied as-is so the client owns the ordering math.
  app.put('/servers/:id/channels/reorder', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const { items } = z
      .object({
        items: z
          .array(
            z.object({
              channelId: z.string(),
              categoryId: z.string().nullable(),
              position: z.number().int().min(0),
            }),
          )
          .min(1)
          .max(500),
      })
      .parse(req.body);

    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_CHANNELS)) return reply.code(403).send({ error: 'forbidden' });

    // Every referenced channel + category must belong to THIS server.
    const own = await db.select().from(channels).where(eq(channels.serverId, serverId));
    const byId = new Map(own.map((c) => [c.id, c]));
    const catIds = new Set((await db.select().from(categories).where(eq(categories.serverId, serverId))).map((c) => c.id));
    for (const it of items) {
      if (!byId.has(it.channelId)) return reply.code(400).send({ error: 'channel not in server' });
      if (it.categoryId !== null && !catIds.has(it.categoryId)) {
        return reply.code(400).send({ error: 'category not in server' });
      }
    }

    // Re-parenting (not just reordering) can change who can see the channel.
    const reparented = items.some((it) => (byId.get(it.channelId)!.categoryId ?? null) !== it.categoryId);

    await db.transaction(async (tx) => {
      for (const it of items) {
        await tx
          .update(channels)
          .set({ categoryId: it.categoryId, position: it.position })
          .where(and(eq(channels.id, it.channelId), eq(channels.serverId, serverId)));
      }
    });

    // server.invalidate makes every client (incl. the actor) refetch bootstrap and
    // re-render the tree in the new order with correct visibility.
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    await writeAudit(serverId, req.user!.sub, 'channel.reorder', {
      targetType: 'server',
      targetId: serverId,
      data: { count: items.length, reparented },
    });
    return reply.code(204).send();
  });

  // Delete a channel.
  app.delete('/channels/:id', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.MANAGE_CHANNELS)) return reply.code(403).send({ error: 'forbidden' });

    const [existing] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    // ⚠️ Аудиторию берём ДО удаления: после `DELETE` считать её уже не по чему, а разослать
    // «канал удалён» всем оставшимся значило бы выдать сам факт существования скрытого канала.
    const audience = await getChannelAudience(channelId);
    await db.delete(channels).where(eq(channels.id, channelId));
    await publishToChannel(
      perms.serverId,
      channelId,
      { t: 'channel.delete', serverId: perms.serverId, channelId },
      audience?.userIds ?? [],
    );
    await writeAudit(perms.serverId, req.user!.sub, 'channel.delete', {
      targetType: 'channel',
      targetId: channelId,
      data: { name: existing?.name },
    });
    return reply.code(204).send();
  });

  // Upload a custom channel icon image (MANAGE_CHANNELS) → sets channels.icon to its public URL.
  app.post('/channels/:id/icon', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.MANAGE_CHANNELS)) return reply.code(403).send({ error: 'forbidden' });
    if (!storageConfigured()) return reply.code(503).send({ error: 'хранилище иконок не настроено' });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no file' });
    const mime = file.mimetype || '';
    if (!isSupportedImage(mime)) {
      return reply.code(400).send({ error: 'формат не поддерживается — нужен PNG, JPEG, WEBP или GIF' });
    }
    const buffer = await file.toBuffer();
    if (buffer.length > 512 * 1024) return reply.code(400).send({ error: 'файл больше 512 КБ' });

    const url = await putMedia('channel-icons', channelId, buffer, mime, Date.now());
    const [row] = await db.update(channels).set({ icon: url }).where(eq(channels.id, channelId)).returning();
    const channel = serializeChannel(row);
    await publishToChannel(perms.serverId, channel.id, { t: 'channel.update', channel });
    await writeAudit(perms.serverId, req.user!.sub, 'channel.update', {
      targetType: 'channel',
      targetId: channelId,
      data: { name: row.name, changed: ['icon'] },
    });
    return reply.send(channel);
  });

  // ----- permission overwrites (channel) -----

  // List a channel's overwrites (needs MANAGE_ROLES on the channel).
  app.get('/channels/:id/overwrites', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.MANAGE_ROLES)) return reply.code(403).send({ error: 'forbidden' });
    const rows = await db.select().from(channelOverwrites).where(eq(channelOverwrites.channelId, channelId));
    return rows.map((r) => ({ targetType: r.targetType, targetId: r.targetId, allow: r.allow, deny: r.deny }));
  });

  // Upsert one overwrite. You may only toggle permissions you yourself hold here; allow wins ties.
  app.put('/channels/:id/overwrites/:targetType/:targetId', async (req, reply) => {
    const { id: channelId, targetType, targetId } = targetParams.parse(req.params);
    const body = overwriteBody.parse(req.body ?? {});
    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.MANAGE_ROLES)) return reply.code(403).send({ error: 'forbidden' });

    const allow = permsFromString(body.allow) & perms.permissions;
    const deny = (permsFromString(body.deny) & perms.permissions) & ~allow;
    if (allow === 0n && deny === 0n) {
      await db
        .delete(channelOverwrites)
        .where(and(eq(channelOverwrites.channelId, channelId), eq(channelOverwrites.targetId, targetId)));
    } else {
      await db
        .insert(channelOverwrites)
        .values({ channelId, targetId, targetType, allow: permsToString(allow), deny: permsToString(deny) })
        .onConflictDoUpdate({
          target: [channelOverwrites.channelId, channelOverwrites.targetId],
          set: { targetType, allow: permsToString(allow), deny: permsToString(deny) },
        });
    }
    await publishToServer(perms.serverId, { t: 'server.invalidate', serverId: perms.serverId });
    await writeAudit(perms.serverId, req.user!.sub, 'channel.overwrite.update', {
      targetType: 'channel',
      targetId: channelId,
      data: { target: { type: targetType, id: targetId }, allow: permsToString(allow), deny: permsToString(deny) },
    });
    return reply.code(204).send();
  });

  app.delete('/channels/:id/overwrites/:targetType/:targetId', async (req, reply) => {
    const { id: channelId, targetType, targetId } = targetParams.parse(req.params);
    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.MANAGE_ROLES)) return reply.code(403).send({ error: 'forbidden' });
    await db
      .delete(channelOverwrites)
      .where(and(eq(channelOverwrites.channelId, channelId), eq(channelOverwrites.targetId, targetId)));
    await publishToServer(perms.serverId, { t: 'server.invalidate', serverId: perms.serverId });
    await writeAudit(perms.serverId, req.user!.sub, 'channel.overwrite.delete', {
      targetType: 'channel',
      targetId: channelId,
      data: { target: { type: targetType, id: targetId } },
    });
    return reply.code(204).send();
  });

  // ----- permission overwrites (category) — inherited by synced channels -----

  async function categoryCtx(categoryId: string, userId: string) {
    const [cat] = await db.select().from(categories).where(eq(categories.id, categoryId)).limit(1);
    if (!cat) return null;
    const ctx = await getMemberContext(cat.serverId, userId);
    if (!ctx || !has(ctx.serverPermissions, Permission.MANAGE_ROLES)) return null;
    return { cat, ctx };
  }

  app.get('/categories/:id/overwrites', async (req, reply) => {
    const { id: categoryId } = z.object({ id: z.string() }).parse(req.params);
    const c = await categoryCtx(categoryId, req.user!.sub);
    if (!c) return reply.code(403).send({ error: 'forbidden' });
    const rows = await db.select().from(categoryOverwrites).where(eq(categoryOverwrites.categoryId, categoryId));
    return rows.map((r) => ({ targetType: r.targetType, targetId: r.targetId, allow: r.allow, deny: r.deny }));
  });

  app.put('/categories/:id/overwrites/:targetType/:targetId', async (req, reply) => {
    const { id: categoryId, targetType, targetId } = targetParams.parse(req.params);
    const body = overwriteBody.parse(req.body ?? {});
    const c = await categoryCtx(categoryId, req.user!.sub);
    if (!c) return reply.code(403).send({ error: 'forbidden' });

    const allow = permsFromString(body.allow) & c.ctx.serverPermissions;
    const deny = (permsFromString(body.deny) & c.ctx.serverPermissions) & ~allow;
    if (allow === 0n && deny === 0n) {
      await db
        .delete(categoryOverwrites)
        .where(and(eq(categoryOverwrites.categoryId, categoryId), eq(categoryOverwrites.targetId, targetId)));
    } else {
      await db
        .insert(categoryOverwrites)
        .values({ categoryId, targetId, targetType, allow: permsToString(allow), deny: permsToString(deny) })
        .onConflictDoUpdate({
          target: [categoryOverwrites.categoryId, categoryOverwrites.targetId],
          set: { targetType, allow: permsToString(allow), deny: permsToString(deny) },
        });
    }
    // Synced channels inherit this — tell clients to re-evaluate visibility now.
    await publishToServer(c.cat.serverId, { t: 'server.invalidate', serverId: c.cat.serverId });
    await writeAudit(c.cat.serverId, req.user!.sub, 'category.overwrite.update', {
      targetType: 'category',
      targetId: categoryId,
      data: { target: { type: targetType, id: targetId }, allow: permsToString(allow), deny: permsToString(deny) },
    });
    return reply.code(204).send();
  });

  app.delete('/categories/:id/overwrites/:targetType/:targetId', async (req, reply) => {
    const { id: categoryId, targetType, targetId } = targetParams.parse(req.params);
    const c = await categoryCtx(categoryId, req.user!.sub);
    if (!c) return reply.code(403).send({ error: 'forbidden' });
    await db
      .delete(categoryOverwrites)
      .where(and(eq(categoryOverwrites.categoryId, categoryId), eq(categoryOverwrites.targetId, targetId)));
    await publishToServer(c.cat.serverId, { t: 'server.invalidate', serverId: c.cat.serverId });
    await writeAudit(c.cat.serverId, req.user!.sub, 'category.overwrite.delete', {
      targetType: 'category',
      targetId: categoryId,
      data: { target: { type: targetType, id: targetId } },
    });
    return reply.code(204).send();
  });

  // Delete a category (its channels keep existing, uncategorized).
  app.delete('/categories/:id', async (req, reply) => {
    const { id: categoryId } = z.object({ id: z.string() }).parse(req.params);
    const [cat] = await db.select().from(categories).where(eq(categories.id, categoryId)).limit(1);
    if (!cat) return reply.code(404).send({ error: 'not found' });

    const ctx = await getMemberContext(cat.serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_CHANNELS)) return reply.code(403).send({ error: 'forbidden' });

    await db.delete(categories).where(eq(categories.id, categoryId));
    await publishToServer(cat.serverId, { t: 'server.invalidate', serverId: cat.serverId });
    await writeAudit(cat.serverId, req.user!.sub, 'category.delete', {
      targetType: 'category',
      targetId: categoryId,
      data: { name: cat.name },
    });
    return reply.code(204).send();
  });
}
