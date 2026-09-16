/**
 * Voice-session persistence for reconnect-grace + restore-on-restart (#11). While you're in a voice
 * channel we stamp { serverId, channelId, ts } in localStorage and refresh `ts` on a heartbeat, so it
 * reflects "last alive". On a clean leave we clear it. If the connection drops and doesn't recover
 * within GRACE_MS, VoiceConnection visually leaves but KEEPS the session; on the next app launch we
 * auto-rejoin the same server+channel (mute/deafen come back via the persisted selfMuted/selfDeafened).
 * The grace window also gates restore: a session older than GRACE_MS is treated as a normal past
 * session, not a crash, so we don't yank you back into a call you left hours ago.
 */
import { activeInstanceId } from './config';

// Namespaced per instance (#7): a voice session belongs to one backend's channel-id space, so after
// switching instances we must NOT auto-rejoin the old instance's channel. Resolved at call time (the
// active instance is stable within a session — a switch restarts the app).
function key(): string {
  return `gv_voice_session:${activeInstanceId() ?? 'default'}`;
}
export const GRACE_MS = 12_000;

export type VoiceSession = { serverId: string; channelId: string; ts: number };

function loadRaw(): VoiceSession | null {
  try {
    const v = JSON.parse(localStorage.getItem(key()) || 'null');
    return v && typeof v.serverId === 'string' && typeof v.channelId === 'string' ? (v as VoiceSession) : null;
  } catch {
    return null;
  }
}

export function saveVoiceSession(serverId: string, channelId: string): void {
  try {
    localStorage.setItem(key(), JSON.stringify({ serverId, channelId, ts: Date.now() }));
  } catch {
    /* storage unavailable */
  }
}

/** Refresh the heartbeat timestamp so "last alive" stays current while connected. */
export function touchVoiceSession(): void {
  const s = loadRaw();
  if (!s) return;
  try {
    localStorage.setItem(key(), JSON.stringify({ ...s, ts: Date.now() }));
  } catch {
    /* storage unavailable */
  }
}

export function clearVoiceSession(): void {
  try {
    localStorage.removeItem(key());
  } catch {
    /* storage unavailable */
  }
}

/** The session to auto-rejoin on boot, but only if it was alive within the grace window (a crash /
 *  quick restart) — otherwise null. */
export function restorableVoiceSession(): VoiceSession | null {
  const s = loadRaw();
  if (!s) return null;
  return Date.now() - s.ts < GRACE_MS ? s : null;
}

/**
 * Сессия для авто-возврата ПОСЛЕ ВОССТАНОВЛЕНИЯ СВЯЗИ в уже запущенном приложении.
 *
 * ⚠️ Окно здесь своё, шире загрузочного (5 минут против 12 секунд), и это намеренно: на старте
 * приложения мы возвращаем только после падения/быстрого перезапуска, а здесь — после провала сети,
 * который вполне может длиться минуты. Само наличие сессии означает, что уход был непреднамеренным.
 */
export function rejoinableVoiceSession(): VoiceSession | null {
  return loadRaw();
}
