/**
 * Bot API v1 (#229, этап 1 — ЛС): `GET|POST /api/bot/v1/<метод>` и WS `/api/bot/v1/ws`. Провод — `bots/botWire.ts`.
 *
 * Вход — заголовок `Authorization: Bot gvb_…` (своя проверка, НЕ `requireAuth`: у бота нет JWT и поколения токена; его токен
 * не открывает маршруты людей, а их JWT — эти). Ответ — `{ok:true, result}` / `{ok:false, error_code, description,
 * retry_after?}` (+ `Retry-After` у 429). Параметры — JSON, форма, multipart или строка запроса.
 *
 * Правила: бот не пишет первым — отправка только в беседу 1:1, где он участник (беседу открывает человек: у бота нет
 * маршрута её создать); приватного бота открывает только владелец (`routes/conv.ts`); ботов нет в группах и федерации.
 * Отправка — тем же путём, что сообщение человека (`sendMessage` → `fanOutSend` → журнал, WS, пуш; ✓✓ — `markRead`).
 * Пределы (`rateHit`): все методы бота, отправка в одну беседу, ожидание событий. Выключен админом / токен не тот — 401;
 * боты выключены на инстансе — 403.
 */
import type { ConvMessage } from '@gusvoice/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { attachmentUploadBlock, clientIp, rateHit } from '../authGuard.js';
import { resolveAttachmentMime, sanitizeFilename } from '../attachmentRules.js';
import { createPending, DailyQuotaError, privateAttachmentsReady, attachmentStore } from '../attachments.js';
import { isBlockedBy } from '../blocks.js';
import {
  BOT_API_FEATURES,
  BOT_API_VERSION,
  BOT_CHAT_RATE,
  BOT_POLL_RATE,
  BOT_RATE,
  BOT_WS_PER_BOT,
  BOT_WS_PING_MS,
  BotApiError,
  botTokenFromHeader,
  CALLBACK_QUERY_INVALID,
  clearedWebhook,
  unixSeconds,
  webhookErrorWire,
} from '../bots/botRules.js';
import {
  armBotWake,
  botByToken,
  confirmUpdates,
  dropUpdates,
  listenBotWake,
  commandsFor,
  pendingCount,
  readBotSettings,
  setBotCommands,
  updatesFrom,
  wireUpdateOf,
  type BotRow,
  type UserRow,
} from '../bots/botStore.js';
import { markTakenRead } from '../bots/botRead.js';
import { chatMemberUpdate, recordBotUpdates } from '../bots/botUpdates.js';
import { kickWebhook, resetWebhookRetry, startBotJobs } from '../bots/webhookDelivery.js';
import {
  answerCallbackQueryParams,
  botText,
  deleteMessageParams,
  deleteMyCommandsParams,
  dmChat,
  editMessageReplyMarkupParams,
  editMessageTextParams,
  getMyCommandsParams,
  setMyCommandsParams,
  errorBody,
  getChatParams,
  getUpdatesParams,
  okBody,
  sendChatActionParams,
  sendMessageParams,
  setWebhookParams,
  setMessageReactionParams,
  deleteWebhookParams,
  toWireMessage,
  toWireUser,
} from '../bots/botWire.js';
import {
  type ConvAccess,
  configureBotConv,
  deleteMessage,
  deliver,
  editMessage,
  editMessageKeyboard,
  loadAccess,
  reactMessage,
  reactionAllowed,
  markRead,
  messageFor,
  sendMessage,
  type AttachmentRef,
} from '../conversations.js';
import { fanOutSend } from '../convSendFanout.js';
import { db } from '../db/index.js';
import { bots, conversationMessageReactions, conversationMessages, users } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import { relayBotTyping } from '../gateway.js';
import { checkHookTarget, hookUrlErrorEn } from '../safeFetch.js';
import { attachmentBlocked, isOwnMediaUrl } from '../storage.js';
import { embedsFallbackText, isWebhookFileField, normalizeEmbeds, WEBHOOK_FILE_MAX_BYTES, WEBHOOK_FILES_MAX } from '../webhookRules.js';


const unauthorized = () => new BotApiError(401, 'Unauthorized');
const chatNotFound = () => new BotApiError(400, 'Bad Request: chat not found');
/** Запросов с одного адреса — ДО базы (поток мусорных токенов не превращается в поток выборок, как у вебхуков). */
const IP_RATE = { max: 600, windowS: 60 } as const;
/** Тело метода (JSON/форма); файлы multipart — свои пределы (как у вебхука). */
const BODY_LIMIT = 64 * 1024;
/** Бюджет содержимого. На границы и заголовки частей даём отдельный запас BODY_LIMIT. */
const MULTIPART_LIMIT = 64 * 1024 * 1024;
const MULTIPART_IN_FLIGHT_MAX = 2;
const MULTIPART_IDLE_MS = 15_000;
const MULTIPART_DEADLINE_MS = 120_000;
const multipartBots = new Set<string>();

interface BotCtx {
  bot: BotRow;
  user: UserRow;
  allowInternal: boolean;
}
type Params = Record<string, unknown>;
interface Upload {
  name: string;
  mime: string;
  buffer: Buffer;
}
type Handler = (ctx: BotCtx, p: Params, extra: { files: Upload[]; req: FastifyRequest; reply?: FastifyReply }) => Promise<unknown>;

async function limit(key: string, rate: { max: number; windowS: number }): Promise<void> {
  const wait = await rateHit(key, rate.max, rate.windowS);
  if (wait) throw new BotApiError(429, `Too Many Requests: retry after ${wait}`, wait);
}

/** Вход бота: заголовок → бот → выключен ли он / боты на инстансе. */
async function authBot(req: FastifyRequest): Promise<BotCtx> {
  await limit(`botip:${clientIp(req)}`, IP_RATE);
  return readBotContext(req);
}

async function readBotContext(req: FastifyRequest): Promise<BotCtx> {
  const token = botTokenFromHeader(req.headers.authorization);
  if (!token) throw unauthorized();
  const found = await botByToken(token);
  if (!found || found.bot.disabledAt) throw unauthorized();
  const settings = await readBotSettings();
  if (!settings.enabled) throw new BotApiError(403, 'Forbidden: bots are disabled on this instance');
  return { bot: found.bot, user: found.user, allowInternal: settings.allowInternalWebhooks };
}

