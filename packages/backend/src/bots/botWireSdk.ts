/**
 * Страж совпадения провода v1 и SDK `@gusvoice/bot` (#229): только типы, в рантайме файла нет.
 *
 * SDK без зависимостей и zod не тянет, поэтому его типы (`packages/bot-sdk/src/wire.ts`) написаны руками. Здесь каждый
 * сверяется со схемой `botWire.ts`: объекты ответа — в обе стороны и по набору полей, параметры — «то, что шлёт SDK,
 * проходит схему» и тот же набор полей. Поле добавили в схему и забыли в SDK (или наоборот) — красный typecheck бэкенда.
 * Импорт из соседнего пакета относительный и `import type`: зависимости в `package.json` нет, образ бэкенда SDK не видит.
 */
import type { MessageEmbed as SharedMessageEmbed } from '@gusvoice/shared';
import type { z } from 'zod';
import type * as Sdk from '../../../bot-sdk/src/wire.js';
import type { SDK_API_VERSION } from '../../../bot-sdk/src/wire.js';
import type { WebhookEmbed } from '../webhookRules.js';
import type { BOT_API_VERSION, BotUpdateType } from './botRules.js';
import type {
  answerCallbackQueryParams,
  botCommand,
  deleteMessageParams,
  deleteMyCommandsParams,
  editMessageReplyMarkupParams,
  getMyCommandsParams,
  inlineKeyboardButton,
  inlineKeyboardMarkup,
  setMyCommandsParams,
  wireCallbackQuery,
  deleteWebhookParams,
  editMessageTextParams,
  getChatParams,
  getUpdatesParams,
  sendChatActionParams,
  sendMessageParams,
  setWebhookParams,
  wireAttachment,
  wireBot,
  wireChatMember,
  wireGetChat,
  wireEmbed,
  wireMessageDeleted,
  wireWebhookInfo,
  WireChat,
  WireError,
  WireMessage,
  WireUpdate,
  WireUser,
  reactionType,
  wireMessageReaction,
  wireServerMemberUpdate,
  wireChatMemberInfo,
  wireServer,
  wireVoiceState,
  wireJoinVoice,
  wireVoiceChatMember,
  joinVoiceParams,
  leaveVoiceParams,
  getVoiceChatMembersParams,
  setMessageReactionParams,
  pinChatMessageParams,
  unpinChatMessageParams,
  getChatMemberParams,
  getChatMemberCountParams,
  getChatMembersParams,
  getServerParams,
  getChatHistoryParams,
  chatMemberRoleParams,
  banChatMemberParams,
  kickChatMemberParams,
  leaveChatParams,
} from './botWire.js';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Объект ответа: типы совпадают в обе стороны и поля те же (необязательное поле взаимную проверку не роняет). */
type Mirror<Sdk, Wire> = Same<Sdk, Wire> extends true ? Same<keyof Sdk, keyof Wire> : false;
/** Параметры метода: то, что шлёт SDK, проходит схему (её выход), и набор полей тот же. */
type Accepts<Schema extends z.ZodType, Params> = [Params] extends [z.output<Schema>] ? Same<keyof Params, keyof z.output<Schema>> : false;
type Assert<T extends true> = T;

