// WebView2 denies getUserMedia (mic/camera) by default — it only prompts/denies unless the host
// grants the PermissionRequested. wry itself only auto-grants clipboard, so we add our own handler
// that allows microphone + camera for the app's own content. Without this, voice/video is dead in
// the Windows desktop build.
#[cfg(target_os = "windows")]
fn grant_media_permissions(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let _ = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let mut token = Default::default();
        let _ = core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                    || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
                Ok(())
            })),
            &mut token,
        );
    });
}

// Suppress WebView2's default screen-capture UI (the "tauri.localhost is sharing your screen" bar +
// permission prompt). ScreenCaptureStarting is on ICoreWebView2_27; on older runtimes the cast fails and
// we just leave the default UI. SetHandled(true)+SetCancel(false) = allow capture without the default UI.
#[cfg(target_os = "windows")]
fn suppress_screen_capture_ui(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_27;
    use webview2_com::ScreenCaptureStartingEventHandler;
    use windows::core::Interface;

    let _ = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let Ok(core26) = core.cast::<ICoreWebView2_27>() else {
            return; // WebView2 runtime too old for ScreenCaptureStarting — keep the default UI
        };
        let mut token = 0i64;
        let _ = core26.add_ScreenCaptureStarting(
            &ScreenCaptureStartingEventHandler::create(Box::new(|_sender, args| {
                if let Some(args) = args {
                    args.SetCancel(false)?;
                    args.SetHandled(true)?;
                }
                Ok(())
            })),
            &mut token,
        );
    });
}

// Отключить БРАУЗЕРНЫЙ СЛОЙ WebView2: родное контекстное меню и горячие клавиши браузера.
//
// Мы гасили их из JS — по одному месту и по одному сочетанию: сначала «Печать» в меню, потом Ctrl+P,
// потом Ctrl+J (загрузки), потом меню на ползунке громкости. Это игра в догонялки: у Edge свои
// панели (коллекции, избранное, чтение вслух, «Отправить вкладку на устройства»), их список
// меняется с версией рантайма, и следующий тестер найдёт очередную дырку.
//
// Здесь канал закрывается целиком и один раз: `AreDefaultContextMenusEnabled(false)` убирает родное
// меню, `AreBrowserAcceleratorKeysEnabled(false)` — весь пакет Ctrl+P/S/O/J/H/D/F1/… . Наши
// собственные сочетания это НЕ трогает: `keydown` до страницы доходит как обычно, отключены только
// действия самого браузера. Ctrl+C/V/X/A и F12 (devtools) продолжают работать — они не браузерные
// акселераторы, а правка и отладка.
//
// Настройки живут на ICoreWebView2Settings (контекстное меню) и ...Settings3 (акселераторы) — на
// древнем рантайме каст не удастся, и мы просто остаёмся на JS-подстраховке, как и раньше.
#[cfg(target_os = "windows")]
fn disable_browser_chrome(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    let _ = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else {
            return;
        };
        // Родное меню по правому клику («Печать», «Сохранить как», «Отправить вкладку», «Проверить»).
        let _ = settings.SetAreDefaultContextMenusEnabled(false);
        // Горячие клавиши браузера целиком: печать, сохранение, загрузки, история, закладки, F1…
        if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    });
}

/// What the client needs to toast a download: the file, and the folder it landed in.
#[cfg(target_os = "windows")]
#[derive(Clone, serde::Serialize)]
struct DownloadInfo {
    name: String,
    dir: String,
    path: String,
}

/// Emitted instead of downloading when we have nowhere to put the file. The client picks a folder and
/// re-issues the request by `url` (see downloads.ts).
#[cfg(target_os = "windows")]
#[derive(Clone, serde::Serialize)]
struct DownloadAsk {
    url: String,
    name: String,
    /// true = a folder WAS configured but is gone or unwritable now (USB pulled, network share down),
    /// so the client can say so instead of asking as if for the first time.
    lost: bool,
}

/// Where downloads go, as chosen by the user (Настройки → Десктоп). `None` = not chosen yet — the first
/// download asks rather than guessing. The client owns the persisted value (localStorage) and mirrors it
/// here on boot and on every change; the shell keeps it only so the DownloadStarting handler, which must
/// answer synchronously, can read it without a round-trip to JS.
#[cfg(target_os = "windows")]
static DOWNLOAD_DIR: std::sync::Mutex<Option<std::path::PathBuf>> = std::sync::Mutex::new(None);

