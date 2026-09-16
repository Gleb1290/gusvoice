-- User presence state + custom status (P2). status ∈ online|dnd|away|invisible.
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_status text NOT NULL DEFAULT 'online';
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_status_emoji text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_status_text text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_status_expires_at timestamptz;
