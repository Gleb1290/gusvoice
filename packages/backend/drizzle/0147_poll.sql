-- Опрос в ЛС (14.10, признак `convpoll1`): определение опроса — в `conversation_messages.media` (`kind: 'poll'`,
-- `shared/convPoll.ts`), голоса — строками здесь (одновременные голоса не теряются, в отличие от счётчика в jsonb). Строка —
-- один отмеченный вариант одного человека; отмена голоса удаляет его строки. Без FK на users: аккаунт не удаляется, а
-- обезличивается (`accountRows.ts`), как у «прослушано» (0101). Только добавление.
CREATE TABLE IF NOT EXISTS conv_poll_votes (
  message_id text NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  option_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, option_id)
);
