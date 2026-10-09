import { DM_FOLDER_PINNED_MAX, dmFolderContains, dmFolderPinnedOrder, type DmChannel, type DmFolder, type DmFolderChat } from '@gusvoice/shared';

/**
 * Чистые правила вкладок папок ЛС (07.10, #211, G40, `folders1`): какая папка открыта, какие беседы в ней, число на
 * вкладке, соседняя папка. Источники — Telegram Desktop `window/window_filters_menu.cpp` (полоса папок),
 * `data/data_chat_filters.cpp` (`ChatFilter::contains`), `core/shortcuts.cpp` (`FolderNext` / `FolderPrevious`).
 */

/** Состояние беседы для вкладок: число новых, пометка «непрочитано», заглушка. */
export interface FolderChatState {
  id: string;
  group?: boolean;
  unread: number;
  marked: boolean;
  muted: boolean;
}

export const folderChat = (c: FolderChatState): DmFolderChat => ({
  id: c.id,
  group: c.group,
  muted: c.muted,
  unread: c.unread > 0 || c.marked,
});

/** Полоса папок показывается, когда у человека есть хоть одна своя папка (у Telegram — когда папок больше, чем «Все чаты»). */
export function foldersShown(folders: readonly DmFolder[] | null): folders is DmFolder[] {
  return !!folders && folders.some((f) => !f.system);
}

/** Открытая папка: выбранная, а пропала (удалили на другом устройстве) или не выбрана — первая по порядку. */
export function activeFolderOf(folders: readonly DmFolder[], activeId: string | null): DmFolder | null {
  return folders.find((f) => f.id === activeId) ?? folders[0] ?? null;
}

/** Соседняя папка по кругу? Нет — у Telegram Desktop `FolderNext` на последней стоит (`window_session_controller`). */
export function neighbourFolder(folders: readonly DmFolder[], activeId: string | null, dir: -1 | 1): DmFolder | null {
  const cur = activeFolderOf(folders, activeId);
  if (!cur) return null;
  const i = folders.indexOf(cur) + dir;
  return i >= 0 && i < folders.length ? folders[i] : null;
}

/**
 * Число на вкладке (`FiltersMenu` → `Dialogs::BadgesForUnread`): новые сообщения в беседах со звуком (пометка без числа —
 * одна); если таких нет, а в заглушённых есть — серое число заглушённых.
 */
export function folderBadge(f: DmFolder, chats: readonly FolderChatState[]): { n: number; muted: boolean } {
  let loud = 0;
  let quiet = 0;
  for (const c of chats) {
    if (!dmFolderContains(f, folderChat(c))) continue;
    const n = c.unread > 0 ? c.unread : c.marked ? 1 : 0;
    if (c.muted) quiet += n;
    else loud += n;
  }
  return loud > 0 ? { n: loud, muted: false } : { n: quiet, muted: quiet > 0 };
}

/** Число на вкладке строкой, как у счётчика строки: больше 99 — «99+». */
export function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

/** Свайп по списку на телефоне листает папки (Telegram Android `DialogsActivity`, `ViewPages`): порог по горизонтали. */
export const FOLDER_SWIPE_MIN_PX = 64;

/** Направление свайпа или `0`: горизонталь вдвое длиннее вертикали и дальше порога. Палец влево — следующая папка. */
export function folderSwipeDir(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < FOLDER_SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 2) return 0;
  return dx < 0 ? 1 : -1;
}

/**
 * Ctrl+1…8 — вкладка по номеру (Telegram Desktop `core/shortcuts.cpp`: `kShowFolder` = «Все чаты», `ShowFolder1…6`,
 * `ShowFolderLast` на Ctrl+1…8; `dialogs_inner_widget.cpp`: `select = clamp(index, 0, count − 1)`, а у `ShowFolderLast` —
 * последняя). Номер дальше последней вкладки — последняя. Ctrl+9 — архив (`ShowArchive`), его ловит список.
 */
export const FOLDER_HOTKEY_LAST = 8;
export function folderByHotkey(folders: readonly DmFolder[], n: number): DmFolder | null {
  if (folders.length === 0 || !Number.isInteger(n) || n < 1 || n > FOLDER_HOTKEY_LAST) return null;
  if (n === FOLDER_HOTKEY_LAST) return folders[folders.length - 1];
  return folders[Math.min(n - 1, folders.length - 1)];
}

