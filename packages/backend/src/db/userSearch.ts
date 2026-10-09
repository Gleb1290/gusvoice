import type { UserSearchHit } from '@gusvoice/shared';
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { rankUserHits, USER_SEARCH_LIMIT } from '../userSearchRules.js';
import { db } from './index.js';
import { users } from './schema.js';

/**
 * Поиск людей своего инстанса по логину (05.10, `GET /users/search`, признак `users1`). Правила — `userSearchRules.ts`.
 * Отдельным модулем (как `peerQueries.ts`): интеграционный тест зовёт запрос напрямую, без маршрутов и Redis.
 *
 * `q` — уже нормализованный `normalizeUserQuery` (нижний регистр, только `[a-z0-9_.-]`). Кто виден — то же, что
 * `userSearchRules.reachableUser`, плюс «не я»: менять оба места вместе.
 * 🔴 По началу — `starts_with`, а не `LIKE`: `_` в логине для `LIKE` — шаблон «любой знак», и «a_b» находил бы «axb».
 * ⚠️ Индекса по `lower(username)` нет намеренно: людей на инстансе сотни, а не миллионы — проход по таблице дешевле
 * миграции; поиску предел 30 в минуту на человека.
 */
export async function searchLocalUsers(me: string, q: string): Promise<UserSearchHit[]> {
  const name = sql`lower(${users.username})`;
  const rows = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(
      and(
        sql`starts_with(${name}, ${q})`,
        ne(users.id, me),
        isNull(users.deletedAt),
        isNull(users.homeInstanceId),
        eq(users.verified, true),
        isNotNull(users.approvedAt),
      ),
    )
    // Порядок — `rankUserHits`: точное первым, короче раньше, затем побайтно. Здесь он нужен, чтобы `LIMIT` не срезал
    // точное совпадение среди многих «по началу».
    .orderBy(sql`${name} = ${q} DESC`, sql`length(${users.username})`, sql`${name} COLLATE "C"`)
    .limit(USER_SEARCH_LIMIT);
  return rankUserHits(rows, q);
}
