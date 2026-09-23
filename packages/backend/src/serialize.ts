import type {
  Poll,
  Attachment,
  Category,
  Channel,
  ChannelType,
  CustomStatus,
  Invite,
  Message,
  MessageReplyPreview,
  MessageSticker,
  PresenceStatus,
  ReactionGroup,
  Role,
  Server,
  User,
  UserBrief,
} from '@gusvoice/shared';
import { previewAllows } from '@gusvoice/shared';
import { isSuperAdmin } from './auth.js';
import { asUserId } from './superAdminRules.js';
import { env } from './env.js';
import { instanceLabel } from './federation/instanceLabels.js';
import { statusFieldsOf } from './statusRules.js';
import { animatedAvatarFor, avatarRentalActive } from './shopRules.js';

type UserRow = {
  id: string;
  username: string;
  email?: string | null;
  verified?: boolean;
  approvedAt?: Date | null;
  canCreateServers?: boolean;
  displayName: string;
  avatarUrl: string | null;
  animatedAvatarUrl?: string | null;
  animatedAvatarUnlocked?: boolean;
  animatedAvatarUntil?: Date | null;
  economyWelcomeSeenAt?: Date | null;
  totpEnabled?: boolean;
  /** Теневая строка гостя (§5.5): чей он и как его зовут дома. У местного — пусто. */
  homeInstanceId?: string | null;
  homeUsername?: string | null;
  presenceStatus?: string | null;
  presenceAuto?: boolean | null;
  customStatusEmoji?: string | null;
  customStatusText?: string | null;
  customStatusExpiresAt?: Date | null;
  steamId?: string | null;
  steamPersona?: string | null;
  showGameActivity?: boolean | null;
  createdAt: Date;
};

// `statusFieldsOf` живёт в `statusRules.ts` (чистая, с явным `now`). Реэкспорт — чтобы `servers.ts`
// и прочие продолжали брать её отсюда, вместе с остальными сериализаторами.
export { statusFieldsOf } from './statusRules.js';

export function serializeUser(u: UserRow): User {
  return {
    id: u.id,
    /**
     * 🔴 У ГОСТЯ наружу уходит его ДОМАШНИЙ ник, а не служебный логин теневой строки (#139, F4).
     * Служебный — это `<id>@<instance_id>`: он существует ради того, чтобы никогда не столкнуться с
     * настоящим логином (§5.5), и человеку показывать его нельзя ни в профиле, ни в упоминании.
     * ⚠️ Отсюда следствие: по этому полю НЕЛЬЗЯ искать человека в базе — только показывать.
     */
    username: u.homeUsername || u.username,
    /** Откуда он, если гость. Значок инстанса рисуется по этому полю (§5.7). */
    homeInstance: u.homeInstanceId ? instanceLabel(u.homeInstanceId) : null,
    email: u.email ?? null,
    verified: u.verified ?? false,
    // Только если строку выбирали целиком: у урезанных выборок (автор сообщения) поля нет — и не врём «не одобрен».
    approved: u.approvedAt === undefined ? undefined : !!u.approvedAt,
    superAdmin: isSuperAdmin(asUserId(u.id)),
    canCreateServers: u.canCreateServers ?? false,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    /**
     * 🔴 Анимация отдаётся ТОЛЬКО пока действует аренда (30 дней, решение 02.09). Истекла —
     * наружу уходит `null`, и клиент показывает обычный аватар.
     * ⚠️ Сам файл при этом НЕ удаляется и ссылка в базе остаётся: продлил — анимация вернулась без
     * перезаливки. Отбирать загруженное за просрочку было бы наказанием сверх цены.
     */
    animatedAvatarUrl: animatedAvatarFor(u.animatedAvatarUrl, u.animatedAvatarUntil, new Date()),
    /** Право загрузить анимацию = действующая аренда. Старый вечный флаг больше не спрашиваем. */
    animatedAvatarUnlocked: avatarRentalActive(u.animatedAvatarUntil ?? null, new Date()),
    animatedAvatarUntil: u.animatedAvatarUntil ? u.animatedAvatarUntil.toISOString() : null,
    // Приветствие экономики показываем один раз на ЧЕЛОВЕКА, поэтому отметка едет с профилем.
    economyWelcomeSeen: !!u.economyWelcomeSeenAt,
    /**
     * 🔴 Видна ли этому человеку экономика вообще — флаг инстанса И список закрытого показа (#117).
     * Клиент по нему прячет вкладку «Монеты» и вовсе не ходит за кошельком: без этого владелец
     * ЧУЖОГО сервера видел бы вкладку сразу после включения флага (владельцу выдаются все права).
     * ⚠️ Едет только в СВОЁМ профиле и в админке: участников сервера сериализует `servers.ts`.
     */
    economyPreview: env.economyEnabled && previewAllows(env.economyPreviewUsers, u.id),
    /**
     * 🔴 Собирает ли инстанс диагностику. То же лекарство, что у `economyPreview`, и по той же
     * причине: клиент запоминает флаги инстанса в момент ДОБАВЛЕНИЯ сервера и больше их не
     * перечитывает, поэтому новый флаг до установленного десктопа не доезжает никогда.
     */
    diagPreview: env.diagEnabled,
    twoFactorEnabled: u.totpEnabled ?? false,
    ...statusFieldsOf(u, Date.now()),
    // Только себе: `serializeUser` вызывается для собственного профиля и админ-панели, участников
    // сервера сериализует `servers.ts` через `statusFieldsOf` без этого поля (#118).
    statusAuto: u.presenceAuto ?? false,
    // Steam link (#40 Phase 1B): expose only whether it's linked + persona; never the SteamID itself.
    steamLinked: !!u.steamId,
    steamPersona: u.steamPersona ?? null,
    showGameActivity: u.showGameActivity ?? true,
    createdAt: u.createdAt.toISOString(),
  };
}

