/**
 * Per-device UI layout preferences (localStorage, no account sync): the channel-sidebar width
 * (#6, drag-resizable) and a global interface scale (#8, мелкий/обычный/крупный/огромный). Both are
 * applied to the document on boot (main.tsx → applyUiPrefs) and on change.
 *
 * Scale uses CSS `zoom` on the root — it scales the WHOLE px-based layout (not just text), which is what
 * "увеличение интерфейса" means. zoom is reliable on every target (Chromium: web, Windows WebView2,
 * Android System WebView).
 */
import { useSyncExternalStore } from 'react';
import { effectiveListWidth, LIST_NARROW_W } from './dmListView';
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
/** Заводской масштаб — «обычный». */
export const UI_SCALE_DEFAULT: UiScale = 'md';
const SCALE_ZOOM: Record<UiScale, number> = { sm: 0.9, md: 1, lg: 1.15, xl: 1.3 };

export function getSidebarWidth(): number {
  const v = parseInt(localStorage.getItem(SIDEBAR_KEY) || '', 10);
  if (v === LIST_NARROW_W) return v; // «только аватары» (G34) — отдельное значение вне 180…480
  return Number.isFinite(v) ? clampWidth(v) : SIDEBAR_DEFAULT;
}
export function clampWidth(px: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(px)));
}

/* Узкая колонка «только аватары» (G34) есть только у списка бесед: у каналов сервера колонка всегда обычная. Список бесед при
   показе поднимает `narrowAllowed` (`setNarrowAllowed`), сохранённая ширина при этом не меняется. */
let storedWidth = SIDEBAR_DEFAULT;
let narrowAllowed = false;
const widthSubs = new Set<() => void>();
function shownWidth(): number {
  return effectiveListWidth(storedWidth, narrowAllowed, SIDEBAR_DEFAULT);
}
export function applySidebarWidth(px: number): void {
  storedWidth = px;
  document.documentElement.style.setProperty('--sidebar-w', `${shownWidth()}px`);
  for (const f of widthSubs) f();
}
export function setSidebarWidth(px: number): void {
  const w = px === LIST_NARROW_W ? LIST_NARROW_W : clampWidth(px);
  try {
    localStorage.setItem(SIDEBAR_KEY, String(w));
  } catch {
    /* storage unavailable */
  }
  applySidebarWidth(w);
}
/** Открыт список бесед — «только аватары» разрешены (G34); закрыт — колонка снова обычной ширины. */
export function setNarrowAllowed(on: boolean): void {
  if (narrowAllowed === on) return;
  narrowAllowed = on;
  applySidebarWidth(storedWidth);
}
export function isNarrowAllowed(): boolean {
  return narrowAllowed;
}
/** Колонка списка сейчас в режиме «только аватары». */
export function useSidebarNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      widthSubs.add(cb);
      return () => widthSubs.delete(cb);
    },
    () => narrowAllowed && storedWidth === LIST_NARROW_W,
    () => false,
  );
}

export function getUiScale(): UiScale {
  const v = localStorage.getItem(SCALE_KEY);
  return v === 'sm' || v === 'lg' || v === 'xl' ? v : UI_SCALE_DEFAULT;
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
