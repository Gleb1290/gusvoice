import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  DM_FOLDER_CHATS_MAX,
  dmFolderCanRemove,
  dmFolderContains,
  dmFolderDefaultIcon,
  dmFolderOwnPins,
  dmFolderTitle,
  type DmChannel,
  type DmFolder,
} from '@gusvoice/shared';
import { confirmAction } from '../confirm';
import { isTauri } from '../hotkeys';
import { READ_ALL_CONFIRM_ABOVE } from '../dmListRules';
import { serverFolders, useDmFolders } from '../dmFolders';
import {
  activeFolderOf,
  badgeText,
  digitOfKey,
  dragShift,
  dropIndex,
  FOLDER_DRAG_START_PX,
  FOLDER_HOLD_MS,
  folderBadge,
  folderByHotkey,
  dmFolderPinLimitText,
  folderChat,
  folderPinOwnPlan,
  foldersPinned,
  foldersShown,
  movedIds,
  neighbourFolder,
  type FolderChatState,
} from '../dmFolderView';
import { peerNameNow } from '../peerName';
import { serverFolderPinOrder, serverFolderPinSet } from '../convSyncRules';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { ContextMenu, MenuDivider, MenuItem, type MenuPos } from './ContextMenu';
import { readAllDms } from './DmRowMenu';
import { Icon } from './Icon';

/**
 * Папки бесед ЛС (07.10, #211, G40, решение владельца Р-8; сервер `folders1`) — как у Telegram.
 *
 * ПК — полоса папок слева от списка, как у Telegram Desktop по умолчанию (`window/window_filters_menu.cpp`,
 * `chatFiltersHorizontal = false` в `core/core_settings.h`): значок, число непрочитанного, подпись; внизу «Изменить».
 * Телефон — вкладки над списком и свайп по списку между папками, как у Telegram Android (`DialogsActivity`,
 * `FilterTabsView`). ПКМ / удержание по вкладке — меню (`FiltersMenu::showMenu`): у своей папки «Изменить папку»,
 * «Прочитать все», «Удалить»; у «Личных сообщений» — «Прочитать все» и «Настроить папки». Ctrl+Shift+↓/↑ — соседняя
 * папка (`core/shortcuts.cpp`, `FolderNext` / `FolderPrevious`, без перехода по кругу), Ctrl+1…8 — вкладка по номеру
 * (`ShowAllChats`, `ShowFolder1…6`, `ShowFolderLast`; номер дальше последней — последняя: `dialogs_inner_widget.cpp`).
 * Полосы нет, пока у человека нет своих папок (у Telegram — пока есть только «Все чаты»).
 *
 * Вкладки перетаскиваются (G40): мышью — потянуть дальше `FOLDER_DRAG_START_PX` (`VerticalLayoutReorder`, как в Telegram
 * Desktop), пальцем — удержать `FOLDER_HOLD_MS` и вести (Android `FilterTabsView`: перестановка по удержанию). Остальные
 * вкладки уступают место, «Личные сообщения» закреплены первыми (`addPinnedInterval(0, 1)`: без Premium «Все чаты» не
 * двигаются). Порядок уходит на сервер (`PUT /api/dm-folders/order`, `useDmFolders.reorder`) — на других устройствах он
 * придёт событием `dmFolders.update`.
 */

/** Открыть редактор папки в настройках: `id` — папка, `'new'` — новая (`include` — с этой беседой), `null` — список. */
export interface FolderEditRequest {
  id: string | 'new' | null;
  include?: string;
}

let editRequest: FolderEditRequest | null = null;

/** Забрать запрос редактора (его читает раздел «Папки» настроек один раз). */
export function takeFolderEditRequest(): FolderEditRequest | null {
  const r = editRequest;
  editRequest = null;
  return r;
}

/** Есть ли запрос — окно настроек открывается сразу на разделе «Папки». */
export function hasFolderEditRequest(): boolean {
  return editRequest !== null;
}

