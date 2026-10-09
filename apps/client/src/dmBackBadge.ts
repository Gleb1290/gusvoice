import type { DmChannel } from '@gusvoice/shared';

/**
 * Число на кнопке «Назад» в открытой беседе (телефон, 03·2.2.2 «бейдж суммы непрочитанного в ДРУГИХ беседах»).
 *
 * Считается из тех же данных, что и счётчик строки в `DmSidebar`: беседа в `unreadDms` и не открытая сейчас, число — её
 * `unread`. Флаг непрочитанного без числа (сокет и загрузка списка приходят из разных мест) — одно сообщение, как точка в
 * строке. 0 — бейджа нет.
 */
export function dmBackBadgeCount(
  dms: ReadonlyArray<Pick<DmChannel, 'id' | 'unread'> & { markedUnread?: boolean }>,
  unreadDms: ReadonlyArray<string>,
  currentDmId: string | null | undefined,
): number {
  let sum = 0;
  for (const d of dms) {
    // «Пометить как непрочитанное» считается за одно сообщение — как в счётчике вкладки-папки и у Telegram
    // (`Dialogs::Entry::unreadCountForBadge`: метка даёт 1); числовой остаток у беседы без флага не в счёт.
    if (d.id === currentDmId || (!unreadDms.includes(d.id) && d.markedUnread !== true)) continue;
    sum += unreadDms.includes(d.id) && d.unread && d.unread > 0 ? d.unread : 1;
  }
  return sum;
}

/** Подпись бейджа: больше 99 — «99+», как у строки беседы. */
export function dmBackBadgeLabel(n: number): string {
  return n > 99 ? '99+' : String(n);
}
