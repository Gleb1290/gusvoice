import { useSyncExternalStore } from 'react';
import { scopedGetItem, scopedSetItem } from './instanceScope';

/**
 * Per-device channel/category view preferences, persisted in localStorage PER INSTANCE (F0 #139 — ключи
 * с id инстанса, см. `instanceScopeRules.ts`; id каналов принадлежат инстансу):
 *  - muted channels  → suppress unread highlight + notification/mention sounds (gv_muted_channels)
 *  - collapsed categories → hide their channels in the sidebar (gv_collapsed_cats)
 *
 * Mirrors the lightweight subscribe pattern of audioSettings/localUserAudio so a toggle
 * re-renders the sidebar (hooks below use useSyncExternalStore). The Set reference is
 * swapped on every change, so snapshots are stable between unrelated renders.
 */

const MUTED_KEY = 'gv_muted_channels';
const COLLAPSED_KEY = 'gv_collapsed_cats';
const MENTIONS_KEY = 'gv_mentions_only_channels';

/**
 * Per-channel/DM notification level (P2):
 *  - 'all'      → unread highlight + sounds on every message (default)
 *  - 'mentions' → unread + sound only when @-mentioned
 *  - 'none'     → nothing (the old "muted" state)
 * Stored as two Sets (muted = 'none', mentionsOnly = 'mentions'); absence = 'all'. Keeping the
 * existing gv_muted_channels set means previously-muted channels stay muted ('none').
 */
export type NotifyLevel = 'all' | 'mentions' | 'none';

function load(key: string): Set<string> {
  try {
    const raw = scopedGetItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

let muted = load(MUTED_KEY);
let collapsed = load(COLLAPSED_KEY);
let mentionsOnly = load(MENTIONS_KEY);

const listeners = new Set<() => void>();
let version = 0;
function emit() {
  version++;
  for (const l of listeners) l();
}
export function subscribeChannelPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function persist(key: string, set: Set<string>) {
  try {
    scopedSetItem(key, JSON.stringify([...set]));
  } catch {
    /* storage full / disabled — keep the in-memory copy */
  }
}

// --- muted channels ---
export function isChannelMuted(id: string): boolean {
  return muted.has(id);
}
function mutedSnapshot(): Set<string> {
  return muted;
}
export function setChannelMuted(id: string, value: boolean): void {
  if (value === muted.has(id)) return;
  muted = new Set(muted);
  if (value) muted.add(id);
  else muted.delete(id);
  persist(MUTED_KEY, muted);
  emit();
}
export function toggleChannelMute(id: string): void {
  setChannelMuted(id, !muted.has(id));
}
export function useMutedChannels(): Set<string> {
  return useSyncExternalStore(subscribeChannelPrefs, mutedSnapshot);
}

// --- notification level (supersedes the binary mute; 'none' === muted) ---
export function notifyLevel(id: string): NotifyLevel {
  if (muted.has(id)) return 'none';
  if (mentionsOnly.has(id)) return 'mentions';
  return 'all';
}
export function setNotifyLevel(id: string, level: NotifyLevel): void {
  const nextMuted = new Set(muted);
  const nextMentions = new Set(mentionsOnly);
  nextMuted.delete(id);
  nextMentions.delete(id);
  if (level === 'none') nextMuted.add(id);
  else if (level === 'mentions') nextMentions.add(id);
  muted = nextMuted;
  mentionsOnly = nextMentions;
  persist(MUTED_KEY, muted);
  persist(MENTIONS_KEY, mentionsOnly);
  emit();
}

// --- collapsed categories ---
export function isCategoryCollapsed(id: string): boolean {
  return collapsed.has(id);
}
function collapsedSnapshot(): Set<string> {
  return collapsed;
}
export function toggleCategoryCollapse(id: string): void {
  collapsed = new Set(collapsed);
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
  persist(COLLAPSED_KEY, collapsed);
  emit();
}
export function useCollapsedCategories(): Set<string> {
  return useSyncExternalStore(subscribeChannelPrefs, collapsedSnapshot);
}

/** Re-render on ANY pref change (mute or collapse). For components that read via the imperative getters. */
export function useChannelPrefsVersion(): number {
  return useSyncExternalStore(
    subscribeChannelPrefs,
    () => version,
  );
}

/**
 * Where the reader left off in a channel, per device (#15). Written when the channel is closed and read
 * when it's opened, so the «Новые сообщения» divider can sit exactly where reading stopped.
 *
 * Deliberately per-device and NOT the server's read state: `bootstrap.reads` carries unread COUNTS, not
 * a timestamp, and the divider needs a point in time. Nothing to migrate, nothing to sync — a fresh
 * device simply shows no divider until it has read something.
 */
const SEEN_KEY = 'gv_channel_seen';

function seenMap(): Record<string, number> {
  try {
    const raw = JSON.parse(scopedGetItem(SEEN_KEY) || '{}') as Record<string, number>;
    return typeof raw === 'object' && raw ? raw : {};
  } catch {
    return {};
  }
}

/** Millisecond timestamp of the last visit, or null when this device has never opened the channel. */
export function lastSeenAt(channelId: string): number | null {
  const v = seenMap()[channelId];
  return typeof v === 'number' ? v : null;
}

export function markChannelSeen(channelId: string, at: number = Date.now()): void {
  const m = seenMap();
  m[channelId] = at;
  // Keep the map from growing forever on long-lived installs: newest 300 channels is plenty.
  const entries = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 300);
  try {
    scopedSetItem(SEEN_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* storage full / disabled — отметка просто не сохранится */
  }
}
