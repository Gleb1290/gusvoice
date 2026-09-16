import type { PresenceStatus } from '@gusvoice/shared';

/** The visual states a status dot can render — the four presence states plus a derived "offline". */
export type DotStatus = PresenceStatus | 'offline';

export const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: 'В сети',
  dnd: 'Не беспокоить',
  away: 'Нет на месте',
  invisible: 'Невидимый',
};

export const STATUS_SUBTITLE: Partial<Record<PresenceStatus, string>> = {
  dnd: 'без уведомлений',
  invisible: 'офлайн для других',
};

/** Order + metadata for the status picker. */
export const STATUS_OPTIONS: PresenceStatus[] = ['online', 'dnd', 'away', 'invisible'];

/**
 * The dot to render for a user: you always see your own true status; for everyone else a chosen
 * "invisible" (or simply being offline) renders as the plain offline dot — so invisibility is
 * indistinguishable from being offline to others.
 */
export function effectiveDot(status: PresenceStatus, online: boolean, isSelf: boolean): DotStatus {
  if (isSelf) return status;
  if (!online || status === 'invisible') return 'offline';
  return status;
}

/** Whether a custom status should be visible to a viewer (hidden when the user reads as offline). */
export function customStatusVisible(status: PresenceStatus, online: boolean, isSelf: boolean): boolean {
  return isSelf || (online && status !== 'invisible');
}
