/**
 * Persisted settings for the in-game voice overlay (desktop). Lives in the MAIN window's localStorage;
 * the overlay window receives what it needs to render inside each state push (see overlay.ts).
 *
 * Modes (when the overlay is shown):
 *   • 'desktop' — always (on top of everything), whenever the show conditions hold
 *   • 'apps'    — only when a foreground app whose exe is in `apps` is focused (Phase 2 foreground watcher)
 */
export type OverlayMode = 'desktop' | 'apps';
export type OverlayContent = 'list' | 'compact';
export type OverlayCorner = 'tl' | 'tr' | 'bl' | 'br';

export interface OverlaySettings {
  enabled: boolean;
  mode: OverlayMode;
  /** exe basenames (lowercased, e.g. "cs2.exe") the overlay shows over in 'apps' mode. */
  apps: string[];
  content: OverlayContent;
  /** 'corner' anchors to a screen corner; 'custom' uses a dragged absolute position (customX/customY). */
  posMode: 'corner' | 'custom';
  corner: OverlayCorner;
  marginX: number;
  marginY: number;
  customX: number;
  customY: number;
  /** 0.3..1 — CSS opacity of the overlay content. */
  opacity: number;
  /** Only show while I'm actually connected to a voice channel (the common case). */
  onlyInVoice: boolean;
}

export const OVERLAY_DEFAULTS: OverlaySettings = {
  enabled: false,
  mode: 'desktop',
  apps: [],
  content: 'list',
  posMode: 'corner',
  corner: 'tr',
  marginX: 24,
  marginY: 24,
  customX: 40,
  customY: 40,
  opacity: 0.95,
  onlyInVoice: true,
};

const KEY = 'gv_overlay_settings';
type Listener = (s: OverlaySettings) => void;
const listeners = new Set<Listener>();

let cache: OverlaySettings | null = null;

export function getOverlaySettings(): OverlaySettings {
  if (cache) return cache;
  let loaded: OverlaySettings;
  try {
    const raw = localStorage.getItem(KEY);
    loaded = raw ? { ...OVERLAY_DEFAULTS, ...JSON.parse(raw) } : { ...OVERLAY_DEFAULTS };
  } catch {
    loaded = { ...OVERLAY_DEFAULTS };
  }
  cache = loaded;
  return loaded;
}

export function setOverlaySettings(patch: Partial<OverlaySettings>): OverlaySettings {
  const next = { ...getOverlaySettings(), ...patch };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  for (const l of listeners) l(next);
  return next;
}

/** Subscribe to settings changes (the overlay controller re-drives the window on each). */
export function onOverlaySettings(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Flip the overlay on/off — bound to the show/hide hotkey (see VoiceControls). */
export function toggleOverlayEnabled(): void {
  setOverlaySettings({ enabled: !getOverlaySettings().enabled });
}
