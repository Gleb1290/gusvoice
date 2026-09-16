// Ephemeral "what game is this user playing" store (issue #40). Activity is NOT persisted: it's
// reported live from two sources and held in memory with a TTL, broadcast on change, and snapshotted
// to freshly-loaded clients.
//
// TWO SOURCES with priority (Phase 1B): 'steam' (server-side GetPlayerSummaries poller — authoritative)
// beats 'client' (desktop local process detection). Each source has its own TTL entry, so e.g. a
// desktop user with Steam linked shows the Steam-reported game, and falls back to local detect if
// Steam goes quiet. The TTL is the safety net for a crashed/closed reporter.
//
// Приоритет источников и переход по TTL — чистые, в `activityRules.ts`; здесь только Map и broadcast.
import type { GameActivity } from '@gusvoice/shared';
import {
  effectiveOf,
  isEmptyRecord,
  sameEffective,
  setSource,
  sweepExpired,
  type ActivityRecord,
  type ActivitySource,
} from './activityRules.js';
import { broadcastUserActivity } from './gateway.js';

export type { ActivitySource } from './activityRules.js';

const store = new Map<string, ActivityRecord>();

/** The user's current (effective, non-expired) game, or null. */
export function getActivity(userId: string): GameActivity | null {
  return effectiveOf(store.get(userId), Date.now());
}

/** Snapshot of everyone currently playing something — seeds a freshly-loaded client. */
export function allActivities(): Record<string, GameActivity> {
  const now = Date.now();
  const out: Record<string, GameActivity> = {};
  for (const [uid, rec] of store) {
    const e = effectiveOf(rec, now);
    if (e) out[uid] = e;
  }
  return out;
}

/** Записать новую запись в хранилище (пустую — удалить) и разослать, если ВИДИМОЕ изменилось. */
function commit(userId: string, next: ActivityRecord, before: GameActivity | null, now: number): void {
  if (isEmptyRecord(next)) store.delete(userId);
  else store.set(userId, next);
  const after = effectiveOf(next, now);
  if (!sameEffective(before, after)) broadcastUserActivity(userId, after);
}

/**
 * Set (or clear with null) a user's game for one SOURCE. Refreshes that source's TTL (so periodic
 * re-reports act as a heartbeat); broadcasts only when the EFFECTIVE (priority-resolved) game changed.
 */
export function setActivity(userId: string, game: GameActivity | null, source: ActivitySource = 'client'): void {
  const now = Date.now();
  const rec = store.get(userId);
  commit(userId, setSource(rec, source, game, now), effectiveOf(rec, now), now);
}

/** Clear ALL sources for a user (e.g. they turned off show_game_activity). Broadcasts if it changed. */
export function clearActivity(userId: string): void {
  const rec = store.get(userId);
  if (!rec) return;
  const before = effectiveOf(rec, Date.now());
  store.delete(userId);
  if (before) broadcastUserActivity(userId, null);
}

/** Drop expired per-source entries and broadcast any effective change. Runs on an interval. */
export function sweepActivities(): void {
  const now = Date.now();
  for (const [uid, rec] of store) commit(uid, sweepExpired(rec, now), effectiveOf(rec, now), now);
}

export function startActivitySweeper(): void {
  setInterval(sweepActivities, 30_000).unref?.();
}
