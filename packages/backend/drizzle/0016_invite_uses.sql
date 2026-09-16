-- Invite expiry was already supported; add usage limits (P3): max_uses (null = unlimited) + a uses counter.
ALTER TABLE invites ADD COLUMN IF NOT EXISTS max_uses integer;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS uses integer NOT NULL DEFAULT 0;
