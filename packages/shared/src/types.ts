// DTO shapes shared between backend, presence and the web client.
// Permission bitfields are serialized as decimal strings (see permissions.ts).

import type { StickerFormat } from './stickerRules';
import type { NotifyView } from './notifyView';
import type { ConvCallService } from './calls';
import type { ConvMediaMark } from './convMedia';

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
   * ⚠️ Показывается ВЕЗДЕ, куда её передали, — и в списках тоже (решение 01.09; прежний показ
   * только по наведению отменён). Без анимации остаётся ОВЕРЛЕЙ: он висит поверх чужой игры.
   * `prefers-reduced-motion` сам по себе анимацию картинки не останавливает.
   */
  animatedAvatarUrl: string | null;
  /**
   * Откуда человек, если он ГОСТЬ с другого инстанса (#139, F4, §5.7). `null`/нет поля — свой.
   *
   * 🔴 Значок инстанса нужен ВЕЗДЕ, где видно человека: в списке участников, в шапке сообщения, в
   * списке голосового канала. Иначе гость неотличим от своего — а отличие принципиальное: его
   * профиль, ник и аватар живут на другом инстансе, ЛС с ним пока нет, и однажды он может исчезнуть
   * вместе со связкой.
   *
   * ⚠️ Едет в РОСТЕРЕ (`ServerMemberInfo`), а не в каждом сообщении: все поверхности читают человека
   * оттуда — тем же приёмом, что и анимированный аватар.
   */
  homeInstance?: {
    instanceId: string;
    name: string | null;
    domain: string;
    /**
     * Принимает ли этот инстанс жалобы (`reports` в его `features`, §5.11).
     *
     * ⚠️ Едет вместе со значком намеренно: галочку «Пожаловаться» рисует окно бана, а открыть его
     * может любой, у кого есть право банить, — ходить за возможностями связки отдельным запросом
     * ему нельзя (это знание держателя). Ложь тут дешёвая: галочка неактивна с подсказкой.
     */
    reports?: boolean;
  } | null;
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
   * Возможности ИНСТАНСА, на которые клиент переходит только по объявлению (ЛС этап 1: `conv1` — беседы
   * `/api/conv/*`). Едет только в `/auth/me`. Нет поля или нет строки — инстанс старый или сосед по федерации без
   * этой возможности, и клиент остаётся на прежних ручках.
   */
  features?: string[];
  /**
   * Предел одного файла в ЛС, байт (`bigfile1`, 09.10): загрузка кусками. Едет только в `/auth/me` рядом с `features`;
   * нет поля — прежние 25 МБ одним запросом.
   */
  dmFileMaxBytes?: number;
  /**
   * Видна ли этому человеку экономика: флаг инстанса И список закрытого показа (#117).
   * ⚠️ Едет только в СВОЁМ профиле. У чужих людей поля нет, и это правильно: кто в закрытом показе
   * — не их дело.
   */
  economyPreview?: boolean;
  /**
   * Собирает ли этот инстанс диагностику (#113) — свежий ответ сервера, а не запомненный флаг.
   * ⚠️ Необязательное: инстанс старой версии поля не пришлёт, и тогда клиент падает на флаг записи
   * реестра. Заведено 20.09 после того, как выяснилось, что у десктопов, добавивших сервер до
   * 28.08, диагностика была выключена НАВСЕГДА — см. `diagVisible.ts`.
   */
  diagPreview?: boolean;
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
  /** «Время захода» — кто видит точное время (С1, `lastseen1`). Только в СВОЁМ профиле. */
  lastSeenPrivacy?: LastSeenPrivacy;
  /** «Скрывать время прочтения» (С1, `lastseen1`). Только в СВОЁМ профиле. */
  hideReadTime?: boolean;
  /** «Кто может звонить» (`presence4`, та же тройка, что у «Времени захода»). Только в СВОЁМ профиле. */
  callPrivacy?: LastSeenPrivacy;
  /** «Кто может мне писать» (`msgpriv1`): все или только мои контакты (+ те, кому я писал первым). Только в СВОЁМ профиле. */
  messagePrivacy?: MessagePrivacy;
  /** «Показывать имя / текст» в уведомлениях (G38, `push2`, `notifyView.ts`). Только в СВОЁМ профиле. */
  notifyView?: NotifyView;
  /** «Уведомления из групп» (G38, `push2`): `false` — пуш и всплывашки групп не приходят. Только в СВОЁМ профиле. */
  notifyGroups?: boolean;
  /** «Личные сообщения» (G38, `push3`): `false` — пуш и всплывашки личных 1:1 не приходят. Только в СВОЁМ профиле. */
  notifyDm?: boolean;
  /** «Повторять уведомления» (G38, `push3`): минуты (`NOTIFY_REPEAT_MINUTES`), `0` — не повторять. Только в СВОЁМ профиле. */
  notifyRepeat?: number;
  createdAt: string;
}

/**
 * «Время захода» (С1, #211; Telegram «Last Seen & Online»): `everyone` — все, `peers` — собеседники и люди с общих
 * серверов (замена «Мои контакты»: контактов у GusVoice нет, решение владельца Р-2), `nobody` — никто.
 * Неизвестное значение читается как `peers`.
 */
export type LastSeenPrivacy = 'everyone' | 'peers' | 'nobody';
/** «Кто может мне писать» (`msgpriv1`): `contacts` — мои контакты и те, кому я сам писал (Telegram «Мои контакты и Premium»). */
export type MessagePrivacy = 'everyone' | 'contacts';

/** Человек в списке исключений «Времени захода» (G07, `lastseen3`). */
export interface LastSeenExceptionUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Исключения «Времени захода» (G07, `lastseen3`; Telegram «Always share with» / «Never share with»): `always` — этим людям время
 * захода видно, что бы ни стояло в правиле; `never` — не видно никому из них. Списки не пересекаются; предел — по
 * `LAST_SEEN_EXCEPTIONS_MAX` на список.
 */
export interface LastSeenExceptions {
  always: LastSeenExceptionUser[];
  never: LastSeenExceptionUser[];
}

/** Примерное время захода, когда точное скрыто (Telegram `userStatusRecently` / `LastWeek` / `LastMonth` / `Empty`). */
export type LastSeenApprox = 'recently' | 'week' | 'month' | 'long';

/**
 * Ответ `GET /users/:id/last-seen` (С1, `lastseen1`) — «в сети» / «был(а) …» ГЛАЗАМИ того, кто спрашивает.
 * Ровно одно из: `online` = true; `at` (точное время, ISO); `approx` (примерное).
 */
export interface UserLastSeen {
  userId: string;
  online: boolean;
  /** Точное время последнего захода — только если оно видно спрашивающему (взаимно, как у Telegram). */
  at: string | null;
  /** Примерное — когда точное скрыто им, мной или «Невидимым». */
  approx: LastSeenApprox | null;
  /** Скрыто МНОЙ (Telegram `by_me`): он своё показывает, а я своё — нет. */
  byMe: boolean;
  /** Видно ли мне его точное время (= можно «Отправить, когда будет в сети», Telegram `CanScheduleUntilOnline`). */
  exact: boolean;
  /**
   * Могу ли я ему позвонить по его «Кто может звонить» (`presence4`; только в `GET /users/:id/last-seen`, не в пачке).
   * Нет поля — сервер не знает настройки: трубку показываем, как раньше.
   */
  canCall?: boolean;
  /**
   * Могу ли я ему написать по его «Кто может мне писать» (`msgpriv1`; только в `GET /users/:id/last-seen`). Нет поля — как
   * раньше: поле ввода есть. `false` — вместо поля ввода плашка «ограничил(а) круг…» (tdesktop `lng_restricted_send_non_premium`).
   */
  canMessage?: boolean;
}

/** Ответ `GET /conv/:id/messages/:mid/read-at` (С1, `lastseen1`) — подвал меню своего сообщения в ЛС. */
export interface ConvReadAt {
  /** Прочитано ли собеседником (то же, что ✓✓). */
  read: boolean;
  /** Когда прочитано — `null`, если время скрыто, неизвестно (прочитано до миграции) или старше 7 суток. */
  at: string | null;
  /** Время скрыто приватностью (его или моей) — Telegram «прочитано» без времени. */
  hidden: boolean;
}

/** Прочитавший СВОЁ сообщение в группе (`readers1`; Telegram `ReadParticipantDate` без даты — времени у групп нет). */
export interface ConvReader {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * Ответ `GET /conv/:id/messages/:mid/readers` (15.10, `readers1`) — «N прочитали» в меню своего сообщения в группе
 * (Telegram `messages.getMessageReadParticipants`). Порядок — порядок участников группы.
 */
export interface ConvReaders {
  items: ConvReader[];
  /** Сообщение старше 7 суток — список не отдаётся (Telegram `MESSAGE_TOO_OLD`, `chat_read_mark_expire_period`). */
  expired?: true;
}

/** Row in the admin panel's user list. */
export interface AdminUser extends User {
  /**
   * Скрыт от соседей по федерации (F2, §5.2.1) — решение АДМИНА ИНСТАНСА, а не самого человека.
   * Поля нет у обычного `User` намеренно: это знание админ-панели, а не каждого клиента.
   */
  hiddenFromPeers?: boolean;
  /**
   * Где этот человек ГОСТЬ прямо сейчас (F3, §5.2.1) — приходит только для скрытых от соседей.
   *
   * 🔴 Скрытие убирает из каталога, но не выгоняет уже вошедшего по ссылке: админ, который скрывал,
   * обязан видеть, что человек всё равно виден на серверах соседа, — иначе он решает по неверной
   * картине («у соседей его нет»).
   */
  guestAt?: {
    instance: string;
    serverName: string;
    method: string | null;
    /** Кто позвал — идентификатор в пространстве ХОСТА (у нас такой строки нет). */
    invitedBy: string | null;
    /**
     * Его же имя, если нашлось в кеше каталога соседа.
     *
     * ⚠️ Отдельным полем, а не подменой `invitedBy`: id — это то, что прислал хост, и по нему
     * держатель может спросить соседа. Имя — наша догадка из кеша, и она может устареть.
     */
    invitedByName?: string | null;
    at: number;
  }[];
}

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
  /** Галочка «Разрешить федеративный доступ» (F2, §5.3) — ставит только админ инстанса. */
  federatedAccess?: boolean;
  /** Связки, которым этот сервер закрыт отдельно (требование 32). Пусто = открыт всем связкам. */
  federationExclusions?: string[];
}

