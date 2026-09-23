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

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, IsIconic, IsWindowVisible};

/// Последнее известное состояние — чтобы слать событие на СМЕНУ, а не каждую секунду.
static COVERED: AtomicBool = AtomicBool::new(false);

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
    let mut ours_rect = RECT::default();
    let mut fg_rect = RECT::default();
    if GetWindowRect(ours, &mut ours_rect).is_err() || GetWindowRect(fg, &mut fg_rect).is_err() {
        return false; // не смогли спросить — считаем, что видно: ошибка не повод гасить интерфейс
    }
    COVER_PCT.store(overlap_pct(&ours_rect, &fg_rect), Ordering::Relaxed);
    fg_rect.left <= ours_rect.left + SLACK
        && fg_rect.top <= ours_rect.top + SLACK
        && fg_rect.right >= ours_rect.right - SLACK
        && fg_rect.bottom >= ours_rect.bottom - SLACK
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
    });
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
