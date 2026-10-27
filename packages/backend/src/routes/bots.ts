/**
 * «Мои боты» и раздел «Боты» админки (#229, этап 1; контракт — `shared/bots.ts`). Bot API самого бота — `routes/botApi.ts`.
 *
 * Человек (JWT, только свой инстанс — `requireLocalUser`): список своих ботов, создание (токен показывается ОДИН раз),
 * имя/описание/«доступен всем», аватар, перевыпуск токена (старый гаснет сразу, WS бота рвутся), удаление (как удаление
 * аккаунта: строка обезличена, беседы остаются). Чужой бот — 404, как несуществующий.
 *
 * Супер-админ: все боты с владельцами, выключить/включить, удалить, настройка инстанса `bots` (кто создаёт, лимит, внутренние
 * адреса доставки, общий выключатель).
 *
 * Строка бота в `users`: `bot=true`, подтверждена и одобрена (иначе её не нашёл бы поиск и не пустило бы правило «писать
 * можно живому»), без почты, с непригодным паролем (вход по паролю ботам закрыт и явно — `routes/auth.ts`), скрыта от
 * соседей (`hidden_from_peers`: ни каталога, ни ЛС между инстансами).
 */
import {
  type AdminBotInfo,
  BOT_ABOUT_MAX,
  BOT_DESCRIPTION_MAX,
  BOT_PER_USER_LIMIT_MAX,
  type BotInfo,
  type BotTokenResponse,
  botUsernameError,
  isAnimatedImage,
  type MyBotsResponse,
} from '@gusvoice/shared';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { hashPassword, isSuperAdmin, requireAuth, requireSuperAdmin } from '../auth.js';
import { rateHit } from '../authGuard.js';
import { botVoiceEnabled, canCreateBot, hashBotToken, newBotToken } from '../bots/botRules.js';
import { deleteBot } from '../bots/botLifecycle.js';
import { type BotRow, readBotSettings, type UserRow, writeBotSettings } from '../bots/botStore.js';
import { db } from '../db/index.js';
import { bots, serverBots, servers, users } from '../db/schema.js';
import { broadcastUserProfile } from '../gateway.js';
import { requireLocalUser } from '../guestGuard.js';
import { isSupportedImage, uploadAvatar } from '../storage.js';
import { asUserId } from '../superAdminRules.js';
import { id as newId } from '../util.js';
import { closeBotSockets } from './botApi.js';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
/** Создание ботов одним человеком — не чаще (защита от перебора ников и мусора). */
const CREATE_RATE = { max: 10, windowS: 3600 } as const;

/**
 * Этап 4 (#232): вон из голосовых комнат рядом с КАЖДЫМ `closeBotSockets` (перевыпуск токена, выключение админом). Лениво —
 * модуль голоса тянет LiveKit; сбой не ломает маршрут (добьёт страховочный обход `sweepBotVoice`).
 */
async function dropBotVoiceSoon(botId: string): Promise<void> {
  await import('../bots/botVoice.js').then((m) => m.dropBotVoice(botId), () => undefined);
}

export function botInfoOf(b: BotRow, u: UserRow): BotInfo {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName === u.username ? null : u.displayName,
    avatarUrl: u.avatarUrl,
    description: b.description,
    about: b.about,
    public: b.public,
    createdAt: b.createdAt.toISOString(),
    tokenCreatedAt: b.tokenCreatedAt.toISOString(),
    webhook: b.webhookUrl
      ? {
          url: b.webhookUrl,
          lastError: b.webhookLastError,
          // Время последней ошибки (26.10, добавление) — «Мои боты» пишут его рядом с ошибкой.
          lastErrorAt: b.webhookLastError && b.webhookLastErrorAt ? b.webhookLastErrorAt.toISOString() : null,
          failures: b.webhookFailures,
          disabledAt: b.webhookDisabledAt ? b.webhookDisabledAt.toISOString() : null,
        }
      : null,
    disabledAt: b.disabledAt ? b.disabledAt.toISOString() : null,
  };
}

async function ownedBots(ownerId: string) {
  return db
    .select({ bot: bots, user: users })
    .from(bots)
    .innerJoin(users, eq(users.id, bots.userId))
    .where(and(eq(bots.ownerId, ownerId), isNull(users.deletedAt)))
    .orderBy(desc(bots.createdAt));
}

