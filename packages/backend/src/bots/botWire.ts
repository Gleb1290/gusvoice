/**
 * Провод Bot API v1 (#229) — ОДИН модуль со схемами zod 4: параметры методов и объекты ответа. Из этих схем потом
 * генерится OpenAPI (этап 5, `z.toJSONSchema`), поэтому ответы собираются только через функции отсюда.
 *
 * 🔴 v1 меняется ТОЛЬКО добавлениями (как протокол федерации, CLAUDE.md №11): новое поле — необязательным, переименование
 * и смена типа — `v2` рядом. Поля snake_case (как Telegram), id — наши UUID строкой, время — секунды Unix.
 *
 * Параметры приходят JSON-ом, формой (`application/x-www-form-urlencoded`), multipart или строкой запроса (GET) — числа и
 * флаги поэтому принимаются и строкой, а массивы/объекты в форме — строкой JSON (как у Telegram).
 */
import {
  ANSWER_TEXT_MAX,
  BOT_VOICE_BITRATE,
  type Attachment,
  BOT_COMMAND_DESC_MAX,
  BOT_COMMAND_RE,
  BOT_COMMANDS_MAX,
  CALLBACK_DATA_MAX_BYTES,
  callbackDataBytes,
  type ConvMessage,
  KEYBOARD_BUTTON_TEXT_MAX,
  KEYBOARD_BUTTONS_MAX,
  KEYBOARD_ROW_BUTTONS_MAX,
  KEYBOARD_URL_MAX,
  type Message,
} from '@gusvoice/shared';
import { z } from 'zod';
import { MESSAGE_TEXT_MAX, TEXT_TOO_LONG } from '../convRules.js';
import { webhookExecuteBody } from '../webhookRules.js';
import {
  BOT_COMMAND_SCOPES,
  BOT_UPDATE_TYPES,
  type BotUpdateType,
  commandScopeOk,
  duplicateCommand,
  GET_UPDATES_LIMIT_MAX,
  GET_UPDATES_TIMEOUT_MAX,
  isHttpUrlWithoutCredentials,
  unixSeconds,
  WEBHOOK_SECRET_RE,
  WEBHOOK_URL_MAX,
} from './botRules.js';

// ─── Разбор параметров ───────────────────────────────────────────────────────────────────────────────────────────────

/** Флаг: `true`/`false`, а из формы и строки запроса — `"true"`/`"1"`/`"false"`/`"0"`. */
const flag = z.preprocess((v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' || v === '' ? false : v), z.boolean());
/** Целое: число или строка из цифр. */
const int = z.preprocess((v) => (typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v), z.number().int());
/** Массив/объект: из формы приходит строкой JSON. */
function jsonish<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }, schema);
}
const id = z.string().trim().min(1).max(64);

export const getUpdatesParams = z.object({
  offset: int.optional(),
  limit: int.pipe(z.number().min(1).max(GET_UPDATES_LIMIT_MAX)).optional(),
  timeout: int.pipe(z.number().min(0).max(GET_UPDATES_TIMEOUT_MAX)).optional(),
  // Незнакомые типы (сервер старше бота, опечатка, типы Telegram, которых у нас нет) — ОТБРАСЫВАЮТСЯ, а не 400 (аудит 26.10):
  // бот под новый тип продолжает получать известные. Остались только незнакомые — пустой список, событий нет.
  allowed_updates: jsonish(z.array(z.string().max(64)).max(64))
    .transform((list) => list.filter((t): t is BotUpdateType => (BOT_UPDATE_TYPES as readonly string[]).includes(t)))
    .optional(),
});

export const setWebhookParams = z.object({
  url: z.string().trim().min(1).max(WEBHOOK_URL_MAX),
  secret_token: z.string().regex(WEBHOOK_SECRET_RE, 'secret_token: 16–256 знаков A-Z a-z 0-9 _ -'),
  drop_pending_updates: flag.optional(),
  /** Пакетная доставка (#231, добавление): тело POST — МАССИВ до 100 событий, подпись по всему телу. По умолчанию — объект. */
  batch: flag.optional(),
});

