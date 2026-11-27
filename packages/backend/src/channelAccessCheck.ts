import { has, isAdmin, Permission, permsFromString, type PermissionName } from '@gusvoice/shared';
import { applyOverwrites, resolveLayered, type OverwriteRow, type PermissionSubject } from './audienceRules.js';
import type { MemberContext } from './permissions.js';

export function canInspectChannelAccess(permissions: bigint): boolean {
  return has(permissions, Permission.VIEW_CHANNEL | Permission.MANAGE_ROLES);
}

function overwriteReason(subject: PermissionSubject, rows: OverwriteRow[], bit: bigint) {
  const relevant = rows.filter((row) => ((permsFromString(row.allow) | permsFromString(row.deny)) & bit) !== 0n);
  if (relevant.some((row) => row.targetType === 'member' && row.targetId === subject.userId)) {
    return 'member';
  }
  if (relevant.some((row) => row.targetType === 'role' && subject.roleIds.includes(row.targetId))) {
    return 'roles';
  }
  if (relevant.some((row) => row.targetType === 'role' && row.targetId === subject.everyoneRoleId)) {
    return 'everyone';
  }
  return null;
}

export function describeChannelAccess(
  type: string,
  ctx: MemberContext | null,
  userId: string,
  category: OverwriteRow[],
  channel: OverwriteRow[],
) {
  const subject = {
    userId, roleIds: ctx?.roleIds ?? [], everyoneRoleId: ctx?.everyoneRoleId ?? null, isBot: ctx?.isBot,
  };
  const base = ctx?.serverPermissions ?? 0n;
  const categoryPermissions = applyOverwrites(base, subject, category);
  const effective = ctx ? resolveLayered(base, subject, category, channel) : 0n;

  function check(permission: PermissionName) {
    const allowed = has(effective, Permission[permission]);
    if (!ctx) return { permission, allowed, source: 'membership' as const };
    if (ctx.isOwner) return { permission, allowed, source: 'owner' as const };
    if (isAdmin(base)) return { permission, allowed, source: 'administrator' as const };

    // An administrative grant in an overwrite can affect every action for a non-bot.
    const bit = isAdmin(effective) ? Permission.ADMINISTRATOR : Permission[permission];
    const channelRule = isAdmin(categoryPermissions) ? null : overwriteReason(subject, channel, bit);
    if (channelRule) return { permission, allowed, source: 'channel' as const, rule: channelRule };
    const categoryRule = overwriteReason(subject, category, bit);
    if (categoryRule) return { permission, allowed, source: 'category' as const, rule: categoryRule };

    const grantingRoles = ctx.roles.filter((role) => (permsFromString(role.permissions) & bit) !== 0n);
    return {
      permission,
      allowed,
      source: 'roles' as const,
      roleIds: grantingRoles.map((role) => role.id),
    };
  }

  const actions: { action: string; requires: PermissionName[] }[] = type === 'voice'
    ? [
        { action: 'join', requires: ['VIEW_CHANNEL', 'CONNECT'] },
        { action: 'speak', requires: ['VIEW_CHANNEL', 'CONNECT', 'SPEAK'] },
      ]
    : [
        { action: 'view', requires: ['VIEW_CHANNEL'] },
        { action: 'read', requires: ['VIEW_CHANNEL', 'READ_HISTORY'] },
        { action: 'write', requires: ['VIEW_CHANNEL', 'SEND_MESSAGES'] },
      ];
  return actions.map(({ action, requires }) => {
    const checks = requires.map(check);
    return { action, allowed: checks.every((item) => item.allowed), checks };
  });
}