function wireMe(ctx: BotCtx) {
  return {
    ...toWireUser({ ...ctx.user, bot: true }),
    description: ctx.bot.description,
    about: ctx.bot.about,
    public: ctx.bot.public,
    api_version: BOT_API_VERSION,
    features: [...BOT_API_FEATURES],
    // Этап 3 (#231, добавление): бот видит потерю событий (потолок журнала); очередь — `getWebhookInfo.pending_update_count`.
    dropped_update_count: ctx.bot.droppedUpdateCount,
  };
}

/** Беседа бота: 1:1, он участник, собеседник есть. Иначе «chat not found» (не подсказываем, существует ли чужая). */
async function chatFor(ctx: BotCtx, chatId: string): Promise<{ access: ConvAccess; peer: UserRow }> {
  const access = await loadAccess(chatId, ctx.bot.userId);
  if (!access || access.kind !== 'direct' || access.saved || !access.peerId) throw chatNotFound();
  const [peer] = await db.select().from(users).where(eq(users.id, access.peerId)).limit(1);
  if (!peer) throw chatNotFound();
  return { access, peer };
}

/**
 * Этап 3 (#231): `chat_id` — беседа (как раньше) или канал/сервер. Беседы бота нет → модуль каналов (ЛЕНИВО: у этого файла
 * закрытый перечень импортов, `botApi.wake.test.ts`); id беседы и канала — `util.id()`, пересечься не могут.
 */
async function channelApi(ctx: BotCtx, chatId: unknown) {
  if (typeof chatId === 'string' && chatId.trim() && (await loadAccess(chatId.trim(), ctx.bot.userId))) return null;
  return import('../bots/botChannel.js');
}

/** Метод только серверов (#231) — целиком в модуле каналов. */
function serverMethod(name: string): Handler {
  return async (ctx, p) => {
    const mod = (await import('../bots/botChannel.js')) as unknown as Record<string, (c: BotCtx, q: Params) => Promise<unknown>>;
    const run = mod[name];
    return run(ctx, p);
  };
}

/** Этап 4 (#232): метод голоса — целиком в `bots/botVoice.ts` (лениво: тот модуль тянет LiveKit). */
function voiceMethod(name: 'voiceJoin' | 'voiceLeave' | 'voiceMembers'): Handler {
  return async (ctx, p) => {
    const mod = await import('../bots/botVoice.js');
    return mod[name](ctx, p);
  };
}

async function wireMessageFor(messageId: string, botId: string) {
  const view = await messageFor(messageId, botId);
  if (!view || 'gone' in view) throw new BotApiError(400, 'Bad Request: message not found');
  return toWireMessage(view as ConvMessage);
}

/** Файлы multipart → закрытые вложения ЛС (`createPending`, как `POST /conv/:id/attachments`) → ссылки для `sendMessage`. */
async function storeFiles(ctx: BotCtx, conversationId: string, files: Upload[]): Promise<AttachmentRef[]> {
  if (files.length === 0) return [];
  if (!privateAttachmentsReady() && !(await attachmentStore.ensureReady())) throw new BotApiError(503, 'Service Unavailable: file storage is not ready');
  const refs: AttachmentRef[] = [];
  for (const f of files) {
    const name = sanitizeFilename(f.name || 'file');
    if (attachmentBlocked(f.mime, name)) throw new BotApiError(415, 'Bad Request: this file type is not allowed (SVG/HTML)');
    const wait = await attachmentUploadBlock(ctx.bot.userId);
    if (wait) throw new BotApiError(429, `Too Many Requests: retry after ${wait}`, wait);
    const contentType = resolveAttachmentMime(f.mime, f.buffer.subarray(0, 64));
    try {
      const id = await createPending({ ownerId: ctx.bot.userId, conversationId, name, contentType, bytes: f.buffer, daily: true });
      refs.push({ id });
    } catch (e) {
      if (e instanceof DailyQuotaError) throw new BotApiError(429, `Too Many Requests: ${e.message}`);
      throw e;
    }
  }
  return refs;
}

/** Telegram: второй потребитель журнала (409 прежнему getUpdates). Точный текст — на него смотрят готовые библиотеки. */
const POLL_CONFLICT = 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';
const WEBHOOK_ACTIVE_CONFLICT = "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first";

/**
 * Висящие getUpdates по ботам (в процессе): прерыватель получает ошибку, которую отдаст ждущий вместо пачки. Зовут
 * `takeOverConsumer` (новый потребитель) и `closeBotSockets` (токен перевыпущен, бот/боты выключены, задан адрес).
 */
const polls = new Map<string, Set<(e: BotApiError) => void>>();
const pendingConsumers = new Map<string, Set<(e: BotApiError) => void>>();

/**
 * Между первым входом и привязкой были асинхронные операции. Перечитываем доступ, а об отзыве
 * во время самого перечитывания узнаём из того же вызова, который отключает активных потребителей.
 * bind регистрирует новый транспорт синхронно, до своего первого await.
 */
async function bindConsumer<T>(botId: string, req: FastifyRequest, bind: (ctx: BotCtx) => Promise<T>): Promise<T> {
  let revoked: BotApiError | undefined;
  const invalidate = (err: BotApiError) => { revoked = err; };
  const pending = pendingConsumers.get(botId) ?? new Set();
  pending.add(invalidate);
  pendingConsumers.set(botId, pending);
  try {
    const ctx = await readBotContext(req);
    if (revoked) throw revoked;
    if (ctx.bot.userId !== botId) throw unauthorized();
    if (ctx.bot.webhookUrl) throw new BotApiError(409, WEBHOOK_ACTIVE_CONFLICT);
    return bind(ctx);
  } catch (err) {
    throw revoked ?? err;
  } finally {
    pending.delete(invalidate);
    if (pending.size === 0) pendingConsumers.delete(botId);
  }
}

