import { useEffect, useRef, useState } from 'react';
import { REORDER_HOLD_MS, REORDER_SLOP_PX } from '../photoEditRules';

/**
 * Перестановка плиток удержанием и перетаскиванием (08.10, #211, G49; Telegram Desktop `attach_album_preview.cpp`: плитка
 * «вынимается» и идёт за указателем, при отпускании встаёт на место под ним). Палец: удержание `REORDER_HOLD_MS` без сдвига,
 * потом тянуть (сдвиг раньше — это прокрутка полосы, жест отдаётся браузеру). Мышь: тянуть сразу, с первым сдвигом больше
 * `REORDER_SLOP_PX` — клик без движения остаётся кликом. Место под указателем — по `data-reorder-i` у плитки.
 */
export function useHoldReorder(count: number, onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<{ from: number; over: number; dx: number; dy: number } | null>(null);
  const st = useRef<{
    i: number;
    id: number;
    x: number;
    y: number;
    touch: boolean;
    live: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    el: HTMLElement;
  } | null>(null);
  const moved = useRef(false);
  const overRef = useRef(-1);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  // Пока плитка в руке, прокрутку полосы пальцем гасим (слушатель не пассивный — иначе `preventDefault` не действует).
  useEffect(() => {
    const block = (e: TouchEvent) => {
      if (st.current?.live) e.preventDefault();
    };
    document.addEventListener('touchmove', block, { passive: false });
    return () => document.removeEventListener('touchmove', block);
  }, []);

  const clear = () => {
    const s = st.current;
    if (s?.timer) clearTimeout(s.timer);
    st.current = null;
    setDrag(null);
  };

  const go = (s: NonNullable<typeof st.current>) => {
    s.live = true;
    moved.current = true;
    try {
      s.el.setPointerCapture(s.id);
    } catch {
      /* указатель уже отпущен */
    }
    overRef.current = s.i;
    if (s.touch) navigator.vibrate?.(10);
    setDrag({ from: s.i, over: s.i, dx: 0, dy: 0 });
  };

  const bind = (i: number) => ({
    'data-reorder-i': i,
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (count < 2 || (e.pointerType === 'mouse' && e.button !== 0)) return;
      // Крестик и «⋯» на плитке (`data-no-reorder`) — кнопки, а не ручка: с них не тащим.
      if ((e.target as HTMLElement).closest('[data-no-reorder]')) return;
      moved.current = false;
      const touch = e.pointerType !== 'mouse';
      const s = { i, id: e.pointerId, x: e.clientX, y: e.clientY, touch, live: false, timer: null as ReturnType<typeof setTimeout> | null, el: e.currentTarget };
      st.current = s;
      if (touch) s.timer = setTimeout(() => st.current === s && go(s), REORDER_HOLD_MS);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const s = st.current;
      if (!s || s.id !== e.pointerId) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (!s.live) {
        if (Math.hypot(dx, dy) <= REORDER_SLOP_PX) return;
        if (s.touch) return clear();
        go(s);
      }
      // Под пальцем — сама плитка в руке; место ищем под ней.
      const hit = document
        .elementsFromPoint(e.clientX, e.clientY)
        .map((el) => el.closest<HTMLElement>('[data-reorder-i]'))
        .find((el) => el && el !== s.el);
      const over = hit ? Number(hit.dataset.reorderI) : s.i;
      overRef.current = Number.isFinite(over) ? over : s.i;
      setDrag({ from: s.i, over: overRef.current, dx, dy });
    },
    onPointerUp: () => {
      const s = st.current;
      const to = overRef.current;
      clear();
      if (s?.live && to !== s.i) onMoveRef.current(s.i, to);
    },
    onPointerCancel: clear,
    onContextMenu: (e: React.MouseEvent) => {
      // Долгое нажатие пальцем — не системное меню картинки, а перестановка.
      if (st.current?.touch) e.preventDefault();
    },
    onClickCapture: (e: React.MouseEvent) => {
      // Отпустили после перетаскивания — это не нажатие по плитке.
      if (moved.current) {
        e.preventDefault();
        e.stopPropagation();
        moved.current = false;
      }
    },
  });

  return { drag, bind };
}
