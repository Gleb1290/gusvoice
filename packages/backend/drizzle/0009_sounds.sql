-- Custom per-server sound packs: one uploaded audio URL per (server, event).
-- `event` is one of the client SoundEvent keys (join/leave/mute/.../stream).
-- Absent row = the synthesized default cue is used for that event.
CREATE TABLE IF NOT EXISTS server_sounds (
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  event text NOT NULL,
  url text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, event)
);
