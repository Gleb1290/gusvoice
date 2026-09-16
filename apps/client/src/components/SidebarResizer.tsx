import { clampWidth, setSidebarWidth } from '../uiPrefs';

/**
 * A thin drag handle on the right edge of the channel/DM sidebar (#6). Dragging updates the
 * `--sidebar-w` CSS var live (the `.app` grid column reads it) and persists on release. The 72px
 * offset is the server rail's fixed width. Hidden on mobile (the grid collapses there).
 */
export function SidebarResizer() {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const RAIL = 72;
    // The interface-scale pref (#8) applies `zoom` to <html>, which scales the client-coordinate space:
    // a pointer over the CSS seam at (72 + width) reports clientX = (72 + width) * zoom. Divide it back
    // out, else any scale ≠ 100% snaps the sidebar by the zoom factor the instant you grab the handle —
    // which read as "the sidebar won't resize" (#100).
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const move = (ev: PointerEvent) => setSidebarWidth(ev.clientX / zoom - RAIL);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-sidebar');
    };
    document.body.classList.add('resizing-sidebar');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // Double-click resets to the default width.
  const onDoubleClick = () => setSidebarWidth(clampWidth(240));
  return (
    <div
      className="sidebar-resizer"
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      title="Перетащите, чтобы изменить ширину · двойной клик — сброс"
    />
  );
}
