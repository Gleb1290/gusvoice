import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { anonymizedUserFields } from './accountRules.js';
import {
  channelReads,
  coinBalances,
  diagReports,
  dmReads,
  emailVerifications,
  federationGuestGrants,
  federationMemberships,
  memberRoles,
  passwordResets,
  pushDevices,
  pushMutes,
  serverMembers,
  users,
} from './db/schema.js';

/**
 * Базовая часть удаления аккаунта (F0 #139): строка `users` и личные строки в соседних таблицах.
 * Вызывать ВНУТРИ транзакции; возвращает серверы, где человек состоял (для `server.invalidate`).
 *
 * ⚠️ Отдельным модулем, без `db`, env, Redis и шлюза — чтобы этот самый код можно было прогнать на
 * настоящем Postgres в проверке, не поднимая бэкенд. Сеть и события — в `accountDelete.ts`.
 *
 * Что НЕ трогается и почему: `messages`, `message_reactions`, `dm_channels`, `dm_messages`,
 * `dm_message_reactions`, `audit_log`, `coin_ledger`, `season_results`, `poll_votes`, `bans` — это
 * переписка и история, ради которой строка и остаётся (`accountRules.ts`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function anonymizeAccountRows(tx: PgDatabase<any, any, any>, userId: string, unusablePasswordHash: string, now: Date): Promise<string[]> {
  const memberOf = await tx
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, userId));
  await tx.delete(memberRoles).where(eq(memberRoles.userId, userId));
  await tx.delete(serverMembers).where(eq(serverMembers.userId, userId));
  await tx.delete(coinBalances).where(eq(coinBalances.userId, userId));
  await tx.delete(pushDevices).where(eq(pushDevices.userId, userId));
  await tx.delete(pushMutes).where(eq(pushMutes.userId, userId));
  await tx.delete(emailVerifications).where(eq(emailVerifications.userId, userId));
  await tx.delete(passwordResets).where(eq(passwordResets.userId, userId));
  await tx.delete(channelReads).where(eq(channelReads.userId, userId));
  await tx.delete(dmReads).where(eq(dmReads.userId, userId));
  await tx.delete(diagReports).where(eq(diagReports.userId, userId));
  /**
   * Где человек был гостем (F3, §5.5). Аккаунта больше нет — значит и «Где я гость» пусто.
   *
   * 🔴 Список хостов для `user.revoked` берётся ИЗ ЭТОГО ЖЕ индекса, поэтому собрать и разослать его
   * обязан вызывающий ДО транзакции (`accountDelete.ts`). Почистить сначала, а потом искать, кому
   * сообщать, — значит не сообщить никому: гость остался бы жить на хостах до их суточной сверки.
   */
  await tx.delete(federationMemberships).where(eq(federationMemberships.userId, userId));
  // Поручительства перед хостами (аудит 19.09, F-04): аккаунта нет — ручаться больше не за кого, и
  // запоздавшее «членство» от хоста про обезличенную строку приниматься не должно.
  await tx.delete(federationGuestGrants).where(eq(federationGuestGrants.userId, userId));
  await tx.update(users).set(anonymizedUserFields(userId, unusablePasswordHash, now)).where(eq(users.id, userId));
  return memberOf.map((s) => s.serverId);
}
