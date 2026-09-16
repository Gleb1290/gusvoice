//! Global push-to-talk for a mouse button, working even when GusVoice ISN'T focused (the user is
//! in a fullscreen game). Window-level mouse listeners in the web client only fire when focused;
//! to catch a bound mouse button system-wide the only Windows option is a low-level mouse hook
//! (`WH_MOUSE_LL`). The hook runs on a dedicated message-pump thread and emits `ptt-down` /
//! `ptt-up` Tauri events to the frontend, which opens/closes the mic (the mic lives in the WebView).
//!
//! We always pass the event through (`CallNextHookEx`), so the game still receives the click — we
//! only observe. The hook is installed lazily the first time a mouse button is bound, and gated by
//! an atomic target button (the bound DOM `MouseEvent.button` index, or -1 to disable emission).
#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::OnceLock;

use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, MSG, MSLLHOOKSTRUCT,
    WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP,
    WM_XBUTTONDOWN, WM_XBUTTONUP,
};

/// Bound PTT button as a DOM `MouseEvent.button` index (0 left, 1 middle, 2 right, 3 X1, 4 X2); -1 = off.
static TARGET: AtomicI32 = AtomicI32::new(-1);
/// Bitmask of buttons bound to mute/deafen/screen-share hotkeys (bit i = DOM button i); 0 = none.
static HK_MASK: AtomicU32 = AtomicU32::new(0);
static INSTALLED: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<AppHandle> = OnceLock::new();

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let target = TARGET.load(Ordering::Relaxed);
        let mask = HK_MASK.load(Ordering::Relaxed);
        if target >= 0 || mask != 0 {
            let info = lparam.0 as *const MSLLHOOKSTRUCT;
            // For X-button messages the high word of mouseData is the X button (1 = X1, 2 = X2).
            let xbtn = if info.is_null() { 0 } else { (((*info).mouseData >> 16) & 0xFFFF) as i32 };
            let (btn, down) = match wparam.0 as u32 {
                WM_LBUTTONDOWN => (0, true),
                WM_LBUTTONUP => (0, false),
                WM_MBUTTONDOWN => (1, true),
                WM_MBUTTONUP => (1, false),
                WM_RBUTTONDOWN => (2, true),
                WM_RBUTTONUP => (2, false),
                WM_XBUTTONDOWN => (2 + xbtn, true), // X1 -> 3, X2 -> 4 (matches DOM MouseEvent.button)
                WM_XBUTTONUP => (2 + xbtn, false),
                _ => (-1, false),
            };
            if btn >= 0 {
                if let Some(app) = APP.get() {
                    // Push-to-talk: the single bound button drives mic open/close.
                    if btn == target {
                        let _ = app.emit(if down { "ptt-down" } else { "ptt-up" }, ());
                    }
                    // Hotkeys: any button in the mask drives a mute/deafen/screen-share toggle. We send the
                    // button index so the frontend can route it to the right action.
                    if btn < 32 && (mask >> (btn as u32)) & 1 != 0 {
                        let _ = app.emit(if down { "hk-mouse-down" } else { "hk-mouse-up" }, btn);
                    }
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

fn ensure_installed() {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return; // already running
    }
    // The hook callback runs on the thread that installed it, which must pump messages.
    std::thread::spawn(|| unsafe {
        let Ok(_hook) = SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), None, 0) else {
            INSTALLED.store(false, Ordering::SeqCst);
            return;
        };
        let mut msg: MSG = std::mem::zeroed();
        // Never posts WM_QUIT — runs until the process exits (Windows uninstalls LL hooks on exit).
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

/// Remember the app handle so the hook thread can emit `ptt-down` / `ptt-up` to the frontend.
pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}

/// Set the bound PTT mouse button (DOM `MouseEvent.button` index; < 0 disables). Installs the hook lazily.
pub fn set_mouse_button(button: i32) {
    TARGET.store(button, Ordering::Relaxed);
    if button >= 0 {
        ensure_installed();
    }
}

/// Set the bitmask of mouse buttons bound to mute/deafen/screen-share hotkeys (bit i = DOM button i).
/// 0 disables hotkey emission. Installs the hook lazily.
pub fn set_hotkey_mask(mask: u32) {
    HK_MASK.store(mask, Ordering::Relaxed);
    if mask != 0 {
        ensure_installed();
    }
}
