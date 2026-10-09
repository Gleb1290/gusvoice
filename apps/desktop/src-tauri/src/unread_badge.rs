//! Число непрочитанных на значке панели задач и в трее (07.10, #211, Р1, G39).
//!
//! Источник — tdesktop: `platform/win/main_window_win.cpp` (`ITaskbarList3::SetOverlayIcon` с картинкой счётчика и
//! подписью «N непрочитанных»), `window/main_window.cpp` `GenerateCounterLayer` (текст: до 999 — число, дальше
//! «..NN»; круг для 1–2 знаков, скруглённый прямоугольник для длинных) и трей со счётчиком в углу значка
//! (`platform/win/tray_win.cpp`, `WithSmallCounter`). Код не копировался: шрифт — свой пиксельный 3×5, рисуем в RGBA.
//!
//! Панель задач — `WebviewWindow::set_overlay_icon` Tauri (под ним тот же `SetOverlayIcon`). Трей — значок текущего
//! голосового состояния (`gv_tray_set_state`) с красным счётчиком в правом нижнем углу и подсказкой с числом.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

static COUNT: AtomicU32 = AtomicU32::new(0);
static TRAY_STATE: Mutex<String> = Mutex::new(String::new());

/// Красный счётчика — `--danger` (как у значков трея, `tray-icons/generate.mjs`).
const BADGE_BG: [u8; 3] = [224, 87, 78];

/// Текст счётчика как у tdesktop: до 999 — число, дальше «..» и две последние цифры.
pub fn badge_text(count: u32) -> String {
    if count < 1000 {
        count.to_string()
    } else {
        format!("..{:02}", count % 100)
    }
}

/// Глифы 3×5 (строки сверху вниз, 3 бита слева направо).
fn glyph(c: char) -> [u8; 5] {
    match c {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b001, 0b001, 0b001],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        _ => [0b000, 0b000, 0b000, 0b000, 0b010], // «.»
    }
}

/// Картинка счётчика `size`×`size` RGBA: красный круг (1–2 знака) или скруглённый прямоугольник, белые цифры.
pub fn render_badge(count: u32, size: u32) -> Vec<u8> {
    let size = size.max(8);
    let text = badge_text(count);
    let n = text.chars().count() as u32;
    let mut px = vec![0u8; (size * size * 4) as usize];
    // Фон: радиус скругления как у tdesktop — полный круг для коротких, меньше для длинных.
    let s = size as f32;
    let radius = if n < 3 { s / 2.0 } else { s / 4.0 };
    let top = if n < 3 { 0.0 } else { s * 0.2 };
    let bottom = if n < 3 { s } else { s * 0.8 };
    for y in 0..size {
        for x in 0..size {
            let cov = rounded_rect_coverage(x as f32 + 0.5, y as f32 + 0.5, 0.0, top, s, bottom, radius);
            if cov > 0.0 {
                let i = ((y * size + x) * 4) as usize;
                px[i] = BADGE_BG[0];
                px[i + 1] = BADGE_BG[1];
                px[i + 2] = BADGE_BG[2];
                px[i + 3] = (cov * 255.0) as u8;
            }
        }
    }
    // Цифры: наибольший целый масштаб, при котором строка влезает в ~70 % ширины и ~55 % высоты.
    let cols = n * 4 - 1; // 3 колонки на знак + 1 промежуток
    let scale = ((s * 0.7) / cols as f32).min((s * 0.55) / 5.0).floor().max(1.0) as u32;
    let w = cols * scale;
    let h = 5 * scale;
    let x0 = (size.saturating_sub(w)) / 2;
    let y0 = (size.saturating_sub(h)) / 2;
    for (ci, c) in text.chars().enumerate() {
        let g = glyph(c);
        for (row, bits) in g.iter().enumerate() {
            for col in 0..3u32 {
                if bits & (0b100 >> col) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let x = x0 + (ci as u32 * 4 + col) * scale + dx;
                        let y = y0 + row as u32 * scale + dy;
                        if x < size && y < size {
                            let i = ((y * size + x) * 4) as usize;
                            px[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
                        }
                    }
                }
            }
        }
    }
    px
}

