/**
 * Заказ «открыть беседу и перейти к сообщению» (G35, поиск из списка бесед): результат по тексту лежит в беседе, которая может
 * быть открыта (лента уже стоит — переход сразу) или нет (её ленту ждёт заказ: `MessagePane` забирает его, когда лента
 * загрузилась). Тот же приём, что у полосы голосовых из другой ленты (`voicePlayer.requestVoiceJump`), но с подпиской:
 * у открытой беседы заказ надо подхватить без перемонтирования.
 *
 * Источник поведения — Telegram: нажатие на найденное сообщение открывает чат на этом сообщении (`openPeerHistory` +
 * `msgId`), подсветка вспышкой — как у перехода по цитате.
 */
import { useSyncExternalStore } from 'react';

let pending: { feedId: string; messageId: string } | null = null;
let seq = 0;
const subs = new Set<() => void>();

/** Заказать переход. Лента `feedId` заберёт его (`takeFeedJump`) — сразу, если открыта, или когда откроется. */
export function requestFeedJump(feedId: string, messageId: string): void {
  pending = { feedId, messageId };
  seq += 1;
  for (const f of subs) f();
}

/** Забрать свой заказ (один раз). Чужой лежит, пока его не заберёт та лента. */
export function takeFeedJump(feedId: string | undefined): string | null {
  if (!feedId || pending?.feedId !== feedId) return null;
  const id = pending.messageId;
  pending = null;
  return id;
}

/** Номер заказа — меняется на каждый новый; лента с ним в зависимостях эффекта перепроверяет свой заказ. */
export function useFeedJumpSeq(): number {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => seq,
    () => 0,
  );
}
