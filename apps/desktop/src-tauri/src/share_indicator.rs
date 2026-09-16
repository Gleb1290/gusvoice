//! Hide Chromium's "<origin> is sharing your screen" indicator window while a screen share is active.
//! It's a separate top-level WebView2 window (confirmed in Alt+Tab); we find it by title and hide it,
//! with a background watcher that re-hides it if Chromium shows it again.
//!
//! IMPORTANT — we must NOT use `ShowWindow(SW_HIDE)`: per MSDN it "hides the window AND activates
//! another window", i.e. it steals the foreground. Doing that every poll while a fullscreen game is
//! running repeatedly kicks the game out of exclusive fullscreen and wedges the shell — the taskbar
//! gets stuck on top of everything and Alt+Tab dies until explorer is restarted / the PC reboots.
//! Instead we hide via `SetWindowPos(SWP_HIDEWINDOW | SWP_NOACTIVATE | SWP_NOZORDER)`, which hides
//! the window WITHOUT touching activation or Z order (MSDN: SWP_NOACTIVATE "Does not activate the
//! window"). Was the cause of the long-stream Alt+Tab/taskbar breakage.
#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible, SetWindowPos, SWP_HIDEWINDOW,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
};

static HIDER_STOP: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

// Substrings of the indicator window's title. The origin ("tauri.localhost") is the most reliable;
// the others cover localisations of "… is sharing your screen".
const NEEDLES: &[&str] = &["tauri.localhost", "предоставляет доступ", "is sharing", "sharing your screen"];

unsafe extern "system" fn enum_proc(hwnd: HWND, _l: LPARAM) -> BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return BOOL(1);
    }
    let mut buf = vec![0u16; len as usize + 1];
    let n = GetWindowTextW(hwnd, &mut buf);
    let title = String::from_utf16_lossy(&buf[..n as usize]);
    if NEEDLES.iter().any(|needle| title.contains(needle)) {
        // Hide WITHOUT activating another window or changing Z order (see the module note on why
        // SW_HIDE is forbidden here). The IsWindowVisible guard above means we only act when
        // Chromium has (re)shown it, so this fires at most once per show — not on every poll.
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_HIDEWINDOW | SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOMOVE | SWP_NOSIZE,
        );
    }
    BOOL(1) // keep enumerating
}

fn hide_once() {
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(0));
    }
}

/// Begin hiding the share-indicator window. Spawns a watcher that re-hides it (~2×/s) until stopped,
/// since the bar appears a beat after capture starts and Chromium may re-show it. The hide itself is
/// non-activating (see module note), so the poll rate is only about how fast we catch a (re)show.
pub fn start_hiding() {
    stop_hiding();
    let stop = Arc::new(AtomicBool::new(false));
    if let Ok(mut g) = HIDER_STOP.lock() {
        *g = Some(stop.clone());
    }
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            hide_once();
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

pub fn stop_hiding() {
    if let Ok(mut g) = HIDER_STOP.lock() {
        if let Some(stop) = g.take() {
            stop.store(true, Ordering::Relaxed);
        }
    }
}
