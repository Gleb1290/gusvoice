// DTO shapes shared between backend, presence and the web client.
// Permission bitfields are serialized as decimal strings (see permissions.ts).

import type { StickerFormat } from './stickerRules';

export type ChannelType = 'text' | 'voice';

/**
 * User-chosen presence state (orthogonal to connection-based online/offline):
 *  online — green; dnd ("не беспокоить") — red, suppresses notification sounds; away
 *  ("нет на месте") — honey; invisible ("невидимый") — appears offline to everyone else.
 */
export type PresenceStatus = 'online' | 'dnd' | 'away' | 'invisible';

/** Optional free-form custom status (emoji and/or text), with an optional auto-clear time. */
export interface CustomStatus {
  emoji: string | null;
  text: string | null;
  /** ISO timestamp after which the custom status auto-clears, or null to keep it indefinitely. */
  expiresAt: string | null;
}

/**
 * What game a user is currently playing, surfaced in presence (issue #40). EPHEMERAL — never stored
 * in the DB: set live from local process detection (desktop) or Steam, held in an in-memory store,
 * broadcast to clients (`user.activity`) and seeded on load via GET /users/activities. Kept as a
 * standalone map on clients (like online presence), not a field on User.
 */
export interface GameActivity {
  name: string;
  /** Steam appId when known (used for a game icon); absent for non-Steam launchers. */
  appId?: number;
}

export interface User {
  id: string;
  username: string;
  email: string | null;
  verified: boolean;
  /**
   * Одобрен ли аккаунт супер-админом (политика регистрации `approval`, #142). `false` — ждёт одобрения и
   * войти не может; в админ-панели рядом с ним кнопка «Подтвердить». Необязательное: старые серверы не присылают.
   */
  approved?: boolean;
  displayName: string;
  avatarUrl: string | null;
  /**
   * Анимированный аватар (#117): ОТДЕЛЬНО от статичного, а не вместо него.
   * ⚠️ Списки и оверлей рисуют `avatarUrl` всегда — анимация показывается по наведению и в
   * карточке профиля. `prefers-reduced-motion` сам по себе анимацию картинки не останавливает.
   */
  animatedAvatarUrl: string | null;
  /** Куплено ли право загрузить анимацию. Глобально: аватар виден на всех серверах. */
  animatedAvatarUnlocked: boolean;
  /**
   * До какого момента действует аренда анимированного аватара (ISO). `null` — не арендован.
   *
   * ⚠️ Нужен интерфейсу, чтобы показать «осталось N дней» и предложить продлить ДО того, как
   * анимация пропадёт. Без срока человек узнавал бы об окончании по факту исчезновения.
   */
  animatedAvatarUntil?: string | null;
  /**
   * Показывали ли человеку приветственное окно экономики (#117). Отметка на сервере — один раз на
   * человека, а не на устройство. Необязательное: старые макеты профиля его не знают.
   */
  economyWelcomeSeen?: boolean;
  /**
   * Видна ли этому человеку экономика: флаг инстанса И список закрытого показа (#117).
   * ⚠️ Едет только в СВОЁМ профиле. У чужих людей поля нет, и это правильно: кто в закрытом показе
   * — не их дело.
   */
  economyPreview?: boolean;
  /** True only for the single configured super-admin (SUPERADMIN_USERNAME). */
  superAdmin: boolean;
  /** Whether this user may create new servers (granted by the super-admin). */
  canCreateServers: boolean;
  /** Whether TOTP two-factor auth is active on this account. */
  twoFactorEnabled: boolean;
  /** User-chosen presence state. */
  status: PresenceStatus;
  /** Custom status (emoji + text), or null when none/expired. */
  customStatus: CustomStatus | null;
  /**
   * Поставила ли текущий статус автоматика (авто-«отошёл»), а не человек. Отдаётся ТОЛЬКО себе:
   * другим участникам этого знать незачем, они видят обычный статус (#118).
   *
   * 🔴 Живёт на сервере, а не в клиенте. Статус общий для всех клиентов человека, поэтому признак
   * «увели мы» обязан быть общим тоже — иначе снять авто-«отошёл» может только тот клиент, который
   * его поставил, а остальные держат жёлтый значок у активного человека вечно.
   */
  statusAuto?: boolean;
  /** Whether a Steam account is linked (#40 Phase 1B). The SteamID itself is never sent to clients. */
  steamLinked?: boolean;
  /** Cached Steam persona name, for the settings UI (null when not linked). */
  steamPersona?: string | null;
  /** Master switch: broadcast my game activity (Steam + desktop local detect). Default true. */
  showGameActivity?: boolean;
  createdAt: string;
}

