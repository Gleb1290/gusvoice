-- Direct messages: 1:1 conversations + their messages.
CREATE TABLE IF NOT EXISTS dm_channels (
  id text PRIMARY KEY,
  user_a text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  CONSTRAINT dm_channels_pair_uniq UNIQUE (user_a, user_b)
);

CREATE TABLE IF NOT EXISTS dm_messages (
  id text PRIMARY KEY,
  dm_channel_id text NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES users(id),
  content text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz
);

CREATE INDEX IF NOT EXISTS dm_messages_channel_created ON dm_messages (dm_channel_id, created_at);
