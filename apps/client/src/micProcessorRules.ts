import type { AudioSettings } from './audioSettings';

type CaptureSettings = Pick<AudioSettings, 'inputDeviceId' | 'echoCancellation' | 'autoGainControl' | 'noiseFilter'>;

/** Один захват для канала, повторного открытия микрофона и его проверки в настройках. */
export function micCaptureOptions(s: CaptureSettings, mobile: boolean, exactDevice = false) {
  return {
    // Без AEC телефон передаёт собеседникам звук собственного динамика. Android AGC/NS остаются
    // выключены: вместе они приводили на Samsung к провалам речи; шумодав/усиление делает наша цепь.
    echoCancellation: mobile ? true : s.echoCancellation,
    autoGainControl: mobile ? false : s.autoGainControl,
    noiseSuppression: mobile ? false : s.noiseFilter === 'system',
    ...(s.inputDeviceId ? { deviceId: exactDevice ? { exact: s.inputDeviceId } : s.inputDeviceId } : {}),
  };
}

/**
 * Правила микрофонной цепи — чистые, БЕЗ WebAudio и без `window`.
 *
 * Вынесено из `micProcessor.ts` по просьбе Codex (2026-07-27): импорт того модуля тянет
 * `deepFilterProcessor`/`noiseFilter` → `config.ts` и падает в Node на `window is not defined`,
 * из-за чего чистые правила были физически недоступны тесту. Тот же случай, что `afkRules.ts`.
 */

/**
 * Порог голоса (гейт) — шкала 1–60 %, «выкл» нет (решение 29.09). По умолчанию 1 %.
 *
 * 🔴 Повод: по умолчанию стоял 0 — гейт выключен, микрофон передавал всё подряд, и новые люди заходили с фоном
 * комнаты в эфире, пока сами не найдут ползунок. 1 % отрезает только почти цифровую тишину и самый слабый фон:
 * шёпот и тихая речь проходят (замечено тем же днём — их обводка и так не горела, `speakingVad.ts`).
 * ⚠️ Из-за этого цепочка `micChainNeeded` теперь собирается у всех (порог > 0), а не только у тех, кто что-то менял.
 */
export const VAD_THRESHOLD_MIN = 0.01;
export const VAD_THRESHOLD_MAX = 0.6;

/** Сохранённое значение → в шкалу. Старые 0 («выкл», в том числе у тех, кто ничего не трогал) становятся 1 %. */
export function clampVadThreshold(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : VAD_THRESHOLD_MIN;
  return Math.min(VAD_THRESHOLD_MAX, Math.max(VAD_THRESHOLD_MIN, n));
}

/** A chain is only needed when the user actually changed something from the cheap defaults. */
export function micChainNeeded(s: AudioSettings): boolean {
  // This custom Web-Audio chain (input-gain node → RNNoise/DeepFilter → gate → MediaStreamDestination)
  // now runs on mobile too. It used to be force-bypassed on Android under the belief that a
  // MediaStreamDestination re-capture attenuates the mic to near-silence + adds heavy latency in the
  // System WebView — but that was observed while getUserMedia AGC/AEC were still mangling the mic at the
  // SOURCE (the "sound saga"). AGC/system NS stay OFF; only AEC is enabled to remove speaker echo.
  // This in-app chain remains responsible for NS/gain/gate after capture (see micCaptureOptions).
  // ⚠️ Since 29.09 the gate is never 0 (scale 1–60 %, `clampVadThreshold`), so real settings ALWAYS need the
  // chain; the old escape hatch «Шумоподавление выкл, gain 100 %, gate 0 → raw mic» is gone from the UI.
  // `vadThreshold > 0` stays in the check for completeness, not as a reachable path.
  return s.inputGain !== 1 || s.vadThreshold > 0 || s.noiseFilter === 'rnnoise' || s.noiseFilter === 'deepfilter';
}

/** Signature that determines whether the chain must be REBUILT (vs just live-updated). */
export function micChainSignature(s: AudioSettings): string {
  return `${micChainNeeded(s)}|${s.noiseFilter}`;
}
