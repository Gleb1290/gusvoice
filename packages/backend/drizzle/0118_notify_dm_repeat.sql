-- Остаток настроек уведомлений как у Telegram (08.10, #211, G38, признак `push3`). Только добавления: старый код колонок не знает.
-- users.notify_dm — «Личные сообщения»: false — пуш и всплывашки личных 1:1 не приходят (группы — notify_groups, заглушка беседы — push_mutes).
-- users.notify_repeat — «Повторять уведомления» (минуты 0|5|10|30|60|120|240, 0 — не повторять): сервер повторяет пуш висящей непрочитанной ЛС.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_dm boolean NOT NULL DEFAULT true;
-- 08.10 (решение владельца 14): умолчание — 60 минут, как у Telegram (`repeat_messages` = 60). Здесь, а не только в 0124: на
-- базах, где 0118 ещё не применялась (прод), колонка появляется сразу с 60 у ВСЕХ — выбрать «Никогда» там ещё никто не мог.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_repeat integer NOT NULL DEFAULT 60;