/// Mirror the client's downloads folder into the shell. Empty/absent clears it (back to "ask me").
#[tauri::command]
fn gv_set_download_dir(dir: Option<String>) {
    #[cfg(target_os = "windows")]
    {
        let next = dir
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .map(std::path::PathBuf::from);
        if let Ok(mut g) = DOWNLOAD_DIR.lock() {
            *g = next;
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = dir;
}

/// `dir/name`, dodging collisions the way a browser does: `file.txt` → `file (1).txt`. WebView2 handles
/// this itself for the path it picked, but NOT for one we set — and silently overwriting a file the user
/// already has is the one outcome nobody wants.
#[cfg(target_os = "windows")]
fn unique_in(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = std::path::Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let ext = p
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    (1..1000)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|c| !c.exists())
        .unwrap_or(first)
}

// Chat attachments download through WebView2, which gives NO feedback inside our window — no download
// shelf, no "saved" hint, and nothing at all when a download fails: the file just silently appears in
// Загрузки, or silently doesn't. Hook DownloadStarting, take over the default download dialog, and
// mirror each download's lifecycle into Tauri events so the web client can toast it in our own style.
// DownloadStarting lives on ICoreWebView2_4; on an older runtime the cast fails and we simply keep
// WebView2's default behaviour (same graceful-degrade shape as suppress_screen_capture_ui).
#[cfg(target_os = "windows")]
fn wire_download_notifications(window: &tauri::WebviewWindow) {
    use tauri::{Emitter, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_4, COREWEBVIEW2_DOWNLOAD_STATE, COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED,
        COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED,
    };
    use webview2_com::{take_pwstr, DownloadStartingEventHandler, StateChangedEventHandler};
    use windows::core::Interface;

    let app = window.app_handle().clone();
    let _ = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let Ok(core4) = core.cast::<ICoreWebView2_4>() else {
            return; // runtime predates DownloadStarting — keep the default behaviour
        };
        let mut token = 0i64;
        let _ = core4.add_DownloadStarting(
            &DownloadStartingEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };
                // We render our own toast, so keep WebView2's default download dialog out of the way —
                // including on the cancel path below, where it would otherwise flash for a blink.
                args.SetHandled(true)?;
                let op = args.DownloadOperation()?;

                // The destination is decided up front. take_pwstr copies + CoTaskMemFree's the buffer —
                // do NOT hand-roll the free here (see the PROPVARIANT heap-corruption bug in audio_capture).
                // We reuse only the file NAME from WebView2's default path; the folder is the user's.
                let mut raw = windows::core::PWSTR::null();
                op.ResultFilePath(&mut raw)?;
                let default_path = take_pwstr(raw);
                let name = std::path::Path::new(&default_path)
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| default_path.clone());

                // create_dir_all doubles as the reachability check: a folder on a pulled USB stick or a
                // dead network share fails here, and we ask again rather than letting the download die
                // with an opaque "прервана".
                let configured = DOWNLOAD_DIR.lock().ok().and_then(|g| g.clone());
                let usable = configured
                    .clone()
                    .filter(|d| std::fs::create_dir_all(d).is_ok());
                let Some(dir) = usable else {
                    // Nowhere to put it. Cancel THIS download and let the client ask for a folder; it
                    // re-issues the request by URL once one is picked. Asking from inside this handler is
                    // not an option — a modal dialog on the WebView2 event-loop thread is the very wedge
                    // that froze the app in v0.5.38.
                    args.SetCancel(true)?;
                    let mut u = windows::core::PWSTR::null();
                    op.Uri(&mut u)?;
                    let url = take_pwstr(u);
                    let _ = app.emit(
                        "gv-download-need-dir",
                        DownloadAsk {
                            url,
                            name,
                            lost: configured.is_some(),
                        },
                    );
                    return Ok(());
                };

                let target = unique_in(&dir, &name);
                {
                    use std::os::windows::ffi::OsStrExt;
                    let wide: Vec<u16> = target
                        .as_os_str()
                        .encode_wide()
                        .chain(std::iter::once(0))
                        .collect();
                    args.SetResultFilePath(windows::core::PCWSTR(wide.as_ptr()))?;
                }
                let info = DownloadInfo {
                    name: target
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or(name),
                    dir: dir.to_string_lossy().into_owned(),
                    path: target.to_string_lossy().into_owned(),
                };

                let _ = app.emit("gv-download-started", info.clone());

                // StateChanged fires on this same operation until it settles. One handler per download;
                // the token is dropped with the operation once it completes.
                let app_done = app.clone();
                let mut tok = 0i64;
                let _ = op.add_StateChanged(
                    &StateChangedEventHandler::create(Box::new(move |op, _| {
                        let Some(op) = op else { return Ok(()) };
                        let mut st = COREWEBVIEW2_DOWNLOAD_STATE::default();
                        op.State(&mut st)?;
                        if st == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                            let _ = app_done.emit("gv-download-done", info.clone());
                        } else if st == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
                            let _ = app_done.emit("gv-download-failed", info.clone());
                        }
                        Ok(())
                    })),
                    &mut tok,
                );
                Ok(())
            })),
            &mut token,
        );
    });
}

#[cfg(target_os = "windows")]
mod apps_enum;
#[cfg(target_os = "windows")]
mod audio_capture;
#[cfg(all(target_os = "windows", feature = "diag"))]
mod diag;
/// Что на самом деле с видеокартой: частоты, состояние производительности, ёмкость видеопамяти,
/// загрузка кодировщика. Без этого процент загрузки GPU нечитаем — см. шапку модуля.
#[cfg(target_os = "windows")]
mod gpu_nvml;
/// In-game voice overlay window (borderless/transparent/always-on-top). Desktop-only.
#[cfg(desktop)]
mod overlay;
/// Нативная тряска ОКНА для МЕГА пока (#117). Десктоп целиком — двигать окно умеет любая из
/// настольных платформ, а на Android окна как объекта нет вовсе.
#[cfg(desktop)]
mod shake;
#[cfg(target_os = "windows")]
mod ptt_mouse;
#[cfg(target_os = "windows")]
mod hotkey_key;
#[cfg(target_os = "windows")]
mod screenshare;
#[cfg(target_os = "windows")]
mod share_indicator;

