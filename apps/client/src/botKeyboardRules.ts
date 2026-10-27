/**
 * Боты, этап 2 (#230): кнопки под сообщением бота и команды по «/» — чистые правила клиента (без React, стора и сети).
 *
 * Как у Telegram: нажатие кнопки шлёт боту `callback_query`, пока бот не ответил — на кнопке часики (tdesktop
 * `history/history_item_components.cpp:1270` — `requestId` у кнопки), ответ — всплывашка или окно (`api/api_bot.cpp:54-190`).
 * Команды бота — список по «/» в начале поля (tdesktop `chat_helpers/field_autocomplete.cpp:405-418`), `/команда` в тексте
 * бота нажимается и уходит сообщением.
 */
import {
  CALLBACK_QUERY_WAIT_S,
  type BotCallbackResult,
  type BotCommandInfo,
  type ChannelBotsInfo,
  type InlineKeyboard,
  type InlineKeyboardButton,
} from '@gusvoice/shared';

/**
 * Сколько клиент сам ждёт ответа на нажатие: окно сервера (`CALLBACK_QUERY_WAIT_S`) + 2 с на сеть. Дольше — запрос
 * обрывается, часики гаснут молча (сервер к этому времени уже ответил бы `timeout`).
 */
export const BOT_CALLBACK_CLIENT_WAIT_MS = (CALLBACK_QUERY_WAIT_S + 2) * 1000;

/** Сколько живёт список команд беседы в памяти; старше — тихо перезапрашивается при вводе «/» (SPEC §2.4). */
export const BOT_COMMANDS_TTL_MS = 60_000;

/** Текст всплывашки, когда кнопка устарела (бот уже поменял клавиатуру, сервер ответил 409 `stale_button`). */
export const STALE_BUTTON_TEXT = 'Кнопка устарела';

/** Ключ «эта кнопка ждёт ответа»: сообщение + данные кнопки, а не номер — клавиатура может смениться под пальцем. */
export function kbPressKey(messageId: string, data: string): string {
  return `${messageId}\u0001${data}`;
}

/**
 * Клавиатура, которую можно рисовать: у кнопки есть подпись и ровно одно из `callback_data` / `url` (`url` — только
 * http(s)); пустые ряды выпадают. Сервер это уже проверил, здесь — страховка от кривого или будущего поля.
 */
