/**
 * Кто супер-админ инстанса — чистые правила, БЕЗ базы и env (#140).
 *
 * 🔴 **Супер-админ — это ЧЕЛОВЕК (id), а не строка логина.** Раньше права выдавались любому, чей
 * `username` совпадал с `SUPERADMIN_USERNAME`. Это держалось только на уникальности логина внутри
 * одного инстанса, а федерация (#139) и любые будущие сопоставления людей по логину или почте
 * отдали бы чужому человеку права инстанса: на инстансе друга можно зарегистрироваться с тем же
 * логином. Правило на будущее: **личность = `(instance_id, user_id)`, логин и почта никогда не ключ**.
 *
 * Как это устроено:
 * 1. При старте id супер-админа читается из `instance_settings` (ключ `SUPERADMIN_ID_KEY`).
 * 2. Записи нет — ОДИН РАЗ ищем пользователя с логином ровно `SUPERADMIN_USERNAME` и записываем его id.
 *    Так уже работающий инстанс переезжает сам, а свежая коробка привязывает аккаунт из сида.
 * 3. Запись есть — env больше НЕ спрашиваем. Смена `SUPERADMIN_USERNAME` в `.env` права не переносит:
 *    иначе переименованный логин или опечатка в `.env` молча отдавали бы инстанс другому человеку.
 */

/** Ключ в `instance_settings`: `{ userId }`. */
export const SUPERADMIN_ID_KEY = 'superadmin_user_id';

export interface BindingInput {
  /** id из `instance_settings`, если запись есть. */
  storedId: string | null;
  /**
   * Запись в `instance_settings` ЕСТЬ, но id в ней не читается (не строка, пустая строка). Не путать с
   * отсутствием записи: см. `decideSuperAdminBinding`.
   */
  storedMalformed?: boolean;
  /** Существует ли пользователь с `storedId`. Спрашивается только когда `storedId` задан. */
  storedExists: boolean;
  /** `SUPERADMIN_USERNAME` из env (может быть пустым). */
  envUsername: string;
  /** id локального пользователя с логином РОВНО `envUsername` (регистр важен) или `null`. */
  usernameMatchId: string | null;
}

export interface BindingDecision {
  /** Кого считать супер-админом до следующего перезапуска. `null` — никого. */
  superAdminId: string | null;
  /** Записать `superAdminId` в `instance_settings` (первая привязка). */
  persist: boolean;
  /** Что сказать в лог — громко, если супер-админа не получилось. */
  log: { level: 'info' | 'warn'; message: string } | null;
}

/**
 * Решить, кто супер-админ.
 *
 * ⚠️ Привязанный id выигрывает у логина из env ВСЕГДА — даже если логин теперь указывает на другого
 * человека. Это и есть исправление #140; откат к «сверять логин» этот случай и ломает.
 * ⚠️ Привязанный id, которого нет в базе, НЕ заменяется поиском по логину: пропажа аккаунта — повод
 * для человека разобраться, а не для автоматики назначить нового супер-админа.
 */
export function decideSuperAdminBinding(input: BindingInput): BindingDecision {
  const { storedId, storedExists, envUsername, usernameMatchId } = input;

  // 🔴 Битая запись — fail-closed, а не «записи нет» (нашёл Codex 15.09). Иначе битая строка вела к
  // привязке по логину из env, запись не исправлялась (`onConflictDoNothing`), и после смены env следующий
  // перезапуск отдавал права другому человеку — ровно то, что #140 запрещает.
  if (input.storedMalformed) {
    return {
      superAdminId: null,
      persist: false,
      log: {
        level: 'warn',
        message:
          `[superadmin] запись '${SUPERADMIN_ID_KEY}' в instance_settings повреждена — супер-админа нет. ` +
          `Исправьте её вручную ({"userId": "<id>"}) или удалите, чтобы привязать заново по SUPERADMIN_USERNAME.`,
      },
    };
  }

  if (storedId) {
    if (!storedExists) {
      return {
        superAdminId: null,
        persist: false,
        log: {
          level: 'warn',
          message:
            `[superadmin] привязанный супер-админ ${storedId} не найден в базе — супер-админа нет. ` +
            `Чтобы привязать заново по SUPERADMIN_USERNAME, удалите строку '${SUPERADMIN_ID_KEY}' из instance_settings и перезапустите бэкенд.`,
        },
      };
    }
    return { superAdminId: storedId, persist: false, log: null };
  }

  if (!envUsername) {
    return { superAdminId: null, persist: false, log: null };
  }

  if (!usernameMatchId) {
    return {
      superAdminId: null,
      persist: false,
      log: {
        level: 'warn',
        message:
          `[superadmin] SUPERADMIN_USERNAME="${envUsername}" задан, но такого пользователя нет — супер-админа нет. ` +
          `Привязка произойдёт при следующем запуске после появления аккаунта (регистр логина важен).`,
      },
    };
  }

  return {
    superAdminId: usernameMatchId,
    persist: true,
    log: {
      level: 'info',
      message: `[superadmin] супер-админ привязан к id ${usernameMatchId} (логин "${envUsername}"). Дальше права определяются только по id.`,
    },
  };
}

/** Супер-админ ли этот пользователь. Сравнивается ТОЛЬКО id. */
export function isSuperAdminId(userId: string | null | undefined, superAdminId: string | null): boolean {
  return !!userId && !!superAdminId && userId === superAdminId;
}

/**
 * Супер-админ ли владелец токена.
 *
 * 🔴 Смотрим `sub`, а НЕ `username` из токена: логин в токене — это отпечаток на момент выдачи,
 * и права по нему — та же ошибка, что и в `isSuperAdmin` по логину.
 */
export function claimsAreSuperAdmin(claims: { sub: string; username?: string }, superAdminId: string | null): boolean {
  return isSuperAdminId(claims.sub, superAdminId);
}
