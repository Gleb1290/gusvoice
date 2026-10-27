/**
 * События сообщений КАНАЛОВ (#231) — единственный вход рассылки `message.create|update|delete|reaction`.
 *
 * Людям — ровно как раньше `publishToChannel` (аудитория с `VIEW_CHANNEL` на момент события), но вид события назван явно:
 * одно и то же `message.update` значит то правку, то закреп, то смену кнопок, а у `message.delete` нет автора удалённого —
 * крючку ботов этого мало. Аудитория считается ОДИН раз — людям и ботам.
 *
 * Боты — крючок `configureChannelBots` (по образцу `configureBotConv` в `conversations.ts`): модуль ботов отсюда не
 * импортируется. Крючок идёт в фоне, по очереди на канал внутри процесса (правка не обгоняет своё создание в журнале
 * бота); сбой крючка — только в лог, маршрут человека от журнала бота не зависит.
 *
 * 🔴 Вне этого файла `publishToChannel` с `t: 'message.create'|'message.update'|'message.delete'|'message.reaction'` не
 * вызывается — иначе новый вход молча обойдёт ботов (страж Codex, ТЗ этапа 3 §7 п.5).
 */
import type { Message } from '@gusvoice/shared';
import { getChannelAudience } from './permissions.js';
import { publishToChannel } from './realtime.js';

type ChannelScopedMessage = Parameters<typeof publishToChannel>[2];

export type ChannelMessageEvent =
  /** Новое сообщение: человек, вебхук, бот. */
  | { kind: 'created'; message: Message }
  /** Правка текста (ставит «изм.»). */
  | { kind: 'edited'; message: Message }
  /** Закреп/снятие — людям `message.update`, ботам ничего. */
  | { kind: 'pinned'; message: Message }
  /** Бот сменил одни кнопки (без «изм.») — людям `message.update`, ботам ничего. */
  | { kind: 'markup'; message: Message }
  /** Удалено; автор берётся ДО удаления. */
  | { kind: 'deleted'; messageId: string; authorId: string }
  /** Реакция одного человека: поставил или снял одно эмодзи. */
  | { kind: 'reaction'; messageId: string; authorId: string; userId: string; emoji: string; op: 'add' | 'remove' };

export interface ChannelBotsHooks {
  record(serverId: string, channelId: string, ev: ChannelMessageEvent, audience: readonly string[], actor?: string): Promise<void>;
}

let hooks: ChannelBotsHooks | null = null;

/** Подключает Bot API (`routes/botApi.ts`); без него события идут только людям. */
export function configureChannelBots(next: ChannelBotsHooks | null): void {
  hooks = next;
}

/** Хвост очереди крючка на канал (внутри процесса): правка не обгоняет создание. */
const queues = new Map<string, Promise<void>>();

function enqueue(channelId: string, run: () => Promise<void>): void {
  const prev = queues.get(channelId) ?? Promise.resolve();
  const next = prev
    .then(run)
    .catch((err) => console.warn('[bots] канал:', err instanceof Error ? err.message : err))
    .finally(() => {
      if (queues.get(channelId) === next) queues.delete(channelId);
    });
  queues.set(channelId, next);
}

/** Событие людям в форме шлюза — как было в маршрутах до выноса. */
export function gatewayMessageOf(serverId: string, channelId: string, ev: ChannelMessageEvent): ChannelScopedMessage {
  switch (ev.kind) {
    case 'created':
      return { t: 'message.create', channelId, serverId, message: ev.message };
    case 'edited':
    case 'pinned':
    case 'markup':
      return { t: 'message.update', channelId, message: ev.message };
    case 'deleted':
      return { t: 'message.delete', channelId, messageId: ev.messageId };
    case 'reaction':
      return { t: 'message.reaction', channelId, messageId: ev.messageId, emoji: ev.emoji, userId: ev.userId, op: ev.op };
  }
}

/**
 * Разослать событие сообщения канала людям (дожидаясь публикации — как прежний `publishToChannel` в маршруте) и поставить
 * крючок ботов в очередь. `actor` — кто сделал (свои действия боту не пишутся).
 */
export async function publishChannelMessageEvent(serverId: string, channelId: string, ev: ChannelMessageEvent, actor?: string): Promise<void> {
  const res = await getChannelAudience(channelId);
  // ⚠️ Канал не из этого сервера — не рассылаем вовсе (как `publishToChannel` без аудитории).
  if (!res || res.serverId !== serverId) return;
  await publishToChannel(serverId, channelId, gatewayMessageOf(serverId, channelId, ev), res.userIds);
  const h = hooks;
  if (h && ev.kind !== 'pinned' && ev.kind !== 'markup') enqueue(channelId, () => h.record(serverId, channelId, ev, res.userIds, actor));
}
