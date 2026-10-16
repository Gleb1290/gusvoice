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

/**
 * Участник голоса → (кого искать в ростере, как звать, если ростер не знает). Локальный участник LiveKit до подключения /
 * после обрыва приходит с пустыми `identity` и `name` (B11, 10.10: своя плитка «(вы)» без имени) — тогда это я: подставляем
 * мой id и моё имя. У чужого пустого имени подстановки нет (его имя — не моё).
 */
export function voiceNameSource(
  p: { identity: string; name?: string | null; isLocal?: boolean },
  me: { id: string; displayName: string } | null,
): { id: string; fallback: string } {
  const fallback = p.name || p.identity || (p.isLocal && me ? me.displayName : '');
  return { id: p.identity || (p.isLocal && me ? me.id : ''), fallback };
}
