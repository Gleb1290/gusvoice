//! Своя полоса окна (#219): меню раскладок Windows 11 (Snap Layouts) над НАШЕЙ кнопкой «Развернуть».
//!
//! У главного окна `decorations: false` (оба конфига), полосу с кнопками рисует клиент
//! (`WindowTitleBar.tsx`). Растягивание за края, тень, скругления, Aero Snap и развёрнутое окно ровно по
//! рабочей области делают сами tao и tauri-runtime-wry (`WM_NCCALCSIZE` по `rcWork` и дочернее окно
//! `TAURI_DRAG_RESIZE_BORDERS`). Не умеют они одного: меню раскладок Windows показывает только окну,
//! которое на `WM_NCHITTEST` отвечает `HTMAXBUTTON`, — а мышь над полосой получает дочернее окно
//! WebView2, и ни HTML, ни CSS этот ответ дать не могут.
//!
//! 🔴 Сабклассить окна WebView2 бесполезно (ввод Chromium ходит своими путями), поэтому — тот же приём,
//! что у самого Tauri для краёв: своё прозрачное дочернее окно ровно над кнопкой «Развернуть», которое
//! на hit-test всегда отвечает `HTMAXBUTTON` (разбор ловушек — dev.to/zbrooklyn «Windows 11 Snap Layouts
//! in a frameless Tauri app», 2026; Microsoft «Support snap layouts for desktop apps on Windows 11»).
//! Окно ничего не рисует (`NULL_BRUSH`, без `WS_EX_LAYERED`/`WS_EX_TRANSPARENT` — с ними пропадает
//! hit-test). Мышь над кнопкой теперь у него, поэтому наведение и нажатие оно отдаёт клиенту событием
//! [`EVENT_STATE`], а щелчок разворачивает/восстанавливает окно само.
//!
//! Где кнопка — сообщает клиент событием [`EVENT_RECT`]: отступ от ПРАВОГО края, верх, ширина и высота в
//! физических пикселях (CSS-пиксели × `devicePixelRatio`, так учтены и масштаб интерфейса `zoom`, и DPI
//! монитора). От правого края — чтобы при растягивании окно ехало вместе с кнопкой без нового замера.
//! `null` — спрятать (полной экран элемента, кнопки нет).
//! Окно-край Tauri держим НАД нашим: тонкая полоска верхнего края над кнопкой остаётся «тянуть вверх».
//!
//! 🔴 Полный экран из развёрнутого окна (показ «во весь экран», 0.9.8): Tauri переводит окно в полноэкранное, а
//! `WM_NCCALCSIZE` у tao для окна без рамки при `IsZoomed` режет клиентскую область до рабочей области монитора,
//! не глядя на полный экран, — снизу оставалась чёрная полоса на месте панели задач. С системной рамкой эта ветка
//! не срабатывала. Наш сабкласс зовётся раньше tao: в полном экране (у окна снят `WS_CAPTION`, его снимает только
//! полный экран) отвечаем сами — клиентская область во всё окно.

use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Listener, Manager, WebviewWindow};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetStockObject, HBRUSH, NULL_BRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, FindWindowExW, GetClientRect, GetWindowLongW, IsZoomed, LoadCursorW,
    PostMessageW, RegisterClassExW, SetWindowPos, GWL_STYLE, HCURSOR, HTMAXBUTTON, HWND_TOP, IDC_ARROW,
    SC_MAXIMIZE, SC_RESTORE, SWP_ASYNCWINDOWPOS, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOOWNERZORDER, SWP_SHOWWINDOW, WINDOW_EX_STYLE, WM_DPICHANGED, WM_NCCALCSIZE, WM_NCDESTROY,
    WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_NCRBUTTONDOWN,
    WM_NCRBUTTONUP, WM_SIZE, WM_SYSCOMMAND, WNDCLASSEXW, WS_CAPTION, WS_CHILD, WS_CLIPSIBLINGS,
};

