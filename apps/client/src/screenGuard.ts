/**
 * Запрет снимков экрана на время просмотра одноразового фото/видео (19.10, #226; Telegram Android `PhotoViewer` ставит
 * `FLAG_SECURE`, tdesktop — `SetWindowDisplayAffinity` `platform/win/specific_win.cpp`; Android `PhotoViewer.java:17445`). Android — мост
 * `GusVoiceNative.setSecure(on)` (`MainActivity.NativeBridge`, флаг окна активности); десктоп — `setContentProtected`
 * главного окна Tauri (право `core:window:allow-set-content-protected`, `capabilities/desktop.json`). В браузере запретить
 * снимок нельзя — ничего. Счётчик: два просмотра подряд не снимают защиту друг у друга.
 */
let holders = 0;

interface NativeSecure {
  setSecure?: (on: boolean) => void;
}
interface TauriWindowGlobal {
  __TAURI__?: { window?: { getCurrentWindow?: () => { setContentProtected?: (on: boolean) => Promise<void> } } };
}

function apply(on: boolean): void {
  try {
    (window as unknown as { GusVoiceNative?: NativeSecure }).GusVoiceNative?.setSecure?.(on);
  } catch {
    /* старая оболочка Android без метода */
  }
  try {
    void (window as unknown as TauriWindowGlobal).__TAURI__?.window?.getCurrentWindow?.()?.setContentProtected?.(on)?.catch(() => {});
  } catch {
    /* не десктоп или нет права */
  }
}

/** Включить защиту; вернёт функцию снятия (повторный вызов безвреден). */
export function protectScreen(): () => void {
  holders++;
  if (holders === 1) apply(true);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0) apply(false);
  };
}