/// Покрытие пикселя скруглённым прямоугольником (сглаживание по расстоянию до края, 1 пиксель).
fn rounded_rect_coverage(px: f32, py: f32, l: f32, t: f32, r: f32, b: f32, rad: f32) -> f32 {
    let cx = px.clamp(l + rad, r - rad);
    let cy = py.clamp(t + rad, b - rad);
    let d = ((px - cx).powi(2) + (py - cy).powi(2)).sqrt();
    (rad - d + 0.5).clamp(0.0, 1.0)
}

/// Наложить счётчик на значок `rgba` (`w`×`h`) в правый нижний угол: сторона счётчика — 5/8 стороны значка.
pub fn compose_badge(rgba: &[u8], w: u32, h: u32, count: u32) -> Vec<u8> {
    let mut out = rgba.to_vec();
    if count == 0 || out.len() != (w * h * 4) as usize {
        return out;
    }
    let side = (w.min(h) * 5).div_ceil(8);
    let badge = render_badge(count, side);
    let ox = w - side;
    let oy = h - side;
    for y in 0..side {
        for x in 0..side {
            let bi = ((y * side + x) * 4) as usize;
            let a = badge[bi + 3] as u32;
            if a == 0 {
                continue;
            }
            let oi = (((oy + y) * w + ox + x) * 4) as usize;
            for k in 0..3 {
                out[oi + k] = ((badge[bi + k] as u32 * a + out[oi + k] as u32 * (255 - a)) / 255) as u8;
            }
            out[oi + 3] = (a + out[oi + 3] as u32 * (255 - a) / 255).min(255) as u8;
        }
    }
    out
}

/// Подсказка трея с числом непрочитанных (как подпись overlay у tdesktop).
pub fn with_count_tip(tip: &str, count: u32) -> String {
    if count == 0 {
        tip.to_string()
    } else {
        format!("{tip} · непрочитанных: {count}")
    }
}

/// Запомнить голосовое состояние трея (зовёт `gv_tray_set_state`) — счётчик рисуется поверх его значка.
pub fn set_tray_state(state: &str) {
    if let Ok(mut s) = TRAY_STATE.lock() {
        *s = state.to_string();
    }
}

/// Значок и подсказка трея для состояния + текущий счётчик.
#[cfg(desktop)]
pub fn refresh_tray(app: &tauri::AppHandle) {
    let Some(tray) = app.tray_by_id("main") else { return };
    let state = TRAY_STATE.lock().map(|s| s.clone()).unwrap_or_default();
    let (icon, tip) = match state.as_str() {
        "speaking" => (Some(tauri::include_image!("tray-icons/speaking.png")), "GusVoice — говорите"),
        "silent" => (Some(tauri::include_image!("tray-icons/silent.png")), "GusVoice — микрофон включён"),
        "muted" => (Some(tauri::include_image!("tray-icons/muted.png")), "GusVoice — микрофон выключен"),
        "deafened" => (Some(tauri::include_image!("tray-icons/deafened.png")), "GusVoice — звук выключен"),
        // idle / unknown → restore the default logo.
        _ => (app.default_window_icon().cloned(), "GusVoice"),
    };
    let count = COUNT.load(Ordering::Relaxed);
    if let Some(icon) = icon {
        let (w, h) = (icon.width(), icon.height());
        let rgba = compose_badge(icon.rgba(), w, h, count);
        let _ = tray.set_icon(Some(tauri::image::Image::new_owned(rgba, w, h)));
    }
    let _ = tray.set_tooltip(Some(with_count_tip(tip, count)));
}

/// Число непрочитанных ЛС (клиент, `unreadBadge.ts`): значок панели задач + трей. 0 — убрать.
#[tauri::command]
pub fn gv_set_unread_badge(app: tauri::AppHandle, count: u32) {
    #[cfg(desktop)]
    {
        #[cfg(target_os = "windows")]
        use tauri::Manager;
        if COUNT.swap(count, Ordering::Relaxed) == count {
            return;
        }
        #[cfg(target_os = "windows")]
        if let Some(w) = app.get_webview_window("main") {
            let overlay = (count > 0).then(|| tauri::image::Image::new_owned(render_badge(count, 32), 32, 32));
            let _ = w.set_overlay_icon(overlay);
        }
        refresh_tray(&app);
    }
    #[cfg(not(desktop))]
    let _ = (app, count);
}
