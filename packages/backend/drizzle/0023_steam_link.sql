-- Steam account link (#40 Phase 1B). steam_id = SteamID64 (null = not linked), steam_persona = cached
-- Steam display name for the settings UI. show_game_activity is the master privacy switch gating both
-- the server-side Steam poller and the desktop local-detect reporter (default on).
ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_persona text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_game_activity boolean NOT NULL DEFAULT true;
