import type { GatewayServerMessage } from '@gusvoice/shared';
import { reachesPeer } from './blockRules.js';
import { typingRoute } from './gatewayRules.js';

/**
 * Пересылка «печатает…» — обработчик кадра `typing` шлюза, вынесенный из `gateway.ts` (просьба Codex 28.09).
 *
 * Всё, что трогает сеть, Redis и базу, приходит зависимостями: без них ветку нельзя было исполнить в тесте,
 * и двойное отрицание блокировки (#212) ловил только файловый страж. Модуль импортирует лишь чистые
 * правила, поэтому поднимается без `env`, базы и Redis.
 *
 * ⚠️ Граница авторизации та же, что у сообщений (#88): ЛС — только участнику беседы и не тому, кто
 * заблокировал отправителя; канал — только если отправитель сам входит в аудиторию канала.
 */

type TypingMessage = Extract<GatewayServerMessage, { t: 'typing' }>;

export interface TypingDeps<S> {
  /** Окно лимита; не ноль — лимит исчерпан (`authGuard.rateHit`). */
  rateHit(key: string, max: number, windowS: number): Promise<number>;
  /** Собеседник по беседе ЛС или `null`, если отправитель в ней не участвует. */
  dmPeerOf(dmId: string, senderId: string): Promise<string | null>;
  /** Заблокировал ли `blockerId` пользователя `blockedId` (`blocks.isBlockedBy`). */
  isBlockedBy(blockerId: string, blockedId: string): Promise<boolean>;
  /** Открытые соединения пользователя на этом экземпляре шлюза. */
  connsOf(userId: string): Iterable<{ socket: S }>;
  send(socket: S, msg: TypingMessage): void;
  getChannelAudience(channelId: string): Promise<{ serverId: string; userIds: string[] } | null>;
  publishToChannel(serverId: string, channelId: string, msg: TypingMessage, audience: string[]): Promise<unknown>;
}

export async function relayTyping<S>(
  deps: TypingDeps<S>,
  conn: { userId: string; servers: Set<string> },
  msg: { serverId?: string; channelId?: string; dmId?: string },
): Promise<void> {
  const uid = conn.userId;
  if (await deps.rateHit(`typing:${uid}`, 20, 10)) return; // честный клиент шлёт ≤1 / 2.5с
  const peerId = msg.dmId ? await deps.dmPeerOf(msg.dmId, uid) : null;
  const route = typingRoute(msg, conn, () => peerId);
  if (!route) return;
  if (route.kind === 'dm') {
    // Заблокированному «печатает» не доходит до того, кто его заблокировал (#212, `blockRules`).
    if (!reachesPeer(await deps.isBlockedBy(route.peerId, uid))) return;
    for (const c of deps.connsOf(route.peerId)) deps.send(c.socket, { t: 'typing', dmId: route.dmId, userId: uid });
    return;
  }
  // Канал: аудитория считается по факту, и отправитель обязан в неё входить — иначе можно
  // было бы «печатать» в канал, который сам не видишь.
  const audience = await deps.getChannelAudience(route.channelId);
  if (!audience || audience.serverId !== route.serverId || !audience.userIds.includes(uid)) return;
  await deps.publishToChannel(
    route.serverId,
    route.channelId,
    { t: 'typing', channelId: route.channelId, userId: uid },
    audience.userIds.filter((id) => id !== uid), // себе «печатает…» не показываем
  );
}