export interface Server {
  id: string;
  name: string;
  iconUrl: string | null;
  ownerId: string;
  createdAt: string;
  /**
   * Только в ответе `GET /servers` (12.10, #218; правило 11 — добавление): сколько у смотрящего непрочитанных сообщений на
   * сервере и сколько из них упоминают его — то же правило, что `bootstrap.reads` и `GET /unread` (окно 14 дней, чужие
   * сообщения, видимые каналы). Поля нет — старый сервер (или сосед на прошлом релизе): клиент берёт только живые счётчики.
   */
  unread?: number;
  mentions?: number;
  /**
   * Последнее сообщение сервера среди каналов, которые смотрящий видит и может читать (`VIEW_CHANNEL` + `READ_HISTORY`), —
   * вторая строка строки сервера в списке на телефоне. `null` — сообщений в таких каналах нет; поля нет — старый сервер.
   */
  lastMessage?: ServerLastMessage | null;
}

/**
 * Последнее сообщение сервера для строки списка (12.10, #218): форма превью строки беседы (`ConvLastMessage`) без полей,
 * которых у канала нет (✓✓, миниатюры, звонки), плюс канал. Вид вложений — то же правило, что у ЛС
 * (`backend convRules.lastAttachmentPreview`); у стикера без текста `text` — его эмодзи, `attachmentKind: 'sticker'`.
 */
export interface ServerLastMessage
  extends Pick<
    ConvLastMessage,
    | 'id'
    | 'authorId'
    | 'text'
    | 'attachments'
    | 'attachmentKind'
    | 'attachmentDurationMs'
    | 'attachmentName'
    | 'attachmentVideo'
    | 'attachmentGif'
    | 'attachmentOnce'
    | 'attachmentRound'
    | 'createdAt'
  > {
  channelId: string;
  /** Название канала; нет — неизвестно (запись, собранная клиентом из события шлюза чужого сервера). */
  channelName?: string;
  /** Отображаемое имя автора (`users.display_name`, как в ленте канала). */
  authorName: string;
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
  /**
   * Могу ли Я писать в этот канал (с переопределениями канала). Есть ТОЛЬКО в ответе `GET /servers/:id` (bootstrap) —
   * в рассылках о канале (`channel.*`) его нет; нет поля (старый сервер) — клиент судит по правам сервера.
   */
  canSend?: boolean;
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
  /**
   * Системная роль «Гости» (#139, §5.9): базовые права людей С ДРУГИХ инстансов, у гостя она
   * заменяет `@everyone`.
   *
   * 🔴 Руками не выдаётся и не снимается: гость получает её ПО ПРИЗНАКУ гостя, а не строкой в
   * `member_roles`. Интерфейс обязан убрать её из списка выдачи — выданная местному, она добавила
   * бы ему прав поверх `@everyone` вместо того, чтобы кого-то ограничить.
   */
  isGuests?: boolean;
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
  // Входящие вебхуки (#24): создание, правка (имя/аватар), новый токен, удаление.
  'webhook.create',
  'webhook.update',
  'webhook.token',
  'webhook.delete',
] as const;

/** Тип выводится ИЗ списка, а не пишется рядом — см. предупреждение выше. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Входящий вебхук канала (#24) — для окна «Настройки канала → Вебхуки». Токена здесь НЕТ: в базе лежит только его хеш,
 * поэтому полный адрес отдаётся один раз — в ответе создания и «Сгенерировать заново» (`WebhookWithToken`).
 */
export interface Webhook {
  id: string;
  serverId: string;
  channelId: string;
  name: string;
  avatarUrl: string | null;
  /** Кто завёл (короткий вид); `null` — создателя уже нет. */
  createdBy: { id: string; displayName: string } | null;
  createdAt: string;
  /** Когда по адресу последний раз пришло сообщение; `null` — ни разу. */
  lastUsedAt: string | null;
}

/**
 * Карточка сообщения вебхука (#24, по Discord Embed Object, уже проверенная сервером). Ссылки (`url`, `author.url`) —
 * только http(s). Картинки (`image`, `thumbnail`, `author.iconUrl`, `footer.iconUrl`) — только из НАШЕГО хранилища
 * (файл того же запроса `attachment://имя` или наша ссылка): чужую картинку клиент не грузит (пиксель слежения, #4) —
 * сервер кладёт её адрес в `imageLink`/`thumbnailLink`, и он показывается обычной ссылкой.
 */
