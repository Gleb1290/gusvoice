/**
 * Кеш каталога соседа у нас (#139, F2, план §5.2 и §5.6).
 *
 * 🔴 Это именно КЕШ, а не источник правды: сосед лежит — выпадающие списки в админке остаются на
 * месте с пометкой «обновлено N назад» (требование 4). Поэтому здесь нигде нет «не смогли забрать →
 * очистим»: пустой список хуже устаревшего, он выглядит как «у соседа никого нет».
 *
 * Состояние приходит двумя путями — событием и сверкой, — и оба обязаны быть идемпотентны: одно и то
 * же изменение легко доезжает дважды. Отсюда `stateWins` со СТРОГИМ сравнением версий: при равных
 * версиях выигрывает лежащее, иначе повторная доставка отменяла бы правку, сделанную между ними.
 */

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { stateWins, type FedDirectoryEntry, type FedServerEntry } from '@gusvoice/shared';
import { db } from '../db/index.js';
import { federationPeerServers, federationPeerUsers } from '../db/schema.js';
import { removeOwnMedia } from '../storage.js';
import { releaseLinkQuota } from './guestQuota.js';
import { dropMediaFiles, planDirectoryBatch } from './directoryCacheCore.js';

export interface CacheOutcome {
  upserted: number;
  removed: number;
  /** Сколько записей отброшено как устаревшие — по ним видно, что события и сверка спорят. */
  stale: number;
}

/**
 * Положить записи каталога людей в кеш.
 *
 * Надгробие удаляет строку — и файл скачанного аватара вместе с ней (`dropAvatarFiles`): «общей
 * чистки хранилища», на которую ссылался прежний комментарий, в коде не было, и картинки соседа
 * копились в бакете навсегда (аудит 19.09, F-05; подтверждено run-1).
 */
export async function applyDirectoryEntries(
  instanceId: string,
  entries: readonly FedDirectoryEntry[],
): Promise<CacheOutcome> {
  const out: CacheOutcome = { upserted: 0, removed: 0, stale: 0 };
  if (entries.length === 0) return out;

  // Только строки ЭТОЙ пачки (#197 п. 11): одиночное событие каталога иначе читало всех людей соседа.
  const known = await db
    .select({
      userId: federationPeerUsers.userId,
      updatedAt: federationPeerUsers.updatedAt,
      avatarLocalUrl: federationPeerUsers.avatarLocalUrl,
    })
    .from(federationPeerUsers)
    .where(
      and(
        eq(federationPeerUsers.instanceId, instanceId),
        inArray(
          federationPeerUsers.userId,
          entries.map((e) => e.userId),
        ),
      ),
    );
  // Что устарело, что удаляется, у кого снять копию — `planDirectoryBatch` (чистый, `directoryCacheCore.ts`).
  const plan = planDirectoryBatch(entries, known);
  out.stale = plan.stale;
  out.removed = plan.removed;
  const { doomed, orphaned } = plan;
  for (const { entry, staleCopy: stale } of plan.upserts) {
    await db
      .insert(federationPeerUsers)
      .values({
        instanceId,
        userId: entry.userId,
        username: entry.username ?? entry.userId,
        displayName: entry.displayName ?? entry.username ?? entry.userId,
        avatarHash: entry.avatarHash ?? null,
        updatedAt: entry.updatedAt,
        cachedAt: new Date(),
      })
      // ⚠️ Скачанный аватар (`avatarLocalUrl`/`avatarCachedHash`) здесь НЕ трогается: он остаётся
      // годным, пока не разошёлся отпечаток, и перезаписывать его пустотой на каждом обновлении
      // профиля значило бы качать картинку заново после каждой смены ника.
      .onConflictDoUpdate({
        target: [federationPeerUsers.instanceId, federationPeerUsers.userId],
        set: {
          username: entry.username ?? entry.userId,
          displayName: entry.displayName ?? entry.username ?? entry.userId,
          avatarHash: entry.avatarHash ?? null,
          updatedAt: entry.updatedAt,
          cachedAt: new Date(),
          // Снимаем копию, ТОЛЬКО если это всё ещё та, что мы видели до цикла (#197 п. 9): скачанную в
          // это окно новую не трогаем — иначе её файл остался бы сиротой; её снимет следующее чтение.
          ...(stale
            ? {
                avatarLocalUrl: sql`CASE WHEN ${federationPeerUsers.avatarLocalUrl} = ${stale} THEN NULL ELSE ${federationPeerUsers.avatarLocalUrl} END`,
                avatarCachedHash: sql`CASE WHEN ${federationPeerUsers.avatarLocalUrl} = ${stale} THEN NULL ELSE ${federationPeerUsers.avatarCachedHash} END`,
              }
            : {}),
        },
      });
    out.upserted += 1;
  }

  if (orphaned.length > 0) dropAvatarFiles(instanceId, orphaned);
  if (doomed.length > 0) {
    const gone = await db
      .delete(federationPeerUsers)
      .where(and(eq(federationPeerUsers.instanceId, instanceId), inArray(federationPeerUsers.userId, doomed)))
      .returning({ url: federationPeerUsers.avatarLocalUrl });
    dropAvatarFiles(
      instanceId,
      gone.map((g) => g.url),
    );
  }
  return out;
}