export const deleteWebhookParams = z.object({ drop_pending_updates: flag.optional() });

// ─── Этап 2 (#230): кнопки под сообщением ───
/**
 * Кнопка: ровно одно из `callback_data` (1–64 БАЙТ UTF-8, как Telegram) и `url` (только http(s), без логина в адресе).
 * Прочие поля Telegram (`web_app`, `switch_inline_query`, …) отбрасываются (`z.object` их срезает).
 */
export const inlineKeyboardButton = z
  .object({
    text: z.string().trim().min(1).max(KEYBOARD_BUTTON_TEXT_MAX),
    callback_data: z
      .string()
      .min(1)
      .refine((s) => callbackDataBytes(s) <= CALLBACK_DATA_MAX_BYTES, `callback_data: не больше ${CALLBACK_DATA_MAX_BYTES} байт`)
      .optional(),
    url: z.string().trim().max(KEYBOARD_URL_MAX).refine(isHttpUrlWithoutCredentials, 'url: только http(s), без логина в адресе').optional(),
  })
  .refine((b) => (b.callback_data !== undefined) !== (b.url !== undefined), 'кнопке нужно ровно одно из callback_data и url')
  // Правила, которых JSON Schema не выразит, — в описание для OpenAPI (этап 5, #233), числа — из тех же констант.
  .meta({
    id: 'InlineKeyboardButton',
    description: `Exactly one of \`callback_data\` (1–${CALLBACK_DATA_MAX_BYTES} BYTES of UTF-8, not characters) and \`url\` (http(s) only, no credentials in the address).`,
  });
/** Клавиатура: ряды ≥ 1, в ряду 1–8 кнопок, всего ≤ 100. */
export const inlineKeyboardMarkup = z
  .object({ inline_keyboard: z.array(z.array(inlineKeyboardButton).min(1).max(KEYBOARD_ROW_BUTTONS_MAX)).min(1) })
  .refine((k) => k.inline_keyboard.reduce((n, r) => n + r.length, 0) <= KEYBOARD_BUTTONS_MAX, `не больше ${KEYBOARD_BUTTONS_MAX} кнопок`)
  .meta({
    id: 'InlineKeyboardMarkup',
    description: `At least one row, 1–${KEYBOARD_ROW_BUTTONS_MAX} buttons in a row, at most ${KEYBOARD_BUTTONS_MAX} buttons in total.`,
  });
const replyMarkup = jsonish(inlineKeyboardMarkup);

export const sendMessageParams = z.object({
  chat_id: id,
  text: z.string().max(MESSAGE_TEXT_MAX, TEXT_TOO_LONG).optional(),
  reply_to_message_id: id.optional(),
  /** Карточки — формат входящего вебхука (`docs/webhooks.md`): до 10, картинки только наши или `attachment://имя`. */
  embeds: jsonish(webhookExecuteBody.shape.embeds).optional(),
  /** Без звука у получателя (как `disable_notification` у Telegram). */
  disable_notification: flag.optional(),
  /** Без карточки превью ссылки. */
  disable_link_preview: flag.optional(),
  /** Кнопки под сообщением (#230). Одних кнопок мало — нужен текст или карточки. */
  reply_markup: replyMarkup.optional(),
  /** Идемпотентность (аудит 26.10, добавление): повтор с тем же `client_id` → то же сообщение (`clientId` людей). */
  client_id: z.string().trim().min(1).max(64).optional(),
  /** Разметка текста (#231): без параметра — наши маркеры; `HTML` — подмножество Telegram; `MarkdownV2` — 400. */
  parse_mode: z.string().max(16).optional(),
});

export const editMessageTextParams = z.object({
  chat_id: id,
  message_id: id,
  text: z.string().max(MESSAGE_TEXT_MAX, TEXT_TOO_LONG),
  /** Как Telegram: правка текста БЕЗ `reply_markup` снимает кнопки. */
  reply_markup: replyMarkup.optional(),
  /** Разметка текста (#231), как у `sendMessage`. */
  parse_mode: z.string().max(16).optional(),
});

