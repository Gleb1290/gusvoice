/**
 * Удаление аккаунта = ОБЕЗЛИЧИВАНИЕ, а не стирание строки — чистые правила, без базы (F0, #139, §5.6.2 плана).
 *
 * 🔴 Раньше `DELETE FROM users` уносил каскадом (миграция 0014) ВСЮ переписку человека: сообщения в
 * каналах, ЛС, реакции. Собеседник открывал беседу и видел половину разговора — только свои реплики,
 * без ответов. Решение (требования 26 и 34): **сообщения остаются, личные данные уходят**.
 *
 * Что остаётся: строка с тем же id (на неё ссылаются сообщения, реакции, журнал, итоги сезонов).
 * Что уходит: логин (освобождается для новой регистрации), почта, пароль, 2FA, аватары, статус, Steam,
 * все сессии, членства и роли в серверах, балансы, устройства для пушей, отметки прочтения.
 *
 * ⚠️ Каскад 0014 в схеме НЕ снимается: он срабатывает только на `DELETE`, а удаление аккаунта больше
 * `DELETE` не делает. Остаётся единственный законный `DELETE` — уборка брошенных неподтверждённых
 * регистраций без следа (`cleanup.ts`), и обезличенные строки она обходит.
 */

/** Префикс логина удалённого аккаунта. Регистрация таких логинов не принимает (`isReservedUsername`). */
export const DELETED_USERNAME_PREFIX = 'deleted-';

/** Как удалённый пользователь выглядит в интерфейсе: чат, список ЛС, итоги сезонов. */
export const DELETED_DISPLAY_NAME = 'Удалённый пользователь';

export function deletedUsername(userId: string): string {
  return `${DELETED_USERNAME_PREFIX}${userId}`;
}

/**
 * Логин, который нельзя занять регистрацией: иначе можно завести `deleted-kto-to` и выдавать себя
 * за удалённый аккаунт. Регистр не важен — регистрация и вход сравнивают логины без учёта регистра.
 */
export function isReservedUsername(username: string): boolean {
  return username.trim().toLowerCase().startsWith(DELETED_USERNAME_PREFIX);
}

/** Почему удалить нельзя, или `null`. Текст — для человека. */
export function accountDeleteBlock(input: {
  ownedServers: number;
  isSuperAdmin: boolean;
  alreadyDeleted: boolean;
}): { status: number; error: string } | null {
  if (input.alreadyDeleted) return { status: 404, error: 'not found' };
  // Супер-админ привязан к id (#140): удалив себя, он оставил бы инстанс без супер-админа.
  if (input.isSuperAdmin) return { status: 409, error: 'Аккаунт супер-админа инстанса удалить нельзя' };
  if (input.ownedServers > 0) {
    return { status: 409, error: `Сначала передайте или удалите свои серверы (${input.ownedServers})` };
  }
  return null;
}

/**
 * Поля строки `users` после обезличивания. `unusablePasswordHash` — bcrypt от случайных байтов: не
 * пустая строка и не мусор, чтобы проверка пароля честно отвечала «не подходит», а не падала.
 *
 * ⚠️ `tokenGeneration` здесь не трогается — его поднимает `bumpTokenGeneration`, который заодно
 * сбрасывает кэш поколений: иначе уже выданные токены жили бы ещё до 10 секунд.
 */
export function anonymizedUserFields(userId: string, unusablePasswordHash: string, now: Date) {
  return {
    username: deletedUsername(userId),
    email: null,
    verified: false,
    canCreateServers: false,
    displayName: DELETED_DISPLAY_NAME,
    passwordHash: unusablePasswordHash,
    avatarUrl: null,
    animatedAvatarUrl: null,
    animatedAvatarUnlocked: false,
    animatedAvatarUntil: null,
    economyWelcomeSeenAt: null,
    totpSecret: null,
    totpEnabled: false,
    totpBackupCodes: null,
    presenceStatus: 'invisible',
    presenceAuto: false,
    customStatusEmoji: null,
    customStatusText: null,
    customStatusExpiresAt: null,
    pdConsentAt: null,
    steamId: null,
    steamPersona: null,
    showGameActivity: false,
    // Удалённый аккаунт не «одобрен»: войти им нельзя ни при какой политике (миграция 0062, #142).
    approvedAt: null,
    deletedAt: now,
  } as const;
}
