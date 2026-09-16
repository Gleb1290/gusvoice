/**
 * Per-device UI layout preferences (localStorage, no account sync): the channel-sidebar width
 * (#6, drag-resizable) and a global interface scale (#8, мелкий/обычный/крупный/огромный). Both are
 * applied to the document on boot (main.tsx → applyUiPrefs) and on change.
 *
 * Scale uses CSS `zoom` on the root — it scales the WHOLE px-based layout (not just text), which is what
 * "увеличение интерфейса" means. zoom is reliable on every target (Chromium: web, Windows WebView2,
 * Android System WebView).
 */
import { installViewportVars, refreshViewportVars } from './popover';

const SIDEBAR_KEY = 'gv_sidebar_w';
const SCALE_KEY = 'gv_ui_scale';

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 240;

export type UiScale = 'sm' | 'md' | 'lg' | 'xl';
export const UI_SCALES: { key: UiScale; label: string }[] = [
  { key: 'sm', label: 'Мелкий' },
  { key: 'md', label: 'Обычный' },
  { key: 'lg', label: 'Крупный' },
  { key: 'xl', label: 'Огромный' },
];
const SCALE_ZOOM: Record<UiScale, number> = { sm: 0.9, md: 1, lg: 1.15, xl: 1.3 };

export function getSidebarWidth(): number {
  const v = parseInt(localStorage.getItem(SIDEBAR_KEY) || '', 10);
  return Number.isFinite(v) ? clampWidth(v) : SIDEBAR_DEFAULT;
}
export function clampWidth(px: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(px)));
}
export function applySidebarWidth(px: number): void {
  document.documentElement.style.setProperty('--sidebar-w', `${px}px`);
}
export function setSidebarWidth(px: number): void {
  const w = clampWidth(px);
  try {
    localStorage.setItem(SIDEBAR_KEY, String(w));
  } catch {
    /* storage unavailable */
  }
  applySidebarWidth(w);
}

export function getUiScale(): UiScale {
  const v = localStorage.getItem(SCALE_KEY);
  return v === 'sm' || v === 'lg' || v === 'xl' ? v : 'md';
}
export function applyUiScale(scale: UiScale): void {
  (document.documentElement.style as unknown as { zoom: string }).zoom = String(SCALE_ZOOM[scale]);
  // zoom меняет соотношение вёрсточных и экранных единиц → переопубликовать --vw-px/--vh-px,
  // иначе всплывающие слои останутся с потолками, посчитанными для прошлого масштаба.
  refreshViewportVars();
}
export function setUiScale(scale: UiScale): void {
  try {
    localStorage.setItem(SCALE_KEY, scale);
  } catch {
    /* storage unavailable */
  }
  applyUiScale(scale);
}

/** Apply all persisted UI prefs to the document — called once on boot. */
export function applyUiPrefs(): void {
  applySidebarWidth(getSidebarWidth());
  applyUiScale(getUiScale());
  // Держит --vw-px/--vh-px в актуальном состоянии при ресайзе окна и появлении клавиатуры.
  installViewportVars();
}
