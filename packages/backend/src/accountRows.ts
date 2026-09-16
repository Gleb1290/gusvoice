import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { anonymizedUserFields } from './accountRules.js';
import {
  channelReads,
  coinBalances,
  diagReports,
  dmReads,
  emailVerifications,
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
  await tx.update(users).set(anonymizedUserFields(userId, unusablePasswordHash, now)).where(eq(users.id, userId));
  return memberOf.map((s) => s.serverId);
}
