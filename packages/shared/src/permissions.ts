// Discord-style permission system. Permissions are a bitfield stored in the DB as
// a decimal string (Postgres `numeric`/`text`) and carried over the wire as a string,
// because the values exceed Number.MAX_SAFE_INTEGER once we add more flags.

// Bit positions are STABLE — never renumber an existing permission (stored role masks
// are these bits). New permissions are appended at the next free position.
export const Permission = {
  VIEW_CHANNEL: 1n << 0n,
  SEND_MESSAGES: 1n << 1n,
  MANAGE_MESSAGES: 1n << 2n,
  CONNECT: 1n << 3n, // join a voice channel
  SPEAK: 1n << 4n, // publish audio
  STREAM: 1n << 5n, // LEGACY umbrella: camera + screen. Kept for back-compat; new grants use VIDEO/SHARE_SCREEN.
  // NOTE: STREAM, PRIORITY_SPEAKER and DEAFEN_MEMBERS are no longer offered in the UI (see the note on
  // PERMS in MembersRolesModal.tsx) — STREAM is superseded by VIDEO/SHARE_SCREEN, the other two were
  // never implemented. The bits stay defined and stay honoured: positions are stable and old role masks
  // still carry them.
  MANAGE_CHANNELS: 1n << 6n,
  MANAGE_ROLES: 1n << 7n,
  MANAGE_SERVER: 1n << 8n,
  KICK_MEMBERS: 1n << 9n,
  BAN_MEMBERS: 1n << 10n,
  CREATE_INVITE: 1n << 11n,
  ADMINISTRATOR: 1n << 12n,
  // --- permissions upgrade (positions 13+) ---
  READ_HISTORY: 1n << 13n, // read past messages of a channel
  VIDEO: 1n << 14n, // publish camera
  SHARE_SCREEN: 1n << 15n, // publish screen-share
  PRIORITY_SPEAKER: 1n << 16n, // TeamSpeak-style priority (carried in token metadata)
  MUTE_MEMBERS: 1n << 17n, // server-mute others in voice
  DEAFEN_MEMBERS: 1n << 18n, // server-deafen others (best-effort)
  MOVE_MEMBERS: 1n << 19n, // move others between voice channels
  VIEW_AUDIT_LOG: 1n << 20n,
  MANAGE_SOUNDS: 1n << 21n, // change a server's / a channel's notification sounds
  MANAGE_EMOJIS: 1n << 22n, // upload / delete a server's custom emoji (#18)
  MANAGE_STICKERS: 1n << 23n, // import / delete Telegram sticker packs (#68)
  POKE_MEMBERS: 1n << 24n, // «ткнуть» человека в голосовом канале (TeamSpeak-style)
  /**
   * Перетаскивать между голосовыми каналами В ОБХОД иерархии — включая владельца сервера.
   *
   * ⚠️ Проверяется ТОЛЬКО буквально по биту, без обычной поблажки администратору: смысл права в том,
   * чтобы владелец мог выдать его ОДНОЙ выбранной группе, а не всем, у кого есть ADMINISTRATOR.
   * ⚠️ Ослабляет ровно перемещение. Мут и отключение из голоса иерархию по-прежнему уважают — иначе
   * любой модератор смог бы затыкать владельца.
   */
  MOVE_ANYONE: 1n << 25n,
  /**
   * Настраивать экономику сервера (#117): тумблер, название и иконку валюты, все ползунки ставки и
   * множителей, а также выдачу монет руками.
   *
   * ⚠️ Отдельным правом, а не под `MANAGE_SERVER`: ползунок ставки — это чужие накопления, и
   * выдавать доступ к нему заодно с переименованием сервера не стоит.
   */
  MANAGE_ECONOMY: 1n << 26n,
  /**
   * Менять НАБОР звуков саундборда (#21): заливать и удалять сэмплы.
   *
   * 🔴 Отдельным правом, а не под `MANAGE_SOUNDS` (требование к фиче). Звуки уведомлений человек
   * слышит по случаю — вход, выход, упоминание; сэмпл саундборда кто угодно проигрывает всему
   * каналу по своему желанию. Это разная мера доверия, и выдавать её заодно с «поменять звук
   * входа» неправильно.
   *
   * ⚠️ Право только на НАБОР. Стрелять из саундборда может любой участник канала — там тормоз
   * монеты, а не право: иначе у одних саундборд есть, а у других нет, и это уже другая фича.
   */
  MANAGE_SOUNDBOARD: 1n << 27n,
} as const;

export type PermissionName = keyof typeof Permission;

export const ALL_PERMISSIONS = Object.values(Permission).reduce((a, b) => a | b, 0n);

