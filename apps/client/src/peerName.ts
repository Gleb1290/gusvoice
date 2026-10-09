import { useMemo } from 'react';
import { personLabel, serverContacts } from './contactRules';
import { useContactList, useContacts } from './contacts';
import { activeInstanceId } from './config';
import { useStore } from './store';

/**
 * Единая точка «как показать человека в ЛС и группах» (08.10, #211, решение владельца п.27): подпись из моих контактов
 * заменяет имя ВЕЗДЕ в личке — список бесед, шапка, автор в группе, карточка, окна, выбор участников, «Переслать», поиск,
 * уведомления. Правило — `personLabel` (`contactRules.ts`). В каналах серверов имя идёт через `memberName.ts` (ник сервера),
 * сюда не ходит.
 *
 * Сигнатура та же, что у `NameResolver` (`memberName.ts`): `(userId, имяИзДанных) → что показать`, — её и ждёт `MessagePane`.
 */
export type PeerNamer = (userId: string, fallback: string) => string;

/** Своё имя без подмены: контакты выключены, гость соседнего инстанса или список ещё не пришёл. */
export const PLAIN_PEER: PeerNamer = (_id, fallback) => fallback;

/** Хук: резолвер подписи для отрисовки. Сам подгружает контакты один раз на инстанс (`useContactList`). */
export function usePeerName(): PeerNamer {
  const on = useStore((s) => serverContacts(s.serverFeatures) && !s.user?.homeInstance);
  const list = useContactList(on);
  return useMemo(() => {
    if (!list?.some((c) => c.name)) return PLAIN_PEER;
    return (userId: string, fallback: string) => personLabel(list, userId, fallback);
  }, [list]);
}

/** То же для обработчиков (сокет, звонок, тосты), куда хук не вставить: читает список в момент вызова. */
export function peerNameNow(userId: string, fallback: string): string {
  const s = useContacts.getState();
  if (s.owner !== (activeInstanceId() ?? '')) return fallback;
  return personLabel(s.list, userId, fallback);
}

/** Имя беседы в ЛС: у 1:1 — подпись собеседника; у группы `otherUser` несёт название группы, его id не контакт. */
export function dmPeerLabel(dm: { otherUser: { id: string; displayName: string } }, nameOf: PeerNamer): string {
  return nameOf(dm.otherUser.id, dm.otherUser.displayName);
}

/**
 * Копия беседы с подписью в `otherUser.displayName` — для окон, которые берут имя из беседы и не знают про контакты
 * (`DmListSwipe.runSwipeAction` → «Удалить чат?»). Без подписи — та же беседа.
 */
export function withPeerLabel<T extends { otherUser: { id: string; displayName: string } }>(dm: T): T {
  const name = peerNameNow(dm.otherUser.id, dm.otherUser.displayName);
  return name === dm.otherUser.displayName ? dm : { ...dm, otherUser: { ...dm.otherUser, displayName: name } };
}