export type BotWireSdkChecks = [
  Assert<Mirror<Sdk.User, WireUser>>,
  Assert<Mirror<Sdk.BotUser, z.infer<typeof wireBot>>>,
  Assert<Mirror<Sdk.Chat, WireChat>>,
  Assert<Mirror<Sdk.ChatFullInfo, z.infer<typeof wireGetChat>>>,
  Assert<Mirror<Sdk.Attachment, z.infer<typeof wireAttachment>>>,
  Assert<Mirror<Sdk.Message, WireMessage>>,
  Assert<Mirror<Sdk.MessageDeleted, z.infer<typeof wireMessageDeleted>>>,
  Assert<Mirror<Sdk.ChatMemberUpdated, z.infer<typeof wireChatMember>>>,
  Assert<Mirror<Sdk.Update, WireUpdate>>,
  Assert<Mirror<Sdk.WebhookInfo, z.infer<typeof wireWebhookInfo>>>,
  Assert<Mirror<Sdk.ApiErrorBody, WireError>>,
  Assert<Mirror<Sdk.MessageEmbed, SharedMessageEmbed>>,
  // Этап 5 (#233): схема карточки на проводе (вместо `z.custom`) — тот же тип, что в ленте.
  Assert<Mirror<SharedMessageEmbed, z.infer<typeof wireEmbed>>>,
  Assert<Mirror<Sdk.InputEmbed, WebhookEmbed>>,
  Assert<Same<Sdk.UpdateType, BotUpdateType>>,
  Assert<Accepts<typeof getUpdatesParams, Sdk.GetUpdatesParams>>,
  Assert<Accepts<typeof setWebhookParams, Sdk.SetWebhookParams>>,
  Assert<Accepts<typeof deleteWebhookParams, Sdk.DeleteWebhookParams>>,
  Assert<Accepts<typeof sendMessageParams, Sdk.SendMessageParams>>,
  Assert<Accepts<typeof editMessageTextParams, Sdk.EditMessageTextParams>>,
  Assert<Accepts<typeof deleteMessageParams, Sdk.DeleteMessageParams>>,
  Assert<Accepts<typeof sendChatActionParams, Sdk.SendChatActionParams>>,
  Assert<Accepts<typeof getChatParams, Sdk.GetChatParams>>,
  // Этап 2 (#230): кнопки и команды.
  Assert<Mirror<Sdk.InlineKeyboardButton, z.infer<typeof inlineKeyboardButton>>>,
  Assert<Mirror<Sdk.InlineKeyboardMarkup, z.infer<typeof inlineKeyboardMarkup>>>,
  Assert<Mirror<Sdk.CallbackQuery, z.infer<typeof wireCallbackQuery>>>,
  Assert<Mirror<Sdk.BotCommand, z.infer<typeof botCommand>>>,
  Assert<Accepts<typeof editMessageReplyMarkupParams, Sdk.EditMessageReplyMarkupParams>>,
  Assert<Accepts<typeof answerCallbackQueryParams, Sdk.AnswerCallbackQueryParams>>,
  Assert<Accepts<typeof setMyCommandsParams, Sdk.SetMyCommandsParams>>,
  Assert<Accepts<typeof getMyCommandsParams, Sdk.GetMyCommandsParams>>,
  Assert<Accepts<typeof deleteMyCommandsParams, Sdk.DeleteMyCommandsParams>>,
  // Этап 3 (#231): серверы.
  Assert<Mirror<Sdk.ReactionType, z.infer<typeof reactionType>>>,
  Assert<Mirror<Sdk.MessageReactionUpdated, z.infer<typeof wireMessageReaction>>>,
  Assert<Mirror<Sdk.ServerMemberUpdated, z.infer<typeof wireServerMemberUpdate>>>,
  Assert<Mirror<Sdk.ChatMember, z.infer<typeof wireChatMemberInfo>>>,
  Assert<Mirror<Sdk.ServerInfo, z.infer<typeof wireServer>>>,
  Assert<Accepts<typeof setMessageReactionParams, Sdk.SetMessageReactionParams>>,
  Assert<Accepts<typeof pinChatMessageParams, Sdk.PinChatMessageParams>>,
  Assert<Accepts<typeof unpinChatMessageParams, Sdk.UnpinChatMessageParams>>,
  Assert<Accepts<typeof getChatMemberParams, Sdk.GetChatMemberParams>>,
  Assert<Accepts<typeof getChatMemberCountParams, Sdk.GetChatMemberCountParams>>,
  Assert<Accepts<typeof getChatMembersParams, Sdk.GetChatMembersParams>>,
  Assert<Accepts<typeof getServerParams, Sdk.GetServerParams>>,
  Assert<Accepts<typeof getChatHistoryParams, Sdk.GetChatHistoryParams>>,
  Assert<Accepts<typeof chatMemberRoleParams, Sdk.ChatMemberRoleParams>>,
  Assert<Accepts<typeof banChatMemberParams, Sdk.BanChatMemberParams>>,
  Assert<Accepts<typeof kickChatMemberParams, Sdk.KickChatMemberParams>>,
  Assert<Accepts<typeof leaveChatParams, Sdk.LeaveChatParams>>,
  // Этап 4 (#232): голос.
  Assert<Mirror<Sdk.VoiceStateUpdated, z.infer<typeof wireVoiceState>>>,
  Assert<Mirror<Sdk.VoiceJoinResult, z.infer<typeof wireJoinVoice>>>,
  Assert<Mirror<Sdk.VoiceChatMember, z.infer<typeof wireVoiceChatMember>>>,
  Assert<Accepts<typeof joinVoiceParams, Sdk.JoinVoiceParams>>,
  Assert<Accepts<typeof leaveVoiceParams, Sdk.LeaveVoiceParams>>,
  Assert<Accepts<typeof getVoiceChatMembersParams, Sdk.GetVoiceChatMembersParams>>,
  // Этап 5 (#233): версия Bot API, которую знает SDK (`SDK_API_VERSION`), = версия сервера (`BOT_API_VERSION`).
  Assert<Same<typeof SDK_API_VERSION, typeof BOT_API_VERSION>>,
];