export interface MessageEmbed {
  title?: string;
  url?: string;
  /** Текст нашим markdown, как у обычного сообщения. */
  description?: string;
  /** Цвет полосы слева, 0xRRGGBB. */
  color?: number;
  /** ISO-время в подвале. */
  timestamp?: string;
  author?: { name: string; url?: string; iconUrl?: string };
  footer?: { text: string; iconUrl?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  image?: { url: string };
  thumbnail?: { url: string };
  /** Чужая https-картинка `image` — показывается ссылкой, не грузится. */
  imageLink?: string;
  /** Чужая https-картинка `thumbnail` — показывается ссылкой, не грузится. */
  thumbnailLink?: string;
}

/** Вебхук вместе с токеном — только в ответе создания и «Сгенерировать заново». Адрес: `<api>/api/webhooks/<id>/<token>`. */
export interface WebhookWithToken extends Webhook {
  token: string;
}

/**
 * Человек в коротком виде — для списков, где ростера нет: баны, журнал действий, кто как голосовал.
 *
 * 🔴 `homeInstance` здесь ОБЯЗАТЕЛЕН по той же причине, по какой он есть в ростере: у гостя
 * `username` в базе технический (`<uuid>@<instance>`), и место, которое собирает человека руками,
 * показывает его именно так. На приёмке 18.09 в списке банов вместо ника и значка инстанса стояли
 * сорок символов служебного идентификатора.
 */
export type UserBrief = Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl' | 'homeInstance'>;

/** One entry in a server's moderation audit trail (read gated by VIEW_AUDIT_LOG). */
export interface AuditLogEntry {
  id: string;
  serverId: string;
  /** The member who performed the action (null if the user account was since deleted). */
  actor: UserBrief | null;
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
  target: UserBrief | null;
  /** Free-form details for display (names, before/after, channel ids, …). */
  data: Record<string, unknown>;
  createdAt: string;
}

/** A server member with their user info, for the members management list. */
export interface ServerMemberInfo {
  /**
   * 🔴 `animatedAvatarUrl` едет в ростере, и ростер — ЕДИНСТВЕННЫЙ его источник в клиенте: в
   * метаданные LiveKit анимация не кладётся вовсе (#129), а в DTO автора сообщения её нет. Всякая
   * поверхность, рисующая движущийся аватар, читает его отсюда (`useAnimatedAvatarUrl`).
   * ⚠️ Отдельный запрос ради одного поля означал бы поход к серверу на каждое открытие карточки.
   */
  user: Pick<
    User,
    'id' | 'username' | 'displayName' | 'avatarUrl' | 'animatedAvatarUrl' | 'homeInstance' | 'status' | 'customStatus'
  >;
  nickname: string | null;
  roleIds: string[];
  joinedAt: string;
}

/** A server ban entry, for the bans management tab. */
export interface BanInfo {
  user: UserBrief;
  reason: string | null;
  bannedBy: string | null;
  createdAt: string;
}

export interface Attachment {
  /**
   * Ссылка на файл. У закрытых файлов ЛС (шаг 1в) — своя у КАЖДОГО смотрящего (`/api/att/<id>/<смотрящий>/<подпись>`),
   * работает, пока у него есть доступ; кешировать её нельзя — кешировать можно `id`.
   */
  url: string;
  /** id закрытого вложения ЛС (шаг 1в). Нет — старое вложение из публичного бакета. */
  id?: string;
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
  /**
   * «Отправить как файл» (ЛС, признак сервера `linkprev1`, окно отправки файлов, как «Отправить как документы» у Telegram):
   * картинка или видео показываются карточкой файла, без кадра. Сервер кладёт поле ТОЛЬКО у таких вложений (у остальных
   * DTO прежний); старый клиент поля не знает и рисует фото.
   */
  asFile?: true;
  /**
   * Спойлер (ЛС, признак сервера `media2`, G48, «Скрыть под спойлером» окна отправки файлов): фото или видео у получателя
   * размыто, пока он не нажмёт; снятие — локально у него. Сервер кладёт поле ТОЛЬКО у фото и видео (не «как файл»); старый
   * клиент поля не знает и рисует обычное фото.
   */
  spoiler?: true;
  /**
   * GIF (ЛС, признак сервера `gifs1`, Р-7): видео без звука, по кругу, само играет в ленте — как GIF у Telegram (tdesktop
   * `data_document.cpp` `isAnimation`: mp4 без звука). Сервер кладёт поле ТОЛЬКО у видео и `image/gif`; старый клиент
   * поля не знает и рисует обычное видео.
   */
  gif?: true;
  /**
   * «Прослушать один раз» (08.10, #211, G54, признак сервера `voice3`; Telegram `ttl_seconds = 0x7FFFFFFF`, tdesktop
   * `TTLButton`): голосовое в личке 1:1 исчезает у получателя после прослушивания. Сервер кладёт поле ТОЛЬКО у голосового
   * беседы 1:1 (не группа, не «Избранное»); такое сообщение нельзя переслать. Старый клиент поле не знает и играет как обычное.
   * С `circles1` (08.10) — ещё и у кружка (`round`): «Посмотреть один раз».
   */
  once?: true;
  /**
   * Таймер одноразового фото или видео, с (19.10, #226, `ttlmedia1`; Telegram «Self-Destruct Timer» 3/10/30/своё до 60):
   * после открытия получателем просмотр закрывается через столько секунд и сообщение сгорает у обоих. Только вместе с
   * `once` у фото/видео; нет поля — «Просмотр один раз» (сгорает при закрытии). Старый клиент поле не знает.
   */
  onceTtl?: number;
  /**
   * Видеосообщение-кружок (08.10, #211, G68, признак сервера `circles1`; Telegram `documentAttributeVideo.round_message`,
   * Android `InstantCameraView`, tdesktop `round_video_recorder.cpp`): квадратное видео до `ROUND_MAX_MS`, в ленте — круг,
   * играет беззвучно по кругу, по нажатию — со звуком. Сервер кладёт поле ТОЛЬКО у видео с равными шириной и высотой и
   * длительностью до минуты; старый клиент поле не знает и рисует обычное видео.
   */
  round?: true;
  /**
   * ЛС между инстансами, Э3 часть 1 (#141, `fedm3`): вложение из копии сообщения человека другого инстанса ещё не скопировано
   * к нам — ссылка пока отвечает 503 `federation.att_pending`; клиент показывает «загружается». Копия доехала — поля нет, и
   * сообщение приходит обновлённым (`conv.change`). Добавление.
   * Э3 часть 2: `'remote'` — файл больше 25 МБ (или у связки кончилось место под копии) лежит только у дома автора: клиент
   * рисует обычную карточку / плитку, ссылка отдаёт файл через наш бэкенд с инстанса автора (открытие чуть дольше), автор
   * недоступен — 503 `federation.att_unavailable`. Старый клиент значение не знает — для него это обычное вложение.
   */
  fedState?: 'copying' | 'remote';
}

/** Сохранённый GIF человека («Мои GIF», `gifs1`). `url` — подписанная ссылка для этого смотрящего. */
export interface SavedGif {
  id: string;
  url: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export interface SavedGifsResponse {
  gifs: SavedGif[];
  /** Предел списка (Telegram `saved_gifs_limit`): сверх него старые уходят. */
  limit: number;
  /** Есть ли внешний поиск (ключ поставщика задан у инстанса). */
  search: boolean;
}

/** Найденный у поставщика GIF (`GET /api/gifs/search`): ссылки — поставщика, файл в ленту копирует сервер. */
export interface ExternalGif {
  id: string;
  /** Видео для отправки (mp4). */
  url: string;
  /** Маленькое видео для сетки выбора. */
  previewUrl: string;
  width: number | null;
  height: number | null;
}

export interface ExternalGifsResponse {
  gifs: ExternalGif[];
  /** Следующая страница; `null` — конец. */
  next: string | null;
}

/** Aggregated reactions for one message — one entry per distinct emoji. */
export interface ReactionGroup {
  emoji: string;
  count: number;
  /** Whether the requesting user is among the reactors. */
  me: boolean;
  /**
   * Кто поставил (ЛС, 07.10, «кто поставил» как у Telegram): люди по порядку постановки, старые первыми, с моментом
   * постановки. Шлёт только сервер бесед ЛС — в каналах серверов поля нет (там людей бывают сотни, а событие
   * `message.reaction` момента не несёт): у них чип с числом, как было. Поле только ДОБАВЛЕНО (правило 11): старый клиент
   * его не знает и рисует число; новый клиент без поля (старый сервер, старая копия в кеше) — тоже число.
   */
  reactors?: ReactionReactor[];
}

/** Один поставивший реакцию (`ReactionGroup.reactors`): кто и когда. Скрытые смотрящим (чёрный список) не приходят. */
export interface ReactionReactor {
  userId: string;
  /** ISO-время постановки. */
  at: string;
}

/** Compact preview of the message a reply points at, shown above the reply. */
export interface MessageReplyPreview {
  id: string;
  authorName: string;
  content: string;
  /**
   * Цитируемое удалено у обоих (ЛС этап 1, беседы): текста нет, клиент пишет «сообщение удалено». Необязательное —
   * старые ручки его не шлют (у них удалённая цитата просто пропадает).
   */
  deleted?: boolean;
  /**
   * Вложения цитируемого (05.10) — в той же форме, что у последнего сообщения строки списка бесед (`ConvLastMessage`,
   * раунд 11): сколько их, вид, длительность голосового (или видео), имя первого файла, видео ли. По ним клиент пишет
   * цитату на сообщение, которого нет в загруженном окне ленты: «Фото», «Видео», «Голосовое сообщение · 0:42», «Файл:
   * имя», «Стикер» (вид `sticker` — только в каналах: у него вложений нет, `attachments` тогда не приходит). Поля
   * есть только у цитаты на сообщение с вложениями или стикером — у остальных DTO прежний. Старый клиент их не читает и
   * пишет, как раньше, «вложение»; незнакомый вид новый клиент считает отсутствием поля (правило 11).
   */
  attachments?: number;
  attachmentKind?: ConvAttachmentKind;
  attachmentDurationMs?: number;
  attachmentName?: string;
  attachmentVideo?: true;
  /** Все вложения — GIF (`Attachment.gif`, 08.10, `gifs1`): «GIF», как у Telegram. Поле только у таких. */
  attachmentGif?: true;
  /** Кружок (`Attachment.round`, 08.10, `circles1`): «Видеосообщение», как у Telegram. Поле только у таких. */
  attachmentRound?: true;
  /**
   * Миниатюра цитаты — первое фото (только у `attachmentKind: 'photo'`, ЛС). У закрытого файла ЛС это ссылка
   * СМОТРЯЩЕГО, как `Attachment.url`: своя у каждого и гаснет с поколением его токенов — кешировать её нельзя. Нет —
   * значок.
   */
  thumb?: string;
  /** Первое фото под спойлером (`Attachment.spoiler`, `media2`, хвост `tails2`): клиент размывает миниатюру. Поле только у таких. */
  thumbSpoiler?: true;
  /**
   * Цитата фрагмента (08.10, `quote1`, G55): выбранный автором ответа кусок текста цитируемого и его смещение в том тексте
   * (для подсветки при переходе). Поля только у ответа с цитатой; `content` — по-прежнему текст цитируемого целиком (у ответа
   * из чужой беседы без доступа — сама цитата).
   */
  quote?: string;
  quoteOffset?: number;
  /** Ответ на сообщение ДРУГОЙ беседы (`quote1`, «Ответить в другом чате»). Поле только у таких. */
  foreign?: true;
  /**
   * Беседа цитируемого — только у `foreign` и только читателю, который в ней состоит (переход открывает ту беседу). Нет поля
   * при `foreign` — доступа нет: виден лишь текст цитаты, перехода нет, вложений нет.
   */
  conversationId?: string;
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
  users: UserBrief[];
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
  /**
   * Роли, которые это сообщение РЕАЛЬНО позвало (#76, `@Модераторы`): id ролей сервера, решённые сервером при отправке
   * (роль можно упоминать либо у автора право управления ролями). Поле есть ТОЛЬКО у сообщений с такими упоминаниями —
   * у остальных DTO прежний, старый клиент поля не знает и роль-упоминание просто не подсвечивает и не звенит.
   * Получатель сверяет с СВОИМИ ролями сервера (`mentionsMyRole`): совпало — это упоминание его, как личное.
   */
  mentionRoles?: string[];
  /**
   * `@everyone`/`@here` в тексте (#76, право `MENTION_EVERYONE`): поле есть ТОЛЬКО у сообщений с таким обращением.
   * `false` — автору не хватило права, текст остался, но никого не зовёт (ни звук, ни значок, ни пуш); `true` — зовёт.
   * Нет поля (старые сообщения, вебхуки, ЛС) — зовёт, как раньше; старый клиент поля не знает и звенит по тексту.
   */
  mentionEveryone?: boolean;
  /**
   * Сообщение пришло через ВХОДЯЩИЙ ВЕБХУК (#24): id вебхука. Поле есть ТОЛЬКО у таких сообщений — у остальных DTO прежний.
   * `author` при этом — служебная строка вебхука с именем и аватаром, которые прислал отправитель (или заданы у вебхука),
   * а не человек: клиент рисует у имени пометку «ВЕБХУК» и не открывает профиль. Старый клиент поля не знает и
   * показывает сообщение как от обычного автора с этим именем.
   */
  webhookId?: string;
  /**
   * Карточки вебхука (#24, Discord Embed Object): до 10 штук, рисуются под текстом. Нет поля — карточек нет. Старый
   * клиент поля не знает — ему остаётся `content` (см. `embedsFallback`).
   */
  embeds?: MessageEmbed[];
  /**
   * `true` — `content` не написан отправителем, а собран сервером из карточек для старых клиентов (сообщение вебхука
   * без текста, только с `embeds`). Новый клиент такой `content` НЕ показывает — рисует карточки.
   */
  embedsFallback?: true;
  /**
   * Пересланное (ЛС, признак сервера `conv5`): чьё это сообщение на самом деле. Нет поля или `null` — не пересланное;
   * сервер шлёт поле ТОЛЬКО у пересланных, у остальных DTO прежний. Автор (`author`) пересланного — тот, кто переслал.
   * Старый клиент поля не знает и показывает пересланное как обычное сообщение пересылающего.
   */
  forwardedFrom?: MessageForwardedFrom | null;
  /**
   * Отправлено «без звука» (ЛС, С3, признак сервера `conv8`, как в Telegram): сообщение доходит, считается в
   * непрочитанном и показывает уведомление как обычно — нет только звука; пуш на телефон уходит с `silent: true` в
   * нагрузке (уведомление без звука). Сервер кладёт поле ТОЛЬКО у таких сообщений (у остальных DTO
   * прежний) — в ответе отправки, истории, `conv.change`, догонке и в старом `dm.create`. Старый клиент поле не знает и
   * звенит, как на любое.
   */
  silent?: true;
  /**
   * «Без превью ссылки» (ЛС, признак сервера `linkprev1`, G19, крестик на полосе превью над полем у Telegram): автор убрал
   * превью — получатель карточку ссылки под сообщением не рисует. Сервер кладёт поле ТОЛЬКО у таких сообщений (у
   * остальных DTO прежний). Старый клиент поля не знает и рисует карточку.
   */
  noPreview?: true;
  /**
   * «Подпись над медиа» (ЛС, признак сервера `media2`, G48, `Type::CaptionUp` у tdesktop): подпись рисуется над фото/альбомом.
   * Сервер кладёт поле ТОЛЬКО у сообщения с подписью и вложением; старый клиент поля не знает и рисует подпись снизу.
   */
  captionAbove?: true;
  /**
   * Опасные ссылки (признак сервера `linkthreats1`, #218 п.5, как «Предупреждение» у Telegram): хосты ссылок текста,
   * найденные в локальном списке угроз сервера. Считается при КАЖДОЙ отдаче сообщения (список обновляется раз в сутки —
   * флаг в базе протух бы), поле есть ТОЛЬКО у сообщений с такой ссылкой. Отправку не блокирует: получатель видит плашку
   * «Опасная ссылка», открыть можно после отдельного подтверждения. Старый клиент поля не знает.
   */
  dangerousLinks?: string[];
}

/**
 * «Переслано от» (ЛС, признак `conv5`). Переслали пересланное — здесь по-прежнему ПЕРВЫЙ автор и время оригинала, как
 * у Telegram.
 */
export interface MessageForwardedFrom {
  /** id автора оригинала (местный; в ЛС между инстансами, этап 6, рядом встанет инстанс — добавлением). */
  userId: string;
  /**
   * Имя автора на момент пересылки (снимок: переименование потом его не меняет). Аккаунт автора удалён — его нынешнее
   * обезличенное имя («Удалённый пользователь»), как у автора сообщения и у цитаты.
   */
  displayName: string;
  /** Время оригинала (ISO). */
  at: string;
  /**
   * Аккаунт автора оригинала удалён (обезличен) — 05.10, только добавление. Узнавать удалённого надо по этому полю, а не по
   * имени: «Удалённый пользователь» может назваться и живой человек. Ставится в снимок при обезличивании и при пересылке
   * сообщения удалённого автора; сервер кладёт его и по самому аккаунту. У живого автора поля нет. Старый клиент поле не
   * знает и показывает имя, как раньше.
   */
  deleted?: true;
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
  /** `homeInstance` (Э1, #141) — только у собеседника с другого инстанса: значок в шапке беседы. */
  otherUser: Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl' | 'homeInstance'>;
  createdAt: string;
  lastMessageAt: string | null;
  /** Messages from the other user newer than my last-read mark (14-day window). GET /dm only. */
  unread?: number;
  /** Закреп беседы (`ConvSummary.pinnedAt`, `conv11`) — только в режиме бесед; сервер в `GET /dm` его не шлёт. */
  pinnedAt?: string | null;
  /** Заглушка беседы (`ConvSummary.muted`, `conv11`) — только в режиме бесед; нет поля — смотреть список заглушек. */
  muted?: ConvMute | null;
  /** «Помечено непрочитанным» (`ConvSummary.markedUnread`, `conv13`) — точка без числа; только в режиме бесед. */
  markedUnread?: boolean;
  /** Беседа в архиве (`ConvSummary.archived`, `archive1`) — только в режиме бесед. */
  archived?: boolean;
  /** Сообщений с непрочитанными реакциями (`ConvSummary.unreadReactions`, `reactunread1`, G24) — значок ♥ в строке. */
  unreadReactions?: number;
  /** Непрочитанных упоминаний (`ConvSummary.unreadMentions`, G24; зарезервировано под группы) — значок «@» в строке. */
  unreadMentions?: number;
  /**
   * Группа ЛС (`ConvSummary.group`, `groups1`) — только в режиме бесед; `otherUser` у неё — сама группа (название, фото,
   * id `group:<беседа>`), участники — здесь.
   */
  group?: ConvGroupInfo;
  /** «Избранное» (`ConvSummary.saved`, `saved1`): беседа с самим собой; `otherUser` — служебный (`saved:<беседа>`), имя «Избранное». */
  saved?: boolean;
}

/**
 * ЛС, этап 1 (#211, `docs/dm/STAGE1.md`): беседы `/api/conv/*`. Клиент переходит на них только если `/auth/me`
 * объявил `features: ['conv1']`, а шлюзу сказал `identify.caps: ['conv1']`.
 */

/** Сообщение беседы. `channelId` = id беседы — общий `MessagePane` работает с ним как с любым `Message`. */
export interface ConvMessage extends Message {
  conversationId: string;
  /** Ключ порядка (микросекунды, HLC) — точное число JS; по нему лента, курсор и «прочитано до». */
  sortKey: number;
  /** id отправки, который прислал отправитель, — чтобы его клиент сопоставил своё «отправляется…». */
  clientId: string | null;
  /**
   * Голосовое сообщение прослушано (07.10, признак сервера `voice1`, G12). Сервер кладёт поле ТОЛЬКО у сообщений с
   * голосовым вложением: получателю — слушал ли ОН; автору — слушал ли хоть один собеседник (кого автор не блокировал).
   * `false` — синяя точка «не прослушано». Нет поля — не голосовое или сервер до `voice1` (точек нет). Старый клиент его
   * не знает и игнорирует (правило 11).
   */
  voiceListened?: boolean;
  /**
   * Голосовое «Прослушать один раз» уже прослушано (08.10, `voice3`, G54): файл удалён, вложений нет, в `content` — запасная
   * фраза «Голосовое сообщение прослушано» (её покажет и старый клиент). Кладётся обоим участникам. Нет поля — не такое.
   */
  voiceOnceSpent?: true;
  /**
   * ЛС между инстансами, Э2 (12.10, #141, Ф9, признак `fedm2`): копия сообщения человека другого инстанса пришла к нам
   * позже отправки больше чем на 5 минут (`federation/convSync.deliveredLate`) — момент прихода (ISO). Лента ставит такое
   * по приходу (внизу), у времени пузыря — «отправлено в ЧЧ:ММ, доставлено позже» (`createdAt` — время отправки на доме
   * автора). Нет поля — не опоздало или сервер до Э2.
   */
  deliveredAt?: string;
  /**
   * ЛС между инстансами, Э5 часть 1 (12.10, #141, признак `fedm5`): сообщение пришло «через» другой инстанс — дом автора лежал,
   * и он писал по долгой сессии на инстансе собеседника (`instance` — id того дома, через который пришло, у собеседника — дом
   * автора). `confirmed: false` — дом автора ещё не подтвердил (или так и не подтвердил): «через «X», не подтверждено»;
   * `true` — подтвердил. Нет поля — обычное сообщение.
   */
  via?: { instance: string; confirmed: boolean };
  /**
   * На моё сообщение поставили реакцию, которую я ещё не видел (07.10, признак сервера `reactunread1`, G24): кладётся
   * ТОЛЬКО автору и только `true`. Клиент гасит её, показав сообщение на экране (`POST /conv/:id/reactions-read`), —
   * как `HistoryItem::markReactionsRead` у Telegram. Нет поля — непрочитанных реакций нет или сервер до `reactunread1`.
   */
  reactionUnread?: true;
  /**
   * Служебная строка ленты: «X закрепил(а) сообщение» (G28, признак сервера `pins2`) — `kind: 'pin'`, `messageId` —
   * закреплённое; действие в группе (07.10, #211, С4, признак `groups1`) — `kind: 'group'`: «создал(а) группу», «добавил(а)»,
   * «удалил(а)», «покинул(а)», «изменил(а) название / фото» (Telegram `HistoryService`, `lng_action_*`). Автор строки — тот,
   * кто сделал действие. Текст в `content` — запасная фраза по-русски для клиента, который вид не знает (он покажет её
   * обычным сообщением или пилюлей). Нет поля — обычное сообщение. Незнакомый `kind` клиент считает отсутствием поля
   * (правило 11): клиент 0097 узнаёт только `pin`, группы ему сервер не отдаёт вовсе. Запись о звонке (08.10, С5, `calls1`) —
   * `kind: 'call'` (`shared/calls.ts`): автор — звонивший, подпись строит читатель (`callServiceText`).
   */
  service?: ConvServiceMark;
  /**
   * Вид сообщения (14.10, G69, признак сервера `geocontact1`): геопозиция `{ kind: 'geo' }` или карточка контакта
   * `{ kind: 'contact' }` (`shared/convMedia.ts`). `content` у такого — запасная фраза для клиента, который вид не знает; новый
   * клиент рисует карточку. Незнакомый `kind` клиент считает отсутствием поля (правило 11). Нет поля — обычное сообщение.
   */
  media?: ConvMediaMark;
}

/** Метка служебной строки ленты ЛС (`ConvMessage.service`): общий дискриминатор `kind`. */
/** `ConvCallService` (08.10, `calls1`, G68) — запись о звонке, `shared/calls.ts`. */
export type ConvServiceMark = ConvPinService | ConvGroupService | ConvCallService;

/** Закреп «для обоих» (G28, `pins2`). */
export interface ConvPinService {
  kind: 'pin';
  /** Закреплённое сообщение — к нему ведёт щелчок по строке. */
  messageId: string;
}

/** Вид действия в группе (`ConvGroupService.type`). Незнакомый вид клиент показывает текстом `content`. */
export type ConvServiceType = 'create' | 'add' | 'remove' | 'leave' | 'title' | 'photo';

/** Действие в группе (`groups1`): автор строки — тот, кто сделал действие. */
export interface ConvGroupService {
  kind: 'group';
  type: ConvServiceType;
  /** Кого коснулось («добавил», «удалил») — снимок имён на момент действия. */
  users?: { id: string; displayName: string }[];
  /** Новое название («создал группу», «переименовал»). */
  title?: string;
}

/** Сообщения для этого человека больше нет: удалено у обоих, спрятано им «у себя» или чужое придержанное. */
export interface ConvGone {
  id: string;
  conversationId: string;
  gone: true;
}

/** Последнее видимое МНЕ сообщение беседы — для строки списка. */
export interface ConvLastMessage {
  id: string;
  authorId: string;
  /** Текст в одну строку, не длиннее 200 символов. */
  text: string;
  attachments: number;
  /**
   * Что за вложения (раунд 11, превью в списке бесед): `photo` — все вложения картинки, `voice` — голосовое, `file` —
   * остальное (и смесь), `sticker` — стикер (в ЛС стикеров пока нет, сервер его не шлёт). Есть, только когда
   * `attachments > 0`. Поля нет при вложениях — сервер до раунда 11 или сводка из кеша клиента, снятая до его
   * обновления: клиент пишет «Вложение» / «N вложений». Незнакомое значение клиент считает отсутствием поля (правило 11).
   */
  attachmentKind?: ConvAttachmentKind;
  /**
   * Голосовое: длительность, мс — «Голосовое · 0:42». У видео (`attachmentVideo`) — его длительность, если вложение её
   * несёт. Нет — длительность неизвестна.
   */
  attachmentDurationMs?: number;
  /** Файл (`attachmentKind: 'file'`): имя первого — «Файл: маршрут.gpx». */
  attachmentName?: string;
  /**
   * Все вложения — видео (`video/*`, 05.10): клиент пишет «Видео» / «3 видео», а не «Файл: клип.mp4». Вид при этом
   * остаётся `file` с именем первого: клиент до этой правки пишет «Файл: имя», как раньше. Поле только у таких.
   */
  attachmentVideo?: true;
  /**
   * Все вложения — GIF (08.10, `gifs1`; Telegram `AttachGif` / tdesktop `isAnimation` → «GIF»): клиент пишет «GIF», а не «Фото» /
   * «Видео». Вид при этом прежний (`photo` у `image/gif`, `file` + `attachmentVideo` у GIF-видео): клиент без поля пишет как раньше.
   * Поле только у таких вложений (правило 11 — только добавление).
   */
  attachmentGif?: true;
  /**
   * Голосовое «Прослушать один раз» (08.10, `voice3`, G54): «Одноразовое голосовое сообщение» (tdesktop
   * `lng_in_dlg_voice_message_ttl`). Поле только у таких; клиент без поля пишет «Голосовое», как раньше.
   */
  attachmentOnce?: true;
  /**
   * Видеосообщение-кружок (08.10, `circles1`, G68): «Видеосообщение» (tdesktop `lng_in_dlg_video_message`), с `attachmentOnce` —
   * «Одноразовое видеосообщение» (`lng_in_dlg_video_message_ttl`). Вид прежний (`file` + `attachmentVideo`): клиент без поля
   * пишет «Видео». Поле только у таких (правило 11 — только добавление).
   */
  attachmentRound?: true;
  /**
   * Мини-превью фото слева от текста строки (07.10, G34; Telegram Android `DialogCell.thumbImage`): ссылка СМОТРЯЩЕГО на
   * первую картинку, только у `attachmentKind: 'photo'`. Нет — значок вида, как раньше (старый сервер, не фото).
   */
  thumb?: string;
  /** Фото под спойлером (`media2`): миниатюра размыта. Поле только у таких. */
  thumbSpoiler?: true;
  /** Сообщение пересланное (07.10, G34): значок «переслано» перед превью (Telegram `mini_forwarded`). Поля нет — нет. */
  forwarded?: true;
  /**
   * Имя автора — только в группе (07.10, `groups1`): строка списка пишет «Имя: текст», как Telegram (`DialogCell`,
   * `fromName`). У служебной записи поля нет (её текст — уже фраза), своё сообщение клиент подписывает «Вы».
   */
  authorName?: string;
  /** Последнее — служебная запись группы (`ConvMessage.service`): текст строки без «Имя:». */
  service?: true;
  /**
   * Последнее — запись о звонке в 1:1 (`calls1`, 10.10): причина, длительность, видео ли. Строка списка собирает из неё ту же
   * подпись, что лента (`callServiceText`: звонивший, не дозвонившийся, — «Отменённый», принимающий — «Пропущенный»); без
   * поля (старый сервер) — запасной текст `text` («Пропущенный звонок»). Поле только у таких (правило 11 — добавление).
   */
  call?: Pick<ConvCallService, 'reason' | 'duration' | 'video'>;
  sortKey: number;
  createdAt: string;
}

/** Вид вложений последнего сообщения в строке списка бесед (`ConvLastMessage.attachmentKind`). */
export type ConvAttachmentKind = 'photo' | 'voice' | 'sticker' | 'file';

/** Беседа в списке — глазами спрашивающего. */
export interface ConvSummary {
  id: string;
  /** `group` — групповая беседа (07.10, `groups1`): приходит только клиенту, объявившему `groups1`. */
  kind: 'direct' | 'group';
  /**
   * «Избранное» (08.10, `saved1`): беседа с самим собой. Поле есть только у неё. `otherUser` — я сам; ✓✓, «был(а) в сети»,
   * звонка и «печатает» у такой беседы нет, непрочитанного не бывает. Старый клиент поля не знает.
   */
  saved?: boolean;
  /**
   * Собеседник 1:1. `null` — строки человека нет (не бывает при обезличивании, но список не должен падать); у группы —
   * всегда `null` (участники — в `group`).
   */
  /** `homeInstance` (Э1, #141) — только у собеседника с другого инстанса (добавление). */
  otherUser: Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl' | 'homeInstance'> | null;
  createdAt: string;
  /** Время последнего видимого мне сообщения (не общее время беседы: придержанное у получателя её не поднимает). */
  lastMessageAt: string | null;
  lastMessage: ConvLastMessage | null;
  /** Точное непрочитанное: видимые мне чужие сообщения новее моего «прочитано до». */
  unread: number;
  lastReadKey: number;
  /**
   * «Прочитано собеседником» (Р6, ✓✓; признак сервера `conv4`): наибольшее «прочитано до» остальных участников ГЛАЗАМИ
   * смотрящего, для 1:1 — собеседника. Моё сообщение с `sortKey <= peerReadKey` прочитано (✓✓), остальные мои —
   * «отправлено» (✓). `null` — сравнивать не с кем (других участников нет). Поля нет вовсе — сервер до `conv4`: только ✓.
   * Пока собеседник держит меня в чёрном списке, ключ не заходит на мои придержанные сообщения (Р12).
   */
  peerReadKey?: number | null;
  /**
   * Мой черновик в этой беседе (Р7, признак сервера `conv3`): между МОИМИ устройствами, собеседнику не виден никогда.
   * `null` — черновика нет (в том числе погашен отправкой сообщения). Поля нет вовсе — сервер черновики не хранит
   * (до `conv3`): клиент держит свой, как раньше.
   */
  draft?: ConvSummaryDraft | null;
  /**
   * Сколько у МЕНЯ отложенных сообщений в этой беседе (С4, признак сервера `conv9`): «Отправить позже» и «Когда будет в
   * сети» — по нему вход «Отложенные сообщения: N» в поле ввода (0 — входа нет). Только мои: собеседник о моих отложенных
   * не узнаёт ничего, пока они не отправлены. Считаются и не отправленные после повторов (`ConvScheduled.failed`). Поля нет
   * вовсе — сервер до `conv9` (отложенных у него нет).
   */
  scheduledCount?: number;
  /**
   * Когда я закрепил беседу наверху списка (07.10, признак сервера `conv11`); `null` — не закреплена. Закреплённые идут
   * первыми, свежезакреплённая выше. Только моя пометка. Поля нет вовсе — сервер до `conv11`.
   */
  pinnedAt?: string | null;
  /**
   * Уведомления от беседы выключены (07.10, `conv11`): `until` — до какого времени, `null` — навсегда; `null` вместо
   * объекта — не выключены (истёкшая заглушка тоже). Глушит пуш, звук, тост и мигание; счётчик серый. Для 1:1 это
   * заглушка собеседника (`push_mutes`, `dm_user`). Поля нет вовсе — сервер до `conv11` (тогда — список заглушек).
   */
  muted?: ConvMute | null;
  /**
   * Я пометил беседу «непрочитанной» (07.10, `conv13`, G04): точка без числа в моём списке; любое чтение беседы снимает.
   * Только моя пометка. Поля нет вовсе — сервер до `conv13`.
   */
  markedUnread?: boolean;
  /**
   * Беседа в моём архиве (07.10, `archive1`, G41): не показывается в основном списке, лежит за строкой «Архив». Только моя
   * отметка. Поля нет вовсе — сервер до `archive1` (клиент считает «не в архиве»).
   */
  archived?: boolean;
  /**
   * Плашка незнакомца (08.10, `stranger1`, С7, G30): мне написал человек без общего сервера, я ему не отвечал и плашку не
   * скрывал. Только моя сводка; поля нет — плашки нет (сервер до `stranger1`).
   */
  stranger?: boolean;
  /**
   * ЛС между инстансами, Э2 часть Б (#141, Ф7): только у беседы с человеком другого инстанса, когда связка с его инстансом
   * разорвана, на паузе или доверие потеряно — архив только для чтения (запись — 403 `federation.dm_link_broken`).
   * Поля нет — связка рабочая (или беседа местная). Добавление.
   */
  fedLink?: 'broken';
  /**
   * ЛС между инстансами, Э3 часть 1 (#141, `fedm3`): только у беседы 1:1 с человеком другого инстанса, чей инстанс не умеет
   * вложения (признак `dm2`) — файлы туда не уходят (загрузка и пересылка — 400 `federation.dm_attachments_later`), клиент
   * держит кнопки файлов закрытыми. Поля нет — файлы можно (или беседа местная). Добавление.
   */
  fedNoFiles?: true;
  /**
   * ЛС между инстансами, Э6 (#141, `fedcall1`): только у беседы 1:1 с человеком другого инстанса, чей инстанс не умеет звонки
   * (признак `dmcall1`) — кнопка звонка неактивна, `POST /conv/:id/call` — 409 `federation.unsupported`. Добавление.
   */
  fedNoCalls?: true;
  /**
   * Опрос (14.10, признак связки `dmpoll1`): только у беседы 1:1 с человеком другого инстанса, чей инстанс умеет опрос, — пункт
   * «Опрос» открыт (без поля у такой беседы — закрыт: копия у соседа была бы текстом, отправка — 403 `conv_poll_federated`).
   * Добавление.
   */
  fedPoll?: true;
  /**
   * ЛС между инстансами, исправления ревью 12.10 (#141, п. 7): инстанс собеседника не забирает наши сообщения дольше 10 минут,
   * хотя есть что забрать (лежит, не может достучаться, у него выключены ЛС) — плашка над полем «Сообщения ждут, пока «X» их
   * заберёт»; писать можно, сообщения доедут, когда он заберёт. Отдельное поле, а не значение `fedLink`: старый клиент на
   * любом `fedLink` показал бы архив без поля ввода. Поля нет — забирает (или беседа местная, или связка разорвана). Добавление.
   */
  fedStale?: true;
  /**
   * ЛС между инстансами, хвост Э7 (14.10, #141): только у 1:1 с человеком другого инстанса — его дом не отвечает нам дольше 10 минут
   * (тот же признак, что у дома группы в `fedGroupHost.down`: сеть / таймаут / 5xx на забор журнала). Плашка над полем «Инстанс «X»
   * недоступен — сообщения доедут, когда он вернётся»; писать можно. Важнее `fedStale` (одна плашка), архив `fedLink` важнее обеих.
   * Поля нет — отвечает (или беседа местная, или связка разорвана). Старый клиент поле не знает и показывает прежнее. Добавление.
   */
  fedPeerDown?: true;
  /**
   * ЛС между инстансами, Э7 часть 1 (#141, `fedm6`): только у группы, чей дом (инстанс создателя) — другой инстанс. Состав,
   * название и фото меняет только он: запросы уходят туда; лежит — 403 `federation.dm_group_host_down` (писать можно, доставка
   * остальным — когда вернётся). Фото группы чужого дома отсюда не меняется — 403 `federation.dm_group_host_only`. Добавление.
   */
  fedGroupHost?: { instanceId: string; down?: true };
  /**
   * Сколько МОИХ сообщений этой беседы с непрочитанными реакциями (07.10, `reactunread1`, G24): «♥ N» над «вниз» и значок ♥
   * в строке списка (Telegram: `unreadReactions().count`, считается по сообщениям, а не по реакциям). Реакции людей, которых
   * я заблокировал, и на удалённое/спрятанное мной не в счёте; своя реакция на своё сообщение — тоже. Поля нет вовсе —
   * сервер до `reactunread1`.
   */
  unreadReactions?: number;
  /**
   * Я больше не участник группы (08.10, #211, `groups3`): `at` — когда вышел, `removed` — удалил кто-то другой (иначе вышел
   * сам). Приходит только внутри `ConvLeft.former` и `ConvListResponse.former`; у действующей беседы поля нет.
   */
  former?: { at: string; removed: boolean };
  /**
   * Сколько сообщений беседы упоминают меня и не прочитаны (кнопка «@» над «вниз», G24). В беседах 1:1 упоминаний нет
   * (у Telegram кнопка есть только в группах и каналах), поэтому сервер поле пока не шлёт: оно зарезервировано под
   * групповые беседы, клиент его уже читает. Поля нет — «@» не показывается.
   */
  unreadMentions?: number;
  /** Группа (07.10, #211, С4, `groups1`): название, фото, участники. Только у `kind: 'group'`. */
  group?: ConvGroupInfo;
}

/**
 * Групповая беседа (С4, решение владельца Р-5): до `limit` участников вместе с создателем; больше — «Создать сервер».
 * Участники — действующие (вышедшие и удалённые сюда не попадают), по времени входа.
 */
export interface ConvGroupInfo {
  title: string;
  avatarUrl: string | null;
  /** Создатель — как владелец: только он удаляет участников. `null` — вышел и передать было некому. */
  ownerId: string | null;
  members: ConvGroupMember[];
  /** Предел участников вместе с создателем (`GROUP_MEMBER_LIMIT`). */
  limit: number;
}

export interface ConvGroupMember {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'owner' | 'member';
  /** Э7 часть 1 (#141, `fedm6`): только у участника с другого инстанса — значок инстанса (как `otherUser.homeInstance`). Добавление. */
  homeInstance?: User['homeInstance'];
}

/** `POST /api/conv/group` (`groups1`): название обязательно, `userIds` — кроме себя, 1…`GROUP_MEMBER_LIMIT - 1`. */
export interface CreateGroupRequest {
  title: string;
  userIds: string[];
}

/** Предел участников группы ЛС вместе с создателем (решение владельца Р-5): больше — «Создать сервер». */
export const GROUP_MEMBER_LIMIT = 5;
/**
 * Ключ заглушки группы (`groups2`, 07.10) в `push_mutes`: та же область `dm_user`, цель — `group:<id беседы>`. Клиент
 * держит у группы `otherUser.id = group:<id>` (`convSyncRules.summaryToDm`), так что «Выключить уведомления ▸» шапки,
 * строки и свайпа работает без новой области; сервер до `groups2` такую строку хранит, но не применяет.
 */
export const GROUP_MUTE_PREFIX = 'group:';
export function groupMuteTarget(conversationId: string): string {
  return `${GROUP_MUTE_PREFIX}${conversationId}`;
}
/** id беседы из цели заглушки группы; не группа — `null`. */
export function groupOfMuteTarget(targetId: string): string | null {
  return targetId.startsWith(GROUP_MUTE_PREFIX) && targetId.length > GROUP_MUTE_PREFIX.length ? targetId.slice(GROUP_MUTE_PREFIX.length) : null;
}

/** Предел длины названия группы (Telegram — 128). */
export const GROUP_TITLE_MAX = 128;

/**
 * Заглушка беседы (`ConvSummary.muted`): до какого времени, `null` — навсегда. `soundOnly: true` (07.10, `conv13`) —
 * «Выключить звук»: уведомление приходит, но без звука; поля нет — полная заглушка.
 */
export interface ConvMute {
  until: string | null;
  soundOnly?: boolean;
}

/** Черновик в сводке беседы (Р7). */
export interface ConvSummaryDraft {
  text: string;
  replyToId: string | null;
  /** Когда записан (время сервера). */
  at: string;
  /** Метка устройства, записавшего черновик (`PUT /conv/:id/draft`): своё эхо клиент не применяет. */
  device: string | null;
}

/** `PUT /api/conv/:id/draft` (Р7): пусто (ни текста, ни ответа) — удалить. */
export interface ConvDraftRequest {
  text: string;
  replyToId: string | null;
  device: string;
}

/**
 * `POST /api/conv/:id/forward` (признак `conv5`): переслать сообщения беседы `fromConversationId` в беседу `:id`.
 * Пересылающий — участник обеих, сообщения видны ему и не удалены; порядок в беседе-получателе — порядок оригиналов
 * (не порядок `messageIds`). Текст и вложения копируются, цитата (`replyTo`) — нет. `clientId` — id отправки ВСЕЙ пачки:
 * повтор с ним и теми же сообщениями — 200 и те же сообщения, с другими — 409 `client_id_conflict`.
 */
export interface ConvForwardRequest {
  clientId: string;
  fromConversationId: string;
  /** 1…100, без повторов. */
  messageIds: string[];
  /**
   * Переслать «без звука» (С3, признак `conv8`): все сообщения пачки — `silent`, пуш пачки — с `silent: true`. Нет поля
   * или `false` — как обычно. Признак оригинала НЕ переносится: «без звука» — свойство отправки, а не сообщения. Сервер
   * без `conv8` поле молча отбрасывает (пересылка уйдёт со звуком) — слать только при признаке.
   */
  silent?: boolean;
  /**
   * «Скрыть имя отправителя» (G71, признак `fwd2`, Telegram «Hide sender name»): копии — обычные сообщения пересылающего, без
   * `forwardedFrom`. Только добавление: сервер без `fwd2` поле отбросит и покажет автора — слать только при признаке.
   */
  hideSender?: boolean;
  /** «Скрыть подписи» (G71, `fwd2`): у сообщений с вложением текст не копируется. Слать только при `fwd2`. */
  hideCaptions?: boolean;
  /**
   * Переслать ОДИН элемент альбома (G56, признак `album1`; `messageIds` — ровно одно сообщение, у элемента есть `id`): новое
   * сообщение только с ним, без подписи альбома. Сервер без `album1` поле отбросит и перешлёт альбом целиком — слать только при признаке.
   */
  attachmentId?: string;
}

/** Ответ удаления одного элемента альбома (G56, `album1`): `item` — убран элемент (или повтор), `message` — сообщение целиком. */
export interface ConvAlbumItemDeleteResponse {
  removed: 'item' | 'message';
}

/** Ответ пересылки: новые сообщения по порядку (201), при повторе — они же в нынешнем виде (200, бывает `gone`). */
export interface ConvForwardResponse {
  messages: (ConvMessage | ConvGone)[];
}

/**
 * `POST /api/conv/:id/messages/delete` (признак `conv5`): удалить пачкой, правила — как у удаления по одному: `both` —
 * свои, а в беседе 1:1 при признаке `conv6` (С1) — и чужие видимые; `me` — любые видимые. Пачка целиком или ничего
 * (чужое «у обоих» там, где нельзя, — 403, не этой беседы — 404). Уже исчезнувшее для меня (удалено у обоих, спрятано
 * мной) — пропускается молча. Ответ 204.
 */
export interface ConvDeleteManyRequest {
  /** 1…100, без повторов. */
  ids: string[];
  for: 'me' | 'both';
}

/**
 * Закреплённое сообщение беседы ГЛАЗАМИ смотрящего (С2, признак сервера `conv7`). Закреп — у каждого свой: «для меня»
 * видит только закрепивший, «для обоих» — оба; собеседнику не виден ни мой закреп «для меня», ни моё «открепить у меня».
 */
export interface ConvPin {
  /**
   * Превью закреплённого — та же форма, что последнее сообщение в строке списка бесед (раунд 11): автор, текст в одну
   * строку (до 200 символов), число и вид вложений, ключ порядка и время. Само сообщение может быть вне загруженного окна
   * ленты — для перехода к нему `GET /conv/:id/messages?around=<message.id>`.
   */
  message: ConvLastMessage;
  /** Миниатюра — ссылка смотрящего на первое фото (только у `attachmentKind: 'photo'`). Нет — без миниатюры. */
  thumb?: string;
  /** Фото под спойлером (`media2`): миниатюра размыта. Поле только у таких. */
  thumbSpoiler?: true;
  /**
   * Закреплено «для обоих» — при откреплении показывать галочку «Также открепить для собеседника». Это свойство МОЕГО
   * закрепа (как его ставили), а не живая проверка у собеседника: его «открепить у меня» мне не видно.
   */
  forBoth: boolean;
  /** Кто закрепил (у закреплённого «для обоих» — тот, кто поставил галочку). */
  pinnedBy: string;
  pinnedAt: string;
}

/** Закреплённые одной беседы — полный список (замена, не дельта), от старых к новым по порядку ленты. */
export interface ConvPinsOf {
  conversationId: string;
  pins: ConvPin[];
}

/**
 * `GET /api/conv/:id/pins` и ответ закрепа/открепления (признак `conv7`): мои закреплённые беседы, от старых к новым по
 * порядку сообщений в ленте. `pts` — номер журнала, согласованный со списком: список из события или догонки с номером не
 * больше этого — не новее (держать свежесть по номерам, как у сводки).
 */
export interface ConvPinsResponse {
  pts: number;
  pins: ConvPin[];
}

/**
 * `PUT /api/conv/:id/messages/:mid/pin` (признак `conv7`): закрепить видимое мне живое сообщение — `me` только у себя,
 * `both` ещё и у собеседника. Открепить — `DELETE` того же адреса с `?for=me|both`: `me` — только у себя, `both` — и
 * закреп «для обоих» у собеседника. Ответ обоих — `ConvPinsResponse`; предел — 409 `{error: 'pin limit', max}`.
 */
export interface ConvPinRequest {
  for: 'me' | 'both';
  /**
   * G4 (14.10): только группа и `for: 'both'` — галочка «Уведомить всех участников» окна закрепа (Telegram `PinNotify`): `true` —
   * участникам пуш «закрепил(а) «…»», `false` — строка закрепа «без звука». Нет поля — как раньше (без пуша). 1:1 поле не читает.
   */
  notify?: boolean;
}

/**
 * Отложенное сообщение (С4, признак сервера `conv9`, как в Telegram): «Отправить позже» (`sendAt`) или «Когда будет в
 * сети» (`whenOnline`, только 1:1 — уйдёт, когда собеседник появится в сети). Лежит на сервере и уходит, даже если автор
 * не в сети: обычной отправкой, со всеми её правилами (журнал, события обоим, пуш, «без звука», блокировка — придержано).
 * Время сообщения в ленте — время ФАКТИЧЕСКОЙ отправки. Видит отложенные только автор. С вложениями — с признаком сервера
 * `conv10` (без него — только текст, вложения — 400).
 */
export interface ConvScheduled {
  id: string;
  conversationId: string;
  /**
   * id отправки от клиента при создании (повтор создания с ним — 200, без дубля). Тот же id получит и само сообщение, когда
   * уйдёт (`ConvMessage.clientId`): по нему клиент автора свяжет «было в отложенных» с сообщением в ленте.
   */
  clientId: string;
  /** Текст (после `trim`, до 4096). Пустой — только у отложенного с вложениями (`conv10`): фото без подписи. */
  content: string;
  /**
   * Вложения (06.10, `conv10`) — поле только у отложенного с файлами, в порядке отправки, в том же виде, что у сообщения:
   * `url` — ссылка СМОТРЯЩЕГО (автора) на закрытый файл, своя и гаснущая, — кешировать можно только `id`.
   */
  attachments?: Attachment[];
  /**
   * Ответ на сообщение — цитата глазами автора, как у сообщения. Ко времени отправки цитируемое удалено или спрятано — уйдёт
   * без ответа (как в Telegram), а не застрянет.
   */
  replyTo: MessageReplyPreview | null;
  /** Уйдёт «без звука» (С3) — поле только у таких. */
  silent?: true;
  /** Подпись над медиа (`media2`, G48) — поле только у таких; уйдёт в сообщение. */
  captionAbove?: true;
  /** «Отправить позже»: когда (ISO). `null` — режим «Когда будет в сети». */
  sendAt: string | null;
  /** «Когда будет в сети» (`sendAt` тогда `null`). */
  whenOnline: boolean;
  createdAt: string;
  /** Когда правили текст (`null` — не правили). */
  editedAt: string | null;
  /**
   * Не отправлено и сервер больше не пытается (поле только у таких): `peer-gone` — собеседник удалил аккаунт, писать некому;
   * `error` — отправка падала после всех повторов. Вернуть в работу — «Отправить сейчас» или новое время/режим; удалить — как
   * обычно.
   */
  failed?: ConvScheduledFailure;
}

export interface ConvScheduledFailure {
  at: string;
  reason: 'peer-gone' | 'error';
}

/** Отложенные одной беседы — полный список (замена, не дельта): сначала по времени, затем «когда будет в сети». */
export interface ConvScheduledOf {
  conversationId: string;
  items: ConvScheduled[];
}

/**
 * `GET /api/conv/:id/scheduled` и ответ создания, правки и удаления (`conv9`): мои отложенные беседы и номер журнала,
 * согласованный со списком (список из `conv.change`/догонки с номером не больше этого — не новее).
 */
export interface ConvScheduledResponse {
  pts: number;
  items: ConvScheduled[];
}

/**
 * `POST /api/conv/:id/scheduled` (`conv9`): ровно одно из `sendAt` (ISO с поясом, от «сейчас» минус минута — расхождение
 * часов — до года вперёд) и `whenOnline: true`. Предел — 100 в беседе и 500 всего у человека (409 `{error: 'scheduled
 * limit', scope, max}`). Вложения — только при `conv10` (сервер до него отвечает 400 `scheduled attachments unsupported`):
 * id загрузок `POST /api/conv/:id/attachments` + подсказки клиента, как у отправки, до 10; текст тогда может быть пустым;
 * свои пределы — 409 с `reason: 'scheduled_media_limit'`.
 */
export interface ConvScheduleRequest {
  clientId: string;
  content: string;
  /** `conv10`: вложения отложенного — id загрузок и подсказки клиента (размеры картинки, огибающая), как у отправки. */
  attachments?: Array<Pick<Attachment, 'width' | 'height' | 'waveform' | 'durationMs' | 'asFile' | 'gif' | 'spoiler'> & { id: string }>;
  replyToId?: string | null;
  silent?: boolean;
  /** `media2`: подпись над медиа (только при подписи и вложении). */
  captionAbove?: boolean;
  sendAt?: string;
  whenOnline?: boolean;
}

/**
 * `PATCH /api/conv/:id/scheduled/:sid` (`conv9`): хотя бы одно поле. `content` — новый текст (пустой — только у
 * отложенного с вложениями, `conv10`: «убрать подпись»; вложения правка не трогает); `sendAt` или `whenOnline: true` (не
 * оба) — новое время или режим, это же снимает отметку «не отправлено» (`failed`) и счётчик повторов.
 */
export interface ConvScheduledEditRequest {
  content?: string;
  sendAt?: string;
  whenOnline?: true;
}

/** Ответ «Отправить сейчас» (`POST /api/conv/:id/scheduled/:sid/send`, `conv9`): ушедшее сообщение и мой список без него. */
export interface ConvScheduledSendResponse {
  message: ConvMessage;
  pts: number;
  items: ConvScheduled[];
}

/** Я больше не участник беседы — клиент убирает её из списка. */
export interface ConvLeft {
  id: string;
  left: true;
  /**
   * Бывшая группа (08.10, #211, `groups3`): я вышел или меня удалили, а беседу я не убирал — сводка на момент выхода
   * (`former` в ней заполнено), клиент с `groups3` держит беседу в списке только на чтение: история до выхода видна,
   * новые сообщения не приходят, вместо поля ввода — плашка «Вы покинули группу» / «Вас удалили из группы» и «Удалить
   * группу» (Telegram: `YouLeft` / `YouWereKicked`, `DeleteThisGroup`). Старый клиент поле не знает и беседу убирает.
   */
  former?: ConvSummary;
}

export interface ConvListResponse {
  /** Номер журнала, согласованный со списком (одна транзакция), — с него начинается догонка. */
  pts: number;
  conversations: ConvSummary[];
  /** Бывшие группы (`groups3`, только на `GET /api/conv?former=1`): сводки с `former`, только на чтение. */
  former?: ConvSummary[];
}

export interface ConvHistoryResponse {
  pts: number;
  /** Старые сверху, новые снизу. */
  messages: ConvMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

/** Одно найденное поиском по беседе (`GET /api/conv/:id/search`, признак `search1`): куда перейти (`around`). */
export interface ConvSearchHit {
  id: string;
  sortKey: number;
  createdAt: string;
  authorId: string;
}

/** Одно найденное поиском из списка (`GET /api/conv/search`, `gsearch1`): беседа, сообщение и его текст для строки результата. */
export interface ConvSearchAllHit extends ConvSearchHit {
  conversationId: string;
  /** Текст сообщения (до 400 знаков — клиент вырезает кусок вокруг совпадения). */
  content: string;
  /**
   * Целое сообщение — только на запрос с `full=1` (12.10, вкладки поиска на телефоне: сетка медиа, строки файлов и голосовых).
   * Старый сервер поля не шлёт — клиент показывает строку найденного, как раньше.
   */
  message?: ConvMessage;
}

/** Порция поиска по всем беседам: новые первыми; `next` — курсор следующей (более старой) порции, `null` — конец. */
export interface ConvSearchAllResponse {
  hits: ConvSearchAllHit[];
  next: string | null;
}

/** Одна «частая» беседа (`GET /api/conv/frequent`, `freq1`, G35): `score` — взвешенное число моих сообщений, `lastAt` — моё последнее. */
export interface ConvFrequentItem {
  conversationId: string;
  score: number;
  lastAt: string;
}

/** Ответ `GET /api/conv/frequent`: самые частые первыми (до `limit ≤ 30`). */
export interface ConvFrequentResponse {
  items: ConvFrequentItem[];
}

/**
 * «Убрать из частых» на сервере (09.10, `freq2`): беседы и когда убраны. `at` — для разового переноса убранных на устройстве
 * (`freq1` помнил их в `localStorage`); нет — «сейчас». Сервер берёт не позже своего «сейчас» и не раньше прежней отметки.
 * Убранная возвращается в `GET /conv/frequent`, когда моё последнее сообщение в ней новее отметки.
 */
export interface ConvFrequentHideRequest {
  items: { conversationId: string; at?: string }[];
}

/** Ответ `POST /api/conv/frequent/hide`: сколько моих бесед отмечено (чужие и неизвестные id молча пропущены). */
export interface ConvFrequentHideResponse {
  hidden: number;
}

/** `GET /api/conv/:id/unread-reactions` (`reactunread1`, G24): сообщения с непрочитанными реакциями, самые старые первыми (до 50). */
export interface ConvUnreadReactionsResponse {
  /** Сколько всего (может быть больше `messages.length`). */
  total: number;
  messages: { id: string; sortKey: number }[];
}

/** Порция поиска по беседе: новые первыми; `total` — всего найдено; `next` — курсор следующей (более старой) порции. */
export interface ConvSearchResponse {
  total: number;
  hits: ConvSearchHit[];
  next: string | null;
}

/**
 * Догонка `GET /api/conv/sync?pts=N`. Сущности — в ТЕКУЩЕМ виде глазами спрашивающего (журнал хранит указатели,
 * поэтому три правки подряд и «удалили раньше, чем я узнал о создании» сворачиваются сами).
 * `reset` — журнал уже обрезан (или сервер «моложе» клиента): перечитать список и открытые беседы.
 */
export type ConvSyncResponse =
  | { reset: true; pts: number }
  | {
      reset: false;
      /** При `more` — номер последней отданной строки журнала: следующий запрос — с него. */
      pts: number;
      more: boolean;
      conversations: (ConvSummary | ConvLeft)[];
      messages: (ConvMessage | ConvGone)[];
      /**
       * Закреплённые (С2, `conv7`) — ПОЛНЫЕ списки бесед, у которых в этой порции журнала менялся мой список закрепа
       * (закрепили, открепили, удалили или поправили закреплённое). Поля нет — таких изменений нет (или сервер до `conv7`).
       */
      pins?: ConvPinsOf[];
      /**
       * Отложенные (С4, `conv9`) — ПОЛНЫЕ списки МОИХ отложенных по беседам, где в этой порции журнала они менялись
       * (создал, поправил, перенёс, удалил, ушло, не отправилось). Поля нет — таких изменений нет (или сервер до `conv9`).
       */
      scheduled?: ConvScheduledOf[];
    };

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

/**
 * Кто может начать личную переписку (05.10, настройка инстанса `instance_settings.dm_policy`). `shared` — только тот, с
 * кем есть общий сервер (как было с 15.09); `anyone` — любой свой живой пользователь инстанса (найденный по @имени).
 * Нет настройки = `shared`. Уже начатые переписки открываются при любой политике.
 */
export type DmPolicy = 'shared' | 'anyone';

/**
 * Человек из поиска `GET /api/users/search?q=` (признак `users1`): только то, что нужно строке выбора «Написать», — без
 * почты и онлайна. Ищутся только свои живые люди инстанса.
 */
export type UserSearchHit = Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl'>;

/** Ответ `GET /api/users/search?q=`: точное совпадение логина первым, затем по началу логина, до 8 строк. */
export interface UserSearchResponse {
  users: UserSearchHit[];
  /**
   * ЛС между инстансами, Э1 (#141, `fedm1`): люди связанных инстансов из кеша каталога — по `@имя@домен` (точное имя) или по
   * началу имени. Скрытых от соседей каталог не отдаёт (Ф11). Нет поля — сервер старше или ЛС между инстансами выключены.
   */
  remote?: RemoteUserHit[];
}

/** Человек связанного инстанса в поиске (`fedm1`): «Написать» — `POST /conv/direct { instanceId, homeUserId }`. */
export interface RemoteUserHit {
  instanceId: string;
  homeUserId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** Подпись инстанса для значка — как `User.homeInstance`. */
  instance: { name: string | null; domain: string };
}

/**
 * Контакт (08.10, #211, признак `contacts1`, решение владельца 08.10 п.7): человек из МОЕГО списка «Контакты», как у Telegram.
 * `name` — моя подпись к нему (Telegram `EditContactBox`: имя контакта видно только мне), `null` — его собственное имя.
 * Список личный: сам человек не узнаёт, что он у меня в контактах.
 */
export interface ContactRow extends UserSearchHit {
  name: string | null;
  /** Когда добавлен (ISO). */
  addedAt: string;
}

/** Ответ `GET /api/contacts` и каждой записи в нём; событие `contacts.update` несёт то же целиком. */
export interface ContactList {
  contacts: ContactRow[];
}

/** Публичные сведения об инстансе — `GET /api/instance`, без входа. */
export interface InstanceInfo {
  name: string | null;
  iconUrl: string | null;
  registration: RegistrationPolicy;
  /**
   * Работает ли на этом инстансе федерация (F4, #139).
   *
   * 🔴 Клиенту это нужно не ради красоты: маршрутов федерации на выключенном инстансе НЕТ ВОВСЕ
   * (404), и без признака окно проверки ссылки узнавало бы об этом только отказом — то есть
   * показывало бы человеку поломку там, где её нет. Необязательное: инстанс постарше поля не
   * пришлёт, и это честно читается как «выключена» (`docs/federation-compat.md`).
   */
  federation?: boolean;
  /**
   * Название инстанса ДЛЯ СОСЕДЕЙ — то, что в визитке федерации (`GET /fed/v1/instance` → `name`, вкладка «Федерация» →
   * «Этот инстанс»); `name` выше — с вкладки «Инстанс», соседям не уходит (приёмка ЛС 13.10: у получателя подпись «через
   * «voice.example.org»», хотя сосед видит название). Только при работающей федерации; нет названия — `null`.
   * Необязательное: инстанс постарше поля не пришлёт.
   */
  fedName?: string | null;
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
  /** Кто может начать личную переписку (05.10). Необязательное: бэкенд постарше поля не пришлёт — выбора нет. */
  dmPolicy?: DmPolicy;
  /**
   * ЛС между инстансами, Э1 (#141, Ф6): кто из людей связанных инстансов может первым написать нашим. Поле есть, только пока
   * у инстанса включён `FEDERATION_DM_ENABLED`; нет поля — выбора в панели нет.
   */
  fedDmPolicy?: 'shared' | 'anyone';
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
 * Набор общего каталога стикеров инстанса (С2, #211, признак `stickers2`): то, что люди загрузили на любой сервер инстанса
 * или себе в ЛС. `GET /api/stickers/catalog` отдаёт обложку (первый стикер) и число, `GET /api/stickers/packs/:id` — набор
 * целиком (`stickers`), `GET /api/stickers/mine` — «мои наборы» целиком в моём порядке.
 */
export interface StickerCatalogPack extends StickerPack {
  /** Сколько стикеров в наборе (в каталоге `stickers` — только обложка). */
  count: number;
  /** Набор стоит в «моих» у спрашивающего. */
  mine: boolean;
  /** Спрашивающий может убрать набор из каталога: загрузил его сам или он админ инстанса. */
  canDelete: boolean;
}

/** Ответ `GET /api/stickers/catalog`. */
export interface StickerCatalog {
  packs: StickerCatalogPack[];
  /** Сколько наборов спрашивающий уже загрузил и сколько можно (`STICKER_PACKS_PER_USER`). */
  uploaded: number;
  uploadLimit: number;
  /** Загрузка из Telegram настроена на инстансе (токен бота); без неё доступен только каталог. */
  importEnabled: boolean;
}

/**
 * Избранные и недавние стикеры человека (С2 порция 2, признак `stickers3`): `GET /api/stickers/lists`, ответ каждой правки
 * и событие `stickers.update` его устройствам. Новый — первым; только стикеры каталога.
 */
export interface StickerLists {
  faved: Sticker[];
  recent: Sticker[];
  /** Сколько можно избранных (`STICKERS_FAVED_MAX`). */
  favedLimit: number;
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

/**
 * Сводка непрочитанного по всему инстансу — для значков в рейле, когда шлюз к инстансу открыт, а
 * человек смотрит на другой (#139, §5.7). Считается тем же правилом, что `reads` в bootstrap.
 */
export interface UnreadSummary {
  /** serverId → сколько непрочитанных сообщений и сколько из них упоминают меня. */
  servers: Record<string, { unread: number; mentions: number }>;
  /** Сколько бесед в личке с непрочитанным (значок у самой личке — про беседы, а не про сообщения). */
  dms: number;
  /** Сколько непрочитанных сообщений в личке всего. */
  dmUnread: number;
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

/** Сообщение собеседника, приложенное к жалобе из ЛС (08.10, `stranger1`): текст урезан, вложение — пометкой. */
export interface DmReportEvidence {
  messageId: string;
  text: string;
  at: number;
}

/** Строка списка жалоб из ЛС у супер-админа (08.10, `stranger1`, С7). */
export interface DmReportRow {
  id: string;
  reason: string;
  comment: string | null;
  evidence: DmReportEvidence[];
  status: 'new' | 'closed';
  createdAt: string;
  reporter: { id: string; username: string; displayName: string };
  reported: { id: string; username: string; displayName: string };
}

/** Одно найденное поиском по серверам (`GET /api/search/servers`, `srvsearch1`): сообщение канала с подписью «#канал · Сервер». */
export interface ServerSearchHit {
  id: string;
  channelId: string;
  channelName: string;
  serverId: string;
  serverName: string;
  authorId: string;
  /** Ник на этом сервере, иначе имя профиля. */
  authorName: string;
  authorAvatarUrl: string | null;
  /** Текст сообщения (до 400 знаков — клиент вырезает кусок вокруг совпадения). */
  content: string;
  createdAt: string;
}

/**
 * С какой длины запроса ищет `GET /search/servers` (08.10, решение владельца 21): от 3 знаков — короче триграммный индекс
 * (0121) не помогает, и запрос превращается в проход по всем сообщениям каналов. Короче — пустой ответ (не 400: старый клиент
 * шлёт от 2 знаков и просто не увидит результатов). Вкладки поиска и личные беседы — по-прежнему от 2.
 */
export const SERVER_SEARCH_MIN_CHARS = 3;

/** Порция поиска по серверам: новые первыми; `next` — курсор следующей (более старой) порции, `null` — конец. */
export interface ServerSearchResponse {
  hits: ServerSearchHit[];
  next: string | null;
}

/** «Переставить закреплённые беседы» (08.10, `pinorder1`): полный новый порядок моих закреплённых, сверху вниз. */
export interface ConvPinOrderRequest {
  ids: string[];
}

/**
 * Ответ на перестановку: все мои закреплённые сверху вниз и их новые отметки `pinnedAt` (те же, что придут в сводках
 * `conv.change`). Закреплённые, которых не было в `ids` (закреп с другого устройства в ту же секунду), — после названных,
 * в прежнем порядке.
 */
export interface ConvPinOrderResponse {
  pins: { id: string; pinnedAt: string }[];
}
