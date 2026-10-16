import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { DmChannel } from '@gusvoice/shared';
import { archivePreview, ARCHIVE_TOAST } from '../dmArchiveRules';
import { dmRowTime } from '../dmRowRules';
import { usePeerName } from '../peerName';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { useSidebarNarrow } from '../uiPrefs';
import { ContextMenu, MenuItem, type MenuPos } from './ContextMenu';
import { DM_ROW_AVA } from '../dmListView';
/** Аватар строки на телефоне — как у бесед (`DmSidebar.tsx`, Telegram Android `DialogCell` 52). */
const DM_ROW_AVA_PHONE = 52;
import { Icon } from './Icon';

/**
 * Архив бесед ЛС (07.10, #211, G41; сервер `archive1`): строка «Архив» наверху списка, шапка экрана архива, действия
 * «В архив» / «Вернуть из архива» с тостом «Отмена». Правила и источники — `dmArchiveRules.ts`.
 */

/**
 * «В архив» / «Вернуть из архива» одной или нескольких бесед. В архив — тост «Чат в архиве» с «Отмена» (Telegram Android
 * `UndoView`: кнопка возвращает), обратно — тост без кнопки (`lng_archived_removed`). Сбой — обычный тост ошибки, состояние
 * откатывает стор. Беседа уезжает из списка сразу (оптимистично), тост — после ответа сервера; отмена идёт тем же путём.
 */
export function archiveDms(ids: readonly string[], archived: boolean): void {
  if (ids.length === 0) return;
  const st = useStore.getState();
  void Promise.all(ids.map((id) => st.setConvArchived(id, archived)))
    .then(() => {
      if (archived) {
        toast('info', ids.length > 1 ? 'Чаты в архиве' : ARCHIVE_TOAST.added, ARCHIVE_TOAST.addedHint, {
          action: { label: ARCHIVE_TOAST.undo, onClick: () => archiveDms(ids, false) },
        });
      } else toast('info', ids.length > 1 ? 'Чаты возвращены из архива' : ARCHIVE_TOAST.removed);
    })
    .catch(toastError);
}

// ─── Свёрнутый / развёрнутый вид строки «Архив» — на устройстве (`archiveCollapsed` у Telegram — настройка сессии) ───
const COLLAPSED_KEY = 'gv.dm.archiveCollapsed';
const listeners = new Set<() => void>();
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}
/** Строка «Архив» свёрнута (тонкая) — настройка этого устройства; `[значение, переключить]`. */
export function useArchiveCollapsed(): [boolean, (v: boolean) => void] {
  const on = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    readCollapsed,
    () => false,
  );
  const set = useCallback((v: boolean) => {
    try {
      if (v) localStorage.setItem(COLLAPSED_KEY, '1');
      else localStorage.removeItem(COLLAPSED_KEY);
    } catch {
      /* хранилище недоступно — вид живёт до перезагрузки */
    }
    listeners.forEach((cb) => cb());
  }, []);
  return [on, set];
}

const HOLD_MS = 450;

/**
 * Строка «Архив» в списке ЛС. Развёрнутая — обычная строка со значком архива, именами последних бесед (непрочитанные жирным)
 * и серым числом непрочитанных бесед; свёрнутая — тонкая строка «Архив» с тем же числом (`CollapsedRow` у Telegram Desktop).
 * ПКМ / удержание — «Свернуть» / «Развернуть» и «Прочитать все».
 */
