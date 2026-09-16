import { isAndroid } from './hotkeys';

/**
 * Android background-voice bridge (#89). While in a voice channel the native shell runs a microphone
 * foreground service (persistent notification) so locking the screen / backgrounding the app doesn't
 * let the OS suspend the WebView's mic capture and drop the call. The service is controlled from JS via
 * a `@JavascriptInterface` object (`window.GusVoiceNative`) that MainActivity injects into the WebView.
 *
 * No-op everywhere except the Android build: on web/desktop the interface is absent, so these are safe
 * best-effort calls. VoiceConnection starts the service on join and stops it on leave.
 */
interface GusVoiceNativeBridge {
  startVoiceService(): void;
  stopVoiceService(): void;
}

function bridge(): GusVoiceNativeBridge | null {
  if (!isAndroid()) return null;
  const b = (window as unknown as { GusVoiceNative?: GusVoiceNativeBridge }).GusVoiceNative;
  return b ?? null;
}

/** Start the microphone foreground service (on voice join). Best-effort; logs and swallows failures. */
export function startNativeVoiceService(): void {
  try {
    bridge()?.startVoiceService();
  } catch (e) {
    console.warn('[native-voice] startVoiceService failed:', e);
  }
}

/** Stop the microphone foreground service (on voice leave). Best-effort. */
export function stopNativeVoiceService(): void {
  try {
    bridge()?.stopVoiceService();
  } catch (e) {
    console.warn('[native-voice] stopVoiceService failed:', e);
  }
}
