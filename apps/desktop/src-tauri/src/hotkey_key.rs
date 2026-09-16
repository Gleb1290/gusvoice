//! Global KEYBOARD hotkeys (mute / deafen / screen-share / overlay) that fire even when GusVoice
//! ISN'T focused — WITHOUT stealing the key from every other app. Tauri's global-shortcut plugin
//! uses Win32 `RegisterHotKey`, which EXCLUSIVELY grabs the key: bind e.g. Numpad `+` and it stops
//! typing anywhere else (calculator, editors, games). Instead we use a low-level keyboard hook
//! (`WH_KEYBOARD_LL`), the same observe-don't-consume approach as the mouse PTT hook (`ptt_mouse`):
//! read the keypress, ALWAYS pass it through (`CallNextHookEx`) so the key still works everywhere,
//! and only emit `hk-key-down` to the frontend for keys the user actually bound.
//!
//! Bindings arrive from the frontend already packed as `(mods << 16) | vk` — `mods` bits CTRL=1,
//! ALT=2, SHIFT=4, META=8; `vk` a Windows virtual-key code. We recover the live modifier state with
//! `GetAsyncKeyState` at press time and match EXACTLY (a bare "M" won't fire an "Alt+M" binding).
#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::OnceLock;

use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, KBDLLHOOKSTRUCT,
    MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

const MOD_CTRL: u32 = 1;
const MOD_ALT: u32 = 2;
const MOD_SHIFT: u32 = 4;
const MOD_META: u32 = 8;

const SLOTS: usize = 8;
/// Up to 8 bound hotkeys, each packed `(mods << 16) | vk`; 0 = empty slot. (Only 4 exist today.)
static BINDINGS: [AtomicU32; SLOTS] = [
    AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0),
    AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0),
];
/// 256-bit "currently held" set keyed by vk — edge-triggers `hk-key-down`, ignoring key auto-repeat.
static PRESSED: [AtomicU64; 4] =
    [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)];
static ANY: AtomicBool = AtomicBool::new(false);
/// Отметка времени (`GetTickCount`) последнего ВЫЗОВА хука — не срабатывания привязки, а именно
/// вызова системой.
///
/// 🔴 Нужна для диагностики #100. Windows молча выбрасывает низкоуровневый хук из цепочки, если тот
/// не ответил за `LowLevelHooksTimeout`: приложение продолжает работать, а хоткеи просто перестают
/// приходить, и отличить это от «человек не нажимал» изнутри невозможно. Сравнив это время с
/// системным временем последнего ввода (`GetLastInputInfo`), получаем прямой ответ: если человек
/// вводит, а хук молчит — его выбросили.
static LAST_HOOK_TICK: AtomicU32 = AtomicU32::new(0);

/// `GetTickCount` последнего вызова хука; `0` — хук не вызывался ни разу (не установлен).
/// Читает только диагностика (#113) — без её фичи не вызывается.
#[cfg_attr(not(feature = "diag"), allow(dead_code))]
pub fn last_hook_tick() -> u32 {
    LAST_HOOK_TICK.load(Ordering::Relaxed)
}
/// PTT KEYBOARD binding: Windows virtual-key of the push-to-talk key (0 = none), plus its held state
/// so we edge-trigger `ptt-key-down` / `ptt-key-up`. Unlike toggle hotkeys, PTT needs BOTH edges (open
/// the mic while held, close on release) and must work while GusVoice isn't focused.
static PTT_KEY: AtomicU32 = AtomicU32::new(0);
static PTT_HELD: AtomicBool = AtomicBool::new(false);
static INSTALLED: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<AppHandle> = OnceLock::new();

unsafe fn key_down(vk: i32) -> bool {
    (GetAsyncKeyState(vk) as u16 & 0x8000) != 0
}

/// Live modifier bitmask (matches the frontend's packing) via `GetAsyncKeyState` at press time.
unsafe fn current_mods() -> u32 {
    let mut m = 0;
    if key_down(VK_CONTROL.0 as i32) {
        m |= MOD_CTRL;
    }
    if key_down(VK_MENU.0 as i32) {
        m |= MOD_ALT;
    }
    if key_down(VK_SHIFT.0 as i32) {
        m |= MOD_SHIFT;
    }
    if key_down(VK_LWIN.0 as i32) || key_down(VK_RWIN.0 as i32) {
        m |= MOD_META;
    }
    m
}

/// True for bare modifier virtual-keys (Ctrl/Shift/Alt + L/R variants, Win keys) — never a hotkey's main key.
fn is_modifier_vk(vk: u32) -> bool {
    matches!(vk,
        0x10 | 0xA0 | 0xA1 | // SHIFT / LSHIFT / RSHIFT
        0x11 | 0xA2 | 0xA3 | // CONTROL / LCONTROL / RCONTROL
        0x12 | 0xA4 | 0xA5 | // MENU(Alt) / LMENU / RMENU
        0x5B | 0x5C          // LWIN / RWIN
    )
}

