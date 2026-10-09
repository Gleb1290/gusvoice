import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type TouchEvent } from 'react';
import { flushSync } from 'react-dom';
import type { DmChannel } from '@gusvoice/shared';
import { serverArchive, serverChatClear, serverChatPrefs, serverUnreadMark } from '../convSyncRules';
import {
  effectiveSwipe,
  readSwipeSetting,
  rowSwipeAction,
  SWIPE_CHOICE_LABEL,
  swipeChoices,
  swipeCommits,
  swipeLabel,
  swipeShift,
  writeSwipeSetting,
  type SwipeAction,
  type SwipeCaps,
  type SwipeRowState,
  type SwipeSetting,
} from '../chatSwipe';
import { PAGE_ANIM_MS, pageOffset, pageSettle } from '../dmFolderView';
import { foldersShown } from '../dmFolderView';
import { useDmFolders } from '../dmFolders';
import { withPeerLabel } from '../peerName';
import { useStore } from '../store';
import { toastError } from '../toast';
import { archiveDms } from './DmArchive';
import { toggleDmPinned } from './DmChatView';
import { toggleFolderPinned, useFoldersOn } from './DmFolderBar';
import { deleteChat, deleteFormerGroup } from './dmClearActions';
import { Icon, type IconName } from './Icon';

/**
 * Жесты по списку бесед на телефоне (07.10, #211, G40 + G42) — Telegram Android `DialogsActivity`:
 *  - свайп влево по строке — действие из «Свайп по чату» (`SwipeController`, `chatSwipe.ts`): строка уходит влево, на
 *    открывшемся месте подложка с значком и надписью, действие — на отпускании (порог 0.45 ширины или бросок);
 *  - свайп вбок по списку — между папками (`ViewPagerFixed`): лента идёт за пальцем, у края без соседа тянется туго,
 *    на отпускании уходит на соседнюю, если дотянули до трети ширины или бросили (`pageSettle`);
 *  - «потянуть вниз» на верху списка, когда строка «Архив» свёрнута — показывает её (`archivePullViewState`);
 *  - свайп влево по развёрнутой строке «Архив» — сворачивает её (`toggleArchiveHidden`).
 * Касание начинает один жест: решает первое заметное движение (`LOCK_PX`).
 */

const LOCK_PX = 10;
/** Скорость пальца — по последним столькими мс (Android `VelocityTracker.computeCurrentVelocity`). */
const VELOCITY_WINDOW_MS = 100;
/** Потянули вниз настолько (px) — строка «Архив» показывается (`PullForegroundDrawable.SNAP_HEIGHT` ≈ 0.85 строки в 70 dp). */
export const ARCHIVE_PULL_PX = 60;

/** Что умеет сервер и открытый список: от этого зависят варианты «Свайпа по чату» и сам свайп. */
export function useSwipeCaps(): SwipeCaps {
  const prefs = useStore((s) => s.convActive && serverChatPrefs(s.serverFeatures));
  const read = useStore((s) => s.convActive && serverUnreadMark(s.serverFeatures));
  const archive = useStore((s) => s.convActive && serverArchive(s.serverFeatures));
  const del = useStore((s) => s.convActive && serverChatClear(s.serverFeatures));
  const foldersOn = useFoldersOn();
  const folders = useDmFolders((s) => s.folders);
  return useMemo(
    () => ({ folders: foldersOn && foldersShown(folders), archive, pin: prefs, read, mute: true, del }),
    [foldersOn, folders, archive, prefs, read, del],
  );
}

