-- ЛС, раунд 12, серверный шаг С2 (05.10, #211, признак `conv7`): закреп сообщений в беседе, как в Telegram, — «для меня»
-- или «для обоих» (галочка «Также закрепить для собеседника»).
--
-- Строка — закреп ГЛАЗАМИ одного человека (`user_id` — чей это закреп, кто его видит): «для обоих» = строки обоим,
-- «для меня» = строка себе; открепить у меня — удалить свою, у обоих — свою и закрепы «для обоих» остальных.
-- `for_both` — закреп поставлен «для обоих»: при откреплении клиент спрашивает «Также открепить для собеседника». Это
-- свойство СВОЕЙ строки, а не живая проверка строки собеседника — его «открепить у меня» остаётся его делом и мне не видно.
-- Владелец строки и закрепивший ссылаются на участие в беседе (как владелец `attachments`), а не на `users`: закреп —
-- часть переписки, удаление аккаунта (обезличивание) его не трогает.
--
-- Только добавление: старый бэкенд (откат) таблицу не читает. Удалённые им сообщения закрепы не снимут — их прячет
-- фильтр видимости при чтении списка (`conversations.pinsFor`), и в предел они не считаются.
CREATE TABLE IF NOT EXISTS conversation_pins (
  conversation_id text NOT NULL,
  user_id text NOT NULL,
  message_id text NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  pinned_by text NOT NULL,
  pinned_at timestamptz NOT NULL DEFAULT now(),
  for_both boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, user_id, message_id),
  FOREIGN KEY (conversation_id, user_id) REFERENCES conversation_members (conversation_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, pinned_by) REFERENCES conversation_members (conversation_id, user_id) ON DELETE CASCADE
);
-- Все закрепы сообщения (удаление «у обоих», правка закреплённого, каскад от сообщения).
CREATE INDEX IF NOT EXISTS conversation_pins_message_idx ON conversation_pins (message_id);

-- Строка журнала «мой список закреплённого в беседе изменился» (`message_id` пуст: сущность — список, а не сообщение;
-- догонка отдаёт список целиком). Старый бэкенд (откат) такие строки читает как любые: беседа попадает в догонку сводкой.
ALTER TABLE user_changes DROP CONSTRAINT IF EXISTS user_changes_kind_check;
ALTER TABLE user_changes ADD CONSTRAINT user_changes_kind_check CHECK (kind IN ('msg', 'read', 'conv', 'draft', 'pin'));

-- Попутно (05.10): признак «автор оригинала удалён» в снимке «Переслано от» — `forwarded_from.deleted = true`. Клиент
-- узнаёт удалённого по нему, а не по имени («Удалённый пользователь» может назваться и живой). Новые снимки его получают
-- при обезличивании (`accountRows.anonymizeAccountRows`) и при пересылке сообщения удалённого автора; здесь —
-- снимки аккаунтов, обезличенных раньше. Только добавление ключа: старый бэкенд собирает DTO по своим полям и его не видит.
UPDATE conversation_messages x
SET forwarded_from = x.forwarded_from || '{"deleted": true}'::jsonb
FROM users u
WHERE x.forwarded_from IS NOT NULL
  AND u.id = x.forwarded_from->>'userId'
  AND u.deleted_at IS NOT NULL
  AND x.forwarded_from->'deleted' IS NULL;
