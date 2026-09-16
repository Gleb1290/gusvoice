/**
 * Per-user, client-only audio preferences — persisted across sessions so you never have to
 * re-set someone's volume on each app launch. Keyed by userId (which is the LiveKit participant
 * identity). Two independent knobs:
 *   - volume: 0..2 (1 = 100%, >1 boosts) — applied via RemoteParticipant.setVolume()
 *   - muted:  locally silence this user regardless of volume ("заглушить только для себя"),
 *             distinct from a server-side mute (which RowActions/moderation handles).
 * The effective gain handed to LiveKit is 0 when locally muted, else `volume`.
 */
import { useEffect, useState } from 'react';
import type { Participant } from 'livekit-client';
import { ParticipantEvent, Track } from 'livekit-client';
import { scopedGetItem, scopedSetItem } from './instanceScope';

/** Ключ ПО ИНСТАНСУ (F0 #139): здесь id пользователей, а они принадлежат инстансу — `instanceScopeRules.ts`. */
const KEY = 'gv_user_audio';
export const MAX_VOLUME = 2;

type Pref = { volume?: number; muted?: boolean };
type Store = Record<string, Pref>;

let cache: Store | null = null;
const listeners = new Set<(userId: string) => void>();

function load(): Store {
  if (cache) return cache;
  try {
    cache = JSON.parse(scopedGetItem(KEY) || '{}') as Store;
  } catch {
    cache = {};
  }
  return cache;
}

function persist() {
  try {
    // drop entries that are back at defaults so the blob doesn't grow unbounded
    const s = cache ?? {};
    for (const [id, p] of Object.entries(s)) {
      if (!p.muted && (p.volume === undefined || p.volume === 1)) delete s[id];
    }
    scopedSetItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full / unavailable — keep in-memory cache */
  }
}

function emit(userId: string) {
  for (const l of listeners) l(userId);
}

export function getUserVolume(userId: string): number {
  return load()[userId]?.volume ?? 1;
}

export function isUserMuted(userId: string): boolean {
  return !!load()[userId]?.muted;
}

/** Gain to hand LiveKit: 0 when locally muted, else the stored volume (default 1). */
export function effectiveGain(userId: string): number {
  const p = load()[userId];
  if (!p) return 1;
  if (p.muted) return 0;
  return p.volume ?? 1;
}

export function setUserVolume(userId: string, volume: number) {
  const s = load();
  const v = Math.max(0, Math.min(MAX_VOLUME, volume));
  s[userId] = { ...s[userId], volume: v };
  persist();
  emit(userId);
}

export function setUserMuted(userId: string, muted: boolean) {
  const s = load();
  s[userId] = { ...s[userId], muted };
  persist();
  emit(userId);
}

export function toggleUserMuted(userId: string): boolean {
  const next = !isUserMuted(userId);
  setUserMuted(userId, next);
  return next;
}

export function resetUserVolume(userId: string) {
  setUserVolume(userId, 1);
}

export function subscribeUserAudio(fn: (userId: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Push the stored gain onto a live LiveKit participant (no-op for local/unsupported).
 * Wrapped in try/catch: without webAudioMix, setVolume writes HTMLMediaElement.volume which
 * throws IndexSizeError for values >1 — that must never bubble up and blank the whole app.
 */
export function applyUserAudio(p: Participant) {
  if (p.isLocal) return;
  const gain = effectiveGain(p.identity);
  // 🔴 Только МИКРОФОН, трек за треком (#71). Раньше здесь стоял `participant.setVolume()`, а он в
  // LiveKit бьёт по ВСЕМ аудиотрекам участника — включая звук его демонстрации экрана. Это не
  // «забывало приглушить» неоткрытый стрим, а активно включало его на полную: эффект дёргается на
  // каждом TrackPublished/TrackSubscribed. Громкость человека — это громкость его ГОЛОСА; стрим
  // живёт по своим правилам (`streamAudioRules`).
  for (const pub of p.trackPublications.values()) {
    if (pub.source !== Track.Source.Microphone) continue;
    const t = pub.track as { setVolume?: (v: number) => void } | undefined;
    if (typeof t?.setVolume !== 'function') continue;
    try {
      t.setVolume(gain);
    } catch {
      // Fall back to a safe value so audio still plays even if the boost path is unavailable.
      try {
        t.setVolume(Math.min(1, gain));
      } catch {
        /* give up silently — never crash the render tree over a volume tweak */
      }
    }
  }
}

/**
 * Keep a remote participant's applied gain in sync with the stored pref, re-applying when the
 * pref changes and when their audio track (re)subscribes — so a volume set before they joined,
 * or before their mic published, still takes effect.
 */
export function useApplyUserAudio(p: Participant) {
  useEffect(() => {
    if (p.isLocal) return;
    const reapply = () => applyUserAudio(p);
    reapply();
    const unsub = subscribeUserAudio((id) => {
      if (id === p.identity) reapply();
    });
    p.on(ParticipantEvent.TrackSubscribed, reapply).on(ParticipantEvent.TrackPublished, reapply);
    return () => {
      unsub();
      p.off(ParticipantEvent.TrackSubscribed, reapply).off(ParticipantEvent.TrackPublished, reapply);
    };
  }, [p]);
}

/** Reactive view of one user's stored audio prefs, for menu UI. */
export function useUserAudio(userId: string) {
  const [, tick] = useState(0);
  useEffect(
    () =>
      subscribeUserAudio((id) => {
        if (id === userId) tick((t) => t + 1);
      }),
    [userId],
  );
  return {
    volume: getUserVolume(userId),
    muted: isUserMuted(userId),
    setVolume: (v: number) => setUserVolume(userId, v),
    setMuted: (m: boolean) => setUserMuted(userId, m),
    toggleMuted: () => toggleUserMuted(userId),
    reset: () => resetUserVolume(userId),
  };
}
