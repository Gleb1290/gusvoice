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
  htmlToMarkers,
  PARSE_MODE_UNSUPPORTED,
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
import { and, eq } from 'drizzle-orm';
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
  const token = botTokenFromHeader(req.headers.authorization);
  if (!token) throw unauthorized();
  const found = await botByToken(token);
  if (!found || found.bot.disabledAt) throw unauthorized();
  const settings = await readBotSettings();
  if (!settings.enabled) throw new BotApiError(403, 'Forbidden: bots are disabled on this instance');
  return { bot: found.bot, user: found.user, allowInternal: settings.allowInternalWebhooks };
}

async function wireMe(ctx: BotCtx) {
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

function kickPolls(botId: string | null, err: BotApiError): void {
  const ids = botId ? [botId] : [...polls.keys()];
  for (const id of ids) for (const k of [...(polls.get(id) ?? [])]) k(err);
}

/**
 * Один потребитель журнала (решение владельца 26.10, C, как Telegram 409): новый getUpdates или WS выбивает прежних —
 * висящий getUpdates отвечает 409 `POLL_CONFLICT`, WS закрывается 4009 (`except` — сам новый сокет). SDK считает это
 * фатальным: запущены два экземпляра бота.
 */
function takeOverConsumer(botId: string, except?: BotSocket): void {
  kickPolls(botId, new BotApiError(409, POLL_CONFLICT));
  for (const s of [...(sockets.get(botId) ?? [])]) {
    if (s === except) continue;
    // Из перечня — сразу: 'close' придёт позже (рукопожатие), а новый сокет уже меряет предел `BOT_WS_PER_BOT`.
    sockets.get(botId)?.delete(s);
    try {
      s.close(4009, 'terminated by other connection');
    } catch {
      /* уже закрыт */
    }
  }
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
      const rows = await updatesFrom(botId, from, q.limit ?? 100, q.allowed_updates);
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
    return await wireMe(ctx);
  },

  async getupdates(ctx, p, { req, reply }) {
    if (ctx.bot.webhookUrl) {
      throw new BotApiError(409, WEBHOOK_ACTIVE_CONFLICT);
    }
    const q = getUpdatesParams.parse(p);
    await limit(`botpoll:${ctx.bot.userId}`, BOT_POLL_RATE);
    const botId = ctx.bot.userId;
    // Один потребитель журнала (решение C, 26.10, как Telegram): этот запрос выбивает висящий getUpdates (409) и WS (4009).
    takeOverConsumer(botId);
    const gone = new AbortController();
    // Выбили (другой потребитель) или сняли доступ (перевыпуск токена, выключение — `closeBotSockets`): ошибка вместо пачки.
    let kicked: BotApiError | null = null;
    const kick = (e: BotApiError): void => {
      kicked = e;
      gone.abort();
    };
    const mine = polls.get(botId) ?? new Set<(e: BotApiError) => void>();
    mine.add(kick);
    polls.set(botId, mine);
    try {
      if (q.offset !== undefined && q.offset > 0) await confirmUpdates(botId, q.offset);
      const from = q.offset !== undefined && q.offset > 0 ? q.offset : 0;
      const deadline = Date.now() + (q.timeout ?? 0) * 1000;
      // Запрос оборвали (бот перезапустился) — не держать ожидание до конца срока. 'close' у ОТВЕТА (как `botPress.ts`): у
      // запроса POST 'close' приходит уже после чтения тела, и обрыв клиента он не ловит (аудит 26.10).
      (reply?.raw ?? req.raw).on('close', () => gone.abort());
      return await pollLoop(botId, from, deadline, q, gone, () => kicked);
    } finally {
      mine.delete(kick);
      if (mine.size === 0 && polls.get(botId) === mine) polls.delete(botId);
    }
  },


  async setwebhook(ctx, p) {
    const q = setWebhookParams.parse(p);
    const bad = await checkHookTarget(q.url, ctx.allowInternal);
    if (bad) throw new BotApiError(400, `Bad Request: bad webhook: ${hookUrlErrorEn(bad)}`);
    await db
      .update(bots)
      .set({
        webhookUrl: q.url,
        webhookSecret: q.secret_token,
        webhookFailures: 0,
        webhookLastError: null,
        webhookLastErrorAt: null,
        webhookDisabledAt: null,
        // Пакетная доставка (#231) — по согласию бота; без флага — по одному событию, как раньше.
        webhookBatch: q.batch === true,
      })
      .where(eq(bots.userId, ctx.bot.userId));
    if (q.drop_pending_updates) await dropUpdates(ctx.bot.userId);
    resetWebhookRetry(ctx.bot.userId);
    // Адрес и WS сразу — дублировали бы друг друга: WS закрывается (как getUpdates отвечает 409).
    closeBotSockets(ctx.bot.userId, 4009, 'webhook is active');
    kickWebhook(ctx.bot.userId);
    return true;
  },

  async deletewebhook(ctx, p) {
    const q = deleteWebhookParams.parse(p);
    await db
      .update(bots)
      .set({ webhookUrl: null, webhookSecret: null, webhookFailures: 0, webhookLastError: null, webhookLastErrorAt: null, webhookDisabledAt: null })
      .where(eq(bots.userId, ctx.bot.userId));
    resetWebhookRetry(ctx.bot.userId);
    if (q.drop_pending_updates) await dropUpdates(ctx.bot.userId);
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
    const text = q.parse_mode ? botHtml((q.text ?? '').trim(), q.parse_mode).trim() : (q.text ?? '').trim();
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
    const text = q.parse_mode ? botHtml(q.text.trim(), q.parse_mode).trim() : q.text.trim();
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
    const { access } = await chatFor(ctx, q.chat_id);
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
    for (const [emoji, op] of steps) {
      const res = await reactMessage(botId, access, q.message_id, emoji, op, new Set());
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

/** `parse_mode` в ЛС (#231): `HTML` → наши маркеры, прочее — 400. */
function botHtml(text: string, mode: string): string {
  if (mode.trim().toLowerCase() === 'html') return htmlToMarkers(text);
  throw new BotApiError(400, PARSE_MODE_UNSUPPORTED);
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
  on(event: 'message' | 'close' | 'error' | 'pong', cb: (...args: any[]) => void): void;
}
const sockets = new Map<string, Set<BotSocket>>();

/**
 * Закрыть WS бота (`null` — всех ботов): токен перевыпущен, бот выключен/удалён, задан адрес доставки. Висящий getUpdates
 * тех же ботов просыпается и отвечает ошибкой по коду (аудит 26.10, п.8): 4001 → 401, 4003 → 403, 4009 → 409 — а не отдаёт
 * пачку по уже снятому доступу.
 */
export function closeBotSockets(botId: string | null, code: number, reason: string): void {
  kickPolls(
    botId,
    code === 4003
      ? new BotApiError(403, 'Forbidden: bots are disabled on this instance')
      : code === 4009
        ? new BotApiError(409, WEBHOOK_ACTIVE_CONFLICT)
        : unauthorized(),
  );
  const ids = botId ? [botId] : [...sockets.keys()];
  for (const id of ids) {
    for (const s of [...(sockets.get(id) ?? [])]) {
      try {
        s.close(code, reason);
      } catch {
        /* уже закрыт */
      }
    }
  }
}

function wsSend(s: BotSocket, msg: Record<string, unknown>): void {
  try {
    s.send(JSON.stringify(msg));
  } catch {
    /* закрывается */
  }
}

/**
 * WS: `GET /api/bot/v1/ws?offset=N` с тем же заголовком. Сервер: `{op:"hello", bot}`, затем `{op:"update", update}` по порядку
 * с `offset` (всё до него подтверждено, как у getUpdates); клиент подтверждает `{op:"ack", offset:N}` (всё до N), может слать
 * `{op:"ping"}` → `{op:"pong"}`. Пинг кадрами раз в 30 с; без ответа — обрыв. Коды закрытия: 4001 — токен/бот, 4003 — боты
 * выключены, 4009 — задан адрес доставки ИЛИ подключился другой потребитель (новый WS/getUpdates, решение C 26.10),
 * 4029 — предел частоты.
 */
async function serveBotSocket(socket: BotSocket, req: FastifyRequest): Promise<void> {
  let ctx: BotCtx;
  try {
    ctx = await authBot(req);
    await limit(`botpoll:${ctx.bot.userId}`, BOT_POLL_RATE);
  } catch (e) {
    const code = e instanceof BotApiError ? (e.code === 403 ? 4003 : e.code === 429 ? 4029 : 4001) : 4001;
    socket.close(code, e instanceof BotApiError ? e.description : 'Unauthorized');
    return;
  }
  const botId = ctx.bot.userId;
  if (ctx.bot.webhookUrl) {
    socket.close(4009, 'webhook is active');
    return;
  }
  // Сокет мог закрыться, пока шёл вход: обработчика `close` ещё нет, и он навсегда занял бы место в пределе на бота.
  if (socket.readyState !== undefined && socket.readyState !== 1) return;
  // Один потребитель (решение C, 26.10): новый WS выбивает прежние (4009) и висящий getUpdates (409). `BOT_WS_PER_BOT` = 1.
  takeOverConsumer(botId, socket);
  const mine = sockets.get(botId) ?? new Set<BotSocket>();
  if (mine.size >= BOT_WS_PER_BOT) {
    socket.close(4029, 'too many connections');
    return;
  }
  mine.add(socket);
  sockets.set(botId, mine);

  const offsetRaw = Number((req.query as Record<string, unknown> | undefined)?.offset);
  let cursor = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  // Подтверждённое (`?offset`, `ack`) бот забрал — «прочитано» по этим беседам (`markTakenRead`).
  const confirm = (offset: number): Promise<void> =>
    confirmUpdates(botId, offset)
      .then((rows) => markTakenRead(botId, rows))
      .catch(() => {});
  // Без ожидания: `updatesFrom` всё равно читает от `cursor`, а `await` здесь открывал окно, где закрытие сокета
  // приходило раньше обработчика `close` (место в пределе и будильник оставались висеть).
  if (cursor > 0) void confirm(cursor);
  let closed = false;
  let pumping = false;
  let pumpAgain = false;
  const pump = async (): Promise<void> => {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        for (;;) {
          if (closed) return;
          const rows = await updatesFrom(botId, cursor, 100);
          if (rows.length === 0) break;
          for (const r of rows) wsSend(socket, { op: 'update', update: wireUpdateOf(r) });
          cursor = rows[rows.length - 1].updateId + 1;
        }
      } while (pumpAgain);
    } catch (err) {
      console.warn('[bots] WS:', err instanceof Error ? err.message : err);
    } finally {
      pumping = false;
    }
  };
  // Будильник ДО первой выборки, а качать начинаем после подтверждения подписки (#229): иначе событие, записанное
  // между выборкой и SUBSCRIBE, ждало бы следующего. Будильник до старта молча пропускаем — первая выборка его покроет
  // (событие в журнале раньше, чем его PUBLISH). Повторы невозможны: `cursor` растёт, выборки идут по одной (`pumping`).
  let started = false;
  const wake = listenBotWake(botId, () => {
    if (started) void pump();
  });
  const off = wake.off;
  let alive = true;
  socket.on('pong', () => {
    alive = true;
  });
  const pinger = setInterval(() => {
    if (!alive) {
      try {
        socket.terminate ? socket.terminate() : socket.close();
      } catch {
        /* уже */
      }
      return;
    }
    alive = false;
    try {
      socket.ping?.();
    } catch {
      /* уже */
    }
  }, BOT_WS_PING_MS);
  pinger.unref();
  socket.on('message', (raw: unknown) => {
    alive = true;
    let msg: { op?: unknown; offset?: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.op === 'ping') wsSend(socket, { op: 'pong' });
    else if (msg.op === 'ack' && typeof msg.offset === 'number' && Number.isInteger(msg.offset) && msg.offset > 0) {
      void confirm(msg.offset);
    }
  });
  socket.on('close', () => {
    closed = true;
    clearInterval(pinger);
    off();
    mine.delete(socket);
    if (mine.size === 0) sockets.delete(botId);
  });
  wsSend(socket, { op: 'hello', bot: wireMe(ctx) });
  await wake.ready;
  if (closed) return;
  started = true;
  await pump();
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

    const handle = async (req: FastifyRequest, reply: FastifyReply) => {
      const name = String((req.params as { method?: string }).method ?? '').toLowerCase();
      const fn = Object.hasOwn(methods, name) ? methods[name] : undefined;
      // Сначала вход: без токена не подсказываем, какие методы есть.
      const ctx = await authBot(req);
      await limit(`botrq:${ctx.bot.userId}`, BOT_RATE);
      if (!fn) throw new BotApiError(404, 'Not Found: method not found');
      const files: Upload[] = [];
      let params: Params = { ...((req.query as Params | undefined) ?? {}) };
      if (req.method === 'POST') {
        if (req.isMultipart()) {
          for await (const part of req.parts({
            limits: { files: WEBHOOK_FILES_MAX, fileSize: WEBHOOK_FILE_MAX_BYTES, fields: 16, fieldSize: BODY_LIMIT },
          })) {
            if (part.type === 'file') {
              const buffer = await part.toBuffer();
              if (!isWebhookFileField(part.fieldname)) throw new BotApiError(400, 'Bad Request: files go in fields files[0]…files[9]');
              files.push({ name: part.filename || 'file', mime: part.mimetype || 'application/octet-stream', buffer });
            } else params[part.fieldname] = String(part.value ?? '');
          }
        } else if (req.body && typeof req.body === 'object') params = { ...params, ...(req.body as Params) };
      }
      if (files.length > 0 && name !== 'sendmessage') throw new BotApiError(400, 'Bad Request: files are accepted only by sendMessage');
      const result = await fn(ctx, params, { files, req, reply });
      return reply.send(okBody(result));
    };
    api.get('/bot/v1/:method', handle);
    api.post('/bot/v1/:method', { bodyLimit: BODY_LIMIT }, handle);
  });
}
