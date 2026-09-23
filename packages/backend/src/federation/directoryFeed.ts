/**
 * Что мы отдаём соседу: наш каталог людей и открытых серверов (#139, F2, §5.2 и §5.3).
 *
 * Правила «кого показывать» — в `directoryRules.ts` и проверяются без базы; здесь настоящие запросы,
 * страницы и часы.
 *
 * 🔴 Разница между дельтой и полной выдачей не в объёме, а в СМЫСЛЕ пропущенной записи:
 *  - в дельте молчание значит «не менялось», поэтому исчезновение обязано приехать НАДГРОБИЕМ;
 *  - в полной выдаче молчание значит «этого больше нет», и надгробия не нужны — сосед заменяет кеш
 *    целиком.
 * Перепутать их местами — тихо оставить у соседа удалённых людей навсегда.
 */

import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  type FedDirectoryEntry,
  type FedDirectoryPage,
  type FedServerEntry,
  type FedServerPage,
} from '@gusvoice/shared';
import { FED_DIRECTORY_REMOVED } from '@gusvoice/shared';
import { db } from '../db/index.js';
import { serverFederationExclusions, serverMembers, servers, users } from '../db/schema.js';
import { directoryEntryOf, mediaHashOf, nextCursorOf, type DirectoryQuery } from './directoryRules.js';

/** Строки идут по паре (время правки, идентификатор) — см. `nextCursorOf`. */
function afterCondition(column: unknown, idColumn: unknown, after: { updatedAt: number; id: string } | null) {
  if (!after) return undefined;
  // Сравнение ПАРЫ, а не двух условий через OR: у нескольких записей бывает одно и то же время
  // правки, и по одному только времени страница либо повторяла бы их, либо теряла.
  return sql`(${column}, ${idColumn}) > (${new Date(after.updatedAt)}, ${after.id})`;
}

/**
 * Страница каталога людей для конкретного соседа.
 *
 * ⚠️ `instanceId` здесь нужен не для фильтра (каталог у всех соседей один и тот же), а чтобы ответ
 * нельзя было переслать от чужого имени: личность отдающего входит в тело, а тело подписано.
 */
export async function directoryPageFor(
  selfInstanceId: string,
  query: DirectoryQuery,
  now: number,
): Promise<FedDirectoryPage> {
  const conditions = [
    afterCondition(users.directoryUpdatedAt, users.id, query.after),
    query.since === null ? undefined : gt(users.directoryUpdatedAt, new Date(query.since)),
    /**
     * 🔴 Гости с других инстансов — не наши люди (§5.2). Отдай мы их, список людей инстанса C утекал
     * бы к B через нас, причём В ОБЕ стороны: и сам факт, что человек у нас бывает.
     *
     * Отсев стоит ДВАЖДЫ — здесь и в `directoryEntryOf`. Это не перестраховка: запрос считает
     * страницы (курсор берётся по числу строк ИЗ БАЗЫ), и без условия здесь страница из двухсот
     * гостей вернула бы соседу пустоту с курсором — он ходил бы по кругу, а мы гоняли бы базу.
     */
    isNull(users.homeInstanceId),
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      verified: users.verified,
      approvedAt: users.approvedAt,
      deletedAt: users.deletedAt,
      hiddenFromPeers: users.hiddenFromPeers,
      homeInstanceId: users.homeInstanceId,
      directoryUpdatedAt: users.directoryUpdatedAt,
    })
    .from(users)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(users.directoryUpdatedAt), asc(users.id))
    .limit(query.limit);

  const entries: FedDirectoryEntry[] = [];
  for (const row of rows) {
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
    if (!entry) continue;
    // В полной выдаче надгробия лишние: чего нет в ответе, того нет и у соседа.
    if (query.since === null && entry.removed) continue;
    /**
     * 🔴 Наружу причина надгробия ОДНА — `deleted` (аудит 19.09, F-24). Внутри правила различают
     * «скрыт» и «удалён» (это нужно самим правилам и их проверкам), но соседу разница не положена:
     * по надгробию `hidden` он считал, сколько людей скрыто, знал их id и момент скрытия — а id
     * годился как адрес для жалоб и просьб о пушах. Значение `hidden` в протоколе остаётся: его
     * шлют соседи прежних версий, и разбор его понимает.
     */
    entries.push(
      entry.removed === FED_DIRECTORY_REMOVED.hidden ? { ...entry, removed: FED_DIRECTORY_REMOVED.deleted } : entry,
    );
  }

  return {
    instanceId: selfInstanceId,
    entries,
    nextCursor: nextCursorOf(rows, query.limit, (r) => ({ updatedAt: r.directoryUpdatedAt.getTime(), id: r.id })),
    full: query.since === null,
    now,
  };
}

