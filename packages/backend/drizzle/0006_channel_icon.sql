-- Custom per-channel icon. Stores an icon-name string from the client's curated
-- channel-icon set; NULL means "use the channel-type default" (# for text, volume for voice).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS icon text;
