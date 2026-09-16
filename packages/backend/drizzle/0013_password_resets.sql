-- Password-reset codes (forgot-password flow). Isolated from email_verifications so a reset never
-- clobbers a pending registration / email-change verification. One active code per user.
CREATE TABLE IF NOT EXISTS password_resets (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz NOT NULL DEFAULT now()
);
