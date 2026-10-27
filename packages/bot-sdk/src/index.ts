/**
 * `@gusvoice/bot` — официальный SDK Bot API v1 GusVoice (#229): методы, события, команды, WS / долгий опрос, приём доставки.
 * Без зависимостей: `fetch`, `WebSocket`, Web Crypto (Node 22+, Bun, Deno; Node 18–21 — опрос или `ws`).
 */
export { Api, GusVoiceApiError, normalizeBase } from './apiClient.js';
export type { ApiOptions, InputFile, SendMessageOptions } from './apiClient.js';
export { Bot, BotVoice, VOICE_ADDON_NAME, VoiceAddonMissing } from './bot.js';
export type { BotOptions, BotVoiceDeps, ErrorHandler, Handler, StartOptions, WebhookHandlerOptions, WebSocketCtor, WebSocketLike } from './bot.js';
export { Context, parseCommand } from './context.js';
export { InlineKeyboard } from './keyboard.js';
export type { ParsedCommand, UpdatePayload } from './context.js';
export { DEFAULT_TOLERANCE_S, SIGNATURE_HEADER, parseSignatureHeader, toNodeHandler, verifyWebhookSignature } from './webhook.js';
export type { VerifyOptions } from './webhook.js';
export type * from './voiceTypes.js';
export { SDK_API_VERSION, UPDATE_TYPES } from './wire.js';
export type * from './wire.js';
