/**
 * Состояние шумового гейта своего микрофона — «открыт / закрыт» (#215), без Web Audio и `window`.
 *
 * 🔴 Повод: своя зелёная обводка горела, хотя порог микрофона не пройден (друзья не слышат). Обводка меряла свой
 * уровень (`speakingVad.ts`) и порога гейта не знала. Теперь гейт (`public/gv-gate-worklet.js`) сам сообщает
 * «открыт/закрыт» (только при смене), `micProcessor.ts` кладёт это сюда, а обводка (`VoiceConnection.tsx`) читает.
 *
 * `null` = гейта нет или он ещё ничего не сказал (цепь не собрана, воркет не загрузился) — тогда обводка живёт
 * только по своему VAD, как раньше. Рация: гейт выключен (порог 0) и сообщает «открыт» — условия гейта нет.
 */

let gateOpen: boolean | null = null;
const listeners = new Set<(open: boolean | null) => void>();

export function getMicGateOpen(): boolean | null {
  return gateOpen;
}

export function setMicGateOpen(open: boolean | null): void {
  if (open === gateOpen) return;
  gateOpen = open;
  for (const l of [...listeners]) l(open);
}

export function subscribeMicGate(fn: (open: boolean | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Своя обводка: VAD И гейт не закрыт. `null` (гейта нет) не мешает. */
export function ownRingSpeaking(vadSpeaking: boolean, gateOpenNow: boolean | null): boolean {
  return vadSpeaking && gateOpenNow !== false;
}
