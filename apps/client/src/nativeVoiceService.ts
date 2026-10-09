import { isAndroid } from './hotkeys';

/**
 * Android background-voice bridge (#89). While in a voice channel the native shell runs a microphone
 * foreground service (persistent notification) so locking the screen / backgrounding the app doesn't
 * let the OS suspend the WebView's mic capture and drop the call. The service is controlled from JS via
 * a `@JavascriptInterface` object (`window.GusVoiceNative`) that MainActivity injects into the WebView.
 *
 * No-op everywhere except the Android build: on web/desktop the interface is absent, so these are safe
 * best-effort calls. VoiceConnection starts the service on join and stops it on leave.
 *
 * 🔴 Старт — только с ВИДИМОЙ страницы (#210). С Android 14 службу с микрофоном нельзя вывести на передний план из
 * фона: `startForeground` бросал `SecurityException`, и приложение падало целиком («GusVoice keeps stopping» поверх
 * рабочего стола). Документация Android прямо требует звать `startForegroundService` для такой службы, пока у приложения
 * есть видимое окно. Голос, начавшийся при скрытой странице (нажал «Присоединиться» и свернул, пока шёл ответ с
 * токеном; авто-возврат в канал после обрыва сети, пока приложение свёрнуто), ждёт `visibilitychange` → `visible`.
 * И на КАЖДОМ возврате на экран, пока идёт голос, старт зовётся снова: нативная сторона при полном типе службы ничего
 * не делает, а если раньше система отказала — поднимает службу или её тип до микрофона (`VoiceForegroundService.kt`).
 * Замер на эмуляторе (Android 16, WebView 145): страница скрывается вместе с `onPause` активности, видимой становится
 * после `onResume` — «видима» здесь и значит «у приложения есть окно на экране».
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

/** Голос идёт — служба нужна: между `startNativeVoiceService` и `stopNativeVoiceService`. */
let wanted = false;
let listening = false;

function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Попросить службу у нативной стороны — если голос идёт и страница на экране. */
function requestStart(): void {
  if (!wanted || pageHidden()) return;
  try {
    bridge()?.startVoiceService();
  } catch (e) {
    console.warn('[native-voice] startVoiceService failed:', e);
  }
}

function onVisibilityChange(): void {
  if (!pageHidden()) requestStart();
}

/** Start the microphone foreground service (on voice join). Best-effort; logs and swallows failures. */
export function startNativeVoiceService(): void {
  if (!bridge()) return;
  wanted = true;
  if (!listening) {
    document.addEventListener('visibilitychange', onVisibilityChange);
    listening = true;
  }
  if (pageHidden()) console.info('[native-voice] page hidden: voice service starts when the app is back on screen (#210)');
  requestStart();
}

/** Stop the microphone foreground service (on voice leave). Best-effort. */
export function stopNativeVoiceService(): void {
  wanted = false;
  if (listening) {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    listening = false;
  }
  try {
    bridge()?.stopVoiceService();
  } catch (e) {
    console.warn('[native-voice] stopVoiceService failed:', e);
  }
}
