//! Overlay app-picker (Windows-only): enumerate the visible top-level windows the user has open,
//! resolve each to its owning exe, dedupe, and pull the exe's icon into a PNG data-URL. Feeds the
//! settings picker where the user chooses which apps the overlay shows over ("выбранные приложения").
//! Best-effort throughout — a window/process/icon we can't read is skipped, never fatal.
use base64::Engine;
use serde::Serialize;
use std::collections::BTreeMap;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, TRUE};
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    DIB_RGB_COLORS, HGDIOBJ,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, EnumWindows, GetIconInfo, GetWindow, GetWindowLongPtrW, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, GET_WINDOW_CMD, GWL_EXSTYLE,
    ICONINFO, WS_EX_TOOLWINDOW,
};

#[derive(Serialize)]
pub struct AppEntry {
    /// Lowercased exe basename, e.g. "cs2.exe" — the key matched against the foreground process.
    pub exe: String,
    /// Window title (falls back to the exe stem) — the human label in the picker.
    pub name: String,
    /// `data:image/png;base64,…` of the exe icon, or null if it couldn't be extracted.
    pub icon: Option<String>,
}

struct EnumState {
    apps: BTreeMap<String, (String, String)>, // exe-basename -> (full path, title)
    self_pid: u32,
}

const GW_OWNER: GET_WINDOW_CMD = GET_WINDOW_CMD(4);

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
    let state = &mut *(lparam.0 as *mut EnumState);
    // Alt-tab-window heuristic: visible, has a title, not a tool window, no owner (skips dialogs/popups).
    if !IsWindowVisible(hwnd).as_bool() {
        return TRUE;
    }
    if GetWindowTextLengthW(hwnd) == 0 {
        return TRUE;
    }
    let exstyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    if exstyle & WS_EX_TOOLWINDOW.0 != 0 {
        return TRUE;
    }
    if let Ok(owner) = GetWindow(hwnd, GW_OWNER) {
        if !owner.0.is_null() {
            return TRUE; // owned (dialog/tooltip) — not a main app window
        }
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 || pid == state.self_pid {
        return TRUE;
    }
    let Some(path) = exe_of_pid(pid) else {
        return TRUE;
    };
    let key = path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(&path)
        .to_lowercase();
    if key.is_empty() || key == "gusvoice.exe" {
        return TRUE;
    }
    if state.apps.contains_key(&key) {
        return TRUE;
    }
    state.apps.insert(key, (path, window_title(hwnd)));
    TRUE
}

unsafe fn exe_of_pid(pid: u32) -> Option<String> {
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; 260];
    let mut len = buf.len() as u32;
    let res = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
    let _ = CloseHandle(handle);
    res.ok()?;
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

unsafe fn window_title(hwnd: HWND) -> String {
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; len as usize + 1];
    let n = GetWindowTextW(hwnd, &mut buf);
    String::from_utf16_lossy(&buf[..n as usize])
}