/**
 * Убрать из хранилища снятые копии аватаров людей соседа и вернуть их байты в квоту связки — пачками
 * (F-05; ревью #195 п. 7; #196 пп. 7 и 11). Порядок, параллельность и счёт байт — `dropMediaFiles`
 * (`directoryCacheCore.ts`).
 *
 * Ссылки приходят из `DELETE … RETURNING` (или из уже обнулённой записи): между чтением и удалением
 * строки окна нет, и файл не остаётся без хозяина. `quotaOwner` — чью квоту пополнять: при
 * перепривязке строки лежат под старой личностью, а место занимает уже новая (#196 п. 8).
 *
 * ⚠️ Мимо ответа и с проглоченной ошибкой: хранилище может лежать, а кеш каталога от этого не
 * должен зависеть; осиротевший файл — потеря места, а не данных.
 */
function dropAvatarFiles(quotaOwner: string, urls: readonly (string | null)[]): void {
  void dropMediaFiles(
    { removeOwnMedia: (url) => removeOwnMedia(url), release: (owner, bytes) => releaseLinkQuota(owner, bytes) },
    quotaOwner,
    urls,
  ).catch(() => {});
}

/** То же для серверов соседа. */
export async function applyServerEntries(
  instanceId: string,
  entries: readonly FedServerEntry[],
): Promise<CacheOutcome> {
  const out: CacheOutcome = { upserted: 0, removed: 0, stale: 0 };
  if (entries.length === 0) return out;

  const known = await db
    .select({ serverId: federationPeerServers.serverId, updatedAt: federationPeerServers.updatedAt })
    .from(federationPeerServers)
    .where(eq(federationPeerServers.instanceId, instanceId));
  const versionOf = new Map(known.map((r) => [r.serverId, Number(r.updatedAt)]));

  const doomed: string[] = [];
  for (const entry of entries) {
    const current = versionOf.get(entry.serverId);
    if (!stateWins(entry.updatedAt, current)) {
      out.stale += 1;
      continue;
    }
    if (entry.removed) {
      if (current !== undefined) doomed.push(entry.serverId);
      out.removed += 1;
      continue;
    }
    const values = {
      name: entry.name ?? entry.serverId,
      iconHash: entry.iconHash ?? null,
      members: entry.members ?? 0,
      updatedAt: entry.updatedAt,
      cachedAt: new Date(),
    };
    await db
      .insert(federationPeerServers)
      .values({ instanceId, serverId: entry.serverId, ...values })
      .onConflictDoUpdate({
        target: [federationPeerServers.instanceId, federationPeerServers.serverId],
        set: values,
      });
    out.upserted += 1;
  }

  if (doomed.length > 0) {
    await db
      .delete(federationPeerServers)
      .where(
        and(eq(federationPeerServers.instanceId, instanceId), inArray(federationPeerServers.serverId, doomed)),
      );
  }
  return out;
}

