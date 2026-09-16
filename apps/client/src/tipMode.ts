/**
 * Small, browser-free rules for the voice-channel «tip» gesture.
 *
 * The server decides whether a tip is legal and how many coins arrive. These rules only decide
 * which local gesture is available and prevent a public channel from becoming a sound machine.
 */
export type TipModeSignal = 'alt-down' | 'alt-up' | 'blur';
export type TipInteraction = 'none' | 'button' | 'hold';

/** Three quick public tips should make one cue, not three overlapping coin pings. */
export const TIP_CUE_THROTTLE_MS = 1_000;
/** Mobile has no Alt: this duration makes the action intentional without a modal. */
export const TIP_HOLD_MS = 550;

export function nextTipMode(active: boolean, signal: TipModeSignal): boolean {
  if (signal === 'alt-down') return true;
  if (signal === 'alt-up' || signal === 'blur') return false;
  return active;
}

export function tipInteraction(economyEnabled: boolean, altHeld: boolean, mobile: boolean): TipInteraction {
  if (!economyEnabled) return 'none';
  if (mobile) return 'hold';
  return altHeld ? 'button' : 'none';
}

export function shouldPlayTipCue(lastPlayedAt: number | null, now: number): boolean {
  return lastPlayedAt === null || now - lastPlayedAt >= TIP_CUE_THROTTLE_MS;
}

/**
 * Обводить ли ник В СТРОКЕ САЙДБАРА — то есть можно ли отсюда типнуть.
 *
 * 🔴 Правилом, а не выражением в разметке: рамка на нике — обещание, что клик сработает, и все три
 * условия этого обещания стоят проверки. Сервер требует, чтобы ОБА сидели в одном канале
 * (`tipRules`), поэтому обводка на человеке из соседнего канала или на себе означала бы
 * гарантированный отказ — а рамка, ведущая в отказ, хуже отсутствующей.
 */
export function canTipRow(
  altHeld: boolean,
  isMe: boolean,
  myVoiceChannelId: string | null,
  rowChannelId: string,
): boolean {
  return altHeld && !isMe && myVoiceChannelId === rowChannelId;
}
