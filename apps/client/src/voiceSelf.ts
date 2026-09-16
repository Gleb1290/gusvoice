/**
 * The user's OWN mic-mute / deafen intent, decoupled from any LiveKit room. These transitions only
 * mutate the store (selfMuted / selfDeafened, persisted) + play the cue; VoiceConnection's apply effect
 * pushes the intent onto the live room when one exists. So the same toggles work whether you're in a
 * voice channel or not (Discord-style global bar), and the state survives channel switches / reconnects
 * / app restarts. See store.setSelfVoice + VoiceConnection's "apply self voice" effect.
 */
import { playSound } from './sounds';
import { useStore } from './store';

/** Toggle mic mute. Unmuting while deafened also un-deafens (you can't talk while deafened). */
export function toggleSelfMute(): void {
  const { selfMuted, selfDeafened, setSelfVoice, voice } = useStore.getState();
  const ch = voice?.channelId;
  if (selfDeafened) {
    setSelfVoice({ muted: false, deafened: false });
    playSound('unmute', ch);
    return;
  }
  setSelfVoice({ muted: !selfMuted, deafened: selfDeafened });
  playSound(selfMuted ? 'unmute' : 'mute', ch);
}

/** Toggle deafen. Deafen forces the mic off (apply effect handles it); the mute pref is preserved so
 *  un-deafening restores the mic to whatever it was. */
export function toggleSelfDeafen(): void {
  const { selfMuted, selfDeafened, setSelfVoice, voice } = useStore.getState();
  setSelfVoice({ muted: selfMuted, deafened: !selfDeafened });
  playSound(selfDeafened ? 'undeafen' : 'deafen', voice?.channelId);
}

/** Force a specific mute state (used to revert an optimistic un-mute the SFU refused = server-mute). */
export function setSelfMuted(muted: boolean): void {
  const { selfDeafened, setSelfVoice } = useStore.getState();
  setSelfVoice({ muted, deafened: selfDeafened });
}