/** «Свайп по чату» этого устройства: значение и запись (`chatSwipe.ts`); синхронно между окнами через событие `storage`. */
export function useSwipeSetting(): [SwipeSetting, (v: SwipeSetting) => void] {
  const [v, setV] = useState<SwipeSetting>(() => readSwipeSetting());
  useEffect(() => {
    const on = () => setV(readSwipeSetting());
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, []);
  return [v, (next) => (writeSwipeSetting(next), setV(next))];
}

const ICON: Record<SwipeAction, (s: SwipeRowState) => IconName> = {
  pin: (s) => (s.pinned ? 'pin-off' : 'pin'),
  read: (s) => (s.unread ? 'checks' : 'mail'),
  archive: (s) => (s.archived ? 'unarchive' : 'archive'),
  mute: (s) => (s.muted ? 'bell' : 'bell-off'),
  delete: () => 'trash',
  folders: () => 'folder',
};

/** Выполнить действие свайпа над беседой — те же вызовы, что у пунктов меню строки (`DmRowMenu.tsx`). */
export function runSwipeAction(dm: DmChannel, a: SwipeAction, s: SwipeRowState): void {
  const st = useStore.getState();
  switch (a) {
    case 'pin':
      // Своя папка со своим набором (`pinset1`): закреп только в ней, как пункт меню строки.
      return s.pinFolder ? void toggleFolderPinned(s.pinFolder, dm.id, !s.pinned) : toggleDmPinned(dm.id, !s.pinned);
    case 'read':
      return void (s.unread ? st.markConvRead(dm.id) : st.setConvUnreadMark(dm.id, true)).catch(toastError);
    case 'archive':
      return archiveDms([dm.id], !s.archived);
    case 'mute':
      return void st.setPushMuted('dm_user', dm.otherUser.id, !s.muted).catch(toastError);
    case 'delete':
      return void (s.former ? deleteFormerGroup(dm) : deleteChat(dm));
    case 'folders':
      return;
  }
}

/** Подложка под уходящей строкой. */
interface Bg {
  top: number;
  height: number;
  width: number;
  label: string;
  icon: IconName;
  danger: boolean;
  armed: boolean;
}

interface Args {
  listRef: React.RefObject<HTMLElement | null>;
  /** Жесты включены: телефон, не режим выбора. */
  enabled: boolean;
  pages: { on: boolean; has: { prev: boolean; next: boolean }; step: (dir: -1 | 1) => void };
  /** Действие свайпа по строке (`effectiveSwipe`), `null` — строка не свайпается. */
  rowAction: SwipeAction | null;
  /** Беседа и её состояние по id строки (`data-swipe-row`). */
  rowOf: (id: string) => { dm: DmChannel; state: SwipeRowState } | null;
  /** Строка «Архив» стоит развёрнутой — её можно свернуть свайпом. */
  archiveCollapse: (() => void) | null;
  /** Строка «Архив» свёрнута и есть, что показать — «потянуть вниз» показывает её. */
  archivePull: (() => void) | null;
}

/** Действие свайпа этой строки: настройка устройства с поправкой на бывшую группу (`rowSwipeAction`); `null` — строка не свайпается. */
function rowActOf(A: Args, rowId: string | null): SwipeAction | null {
  if (!rowId || rowId === 'archive') return null;
  const info = A.rowOf(rowId);
  return info ? rowSwipeAction(A.rowAction, info.state.former === true) : null;
}

type Mode = 'idle' | 'row' | 'page' | 'pull' | 'none';

interface Gesture {
  x: number;
  y: number;
  t: number;
  /** Последние касания (время, x) — скорость броска считаем по окну в `VELOCITY_WINDOW_MS`, как `VelocityTracker`. */
  trail: { t: number; x: number }[];
  vx: number;
  mode: Mode;
  row: HTMLElement | null;
  rowId: string | null;
  armed: boolean;
  scrollTop: number;
}

const CURVE = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';

export function useDmListSwipe(a: Args): { bind: Record<string, (e: TouchEvent) => void>; overlay: ReactNode } {
  const g = useRef<Gesture | null>(null);
  const [bg, setBgState] = useState<Bg | null>(null);
  const bgEl = useRef<HTMLDivElement | null>(null);
  /** Ширина подложки идёт за пальцем прямо в DOM; перерисовка списка — только когда меняется надпись или «готово». */
  const setBg = useCallback((next: Bg | null) => {
    if (next && bgEl.current) bgEl.current.style.width = `${next.width}px`;
    setBgState((cur) => {
      if (!next || !cur) return next;
      return cur.top === next.top && cur.label === next.label && cur.armed === next.armed && cur.icon === next.icon ? cur : { ...next, width: cur.width };
    });
  }, []);
  const live = useRef(a);
  live.current = a;

  const settleRow = useCallback((row: HTMLElement | null, to: number, ms: number) => {
    if (!row) return;
    row.style.transition = ms ? `transform ${ms}ms ${CURVE}` : 'none';
    row.style.transform = to ? `translateX(${to}px)` : '';
    if (ms)
      window.setTimeout(() => {
        row.style.transition = '';
        if (!to) row.style.transform = '';
      }, ms + 30);
  }, []);

  const onTouchStart = useCallback((e: TouchEvent) => {
    const t = e.touches[0];
    if (!live.current.enabled || e.touches.length !== 1 || !t) {
      g.current = null;
      return;
    }
    const row = (e.target as Element | null)?.closest?.<HTMLElement>('[data-swipe-row]') ?? null;
    const now = performance.now();
    g.current = {
      x: t.clientX, y: t.clientY, t: now, trail: [{ t: now, x: t.clientX }], vx: 0,
      mode: 'idle', row, rowId: row?.dataset.swipeRow ?? null, armed: false,
      scrollTop: live.current.listRef.current?.scrollTop ?? 0,
    };
  }, []);

  const onTouchMove = useCallback(
    (e: TouchEvent) => {
      const s = g.current;
      const t = e.touches[0];
      const list = live.current.listRef.current;
      if (!s || !t || !list) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      const now = performance.now();
      s.trail.push({ t: now, x: t.clientX });
      while (s.trail.length > 2 && now - s.trail[0].t > VELOCITY_WINDOW_MS) s.trail.shift();
      const first = s.trail[0];
      s.vx = now > first.t ? ((t.clientX - first.x) / (now - first.t)) * 1000 : 0;
      const A = live.current;
      if (s.mode === 'idle') {
        if (Math.abs(dx) > LOCK_PX && Math.abs(dx) > Math.abs(dy) * 1.2) {
          const isArchiveRow = s.rowId === 'archive';
          if (dx < 0 && s.row && isArchiveRow && A.archiveCollapse) s.mode = 'row';
          else if (dx < 0 && s.row && !isArchiveRow && rowActOf(A, s.rowId) && rowActOf(A, s.rowId) !== 'folders') s.mode = 'row';
          else if (A.pages.on) s.mode = 'page';
          else s.mode = 'none';
          if (s.mode === 'page') list.style.willChange = 'transform';
        } else if (Math.abs(dy) > LOCK_PX) {
          s.mode = dy > 0 && s.scrollTop <= 0 && A.archivePull ? 'pull' : 'none';
        }
        return;
      }
      if (s.mode === 'row' && s.row) {
        const w = s.row.offsetWidth;
        const shift = swipeShift(dx, w);
        s.row.style.transition = 'none';
        s.row.style.transform = `translateX(${shift}px)`;
        const armed = swipeCommits(shift, 0, w);
        if (armed !== s.armed) {
          s.armed = armed;
          navigator.vibrate?.(8);
        }
        const info = s.rowId === 'archive' ? null : A.rowOf(s.rowId ?? '');
        const act = rowActOf(A, s.rowId);
        setBg({
          top: s.row.offsetTop,
          height: s.row.offsetHeight,
          width: -shift,
          label: info && act ? swipeLabel(act, info.state) : 'Свернуть',
          icon: info && act ? ICON[act](info.state) : 'chevron-up',
          danger: act === 'delete' && !!info,
          armed,
        });
      } else if (s.mode === 'page') {
        list.style.transition = 'none';
        list.style.transform = `translateX(${pageOffset(dx, A.pages.has)}px)`;
      } else if (s.mode === 'pull') {
        list.style.transition = 'none';
        list.style.transform = `translateY(${Math.max(0, Math.min(dy * 0.5, 80))}px)`;
        const armed = dy >= ARCHIVE_PULL_PX;
        if (armed !== s.armed) {
          s.armed = armed;
          if (armed) navigator.vibrate?.(8);
        }
      }
    },
    [],
  );

  const finish = useCallback(
    (e: TouchEvent | null) => {
      const s = g.current;
      g.current = null;
      const list = live.current.listRef.current;
      if (!s || !list) return;
      const A = live.current;
      const t = e?.changedTouches[0];
      const dx = t ? t.clientX - s.x : 0;
      if (s.mode === 'row' && s.row) {
        const w = s.row.offsetWidth;
        const shift = swipeShift(dx, w);
        const go = e !== null && swipeCommits(shift, s.vx, w);
        const info = s.rowId === 'archive' ? null : A.rowOf(s.rowId ?? '');
        const act = rowActOf(A, s.rowId);
        setBg(null);
        if (!go) return settleRow(s.row, 0, 180);
        if (s.rowId === 'archive') {
          settleRow(s.row, 0, 0);
          A.archiveCollapse?.();
        } else if (info && act) {
          // Строка, что уходит из списка (в архив, удалить), доезжает до края; остальные возвращаются на место (`swipeFolderBack`).
          settleRow(s.row, act === 'archive' || act === 'delete' ? -w : 0, 160);
          // Окно «Удалить чат?» — с подписью контакта (решение владельца 08.10 п.27, `peerName.ts`): беседа уходит с ней в имени.
          runSwipeAction(withPeerLabel(info.dm), act, info.state);
        }
      } else if (s.mode === 'page') {
        const width = list.offsetWidth;
        const dir = e ? pageSettle(dx, s.vx, width, A.pages.has) : 0;
        list.style.willChange = '';
        if (dir === 0) {
          list.style.transition = `transform ${PAGE_ANIM_MS}ms ${CURVE}`;
          list.style.transform = '';
          window.setTimeout(() => (list.style.transition = ''), PAGE_ANIM_MS + 30);
          return;
        }
        // Лента уходит за край, на её месте — соседняя папка, въезжающая с другой стороны.
        list.style.transition = `transform ${PAGE_ANIM_MS}ms ${CURVE}`;
        list.style.transform = `translateX(${-dir * width}px)`;
        window.setTimeout(() => {
          list.style.transition = 'none';
          flushSync(() => A.pages.step(dir));
          list.scrollTop = 0;
          list.style.transform = `translateX(${dir * width}px)`;
          void list.offsetWidth;
          list.style.transition = `transform ${PAGE_ANIM_MS}ms ${CURVE}`;
          list.style.transform = '';
          window.setTimeout(() => (list.style.transition = ''), PAGE_ANIM_MS + 30);
        }, PAGE_ANIM_MS);
      } else if (s.mode === 'pull') {
        list.style.transition = `transform ${PAGE_ANIM_MS}ms ${CURVE}`;
        list.style.transform = '';
        window.setTimeout(() => (list.style.transition = ''), PAGE_ANIM_MS + 30);
        if (s.armed && e) A.archivePull?.();
      }
    },
    [settleRow],
  );

  const overlay: ReactNode = bg ? (
    <div
      ref={bgEl}
      className={`dm-swipe-bg${bg.danger ? ' danger' : ''}${bg.armed ? ' armed' : ''}`}
      style={{ top: bg.top, height: bg.height, width: bg.width } as CSSProperties}
      aria-hidden="true"
    >
      <Icon name={bg.icon} size={22} />
      <span>{bg.label}</span>
    </div>
  ) : null;

  return { bind: { onTouchStart, onTouchMove, onTouchEnd: (e) => finish(e), onTouchCancel: () => finish(null) }, overlay };
}

/**
 * «Свайп по чату» в настройках (G42; Telegram Android — «Настройки → Настройки чатов → Свайп по чату»,
 * `ChatListSwipeGesture`, `SwipeGestureSettingsView`): список вариантов, выбранный — с галочкой. Пока человек не выбирал —
 * «как у Telegram»: «Сменить папку», если папки есть, иначе «В архив». Настройка телефона (на ПК свайпа нет).
 */
export function ChatSwipeSetting() {
  const caps = useSwipeCaps();
  const [setting, setSetting] = useSwipeSetting();
  const now = effectiveSwipe(setting, caps);
  const choices = swipeChoices(caps);
  return (
    <>
      <div className="settings-group-label" id="set-g-swipe" style={{ marginTop: 18 }}>
        Свайп по чату
      </div>
      <div className="close-opt-sub" style={{ marginBottom: 6 }}>
        Что делает свайп влево по беседе в списке.
      </div>
      <div role="group" aria-labelledby="set-g-swipe" style={{ display: 'contents' }}>
        {choices.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={now === c}
            className={`close-opt ${now === c ? 'on' : ''}`}
            onClick={() => setSetting(c)}
          >
            <span className="close-opt-text">
              <span>{SWIPE_CHOICE_LABEL[c]}</span>
              {c === 'folders' && <span className="close-opt-sub">Свайп по списку листает папки, строки не уходят</span>}
            </span>
            {now === c && <Icon name="check" size={16} />}
          </button>
        ))}
      </div>
    </>
  );
}
