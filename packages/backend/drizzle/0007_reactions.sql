-- Emoji reactions on channel messages: one row per (message, user, emoji).
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS message_reactions_message_idx ON message_reactions(message_id);