function kickPolls(botId: string | null, err: BotApiError): void {
  const ids = botId ? [botId] : [...polls.keys()];
  for (const id of ids) for (const k of [...(polls.get(id) ?? [])]) k(err);
}

/**
 * Один потребитель журнала (решение владельца 26.10, C, как Telegram 409): новый getUpdates или WS выбивает прежних —
 * висящий getUpdates отвечает 409 `POLL_CONFLICT`, WS закрывается 4009. SDK считает это
 * фатальным: запущены два экземпляра бота.
 */
function takeOverConsumer(botId: string): void {
  kickPolls(botId, new BotApiError(409, POLL_CONFLICT));
  for (const stop of sockets.get(botId)?.values() ?? []) stop(4009, 'terminated by other connection');
}

/** Ожидание getUpdates: выборка → пусто → будильник; выбили/сняли доступ (`kicked`) — ошибка, пачку не отдаём. */
async function pollLoop(
  botId: string,
  from: number,
  deadline: number,
  q: { limit?: number; allowed_updates?: string[] },
  gone: AbortController,
  kicked: () => BotApiError | null,
): Promise<unknown> {
  let alarm: ReturnType<typeof armBotWake> | null = null;
  try {
    for (;;) {
      const k0 = kicked();
      if (k0) throw k0;
      // Будильник взводится ДО выборки и выборка ждёт подтверждения подписки: событие, записанное между выборкой и
      // SUBSCRIBE, иначе проспали бы до конца `timeout` (#229). Будильник — только сигнал, правда — журнал.
      const before = deadline - Date.now();
      alarm = before > 0 && !gone.signal.aborted ? armBotWake(botId, before, gone.signal) : null;
      if (alarm) await alarm.ready;
      const rows = !gone.signal.aborted ? await updatesFrom(botId, from, q.limit ?? 100, q.allowed_updates) : [];
      // Выбили / сняли доступ, пока шла выборка — пачку не отдаём (её заберёт новый потребитель).
      const k1 = kicked();
      if (k1) throw k1;
      const left = deadline - Date.now();
      if (!alarm || rows.length > 0 || left <= 0 || gone.signal.aborted) {
        // Бот забрал события — его «прочитано» в этих беседах (как в Telegram: при получении, а не при ответе).
        if (rows.length > 0) await markTakenRead(botId, rows);
        return rows.map(wireUpdateOf);
      }
      await alarm.wait;
    }
  } finally {
    alarm?.cancel();
  }
}

