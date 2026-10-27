/**
 * Правила переподключения и переноса. Чистый модуль — без `@livekit/rtc-node` (причина отключения приходит именем).
 *
 * Разбор `Disconnected` у LiveKit:
 *  - `CLIENT_INITIATED` — мы сами вышли: ничего не делать;
 *  - `PARTICIPANT_REMOVED`, `ROOM_DELETED`, `DUPLICATE_IDENTITY` — бота убрали (модератор, снятие с сервера, бот один 5 минут,
 *    выключение ботов, другой экземпляр с тем же токеном): ШТАТНО, не переподключаемся, очередь сохраняется;
 *  - остальное (обрыв сети, перезапуск SFU) — повторный `joinVoice` с паузами 1-2-4-8-16-30 с, не более 6 попыток.
 */
import type { VoiceStateUpdated } from '@gusvoice/bot';

export type DisconnectAction = 'ignore' | 'kicked' | 'retry';

/** Паузы перед попытками входа, мс. */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 16_000, 30_000];
export const MAX_RETRIES = RETRY_DELAYS_MS.length;
/** Сколько ждать `voice_state` с `move_to`, если нас убрали из комнаты (перенос и отключение приходят разными путями). */
export const MOVE_WAIT_MS = 3000;

const KICKED_REASONS = new Set(['PARTICIPANT_REMOVED', 'ROOM_DELETED', 'DUPLICATE_IDENTITY']);

/** Что делать с причиной отключения (имя члена `DisconnectReason`). */
export function classifyDisconnect(reason: string | undefined): DisconnectAction {
  if (reason === 'CLIENT_INITIATED') return 'ignore';
  if (reason && KICKED_REASONS.has(reason)) return 'kicked';
  return 'retry';
}

/** Пауза перед попыткой номер `attempt` (с 0); `null` — попытки кончились. */
export function retryDelay(attempt: number): number | null {
  return attempt >= 0 && attempt < MAX_RETRIES ? RETRY_DELAYS_MS[attempt] : null;
}

/** Ошибка, после которой повторять вход бессмысленно: токен недействителен (401) или прав нет (403). */
export function isPermanentJoinError(e: unknown): boolean {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return code === 401 || code === 403;
}

/**
 * Если `update` — «бота перенесли модератором», вернуть id нового канала. Условия: действие `left`, это сам бот
 * (`user.id`), канал события — тот, где бот сейчас, и есть `move_to` голосового канала.
 */
export function moveTarget(update: VoiceStateUpdated, selfId: string, currentChannelId: string): string | null {
  if (update.action !== 'left' || update.user.id !== selfId) return null;
  if (update.chat.id !== currentChannelId) return null;
  const to = update.move_to;
  if (!to || to.type !== 'voice' || !to.id || to.id === currentChannelId) return null;
  return to.id;
}
