/**
 * События сообщений КАНАЛОВ (#231) — единственный вход рассылки `message.create|update|delete|reaction`.
 *
 * Людям — ровно как раньше `publishToChannel` (аудитория с `VIEW_CHANNEL` на момент события), но вид события назван явно:
 * одно и то же `message.update` значит то правку, то закреп, то смену кнопок, а у `message.delete` нет автора удалённого —
 * крючку ботов этого мало. Аудитория считается ОДИН раз — людям и ботам.
 *
 * Боты — крючок `configureChannelBots` (по образцу `configureBotConv` в `conversations.ts`): модуль ботов отсюда не
 * импортируется. В процессе крючок записывает события в порядке вызовов для каждого канала. Фоновая очередь
 * ограничена на весь процесс. При заполнении издатель дожидается допуска, а публикация людям идёт своим ходом.
 * Сбой крючка логируется, последующие события продолжают обрабатываться.
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

/** Событие людям в форме шлюза — как было в маршрутах до выноса. */
export function gatewayMessageOf(
  serverId: string,
  channelId: string,
  ev: ChannelMessageEvent,
  forceMuted?: boolean,
): ChannelScopedMessage {
  switch (ev.kind) {
    case 'created':
      return {
        t: 'message.create',
        channelId,
        serverId,
        message: ev.message,
        ...(forceMuted === undefined ? {} : { forceMuted }),
      };
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

const CHANNEL_BOT_QUEUE_LIMIT = 128;

export function createChannelMessagePublisher(limit = CHANNEL_BOT_QUEUE_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Channel bot queue limit must be a positive integer');

  let hooks: ChannelBotsHooks | null = null;
  const queues = new Map<string, Promise<void>>();
  let pending = 0;
  const waitingPublishers = new Set<() => void>();

  /** Подключает Bot API; без крючка события идут только людям. */
  function configureChannelBots(next: ChannelBotsHooks | null): void {
    hooks = next;
  }

  function enqueue(channelId: string, run: () => Promise<void>): void {
    pending++;
    const prev = queues.get(channelId) ?? Promise.resolve();
    const next = prev
      .then(run)
      .catch((err) => console.warn('[bots] канал:', err instanceof Error ? err.message : err))
      .finally(() => {
        pending--;
        if (queues.get(channelId) === next) queues.delete(channelId);
        const first = waitingPublishers.values().next();
        if (!first.done) {
          waitingPublishers.delete(first.value);
          first.value();
        }
      });
    queues.set(channelId, next);
  }

  /**
   * Публикует людям и ждёт допуска в очередь ботов. Место занято до окончания крючка,
   * включая ожидание аудитории и предыдущих событий этого канала.
   */
  async function publishChannelMessageEvent(serverId: string, channelId: string, ev: ChannelMessageEvent, actor?: string): Promise<void> {
    const h = hooks;
    const published = (async () => {
      const res = await getChannelAudience(channelId);
      if (!res || res.serverId !== serverId) return null;
      await publishToChannel(serverId, channelId, gatewayMessageOf(serverId, channelId, ev, res.forceMuted), res.userIds);
      return res.userIds;
    })();
    if (h && ev.kind !== 'pinned' && ev.kind !== 'markup') {
      const audience = published.catch(() => null);
      const record = async () => {
        const ids = await audience;
        if (ids) await h.record(serverId, channelId, ev, ids, actor);
      };
      if (pending < limit) {
        enqueue(channelId, record);
      } else {
        // Издатель ждёт места. Завершившийся крючок допускает ровно одного издателя в порядке вызовов.
        await new Promise<void>((resolve) => waitingPublishers.add(() => {
          enqueue(channelId, record);
          resolve();
        }));
      }
    }
    await published;
  }

  return { configureChannelBots, publishChannelMessageEvent };
}

export const { configureChannelBots, publishChannelMessageEvent } = createChannelMessagePublisher();
