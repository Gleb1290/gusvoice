-- Reply-to: a message may point at an earlier message in the same channel/DM.
-- ON DELETE SET NULL so deleting the parent just drops the quote (the reply survives).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id text REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS reply_to_id text REFERENCES dm_messages(id) ON DELETE SET NULL;
