/**
 * Боты (#234, план `docs/bots-plan.md`). Контракт между сервером и клиентом — управление ботами из «Моих ботов» и
 * админ-панели — и правила, общие для обеих сторон. Провод самого Bot API v1 (`/api/bot/v1/*`, snake_case в стиле Telegram)
 * описан на сервере: его видят чужие программы, и меняется он только добавлениями.
 */

import { Permission } from './permissions';

/** Кто на инстансе может создавать ботов (настройка админа, `instance_settings`). */
export type BotCreators = 'all' | 'approved' | 'admin';

export interface BotSettings {
  /**
   * Общий выключатель ботов на инстансе (владелец 26.10: по умолчанию ВЫКЛ, включает админ тумблером в админ-панели, без `.env`).
   * Выключено — токены не принимаются (403), события не копятся, создавать нельзя. Необязательное: старый сервер не присылает.
   */
  enabled?: boolean;
  creators: BotCreators;
  /** Сколько ботов может держать один человек (админа инстанса не ограничивает). */
  perUserLimit: number;
  /** Доставка событий на адреса локальной сети. По умолчанию выкл — защита от SSRF. Loopback (сам сервер) закрыт всегда (26.10). */
  allowInternalWebhooks: boolean;
  /**
   * Этап 4 (#232): боты могут заходить в голосовые каналы. Нет поля — можно (общий выключатель `enabled` и так по умолчанию
   * выключен); `false` — голос ботам закрыт, при выключении сервер выкидывает всех ботов из всех комнат.
   */
  voice?: boolean;
}

export const DEFAULT_BOT_SETTINGS: BotSettings = { enabled: false, creators: 'all', perUserLimit: 10, allowInternalWebhooks: false };
export const BOT_PER_USER_LIMIT_MAX = 100;

/**
 * Включены ли боты по ответу сервера (`BotSettings` админки или `MyBotsResponse`). Нет поля — сервер старше выключателя:
 * там боты работали всегда, считать включёнными. Только `false` значит «выключены».
 */
export function botsEnabled(r: { enabled?: boolean } | null | undefined): boolean {
  return r?.enabled !== false;
}

export interface BotWebhookState {
  url: string;
  /** Последняя ошибка доставки (коротко, для владельца), `null` — доставки идут. */
  lastError: string | null;
  /** Когда случилась последняя ошибка (ISO). Поле добавлено 26.10 — старый сервер его не шлёт. */
  lastErrorAt?: string | null;
  failures: number;
  /** Доставку выключил сервер после серии сбоев — владелец включает заново через `setWebhook`. */
  disabledAt: string | null;
}

/** Бот в «Моих ботах» владельца. `id` — id пользователя-бота (`users.id`). */
export interface BotInfo {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  description: string;
  about: string;
  /** Писать боту могут все (`true`) или только владелец (`false`, так создаётся новый бот). */
  public: boolean;
  createdAt: string;
  tokenCreatedAt: string;
  webhook: BotWebhookState | null;
  /** Бот выключен админом инстанса — токен не принимается. */
  disabledAt: string | null;
  /** Серверы, где стоит бот (#231; только владельцу). Нет поля — старый сервер. */
  servers?: { id: string; name: string }[];
}

/** `GET /api/bots` */
export interface MyBotsResponse {
  bots: BotInfo[];
  canCreate: boolean;
  limit: number;
  /** Боты на инстансе включены админом (`BotSettings.enabled`). Нет поля — старый сервер, считать включёнными. */
  enabled?: boolean;
}

/** `POST /api/bots` → `{ bot, token }`; токен показывается один раз. Так же отвечает `POST /api/bots/:id/token`. */
export interface CreateBotBody {
  username: string;
  displayName?: string;
  description?: string;
}
export interface BotTokenResponse {
  bot: BotInfo;
  token: string;
}

/** `PATCH /api/bots/:id` */
export interface UpdateBotBody {
  displayName?: string | null;
  description?: string;
  about?: string;
  public?: boolean;
}

/** `GET /api/admin/bots` — все боты инстанса для супер-админа. */
export interface AdminBotInfo extends BotInfo {
  owner: { id: string; username: string; displayName: string | null };
}

export const BOT_DESCRIPTION_MAX = 512;
export const BOT_ABOUT_MAX = 120;

/** Префикс токена бота — по нему сканеры секретов узнают утечку. */
export const BOT_TOKEN_PREFIX = 'gvb_';

/**
 * Как выглядит удалённый бот в беседах (26.10): «Удалённый бот», а не «Удалённый пользователь» (`accountRules.DELETED_DISPLAY_NAME`
 * на сервере). Сервер пишет это имя при удалении бота и подставляет его в сводке беседы удалённым раньше.
 */
