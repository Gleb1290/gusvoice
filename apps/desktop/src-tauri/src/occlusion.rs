//! Видно ли наше окно человеку — и что с этим делать.
//!
//! 🔴 **Почему не по фокусу.** Замер 20.09 (#193) показал: пока человек играет, а наше окно лежит
//! под игрой, мы рисуем ровно столько же, сколько когда он на него смотрит (40 % против 42 %
//! процессора). Напрашивается «нет фокуса — не рисуем», но это сломало бы жизнь всем, у кого ДВА
//! монитора: там окно прекрасно видно на соседнем экране, просто фокус в игре.
//!
//! Поэтому считаем по ГЕОМЕТРИИ: окно перекрыто, только если окно переднего плана накрывает его
//! целиком. Игра на первом мониторе и наше окно на втором дают непересекающиеся прямоугольники —
//! и мы честно считаем, что нас видно.
//!
//! ⚠️ Свёрнутое окно тоже считается невидимым — это тот случай, который движок ловит и сам, но
//! полагаться на него нельзя: в наших срезах признак «страница скрыта» был нулём ВСЕГДА, включая
//! те минуты, когда окно лежало под полноэкранной игрой.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONULL};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
};

/// Последнее известное состояние — чтобы слать событие на СМЕНУ, а не каждую секунду.
static COVERED: AtomicBool = AtomicBool::new(false);

/// На переднем плане чужое окно на весь монитор — почти всегда игра (#207, плейбук 25.09).
///
/// 🔴 Отдельно от `COVERED`, и это главное. Наше окно на ВТОРОМ мониторе видно (потому #193 и не
/// гасит его по фокусу), но пока на первом идёт игра, бесконечные украшения — пульс LIVE, дыхание
/// короны, гусь — перерисовывают окно каждый кадр и будят DWM, чья работа на видеокарте идёт с
/// высоким приоритетом, то есть впереди игры. Discord для того же ставит своё превью на паузу, пока
/// игра в фокусе. Клиент по этому признаку замораживает ТОЛЬКО бесконечные анимации: появления
/// сообщений и тостов на втором мониторе должны работать как обычно.
static GAME_FG: AtomicBool = AtomicBool::new(false);

/// Процесс этой игры (0 — игры нет). Диагностика по нему делит загрузку видеокарты на «игра / мы /
/// DWM» — без этого влияние показа на игру у людей не посчитать (плейбук #207, тема 06, §2).
static GAME_PID: AtomicU32 = AtomicU32::new(0);

/// На сколько процентов площади нашего окна накрыто окном переднего плана.
///
/// 🔴 Ради разбора, а не ради решения. «Механизм молчит» имеет две совершенно разные причины: он не
/// работает вовсе — или работает, а игра честно не накрывает окно целиком (оконный режим, чуть
/// другой размер, вторая панель). Без этого числа их не различить, и 20.09 на этом уже потерян круг.
static COVER_PCT: AtomicU8 = AtomicU8::new(0);

/// Как часто спрашиваем систему. Секунда — человек не заметит задержки при возврате из игры, а
/// стоимость проверки (два системных вызова) на этом шаге неразличима.
const EVERY: Duration = Duration::from_millis(900);

/// Допуск в пикселях: рамки и тени окон дают расхождение в один-два пикселя, и без запаса
/// полноэкранная игра иногда «не дотягивает» до края нашего окна.
const SLACK: i32 = 2;

// Видимая рамка окна без невидимых полей изменения размера. Объявлено вручную, как PDH в `diag.rs`:
// лишняя фича крейта `windows` раздувает кодогенерацию (см. Cargo.toml), а нужна одна функция.
#[link(name = "dwmapi")]
extern "system" {
    fn DwmGetWindowAttribute(hwnd: HWND, attr: u32, value: *mut core::ffi::c_void, size: u32) -> i32;
}
const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;

/// Прямоугольник, который окно РЕАЛЬНО занимает на экране.
///
/// 🔴 Зачем (27.09, #207). `GetWindowRect` включает невидимые поля изменения размера, и у
/// РАЗВЁРНУТОГО окна они торчат за край монитора на ~8 px с каждой стороны. Полноэкранная игра по
/// геометрии «не дотягивала» до нас, и окно под игрой никогда не считалось накрытым: у тестера на
/// одном мониторе телеметрия всё время показывала `cover_pct` 98 и `covered` 0, то есть ни одна
/// экономия #193 (пауза анимаций, редкий тик «кто говорит») под игрой у него не включалась.
unsafe fn visible_rect(hwnd: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    let hr = DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &mut r as *mut RECT as *mut core::ffi::c_void,
        std::mem::size_of::<RECT>() as u32,
    );
    if hr >= 0 {
        return Some(r);
    }
    // Композиция недоступна — как раньше, с полями: хуже, но не ложно «накрыто».
    let mut r = RECT::default();
    GetWindowRect(hwnd, &mut r).ok().map(|_| r)
}

