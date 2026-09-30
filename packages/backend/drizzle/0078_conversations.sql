-- ЛС, этап 1а (#211, docs/dm/STAGE1.md): модель бесед РЯДОМ со старыми dm_*. До шага 1б таблицы пустые и никто в них
-- не пишет (ручки /api/conv/* за флагом CONV_API_ENABLED, на проде выключен); перенос живых ЛС — отдельной миграцией 1б.
--
-- Порядок — sort_key: bigint в МИКРОСЕКУНДАХ, гибридные часы дома, который хранит строку, max(часы базы, last_sort_key+1)
-- под замком строки беседы. Микросекунды < 2^53 до 2255 года — ключ точное число JS (разбор Codex 30.09). Ключ всегда
-- МЕСТНЫЙ: копия соседа (этап 6) получит свой, ключ источника — отдельной колонкой.

CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('direct', 'group')),
  -- 1:1 — «меньший:больший» id участников: одна беседа на пару. У групп пусто.
  direct_key text UNIQUE,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Время последнего сообщения, которое подняло беседу (придержанное блокировкой — не поднимает, как в dm_channels).
  last_message_at timestamptz,
  last_sort_key bigint NOT NULL DEFAULT 0,
  origin_instance_id text,
  CHECK ((kind = 'direct') = (direct_key IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  -- «Прочитано до» — sort_key последнего прочитанного, только вперёд (GREATEST).
  last_read_key bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS conversation_members_user_idx ON conversation_members (user_id);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- id отправки от клиента и отпечаток содержимого: повтор с тем же отпечатком — то же сообщение, с другим — 409.
  client_id text,
  payload_hash text,
  sort_key bigint NOT NULL,
  content text NOT NULL DEFAULT '',
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  reply_to_id text REFERENCES conversation_messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  -- Надгробие «удалено у обоих»: текст и вложения стёрты, строка остаётся, чтобы удаление дошло догонкой.
  deleted_at timestamptz,
  withheld boolean NOT NULL DEFAULT false,
  hidden_for text[] NOT NULL DEFAULT '{}',
  origin_instance_id text
);
-- Ключ порядка уникален внутри беседы по построению (замок беседы) — индекс это и закрепляет.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_order_idx ON conversation_messages (conversation_id, sort_key);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_client_idx
  ON conversation_messages (author_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_message_reactions (
  message_id text NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- Журнал изменений на человека (Р4): pts растёт на каждое изменение, которое человек должен узнать; строка —
-- указатель «сущность X изменилась», догонка отдаёт её ТЕКУЩЕЕ состояние. min_pts — последний удалённый номер.
CREATE TABLE IF NOT EXISTS user_sync (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pts bigint NOT NULL DEFAULT 0,
  min_pts bigint NOT NULL DEFAULT 0
);
-- Ссылается на user_sync, а не на users: журнал — часть состояния синхронизации и уходит вместе с ним.
CREATE TABLE IF NOT EXISTS user_changes (
  user_id text NOT NULL REFERENCES user_sync(user_id) ON DELETE CASCADE,
  pts bigint NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('msg', 'read', 'conv')),
  message_id text,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pts)
);
CREATE INDEX IF NOT EXISTS user_changes_at_idx ON user_changes (at);