/** Только кнопки (#230); без `reply_markup` — снять. Не ставит «(изм.)». */
export const editMessageReplyMarkupParams = z.object({ chat_id: id, message_id: id, reply_markup: replyMarkup.optional() });

export const answerCallbackQueryParams = z.object({
  callback_query_id: id,
  text: z.string().max(ANSWER_TEXT_MAX).optional(),
  /** Окно вместо всплывашки. */
  show_alert: flag.optional(),
});

// ─── Этап 2 (#230): команды ───
export const botCommand = z.object({
  command: z.string().regex(BOT_COMMAND_RE, 'command: 1–32 знака a-z 0-9 _'),
  description: z.string().trim().min(1).max(BOT_COMMAND_DESC_MAX),
}).meta({ id: 'BotCommand' });
/** Область команд: `default`, `all_private_chats` (ЛС), `all_group_chats` (серверы, #231); прочие типы — 400. */
const commandScope = z
  .object({ type: z.string().max(32) })
  .refine((sc) => commandScopeOk(sc.type), { message: 'scope: этот тип пока не поддерживается (только default, all_private_chats, all_group_chats)' })
  .meta({ id: 'BotCommandScope', description: `Supported \`type\`: ${BOT_COMMAND_SCOPES.join(', ')}; other types are rejected with 400.` });
const scopeParam = jsonish(commandScope);
export const setMyCommandsParams = z.object({
  commands: jsonish(
    z
      .array(botCommand)
      .max(BOT_COMMANDS_MAX)
      .meta({ description: `Up to ${BOT_COMMANDS_MAX} commands; every \`command\` must be unique in the list.` })
      .superRefine((list, ctx) => {
        const dup = duplicateCommand(list);
        if (dup) ctx.addIssue({ code: 'custom', message: `commands: повтор "${dup}"` });
      }),
  ),
  scope: scopeParam.optional(),
});
export const getMyCommandsParams = z.object({ scope: scopeParam.optional() });
export const deleteMyCommandsParams = z.object({ scope: scopeParam.optional() });

export const deleteMessageParams = z.object({ chat_id: id, message_id: id });

/** Этап 1 — только «печатает». */
export const sendChatActionParams = z.object({ chat_id: id, action: z.enum(['typing']) });

export const getChatParams = z.object({ chat_id: id });

// ─── Объекты ответа ──────────────────────────────────────────────────────────────────────────────────────────────────

export const wireUser = z.object({
  id: z.string(),
  username: z.string(),
  display_name: z.string(),
  bot: z.boolean(),
  /** Человек с другого инстанса (гость на сервере, #231): домен его дома. У местных поля нет. */
  instance_domain: z.string().optional(),
}).meta({ id: 'User' });
export type WireUser = z.infer<typeof wireUser>;

export const wireChat = z.object({
  id: z.string(),
  /**
   * `dm` — беседа 1:1 (этап 1); `channel` — текстовый канал сервера, `server` — сам сервер (этап 3, добавление значений);
   * `voice` — голосовой канал сервера (этап 4, #232, добавление).
   */
  type: z.enum(['dm', 'channel', 'server', 'voice']),
  /** Только у `channel` и `voice`. */
  server_id: z.string().optional(),
  /** Имя канала (без `#`) или сервера. */
  title: z.string().optional(),
}).meta({ id: 'Chat' });
export type WireChat = z.infer<typeof wireChat>;

export const wireAttachment = z.object({
  /** Ссылка на файл — своя у бота, работает, пока у него есть доступ к беседе. */
  url: z.string(),
  file_name: z.string(),
  mime_type: z.string(),
  file_size: z.number(),
}).meta({ id: 'Attachment' });

/**
 * Карточка в сообщении — `MessageEmbed` из `@gusvoice/shared` (уже проверенная сервером, `normalizeEmbeds`): имена полей как
 * в ленте (`iconUrl`, `imageLink`), а не как во входящем теле вебхука. Совпадение типов сторожит `botWireSdk.ts`.
 */
