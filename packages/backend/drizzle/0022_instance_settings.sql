-- Instance-wide settings editable from the admin panel (key -> JSON value). Currently the 'smtp'
-- row holds the mail config, so an operator can set up e-mail from the UI instead of editing .env +
-- rebuilding. mailer.ts reads the 'smtp' row and falls back to the SMTP_* env vars when it's absent
-- (so existing deployments that configured SMTP via env keep working unchanged).
CREATE TABLE IF NOT EXISTS instance_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