export function drawableKeyboard(kb: InlineKeyboard | null | undefined): InlineKeyboardButton[][] {
  if (!Array.isArray(kb)) return [];
  const rows: InlineKeyboardButton[][] = [];
  for (const row of kb) {
    if (!Array.isArray(row)) continue;
    const ok = row.filter(
      (b) =>
        !!b &&
        typeof b.text === 'string' &&
        b.text.trim() !== '' &&
        (typeof b.callback_data === 'string') !== (typeof b.url === 'string') &&
        (typeof b.url !== 'string' || /^https?:\/\//i.test(b.url)),
    );
    if (ok.length) rows.push(ok);
  }
  return rows;
}

/** Что делать по нажатию url-кнопки: своя ссылка — открыть сразу; чужая — через «Открыть ссылку?» (подпись может врать про адрес). */
export function kbUrlAction(own: boolean): 'open' | 'confirm' {
  return own ? 'open' : 'confirm';
}

/** Что показать по ответу бота на нажатие: окно (`alert`), всплывашку (`text`) или ничего (молча, `timeout`, пустой текст). */
export type CallbackOutcome = { kind: 'alert'; text: string } | { kind: 'toast'; text: string } | { kind: 'none' };
export function callbackOutcome(res: BotCallbackResult | null | undefined): CallbackOutcome {
  if (!res || res.timeout) return { kind: 'none' };
  const text = typeof res.text === 'string' ? res.text.trim() : '';
  if (!text) return { kind: 'none' };
  return res.alert ? { kind: 'alert', text } : { kind: 'toast', text };
}

/**
 * Ошибка нажатия: 409 `stale_button` — «Кнопка устарела»; обрыв по своему таймеру (`timeout`) — молча, как Telegram, когда бот
 * молчит; остальное — обычный тост ошибки.
 */
export function callbackErrorOutcome(err: unknown): 'stale' | 'silent' | 'error' {
  const e = err as { status?: number; message?: string; timeout?: boolean } | null;
  if (e?.timeout) return 'silent';
  if (e?.status === 409) return 'stale';
  return 'error';
}

/** Команды под набранный префикс: по началу имени, без регистра, порядок бота, все (у бота их до 100 — список прокручивается). */
export function filterBotCommands(commands: readonly BotCommandInfo[], query: string): BotCommandInfo[] {
  const q = query.toLowerCase();
  return commands.filter((c) => c.command.toLowerCase().startsWith(q));
}

/**
 * Поле — одна только набранная команда (`/st`, `/status`), без аргументов: выбор из списка её сразу отправляет (как Telegram).
 * Есть что-то после — выбор только подставляет имя, остальное остаётся.
 */
export function onlyCommandInField(value: string, withBot = false): boolean {
  return (withBot ? /^\/[A-Za-z0-9_]*(?:@[A-Za-z0-9_]*)?\s*$/ : /^\/[A-Za-z0-9_]*\s*$/).test(value);
}

// ─── Команды ботов КАНАЛА (#231, ТЗ этапа 3 §4.3; tdesktop `field_autocomplete.cpp:674-760`, `:1496`) ─────────────────
type ChannelBot = ChannelBotsInfo['bots'][number];
/** Строка подсказки «/» в канале: команда и бот, которому она принадлежит (аватар и `@ник` в строке, как у tdesktop). */
export interface ChannelCommandItem extends BotCommandInfo {
  bot: Pick<ChannelBot, 'id' | 'username' | 'displayName' | 'avatarUrl'>;
}
/** Плоский список команд всех ботов канала — по ботам в порядке сервера, внутри бота — в его порядке; кривые строки выпадают. */
export function channelCommandList(bots: readonly ChannelBot[] | null | undefined): ChannelCommandItem[] {
  const out: ChannelCommandItem[] = [];
  for (const b of bots ?? []) {
    if (!b || typeof b.username !== 'string' || !Array.isArray(b.commands)) continue;
    const bot = { id: b.id, username: b.username, displayName: b.displayName, avatarUrl: b.avatarUrl };
    for (const c of b.commands) if (c && typeof c.command === 'string' && c.command !== '') out.push({ ...c, bot });
  }
  return out;
}
/** Фильтр строки после «/»: `st` — по началу команды; `st@we` — ещё и по началу ника бота (без регистра). */
export function filterChannelCommands(list: readonly ChannelCommandItem[], query: string): ChannelCommandItem[] {
  const at = query.indexOf('@');
  const cmd = (at < 0 ? query : query.slice(0, at)).toLowerCase();
  const nick = at < 0 ? null : query.slice(at + 1).toLowerCase();
  return list.filter(
    (c) => c.command.toLowerCase().startsWith(cmd) && (nick === null || c.bot.username.toLowerCase().startsWith(nick)),
  );
}
/**
 * Что вставить по выбору команды в канале: `/cmd`, если такая команда ровно у ОДНОГО бота канала, иначе `/cmd@ник`
 * (решение §9.4: без ника команду получат все боты канала; tdesktop в группе с ботами ставит ник всегда — `:1496`).
 */
export function channelCommandInsert(item: ChannelCommandItem, list: readonly ChannelCommandItem[]): string {
  const name = item.command.toLowerCase();
  const owners = new Set(list.filter((c) => c.command.toLowerCase() === name).map((c) => c.bot.id));
  return owners.size > 1 ? `/${item.command}@${item.bot.username}` : `/${item.command}`;
}
/**
 * `/команда`, нажатая в тексте сообщения бота в канале: уходит ЭТОМУ боту — с `@ником`, если ту же команду знает другой бот
 * канала (иначе её получили бы оба). Уже с ником или автор неизвестен — как есть.
 */
export function botCommandFromMessage(cmd: string, botUsername: string | undefined, list: readonly ChannelCommandItem[]): string {
  if (!botUsername || cmd.includes('@')) return cmd;
  const name = cmd.replace(/^\//, '').toLowerCase();
  const me = botUsername.toLowerCase();
  return list.some((c) => c.command.toLowerCase() === name && c.bot.username.toLowerCase() !== me) ? `${cmd}@${botUsername}` : cmd;
}

/**
 * `/команда` в тексте бота (Telegram — сущность `bot_command`): в начале строки или после пробела/скобки, до конца слова.
 * `http://x/y`, `и/или`, `/etc/hosts` — не команды (слеш внутри слова или путь дальше).
 */
const CMD_IN_TEXT = /(^|[\s(])(\/[A-Za-z0-9_]{1,32})(?=$|[\s.,!?:;)\]])/g;
export function splitBotCommands(text: string): Array<string | { cmd: string }> {
  const out: Array<string | { cmd: string }> = [];
  let at = 0;
  CMD_IN_TEXT.lastIndex = 0;
  for (let m = CMD_IN_TEXT.exec(text); m; m = CMD_IN_TEXT.exec(text)) {
    const start = m.index + m[1].length;
    if (start > at) out.push(text.slice(at, start));
    out.push({ cmd: m[2] });
    at = start + m[2].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
