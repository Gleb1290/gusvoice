import { GROUP_MEMBER_LIMIT, GROUP_TITLE_MAX, type ConvGroupService } from '@gusvoice/shared';

/**
 * Групповые ЛС (07.10, #211, С4 плана «телеграмности», признак `groups1`) — ЧИСТЫЕ правила: предел участников, название,
 * права, текст служебных записей и пуша. Без базы и сети — их проверяет тест Codex.
 *
 * Источник — Telegram: создание «выбор людей → название и фото» (tdesktop `boxes/peers/add_participants_box.cpp`,
 * `GroupInfoBox`; Android `GroupCreateActivity`), служебные строки `lng_action_created_chat`, `lng_action_add_user`,
 * `lng_action_kick_user`, `lng_action_user_left`, `lng_action_changed_title`, `lng_action_changed_photo`. Предел — решение
 * владельца Р-5: до 5 человек вместе с создателем, больше — «Создать сервер».
 */

export { GROUP_MEMBER_LIMIT, GROUP_TITLE_MAX };

/** Название группы: пробелы по краям и внутри схлопнуты; пусто или длиннее предела — `null` (Telegram без названия не создаёт). */
export function normalizeGroupTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t || [...t].length > GROUP_TITLE_MAX) return null;
  return t;
}

export type GroupSizeVerdict = 'ok' | 'empty' | 'too-many' | 'self';

/**
 * Создание: `userIds` — кого зову, кроме себя; повторы схлопываются. Всего с создателем — не больше `limit`; хотя бы один
 * другой человек обязателен (группы «из себя» у Telegram нет).
 */
export function groupCreateCheck(me: string, userIds: readonly string[], limit = GROUP_MEMBER_LIMIT): GroupSizeVerdict {
  const set = new Set(userIds);
  if (set.has(me)) return 'self';
  if (set.size === 0) return 'empty';
  return set.size + 1 > limit ? 'too-many' : 'ok';
}

/** Добавление: `current` — действующие участники сейчас, `adding` — новые (уже без тех, кто в группе). */
export function groupAddCheck(current: number, adding: number, limit = GROUP_MEMBER_LIMIT): 'ok' | 'empty' | 'too-many' {
  if (adding <= 0) return 'empty';
  return current + adding > limit ? 'too-many' : 'ok';
}

export type GroupRole = 'owner' | 'member';

/**
 * Удалить участника может только создатель (владелец), и не себя (себя — «Покинуть группу»). Переименовать, сменить фото
 * и добавить людей — любой участник, как в обычной группе Telegram по умолчанию.
 */
export function canRemoveMember(actorRole: GroupRole | null, actorId: string, targetId: string): boolean {
  return actorRole === 'owner' && actorId !== targetId;
}

/**
 * Кому перейти владению, когда создатель выходит: самому раннему из оставшихся (порядок `members` — по времени входа).
 * Никого — `null`: группа живёт без владельца, удалять участников некому.
 */
export function nextOwner(members: readonly { id: string }[], leaving: string): string | null {
  return members.find((m) => m.id !== leaving)?.id ?? null;
}

/** Готовая фраза служебной записи по-русски — `content` записи (поиск, пуш, клиент без `groups1`). */
export function serviceText(actorName: string, s: ConvGroupService): string {
  const names = (s.users ?? []).map((u) => u.displayName).join(', ');
  switch (s.type) {
    case 'create':
      return `${actorName} создал(а) группу «${s.title ?? ''}»`;
    case 'add':
      return `${actorName} добавил(а) ${names}`;
    case 'remove':
      return `${actorName} удалил(а) ${names}`;
    case 'leave':
      return `${actorName} покинул(а) группу`;
    case 'title':
      return `${actorName} изменил(а) название группы на «${s.title ?? ''}»`;
    case 'photo':
      return `${actorName} изменил(а) фото группы`;
  }
}

/** Заголовок пуша из группы: «Имя в «Название»» (текст — тело пуша), как Android `NotificationMessageGroupText`. */
export function groupPushTitle(authorName: string, title: string): string {
  return `${authorName} в «${title}»`;
}

// Ключ заглушки группы (`groups2`) — в `shared/types.ts` (его же берёт `conversations.ts`).
export { GROUP_MUTE_PREFIX, groupMuteTarget, groupOfMuteTarget } from '@gusvoice/shared';
