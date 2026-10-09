import { snapListWidth } from '../dmListView';
import { clampWidth, isNarrowAllowed, setSidebarWidth, SIDEBAR_MAX, SIDEBAR_MIN } from '../uiPrefs';

/**
 * A thin drag handle on the right edge of the channel/DM sidebar (#6). Dragging updates the
 * `--sidebar-w` CSS var live (the `.app` grid column reads it) and persists on release. The 72px
 * offset is the server rail's fixed width. Hidden on mobile (the grid collapses there). In the DM list, dragging below
 * half the minimal column (tdesktop `columnMinimalWidthLeft / 2`) collapses it to avatars only (G34, `dmListView.ts`).
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
    // Полоса папок ЛС (`--dm-strip-w`) — часть колонки, но не списка: ширину списка считаем без неё.
    const strip = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dm-strip-w')) || 0;
    const move = (ev: PointerEvent) => setSidebarWidth(snapListWidth(ev.clientX / zoom - RAIL - strip, isNarrowAllowed(), SIDEBAR_MIN, SIDEBAR_MAX));
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
