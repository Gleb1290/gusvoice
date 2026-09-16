import { ALL_PERMISSIONS, isAdmin, Permission, PROTECTED_PERMISSIONS } from '@gusvoice/shared';

/**
 * Чистые правила ролей — БЕЗ базы и Fastify.
 *
 * Вынесено из `routes/roles.ts` по просьбе Codex (2026-07-27): импорт роута требует env и поднимает
 * Pool/Redis. Это логика ВЫДАЧИ ПОЛНОМОЧИЙ — ошибка здесь либо раздаёт лишний бит прав, либо даёт
 * поднять роль до своего уровня. Роут теперь только грузит строки и применяет готовый план.
 */

/**
 * Mask requested permissions so an actor can never grant more than they hold.
 *
 * `owner` — владелец сервера (супер-админ тоже: `getMemberContext` отдаёт ему `isOwner: true`).
 * `current` — маска роли ДО правки; для создания роли это `0n`.
 *
 * ⚠️ **Защищённые биты (`PROTECTED_PERMISSIONS`) берутся из `current`, а не из `requested`** — их
 * нельзя ни выдать, ни снять никому, кроме владельца. Именно «сохранить прежнее», а не «вырезать»:
 * иначе администратор, правящий у роли соседний тумблер, молча снял бы выданный владельцем
 * `MOVE_ANYONE` — то есть обошёл бы ограничение с другой стороны, ничего для этого не делая.
 *
 * ⚠️ Проверка идёт по `owner`, а НЕ через `isAdmin`: смысл защищённого бита в том, что владелец
 * выдаёт его одной выбранной группе. Пусти сюда админа — и он выдаст его себе сам, а ограничение
 * станет декоративным.
 */
export function clampGrant(requested: bigint, actor: bigint, owner = false, current = 0n): bigint {
  const base = isAdmin(actor) ? requested & ALL_PERMISSIONS : requested & actor;
  if (owner) return base;
  return (base & ~PROTECTED_PERMISSIONS) | (current & PROTECTED_PERMISSIONS);
}

export interface RoleOrderRow {
  id: string;
  isEveryone: boolean;
  position: number;
}

export type ReorderPlan =
  | { ok: true; updates: { id: string; position: number }[] }
  | { ok: false; code: 400 | 403; error: string };

/**
 * Разобрать запрос на переупорядочивание ролей в план обновлений.
 *
 * `order` перечисляет КАЖДУЮ не-@everyone роль, СВЕРХУ (старшая) ВНИЗ. Позиции раздаются плотно:
 * order[0] → наибольшая, последний → 1, @everyone остаётся 0.
 *
 * ⚠️ **Уникальность проверяется ОТДЕЛЬНО**: длина и «все id известны» её не дают. При двух ролях
 * `['r1','r1']` проходило обе проверки, r1 обновлялась дважды, r2 не обновлялась вовсе — и порядок
 * молча разъезжался. Сообщение об ошибке обещало «exactly once», код — нет. Нашёл Codex.
 *
 * Возвращает только РЕАЛЬНО меняющиеся позиции: неизменные не пишем в базу и не считаем нарушением
 * иерархии (иначе обычный менеджер не смог бы переставить свои нижние роли, не задев верхние).
 */
export function planReorder(
  order: string[],
  all: RoleOrderRow[],
  actor: { privileged: boolean; highest: number },
): ReorderPlan {
  const byId = new Map(all.map((r) => [r.id, r]));
  const nonEveryone = all.filter((r) => !r.isEveryone);
  const uniq = new Set(order).size === order.length;
  if (!uniq || order.length !== nonEveryone.length || order.some((rid) => !byId.has(rid) || byId.get(rid)!.isEveryone)) {
    return { ok: false, code: 400, error: 'order must list every non-@everyone role exactly once' };
  }

  const count = nonEveryone.length;
  const updates = order
    .map((rid, i) => ({ id: rid, position: count - i }))
    .filter((u) => byId.get(u.id)!.position !== u.position);

  if (!actor.privileged) {
    for (const u of updates) {
      const cur = byId.get(u.id)!;
      // И ОТКУДА, и КУДА: двигать роль своего уровня нельзя в обе стороны, иначе менеджер поднял бы
      // нижнюю роль к себе (проверка только `cur` пропустила бы это).
      if (cur.position >= actor.highest || u.position >= actor.highest) {
        return { ok: false, code: 403, error: 'нельзя двигать роли на своём уровне или выше' };
      }
    }
  }
  return { ok: true, updates };
}

/**
 * Права, которые нельзя нести роли с самовыдачей (`members_can_assign`): иначе выдача расползлась бы
 * вирусно — взял роль сам, получил управление ролями, раздал остальное.
 */
export const SELF_ASSIGN_FORBIDDEN = Permission.ADMINISTRATOR | Permission.MANAGE_ROLES | Permission.MANAGE_SERVER;

/**
 * Запрещена ли роль к самовыдаче в ИТОГОВОМ состоянии.
 * ⚠️ Считать по финальным правам и финальному флагу (права из патча + флаг из патча), а не по тому,
 * что лежит в базе: иначе патч «добавить ADMINISTRATOR» к уже самовыдаваемой роли проходит.
 */
export function selfAssignBlocked(willSelfAssign: boolean, finalPermissions: bigint): boolean {
  return willSelfAssign && (finalPermissions & SELF_ASSIGN_FORBIDDEN) !== 0n;
}

/**
 * Можно ли выдать роль участнику. Возвращает текст ошибки (403) или null.
 *
 * Менеджер (MANAGE_ROLES) выдаёт любую роль НИЖЕ своей высшей позиции. Отдельно: роль с
 * самовыдачей (`members_can_assign`) может выдать любой, кто ЕЁ УЖЕ ИМЕЕТ — без MANAGE_ROLES и
 * ⚠️ **в обход иерархии** (осознанно: это способ раздать себе «хобби»-роли). Снятие роли под это
 * исключение НЕ попадает — там всегда нужен MANAGE_ROLES.
 */
export function assignRoleBlock(p: {
  isManager: boolean;
  membersCanAssign: boolean;
  actorHasRole: boolean;
  rolePosition: number;
  actorHighest: number;
}): string | null {
  const selfAssign = p.membersCanAssign && p.actorHasRole;
  if (!p.isManager && !selfAssign) return 'forbidden';
  if (!selfAssign && p.rolePosition >= p.actorHighest) return 'нельзя выдать роль своего уровня или выше';
  return null;
}
