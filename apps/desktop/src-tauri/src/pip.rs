//! Окно «картинка в картинке» для показа экрана (#222): Document Picture-in-Picture в десктопе.
//!
//! 🔴 Почему здесь вообще есть код. `documentPictureInPicture.requestWindow()` в WebView2 идёт тем же
//! путём, что и `window.open`: событие `NewWindowRequested`. wry 0.55.1 (`webview2/mod.rs:702`)
//! вешает на него обработчик всегда, и если у окна нет своего `on_new_window` — отвечает
//! `SetHandled(true)` без окна (`webview2/mod.rs:782`), а Chromium отдаёт странице
//! «Internal error: no window». Своё окно мы даём ТОЛЬКО под картинку в картинке:
//!
//! - клиент перед `requestWindow` зовёт `gv_pip_arm` — одноразовое разрешение на `ARM_MS`;
//! - `on_new_window` главного окна снимает разрешение ПРИ ЛЮБОМ запросе и создаёт окно `pip-N`,
//!   только если оно было взведено и адрес — `about:blank` (так приходит окно картинки в
//!   картинке). Всё остальное — `Deny`, как было до #222: ссылки открываются нашим кодом в
//!   браузере, а не новыми окнами приложения.
//!
//! Окно строится внутри `on_new_window`: wry зовёт его не из COM-колбэка, а следующим сообщением
//! очереди окна (`dispatch_handler` + отсрочка события) — ровно для того, чтобы там можно было
//! создать WebView. Это не нарушает правило оверлея (`docs/overlay-safe-rebuild.md`): дедлочит
//! `build()` из синхронной КОМАНДЫ, а пример с `build()` здесь — из документации самого Tauri
//! (`WebviewWindowBuilder::on_new_window`).
//!
//! Главное окно поэтому создаём сами (`build_main` из `lib.rs` `build_main_window`), а в обоих конфигах
//! (`tauri.conf.json` и `tauri.windows.conf.json`) у него `"create": false`: у окна из конфига обработчик
//! новых окон не задать.

use std::sync::atomic::{AtomicU64, Ordering};

// Своя полоса окна (#219): меню раскладок Windows 11 над нашей кнопкой «Развернуть». Модуль подключён
// отсюда, а не из `lib.rs`: строится он вместе с главным окном, а правка `lib.rs` требует пробной APK.
#[cfg(windows)]
#[path = "titlebar.rs"]
mod titlebar;
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

/// Метки окон картинки в картинке: `pip-1`, `pip-2`, …
pub const PREFIX: &str = "pip-";
/// Сколько живёт разрешение после `gv_pip_arm`. Хватает на вызов `requestWindow` следом за
/// командой (IPC туда-обратно — единицы миллисекунд) и не оставляет «окна» для чужой ссылки.
const ARM_MS: u64 = 1500;
/// Размер, если клиент не передал свой, — 16:9.
const DEFAULT_W: f64 = 480.0;
const DEFAULT_H: f64 = 270.0;
/// Границы размера от клиента (логические px): мельче окошко бесполезно, крупнее — уже не окошко.
const MIN_SIDE: f64 = 120.0;
const MAX_SIDE: f64 = 1920.0;
/// Отступ окошка от края рабочей области — как у плавающего видео Telegram Desktop
/// (`media_view_pip.cpp` `setPositionDefault`: левый верхний угол экрана главного окна,
/// `pipBorderSkip: 20px` в `media_view.style`).
const EDGE_SKIP: f64 = 20.0;

