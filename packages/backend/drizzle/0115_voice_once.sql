-- «Прослушать один раз» у голосовых ЛС (08.10, #211, G54, признак `voice3`). Только добавление: старый код колонку не знает.
-- conversation_messages.once_spent_at — когда получатель дослушал одноразовое голосовое: файл удалён, вложений нет, в content —
--   запасная фраза «Голосовое сообщение прослушано» (`ConvMessage.voiceOnceSpent`). Сам признак «один раз» — `once` у вложения (jsonb).
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS once_spent_at timestamptz;
