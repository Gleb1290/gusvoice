import {
  basePermissions,
  has,
  isAdmin,
  type Overwrite,
  Permission,
  permsFromString,
  resolveChannelPermissions,
} from '@gusvoice/shared';

/**
 * Чистое ядро прав на канал — БЕЗ базы: наложение оверрайдов и вычисление АУДИТОРИИ канала.
 *
 * Вынесено 2026-07-27 в рамках #91. Здесь считается, кто именно имеет право видеть канал, а значит
 * кому можно отдавать события этого канала по сокету. До этого рассылка шла всем подписчикам
 * сервера без единой проверки, и тело сообщения из приватного канала уезжало тем, кому он закрыт.
 *
 * ⚠️ `permissions.ts` пользуется ЭТИМИ ЖЕ функциями (`applyOverwrites`/`resolveLayered`), а не своими
 * копиями. Иначе получилось бы две реализации одной формулы прав, обязанные совпадать до бита, —
 * ровно тот класс расхождений, на котором проект уже обжигался.
 */

export type OverwriteRow = { targetType: string; targetId: string; allow: string; deny: string };

/** Кому считаем: его роли и id роли @everyone на сервере. */
export interface PermissionSubject {
  userId: string;
  roleIds: string[];
  everyoneRoleId: string | null;
}

export function toOverwrite(row: { allow: string; deny: string }): Overwrite {
  return { allow: permsFromString(row.allow), deny: permsFromString(row.deny) };
}

/** Apply ONE source's overwrites (everyone → roles → member) on top of `base` for this subject. */
export function applyOverwrites(base: bigint, subject: PermissionSubject, ows: OverwriteRow[]): bigint {
  const everyoneOw = subject.everyoneRoleId
    ? ows.find((o) => o.targetType === 'role' && o.targetId === subject.everyoneRoleId)
    : undefined;
  const roleOws = ows.filter((o) => o.targetType === 'role' && subject.roleIds.includes(o.targetId));
  const memberOw = ows.find((o) => o.targetType === 'member' && o.targetId === subject.userId);
  return resolveChannelPermissions(base, {
    everyone: everyoneOw ? toOverwrite(everyoneOw) : undefined,
    roleOverwrites: roleOws.map(toOverwrite),
    memberOverwrite: memberOw ? toOverwrite(memberOw) : undefined,
  });
}

/**
 * Layered channel permissions: server perms → CATEGORY overwrites (inherited by every channel of the
 * category) → CHANNEL overwrites (override the category on conflict). A channel with no own overwrites
 * purely inherits its category; a channel's own deny/allow wins over the category's.
 */
export function resolveLayered(
  serverPermissions: bigint,
  subject: PermissionSubject,
  catOws: OverwriteRow[],
  chanOws: OverwriteRow[],
): bigint {
  return applyOverwrites(applyOverwrites(serverPermissions, subject, catOws), subject, chanOws);
}

export interface AudienceRole {
  id: string;
  isEveryone: boolean;
  /** Десятичный битфилд, как он лежит в базе. */
  permissions: string;
}

export interface AudienceMember {
  userId: string;
  roleIds: string[];
  /** Владелец сервера или супер-админ — видит всё, оверрайды не применяются. */
  privileged: boolean;
  /** Гость с другого инстанса (#139): базовые права ему даёт роль «Гости», а не `@everyone`. */
  isGuest?: boolean;
}

/**
 * Кто имеет право ВИДЕТЬ канал — то есть кому можно отдавать его события.
 *
 * Считается по факту, на момент публикации, а не по кэшу у соединения: кэш пришлось бы
 * инвалидировать при каждом изменении прав, и любой пропущенный путь давал бы утечку до истечения
 * TTL. Так делают Zulip и Synapse; Mattermost же от кэша с таймаутом отказался в пользу явной
 * инвалидации, а Rocket.Chat, который проверяет только при подписке, — самое слабое звено из
 * рассмотренных.
 *
 * ⚠️ Ошибка в СТОРОНУ ЛИШНЕГО получателя = утечка. Ошибка в сторону недостающего = человек не увидит
 * событие в реальном времени, и следующий bootstrap это исправит. Поэтому при сомнении не включаем.
 */
export function channelAudience(p: {
  members: AudienceMember[];
  roles: AudienceRole[];
  everyoneRoleId: string | null;
  /** Системная роль «Гости» этого сервера (§5.9); `null` — сервер заведён до неё. */
  guestsRoleId?: string | null;
  categoryOverwrites: OverwriteRow[];
  channelOverwrites: OverwriteRow[];
}): string[] {
  const out: string[] = [];
  const guestsRole = p.guestsRoleId ? (p.roles.find((r) => r.id === p.guestsRoleId) ?? null) : null;

  for (const m of p.members) {
    if (m.privileged) {
      out.push(m.userId);
      continue;
    }
    /**
     * 🔴 Гость считается ТАК ЖЕ, как в `getMemberContext` (аудит 19.09, F-03): роль «Гости» ЗАМЕНЯЕТ
     * ему `@everyone` в базовых правах и едет в `roleIds`, чтобы работали её канальные переопределения.
     * Раньше рассылка про роль «Гости» не знала вовсе — она виртуальная, в `member_roles` её не бывает,
     * — и гость получал сообщения каналов, скрытых от гостей: через REST канала нет, а сокет его слал.
     * ⚠️ Нет роли на сервере — гость считается по `@everyone`, ровно как там же.
     */
    const guestBaseId = m.isGuest && guestsRole ? guestsRole.id : null;
    // ⚠️ Фильтруем от СПИСКА РОЛЕЙ СЕРВЕРА, а не от `m.roleIds`: висячая связь на удалённую роль не
    // должна ни давать прав, ни ронять расчёт.
    // 🔴 И тот же отфильтрованный список идёт В SUBJECT (нашёл Codex): иначе защита половинчатая —
    // прав удалённой роли нет, а вот её `allow`-оверрайд, оставшийся в `channel_overwrites` (там нет
    // FK на roles), всё ещё применялся бы и возвращал доступ.
    const live = p.roles.filter(
      (r) => (guestBaseId ? r.id === guestBaseId : r.isEveryone) || m.roleIds.includes(r.id),
    );
    const liveRoleIds = live.filter((r) => !r.isEveryone).map((r) => r.id);
    const base = basePermissions(live.map((r) => ({ permissions: permsFromString(r.permissions) })));
    if (isAdmin(base)) {
      out.push(m.userId);
      continue;
    }
    const subject: PermissionSubject = { userId: m.userId, roleIds: liveRoleIds, everyoneRoleId: p.everyoneRoleId };
    const perms = resolveLayered(base, subject, p.categoryOverwrites, p.channelOverwrites);
    if (has(perms, Permission.VIEW_CHANNEL)) out.push(m.userId);
  }
  return out;
}
