/**
 * Кому отдавать лицо нашего человека (#139, F2/F3, план §5.2, §5.4) — ЧИСТОЕ правило.
 *
 * Вынесено из `avatars.ts` по просьбе Codex (16.09): тот модуль на импорте поднимает базу,
 * хранилище и сеть, поэтому матрицу «скрыт / удалён / неподтверждён / гость» нельзя было прогнать
 * быстрым тестом — только через живой инстанс. А это ровно то правило, которое стоит проверять
 * построчно: ошибка здесь отдаёт наружу лицо человека, которого нет в каталоге.
 */

import { directoryEntryOf } from './directoryRules.js';

/**
 * Наш аватар для связанного соседа.
 *
 * 🔴 Отдаётся ТОЛЬКО если человек виден в каталоге: у скрытого и удалённого картинки нет, даже если
 * файл лежит на месте. Иначе этот маршрут стал бы обходом скрытия — «в списке нет, а лицо есть».
 */
export function avatarUrlForPeer(row: {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  verified: boolean;
  approvedAt: Date | null;
  deletedAt: Date | null;
  hiddenFromPeers: boolean;
  /**
   * 🔴 Не `null` — это ТЕНЕВАЯ строка гостя, и лица чужого человека мы не отдаём (F3, §5.2).
   * Отдай мы его — сосед B узнавал бы через нас не только о существовании людей инстанса C, но и
   * получал бы их фотографии нашими руками.
   */
  homeInstanceId: string | null;
  directoryUpdatedAt: Date;
}): string | null {
  // Решение принимается ТЕМ ЖЕ правилом, что и видимость в каталоге: два разных правила рано или
  // поздно разойдутся, и разойдутся именно на скрытом человеке.
  const entry = directoryEntryOf({
    userId: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    verified: row.verified,
    approvedAt: row.approvedAt,
    deletedAt: row.deletedAt,
    hiddenFromPeers: row.hiddenFromPeers,
    homeInstanceId: row.homeInstanceId,
    directoryUpdatedAt: row.directoryUpdatedAt.getTime(),
  });
  if (!entry || entry.removed) return null;
  return row.avatarUrl;
}
