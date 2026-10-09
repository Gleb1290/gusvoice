import { useEffect, useRef, type RefObject } from 'react';
import { dragShift, movedIds } from '../dmFolderView';
import {
  DM_ROW_HOLD_MS,
  DM_ROW_HOLD_SLOP,
  PIN_DRAG_START_PX,
  pinDragClamp,
  pinDragScrollStep,
  pinDropIndex,
} from '../dmListRules';
import { useDmFolders } from '../dmFolders';
import { useStore } from '../store';
import { toast } from '../toast';

/**
 * Перестановка закреплённых бесед перетаскиванием (08.10, #211, G02/G42, сервер `pinorder1`) — как у Telegram:
 * - ПК (tdesktop `dialogs_inner_widget.cpp`: `checkReorderPinnedStart`, `updateReorderPinned`, `finishReorderPinned`):
 *   нажать на закреплённой и повести по вертикали дальше `PIN_DRAG_START_PX`; строка идёт за курсором только в пределах
 *   закреплённых, соседние уступают место, у края списка — автопрокрутка, Esc — отмена, отпускание — новый порядок.
 * - Телефон (Android `DialogsActivity`, `ItemTouchHelper` у закреплённых в режиме выбора): удержать `DM_ROW_HOLD_MS` —
 *   беседа выбирается (своя логика строки `DmSidebar`, с вибрацией), повести пальцем дальше — перестановка. Удержание
 *   аватара — меню строки, перетаскивания нет.
 * Слушатели — на самом списке и не из React: строку `DmRow` (memo) не трогаем, тянем стилями прямо в DOM, как свайп
 * строки (`DmListSwipe`), а прокрутку пальцем можно отменить только непассивным `touchmove`.
 */