/// До какого момента (мс эпохи) действует разрешение; 0 — не взведено.
static ARMED_UNTIL: AtomicU64 = AtomicU64::new(0);
static SEQ: AtomicU64 = AtomicU64::new(0);
/// Размер окошка из `gv_pip_arm`. 🔴 Свой, а не из `requestWindow({width, height})`: WebView2 его
/// не передаёт — у события `WindowFeatures.HasSize` = false (опыт 18.10, WebView2 на Windows 11).
static ARM_SIZE: std::sync::Mutex<(f64, f64)> = std::sync::Mutex::new((DEFAULT_W, DEFAULT_H));
/// Куда человек передвинул окошко в последний раз (физические px, левый верхний угол рамки). Следующее
/// окошко встаёт туда же, пока приложение запущено; после перезапуска — снова `default_position`.
static LAST_POS: std::sync::Mutex<Option<(i32, i32)>> = std::sync::Mutex::new(None);
/// Сколько окошек открыто. Свой счётчик, а не перебор окон: в `Destroyed` закрывающееся окно ещё
/// числится у Tauri, и главное окно не узнало бы, что гасить отрисовку уже можно.
static OPEN: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Снять разрешение и сказать, было ли оно живым. Снимается при ЛЮБОМ запросе нового окна —
/// одно разрешение не переживает чужой `window.open`, случившийся первым.
fn take_arm() -> bool {
    let until = ARMED_UNTIL.swap(0, Ordering::SeqCst);
    until != 0 && now_ms() <= until
}

/// Разрешить ОДНО окно картинки в картинке в ближайшие `ARM_MS`. Зовёт клиент прямо перед
/// `documentPictureInPicture.requestWindow()`; `width`/`height` — размер окошка в логических px
/// (не передал — 480×270). `async` — правило оконных команд (`docs/overlay-safe-rebuild.md`),
/// хотя окна она не трогает.
#[tauri::command]
pub async fn gv_pip_arm(window: tauri::WebviewWindow, width: Option<f64>, height: Option<f64>) {
    // Разрешение даёт только главное окно: картинку в картинке открывает его страница.
    if window.label() != "main" {
        return;
    }
    let side = |v: Option<f64>, d: f64| match v {
        Some(v) if v.is_finite() => v.clamp(MIN_SIDE, MAX_SIDE),
        _ => d,
    };
    if let Ok(mut s) = ARM_SIZE.lock() {
        *s = (side(width, DEFAULT_W), side(height, DEFAULT_H));
    }
    ARMED_UNTIL.store(now_ms() + ARM_MS, Ordering::SeqCst);
}

/// Открыто ли сейчас хоть одно окно картинки в картинке.
pub fn any_open() -> bool {
    OPEN.load(Ordering::SeqCst) > 0
}

/// Создать главное окно из конфига (там `"create": false`) — с обработчиком новых окон.
pub fn build_main(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }
    let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() else {
        return Ok(());
    };
    let h = app.clone();
    let _main = WebviewWindowBuilder::from_config(app, &cfg)?
        .on_new_window(move |url, features| on_new_window(&h, url, features))
        .build()?;
    // Без системной рамки (`decorations: false`) меню раскладок Windows 11 даёт только своё окно над кнопкой.
    #[cfg(windows)]
    titlebar::attach(&_main);
    Ok(())
}

