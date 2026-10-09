-- «Кто может звонить» (08.10, #211, решение владельца, признак `presence4`). Только добавления: старый код колонку и таблицу не знает.
-- users.call_privacy: everyone | peers | nobody; по умолчанию everyone — звонить можно всем, кому можно писать (как было до настройки).
ALTER TABLE users ADD COLUMN IF NOT EXISTS call_privacy text NOT NULL DEFAULT 'everyone';
-- Исключения приватности по людям, общие для настроек (`key`): owner «всегда» / «никогда» разрешает target поверх правила.
-- Пока один ключ — 'calls' («Время захода» живёт в last_seen_exceptions, 0120).
CREATE TABLE IF NOT EXISTS privacy_exceptions (
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key IN ('calls')),
  kind text NOT NULL CHECK (kind IN ('always', 'never')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, key, target_id)
);
CREATE INDEX IF NOT EXISTS privacy_exceptions_target_idx ON privacy_exceptions (target_id, key, owner_id);
