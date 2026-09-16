import type { Attachment, MessageSticker } from '@gusvoice/shared';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
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
});

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
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  // When pinned (MANAGE_MESSAGES); null = not pinned.
  pinnedAt: timestamp('pinned_at', { withTimezone: true }),
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
  },
  (t) => ({ pk: primaryKey({ columns: [t.messageId, t.userId, t.emoji] }) }),
);

// 1:1 direct-message conversations. The pair is stored sorted (userA < userB) so a
// unique (user_a, user_b) index guarantees exactly one conversation per pair.
export const dmChannels = pgTable(
  'dm_channels',
  {
    id: text('id').primaryKey(),
    userA: text('user_a')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userB: text('user_b')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  },
  (t) => ({ pair: unique('dm_channels_pair_uniq').on(t.userA, t.userB) }),
);

export const dmMessages = pgTable('dm_messages', {
  id: text('id').primaryKey(),
  dmChannelId: text('dm_channel_id')
    .notNull()
    .references(() => dmChannels.id, { onDelete: 'cascade' }),
  authorId: text('author_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  attachments: jsonb('attachments').$type<Attachment[]>().notNull().default([]),
  // Self-reference; the FK is declared in the migration SQL (avoids a circular type here).
  replyToId: text('reply_to_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
});

// Emoji reactions on DM messages. One row per (message, user, emoji) — mirrors messageReactions.
export const dmMessageReactions = pgTable(
  'dm_message_reactions',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => dmMessages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.messageId, t.userId, t.emoji] }) }),
);

// Persisted read state (migration 0018): unread/mention badges survive reloads.
// last_read_at advances when the client opens the channel/DM (POST .../read).
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

export const dmReads = pgTable(
  'dm_reads',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dmChannelId: text('dm_channel_id')
      .notNull()
      .references(() => dmChannels.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.dmChannelId] }) }),
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
