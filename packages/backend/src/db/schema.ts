import type { Attachment, ConvMediaMark, ConvServiceMark, MessageEmbed, MessageForwardedFrom, MessageSticker } from '@gusvoice/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  email: text('email').unique(),
  verified: boolean('verified').notNull().default(false),
  canCreateServers: boolean('can_create_servers').notNull().default(false),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  avatarUrl: text('avatar_url'),
  /**
   * Анимированный аватар (миграция 0048): ОТДЕЛЬНОЕ поле, а не подмена `avatarUrl`.
   *
   * 🔴 Обычный аватар остаётся статичным кадром для списков и оверлея. `prefers-reduced-motion` сам
   * по себе GIF/WebP/APNG не останавливает — это медиазапрос CSS, а крутит анимацию декодер, — да и
   * двадцать анимаций в списке участников это двадцать непрерывных декодирований.
   */
  animatedAvatarUrl: text('animated_avatar_url'),
  /** ⚠️ Наследие: право «навсегда». Заменено сроком аренды ниже, оставлено ради отката кода. */
  animatedAvatarUnlocked: boolean('animated_avatar_unlocked').notNull().default(false),
  /**
   * До какого момента аренда анимированного аватара действует (миграция 0051).
   *
   * 🔴 Срок, а не флаг: аватар стоит инфраструктуры ПОСТОЯННО — мегабайтный файл отдаётся каждому
   * зрителю, — а разовая плата за постоянный расход расходится по смыслу. Единственная награда в
   * каталоге, где это так.
   * ⚠️ Не привязан ни к сезону, ни к календарному месяцу (так решено): ровно 30 дней от покупки.
   */
  animatedAvatarUntil: timestamp('animated_avatar_until', { withTimezone: true }),
  /**
   * Когда человеку показали приветственное окно экономики (миграция 0052). `null` — ещё не показывали.
   * 🔴 На сервере, а не в localStorage: десктоп, браузер и телефон иначе показывали бы его по разу
   * каждый.
   */
  economyWelcomeSeenAt: timestamp('economy_welcome_seen_at', { withTimezone: true }),
  // 2FA (TOTP). Secret is set during setup; totpEnabled flips true only after a code is confirmed.
  // Backup codes are bcrypt-hashed, single-use (a used hash is removed from the array).
  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  totpBackupCodes: jsonb('totp_backup_codes').$type<string[]>(),
  // Presence state ('online' | 'dnd' | 'away' | 'invisible') + optional custom status.
  presenceStatus: text('presence_status').notNull().default('online'),
  // Кто поставил текущий статус: автоматика (`true`) или человек (`false`). Живёт рядом со статусом
  // НАМЕРЕННО — раньше это был `localStorage` каждого клиента, и снять авто-«отошёл» мог только тот
  // клиент, который его поставил (#118, миграция 0033).
  presenceAuto: boolean('presence_auto').notNull().default(false),
  customStatusEmoji: text('custom_status_emoji'),
  customStatusText: text('custom_status_text'),
  customStatusExpiresAt: timestamp('custom_status_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // 152-ФЗ consent: when the user accepted the privacy policy + user agreement (null = not yet).
  pdConsentAt: timestamp('pd_consent_at', { withTimezone: true }),
  // Session revocation (migration 0019): JWTs carry the generation they were minted with;
  // bumping this kills every outstanding token (logout-everywhere, password change/reset).
  tokenGeneration: integer('token_generation').notNull().default(0),
  // Steam link (#40 Phase 1B, migration 0023): SteamID64 + cached persona for display, plus the
  // master "show my game activity" switch that gates BOTH the Steam poller and the desktop local
  // detect reporter. steam_id NULL = not linked.
  steamId: text('steam_id'),
  steamPersona: text('steam_persona'),
  showGameActivity: boolean('show_game_activity').notNull().default(true),
  /**
   * «Был(а) в сети» (С1, миграция 0098, #211): момент последнего входа в сеть или выхода из неё (первый/последний сокет
   * шлюза). `null` — не заходил после миграции («был(а) давно»). Кто видит точное время — `lastSeenPrivacy`
   * (`everyone` | `peers` | `nobody`, по умолчанию `peers` — решение владельца Р-2), правила — `lastSeenRules.ts`.
   */
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  lastSeenPrivacy: text('last_seen_privacy').notNull().default('peers'),
  /** «Скрывать время прочтения» (Telegram `hide_read_marks`): действует, только когда время захода от собеседника скрыто. */
  hideReadTime: boolean('hide_read_time').notNull().default(false),
  /**
   * «Кто может звонить» (миграция 0122, #211, `presence4`): `everyone` | `peers` | `nobody` (как «Время захода»; по умолчанию
   * `everyone` — как было до настройки). Исключения — `privacyExceptions` с ключом `calls`; правило — `callRules.callAllowed`.
   */
  callPrivacy: text('call_privacy').notNull().default('everyone'),
  /**
   * «Кто может мне писать» (миграция 0146, #218, `msgpriv1`): `everyone` | `contacts` (по умолчанию `everyone` — как было).
   * Исключения «Всегда разрешать» — `privacyExceptions` с ключом `messages`; правило — `messagePrivacyRules.messageAllowed`.
   */
  messagePrivacy: text('message_privacy').notNull().default('everyone'),
  /**
   * Настройки уведомлений как у Telegram (G38, миграция 0111, `push2`): «Показывать имя / текст» (`all` | `name` |
   * `nothing`, `shared/notifyView.ts`) и «Уведомления из групп». Чтит пуш (`push.ts`, `convSendFanout.ts`) и клиент.
   */
  notifyView: text('notify_view').notNull().default('all'),
  notifyGroups: boolean('notify_groups').notNull().default(true),
  /**
   * Остаток настроек уведомлений (G38, миграция 0118, `push3`): «Личные сообщения» (`false` — пуш 1:1 не уходит) и
   * «Повторять уведомления» (минуты, `shared/notifyView.ts`: `NOTIFY_REPEAT_MINUTES`, `0` — не повторять; умолчание 60, как
   * у Telegram — миграция 0124).
   */
  notifyDm: boolean('notify_dm').notNull().default(true),
  notifyRepeat: integer('notify_repeat').notNull().default(60),
  /**
   * Когда аккаунт удалён (миграция 0061, F0 #139). Строка НЕ стирается — обезличивается, чтобы переписка
   * осталась (`accountRules.ts`). `null` — живой аккаунт. Вход, поиск по логину/почте и уборка
   * неподтверждённых такие строки обходят.
   */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  /**
   * Когда супер-админ одобрил аккаунт (миграция 0062, мастер установки). Пусто = ждёт одобрения и не
   * может войти — так бывает только при политике регистрации `approval`. Всем, кто был до миграции,
   * отметка проставлена. Правила — `setupRules.ts`.
   */
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  /**
   * Скрыт от соседей (миграция 0066, F2 §5.2.1) — решение АДМИНА ИНСТАНСА, а не самого человека.
   * Убирает только из каталога: войти по ссылке скрытый может, и там он виден как обычный участник.
   */
  hiddenFromPeers: boolean('hidden_from_peers').notNull().default(false),
  /**
   * Служебная строка «автора» входящего вебхука (миграция 0151, #24): не человек. Неподтверждённая, без почты, с непригодным
   * паролем и скрытая от соседей — не находится поиском, входом и каталогом; список людей админки отсекает её по флагу.
   */
  bot: boolean('bot').notNull().default(false),
  /**
   * Когда запись каталога менялась последний раз (миграция 0066) — по нему строится дельта соседу.
   * Пропущенное обновление не ломает федерацию навсегда: суточная полная сверка отдаёт состояние
   * целиком, не глядя на это поле.
   */
  directoryUpdatedAt: timestamp('directory_updated_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * Теневая строка гостя с другого инстанса (миграция 0067, F3 §5.5). `null` — наш собственный человек.
   *
   * 🔴 Гость живёт В ЭТОЙ ЖЕ таблице, а не в своей: внешние ключи на `users` стоят почти везде
   * (сообщения, роли, монеты, тыки, итоги сезонов), и отдельная таблица означала бы вторую ветку в
   * каждом из этих мест. Цена — каждый список «наших людей» обязан спрашивать `home_instance_id IS NULL`.
   */
  homeInstanceId: text('home_instance_id'),
  homeUserId: text('home_user_id'),
  /** Ник ДОМА без домена: домен и название инстанса дорисовываются из связки при показе (§5.5). */
  homeUsername: text('home_username'),
  /**
   * Поколение сессий на доме (§5.6.1). Гостевая сессия со старым поколением мертва сразу — так
   * «выйти везде» перестаёт кончаться на границе своего инстанса.
   */
  homeGen: integer('home_gen').notNull().default(0),
  /** Отпечаток уже скачанного аватара гостя: картинка перекачивается только при его смене (§5.4). */
  homeAvatarHash: text('home_avatar_hash'),
});

export const emailVerifications = pgTable('email_verifications', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
});

// Password-reset codes (forgot-password flow). Separate from email_verifications so a pending
// reset never clobbers a registration/email-change verification. One active code per user.
export const passwordResets = pgTable('password_resets', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
});

export const servers = pgTable('servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  iconUrl: text('icon_url'),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * «Разрешить федеративный доступ» (миграция 0066, F2 §5.3) — ставит ТОЛЬКО админ инстанса
   * (требование 17), владельцу сервера видно только для чтения. Без неё сервер не виден соседям и
   * пригласить на него человека с другого инстанса нельзя.
   */
  federatedAccess: boolean('federated_access').notNull().default(false),
  /** Когда менялось то, что видит сосед: галочка, имя, иконка (миграция 0066). */
  directoryUpdatedAt: timestamp('directory_updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Исключения федеративного доступа по связке (миграция 0066, требование 32).
 *
 * Галочка у сервера открывает его ВСЕМ соседям сразу; здесь перечислено, кому именно не открывать.
 * ⚠️ Внешнего ключа на `federation_links` нет намеренно: осиротевшая строка оставляет сервер
 * ЗАКРЫТЫМ для вернувшегося соседа (безопасная сторона ошибки), а каскад тихо открыл бы его.
 */
export const serverFederationExclusions = pgTable(
  'server_federation_exclusions',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    instanceId: text('instance_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.serverId, t.instanceId] }) }),
);

/**
 * Кастомные эмодзи сервера (#18). Файл в MinIO (`emoji/`), здесь — запись о нём.
 * Имя уникально в пределах сервера: `:pepe:` обязано означать одно и то же в одном чате.
 */
export const serverEmojis = pgTable('server_emojis', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  // Удаление автора не уносит эмодзи: им пользуется весь сервер, а не только загрузивший.
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Импортированный из Telegram набор стикеров (#68). Файлы в MinIO (`stickers/`), здесь — записи.
 * Имя набора уникально в пределах сервера: повторный импорт иначе двоил бы картинки в пикере.
 */
export const stickerPacks = pgTable('sticker_packs', {
  id: text('id').primaryKey(),
  // NULL — набор общего каталога инстанса (миграция 0092, стикеры в ЛС): его видит любой человек инстанса.
  serverId: text('server_id').references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  title: text('title').notNull(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const stickers = pgTable('stickers', {
  id: text('id').primaryKey(),
  packId: text('pack_id')
    .notNull()
    .references(() => stickerPacks.id, { onDelete: 'cascade' }),
  // Подпись-эмодзи из Telegram: по ней стикер и ищут в пикере.
  emoji: text('emoji').notNull().default(''),
  url: text('url').notNull(),
  format: text('format', { enum: ['webp', 'tgs', 'webm'] }).notNull(),
  position: integer('position').notNull().default(0),
});

/**
 * «Мои наборы» стикеров человека (миграция 0092, признак `stickers2`): добавленные себе наборы каталога, в его порядке
 * (меньше `position` — выше в панели, новый встаёт первым, как у Telegram).
 */
export const userStickerPacks = pgTable(
  'user_sticker_packs',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    packId: text('pack_id')
      .notNull()
      .references(() => stickerPacks.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.packId] }) }),
);

/**
 * Избранные стикеры человека (миграция 0100, признак `stickers3`, С2 порция 2): стикеры каталога, новый — первым, не больше
 * `STICKERS_FAVED_MAX` (как `stickers_faved_limit_default` у Telegram; лишний старый уходит — `stickerLists.ts`).
 */
export const userFavedStickers = pgTable(
  'user_faved_stickers',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    stickerId: text('sticker_id')
      .notNull()
      .references(() => stickers.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.stickerId] }) }),
);

