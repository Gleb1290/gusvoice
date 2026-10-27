/**
 * Входящие вебхуки каналов (#24, образец — Discord).
 *
 * Управление (вход обязателен, право `MANAGE_WEBHOOKS` на канале): список канала и всего сервера (раздел «Интеграции»),
 * создание, имя/канал, аватар, новый токен, удаление. Приём — `POST /api/webhooks/:id/:token` БЕЗ входа: тело в духе
 * Discord (`content`, `username`, `avatar_url`, `embeds` — карточками, `allowed_mentions`) JSON-ом или
 * `multipart/form-data` (`payload_json` + `files[n]` — обычные вложения), ответ 204, с `?wait=true` — 200 и сообщение.
 *
 * Защиты (правила — `webhookRules.ts`): токен только хешем + сравнение за постоянное время; предел частоты на адрес
 * (до базы) и на вебхук (30/мин); предел тела 64 КБ (файлы — пределы вложений канала); упоминания — как у Discord
 * (без `allowed_mentions` зовутся все, поле сужает); аватар-ссылка и картинки карточек — только из нашего хранилища
 * (чужая картинка карточки — ссылкой); текст рендерится тем же путём, что у человека (никакой разметки, кроме нашего
 * markdown). Неверный id и неверный токен отвечают ОДИНАКОВО (404) — подсказки, какой вебхук существует, нет.
 */
import { type Attachment, has, Permission } from '@gusvoice/shared';
import { randomUUID } from 'node:crypto';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { hashPassword, requireAuth } from '../auth.js';
import { attachmentUploadBlock, clientIp, pushDebounced, rateHit, retryMessage } from '../authGuard.js';
import { db } from '../db/index.js';
import { channels, messages, roles, users, webhooks } from '../db/schema.js';
import { getChannelPermissions, getServerChannelPermissions } from '../permissions.js';
import { contentPreview, resolveMentionedMembers, resolveRoleMentions, sendPushToUsers } from '../push.js';
import { publishChannelMessageEvent } from '../channelEvents.js';
import { serializeMessage, serializeWebhook } from '../serialize.js';
import { attachmentBlocked, isOwnMediaUrl, isSupportedImage, putAttachment, putMedia, storageConfigured } from '../storage.js';
import { id } from '../util.js';
import {
  allowedRoleIds,
  embedsFallbackText,
  embedsPreview,
  hashWebhookToken,
  isWebhookFileField,
  mentionPolicy,
  neutralizeMentions,
  newWebhookToken,
  normalizeEmbeds,
  overrideName,
  WEBHOOK_BODY_LIMIT,
  WEBHOOK_FILE_MAX_BYTES,
  WEBHOOK_FILES_MAX,
  WEBHOOK_IP_RATE_MAX,
  WEBHOOK_PER_CHANNEL_MAX,
  WEBHOOK_RATE_MAX,
  WEBHOOK_RATE_WINDOW_S,
  WEBHOOK_TOKEN_RE,
  webhookExecuteBody,
  webhookName,
  webhookText,
  webhookTokenMatches,
  webhookUsername,
} from '../webhookRules.js';

type WebhookRow = typeof webhooks.$inferSelect;

/** Вебхук с создателем — для ответа окну настроек. */
async function withCreator(w: WebhookRow) {
  const [creator] = w.createdBy
    ? await db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, w.createdBy)).limit(1)
    : [];
  return serializeWebhook(w, creator ?? null);
}