/** Кому из связок этот сервер закрыт отдельным решением держателя (требование 32). */
async function exclusionsFor(instanceId: string, serverIds: string[]): Promise<Set<string>> {
  if (serverIds.length === 0) return new Set();
  const rows = await db
    .select({ serverId: serverFederationExclusions.serverId })
    .from(serverFederationExclusions)
    .where(
      and(
        eq(serverFederationExclusions.instanceId, instanceId),
        inArray(serverFederationExclusions.serverId, serverIds),
      ),
    );
  return new Set(rows.map((r) => r.serverId));
}

/**
 * Страница списка серверов, открытых этому соседу.
 *
 * 🔴 В дельте запрос идёт по ВСЕМ серверам, изменившимся с прошлого раза, а недоступные превращаются
 * в надгробия. Отфильтруй мы их запросом — снятие галочки и исключение по связке вообще не попадали
 * бы в дельту, и сервер остался бы висеть у соседа в списке как открытый.
 */
export async function serverPageFor(
  selfInstanceId: string,
  instanceId: string,
  query: DirectoryQuery,
  now: number,
): Promise<FedServerPage> {
  const conditions = [
    afterCondition(servers.directoryUpdatedAt, servers.id, query.after),
    query.since === null ? undefined : gt(servers.directoryUpdatedAt, new Date(query.since)),
    // В полной выдаче отдаём только открытые: отсутствие и есть «этого сервера у вас нет».
    query.since === null ? eq(servers.federatedAccess, true) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const rows = await db
    .select({
      id: servers.id,
      name: servers.name,
      iconUrl: servers.iconUrl,
      federatedAccess: servers.federatedAccess,
      directoryUpdatedAt: servers.directoryUpdatedAt,
      members: sql<number>`(SELECT COUNT(*)::int FROM ${serverMembers} WHERE ${serverMembers.serverId} = ${servers.id})`,
    })
    .from(servers)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(servers.directoryUpdatedAt), asc(servers.id))
    .limit(query.limit);

  const excluded = await exclusionsFor(
    instanceId,
    rows.map((r) => r.id),
  );

  const list: FedServerEntry[] = [];
  for (const row of rows) {
    const updatedAt = row.directoryUpdatedAt.getTime();
    const open = row.federatedAccess && !excluded.has(row.id);
    if (!open) {
      if (query.since !== null) list.push({ serverId: row.id, updatedAt, removed: true });
      continue;
    }
    list.push({
      serverId: row.id,
      updatedAt,
      name: row.name,
      // Иконку сосед качает тем же ленивым путём, что и аватары: отпечаток здесь, картинка по запросу.
      iconHash: mediaHashOf(row.iconUrl),
      members: row.members,
    });
  }

  return {
    instanceId: selfInstanceId,
    servers: list,
    nextCursor: nextCursorOf(rows, query.limit, (r) => ({ updatedAt: r.directoryUpdatedAt.getTime(), id: r.id })),
    full: query.since === null,
    now,
  };
}

/**
 * Отметить, что запись человека в каталоге изменилась.
 *
 * Зовётся при смене ника, имени, аватара, подтверждении, скрытии и удалении. ⚠️ Пропущенный вызов не
 * ломает федерацию навсегда: суточная полная сверка отдаёт состояние целиком, не глядя на это поле, —
 * она ровно для таких дыр и заведена.
 */
export async function touchDirectoryUser(userId: string, at = new Date()): Promise<void> {
  await db.update(users).set({ directoryUpdatedAt: at }).where(eq(users.id, userId));
}

/** То же для сервера: галочка, имя, иконка. */
export async function touchDirectoryServer(serverId: string, at = new Date()): Promise<void> {
  await db.update(servers).set({ directoryUpdatedAt: at }).where(eq(servers.id, serverId));
}
