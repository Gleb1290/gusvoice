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
