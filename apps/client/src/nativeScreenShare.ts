// Native screen-share (desktop): drive the Rust libwebrtc capture/publish commands so we can show a
// fully custom in-app source picker, bypassing WebView2's getDisplayMedia picker (which can't be
// intercepted). On web these are unavailable and the caller falls back to getDisplayMedia.
import { isDesktop } from './hotkeys';

export interface ScreenSource {
  id: string;
  kind: 'screen' | 'window';
  title: string;
  thumb?: string | null; // data:image/png;base64,... (null → render a monogram)
}

/** Mirrors the Rust `StartConfig` (camelCase). Quality fields come from `streamSettings.ts`. */
export interface NativeShareConfig {
  url: string;
  token: string;
  sourceId: string;
  isWindow: boolean;
  fps: number;
  width: number;
  height: number;
  maxBitrate: number;
  codec: string;
  /** Захват ОКНА современным способом (WGC). `false` — старый способ, лечит утечку в проводнике. */
  wgcWindow?: boolean;
  /** Публиковать двумя слоями качества (#109). Отсутствие = включено, как и было. */
  layers?: boolean;
}

type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
function tauriCore(): TauriCore | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
}

/** True when the native screen-share commands are reachable (desktop shell). */
export function nativeScreenShareAvailable(): boolean {
  return isDesktop() && tauriCore() != null;
}

/** Enumerate capturable screens + windows for our own picker grid. */
export async function gvScreenSources(): Promise<ScreenSource[]> {
  const core = tauriCore();
  if (!core) return [];
  const list = (await core.invoke('gv_screen_sources')) as ScreenSource[];
  return Array.isArray(list) ? list : [];
}

/** Connect the companion participant and publish the chosen source. */
export async function gvScreenShareStart(config: NativeShareConfig): Promise<void> {
  const core = tauriCore();
  if (!core) throw new Error('native screen share unavailable');
  await core.invoke('gv_screen_share_start', { config });
}

/** Stop the active native screen share (disconnect the companion). Best-effort. */
export async function gvScreenShareStop(): Promise<void> {
  await tauriCore()
    ?.invoke('gv_screen_share_stop')
    .catch(() => {});
}

type TauriEvent = { listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void> };
function tauriEvent(): TauriEvent | null {
  return (window as unknown as { __TAURI__?: { event?: TauriEvent } }).__TAURI__?.event ?? null;
}

/**
 * Источник трансляции исчез — окно закрыли (или отключили монитор). Rust проверяет это раз в
 * 10 секунд по СПИСКУ источников и шлёт событие; см. `screenshare.rs`, #99.
 *
 * ⚠️ Это НЕ «кадры перестали идти»: свёрнутое окно тоже не отдаёт кадров, а гасить трансляцию на
 * каждый Alt+Tab из игры нельзя. Закрытое окно пропадает из перечисления, свёрнутое — остаётся.
 *
 * Возвращает функцию отписки.
 */
export function onNativeShareEnded(cb: () => void): () => void {
  const ev = tauriEvent();
  if (!ev?.listen) return () => {};
  let un: (() => void) | null = null;
  let disposed = false;
  void ev.listen('gv-screenshare-ended', cb).then((u) => (disposed ? u() : (un = u)));
  return () => {
    disposed = true;
    un?.();
  };
}

/**
 * Показ залип и был пересобран сам (#111). Полезная нагрузка — какой это раз за сеанс.
 *
 * Приходит ТОЛЬКО тому, кто показывает: остальные видят обычные снятие и публикацию трека, и для
 * них это чинится отдельно (отсрочка закрытия окна показа и склейка звуков — см. `streamCue.ts`).
 *
 * Возвращает функцию отписки.
 */
export function onNativeShareHealed(cb: (attempt: number) => void): () => void {
  const ev = tauriEvent();
  if (!ev?.listen) return () => {};
  let un: (() => void) | null = null;
  let disposed = false;
  void ev
    .listen('gv-screenshare-healed', (e) => cb(typeof e.payload === 'number' ? e.payload : 1))
    .then((u) => (disposed ? u() : (un = u)));
  return () => {
    disposed = true;
    un?.();
  };
}

