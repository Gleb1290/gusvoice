/**
 * In-app keyboard shortcuts for voice actions (mute / deafen / screen-share). Stored per
 * browser in localStorage; bound from the audio settings tab and listened for by VoiceControls
 * while in voice. These fire only while the GusVoice tab is focused — truly global hotkeys
 * (working from inside a game) need the native desktop shell (Tauri, #16).
 *
 * A binding is a normalized combo string: optional modifiers in a fixed order followed by the
 * physical KeyboardEvent.code, joined by '+'. Examples: "KeyM", "Alt+KeyM", "Ctrl+Shift+KeyD".
 * Empty string = unbound. Using `code` (not `key`) keeps bindings layout-stable.
 */
export interface Hotkeys {
  mute: string;
  deafen: string;
  screenShare: string;
  /** Desktop-only: show/hide the in-game overlay (toggles overlaySettings.enabled). */
  overlayToggle: string;
  /**
   * Отметить «вот сейчас сломалось» в отчёте диагностики показа (#100).
   *
   * 🔴 Единственный хоткей с НЕПУСТЫМ значением по умолчанию, и это намеренно. Ловим баг, при котором
   * у человека отказывает Alt+Tab: до окна приложения он в этот момент добраться не может — в том и
   * состоит баг, — поэтому кнопка в интерфейсе бесполезна. Первая версия была именно кнопкой, и за
   * сутки её не нажал ни один из четверых приславших отчёты. Хоткей ловится низкоуровневым хуком поверх
   * игры и клавишу НЕ отбирает, так что дефолт никому ничего не ломает.
   */
  diagMark: string;
}

const KEY = 'gv_hotkeys';

const DEFAULTS: Hotkeys = {
  mute: '',
  deafen: '',
  screenShare: '',
  overlayToggle: '',
  // Ctrl+Shift+F12 — заведомо свободная комбинация: одиночный F12 занят оверлеем Steam и снимками
  // экрана, а с двумя модификаторами её не занимает почти никто. Хук клавишу не поглощает, так что
  // даже занятая она продолжит работать в своей программе.
  diagMark: 'Ctrl+Shift+F12',
};

let cache: Hotkeys | null = null;

export function getHotkeys(): Hotkeys {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Hotkeys>) } : { ...DEFAULTS };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to binding changes (so the desktop shell can re-register global shortcuts live). */
export function subscribeHotkeys(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setHotkeys(next: Hotkeys): void {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  for (const l of [...listeners]) l();
}

/** True inside ANY Tauri shell (desktop OR mobile) — the WebView has the Tauri IPC bridge injected. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * True on the Android/iOS Tauri build. Detected by the WebView user-agent INSIDE a Tauri shell —
 * deliberately conservative so it can only ever be true in the native mobile app: a phone browser
 * has no Tauri bridge (isTauri false), and the Windows desktop WebView2 UA contains no
 * "Android"/"iPhone". So web and desktop behaviour is provably unchanged by this split.
 */
export function isMobile(): boolean {
  return isTauri() && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

/** True specifically on the Android Tauri build. */
export function isAndroid(): boolean {
  return isMobile() && /Android/i.test(navigator.userAgent || '');
}

/**
 * True inside the Tauri DESKTOP shell (Windows/macOS/Linux): Tauri bridge present AND not mobile.
 * All desktop-only features (global hotkeys, updater, native screen-share/stream-audio, tray,
 * close-to-tray) gate on this, so they are automatically skipped on the Android build.
 */
export function isDesktop(): boolean {
  return isTauri() && !isMobile();
}

const MODIFIER_CODE = /^(Control|Shift|Alt|Meta)(Left|Right)$/;

/** Build a combo string from a keydown, or null if it's a bare modifier press (keep waiting). */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_CODE.test(e.code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(e.code);
  return parts.join('+');
}

/** True if the event exactly matches the combo (same key AND same modifier set). */
export function matchCombo(e: KeyboardEvent, combo: string): boolean {
  return !!combo && comboFromEvent(e) === combo;
}

/**
 * Build a combo string from a mouse button press, or null for the left button (button 0 — that's
 * normal UI interaction and how a capture is opened). Mouse combos are bare "Mouse<button>" (no
 * modifiers) to match the push-to-talk format and keep the native global hook simple.
 */
export function comboFromMouse(e: MouseEvent): string | null {
  if (e.button === 0) return null;
  return `Mouse${e.button}`;
}

/** True if the event matches a mouse combo (same button). */
export function matchMouseCombo(e: MouseEvent, combo: string): boolean {
  return !!combo && comboFromMouse(e) === combo;
}

/** True if this binding is a mouse button (vs a keyboard key). */
export function isMouseCombo(combo: string): boolean {
  return (combo.split('+').pop() ?? '').startsWith('Mouse');
}

/** The DOM MouseEvent.button index a mouse combo is bound to, or null if it isn't a mouse combo. */
export function mouseButtonOf(combo: string): number | null {
  const last = combo.split('+').pop() ?? '';
  if (!last.startsWith('Mouse')) return null;
  const n = parseInt(last.slice(5), 10);
  return Number.isNaN(n) ? null : n;
}

// --- Desktop native keyboard hook: pack a combo into a Windows virtual-key the Rust hook matches. ---
// The native low-level keyboard hook (src-tauri/src/hotkey_key.rs) OBSERVES keys without swallowing
// them (unlike RegisterHotKey / the global-shortcut plugin, which stole the key from every app). It
// speaks Windows virtual-key codes + a modifier bitmask, so we translate our `KeyboardEvent.code`
// combos here and hand the hook a packed `(mods << 16) | vk` per binding.
const MOD_BITS: Record<string, number> = { Ctrl: 1, Alt: 2, Shift: 4, Meta: 8 };

// KeyboardEvent.code → Windows virtual-key code, for keys a voice hotkey realistically uses. Letters,
// digits, numpad digits and F-keys are computed below; this covers the named/punctuation ones.
const CODE_TO_VK: Record<string, number> = {
  Space: 0x20, Enter: 0x0d, NumpadEnter: 0x0d, Tab: 0x09, Escape: 0x1b, Backspace: 0x08,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Insert: 0x2d, Delete: 0x2e,
  NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadMultiply: 0x6a, NumpadDivide: 0x6f, NumpadDecimal: 0x6e,
  Minus: 0xbd, Equal: 0xbb, BracketLeft: 0xdb, BracketRight: 0xdd, Backslash: 0xdc,
  Semicolon: 0xba, Quote: 0xde, Comma: 0xbc, Period: 0xbe, Slash: 0xbf, Backquote: 0xc0,
};

/** KeyboardEvent.code → Windows virtual-key code, or null if we don't map it. */
function codeToVk(code: string): number | null {
  if (code in CODE_TO_VK) return CODE_TO_VK[code];
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3); // "KeyM" → 'M' = 0x4D
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5); // "Digit5" → '5' = 0x35
  if (/^Numpad[0-9]$/.test(code)) return 0x60 + (code.charCodeAt(6) - 48); // Numpad0..9 → VK_NUMPAD0..9
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code); // F1..F24 → VK_F1.. (0x70+)
  if (fn) return 0x70 + (parseInt(fn[1], 10) - 1);
  return null;
}