/// Счётчик запросов на закрытие и последний подтверждённый клиентом (#125). Разбор — у обработчика.
static CLOSE_REQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static CLOSE_ACK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Сколько ждём ответа клиента, прежде чем закрыться самим.
const CLOSE_ACK_MS: u64 = 1200;

/// «Я взялся за это закрытие» — от веб-клиента. Без него окно закроется само через `CLOSE_ACK_MS`.
#[tauri::command]
fn gv_close_ack() {
    let cur = CLOSE_REQ.load(std::sync::atomic::Ordering::SeqCst);
    CLOSE_ACK.store(cur, std::sync::atomic::Ordering::SeqCst);
}

/// Тряхнуть окно приложения — МЕГА пок (#117, этап 3).
///
/// ⚠️ Ничего не возвращает и не может провалиться для вызывающего: это украшение. Нет окна, идёт
/// другая тряска, платформа отказала — жест всё равно состоялся, и превращать это в ошибку у
/// покупателя было бы враньём о том, что покупка не прошла.
#[tauri::command]
fn gv_shake_window(app: tauri::AppHandle) {
    #[cfg(desktop)]
    shake::shake(&app);
    #[cfg(not(desktop))]
    let _ = app;
}

/// Hide/stop-hiding Chromium's "sharing your screen" indicator window while a desktop screen share runs.
#[tauri::command]
fn gv_hide_share_indicator(hide: bool) {
    #[cfg(target_os = "windows")]
    {
        if hide {
            share_indicator::start_hiding();
        } else {
            share_indicator::stop_hiding();
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = hide;
    }
}

/// PHASE-1 test command: record `seconds` of system-audio-minus-GusVoice to a WAV, return its path.
#[tauri::command]
async fn gv_audio_record_wav(seconds: u32) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || audio_capture::record_wav(seconds))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = seconds;
        Err("native audio capture is Windows-only".into())
    }
}

/// Phase 2: start streaming stream-audio to the webview as raw f32 chunks (48 kHz stereo).
/// `is_window` + `source_id` (the HWND string) scope the capture: window share → ONLY that window's
/// process tree; full-screen → everything minus GusVoice's own voices.
#[tauri::command]
fn gv_stream_audio_start(
    on_audio: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    is_window: bool,
    source_id: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let target = if is_window {
            let hwnd: u64 = source_id
                .as_deref()
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| "bad window id".to_string())?;
            let pid = apps_enum::window_pid(hwnd).ok_or_else(|| "no process for window".to_string())?;
            audio_capture::AudioTarget::IncludeProcess(pid)
        } else {
            audio_capture::AudioTarget::ExcludeSelf
        };
        audio_capture::start_stream(target, move |bytes| {
            let _ = on_audio.send(tauri::ipc::InvokeResponseBody::Raw(bytes.to_vec()));
        });
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (on_audio, is_window, source_id);
        Err("native audio capture is Windows-only".into())
    }
}

#[tauri::command]
fn gv_stream_audio_stop() {
    #[cfg(target_os = "windows")]
    audio_capture::stop_stream();
}

/// Native screen-share (Plan B): enumerate capturable screens + windows for our own picker UI.
/// Returns `[{ id, kind: "screen"|"window", title }]`. Windows-only (libwebrtc desktop_capturer).
#[tauri::command]
async fn gv_screen_sources() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let list = tauri::async_runtime::spawn_blocking(screenshare::enumerate)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_value(list).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("native screen share is Windows-only".into())
    }
}

/// Start a native screen share: connect the companion participant and publish the chosen source.
/// `config` = { url, token, sourceId, isWindow, fps, width, height, maxBitrate, codec }.
#[tauri::command]
async fn gv_screen_share_start(config: serde_json::Value, app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let cfg: screenshare::StartConfig = serde_json::from_value(config).map_err(|e| e.to_string())?;
        screenshare::start(cfg, app).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (config, app);
        Err("native screen share is Windows-only".into())
    }
}

/// Stop the active native screen share (disconnect the companion participant).
#[tauri::command]
async fn gv_screen_share_stop() {
    #[cfg(target_os = "windows")]
    screenshare::stop().await;
}

/// Live encoder stats for the native screen-share — resolution, fps, bitrate, what's throttling it
/// (cpu vs bandwidth) and which encoder is actually running (NVENC vs a software fallback). Null when
/// nothing is being shared natively. Powers the stream debug panel.
#[tauri::command]
async fn gv_screen_share_stats() -> Option<serde_json::Value> {
    #[cfg(target_os = "windows")]
    {
        let s = screenshare::stats().await?;
        return serde_json::to_value(s).ok();
    }
    #[cfg(not(target_os = "windows"))]
    None
}

/// Свежий кадр идущего показа маленькой картинкой (data-URL) — его клиент раз в несколько секунд
/// отправляет на сервер, чтобы остальные видели превью по наведению мышкой (#115). `null`, когда
/// нативного показа нет.
#[tauri::command]
async fn gv_screen_share_preview() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        return screenshare::preview();
    }
    #[cfg(not(target_os = "windows"))]
    None
}

