import { and, eq, or, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { anonymizedUserFields, DELETED_DISPLAY_NAME } from './accountRules.js';
import {
  attachments,
  channelReads,
  coinBalances,
  conversationMessages,
  conversationScheduled,
  diagReports,
  emailVerifications,
  federationGuestGrants,
  federationMemberships,
  memberRoles,
  passwordResets,
  pushDevices,
  dmFolders,
  pushAlways,
  pushMutes,
  serverMembers,
  userBlocks,
  lastSeenExceptions,
  userContacts,
  privacyExceptions,
  userStickerPacks,
  userFavedStickers,
  userSavedGifs,
  userRecentStickers,
  userSync,
  users,
} from './db/schema.js';

/**
 * Базовая часть удаления аккаунта (F0 #139): строка `users` и личные строки в соседних таблицах.
 * Вызывать ВНУТРИ транзакции; возвращает серверы, где человек состоял (для `server.invalidate`).
 *
 * ⚠️ Отдельным модулем, без `db`, env, Redis и шлюза — чтобы этот самый код можно было прогнать на
 * настоящем Postgres в проверке, не поднимая бэкенд. Сеть и события — в `accountDelete.ts`.
 *
 * Что НЕ трогается и почему: `messages`, `message_reactions`, `audit_log`, `coin_ledger`, `season_results`,
 * `poll_votes`, `bans` — это переписка и история, ради которой строка и остаётся (`accountRules.ts`).
 * Из `conversation_messages` меняется
 * только имя в снимках «Переслано от» (ниже), сами сообщения остаются. Отложенные (`conversation_scheduled`, С4) —
 * ещё не переписка, а неотправленное личное: удаляются, и их файлы (`attachments` в состоянии `scheduled`, `conv10`) —
 * тоже; файлы отправленных сообщений остаются, как сами сообщения.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function anonymizeAccountRows(tx: PgDatabase<any, any, any>, userId: string, unusablePasswordHash: string, now: Date): Promise<string[]> {
  const memberOf = await tx
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, userId));
  /*
   * Снимки «Переслано от» (`conv5`, находка Codex 04.10): копия хранит имя автора оригинала на момент пересылки, и
   * после удаления его аккаунта прежнее имя оставалось бы в чужих беседах. Имя — на обезличенное, `userId` прежний (как
   * у автора сообщения: строка `users` остаётся с тем же id), время — прежнее. Надгробия снимка не хранят (удаление у
   * обоих его стирает, Р19), а у сделанных до этого правила он переписывается тем же запросом.
   * И признак `deleted: true` (05.10, только добавление): клиент узнаёт удалённого автора по нему, а не по имени —
   * «Удалённый пользователь» может назваться и живой человек. Слияние `||` идемпотентно: повтор даёт те же байты.
   * Первой записью транзакции: писатели бесед запирают беседу → сообщение → `user_sync`, а строку `user_sync` этого
   * человека транзакция удаляет ниже; держи она её, ожидая строку копии, удаление копии в его беседе заперло бы обе.
   * Кеши клиентов узнают о новом снимке из журнала — строки пишет `conversations.journalForwardedFrom` после фиксации
   * (`accountDelete.ts`).
   */
  await tx
    .update(conversationMessages)
    .set({
      forwardedFrom: sql`${conversationMessages.forwardedFrom} || jsonb_build_object('displayName', ${DELETED_DISPLAY_NAME}::text, 'deleted', true)`,
    })
    .where(sql`${conversationMessages.forwardedFrom}->>'userId' = ${userId}`);
  /*
   * Отложенные сообщения (С4, `conv9`): неотправленный текст — личное автора; после удаления аккаунта не уходит никуда и
   * не хранится. Ссылки на `users` у таблицы нет (автор — участник беседы, как у закрепов), поэтому удаляются явно.
   * Второй записью, ДО `user_sync`: такт планировщика держит строку отложенного и пишет журнал её автора — держи эта
   * транзакция его `user_sync`, ожидая строку, вышел бы круг (`scheduled.ts`, порядок замков).
   */
  await tx.delete(conversationScheduled).where(eq(conversationScheduled.authorId, userId));
  /*
   * Файлы его отложенных (06.10, `conv10`) — «удалено» третьей записью, сразу за строками отложенного (порядок замков тот же,
   * что у такта планировщика: строка отложенного → её файлы). Ссылка файла на строку отложенного проверяется при фиксации
   * (миграция 0087) — без этой записи удаление аккаунта с отложенным фото не зафиксировалось бы. Сами файлы стирает
   * `accountDelete.ts` после фиксации (не успеет — часовая уборка `attachments.purgeAttachments`).
   */
  await tx
    .update(attachments)
    .set({ state: 'deleted', deletedAt: now, scheduledId: null })
    .where(and(eq(attachments.ownerId, userId), eq(attachments.state, 'scheduled')));
  await tx.delete(memberRoles).where(eq(memberRoles.userId, userId));
  await tx.delete(serverMembers).where(eq(serverMembers.userId, userId));
  await tx.delete(coinBalances).where(eq(coinBalances.userId, userId));
  await tx.delete(pushDevices).where(eq(pushDevices.userId, userId));
  await tx.delete(pushMutes).where(eq(pushMutes.userId, userId));
  await tx.delete(pushAlways).where(eq(pushAlways.userId, userId));
  await tx.delete(emailVerifications).where(eq(emailVerifications.userId, userId));
  await tx.delete(passwordResets).where(eq(passwordResets.userId, userId));
  await tx.delete(channelReads).where(eq(channelReads.userId, userId));
  await tx.delete(diagReports).where(eq(diagReports.userId, userId));
  // Журнал догонки ЛС (этап 1): состояние синхронизации устройств человека. Строки `user_changes` уходят каскадом.
  // Беседы, участие в них и сообщения остаются — это переписка собеседника.
  await tx.delete(userSync).where(eq(userSync.userId, userId));
  // Чёрный список (#212) — в обе стороны: свой список — личные данные, а блокировка удалённого аккаунта
  // ничего не защищает (писать ему уже нельзя, `dmRules.canWriteDm`).
  await tx.delete(userBlocks).where(or(eq(userBlocks.blockerId, userId), eq(userBlocks.blockedId, userId)));
  // Исключения «Времени захода» (0120, `lastseen3`) — личный список и записи о человеке в чужих списках, в обе стороны.
  await tx.delete(lastSeenExceptions).where(or(eq(lastSeenExceptions.ownerId, userId), eq(lastSeenExceptions.targetId, userId)));
  // Исключения прочих настроек приватности (0122, `presence4`: «Кто может звонить») — тоже в обе стороны.
  await tx.delete(privacyExceptions).where(or(eq(privacyExceptions.ownerId, userId), eq(privacyExceptions.targetId, userId)));
  // Контакты (0126, `contacts1`) — свой список и записи о человеке в чужих списках (вместе с чужой подписью к нему), в обе стороны.
  await tx.delete(userContacts).where(or(eq(userContacts.ownerId, userId), eq(userContacts.contactId, userId)));
  // «Мои наборы» стикеров (0092, `stickers2`) — личный список. Наборы, которые человек привёз в каталог, остаются у всех
  // (`sticker_packs.created_by` обнуляется сам, как у наборов серверов).
  await tx.delete(userStickerPacks).where(eq(userStickerPacks.userId, userId));
  // Избранные и недавние стикеры (0100, `stickers3`) — личные списки.
  await tx.delete(userFavedStickers).where(eq(userFavedStickers.userId, userId));
  await tx.delete(userRecentStickers).where(eq(userRecentStickers.userId, userId));
  // Мои GIF (0104, `gifs1`) — личный список. Файлы `gif/…` стирает `accountDelete.ts` после фиксации (ключи читает до).
  await tx.delete(userSavedGifs).where(eq(userSavedGifs.userId, userId));
  // Папки бесед ЛС (0093, `folders1`) — личные определения отбора, беседы в них не хранятся.
  await tx.delete(dmFolders).where(eq(dmFolders.userId, userId));
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
