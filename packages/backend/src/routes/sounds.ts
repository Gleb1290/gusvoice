import { has, Permission } from '@gusvoice/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { db } from '../db/index.js';
import { channels, channelSounds, serverSounds } from '../db/schema.js';
import { getMemberContext } from '../permissions.js';
import { publishToServer } from '../realtime.js';
import { putSound, resolveAudioMime, storageConfigured } from '../storage.js';

/**
 * Событиям, которые клиент ПОКАЗЫВАЕТ в панелях загрузки (`EVENTS` в Channel/ServerSoundsPanel).
 *
 * 🔴 Список обязан совпадать с панелями, а не с union'ом `SoundEvent`: строка в панели без записи
 * здесь = кнопка, которая отдаёт 400. Именно это и случилось с `tip` — он висел в панелях с этапа 2,
 * а сюда его добавить забыли, и загрузка своего звука типа не работала вовсе (найдено 02.09).
 */
const SOUND_EVENTS = ['join', 'leave', 'mute', 'unmute', 'deafen', 'undeafen', 'dm', 'mention', 'stream', 'streamStop', 'move', 'tip', 'coins'] as const;
const eventSchema = z.enum(SOUND_EVENTS);

export async function soundRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Upload a custom sound for one event (MANAGE_SOUNDS). Replaces any existing one.
  app.post('/servers/:id/sounds/:event', async (req, reply) => {
    const { id: serverId, event } = z.object({ id: z.string(), event: eventSchema }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_SOUNDS)) return reply.code(403).send({ error: 'forbidden' });
    if (!storageConfigured()) return reply.code(503).send({ error: 'хранилище звуков не настроено' });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no file' });
    // Тип решают БАЙТЫ, а не подпись браузера: разбор в `resolveAudioMime`.
    const buffer = await file.toBuffer();
    const mime = resolveAudioMime(file.mimetype || '', new Uint8Array(buffer));
    if (!mime) {
      return reply.code(400).send({ error: 'формат не поддерживается — нужен MP3, OGG, WAV, WEBM или M4A' });
    }
    if (buffer.length > 512 * 1024) return reply.code(400).send({ error: 'файл больше 512 КБ' });

    const url = await putSound(serverId, event, buffer, mime, Date.now());
    await db
      .insert(serverSounds)
      .values({ serverId, event, url })
      .onConflictDoUpdate({
        target: [serverSounds.serverId, serverSounds.event],
        set: { url, updatedAt: new Date() },
      });
    await writeAudit(serverId, req.user!.sub, 'sound.set', { targetType: 'server', targetId: serverId, data: { event } });
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.send({ event, url });
  });

  // Clear a custom sound — revert to the synthesized default (MANAGE_SOUNDS).
  app.delete('/servers/:id/sounds/:event', async (req, reply) => {
    const { id: serverId, event } = z.object({ id: z.string(), event: eventSchema }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_SOUNDS)) return reply.code(403).send({ error: 'forbidden' });

    await db.delete(serverSounds).where(and(eq(serverSounds.serverId, serverId), eq(serverSounds.event, event)));
    await writeAudit(serverId, req.user!.sub, 'sound.clear', { targetType: 'server', targetId: serverId, data: { event } });
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.code(204).send();
  });

  // --- Per-CHANNEL sound overrides — the channel's "general" or a MANAGE_SOUNDS holder. ---

  // Authorize: returns the channel + member ctx, or sends an error reply (caller returns on null).
  async function authChannelSound(req: FastifyRequest, reply: FastifyReply) {
    const { id: channelId, event } = z.object({ id: z.string(), event: eventSchema }).parse(req.params);
    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
    if (!channel) {
      await reply.code(404).send({ error: 'not found' });
      return null;
    }
    if (channel.type !== 'voice') {
      // Channel sounds are voice events (join/leave/mute/…) — text channels have none.
      await reply.code(400).send({ error: 'только для голосовых каналов' });
      return null;
    }
    const ctx = await getMemberContext(channel.serverId, req.user!.sub);
    if (!ctx) {
      await reply.code(404).send({ error: 'not a member' });
      return null;
    }
    if (channel.generalUserId !== req.user!.sub && !has(ctx.serverPermissions, Permission.MANAGE_SOUNDS)) {
      await reply.code(403).send({ error: 'forbidden' });
      return null;
    }
    return { channel, event };
  }

  app.post('/channels/:id/sounds/:event', async (req, reply) => {
    const auth = await authChannelSound(req, reply);
    if (!auth) return;
    const { channel, event } = auth;
    if (!storageConfigured()) return reply.code(503).send({ error: 'хранилище звуков не настроено' });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no file' });
    // Тип решают БАЙТЫ, а не подпись браузера: разбор в `resolveAudioMime`.
    const buffer = await file.toBuffer();
    const mime = resolveAudioMime(file.mimetype || '', new Uint8Array(buffer));
    if (!mime) {
      return reply.code(400).send({ error: 'формат не поддерживается — нужен MP3, OGG, WAV, WEBM или M4A' });
    }
    if (buffer.length > 512 * 1024) return reply.code(400).send({ error: 'файл больше 512 КБ' });

    const url = await putSound(`ch-${channel.id}`, event, buffer, mime, Date.now());
    await db
      .insert(channelSounds)
      .values({ channelId: channel.id, event, url })
      .onConflictDoUpdate({ target: [channelSounds.channelId, channelSounds.event], set: { url, updatedAt: new Date() } });
    await writeAudit(channel.serverId, req.user!.sub, 'channel.sound.set', { targetType: 'channel', targetId: channel.id, data: { event } });
    await publishToServer(channel.serverId, { t: 'server.invalidate', serverId: channel.serverId });
    return reply.send({ event, url });
  });

  app.delete('/channels/:id/sounds/:event', async (req, reply) => {
    const auth = await authChannelSound(req, reply);
    if (!auth) return;
    const { channel, event } = auth;
    await db.delete(channelSounds).where(and(eq(channelSounds.channelId, channel.id), eq(channelSounds.event, event)));
    await writeAudit(channel.serverId, req.user!.sub, 'channel.sound.clear', { targetType: 'channel', targetId: channel.id, data: { event } });
    await publishToServer(channel.serverId, { t: 'server.invalidate', serverId: channel.serverId });
    return reply.code(204).send();
  });
}