/**
 * Права, которые НЕ раздаются по обычной цепочке «у кого есть — тот и выдаёт».
 *
 * `clampGrant` пускает администратора выдавать что угодно (`isAdmin(actor) → requested`), и для
 * обычных прав это верно. Но `MOVE_ANYONE` существует ровно для того, чтобы владелец сделал себя
 * перетаскиваемым для ОДНОЙ группы — а по обычной цепочке любой админ выдал бы его себе сам, и
 * ограничение стало бы декоративным. Такие биты меняет только владелец сервера (а значит и
 * супер-админ: `getMemberContext` отдаёт ему `isOwner: true`).
 */
export const PROTECTED_PERMISSIONS = Permission.MOVE_ANYONE;

// Default permissions granted to a server's @everyone role.
export const DEFAULT_EVERYONE_PERMISSIONS =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.READ_HISTORY |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.VIDEO |
  Permission.SHARE_SCREEN |
  Permission.CREATE_INVITE |
  // Тык — бытовое действие «эй, зайди в канал», а не модерация: по умолчанию доступен всем, и
  // право нужно как рубильник, которым админ может его отобрать у нарушителя.
  Permission.POKE_MEMBERS;

/** Camera publish allowed if VIDEO (or the legacy STREAM umbrella) is granted. */
export function canPublishCamera(perms: bigint): boolean {
  return has(perms, Permission.VIDEO) || has(perms, Permission.STREAM);
}

/** Screen-share publish allowed if SHARE_SCREEN (or the legacy STREAM umbrella) is granted. */
export function canPublishScreen(perms: bigint): boolean {
  return has(perms, Permission.SHARE_SCREEN) || has(perms, Permission.STREAM);
}

/**
 * Заменить легаси-зонтик STREAM на пару, которую он собой заменял.
 *
 * Без этого роль со STREAM показывает «Камеру» и «Демонстрацию экрана» ВЫКЛЮЧЕННЫМИ, хотя оба
 * права реально действуют (`canPublishCamera`/`canPublishScreen` честно смотрят на зонтик). Админ
 * видит выключенные тумблеры, включает и выключает их — и не отзывает ничего.
 *
 * Применяется при открытии роли, так что сохранение записывает уже современные биты: зонтик
 * вымывается сам, а нетронутые роли продолжают работать.
 */
export function normalizeLegacyPerms(perms: bigint): bigint {
  if ((perms & Permission.STREAM) !== Permission.STREAM) return perms;
  return (perms & ~Permission.STREAM) | Permission.VIDEO | Permission.SHARE_SCREEN;
}

/**
 * Биты, влияющие на то, что нам разрешено публиковать в голосе — то есть на содержимое
 * LiveKit-токена. Клиент сравнивает их до и после смены прав: изменились — токен надо перевыпустить,
 * иначе право выдали, а публиковать всё ещё нельзя (или наоборот — отобрали, а стрим продолжается).
 */
export const VOICE_PUBLISH_MASK =
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.VIDEO |
  Permission.STREAM |
  Permission.SHARE_SCREEN |
  Permission.PRIORITY_SPEAKER;

export function voicePublishBits(perms?: string | null): bigint {
  return permsFromString(perms) & VOICE_PUBLISH_MASK;
}

export interface Overwrite {
  allow: bigint;
  deny: bigint;
}

export function isAdmin(perms: bigint): boolean {
  return (perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR;
}

/** True if `perms` grants `perm` (ADMINISTRATOR grants everything). */
export function has(perms: bigint, perm: bigint): boolean {
  return isAdmin(perms) || (perms & perm) === perm;
}

/** Union of every role's permissions for a member. ADMINISTRATOR short-circuits to all. */
export function basePermissions(roles: { permissions: bigint }[]): bigint {
  let perms = 0n;
  for (const r of roles) perms |= r.permissions;
  return isAdmin(perms) ? ALL_PERMISSIONS : perms;
}

/**
 * Resolve effective permissions for a member in a specific channel, applying
 * overwrites in Discord order: @everyone overwrite, then the OR of role overwrites,
 * then the member-specific overwrite. ADMINISTRATOR ignores all overwrites.
 */
export function resolveChannelPermissions(
  base: bigint,
  opts: {
    everyone?: Overwrite;
    roleOverwrites?: Overwrite[];
    memberOverwrite?: Overwrite;
  },
): bigint {
  if (isAdmin(base)) return ALL_PERMISSIONS;
  let perms = base;

  if (opts.everyone) {
    perms &= ~opts.everyone.deny;
    perms |= opts.everyone.allow;
  }

  let allow = 0n;
  let deny = 0n;
  for (const o of opts.roleOverwrites ?? []) {
    allow |= o.allow;
    deny |= o.deny;
  }
  perms &= ~deny;
  perms |= allow;

  if (opts.memberOverwrite) {
    perms &= ~opts.memberOverwrite.deny;
    perms |= opts.memberOverwrite.allow;
  }

  return perms;
}

export function permsToString(perms: bigint): string {
  return perms.toString();
}

export function permsFromString(s: string | null | undefined): bigint {
  return s ? BigInt(s) : 0n;
}
