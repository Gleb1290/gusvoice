# Примеры ботов GusVoice

Готовые боты на [`@gusvoice/bot`](../../packages/bot-sdk/README.md) и один пример на чистом `curl`. Лицензия — MIT ([LICENSE](LICENSE)):
берите, правьте, запускайте — ваш бот не станет AGPL. Документация API — [docs/bots.md](../../docs/bots.md).

## Общее

1. Создайте бота: «Настройки → Мои боты → Создать бота», скопируйте токен `gvb_…` (показывается один раз).
2. Откройте с ботом беседу и нажмите «Старт»: **бот не пишет первым**.
3. Токен — только из окружения (`GUSVOICE_BOT_TOKEN`), никогда не в коде, не в репозитории, не в образе.
4. Бот находится по нику, поэтому команды с последствиями проверяют `from.id` из `OWNER_IDS` (свой id покажет `/whoami` в `vps-panel.ts`).
   `callback_data` кнопок приходит от клиента человека: каждое нажатие проверяйте так же, как команду.
5. Node.js 22+. На Node 18–21: `MODE=polling` (или передайте пакет `ws`, см. README SDK).

SDK ставится из npm: `npm i @gusvoice/bot` (голос — ещё `@gusvoice/bot-voice`), Python — `pip install gusvoice-bot`; внутри репозитория
типы и импорты берутся из исходников (`tsconfig.json` в этом каталоге).

## Что здесь есть

| Файл | Что показывает | Как запустить | Что нужно |
|---|---|---|---|
| `echo.ts` | Бот в 15 строк: `command('start')`, эхо на любое сообщение, `bot.start()` | `GUSVOICE_URL=… GUSVOICE_BOT_TOKEN=… npx tsx echo.ts` | Node 22+, токен |
| `webhook-node.ts` | Приём событий на адрес: `setWebhook`, `webhookHandler`, `toNodeHandler`, проверка подписи, запуск за обратным прокси, `/healthz` | `GUSVOICE_URL=… GUSVOICE_BOT_TOKEN=… PUBLIC_URL=https://bot.example.com/hook HOOK_SECRET=… npx tsx webhook-node.ts` | токен, публичный https-адрес на прокси, `HOOK_SECRET` (16–256 символов) |
| `vps-panel.ts` | Панель VPS: `/panel` с кнопками, `/status`, `/restart <служба>` из белого списка, `/whoami`, меню команд | `… OWNER_IDS=<id> RESTART_SERVICES=nginx,docker npx tsx vps-panel.ts` | токен, `OWNER_IDS`, права на `systemctl restart` (sudoers) |
| `server-moderator.ts` | Бот-модератор сервера: `/ping`, `/warn` с кнопками «Кикнуть» / «Отмена» по ролям, приветствие новичка | `… MOD_ROLE_IDS=… WELCOME_CHANNEL_ID=… npx tsx server-moderator.ts` | токен, бот добавлен на сервер с правами, id ролей и канала |
| `music.ts` | Звук в голосовом канале: `/play`, `/skip`, `/queue` … (`@gusvoice/bot-voice`) | `… npx tsx music.ts` | токен, `ffmpeg`, glibc-Linux/macOS/Windows (не Alpine), право «Подключаться»+«Говорить» |
| `notify.sh` | Уведомление себе одной строкой `curl`, без SDK | `GUSVOICE_API=… GUSVOICE_BOT_TOKEN=… GUSVOICE_CHAT_ID=… ./notify.sh "Бэкап готов"` | `curl`, токен, id беседы |
| `notify.py` | То же уведомление на Python без SDK (только стандартная библиотека) | `GUSVOICE_API=… GUSVOICE_BOT_TOKEN=… GUSVOICE_CHAT_ID=… python3 notify.py "Бэкап готов"` | Python 3.9+, токен |
| `echo.py` | Эхо-бот на Python SDK (`packages/bot-sdk-py`): `/start`, `/whoami`, эхо, долгий опрос | `GUSVOICE_URL=… GUSVOICE_BOT_TOKEN=… python3 echo.py` | Python 3.9+, `pip install gusvoice-bot` (или `PYTHONPATH=packages/bot-sdk-py`), токен |
| `panel.py` | Мини-панель сервера: `/status` (загрузка, память, диск), кнопка «Обновить», проверка `OWNER_IDS` на сообщениях и кнопках | `… OWNER_IDS=<ваш id> python3 panel.py` | Python 3.9+, токен, свой id |
| `webhook.py` | Приём событий на адрес на Python: `http.server`, проверка подписи, пачки | `… python3 webhook.py` (за обратным прокси с HTTPS) | Python 3.9+, публичный HTTPS-адрес |
| `tsconfig.json` | Проверка типов примеров: `tsc -p examples/bots/tsconfig.json` (в CI — через `packages/bot-sdk`, `pnpm typecheck`) | — | — |
| `LICENSE` | MIT; лежит рядом, чтобы не терялся при копировании каталога | — | — |
| `systemd/my-bot.service` | Бот службой systemd на VPS: свой пользователь, `EnvironmentFile` с токеном, перезапуск, ограничения прав | инструкция — в шапке файла | VPS с systemd |
| `docker/Dockerfile` | Бот в контейнере (`node:24-bookworm-slim`, не root, точные версии) | `docker build -f docker/Dockerfile --build-arg BOT_FILE=echo.ts -t my-bot .` | Docker |
| `docker/bot.env.example` | Образец окружения (без значений): скопировать, заполнить, права 600 | — | — |
| `docker/Dockerfile.dockerignore` | В образ попадают только файлы примеров | — | — |

## Как держать бота круглосуточно

- **systemd** (`systemd/my-bot.service`): `Restart=on-failure`, лимит перезапусков (при 401 «токен перевыпущен» SDK завершается,
  а не долбит сервер), токен в `/etc/my-bot/env` с правами 600.
- **Docker**: `--restart unless-stopped` и `--env-file`. Для голоса нужен ffmpeg в образе (комментарий в `Dockerfile`).
- За обратным прокси `webhook-node.ts` слушает только `127.0.0.1`; прокси не должен менять тело запроса — подпись считается по сырым байтам.
- Не запускайте бота от root. Если ему нужно перезапускать службы — отдельное правило sudoers на конкретные команды.
