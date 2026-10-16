-- ЛС между инстансами, этап Э0 (#141, docs/dm/FEDERATION.md §3): подготовка без видимых изменений. Только добавления: новые
-- колонки с умолчаниями и новые пустые таблицы, существующие данные не трогаются.

-- Дыра доставки по seq (§2.2): номера соседа, перепрыгнутые дырой и ещё не пришедшие. Опоздавшее раннее событие из этого
-- списка принимается, а не выбрасывается как повтор (judgeEvent / trackMissingSeqs).
ALTER TABLE federation_links ADD COLUMN IF NOT EXISTS missing_event_seqs jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Версия правки (+1 на каждую правку; побеждает бо́льшая) и ключ порядка на доме автора у копии чужого сообщения.
-- У своих сообщений origin_sort_key пуст: источник порядка — свой sort_key.
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS edit_version integer NOT NULL DEFAULT 0;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS origin_sort_key bigint;

-- Журнал изменений на связку (по образцу user_sync / user_changes): что МЫ должны отдать этому соседу.
CREATE TABLE IF NOT EXISTS fed_conv_sync (
  instance_id text PRIMARY KEY,
  seq bigint NOT NULL DEFAULT 0,
  min_seq bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fed_conv_changes (
  instance_id text NOT NULL REFERENCES fed_conv_sync(instance_id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind text NOT NULL,
  entity_id text,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, seq)
);
CREATE INDEX IF NOT EXISTS fed_conv_changes_at_idx ON fed_conv_changes (at);

-- Курсор приёма: до какого номера журнала соседа мы уже забрали.
CREATE TABLE IF NOT EXISTS fed_conv_cursor (
  instance_id text PRIMARY KEY,
  since bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
