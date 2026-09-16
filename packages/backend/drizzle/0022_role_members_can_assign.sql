-- Self-service roles: when members_can_assign is true, any member who ALREADY holds this role may
-- GRANT it to other members WITHOUT MANAGE_ROLES (add-only — removal still needs MANAGE_ROLES),
-- bypassing the normal role-hierarchy check for this role only. The API refuses to set the flag on
-- roles carrying admin-level perms (ADMINISTRATOR / MANAGE_ROLES / MANAGE_SERVER) so it can't spread
-- privilege virally.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS members_can_assign boolean NOT NULL DEFAULT false;