/**
 * The Windows virtual-key for a PTT keyboard binding — a BARE `KeyboardEvent.code` (no modifiers; PTT
 * is a single held key). Null for a mouse binding, empty, or an unmapped key (native PTT then off, the
 * focused window path still covers it). Feeds the native keyboard PTT hook (gv_ptt_set_key).
 */
export function pttKeyVk(pttKey: string): number | null {
  if (!pttKey || pttKey.startsWith('Mouse')) return null;
  return codeToVk(pttKey);
}

/**
 * Pack a keyboard combo ("Alt+KeyM", "NumpadAdd") into `(mods << 16) | vk` for the native desktop
 * keyboard hook. Returns null for mouse combos, empty bindings, or keys we don't map (the caller then
 * simply doesn't register that binding natively).
 */
export function comboToKeyPacked(combo: string): number | null {
  if (!combo || isMouseCombo(combo)) return null;
  const parts = combo.split('+');
  const vk = codeToVk(parts.pop() ?? '');
  if (vk == null) return null;
  let mods = 0;
  for (const p of parts) mods |= MOD_BITS[p] ?? 0;
  return (mods << 16) | vk;
}

const ARROWS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
// Mouse buttons (MouseEvent.button): 0 left, 1 middle, 2 right, 3 back/X1, 4 forward/X2.
const MOUSE_LABELS: Record<string, string> = {
  Mouse0: 'ЛКМ',
  Mouse1: 'СКМ',
  Mouse2: 'ПКМ',
  Mouse3: 'Боковая 1',
  Mouse4: 'Боковая 2',
};

function keyLabel(code: string): string {
  if (code === 'Space') return 'Пробел';
  if (code.startsWith('Mouse')) return MOUSE_LABELS[code] ?? `Мышь ${code.slice(5)}`;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return ARROWS[code] ?? code;
}

/** Human-readable combo for the UI, e.g. "Alt + M". Empty combo → "Не задано". */
export function formatCombo(combo: string): string {
  if (!combo) return 'Не задано';
  return combo
    .split('+')
    .map((p) => (p === 'Ctrl' || p === 'Alt' || p === 'Shift' || p === 'Meta' ? p : keyLabel(p)))
    .join(' + ');
}
