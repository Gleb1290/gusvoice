import { isMobile } from './hotkeys';

/**
 * Per-browser audio/video capture preferences (device selection, browser DSP, push-to-talk).
 * Read by VoiceConnection when it connects so the choices apply to the live LiveKit session.
 */
export interface AudioSettings {
  inputDeviceId: string; // '' = system default
  outputDeviceId: string;
  cameraDeviceId: string;
  noiseSuppression: boolean; // legacy mirror of noiseFilter === 'system' (kept for back-compat)
  /**
   * Noise-suppression engine: off | system (getUserMedia NS) | rnnoise (light in-app WASM filter)
   * | deepfilter (DeepFilterNet3 — stronger/heavier in-app neural denoiser).
   */
  noiseFilter: 'off' | 'system' | 'rnnoise' | 'deepfilter';
  echoCancellation: boolean;
  autoGainControl: boolean;
  pushToTalk: boolean;
  pttKey: string; // KeyboardEvent.code, e.g. 'Space'
  /** Input volume / mic gain applied in the capture chain. 1 = 100%, range 0..2 (up to +6 dB-ish boost). */
  inputGain: number;
  /**
   * Voice-activation noise gate threshold, 0..1 in the same scale as the mic-test meter. 0 = gate
   * off (always transmit). Above 0, audio quieter than the threshold is gated out (not transmitted,
   * speaking ring stays off). Ignored while pushToTalk is on. Auto-disabled at 0.
   */
  vadThreshold: number;
  /** Keep the mic open this many ms after releasing the push-to-talk key (avoids clipped word ends). */
  pttReleaseMs: number;
}

const KEY = 'gv_audio';

// On Android the WebView's built-in getUserMedia noise suppression ('system') over-suppresses on
// some devices (e.g. Samsung) — the mic almost cuts out. Default the mobile build to RNNoise instead
// (in-app WASM filter, confirmed good on-device); desktop keeps the system NS. Only affects fresh
// installs — a stored preference always wins in getAudioSettings().
const MOBILE = isMobile();

const DEFAULTS: AudioSettings = {
  inputDeviceId: '',
  outputDeviceId: '',
  cameraDeviceId: '',
  noiseSuppression: !MOBILE,
  noiseFilter: MOBILE ? 'rnnoise' : 'system',
  echoCancellation: true,
  autoGainControl: true,
  pushToTalk: false,
  pttKey: 'Space',
  inputGain: 1,
  vadThreshold: 0,
  pttReleaseMs: 150,
};

let cache: AudioSettings | null = null;
const listeners = new Set<(s: AudioSettings) => void>();

/** Subscribe to live settings changes (the mic chain reacts without rebuilding). Returns unsub. */
export function subscribeAudioSettings(fn: (s: AudioSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAudioSettings(): AudioSettings {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<AudioSettings>) : {};
    const merged = { ...DEFAULTS, ...parsed };
    // Migrate pre-selector users: a stored noiseSuppression:false becomes the 'off' filter.
    if (raw && parsed.noiseFilter === undefined) {
      merged.noiseFilter = parsed.noiseSuppression === false ? 'off' : 'system';
    }
    cache = merged;
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function setAudioSettings(next: AudioSettings): void {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {
      /* a bad listener must not break settings */
    }
  }
}
