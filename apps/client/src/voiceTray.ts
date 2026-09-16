/**
 * Desktop-only: mirror the user's live voice state onto the system-tray icon + tooltip.
 *
 * Derives one of idle / silent / speaking / muted / deafened from the store and pushes it to the Rust
 * `gv_tray_set_state` command (src-tauri/src/lib.rs) whenever it flips:
 *   • idle     — not in a voice channel        → default GusVoice logo
 *   • silent   — mic live, not transmitting     → grey bubble
 *   • speaking — mic transmitting               → green bubble (the SAME local-VAD signal that lights
 *                                                 the avatar speaking ring, store.liveVoice[myId].speaking)
 *   • muted    — mic off                        → crossed-out microphone (red)
 *   • deafened — sound off                      → crossed-out headphones (red)
 *
 * Bursts (speaking flips) are coalesced: the first change applies instantly, then a short cooldown
 * collapses rapid follow-ups so we never hammer the Windows tray API. No-op on web (no Tauri core).
 */
import { useStore } from './store';

type TrayState = 'idle' | 'silent' | 'speaking' | 'muted' | 'deafened';

type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
function tauriCore(): TauriCore | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
}

function derive(): TrayState {
  const s = useStore.getState();
  if (!s.voice) return 'idle';
  if (s.selfDeafened) return 'deafened';
  if (s.selfMuted) return 'muted';
  const me = s.user?.id;
  const speaking = me ? (s.liveVoice[me]?.speaking ?? false) : false;
  return speaking ? 'speaking' : 'silent';
}

let started = false;

/** Wire the tray mirror once. Safe to call on every platform — bails out on web (no Tauri core). */
export function initVoiceTray(): void {
  if (started) return;
  const core = tauriCore();
  if (!core) return; // web build — no system tray
  started = true;

  let current: TrayState | null = null;
  let cooldown = false;
  let dirty = false;

  const push = (next: TrayState) => {
    if (next === current) return;
    current = next;
    core.invoke('gv_tray_set_state', { state: next }).catch(() => {});
  };

  const flush = () => {
    if (cooldown) {
      dirty = true;
      return;
    }
    push(derive());
    cooldown = true;
    setTimeout(() => {
      cooldown = false;
      if (dirty) {
        dirty = false;
        flush();
      }
    }, 120);
  };

  useStore.subscribe(flush);
  flush(); // seed the initial state
}
