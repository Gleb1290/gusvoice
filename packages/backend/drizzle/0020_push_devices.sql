-- UnifiedPush device registrations (push notifications). One row per (user, device); the backend
-- POSTs a wake payload to `endpoint` (our ntfy gateway) when the recipient has no live gateway socket.
CREATE TABLE IF NOT EXISTS push_devices (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  endpoint text NOT NULL,
  platform text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS push_devices_user_idx ON push_devices (user_id);
