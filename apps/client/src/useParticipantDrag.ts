import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';

interface Chip { userId: string; name: string; from: string; x: number; y: number }

export function useParticipantDrag(move: (from: string, userId: string, target: string) => void) {
  const [pdrag, setPdrag] = useState<Chip | null>(null);
  const [pDrop, setPDrop] = useState<string | null>(null);
  const active = useRef<{ chip: Chip; row: Element; pointer: number; dragging: boolean; target: string | null } | null>(null);
  const pClickAfterDrag = useRef(false);

  const clear = useCallback(() => {
    const drag = active.current;
    if (!drag) return;
    active.current = null;
    if (drag.row.hasPointerCapture(drag.pointer)) drag.row.releasePointerCapture(drag.pointer);
    setPdrag(null);
    setPDrop(null);
  }, []);

  // Presence переносит участника в другой список. Со старой строки pointerup уже не придёт.
  useLayoutEffect(() => {
    if (active.current && !active.current.row.isConnected) clear();
  });
  useLayoutEffect(() => {
    window.addEventListener('blur', clear);
    return () => window.removeEventListener('blur', clear);
  }, [clear]);

  function onPpDown(e: PointerEvent, userId: string, name: string, from: string) {
    if (e.altKey || e.button !== 0 || e.pointerType === 'touch' || active.current) return;
    pClickAfterDrag.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
    active.current = { chip: { userId, name, from, x: e.clientX, y: e.clientY }, row: e.currentTarget,
      pointer: e.pointerId, dragging: false, target: null };
  }

  function gesture(e: PointerEvent) {
    const drag = active.current;
    return drag?.pointer === e.pointerId && drag.row === e.currentTarget ? drag : null;
  }

  function onPpMove(e: PointerEvent) {
    const drag = gesture(e);
    if (!drag) return;
    const { chip } = drag;
    if (!drag.dragging && Math.abs(e.clientX - chip.x) + Math.abs(e.clientY - chip.y) < 6) return;
    drag.dragging = true;
    setPdrag({ ...chip, x: e.clientX, y: e.clientY });
    const channel = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-vc]')?.dataset.vc;
    drag.target = channel && channel !== chip.from ? channel : null;
    setPDrop(drag.target);
  }

  function onPpUp(e: PointerEvent) {
    const drag = gesture(e);
    if (!drag) return;
    pClickAfterDrag.current = drag.dragging;
    clear();
    if (drag.dragging && drag.target && drag.row.isConnected) move(drag.chip.from, drag.chip.userId, drag.target);
  }

  function onPpCancel(e: PointerEvent) {
    if (gesture(e)) clear();
  }

  return { pdrag, pDrop, pClickAfterDrag, onPpDown, onPpMove, onPpUp, onPpCancel };
}