export function openFolderEditor(req: FolderEditRequest): void {
  editRequest = req;
  useStore.getState().setSettingsOpen(true);
}

/** Папки включены: сервер умеет и список бесед — новые беседы (`/api/conv`). */
export function useFoldersOn(): boolean {
  return useStore((s) => s.convActive && serverFolders(s.serverFeatures));
}

/** «Прочитать все» в папке (`MarkAsReadMenu::AddChatListAction`, `ChatListKind::Folder`); подтверждение — как у всех бесед. */
async function readAllInFolder(f: DmFolder, chats: readonly FolderChatState[]): Promise<void> {
  if (f.system) return readAllDms();
  const unread = chats.filter((c) => (c.unread > 0 || c.marked) && dmFolderContains(f, folderChat(c)));
  const total = unread.reduce((n, c) => n + c.unread, 0);
  if (total > READ_ALL_CONFIRM_ABOVE) {
    const ok = await confirmAction({
      title: 'Прочитать все беседы в папке?',
      body: 'Вы точно хотите пометить все беседы этой папки как прочитанные? Это действие нельзя отменить.',
      confirmLabel: 'Прочитать все',
    });
    if (!ok) return;
  }
  const st = useStore.getState();
  await Promise.all(unread.map((c) => st.markConvRead(c.id))).catch(toastError);
}

async function removeFolder(f: DmFolder): Promise<void> {
  const ok = await confirmAction({
    title: `Удалить папку «${dmFolderTitle(f)}»?`,
    body: 'Папка исчезнет, а беседы из неё останутся в «Личных сообщениях».',
    confirmLabel: 'Удалить',
    tone: 'danger',
  });
  if (ok) await useDmFolders.getState().remove(f.id).catch(toastError);
}

function FolderGlyph({ f, size }: { f: DmFolder; size: number }) {
  return f.emoticon ? (
    <span className="dm-folder-emo" style={{ fontSize: size - 2 }} aria-hidden="true">
      {f.emoticon}
    </span>
  ) : (
    <Icon name={dmFolderDefaultIcon(f)} size={size} />
  );
}

interface UiArgs {
  dms: readonly DmChannel[];
  /** Беседа в списке «непрочитана» с числом (как у строки: `unreadDms` и не открытая). */
  unreadOf: (d: DmChannel) => number;
  isMuted: (d: DmChannel) => boolean;
  /** Открытая беседа: у Telegram она не пропадает из папки «Непрочитанные», пока открыта. */
  openId: string | null;
  phone: boolean;
}

export interface FolderUi {
  /** Полоса / вкладки показаны. */
  on: boolean;
  /** Полоса слева (ПК) — корню списка нужен отступ. */
  strip: boolean;
  /** Открыта «главная» вкладка (системная «Личные сообщения») или папок нет: только в ней стоит строка «Архив» (Telegram — «Все чаты»). */
  home: boolean;
  /** Беседа видна в открытой папке (поиск ищет по всем, как у Telegram). */
  keep: (d: DmChannel) => boolean;
  /**
   * Открытая СВОЯ папка (не системная), когда сервер ведёт у папок свой порядок закреплённых (09.10, `pinorder2`,
   * `DmFolder.pinned`; Telegram — `pinned_peers` фильтра); иначе `null` (порядок общий, в своей папке не меняется).
   */
  pinFolder: DmFolder | null;
  /**
   * Свой набор закреплённых открытой своей папки сверху вниз (09.10, `pinset1`, `DmFolder.pinnedOwn`; Telegram — `pinned_peers`):
   * «Закрепить» в ней — только в папке, общий закреп в ней не действует. `null` — закреп в папке общий.
   */
  ownPins: readonly string[] | null;
  bar: ReactNode;
  /** Папка пуста — подпись на месте списка. */
  empty: ReactNode;
  /** Листание папок жестом (телефон): есть ли соседи и переход (`DmListSwipe.tsx`). */
  pages: { on: boolean; has: { prev: boolean; next: boolean }; step: (dir: -1 | 1) => void };
}

