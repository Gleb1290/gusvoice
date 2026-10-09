-- Папки бесед ЛС (07.10, #211, G40, решение владельца Р-8; признак `folders1`) — как у Telegram (`ChatFilter`).
--
-- Папка — определение отбора, а не хранилище бесед: типы (`flags`, биты `DM_FOLDER_*` из `shared/dmFolders.ts`), явно
-- включённые (`include_ids`) и явно исключённые (`exclude_ids`) беседы. Одна беседа может стоять в скольких угодно
-- папках. Отбор считает клиент. Удалённая беседа в списках просто не находится — как у Telegram, строки не чистятся.
--
-- Системная папка «Личные сообщения» (`system = 'dms'`) — одна на человека, заводится при первом чтении списка; её
-- нельзя удалить, но можно переставить. Меньше `position` — левее (выше) во вкладках.
CREATE TABLE IF NOT EXISTS dm_folders (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  system      text,
  title       text NOT NULL DEFAULT '',
  emoticon    text,
  flags       integer NOT NULL DEFAULT 0,
  include_ids text[] NOT NULL DEFAULT '{}',
  exclude_ids text[] NOT NULL DEFAULT '{}',
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dm_folders_user_idx ON dm_folders (user_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS dm_folders_system_uq ON dm_folders (user_id, system) WHERE system IS NOT NULL;