/** Недавние стикеры человека (миграция 0100, `stickers3`): последние отправленные, не больше `STICKERS_RECENT_MAX`. */
export const userRecentStickers = pgTable(
  'user_recent_stickers',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    stickerId: text('sticker_id')
      .notNull()
      .references(() => stickers.id, { onDelete: 'cascade' }),
    usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.stickerId] }) }),
);

/**
 * Папки бесед ЛС (миграция 0093, признак `folders1`, #211 G40): определения отбора как у Telegram — типы (`flags`),
 * явно включённые и исключённые беседы. Системная «Личные сообщения» — `system = 'dms'`, одна на человека.
 */
export const dmFolders = pgTable(
  'dm_folders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    system: text('system'),
    title: text('title').notNull().default(''),
    emoticon: text('emoticon'),
    flags: integer('flags').notNull().default(0),
    includeIds: text('include_ids').array().notNull().default(sql`'{}'`),
    excludeIds: text('exclude_ids').array().notNull().default(sql`'{}'`),
    /** Свой порядок закреплённых в папке сверху вниз (миграция 0131, 09.10, `pinorder2`); пусто — общий по `pinned_at`. */
    pinnedIds: text('pinned_ids').array().notNull().default(sql`'{}'`),
    /** Свой набор закреплённых (миграция 0133, 09.10, `pinset1`): `pinned_ids` — набор и порядок, общий закреп в папке не действует. */
    pinnedOwn: boolean('pinned_own').notNull().default(false),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ userIdx: index('dm_folders_user_idx').on(t.userId, t.position) }),
);

// Custom per-server sound pack: an uploaded audio URL per SoundEvent key (join/leave/…).
export const serverSounds = pgTable(
  'server_sounds',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    url: text('url').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.serverId, t.event] }) }),
);

export const categories = pgTable('categories', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
});

export const channels = pgTable('channels', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  type: text('type', { enum: ['text', 'voice'] }).notNull(),
  position: integer('position').notNull().default(0),
  topic: text('topic'),
  syncedToCategory: boolean('synced_to_category').notNull().default(false),
  // Custom icon-name from the curated channel-icon set; NULL = type default (# / volume).
  icon: text('icon'),
  // The channel's appointed "general" (set by owner / MANAGE_SERVER); NULL = none.
  generalUserId: text('general_user_id').references(() => users.id, { onDelete: 'set null' }),
  // Качество звука голосового канала в кбит/с (#101). NULL = умолчание из shared/voiceQuality.ts.
  voiceBitrate: integer('voice_bitrate'),
});

// Per-channel custom sound overrides — same shape as server_sounds; resolved channel -> server -> synth.
export const channelSounds = pgTable(
  'channel_sounds',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    url: text('url').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.channelId, t.event] }) }),
);

export const roles = pgTable('roles', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: integer('color').notNull().default(0),
  // permission bitfield as a decimal string
  permissions: text('permissions').notNull().default('0'),
  position: integer('position').notNull().default(0),
  hoist: boolean('hoist').notNull().default(false),
  isEveryone: boolean('is_everyone').notNull().default(false),
  mentionable: boolean('mentionable').notNull().default(false),
  // Self-service: members holding this role may grant it to others without MANAGE_ROLES (add-only).
  membersCanAssign: boolean('members_can_assign').notNull().default(false),
  /**
   * Системная роль «Гости» (миграция 0067, F3 §5.9) — как `@everyone`, но для людей с других
   * инстансов. Удалить и выдать руками нельзя.
   *
   * 🔴 Для гостя ЗАМЕНЯЕТ `@everyone`, а не добавляется: роли только прибавляют права, и ограничить
   * гостей, оставив им `@everyone`, было бы нечем.
   */
  isGuests: boolean('is_guests').notNull().default(false),
});

export const serverMembers = pgTable(
  'server_members',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nickname: text('nickname'),
    /**
     * Человек отключил приём тыков НА ЭТОМ сервере (#122, миграция 0038).
     * 🔴 Решение самого человека, а не владельца. Посерверно, потому что травля случается на
     * конкретном сервере и глушить из-за неё остальные незачем.
     */
    pokesOptOut: boolean('pokes_opt_out').notNull().default(false),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Состояние членства (миграция 0067, F3 §5.3.1): `active` или `closed_by_host`.
     *
     * 🔴 Закрытие сервера для гостей НЕ удаляет членство: вернули галочку — человек снова внутри,
     * с историей, ролями и монетами. Удаление значило бы наказывать людей за решение держателя.
     */
    state: text('state').notNull().default('active'),
    /** Как попал на сервер: `invite` — по ссылке. По нему строится отметка §5.2.1 у скрывшего админа. */
    joinMethod: text('join_method'),
    invitedBy: text('invited_by').references(() => users.id, { onDelete: 'set null' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.serverId, t.userId] }) }),
);

export const memberRoles = pgTable(
  'member_roles',
  {
    serverId: text('server_id').notNull(),
    userId: text('user_id').notNull(),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.serverId, t.userId, t.roleId] }) }),
);

export const channelOverwrites = pgTable(
  'channel_overwrites',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    targetId: text('target_id').notNull(),
    targetType: text('target_type', { enum: ['role', 'member'] }).notNull(),
    allow: text('allow').notNull().default('0'),
    deny: text('deny').notNull().default('0'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.channelId, t.targetId] }) }),
);

// Permission overwrites attached to a category; channels with synced_to_category inherit these.
export const categoryOverwrites = pgTable(
  'category_overwrites',
  {
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    targetId: text('target_id').notNull(),
    targetType: text('target_type', { enum: ['role', 'member'] }).notNull(),
    allow: text('allow').notNull().default('0'),
    deny: text('deny').notNull().default('0'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.categoryId, t.targetId] }) }),
);

// Server moderation audit trail (read gated by VIEW_AUDIT_LOG).
export const auditLog = pgTable('audit_log', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  actorId: text('actor_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable('messages', {
  id: text('id').primaryKey(),
  channelId: text('channel_id')
    .notNull()
    .references(() => channels.id, { onDelete: 'cascade' }),
  authorId: text('author_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  attachments: jsonb('attachments').$type<Attachment[]>().notNull().default([]),
  // Стикер лежит КОПИЕЙ в самом сообщении (#68): удаление набора иначе оставило бы пустое сообщение.
  sticker: jsonb('sticker').$type<MessageSticker | null>(),
  // Self-reference; the FK is declared in the migration SQL (avoids a circular type here).
  replyToId: text('reply_to_id'),
  // Роли, которые сообщение реально позвало (#76, `@Модераторы`): решает сервер при отправке, текст заново не разбирается.
  mentionRoles: text('mention_roles').array().notNull().default(sql`'{}'::text[]`),
  // `@everyone`/`@here` в тексте (0152, #76): true — автору хватило права `MENTION_EVERYONE`, зовёт; false — не хватило, текст
  // остался, но никого не зовёт; null — в тексте таких обращений нет, либо сообщение старое/вебхук (считается как «зовёт»).
  mentionEveryone: boolean('mention_everyone'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  // When pinned (MANAGE_MESSAGES); null = not pinned.
  pinnedAt: timestamp('pinned_at', { withTimezone: true }),
  // Пришло через вебхук (0151, #24): его id и имя/аватар НА МОМЕНТ отправки. Без FK — удалённый вебхук сообщения не уносит.
  webhookId: text('webhook_id'),
  webhookName: text('webhook_name'),
  webhookAvatar: text('webhook_avatar'),
  // Карточки вебхука (0153, #24): уже проверенные сервером (`normalizeEmbeds`). `embedsFallback` — `content` собран из
  // карточек для старых клиентов (у сообщения не было своего текста), новый клиент его не показывает.
  embeds: jsonb('embeds').$type<MessageEmbed[] | null>(),
  embedsFallback: boolean('embeds_fallback').notNull().default(false),
});

/**
 * Входящий вебхук канала (миграция 0151, #24). `userId` — служебная строка-автор (`users.bot`), `tokenHash` — sha256 токена
 * (сам токен не хранится). Удаление вебхука строку-автора не трогает: его сообщения остаются.
 */
export const webhooks = pgTable('webhooks', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  channelId: text('channel_id')
    .notNull()
    .references(() => channels.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  tokenHash: text('token_hash').notNull(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

// Emoji reactions on channel messages. One row per (message, user, emoji).
export const messageReactions = pgTable(
  'message_reactions',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    // Момент постановки (миграция 0093): порядок аватарок на чипе реакции.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.messageId, t.userId, t.emoji] }) }),
);

/**
 * Жалоба на собеседника из ЛС (миграция 0107, 08.10, #211, С7, Р-10): держателю СВОЕГО инстанса (супер-админу). Жалоба на
 * гостя соседнего инстанса соседу пока не уходит: личка между инстансами выключена (`FED_ERRORS.dmUnavailable`, до #141).
 * `evidence` — снимок до пяти последних сообщений собеседника, которые жалующийся видел сам.
 */
export const dmReports = pgTable(
  'dm_reports',
  {
    id: text('id').primaryKey(),
    /**
     * Ссылки на users БЕЗ внешнего ключа намеренно: аккаунт «удаляют» обезличиванием, а жалоба — запись держателя, она
     * переживает уход любого из двоих (`accountRules.test.ts` держит перечень FK на users — новая таблица в него не входит).
     */
    reporterId: text('reporter_id').notNull(),
    reportedId: text('reported_id').notNull(),
    conversationId: text('conversation_id'),
    /** Одна из `DM_REPORT_REASONS`. */
    reason: text('reason').notNull(),
    comment: text('comment'),
    evidence: jsonb('evidence')
      .$type<{ messageId: string; text: string; at: number }[]>()
      .notNull()
      .default([]),
    /** `new` | `closed`. */
    status: text('status').notNull().default('new'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStatus: index('dm_reports_status_idx').on(t.status, t.createdAt),
    byPair: index('dm_reports_pair_idx').on(t.reporterId, t.reportedId, t.createdAt),
  }),
);

/** Чёрный список (миграция 0076, #212): `blocker` не получает личных сообщений от `blocked`. */
export const userBlocks = pgTable(
  'user_blocks',
  {
    blockerId: text('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: text('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.blockerId, t.blockedId] }) }),
);

/**
 * Контакты (миграция 0126, #211, `contacts1`): `owner` держит `contact` в своём списке «Контакты»; `name` — его личная подпись
 * (`null` — собственное имя человека). Список личный; удаление аккаунта стирает строки в обе стороны (`accountRows.ts`).
 */
export const userContacts = pgTable(
  'user_contacts',
  {
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    contactId: text('contact_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ownerId, t.contactId] }),
    byContact: index('user_contacts_contact_idx').on(t.contactId, t.ownerId),
  }),
);

/**
 * Исключения «Времени захода» (миграция 0120, #211, G07, `lastseen3`): `owner` показывает (`always`) или не показывает (`never`)
 * своё время захода `target` поверх правила Все / Собеседники / Никто. Список личный; удаление аккаунта стирает строки в обе стороны.
 */
export const lastSeenExceptions = pgTable(
  'last_seen_exceptions',
  {
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetId: text('target_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['always', 'never'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ownerId, t.targetId] }),
    byTarget: index('last_seen_exceptions_target_idx').on(t.targetId, t.ownerId),
  }),
);

/**
 * Исключения приватности по людям для прочих настроек (миграция 0122, #211, `presence4`): `owner` всегда (`always`) или никогда
 * (`never`) разрешает `target` то, что закрывает настройка `key`, поверх правила Все / Собеседники / Никто. Пока ключ один —
 * `calls` («Кто может звонить»). Удаление аккаунта стирает строки в обе стороны (`accountRows.ts`).
 */
export const privacyExceptions = pgTable(
  'privacy_exceptions',
  {
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetId: text('target_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 'messages' — «Кто может мне писать» (миграция 0146, `msgpriv1`; только «Всегда разрешать»).
    key: text('key', { enum: ['calls', 'messages'] }).notNull(),
    kind: text('kind', { enum: ['always', 'never'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ownerId, t.key, t.targetId] }),
    byTarget: index('privacy_exceptions_target_idx').on(t.targetId, t.key, t.ownerId),
  }),
);

/**
 * ЛС, этап 1 (#211, `docs/dm/STAGE1.md`, миграция 0078): беседы (старые `dm_*` сняты миграцией 0135).
 * Правила ключей, журнала и видимости — `convRules.ts`, запись и чтение — `conversations.ts`.
 */
export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['direct', 'group'] }).notNull(),
  /** 1:1 — «меньший:больший» id участников (`convRules.directKey`): одна беседа на пару. */
  directKey: text('direct_key').unique(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  /** Последний выданный ключ порядка (микросекунды, HLC) — следующий берётся под замком этой строки. */
  lastSortKey: bigint('last_sort_key', { mode: 'number' }).notNull().default(0),
  originInstanceId: text('origin_instance_id'),
  /** Название и фото группы (миграция 0099, признак `groups1`); у беседы 1:1 — `null`. */
  title: text('title'),
  avatarUrl: text('avatar_url'),
  /** Э7 часть 1 (#141, миграция 0142): версия состава у дома группы — +1 на каждое изменение состава, названия, фото. */
  groupVersion: integer('group_version').notNull().default(0),
});

