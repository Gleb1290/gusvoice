# Трейс WebView2 десктопа

Показывает, кто в процессах WebView2 ест процессор: страница, процесс видеокарты, браузер, звук.
Этим 27.09 нашли вечный `requestAnimationFrame` livekit-client, GIF-аватарки и пересылку звука
показа (#193, карта `docs/codemap/client.md` → «что на самом деле рисовало интерфейс»).

1. Закрыть GusVoice и запустить снова с портом отладки и без прокси (PowerShell):

   ```powershell
   foreach ($v in 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY') { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy --remote-debugging-port=9224'
   Start-Process "$env:LOCALAPPDATA\GusVoice\gusvoice.exe"
   ```

   ⚠️ Переменная ЗАМЕНЯЕТ набор из `gpu_mode.rs`, поэтому его флаги повторены.
2. `node trace.mjs 9224 20 имя` — 20 с трейса всех процессов в `имя.json`.
3. `node --max-old-space-size=8192 analyze.mjs имя.json` — процессор по процессам и потокам (мс в
   секунду, 1000 = ядро), частоты кадров, горячий JS.
4. Уточнить: `perpid.mjs имя.json` — кадры и отрисовка по процессам; `tasks.mjs имя.json Renderer
   CrRendererMain` — из чего состоят задачи главного потока; `ev.mjs 9224 main 'выражение'` —
   выполнить JS в странице (`main`, `overlay`, `toast`).

Сравнивать только состояния на ОДНОЙ машине и в одном положении окна: трейс — не телеметрия.
Потом перезапустить приложение обычным способом, чтобы закрыть порт.
