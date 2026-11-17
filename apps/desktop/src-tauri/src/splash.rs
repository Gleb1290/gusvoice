//! Заставка при запуске (как у Discord, 15.10): маленькое окно `splash` с гусём, пока проверяется и
//! ставится обновление; главное окно до конца заставки скрыто.
//!
//! Оба окна описаны в `tauri.windows.conf.json` — его Tauri накладывает на `tauri.conf.json` ТОЛЬКО в
//! сборке под Windows, поэтому Android (тот же `src-tauri`) остаётся с одним видимым главным окном, как
//! было. Здесь — только страховка и команды заставки; модуль подключён под `cfg(desktop)`.
//!
//! Ход заставки ведёт веб-клиент (`splashFlow.ts`, окно `index.html?window=splash`): проверка → «Запускаю…»
//! → `gv_splash_done` (показать главное окно, закрыть заставку). Есть обновление — качает и ставит его сам,
//! установщик в тихом режиме закрывает приложение и запускает новую версию.
//!
//! 🔴 Страховка: если клиент заставки умер (ошибка модуля, зависший WebView), главное окно иначе так и
//! осталось бы скрытым — приложение «не запускается». Сторож ниже показывает главное окно, когда
//! заставка молчит дольше [`FAILSAFE_MS`] (клиент пингует каждую фазу и каждую секунду скачивания) или
//! окно заставки исчезло (Alt+F4).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Метка окна заставки (`tauri.windows.conf.json`).
pub const LABEL: &str = "splash";
/// Сколько заставка может молчать, прежде чем главное окно покажется само. Обычный запуск без
/// обновления укладывается в ~1–1.5 с, проверка без сети обрывается клиентом через 4 с.
const FAILSAFE_MS: u64 = 10_000;
/// Как часто сторож смотрит на заставку.
const TICK_MS: u64 = 250;

/// Заставка ещё на экране (главное окно ждёт её).
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// Этот запуск шёл через заставку — проверку обновлений при старте делает она, а не главное окно.
static LAUNCHED: AtomicBool = AtomicBool::new(false);
/// Последний признак жизни заставки, мс от эпохи.
static LAST_PING: AtomicU64 = AtomicU64::new(0);
/// Событие главному окну: заставка закрылась, приложение на экране (28.10).
const FINISHED_EVENT: &str = "gv-splash-finished";
/// Журнал обновлений (28.10): файл в данных приложения, потолок размера — дальше остаётся свежая половина.
const UPDATE_LOG: &str = "update-log.txt";
const UPDATE_LOG_MAX: u64 = 128 * 1024;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Зовётся из `setup`: окно заставки уже создано из конфига (или его нет — тогда ничего не делаем).
pub fn start(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_none() {
        return;
    }
    LAST_PING.store(now_ms(), Ordering::SeqCst);
    ACTIVE.store(true, Ordering::SeqCst);
    LAUNCHED.store(true, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(TICK_MS));
        if !ACTIVE.load(Ordering::SeqCst) {
            return;
        }
        let silent = now_ms().saturating_sub(LAST_PING.load(Ordering::SeqCst)) > FAILSAFE_MS;
        let gone = app.get_webview_window(LABEL).is_none();
        if silent || gone {
            finish(&app);
            return;
        }
    });
}

/// Показать главное окно и убрать заставку. Повторный вызов — ничего не делает.
fn finish(app: &AppHandle) {
    if !ACTIVE.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        // Как в трее и single-instance: сначала «видно» для WebView2, потом показ (#207).
        #[cfg(target_os = "windows")]
        crate::set_main_webview_shown(&w, true);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        // Главное окно ждёт этого, прежде чем вернуть человека в голосовой канал (`splashGate.ts`).
        use tauri::Emitter;
        let _ = w.emit(FINISHED_EVENT, ());
    }
    if let Some(s) = app.get_webview_window(LABEL) {
        let _ = s.destroy();
    }
}

/// Признак жизни заставки — отодвигает страховку. `async` — не держим поток событий Windows.
#[tauri::command]
pub async fn gv_splash_ping() {
    LAST_PING.store(now_ms(), Ordering::SeqCst);
}

/// Заставка закончила: показать главное окно, закрыть заставку.
#[tauri::command]
pub async fn gv_splash_done(app: AppHandle) {
    finish(&app);
}

/// Шёл ли этот запуск через заставку. Главное окно по нему НЕ запускает свою проверку обновлений при
/// старте (её уже сделала заставка); 30-минутный опрос работает как раньше.
#[tauri::command]
pub async fn gv_launch_splash() -> bool {
    LAUNCHED.load(Ordering::SeqCst)
}

/// Заставка ещё на экране (28.10). Пока она качает и ставит обновление, главное окно ПРЕЖНЕЙ версии уже
/// загружено (скрыто) — и возвращало человека в голосовой канал, а через секунды установщик его убивал и
/// новая версия заходила второй раз: два звука подключения на одно обновление. Главное окно ждёт конца
/// заставки (`splashGate.ts`, событие [`FINISHED_EVENT`]).
#[tauri::command]
pub async fn gv_splash_active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// Строка в журнал обновлений (28.10): заставка и главное окно пишут, кто что решил при запуске и
/// обновлении (`updateLog` в `updater.ts`). `localStorage` для этого не годится — установщик убивает
/// процесс раньше, чем WebView2 сбрасывает его на диск. Время и PID ставим здесь. Ошибки — молча.
#[tauri::command]
pub async fn gv_update_log(app: AppHandle, line: String) {
    use std::io::Write;
    let Ok(dir) = app.path().app_local_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(UPDATE_LOG);
    if std::fs::metadata(&path).map(|m| m.len() > UPDATE_LOG_MAX).unwrap_or(false) {
        if let Ok(old) = std::fs::read(&path) {
            let tail = &old[old.len() / 2..];
            let cut = tail.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
            let _ = std::fs::write(&path, &tail[cut..]);
        }
    }
    let line: String = line.chars().filter(|c| *c != '\n' && *c != '\r').take(500).collect();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} pid={} v{} {}", now_ms(), std::process::id(), app.package_info().version, line);
    }
}

/// Скрытый режим проверки обновления на пробной сборке: `GV_UPDATE_TEST=downgrade` в окружении →
/// заставка проверяет фид с разрешённым откатом, и пробная сборка «обновляется» на выпущенную версию
/// из боевого фида (тихая установка + перезапуск). Любое другое значение — как будто переменной нет.
/// Обычному человеку эту переменную взять неоткуда.
///
/// С tauri-plugin-updater 2.12 параметр `allowDowngrades` у JS-`check()` убран (страница больше не
/// может ослабить проверку версии): откат разрешает сам Rust — `update_test_downgrade()` ниже
/// подставляет сравнение «версия другая» в `default_version_comparator` при сборке плагина (`lib.rs`).
/// Команда осталась: заставка по ней пишет в журнал, что идёт пробный откат.
#[tauri::command]
pub async fn gv_update_test_mode() -> Option<String> {
    match std::env::var("GV_UPDATE_TEST") {
        Ok(v) if v == "downgrade" => Some(v),
        _ => None,
    }
}

/// Тот же `GV_UPDATE_TEST=downgrade`, но для Rust: включён → плагин обновлений считает обновлением
/// любую ДРУГУЮ версию фида, а не только более новую (вместо убранного `allowDowngrades` у `check()`).
pub fn update_test_downgrade() -> bool {
    matches!(std::env::var("GV_UPDATE_TEST").as_deref(), Ok("downgrade"))
}