/// Mark `vk` pressed; returns the PREVIOUS state (true = was already down → this is an auto-repeat).
fn press(vk: u32) -> bool {
    let (i, bit) = ((vk / 64) as usize, 1u64 << (vk % 64));
    if i >= 4 {
        return false;
    }
    (PRESSED[i].fetch_or(bit, Ordering::Relaxed) & bit) != 0
}
fn release(vk: u32) {
    let (i, bit) = ((vk / 64) as usize, 1u64 << (vk % 64));
    if i < 4 {
        PRESSED[i].fetch_and(!bit, Ordering::Relaxed);
    }
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    'done: {
        if code < 0 {
            break 'done;
        }
        // Отмечаем ЛЮБОЙ вызов, до всех проверок привязок: смысл метки — «система нас ещё зовёт»,
        // а не «сработал хоткей». С привязками или без, выброшенный хук перестаёт её обновлять.
        LAST_HOOK_TICK.store(unsafe { GetTickCount() }, Ordering::Relaxed);
        if !ANY.load(Ordering::Relaxed) && PTT_KEY.load(Ordering::Relaxed) == 0 {
            break 'done;
        }
        let is_up = match wparam.0 as u32 {
            WM_KEYDOWN | WM_SYSKEYDOWN => false,
            WM_KEYUP | WM_SYSKEYUP => true,
            _ => break 'done,
        };
        let info = lparam.0 as *const KBDLLHOOKSTRUCT;
        if info.is_null() {
            break 'done;
        }
        let vk = (*info).vkCode & 0xFFFF;
        if is_modifier_vk(vk) {
            break 'done;
        }
        // Push-to-talk KEYBOARD key: emit down/up (edge-triggered via PTT_HELD, so auto-repeat while
        // held doesn't spam). This runs even when GusVoice isn't focused; the frontend's `held` guard
        // de-dups against the focused window keydown/keyup path. Falls through so the key is still
        // passed on and the (non-matching) toggle-hotkey logic below stays harmless.
        let ptt = PTT_KEY.load(Ordering::Relaxed);
        if ptt != 0 && ptt == vk {
            if is_up {
                if PTT_HELD.swap(false, Ordering::Relaxed) {
                    if let Some(app) = APP.get() {
                        let _ = app.emit("ptt-key-up", ());
                    }
                }
            } else if !PTT_HELD.swap(true, Ordering::Relaxed) {
                if let Some(app) = APP.get() {
                    let _ = app.emit("ptt-key-down", ());
                }
            }
        }
        if is_up {
            release(vk); // clear the debounce bit; toggles fire on press only, so we don't emit up
            break 'done;
        }
        if press(vk) {
            break 'done; // key auto-repeat while held → already emitted on the first down
        }
        let packed = (current_mods() << 16) | vk;
        for slot in BINDINGS.iter() {
            if slot.load(Ordering::Relaxed) == packed {
                if let Some(app) = APP.get() {
                    let _ = app.emit("hk-key-down", packed);
                }
                break;
            }
        }
    }
    // ALWAYS pass the event through — we only observe, never swallow (unlike RegisterHotKey).
    CallNextHookEx(None, code, wparam, lparam)
}

fn ensure_installed() {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return; // already running
    }
    // The hook callback runs on the thread that installed it, which must pump messages.
    std::thread::spawn(|| unsafe {
        let Ok(_hook) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) else {
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

/// Remember the app handle so the hook thread can emit `hk-key-down` to the frontend.
pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}

/// Set the bound keyboard hotkeys (each packed `(mods << 16) | vk`; zero/empty entries ignored).
/// Installs the hook lazily the first time a key is bound; an empty list disables emission.
pub fn set_keys(keys: Vec<u32>) {
    let mut any = false;
    for (i, slot) in BINDINGS.iter().enumerate() {
        let v = keys.get(i).copied().filter(|&v| v != 0).unwrap_or(0);
        slot.store(v, Ordering::Relaxed);
        if v != 0 {
            any = true;
        }
    }
    ANY.store(any, Ordering::Relaxed);
    if any {
        ensure_installed();
    }
}

/// Set the PTT keyboard key (Windows virtual-key; 0 disables). Installs the hook lazily. While the key
/// is held the hook emits `ptt-key-down` / `ptt-key-up` so push-to-talk works when GusVoice isn't
/// focused (e.g. in a fullscreen game), and a release is seen even if focus changed mid-hold.
pub fn set_ptt_key(vk: u32) {
    PTT_KEY.store(vk, Ordering::Relaxed);
    if vk == 0 {
        PTT_HELD.store(false, Ordering::Relaxed); // clear any stale held state on unbind
    } else {
        ensure_installed();
    }
}
