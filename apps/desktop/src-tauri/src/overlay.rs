//! In-game voice overlay: a second, borderless, transparent, always-on-top window that renders a
//! compact "who's in voice / who's speaking" widget on top of other apps. It is click-through by
//! default (mouse passes straight through) and only grabs the cursor while the user is positioning it.
//!
//! Architecture: the MAIN window stays the single source of truth (one LiveKit connection). It pushes
//! the voice roster + the same local-VAD speaking signal that lights the avatar ring / tray into this
//! window via `emit_to("overlay", "gv-overlay-state", …)` (see client `overlay.ts` ↔ `VoiceOverlay.tsx`).
//! The overlay window itself holds NO connection — it just renders what it's told.
//!
//! Only works over windowed / borderless-fullscreen apps (an always-on-top window can't draw above an
//! EXCLUSIVE-fullscreen swapchain — that would need DLL injection, which we deliberately avoid). Desktop
//! only; the whole module is `#[cfg(desktop)]`.
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

/// Метки окон. Их ДВА, и модуль работает с обоими одинаково.
///
/// 🔴 Почему параметр, а не копия модуля. Здесь собран дорого доставшийся опыт: правило «строить окно
/// только из `setup`» (сборка из синхронной команды дедлочит событийный цикл Windows), сторож
/// topmost-группы с разбором Z-порядка и двухшаговый `SetWindowPos`. Второй экземпляр этого кода
/// разошёлся бы с первым при первой же правке, и разошёлся бы молча — окно просто перестало бы
/// всплывать поверх игры, как это уже было.
pub const ROSTER: &str = "overlay";
pub const TOAST: &str = "toast";

/// Слот сторожа под метку: у каждого окна свой HWND.
fn slot_of(label: &str) -> usize {
    if label == TOAST {
        1
    } else {
        0
    }
}

/// Адрес окна и его стартовый размер. Стартовый нужен только чтобы окно не родилось нулевым — обе
/// поверхности сразу сообщают свой настоящий размер (`set_size`).
fn spec(label: &str) -> (String, f64, f64) {
    if label == TOAST {
        ("index.html?window=toast".into(), 420.0, 120.0)
    } else {
        ("index.html?window=overlay".into(), 240.0, 140.0)
    }
}

/// Corner the overlay anchors to. Bit-parsed from a short string sent by the client.
enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    /// По центру сверху и ровно посередине экрана — для КРУПНОЙ плашки, которую надо заметить,
    /// не отводя глаз от середины экрана. Углы для неё плохи ровно тем, чем хороши для ростера.
    TopCenter,
    Center,
}
impl Corner {
    fn parse(s: &str) -> Corner {
        match s {
            "tl" => Corner::TopLeft,
            "bl" => Corner::BottomLeft,
            "br" => Corner::BottomRight,
            "tc" => Corner::TopCenter,
            "c" => Corner::Center,
            _ => Corner::TopRight, // default / "tr"
        }
    }
}

/// Fetch the already-created overlay window WITHOUT building it. Commands MUST use this, never
/// `ensure()` — building a WebviewWindow from a (sync) command deadlocks the event loop on Windows
/// (Webview2 issue). The window is created once in `ensure()` from the setup hook (the safe place).
fn get(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    app.get_webview_window(label)
}

