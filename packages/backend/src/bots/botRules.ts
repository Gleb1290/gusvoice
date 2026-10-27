/**
 * Боты (#229, этап 1 — ЛС; план `docs/bots-plan.md`) — ЧИСТЫЕ правила: токен, разбор заголовка, настройка инстанса, кто
 * может создавать, подпись доставки, паузы повторов, пределы. Без базы, Redis и `env` — их места в `bots/*.ts` и маршрутах.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BOT_PER_USER_LIMIT_MAX,
  BOT_TOKEN_PREFIX,
  BOT_VOICE_MAX_ROOMS,
  BOT_VOICE_PER_CHANNEL,
  type BotSettings,
  DEFAULT_BOT_SETTINGS,
  has,
  mentionedNames,
  Permission,
} from '@gusvoice/shared';
/**
 * Окна нажатия (#230) — из контракта; отсюда их берёт `botStore.ts` (его тест грузит модуль с закрытым перечнем импортов).
 * Аудит 26.10: жизнь запроса в Redis (`TTL`) и выдача из журнала (`STALE`) — одно окно 25 с.
 */
export { CALLBACK_QUERY_STALE_S, CALLBACK_QUERY_TTL_S } from '@gusvoice/shared';
/** Этап 4 (#232): пределы голоса ботов — из контракта (`shared/src/bots.ts`). */
export {
  BOT_VOICE_ALONE_S,
  BOT_VOICE_BITRATE,
  BOT_VOICE_JOIN_RATE,
  BOT_VOICE_MAX_ROOMS,
  BOT_VOICE_PER_CHANNEL,
  BOT_VOICE_TOKEN_TTL_S,
} from '@gusvoice/shared';

/** Ключ настройки в `instance_settings`. */
export const BOTS_SETTINGS_KEY = 'bots';

/** Токен: `gvb_` + 32 случайных байта base64url (43 знака). Префикс — чтобы сканеры секретов узнавали утечку. */
export function newBotToken(): string {
  return BOT_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}
export const BOT_TOKEN_RE = /^gvb_[A-Za-z0-9_-]{43}$/;

/** Хеш токена для базы (sha256 hex). Соли нет: 256 случайных бит словаря не имеют — как у вебхуков (`webhookRules.ts`). */
export function hashBotToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Совпадает ли токен с хешем — за постоянное время (по хешам равной длины). */
export function botTokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashBotToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** Непригодный хеш (удалённый бот): sha256 от случайных байт — ни один токен ему не равен. */
export function deadTokenHash(): string {
  return createHash('sha256').update(randomBytes(32)).digest('hex');
}

/**
 * Токен из заголовка `Authorization: Bot gvb_…`. Только эта схема: `Bearer` — у людей, и токен бота не должен по ошибке
 * уйти в их маршруты (а их JWT — сюда). Кривой — `null` (ответ 401 без похода в базу).
 */
export function botTokenFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bot\s+(\S+)\s*$/.exec(header);
  if (!m || !BOT_TOKEN_RE.test(m[1])) return null;
  return m[1];
}

/** Настройка инстанса из `instance_settings` → полная; мусор и отсутствие — умолчания (`DEFAULT_BOT_SETTINGS`). */
export function normalizeBotSettings(raw: unknown): BotSettings & { enabled: boolean } {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const creators = v.creators === 'all' || v.creators === 'approved' || v.creators === 'admin' ? v.creators : DEFAULT_BOT_SETTINGS.creators;
  const limit =
    typeof v.perUserLimit === 'number' && Number.isInteger(v.perUserLimit) && v.perUserLimit >= 0
      ? Math.min(v.perUserLimit, BOT_PER_USER_LIMIT_MAX)
      : DEFAULT_BOT_SETTINGS.perUserLimit;
  return {
    creators,
    perUserLimit: limit,
    allowInternalWebhooks: v.allowInternalWebhooks === true,
    // Нет поля — ВЫКЛЮЧЕНЫ (владелец 26.10): код ботов уезжает на прод и чужие коробки спящим, админ включает тумблером.
    enabled: v.enabled === true,
    // Этап 4 (#232): голос ботов. Нет поля — можно; поле в объекте только при явном `false` (прежний вид настроек не меняется).
    ...(v.voice === false ? { voice: false } : {}),
  };
}

