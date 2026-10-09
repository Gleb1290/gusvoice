//! Тост беседы с полем ответа и кнопками «Ответить» / «Прочитано» (07.10, #211, Р1, G17).
//!
//! Источник поведения — tdesktop `platform/win/notifications_manager_win.cpp` (ToastNotification с `<input>` и
//! `<action hint-inputId>`: ответ уходит без открытия окна, «Пометить прочитанным», снятие тостов прочитанной беседы
//! из Центра уведомлений). Код Telegram не копировался. `notify-rust` поля ввода не умеет, поэтому XML тоста
//! собираем сами и показываем через WinRT `ToastNotificationManager` (те же `windows` 0.61, что под notify-rust).
//!
//! Ответ человека — событие `gv://notify-action` `{tag, group, action, text}` клиенту (`notifications.ts`): `open` —
//! клик по телу (окно наверх, как у `os_notify::gv_notify_clickable`), `reply` — текст из поля (окно НЕ поднимаем,
//! клиент шлёт сообщение своей очередью отправки), `read` — пометить беседу прочитанной. `group` — id беседы: им
//! [gv_notify_remove] снимает тосты беседы, когда её прочитали (здесь или на другом устройстве).
//!
//! ⚠️ Ответ ловится событием `Activated` нашего процесса — пока приложение живо (окно или трей) и ждущий поток не
//! вышел (закрытие тоста, новое поколение беседы или 30 минут). Ответ из Центра уведомлений после выхода из
//! приложения не дойдёт — у tdesktop для этого COM-активатор, у нас его нет.

/// Показать тост беседы. `tag` — метка клиента (обработчик клика), `group` — id беседы.
#[tauri::command]
pub fn gv_notify_conversation(app: tauri::AppHandle, title: String, body: String, tag: String, group: String) {
    #[cfg(target_os = "windows")]
    {
        let app_id = app_id(&app);
        let gen = bump(&group);
        std::thread::spawn(move || {
            if let Err(e) = win::show(&app, &app_id, &title, &body, &tag, &group, gen) {
                eprintln!("[gv-notify] conversation toast failed: {e:?}");
            }
        });
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (app, title, body, tag, group);
}

/// Снять тосты беседы `group` из Центра уведомлений (беседу прочитали). Ошибки молча: тостов могло и не быть.
#[tauri::command]
pub fn gv_notify_remove(app: tauri::AppHandle, group: String) {
    #[cfg(target_os = "windows")]
    {
        bump(&group); // ждущие потоки этой беседы заканчиваются
        win::remove_group(&app_id(&app), &group);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (app, group);
}

/// AppUserModelID тоста: у установленной сборки — свой; у сборки из `target\` ярлыка с ним нет, и Windows такой тост
/// молча не показала бы — тогда от имени PowerShell, как делает notify-rust.
#[cfg(target_os = "windows")]
fn app_id(app: &tauri::AppHandle) -> String {
    let exe_in_target = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.to_string_lossy().to_lowercase()))
        .map(|d| d.ends_with("\\target\\debug") || d.ends_with("\\target\\release"))
        .unwrap_or(false);
    if exe_in_target {
        "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe".to_string()
    } else {
        app.config().identifier.clone()
    }
}

/// Поколения тостов по беседе: новый тост или «прочитано» сдвигают номер, и старые ждущие потоки выходят.
#[cfg(target_os = "windows")]
fn generations() -> std::sync::MutexGuard<'static, std::collections::HashMap<String, u64>> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static GENS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    GENS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(target_os = "windows")]
fn bump(group: &str) -> u64 {
    let mut m = generations();
    let g = m.entry(group.to_string()).or_insert(0);
    *g += 1;
    *g
}

#[cfg(target_os = "windows")]
fn peek(group: &str) -> u64 {
    generations().get(group).copied().unwrap_or(0)
}

/// Экранирование текста для XML тоста (управляющие символы, кроме перевода строки и табуляции, выбрасываются).
pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

