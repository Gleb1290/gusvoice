-- Permissions upgrade: role mentionable, category-synced channels, category overwrites, audit log.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS mentionable boolean NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS synced_to_category boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS category_overwrites (
  category_id text NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  target_id text NOT NULL,
  target_type text NOT NULL,
  allow text NOT NULL DEFAULT '0',
  deny text NOT NULL DEFAULT '0',
  PRIMARY KEY (category_id, target_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id text PRIMARY KEY,
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES users(id),
  action text NOT NULL,
  target_type text,
  target_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_server_created ON audit_log (server_id, created_at);
