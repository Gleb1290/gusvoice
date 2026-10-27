/**
 * Реестр Bot API v1 (этап 5, #233) — ОДНА точка правды «метод → схема параметров → схема ответа» и «событие → схема».
 * Из него собирается OpenAPI (`botOpenApi.ts` → `GET /api/bot/v1/openapi.json` и `docs/bot-api/openapi.json`).
 *
 * Метод появился в `methods` (`routes/botApi.ts`) и не попал сюда — страж реестра (тест сверяет `botMethodNames()` с этим
 * списком в обе стороны) красный, как `botWireSdk.ts` для SDK. Схемы — только из `botWire.ts`: сервер разбирает параметры ими же.
 * Тексты (summary/description) здесь НЕ храним — они в файлах текстов RU+EN (`docs/bot-api/text.*.json`).
 *
 * `since` — `api_version` (`botRules.ts` `BOT_API_VERSION`), с которой метод/событие есть на сервере: 1 — ЛС, 2 — кнопки и
 * команды, 3 — серверы и реакции, 4 — голос. Порядок записей = порядок путей в документе (детерминизм).
 */
import { z } from 'zod';
import type { BotUpdateType } from './botRules.js';
import {
  answerCallbackQueryParams,
  banChatMemberParams,
  botCommand,
  chatMemberRoleParams,
  deleteMessageParams,
  deleteMyCommandsParams,
  deleteWebhookParams,
  editMessageReplyMarkupParams,
  editMessageTextParams,
  getChatHistoryParams,
  getChatMemberCountParams,
  getChatMemberParams,
  getChatMembersParams,
  getChatParams,
  getMyCommandsParams,
  getServerParams,
  getUpdatesParams,
  getVoiceChatMembersParams,
  joinVoiceParams,
  kickChatMemberParams,
  leaveChatParams,
  leaveVoiceParams,
  pinChatMessageParams,
  sendChatActionParams,
  sendMessageParams,
  setMessageReactionParams,
  setMyCommandsParams,
  setWebhookParams,
  unbanChatMemberParams,
  unpinChatMessageParams,
  wireBot,
  wireCallbackQuery,
  wireChatFullInfo,
  wireChatMember,
  wireChatMemberInfo,
  wireChatMembersPage,
  wireJoinVoice,
  wireMessage,
  wireMessageDeleted,
  wireMessageReaction,
  wireServer,
  wireServerBrief,
  wireServerMemberUpdate,
  wireTrue,
  wireUpdate,
  wireVoiceChatMember,
  wireVoiceState,
  wireWebhookInfo,
} from './botWire.js';

export type BotApiSince = 1 | 2 | 3 | 4;
/** Группы методов в документе (порядок — порядок тегов). */
export const BOT_METHOD_TAGS = ['bot', 'updates', 'messages', 'commands', 'servers', 'moderation', 'voice'] as const;
export type BotMethodTag = (typeof BOT_METHOD_TAGS)[number];

export interface BotMethodSpec {
  /** camelCase, как в доках и SDK; сервер принимает в любом регистре. */
  name: string;
  since: BotApiSince;
  tag: BotMethodTag;
  /** Схема параметров; `null` — метод без параметров. */
  params: z.ZodType | null;
  /** Схема `result` в `{ ok: true, result }`. */
  result: z.ZodType;
  /** Принимает `multipart/form-data` с файлами (`sendMessage`). */
  multipart?: boolean;
  /** Долгий опрос: держит запрос до `timeout` с (`getUpdates`). */
  longPoll?: boolean;
}

export interface BotEventSpec {
  /** Ключ в `Update` (`BOT_UPDATE_TYPES`). */
  type: BotUpdateType;
  since: BotApiSince;
  /** Схема содержимого (значение поля `Update[type]`). */
  schema: z.ZodType;
}

const m = (name: string, since: BotApiSince, tag: BotMethodTag, params: z.ZodType | null, result: z.ZodType, extra: Partial<BotMethodSpec> = {}): BotMethodSpec => ({
  name,
  since,
  tag,
  params,
  result,
  ...extra,
});

