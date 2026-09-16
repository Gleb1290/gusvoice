-- Session revocation (P1-5): a per-user token generation. Every JWT carries the generation it
-- was minted with; requireAuth rejects tokens whose generation no longer matches. Bumping the
-- counter ("Выйти на всех устройствах", password change/reset) instantly kills every other
-- outstanding token. Existing tokens (no gen claim) read as generation 0 = today's default,
-- so this deploy logs nobody out.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_generation integer NOT NULL DEFAULT 0;