export function serializeServer(s: {
  id: string;
  name: string;
  iconUrl: string | null;
  ownerId: string;
  createdAt: Date;
}): Server {
  return { id: s.id, name: s.name, iconUrl: s.iconUrl, ownerId: s.ownerId, createdAt: s.createdAt.toISOString() };
}

export function serializeCategory(c: { id: string; serverId: string; name: string; position: number }): Category {
  return { id: c.id, serverId: c.serverId, name: c.name, position: c.position };
}

export function serializeChannel(c: {
  id: string;
  serverId: string;
  categoryId: string | null;
  name: string;
  type: ChannelType;
  position: number;
  topic: string | null;
  syncedToCategory?: boolean;
  icon?: string | null;
  isPrivate?: boolean;
  generalUserId?: string | null;
  sounds?: Record<string, string>;
  voiceBitrate?: number | null;
}): Channel {
  return {
    id: c.id,
    serverId: c.serverId,
    categoryId: c.categoryId,
    name: c.name,
    type: c.type,
    position: c.position,
    topic: c.topic,
    syncedToCategory: c.syncedToCategory ?? false,
    icon: c.icon ?? null,
    isPrivate: c.isPrivate ?? false,
    generalUserId: c.generalUserId ?? null,
    sounds: c.sounds ?? {},
    voiceBitrate: c.voiceBitrate ?? null,
  };
}

/**
 * Человек для списков без ростера: баны, журнал действий, кто как голосовал.
 *
 * 🔴 Собирать эти три объекта руками — ровно та ошибка, из-за которой в списке банов на стенде
 * 18.09 у гостя вместо ника стоял технический `<uuid>@<instance_id>`: правила гостя (домашний ник
 * и значок инстанса) живут в `serializeUser`, и всякий, кто пишет поля сам, их теряет.
 */
export function serializeUserBrief(u: {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  homeInstanceId?: string | null;
  homeUsername?: string | null;
}): UserBrief {
  return {
    id: u.id,
    username: u.homeUsername || u.username,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    homeInstance: u.homeInstanceId ? instanceLabel(u.homeInstanceId) : null,
  };
}

export function serializeRole(r: {
  id: string;
  serverId: string;
  name: string;
  color: number;
  permissions: string;
  position: number;
  hoist: boolean;
  isEveryone: boolean;
  isGuests?: boolean;
  mentionable?: boolean;
  membersCanAssign?: boolean;
}): Role {
  return {
    id: r.id,
    serverId: r.serverId,
    name: r.name,
    color: r.color,
    permissions: r.permissions,
    position: r.position,
    hoist: r.hoist,
    isEveryone: r.isEveryone,
    // Клиент прячет «Гостей» из списка выдачи по этому полю (§5.9): без него роль стояла там
    // наравне с обычными, и любой клик кончался бы отказом бэкенда.
    isGuests: r.isGuests ?? false,
    mentionable: r.mentionable ?? false,
    membersCanAssign: r.membersCanAssign ?? false,
  };
}

export function serializeMessage(m: {
  id: string;
  channelId: string;
  content: string;
  attachments?: Attachment[] | null;
  createdAt: Date;
  editedAt: Date | null;
  reactions?: ReactionGroup[];
  replyTo?: MessageReplyPreview | null;
  pinnedAt?: Date | null;
  poll?: Poll | null;
  sticker?: MessageSticker | null;
  author: UserRow;
}): Message {
  return {
    id: m.id,
    channelId: m.channelId,
    content: m.content,
    attachments: m.attachments ?? [],
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    reactions: m.reactions ?? [],
    replyTo: m.replyTo ?? null,
    pinnedAt: m.pinnedAt ? m.pinnedAt.toISOString() : null,
    poll: m.poll ?? null,
    sticker: m.sticker ?? null,
    author: {
      id: m.author.id,
      username: m.author.username,
      displayName: m.author.displayName,
      avatarUrl: m.author.avatarUrl,
    },
  };
}

export function serializeInvite(i: {
  code: string;
  serverId: string;
  inviterId: string;
  createdAt: Date;
  expiresAt: Date | null;
  maxUses?: number | null;
  uses?: number;
}): Invite {
  return {
    code: i.code,
    serverId: i.serverId,
    inviterId: i.inviterId,
    createdAt: i.createdAt.toISOString(),
    expiresAt: i.expiresAt ? i.expiresAt.toISOString() : null,
    maxUses: i.maxUses ?? null,
    uses: i.uses ?? 0,
  };
}
