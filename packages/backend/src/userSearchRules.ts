/**
 * Поиск людей своего инстанса по @имени — чистые правила, БЕЗ базы (05.10, признак `users1`). Ручка —
 * `routes/users.ts` `GET /users/search`, запрос в базу — `db/userSearch.ts`.
 *
 * Решения владельца 05.10: ищем ТОЛЬКО по логину — он уникален без учёта регистра (`routes/auth.ts`, регистрация):
 * точное совпадение первым, затем по началу логина; от 3 знаков; до 8 строк. По отображаемому имени не ищем: оно не
 * уникально, и поиск по нему превращался бы в перебор людей инстанса по буквам. Настройки «не находить меня» нет.
 */

/** Логин — 3–32 знака латиницы, цифр и `_ . -`: та же маска, что у регистрации (`routes/auth.ts`, `registerBody`). */
export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

/** Сколько людей отдаёт поиск. */
export const USER_SEARCH_LIMIT = 8;

/** Предел поисков: 30 в минуту на человека (`rateHit('usearch:' + me, …)`) — на набор с паузой 300 мс хватает с запасом. */
export const USER_SEARCH_RATE = { max: 30, windowS: 60 } as const;

/**
 * Запрос → логин для поиска (нижний регистр) или `null`: искать нечего (ручка отвечает 400). Пробелы по краям и ОДИН
 * «@» впереди срезаются — человек пишет «@bob», как в упоминании. Кириллица, пробелы внутри, короче 3 или длиннее 32 —
 * не логин.
 */
export function normalizeUserQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const q = raw.trim().replace(/^@/, '');
  return USERNAME_RE.test(q) ? q.toLowerCase() : null;
}

/**
 * Свой живой человек инстанса: не удалён, не гость с другого инстанса, почта подтверждена, аккаунт одобрен. Только таких
 * находит поиск и только с такими политика `anyone` разрешает начать переписку (`dmRules.decideDmOpen`, `peerReachable`).
 * То же условие — `WHERE` в `db/userSearch.ts`: менять оба места вместе.
 */
export function reachableUser(u: {
  deletedAt: Date | null;
  homeInstanceId: string | null;
  verified: boolean;
  approvedAt: Date | null;
}): boolean {
  return !u.deletedAt && u.homeInstanceId === null && u.verified && !!u.approvedAt;
}

/**
 * Порядок выдачи: логин целиком (без регистра) первым, затем по началу — короче раньше, при равной длине по алфавиту
 * (побайтно, как `COLLATE "C"`); логин, который с запроса НЕ начинается, не выдаётся; не больше `limit`.
 * То же правило — `ORDER BY` в `db/userSearch.ts` (там оно нужно, чтобы `LIMIT` не срезал точное совпадение среди
 * многих «по началу»): менять оба места вместе.
 */
export function rankUserHits<T extends { username: string }>(
  rows: readonly T[],
  q: string,
  limit: number = USER_SEARCH_LIMIT,
): T[] {
  const needle = q.toLowerCase();
  const key = (r: T) => r.username.toLowerCase();
  return rows
    .filter((r) => key(r).startsWith(needle))
    .sort((a, b) => {
      const exact = Number(key(b) === needle) - Number(key(a) === needle);
      if (exact !== 0) return exact;
      if (a.username.length !== b.username.length) return a.username.length - b.username.length;
      return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
    })
    .slice(0, Math.max(0, limit));
}
