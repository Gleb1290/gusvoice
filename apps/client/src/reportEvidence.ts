import { useSyncExternalStore } from 'react';

/**
 * Приложенные к жалобе сообщения (#139, F4, план §5.11).
 *
 * 🔴 **Только выбранные вручную.** Соблазн приложить «последние десять сообщений человека» велик и
 * сделал бы окно проще — но это была бы выгрузка чужой переписки соседу под видом модерации. Держатель
 * инстанса должен получить ровно те строки, которые модератор осознанно ткнул пальцем.
 *
 * 🔴 Корзина живёт В ПАМЯТИ вкладки и только до отправки. В `localStorage` ей нельзя: там она
 * пережила бы и закрытое окно, и смену человека, и однажды уехала бы к соседу как доказательство по
 * совсем другому поводу.
 *
 * ⚠️ Предел — пять сообщений, тот же, что на бэкенде (`REPORT_EVIDENCE_MAX`). Шестое не молча
 * теряется: `add` возвращает `false`, и окно об этом говорит.
 */

export interface EvidenceItem {
  /** Идентификатор сообщения — чтобы не приложить одно и то же дважды. */
  messageId: string;
  text: string;
  /** Мс эпохи. */
  at: number;
  /** Название канала: у соседа наших каналов нет, и «#общий» — единственное, что ему о них скажет. */
  channel: string;
}

export const EVIDENCE_MAX = 5;

const baskets = new Map<string, EvidenceItem[]>();
const subs = new Set<() => void>();

function notify(): void {
  for (const s of subs) s();
}

export function evidenceOf(userId: string): EvidenceItem[] {
  return baskets.get(userId) ?? [];
}

/** Положить сообщение в корзину. `false` — предел уже набран или это сообщение уже приложено. */
export function addEvidence(userId: string, item: EvidenceItem): boolean {
  const list = baskets.get(userId) ?? [];
  if (list.length >= EVIDENCE_MAX) return false;
  if (list.some((e) => e.messageId === item.messageId)) return false;
  baskets.set(userId, [...list, item]);
  notify();
  return true;
}

export function removeEvidence(userId: string, messageId: string): void {
  const list = baskets.get(userId);
  if (!list) return;
  baskets.set(
    userId,
    list.filter((e) => e.messageId !== messageId),
  );
  notify();
}

/** Очистить корзину — после отправки жалобы и после отказа от неё. */
export function clearEvidence(userId: string): void {
  if (!baskets.has(userId)) return;
  baskets.delete(userId);
  notify();
}

/**
 * Подписка на корзину человека.
 *
 * ⚠️ Снимок сравнивается ПО ССЫЛКЕ, поэтому `evidenceOf` обязан возвращать один и тот же массив,
 * пока корзина не менялась: новый массив на каждый вызов заставил бы React считать состояние
 * изменившимся вечно и крутить перерисовку без остановки.
 */
export function useEvidence(userId: string | null): EvidenceItem[] {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => (userId ? (baskets.get(userId) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
}

const EMPTY: EvidenceItem[] = [];