/// The window currently in the foreground — for the "stream the focused window" hotkey. Returns
/// `{ id, exe, isSelf }` (id = HWND as a stringified u64, feeds screenshare's `source_id` with
/// `is_window: true`) or `null` when there's no foreground window. When `isSelf` (GusVoice's own
/// window is in front, so there's nothing else to stream) the caller opens the picker instead.
#[tauri::command]
fn gv_foreground_window() -> Result<Option<serde_json::Value>, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(apps_enum::foreground_window().and_then(|w| serde_json::to_value(w).ok()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("native screen share is Windows-only".into())
    }
}

/// Простой ввода на уровне ОС в миллисекундах: сколько прошло с последнего нажатия клавиши или
/// движения мыши **во всей системе**, а не только в нашем окне.
///
/// Зачем: авто-«отошёл» живёт в вебе и видит только DOM-события своего окна. Человек, играющий в
/// полноэкранную игру с GusVoice в фоне, для веб-слоя выглядит мёртвым — и через десять минут
/// уезжает в «отошёл», сидя за компьютером (ровно тот осознанный остаток, что записан в `afk.ts`).
/// `GetLastInputInfo` закрывает этот случай, потому что считает ввод по всей сессии.
///
/// Вне Windows возвращает `None` — вызывающая сторона тогда работает как раньше, по DOM-событиям.
///
/// Границы, которые стоит знать:
///  * геймпад (XInput) мимо этого API — играющий джойстиком всё ещё уйдёт в «отошёл»;
///  * заблокированный экран (Win+L) простой НЕ сбрасывает — и это правильно, человек ушёл;
///  * счётчик тиков 32-битный и переполняется примерно раз в 49.7 суток, поэтому разница считается
///    `wrapping_sub`: обычное вычитание раз в полтора месяца давало бы «простаивает 49 суток».
#[tauri::command]
fn gv_os_idle_ms() -> Option<u64> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::SystemInformation::GetTickCount;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        // SAFETY: структура живёт до конца вызова, cbSize заполнен — этого API и требует.
        let ok = unsafe { GetLastInputInfo(&mut info) };
        if !ok.as_bool() {
            return None;
        }
        let now = unsafe { GetTickCount() };
        Some(now.wrapping_sub(info.dwTime) as u64)
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Set the global push-to-talk mouse button (DOM `MouseEvent.button` index; < 0 disables). Lets a bound
/// mouse button drive PTT even when GusVoice isn't focused (Windows low-level mouse hook). No-op elsewhere.
#[tauri::command]
fn gv_ptt_set_mouse_button(button: i32) {
    #[cfg(target_os = "windows")]
    ptt_mouse::set_mouse_button(button);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = button;
    }
}

/// Set the global push-to-talk KEYBOARD key (Windows virtual-key; 0 disables). A low-level keyboard hook
/// emits ptt-key-down/up while the key is held so PTT works when GusVoice isn't focused (in a game) and a
/// release is seen even if focus changed mid-hold — the keyboard twin of gv_ptt_set_mouse_button. No-op elsewhere.
#[tauri::command]
fn gv_ptt_set_key(vk: u32) {
    #[cfg(target_os = "windows")]
    hotkey_key::set_ptt_key(vk);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = vk;
    }
}

/// Set the bitmask of mouse buttons bound to mute/deafen/screen-share hotkeys (bit i = DOM button i).
/// Lets a bound mouse button fire those toggles even when GusVoice isn't focused. No-op elsewhere.
#[tauri::command]
fn gv_hotkey_set_mouse_mask(mask: u32) {
    #[cfg(target_os = "windows")]
    ptt_mouse::set_hotkey_mask(mask);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = mask;
    }
}

/// Set the keyboard hotkeys bound to mute/deafen/screen-share/overlay, each packed `(mods << 16) | vk`
/// (mods bits Ctrl=1/Alt=2/Shift=4/Meta=8). A low-level keyboard hook fires them even when GusVoice is
/// unfocused, WITHOUT stealing the key from other apps (unlike RegisterHotKey). Empty list disables. No-op elsewhere.
#[tauri::command]
fn gv_hotkey_set_keys(keys: Vec<u32>) {
    #[cfg(target_os = "windows")]
    hotkey_key::set_keys(keys);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = keys;
    }
}

/// Hide the main window to the system tray (the "свернуть в трей" close behaviour). The tray icon
/// or its "Открыть" item restores it.
#[tauri::command]
fn gv_window_hide(window: tauri::WebviewWindow) {
    let _ = window.hide();
}

