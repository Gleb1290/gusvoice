/** Контекст события для обработчиков `bot.on(…)` / `bot.command(…)` и разбор команды `/имя аргументы`. */
import type { Api, SendMessageOptions } from './apiClient.js';
import type { BotUser, CallbackQuery, Chat, InlineKeyboardMarkup, Message, Update, UpdateType, User } from './wire.js';

export interface ParsedCommand {
  /** Имя команды без `/` и без `@ника`, в нижнем регистре. */
  command: string;
  /** Всё после команды, без пробелов по краям. */
  argsText: string;
  /** `argsText`, разбитый по пробелам. */
  args: string[];
}

const COMMAND_RE = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_.-]+))?(?:\s+([\s\S]*))?$/;

/**
 * Команда в стиле Telegram: `/status`, `/restart nginx`, `/restart@my_bot nginx`. Команда с ником ДРУГОГО бота — не наша
 * (`null`); без ника `botUsername` не проверяется.
 */
export function parseCommand(text: string, botUsername?: string): ParsedCommand | null {
  const m = COMMAND_RE.exec(text.trim());
  if (!m) return null;
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  const argsText = (m[3] ?? '').trim();
  return { command: m[1].toLowerCase(), argsText, args: argsText ? argsText.split(/\s+/) : [] };
}

/** Что лежит в событии данного типа. */
export type UpdatePayload<K extends UpdateType> = NonNullable<Update[K]>;

/** Минимум бота, нужный контексту (без цикла импортов `bot.ts` ↔ `context.ts`). */
export interface ContextHost {
  readonly api: Api;
  readonly me: BotUser | undefined;
}

export class Context<K extends UpdateType = UpdateType> {
  readonly host: ContextHost;
  readonly update: Update;
  readonly type: K;
  /** Команда сообщения (`/status …`), если текст ею начинается. */
  readonly command: string | undefined;
  readonly args: string[];
  readonly argsText: string;
  /** `bot.callbackQuery(/re/, …)` — совпадение регулярки с `callback_data`. */
  match: RegExpExecArray | undefined;
  /** На это нажатие уже ответили (`answerCallbackQuery`) — автоответ SDK не нужен. */
  callbackAnswered = false;

  constructor(host: ContextHost, update: Update, type: K) {
    this.host = host;
    this.update = update;
    this.type = type;
    const parsed = type === 'message' && update.message ? parseCommand(update.message.text, host.me?.username) : null;
    this.command = parsed?.command;
    this.args = parsed?.args ?? [];
    this.argsText = parsed?.argsText ?? '';
  }

  get api(): Api {
    return this.host.api;
  }

  /** Сам бот (после `start()` / первого события). */
  get me(): BotUser | undefined {
    return this.host.me;
  }

  /** Объект события: `Message`, `MessageDeleted` или `ChatMemberUpdated`. */
  get payload(): UpdatePayload<K> {
    return this.update[this.type] as UpdatePayload<K>;
  }

  /** Новое или изменённое сообщение; у нажатия кнопки — сообщение с кнопками (панель). */
  get message(): Message | undefined {
    return this.update.message ?? this.update.edited_message ?? this.update.callback_query?.message;
  }

  /** Беседа события; у `callback_query` — беседа сообщения с кнопками (в корне нажатия чата нет). */
  get chat(): Chat {
    if (this.update.callback_query) return this.update.callback_query.message.chat;
    return (this.update[this.type] as { chat: Chat }).chat;
  }

  /** Нажатие кнопки (только у `callback_query`). */
  get callbackQuery(): CallbackQuery | undefined {
    return this.update.callback_query;
  }

  /** `callback_data` нажатой кнопки (`''` — не нажатие). Пришло от клиента человека: проверяйте `from.id` и белые списки. */
  get callbackData(): string {
    return this.update.callback_query?.data ?? '';
  }