/// Create the overlay window (hidden, click-through). **ONLY call from the `setup` hook** — building a
/// window from a synchronous command/event-handler deadlocks the Windows event loop.
pub fn ensure(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(label) {
        return Ok(w);
    }
    // A dedicated frontend entry (main.tsx routes on `?window=…`) renders just the widget.
    let (url, w0, h0) = spec(label);
    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("GusVoice Overlay")
        // Small initial size — the window reports its real content size via set_size and shrinks to fit
        // (so its transparent bounds don't eat clicks while positioning).
        .inner_size(w0, h0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .visible(false)
        .focused(false)
        .build()?;
    // Click-through by default: the mouse passes through to the game underneath.
    let _ = win.set_ignore_cursor_events(true);
    Ok(win)
}

pub fn show(app: &AppHandle, label: &str) -> tauri::Result<()> {
    let Some(win) = get(app, label) else {
        return Ok(());
    };
    win.show()?;
    // Re-assert topmost — some fullscreen apps steal it on focus changes.
    let _ = win.set_always_on_top(true);
    // ...но одного раза мало: к моменту показа игра ещё не на переднем плане, а выбрасывает нас она
    // позже. Дальше следит сторож (см. `start_topmost_guard`).
    #[cfg(target_os = "windows")]
    if let Ok(h) = win.hwnd() {
        HWNDS[slot_of(label)].store(h.0 as isize, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

// ─────────────────── Возврат оверлея «поверх всех», когда игра его выбросила ───────────────────

/// HWND окна оверлея, снятый в `show`. Сторож ниже работает ТОЛЬКО через WinAPI и намеренно не
/// обращается к Tauri из своего потока: в этом модуле работа с окном из синхронного контекста уже
/// приводила к дедлоку событийного цикла (см. шапку `ensure`).
#[cfg(target_os = "windows")]
static HWNDS: [std::sync::atomic::AtomicIsize; 2] = [
    std::sync::atomic::AtomicIsize::new(0),
    std::sync::atomic::AtomicIsize::new(0),
];

/// Мы «просели», если ВЫШЕ нас в Z-порядке есть видимое окно без `WS_EX_TOPMOST`. По правилам Windows
/// такого быть не может — topmost-окна всегда выше обычных, — значит нас оттуда выбросили.
#[cfg(target_os = "windows")]
unsafe fn dropped_below_normal(me: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetTopWindow, GetWindow, GetWindowLongPtrW, IsWindowVisible, GWL_EXSTYLE, GW_HWNDNEXT,
        WS_EX_TOPMOST,
    };
    let Ok(mut cur) = GetTopWindow(None) else {
        return false;
    };
    // Потолок обхода: на рабочем столе с открытыми чатами и браузером окон бывает под четыре сотни,
    // а нам важно лишь то, что выше нас — до себя мы дойдём в первых десятках.
    for _ in 0..500 {
        if cur.is_invalid() || cur == me {
            return false;
        }
        if IsWindowVisible(cur).as_bool() && (GetWindowLongPtrW(cur, GWL_EXSTYLE) as u32) & WS_EX_TOPMOST.0 == 0
        {
            return true;
        }
        let Ok(next) = GetWindow(cur, GW_HWNDNEXT) else {
            return false;
        };
        cur = next;
    }
    false
}

/// Вернуть окно на вершину.
///
/// ⚠️ Ровно ДВА шага: сначала снять topmost, потом поставить заново. Повторный `HWND_TOPMOST` на окне,
/// у которого бит уже стоит, система считает пустой операцией и Z-порядок не переставляет — а бит у
/// нас как раз и остаётся стоять, теряется только позиция. Проверено вживую поверх Таркова: одним
/// шагом окно не всплывает, двумя — поднимается со 118-го места на 4-е.
///
/// `SWP_NOACTIVATE` обязателен: без него оверлей уведёт фокус из игры (для человека — вылет на
/// рабочий стол посреди боя), а `SWP_NOMOVE|SWP_NOSIZE` сохраняют выбранное им положение.
#[cfg(target_os = "windows")]
unsafe fn reassert_topmost(me: windows::Win32::Foundation::HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
    let _ = SetWindowPos(me, Some(HWND_NOTOPMOST), 0, 0, 0, 0, flags);
    let _ = SetWindowPos(me, Some(HWND_TOPMOST), 0, 0, 0, 0, flags);
}

/// Сторож: пока оверлей показан, возвращает его наверх, если игра выбросила.
///
/// Зачем вообще: полноэкранные игры (и их защита) чистят чужие оверлеи, снимая им позицию в
/// topmost-группе. Бит в стилях при этом остаётся, поэтому со стороны кода всё выглядит исправным —
/// окно живое, видимое, «поверх всех», — а человек его не видит. Именно так оверлей «сломался» после
/// того, как им перестали пользоваться вне игр.
///
/// Толкаем ТОЛЬКО когда реально просели: безусловный `SetWindowPos` дважды в секунду заставляет окно
/// моргать. Секунда с небольшим — компромисс между «не мигает» и «не приходится ждать».
#[cfg(target_os = "windows")]
pub fn start_topmost_guard() {
    use std::sync::atomic::Ordering;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_millis(1200));
        // Оба окна одним проходом: их всего два, и просесть может любое.
        for slot in HWNDS.iter() {
            let raw = slot.load(Ordering::Relaxed);
            if raw == 0 {
                continue; // окно ещё ни разу не показывали
            }
            let hwnd = HWND(raw as *mut core::ffi::c_void);
            unsafe {
                // Скрытое окно поднимать не нужно — вылезет поверх игры, когда его не просили.
                if IsWindowVisible(hwnd).as_bool() && dropped_below_normal(hwnd) {
                    reassert_topmost(hwnd);
                }
            }
        }
    });
}

