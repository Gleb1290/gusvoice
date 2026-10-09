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
    // «Был(а) в сети» (С1, миграция 0098): след активности стирается; у надгробия время захода скрыто от всех.
    lastSeenAt: null,
    lastSeenPrivacy: 'nobody',
    hideReadTime: false,
    // Настройки уведомлений (G38, миграция 0111): к умолчанию — у надгробия ни устройств, ни уведомлений.
    notifyView: 'all',
    notifyGroups: true,
    notifyDm: true,
    notifyRepeat: 0,
    // Удалённый аккаунт не «одобрен»: войти им нельзя ни при какой политике (миграция 0062, #142).
    approvedAt: null,
    // Скрытие от соседей — решение про живого человека; у удалённого прятать уже нечего, и соседям
    // в любом случае уедет надгробие «удалён» (F2, §5.2).
    hiddenFromPeers: false,
    /**
     * 🔴 Время правки каталога обязано сдвинуться на момент удаления (F2, §5.2).
     *
     * Иначе надгробие «этот человек удалён» осталось бы со старой отметкой — и дельта соседа,
     * которая спрашивает «что изменилось ПОСЛЕ такого-то момента», не увидела бы его НИКОГДА.
     * Человек остался бы в списках у соседей навсегда, до следующей суточной сверки.
     */
    directoryUpdatedAt: now,
    /**
     * Теневая строка гостя обезличивается ТАК ЖЕ, но значок инстанса остаётся (F3, §5.6.2): в чужой
     * переписке человек должен остаться «Удалённый пользователь · 🌐 «Друзья»», а не потерять
     * происхождение. Поэтому `home_instance_id` и `home_user_id` СОХРАНЯЮТСЯ (они же — личность, по
     * которой действует запрет на инстанс), а профиль и поколение уходят.
     *
     * 🔴 `homeGen: 0` — не косметика: поколение нужно только живому гостю, а обезличенная строка не
     * пускает никого (`deletedAt` + поднятое `tokenGeneration`). Оставить прежнее значило бы хранить
     * пропуск, к которому больше нет замка.
     */
    homeUsername: null,
    homeAvatarHash: null,
    homeGen: 0,
    deletedAt: now,
  } as const;
}