/** Row in the admin panel's user list. */
export interface AdminUser extends User {}

/** Row in the admin panel's server list. */
export interface AdminServer {
  id: string;
  name: string;
  ownerId: string;
  ownerUsername: string | null;
  channels: number;
  voiceChannels: number;
  members: number;
  createdAt: string;
}

export interface Server {
  id: string;
  name: string;
  iconUrl: string | null;
  ownerId: string;
  createdAt: string;
}

export interface Category {
  id: string;
  serverId: string;
  name: string;
  position: number;
}

export interface Channel {
  id: string;
  serverId: string;
  categoryId: string | null;
  name: string;
  type: ChannelType;
  position: number;
  topic: string | null;
  /** When true, the channel inherits its permission overwrites from its category. */
  syncedToCategory: boolean;
  /** Custom icon-name from the curated channel-icon set; null = type default (# / volume). */
  icon: string | null;
  /** True when the @everyone role cannot VIEW this channel (restricted access) — shows a lock badge. */
  isPrivate: boolean;
  /** The channel's appointed "general" (crown + can manage this channel's sounds); null = none. */
  generalUserId: string | null;
  /** Per-channel custom sound overrides (event → url); resolved channel → server → synth. */
  sounds: Record<string, string>;
  /**
   * Качество звука голосового канала в кбит/с (#101); `null` = умолчание.
   * ⚠️ Читать через `voiceBitrateOf()` из `voiceQuality.ts`, а не напрямую — умолчание живёт там.
   */
  voiceBitrate: number | null;
}

/**
 * Curated icon-name palette a channel manager may assign to a channel (a subset of the
 * client's `<Icon>` set). Shared so the backend can validate the chosen name. `null` on a
 * channel means "use the type default" (# for text, volume for voice).
 */
export const CHANNEL_ICONS = [
  'volume',
  'hash',
  'signal',
  'mic',
  'headphones',
  'users',
  'music',
  'star',
  'bell',
  'bolt',
  'gamepad',
  'flame',
  'heart',
  'code',
  'megaphone',
  'pin',
] as const;
export type ChannelIcon = (typeof CHANNEL_ICONS)[number];

export interface Role {
  id: string;
  serverId: string;
  name: string;
  color: number; // 0xRRGGBB, 0 = no color
  /** Permission bitfield as a decimal string. */
  permissions: string;
  position: number;
  hoist: boolean;
  isEveryone: boolean;
  /** Whether @mentioning this role notifies its members. */
  mentionable: boolean;
  /** Self-service: a member holding this role may grant it to others without MANAGE_ROLES (add-only). */
  membersCanAssign: boolean;
}

export interface Member {
  userId: string;
  serverId: string;
  nickname: string | null;
  roleIds: string[];
  joinedAt: string;
}

/** A per-channel (or per-category) permission overwrite for a role or member. */
export interface PermissionOverwrite {
  targetType: 'role' | 'member';
  targetId: string;
  /** Decimal bitfield string of explicitly-allowed permissions. */
  allow: string;
  /** Decimal bitfield string of explicitly-denied permissions. */
  deny: string;
}

