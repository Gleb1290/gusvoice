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

declare const userIdBrand: unique symbol;

/**
 * Идентификатор ЧЕЛОВЕКА. Обычная строка, но помеченная, и пометка эта — вся суть #140.
 *
 * Типы `id` и `username` в базе одинаковые, поэтому компилятор раньше не мешал передать в проверку
 * прав логин вместо id — именно так дыра и появилась. Теперь прикладная проверка (`isSuperAdmin`
 * в `auth.ts`) принимает `UserId`, а пометить строку можно только вслух, через `asUserId`: такое
 * место видно и на ревью, и грепом.
 *
 * ⚠️ Нижние `isSuperAdminId` / `claimsAreSuperAdmin` намеренно берут обычную строку: они сравнивают
 * два значения, которые им дали, и защищать надо ВХОД в приложение, а не это сравнение.
 */
export type UserId = string & { readonly [userIdBrand]: true };

/** Пометить строку как id человека. Только там, где точно id (первичный ключ `users.id`, `sub` токена). */
export function asUserId(value: string): UserId {
  return value as UserId;
}

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

/**
 * Привязка супер-админа целиком — чтение, решение, запись, объявление в лог (#143).
 *
 * Здесь нет ни базы, ни env: всё приходит зависимостями, поэтому порядок шагов и то, ЧТО именно
 * записывается, проверяются тестом. Решение по-прежнему принимает `decideSuperAdminBinding`.
 *
 * ⚠️ Поиск по логину делается ТОЛЬКО когда записи нет вовсе (не «id не прочитался»): битая запись —
 * fail-closed, иначе смена `SUPERADMIN_USERNAME` отдала бы инстанс другому человеку.
 */
export interface BindingIo {
  /** Сырое значение записи `SUPERADMIN_ID_KEY` или `undefined`, если строки нет. */
  readStored(): Promise<{ value: unknown } | undefined>;
  /** Есть ли в базе пользователь с таким id. */
  userExists(userId: string): Promise<boolean>;
  /** id пользователя с логином РОВНО таким (регистр важен) или `null`. */
  findIdByUsername(username: string): Promise<string | null>;
  /** Записать первую привязку (не перетирая чужую запись). */
  persist(userId: string): Promise<void>;
  /** `SUPERADMIN_USERNAME` из env как есть. */
  envUsername: string;
  /** Куда объявить решение. */
  log(level: 'info' | 'warn', message: string): void;
}

export async function bindSuperAdminWith(io: BindingIo): Promise<BindingDecision> {
  const stored = await io.readStored();
  const rawId = (stored?.value as { userId?: unknown } | undefined)?.userId;
  const storedId = typeof rawId === 'string' && rawId.trim() !== '' ? rawId : null;
  // Строка есть, а id в ней не читается — это НЕ «записи нет» (fail-closed, см. decideSuperAdminBinding).
  const storedMalformed = !!stored && storedId === null;

  const storedExists = storedId ? await io.userExists(storedId) : false;
  const envUsername = io.envUsername.trim();
  const usernameMatchId = !stored && envUsername ? await io.findIdByUsername(envUsername) : null;

  const decision = decideSuperAdminBinding({
    storedId,
    storedMalformed,
    storedExists,
    envUsername,
    usernameMatchId,
  });

  if (decision.persist && decision.superAdminId) await io.persist(decision.superAdminId);
  if (decision.log) io.log(decision.log.level, decision.log.message);
  return decision;
}

/**
 * Порядок первого запуска: сначала создать аккаунт супер-админа, потом привязать права к его id.
 *
 * Порядок здесь не косметика: `bind` ищет аккаунт, которого до `seed` ещё нет, и перепутанные шаги
 * дали бы свежую коробку без супер-админа до второго перезапуска. Поэтому он выражен отдельной
 * функцией, а не двумя вызовами подряд в `index.ts`, где его легко переставить.
 *
 * ⚠️ Упал сид — привязку НЕ делаем: это отказ старта, а не «продолжим как получится».
 */
export async function bootstrapIdentity(steps: {
  seedSuperAdmin(): Promise<void>;
  bindSuperAdmin(): Promise<void>;
}): Promise<void> {
  await steps.seedSuperAdmin();
  await steps.bindSuperAdmin();
}
