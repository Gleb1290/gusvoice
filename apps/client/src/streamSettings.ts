/**
 * Per-browser screen-share quality preferences. Read by VoiceControls when a screen
 * share is started so the chosen resolution / fps / codec / bitrate apply to the
 * published LiveKit track. LiveKit's built-in ScreenSharePresets stop at 1080p30, so
 * we build the capture + publish options by hand to unlock 1440p, 4K and 60 fps.
 */
import type {
  ScalabilityMode,
  ScreenShareCaptureOptions,
  TrackPublishOptions,
  VideoCodec,
} from 'livekit-client';

export type StreamResolution = '720' | '1080' | '1440' | '2160';
export type StreamFps = 15 | 30 | 60;
// 'detail' favours sharp text/UI (maintain-resolution); 'motion' favours smooth
// gameplay/video (maintain-framerate). Maps to the WebRTC contentHint + degradation pref.
export type StreamMode = 'detail' | 'motion';
// Pruned to two codecs that actually make sense for our case (desktop NVIDIA publisher →
// WebView2/Chromium viewers):
//   h264 — PRIMARY. Hardware NVENC encode (≈0 CPU, low latency) when an NVIDIA GPU is present,
//          else auto-falls back to software OpenH264; decoded in hardware by every viewer.
//   vp9  — ALT. Software-encoded (costs CPU) but more efficient → sharper text on a tight uplink;
//          decoded by every Chromium client.
// Dropped: av1 (no AV1-NVENC before RTX 40xx → software-only, CPU-melting, stutters) and
// vp8/'auto' (redundant — software h264 already covers the no-GPU floor). h265/HEVC was tried
// (v0.5.7) and pulled — NVENC encodes it but WebView2 crashes decoding it (STATUS_ACCESS_VIOLATION).
// The Rust fork keeps the h265 (and av1) encoder paths dormant; re-expose only if viable.
export type StreamCodec = 'h264' | 'vp9';

export interface StreamSettings {
  resolution: StreamResolution;
  fps: StreamFps;
  mode: StreamMode;
  codec: StreamCodec;
  audio: boolean; // capture tab / system audio alongside the screen
  /**
   * Захватывать ОКНО современным способом (Windows Graphics Capture). Десктоп, по умолчанию `true`.
   *
   * 🔴 Выключается теми, у кого от показа окна пухнет проводник: этот способ подтекает в
   * `explorer.exe` (замерено: 150 → 750 МБ за два часа показа, три сессии подряд, рост прекращается
   * вместе с показом), а когда проводнику плохо, отваливаются Alt+Tab, «Пуск» и панель задач — ровно
   * то, что обслуживает он. Тот же баг с той же причиной известен у TeamSpeak 6.
   *
   * ⚠️ По умолчанию НЕ выключено: без него захват окна падает на старый способ, который плохо снимает
   * окна игр — вплоть до чёрного кадра. Показа всего экрана флаг не касается (там другой механизм, и
   * утечки нет).
   */
  wgcWindow: boolean;
  /**
   * Публиковать показ ДВУМЯ слоями качества вместо одного (#109).
   *
   * По умолчанию включено: без запасного слоя зритель с потерями не может получить картинку полегче
   * и вместо этого просит опорные кадры — замерено 1.6 раза в секунду при норме 0.1, и пульсирует
   * при этом У ВСЕХ, а не только у него.
   *
   * ⚠️ Выключатель существует, потому что второй слой стоит второго сеанса кодирования у видеокарты
   * и лишних выделений памяти. Потолок сеансов задаёт драйвер (2 → 3 → 8), и симптом упора —
   * «показ вообще не стартует». Выключать имеет смысл ровно в этом случае.
   */
  layers: boolean;
  /**
   * Отдавать маленькое превью показа, чтобы остальные видели по наведению мышкой, что ты стримишь,
   * не заходя в канал (#115). По умолчанию включено.
   *
   * ⚠️ Это выключатель не про нагрузку, а про приватность, и он существует по существу. Раньше,
   * чтобы увидеть чужой экран, надо было зайти в канал — и человек об этом узнавал. С превью можно
   * посмотреть незаметно. Кадр маленький (320 px по ширине) и отвечает на «во что он играет», но
   * право решать, отдавать его или нет, остаётся за показывающим.
   */
  streamPreview: boolean;
}

const KEY = 'gv_stream';

const DEFAULTS: StreamSettings = {
  resolution: '1080',
  fps: 30,
  mode: 'detail',
  // H.264 by default: it's the only codec the GPU can hardware-encode AND every viewer can hardware-
  // decode. VP9/AV1 are software-encoded on most GPUs (no NVENC) and stutter on scene changes.
  codec: 'h264',
  audio: true,
  wgcWindow: true,
  layers: true,
  streamPreview: true,
};

let cache: StreamSettings | null = null;

export function getStreamSettings(): StreamSettings {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<StreamSettings>) } : { ...DEFAULTS };
  } catch {
    cache = { ...DEFAULTS };
  }
  // Drop any retired codec (e.g. a saved 'h265' from v0.5.7) so it can't keep publishing an
  // unviewable stream — fall back to the default.
  if (!VALID_CODECS.has(cache.codec)) cache = { ...cache, codec: DEFAULTS.codec };
  return cache;
}

