// Aliased: React's KeyboardEvent would shadow the DOM one used by the window listener below.
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Modal manners in one place: Esc closes, focus starts inside the dialog and goes back to whatever
 * opened it on close. Attach the returned ref to the dialog box, and give that box `tabIndex={-1}`
 * (so it can take focus) plus `role="dialog" aria-modal="true" aria-labelledby={id of its heading}`.
 *
 * Two details that are easy to get wrong and are handled here:
 *  • The effect runs ONCE, reading the handler through a ref. Wiring it to the `onClose` prop directly
 *    (usually an inline arrow) would re-run it on every parent render and yank focus back to the
 *    dialog box mid-typing — and these dialogs live inside components that re-render on voice events.
 *  • Esc is ignored when something already handled it (`defaultPrevented`). The hotkey/PTT capture in
 *    settings listens in the CAPTURE phase and preventDefault()s Esc to cancel capturing — that must
 *    not close the whole settings modal too.
 */
export function useDialogChrome<T extends HTMLElement = HTMLDivElement>(onClose: () => void) {
  const ref = useRef<T | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, []);

  return ref;
}

/**
 * The tablist keyboard contract: ←/→ (and ↑/↓) walk the tabs, Home/End jump to the ends. Pair it with
 * roving tabindex on the tabs (`tabIndex={active ? 0 : -1}`) so the whole strip is ONE tab stop.
 *
 * `domId` maps a tab key to its element id: the tab we move to only becomes focusable after the
 * re-render, so focus is handed over on the next frame.
 */
export function tabListKeyDown<K extends string>(
  keys: readonly K[],
  current: K,
  pick: (k: K) => void,
  domId: (k: K) => string,
): (e: ReactKeyboardEvent) => void {
  return (e) => {
    const i = keys.indexOf(current);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % keys.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + keys.length) % keys.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = keys.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const k = keys[next];
    pick(k);
    requestAnimationFrame(() => document.getElementById(domId(k))?.focus());
  };
}