export const DELETED_BOT_NAME = 'Удалённый бот';

/**
 * Ник бота: как у людей (латиница, цифры, `_`, 3–32), но оканчивается на `bot` без учёта регистра — как в Telegram, чтобы
 * бот не выдавал себя за человека. Ошибка — текст для человека, `null` — ник подходит.
 */
export function botUsernameError(username: string): string | null {
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) return 'Ник: 3–32 символа, латиница, цифры и _';
  if (!/bot$/i.test(username)) return 'Ник бота должен оканчиваться на bot';
  return null;
}

/**
 * Ник человека не может оканчиваться на `bot` без учёта регистра (владелец 26.10, решение D): только у ботов, иначе человек
 * выдаёт себя за бота. Только НОВЫЕ ники — регистрация, смена ника, создание админом, мастер установки; существующие и теневые
 * строки людей соседей не трогаем. `true` — ник занят под ботов.
 */
export function humanUsernameLooksBot(username: string): boolean {
  return /bot$/i.test(username.trim());
}
export const HUMAN_BOT_USERNAME_ERROR = 'Ник, оканчивающийся на «bot», — только для ботов. Выберите другой.';

/**
 * Почему человеку нельзя писать боту (решение владельца 26.10, A): бот выключен (админом или все боты на инстансе) или
 * приватный, а пишет не владелец. Сводка беседы отдаёт это добавлением (`otherUser.botUnavailable`), отправка — 403
 * `{ error, code: 'bot_unavailable', reason }`. Старый клиент читает только `error`.
 */
export type BotUnavailable = 'private' | 'disabled';
export const BOT_UNAVAILABLE_ERRORS: Record<BotUnavailable, string> = {
  disabled: 'Этот бот выключен',
  private: 'Этот бот доступен только своему владельцу',
};
export const BOT_UNAVAILABLE_CODE = 'bot_unavailable';
export function botUnavailableFor(
  bot: { disabledAt: unknown; public: boolean; ownerId: string },
  instanceBotsEnabled: boolean,
  me: string,
): BotUnavailable | null {
  if (bot.disabledAt || !instanceBotsEnabled) return 'disabled';
  if (!bot.public && bot.ownerId !== me) return 'private';
  return null;
}

// ─── Этап 2 (#230): команды и кнопки ───────────────────────────────────────────────────────────────────────────────────
/** Команды бота (`setMyCommands`): имя 1–32 знака `a-z 0-9 _`, описание 1–256, не больше 100 (как Telegram `BotCommand`). */
export const BOT_COMMANDS_MAX = 100;
export const BOT_COMMAND_RE = /^[a-z0-9_]{1,32}$/;
export const BOT_COMMAND_DESC_MAX = 256;
export interface BotCommandInfo {
  command: string;
  description: string;
}
/**
 * `GET /api/conv/:id/bot` — карточка бота, с которым эта беседа 1:1 (список команд для подсказки по «/» + описание).
 * Старый сервер маршрута не знает (404) — клиент живёт без подсказки. Боты выключены / бот выключен — `commands: []`.
 */
export interface ConvBotInfo {
  id: string;
  /** Длинное описание (экран «Старт»), может быть пустым. */
  description: string;
  /** Короткая строка «о боте» в профиле, может быть пустой. */
  about: string;
  commands: BotCommandInfo[];
  /** Когда бот последний раз менял список (ISO); `null` — не задавал. */
  commandsUpdatedAt: string | null;
}

/** Кнопка под сообщением бота — ровно одно из `callback_data` / `url`. Форма та же, что у Bot API (snake_case): хранится, шлётся клиенту и боту без преобразований. */
export interface InlineKeyboardButton {
  text: string;
  /** До 64 БАЙТ UTF-8. Нажатие шлёт боту `callback_query`. */
  callback_data?: string;
  /** Только http(s) без логина в адресе. Клиент открывает ссылку с тем же подтверждением, что и другие внешние. */
  url?: string;
}
export type InlineKeyboard = InlineKeyboardButton[][];
/** Пределы клавиатуры (Telegram: 8 в ряду, 100 всего — по памяти, взяты консервативно; текст кнопки Telegram не режет — режем сами). */
export const KEYBOARD_ROW_BUTTONS_MAX = 8;
export const KEYBOARD_BUTTONS_MAX = 100;
export const KEYBOARD_BUTTON_TEXT_MAX = 64;
export const CALLBACK_DATA_MAX_BYTES = 64;
export const KEYBOARD_URL_MAX = 2048;
/** `answerCallbackQuery.text` — до 200 знаков (как Telegram). */
export const ANSWER_TEXT_MAX = 200;
/** Сколько человек ждёт ответа бота на нажатие (часики на кнопке), секунд; через столько сервер отвечает `timeout`. */
export const CALLBACK_QUERY_WAIT_S = 15;
/**
 * Окно жизни нажатия, секунд (аудит 26.10 — свели три окна в одно): столько живёт `callback_query_id` для
 * `answerCallbackQuery` (Redis) и столько событие отдаётся боту из журнала; старше — не отдаётся (бот лежал — старое
 * «Перезапустить» не выполняется). Больше `CALLBACK_QUERY_WAIT_S`: бот, ответивший чуть позже часиков, получает `ok`.
 */
