import { REJOIN_WINDOW_MS } from './voiceCueRules';

/** A suspended room cannot renew its own permission to reconnect after a long absence. */
export function createVoiceContinuity(p: {
  now: () => number;
  touch: () => void;
  expire: () => void;
  windowMs?: number;
  enabled?: boolean;
}) {
  let lastAlive = p.now();
  let expired = false;
  const checkAt = (now: number) => {
    if (p.enabled === false) return true;
    if (expired) return false;
    const age = now - lastAlive;
    if (!Number.isFinite(age) || age < 0 || age > (p.windowMs ?? REJOIN_WINDOW_MS)) {
      expired = true;
      p.expire();
      return false;
    }
    return true;
  };
  return {
    check: () => checkAt(p.now()),
    heartbeat() {
      const now = p.now();
      if (!checkAt(now)) return false;
      lastAlive = now;
      p.touch();
      return true;
    },
  };
}
