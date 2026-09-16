-- Pinned channel messages (MANAGE_MESSAGES). NULL = not pinned.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
CREATE INDEX IF NOT EXISTS messages_pinned_idx ON messages(channel_id) WHERE pinned_at IS NOT NULL;

-- Emoji reactions on DM messages: one row per (message, user, emoji). Mirrors message_reactions.
CREATE TABLE IF NOT EXISTS dm_message_reactions (
  message_id text NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS dm_message_reactions_message_idx ON dm_message_reactions(message_id);