export function useDmPinDrag(a: {
  listRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  pinnedIds: readonly string[];
  /** Своя папка со своим порядком закреплённых (`pinorder2`); `null` / нет — общий порядок. */
  folderId?: string | null;
  touchOk?: boolean;
}): void {
  const live = useRef(a);
  live.current = a;
  const { listRef, enabled } = a;

  useEffect(() => {
    const list = listRef.current;
    if (!list || !enabled) return;
    type Arm = {
      id: string;
      ids: string[];
      from: number;
      to: number;
      pointer: number;
      touch: boolean;
      x0: number;
      y0: number;
      at: number;
      active: boolean;
      y1: number;
      lastY: number;
      scroll0: number;
      mids: number[];
      rows: HTMLElement[];
      size: number;
      raf: number | null;
    };
    let arm: Arm | null = null;
    let swallow = false;

    const held = (g: Arm) => g.touch && Date.now() - g.at >= DM_ROW_HOLD_MS;

    const paint = (g: Arm) => {
      const along = pinDragClamp(g.mids, g.from, g.lastY - g.y1 + list.scrollTop - g.scroll0);
      g.to = pinDropIndex(g.mids, g.from, g.mids[g.from] + along);
      g.rows.forEach((row, i) => {
        if (i === g.from) {
          row.style.transform = `translateY(${along}px)`;
          return;
        }
        const s = dragShift(i, g.from, g.to);
        row.style.transform = s ? `translateY(${s * g.size}px)` : '';
      });
    };

    const tick = () => {
      const g = arm;
      if (!g || !g.active) return;
      const r = list.getBoundingClientRect();
      const step = pinDragScrollStep(g.lastY, r.top, r.bottom);
      g.raf = null;
      if (!step) return;
      const was = list.scrollTop;
      list.scrollTop = was + step;
      if (list.scrollTop !== was) paint(g);
      g.raf = window.requestAnimationFrame(tick);
    };

    const begin = (g: Arm, y: number) => {
      const rows: HTMLElement[] = [];
      for (const id of g.ids) {
        const row = list.querySelector<HTMLElement>(`[data-swipe-row="${CSS.escape(id)}"]`);
        if (!row) return false;
        rows.push(row);
      }
      const top = list.getBoundingClientRect().top - list.scrollTop;
      const rects = rows.map((r) => r.getBoundingClientRect());
      g.mids = rects.map((r) => r.top - top + r.height / 2);
      g.size = g.mids.length > 1 ? Math.abs(g.from < g.mids.length - 1 ? g.mids[g.from + 1] - g.mids[g.from] : g.mids[g.from] - g.mids[g.from - 1]) : rects[g.from].height;
      g.rows = rows;
      g.active = true;
      // Сдвиг считается от точки нажатия (tdesktop `_dragStart`): строка сразу встаёт под курсор, порог не «съедается».
      g.y1 = g.y0;
      g.lastY = y;
      g.scroll0 = list.scrollTop;
      list.classList.add('pin-drag-on');
      rows.forEach((row, i) => row.classList.add(i === g.from ? 'pin-dragging' : 'pin-yield'));
      return true;
    };

    const end = (commit: boolean) => {
      const g = arm;
      arm = null;
      if (!g) return;
      if (g.raf != null) window.cancelAnimationFrame(g.raf);
      if (!g.active) return;
      list.classList.remove('pin-drag-on');
      for (const row of g.rows) {
        row.classList.remove('pin-dragging', 'pin-yield');
        row.style.transform = '';
      }
      // Отпускание после перестановки — не щелчок по строке (иначе откроется беседа или переключится выбор).
      swallow = true;
      window.setTimeout(() => (swallow = false), 80);
      const ids = commit ? movedIds(g.ids, g.from, g.to, 0) : null;
      if (ids) reorderDmPins(ids, live.current.folderId ?? null);
    };

    const onDown = (e: PointerEvent) => {
      if (arm) end(false);
      const touch = e.pointerType !== 'mouse';
      if (!touch && e.button !== 0) return;
      /* Касание в широкой раскладке (сенсорный ПК, планшет): удержание там открывает меню строки, выбора нет — перестановки
         под открытым меню не нужны (ревью 09.10). Палец ведёт строку только там, где удержание даёт выбор (телефон). */
      if (touch && live.current.touchOk === false) return;
      const target = e.target as Element | null;
      const row = target?.closest?.<HTMLElement>('[data-swipe-row]');
      if (!row || !list.contains(row)) return;
      if (touch && target?.closest?.('.dm-ava')) return;
      const id = row.dataset.swipeRow ?? '';
      const ids = [...live.current.pinnedIds];
      const from = ids.indexOf(id);
      if (from < 0 || ids.length < 2) return;
      arm = {
        id, ids, from, to: from, pointer: e.pointerId, touch, x0: e.clientX, y0: e.clientY, at: Date.now(),
        active: false, y1: e.clientY, lastY: e.clientY, scroll0: 0, mids: [], rows: [], size: 0, raf: null,
      };
    };

    const onMove = (e: PointerEvent) => {
      const g = arm;
      if (!g || g.pointer !== e.pointerId) return;
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (!g.active) {
        if (g.touch) {
          if (!held(g)) {
            // Палец поехал до удержания — прокрутка списка, не перестановка.
            if (Math.abs(dx) > DM_ROW_HOLD_SLOP || Math.abs(dy) > DM_ROW_HOLD_SLOP) arm = null;
            return;
          }
          if (Math.abs(dy) < 4) return;
        } else if (Math.abs(dy) < PIN_DRAG_START_PX) return;
        if (!begin(g, e.clientY)) {
          arm = null;
          return;
        }
        try {
          list.setPointerCapture(e.pointerId);
        } catch {
          /* указатель уже отпущен */
        }
      }
      g.lastY = e.clientY;
      paint(g);
      if (g.raf == null) g.raf = window.requestAnimationFrame(tick);
    };

    const onUp = (e: PointerEvent) => {
      if (arm && arm.pointer === e.pointerId) end(true);
    };
    const onCancel = () => end(false);

    // Вести палец, не листая список, можно только отменив прокрутку ДО её начала — непассивный слушатель.
    const onTouchMove = (e: TouchEvent) => {
      const g = arm;
      if (!g?.touch || !(g.active || held(g))) return;
      if (e.cancelable) e.preventDefault();
      if (g.active) e.stopPropagation();
    };
    const onTouchEnd = (e: TouchEvent) => {
      if ((swallow || arm?.active) && e.cancelable) e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      if (!swallow) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && arm?.active) {
        e.preventDefault();
        e.stopPropagation();
        end(false);
      }
    };
    const onScroll = () => {
      if (arm?.active) paint(arm);
    };
    const onBlur = () => end(false);

    list.addEventListener('pointerdown', onDown);
    list.addEventListener('pointermove', onMove);
    list.addEventListener('pointerup', onUp);
    list.addEventListener('pointercancel', onCancel);
    list.addEventListener('touchmove', onTouchMove, { passive: false });
    list.addEventListener('touchend', onTouchEnd);
    list.addEventListener('click', onClick, true);
    list.addEventListener('scroll', onScroll);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      end(false);
      list.removeEventListener('pointerdown', onDown);
      list.removeEventListener('pointermove', onMove);
      list.removeEventListener('pointerup', onUp);
      list.removeEventListener('pointercancel', onCancel);
      list.removeEventListener('touchmove', onTouchMove);
      list.removeEventListener('touchend', onTouchEnd);
      list.removeEventListener('click', onClick, true);
      list.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [listRef, enabled]);
}

/**
 * Новый порядок закреплённых (перетаскивание, «Поднять выше» / «Опустить ниже»): сразу у себя, затем сервер; отказ
 * откатывает порядок и показывает тост.
 */
export function reorderDmPins(ids: string[], folderId: string | null = null): void {
  // Своя папка (09.10, `pinorder2`): порядок — у папки (`DmFolder.pinned`), общий порядок и другие папки не трогаются.
  const job = folderId ? useDmFolders.getState().reorderPins(folderId, ids) : useStore.getState().reorderConvPins(ids);
  job.catch(() => toast('error', 'Не удалось изменить порядок закреплённых бесед'));
}