/** «Мои боты» (#231): серверы, где стоит каждый бот, — владелец видит, где его бот, и может убрать его оттуда. */
async function withServers(list: BotInfo[]): Promise<BotInfo[]> {
  if (list.length === 0) return list;
  const rows = await db
    .select({ botId: serverBots.botId, id: servers.id, name: servers.name })
    .from(serverBots)
    .innerJoin(servers, eq(servers.id, serverBots.serverId))
    .where(inArray(serverBots.botId, list.map((b) => b.id)));
  const by = new Map<string, { id: string; name: string }[]>();
  for (const r of rows) by.set(r.botId, [...(by.get(r.botId) ?? []), { id: r.id, name: r.name }]);
  return list.map((b) => ({ ...b, servers: by.get(b.id) ?? [] }));
}

/** Свой живой бот; иначе `null` (маршрут отвечает 404 — чужой бот не отличим от несуществующего). */
async function myBot(ownerId: string, botId: string) {
  const [row] = await db
    .select({ bot: bots, user: users })
    .from(bots)
    .innerJoin(users, eq(users.id, bots.userId))
    .where(and(eq(bots.userId, botId), eq(bots.ownerId, ownerId), isNull(users.deletedAt)))
    .limit(1);
  return row ?? null;
}

const usernameBody = z.string().trim().min(1).max(64);
const nameBody = z.string().trim().min(1).max(64, 'Имя: максимум 64 символа');
const createBody = z.object({
  username: usernameBody,
  displayName: nameBody.optional(),
  description: z.string().max(BOT_DESCRIPTION_MAX).optional(),
});
const updateBody = z.object({
  displayName: nameBody.nullable().optional(),
  description: z.string().max(BOT_DESCRIPTION_MAX).optional(),
  about: z.string().max(BOT_ABOUT_MAX).optional(),
  public: z.boolean().optional(),
});
const botParams = z.object({ id: z.string().min(1).max(64) });