export const wireEmbed = z
  .object({
    title: z.string().optional(),
    url: z.string().optional(),
    description: z.string().optional(),
    color: z.number().optional(),
    timestamp: z.string().optional(),
    author: z.object({ name: z.string(), url: z.string().optional(), iconUrl: z.string().optional() }).optional(),
    footer: z.object({ text: z.string(), iconUrl: z.string().optional() }).optional(),
    fields: z.array(z.object({ name: z.string(), value: z.string(), inline: z.boolean().optional() })).optional(),
    image: z.object({ url: z.string() }).optional(),
    thumbnail: z.object({ url: z.string() }).optional(),
    imageLink: z.string().optional(),
    thumbnailLink: z.string().optional(),
  })
  .meta({ id: 'MessageEmbed' });

export const wireMessage = z.object({
  message_id: z.string(),
  chat: wireChat,
  from: wireUser,
  date: z.number(),
  edit_date: z.number().optional(),
  text: z.string(),
  reply_to_message_id: z.string().optional(),
  attachments: z.array(wireAttachment).optional(),
  embeds: z.array(wireEmbed).optional(),
  /** Кнопки (#230) — только у сообщений с ними. */
  reply_markup: inlineKeyboardMarkup.optional(),
}).meta({ id: 'Message' });
export type WireMessage = z.infer<typeof wireMessage>;

export const wireMessageDeleted = z.object({ message_id: z.string(), chat: wireChat, date: z.number() }).meta({ id: 'MessageDeleted' });
export type WireMessageDeleted = z.infer<typeof wireMessageDeleted>;

/** Статус участника: `creator` — владелец сервера, `kicked` — забанен (имя Telegram), `left` — не участник (#231). */
export const memberStatus = z.enum(['creator', 'member', 'left', 'kicked']);

/** Человек открыл беседу с ботом (`member`) или удалил её у себя (`left`); бота добавили на сервер / убрали (#231). */
export const wireChatMember = z.object({
  chat: wireChat,
  from: wireUser,
  date: z.number(),
  // `kicked` (аудит 26.10, добавление) — человек заблокировал бота; разблокировал — `kicked` → `member` (как Telegram).
  // `creator` (#231, добавление) — в событиях членства сервера.
  old_status: memberStatus,
  new_status: memberStatus,
}).meta({ id: 'ChatMemberUpdated' });
export type WireChatMember = z.infer<typeof wireChatMember>;

/** Нажатие кнопки под сообщением бота (#230). `message` — сообщение с кнопками целиком; `data` — `callback_data` кнопки. */
export const wireCallbackQuery = z.object({
  id: z.string(),
  from: wireUser,
  message: wireMessage,
  data: z.string(),
  date: z.number(),
}).meta({ id: 'CallbackQuery' });
export type WireCallbackQuery = z.infer<typeof wireCallbackQuery>;

export const wireBotCommand = botCommand;

/** Событие: `update_id` + ровно одно из полей. */
export const wireUpdate = z.object({
  update_id: z.number(),
  message: wireMessage.optional(),
  edited_message: wireMessage.optional(),
  message_deleted: wireMessageDeleted.optional(),
  my_chat_member: wireChatMember.optional(),
  callback_query: wireCallbackQuery.optional(),
  /** Этап 3 (#231): реакция человека — набор ЕГО реакций до и после. */
  message_reaction: z.lazy(() => wireMessageReaction).optional(),
  /** Этап 3 (#231): участник сервера вошёл, вышел, кикнут, забанен. */
  chat_member: z.lazy(() => wireServerMemberUpdate).optional(),
  /** Этап 4 (#232): кто зашёл в голосовой канал / вышел из него. */
  voice_state: z.lazy(() => wireVoiceState).optional(),
}).meta({ id: 'Update' });
export type WireUpdate = z.infer<typeof wireUpdate>;

