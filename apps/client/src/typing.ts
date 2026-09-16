import { useSyncExternalStore } from 'react';

/**
 * Ephemeral "who is typing" state, keyed by channel id OR dm id (round-7 P4). Each typing
 * event refreshes a 5s expiry for that user; a 1s prune drops the stale ones. Names are
 * resolved by the caller (roster / DM other-user), so we only track userIds here.
 */
const TTL_MS = 5000;
const typing = new Map<string, Map<string, number>>(); // key -> userId -> expiry
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function emit() {
  version++;
  for (const l of listeners) l();
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [key, m] of typing) {
      for (const [uid, exp] of m) {
        if (exp <= now) {
          m.delete(uid);
          changed = true;
        }
      }
      if (m.size === 0) typing.delete(key);
    }
    if (changed) emit();
    if (typing.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }, 1000);
}

export function noteTyping(key: string, userId: string): void {
  let m = typing.get(key);
  if (!m) typing.set(key, (m = new Map()));
  m.set(userId, Date.now() + TTL_MS);
  ensureTimer();
  emit();
}

function typingUsers(key: string): string[] {
  const m = typing.get(key);
  if (!m) return [];
  const now = Date.now();
  return [...m.entries()].filter(([, exp]) => exp > now).map(([uid]) => uid);
}

/** Currently-typing userIds for a channel/dm key. Re-renders on changes; prune handled internally. */
export function useTyping(key: string): string[] {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
  );
  return typingUsers(key);
}