/**
 * Все действия, которые пишутся в журнал.
 *
 * 🔴 Это ЗАКРЫТЫЙ список, и он существует ради одного: клиент разбирает его исчерпывающим
 * `switch`, поэтому новое действие без человеческого описания не собирается вовсе. До 06.09
 * список был просто `string`, у клиента стояла ветка «не знаю — напечатать код», и в неё молча
 * провалились ПЯТНАДЦАТЬ действий из сорока одного: люди видели в журнале `soundboard.price`.
 * Добавляешь действие — добавь и строку в `describeAudit` (`apps/client/src/auditText.ts`).
 *
 * ⚠️ Это МАССИВ, а тип выводится из него (просьба Codex). Сначала здесь был союз, а в тесте — его
 * переписанная руками копия: из союза в рантайме значения не достать, и забытый в копии элемент
 * TypeScript не замечает. Теперь перечень один, и тест ходит по нему же.
 */
export const AUDIT_ACTIONS = [
  'role.create',
  'role.update',
  'role.delete',
  'role.assign',
  'role.unassign',
  'role.reorder',
  'channel.create',
  'channel.update',
  'channel.delete',
  'channel.reorder',
  'channel.overwrite.update',
  'channel.overwrite.delete',
  'channel.general.set',
  'channel.general.clear',
  'channel.sound.set',
  'channel.sound.clear',
  'category.create',
  'category.update',
  'category.delete',
  'category.reorder',
  'category.overwrite.update',
  'category.overwrite.delete',
  'server.update',
  'server.transfer',
  'sound.set',
  'sound.clear',
  'soundboard.add',
  'soundboard.remove',
  'soundboard.price',
  'economy.settings',
  'economy.shop',
  'economy.retro',
  'economy.icon',
  'member.kick',
  'member.ban',
  'member.unban',
  'member.leave',
  'voice.mute',
  'voice.unmute',
  'voice.disconnect',
  'voice.move',
] as const;

/** Тип выводится ИЗ списка, а не пишется рядом — см. предупреждение выше. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** One entry in a server's moderation audit trail (read gated by VIEW_AUDIT_LOG). */
export interface AuditLogEntry {
  id: string;
  serverId: string;
  /** The member who performed the action (null if the user account was since deleted). */
  actor: Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl'> | null;
  /**
   * Что произошло. ⚠️ Тип закрытый (`AuditAction`) намеренно — см. комментарий у него.
   * В базе лежат и старые записи, поэтому разбор всё равно обязан пережить незнакомую строку.
   */
  action: AuditAction;
  targetType: string | null;
  targetId: string | null;
  /**
   * Тот, НАД КЕМ действие — если это участник и он ещё существует.
   *
   * ⚠️ Приезжает соединением по `targetId`, а не из `data`. Иначе голосовые действия (мут,
   * отключение, перемещение) остаются без имени: они кладут в `data` только канал, и журнал читался
   * как «замьютил участника» — видно кто, не видно кого. Соединение чинит и УЖЕ НАКОПЛЕННЫЕ записи.
   */
  target: Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl'> | null;
  /** Free-form details for display (names, before/after, channel ids, …). */
  data: Record<string, unknown>;
  createdAt: string;
}

/** A server member with their user info, for the members management list. */
export interface ServerMemberInfo {
  /**
   * ⚠️ `animatedAvatarUrl` едет в ростере, потому что карточку профиля открывают из списка
   * участников, а отдельный запрос ради одного поля означал бы поход к серверу на каждое открытие.
   * Списки его НЕ рисуют — только карточка и плитка сцены (см. `Avatar`).
   */
  user: Pick<
    User,
    'id' | 'username' | 'displayName' | 'avatarUrl' | 'animatedAvatarUrl' | 'status' | 'customStatus'
  >;
  nickname: string | null;
  roleIds: string[];
  joinedAt: string;
}

/** A server ban entry, for the bans management tab. */
export interface BanInfo {
  user: Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl'>;
  reason: string | null;
  bannedBy: string | null;
  createdAt: string;
}

export interface Attachment {
  url: string;
  name: string;
  contentType: string;
  size: number;
  width?: number | null;
  height?: number | null;
  /**
   * Голосовое сообщение (#20): огибающая (целые 0..100) и длительность. Считаются ОДИН раз при
   * записи и едут с вложением — иначе каждое голосовое в истории пришлось бы качать и
   * декодировать только ради полосок. Наличие огибающей = это голосовое (`isVoiceMessage`).
   */
  waveform?: number[] | null;
  durationMs?: number | null;
}