export const wireBot = wireUser.extend({
  description: z.string(),
  about: z.string(),
  public: z.boolean(),
  /** Версия возможностей Bot API v1 (аудит 26.10, добавление): 1 — этап 1, 2 — кнопки и команды. Старый сервер не шлёт. */
  api_version: z.number().optional(),
  /** Что умеет этот сервер (`BOT_API_FEATURES`), чтобы бот не гадал по версии. Старый сервер не шлёт. */
  features: z.array(z.string()).optional(),
  /** Сколько событий срезал потолок журнала — бот видит, что терял (#231, добавление). */
  dropped_update_count: z.number().optional(),
}).meta({ id: 'BotUser' });

export const wireWebhookInfo = z.object({
  url: z.string(),
  pending_update_count: z.number(),
  failures: z.number(),
  last_error_date: z.number().optional(),
  last_error_message: z.string().optional(),
  /** Доставку выключил сервер после серии сбоев — включается новым `setWebhook`. */
  disabled_date: z.number().optional(),
  /** Пакетная доставка включена (#231). */
  batch: z.boolean().optional(),
  /** Сколько событий срезал потолок журнала (#231). */
  dropped_update_count: z.number().optional(),
}).meta({ id: 'WebhookInfo' });

export const wireGetChat = wireChat.extend({ user: wireUser });

// ─── Ответы методов без своего объекта (этап 5, #233: реестр `botSpec.ts` → OpenAPI) ───
/** `true` — ответ методов-действий (`setWebhook`, `deleteMessage`, `banChatMember`, …). */
export const wireTrue = z.literal(true);
/** `getChat`: беседа ЛС — с `user` (собеседник), сервер — с `member_count`, канал — без того и другого. */
export const wireChatFullInfo = wireChat
  .extend({ user: wireUser.optional(), member_count: z.number().optional() })
  .meta({ id: 'ChatFullInfo' });
/** `getMyServers`: серверы, куда добавлен бот. */
export const wireServerBrief = z.object({ id: z.string(), title: z.string() }).meta({ id: 'ServerBrief' });

export const wireOk = z.object({ ok: z.literal(true), result: z.unknown() });
export const wireError = z.object({
  ok: z.literal(false),
  error_code: z.number(),
  description: z.string(),
  retry_after: z.number().optional(),
}).meta({ id: 'Error' });
export type WireError = z.infer<typeof wireError>;

// ─── Сборка ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function toWireUser(u: { id: string; username: string; displayName: string | null; bot?: boolean | null; instanceDomain?: string | null }): WireUser {
  return {
    id: u.id,
    username: u.username,
    display_name: u.displayName ?? u.username,
    bot: u.bot === true,
    ...(u.instanceDomain ? { instance_domain: u.instanceDomain } : {}),
  };
}

export function dmChat(conversationId: string): WireChat {
  return { id: conversationId, type: 'dm' };
}

function toWireAttachment(a: Attachment) {
  return { url: a.url, file_name: a.name, mime_type: a.contentType, file_size: a.size };
}

/** Сообщение беседы глазами бота (`messagesFor(…, botId)`: ссылки на файлы — его). */
export function toWireMessage(m: ConvMessage): WireMessage {
  return {
    message_id: m.id,
    chat: dmChat(m.conversationId),
    from: toWireUser({ ...m.author, displayName: m.author.displayName, bot: m.author.bot === true }),
    date: unixSeconds(m.createdAt),
    ...(m.editedAt ? { edit_date: unixSeconds(m.editedAt) } : {}),
    // Текст, собранный из карточек для старых клиентов, боту не нужен — у него есть сами карточки.
    text: m.embedsFallback ? '' : m.content,
    ...(m.replyTo ? { reply_to_message_id: m.replyTo.id } : {}),
    ...(m.attachments.length ? { attachments: m.attachments.map(toWireAttachment) } : {}),
    ...(m.embeds?.length ? { embeds: m.embeds } : {}),
    ...(m.keyboard?.length ? { reply_markup: { inline_keyboard: m.keyboard } } : {}),
  };
}

// ─── Этап 3 (#231): серверы ──────────────────────────────────────────────────────────────────────────────────────────

