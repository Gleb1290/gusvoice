import { useMemo } from 'react';
import type { ServerEmoji } from '@gusvoice/shared';
import type { EmojiResolver } from './messageText';
import { useStore } from './store';

/**
 * Кастомные эмодзи ТЕКУЩЕГО сервера (#18).
 *
 * Берутся из bootstrap, который уже лежит в сторе, — отдельного запроса нет: `:имя:` в первом же
 * сообщении нечем заменить, пока список не приехал, и текст мигнул бы сырым кодом.
 *
 * ⚠️ Область действия — ровно текущий сервер. В ЛС резолвер НЕ передаётся (см. `DmChatView`):
 * эмодзи принадлежат серверу, и показывать их в личке — то же самое, что показывать там серверный
 * ник. Ровно этот разбор был в #73, повторяю решение осознанно.
 */
const EMPTY: ServerEmoji[] = [];

export function useServerEmojis(): ServerEmoji[] {
  return useStore((s) => s.bootstrap?.emojis ?? EMPTY);
}

/** Резолвер для `renderMessageText`: имя → URL картинки, либо null. */
export function useEmojiResolver(): EmojiResolver {
  const emojis = useServerEmojis();
  return useMemo(() => {
    const byName = new Map(emojis.map((e) => [e.name, e.url]));
    return (name: string) => byName.get(name) ?? null;
  }, [emojis]);
}

/** Поиск эмодзи по id — для отрисовки реакций, которые ключуются `custom:<id>`. */
export function useEmojiById(): (id: string) => ServerEmoji | null {
  const emojis = useServerEmojis();
  return useMemo(() => {
    const byId = new Map(emojis.map((e) => [e.id, e]));
    return (id: string) => byId.get(id) ?? null;
  }, [emojis]);
}
