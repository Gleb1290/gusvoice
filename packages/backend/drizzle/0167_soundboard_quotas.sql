INSERT INTO instance_settings (key, value)
VALUES ('soundboard', '{"mode":"off","serverIds":[],"legacyLimit":24}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE server_soundboard_quotas (
  server_id text PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  per_user_limit integer NOT NULL CHECK (per_user_limit >= 0)
);

CREATE INDEX server_soundboard_author_idx ON server_soundboard (server_id, created_by);

-- Без FK: задание переживает удаление клипа, сервера и пользователя.
CREATE TABLE soundboard_cleanup (
  clip_id text PRIMARY KEY,
  server_id text NOT NULL,
  url text NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  failures integer NOT NULL DEFAULT 0
);

CREATE INDEX soundboard_cleanup_due_idx ON soundboard_cleanup (next_attempt_at, clip_id);

CREATE FUNCTION gv_queue_soundboard_cleanup() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO soundboard_cleanup (clip_id, server_id, url)
    VALUES (OLD.id, OLD.server_id, OLD.url);
  RETURN NULL;
END;
$$;

CREATE TRIGGER server_soundboard_cleanup
  AFTER DELETE ON server_soundboard
  FOR EACH ROW EXECUTE FUNCTION gv_queue_soundboard_cleanup();