const methods: Record<string, Handler> = {
  async getme(ctx) {
    return wireMe(ctx);
  },

  async getupdates(ctx, p, { req, reply }) {
    if (ctx.bot.webhookUrl) {
      throw new BotApiError(409, WEBHOOK_ACTIVE_CONFLICT);
    }
    const q = getUpdatesParams.parse(p);
    await limit(`botpoll:${ctx.bot.userId}`, BOT_POLL_RATE);
    const botId = ctx.bot.userId;
    return bindConsumer(botId, req, async () => {
      if (reply?.raw.destroyed) return;
      takeOverConsumer(botId);
      const gone = new AbortController();
      let kicked: BotApiError | null = null;
      const kick = (err: BotApiError): void => {
        kicked = err;
        gone.abort();
      };
      const mine = polls.get(botId) ?? new Set<(e: BotApiError) => void>();
      mine.add(kick);
      polls.set(botId, mine);
      // У запроса POST 'close' приходит после чтения тела. Обрыв клиента виден на ответе.
      const response = reply?.raw ?? req.raw;
      const onClose = () => gone.abort();
      response.on('close', onClose);
      try {
        const from = q.offset !== undefined && q.offset > 0 ? q.offset : 0;
        if (from > 0) await confirmUpdates(botId, from);
        const deadline = Date.now() + (q.timeout ?? 0) * 1000;
        const result = await pollLoop(botId, from, deadline, q, gone, () => kicked);
        if (kicked) throw kicked;
        if (reply && !gone.signal.aborted) return reply.send(okBody(result));
        return result;
      } finally {
        response.off('close', onClose);
        mine.delete(kick);
        if (mine.size === 0 && polls.get(botId) === mine) polls.delete(botId);
      }
    });
  },


  async setwebhook(ctx, p) {
    const q = setWebhookParams.parse(p);
    const bad = await checkHookTarget(q.url, ctx.allowInternal);
    if (bad) throw new BotApiError(400, `Bad Request: bad webhook: ${hookUrlErrorEn(bad)}`);
    const active = and(eq(bots.userId, ctx.bot.userId), eq(bots.tokenHash, ctx.bot.tokenHash), isNull(bots.disabledAt));
    await db.transaction(async (tx) => {
      const [updated] = await tx.update(bots).set({
        ...clearedWebhook,
        webhookUrl: q.url,
        webhookSecret: q.secret_token,
        webhookBatch: q.batch === true,
      }).where(active).returning({ id: bots.userId });
      if (!updated) throw unauthorized();
      if (q.drop_pending_updates) await dropUpdates(updated.id, tx);
    });
    resetWebhookRetry(ctx.bot.userId);
    // Адрес и WS сразу — дублировали бы друг друга: WS закрывается (как getUpdates отвечает 409).
    closeBotSockets(ctx.bot.userId, 4009, 'webhook is active');
    kickWebhook(ctx.bot.userId);
    return true;
  },

  async deletewebhook(ctx, p) {
    const q = deleteWebhookParams.parse(p);
    const active = and(eq(bots.userId, ctx.bot.userId), eq(bots.tokenHash, ctx.bot.tokenHash), isNull(bots.disabledAt));
    await db.transaction(async (tx) => {
      const [updated] = await tx.update(bots).set(clearedWebhook).where(active).returning({ id: bots.userId });
      if (!updated) throw unauthorized();
      if (q.drop_pending_updates) await dropUpdates(updated.id, tx);
    });
    resetWebhookRetry(ctx.bot.userId);
    return true;
  },

  async getwebhookinfo(ctx) {
    const b = ctx.bot;
    return {
      url: b.webhookUrl ?? '',
      pending_update_count: await pendingCount(b.userId),
      failures: b.webhookFailures,
      ...(b.webhookLastErrorAt && b.webhookLastError ? { last_error_date: unixSeconds(b.webhookLastErrorAt), last_error_message: webhookErrorWire(b.webhookLastError) } : {}),
      ...(b.webhookDisabledAt ? { disabled_date: unixSeconds(b.webhookDisabledAt) } : {}),
      // Этап 3 (#231, добавления).
      ...(b.webhookUrl ? { batch: b.webhookBatch } : {}),
      dropped_update_count: b.droppedUpdateCount,
    };
  },

  async sendmessage(ctx, p, { files }) {
    const ch = await channelApi(ctx, p.chat_id);
    if (ch) return ch.channelSendMessage(ctx, p, files);
    const q = sendMessageParams.parse(p);
    const botId = ctx.bot.userId;
    const { access, peer } = await chatFor(ctx, q.chat_id);
    if (peer.deletedAt) throw new BotApiError(403, 'Forbidden: user is deactivated');
    if (await isBlockedBy(peer.id, botId)) throw new BotApiError(403, 'Forbidden: bot was blocked by the user');
    // Повтор с тем же `client_id` (аудит 26.10): уже отправленное — то же сообщение, без второй загрузки файлов и без предела
    // частоты беседы (файлы получили бы новые id, и сверка содержимого в `sendMessage` назвала бы повтор конфликтом).
    if (q.client_id) {
      const [prev] = await db
        .select({ id: conversationMessages.id, conversationId: conversationMessages.conversationId })
        .from(conversationMessages)
        .where(and(eq(conversationMessages.authorId, botId), eq(conversationMessages.clientId, q.client_id)))
        .limit(1);
      if (prev) {
        if (prev.conversationId !== access.conversationId) throw new BotApiError(400, 'Bad Request: client_id is already used in another chat');
        return wireMessageFor(prev.id, botId);
      }
    }
    await limit(`botchat:${botId}:${access.conversationId}`, BOT_CHAT_RATE);
    // Картинки карточек — только из нашего хранилища (как у вебхука); `attachment://` в ЛС не работает: файлы беседы закрытые.
    const embeds = normalizeEmbeds(q.embeds, isOwnMediaUrl, new Map());
    const text = botText(q.text, q.parse_mode);
    if (!text && embeds.length === 0 && files.length === 0) throw new BotApiError(400, 'Bad Request: message text is empty');
    const refs = await storeFiles(ctx, access.conversationId, files);
    const fallback = !text && embeds.length > 0;
    const content = fallback ? embedsFallbackText(embeds) : text;
    const silent = q.disable_notification === true;
    const res = await sendMessage(botId, access, {
      clientId: q.client_id ?? null,
      content,
      attachments: refs,
      replyToId: q.reply_to_message_id ?? null,
      withheld: false,
      silent,
      noPreview: q.disable_link_preview === true,
      ...(embeds.length ? { embeds, embedsFallback: fallback } : {}),
      ...(q.reply_markup ? { keyboard: q.reply_markup.inline_keyboard } : {}),
    });
    if (res.kind === 'bad-reply') throw new BotApiError(400, 'Bad Request: message to reply not found');
    if (res.kind === 'bad-attachments') throw new BotApiError(400, 'Bad Request: attachment upload failed');
    if (res.kind === 'conflict') throw new BotApiError(400, 'Bad Request: client_id is already used for a different message');
    if (res.kind !== 'created' && res.kind !== 'replay') throw chatNotFound();
    if (res.kind === 'created') {
      await fanOutSend({
        me: botId,
        peerId: peer.id,
        conversationId: access.conversationId,
        row: res.row,
        delivery: { ...res.delivery, actor: botId },
        notifyRecipient: true,
        content,
        attachments: res.row.attachments,
        silent,
      });
      // Ответил — прочитал всё до своего ответа (обычно уже отмечено при получении — `markTakenRead`; здесь — когда бот
      // отвечает, не забрав событий): у бота не копится непрочитанное.
      const read = await markRead(botId, access, res.row.sortKey);
      if (read.kind === 'ok' && read.delivery) await deliver({ ...read.delivery, actor: botId });
    }
    return wireMessageFor(res.row.id, botId);
  },

  async editmessagetext(ctx, p) {
    const ch = await channelApi(ctx, p.chat_id);
    if (ch) return ch.channelEditMessageText(ctx, p);
    const q = editMessageTextParams.parse(p);
    const botId = ctx.bot.userId;
    const { access } = await chatFor(ctx, q.chat_id);
    await limit(`botchat:${botId}:${access.conversationId}`, BOT_CHAT_RATE);
    const text = botText(q.text, q.parse_mode);
    // Как Telegram: правка текста без `reply_markup` снимает кнопки (решение владельца #230).
    const res = await editMessage(botId, access, q.message_id, text, { keyboard: q.reply_markup?.inline_keyboard ?? null });
    if (res.kind === 'not-found') throw new BotApiError(400, 'Bad Request: message to edit not found');
    if (res.kind === 'forbidden') throw new BotApiError(400, "Bad Request: message can't be edited");
    if (res.kind === 'empty') throw new BotApiError(400, 'Bad Request: message text is empty');
    if (res.delivery) await deliver({ ...res.delivery, actor: botId });
    return wireMessageFor(q.message_id, botId);
  },

  // ─── Этап 2 (#230): кнопки и команды ───

  async editmessagereplymarkup(ctx, p) {
    const ch = await channelApi(ctx, p.chat_id);
    if (ch) return ch.channelEditMessageReplyMarkup(ctx, p);
    const q = editMessageReplyMarkupParams.parse(p);
    const botId = ctx.bot.userId;
    const { access } = await chatFor(ctx, q.chat_id);
    await limit(`botchat:${botId}:${access.conversationId}`, BOT_CHAT_RATE);
    // Те же кнопки — сообщение без изменений (Telegram отвечает 400 «message is not modified»; мы мягче — идемпотентно).
    const res = await editMessageKeyboard(botId, access, q.message_id, q.reply_markup?.inline_keyboard ?? null);
    if (res.kind === 'not-found') throw new BotApiError(400, 'Bad Request: message to edit not found');
    if (res.kind !== 'ok') throw new BotApiError(400, "Bad Request: message can't be edited");
    if (res.delivery) await deliver({ ...res.delivery, actor: botId });
    return wireMessageFor(q.message_id, botId);
  },

  async answercallbackquery(ctx, p) {
    const q = answerCallbackQueryParams.parse(p);
    // Модуль нажатий — лениво (как `realtime.js` в `botStore`): у этого файла закрытый перечень импортов (`botApi.wake.test.ts`).
    const { answerCallbackQuery } = await import('../bots/botCallback.js');
    const ok = await answerCallbackQuery(ctx.bot.userId, q.callback_query_id, {
      ...(q.text ? { text: q.text } : {}),
      ...(q.show_alert && q.text ? { alert: true as const } : {}),
    });
    if (!ok) throw new BotApiError(400, CALLBACK_QUERY_INVALID);
    return true;
  },

  // Области (#231): `default`, `all_private_chats` (ЛС), `all_group_chats` (серверы) — хранятся отдельно; чтение области без
  // своего списка отдаёт `default` (как Telegram).
  async setmycommands(ctx, p) {
    const q = setMyCommandsParams.parse(p);
    await setBotCommands(ctx.bot.userId, q.commands, scopeOf(q.scope));
    return true;
  },

  async getmycommands(ctx, p) {
    const q = getMyCommandsParams.parse(p);
    const scope = scopeOf(q.scope);
    if (scope === 'default') return (ctx.bot.commands ?? []).map((c) => ({ command: c.command, description: c.description }));
    return commandsFor(ctx.bot, scope === 'all_group_chats' ? 'server' : 'dm');
  },

  async deletemycommands(ctx, p) {
    const q = deleteMyCommandsParams.parse(p);
    const scope = scopeOf(q.scope);
    await setBotCommands(ctx.bot.userId, scope === 'default' ? [] : null, scope);
    return true;
  },

  async deletemessage(ctx, p) {
    const ch = await channelApi(ctx, p.chat_id);
    if (ch) return ch.channelDeleteMessage(ctx, p);
    const q = deleteMessageParams.parse(p);
    const botId = ctx.bot.userId;
    const { access } = await chatFor(ctx, q.chat_id);
    // В беседе 1:1 — и своё, и собеседника, как у человека (`othersForBoth`, С1).
    const res = await deleteMessage(botId, access, q.message_id, 'both', { othersForBoth: true });
    if (res.kind === 'not-found') throw new BotApiError(400, 'Bad Request: message to delete not found');
    if (res.kind === 'forbidden') throw new BotApiError(400, "Bad Request: message can't be deleted");
    if (res.delivery) await deliver({ ...res.delivery, actor: botId });
    return true;
  },

  async sendchataction(ctx, p) {
    const ch = await channelApi(ctx, p.chat_id);
    if (ch) return ch.channelSendChatAction(ctx, p);
    const q = sendChatActionParams.parse(p);
    const { access } = await chatFor(ctx, q.chat_id);
    await relayBotTyping(ctx.bot.userId, access.conversationId);
    return true;
  },

  async getchat(ctx, p) {
    const ch = await channelApi(ctx, p.chat_id);
    if (ch) return ch.channelGetChat(ctx, p);
    const q = getChatParams.parse(p);
    const { access, peer } = await chatFor(ctx, q.chat_id);
    return { ...dmChat(access.conversationId), user: toWireUser({ ...peer, bot: false }) };
  },

  // ─── Этап 3 (#231): реакции, закрепы, серверы ───

  /** Набор реакций бота на сообщение заменяется целиком (как Telegram); в ЛС — тем же путём, что у человека. */
  async setmessagereaction(ctx, p) {
    const ch = await channelApi(ctx, p.chat_id);
    if (ch) return ch.channelSetMessageReaction(ctx, p);
    const q = setMessageReactionParams.parse(p);
    const botId = ctx.bot.userId;
    const { access, peer } = await chatFor(ctx, q.chat_id);
    await limit(`botchat:${botId}:${access.conversationId}`, BOT_CHAT_RATE);
    const want = [...new Set((q.reaction ?? []).map((r) => r.emoji))];
    for (const e of want) if (!(await reactionAllowed(e))) throw new BotApiError(400, 'Bad Request: reaction is not allowed');
    const have = (
      await db
        .select({ emoji: conversationMessageReactions.emoji })
        .from(conversationMessageReactions)
        .where(and(eq(conversationMessageReactions.messageId, q.message_id), eq(conversationMessageReactions.userId, botId)))
    ).map((r) => r.emoji);
    const steps: [string, 'add' | 'remove'][] = [
      ...have.filter((e) => !want.includes(e)).map((e): [string, 'remove'] => [e, 'remove']),
      ...want.filter((e) => !have.includes(e)).map((e): [string, 'add'] => [e, 'add']),
    ];
    if (steps.length === 0 && !(await messageFor(q.message_id, botId))) throw new BotApiError(400, 'Bad Request: message to react not found');
    if (steps.length === 0) return true;
    const blockedActor = new Set(await isBlockedBy(peer.id, botId) ? [peer.id] : []);
    for (const [emoji, op] of steps) {
      const res = await reactMessage(botId, access, q.message_id, emoji, op, blockedActor);
      if (res.kind === 'not-found') throw new BotApiError(400, 'Bad Request: message to react not found');
      if (res.delivery) await deliver({ ...res.delivery, actor: botId, reaction: { userId: botId, emoji, op } });
    }
    return true;
  },

  async pinchatmessage(ctx, p) {
    const ch = await channelApi(ctx, p.chat_id);
    if (!ch) throw new BotApiError(400, 'Bad Request: pinning is available only in server channels');
    return ch.channelPinChatMessage(ctx, p);
  },

  async unpinchatmessage(ctx, p) {
    const ch = await channelApi(ctx, p.chat_id);
    if (!ch) throw new BotApiError(400, 'Bad Request: pinning is available only in server channels');
    return ch.channelUnpinChatMessage(ctx, p);
  },

  getchathistory: serverMethod('channelGetChatHistory'),
  getchatmember: serverMethod('serverGetChatMember'),
  getchatmembercount: serverMethod('serverGetChatMemberCount'),
  getchatmembers: serverMethod('serverGetChatMembers'),
  getmyservers: serverMethod('serverGetMyServers'),
  getserver: serverMethod('serverGetServer'),
  addchatmemberrole: serverMethod('serverAddChatMemberRole'),
  removechatmemberrole: serverMethod('serverRemoveChatMemberRole'),
  banchatmember: serverMethod('serverBanChatMember'),
  unbanchatmember: serverMethod('serverUnbanChatMember'),
  kickchatmember: serverMethod('serverKickChatMember'),
  leavechat: serverMethod('serverLeaveChat'),
  // Этап 4 (#232): голос.
  joinvoice: voiceMethod('voiceJoin'),
  leavevoice: voiceMethod('voiceLeave'),
  getvoicechatmembers: voiceMethod('voiceMembers'),
};