export function DmArchiveRow({
  list,
  unreadDms,
  unreadChats,
  collapsed,
  onCollapsed,
  onOpen,
  phone,
}: {
  /** Беседы архива в порядке списка. */
  list: readonly DmChannel[];
  unreadDms: readonly string[];
  unreadChats: number;
  collapsed: boolean;
  onCollapsed: (v: boolean) => void;
  onOpen: () => void;
  phone: boolean;
}) {
  const [menuAt, setMenuAt] = useState<MenuPos | null>(null);
  const hold = useRef<{ timer: number | null; x: number; y: number; fired: boolean } | null>(null);
  const stop = () => {
    const h = hold.current;
    if (h?.timer != null) window.clearTimeout(h.timer);
    if (h) h.timer = null;
  };
  useEffect(() => stop, []);
  const preview = archivePreview(list, unreadDms, usePeerName());
  const when = collapsed ? null : dmRowTime(list[0]?.lastMessageAt ?? null);
  const label = `Архив, бесед: ${list.length}${unreadChats > 0 ? `, непрочитанных ${unreadChats}` : ''}`;
  const badge =
    unreadChats > 0 ? (
      <span className="dm-badge muted" aria-hidden="true">
        {unreadChats > 99 ? '99+' : unreadChats}
      </span>
    ) : null;
  const readAll = () => {
    for (const d of list) {
      if ((d.unread ?? 0) > 0 || d.markedUnread === true) void useStore.getState().markConvRead(d.id).catch(toastError);
    }
  };
  const menu: ReactNode = menuAt ? (
    <ContextMenu pos={menuAt} onClose={() => setMenuAt(null)} width={232}>
      <MenuItem
        icon={collapsed ? 'chevron-down' : 'chevron-up'}
        label={collapsed ? 'Развернуть' : 'Свернуть'}
        onClick={() => {
          setMenuAt(null);
          onCollapsed(!collapsed);
        }}
      />
      <MenuItem
        icon="checks"
        label="Прочитать все"
        disabled={unreadChats === 0}
        onClick={() => {
          setMenuAt(null);
          readAll();
        }}
      />
    </ContextMenu>
  ) : null;
  const side = collapsed ? 28 : phone ? DM_ROW_AVA_PHONE : DM_ROW_AVA;
  /* «Только аватары» (G34): подписи в строке нет — она в подсказке. */
  const narrowCol = useSidebarNarrow() && !phone;
  return (
    <>
      <button
        type="button"
        data-swipe-row={collapsed ? undefined : 'archive'}
        className={`dm-row dm-archive-row${collapsed ? ' slim' : ''}${unreadChats > 0 ? ' unread' : ''}`}
        aria-label={label}
        title={narrowCol ? label : undefined}
        onClick={() => {
          if (hold.current?.fired) {
            hold.current = null;
            return;
          }
          onOpen();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (hold.current?.fired) return;
          if (e.clientX === 0 && e.clientY === 0) {
            const r = e.currentTarget.getBoundingClientRect();
            setMenuAt({ x: r.left + 24, y: r.bottom - 4 });
          } else setMenuAt({ x: e.clientX, y: e.clientY });
        }}
        onTouchStart={(e) => {
          stop();
          hold.current = null;
          if (e.touches.length !== 1) return;
          const t = e.touches[0];
          const h = { timer: null as number | null, x: t.clientX, y: t.clientY, fired: false };
          hold.current = h;
          h.timer = window.setTimeout(() => {
            h.fired = true;
            h.timer = null;
            navigator.vibrate?.(8);
            setMenuAt({ x: h.x, y: h.y });
          }, HOLD_MS);
        }}
        onTouchMove={(e) => {
          const h = hold.current;
          const t = e.touches[0];
          if (h && !h.fired && t && (Math.abs(t.clientX - h.x) > 10 || Math.abs(t.clientY - h.y) > 10)) {
            stop();
            hold.current = null;
          }
        }}
        onTouchEnd={(e) => {
          stop();
          if (hold.current?.fired && e.cancelable) e.preventDefault();
        }}
        onTouchCancel={stop}
      >
        <span className="dm-ava">
          <span className="dm-archive-ava" style={{ width: side, height: side }}>
            <Icon name="archive" size={collapsed ? 16 : phone ? 24 : 22} />
          </span>
        </span>
        <span className="dm-name">
          <span className="dm-name-text">Архив</span>
        </span>
        {when && (
          <span className="dm-when">
            <time className="dm-time" dateTime={when.dateTime}>
              {when.label}
            </time>
          </span>
        )}
        {!collapsed && (
          <span className="dm-preview">
            {preview.names.map((n, i) => (
              <span key={n.id}>
                {i > 0 ? ', ' : ''}
                {n.unread ? <strong className="dm-archive-unread">{n.name}</strong> : n.name}
              </span>
            ))}
            {preview.more > 0 && ` ${preview.moreLabel}`}
          </span>
        )}
        {badge}
      </button>
      {menu}
    </>
  );
}

/** Шапка экрана архива: «назад» и название (Telegram — стрелка слева и «Архивные чаты»). */
export function DmArchiveHead({ onBack }: { onBack: () => void }) {
  return (
    <div className="server-head dm-list-head dm-archive-head">
      <button type="button" className="head-icon" aria-label="Назад к беседам" title="Назад" onClick={onBack}>
        <Icon name="chevron-left" size={20} />
      </button>
      <strong>Архив</strong>
    </div>
  );
}
