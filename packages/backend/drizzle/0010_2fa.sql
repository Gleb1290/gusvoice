-- 2FA (TOTP) + backup codes on users. Idempotent (applied on boot by src/db/index.ts).
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes jsonb;