/// Quit the whole app (the "выйти полностью" close behaviour / tray "Выйти").
#[tauri::command]
fn gv_app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Мигнуть окном в панели задач — «тебя ткнули», когда GusVoice не в фокусе (TeamSpeak-style).
///
/// ⚠️ Намеренно НЕ `set_focus`: выдёргивать фокус из полноэкранной игры — это уронить игру, а тык
/// зовёт, а не тащит. `Informational` мигает иконкой в панели задач и ждёт, пока человек сам
/// переключится; окно из трея при этом не разворачиваем по той же причине.
/// ⚠️ Windows гасит мигание сам, когда окно получает фокус, — снимать флаг вручную не нужно.
///
/// 🔴 **Тело обязано быть под `cfg(desktop)`.** На Android у `WebviewWindow` метода
/// `request_user_attention` нет вовсе, и эта безобидная с виду команда роняла сборку APK целиком
/// (`E0599`). Три тега — v0.6.16, v0.6.17, v0.6.18 — уехали в хоумлаб без Android: джоба `windows`
/// оставалась зелёной, а красную `apk` рядом с ней никто не читал, и F-Droid молча стоял на
/// v0.6.15. Мигать иконкой в панели задач на телефоне нечему — тык там и так приходит тостом со
/// звуком, так что поведение мобильной сборки не меняется.
#[tauri::command]
fn gv_flash_window(window: tauri::WebviewWindow) {
    #[cfg(desktop)]
    {
        if window.is_focused().unwrap_or(false) {
            return; // человек и так смотрит — мигать нечему
        }
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
    // Параметр остаётся в сигнатуре и на мобиле: его форма — часть контракта команды.
    #[cfg(not(desktop))]
    let _ = window;
}

/// Open an external URL in the OS default browser via the shell. The Steam OpenID login (#40) needs
/// this: the main WebView must NEVER navigate off the embedded app — a full-page nav to another origin
/// drops the app's per-origin localStorage (token/settings), which reads as a logout + settings reset
/// (the v0.5.54 bug #43) — and `window.open` is a silent no-op in WebView2. So we shell the URL out to
/// the default browser; Steam returns to the web callback there, and the app refreshes the linked state
/// on window refocus. Only http(s) is honoured (guards against `file:`/custom-scheme abuse via ShellExecute).
#[tauri::command]
fn gv_open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("refusing to open a non-http(s) URL".into());
    }
    #[cfg(target_os = "windows")]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        // Wide, null-terminated. ShellExecuteW handles `&` in the query string correctly (unlike
        // `cmd /C start`, which would split the OpenID URL on its `&openid.*` params).
        let file: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
        let r = unsafe {
            ShellExecuteW(
                None,
                PCWSTR::null(), // default verb ("open")
                PCWSTR(file.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        // ShellExecuteW returns a value > 32 on success.
        if (r.0 as isize) <= 32 {
            return Err(format!("ShellExecuteW failed ({})", r.0 as isize));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = url;
        Err("gv_open_external is Windows-only".into())
    }
}

/// Reflect the user's live voice state on the system-tray icon + tooltip. Driven from the web client
/// (voiceTray.ts) — it calls this only when the DERIVED state flips (mute/deafen toggles + the same
/// local VAD "speaking" signal that lights the avatar ring, throttled). States → icon:
///   "idle"     → default GusVoice logo (not in a voice channel),
///   "silent"   → grey bubble  (mic live, not transmitting),
///   "speaking" → green bubble  (mic transmitting — matches the avatar speaking ring),
///   "muted"    → crossed-out microphone (red),
///   "deafened" → crossed-out headphones (red).
/// Icons are decoded at build time (`include_image!`, no runtime image feature). Desktop-only; the
/// tray doesn't exist on mobile, so this is a no-op there.
#[tauri::command]
fn gv_tray_set_state(app: tauri::AppHandle, state: String) {
    #[cfg(desktop)]
    {
        let Some(tray) = app.tray_by_id("main") else {
            return;
        };
        let (icon, tip) = match state.as_str() {
            "speaking" => (Some(tauri::include_image!("tray-icons/speaking.png")), "GusVoice — говорите"),
            "silent" => (Some(tauri::include_image!("tray-icons/silent.png")), "GusVoice — микрофон включён"),
            "muted" => (Some(tauri::include_image!("tray-icons/muted.png")), "GusVoice — микрофон выключен"),
            "deafened" => (Some(tauri::include_image!("tray-icons/deafened.png")), "GusVoice — звук выключен"),
            // idle / unknown → restore the default logo.
            _ => (app.default_window_icon().cloned(), "GusVoice"),
        };
        if let Some(icon) = icon {
            let _ = tray.set_icon(Some(icon));
        }
        let _ = tray.set_tooltip(Some(tip));
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, state);
    }
}

// ---- In-game voice overlay (see overlay.rs) — all desktop-only, no-op on mobile ----

/// Show the overlay window. **async** — window ops from a sync command can deadlock the Windows event
/// loop (see overlay.rs); async commands run off the main thread and are safe.
#[tauri::command]
async fn gv_overlay_show(app: tauri::AppHandle) {
    #[cfg(desktop)]
    let _ = overlay::show(&app, overlay::ROSTER);
    #[cfg(not(desktop))]
    let _ = app;
}

/// Hide the overlay window. async — see gv_overlay_show.
#[tauri::command]
async fn gv_overlay_hide(app: tauri::AppHandle) {
    #[cfg(desktop)]
    let _ = overlay::hide(&app, overlay::ROSTER);
    #[cfg(not(desktop))]
    let _ = app;
}

/// Toggle whether the overlay catches the mouse (true = positioning mode, drag; false = click-through).
/// async — see gv_overlay_show.
#[tauri::command]
async fn gv_overlay_set_interactive(app: tauri::AppHandle, interactive: bool) {
    #[cfg(desktop)]
    let _ = overlay::set_interactive(&app, overlay::ROSTER, interactive);
    #[cfg(not(desktop))]
    let _ = (app, interactive);
}

/// Anchor the overlay to a screen corner ("tl"|"tr"|"bl"|"br") with pixel margins. async — see gv_overlay_show.
#[tauri::command]
async fn gv_overlay_set_corner(app: tauri::AppHandle, corner: String, margin_x: i32, margin_y: i32) {
    #[cfg(desktop)]
    let _ = overlay::set_corner(&app, overlay::ROSTER, &corner, margin_x, margin_y);
    #[cfg(not(desktop))]
    let _ = (app, corner, margin_x, margin_y);
}

/// Push the voice roster + render settings from the MAIN window into the overlay window. The overlay
/// holds no connection of its own — it just renders this payload (see client overlay.ts ↔ VoiceOverlay).
#[tauri::command]
fn gv_overlay_push_state(app: tauri::AppHandle, payload: serde_json::Value) {
    #[cfg(desktop)]
    {
        use tauri::Emitter;
        let _ = app.emit_to("overlay", "gv-overlay-state", payload);
    }
    #[cfg(not(desktop))]
    let _ = (app, payload);
}

/// Read the overlay's current position (physical px) — the client persists it after a drag-reposition.
/// async — see gv_overlay_show.
#[tauri::command]
async fn gv_overlay_get_position(app: tauri::AppHandle) -> Option<(i32, i32)> {
    #[cfg(desktop)]
    {
        return overlay::position(&app, overlay::ROSTER).ok();
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        None
    }
}

/// Move the overlay to an absolute physical position (a persisted custom / dragged position).
/// async — see gv_overlay_show.
#[tauri::command]
async fn gv_overlay_set_position(app: tauri::AppHandle, x: i32, y: i32) {
    #[cfg(desktop)]
    let _ = overlay::set_position(&app, overlay::ROSTER, x, y);
    #[cfg(not(desktop))]
    let _ = (app, x, y);
}

/// Resize the overlay window to fit its content (logical px) — the overlay reports its own size so the
/// click-catching area (while positioning) stays tight to the card. async — see gv_overlay_show.
#[tauri::command]
async fn gv_overlay_set_size(app: tauri::AppHandle, w: f64, h: f64) {
    #[cfg(desktop)]
    let _ = overlay::set_size(&app, overlay::ROSTER, w, h);
    #[cfg(not(desktop))]
    let _ = (app, w, h);
}

// ---- Всплывающая плашка «кто кого типнул» (второе окно оверлея, см. overlay.rs) ----
//
// 🔴 Отдельное окно, а не режим ростера (решение 05.09): человек должен уметь держать ростер в
// углу и КРУПНУЮ плашку по центру одновременно, а у них разные позиция, размер и прозрачность.
// Команды повторяют набор ростера один в один и подчиняются тем же правилам: `async fn`, потому что
// оконная операция из синхронной команды дедлочит событийный цикл Windows.

/// Показать окно плашки. async — см. gv_overlay_show.
#[tauri::command]
async fn gv_toast_show(app: tauri::AppHandle) {
    #[cfg(desktop)]
    let _ = overlay::show(&app, overlay::TOAST);
    #[cfg(not(desktop))]
    let _ = app;
}

/// Скрыть окно плашки. async — см. gv_overlay_show.
#[tauri::command]
async fn gv_toast_hide(app: tauri::AppHandle) {
    #[cfg(desktop)]
    let _ = overlay::hide(&app, overlay::TOAST);
    #[cfg(not(desktop))]
    let _ = app;
}

/// Ловит ли плашка мышь (true — режим расстановки, можно таскать). async — см. gv_overlay_show.
#[tauri::command]
async fn gv_toast_set_interactive(app: tauri::AppHandle, interactive: bool) {
    #[cfg(desktop)]
    let _ = overlay::set_interactive(&app, overlay::TOAST, interactive);
    #[cfg(not(desktop))]
    let _ = (app, interactive);
}

/// Прижать плашку к углу экрана ("tl"|"tr"|"bl"|"br"|"c") с отступами. async — см. gv_overlay_show.
#[tauri::command]
async fn gv_toast_set_corner(app: tauri::AppHandle, corner: String, margin_x: i32, margin_y: i32) {
    #[cfg(desktop)]
    let _ = overlay::set_corner(&app, overlay::TOAST, &corner, margin_x, margin_y);
    #[cfg(not(desktop))]
    let _ = (app, corner, margin_x, margin_y);
}

/// Толкнуть событие из ГЛАВНОГО окна в окно плашки. Плашка своего соединения не держит — рисует то,
/// что ей прислали (см. клиентские `tipToast.ts` ↔ `TipToast.tsx`).
#[tauri::command]
fn gv_toast_push_state(app: tauri::AppHandle, payload: serde_json::Value) {
    #[cfg(desktop)]
    {
        use tauri::Emitter;
        let _ = app.emit_to("toast", "gv-toast-state", payload);
    }
    #[cfg(not(desktop))]
    let _ = (app, payload);
}

/// Текущее положение плашки (физические px) — клиент сохраняет его после перетаскивания.
#[tauri::command]
async fn gv_toast_get_position(app: tauri::AppHandle) -> Option<(i32, i32)> {
    #[cfg(desktop)]
    {
        return overlay::position(&app, overlay::TOAST).ok();
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        None
    }
}

/// Поставить плашку в абсолютную позицию (сохранённую после перетаскивания).
#[tauri::command]
async fn gv_toast_set_position(app: tauri::AppHandle, x: i32, y: i32) {
    #[cfg(desktop)]
    let _ = overlay::set_position(&app, overlay::TOAST, x, y);
    #[cfg(not(desktop))]
    let _ = (app, x, y);
}

/// Задать размер окна плашки (логические px).
#[tauri::command]
async fn gv_toast_set_size(app: tauri::AppHandle, w: f64, h: f64) {
    #[cfg(desktop)]
    let _ = overlay::set_size(&app, overlay::TOAST, w, h);
    #[cfg(not(desktop))]
    let _ = (app, w, h);
}

/// Enumerate the user's currently-open apps (exe + name + icon) for the overlay "выбранные приложения"
/// picker. Windows-only; returns an empty list elsewhere. Icon extraction is slowish → off-thread.
#[tauri::command]
async fn gv_list_apps() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let apps = tauri::async_runtime::spawn_blocking(apps_enum::list_apps)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_value(apps).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(serde_json::Value::Array(vec![]))
    }
}

