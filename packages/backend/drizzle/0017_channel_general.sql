-- Channel "general": one appointed user per channel (set by owner / MANAGE_SERVER). They get a crown
-- badge and can manage that channel's own sound overrides.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS general_user_id text REFERENCES users(id) ON DELETE SET NULL;

-- Per-channel custom sound pack — overrides the server pack for voice events that happen in this
-- channel (resolution on the client: channel -> server -> synthesized cue).
CREATE TABLE IF NOT EXISTS channel_sounds (
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  event text NOT NULL,
  url text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, event)
);
