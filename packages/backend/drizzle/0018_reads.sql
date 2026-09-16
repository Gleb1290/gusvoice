-- Persisted per-user read state (P2-7): unread flags + mention counts survive reloads.
-- last_read_at advances when the client opens a channel/DM (POST .../read).
CREATE TABLE IF NOT EXISTS channel_reads (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS dm_reads (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dm_channel_id text NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dm_channel_id)
);

-- Bootstrap aggregates recent messages per channel (14-day window) — index the scan.
CREATE INDEX IF NOT EXISTS messages_channel_created_idx ON messages (channel_id, created_at);
CREATE INDEX IF NOT EXISTS dm_messages_channel_created_idx ON dm_messages (dm_channel_id, created_at);