/// Клиент → сюда: где кнопка «Развернуть» (`{ right, top, width, height }` в физ. пикселях) или `null`.
pub const EVENT_RECT: &str = "gv-titlebar-max-rect";
/// Сюда → клиент: `"enter" | "leave" | "down" | "up"` — подсветить кнопку, как при наведении.
pub const EVENT_STATE: &str = "gv-titlebar-max-state";

const CLASS: windows::core::PCWSTR = w!("GV_SNAP_MAX_BUTTON");
/// Окно-край из tauri-runtime-wry (`undecorated_resizing.rs`, `CLASS_NAME`) — держим его над нашим.
const TAURI_BORDERS: windows::core::PCWSTR = w!("TAURI_DRAG_RESIZE_BORDERS");
const SUBCLASS_ID: usize = 0x6776_7462; // "gvtb"

#[derive(Clone, Copy, Default)]
struct Spot {
    right: f64,
    top: f64,
    width: f64,
    height: f64,
    /// DPI окна в момент замера: переезд на монитор с другим DPI пересчитывает без нового замера.
    dpi: u32,
}

#[derive(Default)]
struct State {
    parent: isize,
    child: isize,
    spot: Option<Spot>,
    hover: bool,
    pressed: bool,
}

static STATE: Mutex<State> = Mutex::new(State { parent: 0, child: 0, spot: None, hover: false, pressed: false });
static MAIN: OnceLock<WebviewWindow> = OnceLock::new();

/// Подключить к главному окну (зовётся один раз из `pip::build_main`, на потоке окна).
pub fn attach(window: &WebviewWindow) {
    let Ok(parent) = window.hwnd() else { return };
    if MAIN.set(window.clone()).is_err() {
        return;
    }
    let child = unsafe { create_child(parent) };
    let Some(child) = child else { return };
    if let Ok(mut s) = STATE.lock() {
        s.parent = parent.0 as isize;
        s.child = child.0 as isize;
    }
    unsafe {
        let _ = SetWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID, 0);
    }
    // `listen_any`: клиент шлёт глобальным `emit`, без адресата.
    window.app_handle().listen_any(EVENT_RECT, |event| {
        let spot = parse_spot(event.payload());
        let parent = {
            let Ok(mut s) = STATE.lock() else { return };
            s.spot = spot.map(|mut sp| {
                sp.dpi = unsafe { GetDpiForWindow(HWND(s.parent as _)) };
                sp
            });
            s.parent
        };
        place(parent);
    });
}

/// `{ right, top, width, height }` (числа ≥ 0, ширина и высота > 0) или `null` / мусор → спрятать.
fn parse_spot(payload: &str) -> Option<Spot> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    let num = |k: &str| v.get(k).and_then(|x| x.as_f64()).filter(|x| x.is_finite() && *x >= 0.0);
    let spot = Spot { right: num("right")?, top: num("top")?, width: num("width")?, height: num("height")?, dpi: 0 };
    (spot.width > 0.0 && spot.height > 0.0).then_some(spot)
}

unsafe fn create_child(parent: HWND) -> Option<HWND> {
    let hinstance = GetModuleHandleW(None).ok()?;
    let class = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(child_proc),
        hInstance: hinstance.into(),
        hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or(HCURSOR::default()),
        // Ничего не рисуем: видна кнопка клиента под окном.
        hbrBackground: HBRUSH(GetStockObject(NULL_BRUSH).0),
        lpszClassName: CLASS,
        ..Default::default()
    };
    RegisterClassExW(&class);
    // Скрыто, пока клиент не скажет, где кнопка.
    CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        CLASS,
        w!(""),
        WS_CHILD | WS_CLIPSIBLINGS,
        0,
        0,
        0,
        0,
        Some(parent),
        None,
        Some(hinstance.into()),
        None,
    )
    .ok()
}

