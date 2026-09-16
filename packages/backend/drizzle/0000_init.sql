-- Initial GusVoice schema. Applied at backend startup by the lightweight migrator
-- in src/db/index.ts (tracked in the _migrations table). Idempotent.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon_url   TEXT,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id        TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('text', 'voice')),
  position    INTEGER NOT NULL DEFAULT 0,
  topic       TEXT
);

CREATE TABLE IF NOT EXISTS roles (
  id           TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  color        INTEGER NOT NULL DEFAULT 0,
  permissions  TEXT NOT NULL DEFAULT '0',
  position     INTEGER NOT NULL DEFAULT 0,
  hoist        BOOLEAN NOT NULL DEFAULT false,
  is_everyone  BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS server_members (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname  TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS member_roles (
  server_id TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role_id   TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id)
);

CREATE TABLE IF NOT EXISTS channel_overwrites (
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('role', 'member')),
  allow       TEXT NOT NULL DEFAULT '0',
  deny        TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (channel_id, target_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created
  ON messages (channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  inviter_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);
