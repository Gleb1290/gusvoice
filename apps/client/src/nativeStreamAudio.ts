/**
 * Desktop-only: bridge the native WASAPI capture (system audio minus GusVoice's own voices, see
 * src-tauri/src/audio_capture.rs) into a WebRTC track published as the screen-share audio.
 *
 * Rust streams raw interleaved-f32 chunks (48 kHz stereo) over a Tauri Channel; we wrap each chunk in an
 * `AudioData` frame and feed a `MediaStreamTrackGenerator`, whose MediaStreamTrack LiveKit publishes.
 */
import { LocalAudioTrack, type Room, Track } from 'livekit-client';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;

type TauriCore = {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>;
  Channel: new () => { onmessage: (m: unknown) => void };
};

function tauriCore(): TauriCore | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
}

type TauriEvent = { listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void> };
function tauriEvent(): TauriEvent | null {
  return (window as unknown as { __TAURI__?: { event?: TauriEvent } }).__TAURI__?.event ?? null;
}

/** Desktop only: hide / stop-hiding Chromium's "sharing your screen" indicator window. No-op elsewhere. */
export function setShareIndicatorHidden(hide: boolean): void {
  tauriCore()
    ?.invoke('gv_hide_share_indicator', { hide })
    .catch(() => {});
}

/**
 * Desktop only: tell the native global mouse hook which button drives push-to-talk (a DOM
 * MouseEvent.button index, or < 0 to disable). Lets PTT work while another app is focused. No-op on web.
 */
export function setPttMouseButton(button: number): void {
  tauriCore()
    ?.invoke('gv_ptt_set_mouse_button', { button })
    .catch(() => {});
}

/** Desktop only: subscribe to global mouse-PTT press/release from the native hook. Returns a teardown fn. */
export function onNativePtt(onDown: () => void, onUp: () => void): () => void {
  const ev = tauriEvent();
  if (!ev?.listen) return () => {};
  let unDown: (() => void) | null = null;
  let unUp: (() => void) | null = null;
  let disposed = false;
  void ev.listen('ptt-down', onDown).then((u) => (disposed ? u() : (unDown = u)));
  void ev.listen('ptt-up', onUp).then((u) => (disposed ? u() : (unUp = u)));
  return () => {
    disposed = true;
    unDown?.();
    unUp?.();
  };
}

/**
 * Desktop only: tell the native KEYBOARD hook which key drives push-to-talk (a Windows virtual-key from
 * pttKeyVk; 0 to disable). Lets keyboard PTT open/close the mic even when GusVoice isn't focused (in a
 * game) — the keyboard twin of setPttMouseButton. No-op on web.
 */
export function setPttKey(vk: number): void {
  tauriCore()
    ?.invoke('gv_ptt_set_key', { vk })
    .catch(() => {});
}

/** Desktop only: subscribe to global keyboard-PTT press/release from the native hook. Returns a teardown fn. */
export function onNativeKeyPtt(onDown: () => void, onUp: () => void): () => void {
  const ev = tauriEvent();
  if (!ev?.listen) return () => {};
  let unDown: (() => void) | null = null;
  let unUp: (() => void) | null = null;
  let disposed = false;
  void ev.listen('ptt-key-down', onDown).then((u) => (disposed ? u() : (unDown = u)));
  void ev.listen('ptt-key-up', onUp).then((u) => (disposed ? u() : (unUp = u)));
  return () => {
    disposed = true;
    unDown?.();
    unUp?.();
  };
}

/**
 * Desktop only: tell the native global mouse hook which buttons are bound to mute/deafen/screen-share
 * hotkeys — a bitmask of DOM MouseEvent.button indices (bit i = button i); 0 disables. Lets those
 * toggles fire from a mouse button even when GusVoice isn't focused. No-op on web.
 */
export function setHotkeyMouseMask(mask: number): void {
  tauriCore()
    ?.invoke('gv_hotkey_set_mouse_mask', { mask })
    .catch(() => {});
}

/**
 * Desktop only: subscribe to global hotkey mouse press/release from the native hook. Each handler
 * receives the DOM MouseEvent.button index that fired. Returns a teardown fn.
 */
export function onNativeMouseHotkey(onDown: (button: number) => void, onUp: (button: number) => void): () => void {
  const ev = tauriEvent();
  if (!ev?.listen) return () => {};
  let unDown: (() => void) | null = null;
  let unUp: (() => void) | null = null;
  let disposed = false;
  void ev.listen('hk-mouse-down', (e) => onDown(e.payload as number)).then((u) => (disposed ? u() : (unDown = u)));
  void ev.listen('hk-mouse-up', (e) => onUp(e.payload as number)).then((u) => (disposed ? u() : (unUp = u)));
  return () => {
    disposed = true;
    unDown?.();
    unUp?.();
  };
}

