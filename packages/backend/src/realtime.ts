import type { GatewayServerMessage } from '@gusvoice/shared';
import Redis from 'ioredis';
import { env } from './env.js';
import { getChannelAudience } from './permissions.js';

// Publisher for cross-process gateway fan-out (also makes multi-instance trivial).
export const redisPub = new Redis(env.redisUrl);

export function serverChannel(serverId: string): string {
  return `gw:server:${serverId}`;
}

export function userChannel(userId: string): string {
  return `gw:user:${userId}`;
}

/** Redis set of user ids server-muted in a voice channel (read by the presence service). */
export function voiceServerMuteKey(channelId: string): string {
  return `vmute:${channelId}`;
}

/**
 * Последний кадр показа этого человека в этом канале (#115). Живёт с TTL и сам протухает, когда
 * показ кончился, — отдельного «показ завершён» ловить не нужно.
 *
 * ⚠️ Ключ включает канал: один и тот же человек в разных каналах — разные показы, и подсовывать
 * зрителю кадр из другого канала нельзя.
 */
export function streamPreviewKey(channelId: string, userId: string): string {
  return `spv:${channelId}:${userId}`;
}

/**
 * Внутренний конверт шины. Наружу клиенту уезжает только `m`; `to` — маршрутизация, и её нельзя
 * отдавать (это список тех, кто видит канал, то есть само по себе сведения о правах).
 *
 * ⚠️ Тип события НЕ определяет маршрут: `channelId` есть и у адресных `poll.counts`/`voice.move`, а у
 * `dm.*` это вообще id личного диалога. Поэтому область задаётся ЯВНО тем, кто публикует, а не
 * угадывается по форме payload.
 */
export interface ServerEnvelope {
  m: GatewayServerMessage;
  /** `undefined` — всем подписчикам сервера; иначе только перечисленным пользователям. */
  to?: string[];
}

/** События, которые ПО СМЫСЛУ видны всем участникам сервера — без привязки к каналу. */
type ServerWideMessage = Extract<
  GatewayServerMessage,
  { t: 'server.invalidate' } | { t: 'member.update' } | { t: 'online.update' } | { t: 'online.list' }
>;

/** События КАНАЛА: их получает только тот, кто имеет право этот канал видеть. */
type ChannelScopedMessage = Extract<
  GatewayServerMessage,
  | { t: 'message.create' }
  | { t: 'message.update' }
  | { t: 'message.delete' }
  | { t: 'message.reaction' }
  | { t: 'channel.create' }
  | { t: 'channel.update' }
  | { t: 'channel.delete' }
  | { t: 'poll.update' }
  | { t: 'mega-poke' }
  | { t: 'soundboard' }
  | { t: 'typing' }
  | { t: 'tip' }
>;

/**
 * Разослать событие, которое видно ВСЕМ участникам сервера.
 *
 * ⚠️ Тип параметра сужен намеренно: событие канала сюда не подставится, и «забыть фильтр» больше
 * нельзя — можно только не вызвать публикацию вовсе (это ловится глазами при ревью роута, а
 * пропущенный фильтр не ловился ничем). Так уже обжигались: кик и бан вообще ничего не публиковали.
 */
export async function publishToServer(serverId: string, msg: ServerWideMessage): Promise<void> {
  await redisPub.publish(serverChannel(serverId), JSON.stringify({ m: msg } satisfies ServerEnvelope));
}

/**
 * Разослать событие КАНАЛА — аудитория считается здесь же, из базы, на момент публикации (#91).
 *
 * `audience` можно передать заранее посчитанным: для `channel.delete` иначе никак — после удаления
 * строки считать уже не по чему.
 */
export async function publishToChannel(
  serverId: string,
  channelId: string,
  msg: ChannelScopedMessage,
  audience?: string[],
): Promise<void> {
  let to = audience;
  if (!to) {
    const res = await getChannelAudience(channelId);
    // ⚠️ Канал не из этого сервера — не рассылаем вовсе, а не «на всякий случай всем».
    if (!res || res.serverId !== serverId) return;
    to = res.userIds;
  }
  if (to.length === 0) return; // видеть некому — рассылать нечего
  await redisPub.publish(serverChannel(serverId), JSON.stringify({ m: msg, to } satisfies ServerEnvelope));
}

/** Fan a message out to all of one user's own gateway connections (used for DMs). */
export async function publishToUser(userId: string, msg: GatewayServerMessage): Promise<void> {
  await redisPub.publish(userChannel(userId), JSON.stringify({ m: msg } satisfies ServerEnvelope));
}