/// Extract an exe's icon as a PNG data-URL (best-effort — None on any failure).
unsafe fn icon_data_url(exe_path: &str) -> Option<String> {
    let wide: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut shfi = SHFILEINFOW::default();
    let ok = SHGetFileInfoW(
        PWSTR(wide.as_ptr() as *mut u16),
        Default::default(),
        Some(&mut shfi),
        std::mem::size_of::<SHFILEINFOW>() as u32,
        SHGFI_ICON | SHGFI_LARGEICON,
    );
    if ok == 0 || shfi.hIcon.is_invalid() {
        return None;
    }
    let png = hicon_to_png(shfi.hIcon);
    let _ = DestroyIcon(shfi.hIcon);
    let bytes = png?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

unsafe fn hicon_to_png(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<Vec<u8>> {
    let mut ii = ICONINFO::default();
    GetIconInfo(hicon, &mut ii).ok()?;
    let mut bm = BITMAP::default();
    GetObjectW(
        HGDIOBJ(ii.hbmColor.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bm as *mut _ as *mut core::ffi::c_void),
    );
    let (w, h) = (bm.bmWidth, bm.bmHeight);
    if w <= 0 || h <= 0 {
        let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
        let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
        return None;
    }
    let mut header = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h, // top-down
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0, // BI_RGB
        ..Default::default()
    };
    let mut bmi = BITMAPINFO {
        bmiHeader: header,
        ..Default::default()
    };
    let px = (w * h) as usize;
    let mut color = vec![0u8; px * 4];
    let hdc = GetDC(None);
    let got = GetDIBits(
        hdc,
        ii.hbmColor,
        0,
        h as u32,
        Some(color.as_mut_ptr() as *mut core::ffi::c_void),
        &mut bmi,
        DIB_RGB_COLORS,
    );
    // If the color bitmap carries no alpha, derive it from the AND mask.
    let mut has_alpha = false;
    for i in 0..px {
        if color[i * 4 + 3] != 0 {
            has_alpha = true;
            break;
        }
    }
    let mut mask = vec![0u8; px * 4];
    if !has_alpha {
        header.biHeight = -h;
        let mut bmi_m = BITMAPINFO {
            bmiHeader: header,
            ..Default::default()
        };
        GetDIBits(
            hdc,
            ii.hbmMask,
            0,
            h as u32,
            Some(mask.as_mut_ptr() as *mut core::ffi::c_void),
            &mut bmi_m,
            DIB_RGB_COLORS,
        );
    }
    let _ = ReleaseDC(None, hdc);
    let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
    let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
    if got == 0 {
        return None;
    }
    // BGRA (bottom origin already flipped by negative height) → RGBA.
    let mut rgba = vec![0u8; px * 4];
    for i in 0..px {
        let b = color[i * 4];
        let g = color[i * 4 + 1];
        let r = color[i * 4 + 2];
        let a = if has_alpha {
            color[i * 4 + 3]
        } else {
            // AND mask: white (non-zero) = transparent, black (0) = opaque.
            if mask[i * 4] == 0 {
                255
            } else {
                0
            }
        };
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = a;
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
    }
    Some(out)
}

/// Enumerate the user's currently-open apps (deduped by exe), each with a name + icon.
pub fn list_apps() -> Vec<AppEntry> {
    let self_pid = unsafe { GetCurrentProcessId() };
    let mut state = EnumState {
        apps: BTreeMap::new(),
        self_pid,
    };
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut state as *mut _ as isize));
    }
    let mut out: Vec<AppEntry> = state
        .apps
        .into_iter()
        .map(|(exe, (path, title))| {
            let name = if title.trim().is_empty() {
                exe.trim_end_matches(".exe").to_string()
            } else {
                title
            };
            let icon = unsafe { icon_data_url(&path) };
            AppEntry { exe, name, icon }
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// The exe basename (lowercased) of the current foreground window — drives the "выбранные приложения"
/// overlay mode. None if there's no foreground window or we can't read its process.
pub fn foreground_exe() -> Option<String> {
    unsafe {
        let hwnd = windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let path = exe_of_pid(pid)?;
        Some(
            path.rsplit(['\\', '/'])
                .next()
                .unwrap_or(&path)
                .to_lowercase(),
        )
    }
}

/// Foreground window info for the "stream the focused window" hotkey. `id` is the HWND as a
/// stringified u64 — the SAME id space libwebrtc's window capturer uses, so it feeds straight into
/// screenshare `StartConfig { source_id, is_window: true }`. `is_self` is true when GusVoice's own
/// window is in front; the caller then opens the picker instead of streaming ourselves.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundWindow {
    pub id: String,
    pub exe: String,
    pub is_self: bool,
}

pub fn foreground_window() -> Option<ForegroundWindow> {
    unsafe {
        let hwnd = windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let exe = match exe_of_pid(pid) {
            Some(path) => path.rsplit(['\\', '/']).next().unwrap_or(&path).to_lowercase(),
            None => String::new(),
        };
        Some(ForegroundWindow {
            id: (hwnd.0 as usize as u64).to_string(),
            exe,
            is_self: pid == GetCurrentProcessId(),
        })
    }
}

/// PID owning a top-level window (HWND as u64) — used to scope stream audio to that window's process
/// tree (WASAPI process-loopback INCLUDE mode). None if the handle is dead / has no process.
pub fn window_pid(hwnd_u64: u64) -> Option<u32> {
    unsafe {
        let hwnd = HWND(hwnd_u64 as usize as *mut core::ffi::c_void);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            None
        } else {
            Some(pid)
        }
    }
}
