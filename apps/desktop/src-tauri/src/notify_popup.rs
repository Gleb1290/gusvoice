//! Свои всплывающие уведомления на ПК (G38, ND-07) — как «свои» уведомления Telegram Desktop
//! (`window/notifications_manager_default.cpp`; на Windows они у Telegram по умолчанию: `ByDefault()` в
//! `platform/win/notifications_manager_win.cpp` = `false`, системные тосты — по галке «Использовать уведомления Windows»).
//!
//! Окно одно на всю стопку (`overlay::NOTIFY`, строится в `setup` вместе с оверлеями): карточки рисует клиент
//! (`?window=notify` → `NotifyPopups.tsx`), он же сообщает размер стопки и угол (`gv_notify_popup_layout`), а мы прижимаем
//! окно к углу РАБОЧЕЙ области выбранного монитора (над панелью задач, как `availableGeometry()` у Telegram в
//! `NotificationDisplayRect`). Данные идут событием из главного окна (`gv_notify_popup_push` → `gv-notify-popup`), действия —
//! обратно тем же событием `gv://notify-action`, что у тоста беседы (`notify_conv.rs`): клиенту новый слушатель не нужен.
//!
//! 🔴 Фокус из игры не уводим: окно показываем `SetWindowPos(HWND_TOPMOST, …, SWP_NOACTIVATE | SWP_SHOWWINDOW)`, а не
//! `show()` Tauri — тот со второго показа зовёт `SW_SHOW` (tao `window_state.rs`: `SW_SHOWNOACTIVATE` только при первом
//! показе окна, собранного с `focused(false)`). Окно стоит под сторожем topmost оверлея (`overlay::guard_hwnd`).
use tauri::{AppHandle, Emitter, Manager};

use crate::overlay::NOTIFY;

/// Отступ стопки от края рабочей области, логические px (Telegram `window/window.style`: `notifyDeltaX: 6px` — сбоку,
/// `notifyDeltaY: 7px` — сверху/снизу; тот же `notifyDeltaY` — промежуток между окнами, он внутри окна, у стопки, в CSS
/// `.nfp-root`). Множится на масштаб монитора (125/150 % Windows), как `st::` у Telegram.
const DELTA_X: f64 = 6.0;
const DELTA_Y: f64 = 7.0;

/// Главное окно → окно уведомлений: показать карточку. Окна нет (сборка без него) — ошибка, клиент покажет системный тост.
#[tauri::command]
pub fn gv_notify_popup_push(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    if app.get_webview_window(NOTIFY).is_none() {
        return Err("no notify window".into());
    }
    app.emit_to(NOTIFY, "gv-notify-popup", payload).map_err(|e| e.to_string())
}

/// Окно уведомлений → действие человека. `open` — поднять главное окно и открыть беседу (обработчик по `tag`), `reply` —
/// ответ из поля карточки. Форма события — та же, что у тоста беседы (`notify_conv::emit`).
#[tauri::command]
pub fn gv_notify_popup_action(app: AppHandle, action: String, tag: String, group: Option<String>, text: Option<String>) {
    let Some(w) = app.get_webview_window("main") else { return };
    if action == "open" {
        crate::set_main_webview_shown(&w, true);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = w.emit(
        "gv://notify-action",
        serde_json::json!({
            "tag": tag,
            "group": group.unwrap_or_default(),
            "action": action,
            "text": text.unwrap_or_default(),
        }),
    );
}

/// Имена мониторов — для выбора в настройках (у Telegram выбор экрана — `notificationsDisplayChecksum`).
#[tauri::command]
pub async fn gv_notify_popup_monitors(app: AppHandle) -> Vec<String> {
    let Some(w) = app.get_webview_window("main") else { return Vec::new() };
    w.available_monitors()
        .map(|list| list.iter().filter_map(|m| m.name().cloned()).collect())
        .unwrap_or_default()
}

/// Окно уведомлений → размер стопки (логические px, уже с масштабом интерфейса клиента — CSS `zoom`) и угол (`tl`/`tr`/`bl`/`br`). `h <= 0` — карточек нет, окно прячем.
/// `monitor` — имя выбранного монитора; нет такого — монитор главного окна (как у Telegram без выбора), потом основной.
/// async: оконные операции из синхронной команды дедлочат событийный цикл Windows (см. `overlay::ensure`).
#[tauri::command]
pub async fn gv_notify_popup_layout(app: AppHandle, w: f64, h: f64, corner: String, monitor: Option<String>) {
    let Some(win) = app.get_webview_window(NOTIFY) else { return };
    if h <= 0.0 || w <= 0.0 {
        hide(&win);
        return;
    }
    let main = app.get_webview_window("main");
    let chosen = monitor.as_deref().filter(|n| !n.is_empty()).and_then(|name| {
        win.available_monitors()
            .ok()?
            .into_iter()
            .find(|m| m.name().map(|s| s.as_str()) == Some(name))
    });
    let mon = chosen
        .or_else(|| main.as_ref().and_then(|m| m.current_monitor().ok().flatten()))
        .or_else(|| win.primary_monitor().ok().flatten());
    let Some(mon) = mon else { return };
    let scale = mon.scale_factor();
    let area = mon.work_area();
    let pw = (w * scale).round() as i32;
    let ph = (h * scale).round() as i32;
    let dx = (DELTA_X * scale).round() as i32;
    let dy = (DELTA_Y * scale).round() as i32;
    let (ax, ay) = (area.position.x, area.position.y);
    let (aw, ah) = (area.size.width as i32, area.size.height as i32);
    let left = corner.ends_with('l');
    let top = corner.starts_with('t');
    // Telegram `notificationStartPosition`: x — от края на `notifyDeltaX`, y — от края на `notifyDeltaY` (`moveWidgets`).
    // Стопка выше/шире рабочей области — прижимаем к её началу, а не уводим за край.
    let x = (if left { ax + dx } else { ax + aw - pw - dx }).max(ax);
    let y = (if top { ay + dy } else { ay + ah - ph - dy }).max(ay);
    place(&win, x, y, pw, ph);
}

/// Показать/сдвинуть окно без активации (Windows) — фокус остаётся у игры. Физические px.
#[cfg(target_os = "windows")]
fn place(win: &tauri::WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    };
    let Ok(hwnd) = win.hwnd() else { return };
    crate::overlay::guard_hwnd(NOTIFY, hwnd.0 as isize);
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        // Переезд на монитор с другим масштабом: Windows шлёт окну WM_DPICHANGED, и tao подгоняет размер (и место) под
        // прежний логический — а мы уже посчитали физический под НОВЫЙ масштаб. Сообщение обрабатывается внутри вызова выше
        // (окно другого потока — SendMessage ждёт), поэтому сверяем итог и ставим прямоугольник ещё раз.
        let mut r = RECT::default();
        if GetWindowRect(hwnd, &mut r).is_ok() && (r.left != x || r.top != y || r.right - r.left != w || r.bottom - r.top != h) {
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn place(win: &tauri::WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
    let _ = win.set_size(tauri::PhysicalSize::new(w.max(1) as u32, h.max(1) as u32));
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = win.show();
    let _ = win.set_always_on_top(true);
}

#[cfg(target_os = "windows")]
fn hide(win: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    let Ok(hwnd) = win.hwnd() else { return };
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
}

#[cfg(not(target_os = "windows"))]
fn hide(win: &tauri::WebviewWindow) {
    let _ = win.hide();
}