/** Голос ботам открыт: боты включены и голос не выключен админом (`voice: false`). */
export function botVoiceEnabled(s: { enabled?: boolean; voice?: boolean }): boolean {
  return s.enabled === true && s.voice !== false;
}

/**
 * Может ли человек создать ещё одного бота. Супер-админ — всегда (лимит его не держит), остальные — по «кто создаёт»
 * (`approved` — одобренный аккаунт, `admin` — только супер-админ) и лимиту. Выключенные боты — никто.
 */
export function canCreateBot(s: BotSettings & { enabled: boolean }, who: { superAdmin: boolean; approved: boolean; owned: number }): boolean {
  if (!s.enabled) return false;
  if (who.superAdmin) return true;
  if (s.creators === 'admin') return false;
  if (s.creators === 'approved' && !who.approved) return false;
  return who.owned < s.perUserLimit;
}

/** Время провода — секунды Unix (как Telegram). */
export function unixSeconds(d: Date | string | number): number {
  return Math.floor(new Date(d).getTime() / 1000);
}

// ─── Доставка на адрес ───────────────────────────────────────────────────────────────────────────────────────────────

/** Секрет подписи, заданный ботом: 16–256 знаков `[A-Za-z0-9_-]` (как `secret_token` у Telegram, но не короче 16). */
export const WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]{16,256}$/;
export const WEBHOOK_URL_MAX = 2048;
/** Срок одной доставки и сколько ответа читаем (тело ответа нам не нужно — только статус). */
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_RESPONSE_MAX = 4 * 1024;
/** Сбоев подряд, после которых доставка выключается (`webhook_disabled_at`) — до нового `setWebhook`. */
export const WEBHOOK_FAILURES_MAX = 10;

/**
 * Заголовок подписи: `t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>` (как Stripe). Время внутри подписи — чтобы
 * перехваченный запрос нельзя было повторить позже окна (SDK проверяет 5 минут).
 */
export function webhookSignature(secret: string, body: string | Buffer, nowS: number): string {
  const mac = createHmac('sha256', secret).update(`${nowS}.`).update(body).digest('hex');
  return `t=${nowS},v1=${mac}`;
}

/** Пауза перед повтором после `failures` сбоев подряд: 5 с, 10, 20 … но не больше 10 минут. */
export function webhookBackoffMs(failures: number): number {
  const n = Math.max(1, failures);
  return Math.min(5_000 * 2 ** (n - 1), 600_000);
}

/**
 * Сетевые сбои доставки по коду Node (26.10): в базе — по-русски (владелец видит его в «Моих ботах»), в проводе Bot API
 * (`getWebhookInfo.last_error_message`) — по-английски, как остальной `description` (`webhookErrorWire`). Одна таблица на оба.
 */
const HOOK_NET_ERRORS: Readonly<Record<string, { ru: string; en: string }>> = {
  ECONNREFUSED: { ru: 'соединение отклонено', en: 'Connection refused' },
  ECONNRESET: { ru: 'соединение сброшено', en: 'Connection reset by peer' },
  ENOTFOUND: { ru: 'имя хоста не резолвится', en: 'Failed to resolve host' },
  EAI_AGAIN: { ru: 'имя хоста не резолвится', en: 'Failed to resolve host' },
  ETIMEDOUT: { ru: 'нет соединения: срок истёк', en: 'Connection timed out' },
  EHOSTUNREACH: { ru: 'хост недоступен', en: 'Host unreachable' },
  ENETUNREACH: { ru: 'сеть недоступна', en: 'Network unreachable' },
};
const HOOK_TLS_ERROR = { ru: 'сертификат адреса не прошёл проверку', en: 'SSL error: certificate verify failed' };

