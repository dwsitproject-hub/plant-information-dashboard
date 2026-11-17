-- A number carried in every session token. Changing or resetting a password bumps it, so sessions signed
-- before (on other devices, or a stolen cookie) stop working at once instead of at their expiry.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