/**
 * Досверка после ПОЛНОЙ выдачи: убрать тех, кого сосед больше не показывает.
 *
 * 🔴 Зовётся ТОЛЬКО когда все страницы забраны успешно. Оборвись сверка на середине — и «чего нет в
 * ответе, того нет и у соседа» удалило бы половину кеша, а следующая сверка вернула бы её обратно:
 * списки мигали бы, а причина была бы невидима.
 */
export async function reconcileDirectory(instanceId: string, seenUserIds: readonly string[]): Promise<number> {
  // Одним запросом — и строки, и ссылки на файлы уходящих (#196 п. 11): между чтением и удалением
  // окна нет. Аватары уходящих — из хранилища (ревью #195 п. 8): полная выдача надгробий не несёт по
  // замыслу, и без этого файл исчезнувшего человека оставался бы навсегда — та самая утечка F-05.
  const rows = await db
    .delete(federationPeerUsers)
    .where(
      seenUserIds.length === 0
        ? eq(federationPeerUsers.instanceId, instanceId)
        : and(eq(federationPeerUsers.instanceId, instanceId), notInArray(federationPeerUsers.userId, [...seenUserIds])),
    )
    .returning({ url: federationPeerUsers.avatarLocalUrl });
  dropAvatarFiles(
    instanceId,
    rows.map((r) => r.url),
  );
  return rows.length;
}

export async function reconcileServers(instanceId: string, seenServerIds: readonly string[]): Promise<number> {
  const rows =
    seenServerIds.length === 0
      ? await db
          .delete(federationPeerServers)
          .where(eq(federationPeerServers.instanceId, instanceId))
          .returning({ serverId: federationPeerServers.serverId })
      : await db
          .delete(federationPeerServers)
          .where(
            and(
              eq(federationPeerServers.instanceId, instanceId),
              notInArray(federationPeerServers.serverId, [...seenServerIds]),
            ),
          )
          .returning({ serverId: federationPeerServers.serverId });
  return rows.length;
}

/**
 * Выбросить кеш связки целиком — при разрыве и перепривязке (§5.6).
 * `quotaOwner` — кому вернуть место снятых аватаров: при перепривязке это уже НОВАЯ личность.
 */
export async function forgetPeerCache(instanceId: string, quotaOwner = instanceId): Promise<void> {
  const rows = await db
    .delete(federationPeerUsers)
    .where(eq(federationPeerUsers.instanceId, instanceId))
    .returning({ url: federationPeerUsers.avatarLocalUrl });
  dropAvatarFiles(
    quotaOwner,
    rows.map((r) => r.url),
  );
  await db.delete(federationPeerServers).where(eq(federationPeerServers.instanceId, instanceId));
}

export interface PeerUserRow {
  instanceId: string;
  userId: string;
  username: string;
  displayName: string;
  avatarHash: string | null;
  avatarLocalUrl: string | null;
  updatedAt: number;
}

/** Люди соседа для выпадающего списка во вкладке «Пользователи». */
export async function peerUsers(instanceId: string): Promise<PeerUserRow[]> {
  const rows = await db
    .select()
    .from(federationPeerUsers)
    .where(eq(federationPeerUsers.instanceId, instanceId))
    .orderBy(federationPeerUsers.username);
  return rows.map((r) => ({
    instanceId: r.instanceId,
    userId: r.userId,
    username: r.username,
    displayName: r.displayName,
    avatarHash: r.avatarHash,
    avatarLocalUrl: r.avatarLocalUrl,
    updatedAt: Number(r.updatedAt),
  }));
}

/** Серверы соседа для выпадающего списка во вкладке «Серверы». */
export async function peerServers(instanceId: string) {
  return db
    .select()
    .from(federationPeerServers)
    .where(eq(federationPeerServers.instanceId, instanceId))
    .orderBy(federationPeerServers.name);
}

/** Сколько записей в кеше связки — это и показывает блок «Синхронизация». */
export async function cacheSizes(instanceId: string): Promise<{ users: number; servers: number }> {
  const [u] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(federationPeerUsers)
    .where(eq(federationPeerUsers.instanceId, instanceId));
  const [s] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(federationPeerServers)
    .where(eq(federationPeerServers.instanceId, instanceId));
  return { users: u?.n ?? 0, servers: s?.n ?? 0 };
}
