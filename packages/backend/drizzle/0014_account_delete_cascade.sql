-- Account deletion: let a user's own content/audit/invites cascade-delete with them. Server
-- ownership stays NO ACTION (servers_owner_id_fkey untouched) — the delete handler refuses while
-- the user still owns servers (they must transfer or delete those first). Constraint names are the
-- Postgres auto `_fkey` form (verified against the live DB).
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_author_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_author_id_fkey
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE dm_messages DROP CONSTRAINT IF EXISTS dm_messages_author_id_fkey;
ALTER TABLE dm_messages ADD CONSTRAINT dm_messages_author_id_fkey
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_id_fkey;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_id_fkey
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE invites DROP CONSTRAINT IF EXISTS invites_inviter_id_fkey;
ALTER TABLE invites ADD CONSTRAINT invites_inviter_id_fkey
  FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE CASCADE;