/** Aggregated reactions for one message — one entry per distinct emoji. */
export interface ReactionGroup {
  emoji: string;
  count: number;
  /** Whether the requesting user is among the reactors. */
  me: boolean;
}

/** Compact preview of the message a reply points at, shown above the reply. */
export interface MessageReplyPreview {
  id: string;
  authorName: string;
  content: string;
}

/** Вариант ответа с уже посчитанными голосами. */
export interface PollOption {
  id: string;
  text: string;
  votes: number;
}

/**
 * Опрос, прикреплённый к сообщению (#17).
 *
 * Результаты скрыты до собственного голоса ВСЕГДА: иначе первые голоса тянут за собой остальные.
 * Пока скрыты, `votes` приходят нулями — их прячет сервер, а не клиент.
 */
export interface Poll {
  question: string;
  options: PollOption[];
  /** Можно выбрать несколько вариантов. */
  multi: boolean;
  /** Кто за что проголосовал не показывается никому и никогда. */
  anonymous: boolean;
  /** ISO-время закрытия; null — бессрочный. */
  closesAt: string | null;
  /** За что проголосовал ТЫ (пусто — ещё не голосовал). Переголосовать нельзя. */
  myVotes: string[];
  /** Сколько ЧЕЛОВЕК проголосовало — не сумма голосов: при мультивыборе это разные числа. */
  voters: number;
  /** Видны ли результаты (проголосовал сам либо опрос закрыт). */
  revealed: boolean;
  /** Срок вышел — голосовать нельзя, результаты открыты всем. */
  closed: boolean;
}

/** Кто за что проголосовал — только для ПУБЛИЧНОГО опроса и только после своего голоса. */
export interface PollVoters {
  optionId: string;
  users: Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl'>[];
}

export interface Message {
  id: string;
  channelId: string;
  author: Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl'>;
  content: string;
  attachments: Attachment[];
  createdAt: string;
  editedAt: string | null;
  reactions: ReactionGroup[];
  /** The quoted message when this is a reply; null otherwise (or if the parent was deleted). */
  replyTo: MessageReplyPreview | null;
  /** When the message was pinned (channel messages only); null/absent if not pinned. */
  pinnedAt?: string | null;
  /** Опрос, если это сообщение-опрос (#17). */
  poll?: Poll | null;
  /** Стикер, если это сообщение-стикер (#68). Текст при этом пустой. */
  sticker?: MessageSticker | null;
}

export interface Invite {
  code: string;
  serverId: string;
  inviterId: string;
  createdAt: string;
  expiresAt: string | null;
  /** Max times the invite can be used, or null for unlimited. */
  maxUses: number | null;
  /** How many times it has been used so far. */
  uses: number;
}

/** A 1:1 direct-message conversation, from the requesting user's perspective. */
export interface DmChannel {
  id: string;
  /** The other participant (never the requesting user). */
  otherUser: Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl'>;
  createdAt: string;
  lastMessageAt: string | null;
  /** Messages from the other user newer than my last-read mark (14-day window). GET /dm only. */
  unread?: number;
}

/** A participant currently connected to a voice channel (from LiveKit presence). */
export interface VoiceParticipant {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  muted: boolean;
  /** Muted by a moderator (MUTE_MEMBERS), as opposed to self-muting their own mic. */
  serverMuted: boolean;
  deafened: boolean;
  speaking: boolean;
  screensharing: boolean;
  camera: boolean;
}

/** channelId -> participants. The shape the presence service broadcasts. */
export type PresenceMap = Record<string, VoiceParticipant[]>;

// ---- Auth payloads --------------------------------------------------------

export interface AuthResponse {
  token: string;
  user: User;
}

/** Registration no longer returns a token directly. `verification_required` = an e-mail code was
 *  sent (SMTP configured). `pending_admin` = no SMTP on this instance, so a super-admin must approve
 *  the account from the admin panel before the user can log in. */