/// Enable/disable the overlay foreground watcher (for "выбранные приложения" mode). The client turns it
/// on only when that mode is active, so the thread stays idle otherwise. Windows-only; no-op elsewhere.
#[tauri::command]
fn gv_overlay_watch(on: bool) {
    #[cfg(target_os = "windows")]
    FG_WATCH_ON.store(on, std::sync::atomic::Ordering::Relaxed);
    #[cfg(not(target_os = "windows"))]
    let _ = on;
}

/// Opt-in flag for the foreground watcher — set via `gv_overlay_watch`. The watcher thread is always
/// alive but stays idle (only sleeps) unless this is true, so it polls/emits ONLY while the user has
/// the overlay "выбранные приложения" mode enabled (not always-on).
#[cfg(target_os = "windows")]
static FG_WATCH_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Background watcher: while enabled, emit `gv-foreground-app` (exe basename) whenever the foreground
/// window changes, so the client shows/hides the overlay in "выбранные приложения" mode. Windows-only.
#[cfg(target_os = "windows")]
fn start_foreground_watch(app: tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri::Emitter;
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(700));
            if !FG_WATCH_ON.load(Ordering::Relaxed) {
                last.clear();
                continue;
            }
            let cur = apps_enum::foreground_exe().unwrap_or_default();
            if cur != last {
                last = cur.clone();
                let _ = app.emit("gv-foreground-app", cur);
            }
        }
    });
}

