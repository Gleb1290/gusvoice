/**
 * Боты, этап 2 (#230) — маршруты ЧЕЛОВЕКА (JWT, свой инстанс): нажатие кнопки под сообщением бота и карточка бота беседы.
 *
 * `POST /api/conv/:id/messages/:mid/callback {data}` — долгий запрос (решение владельца: ответ получает ровно нажавшее
 * устройство, `shared/ws.ts` не меняется): проверки → `callback_query` в журнал бота → ждём `answerCallbackQuery` до
 * `CALLBACK_QUERY_WAIT_S` → `BotCallbackResult` (`{}` / `{text, alert?}` / `{timeout:true}`). 🔴 `data` обязан совпасть с
 * `callback_data` кнопки ТЕКУЩЕЙ клавиатуры сообщения (иначе 409 `stale_button`): человек не подсовывает боту произвольное.
 *
 * `GET /api/conv/:id/bot` → `ConvBotInfo` (команды для подсказки по «/», описание). Только участнику беседы 1:1 с ботом.
 */
import {
  BOT_UNAVAILABLE_CODE,
  BOT_UNAVAILABLE_ERRORS,
  botUnavailableFor,
  type BotCallbackResult,
  CALLBACK_DATA_MAX_BYTES,
  CALLBACK_QUERY_WAIT_S,
  type ConvBotInfo,
  type ConvMessage,
  callbackDataBytes,
} from '@gusvoice/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth } from '../auth.js';
import { rateHit } from '../authGuard.js';
import { acquirePending, createCallbackQuery, releasePending, waitCallbackAnswer } from '../bots/botCallback.js';
import {
  CALLBACK_BOT_RATE,
  CALLBACK_PENDING_PER_BOT,
  CALLBACK_PENDING_PER_USER,
  CALLBACK_USER_RATE,
  keyboardHasData,
  unixSeconds,
} from '../bots/botRules.js';
import { botById, commandsFor, liveBotsAmong, pushUpdate, readBotSettings } from '../bots/botStore.js';
import { toWireMessage, toWireUser } from '../bots/botWire.js';
import { kickWebhook } from '../bots/webhookDelivery.js';
import { loadAccess, messageFor } from '../conversations.js';
import { db } from '../db/index.js';
import { channels, messages, serverBots, users } from '../db/schema.js';
import { requireLocalUser } from '../guestGuard.js';
import { serverBotRoutes } from './serverBots.js';
import { getChannelAudience, getChannelPermissions } from '../permissions.js';
import { has, Permission, type ChannelBotsInfo } from '@gusvoice/shared';
import { and, eq as eqd, inArray } from 'drizzle-orm';

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'Не найдено' });

type Access = NonNullable<Awaited<ReturnType<typeof loadAccess>>>;

/** Беседа 1:1 (не «Избранное») — доступ с собеседником, иначе `null`. */
async function directAccess(conversationId: string, me: string): Promise<(Access & { peerId: string }) | null> {
  const access = await loadAccess(conversationId, me);
  if (!access || access.kind !== 'direct' || access.saved || !access.peerId) return null;
  return access as Access & { peerId: string };
}

/** Беседа 1:1 меня с ботом: `{botId}` или `null` (не участник / не 1:1 / собеседник не бот). `known` — доступ уже прочитан. */
async function botConv(conversationId: string, me: string, known?: Access & { peerId: string }) {
  const access = known ?? (await directAccess(conversationId, me));
  if (!access) return null;
  const found = await botById(access.peerId);
  if (!found || found.user.deletedAt) return null;
  return { access, bot: found.bot, botUser: found.user };
}

async function tooMany(reply: FastifyReply, key: string, rate: { max: number; windowS: number }): Promise<boolean> {
  const wait = await rateHit(key, rate.max, rate.windowS);
  if (!wait) return false;
  reply.header('Retry-After', String(wait)).code(429).send({ error: 'Слишком часто', retryAfter: wait });
  return true;
}