export const BOT_METHOD_SPECS: readonly BotMethodSpec[] = [
  // Этап 1 (#229): ЛС, журнал событий, доставка на адрес.
  m('getMe', 1, 'bot', null, wireBot),
  m('getUpdates', 1, 'updates', getUpdatesParams, z.array(wireUpdate), { longPoll: true }),
  m('setWebhook', 1, 'updates', setWebhookParams, wireTrue),
  m('deleteWebhook', 1, 'updates', deleteWebhookParams, wireTrue),
  m('getWebhookInfo', 1, 'updates', null, wireWebhookInfo),
  m('sendMessage', 1, 'messages', sendMessageParams, wireMessage, { multipart: true }),
  m('editMessageText', 1, 'messages', editMessageTextParams, wireMessage),
  m('deleteMessage', 1, 'messages', deleteMessageParams, wireTrue),
  m('sendChatAction', 1, 'messages', sendChatActionParams, wireTrue),
  m('getChat', 1, 'messages', getChatParams, wireChatFullInfo),
  // Этап 2 (#230): кнопки и команды.
  m('editMessageReplyMarkup', 2, 'messages', editMessageReplyMarkupParams, wireMessage),
  m('answerCallbackQuery', 2, 'messages', answerCallbackQueryParams, wireTrue),
  m('setMyCommands', 2, 'commands', setMyCommandsParams, wireTrue),
  m('getMyCommands', 2, 'commands', getMyCommandsParams, z.array(botCommand)),
  m('deleteMyCommands', 2, 'commands', deleteMyCommandsParams, wireTrue),
  // Этап 3 (#231): серверы, реакции, модерация.
  m('setMessageReaction', 3, 'messages', setMessageReactionParams, wireTrue),
  m('pinChatMessage', 3, 'messages', pinChatMessageParams, wireTrue),
  m('unpinChatMessage', 3, 'messages', unpinChatMessageParams, wireTrue),
  m('getChatHistory', 3, 'messages', getChatHistoryParams, z.array(wireMessage)),
  m('getChatMember', 3, 'servers', getChatMemberParams, wireChatMemberInfo),
  m('getChatMemberCount', 3, 'servers', getChatMemberCountParams, z.number().int().min(0)),
  m('getChatMembers', 3, 'servers', getChatMembersParams, wireChatMembersPage),
  m('getMyServers', 3, 'servers', null, z.array(wireServerBrief)),
  m('getServer', 3, 'servers', getServerParams, wireServer),
  m('addChatMemberRole', 3, 'moderation', chatMemberRoleParams, wireTrue),
  m('removeChatMemberRole', 3, 'moderation', chatMemberRoleParams, wireTrue),
  m('banChatMember', 3, 'moderation', banChatMemberParams, wireTrue),
  m('unbanChatMember', 3, 'moderation', unbanChatMemberParams, wireTrue),
  m('kickChatMember', 3, 'moderation', kickChatMemberParams, wireTrue),
  m('leaveChat', 3, 'servers', leaveChatParams, wireTrue),
  // Этап 4 (#232): голос.
  m('joinVoice', 4, 'voice', joinVoiceParams, wireJoinVoice),
  m('leaveVoice', 4, 'voice', leaveVoiceParams, wireTrue),
  m('getVoiceChatMembers', 4, 'voice', getVoiceChatMembersParams, z.array(wireVoiceChatMember)),
];

/** События (`Update`), порядок — `BOT_UPDATE_TYPES`. */
export const BOT_EVENT_SPECS: readonly BotEventSpec[] = [
  { type: 'message', since: 1, schema: wireMessage },
  { type: 'edited_message', since: 1, schema: wireMessage },
  { type: 'message_deleted', since: 1, schema: wireMessageDeleted },
  { type: 'my_chat_member', since: 1, schema: wireChatMember },
  { type: 'callback_query', since: 2, schema: wireCallbackQuery },
  { type: 'message_reaction', since: 3, schema: wireMessageReaction },
  { type: 'chat_member', since: 3, schema: wireServerMemberUpdate },
  { type: 'voice_state', since: 4, schema: wireVoiceState },
];
