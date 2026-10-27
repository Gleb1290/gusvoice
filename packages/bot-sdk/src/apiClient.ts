/**
 * Клиент методов Bot API v1: `POST <api>/api/bot/v1/<метод>` с заголовком `Authorization: Bot <токен>`, ответ
 * `{ok:true,result}` / `{ok:false,error_code,description,retry_after?}`. 429 повторяется сам после `retry_after`.
 */
import type {
  ApiErrorBody,
  ChatMember,
  ReactionType,
  ServerInfo,
  BotCommand,
  BotCommandScope,
  BotUser,
  ChatFullInfo,
  DeleteWebhookParams,
  GetUpdatesParams,
  InlineKeyboardMarkup,
  InputEmbed,
  Message,
  SendMessageParams,
  Update,
  VoiceChatMember,
  VoiceJoinResult,
  WebhookInfo,
} from './wire.js';

/** Ошибка метода: код и описание — как прислал сервер (`error_code`, `description`), `retryAfter` — у 429. */
export class GusVoiceApiError extends Error {
  readonly code: number;
  readonly description: string;
  readonly retryAfter?: number;
  readonly method?: string;
  constructor(code: number, description: string, retryAfter?: number, method?: string) {
    super(`${method ? `${method}: ` : ''}${code} ${description}`);
    this.name = 'GusVoiceApiError';
    this.code = code;
    this.description = description;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
    if (method !== undefined) this.method = method;
  }
}

/**
 * Файл для `sendMessage`: `Blob`/`File`, байты (`Uint8Array`, `Buffer`) или путь на диске (строка) — имя берётся из пути;
 * объектом — с явным именем и типом. Сервер принимает до 10 файлов по 25 МБ.
 */
export type InputFile = Blob | Uint8Array | string | { data: Blob | Uint8Array | string; name?: string; type?: string };

export interface SendMessageOptions extends Omit<SendMessageParams, 'chat_id' | 'text'> {
  files?: InputFile[];
}

export interface ApiOptions {
  /** Адрес инстанса (сайт или API). */
  baseUrl: string;
  /**
   * Узнать адрес API по `<baseUrl>/config.json` (`apiUrl`) — у инстанса сайт и API часто на разных адресах.
   * По умолчанию да; `false` — `baseUrl` и есть адрес API.
   */
  discover?: boolean;
  /** Сколько раз повторять 429 после `retry_after` (по умолчанию 3; 0 — не повторять). */
  maxRetries?: number;
  /** Предел ожидания одного 429, секунд: дольше — ошибка сразу (по умолчанию 60). */
  maxRetryAfter?: number;
  /** Срок одного запроса, мс (по умолчанию 30 000; долгий опрос — свой срок сверх `timeout`). */
  timeoutMs?: number;
  /** Свой `fetch` (прокси, тесты). */
  fetch?: typeof fetch;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
export { sleep };

/** Сигнал, что сработает по любому из двух (`AbortSignal.any` есть не везде, где живёт Node 18). */
function anySignal(a: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error(`request timed out after ${ms} ms`)), ms);
  const onAbort = () => ctl.abort(a?.reason);
  if (a?.aborted) ctl.abort(a.reason);
  else a?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(t);
      a?.removeEventListener('abort', onAbort);
    },
  };
}

/** Без хвостовых `/` и без `/api` в конце: путь методов SDK дописывает сам. */
export function normalizeBase(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u.endsWith('/api')) u = u.slice(0, -4);
  if (!/^https?:\/\//i.test(u)) throw new TypeError(`baseUrl must start with http:// or https:// (got "${url}")`);
  return u;
}

async function fileToBlob(f: InputFile): Promise<{ blob: Blob; name: string }> {
  const o = typeof f === 'object' && !(f instanceof Blob) && !(f instanceof Uint8Array) ? f : { data: f };
  const { data } = o;
  let blob: Blob;
  let name = o.name;
  if (typeof data === 'string') {
    // Путь на диске: `node:fs` есть в Node, Bun и Deno.
    const fs = await import('node:fs/promises');
    const bytes = await fs.readFile(data);
    blob = new Blob([bytes], o.type ? { type: o.type } : {});
    name ??= data.split(/[\\/]/).pop() || 'file';
  } else if (data instanceof Blob) {
    blob = o.type && !data.type ? new Blob([data], { type: o.type }) : data;
    name ??= (data as Blob & { name?: string }).name || 'file';
  } else {
    blob = new Blob([data], o.type ? { type: o.type } : {});
    name ??= 'file';
  }
  return { blob, name };
}

