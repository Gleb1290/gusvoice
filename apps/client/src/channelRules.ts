import type { ServerBootstrap } from '@gusvoice/shared';

/**
 * Правила непрочитанного и загрузки истории — вынуты из `store.ts` (просьба Codex, #80).
 *
 * Модуль чистый: ни zustand, ни браузера. Именно это и было дырой — обе функции считали важное,
 * но жили внутри стора, и проверить их можно было только запустив приложение. Баг #80 (сообщения с
 * чужого сервера пропадали втихую) тесты не поймали ровно поэтому: покрыто было «при каких признаках
 * уведомляем», а не «при каких условиях счётчик вообще меняется».
 */

/** Часть состояния, с которой работают правила: четыре карты счётчиков. */
export interface UnreadState {
  unreadCounts: Record<string, number>;
  mentionCounts: Record<string, number>;
  unreadServers: Record<string, number>;
  mentionServers: Record<string, number>;
}

export interface IncomingMessage {
  channelId: string;
  /** Сервер сообщения. `undefined` — событие от старого бэкенда, до `serverId` в `message.create`. */
  serverId?: string;
  mentioned: boolean;
  /** Сервер, открытый в окне СЕЙЧАС. */
  currentServerId: string | null;
}

/**
 * Учесть входящее сообщение в счётчиках.
 *
 * ⚠️ Значок на иконке сервера ставится ТОЛЬКО для чужого (не открытого) сервера: у открытого всё
 * видно по каналам, и значок дублировал бы то, что уже на глазах. Старое событие без `serverId`
 * канальный счётчик menять обязано — иначе рассинхрон версий клиента и сервера тихо ломает
 * непрочитанное вместо того, чтобы просто не показать серверный значок.
 */
export function applyUnread(s: UnreadState, m: IncomingMessage): UnreadState {
  const other = m.serverId && m.serverId !== m.currentServerId ? m.serverId : null;
  return {
    unreadCounts: { ...s.unreadCounts, [m.channelId]: (s.unreadCounts[m.channelId] ?? 0) + 1 },
    mentionCounts: m.mentioned
      ? { ...s.mentionCounts, [m.channelId]: (s.mentionCounts[m.channelId] ?? 0) + 1 }
      : s.mentionCounts,
    unreadServers: other ? { ...s.unreadServers, [other]: (s.unreadServers[other] ?? 0) + 1 } : s.unreadServers,
    mentionServers:
      other && m.mentioned
        ? { ...s.mentionServers, [other]: (s.mentionServers[other] ?? 0) + 1 }
        : s.mentionServers,
  };
}

/**
 * Влить сохранённое на сервере состояние прочитанного (`bootstrap.reads`, миграция 0018) в карты
 * счётчиков: записи каналов ЭТОГО сервера заменяются серверной истиной, живые записи ДРУГИХ серверов
 * сохраняются. `keepReadChannelId` (открытый канал) никогда не помечается непрочитанным заново.
 *
 * ⚠️ Сервер присылает ЧИСЛО (`reads[id].unread`) — клиент когда-то схлопывал его в булев список, и в
 * сайдбар доезжала точка вместо счётчика (#78).
 */
export function seedReads(
  s: Pick<UnreadState, 'unreadCounts' | 'mentionCounts'>,
  bootstrap: ServerBootstrap,
  keepReadChannelId: string | null,
): Pick<UnreadState, 'unreadCounts' | 'mentionCounts'> {
  const ids = new Set(bootstrap.channels.map((c) => c.id));
  const reads = bootstrap.reads ?? {};
  const unreadCounts: Record<string, number> = {};
  for (const [id, n] of Object.entries(s.unreadCounts)) if (!ids.has(id)) unreadCounts[id] = n;
  for (const [id, r] of Object.entries(reads)) {
    if (id !== keepReadChannelId && r.unread > 0) unreadCounts[id] = r.unread;
  }
  const mentionCounts: Record<string, number> = {};
  for (const [id, n] of Object.entries(s.mentionCounts)) if (!ids.has(id)) mentionCounts[id] = n;
  for (const [id, r] of Object.entries(reads)) if (id !== keepReadChannelId && r.mentions > 0) mentionCounts[id] = r.mentions;
  return { unreadCounts, mentionCounts };
}

/** Что делать с историей канала при его открытии. */
export interface HistoryPlan {
  /** Идти ли в сеть за историей. */
  refetch: boolean;
  /** Ждать ли ответ перед показом канала (иначе показываем кеш, а ответ его заменит). */
  blocking: boolean;
}

/**
 * 🔴 История перезапрашивается КАЖДЫЙ раз, а не только при пустом кеше (#80). Раньше кеш считался
 * истиной на всю сессию: потерянное `message.create` (сон, обрыв, подписка на другой сервер)
 * оставляло в ленте дыру, которую не лечило даже открытие канала — только перезапуск приложения.
 *
 * Ждём сеть ТОЛЬКО когда показывать нечего: иначе на медленной связи открытие уже прочитанного
 * канала начинало упираться в задержку сети на ровном месте.
 */
export function historyLoadPlan(input: { channelType?: 'text' | 'voice'; hasCache: boolean }): HistoryPlan {
  if (input.channelType !== 'text') return { refetch: false, blocking: false };
  return { refetch: true, blocking: !input.hasCache };
}