/// Поставить окно над кнопкой (или спрятать). Безопасно с любого потока: `SWP_ASYNCWINDOWPOS`.
fn place(parent: isize) {
    let (child, spot) = {
        let Ok(s) = STATE.lock() else { return };
        (s.child, s.spot)
    };
    if child == 0 || parent == 0 {
        return;
    }
    let (parent, child) = (HWND(parent as _), HWND(child as _));
    unsafe {
        let mut rc = RECT::default();
        let hide = SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOMOVE | SWP_NOSIZE | SWP_HIDEWINDOW;
        let Some(sp) = spot else {
            let _ = SetWindowPos(child, None, 0, 0, 0, 0, hide);
            return;
        };
        if GetClientRect(parent, &mut rc).is_err() {
            return;
        }
        let dpi = GetDpiForWindow(parent);
        let k = if sp.dpi > 0 && dpi > 0 { dpi as f64 / sp.dpi as f64 } else { 1.0 };
        let w = (sp.width * k).round() as i32;
        let h = (sp.height * k).round() as i32;
        let x = rc.right - (sp.right * k).round() as i32 - w;
        let y = (sp.top * k).round() as i32;
        if w <= 0 || h <= 0 || x < 0 {
            let _ = SetWindowPos(child, None, 0, 0, 0, 0, hide);
            return;
        }
        // Под окном-краем Tauri, но над WebView2: вставка «после» окна-края кладёт нас сразу под него.
        let above = FindWindowExW(Some(parent), None, TAURI_BORDERS, None).ok().unwrap_or(HWND_TOP);
        let _ = SetWindowPos(
            child,
            Some(above),
            x,
            y,
            w,
            h,
            SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
        );
    }
}

fn emit_state(state: &str) {
    if let Some(w) = MAIN.get() {
        let _ = w.emit(EVENT_STATE, state);
    }
}

unsafe extern "system" fn parent_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    // Полный экран (см. шапку модуля): 0 при `wparam != 0` оставляет клиентскую область равной окну — во весь монитор.
    if msg == WM_NCCALCSIZE && wparam.0 != 0 && (GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_CAPTION.0) == 0 {
        return LRESULT(0);
    }
    let result = DefSubclassProc(hwnd, msg, wparam, lparam);
    match msg {
        // Растянули, развернули, переехали на монитор с другим DPI — кнопка у правого края сместилась.
        WM_SIZE | WM_DPICHANGED => place(hwnd.0 as isize),
        WM_NCDESTROY => {
            if let Ok(mut s) = STATE.lock() {
                s.parent = 0;
                s.child = 0;
            }
        }
        _ => {}
    }
    result
}

unsafe extern "system" fn child_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        // Весь смысл окна: Windows 11 видит «кнопку развернуть» и показывает меню раскладок.
        WM_NCHITTEST => LRESULT(HTMAXBUTTON as isize),
        WM_NCMOUSEMOVE => {
            let first = STATE.lock().map(|mut s| !std::mem::replace(&mut s.hover, true)).unwrap_or(false);
            if first {
                let mut tme = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE | TME_NONCLIENT,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                let _ = TrackMouseEvent(&mut tme);
                emit_state("enter");
            }
            LRESULT(0)
        }
        WM_NCMOUSELEAVE => {
            if let Ok(mut s) = STATE.lock() {
                s.hover = false;
                s.pressed = false;
            }
            emit_state("leave");
            LRESULT(0)
        }
        WM_NCLBUTTONDOWN => {
            if let Ok(mut s) = STATE.lock() {
                s.pressed = true;
            }
            emit_state("down");
            LRESULT(0)
        }
        WM_NCLBUTTONUP => {
            let (was, parent) = STATE
                .lock()
                .map(|mut s| (std::mem::replace(&mut s.pressed, false), s.parent))
                .unwrap_or((false, 0));
            emit_state("up");
            if was && parent != 0 {
                // Тем же путём, что системная кнопка: с анимацией и через обработчики tao.
                let parent = HWND(parent as _);
                let cmd = if IsZoomed(parent).as_bool() { SC_RESTORE } else { SC_MAXIMIZE };
                let _ = PostMessageW(Some(parent), WM_SYSCOMMAND, WPARAM(cmd as usize), LPARAM(0));
            }
            LRESULT(0)
        }
        // Правая кнопка над «Развернуть» ничего не делает (как у системной), но и не уходит в DefWindowProc.
        WM_NCRBUTTONDOWN | WM_NCRBUTTONUP => LRESULT(0),
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
