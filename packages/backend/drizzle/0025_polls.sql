-- Опросы в чате (#17).
--
-- Опрос ЖИВЁТ ОТДЕЛЬНО от сообщения, а не колонкой в `messages`, по двум причинам: голоса нужно
-- считать запросом с группировкой (в jsonb это превратилось бы в перезапись всего документа на
-- каждый голос и гонку при одновременном голосовании), и удаление сообщения обязано уносить опрос
-- за собой — это делает внешний ключ, а не код.
CREATE TABLE IF NOT EXISTS polls (
  message_id  text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  question    text NOT NULL,
  -- [{ id, text }] — порядок вариантов важен, поэтому массив, а не таблица со своим порядком.
  options     jsonb NOT NULL,
  -- true = можно выбрать несколько вариантов
  multi       boolean NOT NULL DEFAULT false,
  -- null = бессрочный
  closes_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Одна строка на (опрос, человек, вариант). Составной первичный ключ сам гасит двойной клик по
-- одному варианту: повторная вставка просто конфликтует, а не удваивает голос.
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id  text NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, option_id)
);

-- Подсчёт идёт по опросу целиком.
CREATE INDEX IF NOT EXISTS poll_votes_message_idx ON poll_votes (message_id);
