/**
 * Правило «как звать человека на этом сервере» — ЧИСТОЕ, без импорта стора (#19/#73).
 *
 * Отдельным файлом от `memberName.ts` (там хук) по уже знакомой причине: модуль, тянущий стор,
 * непроверяем — тест падает на «window is not defined» ещё до первой проверки, потому что стор
 * тянет за собой `config.ts`. Это четвёртый такой случай после `ogParse`, `afkRules` и `pollRules`.
 *
 * Правило: считает — значит живёт отдельно от того, что знает про стор, базу и окно браузера.
 */

/** Ник или обычное имя. Пробельный ник игнорируем — иначе человек остался бы без имени. */
export function resolveName(nickname: string | null | undefined, displayName: string): string {
  const n = nickname?.trim();
  return n ? n : displayName;
}

/** Как звать этого человека, если он есть в ростере; иначе — как пришло. */
export function nameFromRoster(
  roster: Map<string, string | null>,
  userId: string,
  fallback: string,
): string {
  return resolveName(roster.get(userId), fallback);
}
