import type { DmChannel } from '@gusvoice/shared';
import { plural } from './dmRowRules';

/**
 * Архив бесед ЛС (07.10, #211, G41 темы 14 плейбука, признак сервера `archive1`). Правила строки «Архив» и счётчиков —
 * чистые функции, без стора и разметки (`components/DmArchive.tsx`, `DmSidebar.tsx`).
 *
 * Источники (Telegram Desktop): `data/data_folder.cpp` (`ComposeFolderListEntryText` — имена последних бесед, `kShowChatNamesCount`
 * = 8, «и ещё N»; у непрочитанных имя жирным), `dialogs/dialogs_inner_widget.cpp` (`refreshWithCollapsedRows` — свёрнутый
 * архив рисуется тонкой строкой с числом непрочитанных; в папках строки архива нет), `history/history.cpp`
 * (`adjustBadgesStateByFolder` — у бесед архива счётчики серые), `window/window_peer_menu.cpp` (`addToggleArchive`,
 * `ToggleHistoryArchived` — тост «Чат архивирован»).
 */

/** Сколько имён последних бесед стоит в превью строки «Архив» (`kShowChatNamesCount` в `data_folder.cpp`). */
export const ARCHIVE_PREVIEW_NAMES = 8;

/** Беседа в моём архиве (нет поля — сервер до `archive1`, значит не в архиве). */
export function inArchive(d: Pick<DmChannel, 'archived'>): boolean {
  return d.archived === true;
}

/** Беседы основного списка и папок: архивные в них не попадают (у Telegram «Все чаты» и папки с флагом «Архивные» их не берут). */
export function withoutArchived<T extends Pick<DmChannel, 'archived'>>(dms: readonly T[]): T[] {
  return dms.filter((d) => !inArchive(d));
}

/** Беседы архива в порядке списка (закреплённые первыми — их в архиве можно закреплять, как у Android). */
export function archivedOnly<T extends Pick<DmChannel, 'archived'>>(dms: readonly T[]): T[] {
  return dms.filter(inArchive);
}

/** Беседа «непрочитана» для счётчика строки «Архив»: число или точка-пометка. */
function isUnread(d: Pick<DmChannel, 'id' | 'unread' | 'markedUnread'>, unreadDms: readonly string[]): boolean {
  return ((d.unread ?? 0) > 0 && unreadDms.includes(d.id)) || d.markedUnread === true;
}

/**
 * Число на строке «Архив»: сколько бесед архива непрочитаны (у Telegram — `CountInBadge::Chats`, счётчик серый). Открытую
 * на экране беседу не считаем — как и в списке, у неё числа нет (`shownId`).
 */
export function archiveUnreadChats(
  dms: readonly DmChannel[],
  unreadDms: readonly string[],
  shownId: string | null,
): number {
  let n = 0;
  for (const d of dms) if (inArchive(d) && d.id !== shownId && isUnread(d, unreadDms)) n++;
  return n;
}

/**
 * Общий счётчик непрочитанного (значок на рейке, нижняя панель телефона, число у «назад»): беседы архива в него НЕ входят —
 * человек убрал их из виду, а число на строке «Архив» серое и своё. Возвращает id без архивных.
 */
export function unreadOutsideArchive(dms: readonly DmChannel[], unreadDms: readonly string[]): string[] {
  const hidden = new Set(dms.filter(inArchive).map((d) => d.id));
  return hidden.size === 0 ? [...unreadDms] : unreadDms.filter((id) => !hidden.has(id));
}

/** Кусок превью строки «Архив»: имя собеседника, жирное — у непрочитанной беседы. */
export interface ArchiveName {
  id: string;
  name: string;
  unread: boolean;
}

/**
 * Превью строки «Архив»: имена до `ARCHIVE_PREVIEW_NAMES` последних бесед через запятую (непрочитанные — жирным) и «и ещё N
 * чатов», если их больше. `list` — беседы архива в порядке списка.
 */
export function archivePreview(
  list: readonly DmChannel[],
  unreadDms: readonly string[],
  /** Подпись из моих контактов (`peerName.ts`, решение владельца 08.10 п.27); без него — имя из беседы. */
  nameOf: (userId: string, fallback: string) => string = (_id, n) => n,
): { names: ArchiveName[]; more: number; moreLabel: string } {
  const shown = list.slice(0, ARCHIVE_PREVIEW_NAMES);
  const more = list.length - shown.length;
  return {
    names: shown.map((d) => ({ id: d.id, name: nameOf(d.otherUser.id, d.otherUser.displayName), unread: isUnread(d, unreadDms) })),
    more,
    moreLabel: more > 0 ? `и ещё ${more} ${plural(more, 'чат', 'чата', 'чатов')}` : '',
  };
}

/** Тосты архива (`lng_archived_added` / `lng_archived_removed`); «Отмена» — на тосте «в архиве» (Telegram Android `UndoView`). */
export const ARCHIVE_TOAST = {
  added: 'Чат в архиве',
  addedHint: 'Заглушённые чаты остаются в архиве, когда приходят новые сообщения',
  removed: 'Чат возвращён из архива',
  undo: 'Отмена',
} as const;

/** Подпись пункта меню: `lng_archived_add` / `lng_archived_remove`. */
export function archiveMenuLabel(archived: boolean): string {
  return archived ? 'Вернуть из архива' : 'В архив';
}
