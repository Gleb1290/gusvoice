//! Системное уведомление, которое знает про клик (#212, этап 0 ЛС, Б11).
//!
//! 🔴 Плагин `tauri-plugin-notification` на десктопе клик не отдаёт: `sendNotification` показывает тост и
//! забывает о нём. В браузере клик по уведомлению ЛС открывал беседу (`Notification.onclick`), а в
//! десктопе только поднимал окно — человек искал, кто ему написал. Под плагином лежит тот же
//! `notify-rust`, и он умеет ждать ответа на тост: здесь мы показываем тост сами и на клик по телу
//! поднимаем окно и шлём клиенту `gv://notify-click` с меткой, которую он дал (`notifications.ts`).
//!
//! ⚠️ Клик ловится, пока тост на экране: после таймаута он уходит в Центр уведомлений, наш поток
//! заканчивается, и клик оттуда только запускает приложение по ярлыку (single-instance поднимет окно,
//! беседу не откроет). Держать поток на каждый тост до конца сессии — дороже, чем эта разница.

/// Показать тост; клик по телу — окно наверх и `gv://notify-click` с `tag`.
#[tauri::command]
pub fn gv_notify_clickable(app: tauri::AppHandle, title: String, body: String, tag: String) {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        let identifier = app.config().identifier.clone();
        let installed = installed_build();
        std::thread::spawn(move || {
            let mut n = notify_rust::Notification::new();
            n.summary(&title).body(&body);
            // Как у плагина: AppUserModelID приложения — только у установленной сборки. У сборки из
            // `target\` ярлыка с этим ID нет, и Windows такой тост молча не показала бы.
            if installed {
                n.app_id(&identifier);
            }
            let Ok(handle) = n.show() else { return };
            // Ошибка ожидания — тост закрыт без ответа системы; делать с этим нечего.
            let _ = handle.wait_for_response(|r: &notify_rust::NotificationResponse| {
                if !matches!(r, notify_rust::NotificationResponse::Default) {
                    return;
                }
                use tauri::Emitter;
                if let Some(w) = app.get_webview_window("main") {
                    crate::set_main_webview_shown(&w, true);
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                    let _ = w.emit("gv://notify-click", tag.clone());
                }
            });
        });
    }
    // На других платформах команды нет по смыслу (десктоп у нас — Windows), но форма контракта та же.
    #[cfg(not(target_os = "windows"))]
    let _ = (app, title, body, tag);
}

/// Установленная сборка, а не запуск из `target\debug|release` (та же проверка, что у плагина).
#[cfg(target_os = "windows")]
fn installed_build() -> bool {
    let Ok(exe) = std::env::current_exe() else { return true };
    let Some(dir) = exe.parent() else { return true };
    let dir = dir.to_string_lossy().to_lowercase();
    !(dir.ends_with("\\target\\debug") || dir.ends_with("\\target\\release"))
}
