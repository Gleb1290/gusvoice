-- Настройки уведомлений как у Telegram (08.10, #211, G38, признак `push2`). Только добавления: старый код колонок не знает.
-- users.notify_view — «Показывать имя / текст»: all (имя и текст) | name (имя, текст скрыт) | nothing (ни имени, ни текста);
--   чтит сервер в пуше на телефон, клиент — во всплывашке браузера и тосте десктопа (`shared/notifyView.ts`).
-- users.notify_groups — «Уведомления из групп»: false — пуш участнику группы не уходит (личные 1:1 — как были).
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_view text NOT NULL DEFAULT 'all';
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_groups boolean NOT NULL DEFAULT true;
