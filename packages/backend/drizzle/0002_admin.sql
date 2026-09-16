-- Per-user "may create servers" flag (granted by the super-admin in the admin panel).
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_create_servers BOOLEAN NOT NULL DEFAULT false;