/** Имена методов (нижний регистр) — страж реестра `bots/botSpec.ts` сверяет с ними `BOT_METHOD_SPECS` (этап 5, #233). */
export const botMethodNames = (): string[] => Object.keys(methods);

/** Область команд из параметра (уже проверена `botWire`). */
function scopeOf(scope: { type: string } | undefined): 'default' | 'all_private_chats' | 'all_group_chats' {
  const t = scope?.type;
  return t === 'all_private_chats' || t === 'all_group_chats' ? t : 'default';
}

/** Ответ ошибкой провода (+ `Retry-After`). */
function sendError(reply: FastifyReply, e: BotApiError) {
  if (e.retryAfter) reply.header('Retry-After', String(e.retryAfter));
  return reply.code(e.code).send(errorBody(e.code, e.description, e.retryAfter));
}

function zodDescription(err: ZodError): string {
  const first = err.issues[0];
  const path = first?.path?.length ? `${first.path.join('.')}: ` : '';
  return `Bad Request: ${path}${first?.message ?? 'invalid parameters'}`;
}

// ─── WS ботов ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface BotSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  ping?(): void;
  /** 1 = OPEN (ws). Нет поля — считаем открытым. */
  readyState?: number;
  bufferedAmount?: number;
  on(event: 'message' | 'close' | 'error' | 'pong', cb: (...args: any[]) => void): void;
}
const sockets = new Map<string, Map<BotSocket, (code: number, reason: string) => void>>();
const ACK_INTERVAL_MS = 500;
const WS_BOT_COMMAND_BYTES = 1024;
const WS_OUTBOUND_BYTES = 1024 * 1024;

