-- Indexes the site-scoped reads and foreign keys were missing (architecture review AR-10), and
-- case-insensitive uniqueness for sign-in names (AR-11). Safe to run again.

-- Site-scoped tables read by site (and, for certificates, by tank and analysis date).
CREATE INDEX IF NOT EXISTS storage_certificates_site_tank_date_idx ON storage_certificates (site_id, tank_id, analysis_date);
CREATE INDEX IF NOT EXISTS logistics_events_site_day_idx ON logistics_events (site_id, sampled_on);
CREATE INDEX IF NOT EXISTS analytics_movements_site_idx ON analytics_movements (site_id);
CREATE INDEX IF NOT EXISTS vessel_tickets_site_idx ON vessel_tickets (site_id);
CREATE INDEX IF NOT EXISTS truck_batches_site_idx ON truck_batches (site_id);
CREATE INDEX IF NOT EXISTS gate_movements_site_idx ON gate_movements (site_id);

-- Foreign keys used in joins and in deletes during a site reload.
CREATE INDEX IF NOT EXISTS soundings_submission_idx ON soundings (submission_id);
CREATE INDEX IF NOT EXISTS storage_certificates_submission_idx ON storage_certificates (submission_id);
CREATE INDEX IF NOT EXISTS user_sites_site_idx ON user_sites (site_id);
CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles (role_id);

-- soundings_site_recorded_idx (004) is the same index as soundings_site_day (001).
DROP INDEX IF EXISTS soundings_site_day;

-- A deleted account frees its name and e-mail for a new one (the API renames it on delete from now on).
UPDATE users SET username = 'deleted-' || id || '-' || username, email = NULL, updated_at = NOW()
WHERE deleted_at IS NOT NULL AND username NOT LIKE 'deleted-%';

-- Sign-in matches username or email without regard to case, so they must be unique that way too.
-- Skipped with a notice where existing rows already clash; resolve those, then run migrate again
-- after removing this file's row from schema_migrations.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users GROUP BY LOWER(username) HAVING COUNT(*) > 1) THEN
    RAISE NOTICE 'users: usernames differ only by case; users_username_lower_key not created';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key ON users (LOWER(username));
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE email IS NOT NULL GROUP BY LOWER(email) HAVING COUNT(*) > 1) THEN
    RAISE NOTICE 'users: emails differ only by case; users_email_lower_key not created';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (LOWER(email)) WHERE email IS NOT NULL;
  END IF;
END $$;