export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'member'] }).notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    /** «Прочитано до» — ключ последнего прочитанного сообщения, только вперёд. */
    lastReadKey: bigint('last_read_key', { mode: 'number' }).notNull().default(0),
    /** Черновик (Р7, миграция 0081): между МОИМИ устройствами; пусто — все четыре `null`. */
    draftText: text('draft_text'),
    draftReplyTo: text('draft_reply_to'),
    draftAt: timestamp('draft_at', { withTimezone: true }),
    /** Метка устройства, записавшего черновик: своё эхо клиент не применяет. */
    draftDevice: text('draft_device'),
    /**
     * Беседу открыл ДРУГОЙ, и она ещё не показана этому участнику (миграция 0086, 05.10, признак `users1`): видна ему,
     * только когда в ней есть дошедшее до него сообщение или он сам её открыл (`conversations.ts`, `hiddenFromMe`).
     */
    pending: boolean('pending').notNull().default(false),
    /**
     * Когда Я закрепил беседу наверху списка (миграция 0088, 07.10, признак `conv11`); `null` — не закреплена. Только моя
     * строка: собеседник о закрепе не узнаёт. Лимит — `convRules.CONV_PIN_LIMIT`.
     */
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    /**
     * «Удалить чат» (миграция 0089, 07.10, признак `conv12`): ключ порядка, до которого Я убрал беседу из списка; `null` —
     * не убрана. Видна снова, когда до меня дойдёт сообщение с ключом больше (`conversations.ts`, `clearedFromMe`).
     */
    hiddenKey: bigint('hidden_key', { mode: 'number' }),
    /**
     * Когда Я пометил беседу «непрочитанной» (миграция 0091, 07.10, признак `conv13`); `null` — метки нет. Точка без числа
     * в моём списке; только моя строка, собеседник не видит. Снимается любым чтением (`conversations.markRead`).
     */
    unreadMarkedAt: timestamp('unread_marked_at', { withTimezone: true }),
    /**
     * Когда Я убрал беседу из «Частых» (миграция 0130, 09.10, признак `freq2`, G35); `null` — не убирал. `GET /conv/frequent`
     * не отдаёт её, пока моё последнее сообщение там не новее отметки (`conversations.frequentConversations`).
     */
    frequentHiddenAt: timestamp('frequent_hidden_at', { withTimezone: true }),
    /**
     * Когда Я убрал беседу в архив (миграция 0096, 07.10, признак `archive1`, G41); `null` — не в архиве. Только моя строка:
     * собеседник не узнаёт. Новое сообщение возвращает беседу, если она не заглушена (`conversations.unarchiveOnMessage`).
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /**
     * Когда Я скрыл плашку незнакомца крестиком (миграция 0107, 08.10, признак `stranger1`, С7); `null` — не скрывал. Только
     * моя строка: на всех моих устройствах плашка гаснет вместе (`conv.change`), собеседник не узнаёт. Жалоба тоже скрывает.
     */
    strangerHiddenAt: timestamp('stranger_hidden_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.userId] }),
    userIdx: index('conversation_members_user_idx').on(t.userId),
  }),
);

export const conversationMessages = pgTable('conversation_messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  authorId: text('author_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** id отправки от клиента (уникален на автора) и отпечаток содержимого — повтор без дублей, `convRules.payloadHash`. */
  clientId: text('client_id'),
  payloadHash: text('payload_hash'),
  sortKey: bigint('sort_key', { mode: 'number' }).notNull(),
  content: text('content').notNull().default(''),
  attachments: jsonb('attachments').$type<Attachment[]>().notNull().default([]),
  // Self-reference; the FK is declared in the migration SQL (avoids a circular type here).
  replyToId: text('reply_to_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * Когда собеседник прочёл (С1, миграция 0098; только беседы 1:1): ставит `markRead` тем сообщениям, которые сдвиг
   * «прочитано до» накрыл впервые. Отдаётся автору как «Прочитано в 12:34» (`GET /conv/:id/messages/:mid/read-at`).
   * Одна колонка у участника рядом с `last_read_key` дала бы время ПОСЛЕДНЕГО чтения, а не прочтения этого сообщения.
   */
  readAt: timestamp('read_at', { withTimezone: true }),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  /** Надгробие «удалено у обоих»: текст и вложения стёрты, строка живёт, чтобы удаление дошло догонкой. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  withheld: boolean('withheld').notNull().default(false),
  hiddenFor: text('hidden_for').array().notNull().default(sql`'{}'::text[]`),
  /** G56 (0144, `album1`): элементы альбома, спрятанные «у меня», — `<смотрящий>:<id вложения>` (`convRules.attachmentsForViewer`). */
  hiddenAttachments: text('hidden_attachments').array().notNull().default(sql`'{}'::text[]`),
  originInstanceId: text('origin_instance_id'),
  /** «Переслано от» (миграция 0082, признак `conv5`): автор оригинала, имя на момент пересылки, время оригинала. */
  forwardedFrom: jsonb('forwarded_from').$type<MessageForwardedFrom | null>(),
  /**
   * Отправлено «без звука» (С3, миграция 0084, признак `conv8`): у получателя уведомление без звука, пуш — с
   * `silent: true`. Свойство отправки — пересылка его не переносит.
   */
  silent: boolean('silent').notNull().default(false),
  /** «Без превью ссылки» (миграция 0101, признак `linkprev1`, G19): получатель карточку ссылки под сообщением не рисует. */
  noPreview: boolean('no_preview').notNull().default(false),
  /** «Подпись над медиа» (миграция 0112, признак `media2`, G48): подпись рисуется над фото/альбомом. Пересылка переносит. */
  captionAbove: boolean('caption_above').notNull().default(false),
  /** Одноразовое голосовое прослушано (миграция 0115, `voice3`, G54): файл удалён, `ConvMessage.voiceOnceSpent`. */
  onceSpentAt: timestamp('once_spent_at', { withTimezone: true }),
  /** Одноразовое фото/видео открыто получателем (миграция 0149, `ttlmedia1`, #226): сторож сожжёт, если закрытие не пришло. */
  onceOpenedAt: timestamp('once_opened_at', { withTimezone: true }),
  /**
   * Цитата ответа (миграция 0117, `quote1`, G55): выбранный фрагмент цитируемого или снимок начала его текста у ответа на
   * сообщение ДРУГОЙ беседы (`convRules.ReplyQuoteMark`). `null` — обычный ответ.
   */
  replyQuote: jsonb('reply_quote').$type<{ text: string; offset: number; auto?: true } | null>(),
  /** Стикер (миграция 0092, признак `stickers2`) — КОПИЕЙ, как `messages.sticker`: удаление набора историю не портит. */
  sticker: jsonb('sticker').$type<MessageSticker | null>(),
  /**
   * Служебная строка ленты (`ConvServiceMark`): закреп (миграция 0097, `pins2`, G28) — `{ kind: 'pin', messageId }`; действие
   * в группе (07.10, `groups1`) — `{ kind: 'group', type, users?, title? }`. `null` — обычное сообщение.
   */
  service: jsonb('service').$type<ConvServiceMark | null>(),
  /**
   * Вид сообщения (миграция 0145, `geocontact1`, G69): геопозиция или карточка контакта (`shared/convMedia.ts`); `content` —
   * запасная фраза. `null` — обычное сообщение.
   */
  media: jsonb('media').$type<ConvMediaMark | null>(),
  /** Версия правки (миграция 0136, Э0 ЛС между инстансами): +1 на каждую правку; при слиянии копий побеждает бо́льшая. */
  editVersion: integer('edit_version').notNull().default(0),
  /**
   * Ключ порядка на доме автора у КОПИИ чужого сообщения (миграция 0136, Э0); у своих — `null` (источник — свой `sort_key`).
   * Порядок в ленте всегда по местному `sort_key`: опоздавшее встаёт по приходу (Ф9).
   */
  originSortKey: bigint('origin_sort_key', { mode: 'number' }),
  /**
   * Э5 часть 1 (миграция 0140): сообщение пришло «через» — у инстанса собеседника это id дома автора (тот лежал, автор писал
   * по долгой сессии), у дома автора после сверки — id инстанса, через который оно прошло. `null` — обычное сообщение.
   */
  viaInstanceId: text('via_instance_id'),
  /** Состояние «через» (`FedViaState`): `pending` — ждёт решения дома автора, `confirmed`, `unverified`. */
  viaState: text('via_state'),
  /**
   * Э7 часть 1 (#141, миграция 0142): подпись дома автора (`FedMessageSig` в проводе, shared `federation/convGroup.ts`) у копии
   * чужого сообщения в группе со смешанным составом — хост пересылает её дальше как есть. `null` — своё или 1:1.
   */
  originSig: jsonb('origin_sig').$type<Record<string, unknown>>(),
});