/** Номер цифровой клавиши (`Digit1`…`Digit9`, `Numpad1`…) или `null`. */
export function digitOfKey(code: string): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return m ? Number(m[1]) : null;
}

/**
 * Перетаскивание вкладок папок. Telegram Desktop (`window_filters_menu.cpp`, `FiltersMenu::refreshList`): у человека без
 * Premium «Все чаты» закреплена первой — `addPinnedInterval(0, 1)`, сдвинуть можно только свои папки; Android
 * (`FilterTabsView.TouchHelperCallback`): то же — «по умолчанию» вкладка 0 не двигается, и после отпускания возвращается.
 * `pinned` — сколько первых вкладок не двигается (наша системная «Личные сообщения»).
 */
export function foldersPinned(folders: readonly DmFolder[]): number {
  return folders[0]?.system ? 1 : 0;
}

/** Куда лёг палец / курсор: индекс вкладки, над серединой которой сейчас `pos` (середины — по порядку), не раньше `pinned`. */
export function dropIndex(mids: readonly number[], pos: number, pinned: number): number {
  let i = 0;
  while (i < mids.length - 1 && pos > mids[i]) i++;
  return Math.max(pinned, Math.min(i, mids.length - 1));
}

/** Порядок id после переноса вкладки `from` на место `to` (`base::reorder`); тот же индекс или закреплённое — `null`. */
export function movedIds(ids: readonly string[], from: number, to: number, pinned: number): string[] | null {
  if (from === to || from < pinned || to < pinned || from >= ids.length || to >= ids.length) return null;
  const next = ids.slice();
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

/** Сдвиг вкладки `i` пока тянут `from` к `to`, в долях размера перетаскиваемой: остальные уступают место (как `VerticalLayoutReorder`). */
export function dragShift(i: number, from: number, to: number): -1 | 0 | 1 {
  if (i === from) return 0;
  if (from < to && i > from && i <= to) return -1;
  if (from > to && i < from && i >= to) return 1;
  return 0;
}

/** Начало перетаскивания мышью — сдвиг дальше этого (`QApplication::startDragDistance`, 10 px у Qt на ПК). */
export const FOLDER_DRAG_START_PX = 8;
/** Удержание пальцем до перетаскивания вкладки на телефоне (как удержание строки списка и меню вкладки). */
export const FOLDER_HOLD_MS = 420;

/**
 * Свайп между папками на телефоне — как `ViewPagerFixed` у Telegram Android (`DialogsActivity.viewPages`): лента идёт за
 * пальцем, при отпускании уходит на соседнюю, если дотянули до трети ширины или бросили быстрее 3500 px/с
 * (`ViewPagerFixed.onTouchEvent`: `backAnimation = |x| < width / 3 && (|velX| < 3500 || |velX| < |velY|)`); у края без
 * соседа тянется с сопротивлением.
 */
export const PAGE_COMMIT_FRACTION = 1 / 3;
export const PAGE_FLING_PX_S = 3500;
/** Ход ленты (мс) при отпускании. */
export const PAGE_ANIM_MS = 200;

/** Куда уходит лента при отпускании: `-1` — к предыдущей (палец вправо), `1` — к следующей, `0` — вернуться. */
export function pageSettle(dx: number, vx: number, width: number, has: { prev: boolean; next: boolean }): -1 | 0 | 1 {
  const w = Math.max(width, 1);
  const fling = Math.abs(vx) > PAGE_FLING_PX_S && Math.sign(vx) === Math.sign(dx);
  const far = Math.abs(dx) > w * PAGE_COMMIT_FRACTION;
  if (!(fling || far) || dx === 0) return 0;
  const dir = dx < 0 ? 1 : -1;
  return (dir === 1 ? has.next : has.prev) ? dir : 0;
}

/** Смещение ленты за пальцем: есть сосед — как есть, нет — с сопротивлением (`ViewPagerFixed` у края). */
export function pageOffset(dx: number, has: { prev: boolean; next: boolean }): number {
  const ok = dx < 0 ? has.next : has.prev;
  return ok ? dx : dx * 0.25;
}

/**
 * Строки своей папки с её порядком закреплённых (09.10, `pinorder2`; Telegram — `pinned_peers` фильтра): закреплённые —
 * сверху по `dmFolderPinnedOrder` (не названные в `order` — выше, в общем порядке), остальные — как были. Без `order` — как есть.
 */
export function folderPinnedRows<T extends Pick<DmChannel, 'id' | 'pinnedAt'>>(rows: readonly T[], order: readonly string[] | undefined): readonly T[] {
  if (!order || order.length === 0) return rows;
  const pinned = rows.filter((d) => !!d.pinnedAt);
  if (pinned.length < 2) return rows;
  const byId = new Map(pinned.map((d) => [d.id, d] as const));
  const top = dmFolderPinnedOrder(
    pinned.map((d) => d.id),
    order,
  ).map((id) => byId.get(id) as T);
  return [...top, ...rows.filter((d) => !d.pinnedAt)];
}

/** Отметка закрепа строки, закреплённой только в папке (`pinset1`): строке нужен признак «закреплена», время не важно. */
export const FOLDER_PIN_AT = '1970-01-01T00:00:00.000Z';

/**
 * Строки папки со СВОИМ набором закреплённых (09.10, `pinset1`; Telegram — `pinned_peers` фильтра): члены набора — сверху в его
 * порядке и с признаком закрепа (`pinnedAt`; закреплённая только в папке — `FOLDER_PIN_AT`); закреплённые лишь в общем списке
 * теряют признак и встают среди остальных по времени последнего сообщения (`lastMessageAt ?? createdAt`). `rows` — строки папки
 * в порядке списка (закреплённые общие сверху, дальше по времени).
 */
export function folderOwnPinRows<T extends Pick<DmChannel, 'id' | 'pinnedAt' | 'lastMessageAt' | 'createdAt'>>(
  rows: readonly T[],
  set: readonly string[],
): readonly T[] {
  const byId = new Map(rows.map((d) => [d.id, d] as const));
  const inSet = new Set(set);
  const top: T[] = [];
  for (const id of set) {
    const d = byId.get(id);
    if (d && !top.includes(d)) top.push(d.pinnedAt ? d : { ...d, pinnedAt: FOLDER_PIN_AT });
  }
  const rest = rows.filter((d) => !inSet.has(d.id));
  const loose = rest.filter((d) => !d.pinnedAt);
  const unpinned = rest.filter((d) => !!d.pinnedAt).map((d) => ({ ...d, pinnedAt: null }));
  if (top.length === 0 && unpinned.length === 0) return rows;
  const key = (d: T) => d.lastMessageAt ?? d.createdAt;
  const out = [...loose];
  for (const d of unpinned) {
    const at = out.findIndex((x) => key(x).localeCompare(key(d)) < 0);
    out.splice(at < 0 ? out.length : at, 0, d);
  }
  return [...top, ...out];
}

/**
 * Перевод своих папок на свой набор закреплённых (09.10, `pinset1`, `POST /dm-folders/pinned-own`): для каждой своей папки без
 * набора — что в ней сейчас видно закреплённым и в каком порядке (`dmFolderPinnedOrder` поверх общего `pinnedAt`), чтобы при
 * переходе ничего не открепилось само. `dms` — список без архива; `chatOf` — состояние беседы для правил папки.
 */
export function folderPinOwnPlan(
  folders: readonly DmFolder[],
  dms: readonly Pick<DmChannel, 'id' | 'pinnedAt'>[],
  chatOf: (id: string) => FolderChatState | undefined,
): { id: string; ids: string[] }[] {
  const pinned = dms
    .filter((d) => !!d.pinnedAt)
    .sort((a, b) => (b.pinnedAt as string).localeCompare(a.pinnedAt as string));
  const out: { id: string; ids: string[] }[] = [];
  for (const f of folders) {
    if (f.system || f.pinnedOwn) continue;
    const ids = pinned
      .filter((d) => {
        const c = chatOf(d.id);
        return !!c && dmFolderContains(f, folderChat(c));
      })
      .map((d) => d.id);
    out.push({ id: f.id, ids: dmFolderPinnedOrder(ids, f.pinned) });
  }
  return out;
}

/** Тост предела закреплённых в своей папке (09.10, `pinset1`, 409 `folders.pin_limit`; у Telegram — 100 в папке). */
export function dmFolderPinLimitText(max: number | undefined): string {
  return `Достигнут лимит: в папке можно закрепить не больше ${max ?? DM_FOLDER_PINNED_MAX} бесед`;
}
