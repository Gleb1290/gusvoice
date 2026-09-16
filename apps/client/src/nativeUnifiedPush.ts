import { api, getToken } from './api';
import { config } from './config';
import { isAndroid } from './hotkeys';
import { subscribeToServer } from './sockets';
import { useStore } from './store';

/**
 * UnifiedPush registration bridge (Android). The native shell (MainActivity `GusVoiceNative`) drives
 * the ntfy distributor; here we kick registration off, read back the endpoint it assigns, and register
 * that endpoint with the GusVoice backend (with the user's auth token) so pushes for DMs / @mentions
 * wake this device even when the app process is dead. No-op on web/desktop and on older APKs that lack
 * the push bridge methods. See UnifiedPushReceiver.kt + backend push.ts.
 */
interface GusVoicePushBridge {
  registerForPush(): void;
  getPushEndpoint(): string;
  hasPushDistributor(): boolean;
  unregisterPush(): void;
  /** #118: returns "dm:<id>" / "ch:<serverId>:<channelId>" from a notification tap, then clears it. */
  consumePendingDeepLink?(): string;
  /**
   * Embedded distributor (multi-instance builds): start our OWN foreground socket to the instance's
   * ntfy (address from /config.json discovery) and return the endpoint URL to register with the
   * backend. No separate ntfy app needed. Absent on older APKs → we fall back to the external path.
   */
  enableEmbeddedPush?(ntfyBase: string): string;
  disableEmbeddedPush?(): void;
  embeddedPushEndpoint?(): string;
}

function bridge(): GusVoicePushBridge | null {
  if (!isAndroid()) return null;
  const b = (window as unknown as { GusVoiceNative?: Partial<GusVoicePushBridge> }).GusVoiceNative;
  // The same object carries the #89 voice methods; guard on a push method so an older installed APK
  // (voice-bridge only) is treated as "no push".
  return b && typeof b.registerForPush === 'function' ? (b as GusVoicePushBridge) : null;
}

const DEVICE_KEY = 'gv_push_device_id';
function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `and-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

let inFlight = false;
let registered = false;

/**
 * Kick off registration and, once the distributor hands back an endpoint (async round-trip), register
 * it with the backend. Idempotent: guarded so rapid calls don't stack, and the backend upserts per
 * (user, device). Requires an auth token — safe to call before login (no-ops until one exists).
 */
export function startPushRegistration(): void {
  const b = bridge();
  if (!b || registered || inFlight || !getToken()) return;

  // Preferred: EMBEDDED distributor (no second app). Needs the instance's ntfy address from discovery
  // (config.pushGateway). enableEmbeddedPush starts our foreground socket and returns the endpoint
  // synchronously — no polling needed. Absent on older APKs → fall through to the external path below.
  if (typeof b.enableEmbeddedPush === 'function' && config.pushGateway) {
    inFlight = true;
    let endpoint = '';
    try {
      endpoint = b.enableEmbeddedPush(config.pushGateway);
    } catch (e) {
      console.warn('[push] enableEmbeddedPush failed', e);
    }
    inFlight = false;
    if (endpoint && getToken()) {
      registered = true;
      void api.registerPush(endpoint, deviceId()).catch((e) => {
        registered = false; // let a later foreground/boot retry
        console.warn('[push] backend register failed', e);
      });
    }
    return;
  }

  // Fallback: EXTERNAL UnifiedPush distributor (a separate ntfy app).
  inFlight = true;
  try {
    b.registerForPush();
  } catch (e) {
    console.warn('[push] registerForPush failed', e);
  }
  // The endpoint arrives asynchronously (distributor round-trip); poll the native prefs a few times.
  let tries = 0;
  const iv = window.setInterval(() => {
    tries += 1;
    let endpoint = '';
    try {
      endpoint = b.getPushEndpoint();
    } catch {
      /* ignore */
    }
    if (endpoint && getToken()) {
      window.clearInterval(iv);
      inFlight = false;
      registered = true;
      void api.registerPush(endpoint, deviceId()).catch((e) => {
        registered = false; // let a later foreground/boot retry
        console.warn('[push] backend register failed', e);
      });
    } else if (tries >= 20) {
      window.clearInterval(iv); // give up until next foreground/boot — the endpoint is stable once set
      inFlight = false;
    }
  }, 1000);
}

/** Unregister this device from push (on logout) so a previous account stops waking this phone. */
export function stopPushRegistration(): void {
  registered = false;
  inFlight = false;
  const b = bridge();
  if (!b) return;
  // Tell the backend first (we still hold the token), then drop the distributor registration.
  void api.unregisterPush(deviceId()).catch(() => {});
  try {
    b.unregisterPush();
  } catch {
    /* ignore */
  }
  // Embedded distributor (multi-instance builds): stop our foreground socket too.
  try {
    b.disableEmbeddedPush?.();
  } catch {
    /* ignore */
  }
}

/** True if a UnifiedPush distributor (the ntfy app) is installed — used by the settings guide (P4). */
export function hasPushDistributor(): boolean {
  try {
    return bridge()?.hasPushDistributor() ?? false;
  } catch {
    return false;
  }
}

let navigating = false;

/** Navigate to a deep-link target from a notification tap: "dm:<id>" or "ch:<serverId>:<channelId>". */
async function navigateDeepLink(link: string): Promise<void> {
  const s = useStore.getState();
  if (link.startsWith('dm:')) {
    const dmId = link.slice(3);
    if (!dmId) return;
    // MainLayout renders the DM from the `dms` list — make sure the conversation is present first.
    await s.loadDms();
    await s.selectDm(dmId);
  } else if (link.startsWith('ch:')) {
    const rest = link.slice(3);
    const sep = rest.indexOf(':');
    const serverId = sep >= 0 ? rest.slice(0, sep) : '';
    const channelId = sep >= 0 ? rest.slice(sep + 1) : rest;
    if (!channelId) return;
    if (serverId && s.currentServerId !== serverId) {
      await s.openServer(serverId);
      subscribeToServer(serverId);
    }
    s.setView('server');
    await s.openChannel(channelId);
  }
}

/**
 * Consume a pending deep-link from a notification tap (if any) and navigate to it. Called on boot
 * (once authed) and on every foreground. No-op on web/desktop, when signed out, or when there's
 * nothing pending. Errors (e.g. a stale/inaccessible target) are swallowed — a failed jump must never
 * break resume.
 */
export function consumeDeepLink(): void {
  const b = bridge();
  if (!b || navigating || !getToken() || typeof b.consumePendingDeepLink !== 'function') return;
  let link = '';
  try {
    link = b.consumePendingDeepLink();
  } catch {
    /* older APK without the method */
  }
  if (!link) return;
  navigating = true;
  void navigateDeepLink(link)
    .catch((e) => console.warn('[push] deep-link navigation failed', e))
    .finally(() => {
      navigating = false;
    });
}

/** Run registration at boot (if already logged in) and whenever the app returns to the foreground. */
export function initPushRegistration(): void {
  if (!isAndroid()) return;
  startPushRegistration();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      startPushRegistration();
      // A notification tap that resumed us (singleTask → onNewIntent) leaves a pending deep-link.
      consumeDeepLink();
    }
  });
}
