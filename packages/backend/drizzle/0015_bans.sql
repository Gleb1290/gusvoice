-- Server bans (P3). A banned user is removed and blocked from re-joining via invite until unbanned.
CREATE TABLE IF NOT EXISTS bans (
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text,
  banned_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX IF NOT EXISTS bans_server_idx ON bans(server_id);
