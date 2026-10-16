import type { Message, Server, ServerLastMessage } from '@gusvoice/shared';
import { attachmentPreviewOf, oneLine } from './dmRowRules';

/**
 * Строка сервера в списке серверов на телефоне (#218, `PhoneServerList` / `RailGroups rows`) — чистые правила.
 *
 * С 12.10 `GET /servers` отдаёт на каждый сервер счётчики непрочитанного и обращений (`Server.unread` / `mentions`) и
 * последнее сообщение (`Server.lastMessage`): вторая строка — как у группы в Telegram (`DialogCell`: «Автор: текст»,
 * время справа). Старый бэкенд (или сосед) полей не шлёт — тогда, как раньше, вторая строка — счётчики словами
 * (`serverRowLine`) из живых карт `unreadServers` / `mentionServers` (у чужих инстансов — от фонового шлюза); засев карт
 * из ответа — `channelRules.seedServerCounts`.
 * Счётчик справа — число обращений, иначе число непрочитанных.
 */
export interface ServerRowCounts {
  closed: boolean;
  unread: number;
  mentions: number;
}

/** Пустая строка — сказать нечего: название встаёт по центру строки, а не над пустым местом (`.srv-solo`). */
export function serverRowLine(s: ServerRowCounts): string {
  if (s.closed) return 'Закрыт держателем';
  const parts: string[] = [];
  if (s.mentions > 0) parts.push(`Упоминаний: ${s.mentions}`);
  // Обращение входит и в число непрочитанного (одно сообщение с упоминанием = 1 и 1), поэтому «просто новых» — разность.
  const plain = s.unread - s.mentions;
  if (plain > 0) parts.push(`Новых сообщений: ${plain}`);
  return parts.join(' · ');
}

/**
 * Последнее сообщение сервера из сообщения ленты (событие шлюза `message.create` / `message.update`) — то же правило, что
 * у бэкенда (`unread.serverListExtras`): текст в одну строку до 200 символов, у стикера без текста — его эмодзи и вид
 * `sticker`, вид вложений — `attachmentPreviewOf`. `channelName` — если клиент его знает (каналы открытого сервера).
 */
export function serverLastFromMessage(m: Message, channelId: string, channelName?: string): ServerLastMessage {
  const list: readonly unknown[] = Array.isArray(m.attachments) ? m.attachments : [];
  const kind = attachmentPreviewOf(list);
  const emoji = m.sticker && typeof m.sticker.emoji === 'string' ? m.sticker.emoji : '';
  const sticker = !list.length && m.sticker ? ({ attachmentKind: 'sticker' } as const) : {};
  return {
    id: m.id,
    channelId,
    ...(channelName ? { channelName } : {}),
    authorId: m.author.id,
    authorName: m.author.displayName || m.author.username,
    text: oneLine(m.content || emoji),
    attachments: list.length,
    ...(kind ?? {}),
    ...sticker,
    createdAt: m.createdAt,
  };
}

/**
 * Новое сообщение в канале сервера → `servers[].lastMessage`. Сервер без поля (старый бэкенд) не трогается — у него
 * строка остаётся на счётчиках; более старое сообщение (по `createdAt`) прежнее не вытесняет. Изменений нет — тот же массив.
 */
export function applyServerMessageCreate<S extends Pick<Server, 'id' | 'lastMessage'>>(
  servers: S[],
  serverId: string | undefined,
  last: ServerLastMessage,
): S[] {
  if (!serverId) return servers;
  const i = servers.findIndex((s) => s.id === serverId);
  if (i < 0) return servers;
  const s = servers[i];
  if (s.lastMessage === undefined) return servers;
  if (s.lastMessage && Date.parse(s.lastMessage.createdAt) > Date.parse(last.createdAt)) return servers;
  const next = servers.slice();
  next[i] = { ...s, lastMessage: last };
  return next;
}

/**
 * Правка сообщения: если это последнее сообщение какого-то сервера — заменить текст и вид вложений, оставив канал и
 * его название. Не последнее — тот же массив.
 */
export function applyServerMessageUpdate<S extends Pick<Server, 'id' | 'lastMessage'>>(
  servers: S[],
  edited: ServerLastMessage,
): S[] {
  const i = servers.findIndex((s) => s.lastMessage?.id === edited.id);
  if (i < 0) return servers;
  const prev = servers[i].lastMessage!;
  const next = servers.slice();
  next[i] = {
    ...servers[i],
    lastMessage: { ...edited, channelId: prev.channelId, channelName: edited.channelName ?? prev.channelName, createdAt: prev.createdAt },
  };
  return next;
}

/** Удалено последнее сообщение какого-то сервера — нужен свежий список (`loadServers`): предыдущее клиент не знает. */
export function isServerLastMessage(servers: readonly Pick<Server, 'lastMessage'>[], messageId: string): boolean {
  return servers.some((s) => s.lastMessage?.id === messageId);
}