/** Короткий текст ошибки доставки для владельца (без тела ответа целиком) — по-русски; в провод — `webhookErrorWire`. */
export function webhookErrorText(e: { status?: number; error?: unknown }): string {
  if (e.status !== undefined) return `ответ ${e.status}`;
  const code = e.error && typeof e.error === 'object' ? (e.error as { code?: unknown }).code : undefined;
  if (typeof code === 'string') {
    if (Object.hasOwn(HOOK_NET_ERRORS, code)) return HOOK_NET_ERRORS[code].ru;
    if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return HOOK_TLS_ERROR.ru;
  }
  const msg = e.error instanceof Error ? e.error.message : String(e.error ?? 'ошибка');
  return msg.slice(0, 200);
}

/**
 * Ошибка доставки в провод Bot API (`last_error_message`, 26.10): по-английски, как у Telegram (`Wrong response from the
 * webhook: …`, `Read timeout expired`). Вход — то, что лежит в базе (`webhookErrorText`, в т.ч. записи до этой правки);
 * текст без кириллицы (сообщение Node, старое `HTTP 500`) — как есть; незнакомый русский — общей фразой, не по-русски.
 */
export function webhookErrorWire(stored: string): string {
  const status = /^ответ (\d{3})$/.exec(stored);
  if (status) return `Wrong response from the webhook: HTTP ${status[1]}`;
  if (/^(срок запроса истёк|таймаут)/.test(stored)) return 'Read timeout expired';
  if (/^заблокированная цель/.test(stored)) return 'Blocked: the webhook address is not allowed';
  if (stored === HOOK_TLS_ERROR.ru) return HOOK_TLS_ERROR.en;
  for (const e of Object.values(HOOK_NET_ERRORS)) if (e.ru === stored) return e.en;
  return /[А-Яа-яЁё]/.test(stored) ? 'Webhook delivery failed' : stored;
}

// ─── Журнал и пределы ────────────────────────────────────────────────────────────────────────────────────────────────

/** События хранятся сутки; больше потолка на бота — старые уходят первыми (как у Telegram: 24 ч). */
export const BOT_UPDATES_TTL_MS = 24 * 60 * 60 * 1000;
export const BOT_UPDATES_CAP = 1000;
/** Потолок журнала бота «читать всё» хоть на одном сервере (#231, решение владельца): ~1–2 КБ на событие → ≤ 20 МБ. */
export const BOT_UPDATES_CAP_READ_ALL = 10_000;
export const GET_UPDATES_LIMIT_MAX = 100;
export const GET_UPDATES_TIMEOUT_MAX = 50;

/** Пределы (`rateHit`): все методы бота; отправка в одну беседу (≈1/с, запас 5); ожидание событий (getUpdates / WS). */
export const BOT_RATE = { max: 30, windowS: 1 } as const;
export const BOT_CHAT_RATE = { max: 5, windowS: 5 } as const;
export const BOT_POLL_RATE = { max: 30, windowS: 10 } as const;
/**
 * `getMe.api_version` / `features` (аудит 26.10, добавление): версия возможностей v1 (1 — этап 1, 2 — кнопки и команды) и
 * перечень умений сервера — бот проверяет нужное по `features`, а не гадает по версии. Новое умение — дописать в конец.
 */
export const BOT_API_VERSION = 4;
/** Этап 3 (#231): `servers` — каналы и серверы, `reactions` — реакции (и в ЛС), `parse_mode` — HTML, `webhook_batch` — пачки. */
export const BOT_API_FEATURES = [
  'polling',
  'ws',
  'webhook',
  'keyboards',
  'commands',
  'client_id',
  'servers',
  'reactions',
  'parse_mode',
  'webhook_batch',
  // Этап 4 (#232): `joinVoice`/`leaveVoice`/`getVoiceChatMembers` и событие `voice_state`.
  'voice',
  // Этап 5 (#233): `GET /api/bot/v1/openapi.json` — схема OpenAPI 3.1 из реестра методов (провод не менялся, версия та же).
  'openapi',
] as const;
/** Одновременных WS на бота — один потребитель журнала (решение владельца 26.10, C): новый выбивает прежний (4009). */
export const BOT_WS_PER_BOT = 1;
/** Пинг WS бота (чаще простоя прокси ~90 с, как у шлюза людей). */
export const BOT_WS_PING_MS = 30_000;

