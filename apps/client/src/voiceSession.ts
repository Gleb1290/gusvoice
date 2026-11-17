/**
 * Voice-session persistence for reconnect-grace + restore-on-restart (#11).
 * Startup admits a fresh snapshot before any async work; splash may extend only that snapshot.
 * Live reconnect uses its own wider window. A deliberate leave clears the saved session.
 */
import { activeInstanceId } from './config';

// Voice may belong to a different instance than the one currently on screen.
function key(instanceId: string | null | undefined): string {
  return `gv_voice_session:${instanceId ?? 'default'}`;
}
export const GRACE_MS = 12_000;

export type VoiceSession = { serverId: string; channelId: string; ts: number; schema?: 1 };

// Also distinguish clear/save of the same channel at the same millisecond within this process.
const generations = new Map<string, number>();
function invalidate(instanceId: string | null): void {
  const k = key(instanceId);
  generations.set(k, (generations.get(k) ?? 0) + 1);
}

function parseSession(raw: string | null): VoiceSession | null {
  try {
    const v = JSON.parse(raw || 'null');
    return v && typeof v.serverId === 'string' && typeof v.channelId === 'string' ? (v as VoiceSession) : null;
  } catch {
    return null;
  }
}

function loadRaw(instanceId: string | null | undefined = activeInstanceId()): VoiceSession | null {
  try {
    return parseSession(localStorage.getItem(key(instanceId)));
  } catch {
    return null;
  }
}

function fresh(s: VoiceSession | null, now: number): s is VoiceSession {
  // Old splash code could have refreshed a legacy entry just before installing this build.
  // Such a timestamp cannot prove recent intent: require one manual join after upgrading.
  if (!s || s.schema !== 1 || typeof s.ts !== 'number' || !Number.isFinite(s.ts)) return false;
  const age = now - s.ts;
  return age >= 0 && age < GRACE_MS;
}

export function saveVoiceSession(instanceId: string | null, serverId: string, channelId: string): void {
  invalidate(instanceId);
  try {
    localStorage.setItem(key(instanceId), JSON.stringify({ serverId, channelId, ts: Date.now(), schema: 1 }));
  } catch {
    /* storage unavailable */
  }
}

/** Refresh the heartbeat timestamp while the live voice connection is healthy. */
export function touchVoiceSession(instanceId: string | null): void {
  const s = loadRaw(instanceId);
  if (!s) return;
  try {
    localStorage.setItem(key(instanceId), JSON.stringify({ ...s, ts: Date.now(), schema: 1 }));
  } catch {
    /* storage unavailable */
  }
}

export function clearVoiceSession(instanceId: string | null = activeInstanceId()): void {
  invalidate(instanceId);
  try {
    localStorage.removeItem(key(instanceId));
  } catch {
    /* storage unavailable */
  }
}

/** Read-only freshness check; startup admission additionally removes rejected persisted intent. */
export function restorableVoiceSession(): VoiceSession | null {
  const s = loadRaw();
  return fresh(s, Date.now()) ? s : null;
}

export type StartupVoiceSession = {
  touch: () => void;
  current: () => VoiceSession | null;
};

/**
 * Capture BEFORE gateway/async startup work. Rejected intent cannot leak into live-rejoin later.
 * A lease is bound to this instance and exact storage entry; cancellation is permanent.
 */
export function captureStartupVoiceSession(): StartupVoiceSession | null {
  const instanceId = activeInstanceId();
  const k = key(instanceId);
  let expected: string | null;
  try {
    expected = localStorage.getItem(k);
  } catch {
    return null;
  }
  let session = parseSession(expected);
  let lastNow = Date.now();
  if (!fresh(session, lastNow)) {
    clearVoiceSession(instanceId);
    return null;
  }
  const generation = generations.get(k) ?? 0;
  let valid = true;
  const current = (): VoiceSession | null => {
    if (!valid) return null;
    let matches = false;
    try {
      matches = localStorage.getItem(k) === expected && (generations.get(k) ?? 0) === generation;
    } catch {
      /* storage unavailable */
    }
    if (activeInstanceId() !== instanceId || !matches) {
      valid = false;
      return null;
    }
    const now = Date.now();
    // Compare observations too: a small clock rollback can leave ts apparently in the past.
    if (now < lastNow || !fresh(session, now)) {
      valid = false;
      clearVoiceSession(instanceId);
      return null;
    }
    lastNow = now;
    return { ...session };
  };
  return {
    current,
    touch: () => {
      const s = current();
      if (!s) return;
      const next = { ...s, ts: lastNow };
      try {
        const raw = JSON.stringify(next);
        localStorage.setItem(k, raw);
        expected = raw;
        session = next;
      } catch {
        valid = false;
      }
    },
  };
}

/** Live-reconnect intent; the caller applies the separate five-minute window. */
export function rejoinableVoiceSession(): VoiceSession | null {
  return loadRaw();
}