/// Накрыто ли окно `ours` окном переднего плана целиком. Попутно запоминает долю перекрытия.
unsafe fn covered_by_foreground(ours: HWND) -> bool {
    if IsIconic(ours).as_bool() || !IsWindowVisible(ours).as_bool() {
        COVER_PCT.store(100, Ordering::Relaxed);
        return true; // свёрнуто или спрятано — рисовать точно незачем
    }
    let fg = GetForegroundWindow();
    if fg.is_invalid() || fg == ours {
        COVER_PCT.store(0, Ordering::Relaxed);
        return false;
    }
    let mut fg_rect = RECT::default();
    let Some(ours_rect) = visible_rect(ours) else {
        return false; // не смогли спросить — считаем, что видно: ошибка не повод гасить интерфейс
    };
    if GetWindowRect(fg, &mut fg_rect).is_err() {
        return false;
    }
    COVER_PCT.store(overlap_pct(&ours_rect, &fg_rect), Ordering::Relaxed);
    fg_rect.left <= ours_rect.left + SLACK
        && fg_rect.top <= ours_rect.top + SLACK
        && fg_rect.right >= ours_rect.right - SLACK
        && fg_rect.bottom >= ours_rect.bottom - SLACK
}

/// Окно переднего плана — чужое и на весь свой монитор (признак игры).
///
/// ⚠️ Не игра, хотя на весь экран: рабочий стол (`Progman`/`WorkerW` — он «на весь монитор», когда
/// человек кликнул по обоям) и НАШИ окна (оверлей, плашки — они тоже бывают поверх всего).
/// Развёрнутое обычное окно (браузер) до края монитора не достаёт: его ограничивает панель задач,
/// поэтому полноэкранным не считается — и это верно, там мы никому не мешаем.
unsafe fn game_in_foreground(ours: HWND) -> Option<u32> {
    let fg = GetForegroundWindow();
    if fg.is_invalid() || fg == ours {
        return None;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(fg, Some(&mut pid));
    if pid == 0 || pid == GetCurrentProcessId() {
        return None;
    }
    let mut class = [0u16; 32];
    let n = GetClassNameW(fg, &mut class) as usize;
    let class = String::from_utf16_lossy(&class[..n.min(class.len())]);
    if class == "Progman" || class == "WorkerW" {
        return None;
    }
    let mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONULL);
    if mon.is_invalid() {
        return None;
    }
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if !GetMonitorInfoW(mon, &mut info).as_bool() {
        return None;
    }
    let mut r = RECT::default();
    if GetWindowRect(fg, &mut r).is_err() {
        return None;
    }
    let m = info.rcMonitor;
    let full = r.left <= m.left + SLACK
        && r.top <= m.top + SLACK
        && r.right >= m.right - SLACK
        && r.bottom >= m.bottom - SLACK;
    full.then_some(pid)
}

/// Какая доля площади `ours` попадает под `other`, в процентах.
fn overlap_pct(ours: &RECT, other: &RECT) -> u8 {
    let w = (ours.right - ours.left).max(0) as i64;
    let h = (ours.bottom - ours.top).max(0) as i64;
    let area = w * h;
    if area == 0 {
        return 0;
    }
    let ow = (ours.right.min(other.right) - ours.left.max(other.left)).max(0) as i64;
    let oh = (ours.bottom.min(other.bottom) - ours.top.max(other.top)).max(0) as i64;
    ((ow * oh * 100) / area).clamp(0, 100) as u8
}

/// Следить за видимостью главного окна и сообщать клиенту о смене.
///
/// Событие `gv://covered` несёт `true`, когда нас не видно. Клиент по нему замораживает анимации и
/// разряжает служебные тики — решение, ЧТО именно приостановить, принимает он: оболочке про
/// устройство интерфейса знать незачем.
pub fn watch(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(EVERY);
        let Some(win) = app.get_webview_window("main") else {
            continue;
        };
        let Ok(hwnd) = win.hwnd() else {
            continue;
        };
        let now = unsafe { covered_by_foreground(hwnd) };
        if now != COVERED.swap(now, Ordering::Relaxed) {
            let _ = app.emit("gv://covered", now);
        }
        let game_pid = unsafe { game_in_foreground(hwnd) };
        GAME_PID.store(game_pid.unwrap_or(0), Ordering::Relaxed);
        let game = game_pid.is_some();
        if game != GAME_FG.swap(game, Ordering::Relaxed) {
            let _ = app.emit("gv://game-foreground", game);
        }
    });
}

/// Идёт ли сейчас полноэкранная игра на переднем плане — для клиента после перезагрузки страницы
/// (`gv_game_foreground` в `lib.rs`) и для диагностики.
pub fn game_foreground_now() -> bool {
    GAME_FG.load(Ordering::Relaxed)
}

/// Процесс полноэкранной игры на переднем плане, `None` — игры нет. Для диагностики (#207).
pub fn game_pid_now() -> Option<u32> {
    match GAME_PID.load(Ordering::Relaxed) {
        0 => None,
        pid => Some(pid),
    }
}

/// Текущее состояние — на случай, если клиент спросит раньше первой смены (перезагрузка страницы).
/// Наружу отдаётся командой `gv_window_covered` в `lib.rs`: у неё есть заглушка для платформ без
/// Win32, а `generate_handler!` условных элементов списка не умеет.
pub fn covered_now() -> bool {
    COVERED.load(Ordering::Relaxed)
}

/// Доля перекрытия для диагностики (#193).
pub fn cover_pct_now() -> u8 {
    COVER_PCT.load(Ordering::Relaxed)
}