/**
 * Desktop only: tell the native low-level KEYBOARD hook which hotkeys to watch — a list of packed
 * `(mods << 16) | vk` values (see comboToKeyPacked / src-tauri/src/hotkey_key.rs). Empty disables.
 * Unlike RegisterHotKey, the hook OBSERVES the key and passes it through, so a bound key (e.g. Numpad
 * `+`) still types everywhere else. No-op on web.
 */
export function setHotkeyKeys(keys: number[]): void {
  tauriCore()
    ?.invoke('gv_hotkey_set_keys', { keys })
    .catch(() => {});
}

/**
 * Desktop only: subscribe to global keyboard-hotkey presses from the native hook. The handler receives
 * the packed `(mods << 16) | vk` that fired (match it back to a binding via comboToKeyPacked). Returns
 * a teardown fn. Fires on key-down only (toggles); auto-repeat is de-duped natively.
 */
export function onNativeKeyHotkey(onDown: (packed: number) => void): () => void {
  const ev = tauriEvent();
  if (!ev?.listen) return () => {};
  let unDown: (() => void) | null = null;
  let disposed = false;
  void ev.listen('hk-key-down', (e) => onDown(e.payload as number)).then((u) => (disposed ? u() : (unDown = u)));
  return () => {
    disposed = true;
    unDown?.();
  };
}

/** Whether native stream audio can run here (desktop build with the WebCodecs generator). */
export function nativeStreamAudioAvailable(): boolean {
  return !!tauriCore() && typeof (window as unknown as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator === 'function';
}

/**
 * Start native capture and publish it as ScreenShareAudio on `room`. Returns a stop function that tears
 * everything down. Throws if unavailable or if Rust refuses to start.
 *
 * `windowSource` scopes the capture: pass `{ sourceId }` (the shared window's HWND) to stream ONLY that
 * window's process-tree audio; omit it (full-screen share) to stream everything minus GusVoice's voices.
 *
 * ⚠️ Do NOT name this param `window` — it would shadow the global `window`, and the `MediaStreamTrackGenerator`
 * / `AudioData` lookups below would resolve against the param instead (→ always "WebCodecs unsupported",
 * killing native stream audio for BOTH paths). That regression shipped in v0.5.60.
 */
export async function startNativeStreamAudio(room: Room, windowSource?: { sourceId: string }): Promise<() => Promise<void>> {
  const core = tauriCore();
  if (!core) throw new Error('Tauri core API недоступен');
  const Generator = (window as unknown as { MediaStreamTrackGenerator?: new (o: { kind: string }) => MediaStreamTrack & { writable: WritableStream } })
    .MediaStreamTrackGenerator;
  const AudioDataCtor = (window as unknown as { AudioData?: new (o: unknown) => unknown }).AudioData;
  if (!Generator || !AudioDataCtor) throw new Error('WebCodecs (MediaStreamTrackGenerator) не поддерживается');

  const generator = new Generator({ kind: 'audio' });
  const writer = generator.writable.getWriter();
  let timestamp = 0; // microseconds, must increase monotonically

  const channel = new core.Channel();
  channel.onmessage = (msg: unknown) => {
    // Tauri delivers a Raw body as an ArrayBuffer (or a typed-array view of one).
    const ab =
      msg instanceof ArrayBuffer ? msg : ArrayBuffer.isView(msg) ? (msg.buffer as ArrayBuffer) : null;
    if (!ab || ab.byteLength < 8) return;
    const samples = new Float32Array(ab);
    const frames = Math.floor(samples.length / CHANNELS);
    if (frames <= 0) return;
    try {
      const frame = new AudioDataCtor({
        format: 'f32', // interleaved
        sampleRate: SAMPLE_RATE,
        numberOfFrames: frames,
        numberOfChannels: CHANNELS,
        timestamp,
        data: samples,
      });
      timestamp += Math.round((frames / SAMPLE_RATE) * 1_000_000);
      // Drop frames if the consumer is backed up rather than growing an unbounded queue.
      if (writer.desiredSize === null || writer.desiredSize > 0) {
        void writer.write(frame as never).catch(() => {});
      } else {
        (frame as { close?: () => void }).close?.();
      }
    } catch {
      /* a malformed chunk must not kill the stream */
    }
  };

  await core.invoke('gv_stream_audio_start', {
    onAudio: channel,
    isWindow: !!windowSource,
    sourceId: windowSource?.sourceId ?? null,
  });

  // Publish the generator's track as screen-share audio so receivers treat it like any stream audio.
  const track = new LocalAudioTrack(generator, undefined, false);
  await room.localParticipant.publishTrack(track, {
    source: Track.Source.ScreenShareAudio,
    name: 'system-audio',
    dtx: false,
    red: false,
  });

  return async () => {
    try {
      await core.invoke('gv_stream_audio_stop');
    } catch {
      /* ignore */
    }
    try {
      await room.localParticipant.unpublishTrack(track);
    } catch {
      /* ignore */
    }
    try {
      await writer.close();
    } catch {
      /* ignore */
    }
    try {
      (generator as { stop?: () => void }).stop?.();
    } catch {
      /* ignore */
    }
  };
}