/**
 * «Прослушано» у голосовых сообщений ЛС (миграция 0090, 07.10, признак `voice1`): строка — этот человек нажал «играть» на
 * голосовом. Пишет только не-автор; `ConvMessage.voiceListened` собирается из неё (получателю — по его строке, автору — по
 * строке любого другого участника). Строка уходит каскадом с сообщением.
 */
export const conversationVoiceListens = pgTable(
  'conversation_voice_listens',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => conversationMessages.id, { onDelete: 'cascade' }),
    // Без FK на users: аккаунт не удаляется, а обезличивается (`accountRows.ts`) — строка остаётся, как реакции; ссылка лишь
    // потребовала бы записи в перечень сохраняемых FK (`accountRules.test.ts`).
    userId: text('user_id').notNull(),
    listenedAt: timestamp('listened_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.messageId, t.userId] }) }),
);

/**
 * Голоса опросов ЛС (миграция 0147, `convpoll1`): строка — один отмеченный вариант одного человека. Определение опроса — в
 * `conversation_messages.media` (`shared/convPoll.ts`); подсчёт — `convPollView`. Без FK на users — как «прослушано».
 */
export const convPollVotes = pgTable(
  'conv_poll_votes',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => conversationMessages.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    optionId: text('option_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.messageId, t.userId, t.optionId] }) }),
);

export const conversationMessageReactions = pgTable(
  'conversation_message_reactions',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => conversationMessages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Когда автор сообщения увидел реакцию (G24, миграция 0102); `null` — не видел (непрочитанная реакция). */
    seenAt: timestamp('seen_at', { withTimezone: true }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.messageId, t.userId, t.emoji] }) }),
);

/**
 * Закреп сообщений в беседе (С2, миграция 0083, признак `conv7`): строка — закреп ГЛАЗАМИ одного человека (`userId` —
 * кто его видит). «Для обоих» — строки обоим с `forBoth`, «для меня» — строка себе. Владелец и закрепивший ссылаются на
 * участие в беседе, не на `users`: закреп — часть переписки (как владелец `attachments`). Правила — `convRules.ts`
 * («Закреп»), запись и чтение — `conversations.ts`.
 */
export const conversationPins = pgTable(
  'conversation_pins',
  {
    conversationId: text('conversation_id').notNull(),
    userId: text('user_id').notNull(),
    messageId: text('message_id')
      .notNull()
      .references(() => conversationMessages.id, { onDelete: 'cascade' }),
    pinnedBy: text('pinned_by').notNull(),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }).notNull().defaultNow(),
    /** Поставлен «для обоих» — при откреплении спросить «Также открепить для собеседника». */
    forBoth: boolean('for_both').notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.userId, t.messageId] }),
    owner: foreignKey({
      columns: [t.conversationId, t.userId],
      foreignColumns: [conversationMembers.conversationId, conversationMembers.userId],
    }).onDelete('cascade'),
    pinner: foreignKey({
      columns: [t.conversationId, t.pinnedBy],
      foreignColumns: [conversationMembers.conversationId, conversationMembers.userId],
    }).onDelete('cascade'),
    messageIdx: index('conversation_pins_message_idx').on(t.messageId),
  }),
);

/**
 * Отложенные сообщения (С4, миграция 0085, признак `conv9`): «Отправить позже» (`sendAt`) и «Когда будет в сети»
 * (`whenOnline`, режим — ровно один, CHECK в миграции). Уходят обычной отправкой из планировщика (`scheduled.ts`), строка
 * при этом удаляется той же транзакцией. Видит только автор. Автор ссылается на участие в беседе (как владелец
 * `attachments` и закрепы), а не на `users`: беседа уходит — уходят и её отложенные; удаление аккаунта стирает их явно
 * (`accountRows.anonymizeAccountRows`). Правила — `scheduleRules.ts`, чтение и события — `conversations.ts`.
 */
export const conversationScheduled = pgTable(
  'conversation_scheduled',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    authorId: text('author_id').notNull(),
    /** id отправки при создании (уникален на автора); с ним же уйдёт сообщение (`conversation_messages.client_id`). */
    clientId: text('client_id').notNull(),
    /** Отпечаток запроса СОЗДАНИЯ (`scheduleRules.schedPayloadHash`): повтор с ним — 200, с другим — 409. Не меняется. */
    payloadHash: text('payload_hash').notNull(),
    content: text('content').notNull(),
    replyToId: text('reply_to_id').references(() => conversationMessages.id, { onDelete: 'set null' }),
    silent: boolean('silent').notNull().default(false),
    /** «Подпись над медиа» (миграция 0116, `media2`): уходит в сообщение (ложится в строку только при подписи и вложении). */
    captionAbove: boolean('caption_above').notNull().default(false),
    /** «Отправить позже» — когда; `null` — режим «Когда будет в сети». */
    sendAt: timestamp('send_at', { withTimezone: true }),
    whenOnline: boolean('when_online').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    /** Неудачных попыток подряд и когда следующая (отсрочка — `scheduleRules.schedRetryDelayMs`). */
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastError: text('last_error'),
    /** Сервер больше не пытается: `peer-gone` — писать некому, `error` — попытки кончились. Снимает новое время/режим. */
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failReason: text('fail_reason', { enum: ['peer-gone', 'error'] }),
    /**
     * Вложения отложенного (06.10, миграция 0087, признак `conv10`) — в том же виде, что `conversation_messages.attachments`
     * (доверенные поля из строки `attachments` + подсказки клиента, ссылка — заглушка): порядок и подсказки до отправки.
     * Сами строки `attachments` при этом — `scheduled` со ссылкой `scheduled_id` на эту строку. Пусто — только текст.
     */
    attachments: jsonb('attachments').$type<Attachment[]>().notNull().default([]),
  },
  (t) => ({
    author: foreignKey({
      columns: [t.conversationId, t.authorId],
      foreignColumns: [conversationMembers.conversationId, conversationMembers.userId],
    }).onDelete('cascade'),
    clientUq: uniqueIndex('conversation_scheduled_client_uq').on(t.authorId, t.clientId),
    ownerIdx: index('conversation_scheduled_owner_idx').on(t.conversationId, t.authorId),
  }),
);

/**
 * Журнал изменений на связку (миграция 0136, Э0 ЛС между инстансами, `docs/dm/FEDERATION.md` §3.3): `seq` — номер
 * последней строки для этого соседа, `minSeq` — последний удалённый уборкой (сосед с курсором ниже получит `reset`).
 */
export const fedConvSync = pgTable('fed_conv_sync', {
  instanceId: text('instance_id').primaryKey(),
  seq: bigint('seq', { mode: 'number' }).notNull().default(0),
  minSeq: bigint('min_seq', { mode: 'number' }).notNull().default(0),
  /** Миграция 0141 (исправления ревью 12.10, п. 7): `since` последнего забора соседом — всё до него он забрал. */
  ackedSeq: bigint('acked_seq', { mode: 'number' }).notNull().default(0),
  /** Время последнего забора соседом (`GET /fed/v1/conv/changes`); `null` — не забирал после миграции. */
  ackedAt: timestamp('acked_at', { withTimezone: true }),
});

/** Строка журнала на связку — указатель «запись беседы изменилась»; сама запись отдаётся в текущем виде. */
export const fedConvChanges = pgTable(
  'fed_conv_changes',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => fedConvSync.instanceId, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** `FED_CONV_CHANGE` (shared `federation/convWire.ts`): `msg` | `conv` | `pin` | `read`. */
    kind: text('kind').notNull(),
    entityId: text('entity_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.instanceId, t.seq] }),
    atIdx: index('fed_conv_changes_at_idx').on(t.at),
  }),
);

/**
 * Э5 часть 1 (миграция 0140), дом автора: «через»-сообщения наших людей, забранные у соседа и ждущие отчёта клиента.
 * `entity` — копия соседа в проводе (`serializeConvMessageWire`); строка уходит, когда решение принято и отправлено.
 */
