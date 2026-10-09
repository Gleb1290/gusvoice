import type { CustomStatus, PresenceStatus } from '@gusvoice/shared';

/**
 * Чистые правила presence-статуса — БЕЗ базы и env.
 *
 * Вынесено из `serialize.ts` по просьбе Codex (2026-07-27): тот модуль импортирует `auth.js` (а с
 * ним env и БД), поэтому истечение кастом-статуса нельзя было проверить тестом. `now` передаётся
 * явно — «истекло ровно сейчас» иначе невоспроизводимо.
 */

const STATUSES: readonly string[] = ['online', 'dnd', 'away', 'invisible'];

export interface StatusRow {
  presenceStatus?: string | null;
  customStatusEmoji?: string | null;
  customStatusText?: string | null;
  customStatusExpiresAt?: Date | null;
}

/**
 * Presence state + custom status for a user row, with an expired custom status collapsed to null.
 *
 * ⚠️ Неизвестное значение `presenceStatus` (мусор в базе, чужая миграция) схлопывается в `online`, а
 * не отдаётся клиенту как есть — иначе интерфейс получил бы статус, которого не умеет рисовать.
 * ⚠️ Полуинтервал `<=`: момент истечения означает «уже истёк». Тот же выбор в опросах и инвайтах.
 */
export function statusFieldsOf(
  u: StatusRow,
  now: number,
): { status: PresenceStatus; customStatus: CustomStatus | null } {
  const status = (STATUSES.includes(u.presenceStatus ?? '') ? u.presenceStatus : 'online') as PresenceStatus;
  const expired = !!u.customStatusExpiresAt && u.customStatusExpiresAt.getTime() <= now;
  const emoji = u.customStatusEmoji ?? null;
  const text = u.customStatusText ?? null;
  const customStatus: CustomStatus | null =
    expired || (!emoji && !text)
      ? null
      : { emoji, text, expiresAt: u.customStatusExpiresAt ? u.customStatusExpiresAt.toISOString() : null };
  return { status, customStatus };
}

/**
 * Статус человека глазами зрителя (решение владельца 07.10: «невидимый — приватность человека»). Чужому «Невидимый»
 * отдаётся как обычный `online`: в сети его зритель и так не видит (`userVisibilityHub` прячет онлайн), а `online` без
 * онлайна клиент рисует «не в сети» без точки (`effectiveDot`) — ровно как у человека, который правда вышел. Так значение
 * `invisible` не уходит ни соседям, ни гостям с других инстансов. Сам человек (все его устройства) видит настоящее.
 * `viewerId` пустой — зритель неизвестен, считаем чужим.
 */
export function statusSeenBy(status: PresenceStatus, subjectId: string, viewerId: string | null | undefined): PresenceStatus {
  return status === 'invisible' && subjectId !== viewerId ? 'online' : status;
}