export function setStreamSettings(next: StreamSettings): void {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export const RES_OPTIONS: { value: StreamResolution; label: string; width: number; height: number }[] = [
  { value: '720', label: '720p', width: 1280, height: 720 },
  { value: '1080', label: '1080p', width: 1920, height: 1080 },
  { value: '1440', label: '1440p', width: 2560, height: 1440 },
  { value: '2160', label: '4K', width: 3840, height: 2160 },
];

export const FPS_OPTIONS: StreamFps[] = [15, 30, 60];

export const CODEC_OPTIONS: { value: StreamCodec; label: string }[] = [
  { value: 'h264', label: 'H.264 (рекомендуется)' },
  { value: 'vp9', label: 'VP9 (резче, грузит CPU)' },
];

const VALID_CODECS = new Set<string>(CODEC_OPTIONS.map((c) => c.value));

function dims(res: StreamResolution): { width: number; height: number } {
  const o = RES_OPTIONS.find((r) => r.value === res)!;
  return { width: o.width, height: o.height };
}

/** Target max bitrate (bps) for screen content, tuned per resolution × fps × mode. */
export function bitrateFor(s: StreamSettings): number {
  const base: Record<StreamResolution, number> = {
    '720': 1_500_000,
    '1080': 3_000_000,
    '1440': 5_000_000,
    '2160': 8_000_000,
  };
  const fpsMul = s.fps === 60 ? 1.6 : s.fps === 30 ? 1 : 0.75;
  const modeMul = s.mode === 'motion' ? 1.15 : 1; // motion = more inter-frame change
  // H.264 needs more bits for the same quality; VP9 is more efficient. Give H.264 extra headroom
  // so screen text stays crisp without blocky starvation.
  const codecMul = s.codec === 'h264' ? 1.4 : 1;
  return Math.round(base[s.resolution] * fpsMul * modeMul * codecMul);
}

/** Human-readable estimate, e.g. "≈ 5.5 Мбит/с". */
export function bitrateLabel(s: StreamSettings): string {
  return `${(bitrateFor(s) / 1_000_000).toFixed(1).replace('.0', '')} Мбит/с`;
}

const isSvc = (c: StreamCodec): boolean => c === 'vp9';

/** getDisplayMedia constraints for the chosen quality. */
export function captureOptions(s: StreamSettings): ScreenShareCaptureOptions {
  const d = dims(s.resolution);
  return {
    audio: s.audio,
    systemAudio: s.audio ? 'include' : 'exclude',
    resolution: { width: d.width, height: d.height, frameRate: s.fps },
    contentHint: s.mode, // 'detail' | 'motion'
  };
}

/** LiveKit publish options (encoding, codec, degradation) for the chosen quality. */
export function publishOptions(s: StreamSettings): TrackPublishOptions {
  const svc = isSvc(s.codec);
  const degradationPreference: RTCDegradationPreference =
    s.mode === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
  return {
    videoCodec: s.codec as VideoCodec,
    screenShareEncoding: {
      maxBitrate: bitrateFor(s),
      maxFramerate: s.fps,
      priority: 'high',
    },
    degradationPreference,
    // 🔴 Слоёв ДВА, и это принципиально (#109). Раньше стоял `false` с доводом «показ = один
    // чёткий слой» — довод оказался неверным: запасной слой смотрит тот, кому плохо. Без него
    // зритель с потерями не может получить картинку полегче и вместо этого просит опорные кадры
    // (PLI) — замерено 1.6 раза в секунду при норме 0.1. Каждый запрос заставляет кодировщик
    // выдать опорный кадр, а слой один на всех → пульсация У ВСЕХ. Один человек на мобильном
    // интернете (47 % потерь) так уронил качество всему каналу.
    simulcast: s.layers,
    // ⚠️ Для VP9 решает НЕ `simulcast`, а режим масштабируемости: SVC-кодек делает слои внутри
    // ОДНОГО кодировщика. `L1T3` давал только ВРЕМЕННЫЕ слои (пропуск кадров) — разрешение он не
    // уменьшает, а зрителю с потерями нужно именно меньшее разрешение. `L3T3_KEY` даёт три
    // пространственных слоя, а `_KEY` согласует их по опорным кадрам, чтобы переключение между
    // слоями не требовало нового опорного кадра — то есть ровно то, от чего мы уходим.
    ...(svc ? { scalabilityMode: (s.layers ? 'L3T3_KEY' : 'L1T3') as ScalabilityMode } : {}),
  };
}

/**
 * Собрать конфиг НАТИВНОГО показа из выбранных настроек — чистая функция, без React и без Tauri.
 *
 * 🔴 Вынесено по просьбе Codex, и просьба обоснованная: раньше провод «настройка → конфиг → запуск
 * в Rust» жил внутри обработчика в `VoiceControls`, где его нельзя доказать тестом. А ошибка именно
 * здесь возвращает человеку то, что он осознанно выключил: например `wgcWindow`, отключённый из-за
 * утечки в проводнике (#100), или `layers` при нехватке сеансов кодирования (#109). Молча.
 *
 * Тип возврата описан структурно, а не импортом `NativeShareConfig`: тот модуль тянет Tauri, и
 * тест на него не поднялся бы — ровно то, от чего вынос и делается.
 */
export function buildNativeShareConfig(input: {
  url: string;
  token: string;
  sourceId: string;
  isWindow: boolean;
  settings: StreamSettings;
}): {
  url: string;
  token: string;
  sourceId: string;
  isWindow: boolean;
  fps: number;
  width: number;
  height: number;
  maxBitrate: number;
  codec: string;
  wgcWindow: boolean;
  layers: boolean;
} {
  const s = input.settings;
  const dims = RES_OPTIONS.find((r) => r.value === s.resolution) ?? RES_OPTIONS[0];
  return {
    url: input.url,
    token: input.token,
    sourceId: input.sourceId,
    isWindow: input.isWindow,
    fps: s.fps,
    width: dims.width,
    height: dims.height,
    maxBitrate: bitrateFor(s),
    codec: s.codec,
    wgcWindow: s.wgcWindow,
    layers: s.layers,
  };
}