export const fedViaPending = pgTable('fed_via_pending', {
  messageId: text('message_id').primaryKey(),
  instanceId: text('instance_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  authorId: text('author_id').notNull(),
  clientId: text('client_id'),
  entity: jsonb('entity').$type<Record<string, unknown>>().notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Э5 часть 1 (миграция 0140), дом автора: отчёт клиента «это я отправил в обход» (`POST /conv/via-claims`). */
export const fedViaClaims = pgTable(
  'fed_via_claims',
  {
    userId: text('user_id').notNull(),
    clientId: text('client_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.clientId] }) }),
);

/** Э5 часть 1 (миграция 0140), дом автора: последний отчёт клиента человека (`POST /conv/via-claims`). */
export const fedViaReports = pgTable('fed_via_reports', {
  userId: text('user_id').primaryKey(),
  reportedAt: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Курсор приёма журнала соседа: до какого номера забрали (Э2 — забор по звонку в дверь и при восстановлении связи). */
export const fedConvCursor = pgTable('fed_conv_cursor', {
  instanceId: text('instance_id').primaryKey(),
  since: bigint('since', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Журнал изменений на человека (Р4): `pts` — номер последнего изменения, `minPts` — последний удалённый. */
export const userSync = pgTable('user_sync', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  pts: bigint('pts', { mode: 'number' }).notNull().default(0),
  minPts: bigint('min_pts', { mode: 'number' }).notNull().default(0),
});

/** Строка журнала — указатель «сущность изменилась»; ссылается на `user_sync` и уходит вместе с ним. */
export const userChanges = pgTable(
  'user_changes',
  {
    userId: text('user_id')
      .notNull()
      .references(() => userSync.userId, { onDelete: 'cascade' }),
    pts: bigint('pts', { mode: 'number' }).notNull(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    // `pin` (С2, миграция 0083) — «мой список закреплённого в беседе изменился», `messageId` пуст.
    // `sched` (С4, миграция 0085) — «мой список отложенных в беседе изменился», `messageId` пуст, только автору.
    kind: text('kind', { enum: ['msg', 'read', 'conv', 'draft', 'pin', 'sched'] }).notNull(),
    messageId: text('message_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.pts] }),
    atIdx: index('user_changes_at_idx').on(t.at),
  }),
);

/**
 * Вложения новых ЛС (шаг 1в, миграция 0080): файл — в закрытом бакете, строка — владелец, беседа, сообщение, тип по
 * содержимому и состояние. Владелец ссылается на участие в беседе (не на `users`): вложение — часть переписки.
 * Правила — `attachmentRules.ts`, `convRules.attachmentAccess`; запись и выдача — `attachments.ts`, `routes/att.ts`.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    ownerId: text('owner_id').notNull(),
    messageId: text('message_id').references(() => conversationMessages.id, { onDelete: 'set null' }),
    storageKey: text('storage_key').notNull().unique(),
    name: text('name').notNull(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    // `scheduled` (06.10, миграция 0087, `conv10`) — ждёт в отложенном сообщении (`scheduledId`), видит только владелец.
    // `remote` (12.10, миграция 0137, Э3 ЛС между инстансами): файл из копии сообщения соседа, ещё не скопированный к нам
    // (`storage_key` — уже будущий ключ копии, объекта по нему нет); копия доехала — `attached` (`federation/convAtt.ts`).
    state: text('state', { enum: ['pending', 'attached', 'deleted', 'scheduled', 'remote'] }).notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /**
     * Отложенное, за которым файл «припаркован» (только у `scheduled`, CHECK в миграции 0087). Ссылка с ОТЛОЖЕННОЙ проверкой
     * (DEFERRABLE INITIALLY DEFERRED — в миграции; здесь не выражается) и без каскада: строку отложенного нельзя удалить,
     * пока на неё ссылаются её файлы, — писатель в той же транзакции переводит их в `attached`/`deleted` (`scheduled.ts`).
     */
    scheduledId: text('scheduled_id').references(() => conversationScheduled.id),
    /** Э3 (миграция 0137): дом файла у вложения из копии сообщения соседа; у своих файлов пусто. `remote` ⇒ задан (CHECK). */
    originInstanceId: text('origin_instance_id'),
  },
  (t) => ({
    member: foreignKey({
      columns: [t.conversationId, t.ownerId],
      foreignColumns: [conversationMembers.conversationId, conversationMembers.userId],
    }).onDelete('cascade'),
    messageIdx: index('attachments_message_idx').on(t.messageId),
  }),
);

/**
 * Загрузка кусками (`bigfile1`, миграции 0132 и 0134): от начала до сборки; после сборки — строка `attachments` с тем же id.
 * Куски — `attachmentUploadParts` (ETag для сборки + размер для проверки). Правила — `attachmentRules.ts`, ручки — `routes/uploads.ts`.
 */
export const attachmentUploads = pgTable(
  'attachment_uploads',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    ownerId: text('owner_id').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    s3UploadId: text('s3_upload_id').notNull(),
    name: text('name').notNull(),
    declaredType: text('declared_type').notNull(),
    contentType: text('content_type'),
    size: bigint('size', { mode: 'number' }).notNull(),
    partSize: integer('part_size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Сборка идёт с этого момента (0134): «забор» от второго `complete`; старше срока сборки — забирается заново. */
    completingAt: timestamp('completing_at', { withTimezone: true }),
    /** Последний кусок (0134): уборка брошенных — по последней активности, а не по началу. */
    lastPartAt: timestamp('last_part_at', { withTimezone: true }),
  },
  (t) => ({
    member: foreignKey({
      columns: [t.conversationId, t.ownerId],
      foreignColumns: [conversationMembers.conversationId, conversationMembers.userId],
    }).onDelete('cascade'),
    ownerIdx: index('attachment_uploads_owner_idx').on(t.ownerId, t.createdAt),
  }),
);

export const attachmentUploadParts = pgTable(
  'attachment_upload_parts',
  {
    uploadId: text('upload_id')
      .notNull()
      .references(() => attachmentUploads.id, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    etag: text('etag').notNull(),
    size: integer('size').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.uploadId, t.partNumber] }) }),
);

// Persisted read state (migration 0018): unread/mention badges survive reloads.
// last_read_at advances when the client opens the channel (POST .../read); у бесед своё прочитанное (conversation_members).
export const channelReads = pgTable(
  'channel_reads',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.channelId] }) }),
);

// Server bans (BAN_MEMBERS). A banned user is removed from the server and blocked from re-joining
// via invite until unbanned. banned_by goes null if the banning admin's account is later deleted.
export const bans = pgTable(
  'bans',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    bannedBy: text('banned_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.serverId, t.userId] }) }),
);

export const invites = pgTable('invites', {
  code: text('code').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  inviterId: text('inviter_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  maxUses: integer('max_uses'),
  uses: integer('uses').notNull().default(0),
});

// UnifiedPush device registrations (push notifications). One row per (user, device); the backend
// POSTs a wake payload to `endpoint` (our ntfy gateway) when the recipient has no live gateway
// socket. `endpoint` is validated to be on our own ntfy host before use. See routes/push.ts.
export const pushDevices = pgTable(
  'push_devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    endpoint: text('endpoint').notNull(),
    platform: text('platform'),
    /** Ключи шифрования пуша устройства (миграция 0075, #213), base64url. Пусто — пуш без текста. */
    p256dh: text('p256dh'),
    auth: text('auth'),
    /** Что умеет приложение (миграция 0102, Р1 G17): `read1,reply1` через запятую; NULL — старое, ничего. */
    caps: text('caps'),
    /** Часовой пояс устройства, IANA (миграция 0128): повтор уведомления идёт только днём по местному времени. NULL — не знаем, окна нет. */
    tz: text('tz'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ userDevice: unique('push_devices_user_device_uniq').on(t.userId, t.deviceId) }),
);

// Per-user push-mute rules (migration 0021). A row suppresses background pushes to `userId` whose
// source matches (scope, targetId): scope='server' mutes @mention pushes from that server,
// scope='dm_user' mutes DM pushes from that person. In-app delivery is untouched. See push.ts.
export const pushMutes = pgTable(
  'push_mutes',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['server', 'dm_user'] }).notNull(),
    targetId: text('target_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * До какого времени заглушено (миграция 0088, 07.10, признак `conv11`); `null` — навсегда (все прежние строки и
     * вставки старых клиентов). Истёкшая строка = не заглушено (`push.ts`: `activeMute`).
     */
    until: timestamp('until', { withTimezone: true }),
    /**
     * «Выключить звук» (миграция 0091, 07.10, признак `conv13`): уведомление приходит, но без звука и вибрации; `false` —
     * полная заглушка (все прежние строки). Срок — тот же `until`.
     */
    soundOnly: boolean('sound_only').notNull().default(false),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.scope, t.targetId] }) }),
);

/**
 * «Исключения: уведомления включены» (миграция 0127, 08.10, решение владельца 38, признак `push4`): строка — пуш этой беседы
 * уходит, хотя «Личные сообщения» (`users.notify_dm`) или «Уведомления из групп» (`users.notify_groups`) выключены, как
 * Telegram `notify2_<did>` = 0. `targetId` — как у `push_mutes` `dm_user`: id собеседника или `group:<id беседы>`. Заглушка той же
 * беседы снимает строку и наоборот (`push.ts` `setPushMute` / `setPushAlways`).
 */
export const pushAlways = pgTable(
  'push_always',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['dm_user'] }).notNull(),
    targetId: text('target_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.scope, t.targetId] }) }),
);