/** Типы событий: этап 1 + `callback_query` (этап 2, #230 — нажатие кнопки под сообщением бота). */
export const BOT_UPDATE_TYPES = [
  'message',
  'edited_message',
  'message_deleted',
  'my_chat_member',
  'callback_query',
  'message_reaction',
  'chat_member',
  // Этап 4 (#232): кто зашёл в голосовой канал / вышел из него (и сам бот — так он узнаёт, что его отключили или перенесли).
  'voice_state',
] as const;
export type BotUpdateType = (typeof BOT_UPDATE_TYPES)[number];

/**
 * «Прочитано», когда бот ЗАБРАЛ событие (владелец 26.10, как в Telegram: getUpdates отдал / WS подтвердил `ack` / адрес
 * ответил 2xx), а не когда ответил. Из пачки событий — по беседе id её новых сообщений (`message`; правки, удаления,
 * `my_chat_member` прочтения не двигают). Одна отметка на беседу за пачку: «прочитано до» — самое позднее из них
 * (`bots/botRead.ts`). Непонятный груз пропускается.
 */
export function readMarksOf(rows: readonly { type: string; payload: unknown }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (r.type !== 'message' || !r.payload || typeof r.payload !== 'object') continue;
    const p = r.payload as { message_id?: unknown; chat?: { id?: unknown; type?: unknown } | null };
    // У каналов прочтений бота нет (#231) — `markTakenRead` не ходит в беседы зря.
    if (p.chat && typeof p.chat === 'object' && p.chat.type === 'channel') continue;
    const chatId = p.chat && typeof p.chat === 'object' ? p.chat.id : undefined;
    if (typeof p.message_id !== 'string' || !p.message_id || typeof chatId !== 'string' || !chatId) continue;
    const ids = out.get(chatId) ?? [];
    if (!ids.includes(p.message_id)) ids.push(p.message_id);
    out.set(chatId, ids);
  }
  return out;
}

// ─── Этап 2 (#230): команды и кнопки ─────────────────────────────────────────────────────────────────────────────────

/**
 * Адрес url-кнопки: только `http:`/`https:` и без логина/пароля в адресе (`https://bank.ru@evil` — фишинг). Не адрес —
 * отказ. Прочие схемы (`javascript:`, `data:`, `tg:` …) — отказ.
 */
export function isHttpUrlWithoutCredentials(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && u.hostname !== '';
}

/** Области `setMyCommands` этапа 2 — только ЛС: `default` и `all_private_chats` значат одно и то же. */
/** Области команд: `default`; `all_private_chats` — ЛС; `all_group_chats` — серверы (#231, как Telegram). */
export const BOT_COMMAND_SCOPES = ['default', 'all_private_chats', 'all_group_chats'] as const;
export type BotCommandScope = (typeof BOT_COMMAND_SCOPES)[number];
export function commandScopeOk(type: string): boolean {
  return (BOT_COMMAND_SCOPES as readonly string[]).includes(type);
}

/** Первое повторённое имя команды или `null`. */
export function duplicateCommand(commands: readonly { command: string }[]): string | null {
  const seen = new Set<string>();
  for (const c of commands) {
    if (seen.has(c.command)) return c.command;
    seen.add(c.command);
  }
  return null;
}

/** Нажатие кнопки (`POST /conv/:id/messages/:mid/callback`): есть ли у клавиатуры кнопка ровно с этим `callback_data`. */
export function keyboardHasData(keyboard: readonly (readonly { callback_data?: string }[])[] | null | undefined, data: string): boolean {
  if (!keyboard) return false;
  return keyboard.some((row) => row.some((b) => typeof b.callback_data === 'string' && b.callback_data === data));
}

