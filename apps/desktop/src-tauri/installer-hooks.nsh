; Схема `gusvoice://` для ссылок-приглашений (#139, F4, план §4.2.2).
;
; 🔴 Почему схема, а не обычная https-ссылка. Windows связывает `https://` с приложением только для
; упакованных MSIX; у нас NSIS, и другого пути открыть приложение по клику в мессенджере нет.
; Страница `/i/<код>` на хосте вызывает `gusvoice://join?invite=…`, Windows находит запись ниже и
; запускает нас с этим адресом в аргументах. Уже запущенный экземпляр получает его через
; single-instance (см. `lib.rs`), новый — из своей командной строки.
;
; 🔴 Пишем в HKCU, а не HKLM: установщик у нас пользовательский (per-user NSIS), и запись в машинную
; ветку потребовала бы прав администратора — то есть окна UAC там, где его до сих пор не было.
;
; ⚠️ `URL Protocol` — пустое значение-МАРКЕР, а не строка с адресом: именно его наличие говорит
; Windows, что ключ описывает схему. Значение по умолчанию — человекочитаемое имя, его показывает
; браузер в вопросе «открыть приложение GusVoice?».
;
; ⚠️ Кавычки вокруг `$INSTDIR\${MAINBINARYNAME}.exe` обязательны: путь установки содержит пробелы
; («C:\Users\Имя Фамилия\AppData\…»), и без них Windows передаст приложению обрезанный путь.
;
; 🔴 Имя программы — `${MAINBINARYNAME}.exe`, как в самом шаблоне Tauri (`installer.nsi`). До 23.09 здесь
; стояла переменная `$EXECUTABLE`, которой в шаблоне нет: NSIS молча записал её в реестр буквально
; («…\GusVoice\$EXECUTABLE»), и ссылка из браузера не открыла бы приложение ни у кого. Поймано только
; установкой пробной сборки: сборка и тесты этого не видят.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\gusvoice" "" "URL:GusVoice"
  WriteRegStr HKCU "Software\Classes\gusvoice" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\gusvoice\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\gusvoice\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Снимаем за собой: оставленная схема вела бы на удалённый файл, и клик по ссылке давал бы
  ; системную ошибку вместо честного «приложение не установлено» на странице перехода.
  DeleteRegKey HKCU "Software\Classes\gusvoice"
!macroend