// Instance-wide settings editable from the admin panel (migration 0022). key -> JSON value.
// Currently key='smtp' → SmtpConfig ({ host, port, secure, user, pass, from }); mailer.ts reads it,
// falling back to the SMTP_* env vars when absent/blank. See settings.ts.
export const instanceSettings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Кэш предпросмотра ссылок (миграция 0024, #64). Хранит и НЕУДАЧИ (`ok=false`) — иначе битая ссылка
// в живом канале уходила бы наружу при каждом рендере сообщения. TTL разный для удач и неудач,
// см. linkPreview.ts.
export const linkPreviews = pgTable(
  'link_previews',
  {
    url: text('url').primaryKey(),
    ok: boolean('ok').notNull(),
    title: text('title'),
    description: text('description'),
    imageUrl: text('image_url'),
    siteName: text('site_name'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ fetchedIdx: index('link_previews_fetched_idx').on(t.fetchedAt) }),
);

/**
 * Опросы (миграция 0025, #17). Отдельно от `messages`: голоса считаются группировкой, а в jsonb
 * каждый голос переписывал бы весь документ и ловил гонку при одновременном голосовании.
 */
export const polls = pgTable('polls', {
  messageId: text('message_id')
    .primaryKey()
    .references(() => messages.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  options: jsonb('options').$type<{ id: string; text: string }[]>().notNull(),
  multi: boolean('multi').notNull().default(false),
  /**
   * true — кто за что проголосовал не показывается НИКОГДА (миграция 0026).
   * По умолчанию именно true: забыли выбрать — лучше не показать лишнего, у раскрытия нет
   * обратной дороги.
   */
  anonymous: boolean('anonymous').notNull().default(true),
  /** null = бессрочный */
  closesAt: timestamp('closes_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Голос за вариант. Составной ключ гасит двойной клик — повторная вставка конфликтует. */
export const pollVotes = pgTable(
  'poll_votes',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => polls.messageId, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    optionId: text('option_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.messageId, t.userId, t.optionId] }) }),
);

/**
 * Отчёт диагностики из клиента (#100 — «во время показа отваливаются Alt+Tab и Win»).
 *
 * Почему в БД, а не файлом на диске: не нужен ни новый том в compose, ни правка деплоя, а читать
 * можно обычным psql. Отчёты редкие и маленькие — их присылают вручную по кнопке, а не потоком.
 */
export const diagReports = pgTable('diag_reports', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Что за отчёт — на будущее, сейчас всегда 'screenshare'. */
  kind: text('kind').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb('payload').$type<unknown>().notNull(),
});

/**
 * Сырая статистика присутствия в голосе — ШАГ 0 экономики GusCoins (`docs/guscoins-plan.md`).
 *
 * 🔴 Секунды и обстановка, а НЕ монеты: ставка и множители ещё не назначены, их назначат по этим
 * данным. По сырым секундам пересчитывается любая формула задним числом, по монетам — никакая.
 */
export const voiceActivity = pgTable(
  'voice_activity',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Без FK намеренно: канал удалят, а факт «человек тут сидел» останется фактом. */
    channelId: text('channel_id').notNull(),
    seconds: integer('seconds').notNull(),
    /** Сколько ДРУГИХ живых людей было в канале — по этому столбцу подбирается множитель компании. */
    peers: integer('peers').notNull(),
    /** ТОЛЬКО собственный микрофон. Действие модератора — в `serverMuted` (миграция 0040). */
    muted: boolean('muted').notNull().default(false),
    /**
     * Замьючен модератором (#124, В1). 🔴 На начисление НЕ влияет и влиять не должен: иначе право
     * `MUTE_MEMBERS` становится кнопкой «лишить заработка», а прекратить это жертва не может.
     * Пишется как факт — чтобы при разборе «почему у него так мало» было видно, что происходило.
     */
    serverMuted: boolean('server_muted').notNull().default(false),
    deafened: boolean('deafened').notNull().default(false),
    screensharing: boolean('screensharing').notNull().default(false),
    /**
     * «Отошёл» в момент среза (миграция 0055) — сам поставил или увела автоматика.
     * ⚠️ Пишем в СЫРЬЁ, а не считаем на лету: ретро и любой пересчёт по журналу обязаны видеть ровно
     * то же состояние, что видел тикер, иначе одни и те же вечера дадут разные числа.
     */
    away: boolean('away').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    serverCreated: index('voice_activity_server_created_idx').on(t.serverId, t.createdAt),
    userCreated: index('voice_activity_user_created_idx').on(t.userId, t.createdAt),
  }),
);

/**
 * Настройки экономики сервера (GusCoins, #117). Строки нет ⇒ экономика выключена.
 *
 * 🔴 Все числа ЗДЕСЬ, а не в коде: ставку и множители владелец крутит ползунками, без релиза.
 */
export const serverEconomy = pgTable('server_economy', {
  serverId: text('server_id')
    .primaryKey()
    .references(() => servers.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  currencyName: text('currency_name').notNull().default('ГусКоины'),
  iconUrl: text('icon_url'),
  ratePer5min: integer('rate_per_5min').notNull().default(10),
  alonePercent: integer('alone_percent').notNull().default(25),
  companyPercent: integer('company_percent').notNull().default(150),
  /**
   * Дневной потолок, монет (миграция 0053: было 400).
   * 🔴 Потолок — СТРАХОВКА ОТ АНОМАЛИИ, а не второй тормоз поверх затухания. При 400 в него
   * упирались 53 % активных дней недельного замера 04.09; при 800 — ни один из 81.
   */
  dailyCap: integer('daily_cap').notNull().default(800),
  decayAfterMinutes: integer('decay_after_minutes').notNull().default(120),
  decayPercent: integer('decay_percent').notNull().default(50),
  // Проценты, а не запреты (миграция 0034): выключенный микрофон не означает отсутствия, а «не
  // слышу» — участия. Между «не начислять» и «как обычно» лежит вся полезная середина.
  mutedPercent: integer('muted_percent').notNull().default(100),
  deafenedPercent: integer('deafened_percent').notNull().default(25),
  /**
   * Процент ставки в статусе «отошёл» (миграция 0055). Четверть, как у «не слышу».
   * ⚠️ Статус ставит и человек сам, и автоматика по простою ОС — второе и закрывает обход
   * «выключить микрофон на железе и уйти», о котором приложение не узнало бы никак.
   */
  awayPercent: integer('away_percent').notNull().default(25),
  /** Через сколько минут ПРИСУТСТВИЯ выплачивать накопленное. ⚠️ Не то же, что ставка «за 5 минут». */
  payoutMinutes: integer('payout_minutes').notNull().default(10),
  /**
   * Доначислять ли всем разницу при ПОВЫШЕНИИ ставки (миграция 0037).
   * 🔴 По умолчанию ВЫКЛЮЧЕНО: при калибровке ползунками балансы не трогаются вовсе, и число в
   * кошельке не может уменьшиться ни при каком движении. Понижение не отнимает никогда.
   */
  compensateOnRaise: boolean('compensate_on_raise').notNull().default(false),
  tipAmount: integer('tip_amount').notNull().default(5),
  tipTaxPercent: integer('tip_tax_percent').notNull().default(20),
  tipDailyOut: integer('tip_daily_out').notNull().default(100),
  tipDailyIn: integer('tip_daily_in').notNull().default(100),
  /**
   * Максимум, который ОДИН человек доносит ОДНОМУ за сутки (миграция 0041, #124 В2). 0 — без предела.
   * 🔴 Массовый тип от разных людей не трогает — только «завалить в одиночку».
   */
  tipDailyPair: integer('tip_daily_pair').notNull().default(25),
  /** Одноразовая отметка: ретроначисление за сухой прогон уже выдано. */
  retroGrantedAt: timestamp('retro_granted_at', { withTimezone: true }),
  /**
   * Последний сезон, итоги которого ЗАМОРОЖЕНЫ в `season_results` (миграция 0043).
   *
   * ⚠️ Отдельно от самого сезона: «сезон сменился» и «итоги записаны» — разные события. Ленивый
   * сброс `season_earned` случается у каждого в свой момент, а заморозка обязана произойти один раз
   * на сервер и ДО того, как счётчики начнут обнуляться.
   */
  closedSeasonId: text('closed_season_id'),
  /**
   * Длина сезона: `quarter` (времена года) или `month` (миграция 0045).
   * ⚠️ Смена разбивки — смена календарной сетки: сезон, начавшийся в том же окне, продолжается под
   * новым именем; полные прошедшие периоды старой сетки подводятся досрочно (`freezeWindow`), а
   * счётчики кошельков пересчитываются по журналу (`seasons.ts`). Панель об этом предупреждает.
   */
  seasonLength: text('season_length', { enum: ['quarter', 'month'] }).notNull().default('quarter'),
  /**
   * Бонус по клику — «вылезающий гусь» (миграция 0047).
   * ⚠️ `gooseBonus = 0` означает «гуся нет вовсе», а не «гусь есть и даёт ноль»: маскот, за
   * которым ничего не следует, читается как поломка.
   * 🔴 Поэтому умолчание сделано НЕнулевым (миграция 0053). Ноль означал, что владелец включает
   * экономику, приветственное окно рассказывает про гуся и дни подряд — а их нет; обещание без
   * механики хуже отсутствия обоих. Поймано на первом же живом прогоне 03.09.
   */
  gooseBonus: integer('goose_bonus').notNull().default(15),
  gooseMinutes: integer('goose_minutes').notNull().default(10),
  /**
   * Надбавка гуся, пойманного В ДЕАФЕНЕ (миграция 0058). Меньше обычной: человек в канале, но вне
   * разговора — та же логика, по которой `deafenedPercent` режет ставку голоса до четверти.
   *
   * ⚠️ Отдельное число, а не процент от `gooseBonus`: процент пришлось бы подбирать под желаемую
   * величину и он молча уезжал бы при каждой правке основной надбавки.
   * 🔴 Состояние берётся в момент ПОИМКИ, а не выхода гуся: гусь ждёт сколько угодно, и состояние
   * на момент его появления к моменту клика бывает многочасовой давности.
   */
  gooseDeafenedBonus: integer('goose_deafened_bonus').notNull().default(5),
  /**
   * Стрик (миграция 0049): монет за каждый день цепочки, потолок цепочки — неделя. `0` — выключен.
   * Умолчание 3 (миграция 0053): полная неделя даёт 84 монеты — заметно, но погоды не делает.
   */
  streakBonus: integer('streak_bonus').notNull().default(3),
  /**
   * Момент ПЕРВОГО включения экономики — граница между ретро и живым начислением (миграция 0039).
   *
   * 🔴 Ретро берёт срезы строго ДО этой отметки, тикер платит за всё, что после. Без границы ретро
   * оплачивало бы второй раз всё, за что уже заплатил тикер (#124, Д1).
   * ⚠️ Ставится один раз и не двигается: повторное включение после выключения границу не переносит.
   */
  accrualSince: timestamp('accrual_since', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Кошелёк «сервер + человек».
 *
 * 🔴 Три счётчика: `balance` тратится, `earnedTotal` не убывает никогда (уровни считаются по нему),
 * `seasonEarned` обнуляется на границе сезона. ⚠️ Два последних растут ТОЛЬКО от своих источников —
 * входящие типы и выдачи модератора пополняют лишь `balance`, иначе уровни покупаются.
 */
export const coinBalances = pgTable(
  'coin_balances',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    balance: integer('balance').notNull().default(0),
    earnedTotal: integer('earned_total').notNull().default(0),
    seasonEarned: integer('season_earned').notNull().default(0),
    seasonId: text('season_id').notNull().default(''),
    /**
     * Невыплаченная ЦЕННОСТЬ в тысячных монеты (миграция 0035).
     *
     * 🔴 Именно ценность, а не секунды: множители (компания, мьют, затухание) применяются в момент
     * среза и застывают здесь. Копили бы секунды — девять минут в одиночку и минута в компании
     * оплатились бы все десять по ставке компании.
     * Переживает отключение: в этом и состоит «заморозка» — строка просто перестаёт расти.
     */
    pendingMilli: integer('pending_milli').notNull().default(0),
    /** Засчитанное присутствие с прошлой выплаты. Перевалило за `payoutMinutes` — платим. */
    pendingSeconds: integer('pending_seconds').notNull().default(0),
    /**
     * Из чего сложится ближайшая выплата (миграция 0036). Копится вместе с `pendingMilli` и
     * обнуляется вместе с ней: обстановка меняется от среза к срезу, и к моменту выплаты её уже
     * не восстановить.
     * ⚠️ Дельты СО ЗНАКОМ — множитель компании бывает надбавкой, а не потерей.
     * Инвариант: `baseMilli + deltaPresence + deltaCompany + deltaDecay === pendingMilli`.
     */
    baseMilli: integer('base_milli').notNull().default(0),
    deltaPresenceMilli: integer('delta_presence_milli').notNull().default(0),
    deltaCompanyMilli: integer('delta_company_milli').notNull().default(0),
    deltaDecayMilli: integer('delta_decay_milli').notNull().default(0),
    /** Сутки экономики: граница — МЕСТНАЯ полночь (МСК), а не полночь UTC. */
    day: text('day').notNull().default(''),
    secondsToday: integer('seconds_today').notNull().default(0),
    earnedToday: integer('earned_today').notNull().default(0),
    givenToday: integer('given_today').notNull().default(0),
    receivedToday: integer('received_today').notNull().default(0),
    /**
     * Всего секунд в голосе за всё время (миграция 0043) — основа УРОВНЯ.
     *
     * 🔴 Уровень считается от времени, а не от монет: монета плавает вместе со ставкой, и уровень,
     * измеренный в ней, либо раздавался бы бесплатно при повышении, либо отбирался. Время не зависит
     * ни от ставки, ни от налога и не переводится с альта. Разбор — в миграции 0043.
     * ⚠️ `bigint` здесь оправдан: в секундах за годы набегает много, и это НЕ деньги — через
     * node-postgres приезжает строкой, но читаем мы его только для расчёта уровня.
     */
    secondsTotal: bigint('seconds_total', { mode: 'number' }).notNull().default(0),
    /**
     * Сколько раз человек поймал бонусного гуся (миграция 0044) — источник уровня.
     * 🔴 Клик нельзя подарить: надо быть на месте и смотреть. Потому и годится в уровень.
     */
    bonusClaims: integer('bonus_claims').notNull().default(0),
    /** Сутки, за которые бонус стрика уже выдан, и длина цепочки (миграция 0049). */
    streakDay: text('streak_day').notNull().default(''),
    streakDays: integer('streak_days').notNull().default(0),
    /**
     * Человеко-дни признания: +1 за каждого РАЗНОГО человека, типнувшего в этот день (миграция 0044).
     * 🔴 Считаем ЛЮДЕЙ, а не монеты: сумма покупается с альта, человек — нет.
     */
    recognitionTippers: integer('recognition_tippers').notNull().default(0),
    /** Сколько разных людей типнули СЕГОДНЯ — для суточного потолка. Катится вместе с сутками. */
    recognitionToday: integer('recognition_today').notNull().default(0),
    optedOut: boolean('opted_out').notNull().default(false),
    /**
     * Человек отключил приём типов (#122). ⚠️ Отдельно от `optedOut`: тот тоже перекрывает входящие
     * типы, но заодно останавливает начисление — а тому, кому надоели типы, не за что переставать
     * зарабатывать.
     */
    tipsOptOut: boolean('tips_opt_out').notNull().default(false),
  },
  (t) => ({ pk: primaryKey({ columns: [t.serverId, t.userId] }) }),
);

/** Журнал операций: единственный способ ответить «было 500, стало 300, куда делись». */
/**
 * Каталог наград сервера (миграция 0042).
 *
 * 🔴 **Цена в МИНУТАХ сидения, а не в монетах.** В монеты пересчитывает сервер в момент покупки по
 * текущей ставке — иначе один сдвиг ползунка разом ломает весь прайс.
 * ⚠️ Строки может не быть: пока владелец не трогал каталог, действуют умолчания из `shopRules.ts`,
 * и магазин работает на свежем сервере без единой настройки.
 */
export const serverShop = pgTable(
  'server_shop',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    item: text('item').notNull(),
    /**
     * Своя цена сервера в минутах; `null` — своей нет, берётся умолчание (миграция 0059).
     *
     * 🔴 Nullable намеренно: строка создаётся и тумблером «продаётся», и тогда наливная цена по
     * умолчанию выглядела бы как решение владельца. Для аватара это стало бы наценкой поверх цены
     * инстанса, которую никто не ставил.
     */
    priceMinutes: integer('price_minutes'),
    enabled: boolean('enabled').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.serverId, t.item] }) }),
);

/**
 * Чек на каждую покупку (миграция 0042).
 *
 * 🔴 Хранит условия СДЕЛКИ, а не только факт: цена в минутах, реально списанные монеты и версия
 * ставки. Ставку первый месяц двигают часто, и без чека спор «сколько это стоило в тот вторник»
 * неразрешим. Уже выданное по новому каталогу не пересчитывается никогда.
 * ⚠️ `expiresAt` — для срочных наград (приоритет речи, звук входа на неделю). У расходников вроде
 * МЕГА пока он `null`: эффект случился и кончился.
 */
export const coinPurchases = pgTable(
  'coin_purchases',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    item: text('item').notNull(),
    priceMinutes: integer('price_minutes').notNull(),
    priceCoins: integer('price_coins').notNull(),
    ratePer5min: integer('rate_per_5min').notNull(),
    /** Кому адресована награда. ⚠️ Уход человека чек НЕ уносит — ссылка обнуляется, строка живёт. */
    targetUserId: text('target_user_id').references(() => users.id, { onDelete: 'set null' }),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    wallet: index('coin_purchases_wallet_idx').on(t.serverId, t.userId, t.createdAt),
    active: index('coin_purchases_active_idx').on(t.serverId, t.item, t.expiresAt),
  }),
);