export interface RegisterResponse {
  status: 'verification_required' | 'pending_admin';
  email: string;
}

/** SMTP config as shown in the admin panel. The password is never sent back in plain — `hasPass`
 *  says whether one is stored. `source` tells the operator where the effective config comes from. */
export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  hasPass: boolean;
  source: 'db' | 'env' | 'none';
}

/** POST /auth/verify returns the same shape as login once the code is accepted. */
export type VerifyResponse = AuthResponse;

/**
 * Кто может регистрироваться на инстансе (мастер установки, #142). `open` — все; `approval` — все, но
 * супер-админ одобряет каждого; `invite` — только с кодом приглашения сервера. Нет настройки = `open`.
 */
export type RegistrationPolicy = 'open' | 'approval' | 'invite';

/** Публичные сведения об инстансе — `GET /api/instance`, без входа. */
export interface InstanceInfo {
  name: string | null;
  iconUrl: string | null;
  registration: RegistrationPolicy;
}

/** `GET /api/setup/status` — нужен ли мастер первичной настройки. */
export interface SetupStatus {
  /** Супер-админа ещё нет — мастер начинается с кода установки. */
  needsSetup: boolean;
  /** В `.env` есть `SETUP_TOKEN` — без него мастер пройти нельзя (подсказка, что делать). */
  tokenConfigured: boolean;
  /** Супер-админ создан мастером, но шаги после этого не пройдены. */
  wizardPending: boolean;
}

/** Настройки инстанса в админ-панели супер-админа. */
export interface AdminInstanceSettings extends InstanceInfo {
  /** Есть ли почта (SMTP) — без неё регистрации подтверждает админ при любой политике. */
  smtpConfigured: boolean;
}

/**
 * Шаг обновления инстанса из админ-панели (О2б): что сейчас делает `update.sh --from-panel` на хосте.
 * Порядок: файлы стека → образы → копия базы → перезапуск → ожидание здорового бэкенда.
 */
export type InstanceUpdateStep = 'files' | 'pull' | 'backup' | 'restart' | 'health';

/**
 * Код ошибки обновления. Текст пишет клиент: хост вывод команд не пересказывает (в нём могут быть значения
 * из `.env`). Неизвестный код клиент показывает общим текстом.
 */
export type InstanceUpdateError =
  | 'bad-request'
  | 'locked'
  | 'pinned-tag'
  | 'files'
  | 'pull'
  | 'backup'
  | 'backup-space'
  | 'restart'
  | 'storage-migrate'
  | 'health'
  | 'interrupted';

/** Статус последнего обновления из панели — `run/status/status.json`, пишет хост. */
export interface InstanceUpdateStatus {
  state: 'running' | 'done' | 'failed';
  step: InstanceUpdateStep | null;
  /** Версия, которую просили из панели. */
  requested: string | null;
  /** Версия бэкенда после перезапуска (только `done`). */
  version: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: InstanceUpdateError | string | null;
  /** Копия базы перед перезапуском — путь относительно каталога установки. */
  backup: string | null;
}

/** `GET /api/admin/instance/update` — версия, свежий выпуск и кнопка «Обновить». */
export interface InstanceUpdateInfo {
  /** Версия этого бэкенда (`GV_VERSION` в образе): `v0.7.0`, `master-abc1234`, `dev`. */
  installed: string;
  /** Не выпуск (master, dev): обновляется не из панели, свежий выпуск не проверяется. */
  devBuild: boolean;
  latest: { version: string; url: string | null; publishedAt: string | null } | null;
  /** Когда последний раз спрашивали выпуски; null — не спрашивали. */
  checkedAt: string | null;
  /** Спросить не удалось (нет сети, адрес не отвечает) — `latest` может быть от прошлой удачной проверки. */
  checkFailed: boolean;
  /** Проверка выключена (`GV_RELEASES_URL` пуст). */
  checkDisabled: boolean;
  /** Служба обновления на хосте установлена (`update.sh --install-updater`); `tag` — метка образов из `.env`. */
  updater: { tag: string | null } | null;
  status: InstanceUpdateStatus | null;
  /** Запрос из панели лежит, хост его ещё не взял. */
  requestPending: boolean;
  /** …и не берёт дольше 30 с — служба на сервере не отвечает. */
  requestStuck: boolean;
  canUpdate: boolean;
  /** Почему кнопки нет; null — кнопка есть. */
  blockedReason:
    | 'dev-build'
    | 'check-disabled'
    | 'unknown-latest'
    | 'up-to-date'
    | 'no-updater'
    | 'pinned-tag'
    | 'running'
    | 'pending'
    | null;
}