pub fn hide(app: &AppHandle, label: &str) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(label) {
        win.hide()?;
    }
    Ok(())
}

/// Toggle whether the overlay catches the mouse. `interactive=true` (positioning mode) lets the user
/// drag it (via a `data-tauri-drag-region`); `false` restores click-through so it never blocks the game.
pub fn set_interactive(app: &AppHandle, label: &str, interactive: bool) -> tauri::Result<()> {
    let Some(win) = get(app, label) else {
        return Ok(());
    };
    win.set_ignore_cursor_events(!interactive)?;
    if interactive {
        let _ = win.set_focus();
    }
    Ok(())
}

/// Read the overlay's current top-left (physical px) — used to persist a drag-positioned overlay.
pub fn position(app: &AppHandle, label: &str) -> tauri::Result<(i32, i32)> {
    let Some(win) = get(app, label) else {
        return Ok((0, 0));
    };
    let p = win.outer_position()?;
    Ok((p.x, p.y))
}

/// Resize the overlay window to fit its content (logical px). Keeps the transparent, click-catching
/// area (while positioning = interactive) tight to the card instead of a big dead zone that eats clicks.
pub fn set_size(app: &AppHandle, label: &str, w: f64, h: f64) -> tauri::Result<()> {
    let Some(win) = get(app, label) else {
        return Ok(());
    };
    win.set_size(LogicalSize::new(w.max(1.0), h.max(1.0)))?;
    Ok(())
}

/// Move the overlay to an absolute physical position (a persisted custom / dragged position).
pub fn set_position(app: &AppHandle, label: &str, x: i32, y: i32) -> tauri::Result<()> {
    let Some(win) = get(app, label) else {
        return Ok(());
    };
    win.set_position(PhysicalPosition::new(x, y))?;
    Ok(())
}

/// Anchor the overlay to a screen corner with a pixel margin (physical pixels).
pub fn set_corner(app: &AppHandle, label: &str, corner: &str, margin_x: i32, margin_y: i32) -> tauri::Result<()> {
    let Some(win) = get(app, label) else {
        return Ok(());
    };
    let Some(mon) = win.primary_monitor()? else {
        return Ok(());
    };
    let ms = mon.size();
    let ws = win.outer_size()?;
    let (mw, mh) = (ms.width as i32, ms.height as i32);
    let (ww, wh) = (ws.width as i32, ws.height as i32);
    let (x, y) = match Corner::parse(corner) {
        Corner::TopLeft => (margin_x, margin_y),
        Corner::TopRight => (mw - ww - margin_x, margin_y),
        Corner::BottomLeft => (margin_x, mh - wh - margin_y),
        Corner::BottomRight => (mw - ww - margin_x, mh - wh - margin_y),
        // ⚠️ Отступ по горизонтали для центра НЕ применяем: «по центру со смещением» — это уже не
        // центр, и ползунок отступа выглядел бы сломанным. По вертикали он осмыслен.
        Corner::TopCenter => ((mw - ww) / 2, margin_y),
        Corner::Center => ((mw - ww) / 2, (mh - wh) / 2),
    };
    win.set_position(PhysicalPosition::new(x, y))?;
    Ok(())
}