interface AckBatch {
  offset: number;
  timer?: ReturnType<typeof setTimeout>;
  writing: boolean;
  revision: number;
}
const ackBatches = new Map<string, AckBatch>();

/** Не более одной записи на бота за интервал, включая переподключения. Принятый ack переживает обычный close. */
function queueBotAck(botId: string, offset: number): void {
  const batch = ackBatches.get(botId) ?? { offset: 0, writing: false, revision: 0 };
  ackBatches.set(botId, batch);
  batch.offset = Math.max(batch.offset, offset);
  scheduleBotAck(botId, batch);
}

function scheduleBotAck(botId: string, batch: AckBatch): void {
  if (batch.writing || batch.timer) return;
  batch.timer = setTimeout(async () => {
    batch.timer = undefined;
    batch.writing = true;
    const offset = batch.offset;
    const revision = batch.revision;
    try {
      const rows = await confirmUpdates(botId, offset);
      if (batch.revision === revision) await markTakenRead(botId, rows);
    } catch {
      // При ошибке неподтверждённые события можно забрать повторно.
    } finally {
      batch.writing = false;
      if (batch.offset > (batch.revision === revision ? offset : 0)) scheduleBotAck(botId, batch);
      else ackBatches.delete(botId);
    }
  }, ACK_INTERVAL_MS);
  batch.timer.unref();
}

/** Закрыть WS и long poll, отменить их привязку и отложенные подтверждения при отзыве доступа. */
export function closeBotSockets(botId: string | null, code: number, reason: string): void {
  const err = code === 4003
    ? new BotApiError(403, 'Forbidden: bots are disabled on this instance')
    : code === 4009
      ? new BotApiError(409, WEBHOOK_ACTIVE_CONFLICT)
      : unauthorized();
  kickPolls(botId, err);
  const ids = botId === null ? new Set([...pendingConsumers.keys(), ...sockets.keys(), ...ackBatches.keys()]) : [botId];
  for (const id of ids) {
    for (const invalidate of pendingConsumers.get(id) ?? []) invalidate(err);
    for (const stop of sockets.get(id)?.values() ?? []) stop(code, reason);
    const batch = ackBatches.get(id);
    if (!batch) continue;
    clearTimeout(batch.timer);
    batch.timer = undefined;
    batch.offset = 0;
    batch.revision++;
    if (!batch.writing) ackBatches.delete(id);
  }
}