/// Build the system-tray icon + menu (Открыть / Выйти). Left-click restores the window.
#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::Manager;

    fn show_main(app: &tauri::AppHandle) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }

    let open_i = MenuItem::with_id(app, "open", "Открыть GusVoice", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_i, &quit_i])?;

    let _tray = TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("GusVoice")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Tauri's updater downloads each installer into a fresh temp dir named
/// `GusVoice-<ver>-updater-<rand>` and never deletes it, so they accumulate in
/// %LOCALAPPDATA%\Temp (~3.9 MB each, one per update — 22 had piled up). Purge any
/// leftovers on launch; the running app is already installed, so none are needed.
/// Best-effort — ignore every error. The current update's dir (if any) is created
/// AFTER this runs, so it survives until the next launch.
#[cfg(desktop)]
fn purge_updater_leftovers() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("GusVoice-") && name.contains("-updater-") {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // Desktop-only plugins (driven from the web client via their JS APIs):
    //  * global-shortcut — mute/deafen/screen-share hotkeys fire even when GusVoice is unfocused.
    //  * updater + process — Discord-style auto-update: the client checks on launch, downloads the
    //    signed build and relaunch()es into it.
    //  * notification — OS toasts for mentions/DMs while the window is unfocused (notifications.ts).
    #[cfg(desktop)]
    {
        // ⚠️ single-instance регистрируется ПЕРВЫМ — так требует сам плагин: он должен перехватить
        // запуск до того, как остальные плагины начнут занимать ресурсы второго процесса.
        //
        // 🔴 Зачем (#108): приложение закрывается В ТРЕЙ, а человек возвращается к нему кликом по
        // ярлыку на рабочем столе — это самый естественный жест, и именно он поднимал ВТОРОЙ
        // процесс. Дальше два экземпляра входили в LiveKit с ОДНОЙ identity (= userId), сервер
        // вышибал того, кто вошёл раньше, и со стороны это выглядело как «клиент сам замолчал».
        // Плюс каждый экземпляр тянет свой куст msgedgewebview2 — отсюда и лес процессов в
        // диспетчере задач.
        //
        // Колбэк вызывается в УЖЕ РАБОТАЮЩЕМ экземпляре, когда стартует второй; второй после этого
        // завершается сам. `unminimize` перед `show` обязателен: свёрнутое окно от одного `show`
        // остаётся свёрнутым, и клик по ярлыку выглядел бы как «ничего не произошло».
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
        builder = builder
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_dialog::init());
    }
    builder
        .invoke_handler(tauri::generate_handler![
            gv_audio_record_wav,
            gv_stream_audio_start,
            gv_stream_audio_stop,
            gv_screen_sources,
            gv_screen_share_start,
            gv_screen_share_stop,
            gv_screen_share_stats,
            gv_screen_share_preview,
            gv_shake_window,
            // Диагностика #100 — только Windows: PDH-счётчики видеопамяти и дескрипторов.
            // ⚠️ Атрибут действует РОВНО на одну следующую строку, поэтому он нужен КАЖДОЙ команде
            // отдельно. Забытый на второй строке гейт уронил джобу `apk` целиком (E0433: модуль
            // `diag` на Android выключен) — и уронил молча, рядом с зелёной сборкой десктопа.
            #[cfg(all(target_os = "windows", feature = "diag"))]
            diag::gv_diag_snapshot,
            #[cfg(all(target_os = "windows", feature = "diag"))]
            diag::gv_os_info,
            #[cfg(all(target_os = "windows", feature = "diag"))]
            diag::gv_app_version,
            gv_foreground_window,
            gv_os_idle_ms,
            gv_hide_share_indicator,
            gv_ptt_set_mouse_button,
            gv_ptt_set_key,
            gv_hotkey_set_mouse_mask,
            gv_hotkey_set_keys,
            gv_window_hide,
            gv_app_quit,
            gv_flash_window,
            gv_open_external,
            gv_tray_set_state,
            gv_overlay_show,
            gv_overlay_hide,
            gv_overlay_set_interactive,
            gv_overlay_set_corner,
            gv_overlay_push_state,
            gv_overlay_get_position,
            gv_overlay_set_position,
            gv_overlay_set_size,
            gv_toast_show,
            gv_toast_hide,
            gv_toast_set_interactive,
            gv_toast_set_corner,
            gv_toast_push_state,
            gv_toast_get_position,
            gv_toast_set_position,
            gv_toast_set_size,
            gv_list_apps,
            gv_overlay_watch,
            gv_set_download_dir,
            gv_close_ack
        ])
        .setup(|_app| {
            // System tray + close-to-tray: intercept the window's X, prevent the default close, and
            // let the web client decide (свернуть в трей / выйти / спросить) by handling `gv-close-requested`.
            #[cfg(desktop)]
            {
                use tauri::{Emitter, Manager};
                // Clean up installer temp dirs left behind by past auto-updates.
                purge_updater_leftovers();
                setup_tray(_app)?;
                // Create the overlay window ONCE, here — `setup` is the safe place to `build()`. Building
                // a WebviewWindow from a sync command/event-handler deadlocks the Windows event loop
                // (the v0.5.38 wedge). It's hidden + click-through; commands only ever show/position it.
                let _ = overlay::ensure(_app.handle(), overlay::ROSTER);
                // Второе окно — всплывающая плашка «кто кого типнул». Создаётся ЗДЕСЬ по той же
                // причине, что и первое: `build()` из команды дедлочит событийный цикл Windows.
                let _ = overlay::ensure(_app.handle(), overlay::TOAST);
                if let Some(window) = _app.get_webview_window("main") {
                    let emitter = window.clone();
                    let handle = _app.handle().clone();
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let id = CLOSE_REQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                            let _ = emitter.emit("gv-close-requested", ());
                            /*
                             * 🔴 **Страховка на случай мёртвого интерфейса (#125/#127, 05.09).**
                             * Решение о закрытии принимает веб-клиент — а если он умер (исключение
                             * при отрисовке сносило всё дерево React), слушать событие некому, и
                             * окно становилось НЕЗАКРЫВАЕМЫМ: крестик не работал, оставался только
                             * диспетчер задач. Снятие процесса Windows записывает как `AppHangB1`,
                             * поэтому два дня это выглядело зависанием — хотя дамп показал
                             * совершенно здоровый процесс в обычном ожидании сообщений.
                             * ⚠️ Ждём не «жив ли фронт», а ПОДТВЕРЖДЕНИЕ, что он взялся за это
                             * закрытие: живой клиент отвечает мгновенно, ещё до показа выбора, и
                             * дальше человек думает сколько угодно. Не ответил за секунду с
                             * небольшим — выходим сами, потому что окно без интерфейса всё равно
                             * бесполезно.
                             */
                            let h = handle.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(CLOSE_ACK_MS));
                                if CLOSE_ACK.load(std::sync::atomic::Ordering::SeqCst) < id {
                                    h.exit(0);
                                }
                            });
                        }
                    });
                }
            }
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                ptt_mouse::init(_app.handle().clone());
                hotkey_key::init(_app.handle().clone());
                // Overlay "выбранные приложения" mode: watcher thread — stays idle until the client
                // calls gv_overlay_watch(true) (opt-in, not always-on).
                start_foreground_watch(_app.handle().clone());
                // Оверлей поверх игр: возвращать его в topmost-группу, когда игра оттуда выбрасывает
                // (бит в стилях при этом остаётся, теряется только позиция — см. overlay.rs).
                #[cfg(target_os = "windows")]
                overlay::start_topmost_guard();
                if let Some(window) = _app.get_webview_window("main") {
                    grant_media_permissions(&window);
                    suppress_screen_capture_ui(&window);
                    disable_browser_chrome(&window);
                    wire_download_notifications(&window);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, _event| {
            // Уходим штатно — снимаем отметку «показ идёт», иначе закрытое с работающим показом
            // приложение неотличимо от упавшего и следующий показ теряет второй слой (#109).
            #[cfg(target_os = "windows")]
            if matches!(_event, tauri::RunEvent::Exit) {
                screenshare::clear_active_marker(_app);
            }
        });
}
