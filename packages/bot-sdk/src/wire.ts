/**
 * Типы провода Bot API v1 GusVoice (#229) — зеркало схем сервера `packages/backend/src/bots/botWire.ts`.
 *
 * SDK живёт без зависимостей (у потребителя нет zod), поэтому типы здесь написаны руками, а расхождение со схемами
 * ловит typecheck бэкенда: `packages/backend/src/bots/botWireSdk.ts` сверяет каждый тип отсюда с `z.infer` схемы
 * в обе стороны. Провод v1 меняется только добавлениями (поля snake_case, id — строки UUID, время — секунды Unix).
 */

/** Пользователь (человек или бот). */
export interface User {
  id: string;
  username: string;
  display_name: string;
  bot: boolean;
  /** Человек с другого инстанса (гость на сервере, API 3): домен его дома. У местных поля нет — сверяйте `id`, а не ник. */
  instance_domain?: string;
}

/** Сам бот (`getMe`, приветствие WS). */
export interface BotUser extends User {
  description: string;
  about: string;
  /** Писать боту могут все (`true`) или только владелец. */
  public: boolean;
  /** Версия возможностей сервера: 2 — кнопки и команды. Сервер старше 26.10 не шлёт. */
  api_version?: number;
  /** Что умеет сервер: `polling`, `ws`, `webhook`, `keyboards`, `commands`, `client_id`… Сервер старше 26.10 не шлёт. */
  features?: string[];
  /** Сколько событий срезал потолок журнала (API 3). */
  dropped_update_count?: number;
}

/** Беседа. Этап 1 — только личная беседа 1:1 (`dm`). */
export interface Chat {
  id: string;
  /** `dm` — беседа 1:1; `channel` — текстовый канал сервера; `server` — сам сервер (API 3); `voice` — голосовой канал (API 4). Проверяйте `chat.type`. */
  type: 'dm' | 'channel' | 'server' | 'voice';
  /** Только у `channel` и `voice`. */
  server_id?: string;
  /** Имя канала (без `#`) или сервера. */
  title?: string;
}

/** `getChat`: беседа + собеседник. */
export interface ChatFullInfo extends Chat {
  user: User;
}

/** Вложение входящего сообщения. Ссылка — своя у бота, работает, пока у него есть доступ к беседе. */
export interface Attachment {
  url: string;
  file_name: string;
  mime_type: string;
  file_size: number;
}