/** Пределы нажатий: человек — 10 за 5 с, бот — 60 за 10 с; висящих — ≤ 3 у человека, неотвеченных — ≤ 20 у бота. */
export const CALLBACK_USER_RATE = { max: 10, windowS: 5 } as const;
export const CALLBACK_BOT_RATE = { max: 60, windowS: 10 } as const;
export const CALLBACK_PENDING_PER_USER = 3;
export const CALLBACK_PENDING_PER_BOT = 20;
/**
 * Сколько живёт счётчик висящих нажатий без `releasePending` (сбой процесса посреди ожидания): с запасом на ожидание
 * человека `CALLBACK_QUERY_WAIT_S` 15 с. От окна жизни нажатия (`CALLBACK_QUERY_TTL_S`, 25 с) не зависит (аудит 26.10).
 */
export const CALLBACK_PENDING_TTL_S = 30;
/** Опрос ответа бота во время ожидания нажатия (≤ 60 GET на нажатие при 15 с). */
export const CALLBACK_POLL_MS = 250;
/** Точный текст Telegram на повтор/просрочку/чужой id в `answerCallbackQuery`. */
export const CALLBACK_QUERY_INVALID = 'Bad Request: query is too old and response timeout expired or query id is invalid';

// ─── Этап 3 (#231): боты на серверах ─────────────────────────────────────────────────────────────────────────────────

/** Ошибка метода Bot API → `{ok:false}` с этим кодом (общая для `routes/botApi.ts` и `bots/botChannel.ts`). */
export class BotApiError extends Error {
  constructor(
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(description);
  }
}

/** Отправка бота: на сервер целиком (TG «~20 в минуту в группе» — по памяти, с запасом); на канал — `BOT_CHAT_RATE`. */
export const BOT_SERVER_RATE = { max: 30, windowS: 60 } as const;
/** Тяжёлые чтения бота (`getChatHistory`, `getChatMembers`) — как `heavyReadBlock` у людей. */
export const BOT_HEAVY_RATE = { max: 10, windowS: 10 } as const;
/** `getChatMembers.limit` по умолчанию. */
export const CHAT_MEMBERS_PAGE = 100;
/** `getChatHistory.limit` по умолчанию. */
export const CHAT_HISTORY_PAGE = 50;

/**
 * Фильтр приватности (ТЗ этапа 3 §1.5): адресовано ли сообщение канала боту без «читать всё».
 * 1. Текст начинается с `/` (первый знак): `/cmd@<этот бот>` — да, `/cmd@<другой>` — нет, `/cmd` без ника — да (всем ботам канала).
 * 2. Личное `@<ник бота>` (без регистра; `@everyone`/`@here` не в счёт).
 * 3. Упомянута управляемая роль бота.
 * 4. Ответ на сообщение этого бота.
 */
export function botAddressed(
  m: { content: string; mentionRoles?: readonly string[] | null; replyToAuthorId?: string | null },
  bot: { id: string; username: string; roleId?: string | null },
): boolean {
  const nick = bot.username.toLowerCase();
  const text = m.content;
  if (text.startsWith('/')) {
    const first = /^\/\S*/.exec(text)?.[0] ?? '/';
    const at = first.indexOf('@');
    if (at < 0) {
      if (first.length > 1) return true;
    } else if (first.slice(at + 1).toLowerCase() === nick) return true;
  }
  if (mentionedNames(text).some((n) => n.toLowerCase() === nick)) return true;
  if (bot.roleId && m.mentionRoles?.includes(bot.roleId)) return true;
  if (m.replyToAuthorId && m.replyToAuthorId === bot.id) return true;
  return false;
}

const HTML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return HTML_ENTITIES[e.toLowerCase()] ?? all;
  });
}

