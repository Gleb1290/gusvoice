/**
 * Каталог по событиям (#139, F2, план §5.4) — мгновенный слой поверх дельт и суточной сверки.
 *
 * Событие доезжает за секунды, но может не доехать вовсе; дельта раз в 15 минут добирает
 * пропущенное; суточная сверка ловит расхождения, которых не видно ни по одному событию. Здесь —
 * только первый слой, и он НАМЕРЕННО необязательный: потеряется — не страшно, догонят остальные два.
 *
 * 🔴 Поле `version` у этих событий не используется, и это осознанно. Версия записи каталога — её
 * собственное `updated_at` в полезной нагрузке (миллисекунды эпохи): оно едет и в событии, и в
 * дельте, и в полной сверке, а значит сравнение везде идёт по одному и тому же числу. Заведи мы
 * вторую версию рядом — рано или поздно они разошлись бы, и «свежее» стало бы вопросом того, каким
 * путём запись приехала. (Заодно миллисекунды эпохи не влезают в столбец `version` очереди.)
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  FED_DIRECTORY_REMOVED,
  FED_EVENTS,
  parseDirectoryEntry,
  parseServerEntry,
  serializeDirectoryEntry,
  serializeServerEntry,
  type FedServerEntry,
} from '@gusvoice/shared';
import { db } from '../db/index.js';
import { federationLinks, serverFederationExclusions, serverMembers, servers, users } from '../db/schema.js';
import { onFedEvent, queueBroadcast, queueEventTo } from './eventStream.js';
import { applyDirectoryEntries, applyServerEntries } from './directoryCache.js';
import { applyGuestProfile } from './guestProfile.js';
import { directoryEntryOf, mediaHashOf } from './directoryRules.js';
import { touchDirectoryServer, touchDirectoryUser } from './directoryFeed.js';
import { env } from '../env.js';

/** Приём: сосед сообщил, что у него изменилась запись каталога. */
export function registerDirectoryHandlers(): void {
  onFedEvent(FED_EVENTS.userUpdated, async ({ instanceId, event }) => {
    // Полезная нагрузка события — ТА ЖЕ запись каталога, что и в дельте, и разбирается тем же
    // разбором. Один формат вместо двух: иначе «человек скрыт» по одному пути и по другому
    // означало бы разное, и разошлись бы они молча.
    const entry = parseDirectoryEntry(event.payload);
    if (!entry) return;
    await applyDirectoryEntries(instanceId, [entry]);
    /**
     * 🔴 И ТЕНЕВАЯ строка, если этот человек у нас гость (F3, §5.4). Без второго шага он остался бы
     * на наших серверах со старым именем до следующего входа — то есть, возможно, неделями:
     * гостевая сессия живёт восемь суток и продлевается сама.
     */
    await applyGuestProfile(instanceId, entry);
  });

  onFedEvent(FED_EVENTS.serverUpdated, async ({ instanceId, event }) => {
    const entry = parseServerEntry(event.payload);
    if (!entry) return;
    await applyServerEntries(instanceId, [entry]);
  });
}

/**
 * Сообщить соседям, что запись человека изменилась.
 *
 * Зовётся после правки профиля, подтверждения, скрытия и удаления. ⚠️ Ошибка рассылки НЕ поднимается
 * наверх: смена имени не должна падать оттого, что сосед лежит, — событие уйдёт из очереди, а не
 * уйдёт, так дельта доберёт.
 */
export async function announceUser(userId: string): Promise<void> {
  if (!env.federation.enabled) return;
  try {
    await touchDirectoryUser(userId);
    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!row) return;
    const entry = directoryEntryOf({
      userId: row.id,
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      verified: row.verified,
      approvedAt: row.approvedAt,
      deletedAt: row.deletedAt,
      hiddenFromPeers: row.hiddenFromPeers,
      // 🔴 Гость с другого инстанса — не наш человек, и рассказывать о нём соседям мы не вправе
      // (§5.2). Здесь стояла заглушка «теневых строк ещё нет»; в F3 они появились.
      homeInstanceId: row.homeInstanceId,
      directoryUpdatedAt: row.directoryUpdatedAt.getTime(),
    });
    // Неподтверждённого сосед никогда не видел — рассказывать не о чем.
    if (!entry) return;
    /**
     * 🔴 Скрытие СОБЫТИЕМ не рассылаем (аудит F-24; ревью #195 п. 5). Наружу причина надгробия одна —
     * `deleted` (`directoryFeed`), но по событию хост, у которого этот человек ГОСТЬ, на `deleted`
     * необратимо обезличивает его теневую строку (`applyGuestProfile`), а незнакомую причину соседи
     * прежних версий читают как `deleted` же. Слать `hidden` — выдавать факт скрытия. Поэтому скрытого
     * убирает у соседа ближайшая дельта (до 15 минут) под общей причиной, а событие молчит: список в
     * админке соседа — не граница безопасности (аватар и каталог скрытому отказывают и так).
     */
    if (entry.removed === FED_DIRECTORY_REMOVED.hidden) return;
    // В очередь, а не сразу: держатель скрывает людей десятками, и пачка раз в ~5 с (§5.4)
    // и соседу мягче, и нас не упрёт в его предел частоты.
    await queueBroadcast(FED_EVENTS.userUpdated, serializeDirectoryEntry(entry));
  } catch (err) {
    console.warn(`[fed] не удалось разослать запись каталога ${userId}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Как сервер выглядит для конкретной связки: открыт — карточка, закрыт — надгробие. */
async function serverEntryFor(serverId: string, instanceId: string): Promise<FedServerEntry | null> {
  const [row] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!row) return null;
  const [excluded] = await db
    .select({ serverId: serverFederationExclusions.serverId })
    .from(serverFederationExclusions)
    .where(
      and(
        eq(serverFederationExclusions.serverId, serverId),
        eq(serverFederationExclusions.instanceId, instanceId),
      ),
    )
    .limit(1);
  const updatedAt = row.directoryUpdatedAt.getTime();
  if (!row.federatedAccess || excluded) return { serverId, updatedAt, removed: true };

  const [count] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(serverMembers)
    .where(eq(serverMembers.serverId, serverId));
  return {
    serverId,
    updatedAt,
    name: row.name,
    iconHash: mediaHashOf(row.iconUrl),
    members: count?.n ?? 0,
  };
}

/**
 * Сообщить соседям, что сервер изменился.
 *
 * 🔴 Каждому соседу СВОЁ событие, а не общая рассылка: у одного сервер открыт, у другого закрыт
 * исключением по связке (требование 32), и одинаковая для всех карточка сказала бы исключённому,
 * что сервер ему доступен.
 * ⚠️ Число участников здесь не отслеживается: оно меняется постоянно, и слать событие на каждый
 * вход-выход значило бы превратить канал событий в поток. Счётчик обновляется дельтой.
 */
export async function announceServer(serverId: string): Promise<void> {
  if (!env.federation.enabled) return;
  try {
    await touchDirectoryServer(serverId);
    const links = await db
      .select({ instanceId: federationLinks.instanceId })
      .from(federationLinks)
      .where(eq(federationLinks.state, 'active'));
    for (const link of links) {
      const entry = await serverEntryFor(serverId, link.instanceId);
      if (!entry) continue;
      await queueEventTo(link.instanceId, FED_EVENTS.serverUpdated, serializeServerEntry(entry));
    }
  } catch (err) {
    console.warn(`[fed] не удалось разослать сервер ${serverId}: ${err instanceof Error ? err.message : err}`);
  }
}
