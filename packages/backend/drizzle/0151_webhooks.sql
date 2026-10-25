-- Входящие вебхуки каналов (#24, как у Discord). Только добавления: старый код новых колонок и таблицы не знает.
--
-- users.bot — служебная строка «автора» вебхука. У каждого вебхука своя такая строка: сообщение канала обязано иметь
--   автора (`messages.author_id` NOT NULL, на нём держатся история, ответы, непрочитанное), а человеком вебхук не является.
--   Строка заводится неподтверждённой, без почты, с непригодным паролем и скрытой от соседей — поэтому она не находится
--   ни поиском, ни входом, ни каталогом федерации. Список людей в админке отсекает её по этому флагу.
--   При удалении вебхука строка ОСТАЁТСЯ: сообщения, которые он успел написать, живут дальше (как у Discord).
ALTER TABLE users ADD COLUMN IF NOT EXISTS bot boolean NOT NULL DEFAULT false;

-- webhooks — сам вебхук. Токен хранится ТОЛЬКО хешем (sha256 от 32 случайных байт): утёкшая база не даёт писать в каналы,
--   а полный адрес видит один раз тот, кто его создал или сгенерировал заново.
CREATE TABLE IF NOT EXISTS webhooks (
  id text PRIMARY KEY,
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  avatar_url text,
  token_hash text NOT NULL,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS webhooks_channel_idx ON webhooks (channel_id);

-- messages.webhook_* — сообщение пришло через вебхук: его id и имя/аватар НА МОМЕНТ отправки (отправитель может прислать
--   свои `username`/`avatar_url` на одно сообщение, а переименование вебхука историю не переписывает — как у Discord).
--   Без внешнего ключа на webhooks: удалённый вебхук сообщения не уносит.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS webhook_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS webhook_name text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS webhook_avatar text;
