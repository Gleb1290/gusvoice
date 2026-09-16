-- Кастомные эмодзи сервера (#18).
--
-- Файл лежит в MinIO (префикс `emoji/`), здесь только запись о нём. Так же устроены аватары:
-- складывать картинки в Postgres значит раздувать бэкапы и терять раздачу через CDN/nginx.
CREATE TABLE IF NOT EXISTS server_emojis (
  id          text PRIMARY KEY,
  server_id   text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  -- Латиница/цифры/подчёркивание, 2–32. Проверяется в shared/emojiRules.ts на ОБЕИХ сторонах.
  name        text NOT NULL,
  url         text NOT NULL,
  -- Кто загрузил. ON DELETE SET NULL: удаление автора не должно уносить эмодзи, которым
  -- пользуется весь сервер.
  created_by  text REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Имя уникально В ПРЕДЕЛАХ сервера: `:pepe:` обязано означать одно и то же в одном чате.
-- На разных серверах имена независимы — эмодзи серверные, а не глобальные.
CREATE UNIQUE INDEX IF NOT EXISTS server_emojis_name_uq ON server_emojis (server_id, name);

-- Список эмодзи запрашивается на каждое открытие сервера (уходит в bootstrap).
CREATE INDEX IF NOT EXISTS server_emojis_server_idx ON server_emojis (server_id);