/** Идёт перетаскивание вкладки: какая, откуда, куда и на сколько пикселей ушла за пальцем / курсором. */
interface DragState {
  id: string;
  from: number;
  to: number;
  delta: number;
  /** Занимаемое место вкладки вдоль оси (с промежутком) — на столько уступают остальные. */
  size: number;
}

/**
 * Перетаскивание вкладок папок (G40): мышью на ПК (полоса вертикальная — ось Y) и удержанием на телефоне (вкладки
 * горизонтальные — ось X). Что именно считается — `dmFolderView.ts` (`dropIndex`, `movedIds`, `dragShift`). Системная
 * вкладка закреплена первой (`foldersPinned`).
 */
function useFolderDrag(args: {
  phone: boolean;
  list: readonly DmFolder[];
  barRef: React.RefObject<HTMLDivElement | null>;
  /** Удержание закончилось без движения — открыть меню вкладки там, где был палец. */
  onHoldMenu: (f: DmFolder, x: number, y: number) => void;
}) {
  const { phone, list, barRef, onHoldMenu } = args;
  const [drag, setDragState] = useState<DragState | null>(null);
  const dragNow = useRef<DragState | null>(null);
  const setDrag = (d: DragState | null) => {
    dragNow.current = d;
    setDragState(d);
  };
  const live = useRef({ list, onHoldMenu });
  live.current = { list, onHoldMenu };
  const arm = useRef<{
    id: string;
    from: number;
    pointer: number;
    x0: number;
    y0: number;
    mids: number[];
    size: number;
    timer: number | null;
    touch: boolean;
    active: boolean;
    moved: boolean;
    held: boolean;
    last: { x: number; y: number };
  } | null>(null);
  const swallow = useRef(false);

  // Вести палец, не листая полосу, можно только отменив прокрутку ДО её начала — слушатель не из React (тот пассивный).
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const stop = (e: TouchEvent) => {
      if (arm.current?.touch && (arm.current.held || arm.current.active) && e.cancelable) e.preventDefault();
    };
    el.addEventListener('touchmove', stop, { passive: false });
    return () => el.removeEventListener('touchmove', stop);
  });

  const end = (commit: boolean) => {
    const a = arm.current;
    arm.current = null;
    if (a?.timer != null) window.clearTimeout(a.timer);
    const d = dragNow.current;
    if (commit && a?.active && d) {
      const ids = movedIds(live.current.list.map((f) => f.id), d.from, d.to, foldersPinned(live.current.list));
      if (ids) useDmFolders.getState().reorder(ids).catch(toastError);
    }
    dragNow.current = null;
    setDragState(null);
    if (a?.active) {
      swallow.current = true;
      window.setTimeout(() => (swallow.current = false), 60);
      if (commit && a.held && !a.moved) {
        const f = live.current.list[a.from];
        if (f) live.current.onHoldMenu(f, a.last.x, a.last.y);
      }
    }
  };

  const begin = (a: NonNullable<typeof arm.current>, e: { clientX: number; clientY: number }) => {
    a.active = true;
    a.x0 = e.clientX;
    a.y0 = e.clientY;
    setDrag({ id: a.id, from: a.from, to: a.from, delta: 0, size: a.size });
  };

  const props = (f: DmFolder, index: number) => {
    const pinnedN = foldersPinned(list);
    return {
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        if (index < pinnedN || list.length - pinnedN < 2) return;
        const touch = e.pointerType !== 'mouse';
        if (!touch && e.button !== 0) return;
        const bar = barRef.current;
        if (!bar) return;
        const tabs = Array.from(bar.querySelectorAll<HTMLElement>('[data-folder-id]'));
        const rects = tabs.map((t) => t.getBoundingClientRect());
        const mine = rects[index];
        if (!mine || rects.length !== list.length) return;
        const mids = rects.map((r) => (phone ? r.left + r.width / 2 : r.top + r.height / 2));
        const a = {
          id: f.id, from: index, pointer: e.pointerId, x0: e.clientX, y0: e.clientY, mids,
          size: (phone ? mine.width : mine.height) + 4, timer: null as number | null, touch,
          active: false, moved: false, held: false, last: { x: e.clientX, y: e.clientY },
        };
        arm.current = a;
        if (touch) {
          a.timer = window.setTimeout(() => {
            a.timer = null;
            a.held = true;
            navigator.vibrate?.(8);
            begin(a, { clientX: a.x0, clientY: a.y0 });
          }, FOLDER_HOLD_MS);
        }
      },
      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
        const a = arm.current;
        if (!a || a.pointer !== e.pointerId) return;
        a.last = { x: e.clientX, y: e.clientY };
        const dx = e.clientX - a.x0;
        const dy = e.clientY - a.y0;
        const along = phone ? dx : dy;
        if (!a.active) {
          const dist = Math.hypot(dx, dy);
          if (a.touch) {
            // Палец поехал до удержания — это прокрутка полосы, не перестановка.
            if (dist > 10) {
              if (a.timer != null) window.clearTimeout(a.timer);
              arm.current = null;
            }
            return;
          }
          if (dist < FOLDER_DRAG_START_PX) return;
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          begin(a, { clientX: a.x0, clientY: a.y0 });
          return;
        }
        a.moved = true;
        const center = a.mids[a.from] + along;
        const to = dropIndex(a.mids, center, foldersPinned(live.current.list));
        setDrag({ id: a.id, from: a.from, to, delta: along, size: a.size });
      },
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
        if (arm.current && arm.current.pointer === e.pointerId) end(true);
      },
      onPointerCancel: () => end(false),
      // Отпускание после перестановки / удержания не должно стать щелчком: он закрыл бы только что открытое меню вкладки.
      onTouchEnd: (e: React.TouchEvent) => {
        if (swallow.current && e.cancelable) e.preventDefault();
      },
      onClickCapture: (e: React.MouseEvent) => {
        if (swallow.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
    };
  };

  /** Системное «долгое нажатие» Android во время перетаскивания меню не открывает (его откроет отпускание без движения). */
  const menuBlocked = () => !!arm.current && (arm.current.active || arm.current.held);

  const style = (i: number): CSSProperties | undefined => {
    if (!drag) return undefined;
    const axis = phone ? 'X' : 'Y';
    if (i === drag.from) return { transform: `translate${axis}(${drag.delta}px)`, transition: 'none' };
    const s = dragShift(i, drag.from, drag.to);
    return s ? { transform: `translate${axis}(${s * drag.size}px)` } : undefined;
  };

  return { drag, props, style, menuBlocked };
}

