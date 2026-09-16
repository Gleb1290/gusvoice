-- Per-user push-mute rules. A row means: do NOT send `user_id` a background push whose source
-- matches (scope, target_id). scope='server' mutes @mention pushes from that server; scope='dm_user'
-- mutes DM pushes from that person. In-app delivery is unaffected — only the phone wake is suppressed.
CREATE TABLE IF NOT EXISTS push_mutes (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  target_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, target_id)
);