/** Токен для проверки голоса из браузера (шаг «Готово» мастера). */
export interface VoiceTestToken {
  url: string;
  token: string;
  room: string;
}

/** POST /auth/login when the account has 2FA on: no session token until the TOTP step passes. */
export interface TotpRequiredResponse {
  status: 'totp_required';
  challenge: string;
}

/** POST /auth/login resolves to a session (AuthResponse) or a 2FA challenge. */
export type LoginResponse = AuthResponse | TotpRequiredResponse;

/** POST /auth/2fa/setup — secret + scannable QR to add the account to an authenticator. */
export interface TotpSetupResponse {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}

/** POST /auth/2fa/enable and /backup/regenerate — the one-time backup codes (shown once). */
export interface BackupCodesResponse {
  backupCodes: string[];
  user?: User;
}

/** Returned by POST /channels/:id/voice/token — everything the client needs to join. */
export interface VoiceTokenResponse {
  url: string; // external LiveKit wss:// URL
  token: string; // LiveKit access JWT
  room: string; // room name = channel_<channelId>
}

/** Bootstrap payload returned by GET /servers/:id with full channel tree. */
/** Кастомное эмодзи сервера (#18). Набирается как `:name:`, в реакциях ключуется `custom:<id>`. */
export interface ServerEmoji {
  id: string;
  name: string;
  url: string;
}

/** Один стикер импортированного набора (#68). */
export interface Sticker {
  id: string;
  /** Эмодзи, которым он подписан в Telegram — по нему стикер и ищут. */
  emoji: string;
  url: string;
  format: StickerFormat;
}

/** Импортированный из Telegram набор (#68). */
export interface StickerPack {
  id: string;
  /** Имя набора у Telegram (`t.me/addstickers/<name>`) — по нему же защищаемся от повторного импорта. */
  name: string;
  title: string;
  stickers: Sticker[];
}

/**
 * Стикер, вложенный в сообщение.
 *
 * Хранится КОПИЕЙ прямо в сообщении, а не ссылкой на строку набора: удалённый набор иначе оставил бы
 * в истории пустые сообщения без единого признака, что там было. Ровно так же устроены вложения.
 */
export interface MessageSticker {
  id: string;
  emoji: string;
  url: string;
  format: StickerFormat;
}

export interface ServerBootstrap {
  server: Server;
  categories: Category[];
  channels: Channel[];
  roles: Role[];
  member: Member;
  /** Effective permission bitfield (decimal string) of the requesting member. */
  permissions: string;
  /** Custom per-server sound URLs, keyed by SoundEvent. Absent key = synthesized default. */
  sounds: Record<string, string>;
  /**
   * Кастомные эмодзи сервера (#18). Едут в bootstrap, а не отдельным запросом: они нужны СРАЗУ
   * при первой же отрисовке сообщений — `:имя:` в тексте нечем заменить, пока список не приехал.
   */
  emojis: ServerEmoji[];
  /** Наборы стикеров сервера (#68). Тоже в bootstrap — пикер должен открываться без запроса. */
  stickerPacks: StickerPack[];
  /** Настроен ли на инстансе токен бота Telegram. Без него импорт наборов невозможен. */
  stickersEnabled: boolean;
  /**
   * Persisted unread state per visible TEXT channel (only channels with something unread appear):
   * messages newer than my last-read mark (14-day window), and how many @-mention me.
   */
  reads: Record<string, { unread: number; mentions: number }>;
}