function wsSend(s: BotSocket, msg: Record<string, unknown>): boolean {
  if (s.readyState !== undefined && s.readyState !== 1) return false;
  const data = JSON.stringify(msg);
  if ((s.bufferedAmount ?? 0) + Buffer.byteLength(data) > WS_OUTBOUND_BYTES) return false;
  try {
    s.send(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * WS передаёт hello и события после привязки потребителя. Явный ?offset при входе работает как у getUpdates;
 * кадр ack подтверждает только диапазон, который этот сокет уже отправил.
 */
async function serveBotSocket(socket: BotSocket, req: FastifyRequest): Promise<void> {
  // ws закрывает соединение после ошибки транспорта. Подписка нужна сразу, в том числе во время входа.
  socket.on('error', () => {});
  try {
    const ctx = await authBot(req);
    await limit('botpoll:' + ctx.bot.userId, BOT_POLL_RATE);
    await bindConsumer(ctx.bot.userId, req, (fresh) => openBotSocket(socket, req, fresh));
  } catch (err) {
    if (socket.readyState !== undefined && socket.readyState !== 1) return;
    const code = err instanceof BotApiError ? ({ 403: 4003, 409: 4009, 429: 4029 } as Record<number, number>)[err.code] ?? 4001 : 4001;
    const reason = code === 4009 ? 'webhook is active' : err instanceof BotApiError ? err.description : 'Unauthorized';
    socket.close(code, reason);
  }
}

async function openBotSocket(socket: BotSocket, req: FastifyRequest, ctx: BotCtx): Promise<void> {
  if (socket.readyState !== undefined && socket.readyState !== 1) return;
  const botId = ctx.bot.userId;
  takeOverConsumer(botId);
  const mine = sockets.get(botId) ?? new Map<BotSocket, (code: number, reason: string) => void>();
  if (mine.size >= BOT_WS_PER_BOT) {
    socket.close(4029, 'too many connections');
    return;
  }

  const query = (req.query as Record<string, unknown> | undefined)?.offset;
  const offset = typeof query === 'number' || typeof query === 'string' ? Number(query) : 0;
  let cursor = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
  let acked = cursor;
  let closed = false;
  let pumping = false;
  let pumpAgain = false;

  const send = (msg: Record<string, unknown>): boolean => {
    if (closed) return false;
    if (wsSend(socket, msg)) return true;
    stop(4029, 'outbound buffer limit');
    return false;
  };
  const pump = async (): Promise<void> => {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        while (!closed) {
          const rows = await updatesFrom(botId, cursor, 100);
          if (closed || rows.length === 0) break;
          for (const r of rows) {
            if (!send({ op: 'update', update: wireUpdateOf(r) })) return;
            cursor = r.updateId + 1;
          }
        }
      } while (!closed && pumpAgain);
    } catch (err) {
      console.warn('[bots] WS:', err instanceof Error ? err.message : err);
    } finally {
      pumping = false;
    }
  };

  // Сначала подписка, затем первая выборка. Сигнал до первой выборки она сама покроет.
  let started = false;
  const wake = listenBotWake(botId, () => {
    if (started) void pump();
  });
  let alive = true;
  const pinger = setInterval(() => {
    if (!alive) {
      cleanup();
      try {
        socket.terminate ? socket.terminate() : socket.close();
      } catch {
        /* уже закрыт */
      }
      return;
    }
    alive = false;
    try {
      socket.ping?.();
    } catch {
      stop(1011, 'ping failed');
    }
  }, BOT_WS_PING_MS);
  pinger.unref();
  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearInterval(pinger);
    wake.off();
    mine.delete(socket);
    if (mine.size === 0 && sockets.get(botId) === mine) sockets.delete(botId);
  }
  function stop(code: number, reason: string): void {
    cleanup();
    try {
      socket.close(code, reason);
    } catch {
      /* уже закрыт */
    }
  }
  mine.set(socket, stop);
  sockets.set(botId, mine);
  socket.on('close', cleanup);
  socket.on('pong', () => { alive = true; });
  socket.on('message', (raw: Buffer | string, binary?: boolean) => {
    if (closed || binary) return;
    const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
    if (size > WS_BOT_COMMAND_BYTES) {
      stop(1009, 'command too large');
      return;
    }
    let msg: { op?: unknown; offset?: unknown } | null;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.op === 'ping') {
      alive = true;
      send({ op: 'pong' });
    } else if (msg.op === 'ack' && typeof msg.offset === 'number' && Number.isSafeInteger(msg.offset) && msg.offset > acked && msg.offset <= cursor) {
      alive = true;
      acked = msg.offset;
      queueBotAck(botId, acked);
    }
  });

  if (!send({ op: 'hello', bot: wireMe(ctx) })) return;
  if (cursor > 0) queueBotAck(botId, cursor);
  await wake.ready;
  if (closed) return;
  started = true;
  await pump();
}

function multipartTooLarge(): BotApiError {
  return new BotApiError(413, 'Request Entity Too Large: multipart body is too large');
}

function multipartIncomplete(): BotApiError {
  return new BotApiError(400, 'Bad Request: incomplete multipart body');
}

async function readBotMultipart(req: FastifyRequest, params: Params, files: Upload[], maxBytes = MULTIPART_LIMIT): Promise<void> {
  const maxWireBytes = maxBytes + BODY_LIMIT;
  if (Number(req.headers['content-length']) > maxWireBytes) throw multipartTooLarge();
  const raw = req.raw;
  if (raw.destroyed && !raw.readableEnded) throw multipartIncomplete();
  let wireBytes = 0;
  let payloadBytes = 0;
  let cancelFile: (() => void) | undefined;
  let rejectRead!: (err: BotApiError) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
  let failure: BotApiError | undefined;
  const stop = (err: BotApiError): void => {
    if (failure) return;
    failure = err;
    rejectRead(err);
    raw.unpipe();
    raw.pause();
    cancelFile?.();
  };
  const idleTimer = setTimeout(() => stop(new BotApiError(408, 'Request Timeout: multipart upload stalled')), MULTIPART_IDLE_MS);
  const deadline = setTimeout(() => stop(new BotApiError(408, 'Request Timeout: multipart upload took too long')), MULTIPART_DEADLINE_MS);
  idleTimer.unref();
  deadline.unref();
  const onClose = (): void => {
    if (!raw.readableEnded) stop(multipartIncomplete());
  };
  const onData = (chunk: Buffer): void => {
    if (failure) return;
    wireBytes += chunk.length;
    if (wireBytes > maxWireBytes) stop(multipartTooLarge());
    else idleTimer.refresh();
  };
  const reserve = (bytes: number): void => {
    payloadBytes += bytes;
    if (payloadBytes > maxBytes) throw multipartTooLarge();
  };
  const collect = async (): Promise<void> => {
    for await (const part of req.parts({
      limits: { files: WEBHOOK_FILES_MAX, fileSize: WEBHOOK_FILE_MAX_BYTES + 1, fields: 16, fieldSize: BODY_LIMIT + 1 },
    })) {
      if (failure) throw failure;
      if (part.type === 'file') {
        if (!isWebhookFileField(part.fieldname)) throw new BotApiError(400, 'Bad Request: files go in fields files[0]…files[9]');
        const chunks: Buffer[] = [];
        let size = 0;
        cancelFile = () => part.file.destroy();
        try {
          for await (const chunk of part.file) {
            size += chunk.length;
            if (size > WEBHOOK_FILE_MAX_BYTES) throw multipartTooLarge();
            reserve(chunk.length);
            chunks.push(chunk);
          }
          if (part.file.truncated) throw multipartTooLarge();
        } finally {
          cancelFile = undefined;
        }
        files.push({
          name: part.filename || 'file',
          mime: part.mimetype || 'application/octet-stream',
          buffer: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size),
        });
      } else {
        if (part.fieldnameTruncated || !Object.hasOwn(sendMessageParams.shape, part.fieldname)) {
          throw new BotApiError(400, 'Bad Request: unexpected multipart field');
        }
        const value = typeof part.value === 'string' ? part.value : JSON.stringify(part.value ?? '');
        const size = Buffer.byteLength(value);
        if (part.valueTruncated || size > BODY_LIMIT) throw multipartTooLarge();
        reserve(size);
        params[part.fieldname] = value;
      }
    }
  };
  // В отличие от raw.on('data'), prependListener не запускает чтение. Поток включает pipe парсера,
  // а счётчик получает каждый chunk перед ним, в том числе первый.
  raw.prependListener('data', onData);
  raw.once('close', onClose);
  try {
    await Promise.race([interrupted, collect()]);
    if (raw.aborted) throw multipartIncomplete();
  } catch (err) {
    files.length = 0;
    throw err;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(deadline);
    raw.off('data', onData);
    raw.off('close', onClose);
  }
}