export const CALLBACK_QUERY_TTL_S = 25;
/** Старше этого `callback_query` боту не отдаётся — то же окно, что `CALLBACK_QUERY_TTL_S`. */
export const CALLBACK_QUERY_STALE_S = CALLBACK_QUERY_TTL_S;

/** `POST /api/conv/:id/messages/:mid/callback` — тело. */
export interface BotCallbackBody {
  data: string;
}
/**
 * Ответ нажатия (200). Пусто — бот ответил молча (часики гаснут, ничего не показываем). `text` без `alert` — всплывашка;
 * с `alert` — окно с «Понятно». `timeout` — бот не ответил за `CALLBACK_QUERY_WAIT_S`.
 * Ошибки: 409 `{error:'stale_button'}` — такой кнопки у сообщения уже нет (перечитать сообщение); 403 — бот выключен;
 * 404 — нет беседы/сообщения; 429 — часто жмёт (`Retry-After`).
 */
export interface BotCallbackResult {
  text?: string;
  alert?: true;
  timeout?: true;
}

export function callbackDataBytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

// ─── Этап 3 (#231): боты на серверах ───────────────────────────────────────────────────────────────────────────────────
export const SERVER_BOTS_MAX = 20;
/** Права управляемой роли по умолчанию в окне «Добавить бота» (человек меняет галочками). */
export const BOT_DEFAULT_PERMISSIONS = (Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.READ_HISTORY).toString();
export interface ServerBotInfo {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  description: string;
  /** «Читать все сообщения» на этом сервере. */
  readAll: boolean;
  /** Управляемая роль (null — старые данные/сбой). */
  roleId: string | null;
  addedBy: { id: string; displayName: string } | null;
  addedAt: string;
  /** Бот или боты на инстансе выключены — «Сейчас не работает». */
  working: boolean;
}
export interface ServerBotLookup {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  description: string;
  canAdd: boolean;
  /** Почему нельзя: уже на сервере / забанен / лимит. Приватный чужой бот в выдачу не попадает вовсе (404). */
  reason?: string;
}
export interface AddServerBotBody {
  botId: string;
  permissions: string;
  readAll: boolean;
}
export interface UpdateServerBotBody {
  readAll?: boolean;
}
export interface ChannelBotsInfo {
  bots: { id: string; username: string; displayName: string; avatarUrl: string | null; commands: BotCommandInfo[] }[];
}
/** Команды бота по областям (`setMyCommands` со `scope`; сервер хранит в `bots.commands_scoped`). Нет ключа — `default`. */
export interface BotCommandsScoped {
  all_private_chats?: BotCommandInfo[];
  all_group_chats?: BotCommandInfo[];
}

// ─── Этап 4 (#232): звук в голосовом канале ───────────────────────────────────────────────────────────────────────────
/** Входов бота в голос (`joinVoice`) — 6 за 60 с на бота. */
export const BOT_VOICE_JOIN_RATE = { max: 6, windowS: 60 } as const;
/** Ботов в одном голосовом канале (решение владельца 27.10). */
export const BOT_VOICE_PER_CHANNEL = 3;
/** Одновременных голосовых каналов на бота (на сервере — один, вход в другой канал того же сервера = переход). */
export const BOT_VOICE_MAX_ROOMS = 10;
/** Срок токена LiveKit бота: короткий — украденный JWT нельзя отозвать, дальше токен продлевает сам LiveKit. */
export const BOT_VOICE_TOKEN_TTL_S = 600;
/** `joinVoice.bitrate` — сервер только проверяет диапазон и возвращает его в `audio`. */
export const BOT_VOICE_BITRATE = { min: 24000, def: 64000, max: 128000 } as const;
/** Бот один в канале (людей нет) дольше этого — сервер его выкидывает (решение владельца 27.10). */
export const BOT_VOICE_ALONE_S = 300;
