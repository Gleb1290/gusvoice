import { useId, useLayoutEffect, useRef, useState } from 'react';
import { clampAxis, toLayoutRect, viewport } from '../popover';

/** Стартовая ширина для первого кадра — точная берётся замером, см. useLayoutEffect ниже. */
const POP_W = 320;
const GAP = 7;
const EDGE = 8;

/**
 * Small «?» next to a label that reveals an explanation on hover — and on keyboard focus, which is why
 * it's a real <button> and not a styled span: a hover-only hint is invisible to anyone not using a
 * mouse. The popup is `role="tooltip"` and wired to the button through aria-describedby, so a screen
 * reader reads it as the button's description rather than as stray text.
 *
 * The popup is `position: fixed` with coordinates measured on open, NOT an absolutely-positioned child.
 * It has to be: the permissions list lives inside `.role-detail`, which scrolls (`overflow-y: auto`), and
 * an absolute popup would be clipped by it — and clipped exactly for the rows at the bottom of the list,
 * where the explanations matter most. Fixed coordinates also let us keep it inside the viewport instead
 * of hanging off the right edge, and flip it above the dot when there's no room below.
 */
export function HelpDot({ children, label = 'Подсказка' }: { children: React.ReactNode; label?: string }) {
  const id = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  function show() {
    const raw = btnRef.current?.getBoundingClientRect();
    if (!raw) return;
    const r = toLayoutRect(raw); // экранные → вёрсточные, иначе при масштабе ≠ 100% уедет
    // Anchor to the dot's left edge, then clamp so a wide popup near the right edge slides back in.
    const { vw, vh } = viewport();
    const left = clampAxis(r.left - 6, POP_W, vw, EDGE);
    const below = vh - r.bottom;
    setPos(below < 180 ? { left, bottom: vh - r.top + GAP } : { left, top: r.bottom + GAP });
  }

  // Точная ширина известна только после рендера: у `.help-dot-pop` она может ужаться под узкое
  // окно, и тогда клампа по стартовым 320px не хватит — правим по факту.
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!pos || !el) return;
    const { vw } = viewport();
    const left = clampAxis(pos.left, el.offsetWidth, vw, EDGE);
    if (left !== pos.left) setPos({ ...pos, left });
  }, [pos]);

  return (
    <span
      className="help-dot"
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      onFocus={show}
      onBlur={() => setPos(null)}
    >
      <button type="button" ref={btnRef} aria-label={label} aria-describedby={pos ? id : undefined}>
        ?
      </button>
      {pos && (
        <span className="help-dot-pop" id={id} role="tooltip" ref={popRef} style={pos}>
          {children}
        </span>
      )}
    </span>
  );
}
