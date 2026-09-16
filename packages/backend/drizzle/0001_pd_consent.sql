-- Personal-data processing consent (152-ФЗ). Nullable timestamp = when the user accepted the privacy
-- policy + user agreement. Applied at backend startup by the migrator in src/db/index.ts. Idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS pd_consent_at TIMESTAMPTZ;

-- Backfill every existing account as having consented (trusted, invite-only users created by the
-- operator). New registrations set this from the consent checkbox; logins set it if still null.
UPDATE users SET pd_consent_at = now() WHERE pd_consent_at IS NULL;