export const reactionType = z.object({ type: z.literal('emoji'), emoji: z.string().min(1).max(32) }).meta({ id: 'ReactionType' });
export type ReactionType = z.infer<typeof reactionType>;

/** Реакция человека на сообщение: наборы ЕГО реакций до и после. */
export const wireMessageReaction = z.object({
  chat: wireChat,
  message_id: z.string(),
  user: wireUser,
  date: z.number(),
  old_reaction: z.array(reactionType),
  new_reaction: z.array(reactionType),
}).meta({ id: 'MessageReactionUpdated' });
export type WireMessageReaction = z.infer<typeof wireMessageReaction>;

/** Участник сервера (`getChatMember`, `getChatMembers`). Админских `can_*` Telegram нет — права битовые: `role_ids` + `getServer`. */
export const wireChatMemberInfo = z.object({
  user: wireUser,
  status: memberStatus,
  nickname: z.string().optional(),
  role_ids: z.array(z.string()),
  joined_date: z.number().optional(),
}).meta({ id: 'ChatMember' });
export type WireChatMemberInfo = z.infer<typeof wireChatMemberInfo>;
/** `getChatMembers`: страница участников; `next_offset` — только если есть следующая (этап 5: схема ответа для OpenAPI). */
export const wireChatMembersPage = z
  .object({ members: z.array(wireChatMemberInfo), next_offset: z.string().optional() })
  .meta({ id: 'ChatMembersPage' });

/** `chat_member`: кто-то вошёл на сервер, вышел, кикнут, забанен, разбанен. `from` — кто сделал, `user` — с кем. */
export const wireServerMemberUpdate = z.object({
  chat: wireChat,
  from: wireUser,
  user: wireUser,
  date: z.number(),
  old_status: memberStatus,
  new_status: memberStatus,
}).meta({ id: 'ServerMemberUpdated' });
export type WireServerMemberUpdate = z.infer<typeof wireServerMemberUpdate>;

/** `getServer`: каналы — только видимые боту. */
export const wireServer = z.object({
  id: z.string(),
  title: z.string(),
  channels: z.array(z.object({ id: z.string(), title: z.string(), type: z.enum(['text', 'voice']), can_send: z.boolean() })),
  roles: z.array(z.object({ id: z.string(), name: z.string(), position: z.number(), managed: z.boolean() })),
}).meta({ id: 'ServerInfo' });

export const setMessageReactionParams = z.object({
  chat_id: id,
  message_id: id,
  /** 0–3 эмодзи; пусто или нет — снять все свои. Набор заменяется целиком (как Telegram). */
  reaction: jsonish(z.array(reactionType).max(3)).optional(),
});
export const pinChatMessageParams = z.object({ chat_id: id, message_id: id, disable_notification: flag.optional() });
export const unpinChatMessageParams = z.object({ chat_id: id, message_id: id });
export const getChatMemberParams = z.object({ chat_id: id, user_id: id });
export const getChatMemberCountParams = z.object({ chat_id: id });
export const getChatMembersParams = z.object({
  chat_id: id,
  offset: z.string().max(128).optional(),
  limit: int.pipe(z.number().min(1).max(200)).optional(),
});
export const getMyServersParams = z.object({});
export const getServerParams = z.object({ server_id: id });
export const getChatHistoryParams = z.object({
  chat_id: id,
  before_message_id: id.optional(),
  limit: int.pipe(z.number().min(1).max(100)).optional(),
});
export const chatMemberRoleParams = z.object({ chat_id: id, user_id: id, role_id: id });
export const banChatMemberParams = z.object({ chat_id: id, user_id: id, reason: z.string().max(512).optional() });
export const unbanChatMemberParams = z.object({ chat_id: id, user_id: id });
export const kickChatMemberParams = z.object({ chat_id: id, user_id: id });
export const leaveChatParams = z.object({ chat_id: id });

// ─── Этап 4 (#232): голос ────────────────────────────────────────────────────────────────────────────────────────────