/**
 * Замороженные итоги сезона (миграция 0043) — НЕИЗМЕНЯЕМЫЕ.
 *
 * 🔴 Победитель записывается, а не вычисляется на лету: поздняя правка данных (ретро, выдача руками,
 * чистка) иначе задним числом отобрала бы корону у того, кто её уже носил. Корона, которую можно
 * отобрать вчерашним днём, — не награда.
 */
export const seasonResults = pgTable(
  'season_results',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    seasonId: text('season_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    earned: integer('earned').notNull(),
    /** 1 — победитель, он носит корону следующий сезон. */
    place: integer('place').notNull(),
    frozenAt: timestamp('frozen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.seasonId, t.userId] }),
    place: index('season_results_place_idx').on(t.serverId, t.seasonId, t.place),
  }),
);

export const coinLedger = pgTable(
  'coin_ledger',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Со знаком: плюс — приход, минус — расход. */
    amount: integer('amount').notNull(),
    /** 'voice' | 'tip.out' | 'tip.in' | 'grant' | 'retro' | 'rescale' */
    reason: text('reason').notNull(),
    refUserId: text('ref_user_id').references(() => users.id, { onDelete: 'set null' }),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ wallet: index('coin_ledger_wallet_idx').on(t.serverId, t.userId, t.createdAt) }),
);

/**
 * Саундборд сервера (миграция 0046, #21).
 *
 * 🔴 Коллекция принадлежит СЕРВЕРУ, а не каналу: в отличие от звуков событий, «своя шутка именно в
 * этом канале» — не то желание, ради которого стоит заставлять заливать одно и то же по десять раз.
 * ⚠️ `createdBy` обнуляется, а не каскадит: уход одного человека не должен молча выносить половину
 * саундборда сервера.
 */