/**
 * Второй слой качества выключен ЗА человека (#112). Причина: `'old-gpu'` — поколение видеокарты, на
 * котором слой уже ронял приложение; `'crash'` — прошлый показ с двумя слоями оборвался смертью
 * приложения.
 *
 * ⚠️ Подписываться надо ЗАРАНЕЕ, а не в момент старта показа: событие прилетает из `start()` ещё до
 * того, как публикация поднялась, и подписка «по факту показа» его не застанет.
 *
 * Возвращает функцию отписки.
 */
export function onNativeShareLayersOff(cb: (reason: string) => void): () => void {
  const ev = tauriEvent();
  if (!ev?.listen) return () => {};
  let un: (() => void) | null = null;
  let disposed = false;
  void ev
    .listen('gv-screenshare-layers-off', (e) => cb(typeof e.payload === 'string' ? e.payload : 'crash'))
    .then((u) => (disposed ? u() : (un = u)));
  return () => {
    disposed = true;
    un?.();
  };
}

/** Live encoder stats for the native share (see ShareStats in screenshare.rs). Null when not sharing. */
export interface NativeShareStats {
  width: number;
  height: number;
  fps: number;
  bytes_sent: number;
  packets_sent: number;
  target_bitrate: number;
  frames_encoded: number;
  key_frames: number;
  /** "none" | "cpu" | "bandwidth" | "other" — encoder vs uplink, the field worth reading first. */
  limit_reason: string;
  limit_cpu_s: number;
  limit_bandwidth_s: number;
  resolution_changes: number;
  /** libwebrtc's encoder name — "NvCodec…" = NVENC, "OpenH264"/"libvpx" = software. */
  encoder: string;
  power_efficient: boolean;
  nack: number;
  pli: number;
  codec: string;
  rtt_ms: number;
  fraction_lost: number;
  packets_lost: number;
  at_ms: number;

  // ─── Конвейер захвата (2026-08-22) ───
  /** Среднее время ЗАХВАТА кадра, мс. Единицы — быстрый путь; сотни — старый через копирование. */
  capture_ms: number;
  /** Среднее время ПОДГОТОВКИ кадра (перевод формата + уменьшение), мс. */
  convert_ms: number;
  /** РЕАЛЬНЫЙ размер источника — не путать с `width`/`height`, те про то, что ушло в сеть. */
  src_width: number;
  src_height: number;
  frames_captured: number;
  frames_late: number;

  // ─── Самолечение залипшего показа (#111) ───
  /** Время захвата за последние ~5 с. ⚠️ Не путать с `capture_ms` — тем средним с начала показа. */
  capture_ms_now: number;
  /** Сколько раз показ пересобрался сам. У здорового показа обязан остаться нулём. */
  heals: number;
  /** Сколько секунд подряд держится залипание прямо сейчас (0 — всё в порядке). */
  stuck_s: number;
}

/**
 * Свежий кадр идущего НАТИВНОГО показа маленькой картинкой (data-URL) — для превью по наведению
 * мышкой (#115). `null`, когда нативного показа нет: это и есть признак «показывать нечего».
 *
 * ⚠️ Кадр берётся из живого конвейера захвата, а не отдельным снимком источника: повторный захват
 * при занятой видеокарте стоит 66–137 мс — ровно та цена, из-за которой показ и залипал (#111).
 */
export async function gvScreenSharePreview(): Promise<string | null> {
  try {
    return ((await tauriCore()?.invoke('gv_screen_share_preview')) as string | null) ?? null;
  } catch {
    return null;
  }
}

/** One stats sample from the native share, or null (not sharing / not desktop). */
export async function gvScreenShareStats(): Promise<NativeShareStats | null> {
  try {
    return ((await tauriCore()?.invoke('gv_screen_share_stats')) as NativeShareStats | null) ?? null;
  } catch {
    return null;
  }
}

export interface ForegroundWindow {
  id: string; // HWND as a stringified u64 — use as `sourceId` with `isWindow: true`
  exe: string; // lowercased exe basename, e.g. "cs2.exe"
  isSelf: boolean; // GusVoice's own window is in front → caller opens the picker instead
}

/**
 * The window currently in front — for the "stream the focused window" hotkey. Returns null when
 * unavailable (web / no foreground window). `isSelf` means GusVoice itself is focused.
 */
export async function gvForegroundWindow(): Promise<ForegroundWindow | null> {
  const core = tauriCore();
  if (!core) return null;
  try {
    const w = (await core.invoke('gv_foreground_window')) as ForegroundWindow | null;
    return w && typeof w.id === 'string' ? w : null;
  } catch {
    return null;
  }
}