  /** Кто написал / открыл беседу (у `message_deleted` — нет). */
  get from(): User | undefined {
    const p = this.update[this.type] as { from?: User; user?: User };
    // У реакции (API 3) автор — `user`.
    return p.from ?? (this.type === 'message_reaction' ? p.user : undefined);
  }

  /** Событие из текстового канала сервера (API 3). */
  get isChannel(): boolean {
    return this.chat?.type === 'channel';
  }

  /** Сервер события: у канала (текстового и голосового) — `chat.server_id`, у событий членства — сам `chat.id` (API 3). */
  get serverId(): string | undefined {
    const c = this.chat;
    if (!c) return undefined;
    return c.type === 'channel' || c.type === 'voice' ? c.server_id : c.type === 'server' ? c.id : undefined;
  }

  /** Поставить реакцию на сообщение события (одно эмодзи; пусто — снять свои). В ЛС и в каналах (API 3). */
  react(emoji?: string): Promise<true> {
    const m = this.message;
    if (!m) return Promise.reject(new Error('react: в этом событии нет сообщения'));
    return this.host.api.setMessageReaction(this.chat.id, m.message_id, emoji ? [{ type: 'emoji', emoji }] : []);
  }

  /** Текст сообщения (`''`, если его нет; у нажатия кнопки — тоже `''`, текст панели — `ctx.message.text`). */
  get text(): string {
    if (this.update.callback_query) return '';
    return this.message?.text ?? '';
  }

  /** Ответить в ту же беседу. */
  reply(text: string, options?: SendMessageOptions): Promise<Message> {
    return this.api.sendMessage(this.chat.id, text, options);
  }

  /** Ответить цитатой на это сообщение. */
  replyTo(text: string, options?: SendMessageOptions): Promise<Message> {
    const id = this.message?.message_id;
    return this.api.sendMessage(this.chat.id, text, { ...(id ? { reply_to_message_id: id } : {}), ...options });
  }

  /**
   * Ответ на нажатие: гасит часики на кнопке; строка — всплывашка, `{text, show_alert:true}` — окно. Один раз; без вызова SDK
   * ответит пустым сам после обработчика (`autoAnswerCallbackQuery`).
   */
  answerCallbackQuery(textOrOptions?: string | { text?: string; show_alert?: boolean }): Promise<true> {
    const q = this.update.callback_query;
    if (!q) return Promise.reject(new TypeError('answerCallbackQuery: это не нажатие кнопки'));
    this.callbackAnswered = true;
    const options = typeof textOrOptions === 'string' ? { text: textOrOptions } : (textOrOptions ?? {});
    return this.api.answerCallbackQuery(q.id, options);
  }

  /** Править текст сообщения события (у нажатия — панели). 🔴 Без `reply_markup` кнопки СНИМАЮТСЯ (как в Telegram). */
  editMessageText(text: string, options: { reply_markup?: InlineKeyboardMarkup } = {}): Promise<Message> {
    const m = this.message;
    if (!m) return Promise.reject(new TypeError('editMessageText: у события нет сообщения'));
    return this.api.editMessageText(m.chat.id, m.message_id, text, options);
  }

  /** Сменить только кнопки сообщения события (без «(изм.)»); без аргумента — снять. */
  editMessageReplyMarkup(replyMarkup?: InlineKeyboardMarkup): Promise<Message> {
    const m = this.message;
    if (!m) return Promise.reject(new TypeError('editMessageReplyMarkup: у события нет сообщения'));
    return this.api.editMessageReplyMarkup(m.chat.id, m.message_id, replyMarkup);
  }

  /** Удалить сообщение события (у нажатия — панель). */
  deleteMessage(): Promise<true> {
    const m = this.message;
    if (!m) return Promise.reject(new TypeError('deleteMessage: у события нет сообщения'));
    return this.api.deleteMessage(m.chat.id, m.message_id);
  }

  /** «Печатает…» у собеседника (гаснет сам через несколько секунд или с ответом). */
  typing(): Promise<true> {
    return this.api.sendChatAction(this.chat.id, 'typing');
  }
}