/**
 * `parse_mode: 'HTML'` (ТЗ §1.7): подмножество HTML Telegram → наши маркеры (`shared/textFormat.ts`). `b/strong` → `**`,
 * `i/em` → `__`, `u/ins` → `<u>`, `s/strike/del` → `~~`, `tg-spoiler`/`span class="tg-spoiler"` → `||`, `code` → обратная
 * кавычка, `pre` → блок из трёх кавычек, `a href` → «текст (адрес)» (или адрес, если текст и есть адрес), `blockquote` →
 * строки `> `. Незнакомые теги снимаются (текст остаётся), сущности раскодируются.
 */
export function htmlToMarkers(html: string): string {
  type Frame = { tag: string; close: string; href?: string; quote?: boolean; start: number };
  const out: string[] = [];
  const stack: Frame[] = [];
  const re = /<\s*(\/?)\s*([a-z][a-z0-9-]*)([^>]*)>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  const finish = (f: Frame) => {
    if (f.href !== undefined) {
      const inner = out.splice(f.start).join('');
      out.push(inner && f.href && inner !== f.href ? `${inner} (${f.href})` : inner || f.href);
    } else if (f.quote) {
      const inner = out.splice(f.start).join('');
      out.push(inner.split('\n').map((l) => `> ${l}`).join('\n'));
    } else out.push(f.close);
  };
  while ((m = re.exec(html))) {
    out.push(decodeEntities(html.slice(last, m.index)));
    last = re.lastIndex;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] ?? '';
    if (!closing) {
      if (tag === 'br') {
        out.push('\n');
        continue;
      }
      let open = '';
      const f: Frame = { tag, close: '', start: 0 };
      if (tag === 'b' || tag === 'strong') [open, f.close] = ['**', '**'];
      else if (tag === 'i' || tag === 'em') [open, f.close] = ['__', '__'];
      else if (tag === 'u' || tag === 'ins') [open, f.close] = ['<u>', '</u>'];
      else if (tag === 's' || tag === 'strike' || tag === 'del') [open, f.close] = ['~~', '~~'];
      else if (tag === 'tg-spoiler' || (tag === 'span' && /class\s*=\s*["']?tg-spoiler/i.test(attrs))) [open, f.close] = ['||', '||'];
      else if (tag === 'code') {
        if (!stack.some((x) => x.tag === 'pre')) [open, f.close] = ['`', '`'];
      } else if (tag === 'pre') [open, f.close] = ['```\n', '\n```'];
      else if (tag === 'a') {
        const h = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
        f.href = decodeEntities(h?.[1] ?? h?.[2] ?? '');
      } else if (tag === 'blockquote') f.quote = true;
      out.push(open);
      f.start = out.length;
      stack.push(f);
      continue;
    }
    const at = stack.map((x) => x.tag).lastIndexOf(tag);
    if (at === -1) continue;
    while (stack.length > at) finish(stack.pop()!);
  }
  out.push(decodeEntities(html.slice(last)));
  while (stack.length) finish(stack.pop()!);
  return out.join('');
}

/** Отказ `parse_mode` (провод): `MarkdownV2`/`Markdown` — свои грамматики TG, не поддерживаем. */
export const PARSE_MODE_UNSUPPORTED = 'Bad Request: parse_mode MarkdownV2 is not supported; use HTML or plain markers';

// ─── Этап 4 (#232): звук в голосовом канале ──────────────────────────────────────────────────────────────────────────

/** Что известно о цели `joinVoice` (и страховочного обхода) — собирает `bots/botVoice.ts`, решает `botVoiceDecision`. */
export interface BotVoiceInput {
  /** Боты включены на инстансе и голос ботам не выключен (`botVoiceEnabled`). */
  enabled: boolean;
  /**
   * Цель: `missing` — канала нет, бот не на его сервере или не видит его (`VIEW_CHANNEL`); `server` — это id сервера, где бот
   * участник; иначе — тип найденного канала.
   */
  target: 'missing' | 'server' | { type: string };
  /** Права бота в канале (для `missing`/`server` не читаются). */
  perms: bigint;
  /** Через сколько секунд можно снова (`rateHit` по `BOT_VOICE_JOIN_RATE`); 0/нет — можно. Обход не передаёт. */
  rateWait?: number;
  /** Других ботов в канале (presence + отметки «заходит»), сам бот не в счёт. */
  botsInChannel?: number;
  /** Каналов бота, которые останутся после входа (без этого канала и без каналов его сервера — они закрываются переходом). */
  otherRooms?: number;
}

/**
 * Пускать ли бота в голосовой канал (ТЗ этапа 4 §1.1). Порядок проверок — часть контракта: выключено → не найден → сервер
 * вместо канала → не голосовой → `CONNECT` → `SPEAK` → частота → ботов в канале → каналов у бота. `null` — можно.
 * Страховочный обход (`sweepBotVoice`) зовёт с п.1–5 (без частоты и счётчиков): не прошёл — бота выкидывает.
 */
export function botVoiceDecision(i: BotVoiceInput): BotApiError | null {
  if (!i.enabled) return new BotApiError(403, 'Forbidden: voice is disabled for bots on this server');
  if (i.target === 'missing') return new BotApiError(400, 'Bad Request: chat not found');
  if (i.target === 'server') return new BotApiError(400, 'Bad Request: chat is a server; use a channel id');
  if (i.target.type !== 'voice') return new BotApiError(400, 'Bad Request: chat is not a voice channel');
  if (!has(i.perms, Permission.CONNECT)) return new BotApiError(403, 'Forbidden: not enough rights to connect to the voice chat');
  if (!has(i.perms, Permission.SPEAK)) return new BotApiError(403, 'Forbidden: not enough rights to speak in the voice chat');
  if (i.rateWait && i.rateWait > 0) return new BotApiError(429, `Too Many Requests: retry after ${i.rateWait}`, i.rateWait);
  if ((i.botsInChannel ?? 0) >= BOT_VOICE_PER_CHANNEL) return new BotApiError(400, 'Bad Request: too many bots in the voice chat');
  if ((i.otherRooms ?? 0) >= BOT_VOICE_MAX_ROOMS) return new BotApiError(400, 'Bad Request: too many active voice chats');
  return null;
}

/** Суффикс спутника нативного показа экрана (`<id>#screen`) — в составе голоса не участник. */
const SCREEN_SUFFIX = '#screen';

/**
 * Разница двух срезов состава голосового канала (id участников; ТЗ §1.5): кто зашёл, кто вышел. `prev` `null` — среза не было
 * (первое событие канала): все из `next` — зашли. Спутники `#screen` и повторы не участвуют; порядок — как в срезе.
 */
export function voiceStateDiff(prev: readonly string[] | null | undefined, next: readonly string[]): { joined: string[]; left: string[] } {
  const clean = (ids: readonly string[]) => [...new Set(ids.filter((id) => typeof id === 'string' && id && !id.endsWith(SCREEN_SUFFIX)))];
  const before = clean(prev ?? []);
  const after = clean(next);
  const was = new Set(before);
  const now = new Set(after);
  return { joined: after.filter((id) => !was.has(id)), left: before.filter((id) => !now.has(id)) };
}

/**
 * Бот сидит в канале один (ТЗ §9.2, решение владельца 27.10): людей нет — с какого момента. `aloneSince` — сохранённая отметка
 * (unix с) или `null`. Возвращает новую отметку: люди есть или ботов нет → `null`; одиночество началось сейчас → `nowS`.
 */
export function botAloneSince(members: readonly { bot?: boolean }[], aloneSince: number | null, nowS: number): number | null {
  const bots = members.filter((m) => m.bot === true).length;
  if (bots === 0 || bots < members.length) return null;
  return aloneSince ?? nowS;
}

/** Пора выкидывать одиноких ботов канала: одни дольше `aloneS` секунд. */
export function botAloneExpired(aloneSince: number | null, nowS: number, aloneS: number): boolean {
  return aloneSince !== null && nowS - aloneSince >= aloneS;
}
