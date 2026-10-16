/**
 * ЛС между инстансами, Э1 (#141, `fedm1`): поиск людей СВЯЗАННЫХ инстансов для «Написать» — по кешу каталога соседа
 * (`federation_peer_users`), без похода к соседу. `@имя@домен` — точное имя у инстанса с этим доменом; просто имя — по
 * началу у всех рабочих связок. Скрытых от соседей (Ф11) каталог соседа не отдаёт — здесь их и нет.
 * Связки на паузе, разорванные, без доверия — не ищутся (написать им всё равно нельзя).
 */
import type { RemoteUserHit } from '@gusvoice/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { federationLinks, federationPeerUsers } from '../db/schema.js';
import { USER_SEARCH_LIMIT } from '../userSearchRules.js';
import { instanceLabel } from './instanceLabels.js';

/**
 * `handle` — разобранный `@имя@домен` (`parseRemoteHandle`, имя и домен в нижнем регистре) или `{ prefix }` — уже
 * нормализованный запрос `normalizeUserQuery`.
 */
export async function searchRemoteUsers(
  query: { username: string; domain: string } | { prefix: string },
): Promise<RemoteUserHit[]> {
  const active = await db
    .select({ instanceId: federationLinks.instanceId, domain: federationLinks.domain })
    .from(federationLinks)
    .where(eq(federationLinks.state, 'active'));
  const ids =
    'domain' in query ? active.filter((l) => l.domain.toLowerCase() === query.domain).map((l) => l.instanceId) : active.map((l) => l.instanceId);
  if (ids.length === 0) return [];
  const name = sql`lower(${federationPeerUsers.username})`;
  const rows = await db
    .select({
      instanceId: federationPeerUsers.instanceId,
      userId: federationPeerUsers.userId,
      username: federationPeerUsers.username,
      displayName: federationPeerUsers.displayName,
      avatarUrl: federationPeerUsers.avatarLocalUrl,
    })
    .from(federationPeerUsers)
    .where(
      and(
        inArray(federationPeerUsers.instanceId, ids),
        'domain' in query ? sql`${name} = ${query.username}` : sql`starts_with(${name}, ${query.prefix})`,
      ),
    )
    .orderBy(
      'domain' in query ? sql`1` : sql`${name} = ${query.prefix} DESC`,
      sql`length(${federationPeerUsers.username})`,
      sql`${name} COLLATE "C"`,
    )
    .limit(USER_SEARCH_LIMIT);
  return rows.map((r) => {
    const label = instanceLabel(r.instanceId);
    return {
      instanceId: r.instanceId,
      homeUserId: r.userId,
      username: r.username,
      displayName: r.displayName,
      avatarUrl: r.avatarUrl ?? null,
      instance: { name: label.name, domain: label.domain || (active.find((l) => l.instanceId === r.instanceId)?.domain ?? '') },
    };
  });
}