/** Закрепить / открепить только в папке (09.10, `pinset1`): предел — тост, как у общего закрепа; иначе — ошибка тостом. */
export function toggleFolderPinned(folderId: string, convId: string, pinned: boolean): Promise<void> {
  return useDmFolders
    .getState()
    .pinChat(folderId, convId, pinned)
    .catch((e: unknown) => {
      const err = e as { reason?: string; max?: number };
      if (err.reason === 'folders.pin_limit') toast('error', dmFolderPinLimitText(err.max));
      else toastError(e);
    });
}

export function useDmFolderUi({ dms, unreadOf, isMuted, openId, phone }: UiArgs): FolderUi {
  const enabled = useFoldersOn();
  const pinOrder2 = useStore((s) => s.convActive && serverFolderPinOrder(s.serverFeatures));
  const pinSetOn = useStore((s) => s.convActive && serverFolderPinSet(s.serverFeatures));
  // Перевод папок на свой набор считается по списку бесед — только по догнанному (`live`), иначе закреплённые «пропали» бы.
  const listLive = useStore((s) => s.conv.phase === 'live');
  const folders = useDmFolders((s) => s.folders);
  const activeId = useDmFolders((s) => s.activeId);
  const [menu, setMenu] = useState<{ f: DmFolder; pos: MenuPos } | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const kept = useRef<string | null>(null);

  useEffect(() => {
    if (enabled) useDmFolders.getState().load().catch(() => {});
  }, [enabled]);

  const shown = enabled && foldersShown(folders);
  const list = shown ? folders : [];
  const active = shown ? activeFolderOf(list, activeId) : null;

  const chats = useMemo<FolderChatState[]>(
    // `group` (08.10): без него тип папки «Группы» (`groups2`) не находил ни одной группы.
    () => dms.map((d) => ({ id: d.id, group: !!d.group, unread: unreadOf(d), marked: d.markedUnread === true, muted: isMuted(d) })),
    [dms, unreadOf, isMuted],
  );
  const byId = useMemo(() => new Map(chats.map((c) => [c.id, c] as const)), [chats]);

  /* Свой набор закреплённых в папках (09.10, `pinset1`): новая папка — сразу с набором (`useDmFolders.create`); папка без набора
     переводится один раз — набор = что в ней сейчас видно закреплённым в её порядке (`folderPinOwnPlan`), ничего не открепляется.
     Другое устройство могло перевести раньше — сервер такую папку не трогает. */
  useEffect(() => {
    if (useDmFolders.getState().pinSet !== pinSetOn) useDmFolders.setState({ pinSet: pinSetOn });
  }, [pinSetOn]);
  const ownTried = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!enabled || !pinSetOn || !listLive || !folders) return;
    const plan = folderPinOwnPlan(folders, dms, (id) => byId.get(id)).filter((p) => !ownTried.current.has(p.id));
    if (plan.length === 0) return;
    for (const p of plan) ownTried.current.add(p.id);
    useDmFolders
      .getState()
      .pinOwn(plan)
      // Не вышло — папка до следующего запуска живёт по-старому (закреп общий, `pinorder2`); повтор на каждом рендере не нужен.
      .catch(() => {});
  }, [enabled, pinSetOn, listLive, folders, dms, byId]);

  // Открытая беседа держится в папке, пока открыта (`fakeUnreadWhileOpened`), — но только если уже была в ней.
  if (kept.current !== openId) kept.current = null;
  const keep = useCallback(
    (d: DmChannel) => {
      if (!active) return true;
      const c = byId.get(d.id);
      if (!c) return true;
      const sticky = kept.current === d.id;
      const inside = dmFolderContains(active, folderChat(c), sticky);
      if (inside && d.id === openId) kept.current = d.id;
      return inside;
    },
    [active, byId, openId],
  );

  const go = useCallback((f: DmFolder | null) => {
    if (f) useDmFolders.getState().select(f.id);
  }, []);

  // Ctrl+Shift+↓ / ↑ — соседняя папка (`FolderNext` / `FolderPrevious`), Ctrl+1…8 — вкладка по номеру (`folderByHotkey`); окно поверх — не наше.
  useEffect(() => {
    if (!shown || phone) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const st = useDmFolders.getState();
      if (!e.shiftKey) {
        const n = digitOfKey(e.code);
        const f = n === null ? null : folderByHotkey(st.folders ?? [], n);
        if (!f) return;
        e.preventDefault();
        st.select(f.id);
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const next = neighbourFolder(st.folders ?? [], st.activeId, e.key === 'ArrowDown' ? 1 : -1);
      e.preventDefault();
      if (next) st.select(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, phone]);

  const dnd = useFolderDrag({
    phone,
    list,
    barRef,
    onHoldMenu: (f, x, y) => setMenu({ f, pos: { x, y } }),
  });

  // Выбранная вкладка не должна оставаться за краем полосы (листание свайпом, Ctrl+цифра).
  useEffect(() => {
    if (!active) return;
    barRef.current
      ?.querySelector<HTMLElement>(`[data-folder-id="${CSS.escape(active.id)}"]`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active?.id]);

  const pages: FolderUi['pages'] = {
    on: shown && phone,
    has: {
      prev: !!neighbourFolder(list, active?.id ?? null, -1),
      next: !!neighbourFolder(list, active?.id ?? null, 1),
    },
    step: (dir) => go(neighbourFolder(list, active?.id ?? null, dir)),
  };

  const close = useCallback(() => setMenu(null), []);
  let menuNode: ReactNode = null;
  if (menu) {
    const { f, pos } = menu;
    const hasUnread = chats.some((c) => (c.unread > 0 || c.marked) && dmFolderContains(f, folderChat(c)));
    const act = (fn: () => void) => () => {
      close();
      fn();
    };
    menuNode = (
      <ContextMenu pos={pos} onClose={close} width={232}>
        {!f.system && <MenuItem icon="edit" label="Изменить папку" onClick={act(() => openFolderEditor({ id: f.id }))} />}
        <MenuItem
          icon="checks"
          label="Прочитать все"
          disabled={!hasUnread}
          onClick={act(() => void readAllInFolder(f, chats))}
        />
        {f.system ? (
          <MenuItem icon="settings" label="Настроить папки" onClick={act(() => openFolderEditor({ id: null }))} />
        ) : (
          <>
            <MenuDivider />
            <MenuItem icon="trash" label="Удалить" danger onClick={act(() => void removeFolder(f))} />
          </>
        )}
      </ContextMenu>
    );
  }

  const tab = (f: DmFolder, i: number) => {
    const b = folderBadge(f, chats);
    const on = f.id === active?.id;
    const title = dmFolderTitle(f);
    const dragging = dnd.drag?.id === f.id;
    return (
      <button
        key={f.id}
        type="button"
        role="tab"
        aria-selected={on}
        data-folder-id={f.id}
        className={`${on ? 'dm-folder on' : 'dm-folder'}${dragging ? ' dragging' : ''}${dnd.drag && !dragging ? ' yielding' : ''}`}
        style={dnd.style(i)}
        title={phone ? undefined : title}
        {...dnd.props(f, i)}
        onClick={() => go(f)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (dnd.menuBlocked()) return;
          setMenu({ f, pos: { x: e.clientX, y: e.clientY } });
        }}
      >
        {!phone && (
          <span className="dm-folder-ico">
            <FolderGlyph f={f} size={22} />
          </span>
        )}
        <span className="dm-folder-name">{title}</span>
        {b.n > 0 && (
          <span className={b.muted ? 'dm-folder-badge muted' : 'dm-folder-badge'} aria-label={`, непрочитанных ${b.n}`}>
            {badgeText(b.n)}
          </span>
        )}
      </button>
    );
  };

  const bar: ReactNode = shown ? (
    <>
      <div ref={barRef} className={phone ? 'dm-folder-tabs' : isTauri() ? 'dm-folders desk' : 'dm-folders'} role="tablist" aria-label="Папки">
        {list.map(tab)}
        {!phone && (
          <button type="button" className="dm-folder edit" title="Настроить папки" onClick={() => openFolderEditor({ id: null })}>
            <span className="dm-folder-ico">
              <Icon name="settings" size={20} />
            </span>
            <span className="dm-folder-name">Изменить</span>
          </button>
        )}
      </div>
      {menuNode}
    </>
  ) : null;

  const empty: ReactNode =
    active && !active.system ? (
      <div className="dm-empty dm-nores">
        <span>В этой папке пока нет бесед.</span>
        <button type="button" className="link" onClick={() => openFolderEditor({ id: active.id })}>
          Изменить папку
        </button>
      </div>
    ) : null;

  const pinFolder = pinOrder2 && active && !active.system ? active : null;
  const ownPins = pinSetOn && pinFolder ? dmFolderOwnPins(pinFolder) : null;
  return { on: shown, strip: shown && !phone, home: !active || !!active.system, keep, pinFolder, ownPins, bar, empty, pages };
}

/**
 * Второй уровень «Добавить в папку ▸» в меню беседы (`FillChooseFilterMenu`): все свои папки с галочкой у тех, где беседа
 * уже есть; нажатие добавляет или убирает (убрать нельзя, если папка опустеет — `CanRemoveFromChatFilter`), тост
 * `lng_filters_toast_add` / `_remove`. Внизу — «Новая папка» с этой беседой (как у Telegram Android).
 */
export function DmFolderMenuItems({ dm, muted, onDone }: { dm: DmChannel; muted: boolean; onDone: () => void }) {
  const folders = useDmFolders((s) => s.folders) ?? [];
  const chat = { id: dm.id, group: !!dm.group, muted, unread: (dm.unread ?? 0) > 0 || dm.markedUnread === true };
  const own = folders.filter((f) => !f.system);
  return (
    <>
      {own.map((f) => {
        const inside = dmFolderContains(f, chat);
        const can = inside ? dmFolderCanRemove(f, chat) : f.include.length < DM_FOLDER_CHATS_MAX;
        return (
          <MenuItem
            key={f.id}
            icon={inside ? 'check' : undefined}
            label={dmFolderTitle(f)}
            disabled={!can}
            onClick={() => {
              onDone();
              useDmFolders
                .getState()
                .toggleChat(f.id, chat, !inside)
                .then(() =>
                  toast(
                    'success',
                    inside
                      ? `${peerNameNow(dm.otherUser.id, dm.otherUser.displayName)} — убрана из папки «${dmFolderTitle(f)}»`
                      : `${peerNameNow(dm.otherUser.id, dm.otherUser.displayName)} — добавлена в папку «${dmFolderTitle(f)}»`,
                  ),
                )
                .catch(toastError);
            }}
          />
        );
      })}
      {own.length > 0 && <MenuDivider />}
      <MenuItem
        icon="plus"
        label="Новая папка"
        onClick={() => {
          onDone();
          openFolderEditor({ id: 'new', include: dm.id });
        }}
      />
    </>
  );
}

/**
 * «Убрать из папки «…»» в меню беседы, когда открыта своя папка и беседу из неё можно убрать (`dmFolderCanRemove`): у
 * Telegram Android этот пункт есть в меню чата внутри папки.
 */
export function FolderRemoveItem({ dm, muted, onDone }: { dm: DmChannel; muted: boolean; onDone: () => void }) {
  const folders = useDmFolders((s) => s.folders);
  const activeId = useDmFolders((s) => s.activeId);
  if (!foldersShown(folders)) return null;
  const f = activeFolderOf(folders, activeId);
  const chat = { id: dm.id, group: !!dm.group, muted, unread: (dm.unread ?? 0) > 0 || dm.markedUnread === true };
  if (!f || !dmFolderCanRemove(f, chat)) return null;
  return (
    <MenuItem
      icon="minus"
      label={`Убрать из папки «${dmFolderTitle(f)}»`}
      onClick={() => {
        onDone();
        useDmFolders
          .getState()
          .toggleChat(f.id, chat, false)
          .then(() => toast('success', `${peerNameNow(dm.otherUser.id, dm.otherUser.displayName)} — убрана из папки «${dmFolderTitle(f)}»`))
          .catch(toastError);
      }}
    />
  );
}

/** Беседа выбора глазами правила папки. */
const pickChat = (dm: DmChannel, muted: boolean) => ({ id: dm.id, group: !!dm.group, muted, unread: (dm.unread ?? 0) > 0 || dm.markedUnread === true });

/** По одной беседе, по очереди: каждый ответ сервера — весь список папок, параллельные затёрли бы друг друга. */
function toggleChatsInFolder(folderId: string, chats: readonly ReturnType<typeof pickChat>[], add: boolean): Promise<void> {
  return chats.reduce<Promise<void>>((p, c) => p.then(() => useDmFolders.getState().toggleChat(folderId, c, add)), Promise.resolve());
}

/**
 * Что режим выбора бесед на телефоне умеет с папками (Telegram Android `DialogsActivity.updateCounters`,
 * `TA/ui/DialogsActivity.java:9927-9947`): «В папку» — на главной вкладке и в архиве, если есть свои папки
 * (`getCanAddDialogFilters` не пуст); «Убрать из папки» — открыта своя папка и хоть одну выбранную из неё можно убрать.
 */
export function useFolderPickCaps(): { add: boolean; removeFrom: DmFolder | null } {
  const on = useFoldersOn();
  const folders = useDmFolders((s) => s.folders);
  const activeId = useDmFolders((s) => s.activeId);
  if (!on || !foldersShown(folders)) return { add: false, removeFrom: null };
  const active = activeFolderOf(folders, activeId);
  const home = !active || !!active.system;
  return { add: home && folders.some((f) => !f.system), removeFrom: home ? null : active };
}

/**
 * Второй уровень «В папку» режима выбора (Telegram Android `FiltersListBottomSheet`, вызов — `add_to_folder`
 * `TA/ui/DialogsActivity.java:3913`): свои папки; галочка — ВСЕ выбранные уже там, тогда нажатие убирает их (если папка не
 * опустеет — `dmFolderCanRemove`), иначе добавляет недостающих (не больше `DM_FOLDER_CHATS_MAX` явно включённых).
 */
export function DmFolderPickItems({ picked, isMuted, onDone }: { picked: readonly DmChannel[]; isMuted: (dm: DmChannel) => boolean; onDone: () => void }) {
  const folders = useDmFolders((s) => s.folders) ?? [];
  const chats = picked.map((d) => pickChat(d, isMuted(d)));
  const n = chats.length;
  return (
    <>
      {folders
        .filter((f) => !f.system)
        .map((f) => {
          const missing = chats.filter((c) => !dmFolderContains(f, c));
          const all = missing.length === 0;
          const can = all ? chats.every((c) => dmFolderCanRemove(f, c)) : f.include.length + missing.length <= DM_FOLDER_CHATS_MAX;
          const title = dmFolderTitle(f);
          return (
            <MenuItem
              key={f.id}
              icon={all ? 'check' : undefined}
              label={title}
              disabled={!can}
              onClick={() => {
                onDone();
                toggleChatsInFolder(f.id, all ? chats : missing, !all)
                  .then(() => toast('success', all ? `Убрано из папки «${title}»: ${n}` : `Добавлено в папку «${title}»: ${missing.length}`))
                  .catch(toastError);
              }}
            />
          );
        })}
    </>
  );
}

/**
 * Пункты папок в «⋯» режима выбора: «В папку ▸» (`onFolders` — открыть второй уровень, `DmFolderPickItems`) и «Убрать из
 * папки «…»» — по `useFolderPickCaps`. Отдельным компонентом: панель выбора зовёт его, только если папки включены.
 */
export function DmFolderPickEntries({
  picked,
  isMuted,
  onDone,
  onFolders,
}: {
  picked: readonly DmChannel[];
  isMuted: (dm: DmChannel) => boolean;
  onDone: () => void;
  onFolders: () => void;
}) {
  const caps = useFolderPickCaps();
  return (
    <>
      {caps.add && <MenuItem icon="folder" label="В папку" submenu onClick={onFolders} />}
      {caps.removeFrom && <FolderRemovePickItem folder={caps.removeFrom} picked={picked} isMuted={isMuted} onDone={onDone} />}
    </>
  );
}

/** «Убрать из папки «…»» режима выбора: убирает из открытой своей папки тех выбранных, кого можно (`dmFolderCanRemove`). */
function FolderRemovePickItem({
  folder,
  picked,
  isMuted,
  onDone,
}: {
  folder: DmFolder;
  picked: readonly DmChannel[];
  isMuted: (dm: DmChannel) => boolean;
  onDone: () => void;
}) {
  const chats = picked.map((d) => pickChat(d, isMuted(d))).filter((c) => dmFolderCanRemove(folder, c));
  if (chats.length === 0) return null;
  const title = dmFolderTitle(folder);
  return (
    <MenuItem
      icon="minus"
      label={`Убрать из папки «${title}»`}
      onClick={() => {
        onDone();
        toggleChatsInFolder(folder.id, chats, false)
          .then(() => toast('success', `Убрано из папки «${title}»: ${chats.length}`))
          .catch(toastError);
      }}
    />
  );
}