async function handleBotMethod(req: FastifyRequest, reply: FastifyReply) {
  const name = String((req.params as { method?: string }).method ?? '').toLowerCase();
  const fn = Object.hasOwn(methods, name) ? methods[name] : undefined;
  // Сначала вход: без токена не подсказываем, какие методы есть.
  const multipart = req.isMultipart?.() || /^multipart\/form-data(?:\s*;|$)/i.test(req.headers['content-type'] ?? '');
  let uploadBotId: string | undefined;
  try {
    let ctx = await authBot(req);
    await limit(`botrq:${ctx.bot.userId}`, BOT_RATE);
    if (!fn) throw new BotApiError(404, 'Not Found: method not found');
    const files: Upload[] = [];
    let params: Params = { ...((req.query as Params | undefined) ?? {}) };
    if (multipart) {
      if (req.method !== 'POST' || name !== 'sendmessage') {
        throw new BotApiError(400, 'Bad Request: multipart is accepted only by POST sendMessage');
      }
      const botId = ctx.bot.userId;
      if (multipartBots.has(botId) || multipartBots.size >= MULTIPART_IN_FLIGHT_MAX) {
        throw new BotApiError(429, 'Too Many Requests: too many simultaneous uploads', 1);
      }
      multipartBots.add(botId);
      uploadBotId = botId;
      await readBotMultipart(req, params, files);
      // Загрузка могла идти долго. Проверяем токен и настройки ещё раз перед записью файлов.
      ctx = await readBotContext(req);
      if (reply.raw.destroyed) return reply;
    } else if (req.method === 'POST' && req.body && typeof req.body === 'object') {
      params = { ...params, ...(req.body as Params) };
    }
    const result = await fn(ctx, params, { files, req, reply });
    if (reply.sent || reply.raw.destroyed) return reply;
    return reply.send(okBody(result));
  } catch (err) {
    if (multipart && !req.raw.readableEnded) {
      req.raw.unpipe();
      req.raw.pause();
      reply.header('Connection', 'close');
    }
    throw err;
  } finally {
    if (uploadBotId !== undefined) multipartBots.delete(uploadBotId);
  }
}

export async function botApiRoutes(app: FastifyInstance): Promise<void> {
  // Фон ботов (доставка на адрес, уборка журнала) — когда сервер начал слушать: тесты на `inject` его не заводят.
  app.addHook('onListen', async () => startBotJobs());
  // Этап 4 (#232): `voice_state` — подписка на `presence:update` (одна на процесс; лениво — закрытый перечень импортов).
  app.addHook('onListen', async () => {
    void import('../bots/botVoiceEvents.js').then(
      (m) => m.startBotVoiceEvents(),
      (err) => console.warn('[bots] voice_state:', err instanceof Error ? err.message : err),
    );
  });
  // События беседы → журнал бота и `my_chat_member` (крючки `conversations.ts`, без импорта ботов оттуда).
  configureBotConv({
    record: recordBotUpdates,
    chatMember: chatMemberUpdate,
    enabled: async (q) => (await readBotSettings(q)).enabled,
  });
  // Этап 3 (#231): события каналов и членства серверов → журнал бота (крючки `channelEvents.ts` / `memberEvents.ts`, без
  // импорта ботов оттуда). Лениво — закрытый перечень импортов этого файла (`botApi.wake.test.ts`).
  const [{ configureChannelBots }, { configureMemberBots }, botChannel] = await Promise.all([
    import('../channelEvents.js'),
    import('../memberEvents.js'),
    import('../bots/botChannel.js'),
  ]);
  configureChannelBots({ record: botChannel.recordChannelBotUpdates });
  configureMemberBots({ changed: botChannel.memberBotUpdates });
  await app.register(async (api) => {
    // Форма (`curl -d chat_id=…`) — только здесь: остальной API формы не принимает.
    api.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: BODY_LIMIT }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
    api.setErrorHandler((err, req, reply) => {
      if (err instanceof BotApiError) return sendError(reply, err);
      if (err instanceof ZodError) return sendError(reply, new BotApiError(400, zodDescription(err)));
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return sendError(reply, new BotApiError(e.statusCode, `Bad Request: ${e.message ?? 'bad request'}`));
      req.log.error(err);
      return sendError(reply, new BotApiError(500, 'Internal Server Error'));
    });

    api.get('/bot/v1/ws', { websocket: true }, (socket, req) => {
      void serveBotSocket(socket as unknown as BotSocket, req);
    });

    api.get('/bot/v1/:method', handleBotMethod);
    api.post('/bot/v1/:method', { bodyLimit: BODY_LIMIT }, handleBotMethod);
  });
}
