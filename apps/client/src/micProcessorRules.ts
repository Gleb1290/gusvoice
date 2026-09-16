import type { AudioSettings } from './audioSettings';

/**
 * Правила микрофонной цепи — чистые, БЕЗ WebAudio и без `window`.
 *
 * Вынесено из `micProcessor.ts` по просьбе Codex (2026-07-27): импорт того модуля тянет
 * `deepFilterProcessor`/`noiseFilter` → `config.ts` и падает в Node на `window is not defined`,
 * из-за чего чистые правила были физически недоступны тесту. Тот же случай, что `afkRules.ts`.
 */

/** A chain is only needed when the user actually changed something from the cheap defaults. */
export function micChainNeeded(s: AudioSettings): boolean {
  // This custom Web-Audio chain (input-gain node → RNNoise/DeepFilter → gate → MediaStreamDestination)
  // now runs on mobile too. It used to be force-bypassed on Android under the belief that a
  // MediaStreamDestination re-capture attenuates the mic to near-silence + adds heavy latency in the
  // System WebView — but that was observed while getUserMedia AGC/AEC were still mangling the mic at the
  // SOURCE (the "sound saga"). With that processing forced OFF (raw mic in — see
  // VoiceConnection.audioCaptureDefaults), THIS in-app chain is the correct place to do NS/gain/gate on
  // mobile: it never touches the WebView's broken WebRTC/ECNS path. Escape hatch if a device still
  // misbehaves: Settings → Шумоподавление = «Выкл», gain 100%, gate 0 → this returns false → the
  // known-good raw mic, no rebuild.
  return s.inputGain !== 1 || s.vadThreshold > 0 || s.noiseFilter === 'rnnoise' || s.noiseFilter === 'deepfilter';
}

/** Signature that determines whether the chain must be REBUILT (vs just live-updated). */
export function micChainSignature(s: AudioSettings): string {
  return `${micChainNeeded(s)}|${s.noiseFilter}`;
}
