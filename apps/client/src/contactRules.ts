import { FEATURE_CONTACTS1, type ContactRow } from '@gusvoice/shared';

/**
 * Чистые правила контактов (08.10, #211, сервер `contacts1`, решение владельца 08.10 п.7). Без импортов, кроме общих типов:
 * их тянут `contacts.ts`, `sockets.ts` и компоненты.
 */

/** Сервер умеет контакты. */
export function serverContacts(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CONTACTS1);
}

/** Имя контакта в моих списках: моя подпись, иначе его имя (Telegram показывает имя из контакта). */
export function contactLabel(c: Pick<ContactRow, 'name' | 'displayName'>): string {
  return c.name ?? c.displayName;
}

/** Совпадает ли контакт с запросом поиска: подпись, имя или @логин (без учёта регистра, `@` в начале не мешает). */
export function contactMatches(c: Pick<ContactRow, 'name' | 'displayName' | 'username'>, query: string): boolean {
  const q = query.trim().replace(/^@/, '').toLocaleLowerCase('ru');
  if (!q) return true;
  return [c.name ?? '', c.displayName, c.username].some((s) => s.toLocaleLowerCase('ru').includes(q));
}

/**
 * Порядок списка «Контакты», как у Telegram Desktop (`ContactsBoxController`, режим `SortMode::Online` по умолчанию): кто в сети —
 * сверху, дальше по имени. Чьё время захода мне не видно, считается не в сети (`onlineSet` — только видимые, `lastseen2`).
 */
export function sortContacts<T extends Pick<ContactRow, 'id' | 'name' | 'displayName'>>(list: readonly T[], onlineSet: ReadonlySet<string>): T[] {
  return [...list].sort((a, b) => {
    const on = Number(onlineSet.has(b.id)) - Number(onlineSet.has(a.id));
    if (on !== 0) return on;
    return contactLabel(a).localeCompare(contactLabel(b), 'ru');
  });
}

/** Человек у меня в контактах? `list === null` (ещё не загружен) — нет. */
export function isContact(list: readonly Pick<ContactRow, 'id'>[] | null, userId: string): boolean {
  return !!list?.some((c) => c.id === userId);
}

/**
 * Как показать человека в ЛС и группах (решение владельца 08.10 п.27, как Telegram — у него сервер сам подменяет имя на
 * имя из контакта, `data_session.cpp` `setName(fname, lname, …)`): моя подпись контакта, иначе его имя `fallback`. Пустая
 * подпись и не контакт — его имя. В каналах серверов не применяется: там ник сервера (`memberName.ts`).
 */
export function personLabel(list: readonly Pick<ContactRow, 'id' | 'name'>[] | null | undefined, userId: string, fallback: string): string {
  const n = list?.find((c) => c.id === userId)?.name?.trim();
  return n ? n : fallback;
}
