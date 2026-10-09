-- «Был(а) в сети» и «Прочитано в 12:34» (С1 плана «телеграмности», #211). Только добавления: старый код колонок не знает.
-- users.last_seen_at — момент входа в сеть / выхода из неё (шлюз); null — не заходил после миграции («был(а) давно»).
-- users.last_seen_privacy — кто видит точное время захода: everyone | peers (собеседники и люди с общих серверов) | nobody;
--   по умолчанию peers (решение владельца Р-2). users.hide_read_time — «Скрывать время прочтения» (как Telegram).
-- conversation_messages.read_at — когда собеседник 1:1 прочёл это сообщение (ставит markRead при сдвиге «прочитано до»).
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_privacy text NOT NULL DEFAULT 'peers';
ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_read_time boolean NOT NULL DEFAULT false;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS read_at timestamptz;
