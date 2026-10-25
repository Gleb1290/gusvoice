-- Одноразовые фото и видео в ЛС (19.10, #226, признак `ttlmedia1`; Telegram «Self-Destruct Timer»). Только добавление: старый код
-- колонку не знает. Пометка «один раз» и таймер живут в jsonb вложения (`once`, `onceTtl`).
-- conversation_messages.once_opened_at — когда получатель открыл одноразовое фото/видео: дальше оно сгорает при закрытии,
--   по таймеру или (клиент не сообщил) сторожем сервера (`sweepOpenedOnce`) — тогда же, что и `once_spent_at` у голосового.
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS once_opened_at timestamptz;
CREATE INDEX IF NOT EXISTS conversation_messages_once_opened_idx
  ON conversation_messages (once_opened_at)
  WHERE once_opened_at IS NOT NULL AND once_spent_at IS NULL;