export async function botRoutes(app: FastifyInstance): Promise<void> {
  // ---------- «Мои боты» ----------
  await app.register(async (api) => {
    api.addHook('preHandler', requireAuth);
    api.addHook('preHandler', requireLocalUser);

    api.get('/bots', async (req): Promise<MyBotsResponse> => {
      const me = req.user!.sub;
      const [settings, rows, [meRow]] = await Promise.all([
        readBotSettings(),
        ownedBots(me),
        db.select({ approvedAt: users.approvedAt }).from(users).where(eq(users.id, me)).limit(1),
      ]);
      const superAdmin = isSuperAdmin(asUserId(me));
      return {
        bots: await withServers(rows.map((r) => botInfoOf(r.bot, r.user))),
        canCreate: canCreateBot(settings, { superAdmin, approved: !!meRow?.approvedAt, owned: rows.length }),
        limit: superAdmin ? BOT_PER_USER_LIMIT_MAX : settings.perUserLimit,
        enabled: settings.enabled,
      };
    });

    api.post('/bots', async (req, reply): Promise<BotTokenResponse | FastifyReply> => {
      const me = req.user!.sub;
      const body = createBody.parse(req.body);
      const nameError = botUsernameError(body.username);
      if (nameError) return reply.code(400).send({ error: nameError });
      const settings = await readBotSettings();
      const [[meRow], owned] = await Promise.all([
        db.select({ approvedAt: users.approvedAt }).from(users).where(eq(users.id, me)).limit(1),
        ownedBots(me),
      ]);
      if (!canCreateBot(settings, { superAdmin: isSuperAdmin(asUserId(me)), approved: !!meRow?.approvedAt, owned: owned.length })) {
        return reply.code(403).send({ error: settings.enabled ? 'Создавать ботов вам сейчас нельзя (настройка инстанса или лимит)' : 'Боты на этом сервере выключены' });
      }
      const wait = await rateHit(`bot-create:${me}`, CREATE_RATE.max, CREATE_RATE.windowS);
      if (wait) return reply.code(429).header('Retry-After', String(wait)).send({ error: 'Слишком много новых ботов — попробуйте позже', retry_after: wait });
      // Ник уникален без учёта регистра — как у людей (вход ищет по нему же без регистра).
      const [taken] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = ${body.username.toLowerCase()}`).limit(1);
      if (taken) return reply.code(409).send({ error: 'Этот ник занят' });

      const botId = newId();
      const token = newBotToken();
      try {
        await db.transaction(async (tx) => {
          await tx.insert(users).values({
            id: botId,
            username: body.username,
            email: null,
            verified: true,
            approvedAt: new Date(),
            canCreateServers: false,
            displayName: body.displayName ?? body.username,
            passwordHash: await hashPassword(randomUUID()),
            hiddenFromPeers: true,
            bot: true,
          });
          await tx.insert(bots).values({ userId: botId, ownerId: me, tokenHash: hashBotToken(token), description: body.description ?? '' });
        });
      } catch (err) {
        // Гонка двух созданий с одним ником: уникальность `users.username` — у базы.
        if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'Этот ник занят' });
        throw err;
      }
      const row = await myBot(me, botId);
      return reply.code(201).send({ bot: botInfoOf(row!.bot, row!.user), token });
    });

    api.patch('/bots/:id', async (req, reply) => {
      const { id } = botParams.parse(req.params);
      const body = updateBody.parse(req.body ?? {});
      const row = await myBot(req.user!.sub, id);
      if (!row) return reply.code(404).send({ error: 'not found' });
      const displayName = body.displayName === undefined ? undefined : (body.displayName ?? row.user.username);
      if (displayName !== undefined && displayName !== row.user.displayName) {
        await db.update(users).set({ displayName }).where(eq(users.id, id));
        broadcastUserProfile(id, displayName, row.user.avatarUrl, null);
      }
      const patch = {
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.about !== undefined ? { about: body.about } : {}),
        ...(body.public !== undefined ? { public: body.public } : {}),
      };
      if (Object.keys(patch).length) await db.update(bots).set(patch).where(eq(bots.userId, id));
      const fresh = await myBot(req.user!.sub, id);
      return botInfoOf(fresh!.bot, fresh!.user);
    });

    // Аватар — как у человека (`POST /users/me/avatar`): png/jpeg/webp/gif до 5 МБ, без анимации.
    api.post('/bots/:id/avatar', async (req, reply) => {
      const { id } = botParams.parse(req.params);
      const row = await myBot(req.user!.sub, id);
      if (!row) return reply.code(404).send({ error: 'not found' });
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'no file' });
      if (!isSupportedImage(file.mimetype)) return reply.code(400).send({ error: 'unsupported image type (png/jpeg/webp/gif)' });
      const buffer = await file.toBuffer();
      if (file.file.truncated) return reply.code(413).send({ error: 'request file too large' });
      if (buffer.length > MAX_AVATAR_BYTES) return reply.code(413).send({ error: 'image too large (max 5 MB)' });
      if (isAnimatedImage(new Uint8Array(buffer), file.mimetype)) return reply.code(400).send({ error: 'анимированный аватар боту нельзя — нужна статичная картинка' });
      let url: string;
      try {
        url = await uploadAvatar(id, buffer, file.mimetype, Date.now());
      } catch (err) {
        const e = err as { statusCode?: number; message?: string };
        return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'upload failed' });
      }
      await db.update(users).set({ avatarUrl: url }).where(eq(users.id, id));
      broadcastUserProfile(id, row.user.displayName, url, null);
      const fresh = await myBot(req.user!.sub, id);
      return botInfoOf(fresh!.bot, fresh!.user);
    });

    // Перевыпуск: новый хеш — старый токен перестаёт подходить сразу (каждый запрос бота ищет по хешу); его WS закрываются.
    api.post('/bots/:id/token', async (req, reply): Promise<BotTokenResponse | FastifyReply> => {
      const { id } = botParams.parse(req.params);
      const row = await myBot(req.user!.sub, id);
      if (!row) return reply.code(404).send({ error: 'not found' });
      const token = newBotToken();
      await db.update(bots).set({ tokenHash: hashBotToken(token), tokenCreatedAt: new Date() }).where(eq(bots.userId, id));
      closeBotSockets(id, 4001, 'token revoked');
      await dropBotVoiceSoon(id);
      const fresh = await myBot(req.user!.sub, id);
      return { bot: botInfoOf(fresh!.bot, fresh!.user), token };
    });

    api.delete('/bots/:id', async (req, reply) => {
      const { id } = botParams.parse(req.params);
      const row = await myBot(req.user!.sub, id);
      if (!row) return reply.code(404).send({ error: 'not found' });
      await deleteBot(id);
      return reply.code(204).send();
    });

    // Владелец убирает своего бота с сервера (#231, «Мои боты» → «Серверы» → «Убрать»): как `leaveChat` от имени бота.
    api.delete('/bots/:id/servers/:serverId', async (req, reply) => {
      const { id } = botParams.parse(req.params);
      const serverId = String((req.params as { serverId?: string }).serverId ?? '');
      const row = await myBot(req.user!.sub, id);
      if (!row) return reply.code(404).send({ error: 'not found' });
      const { removeBotFromServer } = await import('./serverBots.js');
      if (!(await removeBotFromServer(serverId, id, req.user!.sub))) return reply.code(404).send({ error: 'Бота нет на этом сервере' });
      return reply.code(204).send();
    });
  });

  // ---------- админка: все боты инстанса ----------
  await app.register(async (admin) => {
    admin.addHook('preHandler', requireSuperAdmin);

    admin.get('/admin/bots/settings', async () => readBotSettings());

    admin.put('/admin/bots/settings', async (req) => {
      const body = z
        .object({
          // Каждое поле необязательное (26.10): клиент шлёт только то, что переключили (главный тумблер — `{enabled}`),
          // остальное берётся из сохранённого. Прежний полный объект принимается как раньше.
          creators: z.enum(['all', 'approved', 'admin']).optional(),
          perUserLimit: z.number().int().min(0).max(BOT_PER_USER_LIMIT_MAX).optional(),
          allowInternalWebhooks: z.boolean().optional(),
          enabled: z.boolean().optional(),
          // Этап 4 (#232): «Боты могут заходить в голосовые каналы». Нет поля в сохранённом — можно.
          voice: z.boolean().optional(),
        })
        .parse(req.body);
      const prev = await readBotSettings();
      const voice = body.voice ?? prev.voice;
      const next = await writeBotSettings({
        creators: body.creators ?? prev.creators,
        perUserLimit: body.perUserLimit ?? prev.perUserLimit,
        allowInternalWebhooks: body.allowInternalWebhooks ?? prev.allowInternalWebhooks,
        enabled: body.enabled ?? prev.enabled,
        ...(voice === false ? { voice: false } : {}),
      });
      // Выключили — живые WS ботов закрываются сразу (долгий опрос вернётся пустым и следующий получит 403).
      if (prev.enabled && !next.enabled) closeBotSockets(null, 4003, 'bots disabled');
      // Выключили ботов или голос ботов — все боты выкидываются из всех голосовых комнат.
      if (botVoiceEnabled(prev) && !botVoiceEnabled(next)) {
        await import('../bots/botVoice.js').then((m) => m.dropAllBotsVoice(), () => undefined);
      }
      return next;
    });

    admin.get('/admin/bots', async (): Promise<AdminBotInfo[]> => {
      const rows = await db
        .select({ bot: bots, user: users })
        .from(bots)
        .innerJoin(users, eq(users.id, bots.userId))
        .where(isNull(users.deletedAt))
        .orderBy(desc(bots.createdAt));
      const ownerIds = [...new Set(rows.map((r) => r.bot.ownerId))];
      const owners = ownerIds.length
        ? await db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(inArray(users.id, ownerIds))
        : [];
      const byId = new Map(owners.map((o) => [o.id, o]));
      return rows.map((r) => {
        const o = byId.get(r.bot.ownerId);
        return { ...botInfoOf(r.bot, r.user), owner: { id: r.bot.ownerId, username: o?.username ?? '', displayName: o?.displayName ?? null } };
      });
    });

    admin.patch('/admin/bots/:id', async (req, reply) => {
      const { id } = botParams.parse(req.params);
      const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);
      const [row] = await db.select({ bot: bots, user: users }).from(bots).innerJoin(users, eq(users.id, bots.userId)).where(eq(bots.userId, id)).limit(1);
      if (!row || row.user.deletedAt) return reply.code(404).send({ error: 'not found' });
      await db.update(bots).set({ disabledAt: disabled ? (row.bot.disabledAt ?? new Date()) : null }).where(eq(bots.userId, id));
      if (disabled) {
        closeBotSockets(id, 4001, 'bot disabled');
        await dropBotVoiceSoon(id);
      }
      const [fresh] = await db.select({ bot: bots, user: users }).from(bots).innerJoin(users, eq(users.id, bots.userId)).where(eq(bots.userId, id)).limit(1);
      const [owner] = await db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(eq(users.id, fresh.bot.ownerId)).limit(1);
      const info: AdminBotInfo = { ...botInfoOf(fresh.bot, fresh.user), owner: { id: fresh.bot.ownerId, username: owner?.username ?? '', displayName: owner?.displayName ?? null } };
      return info;
    });

    admin.delete('/admin/bots/:id', async (req, reply) => {
      const { id } = botParams.parse(req.params);
      const [row] = await db.select({ deletedAt: users.deletedAt }).from(bots).innerJoin(users, eq(users.id, bots.userId)).where(eq(bots.userId, id)).limit(1);
      if (!row || row.deletedAt) return reply.code(404).send({ error: 'not found' });
      await deleteBot(id);
      return reply.code(204).send();
    });
  });
}