export const serverSoundboard = pgTable(
  'server_soundboard',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    /**
     * Своя цена этого звука В МОНЕТАХ; `null` — действует общая из каталога (она в минутах).
     *
     * 🔴 **Исключение из правила «прайс в минутах» — сознательное** (решение 04.09, миграция
     * 0057). Минуты защищают каталог от сдвига ставки: «полчаса сидения» остаётся собой при любой
     * ставке. Но цены звуков назначают РУКАМИ и по одному («будут ультимативные и так себе»),
     * глядя на балансы людей, — и там минуты мешают: владелец думает «этот выстрел стоит 200
     * монет», а вводит 100 минут и потом ищет, во что они превратились.
     * ⚠️ Плата: после сдвига ставки цены звуков останутся прежними в монетах, то есть подешевеют
     * или подорожают относительно заработка. Пересматривать их придётся руками — как и назначали.
     */
    priceCoins: integer('price_coins'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Порядок добавления — он же порядок кнопок в сетке: перетасовка между заходами убивает
  // мышечную память, ради которой саундборд и нужен.
  (t) => ({ byServer: index('server_soundboard_server_idx').on(t.serverId, t.createdAt) }),
);

/**
 * Связки с соседними инстансами (федерация #139, миграция 0063).
 *
 * 🔴 Первичный ключ — `instanceId` соседа, а не домен: домен сосед может сменить, оставшись собой,
 * а сменившийся ключ = уже другой инстанс. Здесь только ПУБЛИЧНЫЕ ключи соседей — наш собственный
 * корневой ключ лежит отдельным зашифрованным файлом, чтобы дамп базы не уносил печать инстанса.
 */
export const federationLinks = pgTable(
  'federation_links',
  {
    instanceId: text('instance_id').primaryKey(),
    domain: text('domain').notNull(),
    apiBase: text('api_base').notNull(),
    clientOrigin: text('client_origin').notNull(),
    rootKey: text('root_key').notNull(),
    /** Как сосед назвал себя сам; `localName` — как его назвал НАШ держатель (перебивает, §5.1.2). */
    theirName: text('their_name'),
    localName: text('local_name'),
    iconHash: text('icon_hash'),
    /** requested | pending | active | paused | blocked | trust-lost — переходы в `linkRules.ts`. */
    state: text('state').notNull(),
    protocolVersion: integer('protocol_version'),
    features: jsonb('features').$type<string[]>().notNull().default([]),
    /** Замеренное расхождение часов — чтобы вкладка «Федерация» объясняла отказы подписи. */
    clockSkewMs: integer('clock_skew_ms'),
    /** Последний принятый номер события соседа (дедуп) и наш счётчик исходящих. */
    lastEventSeq: bigint('last_event_seq', { mode: 'number' }).notNull().default(0),
    /**
     * Номера соседа, перепрыгнутые дырой и ещё не пришедшие (миграция 0136, Э0 ЛС между инстансами): опоздавшее раннее
     * событие из этого списка принимается, а не выбрасывается повтором (`judgeEvent`, `trackMissingSeqs`).
     */
    missingEventSeqs: jsonb('missing_event_seqs').$type<number[]>().notNull().default([]),
    outEventSeq: bigint('out_event_seq', { mode: 'number' }).notNull().default(0),
    /**
     * Квота хранилища для файлов гостей этой связки и сколько занято (миграция 0068, §5.10).
     * 🔴 На связку, а не «на гостей вообще»: предел обязан называть виновника, иначе держателю
     * нечего решать. `0` = без предела.
     */
    quotaBytes: bigint('quota_bytes', { mode: 'number' }).notNull().default(2147483648),
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /** Наше «подтверждено» соседу не доставлено — досылается (миграция 0074, #199; `linkService.resendConfirmation`). */
    confirmPending: boolean('confirm_pending').notNull().default(false),
  },
  (t) => ({
    byState: index('federation_links_state_idx').on(t.state),
    // Домен НЕ уникален: после перепривязки старая замороженная связка и новая какое-то время
    // делят один домен, и падать на этом нельзя.
    byDomain: index('federation_links_domain_idx').on(t.domain),
  }),
);

/**
 * Одноразовые коды связки (миграция 0063).
 *
 * 🔴 Хранится только ХЕШ секрета, как у пароля: сам код живёт лишь в сообщении, которым держатели
 * обменялись вне приложения. Использованный код не принимается, даже если срок ещё не вышел.
 */
export const federationLinkCodes = pgTable(
  'federation_link_codes',
  {
    id: text('id').primaryKey(),
    secretHash: text('secret_hash').notNull().unique(),
    /** link | rebind — перепривязка после потери или кражи ключа (§5.1.3). */
    purpose: text('purpose').notNull().default('link'),
    previousInstanceId: text('previous_instance_id'),
    // Кто выдал код — только в журнале аудита: иначе это ещё одно место с личными данными,
    // которое пришлось бы чистить при удалении аккаунта ради строки, живущей сутки.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedByInstanceId: text('used_by_instance_id'),
  },
  (t) => ({ byExpiry: index('federation_link_codes_expires_idx').on(t.expiresAt) }),
);

/**
 * Отозванные ключи инстансов (федерация #139, миграция 0064).
 *
 * 🔴 Запись живёт НАВСЕГДА: «ключ неизвестен» — обычное дело (сосед, с которым мы не связаны), а
 * «ключ отозван» — сигнал о возможной краже, и держатель должен его увидеть, а не гадать.
 */
export const federationRevokedKeys = pgTable('federation_revoked_keys', {
  instanceId: text('instance_id').primaryKey(),
  /** На какую личность сосед перешёл — человек сверяет с ней отпечаток при перепривязке. */
  replacedByInstanceId: text('replaced_by_instance_id'),
  domain: text('domain'),
  /** own — мы отозвали свой ключ; peer — отзыв пришёл от соседа. */
  origin: text('origin').notNull().default('peer'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Очередь исходящих событий федерации (#139, миграция 0065).
 *
 * 🔴 Разбирается строго по возрастанию `seq` внутри связки: у события есть порядковый номер, и
 * получатель отбрасывает всё, что меньше последнего принятого. Отправь пятое раньше четвёртого —
 * четвёртое пропадёт как «старое».
 */
export const federationOutbox = pgTable(
  'federation_outbox',
  {
    id: text('id').primaryKey(),
    /** Внешнего ключа нет намеренно: связку могут разорвать и завести заново, а хвост очереди
     *  должен выбрасываться по своим правилам, а не каскадом. */
    instanceId: text('instance_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    eventId: text('event_id').notNull(),
    kind: text('kind').notNull(),
    version: integer('version'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDelivery: index('federation_outbox_delivery_idx').on(t.instanceId, t.seq),
    byAttempt: index('federation_outbox_attempt_idx').on(t.nextAttemptAt),
  }),
);

/**
 * КЕШ каталога соседа (#139 F2, миграция 0066, план §5.2).
 *
 * 🔴 Именно кеш, а не источник правды: упал сосед — выпадающие списки в админке остаются на месте с
 * пометкой «обновлено N назад» (требование 4). Первичный ключ — ПАРА: один и тот же идентификатор у
 * разных инстансов означает разных людей.
 */
export const federationPeerUsers = pgTable(
  'federation_peer_users',
  {
    instanceId: text('instance_id').notNull(),
    userId: text('user_id').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    /** Отпечаток аватара у соседа; картинка качается лениво и только при несовпадении (§5.4). */
    avatarHash: text('avatar_hash'),
    avatarLocalUrl: text('avatar_local_url'),
    avatarCachedHash: text('avatar_cached_hash'),
    /** Часы СОСЕДА на момент правки записи — они же версия состояния. */
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    cachedAt: timestamp('cached_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.instanceId, t.userId] }),
    byName: index('federation_peer_users_name_idx').on(t.instanceId, t.username),
  }),
);

/**
 * Э7 часть 3 (миграция 0143): название и домен инстанса, с которым у нас НЕТ связки, — со слов дома группы (третий человек
 * смешанной группы). Связка всегда старше (`instanceLabels.refreshInstanceLabels`); строка нужна только подписи значка.
 */
export const federationVouchedInstances = pgTable('federation_vouched_instances', {
  instanceId: text('instance_id').primaryKey(),
  name: text('name'),
  domain: text('domain').notNull(),
  vouchedBy: text('vouched_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Серверы соседа, открытые для федеративного доступа (миграция 0066, §5.3) — только просмотр. */
export const federationPeerServers = pgTable(
  'federation_peer_servers',
  {
    instanceId: text('instance_id').notNull(),
    serverId: text('server_id').notNull(),
    name: text('name').notNull(),
    iconHash: text('icon_hash'),
    members: integer('members').notNull().default(0),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    cachedAt: timestamp('cached_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.instanceId, t.serverId] }) }),
);

/**
 * Состояние синхронизации по связке и виду каталога (миграция 0066, §5.4).
 *
 * 🔴 `needsFull` по умолчанию `true`: у новой связки дельте «с момента» не от чего отсчитываться,
 * пока не прошла первая полная выдача.
 */
export const federationSyncState = pgTable(
  'federation_sync_state',
  {
    instanceId: text('instance_id').notNull(),
    /** directory | servers — у каждого вида своё расписание и свой курсор. */
    kind: text('kind').notNull(),
    /** С какого момента просить следующую дельту. Время в часах СОСЕДА, не в наших. */
    since: bigint('since', { mode: 'number' }),
    lastDeltaAt: timestamp('last_delta_at', { withTimezone: true }),
    lastFullAt: timestamp('last_full_at', { withTimezone: true }),
    failures: integer('failures').notNull().default(0),
    needsFull: boolean('needs_full').notNull().default(true),
    lastProblem: text('last_problem'),
    entries: integer('entries').notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.instanceId, t.kind] }) }),
);

/**
 * Индекс членств на ДОМЕ (миграция 0067, F3 §5.5): где наши люди состоят гостями.
 *
 * 🔴 Без него «выйти везде» (§5.6.1) не знало бы, КУДА слать отзыв: гостевая сессия живёт у хоста и
 * от дома не зависит — в этом и была вся устойчивость (требование 4). Отсюда же «Где я гость» (§5.7),
 * рейл на новом устройстве и отметка «скрыт, но виден» у админа (§5.2.1).
 */
export const federationMemberships = pgTable(
  'federation_memberships',
  {
    /** Хост, где человек гость. `userId` — НАШ, в пространстве дома. */
    instanceId: text('instance_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverId: text('server_id').notNull(),
    serverName: text('server_name').notNull().default(''),
    state: text('state').notNull().default('active'),
    /** Как вошёл и кто позвал — в пространстве ХОСТА: этих строк у нас нет, показываем как есть. */
    method: text('method'),
    invitedBy: text('invited_by'),
    reason: text('reason'),
    /** Часы ХОСТА на момент события — они же версия: без неё старое «вышел» затрёт свежее «вернулся». */
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    /** Когда индекс сверялся с хостом целиком (§5.4). Пусто — ещё ни разу. */
    checkedAt: timestamp('checked_at', { withTimezone: true }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.instanceId, t.userId, t.serverId] }) }),
);

/**
 * Поручительства ДОМА: кому из хостов и за кого выдавался токен личности (миграция 0070, аудит F-04).
 *
 * 🔴 Единственное, что дом знает о гостевании САМ, а не со слов хоста. Членства и просьбы разбудить
 * телефон принимаются только для пар, которые здесь есть: иначе связанный сосед объявлял бы гостем
 * любого нашего человека и будил бы его когда захочет.
 */
export const federationGuestGrants = pgTable(
  'federation_guest_grants',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    instanceId: text('instance_id').notNull(),
    firstIssuedAt: timestamp('first_issued_at', { withTimezone: true }).notNull().defaultNow(),
    lastIssuedAt: timestamp('last_issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.instanceId] }) }),
);

/**
 * Журнал отзывов на ДОМЕ (миграция 0067, §5.6.1).
 *
 * 🔴 Хост мог быть выключен в момент, когда человек нажал «выйти везде»: событие до него не доедет, а
 * поднявшись, он обязан забрать пропущенное сам (`GET /fed/v1/revocations?since=`). Без журнала
 * «выйти везде» было бы обещанием, которое держится, только пока все живы.
 */
export const federationRevocations = pgTable('federation_revocations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  /** `sessions` — новое поколение (человек жив); `revoked` — аккаунта больше нет. */
  kind: text('kind').notNull(),
  gen: integer('gen'),
  /** НАШИ часы: хост спрашивает «что после такого-то момента», называя момент из нашего же ответа. */
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  /**
   * Кому адресована запись — хост человека (миграция 0071, аудит run-1 F-26). Строка пишется на
   * КАЖДОГО его хоста, а выдача отбирает строки спрашивающего: иначе любой сосед получал бы
   * хронологию событий безопасности всех наших людей.
   */
  instanceId: text('instance_id').notNull().default(''),
});

/**
 * Запрет чужому человеку на весь инстанс (миграция 0068, F3 §5.11, требование 36).
 *
 * 🔴 Ключ — ГЛОБАЛЬНАЯ личность, а не наша теневая строка: запретить можно того, кто ещё ни разу не
 * заходил, запрет переживает разрыв связки и переезжает при перепривязке. Привяжи его к теневой
 * строке — человек снимал бы запрет, просто зайдя заново.
 */
export const instanceBans = pgTable(
  'instance_bans',
  {
    homeInstanceId: text('home_instance_id').notNull(),
    homeUserId: text('home_user_id').notNull(),
    /** Для держателя и журнала. Человеку причина НЕ показывается — он видит «вход закрыт». */
    reason: text('reason'),
    /** Пусто = навсегда. Истёк — войти можно, но прежние членства не возвращаются. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Снятие не стирает строку — это журнал запретов (§5.11): кто, кого, срок, причина, снятие. */
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedBy: text('removed_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.homeInstanceId, t.homeUserId] }) }),
);

/**
 * Жалобы держателям — наши и к нам (миграция 0068, §5.11, требование 37).
 *
 * `direction`: `out` — мы пожаловались соседу, `in` — сосед нам. Одна таблица, потому что
 * жизненный цикл у них один (отправлена → доставлена → прочитана → отвечена → закрыта) и список
 * во вкладке «Федерация» тоже один.
 */
/**
 * Журнал оповещений держателю о федерации (миграция 0069, §5.10).
 *
 * 🔴 Ключ тройной — вид, связка и подробность: «нужна другая версия» для версии 2 и для версии 3 это
 * РАЗНЫЕ поводы, и второй обязан прозвучать, хотя вид у них один.
 */
export const federationAlerts = pgTable(
  'federation_alerts',
  {
    kind: text('kind').notNull(),
    /** Пустая строка — повод про нас самих (истекает свой ключ подписи), а не про связку. */
    instanceId: text('instance_id').notNull().default(''),
    detail: text('detail').notNull().default(''),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    /** Повод исчез. Строка остаётся: держатель должен видеть, что связка падала. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.kind, t.instanceId, t.detail] }) }),
);

export const federationReports = pgTable(
  'federation_reports',
  {
    id: text('id').primaryKey(),
    direction: text('direction').notNull(),
    instanceId: text('instance_id').notNull(),
    /** Идентификатор в пространстве ОТПРАВИТЕЛЯ: по нему приходит ответ. */
    reportId: text('report_id').notNull(),
    /** На кого жалуются — в пространстве его дома (у входящей это наш собственный человек). */
    reportedUserId: text('reported_user_id').notNull(),
    /** `instance_ban` | `server_ban` — что отправитель уже сделал у себя. */
    action: text('action').notNull(),
    serverName: text('server_name'),
    reason: text('reason'),
    /** 🔴 До пяти сообщений, выбранных ВРУЧНУЮ: переписку соседу хост сам не отдаёт. */
    evidence: jsonb('evidence')
      .$type<{ text: string; at: number; channel: string }[]>()
      .notNull()
      .default([]),
    /** Когда улики менялись в последний раз (миграция 0073, #197 п. 4): по этому держателя оповещают заново. */
    evidenceAt: timestamp('evidence_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status').notNull().default('sent'),
    reply: text('reply'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTarget: index('federation_reports_target_idx').on(t.instanceId, t.reportedUserId, t.createdAt),
  }),
);

/**
 * Журнал федерации уровня инстанса (миграция 0072, аудит 19.09 F-25): события связок, первый вход
 * гостя, отказы гостевых сессий, потеря доверия. Раньше всё это жило только в выводе процесса.
 */
export const federationAudit = pgTable(
  'federation_audit',
  {
    id: text('id').primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    event: text('event').notNull(),
    instanceId: text('instance_id'),
    actorId: text('actor_id'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => ({ byAt: index('federation_audit_at_idx').on(t.at) }),
);

/**
 * Мои GIF (миграция 0104, `gifs1`, Р-7): сохранённые GIF человека — своя копия файла в закрытом хранилище (`gif/<id>`),
 * новые первыми, не больше `GIFS_SAVED_MAX`; `origin` — откуда сохранён (повтор поднимает строку). См. `gifs.ts`.
 */
export const userSavedGifs = pgTable('user_saved_gifs', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  storageKey: text('storage_key').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),
  origin: text('origin').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
});