/// XML тоста беседы: заголовок, текст, поле ответа, «Ответить» (с полем), «Прочитано»; без звука (звук играет клиент).
pub fn toast_xml(title: &str, body: &str) -> String {
    format!(
        concat!(
            "<toast launch=\"open\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual>",
            "<actions><input id=\"gvReply\" type=\"text\" placeHolderContent=\"Сообщение\"/>",
            "<action content=\"Ответить\" arguments=\"reply\" hint-inputId=\"gvReply\" activationType=\"foreground\"/>",
            "<action content=\"Прочитано\" arguments=\"read\" activationType=\"foreground\"/></actions>",
            "<audio silent=\"true\"/></toast>"
        ),
        xml_escape(title),
        xml_escape(body)
    )
}

#[cfg(target_os = "windows")]
mod win {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use windows::core::{IInspectable, Interface, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::{IPropertyValue, TypedEventHandler};
    use windows::UI::Notifications::{
        ToastActivatedEventArgs, ToastDismissalReason, ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification,
        ToastNotificationManager,
    };

    /// Группа и метка тоста WinRT — не длиннее 64 символов.
    fn cut(s: &str) -> HSTRING {
        HSTRING::from(s.chars().take(64).collect::<String>())
    }

    pub fn remove_group(app_id: &str, group: &str) {
        if let Ok(h) = ToastNotificationManager::History() {
            let _ = h.RemoveGroupWithId(&cut(group), &HSTRING::from(app_id));
        }
    }

    enum Ev {
        Act(String, String),
        Gone(bool),
    }

    pub fn show(
        app: &tauri::AppHandle,
        app_id: &str,
        title: &str,
        body: &str,
        tag: &str,
        group: &str,
        gen: u64,
    ) -> windows::core::Result<()> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(super::toast_xml(title, body)))?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        toast.SetGroup(&cut(group))?;
        toast.SetTag(&cut(tag))?;

        let (tx, rx) = mpsc::channel::<Ev>();
        let tx_a = tx.clone();
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, insp| {
            let mut action = String::from("open");
            let mut text = String::new();
            if let Some(args) = insp.as_ref().and_then(|i| i.cast::<ToastActivatedEventArgs>().ok()) {
                if let Ok(a) = args.Arguments() {
                    if !a.is_empty() {
                        action = a.to_string();
                    }
                }
                if let Some(s) = args
                    .UserInput()
                    .ok()
                    .and_then(|input| input.Lookup(&HSTRING::from("gvReply")).ok())
                    .and_then(|v| v.cast::<IPropertyValue>().ok())
                    .and_then(|pv| pv.GetString().ok())
                {
                    text = s.to_string();
                }
            }
            let _ = tx_a.send(Ev::Act(action, text));
            Ok(())
        }))?;
        let tx_d = tx.clone();
        toast.Dismissed(&TypedEventHandler::<ToastNotification, ToastDismissedEventArgs>::new(move |_, args| {
            // Таймаут — тост ушёл в Центр уведомлений и ещё может ответить; закрыт человеком или приложением — всё.
            let timed_out = args.as_ref().and_then(|a| a.Reason().ok()) == Some(ToastDismissalReason::TimedOut);
            let _ = tx_d.send(Ev::Gone(!timed_out));
            Ok(())
        }))?;
        toast.Failed(&TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, _| {
            let _ = tx.send(Ev::Gone(true));
            Ok(())
        }))?;

        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&toast)?;

        // Ждём ответа, пока тост жив: до закрытия, нового поколения беседы (прочитано / новый тост) или 30 минут.
        let deadline = Instant::now() + Duration::from_secs(30 * 60);
        loop {
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ev::Act(action, text)) => {
                    emit(app, tag, group, &action, &text);
                    return Ok(());
                }
                Ok(Ev::Gone(true)) | Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
                Ok(Ev::Gone(false)) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if Instant::now() >= deadline || super::peek(group) != gen {
                return Ok(());
            }
        }
    }

    fn emit(app: &tauri::AppHandle, tag: &str, group: &str, action: &str, text: &str) {
        use tauri::{Emitter, Manager};
        let Some(w) = app.get_webview_window("main") else { return };
        if action == "open" {
            crate::set_main_webview_shown(&w, true);
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        let _ = w.emit(
            "gv://notify-action",
            serde_json::json!({ "tag": tag, "group": group, "action": action, "text": text }),
        );
    }
}
