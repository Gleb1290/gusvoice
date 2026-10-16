/**
 * Профиль гостя на хосте по событиям его дома (#139, F3, план §5.4).
 *
 * 🔴 Без этого гость, переименовавшийся дома, оставался бы на НАШИХ серверах со старым именем до
 * следующего входа — то есть, возможно, неделями: гостевая сессия живёт восемь суток и продлевается
 * сама. В каталоге сосед менялся бы, а в чате рядом с его сообщениями стояло бы прежнее имя.
 *
 * Событие приходит то же самое (`user.updated`, запись каталога) — и обрабатывается ДВАЖДЫ: кеш
 * каталога обновляет `directoryCache`, а теневую строку этот модуль. Разные вещи с разной судьбой:
 * кеш можно выбросить целиком, теневую строку — никогда (на неё ссылается переписка).
 */

import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { FED_DIRECTORY_REMOVED, type FedDirectoryEntry } from '@gusvoice/shared';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { anonymizedUserFields } from '../accountRules.js';
import { hashPassword, forgetTokenGeneration } from '../auth.js';
import { broadcastUserProfile } from '../gateway.js';
import { refreshGuestAvatar } from './avatars.js';
import { applyRevocation } from './guestRevocation.js';

/**
 * Применить запись каталога к теневой строке, если она у нас есть.
 *
 * Возвращает `true`, если строка нашлась и что-то поменялось. Человека без теневой строки здесь
 * попросту нет — это обычное дело: в каталоге соседа сотни людей, а гостями у нас бывают единицы.
 */
/**
 * Обезличить теневую строку (аккаунта дома больше нет, §5.6.2): сообщения остаются. Уже обезличенную — не трогает. Членства и
 * сессии — `applyRevocation` (зовёт вызывающий; `user.revoked` зовёт это сам через `configureShadowGone`).
 */
export async function anonymizeShadow(shadowId: string): Promise<void> {
  const [shadow] = await db.select({ id: users.id, deletedAt: users.deletedAt }).from(users).where(eq(users.id, shadowId)).limit(1);
  if (!shadow || shadow.deletedAt !== null) return;
  const unusable = await hashPassword(randomBytes(32).toString('hex'));
  const fields = anonymizedUserFields(shadow.id, unusable, new Date());
  await db.update(users).set(fields).where(eq(users.id, shadow.id));
  forgetTokenGeneration(shadow.id);
  // Рассылка синхронная и сама не падает — обёртка не нужна.
  broadcastUserProfile(shadow.id, fields.displayName, null, null);
}

export async function applyGuestProfile(instanceId: string, entry: FedDirectoryEntry): Promise<boolean> {
  const [shadow] = await db
    .select()
    .from(users)
    .where(and(eq(users.homeInstanceId, instanceId), eq(users.homeUserId, entry.userId)))
    .limit(1);
  if (!shadow) return false;

  if (entry.removed) {
    /**
     * Надгробие. `deleted` — аккаунта дома больше нет: обезличиваем теневую строку (§5.6.2),
     * сообщения остаются. `hidden` — человека лишь убрали из каталога: он по-прежнему наш гость и
     * виден на серверах как обычный участник (§5.2.1), трогать его нельзя.
     */
    if (entry.removed !== FED_DIRECTORY_REMOVED.deleted) return false;
    if (shadow.deletedAt !== null) return false;

    const unusable = await hashPassword(randomBytes(32).toString('hex'));
    const fields = anonymizedUserFields(shadow.id, unusable, new Date());
    await db.update(users).set(fields).where(eq(users.id, shadow.id));
    forgetTokenGeneration(shadow.id);
    // Членства снимаются и сессии гаснут тем же путём, что и по событию `user.revoked`.
    await applyRevocation({ instanceId, homeUserId: entry.userId, gen: null, account: true });
    // Рассылка синхронная и сама не падает — обёртка не нужна.
    broadcastUserProfile(shadow.id, fields.displayName, null, null);
    return true;
  }

  const displayName = entry.displayName ?? entry.username ?? shadow.displayName;
  const changed = shadow.displayName !== displayName || shadow.homeUsername !== entry.username;
  if (changed) {
    await db
      .update(users)
      .set({ displayName, homeUsername: entry.username ?? shadow.homeUsername })
      .where(eq(users.id, shadow.id));
    // Собеседники видят новое имя без перезахода — иначе оно менялось бы «когда-нибудь потом».
    broadcastUserProfile(shadow.id, displayName, shadow.avatarUrl, shadow.animatedAvatarUrl);
  }

  const avatarChanged = shadow.homeAvatarHash !== (entry.avatarHash ?? null);
  if (avatarChanged) {
    // Не ждём: картинка не должна задерживать разбор пачки событий (§5.4).
    void refreshGuestAvatar({
      shadowUserId: shadow.id,
      instanceId,
      homeUserId: entry.userId,
      avatarHash: entry.avatarHash ?? null,
    }).catch(() => {});
  }
  /**
   * ⚠️ Смена одного аватара — тоже изменение (нашёл Codex 16.09: возвращалось `false`, хотя
   * контракт обещает «что-то поменялось»). Сейчас единственный вызывающий результат игнорирует, и
   * потому это не баг для человека, — но расхождение обещания с поведением живёт ровно до второго
   * вызывающего, который на обещание положится.
   */
  return changed || avatarChanged;
}
