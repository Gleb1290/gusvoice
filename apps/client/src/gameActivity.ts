// Local game-activity reporter (issue #40 Phase 1A — DESKTOP, no Steam login). Polls the running apps
// natively (apps_enum via listOverlayApps), matches them against the curated games.json catalog
// (gameDetect), and reports "playing X" to the backend, which broadcasts it into everyone's presence.
//
// Desktop-only (web/mobile can't see OS processes). Gated by the user's server-side master switch
// `showGameActivity` (shared with the Steam source, toggled in settings). The backend TTLs each report,
// so an ACTIVE game is re-sent every cycle (heartbeat) and a single `null` is sent once when it stops.
import { api } from './api';
import { matchRunningGame } from './gameDetect';
import { isDesktop } from './hotkeys';
import { listOverlayApps } from './overlay';
import { useStore } from './store';

// Re-report cadence — comfortably under the backend's 90s activity TTL so a running game stays "live".
const POLL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
// Whether the backend currently holds an activity FROM US (so we send `null` exactly once on stop).
let reported = false;

/** Whether this device should broadcast game activity: desktop build + the user's master switch on. */
export function gameActivityEnabled(): boolean {
  return isDesktop() && (useStore.getState().user?.showGameActivity ?? true);
}

async function tick(): Promise<void> {
  if (!gameActivityEnabled()) return;
  let exes: string[];
  try {
    exes = (await listOverlayApps()).map((a) => a.exe);
  } catch {
    return; // enumeration failed this cycle — leave state; the TTL covers a prolonged silence
  }
  const game = matchRunningGame(exes);
  if (game) {
    // Re-send every cycle: refreshes the backend TTL (heartbeat); it only re-broadcasts on a change.
    await api.setActivity({ name: game.name, appId: game.appId }).then(() => (reported = true)).catch(() => {});
  } else if (reported) {
    await api.setActivity(null).then(() => (reported = false)).catch(() => {});
  }
}

/** Start the desktop game-activity reporter (idempotent). No-op on web/mobile or when disabled. */
export function startGameActivity(): void {
  if (!gameActivityEnabled() || timer) return;
  void tick();
  timer = setInterval(() => void tick(), POLL_MS);
}

/** Stop reporting (logout / opt-out). The backend TTL clears any lingering server-side state. */
export function stopGameActivity(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Start or stop to match the current enabled state — call on auth change and after toggling the switch. */
export function syncGameActivity(): void {
  if (gameActivityEnabled()) startGameActivity();
  else stopGameActivity();
}
