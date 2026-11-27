ALTER TABLE channels
  ADD COLUMN force_muted boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT channels_force_muted_text_only CHECK (NOT force_muted OR type = 'text');
