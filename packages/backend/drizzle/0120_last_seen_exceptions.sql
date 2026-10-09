-- Исключения «Времени захода» (08.10, #211, G07, признак `lastseen3`). Только добавления: старый код таблицы не знает.
-- owner «всегда» / «никогда» показывает своё время захода target поверх правила users.last_seen_privacy.
CREATE TABLE IF NOT EXISTS last_seen_exceptions (
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('always', 'never')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, target_id)
);
CREATE INDEX IF NOT EXISTS last_seen_exceptions_target_idx ON last_seen_exceptions (target_id, owner_id);