/** Карточка в сообщении (как её видит бот: поля как у клиента GusVoice). */
export interface MessageEmbed {
  title?: string;
  url?: string;
  description?: string;
  /** Цвет полосы слева, 0xRRGGBB. */
  color?: number;
  /** ISO-время в подвале. */
  timestamp?: string;
  author?: { name: string; url?: string; iconUrl?: string };
  footer?: { text: string; iconUrl?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  image?: { url: string };
  thumbnail?: { url: string };
  /** Чужая https-картинка `image` — показывается ссылкой. */
  imageLink?: string;
  /** Чужая https-картинка `thumbnail` — показывается ссылкой. */
  thumbnailLink?: string;
}

/**
 * Карточка в `sendMessage` — формат входящего вебхука (подмножество Discord, `docs/webhooks.md`): до 10 карточек,
 * картинки — только адреса этого инстанса или `attachment://<имя файла>` из `files`.
 */
export interface InputEmbed {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  color?: number | null;
  timestamp?: string | null;
  fields?: { name: string; value: string; inline?: boolean | null }[] | null;
  author?: { name: string; url?: string | null; icon_url?: string | null } | null;
  footer?: { text: string; icon_url?: string | null } | null;
  image?: { url: string } | null;
  thumbnail?: { url: string } | null;
}

export interface Message {
  message_id: string;
  chat: Chat;
  from: User;
  date: number;
  edit_date?: number;
  /** Текст; у сообщения только из карточек — пустая строка (смотрите `embeds`). */
  text: string;
  reply_to_message_id?: string;
  attachments?: Attachment[];
  embeds?: MessageEmbed[];
  /** Кнопки под сообщением — только у сообщений с ними. */
  reply_markup?: InlineKeyboardMarkup;
}

// ─── Кнопки и команды (этап 2) ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Кнопка под сообщением: ровно одно из `callback_data` (1–64 БАЙТ UTF-8; нажатие шлёт боту `callback_query`) и `url`
 * (только http/https, без логина в адресе). `text` — 1–64 знака.
 */
export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

/** Клавиатура под сообщением: ряды (≥ 1), в ряду 1–8 кнопок, всего ≤ 100. */
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/** Нажатие кнопки: `message` — сообщение с кнопками целиком, `data` — `callback_data` нажатой кнопки (её прислал клиент человека — не доверяйте). */
export interface CallbackQuery {
  /** Ответить на него — `answerCallbackQuery` (один раз, в течение ~15 с). */
  id: string;
  from: User;
  message: Message;
  data: string;
  date: number;
}

/** Команда для подсказки по «/»: имя 1–32 знака `a-z 0-9 _`, описание 1–256. */
export interface BotCommand {
  command: string;
  description: string;
}

/** Область команд. Пока только ЛС: `default` и `all_private_chats` — одно и то же. */
export interface BotCommandScope {
  /** `all_group_chats` (API 3) — список для серверов; `all_private_chats` — для ЛС; `default` — где своего нет. */
  type: 'default' | 'all_private_chats' | 'all_group_chats';
}

export interface MessageDeleted {
  message_id: string;
  chat: Chat;
  date: number;
}

/** Человек открыл беседу с ботом (`member`) или удалил её у себя (`left`). */
export interface ChatMemberUpdated {
  chat: Chat;
  from: User;
  date: number;
  /** `kicked` — человек заблокировал бота (писать ему бот не может), разблокировал — снова `member`. */
  old_status: ChatMemberStatus;
  new_status: ChatMemberStatus;
}

/** Событие: `update_id` + ровно одно из полей. */
export interface Update {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  message_deleted?: MessageDeleted;
  my_chat_member?: ChatMemberUpdated;
  callback_query?: CallbackQuery;
  /** API 3: человек поставил или снял реакцию. */
  message_reaction?: MessageReactionUpdated;
  /** API 3: участник сервера вошёл, вышел, кикнут, забанен. */
  chat_member?: ServerMemberUpdated;
  /** API 4: кто-то зашёл в голосовой канал или вышел из него (в том числе сам бот). */
  voice_state?: VoiceStateUpdated;
}

/** Типы событий: этап 1 + `callback_query` (нажатие кнопки) + API 3 (`message_reaction`, `chat_member`) + API 4 (`voice_state`). */
/**
 * Версия Bot API, которую знает этот SDK (`getMe().api_version` сервера). Обновляется вместе с `BOT_API_VERSION` бэкенда
 * (`packages/backend/src/bots/botRules.ts`); равенство держит `packages/backend/src/bots/botWireSdk.ts`. Провод меняется
 * только добавлениями: сервер новее SDK — работает, но новых методов и полей SDK ещё не знает (`bot.start()` скажет в лог).
 */
export const SDK_API_VERSION = 4;
export const UPDATE_TYPES = ['message', 'edited_message', 'message_deleted', 'my_chat_member', 'callback_query', 'message_reaction', 'chat_member', 'voice_state'] as const;
export type UpdateType = (typeof UPDATE_TYPES)[number];

export interface WebhookInfo {
  /** Пусто — адрес не задан. */
  url: string;
  pending_update_count: number;
  failures: number;
  last_error_date?: number;
  last_error_message?: string;
  /** Доставку выключил сервер после серии сбоев — включается новым `setWebhook`. */
  disabled_date?: number;
  /** Пакетная доставка включена (API 3). */
  batch?: boolean;
  /** Сколько событий срезал потолок журнала (API 3). */
  dropped_update_count?: number;
}

/** Ответ сервера. */
export type ApiResponse<T> = { ok: true; result: T } | ApiErrorBody;
export interface ApiErrorBody {
  ok: false;
  error_code: number;
  description: string;
  retry_after?: number;
}

// ─── Параметры методов (как их принимает сервер) ─────────────────────────────────────────────────────────────────────

export interface GetUpdatesParams {
  /** Первое нужное событие; всё до него сервер считает подтверждённым. */
  offset?: number;
  /** 1–100. */
  limit?: number;
  /** Долгий опрос, секунд: 0–50. */
  timeout?: number;
  allowed_updates?: UpdateType[];
}

export interface SetWebhookParams {
  url: string;
  /** Секрет подписи доставки: 16–256 знаков `A-Z a-z 0-9 _ -`. */
  secret_token: string;
  drop_pending_updates?: boolean;
  /** API 3: тело POST — массив до 100 событий (`webhookCallback` понимает и объект, и массив). */
  batch?: boolean;
}

export interface DeleteWebhookParams {
  drop_pending_updates?: boolean;
}

export interface SendMessageParams {
  chat_id: string;
  text?: string;
  reply_to_message_id?: string;
  embeds?: InputEmbed[];
  /** Без звука у получателя. */
  disable_notification?: boolean;
  /** Без карточки превью ссылки. */
  disable_link_preview?: boolean;
  /** Кнопки под сообщением. */
  reply_markup?: InlineKeyboardMarkup;
  /**
   * Свой id отправки (1–64 знака): повтор `sendMessage` с тем же `client_id` (обрыв сети, перезапуск) вернёт ТО ЖЕ
   * сообщение, а не второе. Сервер старше 26.10 поле игнорирует.
   */
  client_id?: string;
  /** API 3: `HTML` — подмножество Telegram переводится в наши маркеры; без параметра — наши маркеры (`**жирный**`). */
  parse_mode?: string;
}

export interface EditMessageTextParams {
  chat_id: string;
  message_id: string;
  text: string;
  /** API 3: как у `sendMessage`. */
  parse_mode?: string;
  /** Как в Telegram: без `reply_markup` кнопки СНИМАЮТСЯ. Чтобы оставить — передайте их снова. */
  reply_markup?: InlineKeyboardMarkup;
}

export interface EditMessageReplyMarkupParams {
  chat_id: string;
  message_id: string;
  /** Без него кнопки снимаются. */
  reply_markup?: InlineKeyboardMarkup;
}

export interface AnswerCallbackQueryParams {
  callback_query_id: string;
  /** До 200 знаков; без него часики на кнопке просто гаснут. */
  text?: string;
  /** Окно с кнопкой «Понятно» вместо всплывашки. */
  show_alert?: boolean;
}

export interface SetMyCommandsParams {
  /** Замещает весь список; `[]` — снять. До 100. */
  commands: BotCommand[];
  scope?: BotCommandScope;
}

export interface GetMyCommandsParams {
  scope?: BotCommandScope;
}

export interface DeleteMyCommandsParams {
  scope?: BotCommandScope;
}

export interface DeleteMessageParams {
  chat_id: string;
  message_id: string;
}

export interface SendChatActionParams {
  chat_id: string;
  action: 'typing';
}

export interface GetChatParams {
  chat_id: string;
}

// ─── API 3 (#231): боты на серверах ───

/** `creator` — владелец сервера; `kicked` — забанен (имя Telegram); `left` — не участник. */
export type ChatMemberStatus = 'creator' | 'member' | 'left' | 'kicked';

export interface ReactionType {
  type: 'emoji';
  emoji: string;
}

/** Реакция человека: наборы ЕГО реакций на сообщение до и после. */
export interface MessageReactionUpdated {
  chat: Chat;
  message_id: string;
  user: User;
  date: number;
  old_reaction: ReactionType[];
  new_reaction: ReactionType[];
}

/** `chat_member`: `from` — кто сделал, `user` — с кем. `chat.type === 'server'`. */
export interface ServerMemberUpdated {
  chat: Chat;
  from: User;
  user: User;
  date: number;
  old_status: ChatMemberStatus;
  new_status: ChatMemberStatus;
}

/** Участник сервера. Права битовые: `role_ids` + `getServer().roles`. */
export interface ChatMember {
  user: User;
  status: ChatMemberStatus;
  nickname?: string;
  role_ids: string[];
  joined_date?: number;
}

export interface ServerInfo {
  id: string;
  title: string;
  channels: { id: string; title: string; type: 'text' | 'voice'; can_send: boolean }[];
  roles: { id: string; name: string; position: number; managed: boolean }[];
}

export interface SetMessageReactionParams {
  chat_id: string;
  message_id: string;
  /** 0–3; пусто — снять все свои. Набор заменяется целиком. */
  reaction?: ReactionType[];
}
export interface PinChatMessageParams {
  chat_id: string;
  message_id: string;
  disable_notification?: boolean;
}
export interface UnpinChatMessageParams {
  chat_id: string;
  message_id: string;
}
export interface GetChatMemberParams {
  chat_id: string;
  user_id: string;
}
export interface GetChatMemberCountParams {
  chat_id: string;
}
export interface GetChatMembersParams {
  chat_id: string;
  offset?: string;
  limit?: number;
}
export interface GetServerParams {
  server_id: string;
}
export interface GetChatHistoryParams {
  chat_id: string;
  before_message_id?: string;
  limit?: number;
}
export interface ChatMemberRoleParams {
  chat_id: string;
  user_id: string;
  role_id: string;
}
export interface BanChatMemberParams {
  chat_id: string;
  user_id: string;
  reason?: string;
}
export interface KickChatMemberParams {
  chat_id: string;
  user_id: string;
}
export interface LeaveChatParams {
  chat_id: string;
}

// ─── API 4 (#232): голос ───

/** `voice_state`: `chat.type === 'voice'`. `move_to` — только у `left` самого бота, когда его перенёс модератор. */
export interface VoiceStateUpdated {
  chat: Chat;
  user: User;
  action: 'joined' | 'left';
  date: number;
  move_to?: Chat;
}

/** Кто сейчас в голосовом канале (`getVoiceChatMembers`, срез presence). */
export interface VoiceChatMember {
  user: User;
  muted: boolean;
  deafened: boolean;
  server_muted: boolean;
  is_bot: boolean;
}

/**
 * Ответ `joinVoice`: данные для входа в комнату LiveKit. Токен живёт `expires_in` секунд (продлевает его сам LiveKit),
 * в журнал и в ответы пользователям его не выводить.
 */
export interface VoiceJoinResult {
  url: string;
  token: string;
  room: string;
  chat: Chat;
  /** Бот уже заглушён модератором: токен без права говорить. */
  server_muted: boolean;
  expires_in: number;
  audio: { sample_rate: number; channels: number; bitrate: number };
}

export interface JoinVoiceParams {
  chat_id: string;
  /** 24000–128000, по умолчанию 64000. Сервер только возвращает его в `audio.bitrate`. */
  bitrate?: number;
}
export interface LeaveVoiceParams {
  /** Без него — выйти из всех голосовых каналов. */
  chat_id?: string;
}
export interface GetVoiceChatMembersParams {
  chat_id: string;
}
