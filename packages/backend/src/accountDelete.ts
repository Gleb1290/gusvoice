import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DELETED_DISPLAY_NAME } from './accountRules.js';
import { anonymizeAccountRows } from './accountRows.js';
import { clearActivity } from './activity.js';
import { forgetTokenGeneration, hashPassword } from './auth.js';
import { db } from './db/index.js';
import { announceUser } from './federation/directoryEvents.js';
import { revokeAccountEverywhere } from './federation/guestRevocation.js';
import { users } from './db/schema.js';
import { broadcastUserProfile } from './gateway.js';
import { removeFromOtherRooms } from './livekit.js';
import { publishToServer } from './realtime.js';
import { removeUserAvatars } from './storage.js';

/**
 * Удалить аккаунт — обезличить строку, оставив переписку (F0 федерации, #139). Правила, что уходит и что
 * остаётся, — в `accountRules.ts`; проверки «можно ли» делает вызывающий маршрут (`accountDeleteBlock`).
 *
 * Порядок важен:
 * 1. **Одна транзакция:** строка `users` и личные строки в соседних таблицах (`accountRows.ts`) **и подъём
 *    поколения токенов**. 🔴 Раньше поколение поднималось отдельным запросом ПОСЛЕ фиксации (нашёл Codex
 *    15.09): упади этот запрос — аккаунт уже обезличен, а старые токены живы до своего срока. Теперь либо
 *    всё, либо ничего. (`tokenGenValid` вдобавок отбивает удалённых сам — вторая линия.)
 * 2. После фиксации — сброс кэша поколений (синхронный, упасть нечему): иначе токены жили бы ещё до 10 с.
 * 3. Всё внешнее — **best-effort, без права уронить ответ**: события, файлы аватаров, голосовые комнаты.
 *    🔴 Раньше первое же `publishToServer` при упавшем Redis бросало исключение: маршрут отвечал 500 уже
 *    ПОСЛЕ удаления, а чистка аватаров и голоса не запускалась вовсе (нашёл Codex 15.09). Каждый шаг теперь
 *    сам по себе, провал пишется в лог. Открытые сокеты шлюза умирают на ближайшем `ping` (≤ ~40 с).
 */
export async function anonymizeAccount(userId: string): Promise<void> {
  const unusable = await hashPassword(randomBytes(32).toString('hex'));
  /**
   * 🔴 Хостам, где человек был гостем, сообщаем ДО транзакции (F3, §5.6): она чистит индекс членств
   * каскадом, и список адресатов после неё был бы пуст. Гость остался бы жить на чужих серверах до
   * их суточной сверки — то есть до суток от имени удалённого аккаунта.
   */
  await revokeAccountEverywhere({ userId }).catch((err) => {
    console.warn(`[account] отзыв гостевых сессий ${userId} не разослан: ${err instanceof Error ? err.message : err}`);
  });
  const memberOf = await db.transaction(async (tx) => {
    const servers = await anonymizeAccountRows(tx, userId, unusable, new Date());
    await tx
      .update(users)
      .set({ tokenGeneration: sql`${users.tokenGeneration} + 1` })
      .where(eq(users.id, userId));
    return servers;
  });
  forgetTokenGeneration(userId);

  const results = await Promise.allSettled([
    Promise.resolve().then(() => clearActivity(userId)),
    // Собеседники по ЛС (беседы остаются) видят новое имя и пустой аватар без перезахода.
    Promise.resolve().then(() => broadcastUserProfile(userId, DELETED_DISPLAY_NAME, null, null)),
    // Участники бывших серверов: ростер без призрака, а шлюз пересобирает, кто чей онлайн видит (#136).
    ...memberOf.map((serverId) => publishToServer(serverId, { t: 'server.invalidate', serverId })),
    removeUserAvatars(userId),
    removeFromOtherRooms(userId, ''),
    removeFromOtherRooms(`${userId}#screen`, ''),
    // Соседям по федерации — надгробие «удалён» (F2, §5.2). Время правки каталога уже сдвинуто самой
    // транзакцией обезличивания, поэтому даже не доехавшее событие догонит дельтой.
    announceUser(userId),
  ]);
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length > 0) {
    console.warn(
      `[account] аккаунт ${userId} обезличен, но ${failed.length} шаг(ов) после фиксации не удались: ` +
        failed.map((f) => (f.reason as Error)?.message ?? String(f.reason)).join('; '),
    );
  }
}