fn on_new_window(
    app: &AppHandle,
    url: Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<tauri::Wry> {
    let armed = take_arm();
    if !armed || url.as_str() != "about:blank" {
        return NewWindowResponse::Deny;
    }
    let label = format!("{PREFIX}{}", SEQ.fetch_add(1, Ordering::SeqCst) + 1);
    let (w, h) = ARM_SIZE.lock().map(|s| *s).unwrap_or((DEFAULT_W, DEFAULT_H));
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("GusVoice")
        .inner_size(w, h);
    if let Some((x, y)) = default_position(app) {
        builder = builder.position(x, y);
    }
    let built = builder
        // Окружение WebView2 открывшего окна: `SetNewWindow` требует то же самое.
        .window_features(features)
        .always_on_top(true)
        // Без значка на панели задач — поэтому и без «свернуть»: свёрнутое окошко без значка
        // не вернуть ничем. Развернуть на весь экран окошку тоже незачем.
        .skip_taskbar(true)
        .minimizable(false)
        .maximizable(false)
        // Фокус не забираем: окошко могут открыть, пока человек в игре или в другом окне.
        .focused(false)
        .build();
    match built {
        Ok(window) => {
            OPEN.fetch_add(1, Ordering::SeqCst);
            // Пока окошко открыто, страницу главного окна НЕ гасим при сворачивании/уходе в трей:
            // окошко ведёт её же скрипт (`lib.rs` → `set_main_webview_shown`).
            #[cfg(target_os = "windows")]
            if let Some(main) = app.get_webview_window("main") {
                crate::set_main_webview_shown(&main, true);
            }
            #[cfg(target_os = "windows")]
            close_with_page(&window);
            let h = app.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Moved(p) = event {
                    if let Ok(mut last) = LAST_POS.lock() {
                        *last = Some((p.x, p.y));
                    }
                }
                if let tauri::WindowEvent::Destroyed = event {
                    OPEN.fetch_sub(1, Ordering::SeqCst);
                    // Окошко закрылось, а главное окно свёрнуто или в трее — погасить его
                    // отрисовку, как погасили бы без окошка.
                    #[cfg(target_os = "windows")]
                    if let Some(main) = h.get_webview_window("main") {
                        let hidden = !main.is_visible().unwrap_or(true)
                            || main.is_minimized().unwrap_or(false);
                        if hidden {
                            crate::set_main_webview_shown(&main, false);
                        }
                    }
                    #[cfg(not(target_os = "windows"))]
                    let _ = &h;
                }
            });
            NewWindowResponse::Create { window }
        }
        Err(_) => NewWindowResponse::Deny,
    }
}

/// Где открыть окошко (логические px): там, куда его передвинули в прошлый раз (`LAST_POS`), если
/// тот монитор ещё на месте; иначе левый верхний угол рабочей области монитора главного окна. Без
/// позиции Windows ставит новые окна «лесенкой» от прошлого.
fn default_position(app: &AppHandle) -> Option<(f64, f64)> {
    let main = app.get_webview_window("main")?;
    if let Some((x, y)) = LAST_POS.lock().ok().and_then(|l| *l) {
        let monitors = main.available_monitors().unwrap_or_default();
        let on = monitors.iter().find(|m| {
            let a = m.work_area();
            x >= a.position.x
                && y >= a.position.y
                && x < a.position.x + a.size.width as i32
                && y < a.position.y + a.size.height as i32
        });
        if let Some(m) = on {
            let pos = tauri::PhysicalPosition::new(x, y).to_logical::<f64>(m.scale_factor());
            return Some((pos.x, pos.y));
        }
    }
    let mon = main
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| main.primary_monitor().ok().flatten())?;
    let area = mon.work_area();
    let scale = mon.scale_factor();
    let pos = area.position.to_logical::<f64>(scale);
    Some((pos.x + EDGE_SKIP, pos.y + EDGE_SKIP))
}

/// `pipWindow.close()` (или закрытие окошка самим Chromium — например, главная страница
/// перезагрузилась) закрывает и окно Tauri.
///
/// 🔴 Само не закрывается: wry на `WindowCloseRequested` зовёт `DestroyWindow` у СВОЕГО дочернего
/// окна-контейнера WebView (`webview2/mod.rs:616`), а не у окна верхнего уровня. Опыт 18.10: после
/// `close()` страница окошка исчезла, а пустая рамка с заголовком осталась висеть поверх всех окон.
/// Закрываем из отдельного потока: событие приходит внутри COM-колбэка WebView2, а закрытие окна
/// уходит сообщением в событийный цикл и выполнится уже после колбэка.
#[cfg(target_os = "windows")]
fn close_with_page(window: &tauri::WebviewWindow) {
    use webview2_com::WindowCloseRequestedEventHandler;
    let w = window.clone();
    let _ = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let mut token = Default::default();
        let _ = core.add_WindowCloseRequested(
            &WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                let w = w.clone();
                std::thread::spawn(move || {
                    let _ = w.destroy();
                });
                Ok(())
            })),
            &mut token,
        );
    });
}
