-- Групповые ЛС до 5 человек (С4 плана «телеграмности», #211, решение владельца Р-5). Только добавления: старый код
-- колонок не знает, а группы старому клиенту сервер не отдаёт вовсе (признак groups1).
-- conversations.title / avatar_url — название и фото группы (у беседы 1:1 — NULL).
-- Служебные записи группы («создал», «добавил», «удалил», «вышел», «переименовал», «сменил фото») пишутся в уже
-- существующую conversation_messages.service (миграция 0097) видом {kind:'group', type, users?, title?}.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS avatar_url text;