/** Может ли человек управлять вебхуками этого канала: `MANAGE_WEBHOOKS` с учётом прав канала. */
async function canManage(channelId: string, userId: string): Promise<{ serverId: string } | 'missing' | 'forbidden'> {
  const perms = await getChannelPermissions(channelId, userId);
  if (!perms) return 'missing';
  if (!has(perms.permissions, Permission.MANAGE_WEBHOOKS)) return 'forbidden';
  return { serverId: perms.serverId };
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // ---------- приём: без входа ----------
  await app.register(async (pub) => {
    pub.post(
      '/webhooks/:id/:token',
      { bodyLimit: WEBHOOK_BODY_LIMIT },
      async (req, reply) => {
        // Предел с адреса — ДО базы: поток мусора не превращается в поток выборок.
        const ipWait = await rateHit(`whip:${clientIp(req)}`, WEBHOOK_IP_RATE_MAX, WEBHOOK_RATE_WINDOW_S);
        if (ipWait) return reply.code(429).header('Retry-After', String(ipWait)).send({ error: 'слишком часто', retry_after: ipWait });

        const notFound = () => reply.code(404).send({ error: 'unknown webhook' });
        // Кривая форма id/токена — тот же 404, что и неверный токен (не 400 общего обработчика Zod; нашёл Codex, R274).
        const parsed = z.object({ id: z.string().min(1).max(64), token: z.string() }).safeParse(req.params);
        if (!parsed.success) return notFound();
        const params = parsed.data;
        if (!WEBHOOK_TOKEN_RE.test(params.token)) return notFound();
        const [hook] = await db.select().from(webhooks).where(eq(webhooks.id, params.id)).limit(1);
        // Неверный id и неверный токен — один и тот же ответ: по нему нельзя узнать, какой вебхук существует.
        if (!hook || !webhookTokenMatches(params.token, hook.tokenHash)) return notFound();

        const wait = await rateHit(`webhook:${hook.id}`, WEBHOOK_RATE_MAX, WEBHOOK_RATE_WINDOW_S);
        if (wait) return reply.code(429).header('Retry-After', String(wait)).send({ error: 'слишком часто', retry_after: wait });

        const ct = String(req.headers['content-type'] ?? '').toLowerCase();
        const isForm = ct.startsWith('multipart/form-data');
        if (!ct.startsWith('application/json') && !isForm) {
          return reply.code(415).send({ error: 'нужно тело application/json или multipart/form-data' });
        }
        // Файлы (как Discord: `payload_json` + `files[n]`) здесь только читаются; в хранилище кладутся ПОСЛЕ проверки
        // тела. Пределы multipart — свои у запроса (общий в `index.ts` пускает один файл): число и размер — как у
        // вложений канала; превышение — ошибка плагина с 413.
        const files: { name: string; mime: string; buffer: Buffer }[] = [];
        let rawBody: unknown = req.body ?? {};
        if (isForm) {
          const fields: Record<string, string> = {};
          let badFile = false;
          for await (const part of req.parts({
            limits: { files: WEBHOOK_FILES_MAX, fileSize: WEBHOOK_FILE_MAX_BYTES, fields: 8, fieldSize: WEBHOOK_BODY_LIMIT },
          })) {
            if (part.type === 'file') {
              const buffer = await part.toBuffer();
              if (!isWebhookFileField(part.fieldname)) badFile = true;
              else files.push({ name: part.filename || 'file', mime: part.mimetype || 'application/octet-stream', buffer });
            } else fields[part.fieldname] = String(part.value ?? '');
          }
          if (badFile) return reply.code(400).send({ error: 'файлы — в полях files[0]…files[9]' });
          if (fields.payload_json !== undefined) {
            try {
              rawBody = JSON.parse(fields.payload_json);
            } catch {
              return reply.code(400).send({ error: 'payload_json — не JSON' });
            }
          } else {
            rawBody = { content: fields.content, username: fields.username, avatar_url: fields.avatar_url };
          }
        }
        const body = webhookExecuteBody.parse(rawBody ?? {});
        const query = z.object({ wait: z.enum(['true', 'false']).optional() }).parse(req.query);

        const policy = mentionPolicy(body.allowed_mentions);
        const text = webhookText(body);
        if (!text && !body.embeds?.length && files.length === 0) {
          return reply.code(400).send({ error: 'пустое сообщение: нужен content, embeds или файл' });
        }
        // Те же запреты, что у вложений канала (`routes/messages.ts`): SVG/HTML исполнимы при показе.
        if (files.some((f) => attachmentBlocked(f.mime, f.name))) {
          return reply.code(415).send({ error: 'этот тип файла запрещён (SVG/HTML)' });
        }

        const [channel] = await db.select().from(channels).where(eq(channels.id, hook.channelId)).limit(1);
        if (!channel || channel.type !== 'text') return notFound();
        const [author] = await db.select().from(users).where(eq(users.id, hook.userId)).limit(1);
        if (!author) return notFound();

        const attachments: Attachment[] = [];
        const fileUrls = new Map<string, string>();
        if (files.length) {
          if (!storageConfigured()) return reply.code(503).send({ error: 'attachments storage not configured' });
          for (const f of files) {
            // Предел загрузок — на строку-автора вебхука, как у человека на его id (P2-3).
            const upWait = await attachmentUploadBlock(hook.userId);
            if (upWait) {
              return reply.code(429).header('Retry-After', String(upWait)).send({ error: retryMessage(upWait), retry_after: upWait });
            }
            const url = await putAttachment(id(), f.buffer, f.mime, f.name, Date.now());
            attachments.push({ url, name: f.name, contentType: f.mime, size: f.buffer.length });
            fileUrls.set(f.name, url);
          }
        }
        // Карточки: картинки — только наши (файл этого же запроса `attachment://имя` или наша ссылка), чужие — ссылкой.
        const embeds = normalizeEmbeds(body.embeds, isOwnMediaUrl, fileUrls);
        if (!text && embeds.length === 0 && attachments.length === 0) {
          return reply.code(400).send({ error: 'пустое сообщение: нужен content, embeds или файл' });
        }

        const name = overrideName(body.username) ?? hook.name;
        // Чужая картинка в ленте — пиксель слежения за каждым, кто открыл канал (#4): берём только из нашего хранилища.
        const avatar = body.avatar_url && isOwnMediaUrl(body.avatar_url) ? body.avatar_url : hook.avatarUrl;
        // Упоминания — как у Discord: вебхук зовёт любые роли (право «Упоминать @everyone, @here и все роли», не только
        // «можно упоминать»), если политика пускает. Роли решаются по тексту ДО обезвреживания, а их названия обезвреживание
        // не трогает — иначе подсветка роли не нашла бы её в тексте. Карточки никого не зовут (как у Discord).
        const mentionRoleIds = allowedRoleIds(await resolveRoleMentions(text, channel.serverId, Permission.MENTION_EVERYONE), policy);
        const keepRoles = mentionRoleIds.length
          ? (await db.select({ name: roles.name }).from(roles).where(inArray(roles.id, mentionRoleIds))).map((r) => r.name)
          : [];
        // Список `allowed_mentions.users` — это id, а текст разбирается по нику: id → ник здесь.
        const keepUsers =
          Array.isArray(policy.users) && policy.users.length
            ? (await db.select({ username: users.username }).from(users).where(inArray(users.id, [...policy.users]))).map((u) => u.username)
            : [];
        const content = neutralizeMentions(text, policy, keepRoles, keepUsers);
        // Без своего текста `content` для старых клиентов собирается из карточек (новые его не показывают).
        const fallback = !content && embeds.length > 0;

        const [row] = await db
          .insert(messages)
          .values({
            id: id(),
            channelId: channel.id,
            authorId: author.id,
            content: fallback ? embedsFallbackText(embeds) : content,
            attachments,
            mentionRoles: mentionRoleIds,
            webhookId: hook.id,
            webhookName: name,
            webhookAvatar: avatar,
            ...(embeds.length ? { embeds, embedsFallback: fallback } : {}),
          })
          .returning();
        await db.update(webhooks).set({ lastUsedAt: new Date() }).where(eq(webhooks.id, hook.id));

        const message = serializeMessage({ ...row, author, replyTo: null });
        // Вход событий канала (#231): людям `message.create`, ботам «читать всё» — `message` (вебхук ботам в режиме приватности не виден).
        await publishChannelMessageEvent(channel.serverId, channel.id, { kind: 'created', message }, author.id);
        // Пуш упомянутым — как у обычного сообщения канала (`routes/messages.ts`), с тем же гашением очередей.
        const preview = content || embedsPreview(embeds);
        void resolveMentionedMembers(content, channel.serverId, author.id, channel.id, mentionRoleIds).then(async (ids) => {
          if (ids.length === 0) return;
          const fresh: string[] = [];
          for (const uid of ids) if (!(await pushDebounced(uid, channel.id))) fresh.push(uid);
          if (fresh.length === 0) return;
          return sendPushToUsers(
            fresh,
            { type: 'mention', title: name, body: contentPreview(preview, attachments.length), channelId: channel.id, serverId: channel.serverId },
            { scope: 'server', targetId: channel.serverId },
          );
        });
        return query.wait === 'true' ? reply.code(200).send(message) : reply.code(204).send();
      },
    );
  });

  // ---------- управление: вход обязателен ----------
  await app.register(async (api) => {
    api.addHook('preHandler', requireAuth);

    api.get('/channels/:id/webhooks', async (req, reply) => {
      const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
      const ok = await canManage(channelId, req.user!.sub);
      if (ok === 'missing') return reply.code(404).send({ error: 'not found' });
      if (ok === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      const rows = await db.select().from(webhooks).where(eq(webhooks.channelId, channelId)).orderBy(webhooks.createdAt);
      return Promise.all(rows.map(withCreator));
    });

    // Все вебхуки сервера (раздел «Интеграции» настроек сервера, как у Discord): только каналов, где у человека есть
    // `VIEW_CHANNEL` и `MANAGE_WEBHOOKS` (с учётом прав канала: скрытый канал не светится). Не участник — 404; ни одного
    // такого канала — 403.
    api.get('/servers/:id/webhooks', async (req, reply) => {
      const { id: serverId } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
      const perms = await getServerChannelPermissions(serverId, req.user!.sub);
      if (!perms) return reply.code(404).send({ error: 'not found' });
      const manageable = [...perms].filter(([, p]) => has(p, Permission.VIEW_CHANNEL) && has(p, Permission.MANAGE_WEBHOOKS)).map(([channelId]) => channelId);
      if (manageable.length === 0) return reply.code(403).send({ error: 'forbidden' });
      const rows = await db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.serverId, serverId), inArray(webhooks.channelId, manageable)))
        .orderBy(webhooks.createdAt);
      return Promise.all(rows.map(withCreator));
    });

    api.post('/channels/:id/webhooks', async (req, reply) => {
      const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
      const body = z.object({ name: webhookName }).parse(req.body);
      const ok = await canManage(channelId, req.user!.sub);
      if (ok === 'missing') return reply.code(404).send({ error: 'not found' });
      if (ok === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
      if (!channel || channel.type !== 'text') return reply.code(400).send({ error: 'вебхук можно завести только у текстового канала' });
      const [{ n }] = await db.select({ n: count() }).from(webhooks).where(eq(webhooks.channelId, channelId));
      if (n >= WEBHOOK_PER_CHANNEL_MAX) {
        return reply.code(400).send({ error: `У канала уже ${WEBHOOK_PER_CHANNEL_MAX} вебхуков — удалите ненужный` });
      }

      const hookId = id();
      const userId = id();
      const token = newWebhookToken();
      // Строка-автор: не человек. Неподтверждённая, без почты, пароль непригоден, скрыта от соседей — не находится
      // ни поиском, ни входом, ни каталогом федерации (миграция 0151).
      await db.insert(users).values({
        id: userId,
        username: webhookUsername(hookId),
        email: null,
        verified: false,
        approvedAt: null,
        canCreateServers: false,
        displayName: body.name,
        passwordHash: await hashPassword(randomUUID()),
        hiddenFromPeers: true,
        bot: true,
      });
      const [row] = await db
        .insert(webhooks)
        .values({
          id: hookId,
          serverId: ok.serverId,
          channelId,
          userId,
          name: body.name,
          tokenHash: hashWebhookToken(token),
          createdBy: req.user!.sub,
        })
        .returning();
      await writeAudit(ok.serverId, req.user!.sub, 'webhook.create', {
        targetType: 'channel',
        targetId: channelId,
        data: { name: body.name, channelName: channel.name },
      });
      return reply.code(201).send({ ...(await withCreator(row)), token });
    });

    /** Загрузить вебхук и проверить право на его канал. */
    async function loadManaged(webhookId: string, userId: string) {
      const [hook] = await db.select().from(webhooks).where(eq(webhooks.id, webhookId)).limit(1);
      if (!hook) return 'missing' as const;
      const ok = await canManage(hook.channelId, userId);
      if (ok === 'missing') return 'missing' as const;
      if (ok === 'forbidden') return 'forbidden' as const;
      return hook;
    }

    // Имя, канал (в пределах сервера; право нужно на ОБА канала), сброс аватара (`avatarUrl: null`).
    api.patch('/webhooks/:id', async (req, reply) => {
      const { id: webhookId } = z.object({ id: z.string() }).parse(req.params);
      const body = z
        .object({ name: webhookName.optional(), channelId: z.string().min(1).max(64).optional(), avatarUrl: z.null().optional() })
        .parse(req.body);
      const hook = await loadManaged(webhookId, req.user!.sub);
      if (hook === 'missing') return reply.code(404).send({ error: 'not found' });
      if (hook === 'forbidden') return reply.code(403).send({ error: 'forbidden' });

      const patch: Partial<WebhookRow> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.avatarUrl === null) patch.avatarUrl = null;
      if (body.channelId !== undefined && body.channelId !== hook.channelId) {
        const [target] = await db.select().from(channels).where(eq(channels.id, body.channelId)).limit(1);
        if (!target || target.serverId !== hook.serverId) return reply.code(400).send({ error: 'канал не найден на этом сервере' });
        if (target.type !== 'text') return reply.code(400).send({ error: 'вебхук можно перенести только в текстовый канал' });
        const ok = await canManage(target.id, req.user!.sub);
        if (ok === 'missing' || ok === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
        patch.channelId = target.id;
      }
      if (Object.keys(patch).length === 0) return withCreator(hook);
      const [row] = await db.update(webhooks).set(patch).where(eq(webhooks.id, hook.id)).returning();
      // Строке-автору — нынешние имя и аватар (профиль, старые клиенты). Историю это не трогает: там снятые при отправке.
      await db.update(users).set({ displayName: row.name, avatarUrl: row.avatarUrl }).where(eq(users.id, row.userId));
      await writeAudit(hook.serverId, req.user!.sub, 'webhook.update', {
        targetType: 'channel',
        targetId: row.channelId,
        data: { name: row.name, changed: Object.keys(patch) },
      });
      return withCreator(row);
    });

    api.post('/webhooks/:id/avatar', async (req, reply) => {
      const { id: webhookId } = z.object({ id: z.string() }).parse(req.params);
      const hook = await loadManaged(webhookId, req.user!.sub);
      if (hook === 'missing') return reply.code(404).send({ error: 'not found' });
      if (hook === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      if (!storageConfigured()) return reply.code(503).send({ error: 'хранилище не настроено' });
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'no file' });
      const mime = file.mimetype || '';
      if (!isSupportedImage(mime)) return reply.code(400).send({ error: 'формат не поддерживается — нужен PNG, JPEG, WEBP или GIF' });
      const buffer = await file.toBuffer();
      if (file.file.truncated) return reply.code(413).send({ error: 'request file too large' });
      if (buffer.length > 512 * 1024) return reply.code(400).send({ error: 'файл больше 512 КБ' });
      const url = await putMedia('avatars', hook.userId, buffer, mime, Date.now());
      const [row] = await db.update(webhooks).set({ avatarUrl: url }).where(eq(webhooks.id, hook.id)).returning();
      await db.update(users).set({ avatarUrl: url }).where(eq(users.id, row.userId));
      await writeAudit(hook.serverId, req.user!.sub, 'webhook.update', {
        targetType: 'channel',
        targetId: row.channelId,
        data: { name: row.name, changed: ['avatarUrl'] },
      });
      return withCreator(row);
    });

    // Новый токен: старый адрес перестаёт работать сразу. Полный адрес видно только в этом ответе.
    api.post('/webhooks/:id/token', async (req, reply) => {
      const { id: webhookId } = z.object({ id: z.string() }).parse(req.params);
      const hook = await loadManaged(webhookId, req.user!.sub);
      if (hook === 'missing') return reply.code(404).send({ error: 'not found' });
      if (hook === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      const token = newWebhookToken();
      const [row] = await db
        .update(webhooks)
        .set({ tokenHash: hashWebhookToken(token) })
        .where(eq(webhooks.id, hook.id))
        .returning();
      await writeAudit(hook.serverId, req.user!.sub, 'webhook.token', {
        targetType: 'channel',
        targetId: row.channelId,
        data: { name: row.name },
      });
      return { ...(await withCreator(row)), token };
    });

    // Удаление: адрес умирает, сообщения вебхука и его строка-автор остаются (как у Discord).
    api.delete('/webhooks/:id', async (req, reply) => {
      const { id: webhookId } = z.object({ id: z.string() }).parse(req.params);
      const hook = await loadManaged(webhookId, req.user!.sub);
      if (hook === 'missing') return reply.code(404).send({ error: 'not found' });
      if (hook === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      await db.delete(webhooks).where(and(eq(webhooks.id, hook.id), eq(webhooks.serverId, hook.serverId)));
      await writeAudit(hook.serverId, req.user!.sub, 'webhook.delete', {
        targetType: 'channel',
        targetId: hook.channelId,
        data: { name: hook.name },
      });
      return reply.code(204).send();
    });
  });
}