/** Методы Bot API v1. */
export class Api {
  private readonly token: string;
  private readonly base: string;
  private readonly opts: Required<Pick<ApiOptions, 'discover' | 'maxRetries' | 'maxRetryAfter' | 'timeoutMs'>>;
  private readonly fetchFn: typeof fetch;
  private apiBase: Promise<string> | null = null;

  constructor(token: string, options: ApiOptions) {
    if (!token || typeof token !== 'string') throw new TypeError('Bot token is required (take it from an environment variable)');
    if (!options?.baseUrl) throw new TypeError('baseUrl is required: the address of your GusVoice instance');
    this.token = token.trim();
    this.base = normalizeBase(options.baseUrl);
    this.opts = {
      discover: options.discover ?? true,
      maxRetries: Math.max(0, options.maxRetries ?? 3),
      maxRetryAfter: options.maxRetryAfter ?? 60,
      timeoutMs: options.timeoutMs ?? 30_000,
    };
    this.fetchFn = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  /** Адрес API (`https://api.example.com`) — после разбора `config.json`. */
  apiUrl(): Promise<string> {
    if (!this.apiBase) {
      const p = this.discoverApi();
      this.apiBase = p;
      // Сбой сети при разборе не запоминаем: следующий вызов попробует снова.
      p.catch(() => {
        if (this.apiBase === p) this.apiBase = null;
      });
    }
    return this.apiBase;
  }

  private async discoverApi(): Promise<string> {
    if (!this.opts.discover) return this.base;
    const { signal, done } = anySignal(undefined, 10_000);
    try {
      const r = await this.fetchFn(`${this.base}/config.json`, { signal, headers: { accept: 'application/json' } });
      if (!r.ok) return this.base;
      const cfg = (await r.json().catch(() => null)) as { apiUrl?: unknown } | null;
      const api = typeof cfg?.apiUrl === 'string' ? cfg.apiUrl.trim() : '';
      if (!api) return this.base;
      // Относительный `apiUrl` — от адреса сайта; токен уходит только на http(s).
      const found = normalizeBase(new URL(api, `${this.base}/`).href);
      // Сайт по https, а `config.json` шлёт на http (подмена или ошибка настройки) — токен по открытому каналу не отдаём (аудит 26.10).
      if (/^https:/i.test(this.base) && !/^https:/i.test(found)) {
        throw new Error(`config.json of ${this.base} points apiUrl to non-HTTPS ${found}; refusing to send the bot token over plain HTTP`);
      }
      return found;
    } catch (e) {
      if (signal.aborted) return this.base;
      throw e;
    } finally {
      done();
    }
  }

  /** WS-адрес бота (`wss://…/api/bot/v1/ws`). */
  async wsUrl(offset?: number): Promise<string> {
    const u = new URL(`${await this.apiUrl()}/api/bot/v1/ws`);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    if (offset && offset > 0) u.searchParams.set('offset', String(offset));
    return u.href;
  }

  /** Заголовок входа (для своего транспорта, например WS из пакета `ws`). */
  authHeader(): string {
    return `Bot ${this.token}`;
  }

  /**
   * Любой метод v1. `params` уходят JSON-ом; `files` — multipart (`files[0]…`), параметры тогда полями формы
   * (массивы и объекты — строкой JSON).
   */
  async call<T = unknown>(method: string, params: object = {}, extra: { files?: InputFile[]; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const url = `${await this.apiUrl()}/api/bot/v1/${method}`;
    for (let attempt = 0; ; attempt++) {
      let body: string | FormData;
      const headers: Record<string, string> = { authorization: this.authHeader() };
      if (extra.files?.length) {
        const form = new FormData();
        for (const [k, v] of Object.entries(params)) {
          if (v === undefined || v === null) continue;
          form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
        const files = await Promise.all(extra.files.map(fileToBlob));
        files.forEach((f, i) => form.append(`files[${i}]`, f.blob, f.name));
        body = form;
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(params);
      }
      const { signal, done } = anySignal(extra.signal, extra.timeoutMs ?? this.opts.timeoutMs);
      let status: number;
      let json: unknown;
      let retryHeader: string | null;
      try {
        const r = await this.fetchFn(url, { method: 'POST', headers, body, signal });
        status = r.status;
        retryHeader = r.headers.get('retry-after');
        const text = await r.text();
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      } finally {
        done();
      }
      const res = json as { ok?: unknown; result?: unknown } | null;
      if (res && res.ok === true) return res.result as T;
      const err = (res && res.ok === false ? res : null) as ApiErrorBody | null;
      const code = err?.error_code ?? status;
      const description = err?.description ?? `HTTP ${status}`;
      const retryAfter = err?.retry_after ?? (retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : undefined);
      if (code === 429 && retryAfter !== undefined && attempt < this.opts.maxRetries && retryAfter <= this.opts.maxRetryAfter) {
        await sleep(retryAfter * 1000, extra.signal);
        continue;
      }
      throw new GusVoiceApiError(code, description, retryAfter, method);
    }
  }

  getMe(): Promise<BotUser> {
    return this.call('getMe');
  }

  /** Долгий опрос: события начиная с `offset` (всё до него сервер считает подтверждённым). */
  getUpdates(params: GetUpdatesParams = {}, signal?: AbortSignal): Promise<Update[]> {
    return this.call('getUpdates', params, { signal, timeoutMs: (params.timeout ?? 0) * 1000 + this.opts.timeoutMs });
  }

  /** Доставка событий POST-ом на `url`, подпись — секретом `secretToken` (16–256 знаков `A-Z a-z 0-9 _ -`). */
  setWebhook(url: string, secretToken: string, options: { drop_pending_updates?: boolean; batch?: boolean } = {}): Promise<true> {
    return this.call('setWebhook', { url, secret_token: secretToken, ...options });
  }

  deleteWebhook(options: DeleteWebhookParams = {}): Promise<true> {
    return this.call('deleteWebhook', options);
  }

  getWebhookInfo(): Promise<WebhookInfo> {
    return this.call('getWebhookInfo');
  }

  /** Сообщение в беседу `chatId` (id беседы — `ctx.chat.id`, не id человека). */
  sendMessage(chatId: string, text?: string, options: SendMessageOptions = {}): Promise<Message> {
    const { files, ...rest } = options;
    const params: SendMessageParams = { chat_id: chatId, ...(text !== undefined ? { text } : {}), ...rest };
    return this.call('sendMessage', params, { files });
  }

  /**
   * Правка текста. 🔴 Как в Telegram: без `reply_markup` кнопки под сообщением СНИМАЮТСЯ — чтобы оставить, передайте их снова.
   * `reply_markup` — `{inline_keyboard}` или `new InlineKeyboard()…`.
   */
  editMessageText(chatId: string, messageId: string, text: string, options: { reply_markup?: InlineKeyboardMarkup; parse_mode?: string } = {}): Promise<Message> {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...options });
  }

  /** Только кнопки под сообщением (без «(изм.)»); без `replyMarkup` — снять. */
  editMessageReplyMarkup(chatId: string, messageId: string, replyMarkup?: InlineKeyboardMarkup): Promise<Message> {
    return this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }

  /**
   * Ответ на нажатие кнопки (`callback_query.id`): гасит часики на кнопке у человека; `text` (до 200 знаков) — всплывашка,
   * с `show_alert` — окно. Один раз и в течение ~15 с; повтор — ошибка 400.
   */
  answerCallbackQuery(callbackQueryId: string, options: { text?: string; show_alert?: boolean } = {}): Promise<true> {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...options });
  }

  /** Список команд для подсказки по «/» у человека: замещает весь; `[]` — снять. */
  setMyCommands(commands: BotCommand[], options: { scope?: BotCommandScope } = {}): Promise<true> {
    return this.call('setMyCommands', { commands, ...options });
  }

  getMyCommands(options: { scope?: BotCommandScope } = {}): Promise<BotCommand[]> {
    return this.call('getMyCommands', options);
  }

  deleteMyCommands(options: { scope?: BotCommandScope } = {}): Promise<true> {
    return this.call('deleteMyCommands', options);
  }

  deleteMessage(chatId: string, messageId: string): Promise<true> {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  /** «Печатает…» у собеседника (этап 1 — только `typing`). */
  sendChatAction(chatId: string, action: 'typing' = 'typing'): Promise<true> {
    return this.call('sendChatAction', { chat_id: chatId, action });
  }

  getChat(chatId: string): Promise<ChatFullInfo> {
    return this.call('getChat', { chat_id: chatId });
  }

  // ─── API 3 (#231): серверы ───

  /** Набор реакций бота на сообщение (0–3) заменяется целиком; строка — одно эмодзи; `[]` — снять свои. ЛС и каналы. */
  setMessageReaction(chatId: string, messageId: string, reaction: ReactionType[] | string): Promise<true> {
    const list = typeof reaction === 'string' ? (reaction ? [{ type: 'emoji' as const, emoji: reaction }] : []) : reaction;
    return this.call('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: list });
  }

  /** Закрепить сообщение в канале (нужно право «Управлять сообщениями»). */
  pinChatMessage(chatId: string, messageId: string, options: { disable_notification?: boolean } = {}): Promise<true> {
    return this.call('pinChatMessage', { chat_id: chatId, message_id: messageId, ...options });
  }

  unpinChatMessage(chatId: string, messageId: string): Promise<true> {
    return this.call('unpinChatMessage', { chat_id: chatId, message_id: messageId });
  }

  /** Участник сервера (`chatId` — сервер или его канал): статус `creator|member|left|kicked`, роли, ник. */
  getChatMember(chatId: string, userId: string): Promise<ChatMember> {
    return this.call('getChatMember', { chat_id: chatId, user_id: userId });
  }

  getChatMemberCount(serverId: string): Promise<number> {
    return this.call('getChatMemberCount', { chat_id: serverId });
  }

  /** Ростер сервера страницами (`limit` ≤ 200; дальше — `next_offset`). */
  getChatMembers(serverId: string, options: { offset?: string; limit?: number } = {}): Promise<{ members: ChatMember[]; next_offset?: string }> {
    return this.call('getChatMembers', { chat_id: serverId, ...options });
  }

  getMyServers(): Promise<{ id: string; title: string }[]> {
    return this.call('getMyServers');
  }

  /** Сервер: видимые боту каналы (`can_send`) и роли (`managed` — роль бота или «Гости»). */
  getServer(serverId: string): Promise<ServerInfo> {
    return this.call('getServer', { server_id: serverId });
  }

  /** История канала (старые → новые) — только боту с «читать все сообщения» и правом читать историю. */
  getChatHistory(channelId: string, options: { before_message_id?: string; limit?: number } = {}): Promise<Message[]> {
    return this.call('getChatHistory', { chat_id: channelId, ...options });
  }

  addChatMemberRole(serverId: string, userId: string, roleId: string): Promise<true> {
    return this.call('addChatMemberRole', { chat_id: serverId, user_id: userId, role_id: roleId });
  }

  removeChatMemberRole(serverId: string, userId: string, roleId: string): Promise<true> {
    return this.call('removeChatMemberRole', { chat_id: serverId, user_id: userId, role_id: roleId });
  }

  banChatMember(serverId: string, userId: string, options: { reason?: string } = {}): Promise<true> {
    return this.call('banChatMember', { chat_id: serverId, user_id: userId, ...options });
  }

  unbanChatMember(serverId: string, userId: string): Promise<true> {
    return this.call('unbanChatMember', { chat_id: serverId, user_id: userId });
  }

  /** Выгнать с сервера (без бана — может вернуться по ссылке). */
  kickChatMember(serverId: string, userId: string): Promise<true> {
    return this.call('kickChatMember', { chat_id: serverId, user_id: userId });
  }

  /** Бот уходит с сервера сам. */
  leaveChat(serverId: string): Promise<true> {
    return this.call('leaveChat', { chat_id: serverId });
  }

  // ─── API 4 (#232): голос ───

  /**
   * Вход в голосовой канал: данные для LiveKit (`url`, `token`, `room`). Сам звук — в пакете `@gusvoice/bot-voice`
   * (`bot.voice.join(channelId)` зовёт этот метод и подключается). Вход в другой канал того же сервера — переход.
   * `bitrate` 24000–128000 (по умолчанию 64000). Токен живёт 10 минут — не логируйте его.
   */
  joinVoice(chatId: string, options: { bitrate?: number } = {}): Promise<VoiceJoinResult> {
    return this.call('joinVoice', { chat_id: chatId, ...options });
  }

  /** Выйти из голосового канала; без `chatId` — из всех. Повтор безопасен: если бота там нет, ответ всё равно `true`. */
  leaveVoice(chatId?: string): Promise<true> {
    return this.call('leaveVoice', chatId ? { chat_id: chatId } : {});
  }

  /** Кто сейчас в голосовом канале (срез presence — то же, что видят люди). */
  getVoiceChatMembers(chatId: string): Promise<VoiceChatMember[]> {
    return this.call('getVoiceChatMembers', { chat_id: chatId });
  }
}

export type { InputEmbed };