/** `joinVoice`: голосовой канал; `bitrate` — сервер только проверяет диапазон и возвращает его в `audio`. */
export const joinVoiceParams = z.object({
  chat_id: id,
  bitrate: int.pipe(z.number().min(BOT_VOICE_BITRATE.min).max(BOT_VOICE_BITRATE.max)).optional(),
});
/** `leaveVoice`: с `chat_id` — из этого канала, без — из всех. */
export const leaveVoiceParams = z.object({ chat_id: id.optional() });
export const getVoiceChatMembersParams = z.object({ chat_id: id });

/** Ответ `joinVoice`: куда и с чем подключаться к LiveKit (токен живёт `expires_in` с, дальше его продлевает сам LiveKit). */
export const wireJoinVoice = z.object({
  url: z.string(),
  token: z.string(),
  room: z.string(),
  chat: wireChat,
  /** Бот уже заглушён модератором — в токене нет микрофона. */
  server_muted: z.boolean(),
  expires_in: z.number(),
  audio: z.object({ sample_rate: z.number(), channels: z.number(), bitrate: z.number() }),
}).meta({ id: 'VoiceJoinResult' });
export type WireJoinVoice = z.infer<typeof wireJoinVoice>;

/** Участник голосового канала (`getVoiceChatMembers`) — по срезу presence, как видит клиент. */
export const wireVoiceChatMember = z.object({
  user: wireUser,
  muted: z.boolean(),
  deafened: z.boolean(),
  server_muted: z.boolean(),
  is_bot: z.boolean(),
}).meta({ id: 'VoiceChatMember' });
export type WireVoiceChatMember = z.infer<typeof wireVoiceChatMember>;

/**
 * `voice_state`: человек или бот зашёл в голосовой канал / вышел. `move_to` — только самому боту, когда его перенёс модератор
 * (SDK по умолчанию заходит туда сам).
 */
export const wireVoiceState = z.object({
  chat: wireChat,
  user: wireUser,
  action: z.enum(['joined', 'left']),
  date: z.number(),
  move_to: wireChat.optional(),
}).meta({ id: 'VoiceStateUpdated' });
export type WireVoiceState = z.infer<typeof wireVoiceState>;

/** Голосовой канал на проводе. */
export function voiceChat(channel: { id: string; serverId: string; name: string }): WireChat {
  return { id: channel.id, type: 'voice', server_id: channel.serverId, title: channel.name };
}

export function channelChat(channel: { id: string; serverId: string; name: string }): WireChat {
  return { id: channel.id, type: 'channel', server_id: channel.serverId, title: channel.name };
}

export function serverChat(server: { id: string; name: string }): WireChat {
  return { id: server.id, type: 'server', title: server.name };
}

/**
 * Сообщение КАНАЛА (DTO `serializeMessage`) → провод. Вложения каналов публичные — один вид на всех ботов. `from` — уже
 * собранный автор (у гостя `instance_domain` и домашний ник); без него — из DTO.
 */
export function toWireChannelMessage(m: Message, chat: WireChat, from?: WireUser): WireMessage {
  return {
    message_id: m.id,
    chat,
    from: from ?? toWireUser({ id: m.author.id, username: m.author.username, displayName: m.author.displayName, bot: m.author.bot === true }),
    date: unixSeconds(m.createdAt),
    ...(m.editedAt ? { edit_date: unixSeconds(m.editedAt) } : {}),
    text: m.embedsFallback ? '' : m.content,
    ...(m.replyTo ? { reply_to_message_id: m.replyTo.id } : {}),
    ...(m.attachments.length ? { attachments: m.attachments.map(toWireAttachment) } : {}),
    ...(m.embeds?.length ? { embeds: m.embeds } : {}),
    ...(m.keyboard?.length ? { reply_markup: { inline_keyboard: m.keyboard } } : {}),
  };
}


export function okBody(result: unknown) {
  return { ok: true as const, result };
}

export function errorBody(code: number, description: string, retryAfter?: number): WireError {
  return { ok: false, error_code: code, description, ...(retryAfter ? { retry_after: retryAfter } : {}) };
}
