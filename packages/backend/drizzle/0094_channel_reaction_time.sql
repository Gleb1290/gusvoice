-- Реакции в каналах серверов: момент постановки (G75, #211) — по нему чипы рисуют аватарки поставивших в порядке постановки
-- (как в ЛС, `dm_message_reactions.created_at`). Только добавление колонки: старые строки получают момент миграции, старый
-- код колонку не знает и не трогает.
ALTER TABLE message_reactions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
