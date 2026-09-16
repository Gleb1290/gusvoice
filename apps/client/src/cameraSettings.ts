/**
 * Per-browser camera quality preset. Read when the camera is enabled / flipped so the chosen
 * resolution + bitrate apply to the published LiveKit track. All presets share the winning publish
 * config from #32 (one non-simulcast layer + maintain-resolution — keep sharpness, drop fps under
 * pressure); they differ only in resolution / bitrate / fps. Default = «Обычное» (720p). See #33.
 */
import type { TrackPublishOptions, VideoCaptureOptions } from 'livekit-client';

export type CameraPreset = 'max' | 'normal' | 'eco';

interface PresetDef {
  label: string;
  sub: string;
  width: number;
  height: number;
  maxBitrate: number;
  maxFramerate: number;
}

export const CAMERA_PRESETS: Record<CameraPreset, PresetDef> = {
  max: { label: 'Максимум', sub: '1080p · для дома / Wi-Fi', width: 1920, height: 1080, maxBitrate: 4_000_000, maxFramerate: 30 },
  normal: { label: 'Обычное', sub: '720p · сбалансированно', width: 1280, height: 720, maxBitrate: 2_500_000, maxFramerate: 30 },
  eco: { label: 'Экономный', sub: '480p · для мобильного', width: 854, height: 480, maxBitrate: 800_000, maxFramerate: 24 },
};

// Display order in the picker (best first).
export const CAMERA_PRESET_ORDER: CameraPreset[] = ['max', 'normal', 'eco'];

const KEY = 'gv_camera';
const DEFAULT: CameraPreset = 'normal';
let cache: CameraPreset | null = null;

export function getCameraPreset(): CameraPreset {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw && raw in CAMERA_PRESETS ? (raw as CameraPreset) : DEFAULT;
  } catch {
    cache = DEFAULT;
  }
  return cache;
}

export function setCameraPreset(p: CameraPreset): void {
  cache = p;
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* ignore */
  }
}

/** getUserMedia capture constraints (resolution + fps) for a preset. */
export function cameraCaptureOptions(preset: CameraPreset = getCameraPreset()): VideoCaptureOptions {
  const p = CAMERA_PRESETS[preset];
  return { resolution: { width: p.width, height: p.height, frameRate: p.maxFramerate } };
}

/** LiveKit publish options — one sharp non-simulcast layer at the preset's bitrate (see #32). */
export function cameraPublishOptions(preset: CameraPreset = getCameraPreset()): TrackPublishOptions {
  const p = CAMERA_PRESETS[preset];
  return {
    simulcast: false,
    videoEncoding: { maxBitrate: p.maxBitrate, maxFramerate: p.maxFramerate },
    degradationPreference: 'maintain-resolution',
  };
}