export async function botPressRoutes(app: FastifyInstance) {
  // Боты на серверах (#231): «Настройки сервера → Интеграции → Боты» — здесь, а не в `index.ts` (закрытый перечень его импортов).
  app.register(serverBotRoutes);
  // ─── Каналы сервера (#231) ─── Гости-соседи тоже (решение владельца §9.7/§9.21): без `requireLocalUser`.
  app.register(async (api) => {
    api.addHook('preHandler', requireAuth);

    // Боты канала с командами (для подсказки по «/»): боты сервера, видящие канал, живые; боты выключены — `bots: []`.
    api.get<{ Params: { id: string } }>('/channels/:id/bots', async (req, reply) => {
      const perms = await getChannelPermissions(req.params.id, req.user!.sub);
      if (!perms || !has(perms.permissions, Permission.VIEW_CHANNEL)) return notFound(reply);
      const out: ChannelBotsInfo = { bots: [] };
      if (!(await readBotSettings()).enabled) return out;
      const rows = await db.select({ botId: serverBots.botId }).from(serverBots).where(eqd(serverBots.serverId, perms.serverId));
      if (rows.length === 0) return out;
      const audience = await getChannelAudience(req.params.id);
      const seen = new Set(audience?.userIds ?? []);
      const live = await liveBotsAmong(rows.map((r) => r.botId).filter((b) => seen.has(b)));
      if (live.size === 0) return out;
      const us = await db.select().from(users).where(inArray(users.id, [...live.keys()]));
      for (const u of us) {
        const b = live.get(u.id)!;
        out.bots.push({ id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl, commands: commandsFor(b, 'server') });
      }
      return out;
    });

    api.post<{ Params: { id: string; mid: string }; Body: { data?: unknown } }>('/channels/:id/messages/:mid/callback', async (req, reply) => {
      const me = req.user!.sub;
      const data = req.body?.data;
      if (typeof data !== 'string' || !data || callbackDataBytes(data) > CALLBACK_DATA_MAX_BYTES) {
        return reply.code(400).send({ error: 'Неверные данные кнопки' });
      }
      if (await tooMany(reply, `cbq:${me}`, CALLBACK_USER_RATE)) return reply;
      // 1. Нажавший видит канал.
      const perms = await getChannelPermissions(req.params.id, me);
      if (!perms || !has(perms.permissions, Permission.VIEW_CHANNEL)) return notFound(reply);
      // 2. Сообщение этого канала, автор — бот, который стоит на этом сервере.
      const [msg] = await db.select().from(messages).where(eqd(messages.id, req.params.mid)).limit(1);
      if (!msg || msg.channelId !== req.params.id) return notFound(reply);
      if (await tooMany(reply, `cbqbot:${msg.authorId}`, CALLBACK_BOT_RATE)) return reply;
      const found = await botById(msg.authorId);
      if (!found || found.user.deletedAt) return reply.code(400).send({ error: 'Это не сообщение бота' });
      const [onServer] = await db
        .select({ botId: serverBots.botId })
        .from(serverBots)
        .where(and(eqd(serverBots.serverId, perms.serverId), eqd(serverBots.botId, found.bot.userId)))
        .limit(1);
      if (!onServer) return reply.code(403).send({ error: 'Бот удалён с сервера' });
      if (found.bot.disabledAt || !(await readBotSettings()).enabled) {
        return reply.code(403).send({ error: 'Бот выключен', code: BOT_UNAVAILABLE_CODE, reason: 'disabled' });
      }
      // 3. Точное совпадение с кнопкой ТЕКУЩЕЙ клавиатуры.
      if (!keyboardHasData(msg.keyboard, data)) return reply.code(409).send({ error: 'stale_button' });
      // 4. Те же пределы висящих, что в ЛС.
      if (!(await acquirePending(`u:${me}`, CALLBACK_PENDING_PER_USER))) {
        return reply.header('Retry-After', '5').code(429).send({ error: 'Слишком часто', retryAfter: 5 });
      }
      if (!(await acquirePending(`b:${found.bot.userId}`, CALLBACK_PENDING_PER_BOT))) {
        await releasePending(`u:${me}`);
        return reply.header('Retry-After', '5').code(429).send({ error: 'Бот занят', retryAfter: 5 });
      }
      try {
        const [channel] = await db.select().from(channels).where(eqd(channels.id, req.params.id)).limit(1);
        if (!channel) return notFound(reply);
        const { channelCallbackMessage, wireUserOf } = await import('../bots/botChannel.js');
        const wireMsg = await channelCallbackMessage(found.bot.userId, channel, msg.id);
        const [meRow] = await db.select().from(users).where(eqd(users.id, me)).limit(1);
        if (!wireMsg || !meRow) return notFound(reply);
        const queryId = await createCallbackQuery({
          botId: found.bot.userId,
          userId: me,
          conversationId: '',
          messageId: msg.id,
          channelId: channel.id,
          serverId: channel.serverId,
        });
        await pushUpdate(found.bot.userId, 'callback_query', {
          id: queryId,
          // Гость-сосед — с `instance_domain` (ник может совпасть с местным).
          from: wireUserOf(meRow),
          message: wireMsg,
          data,
          date: unixSeconds(Date.now()),
        });
        kickWebhook(found.bot.userId);
        const gone = new AbortController();
        reply.raw.on('close', () => gone.abort());
        const answer = await waitCallbackAnswer(queryId, CALLBACK_QUERY_WAIT_S * 1000, gone.signal);
        const out: BotCallbackResult = answer ?? { timeout: true };
        return out;
      } finally {
        await releasePending(`u:${me}`);
        await releasePending(`b:${found.bot.userId}`);
      }
    });
  });

  app.register(async (api) => {
    api.addHook('preHandler', requireAuth);
    api.addHook('preHandler', requireLocalUser);

    api.get<{ Params: { id: string } }>('/conv/:id/bot', async (req, reply) => {
      const c = await botConv(req.params.id, req.user!.sub);
      if (!c) return notFound(reply);
      const live = !c.bot.disabledAt && (await readBotSettings()).enabled;
      const info: ConvBotInfo = {
        id: c.bot.userId,
        description: c.bot.description,
        about: c.bot.about,
        // Область ЛС (#231): `all_private_chats`, если задан, иначе `default`.
        commands: live ? commandsFor(c.bot, 'dm') : [],
        commandsUpdatedAt: c.bot.commandsUpdatedAt ? c.bot.commandsUpdatedAt.toISOString() : null,
      };
      return info;
    });

    api.post<{ Params: { id: string; mid: string }; Body: { data?: unknown } }>('/conv/:id/messages/:mid/callback', async (req, reply) => {
      const me = req.user!.sub;
      const data = req.body?.data;
      if (typeof data !== 'string' || !data || callbackDataBytes(data) > CALLBACK_DATA_MAX_BYTES) {
        return reply.code(400).send({ error: 'Неверные данные кнопки' });
      }
      // Пределы — ДО чтения базы (аудит 26.10): частые нажатия не крутят выборки. Предел человека — сразу; бота — как только
      // известен собеседник (одна выборка доступа), до карточки бота и сообщения.
      if (await tooMany(reply, `cbq:${me}`, CALLBACK_USER_RATE)) return reply;
      const access = await directAccess(req.params.id, me);
      if (!access) return notFound(reply);
      if (await tooMany(reply, `cbqbot:${access.peerId}`, CALLBACK_BOT_RATE)) return reply;
      const c = await botConv(req.params.id, me, access);
      if (!c) return notFound(reply);
      // Выключен или приватный, а нажимает не владелец (решение A, 26.10) — 403 с причиной, как у отправки.
      const why = botUnavailableFor(c.bot, (await readBotSettings()).enabled === true, me);
      if (why) return reply.code(403).send({ error: why === 'disabled' ? 'Бот выключен' : BOT_UNAVAILABLE_ERRORS.private, code: BOT_UNAVAILABLE_CODE, reason: why });
      const view = await messageFor(req.params.mid, me);
      if (!view || 'gone' in view || view.conversationId !== c.access.conversationId) return notFound(reply);
      const msg = view as ConvMessage;
      if (msg.author.id !== c.bot.userId) return reply.code(400).send({ error: 'Это не сообщение бота' });
      // Точное совпадение с кнопкой ТЕКУЩЕЙ клавиатуры: бот сменил кнопки — старое нажатие не уходит (клиент перечитает).
      if (!keyboardHasData(msg.keyboard, data)) return reply.code(409).send({ error: 'stale_button' });
      if (!(await acquirePending(`u:${me}`, CALLBACK_PENDING_PER_USER))) {
        return reply.header('Retry-After', '5').code(429).send({ error: 'Слишком часто', retryAfter: 5 });
      }
      if (!(await acquirePending(`b:${c.bot.userId}`, CALLBACK_PENDING_PER_BOT))) {
        await releasePending(`u:${me}`);
        return reply.header('Retry-After', '5').code(429).send({ error: 'Бот занят', retryAfter: 5 });
      }
      try {
        const botView = await messageFor(msg.id, c.bot.userId);
        if (!botView || 'gone' in botView) return notFound(reply);
        const [meRow] = await db.select().from(users).where(eq(users.id, me)).limit(1);
        if (!meRow) return notFound(reply);
        const queryId = await createCallbackQuery({ botId: c.bot.userId, userId: me, conversationId: c.access.conversationId, messageId: msg.id });
        await pushUpdate(c.bot.userId, 'callback_query', {
          id: queryId,
          from: toWireUser({ ...meRow, bot: false }),
          message: toWireMessage(botView as ConvMessage),
          data,
          date: unixSeconds(Date.now()),
        });
        kickWebhook(c.bot.userId);
        const gone = new AbortController();
        // Ответ ещё не отправлен — 'close' у ответа значит обрыв соединения (у запроса 'close' бывает и после чтения тела).
        reply.raw.on('close', () => gone.abort());
        const answer = await waitCallbackAnswer(queryId, CALLBACK_QUERY_WAIT_S * 1000, gone.signal);
        const out: BotCallbackResult = answer ?? { timeout: true };
        return out;
      } finally {
        await releasePending(`u:${me}`);
        await releasePending(`b:${c.bot.userId}`);
      }
    });
  });
}
