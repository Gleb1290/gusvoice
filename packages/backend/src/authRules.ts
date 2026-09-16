/**
 * Чистые правила аутентификации и лимитов — БЕЗ Redis, env, БД и Fastify.
 *
 * Вынесено из `auth.ts` и `authGuard.ts` по просьбе Codex (2026-07-27): оба модуля на импорте
 * читают env и поднимают Redis/Pool, из-за чего пороги нельзя было проверить тестом. Ошибки здесь
 * дорогие в обе стороны: вечный lockout не пускает владельца в его же аккаунт, отсутствие
 * lockout'а открывает перебор пароля, а неверный порог продления внезапно разлогинивает всех.
 */

// ---- Срок жизни токена ---------------------------------------------------------------------

/**
 * Срок жизни токена — от ПОСЛЕДНЕЙ активности, а не от выдачи.
 *
 * Раньше стояло ровно `7d` от момента входа, поэтому людей, сидящих в приложении каждый день, всё
 * равно выкидывало раз в неделю. Теперь токен обновляется на лету, и «протух» означает «неделю не
 * заходил». TTL 8 суток при обновлении раз в сутки даёт гарантию: после последнего запроса токен
 * живёт ещё НЕ МЕНЬШЕ 7 суток. Обновлять на каждый запрос смысла нет — это новая подпись и запись
 * в localStorage на каждый чих.
 */
export const TOKEN_TTL_S = 8 * 24 * 3600;
export const REFRESH_AFTER_S = 24 * 3600;

/** Сколько живёт токен и когда продлевается — для тестов и для документации. */
export const TOKEN_TIMING = { ttlSeconds: TOKEN_TTL_S, refreshAfterSeconds: REFRESH_AFTER_S };

/**
 * Решение о продлении токена.
 *
 * ⚠️ Две ветки «не продлеваем» существуют не для красоты: токен старого образца БЕЗ `iat` продлить
 * нечем (обновится при следующем входе), а отрицательный возраст = разъехавшиеся часы, и продление
 * там плодило бы новую подпись на каждый запрос.
 */
export function shouldRefresh(iat: number | undefined, nowSec: number): boolean {
  if (!iat) return false;
  const age = nowSec - iat;
  if (age < 0) return false;
  return age >= REFRESH_AFTER_S;
}

/**
 * Поколение, с которым сверяется `gen` из токена (`auth.ts tokenGenValid`).
 *
 * Удалённый (обезличенный) аккаунт получает -1 — не совпадает ни с одним выданным поколением, даже текущим:
 * вторая линия на случай, если поднять поколение при удалении почему-то не удалось (F0 #139). Защита не должна
 * держаться на одном шаге. Вынесено для теста по просьбе Codex (#143).
 */
export function effectiveTokenGeneration(u: { gen: number; deletedAt: Date | null }): number {
  return u.deletedAt ? -1 : u.gen;
}

// ---- Фиксированное окно лимитов ------------------------------------------------------------

/**
 * Сколько секунд ждать по счётчику фиксированного окна: 0 — пока под лимитом, иначе остаток окна.
 *
 * `ttl` — то, что вернул Redis (`-1` = ключ без TTL, `-2` = ключа уже нет). В обоих случаях
 * отдаём полное окно: сказать «ждите −1 секунду» хуже, чем перестраховаться.
 */
export function retryAfter(count: number, max: number, ttl: number, windowS: number): number {
  if (count <= max) return 0;
  return ttl > 0 ? ttl : windowS;
}

/** «Слишком много попыток…» for a retry-after in seconds (never says less than 1 min). */
export function retryMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Слишком много попыток. Попробуйте через ${minutes} мин.`;
}

// ---- Lockout по паролю ----------------------------------------------------------------------

export const MAX_FAILS = 5;
export const FAIL_WINDOW_S = 15 * 60; // wrong passwords must land inside this window to add up
export const LEVEL_TTL_S = 24 * 60 * 60; // escalation memory — a quiet day resets to 15 min
export const STEP_MIN = 15;

/**
 * Ключ счётчика — IP И имя, а не одно имя.
 *
 * ⚠️ Ключ только по имени позволил бы запереть ЧУЖОЙ аккаунт: посторонний перебирает пароли, а
 * настоящий владелец не может войти. С парой ip+username у владельца свой чистый счётчик.
 * Имя приводится к нижнему регистру, иначе `Masha`/`masha` считались бы порознь.
 */
export function loginKey(ip: string, username: string): string {
  return `${ip}:${username.toLowerCase()}`;
}

/** Пора ли запирать после этой неудачи. */
export function lockTriggered(fails: number): boolean {
  return fails >= MAX_FAILS;
}

/** Длительность запрета на этой ступени: 15 → 30 → 45 … минут. */
export function lockoutSeconds(level: number): number {
  return level * STEP_MIN * 60;
}
